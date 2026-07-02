import { describe, it, expect } from 'vitest';
import {
  mergeChunks,
  parsePESHeaderPTS,
  getTimelineTime,
  extractAnnexBNALUnits,
  parseAdtsHeader,
  findBox,
  findBoxes,
  parseTrackID,
  parseHandlerType,
  parseTfhdTrackID,
  parseTfhd,
  parseTRUN,
  parseMdhdTimescale,
  parseTfdtBaseMediaDecodeTime,
  parseAudioSpecificConfig,
  buildAdtsFrame,
  rebaseFmp4Pts,
  AAC_SAMPLE_RATES,
  ROLLOVER,
} from './parsers.js';

const u8 = (...bytes: number[]) => new Uint8Array(bytes);

/** Build an MP4 box: size(4 BE) + 4-char type + payload. */
function box(type: string, payload: number[]): number[] {
  const size = 8 + payload.length;
  return [
    (size >>> 24) & 0xff, (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff,
    type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3),
    ...payload,
  ];
}

describe('mergeChunks', () => {
  it('concatenates chunks in order', () => {
    expect(Array.from(mergeChunks([u8(1, 2), u8(3), u8(4, 5)], 5))).toEqual([1, 2, 3, 4, 5]);
  });
  it('returns empty for no chunks', () => {
    expect(mergeChunks([], 0).length).toBe(0);
  });
});

describe('parsePESHeaderPTS', () => {
  // PES with a PTS of exactly 90000 (1s at 90kHz). PTS field encoded across pes[9..13].
  const pesWithPts = u8(
    0x00, 0x00, 0x01, // start code prefix
    0xe0,             // stream id (video)
    0x00, 0x00,       // packet length
    0x80,             // flags1
    0x80,             // flags2 -> PTS present
    0x05,             // header data length
    0x21, 0x00, 0x05, 0xbf, 0x21, // PTS = 90000
  );

  it('extracts a 90kHz PTS', () => {
    expect(parsePESHeaderPTS(pesWithPts)).toBe(90000);
  });

  it('returns 0 when the PTS flag is absent', () => {
    const noPts = pesWithPts.slice();
    noPts[7] = 0x00; // clear PTS flag
    expect(parsePESHeaderPTS(noPts)).toBe(0);
  });

  it('returns 0 for a wrong start-code prefix', () => {
    const bad = pesWithPts.slice();
    bad[2] = 0x00;
    expect(parsePESHeaderPTS(bad)).toBe(0);
  });

  it('returns 0 for a too-short buffer', () => {
    expect(parsePESHeaderPTS(u8(0, 0, 1, 0xe0))).toBe(0);
  });
});

describe('getTimelineTime', () => {
  it('converts PTS to seconds without an offset', () => {
    expect(getTimelineTime(90000, null, 0)).toEqual({ sec: 1, pts: 90000, offset: 0 });
  });

  it('does not roll over for small backward jitter', () => {
    const r = getTimelineTime(100, 90000, 0);
    expect(r.offset).toBe(0);
    expect(r.pts).toBe(100);
  });

  it('applies a 33-bit rollover when the clock wraps', () => {
    const prev = ROLLOVER - 100; // near the top of the 90kHz clock
    const r = getTimelineTime(100, prev, 0);
    expect(r.offset).toBe(ROLLOVER);
    expect(r.pts).toBe(100 + ROLLOVER);
  });
});

describe('extractAnnexBNALUnits', () => {
  it('splits NAL units on 3-byte start codes', () => {
    const units = extractAnnexBNALUnits(u8(0, 0, 1, 0x67, 0xaa, 0, 0, 1, 0x68, 0xbb));
    expect(units.map((u) => Array.from(u))).toEqual([[0x67, 0xaa], [0x68, 0xbb]]);
  });

  it('handles 4-byte start codes', () => {
    const units = extractAnnexBNALUnits(u8(0, 0, 0, 1, 0x67, 0xaa));
    expect(units.map((u) => Array.from(u))).toEqual([[0x67, 0xaa]]);
  });

  it('returns nothing when there is no start code', () => {
    expect(extractAnnexBNALUnits(u8(1, 2, 3, 4))).toEqual([]);
  });
});

