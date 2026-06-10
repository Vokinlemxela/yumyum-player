/**
 * @module @yumyum-player/core
 *
 * Yum-yum Player — Multi-codec browser video player engine.
 * Supports H.264, HEVC/H.265, MJPEG via WebCodecs API + WebGL2 rendering.
 *
 * @example
 * ```typescript
 * import { YumYumPlayer } from '@yumyum-player/core';
 *
 * const canvas = document.getElementById('player') as HTMLCanvasElement;
 * const player = new YumYumPlayer({ canvas });
 *
 * await player.load('https://example.com/stream.m3u8');
 * player.play();
 * ```
 */

import { WebGLVideoRenderer } from './render/WebGLVideoRenderer.js';
import { PCMAudioWorklet } from './render/PCMAudioWorklet.js';
import { PlaybackController, DecodedFrame } from './sync/PlaybackController.js';
import { StreamLoader } from './network/StreamLoader.js';
import { LoaderRegistry } from './network/LoaderRegistry.js';
import { IStreamLoader, LoaderDeps } from './network/IStreamLoader.js';
import { PlayerPlugin, PluginContext } from './plugin/types.js';
import {
  DecoderRegistry,
  H264Decoder,
  HEVCDecoder,
  MJPEGDecoder,
  AACDecoder,
} from './decode/DecoderRegistry.js';
import { DEMUXER_WORKER_SOURCE } from './demux/DemuxerWorkerInline.js';
import { Logger, LogLevel } from './utils/Logger.js';

// ─── Public API Types ───────────────────────────────────────────────

export interface PlayerConfig {
  /** Target canvas element for video rendering */
  canvas: HTMLCanvasElement;
  /** Initial volume level (0.0 — 1.0). Default: 1.0 */
  volume?: number;
  /** Start muted. Default: false */
  muted?: boolean;
  /** Placeholder style when frame gap / signal loss is detected. Default: 'black' */
  placeholderStyle?: 'black' | 'no-signal' | 'none';
  /** Isolated instance logging level. Default: 'silent' */
  logLevel?: LogLevel;
  /** Optional plugins (e.g. Pro modules) that register extra decoders or loaders. */
  plugins?: PlayerPlugin[];
  /**
   * Force the software HEVC decoder (the registered `h265-sw` fallback) even
   * when the browser supports HEVC natively. Useful for testing the WASM path
   * and for guaranteeing identical decoding across devices. Default: false.
   */
  forceSoftwareHevc?: boolean;
}

export interface PlayerTelemetry {
  queueLength: number;
  droppedFrames: number;
  renderedFrames: number;
  playbackState: string;
  currentPTS: number;
  backpressureActive: boolean;
  activeCodec: string;
  duration: number;
  /**
   * Furthest buffered media position in seconds — drives the timeline buffer bar.
   * For VOD this is the raw look-ahead download front; falls back to currentPTS
   * for live / loaders that cannot report it.
   */
  bufferedEnd: number;
  decodingStrategy: string;
  /** Current playback speed multiplier (1 = normal). */
  playbackRate: number;
}

export type PlayerEvent = 'play' | 'pause' | 'error' | 'ended';
export type PlayerLifecycleState = 'IDLE' | 'LOADING' | 'LOADED' | 'PLAYING' | 'PAUSED' | 'DESTROYED';

// Re-export useful types for advanced consumers
export type { DecodedFrame } from './sync/PlaybackController.js';
export type { PlaybackState } from './sync/PlaybackController.js';
export type { YUVFrameData } from './render/WebGLVideoRenderer.js';
export type { IBaseDecoder } from './decode/DecoderRegistry.js';
export { Logger } from './utils/Logger.js';
export type { LogLevel } from './utils/Logger.js';
export type { Segment } from './network/StreamLoader.js';
// Extension API for plugins (Pro modules)
export type { PlayerPlugin, PluginContext, DecoderFactory, DecoderDeps } from './plugin/types.js';
export type { IStreamLoader, LoaderFactory, LoaderDeps, LoaderKind } from './network/IStreamLoader.js';

