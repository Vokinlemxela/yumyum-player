import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StreamLoader } from './StreamLoader.js';
import { LoaderDeps, SegmentMeta } from './IStreamLoader.js';
import { Logger } from '../utils/Logger.js';

// ─── Test helpers ───────────────────────────────────────────────────

const SEG_DURATION = 2;
const SEG_COUNT = 30; // 60s VOD

/** Build a VOD m3u8 (has ENDLIST) with SEG_COUNT segments of SEG_DURATION each. */
function makePlaylist(live = false): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${SEG_DURATION}`];
  for (let i = 0; i < SEG_COUNT; i++) {
    lines.push(`#EXTINF:${SEG_DURATION.toFixed(1)},`);
    lines.push(`segment_${i}.ts`);
  }
  if (!live) lines.push('#EXT-X-ENDLIST');
  return lines.join('\n');
}

/** A valid MPEG-TS payload always begins with the 0x47 sync byte. */
function makeTsSegment(): ArrayBuffer {
  const u8 = new Uint8Array(188);
  u8[0] = 0x47;
  return u8.buffer;
}

interface FetchTracker {
  playlistText: string;
  /** Indices of segments that have been fetched (by segment_<i>.ts). */
  fetched: number[];
}

function installFetchMock(tracker: FetchTracker) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('.m3u8')) {
      return { ok: true, text: async () => tracker.playlistText } as unknown as Response;
    }
    const match = url.match(/segment_(\d+)\.ts$/);
    if (match) tracker.fetched.push(Number(match[1]));
    return {
      ok: true,
      arrayBuffer: async () => makeTsSegment(),
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function makeLoader(onData: (buf: ArrayBuffer) => void) {
  const deps: LoaderDeps = {
    onData: (buffer) => onData(buffer),
    onMockPacket: null,
    onError: null,
    logger: new Logger('test', 'silent'),
  };
  return new StreamLoader(deps);
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('StreamLoader VOD raw look-ahead buffer', () => {
  let tracker: FetchTracker;

  beforeEach(() => {
    tracker = { playlistText: makePlaylist(), fetched: [] };
    installFetchMock(tracker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('downloads ahead into the raw buffer even while decode backpressure is held', async () => {
    const fed: ArrayBuffer[] = [];
    const loader = makeLoader((b) => fed.push(b));
    await loader.loadPlaylist('https://example.com/vod/stream.m3u8');

    // Backpressure permanently engaged: the decoder is "full", so nothing may be fed.
    loader.start(() => true);

    // The look-ahead fills to ~RAW_LOOKAHEAD_SECONDS (15s) without ever feeding.
    await waitFor(() => loader.getBufferedEnd() >= 15);

    // Give the loop a beat to confirm it stops at the bound rather than racing to EOF.
    await new Promise((r) => setTimeout(r, 100));

    expect(fed.length).toBe(0); // feed is gated by backpressure
    const buffered = loader.getBufferedEnd();
    expect(buffered).toBeGreaterThanOrEqual(15);
    // Bounded: one segment of overshoot at most, never the full 60s VOD.
    expect(buffered).toBeLessThanOrEqual(15 + SEG_DURATION);
    expect(tracker.fetched).toEqual([...Array(buffered / SEG_DURATION).keys()]);

    loader.destroy();
  });

  it('feeds the worker from the raw buffer once backpressure releases', async () => {
    const fed: ArrayBuffer[] = [];
    const loader = makeLoader((b) => fed.push(b));
    await loader.loadPlaylist('https://example.com/vod/stream.m3u8');

    let paused = true;
    loader.start(() => paused);

    await waitFor(() => loader.getBufferedEnd() >= 15);
    expect(fed.length).toBe(0);

    // Release backpressure: raw segments now drain into the worker.
    paused = false;
    await waitFor(() => fed.length >= 5);

    expect(fed.length).toBeGreaterThanOrEqual(5);
    // Download front stays ahead of the feed front (network cushion intact).
    expect(loader.getBufferedEnd()).toBeGreaterThan(fed.length * SEG_DURATION);

    loader.destroy();
  });

  it('clears the raw buffer and re-fetches from the seek target', async () => {
    const fed: ArrayBuffer[] = [];
    const loader = makeLoader((b) => fed.push(b));
    await loader.loadPlaylist('https://example.com/vod/stream.m3u8');

    loader.start(() => true); // hold feed, fill look-ahead from index 0
    await waitFor(() => loader.getBufferedEnd() >= 15);

    tracker.fetched.length = 0; // forget the pre-seek downloads
    loader.seek(40); // segment index 20
    // seek() halts the loop; the player restarts the loader (stop()+start()).
    loader.stop();
    loader.start(() => true);

    // Buffer restarts at the seek point, then climbs again.
    await waitFor(() => loader.getBufferedEnd() > 40);

    // Everything fetched after the seek is at or past index 20 — the old raw
    // buffer was discarded, not replayed.
    expect(tracker.fetched.every((i) => i >= 20)).toBe(true);
    expect(loader.getBufferedEnd()).toBeGreaterThan(40);
    expect(loader.getBufferedEnd()).toBeLessThanOrEqual(40 + 15 + SEG_DURATION);

    loader.destroy();
  });

  it('reports getBufferedEnd as the downloaded media position', async () => {
    const loader = makeLoader(() => {});
    await loader.loadPlaylist('https://example.com/vod/stream.m3u8');
    expect(loader.getBufferedEnd()).toBe(0); // nothing downloaded yet

    loader.start(() => true);
    await waitFor(() => loader.getBufferedEnd() >= 15);
    // Always a whole number of 2s segments.
    expect(loader.getBufferedEnd() % SEG_DURATION).toBe(0);

    loader.destroy();
  });
});

describe('StreamLoader live streams are unaffected by the look-ahead', () => {
  let tracker: FetchTracker;

  beforeEach(() => {
    tracker = { playlistText: makePlaylist(true), fetched: [] };
    installFetchMock(tracker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('feeds live segments directly from the live edge without a raw look-ahead', async () => {
    const fed: ArrayBuffer[] = [];
    const loader = makeLoader((b) => fed.push(b));
    await loader.loadPlaylist('https://example.com/live/stream.m3u8');

    expect(loader.getDuration()).toBe(Infinity);

    loader.start(() => false);
    await waitFor(() => fed.length >= 1);
    // Give the loop ample time — a VOD look-ahead would race to fill ~15s here.
    await new Promise((r) => setTimeout(r, 300));

    // Live uses the legacy direct-feed loop: it starts at the live edge and never
    // pre-downloads a 15s cushion from the start of the playlist.
    expect(tracker.fetched.length).toBeGreaterThan(0);
    expect(tracker.fetched.every((i) => i >= SEG_COUNT - 2)).toBe(true);

    // No raw look-ahead cushion: live only pulls what it feeds at the edge
    // (2 segments behind the live edge), NOT ~8 segments (15s / 2s) like VOD.
    expect(tracker.fetched.length).toBeLessThanOrEqual(2);

    // getBufferedEnd tracks the fed cursor for live (no download-ahead window):
    // it never leads the fed media position by the RAW_LOOKAHEAD margin.
    const fedMediaEnd = fed.length * SEG_DURATION + (SEG_COUNT - 2) * SEG_DURATION;
    expect(loader.getBufferedEnd()).toBeLessThanOrEqual(fedMediaEnd);

    loader.destroy();
  });

  it('keeps the prefix-sum cache consistent as live segments are appended', async () => {
    // Build a live playlist (no ENDLIST) and grow it via a re-parse to drive the
    // parseM3U8 append branch — the path that must invalidate the cache.
    const buildLive = (count: number): string => {
      const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${SEG_DURATION}`];
      for (let i = 0; i < count; i++) {
        lines.push(`#EXTINF:${SEG_DURATION.toFixed(1)},`);
        lines.push(`segment_${i}.ts`);
      }
      return lines.join('\n'); // no ENDLIST → live
    };

    const loader = makeLoader(() => {});
    await loader.loadPlaylist('https://example.com/live/stream.m3u8'); // tracker is VOD; ignore
    // Seed the segment list directly via the parser (initial live manifest).
    (loader as any).segments = [];
    (loader as any).segmentUrls = new Set();
    (loader as any).parseM3U8(buildLive(SEG_COUNT), 'https://example.com/live/stream.m3u8');
    expect(loader.getDuration()).toBe(Infinity); // live
    // mediaBaseOf warms the prefix-sum cache.
    expect((loader as any).mediaBaseOf(SEG_COUNT)).toBe(SEG_COUNT * SEG_DURATION);

    // Append: re-parse a grown manifest. The cache must invalidate and rebuild.
    (loader as any).parseM3U8(buildLive(SEG_COUNT + 10), 'https://example.com/live/stream.m3u8');

    expect(loader.hasProgramDateTime()).toBe(false); // live never gains a timeline
    expect((loader as any).segments.length).toBe(SEG_COUNT + 10);
    // mediaBase reflects the appended segments (cache rebuilt cleanly, not stale).
    expect((loader as any).mediaBaseOf(SEG_COUNT + 10)).toBe((SEG_COUNT + 10) * SEG_DURATION);
    expect((loader as any).mediaBaseOf(SEG_COUNT)).toBe(SEG_COUNT * SEG_DURATION);

    loader.destroy();
  });

  it('throttles HLS live 404-resync rate using a sliding budget and exponential backoff', async () => {
    vi.useFakeTimers();
    
    let playlistFetchCount = 0;
    let segmentFetchCount = 0;
    
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('.m3u8')) {
        playlistFetchCount++;
        return { ok: true, text: async () => makePlaylist(true) } as unknown as Response;
      }
      segmentFetchCount++;
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found',
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const loader = makeLoader(() => {});
    await loader.loadPlaylist('https://example.com/live/stream.m3u8');
    
    playlistFetchCount = 0;
    segmentFetchCount = 0;

    loader.start(() => false);

    // Advance time to run several loops.
    // In degraded mode, the resync budget allows max 3 resyncs (playlist fetches).
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(30);
    }

    expect(playlistFetchCount).toBe(3);
    
    const playlistFetchCountBefore = playlistFetchCount;
    await vi.advanceTimersByTimeAsync(100);
    expect(playlistFetchCount).toBe(playlistFetchCountBefore);

    // Success recovery
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('.m3u8')) {
        // Return grown playlist (35 segments) so currentSegmentIndex (30) is in bounds
        const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${SEG_DURATION}`];
        for (let i = 0; i < 35; i++) {
          lines.push(`#EXTINF:${SEG_DURATION.toFixed(1)},`);
          lines.push(`segment_${i}.ts`);
        }
        return { ok: true, text: async () => lines.join('\n') } as unknown as Response;
      }
      return {
        ok: true,
        arrayBuffer: async () => makeTsSegment(),
      } as unknown as Response;
    });

    await vi.advanceTimersByTimeAsync(5000);
    
    expect((loader as any).isDegradedMode).toBe(false);
    expect((loader as any).resyncBackoffAttempts).toBe(0);

    loader.destroy();
    vi.useRealTimers();
  });
});

// ─── Archive VOD: PROGRAM-DATE-TIME wall-clock timeline ─────────────

const ARCHIVE_SEG_DURATION = 4;

/** A valid fMP4 payload begins (after the 4-byte size) with the 'ftyp' box type. */
function makeFmp4Segment(): ArrayBuffer {
  const u8 = new Uint8Array(16);
  // size (big-endian) then 'ftyp'
  u8[3] = 16;
  u8[4] = 0x66; u8[5] = 0x74; u8[6] = 0x79; u8[7] = 0x70; // ftyp
  return u8.buffer;
}

interface ArchiveBuilderOpts {
  /** Wall-clock epoch ms of the first segment's PROGRAM-DATE-TIME. */
  startMs: number;
  /** Number of segments before a recording gap (use full count for no gap). */
  preGapCount: number;
  totalCount: number;
  /** Gap length in ms inserted before the post-gap segment (0 = contiguous). */
  gapMs: number;
  /** Drop trailing fractional millis from RFC3339 to mimic backend output. */
  noMillis?: boolean;
}

/** Build an archive HLS-VOD playlist: VOD + per-segment PDT + one DISCONTINUITY. */
function makeArchivePlaylist(opts: ArchiveBuilderOpts): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-PLAYLIST-TYPE:VOD', `#EXT-X-TARGETDURATION:${ARCHIVE_SEG_DURATION}`];
  let wall = opts.startMs;
  for (let i = 0; i < opts.totalCount; i++) {
    if (i === opts.preGapCount && opts.gapMs > 0) {
      wall += opts.gapMs; // recording gap before this segment
      lines.push('#EXT-X-DISCONTINUITY');
    }
    const iso = opts.noMillis
      ? new Date(wall).toISOString().replace(/\.\d{3}Z$/, 'Z')
      : new Date(wall).toISOString();
    lines.push(`#EXT-X-PROGRAM-DATE-TIME:${iso}`);
    lines.push(`#EXTINF:${ARCHIVE_SEG_DURATION.toFixed(1)},`);
    lines.push(`export?start=${i}&duration=${ARCHIVE_SEG_DURATION}&format=fmp4`);
    wall += ARCHIVE_SEG_DURATION * 1000;
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n');
}

function installArchiveFetchMock(playlistText: string, fetchedExports: string[]) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes('.m3u8')) {
      return { ok: true, text: async () => playlistText } as unknown as Response;
    }
    fetchedExports.push(url);
    return { ok: true, arrayBuffer: async () => makeFmp4Segment() } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function makeArchiveLoader(onData: (buf: ArrayBuffer) => void, onMeta: (m: SegmentMeta) => void) {
  const deps: LoaderDeps = {
    onData: (buffer) => onData(buffer),
    onSegmentMeta: onMeta,
    onMockPacket: null,
    onError: null,
    logger: new Logger('test', 'silent'),
  };
  return new StreamLoader(deps);
}

