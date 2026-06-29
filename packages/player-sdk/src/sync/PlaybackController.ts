import { Logger } from '../utils/Logger.js';
import { AudioMasterClock } from '../render/AudioMasterClock.js';
import { TimingPolicy } from './TimingPolicy.js';
import { StreamSignals } from '../quality/Signals.js';

export interface DecodedFrame {
  pts: number; // in seconds
  data: VideoFrame | ImageBitmap | {
    width: number;
    height: number;
    yPlane: Uint8Array;
    uPlane: Uint8Array;
    vPlane: Uint8Array;
  };
  duration: number; // in seconds
}

export type PlaybackState = 'IDLE' | 'PLAYING' | 'PAUSED';

export class PlaybackController {
  private frameQueue: DecodedFrame[] = [];
  private state: PlaybackState = 'IDLE';
  private lastRenderedPTS = -1;
  private droppedFramesCount = 0;
  private renderedFramesCount = 0;
  /**
   * Target media position (s) of an in-progress seek, or null. After a seek the
   * demuxer re-emits from the keyframe before the target, so frames arrive
   * starting below the requested time. Until the target frame is decoded we pin
   * the clock to the target and discard the pre-roll — otherwise the lazy
   * alignment in tick() would anchor the clock to the first decoded frame and
   * playback would jump back to the start (the classic "seek resets to 0" bug).
   */
  private seekTarget: number | null = null;

  // Timings
  public duration = Infinity; // Total media duration to auto-pause at the end
  private playStartTime = 0; // performance.now() of playback start
  private mediaStartClock = 0; // The media position when playback started
  private audioCtxStartOffset: number | null = null; // AudioContext time at start/seek
  private playbackRate = 1; // Playback speed multiplier (1 = normal)
  private lastCorrectionTime = 0; // Last wall-clock time (s) of live clock correction

  // Unified A/V master clock slaved to the audio clock
  private masterClock = new AudioMasterClock({
    resyncThreshold: TimingPolicy.CLOCK_RESYNC_THRESHOLD,
    driftNudge: 1.0, // Hard snap on acceptance
    adoptTolerance: TimingPolicy.AUDIO_ADOPT_TOLERANCE,
    seekResyncTolerance: TimingPolicy.SEEK_RESYNC_TOLERANCE,
    underrunHold: TimingPolicy.UNDERRUN_HOLD
  });

  // Backpressure thresholds for the DECODED-frame queue. Kept small on purpose:
  // the queue holds decoded VideoFrames, and holding many of them back-pressures
  // the WebCodecs output pool and actually slows the decoder. A genuine
  // multi-second look-ahead must buffer RAW segments (cheap), not decoded frames
  // — tracked as a separate follow-up.
  private maxQueueSize = 30;
  private minQueueSize = 10;
  private isBackpressurePaused = false;

  private rafId: number | null = null;
  private isDrawingGap = false;
  /**
   * Buffering = stalled during PLAYING (a gap-stall with no fresh frames). Tracked
   * separately from `isDrawingGap` so we can emit an edge-triggered signal to the
   * consumer (spinner) instead of polling every frame. False on pause/seek/flush.
   */
  private buffering = false;

