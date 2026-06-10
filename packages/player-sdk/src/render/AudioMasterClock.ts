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
export class AudioMasterClock {
  /** Drift beyond this (seconds) triggers a hard re-anchor instead of a nudge. */
  static readonly RESYNC_THRESHOLD = 0.15; // 150ms
  /** Fraction of small drift absorbed per report, to cancel constant offset. */
  static readonly DRIFT_NUDGE = 0.05;

  private anchorCtxTime: number | null = null; // audioCtx.currentTime at the anchor
  private anchorMediaPts = 0;                   // media PTS (s) at the anchor

  /** Whether an anchor has been established yet. */
  public get isAnchored(): boolean {
    return this.anchorCtxTime !== null;
  }

  /** Drop the anchor (on flush/seek); the next report re-establishes it. */
  public reset(): void {
    this.anchorCtxTime = null;
    this.anchorMediaPts = 0;
  }

  /**
   * Fold a fresh worklet play-PTS report into the anchor.
   * @param reportedPts sample-accurate media PTS (s); ignored when negative
   * @param ctxNow `audioCtx.currentTime` at the moment of the report
   */
  public update(reportedPts: number, ctxNow: number): void {
    if (reportedPts < 0) return;

    if (this.anchorCtxTime === null) {
      this.anchorCtxTime = ctxNow;
      this.anchorMediaPts = reportedPts;
      return;
    }

    const predicted = this.anchorMediaPts + (ctxNow - this.anchorCtxTime);
    const drift = reportedPts - predicted;

    if (Math.abs(drift) > AudioMasterClock.RESYNC_THRESHOLD) {
      // Real discontinuity — snap the anchor to the reported position.
      this.anchorCtxTime = ctxNow;
      this.anchorMediaPts = reportedPts;
    } else {
      // Steady-state: gently pull toward the reported PTS without per-frame jitter.
      this.anchorMediaPts += drift * AudioMasterClock.DRIFT_NUDGE;
    }
  }

  /**
   * Current media clock (seconds), or `null` if not yet anchored.
   * @param ctxNow `audioCtx.currentTime`
   * @param latency output latency to subtract so video matches what's heard
   */
  public read(ctxNow: number, latency = 0): number | null {
    if (this.anchorCtxTime === null) return null;
    return this.anchorMediaPts + (ctxNow - this.anchorCtxTime) - latency;
  }
}