describe('StreamLoader archive VOD (PROGRAM-DATE-TIME)', () => {
  const T0 = Date.UTC(2026, 5, 18, 12, 0, 0); // 2026-06-18T12:00:00Z

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('parses per-segment PDT and the DISCONTINUITY flag, with continuous media time', async () => {
    // 5 segments, gap of 60s before segment index 3.
    const playlist = makeArchivePlaylist({ startMs: T0, preGapCount: 3, totalCount: 5, gapMs: 60_000 });
    installArchiveFetchMock(playlist, []);

    const loader = makeArchiveLoader(() => {}, () => {});
    await loader.loadPlaylist('https://example.com/cameras/1/archive.m3u8');

    expect(loader.hasProgramDateTime()).toBe(true);
    // Media duration collapses the gap: 5 * 4s = 20s of media.
    expect(loader.getDuration()).toBe(5 * ARCHIVE_SEG_DURATION);

    const range = loader.getWallClockRange()!;
    expect(range).not.toBeNull();
    expect(range.startMs).toBe(T0);
    // Pre-gap: 3 segments * 4s; then +60s gap; then 2 segments * 4s.
    const expectedEnd = T0 + 3 * ARCHIVE_SEG_DURATION * 1000 + 60_000 + 2 * ARCHIVE_SEG_DURATION * 1000;
    expect(range.endMs).toBe(expectedEnd);
    // Exactly one recording gap, positioned at the discontinuity.
    expect(range.gaps.length).toBe(1);
    expect(range.gaps[0].startMs).toBe(T0 + 3 * ARCHIVE_SEG_DURATION * 1000);
    expect(range.gaps[0].endMs).toBe(T0 + 3 * ARCHIVE_SEG_DURATION * 1000 + 60_000);

    loader.destroy();
  });

  it('tolerates PROGRAM-DATE-TIME without trailing milliseconds', async () => {
    const playlist = makeArchivePlaylist({ startMs: T0, preGapCount: 4, totalCount: 4, gapMs: 0, noMillis: true });
    installArchiveFetchMock(playlist, []);

    const loader = makeArchiveLoader(() => {}, () => {});
    await loader.loadPlaylist('https://example.com/cameras/1/archive.m3u8');

    expect(loader.hasProgramDateTime()).toBe(true);
    expect(loader.getWallClockRange()!.startMs).toBe(T0);
    loader.destroy();
  });

  it('mediaToWall / wallToMedia are mutually inverse on the continuous (no-gap) timeline', async () => {
    const playlist = makeArchivePlaylist({ startMs: T0, preGapCount: 6, totalCount: 6, gapMs: 0 });
    installArchiveFetchMock(playlist, []);

    const loader = makeArchiveLoader(() => {}, () => {});
    await loader.loadPlaylist('https://example.com/cameras/1/archive.m3u8');

    // Monotonic: increasing media time → strictly increasing wall clock.
    let prevWall = -Infinity;
    for (let m = 0; m < 6 * ARCHIVE_SEG_DURATION; m += 1.5) {
      const wall = loader.mediaToWall(m)!;
      expect(wall).toBeGreaterThan(prevWall);
      prevWall = wall;
      // Round-trips back to the same media time within tolerance.
      const back = loader.wallToMedia(wall)!;
      expect(Math.abs(back - m)).toBeLessThan(0.001);
    }

    // Sanity: media 0 maps to the first PDT; media at the 2nd segment to PDT+4s.
    expect(loader.mediaToWall(0)).toBe(T0);
    expect(loader.mediaToWall(ARCHIVE_SEG_DURATION)).toBe(T0 + ARCHIVE_SEG_DURATION * 1000);

    loader.destroy();
  });

  it('snaps a wall-clock instant inside a gap forward to the post-gap segment mediaBase', async () => {
    // 4 segments, 60s gap before index 2. Pre-gap media: [0,8); post-gap media base: 8.
    const playlist = makeArchivePlaylist({ startMs: T0, preGapCount: 2, totalCount: 4, gapMs: 60_000 });
    installArchiveFetchMock(playlist, []);

    const loader = makeArchiveLoader(() => {}, () => {});
    await loader.loadPlaylist('https://example.com/cameras/1/archive.m3u8');

    const preGapMedia = 2 * ARCHIVE_SEG_DURATION; // 8s — base of the post-gap segment
    const postGapPDT = T0 + 2 * ARCHIVE_SEG_DURATION * 1000 + 60_000;

    // Instant 30s into the 60s gap → snaps forward to the post-gap mediaBase.
    const gapInstant = T0 + 2 * ARCHIVE_SEG_DURATION * 1000 + 30_000;
    expect(loader.wallToMedia(gapInstant)).toBe(preGapMedia);

    // mediaToWall across the boundary returns the post-gap segment's PDT.
    expect(loader.mediaToWall(preGapMedia)).toBe(postGapPDT);

    // Before the first segment clamps to media 0; after the end clamps to duration.
    expect(loader.wallToMedia(T0 - 10_000)).toBe(0);
    expect(loader.wallToMedia(postGapPDT + 999_999)).toBe(4 * ARCHIVE_SEG_DURATION);

    loader.destroy();
  });

  it('emits segment meta in order, just before each segment buffer, with growing mediaBase', async () => {
    const playlist = makeArchivePlaylist({ startMs: T0, preGapCount: 2, totalCount: 4, gapMs: 30_000 });
    const fetchedExports: string[] = [];
    installArchiveFetchMock(playlist, fetchedExports);

    // Record the interleaving of meta and data events to assert ordering.
    const events: Array<{ kind: 'meta'; meta: SegmentMeta } | { kind: 'data' }> = [];
    const loader = makeArchiveLoader(
      () => events.push({ kind: 'data' }),
      (meta) => events.push({ kind: 'meta', meta }),
    );
    await loader.loadPlaylist('https://example.com/cameras/1/archive.m3u8');

    loader.start(() => false); // no backpressure: drain all 4 segments
    await waitFor(() => events.filter((e) => e.kind === 'data').length >= 4);
    await new Promise((r) => setTimeout(r, 50));

    // Pairs: every data event is immediately preceded by a meta event.
    const metas: SegmentMeta[] = [];
    for (let i = 0; i < events.length; i++) {
      if (events[i].kind === 'data') {
        expect(events[i - 1]?.kind).toBe('meta');
        metas.push((events[i - 1] as { kind: 'meta'; meta: SegmentMeta }).meta);
      }
    }
    expect(metas.length).toBe(4);
    // mediaBase grows by the (collapsed) segment duration — monotonic, gap-free.
    expect(metas.map((m) => m.mediaBase)).toEqual([0, 4, 8, 12]);
    // Discontinuity flagged only on the post-gap segment (index 2).
    expect(metas.map((m) => m.discontinuity)).toEqual([false, false, true, false]);

    loader.destroy();
  });

  it('binary-searched wall-clock maps match a brute-force linear reference', async () => {
    // Irregular segment durations exercise the prefix-sum boundaries (a uniform
    // duration would hide off-by-one bugs in the binary search).
    const durations = [4, 4, 2.5, 6, 4, 3.25, 4, 4];
    const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-TARGETDURATION:6'];
    let wall = T0;
    for (let i = 0; i < durations.length; i++) {
      lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(wall).toISOString()}`);
      lines.push(`#EXTINF:${durations[i].toFixed(2)},`);
      lines.push(`export?start=${i}&format=fmp4`);
      wall += durations[i] * 1000;
    }
    lines.push('#EXT-X-ENDLIST');
    installArchiveFetchMock(lines.join('\n'), []);

    const loader = makeArchiveLoader(() => {}, () => {});
    await loader.loadPlaylist('https://example.com/cameras/1/archive.m3u8');

    // Linear reference for mediaToWall: identical to the pre-optimization code.
    const starts: number[] = [];
    let acc = 0;
    for (let i = 0; i < durations.length; i++) { starts.push(acc); acc += durations[i]; }
    const totalMedia = acc;
    const refWall = (media: number): number => {
      const clamped = Math.max(0, media);
      let idx = durations.length - 1;
      for (let i = 0; i < durations.length; i++) {
        if (clamped < starts[i] + durations[i]) { idx = i; break; }
      }
      const pdt = T0 + starts[idx] * 1000; // contiguous → PDT == base offset
      return pdt + (clamped - starts[idx]) * 1000;
    };

    // Sample densely, including exact segment boundaries and beyond-the-end.
    const samples: number[] = [];
    for (let m = -1; m <= totalMedia + 2; m += 0.5) samples.push(m);
    for (const s of starts) { samples.push(s); samples.push(s - 1e-9); samples.push(s + 1e-9); }

    for (const m of samples) {
      const got = loader.mediaToWall(m)!;
      expect(got).toBeCloseTo(refWall(m), 6);
    }

    loader.destroy();
  });

  it('rebuilds the prefix-sum cache on a repeated loadPlaylist (no stale state)', async () => {
    // First archive: 4 segments @ 4s starting at T0.
    installArchiveFetchMock(
      makeArchivePlaylist({ startMs: T0, preGapCount: 4, totalCount: 4, gapMs: 0 }),
      [],
    );
    const loader = makeArchiveLoader(() => {}, () => {});
    await loader.loadPlaylist('https://example.com/cameras/1/archive.m3u8');
    // Warm the cache.
    expect(loader.getDuration()).toBe(4 * ARCHIVE_SEG_DURATION);
    expect(loader.mediaToWall(0)).toBe(T0);

    // Second archive: different start (T0 + 1h) and more segments. A stale cache
    // would carry over the first playlist's prefix-sum / PDT base.
    const T1 = T0 + 3_600_000;
    installArchiveFetchMock(
      makeArchivePlaylist({ startMs: T1, preGapCount: 7, totalCount: 7, gapMs: 0 }),
      [],
    );
    await loader.loadPlaylist('https://example.com/cameras/2/archive.m3u8');

    expect(loader.getDuration()).toBe(7 * ARCHIVE_SEG_DURATION);
    expect(loader.mediaToWall(0)).toBe(T1);
    // mediaBase of the last segment must reflect the NEW playlist.
    expect(loader.mediaToWall(6 * ARCHIVE_SEG_DURATION)).toBe(T1 + 6 * ARCHIVE_SEG_DURATION * 1000);
    expect(loader.wallToMedia(T1 + 6 * ARCHIVE_SEG_DURATION * 1000)).toBeCloseTo(6 * ARCHIVE_SEG_DURATION, 6);

    loader.destroy();
  });

  it('does NOT emit meta or expose a wall-clock timeline for plain VOD (no PDT)', async () => {
    installFetchMock({ playlistText: makePlaylist(false), fetched: [] });
    let metaCount = 0;
    const loader = makeArchiveLoader(() => {}, () => { metaCount++; });
    await loader.loadPlaylist('https://example.com/vod/stream.m3u8');
    expect(loader.hasProgramDateTime()).toBe(false);
    expect(loader.mediaToWall(5)).toBeNull();
    expect(loader.wallToMedia(Date.now())).toBeNull();
    expect(loader.getWallClockRange()).toBeNull();

    loader.start(() => false);
    await waitFor(() => loader.getBufferedEnd() > 0);
    await new Promise((r) => setTimeout(r, 50));
    expect(metaCount).toBe(0); // plain VOD never emits segment meta

    loader.destroy();
  });

  it('parses master playlist with multiple variants and populates QualityLevels', async () => {
    const masterPlaylist = `
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.42e00a,mp4a.40.2"
low/stream.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
high/stream.m3u8
    `.trim();

    const mediaPlaylist = `
#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6.0,
segment_0.ts
#EXT-X-ENDLIST
    `.trim();

    const fetches: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((url: any) => {
      fetches.push(url);
      if (url === 'https://example.com/stream.m3u8') {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(masterPlaylist)
        } as any);
      }
      if (url === 'https://example.com/low/stream.m3u8') {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(mediaPlaylist)
        } as any);
      }
      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });

    const loader = makeLoader(() => {});
    await loader.load('https://example.com/stream.m3u8');

    expect(fetches).toContain('https://example.com/stream.m3u8');
    expect(fetches).toContain('https://example.com/low/stream.m3u8');

    const levels = loader.getLevels();
    expect(levels.length).toBe(2);

    expect(levels[0].label).toBe('720p');
    expect(levels[0].kind).toBe('main');
    expect(levels[0].url).toBe('https://example.com/high/stream.m3u8');

    expect(levels[1].label).toBe('360p');
    expect(levels[1].kind).toBe('sub');
    expect(levels[1].url).toBe('https://example.com/low/stream.m3u8');

    expect(loader.getActiveId()).toBe('https://example.com/low/stream.m3u8');

    loader.destroy();
    vi.restoreAllMocks();
  });

  it('switches quality levels and reloads media playlist accordingly', async () => {
    const masterPlaylist = `
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
low/stream.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720
high/stream.m3u8
    `.trim();

    const mediaHigh = `
#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6.0,
high_0.ts
#EXTINF:6.0,
high_1.ts
#EXT-X-ENDLIST
    `.trim();

    const mediaLow = `
#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6.0,
low_0.ts
#EXTINF:6.0,
low_1.ts
#EXT-X-ENDLIST
    `.trim();

    const fetches: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((url: any) => {
      fetches.push(url);
      if (url === 'https://example.com/stream.m3u8') {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(masterPlaylist)
        } as any);
      }
      if (url === 'https://example.com/high/stream.m3u8') {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(mediaHigh)
        } as any);
      }
      if (url === 'https://example.com/low/stream.m3u8') {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(mediaLow)
        } as any);
      }
      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });

    const loader = makeLoader(() => {});
    await loader.load('https://example.com/stream.m3u8');

    expect(loader.getActiveId()).toBe('https://example.com/low/stream.m3u8');
    
    fetches.length = 0;
    await loader.quality!.switchQuality('https://example.com/high/stream.m3u8');

    expect(loader.getActiveId()).toBe('https://example.com/high/stream.m3u8');
    expect(fetches).toContain('https://example.com/high/stream.m3u8');

    loader.destroy();
    vi.restoreAllMocks();
  });
});

