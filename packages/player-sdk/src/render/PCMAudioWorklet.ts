import { Logger } from '../utils/Logger.js';
import { AudioMasterClock } from './AudioMasterClock.js';

// Storing the audio worklet processor as a raw string to convert into an in-memory Object URL.
// This guarantees zero external configuration/network request delays for players.
const audioWorkletProcessorCode = `
class PCMPlayerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.bufferSize = options.processorOptions?.bufferSize || 128 * 1024;
    
    // Allocate Ring buffers for stereo channels
    this.leftChannelBuffer = new Float32Array(this.bufferSize);
    this.rightChannelBuffer = new Float32Array(this.bufferSize);
    
    this.readPos = 0;
    this.writePos = 0;
    this.available = 0;

    // PTS queue and registry
    this.currentPlayPTS = -1;
    this.ptsQueue = []; // array of { writePos: number, pts: number }
    this.tickCount = 0;

    this.port.onmessage = (event) => {
      const data = event.data; // Expected { type: 'WRITE', left: Float32Array, right: Float32Array, pts?: number }
      if (data && data.type === 'WRITE') {
        this._enqueue(data.left, data.right, data.pts);
      } else if (data && data.type === 'FLUSH') {
        this._flush();
      } else if (data && data.type === 'SYNC') {
        this._sync(data.pts);
      }
    };
  }

  _enqueue(left, right, pts) {
    const len = left.length;
    const samplesToWrite = Math.min(len, this.bufferSize);
    
    // If incoming data exceeds buffer capacity, skip leading samples
    const startOffset = len > this.bufferSize ? len - this.bufferSize : 0;
    
    if (pts !== undefined && pts !== null && pts >= 0) {
      // Associate this PTS with the current write position in the ring buffer
      this.ptsQueue.push({ writePos: this.writePos, pts: pts });
    }

    const samplesToEnd = this.bufferSize - this.writePos;
    if (samplesToWrite <= samplesToEnd) {
      this.leftChannelBuffer.set(left.subarray(startOffset, startOffset + samplesToWrite), this.writePos);
      if (right) {
        this.rightChannelBuffer.set(right.subarray(startOffset, startOffset + samplesToWrite), this.writePos);
      } else {
        this.rightChannelBuffer.set(left.subarray(startOffset, startOffset + samplesToWrite), this.writePos);
      }
      this.writePos = (this.writePos + samplesToWrite) % this.bufferSize;
    } else {
      const firstPartSize = samplesToEnd;
      const secondPartSize = samplesToWrite - samplesToEnd;

      // Copy first part (to the end of the ring buffer)
      this.leftChannelBuffer.set(left.subarray(startOffset, startOffset + firstPartSize), this.writePos);
      if (right) {
        this.rightChannelBuffer.set(right.subarray(startOffset, startOffset + firstPartSize), this.writePos);
      } else {
        this.rightChannelBuffer.set(left.subarray(startOffset, startOffset + firstPartSize), this.writePos);
      }

      // Copy second part (to the beginning of the ring buffer)
      this.leftChannelBuffer.set(left.subarray(startOffset + firstPartSize, startOffset + samplesToWrite), 0);
      if (right) {
        this.rightChannelBuffer.set(right.subarray(startOffset + firstPartSize, startOffset + samplesToWrite), 0);
      } else {
        this.rightChannelBuffer.set(left.subarray(startOffset + firstPartSize, startOffset + samplesToWrite), 0);
      }

      this.writePos = secondPartSize;
    }
    this.available = Math.min(this.available + samplesToWrite, this.bufferSize);
  }

  _flush() {
    this.readPos = 0;
    this.writePos = 0;
    this.available = 0;
    this.currentPlayPTS = -1;
    this.ptsQueue = [];
    this.leftChannelBuffer.fill(0);
    this.rightChannelBuffer.fill(0);
  }

  _sync(targetPts) {
    if (targetPts === undefined || targetPts === null || targetPts < 0 || this.ptsQueue.length === 0) {
      return;
    }

    // Find the marker in ptsQueue that is closest to targetPts
    let bestMarkerIdx = -1;
    let minDiff = Infinity;

    for (let i = 0; i < this.ptsQueue.length; i++) {
      const diff = Math.abs(this.ptsQueue[i].pts - targetPts);
      if (diff < minDiff) {
        minDiff = diff;
        bestMarkerIdx = i;
      }
    }

    if (bestMarkerIdx !== -1) {
      const marker = this.ptsQueue[bestMarkerIdx];
      
      // Calculate how many samples we need to skip from our current readPos to reach the marker's writePos
      let samplesToSkip = 0;
      if (marker.writePos >= this.readPos) {
        samplesToSkip = marker.writePos - this.readPos;
      } else {
        samplesToSkip = (this.bufferSize - this.readPos) + marker.writePos;
      }

      // We cannot skip more samples than are available in the buffer
      if (samplesToSkip <= this.available) {
        this.readPos = marker.writePos;
        this.available -= samplesToSkip;
        this.currentPlayPTS = marker.pts;
        
        // Remove all markers in the queue up to the best marker
        this.ptsQueue.splice(0, bestMarkerIdx + 1);
      }
    }
  }

  _hasCrossed(start, length, target) {
    const end = (start + length) % this.bufferSize;
    if (start <= end) {
      return target >= start && target < end;
    } else {
      // Wraps around
      return target >= start || target < end;
    }
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const outL = output[0];
    const outR = output[1] || output[0]; // Fallback to mono if only 1 channel output

    const requestedSamples = outL.length;

    if (this.available >= requestedSamples) {
      // Check PTS markers
      while (this.ptsQueue.length > 0) {
        const firstMarker = this.ptsQueue[0];
        if (this._hasCrossed(this.readPos, requestedSamples, firstMarker.writePos)) {
          this.currentPlayPTS = firstMarker.pts;
          this.ptsQueue.shift();
        } else {
          break;
        }
      }

      const samplesToEnd = this.bufferSize - this.readPos;
      if (requestedSamples <= samplesToEnd) {
        outL.set(this.leftChannelBuffer.subarray(this.readPos, this.readPos + requestedSamples));
        outR.set(this.rightChannelBuffer.subarray(this.readPos, this.readPos + requestedSamples));
        this.readPos = (this.readPos + requestedSamples) % this.bufferSize;
      } else {
        const firstPartSize = samplesToEnd;
        const secondPartSize = requestedSamples - samplesToEnd;

        outL.set(this.leftChannelBuffer.subarray(this.readPos, this.readPos + firstPartSize), 0);
        outR.set(this.rightChannelBuffer.subarray(this.readPos, this.readPos + firstPartSize), 0);

        outL.set(this.leftChannelBuffer.subarray(0, secondPartSize), firstPartSize);
        outR.set(this.rightChannelBuffer.subarray(0, secondPartSize), firstPartSize);

        this.readPos = secondPartSize;
      }
      this.available -= requestedSamples;

      // Advance play PTS linearly if it has been initialized
      if (this.currentPlayPTS >= 0) {
        this.currentPlayPTS += requestedSamples / sampleRate;
      }
    } else {
      // Underrun - output silence
      outL.fill(0);
      outR.fill(0);
    }

    // Periodically post status back to the main thread
    this.tickCount++;
    if (this.tickCount % 16 === 0) {
      this.port.postMessage({
        type: 'PLAY_STATUS',
        playPts: this.currentPlayPTS,
        available: this.available
      });
    }

    return true; // Keep processor alive
  }
}

registerProcessor('pcm-player-processor', PCMPlayerProcessor);
`;