describe('parseAdtsHeader', () => {
  // profile=1 (LC), sampleRateIndex=4 (44100), channels=2, frameLength=7
  const adts = u8(0xff, 0xf1, 0x50, 0x80, 0x00, 0xe0, 0x00, 0x00);

  it('parses a valid ADTS header', () => {
    expect(parseAdtsHeader(adts)).toEqual({
      profile: 1,
      sampleRateIndex: 4,
      sampleRate: 44100,
      channels: 2,
      frameLength: 7,
    });
  });

  it('returns null without the sync word', () => {
    expect(parseAdtsHeader(u8(0x00, 0x00, 0x50, 0x80, 0x00, 0xe0, 0x00, 0x00))).toBeNull();
  });

  it('returns null for a too-short packet', () => {
    expect(parseAdtsHeader(u8(0xff, 0xf1, 0x50, 0x80, 0x00, 0xe0, 0x00))).toBeNull();
  });

  it('maps every sample-rate index correctly', () => {
    expect(AAC_SAMPLE_RATES[3]).toBe(48000);
    expect(AAC_SAMPLE_RATES[8]).toBe(16000);
  });
});

describe('findBox / findBoxes', () => {
  it('finds a top-level box payload', () => {
    const data = u8(...box('mvhd', [0xaa]));
    expect(Array.from(findBox(data, 'mvhd')!)).toEqual([0xaa]);
  });

  it('recurses into container boxes', () => {
    const data = u8(...box('moov', box('mvhd', [0xaa])));
    expect(Array.from(findBox(data, 'mvhd')!)).toEqual([0xaa]);
  });

  it('returns null when the box is absent', () => {
    expect(findBox(u8(...box('moov', [])), 'trak')).toBeNull();
  });

  it('finds all matching boxes', () => {
    const data = u8(...box('moov', [...box('trak', [0x01]), ...box('trak', [0x02])]));
    expect(findBoxes(data, 'trak').map((b) => Array.from(b))).toEqual([[0x01], [0x02]]);
  });
});

describe('fMP4 metadata parsers', () => {
  it('parses a version-0 tkhd track ID', () => {
    const tkhd = u8(0, 0, 0, 0, /*creation*/ 0, 0, 0, 0, /*mod*/ 0, 0, 0, 0, /*trackID*/ 0, 0, 0, 7);
    expect(parseTrackID(tkhd)).toBe(7);
  });

  it('parses a hdlr handler type', () => {
    const hdlr = u8(0, 0, 0, 0, 0, 0, 0, 0, 0x76, 0x69, 0x64, 0x65); // 'vide'
    expect(parseHandlerType(hdlr)).toBe('vide');
  });

  it('parses a tfhd track ID', () => {
    expect(parseTfhdTrackID(u8(0, 0, 0, 0, 0, 0, 0, 5))).toBe(5);
  });
});

