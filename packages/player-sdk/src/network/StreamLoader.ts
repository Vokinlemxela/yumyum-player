import { Logger } from '../utils/Logger.js';
import { MockStreamGenerator } from './MockStreamGenerator.js';
import { IStreamLoader, LoaderDeps, LoaderKind, SegmentMeta, WallClockRange } from './IStreamLoader.js';

export interface Segment {
  url: string;
  duration: number;
  failed?: boolean; // Track segments that returned 404 (already deleted by FFmpeg)
  /** Wall-clock start of this segment (ms epoch), from `#EXT-X-PROGRAM-DATE-TIME`. */
  programDateTime?: number;
  /** Set when `#EXT-X-DISCONTINUITY` precedes this segment (a recording gap). */
  discontinuity?: boolean;
}

export class StreamLoader implements IStreamLoader {
  /** HLS is pull-driven: the player fetches segments on demand and may seek. */
  public readonly kind: LoaderKind = 'pull';

  private segments: Segment[] = [];
  private segmentUrls: Set<string> = new Set();
  /**
   * Lazy prefix-sum of segment durations: `segmentStarts[i]` = mediaBase of
   * segment i (sum of durations [0..i)); the final entry is the total media
   * duration. Built on first wall-clock query and invalidated on ANY change to
   * the segments array (see `markSegmentsDirty`). Keeps the wall-clock hot-path
   * O(1)/O(log n) instead of O(n) per frame on day-long archives.
   */
  private segmentStarts: number[] | null = null;
  /** Cached `hasProgramDateTime` flag, recomputed during parse, never per-call. */
  private hasPDT = false;
  /** Next segment the worker will be fed (the decode/playback front). */
  private currentSegmentIndex = 0;
  /** Next segment to download into the raw look-ahead buffer (the network front). */
  private fetchIndex = 0;
  /**
   * Downloaded-but-not-yet-decoded segments. This is the cheap raw cushion that
   * lets the network run ahead of the decoder without holding decoded frames.
   */
  private pendingRaw: { index: number; buffer: ArrayBuffer; duration: number }[] = [];
  private consecutiveFailures = 0;
  private isBackpressurePausedFn: (() => boolean) | null = null;
  /**
   * How many seconds of raw (un-decoded) segment data to pre-download ahead of the
   * feed point for VOD. Decoupled from decoder backpressure so the buffer bar can
   * lead the playhead like YouTube without back-pressuring the WebCodecs frame pool.
   */
  private readonly RAW_LOOKAHEAD_SECONDS = 15;
  private isLive = false;
  private targetDuration = 5;
  private isDownloading = false;
  private playlistUrl = '';
  private isMp4 = false;
  private mp4Duration = 0;
  private initSegmentUrl = '';
  private initSegmentBuffer: ArrayBuffer | null = null;
  private needSendInit = false;
  /**
   * Archive VOD: a non-live playlist that carries `#EXT-X-PROGRAM-DATE-TIME` on
   * its segments. Gates the wall-clock timeline and per-segment meta emission;
   * live / progressive MP4 / mock all keep this `false` and behave as before.
   */
  private isArchive = false;

  private activeAbortController: AbortController | null = null;
  private loopTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private loopGeneration = 0;

  private getAbortSignal(): AbortSignal {
    if (!this.activeAbortController) {
      this.activeAbortController = new AbortController();
    }
    return this.activeAbortController.signal;
  }