// ─── Main Player Class ──────────────────────────────────────────────

export class YumYumPlayer {
  private videoRenderer: WebGLVideoRenderer;
  private audioRenderer: PCMAudioWorklet;
  private playbackController: PlaybackController;
  private loaderRegistry: LoaderRegistry;
  private loaderDeps: LoaderDeps;
  private activeLoader: IStreamLoader | null = null;
  private decoders: DecoderRegistry;
  private logger: Logger;

  private worker: Worker | null = null;
  private workerBlobUrl: string | null = null;
  private activeCodec: 'h264' | 'h265' | 'mjpeg' = 'h264';
  private isBackpressurePaused = false;
  private isInitialized = false;
  /** User-requested mute state, kept separate from the automatic mute applied at non-1x speeds. */
  private userMuted = false;

  private lifecycleState: PlayerLifecycleState = 'IDLE';

  /** Get the current player lifecycle state */
  public get state(): PlayerLifecycleState {
    return this.lifecycleState;
  }

  private listeners: Map<PlayerEvent, Array<(...args: unknown[]) => void>> = new Map();

  /**
   * Subscribe to player events.
   *
   * @param event - Event name: 'play', 'pause', 'error', 'ended'
   * @param callback - Event handler
   */
  public on(event: PlayerEvent, callback: (...args: unknown[]) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(callback);
  }

  /**
   * Unsubscribe from player events.
   *
   * @param event - Event name to unsubscribe from
   * @param callback - The exact callback reference that was passed to `on()`
   */
  public off(event: PlayerEvent, callback: (...args: unknown[]) => void): void {
    const cbs = this.listeners.get(event);
    if (cbs) {
      const idx = cbs.indexOf(callback);
      if (idx !== -1) {
        cbs.splice(idx, 1);
      }
    }
  }

  /** Emit a player event */
  private emit(event: PlayerEvent, ...args: unknown[]): void {
    this.listeners.get(event)?.forEach(cb => cb(...args));
  }

