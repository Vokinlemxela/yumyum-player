/**
 * Centralized timing policy constants for A/V synchronization,
 * clock adoption, drift correction, underrun holding, and gap detection.
 */
export const TimingPolicy = {
  // --- Audio Master Clock (PCMAudioWorklet / AudioMasterClock) ---
  /** Drift beyond this (seconds) triggers a hard re-anchor instead of a nudge. */
  CLOCK_RESYNC_THRESHOLD: 0.15, // 150ms
  /** Fraction of small drift absorbed per report, to cancel constant offset. */
  CLOCK_DRIFT_NUDGE: 0.05,

  // --- Clock Adoption & Acceptance Gating (PlaybackController) ---
  /** Max gap (s) for the FIRST adoption of the audio clock (startup / post-flush). */
  AUDIO_ADOPT_TOLERANCE: 2.0,
  /** Max gap (s) for following the audio clock once locked — tight, to reject spikes. */
  SEEK_RESYNC_TOLERANCE: 0.5,
  /** Brief underrun hold: max seconds to freeze clock when audio goes silent. */
  UNDERRUN_HOLD: 1.0,

  // --- Live Clock Drift Correction & Hysteresis (PlaybackController) ---
  /** Minimum interval (seconds) between successive clock corrections/re-anchors. */
  CORRECTION_COOLDOWN: 2.0,
  /** Forward drift dead-band (seconds) for live stream: correct clock forward if oldest frame is in the future. */
  LIVE_FORWARD_DEADBAND: 0.080,
  /** Backward drift dead-band padding (seconds) for live stream. */
  LIVE_BACKWARD_PADDING: 0.050,
  /** VOD drift-ahead correction trigger (seconds). */
  VOD_DRIFT_AHEAD_TRIGGER: -0.040,

  // --- Buffering & Gap Detection (PlaybackController) ---
  /** Gap detection threshold (seconds) for live streams. */
  GAP_THRESHOLD_LIVE: 2.0,
  /** Gap detection threshold (seconds) for VOD streams. */
  GAP_THRESHOLD_VOD: 0.250,
  /** Future threshold (seconds) for next frame to trigger gap buffering. */
  NEXT_FRAME_FUTURE_THRESHOLD: 0.5,

  // --- Frame Lag Threshold Parameters ---
  /** Minimum floor value for FRAME_LAG_THRESHOLD. */
  FRAME_LAG_FLOOR: 0.100,
  /** Multiplier for tick interval to compute FRAME_LAG_THRESHOLD. */
  FRAME_LAG_MULT: 1.25,

  // --- Live Catch-up Threshold Parameters ---
  /** Multiplier of FPS to determine queue catchup threshold. */
  CATCHUP_THRESHOLD_MULT: 6,
  /** Multiplier of FPS to determine target queue size on catchup. */
  CATCHUP_TARGET_MULT: 2.5,

  // --- ABR Quality Controller Parameters ---
  /** Cooldown period (seconds) after any quality switch before another can occur. */
  ABR_COOLDOWN_SECONDS: 10,
  /** Dwell time (seconds) required to sustain a down-switch trigger condition. */
  ABR_DOWN_DWELL_SECONDS: 3,
  /** Dwell time (seconds) required to sustain an up-switch trigger condition. */
  ABR_UP_DWELL_SECONDS: 10,
  /** Safety multiplier for down-switching on low throughput. */
  ABR_SAFETY_FACTOR: 1.2,
  /** Headroom multiplier required to upgrade quality. */
  ABR_UP_HEADROOM_FACTOR: 1.5,
  /** Dropped frames per second threshold above which we down-switch. */
  ABR_DROPPED_FPS_THRESHOLD: 2,
  /** Ratio of effective FPS to target FPS below which we down-switch. */
  ABR_FPS_RATIO_THRESHOLD: 0.8,
  /** Average frame queue length below which we down-switch. */
  ABR_QUEUE_STARVATION_THRESHOLD: 1.0,

  // --- Multi-camera WebGL GPU limits ---
  /** Maximum simultaneous active WebGL2 contexts allowed across the application. */
  MAX_GL_CONTEXTS: 8,
  /** Maximum simultaneous active per-pixel JS rendering fallback cells. */
  MAX_JS_CELLS: 2,
};
