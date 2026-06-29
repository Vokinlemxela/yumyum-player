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

  it('advances 4× as fast at 4x', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const c = makeController();
    c.start();
    c.setPlaybackRate(4);
    now.mockReturnValue(3000); // +2s real
    expect(c.getCurrentTime()).toBeCloseTo(8, 6); // scaled 4x
  });

  it('advances 16× as fast at 16x', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const c = makeController();
    c.start();
    c.setPlaybackRate(16);
    now.mockReturnValue(2000); // +1s real
    expect(c.getCurrentTime()).toBeCloseTo(16, 6); // scaled 16x
  });

  it('preserves position when switching from 1x to 4x mid-playback', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const c = makeController();
    c.start();
    now.mockReturnValue(3000); // +2s at 1x → pos 2
    expect(c.getCurrentTime()).toBeCloseTo(2, 6);
    c.setPlaybackRate(4); // re-anchor at pos 2
    expect(c.getCurrentTime()).toBeCloseTo(2, 6); // no jump
    now.mockReturnValue(4000); // +1s real at 4x → +4 → 6
    expect(c.getCurrentTime()).toBeCloseTo(6, 6);
  });

  it('preserves position when switching from 4x to 16x mid-playback', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const c = makeController();
    c.start();
    c.setPlaybackRate(4);
    now.mockReturnValue(2000); // +1s at 4x → pos 4
    expect(c.getCurrentTime()).toBeCloseTo(4, 6);
    c.setPlaybackRate(16); // re-anchor at pos 4
    expect(c.getCurrentTime()).toBeCloseTo(4, 6); // no jump
    now.mockReturnValue(3000); // +1s real at 16x → +16 → 20
    expect(c.getCurrentTime()).toBeCloseTo(20, 6);
  });

  it('preserves position when switching from 16x back to 1x', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const c = makeController();
    c.start();
    c.setPlaybackRate(16);
    now.mockReturnValue(1500); // +0.5s at 16x → pos 8
    expect(c.getCurrentTime()).toBeCloseTo(8, 6);
    c.setPlaybackRate(1); // re-anchor at pos 8
    expect(c.getCurrentTime()).toBeCloseTo(8, 6); // no jump
    now.mockReturnValue(2500); // +1s real at 1x → +1 → 9
    expect(c.getCurrentTime()).toBeCloseTo(9, 6);
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
      c.duration = 60;
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
      bpController.duration = 60;

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
      c.duration = 60; // finite = VOD → 250ms GAP_THRESHOLD
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
      c.duration = 60; // VOD → 250ms threshold
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
      c.duration = 60; // VOD → 250ms threshold
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
      c.duration = 60; // VOD → 250ms threshold
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

    it('uses higher threshold for live (duration=Infinity) to avoid segment-gap spinners', () => {
      const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
      const events: boolean[] = [];
      const c = makeBufferingController(events);
      // duration defaults to Infinity (live) → 2s GAP_THRESHOLD
      c.start();
      c.enqueueFrame({ pts: 0, duration: 0.04, data: { close: vi.fn() } as any });
      (c as any).tick();

      // +1s gap — within the live 2s threshold → no buffering signal.
      now.mockReturnValue(2000);
      (c as any).tick();
      expect(c.isBuffering).toBe(false);
      expect(events).toEqual([]);

      // +2.5s gap — exceeds the 2s threshold → buffering starts.
      now.mockReturnValue(3500);
      (c as any).tick();
      expect(c.isBuffering).toBe(true);
      expect(events).toEqual([true]);

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

  describe('VOD synchronization and clock drift correction', () => {
    it('aligns the clock back for VOD streams when it has drifted ahead (stalled queue) to prevent frame drop', () => {
      const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
      let renderedFrame: any = null;
      const c = new PlaybackController(
        null,
        (frame) => { renderedFrame = frame; },
        null,
        null,
        null,
        undefined,
        undefined,
        undefined,
        new Logger('test', 'silent')
      );
      c.duration = 100; // VOD stream
      c.start();

      // Render the first frame to exit the initial lazy alignment state
      const f1Data = { close: vi.fn() };
      const f1 = { pts: 0.0, duration: 0.04, data: f1Data as any };
      c.enqueueFrame(f1);
      (c as any).tick();
      expect(renderedFrame).toBe(f1Data);
      renderedFrame = null;

      // Advance the performance clock by 3 seconds, mimicking a decoder/network stall
      now.mockReturnValue(4000);

      // Now the clock has progressed to 3.0s, but the next frame is at 0.04s.
      // Without clock drift correction, delta = 0.04 - 3.0 = -2.96, which is < -0.100 (discarded as late).
      // With our fix, the clock is adjusted back to 0.04, and the frame is rendered.
      const f2Data = { close: vi.fn() };
      const f2 = { pts: 0.04, duration: 0.04, data: f2Data as any };
      c.enqueueFrame(f2);
      (c as any).tick();

      expect(renderedFrame).toBe(f2Data);
      expect(c.getCurrentTime()).toBeCloseTo(0.04, 6);
    });

    it('does not align the clock forward for VOD streams if the clock is behind (waiting for future frames)', () => {
      const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
      let renderedFrame: any = null;
      const c = new PlaybackController(
        null,
        (frame) => { renderedFrame = frame; },
        null,
        null,
        null,
        undefined,
        undefined,
        undefined,
        new Logger('test', 'silent')
      );
      c.duration = 100; // VOD stream
      c.start();

      // Render the first frame to exit the initial lazy alignment state
      const f1Data = { close: vi.fn() };
      const f1 = { pts: 0.0, duration: 0.04, data: f1Data as any };
      c.enqueueFrame(f1);
      (c as any).tick();
      expect(renderedFrame).toBe(f1Data);
      renderedFrame = null;

      // Enqueue a frame that is in the future (e.g. 1.0s, while the clock is at 0.0s)
      const f2Data = { close: vi.fn() };
      const f2 = { pts: 1.0, duration: 0.04, data: f2Data as any };
      c.enqueueFrame(f2);
      (c as any).tick();

      // The clock should NOT align forward to 1.0s. It should stay at 0.0s.
      // So f2 should not be rendered yet.
      expect(renderedFrame).toBeNull();
      expect(c.getCurrentTime()).toBeCloseTo(0.0, 6);
    });

    it('prevents flapping in live clock drift correction via cooldown logic', () => {
      // Set performance.now() to start at 3000ms (3.0s) so that the first tick (which
      // triggers the cooldown start) is far past 0, letting the first drift correction
      // pass the cooldown filter.
      const now = vi.spyOn(performance, 'now').mockReturnValue(3000); 
      let renderCount = 0;
      const c = new PlaybackController(
        null,
        () => { renderCount++; },
        null,
        null,
        null,
        25, // targetFps = 25
        25, // renderFps = 25
        undefined,
        new Logger('test', 'silent')
      );
      c.duration = Infinity; // Live stream
      c.start();

      // Initial alignment: f1 PTS is 0.0
      c.enqueueFrame({ pts: 0.0, duration: 0.04, data: {} as any });
      (c as any).tick(); // aligned to 0.0, clock at 0.0

      // We can mock masterClock.setAnchor to spy on it:
      const setAnchorSpy = vi.spyOn((c as any).masterClock, 'setAnchor');

      // 1. Trigger a small drift correction forward (pts is 0.09s, clock is at 0.0s -> diff 0.09s > 0.08s)
      now.mockReturnValue(3000); // clock = 0
      c.enqueueFrame({ pts: 0.09, duration: 0.04, data: {} as any });
      (c as any).tick();
      expect(setAnchorSpy).toHaveBeenCalledTimes(1); // corrected!
      expect((c as any).lastCorrectionTime).toBe(3000 / 1000); // 3.0

      setAnchorSpy.mockClear();

      // 2. Trigger another drift correction forward immediately after (10ms later: now = 3010ms).
      // Since it is only 10ms after the first correction, it should be BLOCKED by the 2.0s cooldown!
      now.mockReturnValue(3010); // +10ms
      c.enqueueFrame({ pts: 0.19, duration: 0.04, data: {} as any });
      (c as any).tick();
      expect(setAnchorSpy).not.toHaveBeenCalled(); // blocked by cooldown!

      // 3. Advance wall clock by 2.1s (now = 5110ms)
      // The cooldown is now elapsed. Let's trigger another correction.
      now.mockReturnValue(5110);
      // Clear the late frame that is still in the queue so it doesn't block correction
      (c as any).frameQueue = [];
      // Predicted clock = 0.09 + 2.1 = 2.19s. PTS = 2.30s -> diff = 0.11s > 0.08s.
      c.enqueueFrame({ pts: 2.30, duration: 0.04, data: {} as any });
      (c as any).tick();
      expect(setAnchorSpy).toHaveBeenCalledTimes(1); // corrected after cooldown elapsed!
    });

    it('bypasses cooldown for large discontinuities in live clock drift correction', () => {
      const now = vi.spyOn(performance, 'now').mockReturnValue(3000);
      const c = new PlaybackController(
        null,
        () => {},
        null,
        null,
        null,
        25,
        25,
        undefined,
        new Logger('test', 'silent')
      );
      c.duration = Infinity;
      c.start();

      // Initial alignment: f1 PTS is 0.0
      c.enqueueFrame({ pts: 0.0, duration: 0.04, data: {} as any });
      (c as any).tick();

      const setAnchorSpy = vi.spyOn((c as any).masterClock, 'setAnchor');

      // 1. Trigger small correction
      c.enqueueFrame({ pts: 0.09, duration: 0.04, data: {} as any });
      (c as any).tick();
      expect(setAnchorSpy).toHaveBeenCalledTimes(1);
      setAnchorSpy.mockClear();

      // 2. Trigger huge correction immediately after (10ms later).
      // diff is 0.6s > 0.15s (discontinuity). Cooldown should be bypassed!
      now.mockReturnValue(3010);
      c.enqueueFrame({ pts: 0.70, duration: 0.04, data: {} as any }); // clock is 0.09 + 0.01 = 0.10. diff = 0.6s
      (c as any).tick();
      expect(setAnchorSpy).toHaveBeenCalledTimes(1); // bypassed cooldown!
    });

    it('drops frames to catch up when the live queue exceeds catchupThreshold', () => {
      const c = new PlaybackController(
        null,
        () => {},
        null,
        null,
        null,
        25, // targetFps = 25
        25, // renderFps = 25
        undefined,
        new Logger('test', 'silent')
      );
      c.duration = Infinity; // Live
      c.start();

      // Alignment
      c.enqueueFrame({ pts: 0.0, duration: 0.04, data: { close: vi.fn() } as any });
      (c as any).tick();

      // catchupThreshold is Math.max(150, fps * CATCHUP_THRESHOLD_MULT (6)) = Math.max(150, 150) = 150 frames.
      // Let's enqueue 160 frames. Start at i = 1 to avoid frame decimation collision with the first aligned frame.
      const closeSpies: any[] = [];
      for (let i = 1; i <= 160; i++) {
        const closeSpy = vi.fn();
        c.enqueueFrame({ pts: i * 0.04, duration: 0.04, data: { close: closeSpy } as any });
        closeSpies.push(closeSpy);
      }

      // Check current queue length before tick
      expect((c as any).frameQueue.length).toBe(160);

      // Run tick: it should trigger queue size catchup and drop frames down to catchupTarget.
      // catchupTarget = Math.max(60, fps * CATCHUP_TARGET_MULT (2.5)) = Math.max(60, 62) = 62 frames.
      // So it should drop: 160 - 62 = 98 frames.
      // 1 frame of the remaining 62 is also consumed/rendered by this tick, leaving 61 in the queue.
      (c as any).tick();

      expect((c as any).frameQueue.length).toBe(61);
      expect((c as any).droppedFramesCount).toBe(98);
      // Verify that dropped frames were closed (indices 0 to 97 corresponding to i = 1 to 98)
      for (let i = 0; i < 98; i++) {
        expect(closeSpies[i]).toHaveBeenCalledTimes(1);
      }
      // Frame at index 98 (i = 99) was rendered, so it was also closed
      expect(closeSpies[98]).toHaveBeenCalledTimes(1);
      // Remaining frames (indices 99 to 159) should not be closed
      for (let i = 99; i < 160; i++) {
        expect(closeSpies[i]).not.toHaveBeenCalled();
      }
    });
  });
});


describe('PlaybackController signals interval', () => {
  it('fires onSignals callback at 1 Hz with headroom data', async () => {
    vi.useFakeTimers();
    const signals: any[] = [];
    const c = new PlaybackController(
      null, null, null, null, null,
      25, undefined, undefined,
      new Logger('test', 'silent'),
      (s) => signals.push({ ...s }),
    );
    // Advance 1 second to trigger the interval
    vi.advanceTimersByTime(1000);
    expect(signals.length).toBe(1);
    expect(signals[0].targetFps).toBe(25);
    expect(signals[0].throughputKbps).toBe(0); // no loader enrichment
    expect(signals[0].droppedFps).toBe(0);
    expect(typeof signals[0].avgQueueLen).toBe('number');
    expect(typeof signals[0].ts).toBe('number');
    c.destroy();
    vi.useRealTimers();
  });

  it('reports droppedFps accurately from dropped frame timestamps', async () => {
    vi.useFakeTimers();
    const signals: any[] = [];
    const c = new PlaybackController(
      null, null, null, null, null,
      undefined, undefined, undefined,
      new Logger('test', 'silent'),
      (s) => signals.push({ ...s }),
    );
    // Advance to a non-zero time so timestamps are valid
    vi.advanceTimersByTime(500);
    // Simulate drops by manually pushing timestamps within the last 1s
    const now = performance.now();
    (c as any).droppedFrameTimes.push(now - 200);
    (c as any).droppedFrameTimes.push(now - 100);
    (c as any).droppedFrameTimes.push(now - 50);

    vi.advanceTimersByTime(500);
    expect(signals.length).toBe(1);
    expect(signals[0].droppedFps).toBe(3);
    c.destroy();
    vi.useRealTimers();
  });

  it('stops the interval on destroy', async () => {
    vi.useFakeTimers();
    const signals: any[] = [];
    const c = new PlaybackController(
      null, null, null, null, null,
      undefined, undefined, undefined,
      new Logger('test', 'silent'),
      (s) => signals.push({ ...s }),
    );
    c.destroy();
    vi.advanceTimersByTime(3000);
    expect(signals.length).toBe(0);
    vi.useRealTimers();
  });

  it('computes avgQueueLen from tick samples', async () => {
    vi.useFakeTimers();
    const signals: any[] = [];
    const c = new PlaybackController(
      null, null, null, null, null,
      undefined, undefined, undefined,
      new Logger('test', 'silent'),
      (s) => signals.push({ ...s }),
    );
    // Manually push queue length samples
    (c as any).queueLengthSamples.push(10, 20, 30);

    vi.advanceTimersByTime(1000);
    expect(signals.length).toBe(1);
    expect(signals[0].avgQueueLen).toBe(20); // (10+20+30)/3 = 20
    // Samples should be cleared after emission
    expect((c as any).queueLengthSamples.length).toBe(0);
    c.destroy();
    vi.useRealTimers();
  });

  it('prunes renderedFrameTimes in tick() to prevent memory leak without getDiagnostics()', () => {
    const c = new PlaybackController(
      null, null, null, null, null,
      undefined, undefined, undefined,
      new Logger('test', 'silent')
    );
    c.start();
    const ctrl = c as any;

    // Simulate rendering 100 frames at old timestamps
    const nowSpy = vi.spyOn(performance, 'now');
    nowSpy.mockReturnValue(1000);
    for (let i = 0; i < 100; i++) {
      ctrl.renderedFrameTimes.push(1000);
    }
    expect(ctrl.renderedFrameTimes.length).toBe(100);

    // Advance time by 2 seconds and call tick()
    nowSpy.mockReturnValue(3000);
    ctrl.tick();

    // After tick() is processed, all timestamps older than 3000 - 1000 = 2000 should be pruned!
    expect(ctrl.renderedFrameTimes.length).toBe(0);

    c.destroy();
    nowSpy.mockRestore();
  });
});

