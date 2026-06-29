import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QualityController } from './QualityController.js';
import { QualitySource, QualityLevel } from './QualitySource.js';
import { StreamSignals } from './Signals.js';
import { Logger } from '../utils/Logger.js';

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
});