export class PCMAudioWorklet {
  private audioCtx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private gainNode: GainNode | null = null;
  private workletUrl: string | null = null;
  private isInitialized = false;
  private volumeLevel = 1.0;
  private isMuted = false;

  /** Whether audio is currently muted (read-only accessor for external consumers) */
  public get isMutedState(): boolean {
    return this.isMuted;
  }

  // Real-time PTS tracking states
  private lastReportedPlayPts = -1;
  private audioBufferAvailable = 0;
  private lastSeenSampleRate = 44100;

  // Bounded-concurrency, order-preserving pipeline for the Web Audio fallback
  // (browsers without WebCodecs AAC, e.g. Yandex). `decodeAudioData` is async.
  // The naive approach — strictly serialize decode→feed→next decode — means a
  // single slow decode or a momentarily busy main thread stalls the whole chain,
  // so the worklet ring buffer drains to zero and the master clock has to hold
  // (the periodic micro-freezes on this path). Instead we let up to
  // MAX_CONCURRENT_FALLBACK_DECODES decodes run at once so they pipeline and
  // refill the ring buffer ahead of realtime, while still feeding the decoded
  // PCM into the worklet in strict arrival order — out-of-order feeds would
  // scramble the PCM/PTS markers and make the clock jump.
  private static readonly MAX_CONCURRENT_FALLBACK_DECODES = 3;
  // Target audio lead (seconds) the pipeline builds ahead of playback. Big
  // enough to absorb bursty decodeAudioData (kills the underruns), but well
  // under the worklet ring buffer (~11.6s) so a live backlog can't be decoded
  // faster than realtime and overrun the buffer — which laps readPos, scrambles
  // the PTS markers, and breaks A/V sync. New decodes are gated on this;
  // in-flight ones (≤ MAX_CONCURRENT) may overshoot the target slightly.
  private static readonly FALLBACK_LEAD_TARGET_SECONDS = 4;
  private fallbackSeq = 0;        // sequence number assigned to each batch on arrival
  private fallbackNextFeed = 0;   // next sequence number to feed into the worklet
  private fallbackInFlight = 0;   // decodeAudioData calls currently running
  private fallbackEpoch = 0;      // bumped on flush() to abandon stale in-flight decodes
  private fallbackPending: Array<{ buffer: ArrayBuffer; pts: number; seq: number }> = [];
  // Decoded results waiting for their predecessors so they can be fed in order.
  // A `null` value marks a failed decode whose slot must still be skipped over.
  private fallbackReady = new Map<number, { left: Float32Array; right?: Float32Array; sampleRate: number; pts: number } | null>();

