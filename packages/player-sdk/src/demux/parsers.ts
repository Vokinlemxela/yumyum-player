/**
 * Pure, side-effect-free parsers for MPEG-TS, AnnexB/NAL, ADTS and fMP4.
 *
 * These functions operate solely on their inputs and return values — no
 * `self`, `postMessage`, `performance` or module state. They are imported by
 * the DemuxerWorker (esbuild inlines them at build) and by the AAC decoder,
 * and are unit-tested directly in `parsers.test.ts`.
 */

/** 90kHz clock rolls over at 33 bits (2^33). */
export const ROLLOVER = 8589934592;

/** MP4 boxes that contain child boxes and must be recursed into. */
export const CONTAINER_BOXES = new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'avc1', 'hev1', 'hvc1', 'moof', 'traf',
]);

/** ADTS/MP4 AAC sampling-frequency table, indexed by `sampling_frequency_index`. */
export const AAC_SAMPLE_RATES: readonly number[] = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

export interface SampleInfo {
  size: number;
  isKeyframe: boolean;
  duration: number;
  compositionOffset: number;
}

export interface AdtsHeader {
  /** 0=Main, 1=LC, 2=SSR (AudioObjectType is profile+1). */
  profile: number;
  sampleRateIndex: number;
  sampleRate: number;
  channels: number;
  /** Full ADTS frame length in bytes (header + payload). */
  frameLength: number;
}

/** Concatenate chunks into a single buffer of the given total length. */
export function mergeChunks(chunks: Uint8Array[], totalLength: number): Uint8Array {
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/** Parse the 33-bit PTS (90kHz) from a PES header, or 0 if absent/invalid. */
export function parsePESHeaderPTS(pes: Uint8Array): number {
  if (pes.length < 14) return 0;
  // PES packet starts with 3-byte prefix (0x000001) + streamId + packetLength + flags
  if (pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1) return 0;

  const flags = pes[7];
  const hasPTS = (flags & 0x80) !== 0;

  if (hasPTS) {
    const ptsHeaderOffset = 9;
    // Extract 33-bit PTS value using standard Numbers
    const b0 = pes[ptsHeaderOffset];
    const b1 = pes[ptsHeaderOffset + 1];
    const b2 = pes[ptsHeaderOffset + 2];
    const b3 = pes[ptsHeaderOffset + 3];
    const b4 = pes[ptsHeaderOffset + 4];

    // High 3 bits of PTS (bits 30-32)
    const ptsHigh = ((b0 & 0x0E) >> 1) * 0x40000000;

    // Lower 30 bits
    const ptsLow = ((b1 << 22) |
                    (((b2 & 0xFE) >> 1) << 15) |
                    (b3 << 7) |
                    ((b4 & 0xFE) >> 1)) >>> 0;

    return ptsHigh + ptsLow;
  }

  return 0;
}

/** Map a raw PTS onto a monotonic timeline, accounting for 90kHz rollover. */
export function getTimelineTime(pts: number, previousPTS: number | null, offset: number): { sec: number, pts: number, offset: number } {
  let adjustedPTS = pts + offset;

  if (previousPTS !== null && previousPTS - adjustedPTS > ROLLOVER / 2) {
    offset += ROLLOVER;
    adjustedPTS = pts + offset;
  }

  const seconds = adjustedPTS / 90000;
  return { sec: seconds, pts: adjustedPTS, offset };
}

/** Split an Annex-B byte stream into NAL units (start codes stripped). */
export function extractAnnexBNALUnits(data: Uint8Array): Uint8Array[] {
  const units: Uint8Array[] = [];
  let i = 0;
  const len = data.length;

  while (i < len - 3) {
    // Check start code 0x000001
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      const start = i + 3;
      let end = len;

      // Scan for next start code
      for (let j = start; j < len - 3; j++) {
        if (data[j] === 0 && data[j + 1] === 0) {
          if (data[j + 2] === 1 || (data[j + 2] === 0 && data[j + 3] === 1)) {
            end = j;
            break;
          }
        }
      }

      units.push(data.subarray(start, end));
      i = end;
    } else {
      i++;
    }
  }

  return units;
}

