import { DecodedFrame } from '../sync/PlaybackController.js';
import { Logger } from '../utils/Logger.js';
import { AAC_SAMPLE_RATES, parseAdtsHeader } from '../demux/parsers.js';

export interface IBaseDecoder {
  decode(packet: Uint8Array, timestampUs: number, isKeyframe: boolean, parsedCodec?: string, description?: Uint8Array): void;
  flush(): void;
  destroy(): void;
  isSoftwareFallback?(): boolean;
}

export class DecoderRegistry {
  private decoders: Map<string, IBaseDecoder> = new Map();

  constructor(private onError: (error: Error) => void, private logger: Logger) {}

  public register(name: string, decoder: IBaseDecoder) {
    this.decoders.set(name, decoder);
  }

  public get(name: string): IBaseDecoder | undefined {
    return this.decoders.get(name);
  }

  public flushAll() {
    for (const decoder of this.decoders.values()) {
      decoder.flush();
    }
  }

  public destroyAll() {
    for (const decoder of this.decoders.values()) {
      decoder.destroy();
    }
    this.decoders.clear();
  }
}

/**
 * Split an interleaved stereo/multi-channel Float32 buffer into separate left
 * and right planes. Safari decodes AAC to interleaved 'f32' (all channels in one
 * plane); this recovers per-channel planes for the PCM worklet. Pure + tested.
 */
export function deinterleaveChannels(
  interleaved: Float32Array,
  numFrames: number,
  numChannels: number
): { left: Float32Array; right?: Float32Array } {
  const left = new Float32Array(numFrames);
  const right = numChannels > 1 ? new Float32Array(numFrames) : undefined;
  for (let i = 0; i < numFrames; i++) {
    left[i] = interleaved[i * numChannels];
    if (right) right[i] = interleaved[i * numChannels + 1];
  }
  return { left, right };
}

function areUint8ArraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

let mockCanvas: HTMLCanvasElement | null = null;
let mockCanvasCtx: CanvasRenderingContext2D | null = null;

/**
 * Detects a synthetic mock packet by the "YUMM" magic (0x59 0x55 0x4D 0x4D).
 * This is not a valid Annex-B start code, so real H.264/HEVC packets — which
 * begin with 0x00000001 — can never be misdetected as mock.
 */
function isMockVideoPacket(packet: Uint8Array): boolean {
  return packet.length >= 4 &&
    packet[0] === 0x59 && packet[1] === 0x55 && packet[2] === 0x4D && packet[3] === 0x4D;
}

function getMockFrame(timestampUs: number, codec: string): Promise<ImageBitmap> {
  if (typeof document === 'undefined') {
    return Promise.reject(new Error('Browser context required'));
  }
  if (!mockCanvas) {
    mockCanvas = document.createElement('canvas');
    mockCanvas.width = 640;
    mockCanvas.height = 360;
    mockCanvasCtx = mockCanvas.getContext('2d');
  }

  const ctx = mockCanvasCtx!;
  const w = mockCanvas.width;
  const h = mockCanvas.height;

  // Draw cyber matrix grid
  ctx.fillStyle = '#050505';
  ctx.fillRect(0, 0, w, h);

  // Grid lines
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 1;
  const gridSize = 32;
  for (let x = 0; x < w; x += gridSize) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = 0; y < h; y += gridSize) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  // Draw some moving shapes or text based on timestampUs
  const time = timestampUs / 1000000;
  
  // Rotating sweep line
  const cx = w / 2;
  const cy = h / 2;
  const radius = 100;
  const angle = time * Math.PI; // 0.5 rot/sec
  
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
  ctx.strokeStyle = codec === 'HEVC' ? 'rgba(0, 255, 102, 0.6)' : 'rgba(0, 173, 255, 0.6)';
  ctx.stroke();

  // Draw HUD text
  ctx.font = 'bold 12px monospace';
  ctx.fillStyle = codec === 'HEVC' ? '#00FF66' : '#00ADFF';
  ctx.fillText(`YUMYUM CORE PLAYBACK LIVE FEED`, 20, 30);
  ctx.fillStyle = '#666';
  ctx.fillText(`CODEC: ${codec} (MOCK SIMULATION)`, 20, 50);
  ctx.fillText(`TIME: ${time.toFixed(2)}s`, 20, 70);
  ctx.fillText(`PTS: ${timestampUs} Us`, 20, 90);

  // Rotating target indicator
  ctx.beginPath();
  ctx.arc(cx + Math.cos(-angle) * 60, cy + Math.sin(-angle) * 60, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#FF3366';
  ctx.fill();

  return createImageBitmap(mockCanvas);
}

