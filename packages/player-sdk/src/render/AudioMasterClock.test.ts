import { describe, it, expect } from 'vitest';
import { AudioMasterClock } from './AudioMasterClock.js';

describe('AudioMasterClock', () => {
  it('is not anchored and reads null until the first report', () => {
    const clock = new AudioMasterClock();
    expect(clock.isAnchored).toBe(false);
    expect(clock.read(10)).toBeNull();
  });

  it('anchors on the first report and reads the reported PTS at that instant', () => {
    const clock = new AudioMasterClock();
    clock.update(5.0, 100); // mediaPts=5s when audioCtx.currentTime=100
    expect(clock.isAnchored).toBe(true);
    expect(clock.read(100)).toBeCloseTo(5.0, 6);
  });

  it('advances in lockstep with audioCtx.currentTime', () => {
    const clock = new AudioMasterClock();
    clock.update(5.0, 100);
    // 0.5s of hardware time later → 0.5s of media time later.
    expect(clock.read(100.5)).toBeCloseTo(5.5, 6);
  });

  it('subtracts the output latency so video matches what is heard', () => {
    const clock = new AudioMasterClock();
    clock.update(5.0, 100);
    expect(clock.read(100, 0.02)).toBeCloseTo(4.98, 6);
  });

  it('ignores negative (uninitialized) reports', () => {
    const clock = new AudioMasterClock();
    clock.update(-1, 100);
    expect(clock.isAnchored).toBe(false);
  });

  it('smooths a small drift instead of snapping (no per-frame jitter)', () => {
    const clock = new AudioMasterClock();
    clock.update(5.0, 100);
    // A report 30ms ahead of prediction (within the 150ms threshold): the clock
    // should barely move, nudging by only DRIFT_NUDGE (5%) of the drift.
    clock.update(5.03, 100); // predicted 5.0, drift +0.03
    const expected = 5.0 + 0.03 * AudioMasterClock.DRIFT_NUDGE;
    expect(clock.read(100)).toBeCloseTo(expected, 6);
    // Crucially it did NOT jump to 5.03.
    expect(clock.read(100)).toBeLessThan(5.03);
  });

  it('hard re-anchors on a large discontinuity (> threshold)', () => {
    const clock = new AudioMasterClock();
    clock.update(5.0, 100);
    // A 1s forward jump (seek / PTS discontinuity) exceeds the threshold.
    clock.update(6.0, 100);
    expect(clock.read(100)).toBeCloseTo(6.0, 6);
  });

  it('stays smooth and ~monotonic across many in-sync reports', () => {
    const clock = new AudioMasterClock();
    let media = 10.0;
    let ctx = 50.0;
    clock.update(media, ctx);

    let prev = clock.read(ctx)!;
    // Simulate ~2s of playback: ctx and reported media advance together with a
    // tiny constant message-latency offset (reported lags prediction by ~8ms).
    for (let i = 0; i < 50; i++) {
      ctx += 0.0427; // ~report interval
      media += 0.0427;
      clock.update(media - 0.008, ctx); // constant lag → should be nudged out, not chased
      const now = clock.read(ctx)!;
      expect(now).toBeGreaterThanOrEqual(prev - 1e-9); // never goes backwards
      prev = now;
    }
    // After ~2s the clock tracks real media time closely.
    expect(clock.read(ctx)!).toBeCloseTo(media, 1);
  });

  it('re-anchors fresh after reset', () => {
    const clock = new AudioMasterClock();
    clock.update(5.0, 100);
    clock.reset();
    expect(clock.isAnchored).toBe(false);
    expect(clock.read(200)).toBeNull();
    clock.update(8.0, 200);
    expect(clock.read(200)).toBeCloseTo(8.0, 6);
  });
});
