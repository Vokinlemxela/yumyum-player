/**
 * Smooth, monotonic A/V master clock derived from the audio hardware time.
 *
 * The audio worklet reports a sample-accurate play PTS, but only every ~42ms and
 * over a jittery message port. Extrapolating that value with wall-clock time
 * makes the clock overshoot then snap back, and the video scheduler chases the
 * jitter (frames lag / run away / bounce). Instead we anchor the media PTS to
 * `audioCtx.currentTime` — a smooth, monotonic hardware clock that advances at
 * exactly the same rate as sample consumption — and only re-anchor on a real
 * discontinuity (seek / underrun / PTS jump). Small steady-state drift (e.g. the
 * constant message-latency offset) is nudged out gradually so the clock stays
 * smooth.
 *
 * This class is deliberately free of any Web Audio dependency: the caller passes
 * in `audioCtx.currentTime`. That keeps the timing logic pure and unit-testable.
 */
import { TimingPolicy } from '../sync/TimingPolicy.js';

export interface AudioMasterClockOptions {
  resyncThreshold?: number;     // drift threshold for hard re-anchor
  driftNudge?: number;          // fraction of drift absorbed per update (1.0 = hard snap)
  adoptTolerance?: number;      // max gap (s) for FIRST lock/adoption
  seekResyncTolerance?: number;   // max gap (s) for subsequent lock updates
  underrunHold?: number;        // max seconds to freeze time during underrun
}

export class AudioMasterClock {
  /** Drift beyond this (seconds) triggers a hard re-anchor instead of a nudge. */
  static readonly RESYNC_THRESHOLD = TimingPolicy.CLOCK_RESYNC_THRESHOLD;
  /** Fraction of small drift absorbed per report, to cancel constant offset. */
  static readonly DRIFT_NUDGE = TimingPolicy.CLOCK_DRIFT_NUDGE;

  private readonly resyncThreshold: number;
  private readonly driftNudge: number;
  private readonly adoptTolerance: number;
  private readonly seekResyncTolerance: number;
  private readonly underrunHold: number;

  private anchorCtxTime: number | null = null; // audioCtx.currentTime at the anchor
  private anchorMediaPts = 0;                   // media PTS (s) at the anchor

  private lastAudioClock: number | null = null;
  private lastAudioWall: number | null = null;
  private isAcquired = false;
  private isFrozen = false;

  constructor(options: AudioMasterClockOptions = {}) {
    this.resyncThreshold = options.resyncThreshold ?? AudioMasterClock.RESYNC_THRESHOLD;
    this.driftNudge = options.driftNudge ?? AudioMasterClock.DRIFT_NUDGE;
    this.adoptTolerance = options.adoptTolerance ?? Infinity;
    this.seekResyncTolerance = options.seekResyncTolerance ?? Infinity;
    this.underrunHold = options.underrunHold ?? 0;
  }

  /** Whether an anchor has been established yet. */
  public get isAnchored(): boolean {
    return this.anchorCtxTime !== null;
  }

  /** Whether the audio clock is currently actively acquired. */
  public get audioAcquired(): boolean {
    return this.isAcquired;
  }

  /** Current media PTS anchor. */
  public get anchorPts(): number {
    return this.anchorMediaPts;
  }

  /** Drop the anchor (on flush/seek); the next report re-establishes it. */
  public reset(): void {
    this.anchorCtxTime = null;
    this.anchorMediaPts = 0;
    this.lastAudioClock = null;
    this.lastAudioWall = null;
    this.isAcquired = false;
    this.isFrozen = false;
  }

  /** Manually set the anchor (e.g. on seek or playback start). */
  public setAnchor(mediaPts: number, ctxNow: number): void {
    this.anchorCtxTime = ctxNow;
    this.anchorMediaPts = mediaPts;
    this.lastAudioClock = mediaPts;
    this.lastAudioWall = ctxNow;
    this.isAcquired = false;
    this.isFrozen = false;
  }

  /**
   * Fold a fresh worklet play-PTS report into the anchor.
   * @param reportedPts sample-accurate media PTS (s); null or negative triggers underrun hold
   * @param ctxNow `audioCtx.currentTime` (or wall-clock time) at the moment of the report
   */
  public update(reportedPts: number | null, ctxNow: number): void {
    if (reportedPts === null || reportedPts < 0) {
      if (this.isAcquired && this.lastAudioWall !== null && this.lastAudioClock !== null) {
        this.isFrozen = true;
        if (ctxNow - this.lastAudioWall >= this.underrunHold) {
          // Reached underrun hold limit: lose acquisition, fall back to system time
          this.isAcquired = false;
          this.isFrozen = false;
          this.anchorCtxTime = ctxNow;
          this.anchorMediaPts = this.lastAudioClock;
        }
      }
      return;
    }

    if (this.anchorCtxTime === null) {
      this.anchorCtxTime = ctxNow;
      this.anchorMediaPts = reportedPts;
      this.lastAudioClock = reportedPts;
      this.lastAudioWall = ctxNow;
      this.isAcquired = true;
      this.isFrozen = false;
      return;
    }

    const predicted = this.anchorMediaPts + (ctxNow - this.anchorCtxTime);
    const gap = Math.abs(reportedPts - predicted);

    // Verify clock adopt/resync tolerances if they are active
    const tolerance = this.isAcquired ? this.seekResyncTolerance : this.adoptTolerance;
    if (gap > tolerance) {
      // Out of bounds: reject this update (e.g. spike or old pre-seek PTS)
      return;
    }

    this.isAcquired = true;
    this.isFrozen = false;
    this.lastAudioClock = reportedPts;
    this.lastAudioWall = ctxNow;

    const drift = reportedPts - predicted;

    if (Math.abs(drift) > this.resyncThreshold) {
      // Real discontinuity — snap the anchor to the reported position.
      this.anchorCtxTime = ctxNow;
      this.anchorMediaPts = reportedPts;
    } else {
      // Steady-state: gently pull toward the reported PTS without per-frame jitter.
      this.anchorMediaPts += drift * this.driftNudge;
    }
  }

  /**
   * Current media clock (seconds), or `null` if not yet anchored.
   * @param ctxNow `audioCtx.currentTime` (or wall-clock time)
   * @param latency output latency to subtract so video matches what's heard
   */
  public read(ctxNow: number, latency = 0): number | null {
    if (this.anchorCtxTime === null) return null;

    if (this.isAcquired && this.isFrozen && this.lastAudioClock !== null && this.lastAudioWall !== null) {
      const sinceLastReport = ctxNow - this.lastAudioWall;
      if (sinceLastReport > 0 && sinceLastReport < this.underrunHold) {
        return this.lastAudioClock;
      }
    }

    return this.anchorMediaPts + (ctxNow - this.anchorCtxTime) - latency;
  }
}
