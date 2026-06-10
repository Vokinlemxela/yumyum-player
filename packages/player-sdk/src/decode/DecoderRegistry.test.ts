import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HEVCDecoder, DecoderRegistry, IBaseDecoder, AACDecoder, deinterleaveChannels } from './DecoderRegistry.js';
import { buildAdtsFrame } from '../demux/parsers.js';
import { Logger } from '../utils/Logger.js';

// Note: under Node/Vitest there is no global `VideoDecoder`, so HEVCDecoder
// always resolves into software-fallback mode — exactly the path Pro plugins
// (e.g. @yumyum-player/hevc-wasm) target.

class FakeDecoder implements IBaseDecoder {
  public calls: Array<{ packet: Uint8Array; ts: number; key: boolean }> = [];
  public flushed = false;
  public destroyed = false;
  decode(packet: Uint8Array, ts: number, key: boolean): void {
    this.calls.push({ packet, ts, key });
  }
  flush(): void { this.flushed = true; }
  destroy(): void { this.destroyed = true; }
}

const silent = () => new Logger('test', 'silent');

describe('HEVCDecoder software fallback', () => {
  it('delegates decoding to a registered h265-sw fallback when native HEVC is unavailable', async () => {
    const fake = new FakeDecoder();
    const dec = new HEVCDecoder(() => {}, () => {}, silent(), () => fake);
    await dec.ready;

    expect(dec.isSoftwareFallback()).toBe(true);

    const pkt = new Uint8Array([0, 0, 1, 0x26, 0xab]); // non-mock HEVC NAL
    dec.decode(pkt, 1_000_000, true);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].key).toBe(true);
    expect(fake.calls[0].ts).toBe(1_000_000);
  });

  it('forwards flush to the fallback decoder', async () => {
    const fake = new FakeDecoder();
    const dec = new HEVCDecoder(() => {}, () => {}, silent(), () => fake);
    await dec.ready;
    dec.flush();
    expect(fake.flushed).toBe(true);
  });

  it('emits an error on first frame when no fallback is registered', async () => {
    let err: Error | null = null;
    const dec = new HEVCDecoder(() => {}, (e) => { err = e; }, silent());
    await dec.ready;
    expect(err).toBeNull(); // no preemptive error before any frame
    dec.decode(new Uint8Array([0, 0, 1, 0x26]), 0, true);
    expect(err).toBeInstanceOf(Error);
  });

  it('resolves the fallback lazily from the registry (plugin registered after construction)', async () => {
    const registry = new DecoderRegistry(() => {}, silent());
    const fake = new FakeDecoder();
    // HEVCDecoder is created BEFORE the plugin registers its decoder, mirroring
    // the player constructor order; the getFallback closure resolves lazily.
    const hevc = new HEVCDecoder(() => {}, () => {}, silent(), () => registry.get('h265-sw'));
    registry.register('h265-sw', fake);
    await hevc.ready;

    hevc.decode(new Uint8Array([0, 0, 1, 0x26]), 0, true);
    expect(fake.calls).toHaveLength(1);
  });
});

describe('deinterleaveChannels', () => {
  it('splits an interleaved stereo buffer into left/right planes', () => {
    // [L0, R0, L1, R1, L2, R2]
    const interleaved = new Float32Array([1, -1, 2, -2, 3, -3]);
    const { left, right } = deinterleaveChannels(interleaved, 3, 2);
    expect(Array.from(left)).toEqual([1, 2, 3]);
    expect(Array.from(right!)).toEqual([-1, -2, -3]);
  });

  it('returns no right plane for mono', () => {
    const interleaved = new Float32Array([1, 2, 3, 4]);
    const { left, right } = deinterleaveChannels(interleaved, 4, 1);
    expect(Array.from(left)).toEqual([1, 2, 3, 4]);
    expect(right).toBeUndefined();
  });
});

describe('AACDecoder Web Audio fallback', () => {
  // Force the "no native AudioDecoder" path (e.g. Yandex / Chromium without
  // proprietary codecs), so audio routes through the decodeAudioData fallback.
  let savedAudioDecoder: unknown;
  beforeEach(() => {
    savedAudioDecoder = (globalThis as Record<string, unknown>).AudioDecoder;
    (globalThis as Record<string, unknown>).AudioDecoder = undefined;
  });
  afterEach(() => {
    (globalThis as Record<string, unknown>).AudioDecoder = savedAudioDecoder;
  });

  const cfg = { objectType: 2, sampleRateIndex: 4, sampleRate: 44100, channels: 2 };
  const frame = (fill: number) => buildAdtsFrame(cfg, new Uint8Array(13).fill(fill));

  it('batches ~20 ADTS packets into one decodeAudioData chunk with the batch-start PTS', () => {
    const chunks: Array<{ bytes: number; pts: number }> = [];
    const dec = new AACDecoder(
      () => {},
      (buf, pts) => chunks.push({ bytes: buf.byteLength, pts }),
      silent()
    );

    // Packet #1 triggers (failed) configuration and is held in pendingPackets;
    // packets #2..#21 accumulate in the fallback and flush at 20.
    for (let i = 1; i <= 21; i++) {
      dec.decode(frame(i & 0xff), i * 1000, true);
    }

    expect(chunks).toHaveLength(1);
    // 20 frames of (13 payload + 7 ADTS header) bytes each.
    expect(chunks[0].bytes).toBe(20 * 20);
    // Batch-start PTS is the first *fallback* packet (#2) at 2000µs → 0.002s.
    expect(chunks[0].pts).toBeCloseTo(0.002, 6);
  });

  it('does not emit a partial batch below the threshold', () => {
    const chunks: unknown[] = [];
    const dec = new AACDecoder(() => {}, () => chunks.push(1), silent());
    for (let i = 1; i <= 10; i++) {
      dec.decode(frame(i), i * 1000, true);
    }
    expect(chunks).toHaveLength(0);
  });
});