// ==================== BASE VIDEO DECODER ====================
export abstract class BaseVideoDecoder implements IBaseDecoder {
  protected decoder: VideoDecoder | null = null;
  protected isDestroyed = false;
  protected hasDecodedFirstKeyframe = false;
  protected currentCodec: string;
  protected currentDescription: Uint8Array | null = null;
  protected recoveryAttempts = 0;
  protected readonly MAX_RECOVERY_ATTEMPTS = 3;
  protected failedCodecs: Set<string> = new Set();
  
  protected decodeCount = 0;
  protected outputCount = 0;

  constructor(
    protected onFrame: (frame: DecodedFrame) => void,
    protected onError: (error: Error) => void,
    protected logger: Logger,
    defaultCodec: string
  ) {
    this.currentCodec = defaultCodec;
  }

  public abstract isSoftwareFallback(): boolean;
  public abstract decode(packet: Uint8Array, timestampUs: number, isKeyframe: boolean, parsedCodec?: string, description?: Uint8Array): void;

  protected setupNativeDecoder(outputLogTag: string) {
    if (typeof VideoDecoder === 'undefined') return;
    
    this.hasDecodedFirstKeyframe = false;
    this.decoder = new VideoDecoder({
      output: (videoFrame) => {
        if (this.isDestroyed) {
          videoFrame.close();
          return;
        }
        this.outputCount++;
        if (this.outputCount % 60 === 1) {
          this.logger.debug(`${outputLogTag} Successfully decoded frame #${this.outputCount} | PTS: ${videoFrame.timestamp / 1000000}s | State: ${this.decoder?.state}`);
        }
        
        this.onFrame({
          pts: videoFrame.timestamp / 1000000,
          duration: (videoFrame.duration || 33333) / 1000000,
          data: videoFrame,
        });
      },
      error: (e) => {
        this.logger.error(`${outputLogTag} Native VideoDecoder error:`, e);
        this.attemptRecovery();
      },
    });

    this.configureDecoder();
  }

  protected configureDecoder() {
    if (!this.decoder) return;
    try {
      const config: VideoDecoderConfig = {
        codec: this.currentCodec,
        hardwareAcceleration: 'prefer-hardware',
        optimizeForLatency: true,
      };
      if (this.currentDescription) {
        config.description = this.currentDescription;
      }
      this.decoder.configure(config);
      this.logger.debug(`${this.currentCodec} Native decoder configured successfully | desc: ${this.currentDescription ? 'yes' : 'no'}`);
    } catch (err) {
      this.logger.error(`Failed to configure decoder with codec ${this.currentCodec}:`, err);
      this.attemptRecovery();
    }
  }

  protected abstract attemptRecovery(): void;

  public flush() {
    this.hasDecodedFirstKeyframe = false;
    if (this.decoder && this.decoder.state === 'configured') {
      this.decoder.flush().catch(() => {});
    }
  }

  public destroy() {
    this.isDestroyed = true;
    this.hasDecodedFirstKeyframe = false;
    if (this.decoder) {
      if (this.decoder.state !== 'closed') {
        this.decoder.close();
      }
      this.decoder = null;
    }
  }
}

// ==================== H.264 NATIVE DECODER ====================
export class H264Decoder extends BaseVideoDecoder {
  private hasWebCodecsSupport = typeof VideoDecoder !== 'undefined';

  constructor(
    onFrame: (frame: DecodedFrame) => void,
    onError: (error: Error) => void,
    logger: Logger
  ) {
    super(onFrame, onError, logger, 'avc1.42e01e');
    if (this.hasWebCodecsSupport) {
      this.setupNativeDecoder('H264');
    } else {
      this.logger.warn('WebCodecs VideoDecoder is not supported in this browser context.');
      setTimeout(() => this.onError(new Error('WebCodecs VideoDecoder is not supported in this browser context.')), 0);
    }
  }

  public isSoftwareFallback(): boolean {
    return !this.hasWebCodecsSupport || this.recoveryAttempts > this.MAX_RECOVERY_ATTEMPTS;
  }

