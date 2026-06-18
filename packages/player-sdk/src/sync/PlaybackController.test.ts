import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlaybackController } from './PlaybackController.js';
import { Logger } from '../utils/Logger.js';

// PlaybackController.start() schedules a tick via requestAnimationFrame, which
// is absent in the default node test environment. Stub it so it never fires
// (returns a handle without invoking the callback), keeping the clock static
// between our explicit performance.now() steps.
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const makeController = (audioClock: (() => number | null) | null = null) =>
  new PlaybackController(audioClock, null, null, null, null, undefined, undefined, undefined, new Logger('test', 'silent'));

describe('PlaybackController playback rate', () => {
  it('defaults to 1x', () => {
    expect(makeController().getPlaybackRate()).toBe(1);
  });

  it('advances the system clock in real time at 1x', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000); // ms
    const c = makeController();
    c.start(); // anchors playStartTime = 1.0s, mediaStartClock = 0
    now.mockReturnValue(3000); // +2s of real time
    expect(c.getCurrentTime()).toBeCloseTo(2, 6);
  });

  it('advances twice as fast at 2x', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const c = makeController();
    c.start();
    c.setPlaybackRate(2);
    now.mockReturnValue(3000); // +2s real
    expect(c.getCurrentTime()).toBeCloseTo(4, 6); // scaled 2x
  });

  it('advances half as fast at 0.5x', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const c = makeController();
    c.start();
    c.setPlaybackRate(0.5);
    now.mockReturnValue(3000); // +2s real
    expect(c.getCurrentTime()).toBeCloseTo(1, 6); // scaled 0.5x
  });

  it('preserves position when changing rate mid-playback (re-anchor, no jump)', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const c = makeController();
    c.start();
    now.mockReturnValue(5000); // +4s at 1x → pos 4
    expect(c.getCurrentTime()).toBeCloseTo(4, 6);
    c.setPlaybackRate(2); // re-anchor at the current position
    expect(c.getCurrentTime()).toBeCloseTo(4, 6); // no jump on switch
    now.mockReturnValue(6000); // +1s real at 2x → +2 → 6
    expect(c.getCurrentTime()).toBeCloseTo(6, 6);
  });

  it('uses the audio clock at 1x (once converged) but ignores it at non-1x speed', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    let audio: number | null = 0.2; // plausible: near the system clock (starts at 0)
    const c = makeController(() => audio);
    c.start();
    expect(c.getCurrentTime()).toBeCloseTo(0.2, 6); // 1x → converged audio clock wins
    c.setPlaybackRate(1.5); // re-anchors to current pos, then ignores audio
    audio = 99; // even a bogus audio value is ignored at non-1x
    expect(c.getCurrentTime()).toBeCloseTo(0.2, 6); // system clock, same instant
  });

  it('rejects a wildly divergent audio clock instead of jumping to it', () => {
    // A bad PTS marker / underrun overshoot can momentarily make the audio clock
    // jump far from the real position. The video clock must not follow it.
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    let audio: number | null = 0.1; // converged → trusted
    const c = makeController(() => audio);
    c.start();
    expect(c.getCurrentTime()).toBeCloseTo(0.1, 6);
    now.mockReturnValue(1100); // +0.1s; keep audio converged so it stays trusted
    audio = 0.2;
    expect(c.getCurrentTime()).toBeCloseTo(0.2, 6);
    // Audio clock spikes far ahead (bad marker). Reject it: stay on the smooth
    // system clock, which is slaved to the last good audio position (0.2).
    audio = 50;
    expect(c.getCurrentTime()).toBeCloseTo(0.2, 6);
  });

  it('holds the last audio position during a brief underrun (no jump)', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    let audio: number | null = 0.3; // near system (0) → trusted
    const c = makeController(() => audio);
    c.start();
    expect(c.getCurrentTime()).toBeCloseTo(0.3, 6); // lastAudioWall = 1.0s
    // Underrun: audio clock vanishes. Within the hold window the clock freezes at
    // the last audio position rather than racing the realtime system clock.
    audio = null;
    now.mockReturnValue(1500); // +0.5s into the underrun (< UNDERRUN_HOLD = 1s)
    expect(c.getCurrentTime()).toBeCloseTo(0.3, 6); // held, not 0.5
    // After the hold window expires, freewheel on the system clock from the held
    // position so playback continues even if audio never returns.
    now.mockReturnValue(2100); // 1.1s after last audio → hold expired, re-anchor at 0.3
    expect(c.getCurrentTime()).toBeCloseTo(0.3, 6);
    now.mockReturnValue(2600); // +0.5s of freewheel
    expect(c.getCurrentTime()).toBeCloseTo(0.8, 6);
  });

  it('ignores a stale audio clock right after a seek until it reconverges', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    let audio: number | null = 0.1; // converged before the seek
    const c = makeController(() => audio);
    c.start();
    expect(c.getCurrentTime()).toBeCloseTo(0.1, 6);
    c.seek(10); // flush → distrust audio; system clock anchored at 10s
    audio = 99; // stale/old-position audio must be ignored
    expect(c.getCurrentTime()).toBeCloseTo(10, 6);
    now.mockReturnValue(1500); // +0.5s real
    expect(c.getCurrentTime()).toBeCloseTo(10.5, 6); // system clock, not stale audio 99
    // Once the audio pipeline re-anchors near the new position, trust it again.
    audio = 10.5;
    expect(c.getCurrentTime()).toBeCloseTo(10.5, 6);
  });

  it('rejects non-positive / non-finite rates', () => {
    const c = makeController();
    c.setPlaybackRate(0);
    c.setPlaybackRate(-1);
    c.setPlaybackRate(NaN);
    expect(c.getPlaybackRate()).toBe(1);
  });

  describe('lowPower and targetFps options', () => {
    it('applies frame decimation under targetFps', () => {
      const c = new PlaybackController(null, null, null, null, null, 10, undefined, undefined, new Logger('test', 'silent'));
      // targetFps = 10, so interval is 0.1s. Margin is 0.005s, so frames < 0.095s apart in PTS should be dropped.
      
      const mockClose1 = vi.fn();
      const mockClose2 = vi.fn();
      const mockClose3 = vi.fn();

      c.enqueueFrame({ pts: 0.0, duration: 0.033, data: { close: mockClose1 } as any });
      // 0.03s is < 0.095s from 0.0 -> should be dropped
      c.enqueueFrame({ pts: 0.03, duration: 0.033, data: { close: mockClose2 } as any });
      // 0.11s is >= 0.095s from 0.0 -> should be kept
      c.enqueueFrame({ pts: 0.11, duration: 0.033, data: { close: mockClose3 } as any });

      expect(mockClose1).not.toHaveBeenCalled();
      expect(mockClose2).toHaveBeenCalled();
      expect(mockClose3).not.toHaveBeenCalled();
      
      const diag = c.getDiagnostics();
      expect(diag.decodedFrames).toBe(3);
      expect(diag.droppedFrames).toBe(1);
      expect(diag.queueLength).toBe(2);
    });

    it('optimizes queue limits and sets default FPS when lowPower is true', () => {
      const c = new PlaybackController(null, null, null, null, null, undefined, undefined, true, new Logger('test', 'silent'));
      const diag = c.getDiagnostics();
      
      // When lowPower is active, maxQueueSize defaults to 5.
      // Let's check if backpressure triggers at queue size 5.
      let backpressureChange = false;
      const bpController = new PlaybackController(
        null,
        null,
        (pause) => { backpressureChange = pause; },
        null,
        null,
        undefined,
        undefined,
        true,
        new Logger('test', 'silent')
      );

      for (let i = 0; i < 5; i++) {
        bpController.enqueueFrame({ pts: i * 0.2, duration: 0.2, data: { close: vi.fn() } as any });
      }
      expect(backpressureChange).toBe(true); // Should pause decoding at queue size 5
    });

  });

  describe('buffering signal', () => {
    // Build a controller wired with a render sink and a buffering listener.
    const makeBufferingController = (events: boolean[]) => {
      const c = new PlaybackController(
        null,
        () => {},          // onRenderFrame (no-op sink)
        null,
        null,
        (b) => events.push(b),
        undefined,
        undefined,
        undefined,
        new Logger('test', 'silent'),
      );
      return c;
    };

    it('emits waiting=true once on a gap-stall during PLAYING, not every frame', () => {
      const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
      const events: boolean[] = [];
      const c = makeBufferingController(events);
      c.start();

      // Render one frame so lastRenderedPTS is set and gap detection can engage.
      c.enqueueFrame({ pts: 0, duration: 0.04, data: { close: vi.fn() } as any });
      (c as any).tick();
      expect(c.isBuffering).toBe(false);

      // Advance the clock well past GAP_THRESHOLD with an empty queue → stall.
      now.mockReturnValue(2000); // +1s, no new frames
      (c as any).tick();
      (c as any).tick(); // a second stalled tick must NOT re-emit
      now.mockReturnValue(2500);
      (c as any).tick();

      expect(c.isBuffering).toBe(true);
      // Exactly one true transition despite multiple stalled ticks.
      expect(events).toEqual([true]);

      c.destroy();
    });

    it('emits playing=false when a fresh frame ends the stall', () => {
      const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
      const events: boolean[] = [];
      const c = makeBufferingController(events);
      c.start();

      c.enqueueFrame({ pts: 0, duration: 0.04, data: { close: vi.fn() } as any });
      (c as any).tick();

      now.mockReturnValue(2000); // stall
      (c as any).tick();
      expect(c.isBuffering).toBe(true);

      // A frame at the current clock arrives and renders → buffering clears.
      c.enqueueFrame({ pts: 1.0, duration: 0.04, data: { close: vi.fn() } as any });
      (c as any).tick();
      expect(c.isBuffering).toBe(false);
      expect(events).toEqual([true, false]);

      c.destroy();
    });

    it('clears buffering on pause (no sticky spinner)', () => {
      const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
      const events: boolean[] = [];
      const c = makeBufferingController(events);
      c.start();
      c.enqueueFrame({ pts: 0, duration: 0.04, data: { close: vi.fn() } as any });
      (c as any).tick();
      now.mockReturnValue(2000);
      (c as any).tick();
      expect(c.isBuffering).toBe(true);

      c.pause();
      expect(c.isBuffering).toBe(false);
      expect(events).toEqual([true, false]);

      c.destroy();
    });

    it('clears buffering on seek/flush', () => {
      const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
      const events: boolean[] = [];
      const c = makeBufferingController(events);
      c.start();
      c.enqueueFrame({ pts: 0, duration: 0.04, data: { close: vi.fn() } as any });
      (c as any).tick();
      now.mockReturnValue(2000);
      (c as any).tick();
      expect(c.isBuffering).toBe(true);

      c.seek(10); // flush() resets the stall
      expect(c.isBuffering).toBe(false);
      expect(events).toEqual([true, false]);

      c.destroy();
    });

    it('does not flag buffering while paused/idle', () => {
      const events: boolean[] = [];
      const c = makeBufferingController(events);
      // Never started: tick is a no-op, no buffering ever emitted.
      (c as any).tick();
      expect(c.isBuffering).toBe(false);
      expect(events).toEqual([]);
      c.destroy();
    });
  });

  describe('extra diagnostics', () => {
    it('tracks effectiveFps and decodedFrames in diagnostics', () => {
      const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
      let rendered: any = null;
      const c = new PlaybackController(
        null,
        (frame) => { rendered = frame; },
        null,
        null,
        null,
        undefined,
        undefined,
        undefined,
        new Logger('test', 'silent')
      );
      c.start();

      const f1 = { pts: 0.0, duration: 0.03, data: { close: vi.fn() } as any };
      const f2 = { pts: 0.03, duration: 0.03, data: { close: vi.fn() } as any };

      c.enqueueFrame(f1);
      c.enqueueFrame(f2);
      
      // Trigger a tick by manually calling the private tick method (or through mock requestAnimationFrame if ticked)
      // Since requestAnimationFrame is stubbed, we can trigger the tick method or just simulate it by invoking it directly.
      (c as any).tick();
      
      const diag = c.getDiagnostics();
      expect(diag.decodedFrames).toBe(2);
      expect(diag.effectiveFps).toBe(1); // One frame rendered in the last second
    });
  });
});