// ─── switchQuality re-entrancy guard ─────────────────────────────────

describe('StreamLoader switchQuality re-entrancy', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /**
   * Master + two media playlists, mirroring the fixtures used by the existing
   * "switches quality levels" test. The `high` media-playlist fetch is
   * deferred so a test can hold the first switchQuality() call mid-`await`
   * and fire a second, overlapping call while it is still in flight.
   */
  function installQualitySwitchFetchMock(fetches: string[]) {
    const mediaHigh = `
#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6.0,
high_0.ts
#EXTINF:6.0,
high_1.ts
#EXT-X-ENDLIST
    `.trim();

    const mediaLow = `
#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6.0,
low_0.ts
#EXTINF:6.0,
low_1.ts
#EXT-X-ENDLIST
    `.trim();

    const mediaSub = `
#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6.0,
sub_0.ts
#EXTINF:6.0,
sub_1.ts
#EXT-X-ENDLIST
    `.trim();

    const masterPlaylist = `
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=320x240
sub/stream.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
low/stream.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720
high/stream.m3u8
    `.trim();

    // Resolved so the second (`high`) fetch only settles once explicitly released,
    // guaranteeing the first switchQuality() call is still mid-`loadPlaylist` when
    // the second, overlapping call is issued.
    let releaseHigh: (() => void) | null = null;
    const highGate = new Promise<void>((resolve) => { releaseHigh = resolve; });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      fetches.push(url);
      if (url === 'https://example.com/stream.m3u8') {
        return { ok: true, status: 200, text: () => Promise.resolve(masterPlaylist) } as any;
      }
      if (url === 'https://example.com/high/stream.m3u8') {
        await highGate; // held open until the test calls releaseHigh()
        return { ok: true, status: 200, text: () => Promise.resolve(mediaHigh) } as any;
      }
      if (url === 'https://example.com/low/stream.m3u8') {
        return { ok: true, status: 200, text: () => Promise.resolve(mediaLow) } as any;
      }
      if (url === 'https://example.com/sub/stream.m3u8') {
        return { ok: true, status: 200, text: () => Promise.resolve(mediaSub) } as any;
      }
      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });

    return { releaseHigh: () => releaseHigh!() };
  }

  it('drops a concurrent switchQuality() call and leaves activeQualityId/segments consistent', async () => {
    const fetches: string[] = [];
    const { releaseHigh } = installQualitySwitchFetchMock(fetches);

    const loader = makeLoader(() => {});
    await loader.load('https://example.com/stream.m3u8');
    // Master playlist sorts by bitrate desc; active defaults to the first (lowest
    // bitrate is last after sort) — pin the starting point explicitly instead of
    // relying on the default.
    await loader.quality!.switchQuality('https://example.com/sub/stream.m3u8');
    expect(loader.getActiveId()).toBe('https://example.com/sub/stream.m3u8');

    fetches.length = 0;

    // Fire the manual switch to "high" — its media-playlist fetch is gated and
    // won't resolve until releaseHigh() is called below, so this call is
    // guaranteed to still be inside loadPlaylist() when the second call fires.
    const firstSwitch = loader.quality!.switchQuality('https://example.com/high/stream.m3u8');

    // Give the first call's microtasks a beat to reach the gated fetch.
    await waitFor(() => fetches.includes('https://example.com/high/stream.m3u8'));

    // Overlapping ABR-style switch to "low" while the first call is mid-flight.
    // Must be dropped by the re-entrancy guard, not interleaved.
    const secondSwitch = loader.quality!.switchQuality('https://example.com/low/stream.m3u8');

    // The dropped call resolves immediately (early return) — await it now so it
    // can't race the first call's completion below.
    await secondSwitch;
    // The "low" playlist must never have been fetched: the concurrent call was
    // dropped before it could mutate any shared state.
    expect(fetches).not.toContain('https://example.com/low/stream.m3u8');
    // activeQualityId must not have been clobbered by the dropped call while the
    // first switch was still in flight.
    expect(loader.getActiveId()).toBe('https://example.com/high/stream.m3u8');

    // Now let the first (in-flight) switch complete.
    releaseHigh();
    await firstSwitch;

    // Final state matches the call that actually completed ("high"), and the
    // segment list reflects ONLY the high playlist (no corruption/mixing).
    expect(loader.getActiveId()).toBe('https://example.com/high/stream.m3u8');
    const segments = (loader as any).segments as { url: string }[];
    expect(segments.map((s) => s.url)).toEqual([
      'https://example.com/high/high_0.ts',
      'https://example.com/high/high_1.ts',
    ]);
    expect((loader as any).isSwitching).toBe(false);

    loader.destroy();
  });

  it('clears the isSwitching guard even if loadPlaylist rejects, so a later switch can proceed', async () => {
    const fetches: string[] = [];
    const masterPlaylist = `
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
low/stream.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720
high/stream.m3u8
    `.trim();
    const mediaLow = `
#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6.0,
low_0.ts
#EXT-X-ENDLIST
    `.trim();

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      fetches.push(url);
      if (url === 'https://example.com/stream.m3u8') {
        return { ok: true, status: 200, text: () => Promise.resolve(masterPlaylist) } as any;
      }
      if (url === 'https://example.com/low/stream.m3u8') {
        return { ok: true, status: 200, text: () => Promise.resolve(mediaLow) } as any;
      }
      if (url === 'https://example.com/high/stream.m3u8') {
        return { ok: false, status: 500 } as any; // loadPlaylist throws on this
      }
      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });

    const loader = makeLoader(() => {});
    await loader.load('https://example.com/stream.m3u8');
    expect(loader.getActiveId()).toBe('https://example.com/low/stream.m3u8');

    await expect(loader.quality!.switchQuality('https://example.com/high/stream.m3u8')).rejects.toThrow();

    // The guard must clear in the `finally` branch even though loadPlaylist threw.
    expect((loader as any).isSwitching).toBe(false);

    // A subsequent switch must not be dropped by a stuck guard.
    fetches.length = 0;
    await loader.quality!.switchQuality('https://example.com/low/stream.m3u8');
    expect(fetches).toContain('https://example.com/low/stream.m3u8');

    loader.destroy();
    vi.restoreAllMocks();
  });
});