describe('parseTRUN', () => {
  it('parses sample size + duration and marks keyframes', () => {
    // flags 0x000301: data_offset + sample_duration + sample_size
    const trun = u8(
      0, 0x00, 0x03, 0x01, // version + flags
      0, 0, 0, 1,          // sample_count
      0, 0, 0, 0,          // data_offset
      0, 0, 0, 10,         // sample_duration
      0, 0, 0, 100,        // sample_size
    );
    expect(parseTRUN(trun)).toEqual([
      { size: 100, isKeyframe: true, duration: 10, compositionOffset: 0 },
    ]);
  });

  it('marks a delta sample (non-sync) as non-keyframe', () => {
    // flags 0x000601: data_offset + sample_size + sample_flags; sample_flags sets the non-sync bit
    const trun = u8(
      0, 0x00, 0x06, 0x01,
      0, 0, 0, 1,
      0, 0, 0, 0,           // data_offset
      0, 0, 0, 100,         // sample_size
      0x00, 0x01, 0x00, 0x00, // sample_flags -> sample_is_non_sync (bit 16)
    );
    expect(parseTRUN(trun)[0].isKeyframe).toBe(false);
  });

  it('returns empty for a truncated box', () => {
    expect(parseTRUN(u8(0, 0, 0))).toEqual([]);
  });

  it('bounds a hostile sample_count instead of hanging (DoS guard)', () => {
    // flags=0: no per-sample fields present, so entrySize is 0 and the only
    // guard is the sample_count cap itself. sample_count = 0x7FFFFFFF is the
    // max positive value the `<< 24` read can produce (a real-world attack
    // would also try the sign-flipped 0x80000000+ range, which the `>>> 0`
    // unsigned read normalizes to the same over-the-cap territory).
    const trun = u8(
      0, 0x00, 0x00, 0x00, // version + flags = 0
      0x7f, 0xff, 0xff, 0xff, // sample_count = 0x7FFFFFFF
    );
    const result = parseTRUN(trun);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeLessThanOrEqual(100_000);
  });

  it('still parses a normal multi-sample trun after the bounds fix', () => {
    // flags 0x000301: data_offset + sample_duration + sample_size, 3 samples.
    const trun = u8(
      0, 0x00, 0x03, 0x01, // version + flags
      0, 0, 0, 3,          // sample_count
      0, 0, 0, 0,          // data_offset
      0, 0, 0, 10, 0, 0, 0, 100, // sample 1: duration=10, size=100
      0, 0, 0, 20, 0, 0, 0, 200, // sample 2: duration=20, size=200
      0, 0, 0, 30, 0, 0, 1, 44, // sample 3: duration=30, size=300 (0x12C, big-endian)
    );
    expect(parseTRUN(trun)).toEqual([
      { size: 100, isKeyframe: true, duration: 10, compositionOffset: 0 },
      { size: 200, isKeyframe: true, duration: 20, compositionOffset: 0 },
      { size: 300, isKeyframe: true, duration: 30, compositionOffset: 0 },
    ]);
  });
});

describe('parseTfhd', () => {
  it('reads trackId and default sample duration when present', () => {
    // flags = 0x000008 (default-sample-duration-present)
    const tfhd = u8(
      0, 0x00, 0x00, 0x08,
      0, 0, 0, 2,            // trackId
      0, 0, 0x03, 0xC0,      // default_sample_duration = 960
    );
    expect(parseTfhd(tfhd)).toEqual({ trackId: 2, defaultSampleDuration: 960, defaultSampleSize: 0 });
  });

  it('skips base-data-offset and sample-description-index before the default duration', () => {
    // flags = 0x000001 | 0x000002 | 0x000008
    const tfhd = u8(
      0, 0x00, 0x00, 0x0B,
      0, 0, 0, 1,            // trackId
      0, 0, 0, 0, 0, 0, 0, 0, // base_data_offset (8)
      0, 0, 0, 1,            // sample_description_index (4)
      0, 0, 0x04, 0x00,      // default_sample_duration = 1024
    );
    expect(parseTfhd(tfhd).defaultSampleDuration).toBe(1024);
  });
});

describe('parseMdhdTimescale', () => {
  it('reads a v0 timescale', () => {
    const mdhd = u8(
      0, 0, 0, 0,            // version 0 + flags
      0, 0, 0, 0,            // creation_time
      0, 0, 0, 0,            // modification_time
      0, 0, 0xAC, 0x44,      // timescale = 44100
      0, 0, 0, 0,            // duration
    );
    expect(parseMdhdTimescale(mdhd)).toBe(44100);
  });

  it('reads a v1 timescale (64-bit times)', () => {
    const mdhd = u8(
      1, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, // creation_time (8)
      0, 0, 0, 0, 0, 0, 0, 0, // modification_time (8)
      0, 0, 0x5D, 0xC0,       // timescale = 24000
    );
    expect(parseMdhdTimescale(mdhd)).toBe(24000);
  });
});