  /**
   * Create a new Yum-yum Player instance.
   *
   * @param config - Player configuration with target canvas element
   *
   * @example
   * ```typescript
   * const player = new YumYumPlayer({
   *   canvas: document.querySelector('canvas')!,
   *   volume: 0.8,
   *   muted: false,
   *   placeholderStyle: 'black',
   * });
   * ```
   */
  constructor(private config: PlayerConfig) {
    this.logger = new Logger('YumYumPlayer', config.logLevel || 'silent');

    // 1. Initialize Video WebGL2 Renderer
    this.videoRenderer = new WebGLVideoRenderer(config.canvas, config.placeholderStyle || 'black', this.logger.createChild('WebGLVideoRenderer'));

    // 2. Initialize PCM AudioWorklet
    this.audioRenderer = new PCMAudioWorklet(this.logger.createChild('PCMAudioWorklet'));
    if (config.volume !== undefined) this.audioRenderer.setVolume(config.volume);
    if (config.muted !== undefined) {
      this.audioRenderer.mute(config.muted);
      this.userMuted = config.muted;
    }

    // 3. Initialize Playback Controller (A/V Sync and Backpressure)
    this.playbackController = new PlaybackController(
      () => {
        // Return active audio master clock
        if (this.audioRenderer.state === 'running') {
          const pts = this.audioRenderer.getPlayPTS();
          if (pts !== null && pts >= 0) {
            return pts;
          }
        }
        return null;
      },
      (frameData) => {
        // Render Frame Callback
        if (!frameData) {
          this.logger.debug('onRenderFrame(null) called! Triggering videoRenderer.drawGapPlaceholder()');
          this.videoRenderer.drawGapPlaceholder();
          return;
        }
        if ('yPlane' in frameData) {
          this.videoRenderer.renderYUV(frameData);
        } else {
          this.videoRenderer.renderVideoFrame(frameData);
        }
      },
      (pauseDecoding) => {
        // Backpressure trigger
        this.isBackpressurePaused = pauseDecoding;
        if (this.worker) {
          this.worker.postMessage({
            type: pauseDecoding ? 'PAUSE_DECODING' : 'RESUME_DECODING',
          });
        }
      },
      () => {
        this.emit('ended');
      },
      this.logger.createChild('PlaybackController')
    );

    // 4. Initialize Decoders Registry
    this.decoders = new DecoderRegistry(
      (err) => this.emit('error', err),
      this.logger.createChild('DecoderRegistry')
    );

    // Register active decoders
    this.decoders.register('h264', new H264Decoder(
      (f) => this.playbackController.enqueueFrame(f),
      (err) => this.emit('error', err),
      this.logger.createChild('H264Decoder')
    ));
    this.decoders.register('h265', new HEVCDecoder(
      (f) => this.playbackController.enqueueFrame(f),
      (err) => this.emit('error', err),
      this.logger.createChild('HEVCDecoder'),
      // When native HEVC is unsupported, delegate to a plugin-registered
      // software decoder (e.g. @yumyum-player/hevc-wasm registers 'h265-sw').
      () => this.decoders.get('h265-sw'),
      config.forceSoftwareHevc ?? false
    ));
    this.decoders.register('mjpeg', new MJPEGDecoder(
      (f) => this.playbackController.enqueueFrame(f),
      (err) => this.emit('error', err),
      this.logger.createChild('MJPEGDecoder')
    ));
    this.decoders.register('aac', new AACDecoder(
      (l, r, sr, pts) => this.audioRenderer.feedPCM(l, r, sr, pts),
      (adtsBuffer, pts) => this.audioRenderer.decodeAndFeed(adtsBuffer, pts),
      this.logger.createChild('AACDecoder')
    ));

    // 5. Shared dependencies handed to every stream loader
    this.loaderDeps = {
      onData: (buffer, streaming) => {
        // Direct raw media buffers to the background demuxer worker.
        // Discrete HLS segments use DEMUX; continuous live chunks use STREAM_DEMUX.
        if (this.worker) {
          this.worker.postMessage({ type: streaming ? 'STREAM_DEMUX' : 'DEMUX', data: buffer }, [buffer]);
        }
      },
      onMockPacket: (mockPacket, type, pts, isKey) => {
        // Handle local mock stream packets directly
        if (type === 'video') {
          const decoder = this.decoders.get(this.activeCodec);
          if (decoder) {
            decoder.decode(mockPacket, pts, isKey);
          }
        } else if (type === 'audio') {
          // Direct PCM play injection for mock audio
          const pcmFloat = new Float32Array(mockPacket.buffer);
          this.audioRenderer.feedPCM(pcmFloat);
        }
      },
      onError: (err) => this.emit('error', err),
      logger: this.logger,
    };

    // 6. Register the built-in loader. HLS (and mock/relative URLs) is the
    // default. Live WebSocket (ws://, wss://) is provided by the Pro plugin
    // @yumyum-player/pro-streaming via registerLoader().
    this.loaderRegistry = new LoaderRegistry();
    this.loaderRegistry.registerDefault((deps) => new StreamLoader({ ...deps, logger: deps.logger.createChild('StreamLoader') }));

    // 7. Install plugins (Pro modules) so they can register extra decoders/loaders.
    const pluginContext: PluginContext = {
      registerDecoder: (key, factory) => {
        this.decoders.register(key, factory({
          onFrame: (f) => this.playbackController.enqueueFrame(f),
          onError: (err) => this.emit('error', err),
          logger: this.logger.createChild(key),
        }));
      },
      registerLoader: (schemes, factory) => this.loaderRegistry.register(schemes, factory),
      logger: this.logger.createChild('plugin'),
    };
    for (const plugin of config.plugins ?? []) {
      try {
        plugin.install(pluginContext);
        this.logger.info(`Installed plugin: ${plugin.name}`);
      } catch (err) {
        this.logger.error(`Failed to install plugin "${plugin.name}":`, err);
      }
    }
  }