// ─── Playlist URL resolution (segments, variants, EXT-X-MAP) ────────

describe('StreamLoader playlist URL resolution', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('resolves relative, root-absolute, and absolute segment URLs against the playlist base', async () => {
    const playlist = `
#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6.0,
relative_0.ts
#EXTINF:6.0,
/root/absolute_1.ts
#EXTINF:6.0,
https://cdn.example.com/abs/absolute_2.ts
#EXT-X-ENDLIST
    `.trim();

    vi.spyOn(globalThis, 'fetch').mockImplementation((url: any) => {
      if (url === 'https://example.com/streams/nested/stream.m3u8') {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(playlist) } as any);
      }
      return Promise.resolve({ ok: true, arrayBuffer: async () => makeTsSegment() } as any);
    });

    const loader = makeLoader(() => {});
    await loader.loadPlaylist('https://example.com/streams/nested/stream.m3u8');

    const segments = (loader as any).segments as { url: string }[];
    expect(segments.map((s) => s.url)).toEqual([
      // Relative → resolved against the playlist's directory.
      'https://example.com/streams/nested/relative_0.ts',
      // Root-absolute → resolved against the playlist's origin, NOT concatenated
      // onto the directory (naive `baseUrl + '/root/...'` would have produced
      // 'https://example.com/streams/nested//root/absolute_1.ts').
      'https://example.com/root/absolute_1.ts',
      // Already absolute → passed through (different origin allowed; scheme is
      // still https).
      'https://cdn.example.com/abs/absolute_2.ts',
    ]);

    loader.destroy();
  });

  it('rejects a segment URI with a javascript: or file: scheme and skips that entry', async () => {
    const playlist = `
#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6.0,
good_0.ts
#EXTINF:6.0,
javascript:alert(1)
#EXTINF:6.0,
file:///etc/passwd
#EXTINF:6.0,
good_1.ts
#EXT-X-ENDLIST
    `.trim();

    vi.spyOn(globalThis, 'fetch').mockImplementation((url: any) => {
      if (url === 'https://example.com/streams/stream.m3u8') {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(playlist) } as any);
      }
      return Promise.resolve({ ok: true, arrayBuffer: async () => makeTsSegment() } as any);
    });

    const loader = makeLoader(() => {});
    await loader.loadPlaylist('https://example.com/streams/stream.m3u8');

    // The malicious/invalid-scheme entries are dropped entirely — only the two
    // legitimate http(s) segments remain in the queue.
    const segments = (loader as any).segments as { url: string }[];
    expect(segments.map((s) => s.url)).toEqual([
      'https://example.com/streams/good_0.ts',
      'https://example.com/streams/good_1.ts',
    ]);

    loader.destroy();
  });

  it('rejects a master-playlist variant with a disallowed scheme and keeps only valid levels', async () => {
    const masterPlaylist = `
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
low/stream.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=960x540
file:///etc/variant.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720
high/stream.m3u8
    `.trim();

    const mediaLow = `
#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6.0,
low_0.ts
#EXT-X-ENDLIST
    `.trim();

    const fetches: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((url: any) => {
      fetches.push(url);
      if (url === 'https://example.com/stream.m3u8') {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(masterPlaylist) } as any);
      }
      if (url === 'https://example.com/low/stream.m3u8') {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(mediaLow) } as any);
      }
      return Promise.reject(new Error(`Unexpected fetch URL (should not resolve the file: variant): ${url}`));
    });

    const loader = makeLoader(() => {});
    await loader.load('https://example.com/stream.m3u8');

    // Only the two http(s) variants were parsed; the file: variant never
    // reached getLevels() and was never fetched.
    const levels = loader.getLevels();
    expect(levels.map((l) => l.url)).toEqual([
      'https://example.com/high/stream.m3u8', // sorted by bitrate desc
      'https://example.com/low/stream.m3u8',
    ]);
    expect(fetches.some((u) => u.includes('etc/variant'))).toBe(false);

    loader.destroy();
  });

  it('resolves an EXT-X-MAP init segment URI and rejects a disallowed scheme', async () => {
    const goodMapPlaylist = `
#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MAP:URI="init/segment.mp4"
#EXTINF:6.0,
seg_0.m4s
#EXT-X-ENDLIST
    `.trim();

    vi.spyOn(globalThis, 'fetch').mockImplementation((url: any) => {
      if (url === 'https://example.com/streams/stream.m3u8') {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(goodMapPlaylist) } as any);
      }
      return Promise.resolve({ ok: true, arrayBuffer: async () => makeTsSegment() } as any);
    });

    const loader = makeLoader(() => {});
    await loader.loadPlaylist('https://example.com/streams/stream.m3u8');
    expect((loader as any).initSegmentUrl).toBe('https://example.com/streams/init/segment.mp4');
    loader.destroy();
    vi.restoreAllMocks();

    // Disallowed-scheme EXT-X-MAP URI: resolved to '', so loadPlaylist's
    // `if (this.initSegmentUrl)` guard skips fetching it entirely.
    const badMapPlaylist = `
#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MAP:URI="javascript:alert(1)"
#EXTINF:6.0,
seg_0.m4s
#EXT-X-ENDLIST
    `.trim();

    const fetches: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((url: any) => {
      fetches.push(url);
      if (url === 'https://example.com/streams/bad.m3u8') {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(badMapPlaylist) } as any);
      }
      return Promise.resolve({ ok: true, arrayBuffer: async () => makeTsSegment() } as any);
    });

    const loader2 = makeLoader(() => {});
    await loader2.loadPlaylist('https://example.com/streams/bad.m3u8');
    expect((loader2 as any).initSegmentUrl).toBe('');
    expect(fetches.some((u) => u.startsWith('javascript:'))).toBe(false);

    loader2.destroy();
  });

  it('leaves mock:// playlist URL handling untouched by the http(s) URL hardening', async () => {
    const loader = makeLoader(() => {});
    await loader.loadPlaylist('mock://camera-1');

    const segments = (loader as any).segments as { url: string }[];
    expect(segments.length).toBe(20); // generateMockPlaylist's fixed mock segment count
    expect(segments.every((s) => s.url.startsWith('mock://camera-1/segment_'))).toBe(true);

    loader.destroy();
  });
});