  protected attemptRecovery() {
    if (this.isDestroyed) return;
    this.recoveryAttempts++;

    this.failedCodecs.add(this.currentCodec);
    this.logger.warn(`Codec ${this.currentCodec} failed. Added to failedCodecs. Total recovery attempts: ${this.recoveryAttempts}`);

    if (this.recoveryAttempts > this.MAX_RECOVERY_ATTEMPTS) {
      this.logger.error('Max recovery attempts reached. Native decoder disabled.');
      this.onError(new Error('Stream error — reload required'));
      return;
    }

    const fallbacks = ['avc1.42e01e', 'avc1.64002a', 'avc1.4d4029', 'avc1.42c028'];
    let fallbackCodec = 'avc1.42e01e';
    for (const cand of fallbacks) {
      if (!this.failedCodecs.has(cand)) {
        fallbackCodec = cand;
        break;
      }
    }

    this.logger.warn(`Triggering Hot Recovery. Swapping ${this.currentCodec} -> ${fallbackCodec}`);
    this.currentCodec = fallbackCodec;
    this.hasDecodedFirstKeyframe = false;

    if (this.decoder) {
      try {
        this.decoder.close();
      } catch (e) {}
      this.decoder = null;
    }

    this.setupNativeDecoder('H264');
  }

  public decode(packet: Uint8Array, timestampUs: number, isKeyframe: boolean, parsedCodec?: string, description?: Uint8Array) {
    const isMockPacket = isMockVideoPacket(packet);
    if (isMockPacket) {
      getMockFrame(timestampUs, 'H.264').then((bitmap) => {
        if (this.isDestroyed) {
          bitmap.close();
          return;
        }
        this.onFrame({
          pts: timestampUs / 1000000,
          duration: 33333 / 1000000,
          data: bitmap,
        });
      }).catch((e) => {
        this.logger.error('Failed to generate mock H.264 frame:', e);
      });
      return;
    }

    this.decodeCount++;
    
    let normDesc = description;
    let normCodec = parsedCodec;
    if (normCodec && this.failedCodecs.has(normCodec)) {
      if (this.decodeCount % 60 === 1) {
        this.logger.warn(`Incoming parsed codec ${parsedCodec} is in failedCodecs list. Sticking to current recovery codec: ${this.currentCodec}`);
      }
      normCodec = undefined;
    }

    const codecChanged = normCodec && normCodec !== this.currentCodec;
    const descriptionChanged = normDesc && (!this.currentDescription || !areUint8ArraysEqual(normDesc, this.currentDescription));
    if (codecChanged || descriptionChanged) {
      if (parsedCodec && normCodec && parsedCodec !== normCodec) {
        this.logger.warn(`Clamping H.264 profile level from ${parsedCodec} to ${normCodec} (Level 4.2 fallback)`);
      }
      this.logger.debug(`H.264 SPS profile change detected: ${this.currentCodec} -> ${normCodec || this.currentCodec} | descChanged: ${descriptionChanged ? 'yes' : 'no'}`);
      if (normCodec) this.currentCodec = normCodec;
      if (normDesc) this.currentDescription = normDesc;
      this.hasDecodedFirstKeyframe = false;
      
      if (this.decoder && this.decoder.state !== 'closed') {
        try {
          this.configureDecoder();
          this.logger.debug(`Synchronously reconfigured successfully to profile: ${this.currentCodec}`);
        } catch (err) {
          this.logger.error(`Failed to synchronously reconfigure decoder to ${this.currentCodec}:`, err);
        }
      }
    }

    if (!this.hasDecodedFirstKeyframe && !isKeyframe) {
      if (this.decodeCount % 60 === 1) {
        this.logger.debug(`Discarding non-keyframe before first keyframe | PTS: ${timestampUs / 1000000}s`);
      }
      return;
    }

    if (isKeyframe) {
      this.hasDecodedFirstKeyframe = true;
    }

    if (this.decodeCount % 60 === 1) {
      this.logger.debug(`decode() called #${this.decodeCount} | Pkt Size: ${packet.length} | PTS: ${timestampUs / 1000000}s | Key: ${isKeyframe} | Decoder state: ${this.decoder?.state}`);
    }

    if (!this.decoder || this.decoder.state === 'closed') {
      if (this.decodeCount % 60 === 1) {
        this.logger.warn(`decode ignored: decoder is null or closed`);
      }
      return;
    }

    try {
      const chunk = new EncodedVideoChunk({
        type: isKeyframe ? 'key' : 'delta',
        timestamp: timestampUs,
        data: packet,
      });
      this.decoder.decode(chunk);
    } catch (err) {
      this.logger.warn('Native decode error, attempting recovery:', err);
      this.attemptRecovery();
    }
  }
}