  // Smooth, monotonic A/V master clock anchored to audioCtx.currentTime. See
  // AudioMasterClock for the rationale; the timing math lives there so it can be
  // unit-tested without Web Audio.
  private masterClock = new AudioMasterClock();

  constructor(private logger: Logger) {
    // Generate static blob URL for AudioWorklet
    const blob = new Blob([audioWorkletProcessorCode], { type: 'application/javascript' });
    this.workletUrl = URL.createObjectURL(blob);
  }

  public async initialize(sampleRate = 48000): Promise<void> {
    if (this.isInitialized) return;

    this.lastSeenSampleRate = sampleRate;

    // Standard AudioContext initialization (preserve if already created synchronously)
    if (!this.audioCtx) {
      this.audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)({
        sampleRate,
        latencyHint: 'interactive',
      });
    }

    try {
      // The processor source is bundled as a Blob URL (see constructor), so it
      // ships with the package — no external/same-origin file is required.
      await this.audioCtx.audioWorklet.addModule(this.workletUrl!);
      this.logger.debug('AudioWorklet initialized successfully via blob URL');

      if (!this.audioCtx) return; // Race condition check

      this.workletNode = new AudioWorkletNode(this.audioCtx, 'pcm-player-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2], // Stereo out
        processorOptions: {
          bufferSize: 512 * 1024, // 512K samples (~12 seconds of stereo audio)
        },
      });

      // Handle PTS and buffer updates from audio worklet thread
      this.workletNode.port.onmessage = (event) => {
        const msg = event.data as { type: string; playPts: number; available: number };
        if (msg && msg.type === 'PLAY_STATUS') {
          this.lastReportedPlayPts = msg.playPts;
          this.audioBufferAvailable = msg.available;
          if (msg.available === 0) {
            // Underrun: audioCtx.currentTime keeps advancing while no samples are
            // consumed, so the anchored master clock would overshoot and then snap
            // back when audio resumes. Drop the anchor now; the first report after
            // refill re-anchors at the true play position (no jump).
            this.masterClock.reset();
          } else {
            this.updateClockAnchor(msg.playPts);
          }
          // The ring buffer just drained a little — top the lead back up if any
          // fallback batches are queued (see the lead gate in pumpFallbackDecodes).
          if (this.fallbackPending.length > 0) this.pumpFallbackDecodes();
        }
      };

      this.gainNode = this.audioCtx.createGain();
      // Apply current mute state immediately — gain=0 when muted so audio
      // always flows through the pipeline but produces silence when muted.
      const initialGain = this.isMuted ? 0 : this.volumeLevel;
      this.gainNode.gain.setValueAtTime(initialGain, this.audioCtx.currentTime);

      this.workletNode.connect(this.gainNode);
      this.gainNode.connect(this.audioCtx.destination);