  private abortActiveRequests() {
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }
  }

  private onSegmentLoaded: ((segmentData: ArrayBuffer) => void) | null;
  private onSegmentMeta: ((meta: SegmentMeta) => void) | null;
  private onMockPacket: ((packet: Uint8Array, type: 'video' | 'audio', pts: number, isKey: boolean) => void) | null;
  private onError: ((error: Error) => void) | null;
  private logger: Logger;

  constructor(deps: LoaderDeps) {
    this.onSegmentLoaded = (buffer) => deps.onData(buffer, this.isMp4);
    this.onSegmentMeta = deps.onSegmentMeta ?? null;
    this.onMockPacket = deps.onMockPacket;
    this.onError = deps.onError;
    this.logger = deps.logger;
  }

  /**
   * Mark the prefix-sum cache stale. Called on every segments-array mutation
   * (loadPlaylist reset, parseM3U8 append). Rebuilt lazily on the next query so
   * a burst of appends costs a single rebuild, not one per append.
   */
  private markSegmentsDirty(): void {
    this.segmentStarts = null;
  }

  /**
   * Lazily (re)build the prefix-sum of segment durations. `segmentStarts[i]` is
   * the mediaBase of segment i; `segmentStarts[length]` is the total duration.
   */
  private ensureSegmentStarts(): number[] {
    if (this.segmentStarts !== null) return this.segmentStarts;
    const starts = new Array<number>(this.segments.length + 1);
    let acc = 0;
    for (let i = 0; i < this.segments.length; i++) {
      starts[i] = acc;
      acc += this.segments[i].duration;
    }
    starts[this.segments.length] = acc;
    this.segmentStarts = starts;
    return starts;
  }

  /**
   * Media-time base (s) of a segment = sum of durations of all preceding
   * segments. Media time is continuous: recording gaps collapse, and wall-clock
   * is recovered from each segment's PROGRAM-DATE-TIME. O(1) via the prefix-sum
   * cache.
   */
  private mediaBaseOf(index: number): number {
    const starts = this.ensureSegmentStarts();
    if (index <= 0) return 0;
    if (index >= this.segments.length) return starts[this.segments.length];
    return starts[index];
  }

  /**
   * Emit per-segment timing meta just before its bytes, but only for archive
   * VOD segments (those carrying a PROGRAM-DATE-TIME). Keeps strict ordering
   * with onSegmentLoaded so the demuxer rebases the matching bytes.
   */
  private emitSegmentMeta(index: number): void {
    if (!this.isArchive || !this.onSegmentMeta) return;
    const seg = this.segments[index];
    if (!seg || seg.programDateTime === undefined) return;
    this.onSegmentMeta({
      mediaBase: this.mediaBaseOf(index),
      programDateTime: seg.programDateTime,
      discontinuity: seg.discontinuity ?? false,
    });
  }

  // ─── IStreamLoader ──────────────────────────────────────────────────
  public load(url: string): Promise<void> {
    return this.loadPlaylist(url);
  }

  public start(isBackpressured: () => boolean): void {
    this.startDownloading(isBackpressured);
  }

  public stop(): void {
    this.stopDownloading();
  }

  public async loadPlaylist(url: string): Promise<void> {
    this.segments = [];
    this.segmentUrls.clear();
    this.markSegmentsDirty();
    this.hasPDT = false;
    this.currentSegmentIndex = 0;
    this.fetchIndex = 0;
    this.pendingRaw = [];
    this.consecutiveFailures = 0;
    this.playlistUrl = url;
    this.isMp4 = false;
    this.isArchive = false;
    this.initSegmentUrl = '';
    this.initSegmentBuffer = null;
    this.needSendInit = false;

    // Support progressive MP4/fMP4 streams
    if (url.endsWith('.mp4') || url.includes('.mp4') || url.includes('/export') || url.includes('format=mp4')) {
      this.isMp4 = true;
      this.isLive = false;
      const u = new URL(url, typeof window !== 'undefined' ? window.location.href : undefined);
      const durParam = u.searchParams.get('duration');
      if (durParam) {
        this.mp4Duration = parseFloat(durParam);
      }
      this.segments = [{ url, duration: this.mp4Duration || 300 }];
      this.logger.debug(`Progressive MP4 stream detected. Target duration: ${this.mp4Duration || 300}s`);
      return;
    }

    // Support local mock streams directly to guarantee stable test capabilities
    if (url.startsWith('mock://') || url.includes('mock://')) {
      this.generateMockPlaylist(url);
      return;
    }

    if (url.startsWith('rtsp://') || url.includes('rtsp://')) {
      throw new Error("RTSP URL cannot be fetched directly in the browser. Please use the RTSP Transcoder tab.");
    }

    this.abortActiveRequests();
    try {
      const response = await fetch(url, { signal: this.getAbortSignal() });
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      const text = await response.text();

      // Check if it is a master playlist (multivariant)
      if (text.includes('#EXT-X-STREAM-INF')) {
        const lines = text.split('\n');
        const urlWithoutHash = url.split('#')[0].split('?')[0];
        const baseUrl = urlWithoutHash.substring(0, urlWithoutHash.lastIndexOf('/') + 1);
        let streamUrl = '';
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line.startsWith('#EXT-X-STREAM-INF')) {
            for (let j = i + 1; j < lines.length; j++) {
              const nextLine = lines[j].trim();
              if (nextLine && !nextLine.startsWith('#')) {
                streamUrl = nextLine;
                break;
              }
            }
            if (streamUrl) break;
          }
        }
        if (streamUrl) {
          const resolvedUrl = streamUrl.startsWith('http') ? streamUrl : baseUrl + streamUrl;
          this.logger.debug(`Master playlist detected. Loading media playlist: ${resolvedUrl}`);
          return this.loadPlaylist(resolvedUrl);
        }
        throw new Error('No media playlist found in master playlist.');
      }

      this.parseM3U8(text, url);

      // Download init segment if present
      if (this.initSegmentUrl) {
        this.logger.debug(`Loading init segment from: ${this.initSegmentUrl}`);
        const res = await fetch(this.initSegmentUrl, { signal: this.getAbortSignal() });
        if (!res.ok) throw new Error(`Failed to load init segment from: ${this.initSegmentUrl}`);
        this.initSegmentBuffer = await res.arrayBuffer();
        this.needSendInit = true;
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      this.logger.error('Failed to load playlist:', err);
      throw err;
    }
  }

  private parseM3U8(text: string, playlistUrl: string) {
    const lines = text.split('\n');
    const urlWithoutHash = playlistUrl.split('#')[0].split('?')[0];
    const baseUrl = urlWithoutHash.substring(0, urlWithoutHash.lastIndexOf('/') + 1);
    
    let currentDuration = 5;
    const newSegments: Segment[] = [];
    this.initSegmentUrl = '';

    // PROGRAM-DATE-TIME and DISCONTINUITY apply to the NEXT segment URI line.
    let pendingPDT: number | undefined;
    let pendingDiscontinuity = false;
    let sawPDT = false;

    for (let line of lines) {
      line = line.trim();
      if (line.startsWith('#EXT-X-TARGETDURATION:')) {
        this.targetDuration = parseInt(line.split(':')[1], 10);
      } else if (line.startsWith('#EXTINF:')) {
        currentDuration = parseFloat(line.split(':')[1].split(',')[0]);
      } else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
        // Value is RFC3339 / RFC3339Nano; Date.parse yields ms epoch and tolerates
        // missing trailing fractional digits. Skip unparseable values.
        const raw = line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length).trim();
        const parsed = Date.parse(raw);
        if (!Number.isNaN(parsed)) {
          pendingPDT = parsed;
          sawPDT = true;
        }
      } else if (line === '#EXT-X-DISCONTINUITY') {
        pendingDiscontinuity = true;
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const match = /URI="([^"]+)"/.exec(line);
        if (match) {
          const initUrl = match[1];
          this.initSegmentUrl = initUrl.startsWith('http') ? initUrl : baseUrl + initUrl;
        }
      } else if (line && !line.startsWith('#')) {
        // Resolve absolute or relative segment URL
        const segmentUrl = line.startsWith('http') ? line : baseUrl + line;
        newSegments.push({
          url: segmentUrl,
          duration: currentDuration,
          programDateTime: pendingPDT,
          discontinuity: pendingDiscontinuity,
        });
        pendingPDT = undefined;
        pendingDiscontinuity = false;
      }
    }

    this.isLive = !text.includes('#EXT-X-ENDLIST');
    // Archive VOD = non-live playlist whose segments carry PROGRAM-DATE-TIME.
    // This gates the wall-clock timeline and per-segment meta emission.
    this.isArchive = !this.isLive && sawPDT;

    if (this.segments.length === 0) {
      this.segments = newSegments;
      this.segmentUrls = new Set(newSegments.map(s => s.url));
      // Cache the wall-clock flag at parse time so hasProgramDateTime() never
      // scans the (possibly day-long) segments array per call.
      this.hasPDT = this.isArchive && newSegments.some((s) => s.programDateTime !== undefined);
      // Fresh segments array — invalidate the prefix-sum cache.
      this.markSegmentsDirty();

      // If it is a live stream, seek to the active edge (second to last segment) on first load
      if (this.isLive && this.segments.length > 0) {
        this.currentSegmentIndex = Math.max(0, this.segments.length - 2);
        this.logger.debug(`Live stream detected. Starting playback from active edge segment index: ${this.currentSegmentIndex}`);
      }
    } else {
      const newManifestUrls = new Set(newSegments.map(s => s.url));

      // For live stream: only append new segments that aren't already in the queue (O(1) Set lookup)
      let appended = false;
      for (const newSeg of newSegments) {
        if (!this.segmentUrls.has(newSeg.url)) {
          this.segments.push(newSeg);
          this.segmentUrls.add(newSeg.url);
          appended = true;
          if (this.isArchive && newSeg.programDateTime !== undefined) this.hasPDT = true;
        }
      }
      // Any append changes the prefix-sum; invalidate so the next query rebuilds.
      if (appended) this.markSegmentsDirty();

      // Cleanup: remove old, already played segments to prevent memory leaks in live mode
      if (this.isLive && this.segments.length > 50) {
        let shift = 0;
        const filteredSegments: Segment[] = [];
        
        for (let i = 0; i < this.segments.length; i++) {
          const seg = this.segments[i];
          if (i >= this.currentSegmentIndex || newManifestUrls.has(seg.url)) {
            filteredSegments.push(seg);
          } else {
            shift++;
          }
        }
        
        if (shift > 0) {
          this.segments = filteredSegments;
          this.segmentUrls = new Set(filteredSegments.map(s => s.url));
          this.currentSegmentIndex = Math.max(0, this.currentSegmentIndex - shift);
          // Segments array rebuilt — invalidate the prefix-sum cache.
          this.markSegmentsDirty();
          this.logger.debug(`Cleaned up ${shift} played segments from queue. Active index shifted to: ${this.currentSegmentIndex}`);
        }
      }

      // For live streams: if current index points to a segment that no longer exists in the
      // refreshed manifest, fast-forward to the earliest available segment (live edge recovery)
      if (this.isLive && this.currentSegmentIndex < this.segments.length) {
        const currentUrl = this.segments[this.currentSegmentIndex]?.url;
        if (currentUrl && !newManifestUrls.has(currentUrl)) {
          const firstAvailableIdx = this.segments.findIndex(s => 
            newManifestUrls.has(s.url)
          );
          if (firstAvailableIdx > this.currentSegmentIndex) {
            this.logger.debug(`Live edge recovery: jumping from segment ${this.currentSegmentIndex} to ${firstAvailableIdx}`);
            this.currentSegmentIndex = firstAvailableIdx;
          }
        }
      }
    }

    this.logger.debug(`Parsed M3U8: ${this.segments.length} segments in queue. Live stream: ${this.isLive}`);
  }

  private generateMockPlaylist(url: string) {
    // Setting up mock playback segments
    this.logger.debug(`Generating mock streaming profile for: ${url}`);
    this.isLive = false;
    this.segments = Array.from({ length: 20 }, (_, i) => ({
      url: `${url}/segment_${i}.ts`,
      duration: 2.0,
    }));
  }

  private async refreshPlaylist(): Promise<void> {
    if (!this.playlistUrl || this.playlistUrl.startsWith('mock://') || this.playlistUrl.includes('mock://')) return;
    try {
      const response = await fetch(this.playlistUrl, { signal: this.getAbortSignal() });
      if (response.ok) {
        const text = await response.text();
        this.parseM3U8(text, this.playlistUrl);
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      this.logger.error('Failed to refresh live playlist:', err);
    }
  }

  /** Mock streams synthesize packets locally and have no real network cushion. */
  private isMockPlaylist(): boolean {
    return !!this.playlistUrl && (this.playlistUrl.startsWith('mock://') || this.playlistUrl.includes('mock://'));
  }

  /**
   * The raw look-ahead buffer only applies to VOD pulled over the network. Live
   * keeps its low-latency direct-feed loop, and mock streams feed generated
   * packets straight through.
   */
  private isRawLookaheadEligible(): boolean {
    return !this.isLive && !this.isMockPlaylist();
  }

  /** Seconds of media currently sitting in the raw (un-decoded) look-ahead buffer. */
  private rawBufferedSeconds(): number {
    let total = 0;
    for (const raw of this.pendingRaw) total += raw.duration;
    return total;
  }

  public async startDownloading(isBackpressurePaused: () => boolean) {
    this.isBackpressurePausedFn = isBackpressurePaused;
    if (this.isDownloading) return;
    this.isDownloading = true;
    this.kickDownloadLoop();
  }

  /** (Re)start the download loop, invalidating any loop already in flight. */
  private kickDownloadLoop() {
    this.loopGeneration++;
    if (this.loopTimeoutId) {
      clearTimeout(this.loopTimeoutId);
      this.loopTimeoutId = null;
    }
    this.runDownloadLoop(this.loopGeneration);
  }

  private async runDownloadLoop(gen: number): Promise<void> {
    if (!this.isDownloading || this.loopGeneration !== gen) return;

    const isBackpressurePaused = this.isBackpressurePausedFn ?? (() => false);
    const scheduleNext = (delay: number) => {
      if (this.loopGeneration !== gen) return;
      if (this.loopTimeoutId) clearTimeout(this.loopTimeoutId);
      this.loopTimeoutId = setTimeout(() => this.runDownloadLoop(gen), delay);
    };

    if (this.isMp4) {
      await this.mp4Tick(gen, isBackpressurePaused, scheduleNext);
    } else if (this.isRawLookaheadEligible()) {
      await this.vodTick(gen, isBackpressurePaused, scheduleNext);
    } else {
      await this.legacyTick(isBackpressurePaused, scheduleNext);
    }
  }

  /**
   * VOD tick: download-ahead is decoupled from decode backpressure.
   * 1. Feed at most one raw segment to the worker — gated by backpressure.
   * 2. Fetch ahead into the raw buffer up to RAW_LOOKAHEAD_SECONDS — NOT gated by
   *    backpressure, so getBufferedEnd() leads the playhead like YouTube.
   */
  private async vodTick(
    gen: number,
    isBackpressurePaused: () => boolean,
    scheduleNext: (delay: number) => void,
  ): Promise<void> {
    // 1. Feed worker — the only step gated by the decoded-frame queue. Release one
    //    raw segment to the demuxer/decoder when the frame queue has drained.
    let didFeed = false;
    if (!isBackpressurePaused() && this.pendingRaw.length > 0) {
      if (this.needSendInit && this.initSegmentBuffer) {
        this.logger.debug('Sending HLS fMP4 init segment');
        this.onSegmentLoaded?.(this.initSegmentBuffer.slice(0));
        this.needSendInit = false;
      }

      const raw = this.pendingRaw.shift()!;
      this.currentSegmentIndex = raw.index + 1;
      // Archive VOD: hand the demuxer this segment's timing meta in order, right
      // before its bytes, so it can rebase the self-contained fMP4 onto a
      // continuous media timeline. No-op for live / progressive / mock.
      this.emitSegmentMeta(raw.index);
      this.onSegmentLoaded?.(raw.buffer);
      didFeed = true;
    }

    // 2. Fetch ahead — independent of backpressure, bounded by the raw look-ahead.
    const canFetch =
      this.fetchIndex < this.segments.length &&
      this.rawBufferedSeconds() < this.RAW_LOOKAHEAD_SECONDS;

    if (canFetch) {
      const segment = this.segments[this.fetchIndex];
      try {
        const res = await fetch(segment.url, { signal: this.getAbortSignal() });
        if (this.loopGeneration !== gen) return; // seek/stop happened while fetching

        let buffer: ArrayBuffer | null = null;
        let isValid = false;
        if (res.ok) {
          buffer = await res.arrayBuffer();
          const uint8 = new Uint8Array(buffer);
          if (this.isValidSegment(uint8)) {
            isValid = true;
          } else {
            this.logger.warn(`Received invalid segment (size: ${uint8.length} bytes, sync byte: 0x${uint8[0]?.toString(16) || 'none'}). HTML/404 response suspected.`);
          }
        }
        if (this.loopGeneration !== gen) return; // seek/stop happened while reading body

        if (isValid && buffer) {
          this.pendingRaw.push({ index: this.fetchIndex, buffer, duration: segment.duration });
          this.fetchIndex++;
          this.consecutiveFailures = 0;
          // Fill the look-ahead with no artificial delay while the decoder is
          // backpressured. But if we ALSO fed this tick, keep the original ~50ms
          // feed cadence so the decoder can re-assert backpressure before we hand
          // it another full segment — otherwise many decoded frames pile up and
          // stall the HW decoder pool (the whole reason we buffer raw, not frames).
          scheduleNext(didFeed ? 50 : 0);
        } else {
          this.consecutiveFailures++;
          this.logger.warn(`Segment fetch failed: ${segment.url} | Consecutive failures: ${this.consecutiveFailures}`);
          const backoff = Math.min(5000, 500 * Math.pow(2, this.consecutiveFailures - 1));
          scheduleNext(backoff);
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') {
          this.logger.debug('Segment download fetch aborted successfully.');
          return;
        }
        this.consecutiveFailures++;
        this.logger.error(`Network error downloading segment: ${segment.url}`, err);
        const backoff = Math.min(5000, 500 * Math.pow(2, this.consecutiveFailures - 1));
        scheduleNext(backoff);
      }
      return;
    }

    // 3. Look-ahead full or all segments downloaded. Complete once the raw buffer
    //    has also fully drained into the worker.
    if (this.fetchIndex >= this.segments.length && this.pendingRaw.length === 0) {
      this.isDownloading = false;
      this.logger.debug('Stream download completed (EOF)');
      return;
    }

    // Either backpressured with a full look-ahead, or waiting for the queue to
    // drain. Poll again: a short beat after a feed, otherwise an idle wait.
    scheduleNext(didFeed ? 50 : 100);
  }

  /**
   * Legacy direct-feed tick for live streams (low latency) and mock streams
   * (locally generated packets). Fetch and feed share a single segment cursor.
   */
  private async legacyTick(
    isBackpressurePaused: () => boolean,
    scheduleNext: (delay: number) => void,
  ): Promise<void> {
    if (isBackpressurePaused()) {
      // Yield execution and check again shortly
      scheduleNext(100);
      return;
    }

    if (this.isLive && this.segments.length > 0) {
      const maxBehind = 2;
      const liveEdgeIndex = Math.max(0, this.segments.length - 1);
      if (liveEdgeIndex - this.currentSegmentIndex > maxBehind) {
        this.logger.warn(`Live streaming lag detected (currently at ${this.currentSegmentIndex}, latest is ${this.segments.length - 1}). Fast-forwarding directly to live edge index: ${liveEdgeIndex}`);
        this.currentSegmentIndex = liveEdgeIndex;
      }
    }

    if (this.currentSegmentIndex >= this.segments.length) {
      if (this.isMockPlaylist()) {
        this.logger.debug('Mock stream reached end of segments list. Looping back to segment 0.');
        this.currentSegmentIndex = 0;
      } else if (this.isLive) {
        // Refresh live playlist to look for newly appended segments
        await this.refreshPlaylist();

        if (this.currentSegmentIndex >= this.segments.length) {
          // No new segments are available yet. Poll at half target duration (spec compliant, saves CPU/network)
          const retryDelay = Math.max(500, Math.min(2500, (this.targetDuration * 1000) / 2));
          scheduleNext(retryDelay);
          return;
        }
      } else {
        this.isDownloading = false;
        this.logger.debug('Stream download completed (EOF)');
        return;
      }
    }

    const activeSegment = this.segments[this.currentSegmentIndex];

    if (activeSegment.url.startsWith('mock://') || activeSegment.url.includes('mock://')) {
      // Generate mock media elementary packets locally
      MockStreamGenerator.triggerMockPackets(activeSegment, this.currentSegmentIndex, this.onMockPacket);
      this.currentSegmentIndex++;
      this.consecutiveFailures = 0;
      // Queue next mock segment after simulated duration
      scheduleNext(activeSegment.duration * 1000);
    } else {
      try {
        const res = await fetch(activeSegment.url, { signal: this.getAbortSignal() });
        let isValid = false;
        let buffer: ArrayBuffer | null = null;

        if (res.ok) {
          buffer = await res.arrayBuffer();
          const uint8 = new Uint8Array(buffer);
          if (this.isValidSegment(uint8)) {
            isValid = true;
          } else {
            this.logger.warn(`Received invalid segment (size: ${uint8.length} bytes, sync byte: 0x${uint8[0]?.toString(16) || 'none'}). HTML/404 response suspected.`);
          }
        }

        if (isValid && buffer) {
          if (this.needSendInit && this.initSegmentBuffer) {
            this.logger.debug('Sending HLS fMP4 init segment');
            this.onSegmentLoaded?.(this.initSegmentBuffer.slice(0));
            this.needSendInit = false;
          }

          this.onSegmentLoaded?.(buffer);
          this.currentSegmentIndex++;
          this.consecutiveFailures = 0;
          // Small delay to let decoder process the segment before flooding with the next
          scheduleNext(50);
        } else {
          // Segment returned 404, network error, or invalid payload
          this.consecutiveFailures++;
          this.logger.warn(`Segment fetch failed: ${activeSegment.url} | Consecutive failures: ${this.consecutiveFailures}`);

           if (this.isLive) {
            // For live streams: skip deleted segment and refresh playlist to resync to live edge
            activeSegment.failed = true;
            this.currentSegmentIndex++;

            if (this.consecutiveFailures >= 2) {
              // Multiple consecutive 404s — we've fallen behind the live window.
              // Refresh playlist and jump to the live edge.
              this.logger.warn(`Too many 404s in sequence (${this.consecutiveFailures}). Resyncing to live edge...`);
              await this.refreshPlaylist();
              // Jump to the latest available segment (live edge)
              if (this.segments.length > 0) {
                this.currentSegmentIndex = Math.max(0, this.segments.length - 1);
                this.logger.debug(`Resynced to live edge at segment index: ${this.currentSegmentIndex}`);
              }
              this.consecutiveFailures = 0;
            }

            scheduleNext(30);
          } else {
            // For VOD: retry with exponential backoff
            const backoff = Math.min(5000, 500 * Math.pow(2, this.consecutiveFailures - 1));
            scheduleNext(backoff);
          }
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') {
          this.logger.debug('Segment download fetch aborted successfully.');
          return;
        }
        this.consecutiveFailures++;
        this.logger.error(`Network error downloading segment: ${activeSegment.url}`, err);
        // Exponential backoff on network errors
        const backoff = Math.min(5000, 500 * Math.pow(2, this.consecutiveFailures - 1));
        scheduleNext(backoff);
      }
    }
  }

  public stopDownloading() {
    this.isDownloading = false;
    this.loopGeneration++;
    if (this.loopTimeoutId) {
      clearTimeout(this.loopTimeoutId);
      this.loopTimeoutId = null;
    }
    this.abortActiveRequests();
  }



  public seek(pts: number): boolean {
    this.abortActiveRequests();
    // The raw look-ahead holds segments for the OLD position — drop them so the
    // buffer bar and network cushion rebuild from the seek target.
    this.pendingRaw = [];
    this.consecutiveFailures = 0;

    if (this.isMp4) {
      this.currentSegmentIndex = 0;
      this.fetchIndex = 0;
      this.loopGeneration++;
      if (this.loopTimeoutId) {
        clearTimeout(this.loopTimeoutId);
        this.loopTimeoutId = null;
      }
      return true;
    }

    this.needSendInit = true;
    let accumulatedTime = 0;
    let foundIndex = 0;

    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i];
      if (accumulatedTime + seg.duration > pts) {
        foundIndex = i;
        break;
      }
      accumulatedTime += seg.duration;
    }

    this.currentSegmentIndex = foundIndex;
    this.fetchIndex = foundIndex;
    this.logger.debug(`Seeked to PTS ${pts.toFixed(2)}s | Segment Index: ${foundIndex}/${this.segments.length}`);

    // Halt the in-flight loop: bump the generation so any pending tick and the
    // aborted in-flight fetch unwind cleanly. The player's seek() restarts the
    // loader (stop()+start()) from this new position, which re-fills the raw
    // look-ahead buffer fresh from foundIndex.
    this.loopGeneration++;
    if (this.loopTimeoutId) {
      clearTimeout(this.loopTimeoutId);
      this.loopTimeoutId = null;
    }
    return true;
  }

  public getDuration(): number {
    if (this.isLive) return Infinity;
    return this.segments.reduce((sum, seg) => sum + seg.duration, 0);
  }

  // ─── Wall-clock (PROGRAM-DATE-TIME) timeline ────────────────────────
  // Available only for archive VOD. PROGRAM-DATE-TIME is the single source of
  // truth for absolute time; synthetic media time is continuous (gaps collapse)
  // and wall = PDT(segment) + (mediaTime − mediaBase(segment))·1000.

  /** True when this loader exposes a PROGRAM-DATE-TIME wall-clock timeline. */
  public hasProgramDateTime(): boolean {
    // Flag is computed during parse (and on live append); O(1) per call.
    return this.hasPDT;
  }

  /**
   * Index of the segment whose media-time span [base, base+dur) contains
   * `mediaSeconds`. Binary search over the prefix-sum cache, O(log n). Values
   * at or beyond the end clamp to the last segment (matching the prior linear
   * implementation).
   */
  private segmentIndexForMedia(mediaSeconds: number): number | null {
    const n = this.segments.length;
    if (n === 0) return null;
    const starts = this.ensureSegmentStarts();
    // Find the largest i with starts[i] <= mediaSeconds. starts is strictly
    // non-decreasing; the segment span is [starts[i], starts[i+1]).
    let lo = 0;
    let hi = n - 1;
    let found = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= mediaSeconds) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    // `found` is the segment whose base is <= mediaSeconds; since the last
    // segment's span is open-ended here, anything at/past the end clamps to it.
    return found;
  }

  /**
   * Continuous media-time (s) → absolute wall-clock (ms epoch). Uses the
   * PROGRAM-DATE-TIME of the containing segment so it correctly jumps across
   * recording gaps. Returns `null` without a wall-clock timeline.
   */
  public mediaToWall(mediaSeconds: number): number | null {
    if (!this.hasProgramDateTime()) return null;
    const clamped = Math.max(0, mediaSeconds);
    const idx = this.segmentIndexForMedia(clamped);
    if (idx === null) return null;
    const seg = this.segments[idx];
    if (seg.programDateTime === undefined) return null;
    const base = this.mediaBaseOf(idx);
    return seg.programDateTime + (clamped - base) * 1000;
  }

  /**
   * Absolute wall-clock (ms epoch) → continuous media-time (s). When `wallMs`
   * falls inside a recording gap it snaps forward to the next segment's
   * mediaBase. Before the first / after the last segment it clamps to the
   * timeline bounds. Returns `null` without a wall-clock timeline.
   */
  public wallToMedia(wallMs: number): number | null {
    if (!this.hasProgramDateTime()) return null;

    const n = this.segments.length;
    if (n === 0) return null;
    const starts = this.ensureSegmentStarts();

    // Archive segments carry monotonically increasing PROGRAM-DATE-TIMEs, so we
    // can binary-search them. (gates above guarantee at least one PDT segment;
    // for archive playlists every segment has one.) Find the first segment whose
    // PDT is strictly greater than wallMs — the "snap forward" boundary.
    let lo = 0;
    let hi = n - 1;
    let firstGreater = n; // index of first segment with PDT > wallMs (n = none)
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const pdt = this.segments[mid].programDateTime;
      if (pdt !== undefined && pdt > wallMs) {
        firstGreater = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }

    if (firstGreater === 0) {
      // Before the first segment's PDT — clamp to the start of the timeline.
      return starts[0];
    }

    // Candidate containing segment is the one just before the snap boundary.
    const idx = firstGreater - 1;
    const seg = this.segments[idx];
    const pdt = seg.programDateTime;
    if (pdt === undefined) return starts[n]; // defensive: no PDT (archive: never)

    if (wallMs < pdt + seg.duration * 1000) {
      // Inside this segment's wall-clock span.
      return starts[idx] + (wallMs - pdt) / 1000;
    }
    if (firstGreater < n) {
      // In the recording gap between this segment's end and the next PDT —
      // snap forward to the next segment's mediaBase.
      return starts[firstGreater];
    }
    // Past the last segment — clamp to the end of the timeline.
    return starts[n];
  }

  /** Absolute wall-clock coverage of the archive (start, end, recording gaps). */
  public getWallClockRange(): WallClockRange | null {
    if (!this.hasProgramDateTime()) return null;

    let startMs: number | null = null;
    let endMs: number | null = null;
    const gaps: { startMs: number; endMs: number }[] = [];
    let prevEnd: number | null = null;

    for (const seg of this.segments) {
      if (seg.programDateTime === undefined) continue;
      const segStart = seg.programDateTime;
      const segEnd = segStart + seg.duration * 1000;
      if (startMs === null) startMs = segStart;
      // A discontinuity flag or a wall-clock jump between consecutive PDTs marks
      // a recording gap. Use the previous segment's wall-end as the gap start.
      if (prevEnd !== null && (seg.discontinuity || segStart > prevEnd + 1)) {
        gaps.push({ startMs: prevEnd, endMs: segStart });
      }
      endMs = segEnd;
      prevEnd = segEnd;
    }

    if (startMs === null || endMs === null) return null;
    return { startMs, endMs, gaps };
  }

  /**
   * Furthest buffered media position in seconds — drives the timeline buffer bar.
   * For VOD this counts every segment pulled into the raw look-ahead buffer (fed +
   * pending), so it leads the playhead by the look-ahead window like YouTube. For
   * live it tracks the fed position.
   */
  public getBufferedEnd(): number {
    const downloadedThrough = this.isRawLookaheadEligible()
      ? this.fetchIndex
      : this.currentSegmentIndex;
    let end = 0;
    for (let i = 0; i < downloadedThrough && i < this.segments.length; i++) {
      end += this.segments[i].duration;
    }
    return end;
  }

  public destroy() {
    this.stopDownloading();
    this.segments = [];
    this.segmentUrls.clear();
    this.pendingRaw = [];
    this.isBackpressurePausedFn = null;
    this.playlistUrl = '';
    this.onSegmentLoaded = null;
    this.onMockPacket = null;
    this.onError = null;
    this.initSegmentBuffer = null;
  }

  private isValidSegment(uint8: Uint8Array): boolean {
    if (uint8.length === 0) return false;
    if (uint8[0] === 0x47) return true;
    if (uint8.length >= 8) {
      const type = String.fromCharCode(uint8[4], uint8[5], uint8[6], uint8[7]);
      if (['ftyp', 'moof', 'mdat', 'styp'].includes(type)) return true;
    }
    return false;
  }

  private async mp4Tick(
    gen: number,
    isBackpressurePaused: () => boolean,
    scheduleNext: (delay: number) => void,
  ): Promise<void> {
    if (this.fetchIndex > 0) return;
    this.fetchIndex = 1;

    try {
      const res = await fetch(this.playlistUrl, { signal: this.getAbortSignal() });
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      if (!res.body) throw new Error('No response body');

      const reader = res.body.getReader();
      
      const readChunk = async () => {
        if (!this.isDownloading || this.loopGeneration !== gen) {
          reader.cancel().catch(() => {});
          return;
        }

        if (isBackpressurePaused()) {
          setTimeout(readChunk, 50);
          return;
        }

        try {
          const { done, value } = await reader.read();
          if (done) {
            this.isDownloading = false;
            this.logger.debug('MP4 progressive download completed (EOF)');
            return;
          }

          if (value) {
            if (this.currentSegmentIndex === 0) {
              const isValid = this.isValidSegment(value);
              if (!isValid) {
                this.logger.warn('Warning: MP4 stream first chunk is not a valid fMP4 container.');
              }
            }
            this.onSegmentLoaded?.(value.buffer);
            this.currentSegmentIndex++;
          }
          readChunk();
        } catch (err) {
          const isAbort = (err instanceof Error && err.name === 'AbortError') ||
            (err instanceof Error && err.message.includes('aborted')) ||
            (this.loopGeneration !== gen) ||
            (!this.isDownloading);
          
          if (isAbort) {
            this.logger.debug('MP4 chunk read aborted or generation changed.');
            return;
          }
          this.logger.error('Error reading MP4 stream chunk:', err);
          this.isDownloading = false;
          if (this.onError) this.onError(err instanceof Error ? err : new Error(String(err)));
        }
      };

      readChunk();
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        this.logger.debug('MP4 fetch aborted successfully.');
        return;
      }
      this.logger.error('Error starting MP4 download:', err);
      this.isDownloading = false;
      if (this.onError) this.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