// ==================== HEVC DECODER (WITH WASM FALLBACK) ====================
export class HEVCDecoder extends BaseVideoDecoder {
  private isWasmFallback = false;
  private isReady = false;
  private packetQueue: Array<{ packet: Uint8Array; timestampUs: number; isKeyframe: boolean }> = [];
  public ready: Promise<void>;

  /** Resolves the software fallback decoder (e.g. plugin 'h265-sw'), if any. */
  private getFallback?: () => IBaseDecoder | undefined;
  private fallbackDecoder: IBaseDecoder | null = null;
  /** Force the software fallback even when native HEVC is available. */
  private forceSoftware: boolean;

  constructor(
    onFrame: (frame: DecodedFrame) => void,
    onError: (error: Error) => void,
    logger: Logger,
    getFallback?: () => IBaseDecoder | undefined,
    forceSoftware = false
  ) {
    super(onFrame, onError, logger, 'hvc1.1.6.L93.B0');
    this.getFallback = getFallback;
    this.forceSoftware = forceSoftware;
    this.ready = this.probeAndInitialize();
  }

  public isSoftwareFallback(): boolean {
    return this.isWasmFallback;
  }

  private async probeAndInitialize() {
    this.isReady = false;
    this.hasDecodedFirstKeyframe = false;
    const isSupported = !this.forceSoftware && typeof VideoDecoder !== 'undefined' && (
      await VideoDecoder.isConfigSupported({
        codec: this.currentCodec,
        hardwareAcceleration: 'prefer-hardware',
      })
    ).supported;

    if (this.isDestroyed) return;

    if (isSupported) {
      this.setupNativeDecoder('HEVC');
    } else {
      this.isWasmFallback = true;
      // Delegate to a software fallback decoder if a Pro plugin registered one.
      // Resolution is also retried lazily in decode() to be robust to plugin
      // registration ordering; the error overlay is shown on the first frame
      // only if no fallback is available.
      this.fallbackDecoder = this.getFallback?.() ?? null;
      if (this.fallbackDecoder) {
        this.logger.info('Native HEVC unsupported — delegating to registered software decoder (h265-sw).');
      } else {
        this.logger.warn('Native HEVC not supported; will use a software fallback if registered, otherwise error on first frame.');
      }
    }

    this.isReady = true;
    this.processQueuedPackets();
  }

  private processQueuedPackets() {
    const queue = this.packetQueue;
    this.packetQueue = [];
    for (const item of queue) {
      this.decode(item.packet, item.timestampUs, item.isKeyframe);
    }
  }

  protected attemptRecovery() {
    if (this.isDestroyed) return;
    this.recoveryAttempts++;

    this.failedCodecs.add(this.currentCodec);
    this.logger.warn(`HEVC Codec ${this.currentCodec} failed. Added to failedCodecs. Total recovery attempts: ${this.recoveryAttempts}`);

    if (this.recoveryAttempts > this.MAX_RECOVERY_ATTEMPTS) {
      this.logger.error('Max recovery attempts reached. Native decoder disabled.');
      this.onError(new Error('Stream error — reload required'));
      return;
    }

    const profiles = [
      'hvc1.1.6.L93.B0', // Main L3.1
      'hvc1.1.4.L120.B0', // Main L4.0
      'hev1.1.4.L120.B0', // HEV1 fallback
      'hvc1.1.4.L126.B0'  // Level 4.2
    ];

    let nextCodec = profiles[0];
    for (const cand of profiles) {
      if (!this.failedCodecs.has(cand)) {
        nextCodec = cand;
        break;
      }
    }

    this.logger.warn('Triggering HEVC Hot Recovery. Swapping ' + this.currentCodec + ' -> ' + nextCodec);
    this.currentCodec = nextCodec;
    this.hasDecodedFirstKeyframe = false;

    if (this.decoder) {
      try {
        this.decoder.close();
      } catch (e) {}
      this.decoder = null;
    }

    this.probeAndInitialize();
  }