      this.isInitialized = true;
      this.logger.debug('AudioWorklet initialized successfully');
    } catch (err) {
      this.logger.error('Failed to initialize AudioWorklet:', err);
      throw err;
    }
  }

  public syncTimeline(pts: number) {
    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: 'SYNC', pts });
    }
  }

  public decodeAndFeed(adtsBuffer: ArrayBuffer, pts: number) {
    if (!this.isInitialized) {
      // Not yet initialized — trigger lazy init (will start receiving audio after init)
      this.initialize(this.lastSeenSampleRate).then(() => {
        this.resume().catch(() => {});
      }).catch(err => {
        this.logger.error('Lazy initialization in decodeAndFeed failed:', err);
      });
      return;
    }

    if (!this.audioCtx) return;

    // Web Audio decodeAudioData expects a clean, copied ArrayBuffer.
    const bufferCopy = adtsBuffer.slice(0);

    // Queue the batch with a monotonic sequence number, then pump the pipeline.
    // The sequence number lets us feed results in arrival order even though the
    // concurrent decodes may resolve out of order (see pumpFallbackDecodes).
    this.fallbackPending.push({ buffer: bufferCopy, pts, seq: this.fallbackSeq++ });
    this.pumpFallbackDecodes();
  }

  /**
   * Start as many queued fallback decodes as the concurrency budget AND the
   * buffered-lead budget allow. Each result is parked in `fallbackReady` keyed
   * by its sequence number; `flushFallbackReady` drains them into the worklet
   * strictly in order.
   */
  private pumpFallbackDecodes() {
    const ctx = this.audioCtx;
    if (!ctx) return;

    // Bound the lead: once the worklet already holds ~FALLBACK_LEAD_TARGET
    // seconds of audio, stop launching new decodes and leave batches queued as
    // (cheap) raw ADTS in `fallbackPending`. The PLAY_STATUS handler re-pumps as
    // the ring buffer drains, so we keep a healthy cushion without overrunning.
    const leadTargetSamples = ctx.sampleRate * PCMAudioWorklet.FALLBACK_LEAD_TARGET_SECONDS;

    while (
      this.fallbackInFlight < PCMAudioWorklet.MAX_CONCURRENT_FALLBACK_DECODES &&
      this.fallbackPending.length > 0 &&
      this.audioBufferAvailable < leadTargetSamples
    ) {
      const item = this.fallbackPending.shift()!;
      const epoch = this.fallbackEpoch; // captured so a flush mid-decode can abandon this result
      this.fallbackInFlight++;

      ctx.decodeAudioData(item.buffer)
        .then((audioBuffer) => {
          if (epoch !== this.fallbackEpoch) return; // flushed while decoding — drop it
          const left = audioBuffer.getChannelData(0);
          const right = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : undefined;
          this.fallbackReady.set(item.seq, { left, right, sampleRate: audioBuffer.sampleRate, pts: item.pts });
        })
        .catch((err) => {
          if (epoch !== this.fallbackEpoch) return;
          this.logger.warn('decodeAudioData fallback failed:', err);
          this.fallbackReady.set(item.seq, null); // mark the slot done so ordering can advance past it
        })
        .finally(() => {
          if (epoch !== this.fallbackEpoch) return; // counters already reset by flush
          this.fallbackInFlight--;
          this.flushFallbackReady();
          this.pumpFallbackDecodes();
        });
    }
  }

  /** Feed contiguous ready results into the worklet in strict arrival order. */
  private flushFallbackReady() {
    while (this.fallbackReady.has(this.fallbackNextFeed)) {
      const result = this.fallbackReady.get(this.fallbackNextFeed)!;
      this.fallbackReady.delete(this.fallbackNextFeed);
      this.fallbackNextFeed++;
      if (result) {
        // Feed decoded Float32 PCM channels directly into our worklet!
        this.feedPCM(result.left, result.right, result.sampleRate, result.pts);
      }
    }
  }

  /**
   * Update the master-clock anchor from a fresh worklet play-PTS report.
   * Re-anchors hard on a discontinuity (seek/underrun/PTS jump), otherwise
   * absorbs a small fraction of the drift so the clock converges smoothly.
   */
  private updateClockAnchor(reportedPts: number) {
    if (!this.audioCtx) return;
    this.masterClock.update(reportedPts, this.audioCtx.currentTime);
  }

  public getPlayPTS(): number | null {
    if (!this.audioCtx || this.state === 'suspended' || this.audioBufferAvailable === 0) {
      return null;
    }
    if (!this.masterClock.isAnchored || this.lastReportedPlayPts < 0) {
      return null;
    }

    // Subtract the output latency so the video matches what the listener
    // actually hears (not what was just handed to the audio device).
    const latency = this.audioCtx.baseLatency || 0;
    return this.masterClock.read(this.audioCtx.currentTime, latency);
  }

  public get currentTime(): number {
    return this.audioCtx ? this.audioCtx.currentTime : 0;
  }

  public get state(): AudioContextState {
    return this.audioCtx ? this.audioCtx.state : 'suspended';
  }

  public async resume(): Promise<void> {
    // 1. Synchronously create AudioContext if it doesn't exist yet, to capture the user gesture
    if (!this.audioCtx) {
      const rate = this.lastSeenSampleRate > 0 ? this.lastSeenSampleRate : 48000;
      this.audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)({
        sampleRate: rate,
        latencyHint: 'interactive',
      });
    }

    // 2. Synchronously call resume() to capture the user gesture
    let resumePromise: Promise<void> | null = null;
    if (this.audioCtx.state === 'suspended') {
      resumePromise = this.audioCtx.resume();
      this.logger.debug('Synchronously invoked audioCtx.resume() to capture gesture stack');
    }

    // 3. Perform the asynchronous AudioWorklet initialization (if not done yet)
    if (!this.isInitialized) {
      this.logger.debug(`Lazy AudioContext activation triggered for sampleRate=${this.lastSeenSampleRate}Hz`);
      await this.initialize(this.lastSeenSampleRate);
    }

    // 4. Handle the resumption promise asynchronously without blocking player startup
    if (resumePromise) {
      resumePromise
        .then(() => {
          this.logger.debug(`AudioContext resumed successfully. State: ${this.audioCtx?.state}`);
        })
        .catch((err) => {
          this.logger.warn('AudioContext resume failed or was blocked:', err);
        });
    }
  }

  public async suspend(): Promise<void> {
    if (this.audioCtx && this.audioCtx.state === 'running') {
      await this.audioCtx.suspend();
    }
  }

  private resample(data: Float32Array, fromRate: number, toRate: number): Float32Array {
    if (fromRate === toRate || !fromRate || !toRate) return data;
    
    const ratio = fromRate / toRate;
    const newLength = Math.round(data.length / ratio);
    const result = new Float32Array(newLength);
    
    for (let i = 0; i < newLength; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const nextIdx = Math.min(data.length - 1, idx + 1);
      const weight = pos - idx;
      
      // Linear interpolation
      result[i] = data[idx] * (1 - weight) + data[nextIdx] * weight;
    }
    
    return result;
  }

  public feedPCM(left: Float32Array, right?: Float32Array, sourceSampleRate?: number, pts?: number) {
    if (sourceSampleRate) {
      this.lastSeenSampleRate = sourceSampleRate;
    }

    if (!this.isInitialized) {
      // Not yet initialized — cannot process audio. Data is silently dropped.
      // Once play() creates the AudioContext, future frames will flow through.
      return;
    }

    if (!this.workletNode || !this.audioCtx) return;

    // Dynamically resample if source sample rate differs from the running AudioContext rate
    const targetSampleRate = this.audioCtx.sampleRate;
    if (sourceSampleRate && sourceSampleRate !== targetSampleRate) {
      left = this.resample(left, sourceSampleRate, targetSampleRate);
      if (right) {
        right = this.resample(right, sourceSampleRate, targetSampleRate);
      }
    }

    // Use zero copy transfer for the TypedArray buffers
    const transferables = [left.buffer];
    if (right) {
      transferables.push(right.buffer);
    }

    this.workletNode.port.postMessage(
      {
        type: 'WRITE',
        left,
        right,
        pts,
      },
      transferables
    );
  }

  public setVolume(volume: number) {
    this.volumeLevel = Math.max(0, Math.min(1, volume));
    if (this.gainNode && this.audioCtx && !this.isMuted) {
      this.gainNode.gain.setValueAtTime(this.volumeLevel, this.audioCtx.currentTime);
    }
  }

  public mute(mute: boolean) {
    this.isMuted = mute;
    if (this.gainNode && this.audioCtx) {
      const activeVolume = mute ? 0 : this.volumeLevel;
      this.gainNode.gain.setValueAtTime(activeVolume, this.audioCtx.currentTime);
    }
  }

  public flush() {
    this.lastReportedPlayPts = -1;
    this.audioBufferAvailable = 0;
    this.masterClock.reset();
    // Abandon the fallback pipeline: bump the epoch so any in-flight
    // decodeAudioData results resolve into a no-op, and reset the ordering state.
    this.fallbackEpoch++;
    this.fallbackSeq = 0;
    this.fallbackNextFeed = 0;
    this.fallbackInFlight = 0;
    this.fallbackPending = [];
    this.fallbackReady.clear();
    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: 'FLUSH' });
    }
  }

  public async destroy() {
    this.flush();
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.gainNode) {
      this.gainNode.disconnect();
      this.gainNode = null;
    }
    if (this.audioCtx) {
      try {
        await this.audioCtx.close();
      } catch (err) {
        this.logger.error('Failed to close AudioContext in destroy:', err);
      }
      this.audioCtx = null;
    }
    if (this.workletUrl) {
      URL.revokeObjectURL(this.workletUrl);
      this.workletUrl = null;
    }
    this.isInitialized = false;
  }
}
