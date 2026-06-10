import { Logger } from '../utils/Logger.js';

/**
 * How the player drives a loader:
 * - `pull`: the player pulls media on demand via {@link IStreamLoader.start} /
 *   {@link IStreamLoader.stop} and may seek (e.g. HLS).
 * - `push`: the loader streams continuously once {@link IStreamLoader.load}
 *   connects; start/stop are no-ops and seeking is unsupported (e.g. live WS).
 */
export type LoaderKind = 'pull' | 'push';

/**
 * Dependencies handed to every loader factory. A loader uses only what it needs.
 */
export interface LoaderDeps {
  /**
   * Deliver a raw media buffer to the demuxer.
   * `streaming` selects continuous stream demux (`true`) vs. discrete segment
   * demux (`false`). The buffer is transferred, so callers must not reuse it.
   */
  onData: (buffer: ArrayBuffer, streaming: boolean) => void;
  /** Locally generated mock elementary packets that bypass the demuxer worker. */
  onMockPacket: ((packet: Uint8Array, type: 'video' | 'audio', pts: number, isKey: boolean) => void) | null;
  onError: ((error: Error) => void) | null;
  logger: Logger;
}

/**
 * A stream loader connects to a source and feeds media buffers into the demuxer.
 * Built-in loaders (HLS, WebSocket) and plugin loaders implement this contract.
 */
export interface IStreamLoader {
  readonly kind: LoaderKind;
  /** Connect to / load the URL. Resolves when ready to begin playback. */
  load(url: string): Promise<void>;
  /** Begin fetching. No-op for `push` loaders that stream on connect. */
  start(isBackpressured: () => boolean): void;
  /** Stop fetching. No-op for `push` loaders that stream continuously. */
  stop(): void;
  /** Seek to a position in seconds; returns `false` if unsupported (live). */
  seek(timeSeconds: number): boolean;
  /** Total duration in seconds (`Infinity` for live). */
  getDuration(): number;
  /**
   * Furthest buffered media position in seconds, for the timeline buffer bar —
   * the position up to which data has been downloaded ahead of the playhead.
   * Optional: `pull` loaders that track segments implement it; `push`/live
   * loaders may omit it.
   */
  getBufferedEnd?(): number;
  /** Release all resources. */
  destroy(): void;
}

/** Constructs a loader from the shared {@link LoaderDeps}. */
export type LoaderFactory = (deps: LoaderDeps) => IStreamLoader;