describe('parseTfdtBaseMediaDecodeTime', () => {
  it('reads a v0 32-bit base time', () => {
    expect(parseTfdtBaseMediaDecodeTime(u8(0, 0, 0, 0, 0, 0x01, 0x00, 0x00))).toBe(65536);
  });

  it('reads a v1 64-bit base time', () => {
    // hi=1, lo=0 -> 2^32
    expect(parseTfdtBaseMediaDecodeTime(u8(1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0))).toBe(0x100000000);
  });
});

describe('parseAudioSpecificConfig', () => {
  it('extracts AAC-LC 44100Hz stereo from an esds descriptor', () => {
    // AudioSpecificConfig for AOT=2, srIndex=4 (44100), channels=2 -> 0x12 0x10
    const esdsPayload = [
      0, 0, 0, 0,                        // version + flags
      0x03, 22, 0, 0, 0x00,              // ES_Descriptor: ES_ID(2) + flags(1)
      0x04, 17, 0x40, 0x15, 0, 0, 0,     // DecoderConfigDescriptor header
      0, 0, 0, 0, 0, 0, 0, 0,            // max + avg bitrate
      0x05, 2, 0x12, 0x10,               // DecoderSpecificInfo: ASC
    ];
    const trak = new Uint8Array(box('esds', esdsPayload));
    expect(parseAudioSpecificConfig(trak)).toEqual({
      objectType: 2,
      sampleRateIndex: 4,
      sampleRate: 44100,
      channels: 2,
    });
  });

  it('returns null when no esds is present', () => {
    expect(parseAudioSpecificConfig(new Uint8Array(box('mdat', [1, 2, 3, 4])))).toBeNull();
  });
});

describe('buildAdtsFrame', () => {
  it('produces a header that round-trips through parseAdtsHeader', () => {
    const cfg = { objectType: 2, sampleRateIndex: 4, sampleRate: 44100, channels: 2 };
    const payload = new Uint8Array(20).fill(0xAA);
    const frame = buildAdtsFrame(cfg, payload);

    const header = parseAdtsHeader(frame);
    expect(header).not.toBeNull();
    expect(header!.profile).toBe(1);          // ADTS profile = AOT - 1
    expect(header!.sampleRate).toBe(44100);
    expect(header!.channels).toBe(2);
    expect(header!.frameLength).toBe(payload.length + 7);
    // Payload survives intact after the 7-byte header.
    expect(Array.from(frame.subarray(7))).toEqual(Array.from(payload));
  });
});

describe('rebaseFmp4Pts', () => {
  it('zeroes intra-segment time and shifts onto the media base', () => {
    // Segment whose moov-local PTS starts at 100s, mediaBase 12s.
    // First sample: 100 − 100 + 12 = 12; 0.5s later: 100.5 − 100 + 12 = 12.5.
    expect(rebaseFmp4Pts(100, 100, 12)).toBe(12);
    expect(rebaseFmp4Pts(100.5, 100, 12)).toBeCloseTo(12.5, 6);
  });

  it('is a no-op shift for live (segmentTimeBase = 0)', () => {
    // Matches the legacy `raw − timelineOffset` behaviour exactly.
    expect(rebaseFmp4Pts(5.25, 5, 0)).toBeCloseTo(0.25, 6);
    expect(rebaseFmp4Pts(5, 5, 0)).toBe(0);
  });

  it('stays monotonic and continuous across a gap-collapsed segment boundary', () => {
    // Segment A: base 0, offset 0, dur 4 → ends at media 4 (raw 4).
    const endOfA = rebaseFmp4Pts(4, 0, 0);
    // Segment B (post-gap): its own moov offset 1000, base 4 → starts at media 4.
    const startOfB = rebaseFmp4Pts(1000, 1000, 4);
    expect(startOfB).toBe(endOfA); // seamless, no backward jump
    expect(rebaseFmp4Pts(1002, 1000, 4)).toBe(6); // continues forward
  });
});
