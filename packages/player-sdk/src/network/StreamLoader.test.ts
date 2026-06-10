import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StreamLoader } from './StreamLoader.js';
import { LoaderDeps } from './IStreamLoader.js';
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
    expect(tracker.fetched.every((i) => i >= SEG_COUNT - 2)).toBe(true);

    // No raw look-ahead cushion: live only pulls what it feeds at the edge
    // (2 segments behind the live edge), NOT ~8 segments (15s / 2s) like VOD.
    expect(tracker.fetched.length).toBeLessThanOrEqual(3);

    // getBufferedEnd tracks the fed cursor for live (no download-ahead window):
    // it never leads the fed media position by the RAW_LOOKAHEAD margin.
    const fedMediaEnd = fed.length * SEG_DURATION + (SEG_COUNT - 2) * SEG_DURATION;
    expect(loader.getBufferedEnd()).toBeLessThanOrEqual(fedMediaEnd);

    loader.destroy();
  });
});
