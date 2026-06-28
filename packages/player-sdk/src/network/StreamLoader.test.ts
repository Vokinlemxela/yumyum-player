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
    expect(tracker.fetched.every((i) => i >= SEG_COUNT - 3)).toBe(true);

    // No raw look-ahead cushion: live only pulls what it feeds at the edge
    // (3 segments behind the live edge), NOT ~8 segments (15s / 2s) like VOD.
    expect(tracker.fetched.length).toBeLessThanOrEqual(3);

    // getBufferedEnd tracks the fed cursor for live (no download-ahead window):
    // it never leads the fed media position by the RAW_LOOKAHEAD margin.
    const fedMediaEnd = fed.length * SEG_DURATION + (SEG_COUNT - 3) * SEG_DURATION;
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
});