  public decode(packet: Uint8Array, timestampUs: number, isKeyframe: boolean, parsedCodec?: string, description?: Uint8Array) {
    if (this.isDestroyed) return;

    const isMockPacket = isMockVideoPacket(packet);
    if (isMockPacket) {
      getMockFrame(timestampUs, 'HEVC').then((bitmap) => {
        if (this.isDestroyed) {
          bitmap.close();
          return;
        }
        this.onFrame({
          pts: timestampUs / 1000000,
          duration: 33333 / 1000000,
          data: bitmap,
        });
      }).catch((e) => {
        this.logger.error('Failed to generate mock HEVC frame:', e);
      });
      return;
    }

    if (!this.isReady) {
      if (this.packetQueue.length < 150) {
        this.packetQueue.push({ packet, timestampUs, isKeyframe });
      }
      return;
    }

    if (this.isWasmFallback) {
      if (!this.fallbackDecoder) this.fallbackDecoder = this.getFallback?.() ?? null;
      if (this.fallbackDecoder) {
        this.fallbackDecoder.decode(packet, timestampUs, isKeyframe, parsedCodec, description);
      } else {
        this.onError(new Error('HEVC playback is not natively supported on this device.'));
      }
      return;
    }

    const descriptionChanged = description && (!this.currentDescription || !areUint8ArraysEqual(description, this.currentDescription));
    if (descriptionChanged) {
      this.currentDescription = description;
      this.hasDecodedFirstKeyframe = false;

      if (this.decoder && this.decoder.state !== 'closed') {
        try {
          this.configureDecoder();
          this.logger.debug('Synchronously reconfigured HEVC successfully with description: ' + this.currentDescription.length + ' bytes');
        } catch (err) {
          this.logger.warn('Failed to synchronously reconfigure HEVC decoder:', err);
        }
      }
    }

    if (!this.hasDecodedFirstKeyframe && !isKeyframe) {
      return;
    }

    if (isKeyframe) {
      this.hasDecodedFirstKeyframe = true;
    }

    if (!this.decoder || this.decoder.state === 'closed') {
      this.onError(new Error('Decoder is not initialized or closed'));
      return;
    }

    try {
      const chunk = new EncodedVideoChunk({
        type: isKeyframe ? 'key' : 'delta',
        timestamp: timestampUs,
        data: packet,
      });
      this.decoder.decode(chunk);
    } catch (err) {
      this.logger.warn('Native decode error, attempting recovery:', err);
      this.attemptRecovery();
    }
  }

  public flush() {
    super.flush();
    this.packetQueue = [];
    if (this.fallbackDecoder) this.fallbackDecoder.flush();
  }

  public destroy() {
    super.destroy();
    this.packetQueue = [];
    // The fallback decoder is owned by the registry (registered under its own
    // key) and destroyed via destroyAll(); just drop our reference here.
    this.fallbackDecoder = null;
  }
}

// ==================== MJPEG DECODER (WORKER COMPATIBLE) ========================
export class MJPEGDecoder implements IBaseDecoder {
  private isDestroyed = false;

  constructor(
    private onFrame: (frame: DecodedFrame) => void,
    private onError: (error: Error) => void,
    private logger: Logger
  ) {}

  public decode(packet: Uint8Array, timestampUs: number) {
    if (this.isDestroyed) return;

    // Validate JPEG magic bytes (FF D8 FF) to protect against mock or corrupted packets
    const isValidJPEG = packet.length >= 3 && packet[0] === 0xFF && packet[1] === 0xD8 && packet[2] === 0xFF;

    if (!isValidJPEG) {
      this.onError(new Error('Stream error — reload required'));
      return;
    }

    // Decoding real MJPEG using high-performance browser ImageBitmap compilation
    const blob = new Blob([packet as BufferSource], { type: 'image/jpeg' });
    
    createImageBitmap(blob)
      .then((bitmap) => {
        if (this.isDestroyed) {
          bitmap.close();
          return;
        }
        this.onFrame({
          pts: timestampUs / 1000000,
          duration: 33333 / 1000000,
          data: bitmap, // ImageBitmap is a transferable object
        });
      })
      .catch((err) => {
        if (this.isDestroyed) return;
        this.logger.error('MJPEG ImageBitmap creation error:', err);
        this.onError(new Error('Stream error — reload required'));
      });
  }

  public flush() {}

  public destroy() {
    this.isDestroyed = true;
  }
}

// ==================== AAC AUDIO DECODER ====================
/**
 * AAC Decoder with dual-strategy approach for cross-browser compatibility:
 * 
 * Strategy 1 (ADTS mode): Configure WITHOUT `description`, feed complete ADTS packets.
 *   - Works on browsers that auto-detect config from ADTS headers.
 * 
 * Strategy 2 (Raw frame mode): Configure WITH `description` (AudioSpecificConfig),
 *   feed raw AAC frames with ADTS header stripped.
 *   - Required by browsers that need explicit config.
 * 
 * If both fail, the decoder silently falls back to no audio.
 */
