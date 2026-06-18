import { Logger } from '../utils/Logger.js';

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
  // A/V master-clock fallback state. The audio clock is the master, but it can
  // briefly vanish (underrun) or jump (re-anchor after a seek). `audioAcquired`
  // tracks whether we've locked onto it: the first lock adopts it outright, then
  // we follow it only while it stays near the (audio-slaved) system clock, so the
  // video scheduler never sees a multi-second jump.
  private audioAcquired = false;
  private lastAudioClock = 0;            // last accepted audio-clock value (s)
  private lastAudioWall = 0;             // performance.now()/1000 at that moment
  /** How long to hold the last audio position on an underrun before freewheeling. */
  private static readonly UNDERRUN_HOLD = 1.0;

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

  constructor(
    private getAudioClock: (() => number | null) | null, // returns audioCtx.currentTime adjusted for latency
    private onRenderFrame: ((frame: DecodedFrame['data']) => void) | null,
    private onBackpressureChange: ((pause: boolean) => void) | null,
    private onEnded: (() => void) | null | undefined,
    private onBufferingChange: ((buffering: boolean) => void) | null | undefined,
    private targetFps: number | undefined,
    private renderFps: number | undefined,
    private lowPower: boolean | undefined,
    private logger: Logger
  ) {
    if (this.lowPower) {
      if (this.targetFps === undefined) this.targetFps = 8;
      if (this.renderFps === undefined) this.renderFps = this.targetFps;
      this.maxQueueSize = 5;
      this.minQueueSize = 2;
    } else if (this.targetFps !== undefined) {
      if (this.renderFps === undefined) this.renderFps = this.targetFps;
    }
  }

  public get hasStarted(): boolean {
    return this.lastRenderedPTS !== -1;
  }

  /** True while playback is stalled (buffering) during PLAYING. */
  public get isBuffering(): boolean {
    return this.buffering;
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
  }

  public seek(pts: number) {
    // flush() resets audioAcquired, so the system clock (anchored at the seek
    // target below) drives playback until the flushed audio pipeline re-anchors
    // at the new position and is re-adopted — it can't race ahead of the
    // not-yet-decoded video and drop every incoming frame.
    this.flush();
    this.mediaStartClock = pts;
    this.playStartTime = performance.now() / 1000;
    this.seekTarget = pts;

    const audioTime = this.getAudioClock ? this.getAudioClock() : null;
    this.audioCtxStartOffset = audioTime;
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
    this.audioAcquired = false;
    this.lastAudioWall = 0;
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
  }

  /** Max gap (s) for following the audio clock once locked — tight, to reject spikes. */
  private static readonly SEEK_RESYNC_TOLERANCE = 0.5;
  /**
   * Max gap (s) for the FIRST adoption of the audio clock (startup / post-flush).
   * Generous enough to absorb audio output+buffer latency (the audio heard now is
   * ~1s behind the video-anchored placeholder clock) while still rejecting a
   * wildly stale value such as the pre-seek position.
   */
  private static readonly AUDIO_ADOPT_TOLERANCE = 2.0;

  public getCurrentTime(): number {
    // At non-1x speed the audio clock is not stretched, so it no longer
    // reflects the (scaled) media position — always use the system clock.
    if (this.playbackRate === 1) {
      const audioTime = this.getAudioClock ? this.getAudioClock() : null;

      if (audioTime !== null && audioTime >= 0) {
        const systemTime = this.getSystemClockTime();
        // Audio is the A/V master. On the FIRST acquisition (startup, or after a
        // flush/seek) adopt it unconditionally and re-anchor the system clock to
        // it — the audio clock reflects what is actually heard, and the system
        // clock was only a video-anchored placeholder that sits ~1 buffer ahead.
        // After that, follow audio only while it stays near the (audio-slaved)
        // system clock: normal progression always passes, but a spike (bad PTS
        // marker / underrun overshoot) or stale value is rejected so the video
        // scheduler never sees a multi-second jump.
        const gap = Math.abs(audioTime - systemTime);
        // First lock: adopt within a generous window that absorbs the audio
        // output/buffer latency (~1s) but still rejects a wildly stale value (e.g.
        // the old position racing in before a post-seek flush settles). Once
        // locked: a tight window rejects spikes.
        const accept = this.audioAcquired
          ? gap <= PlaybackController.SEEK_RESYNC_TOLERANCE
          : gap <= PlaybackController.AUDIO_ADOPT_TOLERANCE;
        if (accept) {
          this.audioAcquired = true;
          // Slave the system (fallback) clock to audio so a future underrun
          // freewheels seamlessly from here instead of snapping to a diverged clock.
          this.mediaStartClock = audioTime;
          this.playStartTime = performance.now() / 1000;
          this.lastAudioClock = audioTime;
          this.lastAudioWall = this.playStartTime;
          return audioTime;
        }
        // Diverged spike: freewheel on the (last-slaved) system clock, no re-anchor.
        return systemTime;
      }

      // Audio clock unavailable. Distinguish a brief underrun (audio was just
      // playing) from a genuinely audio-less stream.
      if (this.audioAcquired) {
        const now = performance.now() / 1000;
        if (now - this.lastAudioWall < PlaybackController.UNDERRUN_HOLD) {
          // Brief underrun: hold the last audio position so video freezes in place
          // (honest micro-rebuffer) and stays in A/V sync, rather than racing the
          // realtime system clock and then jumping back when audio returns.
          return this.lastAudioClock;
        }
        // Audio has been gone too long — give up on it and let the system clock
        // freewheel so playback continues (re-anchored at the held position). The
        // next valid audio sample re-adopts (one-time correction) to regain sync.
        this.audioAcquired = false;
        this.mediaStartClock = this.lastAudioClock;
        this.playStartTime = performance.now() / 1000;
      }
    }

    return this.getSystemClockTime();
  }

  public getSystemClockTime(): number {
    if (this.state === 'PLAYING') {
      const elapsed = (performance.now() / 1000) - this.playStartTime;
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
    this.tickCount++;
    const isThrottle = this.tickCount % 60 === 1;

    // Auto-pause at the end of the media VOD stream
    let currentClock = this.getCurrentTime();
    if (this.duration !== Infinity && currentClock >= this.duration) {
      this.logger.debug(`End of stream reached (PTS: ${currentClock.toFixed(2)}s >= Duration: ${this.duration.toFixed(2)}s). Auto-pausing.`);
      this.pause();
      this.onEnded?.();
      return;
    }

    // Real-time synchronization & catch-up for live streams (Infinity duration)
    if (this.duration === Infinity && this.frameQueue.length > 0) {
      // 1. Queue size catch-up: if queue size exceeds 45 frames (~1.5s lag), discard old ones to jump to live edge
      if (this.frameQueue.length > 45) {
        const dropCount = this.frameQueue.length - 5;
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
      }

      // 2. Clock drift correction: keep the clock locked closely to the enqueued frame's PTS
      const firstFrame = this.frameQueue[0];
      const clockDiff = firstFrame.pts - currentClock;
      // If clock is ahead by more than 40ms or behind by more than 80ms, align clock instantly
      if (clockDiff < -0.040 || clockDiff > 0.080) {
        this.mediaStartClock = firstFrame.pts;
        this.playStartTime = performance.now() / 1000;
        
        const audioTime = this.getAudioClock ? this.getAudioClock() : null;
        this.audioCtxStartOffset = audioTime;
        
        // Re-read current clock after timeline alignment
        currentClock = this.getCurrentTime();
      }
    }

    // Post-seek landing: drop pre-roll frames (decoded from the keyframe before
    // the target) and keep the clock pinned to the target until the target frame
    // is decoded. This must run before the lazy alignment below, which would
    // otherwise anchor the clock to the first decoded frame (≈0) and undo the seek.
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
      }
      if (this.frameQueue.length === 0) {
        // Target frame not decoded yet — hold the clock at the target so it
        // can't race ahead, and wait for the next decoded batch.
        this.mediaStartClock = this.seekTarget;
        this.playStartTime = performance.now() / 1000;
        this.scheduleTick();
        return;
      }
      // Target frame available — clear seek state; the lazy alignment anchors
      // the clock to it (its pts is ≥ target, ≈ the requested position).
      this.seekTarget = null;
    }

    // Lazy timing alignment on the very first frame processed
    if (this.lastRenderedPTS === -1 && this.frameQueue.length > 0) {
      this.mediaStartClock = this.frameQueue[0].pts;
      this.playStartTime = performance.now() / 1000;

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
    // 100ms threshold for dropping laggy frames.
    // Kept larger than the clock ahead threshold (80ms) so clock is corrected before frames are dropped.
    const FRAME_LAG_THRESHOLD = 0.100; // 100ms in seconds

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
      // Gap Detection: if no new frame rendered for >250ms, trigger placeholder frame
      const GAP_THRESHOLD = 0.250; // 250ms
      if (this.state === 'PLAYING' && this.lastRenderedPTS !== -1) {
        const timeSinceLastRendered = currentClock - this.lastRenderedPTS;
        const isQueueEmpty = this.frameQueue.length === 0;
        const isNextFrameFarFuture = !isQueueEmpty && (this.frameQueue[0].pts - currentClock > 0.5);

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
    this.getAudioClock = null;
    this.onRenderFrame = null;
    this.onBackpressureChange = null;
    this.onEnded = null;
    this.onBufferingChange = null;
  }
}
