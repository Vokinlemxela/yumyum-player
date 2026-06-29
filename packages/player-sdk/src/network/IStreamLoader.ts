import { Logger } from '../utils/Logger.js';
import { QualitySource } from '../quality/QualitySource.js';

/**
 * How the player drives a loader:
 * - `pull`: the player pulls media on demand via {@link IStreamLoader.start} /
 *   {@link IStreamLoader.stop} and may seek (e.g. HLS).
 * - `push`: the loader streams continuously once {@link IStreamLoader.load}
 *   connects; start/stop are no-ops and seeking is unsupported (e.g. live WS).
 */
export type LoaderKind = 'pull' | 'push';

/**
 * Per-segment timing metadata emitted by archive VOD loaders just BEFORE the
 * segment bytes are delivered via {@link LoaderDeps.onData}. Lets the demuxer
 * rebase the self-contained fMP4 segment onto a continuous media timeline.
 * Only archive playlists (HLS-VOD carrying `#EXT-X-PROGRAM-DATE-TIME`) emit it.
 */
export interface SegmentMeta {
  /** Sum of durations (s) of all preceding segments — the media-time base for this segment. */
  mediaBase: number;
  /** Wall-clock start of this segment (ms epoch), from PROGRAM-DATE-TIME. */
  programDateTime: number;
  /** True when a recording gap precedes this segment (`#EXT-X-DISCONTINUITY`). */
  discontinuity: boolean;
}

/**
 * Wall-clock coverage of an archive VOD timeline: the absolute time span the
 * recording covers plus any recording gaps inside it.
 */
export interface WallClockRange {
  startMs: number;
  endMs: number;
  gaps: { startMs: number; endMs: number }[];
}

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
  /**
   * Timing metadata for the NEXT segment fed via {@link onData}. Emitted in
   * order, immediately before that segment's bytes, only for archive VOD
   * segments. Live / progressive MP4 / mock paths never call it.
   */
  onSegmentMeta?: (meta: SegmentMeta) => void;
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
  readonly quality?: QualitySource;
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
  /** Get current throughput estimation (in Kbps) and number of samples */
  getThroughput?(): { throughputKbps: number; throughputSamples: number };
  /**
   * Whether this loader exposes a wall-clock (PROGRAM-DATE-TIME) timeline.
   * Only archive VOD loaders return `true`; live / progressive / mock omit it.
   */
  hasProgramDateTime?(): boolean;
  /**
   * Map a continuous media-time position (s) to absolute wall-clock (ms epoch),
   * using the PROGRAM-DATE-TIME of the segment that contains it. `null` when no
   * wall-clock timeline is available.
   */
  mediaToWall?(mediaSeconds: number): number | null;
  /**
   * Map an absolute wall-clock instant (ms epoch) to a media-time position (s).
   * Instants inside a recording gap snap forward to the next segment. `null`
   * when no wall-clock timeline is available.
   */
  wallToMedia?(wallMs: number): number | null;
  /** Absolute wall-clock coverage of the archive, or `null` when unavailable. */
  getWallClockRange?(): WallClockRange | null;
  /** Release all resources. */
  destroy(): void;
}

/** Constructs a loader from the shared {@link LoaderDeps}. */
export type LoaderFactory = (deps: LoaderDeps) => IStreamLoader;