/** Parse an ADTS header, or `null` if the sync word is not present. */
export function parseAdtsHeader(packet: Uint8Array): AdtsHeader | null {
  // ADTS sync word is 0xFFF (12 bits)
  if (packet.length <= 7 || packet[0] !== 0xFF || (packet[1] & 0xF0) !== 0xF0) return null;

  const profile = (packet[2] & 0xC0) >> 6;
  const sampleRateIndex = (packet[2] & 0x3C) >> 2;
  const channelConfig = ((packet[2] & 0x01) << 2) | ((packet[3] & 0xC0) >> 6);

  const sampleRate = AAC_SAMPLE_RATES[sampleRateIndex] || 44100;
  const channels = channelConfig || 2;
  const frameLength = ((packet[3] & 0x03) << 11) | (packet[4] << 3) | ((packet[5] & 0xE0) >> 5);

  return { profile, sampleRateIndex, sampleRate, channels, frameLength };
}

/** Recursively find the first MP4 box of `targetType`, returning its payload. */
export function findBox(data: Uint8Array, targetType: string): Uint8Array | null {
  let offset = 0;
  const len = data.length;
  while (offset + 8 <= len) {
    const size = (data[offset] << 24) |
                 (data[offset + 1] << 16) |
                 (data[offset + 2] << 8) |
                 data[offset + 3];
    const type = String.fromCharCode(
      data[offset + 4],
      data[offset + 5],
      data[offset + 6],
      data[offset + 7]
    );

    if (size <= 0 || offset + size > len) break;

    if (type === targetType) {
      return data.subarray(offset + 8, offset + size);
    }

    if (CONTAINER_BOXES.has(type)) {
      const subBoxPayload = data.subarray(offset + 8, offset + size);
      let searchData = subBoxPayload;
      if (type === 'stsd') {
        searchData = subBoxPayload.subarray(8);
      } else if (type === 'avc1' || type === 'hev1' || type === 'hvc1') {
        searchData = subBoxPayload.subarray(78);
      }
      const found = findBox(searchData, targetType);
      if (found) return found;
    }

    offset += size;
  }
  return null;
}

/** Recursively find all MP4 boxes of `targetType`, returning their payloads. */
export function findBoxes(data: Uint8Array, targetType: string): Uint8Array[] {
  const results: Uint8Array[] = [];
  let offset = 0;
  const len = data.length;
  while (offset + 8 <= len) {
    const size = (data[offset] << 24) |
                 (data[offset + 1] << 16) |
                 (data[offset + 2] << 8) |
                 data[offset + 3];
    const type = String.fromCharCode(
      data[offset + 4],
      data[offset + 5],
      data[offset + 6],
      data[offset + 7]
    );

    if (size <= 0 || offset + size > len) break;

    if (type === targetType) {
      results.push(data.subarray(offset + 8, offset + size));
    }

    if (CONTAINER_BOXES.has(type)) {
      const subBoxPayload = data.subarray(offset + 8, offset + size);
      let searchData = subBoxPayload;
      if (type === 'stsd') {
        searchData = subBoxPayload.subarray(8);
      } else if (type === 'avc1' || type === 'hev1' || type === 'hvc1') {
        searchData = subBoxPayload.subarray(78);
      }
      const subResults = findBoxes(searchData, targetType);
      results.push(...subResults);
    }

    offset += size;
  }
  return results;
}

/** Parse the track ID from a `tkhd` box payload. */
export function parseTrackID(tkhdPayload: Uint8Array): number {
  if (tkhdPayload.length < 4) return 0;
  const version = tkhdPayload[0];
  const offset = version === 1 ? 4 + 8 + 8 : 4 + 4 + 4;
  if (offset + 4 > tkhdPayload.length) return 0;
  return (tkhdPayload[offset] << 24) |
         (tkhdPayload[offset + 1] << 16) |
         (tkhdPayload[offset + 2] << 8) |
         tkhdPayload[offset + 3];
}

/** Parse the 4-char handler type (e.g. `vide`/`soun`) from a `hdlr` payload. */
export function parseHandlerType(hdlrPayload: Uint8Array): string {
  if (hdlrPayload.length < 12) return '';
  return String.fromCharCode(
    hdlrPayload[8],
    hdlrPayload[9],
    hdlrPayload[10],
    hdlrPayload[11]
  );
}

