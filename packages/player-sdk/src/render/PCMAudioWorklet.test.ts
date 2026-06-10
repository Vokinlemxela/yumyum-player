import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PCMAudioWorklet } from './PCMAudioWorklet.js';
import { Logger } from '../utils/Logger.js';

// The Web Audio fallback path (browsers without WebCodecs AAC, e.g. Yandex)
// decodes ADTS batches with `decodeAudioData` and feeds the PCM into the
// worklet. Those decodes run concurrently for throughput, so they can resolve
// out of order — but the PCM MUST still reach the worklet in arrival order or
// the PTS markers scramble and the clock jumps. These tests pin that contract.

const silent = () => new Logger('test', 'silent');

interface Deferred {
  resolve: (buf: unknown) => void;
  reject: (err: unknown) => void;
}

class MockPort {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  posted: Array<{ type: string; pts?: number }> = [];
  postMessage(msg: { type: string; pts?: number }) {
    this.posted.push(msg);
  }
}

class MockWorkletNode {
  port = new MockPort();
  connect() {}
  disconnect() {}
}

// Every started decode parks its resolver here so the test can resolve them in
// any order it likes, simulating out-of-order completion.
let pendingDecodes: Deferred[] = [];

class MockAudioContext {
  state = 'running';
  sampleRate = 44100;
  baseLatency = 0;
  currentTime = 0;
  destination = {};
  audioWorklet = { addModule: async () => {} };
  decodeAudioData(): Promise<unknown> {
    return new Promise((resolve, reject) => {
      pendingDecodes.push({ resolve, reject });
    });
  }
  createGain() {
    return { gain: { setValueAtTime() {} }, connect() {}, disconnect() {} };
  }
  resume() { return Promise.resolve(); }
  suspend() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}

// A decoded buffer whose single channel is tagged so feeds are distinguishable;
// sampleRate matches the context so feedPCM skips resampling.
const mockAudioBuffer = () => ({
  numberOfChannels: 1,
  sampleRate: 44100,
  getChannelData: () => new Float32Array([0.1, 0.2]),
});

// Let queued microtasks (the decode `.then`/`.finally` chains) settle.
const drain = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe('PCMAudioWorklet fallback decode pipeline', () => {
  let savedWindow: unknown;
  let savedWorkletNode: unknown;
  let savedCreateObjectURL: unknown;

  beforeEach(() => {
    pendingDecodes = [];
    const g = globalThis as Record<string, unknown>;
    savedWindow = g.window;
    savedWorkletNode = g.AudioWorkletNode;
    savedCreateObjectURL = (g.URL as { createObjectURL?: unknown })?.createObjectURL;
    g.window = { AudioContext: MockAudioContext };
    g.AudioWorkletNode = MockWorkletNode;
    if (!g.URL) g.URL = {};
    (g.URL as { createObjectURL: () => string; revokeObjectURL: () => void }).createObjectURL = () => 'blob:mock';
    (g.URL as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
  });

  afterEach(() => {
    const g = globalThis as Record<string, unknown>;
    g.window = savedWindow;
    g.AudioWorkletNode = savedWorkletNode;
    (g.URL as { createObjectURL?: unknown }).createObjectURL = savedCreateObjectURL;
  });

  // Pull the WRITE messages (with their PTS) that reached the worklet.
  const writes = (w: PCMAudioWorklet) => {
    const node = (w as unknown as { workletNode: MockWorkletNode }).workletNode;
    return node.port.posted.filter((m) => m.type === 'WRITE').map((m) => m.pts);
  };

  it('feeds out-of-order decode results into the worklet in arrival order', async () => {
    const w = new PCMAudioWorklet(silent());
    await w.initialize(44100);

    // Five batches arrive with strictly increasing PTS.
    for (let i = 0; i < 5; i++) w.decodeAndFeed(new ArrayBuffer(8), i);

    // Resolve everything, but always newest-first, so within each concurrency
    // window the results complete in reverse order.
    let fed = 0;
    for (let guard = 0; guard < 50 && fed < 5; guard++) {
      if (pendingDecodes.length > 0) {
        pendingDecodes.pop()!.resolve(mockAudioBuffer());
        fed = writes(w).length;
      }
      await drain();
    }

    expect(writes(w)).toEqual([0, 1, 2, 3, 4]);
  });

  it('skips a failed decode without stalling later batches', async () => {
    const w = new PCMAudioWorklet(silent());
    await w.initialize(44100);

    for (let i = 0; i < 3; i++) w.decodeAndFeed(new ArrayBuffer(8), i);

    // Fail the first batch; the other two should still be fed in order.
    pendingDecodes[0].reject(new Error('decode failed'));
    pendingDecodes[1].resolve(mockAudioBuffer());
    pendingDecodes[2].resolve(mockAudioBuffer());
    await drain();

    expect(writes(w)).toEqual([1, 2]);
  });

  it('respects the concurrency cap, starting later decodes only as earlier ones finish', async () => {
    const w = new PCMAudioWorklet(silent());
    await w.initialize(44100);

    for (let i = 0; i < 5; i++) w.decodeAndFeed(new ArrayBuffer(8), i);
    await drain();

    // MAX_CONCURRENT_FALLBACK_DECODES = 3 in flight at once.
    expect(pendingDecodes.length).toBe(3);

    pendingDecodes.shift()!.resolve(mockAudioBuffer());
    await drain();
    // One finished → one more started, never exceeding the cap.
    expect(pendingDecodes.length).toBe(3);
  });

  // Push a PLAY_STATUS report (as the worklet does) to set the buffered lead.
  const reportAvailable = (w: PCMAudioWorklet, available: number) => {
    const node = (w as unknown as { workletNode: MockWorkletNode }).workletNode;
    node.port.onmessage?.({ data: { type: 'PLAY_STATUS', playPts: 0, available } });
  };

  it('stops launching decodes once a healthy lead is buffered, and resumes as it drains', async () => {
    const w = new PCMAudioWorklet(silent());
    await w.initialize(44100); // lead target = 4s * 44100 = 176400 samples

    // The ring buffer already holds well over the lead target.
    reportAvailable(w, 200000);

    for (let i = 0; i < 3; i++) w.decodeAndFeed(new ArrayBuffer(8), i);
    await drain();

    // Gate closed: nothing should have started decoding; batches wait as raw ADTS.
    expect(pendingDecodes.length).toBe(0);

    // The buffer drains below the target → decoding resumes (capped at 3).
    reportAvailable(w, 0);
    await drain();
    expect(pendingDecodes.length).toBe(3);
  });

  it('drops in-flight decodes after a flush instead of feeding stale audio', async () => {
    const w = new PCMAudioWorklet(silent());
    await w.initialize(44100);

    w.decodeAndFeed(new ArrayBuffer(8), 0);
    w.decodeAndFeed(new ArrayBuffer(8), 1);
    await drain();

    const inFlight = [...pendingDecodes];
    w.flush();

    // These belong to the pre-flush epoch and must be ignored.
    for (const d of inFlight) d.resolve(mockAudioBuffer());
    await drain();

    expect(writes(w)).toEqual([]);

    // A fresh batch after flush still works and starts numbering over.
    w.decodeAndFeed(new ArrayBuffer(8), 9);
    await drain();
    expect(pendingDecodes.length).toBeGreaterThan(0);
    pendingDecodes[pendingDecodes.length - 1].resolve(mockAudioBuffer());
    await drain();
    expect(writes(w)).toEqual([9]);
  });
});