  /**
   * Load an HLS stream or mock URL.
   *
   * @param url - HLS playlist URL (.m3u8) or mock:// test URL
   *
   * @example
   * ```typescript
   * await player.load('/live/stream.m3u8');
   * ```
   */
  public async load(url: string): Promise<void> {
    if (this.lifecycleState === 'DESTROYED') {
      throw new Error('YumYumPlayer: Cannot load. Player is in DESTROYED state.');
    }

    this.logger.info(`Loading stream from: ${url} (Current state: ${this.lifecycleState})`);
    this.lifecycleState = 'LOADING';

    try {
      this.playbackController.flush();
      this.audioRenderer.flush();

      // 1. Tear down any previous loader
      if (this.activeLoader) {
        this.activeLoader.stop();
        this.activeLoader.destroy();
        this.activeLoader = null;
      }

      // 2. Resolve active codec from URL markers (HLS mock:// and WS codec= hints)
      if (url.includes('codec=h265') || url.includes('codec=hevc') || url.includes('mock://hevc')) {
        this.activeCodec = 'h265';
      } else if (url.includes('codec=mjpeg') || url.includes('mock://mjpeg')) {
        this.activeCodec = 'mjpeg';
      } else {
        this.activeCodec = 'h264';
      }

      // 3. Initialize background Demuxer Worker before any data flows
      this.initDemuxWorker();

      // 4. Select a loader for this URL's scheme
      const scheme = LoaderRegistry.schemeOf(url);
      if ((scheme === 'ws' || scheme === 'wss') && !this.loaderRegistry.has(scheme)) {
        throw new Error(
          'Low-latency WebSocket streaming requires the @yumyum-player/pro-streaming plugin. ' +
          'Enable it via: new YumYumPlayer({ canvas, plugins: [proStreaming()] }).'
        );
      }
      const loader = this.loaderRegistry.create(url, this.loaderDeps);
      if (!loader) {
        throw new Error(`No stream loader is registered for "${scheme}://" URLs.`);
      }
      this.activeLoader = loader;

      // 5. Connect / load the source
      await loader.load(url);

      if (loader.kind === 'push') {
        // Live stream: already streaming on connect — start playback immediately
        this.playbackController.duration = Infinity;
        this.isInitialized = true;
        this.lifecycleState = 'PLAYING';
        this.playbackController.start();
        this.emit('play');
        return;
      }

      // Pull stream (HLS/mock): downloading deferred to play()
      this.playbackController.duration = this.getDuration();
      this.isInitialized = true;
      this.lifecycleState = 'LOADED';
    } catch (err) {
      this.logger.error('Failed to load stream:', err);
      this.lifecycleState = 'IDLE';
      this.terminateDemuxWorker();
      throw err;
    }
  }

  private initDemuxWorker(): void {
    if (this.worker) {
      this.logger.info(`Reusing active Demuxer Worker instance. Resetting internal state. Active Codec: ${this.activeCodec}`);
      this.worker.postMessage({
        type: 'INIT',
        data: {
          videoCodec: this.activeCodec,
          audioCodec: 'aac',
          logLevel: this.logger.getLevel(),
        },
      });
      return;
    }

    try {
      // Strategy: Inline Blob Worker (zero external file dependencies)
      // The worker source is bundled as a string constant at build time.
      const blob = new Blob([DEMUXER_WORKER_SOURCE], { type: 'application/javascript' });
      this.workerBlobUrl = URL.createObjectURL(blob);
      this.worker = new Worker(this.workerBlobUrl);

      this.worker.onmessage = (e: MessageEvent) => {
        try {
          const { type, codec, pts, data, isKeyframe } = e.data;

          if (type === 'VIDEO') {
            const decoder = this.decoders.get(codec);
            if (decoder) {
              decoder.decode(data, Math.floor(pts * 1000000), isKeyframe, e.data.parsedCodec, e.data.description);
            }
          } else if (type === 'AUDIO') {
            const decoder = this.decoders.get('aac');
            if (decoder) {
              decoder.decode(data, Math.floor(pts * 1000000), true);
            }
          }
        } catch (err) {
          this.logger.error('Decode pipeline error:', err);
          this.emit('error', err instanceof Error ? err : new Error(String(err)));
        }
      };

      this.worker.onerror = (err) => {
        this.logger.error('Worker error:', err);
        this.emit('error', err);
      };

      // Set up worker codecs config
      this.worker.postMessage({
        type: 'INIT',
        data: {
          videoCodec: this.activeCodec,
          audioCodec: 'aac',
          logLevel: this.logger.getLevel(),
        },
      });
    } catch (err: unknown) {
      this.logger.error('CRITICAL: Web Worker creation failed. Demuxing pipeline is non-functional.', err);
      this.emit('error', new Error('Demuxer Worker creation failed. Playback will not work. Check CSP/COEP headers.'));
    }
  }