/** Parse the track ID from a `tfhd` box payload. */
export function parseTfhdTrackID(tfhdPayload: Uint8Array): number {
  if (tfhdPayload.length < 8) return 0;
  return (tfhdPayload[4] << 24) |
         (tfhdPayload[5] << 16) |
         (tfhdPayload[6] << 8) |
         tfhdPayload[7];
}

/**
 * Hard ceiling on the number of samples a single `trun` box may claim.
 * Real segments carry far fewer (typically tens to low hundreds); this exists
 * purely to bound the loop below against a hostile/corrupt `sample_count`
 * field, which is untrusted network input.
 */
const MAX_TRUN_SAMPLES = 100_000;

/** Parse per-sample info (size/duration/keyframe/cts) from a `trun` box payload. */
export function parseTRUN(trunData: Uint8Array): SampleInfo[] {
  if (trunData.length < 8) return [];

  const flags = (trunData[1] << 16) | (trunData[2] << 8) | trunData[3];

  // `>>> 0` treats the 32-bit read as unsigned so a high-bit-set value (which
  // would otherwise become negative via the `<< 24`) doesn't slip past the
  // upper-bound check below.
  const sampleCount = ((trunData[4] << 24) | (trunData[5] << 16) | (trunData[6] << 8) | trunData[7]) >>> 0;

  // sample_count is attacker-controlled (untrusted network bytes). Reject
  // implausible values outright rather than looping up to 2^32-1 times.
  if (sampleCount > MAX_TRUN_SAMPLES) return [];

  let offset = 8;
  if (flags & 0x000001) offset += 4; // data_offset
  if (flags & 0x000004) offset += 4; // first_sample_flags

  const samples: SampleInfo[] = [];

  let entrySize = 0;
  if (flags & 0x000100) entrySize += 4;
  if (flags & 0x000200) entrySize += 4;
  if (flags & 0x000400) entrySize += 4;
  if (flags & 0x000800) entrySize += 4;

  // When entrySize is 0 (flags set none of the per-sample bits), the
  // `offset + entrySize > trunData.length` guard inside the loop never
  // triggers — so also cap by how many zero-size entries could plausibly fit,
  // ensuring the loop always terminates in bounded time regardless of flags.
  const maxIterations = entrySize > 0
    ? Math.min(sampleCount, Math.floor((trunData.length - offset) / entrySize) + 1)
    : sampleCount;

  for (let i = 0; i < maxIterations; i++) {
    if (entrySize > 0 && offset + entrySize > trunData.length) break;

    let duration = 0;
    if (flags & 0x000100) {
      duration = (trunData[offset] << 24) | (trunData[offset + 1] << 16) | (trunData[offset + 2] << 8) | trunData[offset + 3];
      offset += 4;
    }

    let size = 0;
    if (flags & 0x000200) {
      size = (trunData[offset] << 24) | (trunData[offset + 1] << 16) | (trunData[offset + 2] << 8) | trunData[offset + 3];
      offset += 4;
    }

    let sampleFlags = 0;
    if (flags & 0x000400) {
      sampleFlags = (trunData[offset] << 24) | (trunData[offset + 1] << 16) | (trunData[offset + 2] << 8) | trunData[offset + 3];
      offset += 4;
    }

    let compositionOffset = 0;
    if (flags & 0x000800) {
      compositionOffset = (trunData[offset] << 24) | (trunData[offset + 1] << 16) | (trunData[offset + 2] << 8) | trunData[offset + 3];
      offset += 4;
    }

    const isDiff = (sampleFlags >> 16) & 0x01;
    const isKey = size > 0 && !isDiff;

    samples.push({
      size,
      isKeyframe: isKey,
      duration,
      compositionOffset,
    });
  }

  return samples;
}

/** Parsed `tfhd` fields needed for fMP4 sample timing. */
export interface TfhdInfo {
  trackId: number;
  defaultSampleDuration: number;
  defaultSampleSize: number;
}