export class AACDecoder implements IBaseDecoder {
  private decoder: AudioDecoder | null = null;
  private isDestroyed = false;
  private isConfigured = false;
  private isConfiguring = false;
  private isFailed = false; // Permanently failed — don't retry
  private useAdtsMode = false; // DEFAULT to false (raw frame mode with description) as it is most highly compatible and robust
  private hasTriedAdts = false;
  private hasTriedRaw = false;
  private currentSampleRate = 0;
  private currentChannels = 0;
  private currentProfile = -1;
  private pendingPackets: Array<{ packet: Uint8Array; timestampUs: number }> = [];
  private decodeErrorCount = 0;
  private decodeCount = 0;

  // Web Audio fallback accumulator fields
  private fallbackBuffer: Uint8Array[] = [];
  private fallbackPts: number[] = [];

  constructor(
    private onPCM: (left: Float32Array, right?: Float32Array, sampleRate?: number, pts?: number) => void,
    private onADTSChunk: ((adtsBuffer: ArrayBuffer, pts: number) => void) | undefined,
    private logger: Logger
  ) {}

  private async configureAudioDecoder(sampleRate: number, channels: number, profile: number) {
    if (typeof AudioDecoder === 'undefined') {
      this.logger.warn('AudioDecoder API not available.');
      this.isFailed = true;
      this.isConfiguring = false;
      return;
    }

    this.isConfiguring = true;

    const audioObjectType = profile + 1;
    const codecString = `mp4a.40.${audioObjectType}`;

    // --- Strategy 1: Raw frame mode (with AudioSpecificConfig description) ---
    if (!this.useAdtsMode) {
      this.hasTriedRaw = true;
      const rateIdx = AAC_SAMPLE_RATES.indexOf(sampleRate);
      const sampleRateIndex = rateIdx !== -1 ? rateIdx : 4;

      const ascVal = (audioObjectType << 11) | (sampleRateIndex << 7) | (channels << 3);
      const description = new Uint8Array(2);
      description[0] = (ascVal >> 8) & 0xFF;
      description[1] = ascVal & 0xFF;

      const rawConfig: AudioDecoderConfig = {
        codec: codecString,
        sampleRate: sampleRate,
        numberOfChannels: channels,
        description: description, // Pass the Uint8Array directly
      };

      try {
        this.logger.warn(`Testing support for AAC Raw mode: codec=${codecString}, sampleRate=${sampleRate}Hz, channels=${channels}ch`);
        const check = await AudioDecoder.isConfigSupported(rawConfig);
        if (this.isDestroyed) return;

        if (check.supported) {
          this.logger.warn(`AAC Raw mode is supported. Creating decoder...`);
          this.createDecoder(check.config || rawConfig, sampleRate, channels, profile);
          return;
        }
      } catch (e) {
        this.logger.warn('Raw frame mode isConfigSupported failed:', e);
      }

      // Raw mode not supported, try ADTS mode
      this.logger.warn('AAC Raw mode not supported, trying ADTS mode fallback...');
      this.useAdtsMode = true;
    }

    // --- Strategy 2: ADTS mode (no description) ---
    this.hasTriedAdts = true;
    const adtsConfig: AudioDecoderConfig = {
      codec: codecString,
      sampleRate: sampleRate,
      numberOfChannels: channels,
    };

    try {
      this.logger.warn(`Testing support for AAC ADTS mode: codec=${codecString}, sampleRate=${sampleRate}Hz, channels=${channels}ch`);
      const check = await AudioDecoder.isConfigSupported(adtsConfig);
      if (this.isDestroyed) return;

      if (check.supported) {
        this.logger.warn(`AAC ADTS mode is supported. Creating decoder...`);
        this.createDecoder(check.config || adtsConfig, sampleRate, channels, profile);
        return;
      }
    } catch (e) {
      this.logger.warn('ADTS mode isConfigSupported failed:', e);
    }

    // Both strategies failed
    this.logger.warn(`No supported AAC config for codec=${codecString}, ${sampleRate}Hz / ${channels}ch. Audio disabled.`);
    this.isFailed = true;
    this.isConfiguring = false;
  }