describe('StreamLoader EWMA throughput', () => {
  it('initializes throughput with the first sample', () => {
    const loader = makeLoader(() => {});
    // Access private method via cast
    const sl = loader as any;
    expect(sl.getThroughput().throughputKbps).toBe(0);
    expect(sl.getThroughput().throughputSamples).toBe(0);

    // 1MB in 100ms → (1_000_000 * 8) / 100 = 80000 Kbps
    sl.recordThroughputSample(1_000_000, 100);
    const tp = sl.getThroughput();
    expect(tp.throughputSamples).toBe(1);
    expect(tp.throughputKbps).toBeGreaterThan(70000);

    loader.destroy();
  });

  it('applies EWMA smoothing on subsequent samples', () => {
    const loader = makeLoader(() => {});
    const sl = loader as any;

    // First sample: 100KB in 100ms → (100000 * 8) / 100 = 8000 Kbps
    sl.recordThroughputSample(100000, 100);
    const first = sl.smoothedThroughputKbps;

    // Second sample: much lower: 10KB in 100ms → ≈ 781.25 Kbps
    sl.recordThroughputSample(10000, 100);
    const second = sl.smoothedThroughputKbps;

    // EWMA should dampen the drop — second should be between first and 781
    expect(second).toBeLessThan(first);
    expect(second).toBeGreaterThan(781);

    // Third sample: same low value → should decrease further
    sl.recordThroughputSample(10000, 100);
    const third = sl.smoothedThroughputKbps;
    expect(third).toBeLessThan(second);

    expect(sl.getThroughput().throughputSamples).toBe(3);
    loader.destroy();
  });

  it('clamps zero-duration to 1ms minimum', () => {
    const loader = makeLoader(() => {});
    const sl = loader as any;

    // Zero duration should not throw or produce Infinity
    sl.recordThroughputSample(1000, 0);
    const tp = sl.getThroughput();
    expect(Number.isFinite(tp.throughputKbps)).toBe(true);
    expect(tp.throughputKbps).toBeGreaterThan(0);

    loader.destroy();
  });
});
