import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QualityController } from './QualityController.js';
import { QualitySource, QualityLevel } from './QualitySource.js';
import { StreamSignals } from './Signals.js';
import { Logger } from '../utils/Logger.js';
import { shouldEmitQualityChangeOnUnchangedRendition, clampToMaxQualityKind } from '../index.js';

describe('QualityController ABR logic', () => {
  let mockSource: QualitySource;
  let mockLevels: QualityLevel[];
  let activeId: string;
  let switchCalls: string[];
  let logger: Logger;

  beforeEach(() => {
    switchCalls = [];
    activeId = 'level-main';
    mockLevels = [
      { id: 'level-main', label: '720p', url: 'https://ex.com/main.m3u8', kind: 'main', bitrateKbps: 2000 },
      { id: 'level-sub', label: '360p', url: 'https://ex.com/sub.m3u8', kind: 'sub', bitrateKbps: 500 },
    ];
    mockSource = {
      getLevels: () => mockLevels,
      getActiveId: () => activeId,
      switchQuality: (id) => {
        activeId = id;
        switchCalls.push(id);
      },
    };
    logger = new Logger('test', 'silent');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts in manual mode and ignores signals', () => {
    const controller = new QualityController(mockSource, logger, { mode: 'manual' });
    expect(controller.getMode()).toBe('manual');

    // Trigger drops downswitch condition
    controller.reportSignals({
      throughputKbps: 100,
      throughputSamples: 5,
      droppedFps: 10, // > 2 threshold
      effectiveFps: 5,
      targetFps: 25,
      avgQueueLen: 5,
      decoderReady: true,
      ts: performance.now(),
    });

    expect(switchCalls).toHaveLength(0);
  });

  it('down-switches to lower quality on low throughput after dwell time', () => {
    vi.useFakeTimers();
    const controller = new QualityController(mockSource, logger, { mode: 'auto' });
    expect(controller.getMode()).toBe('auto');

    const lowThroughputSignal: StreamSignals = {
      throughputKbps: 400, // < 2000 * 1.2 safety factor
      throughputSamples: 10,
      droppedFps: 0,
      effectiveFps: 25,
      targetFps: 25,
      avgQueueLen: 10,
      decoderReady: true,
      ts: performance.now(),
    };

    // Report first signal
    controller.reportSignals(lowThroughputSignal);
    expect(switchCalls).toHaveLength(0);

    // Advance half of dwell time (1.5s)
    vi.advanceTimersByTime(1500);
    controller.reportSignals({ ...lowThroughputSignal, ts: performance.now() });
    expect(switchCalls).toHaveLength(0);

    // Advance past 3s down dwell time
    vi.advanceTimersByTime(1600);
    controller.reportSignals({ ...lowThroughputSignal, ts: performance.now() });
    
    expect(switchCalls).toContain('level-sub');
    expect(activeId).toBe('level-sub');
    vi.useRealTimers();
  });

  it('down-switches immediately on severe frame drops', () => {
    vi.useFakeTimers();
    const controller = new QualityController(mockSource, logger, { mode: 'auto' });

    const badDropsSignal: StreamSignals = {
      throughputKbps: 2500,
      throughputSamples: 10,
      droppedFps: 5, // > 2 threshold
      effectiveFps: 20,
      targetFps: 25,
      avgQueueLen: 10,
      decoderReady: true,
      ts: performance.now(),
    };

    controller.reportSignals(badDropsSignal);
    vi.advanceTimersByTime(3100); // Wait past 3s down dwell
    controller.reportSignals({ ...badDropsSignal, ts: performance.now() });

    expect(switchCalls).toContain('level-sub');
    vi.useRealTimers();
  });

  it('up-switches to higher quality when throughput is sufficient after longer dwell', () => {
    vi.useFakeTimers();
    activeId = 'level-sub'; // Start at sub
    const controller = new QualityController(mockSource, logger, { mode: 'auto' });

    const highThroughputSignal: StreamSignals = {
      throughputKbps: 3500, // >= 2000 * 1.5 up headroom
      throughputSamples: 10,
      droppedFps: 0, // must be 0 drops
      effectiveFps: 25,
      targetFps: 25,
      avgQueueLen: 10,
      decoderReady: true,
      ts: performance.now(),
    };

    controller.reportSignals(highThroughputSignal);
    expect(switchCalls).toHaveLength(0);

    // Advance 5s (half of up dwell)
    vi.advanceTimersByTime(5000);
    controller.reportSignals({ ...highThroughputSignal, ts: performance.now() });
    expect(switchCalls).toHaveLength(0);

    // Advance to 10s up dwell
    vi.advanceTimersByTime(5100);
    controller.reportSignals({ ...highThroughputSignal, ts: performance.now() });

    expect(switchCalls).toContain('level-main');
    expect(activeId).toBe('level-main');
    vi.useRealTimers();
  });

  it('respects cooldown and does not switch repeatedly', () => {
    vi.useFakeTimers();
    const controller = new QualityController(mockSource, logger, { mode: 'auto' });

    const lowThroughputSignal: StreamSignals = {
      throughputKbps: 400,
      throughputSamples: 10,
      droppedFps: 0,
      effectiveFps: 25,
      targetFps: 25,
      avgQueueLen: 10,
      decoderReady: true,
      ts: performance.now(),
    };

    // First down-switch
    controller.reportSignals(lowThroughputSignal);
    vi.advanceTimersByTime(3100);
    controller.reportSignals({ ...lowThroughputSignal, ts: performance.now() });
    expect(switchCalls).toContain('level-sub');
    expect(switchCalls).toHaveLength(1);

    // Reset levels to have a third level below sub for testing subsequent switches
    mockLevels = [
      { id: 'level-main', label: '720p', url: 'main', kind: 'main', bitrateKbps: 2000 },
      { id: 'level-sub', label: '360p', url: 'sub', kind: 'sub', bitrateKbps: 500 },
      { id: 'level-tiny', label: '144p', url: 'tiny', kind: 'sub', bitrateKbps: 100 },
    ];
    activeId = 'level-sub';

    // Now try to trigger another down-switch to level-tiny immediately
    const tinySignal: StreamSignals = {
      throughputKbps: 50,
      throughputSamples: 10,
      droppedFps: 10,
      effectiveFps: 5,
      targetFps: 25,
      avgQueueLen: 1,
      decoderReady: true,
      ts: performance.now(),
    };

    controller.reportSignals(tinySignal);
    vi.advanceTimersByTime(3100);
    controller.reportSignals({ ...tinySignal, ts: performance.now() });

    // Should not have switched to tiny yet because of cooldown (10 seconds)
    expect(switchCalls).toHaveLength(1); // Still only the first switch in calls array

    // Advance past cooldown (remaining 7s)
    vi.advanceTimersByTime(7000);
    controller.reportSignals(tinySignal); // starts new down dwell
    vi.advanceTimersByTime(3100);
    controller.reportSignals({ ...tinySignal, ts: performance.now() });

    expect(switchCalls).toContain('level-tiny');
    expect(switchCalls).toHaveLength(2);
    vi.useRealTimers();
  });

  it('restricts max quality kind under grid density limits', () => {
    vi.useFakeTimers();
    activeId = 'level-sub';
    const controller = new QualityController(mockSource, logger, { mode: 'auto' });
    
    // Set restriction to sub
    controller.setMaxQualityKind('sub');

    const highThroughputSignal: StreamSignals = {
      throughputKbps: 4000,
      throughputSamples: 10,
      droppedFps: 0,
      effectiveFps: 25,
      targetFps: 25,
      avgQueueLen: 10,
      decoderReady: true,
      ts: performance.now(),
    };

    // Even with high throughput and long dwell, should not raise to main
    controller.reportSignals(highThroughputSignal);
    vi.advanceTimersByTime(11000);
    controller.reportSignals({ ...highThroughputSignal, ts: performance.now() });

    expect(switchCalls).toHaveLength(0);
    expect(activeId).toBe('level-sub');
    vi.useRealTimers();
  });

  it('forces down-switch immediately if current level violates density limit', () => {
    activeId = 'level-main';
    const controller = new QualityController(mockSource, logger, { mode: 'auto' });

    // Restrict to sub while active is main
    controller.setMaxQualityKind('sub');

    expect(switchCalls).toContain('level-sub');
    expect(activeId).toBe('level-sub');
  });

  // ─── Regression: hard ceiling not enforced in manual mode ─────────
  //
  // setMaxQualityKind() is a HARD CEILING (density constraint for multi-camera
  // grid layouts, e.g. cap all cells to 'sub' to protect GPU/bandwidth). It
  // must be enforced in BOTH auto and manual mode. Previously the controller
  // only called evaluateRestriction() when `mode === 'auto'`, so setting a
  // 'sub' ceiling while a cell was manually pinned to 'main' silently stored
  // the restriction but never forced the active rendition down.
  it('forces down-switch immediately when a density limit is set in MANUAL mode', () => {
    activeId = 'level-main';
    const controller = new QualityController(mockSource, logger, { mode: 'manual' });
    const switchEvents: Array<{ id: string; reason: string }> = [];
    controller.onQualitySwitch = (id, reason) => switchEvents.push({ id, reason });

    // Restrict to sub while in MANUAL mode with active = main.
    controller.setMaxQualityKind('sub');

    // The controller must clamp down immediately, regardless of mode.
    expect(switchCalls).toContain('level-sub');
    expect(activeId).toBe('level-sub');
    expect(controller.getMode()).toBe('manual'); // restriction does not itself change mode
    expect(switchEvents).toHaveLength(1);
    expect(switchEvents[0].id).toBe('level-sub');
  });

  it('does NOT force a change when the ceiling is cleared or raised in manual mode', () => {
    // Start pinned to sub in manual mode (e.g. user manually selected sub
    // while a 'sub' ceiling was active).
    activeId = 'level-sub';
    const controller = new QualityController(mockSource, logger, { mode: 'manual' });
    controller.setMaxQualityKind('sub');
    switchCalls.length = 0; // discard the (no-op) switch from setting the ceiling

    // Clearing the ceiling must not force any change — it just lifts the cap;
    // the current manual selection (sub) stays.
    controller.setMaxQualityKind(null);
    expect(switchCalls).toHaveLength(0);
    expect(activeId).toBe('level-sub');

    // Raising the ceiling back up to 'main' must also not force an UP-switch —
    // there is no stored pre-clamp intent to restore.
    controller.setMaxQualityKind('sub'); // re-restrict first
    switchCalls.length = 0;
    controller.setMaxQualityKind('main');
    expect(switchCalls).toHaveLength(0);
    expect(activeId).toBe('level-sub');
  });

  it('reports the real underlying rendition kind even while in auto mode', () => {
    activeId = 'level-main';
    const controller = new QualityController(mockSource, logger, { mode: 'auto' });

    expect(controller.getActiveRenditionKind()).toBe('main');

    // Density restriction pre-empts the active rendition to sub while mode stays 'auto'.
    controller.setMaxQualityKind('sub');
    expect(controller.getMode()).toBe('auto');
    expect(activeId).toBe('level-sub');
    // getActiveRenditionKind must reflect what is ACTUALLY playing, not 'auto'.
    expect(controller.getActiveRenditionKind()).toBe('sub');
  });

  // ─── Regression: swallowed auto→manual transition ─────────────────
  //
  // Reproduces the exact production bug: selecting "SUB" appears to do nothing.
  // 1. On load the app applies setMaxQualityKind('sub') WHILE mode is 'auto',
  //    which force-switches the active rendition to sub but leaves mode 'auto'.
  // 2. The user manually clicks "SUB" → setQuality('sub'). The active id already
  //    equals sub, so the old code early-returned without emitting 'qualitychange'
  //    — the app's listener never fired and the UI never reconciled from AUTO.
  //
  // This test drives the REAL QualityController through the pre-emption, then
  // replays the player's setQuality('sub') algorithm using the REAL exported
  // decision helper `shouldEmitQualityChangeOnUnchangedRendition`. It FAILS
  // before the fix (helper/branch absent → no emit) and PASSES after.
  it('emits qualitychange when manually selecting sub that ABR already pre-empted (auto→manual)', () => {
    activeId = 'level-main';
    const controller = new QualityController(mockSource, logger, { mode: 'auto' });

    // Step 1: density restriction applied in auto mode force-switches to sub.
    controller.setMaxQualityKind('sub');
    expect(activeId).toBe('level-sub');
    expect(controller.getMode()).toBe('auto'); // mode NOT collapsed by the restriction

    // Step 2: user manually selects "sub" — replay the player's setQuality algorithm.
    const emitted: Array<{ event: string; id: string }> = [];
    const emit = (event: string, id: string) => emitted.push({ event, id });

    const modeChanged = controller.getMode() !== 'manual';
    controller.setMode('manual');

    // Resolve alias 'sub' → concrete level id (as the player does).
    const resolvedId = mockLevels.find(l => l.kind === 'sub')!.id;
    const currentActiveId = mockSource.getActiveId();
    const renditionChanged = currentActiveId !== resolvedId;

    if (renditionChanged) {
      mockSource.switchQuality(resolvedId);
      emit('qualitychange', resolvedId);
    } else if (shouldEmitQualityChangeOnUnchangedRendition(renditionChanged, modeChanged)) {
      emit('qualitychange', resolvedId);
    }

    // The transition MUST be observable and the mode MUST become manual.
    expect(controller.getMode()).toBe('manual');
    expect(emitted).toEqual([{ event: 'qualitychange', id: 'level-sub' }]);
  });

  it('does NOT emit a spurious qualitychange on a genuine no-op manual re-select', () => {
    activeId = 'level-sub';
    const controller = new QualityController(mockSource, logger, { mode: 'manual' });

    const emitted: string[] = [];
    const modeChanged = controller.getMode() !== 'manual'; // false — already manual
    controller.setMode('manual');

    const resolvedId = mockLevels.find(l => l.kind === 'sub')!.id;
    const renditionChanged = mockSource.getActiveId() !== resolvedId; // false

    if (renditionChanged) {
      mockSource.switchQuality(resolvedId);
      emitted.push(resolvedId);
    } else if (shouldEmitQualityChangeOnUnchangedRendition(renditionChanged, modeChanged)) {
      emitted.push(resolvedId);
    }

    expect(emitted).toEqual([]); // no spurious event, no double-emit
  });

  it('shouldEmitQualityChangeOnUnchangedRendition: truth table', () => {
    // rendition changed → switch path emits, helper stays out of it
    expect(shouldEmitQualityChangeOnUnchangedRendition(true, true)).toBe(false);
    expect(shouldEmitQualityChangeOnUnchangedRendition(true, false)).toBe(false);
    // rendition unchanged + mode changed (auto→manual) → emit
    expect(shouldEmitQualityChangeOnUnchangedRendition(false, true)).toBe(true);
    // rendition unchanged + mode unchanged → silent
    expect(shouldEmitQualityChangeOnUnchangedRendition(false, false)).toBe(false);
  });

  // ─── Regression: index.ts setQuality() bypasses the density ceiling ────
  //
  // The player's `setQuality(id)` resolved 'main'/'sub' aliases to a concrete
  // level id and called `activeLoader.quality.switchQuality(resolvedId)`
  // directly — bypassing the QualityController entirely. So
  // `setQuality('main')` under a 'sub' density ceiling (grid density limit)
  // would happily switch to and play 'main', silently violating the ceiling.
  //
  // `clampToMaxQualityKind` is the exact (exported, pure) function
  // `index.ts`'s setQuality() now calls to clamp the resolved target before
  // switching/comparing against the active id — these tests exercise it
  // directly, and the second test below replays setQuality()'s full
  // resolve → clamp → compare → emit sequence the way the player does,
  // reusing the REAL QualityController + the REAL exported decision helpers
  // (this file cannot instantiate the full YumYumPlayer — it needs a canvas/
  // WebGL2 context — so this replay is the most faithful level testable).
  describe('clampToMaxQualityKind (index.ts setQuality density-ceiling clamp)', () => {
    it('clamps a request that exceeds the ceiling down to the highest conforming level', () => {
      const clamped = clampToMaxQualityKind(mockLevels, 'level-main', 'sub');
      expect(clamped).toBe('level-sub');
    });

    it('does not clamp when the target already conforms to the ceiling', () => {
      const clamped = clampToMaxQualityKind(mockLevels, 'level-sub', 'sub');
      expect(clamped).toBe('level-sub');
    });

    it('does not clamp when there is no ceiling (null)', () => {
      const clamped = clampToMaxQualityKind(mockLevels, 'level-main', null);
      expect(clamped).toBe('level-main');
    });

    it('does not clamp when the ceiling is main (nothing exceeds the top)', () => {
      const clamped = clampToMaxQualityKind(mockLevels, 'level-main', 'main');
      expect(clamped).toBe('level-main');
    });

    it("picks the highest-bitrate conforming level when multiple 'sub' levels exist", () => {
      const levels: QualityLevel[] = [
        { id: 'level-main', label: '720p', url: 'main', kind: 'main', bitrateKbps: 2000 },
        { id: 'level-sub', label: '360p', url: 'sub', kind: 'sub', bitrateKbps: 500 },
        { id: 'level-tiny', label: '144p', url: 'tiny', kind: 'sub', bitrateKbps: 100 },
      ];
      const clamped = clampToMaxQualityKind(levels, 'level-main', 'sub');
      expect(clamped).toBe('level-sub'); // highest bitrate among conforming ('sub') levels
    });

    it('replays setQuality("main") under a sub ceiling: clamps target AND emits the clamped id', () => {
      // Player is manual, active is already 'level-sub' (e.g. the user had
      // previously picked sub, or ABR had pre-empted down to it).
      activeId = 'level-sub';
      const controller = new QualityController(mockSource, logger, { mode: 'manual' });
      controller.setMaxQualityKind('sub'); // grid density ceiling in effect

      const emitted: Array<{ event: string; id: string }> = [];
      const emit = (event: string, id: string) => emitted.push({ event, id });

      // Replay setQuality('main') exactly as index.ts does post-fix:
      // resolve alias → clamp against the ceiling → compare → switch/emit.
      const modeChanged = controller.getMode() !== 'manual'; // false, already manual
      controller.setMode('manual');

      const resolvedAlias = mockLevels.find(l => l.kind === 'main')!.id; // 'level-main'
      const clampedId = clampToMaxQualityKind(mockLevels, resolvedAlias, controller.getMaxQualityKind());
      expect(clampedId).toBe('level-sub'); // clamped DOWN from main to sub

      const currentActiveId = mockSource.getActiveId();
      const renditionChanged = currentActiveId !== clampedId; // false — already sub

      if (renditionChanged) {
        mockSource.switchQuality(clampedId);
        emit('qualitychange', clampedId);
      } else if (shouldEmitQualityChangeOnUnchangedRendition(renditionChanged, modeChanged)) {
        emit('qualitychange', clampedId);
      }

      // The player must never end up playing 'main' — the ceiling holds, and
      // consumers see the clamped ('sub') id, not the originally-requested one.
      // (Mode was already manual and the clamped rendition was already active,
      // so no event fires at all here — see the truth table above.)
      expect(mockSource.getActiveId()).toBe('level-sub');
      expect(emitted).toEqual([]);
    });

    it('replays setQuality("main") under a sub ceiling: SWITCH path also respects the clamp (not just the unchanged-rendition path)', () => {
      // Three levels so the clamped target ('level-sub', highest-bitrate
      // conforming) is a DIFFERENT id than the currently-active one
      // ('level-tiny'), forcing the replay through the renditionChanged=true
      // switch path rather than the unchanged-rendition emit path.
      const levels: QualityLevel[] = [
        { id: 'level-main', label: '720p', url: 'main', kind: 'main', bitrateKbps: 2000 },
        { id: 'level-sub', label: '360p', url: 'sub', kind: 'sub', bitrateKbps: 500 },
        { id: 'level-tiny', label: '144p', url: 'tiny', kind: 'sub', bitrateKbps: 100 },
      ];
      mockLevels = levels;
      activeId = 'level-tiny';
      const controller = new QualityController(mockSource, logger, { mode: 'manual' });
      controller.setMaxQualityKind('sub'); // active kind is already 'sub' -> no forced switch here
      expect(mockSource.getActiveId()).toBe('level-tiny');
      switchCalls.length = 0; // isolate from the ceiling-set call above

      const emitted: Array<{ event: string; id: string }> = [];
      const emit = (event: string, id: string) => emitted.push({ event, id });

      const modeChanged = controller.getMode() !== 'manual'; // false
      controller.setMode('manual');

      const resolvedAlias = levels.find(l => l.kind === 'main')!.id; // 'level-main'
      const clampedId = clampToMaxQualityKind(levels, resolvedAlias, controller.getMaxQualityKind());
      expect(clampedId).toBe('level-sub'); // highest-bitrate conforming level, NOT level-tiny

      const currentActiveId = mockSource.getActiveId(); // 'level-tiny'
      const renditionChanged = currentActiveId !== clampedId; // true — tiny !== sub

      if (renditionChanged) {
        mockSource.switchQuality(clampedId);
        emit('qualitychange', clampedId);
      } else if (shouldEmitQualityChangeOnUnchangedRendition(renditionChanged, modeChanged)) {
        emit('qualitychange', clampedId);
      }

      // Switched to the CLAMPED id (sub), never to the originally-requested main.
      expect(switchCalls).toEqual(['level-sub']);
      expect(mockSource.getActiveId()).toBe('level-sub');
      expect(emitted).toEqual([{ event: 'qualitychange', id: 'level-sub' }]);
    });
  });
});