  private handleFallback() {
    if (this.decoder) {
      try { this.decoder.close(); } catch (err) {}
      this.decoder = null;
    }
    this.isConfigured = false;

    // Use current sample parameters or fallback to standard ones if not yet set
    const sampleRate = this.currentSampleRate > 0 ? this.currentSampleRate : 44100;
    const channels = this.currentChannels > 0 ? this.currentChannels : 2;
    const profile = this.currentProfile !== -1 ? this.currentProfile : 1;

    if (!this.useAdtsMode && !this.hasTriedAdts) {
      this.logger.warn('AAC Raw mode failed. Switching to ADTS mode fallback...');
      this.useAdtsMode = true;
      this.decodeErrorCount = 0;
      this.configureAudioDecoder(sampleRate, channels, profile);
    } else if (this.useAdtsMode && !this.hasTriedRaw) {
      this.logger.warn('AAC ADTS mode failed. Switching to Raw mode fallback...');
      this.useAdtsMode = false;
      this.decodeErrorCount = 0;
      this.configureAudioDecoder(sampleRate, channels, profile);
    } else {
      this.logger.warn(
        'Both AAC Raw and ADTS decoding strategies failed. Audio has been disabled. ' +
        'Note: If you are using an open-source Chromium build, proprietary codecs like AAC (mp4a.40.2) ' +
        'are often disabled due to licensing. Please use official Google Chrome, Microsoft Edge, or Safari ' +
        'for full audio playback support.'
      );
      this.isFailed = true;
      this.isConfiguring = false;
    }
  }

  private createDecoder(config: AudioDecoderConfig, sampleRate: number, channels: number, profile: number) {
    if (this.decoder) {
      try { this.decoder.close(); } catch (e) {}
    }

    this.decoder = new AudioDecoder({
      output: (audioData) => {
        try {
          const numFrames = audioData.numberOfFrames;
          const numChannels = audioData.numberOfChannels;
          // Browsers disagree on the decoded layout: Chrome yields 'f32-planar'
          // (one plane per channel), Safari yields interleaved 'f32' (all
          // channels in plane 0). Copying an interleaved plane into a
          // per-channel-sized buffer throws "Buffer is too small", which is why
          // Safari had no audio. Handle each layout explicitly.
          const format = audioData.format || 'f32-planar';

          let left: Float32Array;
          let right: Float32Array | undefined;

          if (format === 'f32') {
            // Interleaved float (Safari): one plane holds all channels.
            const interleaved = new Float32Array(numFrames * numChannels);
            audioData.copyTo(interleaved, { planeIndex: 0 });
            ({ left, right } = deinterleaveChannels(interleaved, numFrames, numChannels));
          } else {
            // Planar f32 (Chrome) or other formats: copy per plane, asking the
            // browser to convert to planar f32 when the source isn't already.
            const copyFormat: AudioSampleFormat | undefined = format === 'f32-planar' ? undefined : 'f32-planar';
            left = new Float32Array(numFrames);
            right = numChannels > 1 ? new Float32Array(numFrames) : undefined;
            audioData.copyTo(left, { planeIndex: 0, format: copyFormat });
            if (right) audioData.copyTo(right, { planeIndex: 1, format: copyFormat });
          }

          this.onPCM(left, right, audioData.sampleRate, audioData.timestamp / 1000000);
          // Reset error count on successful decode
          this.decodeErrorCount = 0;
        } catch (err) {
          this.logger.warn('Failed to copy decoded AudioData:', err);
          this.handleFallback();
        } finally {
          audioData.close();
        }
      },
      error: (e) => {
        this.decodeErrorCount++;
        this.logger.warn(`Decode error #${this.decodeErrorCount} (mode: ${this.useAdtsMode ? 'ADTS' : 'raw'}):`, e);
        this.handleFallback();
      },
    });

    try {
      this.decoder.configure(config);
      this.isConfigured = true;
      this.isConfiguring = false;
      this.currentSampleRate = sampleRate;
      this.currentChannels = channels;
      this.currentProfile = profile;
      const modeLabel = this.useAdtsMode ? 'ADTS (full packet)' : 'Raw Frame (description)';
      this.logger.warn(`AudioDecoder successfully configured: ${sampleRate}Hz, ${channels}ch, profile=${profile}, mode: ${modeLabel}`);

      // Drain packets that arrived during async configuration
      if (this.pendingPackets.length > 0) {
        this.logger.warn(`Draining ${this.pendingPackets.length} pending packets`);
        const pending = this.pendingPackets.splice(0);
        for (const p of pending) {
          this.feedPacket(p.packet, p.timestampUs);
        }
      }
    } catch (err) {
      this.logger.warn(`decoder.configure() threw synchronously (mode: ${this.useAdtsMode ? 'ADTS' : 'raw'}):`, err);
      this.handleFallback();
    }
  }