  private terminateDemuxWorker(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    if (this.workerBlobUrl) {
      URL.revokeObjectURL(this.workerBlobUrl);
      this.workerBlobUrl = null;
    }
  }

  /** Start or resume playback */
  public async play(): Promise<void> {
    if (this.lifecycleState === 'DESTROYED') {
      throw new Error('YumYumPlayer: Cannot play. Player is in DESTROYED state.');
    }
    if (this.lifecycleState === 'IDLE') {
      throw new Error('YumYumPlayer: Cannot play. No stream is loaded. Call load() first.');
    }

    if (!this.isInitialized) return;

    this.logger.info(`Starting playback (Current state: ${this.lifecycleState})`);

    // Always activate AudioContext so audio flows through the pipeline even
    // when muted. Gain=0 provides silence; unmuting just raises the gain.
    await this.audioRenderer.resume();
    this.playbackController.start();
    // `push` loaders stream on connect and treat this as a no-op.
    this.activeLoader?.start(() => this.isBackpressurePaused);
    this.lifecycleState = 'PLAYING';
    this.emit('play');
  }

  /** Pause playback */
  public pause(): void {
    if (this.lifecycleState === 'DESTROYED') {
      return;
    }

    this.logger.info(`Pausing playback (Current state: ${this.lifecycleState})`);

    this.playbackController.pause();
    this.audioRenderer.suspend();
    // `push` loaders keep streaming so the live edge stays current (no-op stop).
    this.activeLoader?.stop();
    if (this.lifecycleState === 'PLAYING') {
      this.lifecycleState = 'PAUSED';
    }
    this.emit('pause');
  }

  /**
   * Seek to a specific time position.
   *
   * @param timeSeconds - Target position in seconds
   */
  public seek(timeSeconds: number): void {
    if (!Number.isFinite(timeSeconds) || timeSeconds < 0) {
      this.logger.warn(`Invalid seek value: ${timeSeconds}. Ignoring.`);
      return;
    }
    if (!this.activeLoader) return;
    // Loader rejects the seek (e.g. live) — abort without touching playback.
    if (!this.activeLoader.seek(timeSeconds)) {
      this.logger.warn('Seeking is not supported on the active stream (live).');
      return;
    }
    this.playbackController.seek(timeSeconds);
    this.audioRenderer.flush();
    if (this.worker) {
      this.worker.postMessage({ type: 'FLUSH' });
    }
    // The loader halts its fetch loop on seek(). Restart it from the new
    // position so frames keep flowing — otherwise playback freezes (the clock
    // keeps ticking but no new frames arrive) until the next play() call.
    if (this.lifecycleState === 'PLAYING') {
      this.activeLoader.stop();
      this.activeLoader.start(() => this.isBackpressurePaused);
    }
  }

  /**
   * Set playback volume.
   *
   * @param volume - Volume level (0.0 — 1.0)
   */
  public setVolume(volume: number): void {
    this.audioRenderer.setVolume(volume);
    if (volume > 0) {
      this.audioRenderer.resume().catch(() => {});
    }
  }