/** Parse a `tfhd` box payload: track ID plus the optional default duration/size. */
export function parseTfhd(tfhdPayload: Uint8Array): TfhdInfo {
  const empty: TfhdInfo = { trackId: 0, defaultSampleDuration: 0, defaultSampleSize: 0 };
  if (tfhdPayload.length < 8) return empty;

  const flags = (tfhdPayload[1] << 16) | (tfhdPayload[2] << 8) | tfhdPayload[3];
  const trackId = (tfhdPayload[4] << 24) | (tfhdPayload[5] << 16) | (tfhdPayload[6] << 8) | tfhdPayload[7];

  let offset = 8;
  if (flags & 0x000001) offset += 8; // base-data-offset
  if (flags & 0x000002) offset += 4; // sample-description-index

  let defaultSampleDuration = 0;
  if (flags & 0x000008) {
    if (offset + 4 > tfhdPayload.length) return { trackId, defaultSampleDuration: 0, defaultSampleSize: 0 };
    defaultSampleDuration = (tfhdPayload[offset] << 24) | (tfhdPayload[offset + 1] << 16) | (tfhdPayload[offset + 2] << 8) | tfhdPayload[offset + 3];
    offset += 4;
  }

  let defaultSampleSize = 0;
  if (flags & 0x000010) {
    if (offset + 4 > tfhdPayload.length) return { trackId, defaultSampleDuration, defaultSampleSize: 0 };
    defaultSampleSize = (tfhdPayload[offset] << 24) | (tfhdPayload[offset + 1] << 16) | (tfhdPayload[offset + 2] << 8) | tfhdPayload[offset + 3];
  }

  return { trackId, defaultSampleDuration, defaultSampleSize };
}

/** Parse the media timescale (ticks per second) from an `mdhd` box payload. */
export function parseMdhdTimescale(mdhdPayload: Uint8Array): number {
  if (mdhdPayload.length < 4) return 0;
  const version = mdhdPayload[0];
  // v0: [creation(4) modification(4) timescale(4) ...]; v1 widens the times to 8.
  const offset = version === 1 ? 4 + 8 + 8 : 4 + 4 + 4;
  if (offset + 4 > mdhdPayload.length) return 0;
  return ((mdhdPayload[offset] << 24) |
          (mdhdPayload[offset + 1] << 16) |
          (mdhdPayload[offset + 2] << 8) |
          mdhdPayload[offset + 3]) >>> 0;
}

/** Parse the `baseMediaDecodeTime` (in track timescale) from a `tfdt` box payload. */
export function parseTfdtBaseMediaDecodeTime(tfdtPayload: Uint8Array): number {
  if (tfdtPayload.length < 8) return 0;
  const version = tfdtPayload[0];
  if (version === 1) {
    if (tfdtPayload.length < 12) return 0;
    const hi = ((tfdtPayload[4] << 24) | (tfdtPayload[5] << 16) | (tfdtPayload[6] << 8) | tfdtPayload[7]) >>> 0;
    const lo = ((tfdtPayload[8] << 24) | (tfdtPayload[9] << 16) | (tfdtPayload[10] << 8) | tfdtPayload[11]) >>> 0;
    // Safe for realistic media durations (well under 2^53 ticks).
    return hi * 0x100000000 + lo;
  }
  return ((tfdtPayload[4] << 24) | (tfdtPayload[5] << 16) | (tfdtPayload[6] << 8) | tfdtPayload[7]) >>> 0;
}

/** AAC config extracted from an `esds`/AudioSpecificConfig, used to synthesize ADTS. */
export interface AudioSpecificConfigInfo {
  /** AudioObjectType (e.g. 2 = AAC-LC). ADTS `profile` = objectType − 1. */
  objectType: number;
  sampleRateIndex: number;
  sampleRate: number;
  channels: number;
}

/** Locate an `esds` box payload anywhere inside a (audio) `trak`/`mp4a` payload. */
function findEsdsPayload(data: Uint8Array): Uint8Array | null {
  for (let i = 0; i + 8 <= data.length; i++) {
    if (data[i + 4] === 0x65 && data[i + 5] === 0x73 && data[i + 6] === 0x64 && data[i + 7] === 0x73) {
      const size = ((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3]) >>> 0;
      if (size >= 8 && i + size <= data.length) {
        return data.subarray(i + 8, i + size);
      }
    }
  }
  return null;
}