  /**
   * Feed a packet to the decoder using the active strategy.
   * ADTS mode: feeds the complete ADTS packet.
   * Raw frame mode: strips the ADTS header and feeds only the AAC frame body.
   */
  private feedPacket(packet: Uint8Array, timestampUs: number) {
    if (!this.decoder || !this.isConfigured || this.decoder.state !== 'configured') return;

    let data: Uint8Array;

    if (this.useAdtsMode) {
      data = packet;
    } else {
      // Strip ADTS header: 7 bytes (no CRC) or 9 bytes (with CRC)
      let headerSize = 7;
      if (packet.length > 1) {
        const hasCRC = (packet[1] & 0x01) === 0;
        if (hasCRC) headerSize = 9;
      }
      if (packet.length <= headerSize) return;
      data = packet.subarray(headerSize);
    }

    try {
      const chunk = new EncodedAudioChunk({
        type: 'key',
        timestamp: timestampUs,
        data: data,
      });
      this.decoder.decode(chunk);
    } catch (err) {
      // Synchronous decode errors (rare)
      if (this.decodeErrorCount < 3) {
        this.logger.error('decode() threw:', err);
      }
    }
  }

  private accumulateFallback(packet: Uint8Array, timestampUs: number) {
    if (!this.onADTSChunk) return;

    this.fallbackBuffer.push(packet);
    this.fallbackPts.push(timestampUs / 1000000);

    // Accumulate ~460ms (20 packets) of ADTS audio data to minimize decodeAudioData invocation overhead
    if (this.fallbackBuffer.length >= 20) {
      let totalLength = 0;
      for (const p of this.fallbackBuffer) {
        totalLength += p.length;
      }
      
      const merged = new Uint8Array(totalLength);
      let offset = 0;
      for (const p of this.fallbackBuffer) {
        merged.set(p, offset);
        offset += p.length;
      }

      const chunkStartPts = this.fallbackPts[0];
      
      // Clear accumulator
      this.fallbackBuffer = [];
      this.fallbackPts = [];

      try {
        this.onADTSChunk(merged.buffer, chunkStartPts);
      } catch (err) {
        this.logger.error('Error invoking onADTSChunk fallback:', err);
      }
    }
  }

  public decode(packet: Uint8Array, timestampUs: number, isKeyframe: boolean, parsedCodec?: string) {
    if (this.isDestroyed) return;
    if (this.isFailed) {
      this.accumulateFallback(packet, timestampUs);
      return;
    }

    // Detect ADTS sync word and parse the header
    const header = parseAdtsHeader(packet);
    if (!header) return;

    const { profile, sampleRate, channels } = header;

    if (this.decodeCount++ % 300 === 1) {
      this.logger.debug(`ADTS Header parsed: profile=${profile}, sampleRate=${sampleRate}Hz, channels=${channels}ch`);
    }

    // Reset isFailed if audio parameters changed, allowing recovery on stream switch
    const paramsChanged = sampleRate !== this.currentSampleRate || channels !== this.currentChannels || profile !== this.currentProfile;
    if (paramsChanged && this.isFailed) {
      this.logger.debug(`Audio configuration changed from rate=${this.currentSampleRate}Hz/ch=${this.currentChannels} to rate=${sampleRate}Hz/ch=${channels}. Resetting failure state.`);
      this.isFailed = false;
      this.isConfigured = false;
    }

    if (!this.isConfigured && !this.isConfiguring) {
      this.hasTriedAdts = false;
      this.hasTriedRaw = false;
      // Start with raw mode as default
      this.useAdtsMode = false;
      this.configureAudioDecoder(sampleRate, channels, profile);
      this.pendingPackets.push({ packet, timestampUs });
      return;
    }

    if (this.isConfiguring) {
      if (this.pendingPackets.length < 100) {
        this.pendingPackets.push({ packet, timestampUs });
      }
      return;
    }

    // Reconfigure if stream parameters changed
    if (sampleRate !== this.currentSampleRate || channels !== this.currentChannels || profile !== this.currentProfile) {
      this.isConfigured = false;
      this.hasTriedAdts = false;
      this.hasTriedRaw = false;
      this.useAdtsMode = false;
      this.configureAudioDecoder(sampleRate, channels, profile);
      this.pendingPackets.push({ packet, timestampUs });
      return;
    }

    this.feedPacket(packet, timestampUs);
  }

  public flush() {
    this.pendingPackets = [];
    if (this.decoder && this.decoder.state === 'configured') {
      this.decoder.flush().catch(() => {});
    }
  }

  public destroy() {
    this.isDestroyed = true;
    this.pendingPackets = [];
    if (this.decoder) {
      if (this.decoder.state !== 'closed') {
        this.decoder.close();
      }
      this.decoder = null;
    }
    this.isConfigured = false;
    this.isConfiguring = false;
  }
}