  /**
   * Mute or unmute audio.
   *
   * @param isMuted - true to mute, false to unmute
   */
  public mute(isMuted: boolean): void {
    this.userMuted = isMuted;
    this.audioRenderer.mute(isMuted);
    if (!isMuted && this.audioRenderer.state !== 'running') {
      // Re-resume the AudioContext if it got suspended (e.g. Safari policy).
      // This is a no-op if the context is already running.
      this.audioRenderer.resume().catch(() => {});
    }
  }

  /** Allowed playback speeds, matching the UI speed menu. */
  private static readonly PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

  /**
   * Set the playback speed. The value is clamped to the supported set.
   * Audio is not time-stretched, so non-1x speeds mute audio automatically;
   * returning to 1x restores the user's own mute preference.
   *
   * @param rate - Desired speed multiplier (e.g. 0.5, 1, 1.5, 2)
   */
  public setPlaybackRate(rate: number): void {
    // Snap to the nearest supported rate so the clock and UI stay in sync.
    const allowed = YumYumPlayer.PLAYBACK_RATES;
    const clamped = allowed.reduce((best, r) =>
      Math.abs(r - rate) < Math.abs(best - rate) ? r : best, allowed[0]);

    this.playbackController.setPlaybackRate(clamped);

    // Mute while sped up / slowed down; restore the user's choice at 1x.
    this.audioRenderer.mute(clamped !== 1 ? true : this.userMuted);
    if (clamped === 1 && !this.userMuted && this.audioRenderer.state !== 'running') {
      this.audioRenderer.resume().catch(() => {});
    }
  }

  /** Get the current playback speed multiplier. */
  public getPlaybackRate(): number {
    return this.playbackController.getPlaybackRate();
  }

  /** Get the current playback position in seconds. */
  public getCurrentTime(): number {
    return this.playbackController.getCurrentTime();
  }

  /** Get real-time player diagnostics and telemetry */
  public getTelemetry(): PlayerTelemetry {
    const diag = this.playbackController.getDiagnostics();
    return {
      ...diag,
      activeCodec: this.activeCodec,
      duration: this.getDuration(),
      bufferedEnd: this.activeLoader?.getBufferedEnd?.() ?? diag.currentPTS,
      decodingStrategy:
        this.activeCodec === 'h265' && this.decoders.get('h265')?.isSoftwareFallback?.()
          ? 'WASM Fallback'
          : this.activeCodec === 'mjpeg'
          ? 'ImageBitmap (CPU)'
          : 'WebCodecs (GPU)',
    };
  }

  /** Get total media duration in seconds (Infinity for live streams) */
  public getDuration(): number {
    return this.activeLoader ? this.activeLoader.getDuration() : 0;
  }

  /**
   * Media position (seconds) up to which the stream has been downloaded. For VOD
   * this leads the playhead by the loader's raw look-ahead window, giving a
   * YouTube-style buffer bar. Returns 0 when the active loader cannot report it.
   */
  public getBufferedEnd(): number {
    return this.activeLoader?.getBufferedEnd?.() ?? 0;
  }

  /** Destroy the player and release all resources */
  public destroy(): void {
    if (this.lifecycleState === 'DESTROYED') {
      return;
    }

    this.logger.info(`Destroying player (Current state: ${this.lifecycleState})`);
    this.pause();
    if (this.activeLoader) {
      this.activeLoader.destroy();
      this.activeLoader = null;
    }
    this.terminateDemuxWorker();
    this.playbackController.destroy();
    this.audioRenderer.destroy().catch((err) => {
      this.logger.error('Failed to destroy audio renderer:', err);
    });
    this.videoRenderer.destroy();
    this.decoders.destroyAll();
    this.listeners.clear();
    this.isInitialized = false;
    this.lifecycleState = 'DESTROYED';
  }
}

// ─── Backwards Compatibility Alias ──────────────────────────────────

/** @deprecated Use `YumYumPlayer` instead */
export type MultiCodecPlayer = YumYumPlayer;
/** @deprecated Use `YumYumPlayer` instead */
export const MultiCodecPlayer = YumYumPlayer;