  private lastKeptPts = -1;
  private decodedFramesCount = 0;
  private renderedFrameTimes: number[] = [];
  private droppedFrameTimes: number[] = [];
  private queueLengthSamples: number[] = [];
  private signalsInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private getAudioClock: (() => number | null) | null, // returns audioCtx.currentTime adjusted for latency
    private onRenderFrame: ((frame: DecodedFrame['data']) => void) | null,
    private onBackpressureChange: ((pause: boolean) => void) | null,
    private onEnded: (() => void) | null | undefined,
    private onBufferingChange: ((buffering: boolean) => void) | null | undefined,
    private targetFps: number | undefined,
    private renderFps: number | undefined,
    private lowPower: boolean | undefined,
    private logger: Logger,
    private onSignals?: ((signals: StreamSignals) => void) | null,
  ) {
    if (this.lowPower) {
      if (this.targetFps === undefined) this.targetFps = 8;
      if (this.renderFps === undefined) this.renderFps = this.targetFps;
      this.maxQueueSize = 5;
      this.minQueueSize = 2;
    } else if (this.targetFps !== undefined) {
      if (this.renderFps === undefined) this.renderFps = this.targetFps;
    }
    this.masterClock.setAnchor(0, performance.now() / 1000);
    this.startSignalsInterval();
  }

  public get hasStarted(): boolean {
    return this.lastRenderedPTS !== -1;
  }

  /** True while playback is stalled (buffering) during PLAYING. */
  public get isBuffering(): boolean {
    return this.buffering;
  }

  public setLowPower(lowPower: boolean): void {
    this.lowPower = lowPower;
    if (lowPower) {
      this.targetFps = 8;
      this.renderFps = 8;
      this.maxQueueSize = 5;
      this.minQueueSize = 2;
      this.logger.info('PlaybackController: Switched to lowPower mode (FPS target: 8)');
    }
  }

  /**
   * Update the buffering flag and notify the consumer only on a transition —
   * never per frame. Centralizes the edge-trigger so tick()/pause()/seek()/flush()
   * all funnel through one place.
   */
  private setBuffering(next: boolean): void {
    if (this.buffering === next) return;
    this.buffering = next;
    this.onBufferingChange?.(next);
  }

  public getState(): PlaybackState {
    return this.state;
  }

  private enqueueCount = 0;

  public enqueueFrame(frame: DecodedFrame) {
    this.enqueueCount++;
    this.decodedFramesCount++;

    if (this.targetFps !== undefined) {
      if (this.lastKeptPts !== -1 && frame.pts >= this.lastKeptPts && frame.pts - this.lastKeptPts < (1 / this.targetFps) - 0.005) {
        if (frame.data && 'close' in frame.data) {
          try {
            frame.data.close();
          } catch (err) {
            this.logger.error('Error closing VideoFrame in targetFps decimation:', err);
          }
        }
        this.droppedFramesCount++;
        this.droppedFrameTimes.push(performance.now());
        return;
      }
      this.lastKeptPts = Math.max(this.lastKeptPts, frame.pts);
    }
    
    // Insert frame in ascending PTS order to support B-frame reordering
    let insertIdx = this.frameQueue.length;
    for (let i = this.frameQueue.length - 1; i >= 0; i--) {
      if (this.frameQueue[i].pts <= frame.pts) {
        break;
      }
      insertIdx = i;
    }
    this.frameQueue.splice(insertIdx, 0, frame);

    // Check backpressure
    this.checkBackpressure();
  }

  public start() {
    if (this.state === 'PLAYING') return;

    this.state = 'PLAYING';
    this.playStartTime = performance.now() / 1000;

    const audioTime = this.getAudioClock ? this.getAudioClock() : null;
    this.audioCtxStartOffset = audioTime;

    this.masterClock.setAnchor(this.mediaStartClock, this.playStartTime);

    this.scheduleTick();
  }

  public pause() {
    if (this.state !== 'PLAYING') return;
    
    // Fix current time before pausing to prevent clock drift/advance
    this.mediaStartClock = this.getCurrentTime();
    
    this.state = 'PAUSED';
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      clearTimeout(this.rafId);
      this.rafId = null;
    }
    this.audioCtxStartOffset = null;
    // Leaving PLAYING — clear any buffering signal so the spinner doesn't stick.
    this.setBuffering(false);

    this.masterClock.setAnchor(this.mediaStartClock, performance.now() / 1000);
  }

  public seek(pts: number) {
    // flush() resets masterClock, so the system clock (anchored at the seek
    // target below) drives playback until the flushed audio pipeline re-anchors
    // at the new position and is re-adopted.
    this.flush();
    this.mediaStartClock = pts;
    this.playStartTime = performance.now() / 1000;
    this.seekTarget = pts;

    const audioTime = this.getAudioClock ? this.getAudioClock() : null;
    this.audioCtxStartOffset = audioTime;

    this.masterClock.setAnchor(pts, this.playStartTime);
  }

  public flush() {
    // Clear and close video frames to avoid memory leaks!
    for (const frame of this.frameQueue) {
      if (frame.data && 'close' in frame.data) {
        try {
          frame.data.close();
        } catch (err) {
          this.logger.error('Error closing VideoFrame in flush:', err);
        }
      }
    }
    this.frameQueue = [];
    this.lastRenderedPTS = -1;
    this.lastKeptPts = -1;
    this.audioCtxStartOffset = null;
    this.isBackpressurePaused = false;
    this.isDrawingGap = false;
    // Seek / codec-change clears any in-progress stall — reset buffering so a
    // stale spinner can't linger across the flush.
    this.setBuffering(false);
    // The audio pipeline is also flushed on seek/codec-change: re-acquire its
    // clock from scratch (the first valid sample after the flush is adopted).
    this.masterClock.reset();
    this.onBackpressureChange?.(false);
  }

  public getDiagnostics() {
    const now = performance.now();
    while (this.renderedFrameTimes.length > 0 && this.renderedFrameTimes[0] < now - 1000) {
      this.renderedFrameTimes.shift();
    }
    return {
      queueLength: this.frameQueue.length,
      droppedFrames: this.droppedFramesCount,
      renderedFrames: this.renderedFramesCount,
      decodedFrames: this.decodedFramesCount,
      effectiveFps: this.renderedFrameTimes.length,
      playbackState: this.state,
      currentPTS: this.getCurrentTime(),
      backpressureActive: this.isBackpressurePaused,
      playbackRate: this.playbackRate,
    };
  }

  public getPlaybackRate(): number {
    return this.playbackRate;
  }

  /**
   * Set the playback speed multiplier. Re-anchors the master clock so the
   * current position is preserved across the rate change. Audio is not
   * time-stretched here (the player mutes audio at non-1x rates), so the
   * scaled system clock drives playback whenever rate !== 1.
   */
  public setPlaybackRate(rate: number) {
    if (!Number.isFinite(rate) || rate <= 0) return;
    // Re-anchor at the current position before switching rate to avoid a jump.
    this.mediaStartClock = this.getCurrentTime();
    this.playStartTime = performance.now() / 1000;
    this.audioCtxStartOffset = null;
    this.playbackRate = rate;
    this.masterClock.setAnchor(this.mediaStartClock, this.playStartTime);
  }

  public getCurrentTime(): number {
    if (this.state !== 'PLAYING') {
      return this.masterClock.anchorPts;
    }

    const now = performance.now() / 1000;
    if (this.playbackRate === 1) {
      const audioTime = this.getAudioClock ? this.getAudioClock() : null;
      this.masterClock.update(audioTime, now);
      return this.masterClock.read(now) ?? this.getSystemClockTime(now);
    }

    return this.getSystemClockTime(now);
  }

  public getSystemClockTime(now = performance.now() / 1000): number {
    if (this.state === 'PLAYING') {
      const elapsed = now - this.playStartTime;
      return this.mediaStartClock + elapsed * this.playbackRate;
    }
    return this.mediaStartClock;
  }

  private scheduleTick() {
    if (this.state !== 'PLAYING') return;
    
    if (typeof document !== 'undefined' && document.hidden) {
      // Background tab: use setTimeout (100ms / 10fps) to keep playback timeline ticking and prevent freezes
      this.rafId = setTimeout(() => this.tick(), 100) as unknown as number;
    } else if (this.renderFps !== undefined) {
      const delay = 1000 / this.renderFps;
      this.rafId = setTimeout(() => this.tick(), delay) as unknown as number;
    } else {
      this.rafId = requestAnimationFrame(() => this.tick());
    }
  }

  private tickCount = 0;

  private tick() {
    if (this.state !== 'PLAYING') return;

    // Prune old render times regularly to prevent memory leaks if telemetry isn't polled
    const now = performance.now();
    while (this.renderedFrameTimes.length > 0 && this.renderedFrameTimes[0] < now - 1000) {
      this.renderedFrameTimes.shift();
    }

    this.tickCount++;
    this.queueLengthSamples.push(this.frameQueue.length);
    const isThrottle = this.tickCount % 60 === 1;

    const tickInterval = this.renderFps ? (1.0 / this.renderFps) : 0.040;
    const FRAME_LAG_THRESHOLD = Math.max(TimingPolicy.FRAME_LAG_FLOOR, tickInterval * TimingPolicy.FRAME_LAG_MULT);

    // Auto-pause at the end of the media VOD stream
    let currentClock = this.getCurrentTime();
    if (this.duration !== Infinity && currentClock >= this.duration) {
      this.logger.debug(`End of stream reached (PTS: ${currentClock.toFixed(2)}s >= Duration: ${this.duration.toFixed(2)}s). Auto-pausing.`);
      this.pause();
      this.onEnded?.();
      return;
    }

    // Real-time synchronization & catch-up
    if (this.lastRenderedPTS !== -1 && this.frameQueue.length > 0) {
      // 1. Queue size catch-up (Live streams only)
      // Dynamic limits based on FPS to avoid conflicts with HLS segment buffers.
      const fps = this.targetFps ?? 25;
      const catchupThreshold = Math.max(150, fps * TimingPolicy.CATCHUP_THRESHOLD_MULT);
      const catchupTarget = Math.max(60, Math.floor(fps * TimingPolicy.CATCHUP_TARGET_MULT));

      if (this.duration === Infinity && this.frameQueue.length > catchupThreshold) {
        const dropCount = this.frameQueue.length - catchupTarget;
        const droppedFrames = this.frameQueue.splice(0, dropCount);
        for (const dropped of droppedFrames) {
          if (dropped.data && 'close' in dropped.data) {
            try {
              dropped.data.close();
            } catch (err) {
              this.logger.error('Error closing VideoFrame in catchup:', err);
            }
          }
        }
        this.droppedFramesCount += dropCount;
        for (let d = 0; d < dropCount; d++) this.droppedFrameTimes.push(performance.now());
      }

      // 2. Drift correction: keep the clock locked closely to the enqueued frame's PTS
      const firstFrame = this.frameQueue[0];
      const clockDiff = firstFrame.pts - currentClock;
      
      let shouldCorrect = false;
      const nowWall = performance.now() / 1000;

      if (this.duration === Infinity) {
        // For live streams, correct forward if the oldest frame is in the future.
        // Correct backward ONLY if the clock has run ahead of the entire queue (newest frame is late).
        const lastFrame = this.frameQueue[this.frameQueue.length - 1];
        const lastFrameDiff = lastFrame.pts - currentClock;

        const exceedsForward = clockDiff > TimingPolicy.LIVE_FORWARD_DEADBAND;
        const exceedsBackward = lastFrameDiff < -(FRAME_LAG_THRESHOLD + TimingPolicy.LIVE_BACKWARD_PADDING);

        if (exceedsForward || exceedsBackward) {
          const cooldownElapsed = nowWall - this.lastCorrectionTime;
          // Bypass cooldown for large discontinuities (exceeding CLOCK_RESYNC_THRESHOLD = 150ms)
          const isDiscontinuity = Math.abs(clockDiff) > TimingPolicy.CLOCK_RESYNC_THRESHOLD;
          if (isDiscontinuity || cooldownElapsed >= TimingPolicy.CORRECTION_COOLDOWN) {
            shouldCorrect = true;
          }
        }
      } else {
        // For VOD streams, only correct if the clock is ahead (drifted ahead) by >40ms (clockDiff < -0.040),
        // to avoid dropping frames as late. Do not pull the clock forward if it is behind.
        shouldCorrect = clockDiff < TimingPolicy.VOD_DRIFT_AHEAD_TRIGGER;
      }

      if (shouldCorrect) {
        this.logger.debug(`Correcting clock to firstFrame.pts: ${firstFrame.pts.toFixed(3)}s (clockDiff: ${clockDiff.toFixed(3)}s)`);
        this.mediaStartClock = firstFrame.pts;
        this.playStartTime = nowWall;
        this.lastCorrectionTime = nowWall;
        this.masterClock.setAnchor(firstFrame.pts, nowWall);
        
        const audioTime = this.getAudioClock ? this.getAudioClock() : null;
        this.audioCtxStartOffset = audioTime;
        
        // Re-read current clock after timeline alignment
        currentClock = this.getCurrentTime();
      }
    }

    // Post-seek landing: drop pre-roll frames (decoded from the keyframe before
    // the target) and keep the clock pinned to the target until the target frame
    // is decoded.
    if (this.seekTarget !== null && this.lastRenderedPTS === -1) {
      while (this.frameQueue.length > 0 && this.frameQueue[0].pts < this.seekTarget) {
        const stale = this.frameQueue.shift()!;
        if (stale.data && 'close' in stale.data) {
          try {
            stale.data.close();
          } catch (err) {
            this.logger.error('Error closing pre-seek VideoFrame:', err);
          }
        }
        this.droppedFramesCount++;
        this.droppedFrameTimes.push(performance.now());
      }
      if (this.frameQueue.length === 0) {
        // Target frame not decoded yet — hold the clock at the target so it
        // can't race ahead, and wait for the next decoded batch.
        const nowWall = performance.now() / 1000;
        this.mediaStartClock = this.seekTarget;
        this.playStartTime = nowWall;
        this.masterClock.setAnchor(this.seekTarget, nowWall);
        this.scheduleTick();
        return;
      }
      // Target frame available — clear seek state; the lazy alignment anchors
      // the clock to it (its pts is ≥ target, ≈ the requested position).
      this.seekTarget = null;
    }

    // Lazy timing alignment on the very first frame processed
    if (this.lastRenderedPTS === -1 && this.frameQueue.length > 0) {
      const nowWall = performance.now() / 1000;
      this.mediaStartClock = this.frameQueue[0].pts;
      this.playStartTime = nowWall;
      this.masterClock.setAnchor(this.mediaStartClock, nowWall);

      const audioTime = this.getAudioClock ? this.getAudioClock() : null;
      this.audioCtxStartOffset = audioTime;

      this.lastRenderedPTS = this.mediaStartClock - 0.01;
      // Re-read the clock after re-anchoring so the scheduling below doesn't
      // measure frames against the pre-alignment (raced-ahead) clock and drop
      // the freshly-decoded frames — the cause of the post-seek freeze.
      currentClock = this.getCurrentTime();
      this.logger.debug(`Aligned timeline to start PTS: ${this.mediaStartClock}s, audioCtxOffset: ${this.audioCtxStartOffset}s`);
    }

    let bestFrame: DecodedFrame | null = null;

    // A/V Sync scheduling algorithm

    while (this.frameQueue.length > 0) {
      const first = this.frameQueue[0];
      const delta = first.pts - currentClock;

      if (delta < -FRAME_LAG_THRESHOLD) {
        // Frame is too late! Drop it without rendering
        const dropped = this.frameQueue.shift()!;
        if (dropped.data && 'close' in dropped.data) {
          try {
            dropped.data.close();
          } catch (err) {
            this.logger.error('Error closing late VideoFrame:', err);
          }
        }
        this.droppedFramesCount++;
        this.droppedFrameTimes.push(performance.now());
      } else if (delta > 0.008) {
        // Frame is in the future. Wait for the clock to catch up.
        break;
      } else {
        // Frame is within timing window.
        // Keep pulling, we want the most recent valid frame.
        if (bestFrame) {
          if (bestFrame.data && 'close' in bestFrame.data) {
            try {
              bestFrame.data.close();
            } catch (err) {
              this.logger.error('Error closing discarded VideoFrame:', err);
            }
          }
        }
        bestFrame = this.frameQueue.shift()!;
      }
    }

    if (bestFrame) {
      // If pts is newer than the last rendered PTS, paint it
      if (bestFrame.pts > this.lastRenderedPTS) {
        try {
          this.onRenderFrame?.(bestFrame.data);
          this.renderedFrameTimes.push(performance.now());
        } catch (err) {
          this.logger.error('Error in onRenderFrame:', err);
        }
        this.lastRenderedPTS = bestFrame.pts;
        this.renderedFramesCount++;
      }

      // Close after rendering (if closeable, i.e., VideoFrame)
      if (bestFrame.data && 'close' in bestFrame.data) {
        try {
          bestFrame.data.close();
        } catch (err) {
          this.logger.error('Error closing rendered VideoFrame:', err);
        }
      }
      this.isDrawingGap = false;
      // A fresh frame painted — playback is no longer stalled.
      this.setBuffering(false);
    } else {
      // Gap Detection: if no new frame rendered within threshold, signal buffering.
      // Live streams have natural gaps at segment boundaries (~1–2s) while the
      // loader fetches and decodes the next HLS segment. Use a generous 2s
      // threshold for live to avoid false spinners; VOD keeps a tight 250ms.
      const GAP_THRESHOLD = this.duration === Infinity ? TimingPolicy.GAP_THRESHOLD_LIVE : TimingPolicy.GAP_THRESHOLD_VOD;
      if (this.state === 'PLAYING' && this.lastRenderedPTS !== -1) {
        const timeSinceLastRendered = currentClock - this.lastRenderedPTS;
        const isQueueEmpty = this.frameQueue.length === 0;
        const isNextFrameFarFuture = !isQueueEmpty && (this.frameQueue[0].pts - currentClock > TimingPolicy.NEXT_FRAME_FUTURE_THRESHOLD);

        if (timeSinceLastRendered > GAP_THRESHOLD && (isQueueEmpty || isNextFrameFarFuture)) {
          this.isDrawingGap = true;
          // Freeze on the last rendered frame instead of painting a black placeholder to prevent flickering.
          // The UI cell (GridPlayerCell.tsx) handles displaying a non-blocking buffering indicator.
          // Edge-triggered signal so the consumer can show a buffering spinner.
          this.setBuffering(true);
        } else {
          this.isDrawingGap = false;
          this.setBuffering(false);
        }
      }
    }

    // Evaluate backpressure queue sizes after consumption
    this.checkBackpressure();

    this.scheduleTick();
  }

  private checkBackpressure() {
    if (this.duration === Infinity) return;

    const len = this.frameQueue.length;

    if (!this.isBackpressurePaused && len >= this.maxQueueSize) {
      this.isBackpressurePaused = true;
      this.onBackpressureChange?.(true); // Trigger PAUSE_DECODING
    } else if (this.isBackpressurePaused && len <= this.minQueueSize) {
      this.isBackpressurePaused = false;
      this.onBackpressureChange?.(false); // Trigger RESUME_DECODING
    }
  }

  public destroy() {
    this.pause();
    this.flush();
    this.stopSignalsInterval();
    this.getAudioClock = null;
    this.onRenderFrame = null;
    this.onBackpressureChange = null;
    this.onEnded = null;
    this.onBufferingChange = null;
    this.onSignals = null;
  }

  private startSignalsInterval(): void {
    this.stopSignalsInterval();
    this.signalsInterval = setInterval(() => {
      if (!this.onSignals) return;
      const now = performance.now();
      // Prune drop timestamps older than 1s
      while (this.droppedFrameTimes.length > 0 && this.droppedFrameTimes[0] < now - 1000) {
        this.droppedFrameTimes.shift();
      }
      // Prune rendered timestamps older than 1s
      while (this.renderedFrameTimes.length > 0 && this.renderedFrameTimes[0] < now - 1000) {
        this.renderedFrameTimes.shift();
      }
      // Average queue length over the sampling window
      const avgQueueLen = this.queueLengthSamples.length > 0
        ? this.queueLengthSamples.reduce((a, b) => a + b, 0) / this.queueLengthSamples.length
        : this.frameQueue.length;
      this.queueLengthSamples.length = 0;

      const signals: StreamSignals = {
        throughputKbps: 0,
        throughputSamples: 0,
        droppedFps: this.droppedFrameTimes.length,
        effectiveFps: this.renderedFrameTimes.length,
        targetFps: this.targetFps ?? 25,
        avgQueueLen: Math.round(avgQueueLen * 10) / 10,
        // proxy state: decoder is configured and actively producing frames
        decoderReady: this.state === 'PLAYING' && this.lastRenderedPTS !== -1,
        ts: now,
      };
      this.onSignals(signals);
    }, 1000);
  }

  private stopSignalsInterval(): void {
    if (this.signalsInterval) {
      clearInterval(this.signalsInterval);
      this.signalsInterval = null;
    }
  }
}