/**
 * Parse the AAC AudioSpecificConfig out of an audio track's `esds` descriptor.
 * Walks the ES_Descriptor → DecoderConfigDescriptor → DecoderSpecificInfo chain.
 */
export function parseAudioSpecificConfig(trak: Uint8Array): AudioSpecificConfigInfo | null {
  const esds = findEsdsPayload(trak);
  if (!esds) return null;

  let o = 4; // skip the esds full-box version(1) + flags(3)

  const readDescLen = (): number => {
    let len = 0;
    for (let i = 0; i < 4; i++) {
      const b = esds[o++];
      len = (len << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return len;
  };

  // ES_Descriptor (tag 0x03)
  if (esds[o] === 0x03) {
    o++;
    readDescLen();
    o += 2; // ES_ID
    const esFlags = esds[o++];
    if (esFlags & 0x80) o += 2;            // streamDependenceFlag → dependsOn_ES_ID
    if (esFlags & 0x40) { o += 1 + esds[o]; } // URL_Flag → URLlength + URLstring
    if (esFlags & 0x20) o += 2;            // OCRstreamFlag → OCR_ES_ID
  }

  // DecoderConfigDescriptor (tag 0x04)
  if (esds[o] === 0x04) {
    o++;
    readDescLen();
    o += 13; // objectTypeIndication(1)+streamType/flags(1)+bufferSizeDB(3)+maxBitrate(4)+avgBitrate(4)
  }

  // DecoderSpecificInfo (tag 0x05) — holds the AudioSpecificConfig
  if (esds[o] === 0x05) {
    o++;
    readDescLen();
    if (o + 2 > esds.length) return null;
    const b0 = esds[o];
    const b1 = esds[o + 1];
    const objectType = (b0 >> 3) & 0x1f;
    const sampleRateIndex = ((b0 & 0x07) << 1) | ((b1 >> 7) & 0x01);
    const channels = (b1 >> 3) & 0x0f;
    return {
      objectType,
      sampleRateIndex,
      sampleRate: AAC_SAMPLE_RATES[sampleRateIndex] || 44100,
      channels: channels || 2,
    };
  }

  return null;
}

/**
 * Rebase a self-contained fMP4 sample PTS onto the continuous media timeline.
 *
 * Each archive segment carries its own ftyp+moov+moof, so its tfdt/trun timing
 * is segment-local. `timelineOffset` (captured from the first sample after each
 * moov) zeroes the intra-segment time to 0..dur; `segmentTimeBase` (the sum of
 * preceding segment durations, supplied via SEGMENT_META) then shifts it onto
 * the gap-collapsed media timeline.
 *
 * For live fMP4 (one EXT-X-MAP, moof-only, no SEGMENT_META) `segmentTimeBase`
 * is 0, so this reduces to the existing `raw − timelineOffset` behaviour.
 */
export function rebaseFmp4Pts(rawSeconds: number, timelineOffset: number, segmentTimeBase: number): number {
  return rawSeconds - timelineOffset + segmentTimeBase;
}

/**
 * Wrap a raw AAC access unit in a 7-byte ADTS header so it can flow through the
 * ADTS-oriented AAC decoder path. fMP4 carries raw AAC frames (no ADTS), so we
 * synthesize the header from the track's AudioSpecificConfig.
 */
export function buildAdtsFrame(cfg: AudioSpecificConfigInfo, aac: Uint8Array): Uint8Array {
  const frameLen = aac.length + 7;
  const profile = (cfg.objectType - 1) & 0x3; // ADTS profile = AOT − 1
  const out = new Uint8Array(frameLen);
  out[0] = 0xFF;
  out[1] = 0xF1; // MPEG-4, layer 0, protection absent
  out[2] = (profile << 6) | ((cfg.sampleRateIndex & 0x0F) << 2) | ((cfg.channels >> 2) & 0x01);
  out[3] = ((cfg.channels & 0x03) << 6) | ((frameLen >> 11) & 0x03);
  out[4] = (frameLen >> 3) & 0xFF;
  out[5] = ((frameLen & 0x07) << 5) | 0x1F;
  out[6] = 0xFC;
  out.set(aac, 7);
  return out;
}
