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

/**
 * Minimal mock of the WebCodecs `AudioDecoder` used to drive AACDecoder's real
 * (non-fallback) path. Each `new AudioDecoder(...)` call is recorded in
 * `MockAudioDecoder.instances` in creation order, so a test can grab a
 * specific instance (e.g. the first one, "D1") and manually invoke its
 * captured `output`/`error` callbacks — simulating the browser delivering a
 * late/queued callback for a decoder that AACDecoder has since replaced.
 */
class MockAudioDecoder {
  static instances: MockAudioDecoder[] = [];
  static isConfigSupportedResult: AudioDecoderSupport = { supported: true, config: {} as AudioDecoderConfig };
  static isConfigSupported(_config: AudioDecoderConfig): Promise<AudioDecoderSupport> {
    return Promise.resolve(MockAudioDecoder.isConfigSupportedResult);
  }

  public state: 'unconfigured' | 'configured' | 'closed' = 'unconfigured';
  public closeCallCount = 0;
  public configureCalls: AudioDecoderConfig[] = [];
  public decodeCalls: EncodedAudioChunk[] = [];
  private readonly outputCb: (data: AudioData) => void;
  private readonly errorCb: (e: Error) => void;

  constructor(init: { output: (data: AudioData) => void; error: (e: Error) => void }) {
    this.outputCb = init.output;
    this.errorCb = init.error;
    MockAudioDecoder.instances.push(this);
  }

  configure(config: AudioDecoderConfig) {
    this.configureCalls.push(config);
    this.state = 'configured';
  }

  decode(chunk: EncodedAudioChunk) {
    this.decodeCalls.push(chunk);
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  close() {
    this.closeCallCount++;
    this.state = 'closed';
  }

  /** Invoke this instance's captured `error` callback, as the browser would. */
  triggerError(e: Error) {
    this.errorCb(e);
  }

  /** Invoke this instance's captured `output` callback, as the browser would. */
  triggerOutput(data: AudioData) {
    this.outputCb(data);
  }
}

/** Minimal fake AudioData sufficient to exercise the output callback's close(). */
function makeFakeAudioData(): AudioData & { closeCallCount: number } {
  let closeCallCount = 0;
  return {
    numberOfFrames: 1,
    numberOfChannels: 1,
    format: 'f32-planar',
    sampleRate: 44100,
    timestamp: 0,
    copyTo: () => {},
    close: () => { closeCallCount++; },
    get closeCallCount() { return closeCallCount; },
  } as unknown as AudioData & { closeCallCount: number };
}

describe('AACDecoder stale-callback guard (RES-H4)', () => {
  // Drive AACDecoder's real AudioDecoder path (not the Web Audio fallback) via
  // MockAudioDecoder, so handleFallback()'s decoder-swap can be exercised.
  let savedAudioDecoder: unknown;
  beforeEach(() => {
    savedAudioDecoder = (globalThis as Record<string, unknown>).AudioDecoder;
    MockAudioDecoder.instances = [];
    MockAudioDecoder.isConfigSupportedResult = { supported: true, config: {} as AudioDecoderConfig };
    (globalThis as Record<string, unknown>).AudioDecoder = MockAudioDecoder;
  });
  afterEach(() => {
    (globalThis as Record<string, unknown>).AudioDecoder = savedAudioDecoder;
  });

  const cfg = { objectType: 2, sampleRateIndex: 4, sampleRate: 44100, channels: 2 };
  const frame = (fill: number) => buildAdtsFrame(cfg, new Uint8Array(13).fill(fill));

  // Allow pending microtasks (the `await AudioDecoder.isConfigSupported(...)`
  // inside configureAudioDecoder) to settle before assertions.
  const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('ignores a stale error callback from a decoder already replaced by handleFallback()', async () => {
    const dec = new AACDecoder(() => {}, undefined, silent());

    // First packet triggers async configuration (raw mode by default) and is
    // queued in pendingPackets until it resolves.
    dec.decode(frame(1), 1000, true);
    await flushMicrotasks();

    expect(MockAudioDecoder.instances).toHaveLength(1);
    const d1 = MockAudioDecoder.instances[0];
    expect(d1.state).toBe('configured');

    // Simulate the first of two queued decode errors arriving from D1: this
    // runs handleFallback(), which closes D1 and (since raw mode hasn't
    // failed-over to ADTS yet) synchronously kicks off reconfiguration in
    // ADTS mode.
    d1.triggerError(new Error('mock decode error #1'));
    await flushMicrotasks();

    expect(d1.closeCallCount).toBe(1);
    expect(MockAudioDecoder.instances).toHaveLength(2);
    const d2 = MockAudioDecoder.instances[1];
    expect(d2.state).toBe('configured');

    // Now simulate the SECOND queued error callback arriving late from the
    // now-closed D1 (this is the RES-H4 race: two `error` events queued from
    // D1 in quick succession, the second delivered after handleFallback()
    // already swapped in D2). Before the fix this would call handleFallback()
    // again and tear down the healthy D2.
    d1.triggerError(new Error('mock decode error #2 (stale)'));
    await flushMicrotasks();

    // D2 must be untouched: not closed, and no third decoder was created.
    expect(d2.closeCallCount).toBe(0);
    expect(MockAudioDecoder.instances).toHaveLength(2);
  });

  it('closes AudioData but takes no other action on a stale output callback', async () => {
    const pcmCalls: number[] = [];
    const dec = new AACDecoder((left) => { pcmCalls.push(left.length); }, undefined, silent());

    dec.decode(frame(1), 1000, true);
    await flushMicrotasks();

    const d1 = MockAudioDecoder.instances[0];

    // Force the D1 -> D2 swap via the same error path as above.
    d1.triggerError(new Error('mock decode error'));
    await flushMicrotasks();

    expect(MockAudioDecoder.instances).toHaveLength(2);
    const d2 = MockAudioDecoder.instances[1];

    // A stale `output` callback firing late from the replaced D1 must not
    // reach onPCM, and must still close() the AudioData (WebCodecs requires
    // every AudioData to be closed or it leaks).
    const staleAudioData = makeFakeAudioData();
    d1.triggerOutput(staleAudioData);

    expect(pcmCalls).toHaveLength(0);
    expect(staleAudioData.closeCallCount).toBe(1);
    // D2 remains untouched by the stale output callback.
    expect(d2.closeCallCount).toBe(0);
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
