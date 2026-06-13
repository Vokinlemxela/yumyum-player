// Dedicated Web Worker for Demuxing and Parsing MPEG-TS segments
// Bypasses browser main-thread UI lag.

import {
  mergeChunks,
  parsePESHeaderPTS,
  getTimelineTime,
  extractAnnexBNALUnits,
  findBox,
  findBoxes,
  parseTrackID,
  parseHandlerType,
  parseTfhd,
  parseTRUN,
  parseMdhdTimescale,
  parseTfdtBaseMediaDecodeTime,
  parseAudioSpecificConfig,
  buildAdtsFrame,
} from './parsers.js';
import type { SampleInfo, AudioSpecificConfigInfo } from './parsers.js';

type LogLevel = 'silent' | 'error' | 'warn' | 'debug';
let workerLogLevel: LogLevel = 'silent';

function logDebug(message: string, ...args: unknown[]) {
  if (workerLogLevel === 'debug') {
    console.log(`[DemuxerWorker] ${message}`, ...args);
  }
}

function logWarn(message: string, ...args: unknown[]) {
  if (workerLogLevel === 'debug' || workerLogLevel === 'warn') {
    console.warn(`[DemuxerWorker] ${message}`, ...args);
  }
}

function logError(message: string, ...args: unknown[]) {
  if (workerLogLevel !== 'silent') {
    console.error(`[DemuxerWorker] ${message}`, ...args);
  }
}

interface DemuxerMessage {
  type: 'VIDEO' | 'AUDIO';
  codec: 'h264' | 'h265' | 'mjpeg' | 'aac';
  parsedCodec?: string;
  pts: number;
  data: Uint8Array;
  isKeyframe?: boolean;
}

interface WorkerContext {
  postMessage(message: DemuxerMessage, transfer?: Transferable[]): void;
}

const workerCtx = self as unknown as WorkerContext;

interface DemuxerConfig {
  videoCodec: 'h264' | 'h265' | 'mjpeg';
  audioCodec: 'aac';
  logLevel?: LogLevel;
}

let config: DemuxerConfig = {
  videoCodec: 'h264',
  audioCodec: 'aac',
};

let previousVideoPTS: number | null = null;
let previousAudioPTS: number | null = null;
let videoOffset = 0;
let audioOffset = 0;

// Persistent state for stream demuxing
let streamVideoChunks: Uint8Array[] = [];
let streamVideoChunksLen = 0;
let streamAudioChunks: Uint8Array[] = [];
let streamAudioChunksLen = 0;
let streamLastVideoPTS = 0;
let streamLastAudioPTS = 0;
let streamBuffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
let streamPmtPID = 4096;
let streamVideoPID = 256;
let streamAudioPID = 257;
let isRawStream: boolean | null = null;
let rawStartTime = 0;

const MAX_STREAM_BUFFER = 5 * 1024 * 1024; // 5MB safety limit
const MAX_PES_BUFFER = 2 * 1024 * 1024;     // 2MB safety limit

// fMP4 stream states
let isFMP4Stream: boolean | null = null;
let currentAVCC: Uint8Array | null = null;
let currentHVCC: Uint8Array | null = null;
let currentParsedCodec: string | undefined = undefined;
let fmp4TimelineOffset: number | null = null;

interface FragmentTrackSamples {
  trackId: number;
  type: 'video' | 'audio';
  samples: SampleInfo[];
  /** Track-timescale decode time of the first sample in this fragment (from tfdt). */
  baseMediaDecodeTime: number;
}

let trackTypes: Map<number, 'video' | 'audio'> = new Map();
let trackTimescales: Map<number, number> = new Map();
let audioConfig: AudioSpecificConfigInfo | null = null;
let currentFragmentSamples: FragmentTrackSamples[] = [];

self.onmessage = (e: MessageEvent) => {
  const { type, data } = e.data;
  logDebug(`Received event: ${type}`);

  switch (type) {
    case 'INIT':
      config = data;
      workerLogLevel = data.logLevel || 'silent';
      previousVideoPTS = null;
      previousAudioPTS = null;
      videoOffset = 0;
      audioOffset = 0;
      
      // Reset stream state
      streamVideoChunks = [];
      streamVideoChunksLen = 0;
      streamAudioChunks = [];
      streamAudioChunksLen = 0;
      streamLastVideoPTS = 0;
      streamLastAudioPTS = 0;
      streamBuffer = new Uint8Array(0);
      streamPmtPID = 4096;
      streamVideoPID = 256;
      streamAudioPID = 257;
      isRawStream = null;
      rawStartTime = 0;
      
      // Reset fMP4 state
      isFMP4Stream = null;
      currentAVCC = null;
      currentHVCC = null;
      currentParsedCodec = undefined;
      fmp4TimelineOffset = null;
      trackTypes.clear();
      trackTimescales.clear();
      audioConfig = null;
      currentFragmentSamples = [];

      logDebug('Initialized config:', config);
      break;

    case 'DEMUX':
      try {
        const uint8 = new Uint8Array(data);
        let isFmp4 = false;
        if (uint8.length >= 8) {
          const type = String.fromCharCode(uint8[4], uint8[5], uint8[6], uint8[7]);
          if (['ftyp', 'moof', 'mdat', 'styp'].includes(type)) {
            isFmp4 = true;
          }
        }
        if (isFmp4) {
          demuxStream(data);
        } else {
          demuxSegment(data);
        }
      } catch (err) {
        logError('Failed to demux segment:', err);
        self.postMessage({ type: 'ERROR', error: err instanceof Error ? err.message : String(err) });
      }
      break;

    case 'STREAM_DEMUX':
      try {
        demuxStream(data);
      } catch (err) {
        logError('Failed to demux stream chunk:', err);
        self.postMessage({ type: 'ERROR', error: err instanceof Error ? err.message : String(err) });
      }
      break;

    case 'FLUSH':
      previousVideoPTS = null;
      previousAudioPTS = null;
      videoOffset = 0;
      audioOffset = 0;

      // Flush remaining packets in streaming buffer if any
      if (streamVideoChunksLen > 0) {
        processVideoPES(mergeChunks(streamVideoChunks, streamVideoChunksLen), streamLastVideoPTS);
        streamVideoChunks = [];
        streamVideoChunksLen = 0;
      }
      if (streamAudioChunksLen > 0) {
        processAudioPES(mergeChunks(streamAudioChunks, streamAudioChunksLen), streamLastAudioPTS);
        streamAudioChunks = [];
        streamAudioChunksLen = 0;
      }
      streamBuffer = new Uint8Array(0);
      currentParsedCodec = undefined;
      currentFragmentSamples = [];
      fmp4TimelineOffset = null;
      logDebug('Flushed timelines and streaming buffers');
      break;
  }
};

function demuxSegment(buffer: ArrayBuffer) {
  logDebug(`demuxSegment started. Buffer size: ${buffer.byteLength} bytes`);
  const view = new DataView(buffer);
  const uint8 = new Uint8Array(buffer);
  const len = uint8.length;

  let offset = 0;

  // Trackers for PES packet reassembly (chunk-based, avoids O(n²) copy)
  let videoChunks: Uint8Array[] = [];
  let videoChunksLen = 0;
  let audioChunks: Uint8Array[] = [];
  let audioChunksLen = 0;
  let lastVideoPTS = 0;
  let lastAudioPTS = 0;

  // PIDs from PAT/PMT (with sensible standard defaults)
  let pmtPID = 4096;
  let videoPID = 256;
  let audioPID = 257;

  // Parse TS Packets (188 bytes each)
  while (offset < len) {
    // 1. Sync byte check
    if (uint8[offset] !== 0x47) {
      // Re-align to next sync byte
      let found = false;
      for (let i = offset + 1; i < len; i++) {
        if (uint8[i] === 0x47) {
          offset = i;
          found = true;
          break;
        }
      }
      if (!found) break; // End of segment reached
    }

    // 2. Parse packet header
    const header = view.getUint32(offset, false);
    const payloadStart = (header & 0x400000) !== 0;
    const pid = (header >> 8) & 0x1FFF;
    const adaptationFieldControl = (header >> 4) & 0x03;

    if (adaptationFieldControl === 0 || adaptationFieldControl === 2) {
      offset += 188;
      continue;
    }

    let payloadOffset = 4;
    if (adaptationFieldControl === 3) {
      // Parse adaptation field length
      const adaptationLen = uint8[offset + 4];
      payloadOffset += 1 + adaptationLen;
    }

    const packetPayload = uint8.subarray(offset + payloadOffset, offset + 188);

    // 3. Process packet based on PID
    if (pid === 0) {
      // PAT (Program Association Table) -> Parse PMT PID
      let payOffset = 0;
      if (payloadStart) {
        const pointerField = packetPayload[0];
        payOffset = 1 + pointerField;
      }
      if (payOffset < packetPayload.length) {
        const tableId = packetPayload[payOffset];
        if (tableId === 0x00) {
          const sectionLength = ((packetPayload[payOffset + 1] & 0x0F) << 8) | packetPayload[payOffset + 2];
          let entryOffset = payOffset + 8;
          const endOffset = payOffset + 3 + sectionLength - 4; // excluding CRC
          while (entryOffset < endOffset && entryOffset + 4 <= packetPayload.length) {
            const programNum = (packetPayload[entryOffset] << 8) | packetPayload[entryOffset + 1];
            const programPID = ((packetPayload[entryOffset + 2] & 0x1F) << 8) | packetPayload[entryOffset + 3];
            if (programNum !== 0) {
              pmtPID = programPID;
            }
            entryOffset += 4;
          }
        }
      }
    } else if (pid === pmtPID) {
      // PMT (Program Map Table) -> Map Video / Audio PIDs
      let payOffset = 0;
      if (payloadStart) {
        const pointerField = packetPayload[0];
        payOffset = 1 + pointerField;
      }
      if (payOffset < packetPayload.length) {
        const tableId = packetPayload[payOffset];
        if (tableId === 0x02) {
          const sectionLength = ((packetPayload[payOffset + 1] & 0x0F) << 8) | packetPayload[payOffset + 2];
          const programInfoLength = ((packetPayload[payOffset + 10] & 0x0F) << 8) | packetPayload[payOffset + 11];
          let entryOffset = payOffset + 12 + programInfoLength;
          const endOffset = payOffset + 3 + sectionLength - 4; // excluding CRC
          while (entryOffset < endOffset && entryOffset + 5 <= packetPayload.length) {
            const streamType = packetPayload[entryOffset];
            const elementaryPID = ((packetPayload[entryOffset + 1] & 0x1F) << 8) | packetPayload[entryOffset + 2];
            const esInfoLength = ((packetPayload[entryOffset + 3] & 0x0F) << 8) | packetPayload[entryOffset + 4];
            if (streamType === 0x1b || streamType === 0x24 || streamType === 0xe0) {
              // Video PID
              videoPID = elementaryPID;
            } else if (streamType === 0x0f || streamType === 0x03 || streamType === 0x04 || streamType === 0x11) {
              // Audio PID
              audioPID = elementaryPID;
            }
            entryOffset += 5 + esInfoLength;
          }
        }
      }
    } else if (pid === videoPID) {
      if (payloadStart) {
        if (videoChunksLen > 0) {
          processVideoPES(mergeChunks(videoChunks, videoChunksLen), lastVideoPTS);
        }
        videoChunks = [packetPayload];
        videoChunksLen = packetPayload.length;
        lastVideoPTS = parsePESHeaderPTS(packetPayload);
      } else {
        videoChunks.push(packetPayload);
        videoChunksLen += packetPayload.length;
      }
    } else if (pid === audioPID) {
      if (payloadStart) {
        if (audioChunksLen > 0) {
          processAudioPES(mergeChunks(audioChunks, audioChunksLen), lastAudioPTS);
        }
        audioChunks = [packetPayload];
        audioChunksLen = packetPayload.length;
        lastAudioPTS = parsePESHeaderPTS(packetPayload);
      } else {
        audioChunks.push(packetPayload);
        audioChunksLen += packetPayload.length;
      }
    }

    offset += 188;
  }

  // Handle final remaining packets
  if (videoChunksLen > 0) {
    processVideoPES(mergeChunks(videoChunks, videoChunksLen), lastVideoPTS);
  }
  if (audioChunksLen > 0) {
    processAudioPES(mergeChunks(audioChunks, audioChunksLen), lastAudioPTS);
  }
}

function demuxStream(chunk: ArrayBuffer) {
  const newBytes = new Uint8Array(chunk);

  if (isFMP4Stream === null) {
    // fMP4 box starts with 4-byte size, then 4-byte type 'ftyp'
    if (newBytes.length >= 8 &&
        newBytes[4] === 0x66 && newBytes[5] === 0x74 &&
        newBytes[6] === 0x79 && newBytes[7] === 0x70) {
      isFMP4Stream = true;
      logWarn('Detected fMP4 stream. Switching to fMP4 parsing mode.');
      rawStartTime = performance.now();
    } else {
      isFMP4Stream = false;
    }
  }

  if (isFMP4Stream) {
    if (streamBuffer.length === 0) {
      streamBuffer = newBytes;
    } else {
      const combined = new Uint8Array(streamBuffer.length + newBytes.length);
      combined.set(streamBuffer, 0);
      combined.set(newBytes, streamBuffer.length);
      streamBuffer = combined;
    }

    let offset = 0;
    const len = streamBuffer.length;
    
    while (offset + 8 <= len) {
      const size = ((streamBuffer[offset] << 24) |
                    (streamBuffer[offset + 1] << 16) |
                    (streamBuffer[offset + 2] << 8) |
                    streamBuffer[offset + 3]) >>> 0;
      
      const type = String.fromCharCode(
        streamBuffer[offset + 4],
        streamBuffer[offset + 5],
        streamBuffer[offset + 6],
        streamBuffer[offset + 7]
      );
      
      if (size <= 0) {
        logError(`Invalid fMP4 box size: ${size} at offset ${offset}`);
        offset++;
        continue;
      }
      
      if (offset + size > len) {
        // Incomplete box, wait for more data
        break;
      }
      
      const boxData = streamBuffer.subarray(offset + 8, offset + size);
      processFMP4Box(type, boxData);
      
      offset += size;
    }
    
    if (offset > 0) {
      streamBuffer = streamBuffer.subarray(offset);
      if (streamBuffer.byteOffset > 1024 * 1024) {
        streamBuffer = streamBuffer.slice();
      }
    }
    return;
  }

  if (isRawStream === null) {
    // If the chunk doesn't start with 0x47 sync byte, it's a raw video stream, not MPEG-TS!
    isRawStream = newBytes[0] !== 0x47;
    if (isRawStream) {
      const hex = Array.from(newBytes.subarray(0, 32)).map(b => b.toString(16).padStart(2, '0')).join(' ');
      logWarn(`Stream first 32 bytes (hex): ${hex}`);
      logWarn('MPEG-TS sync byte (0x47) not found at start of stream. Switching to RAW stream bypass mode.');
      rawStartTime = performance.now();
    } else {
      logDebug('MPEG-TS stream detected successfully.');
    }
  }

  if (isRawStream) {
    const esData = newBytes;
    const timeSeconds = (performance.now() - rawStartTime) / 1000;

    if (config.videoCodec === 'mjpeg') {
      let jpegStart = -1;
      for (let i = 0; i < esData.length - 1; i++) {
        if (esData[i] === 0xFF && esData[i + 1] === 0xD8) {
          jpegStart = i;
          break;
        }
      }
      if (jpegStart !== -1) {
        const jpegBuffer = esData.slice(jpegStart);
        const transferable = jpegBuffer.buffer;
        workerCtx.postMessage(
          {
            type: 'VIDEO',
            codec: 'mjpeg',
            pts: timeSeconds,
            data: jpegBuffer,
            isKeyframe: true,
          },
          [transferable]
        );
      }
      return;
    }

    let nalUnits = extractAnnexBNALUnits(esData);
    if (nalUnits.length === 0) {
      nalUnits = [esData];
    }
    let isKeyframe = false;
    let parsedCodec: string | undefined = undefined;

    for (const nal of nalUnits) {
      if (nal.length === 0) continue;

      if (config.videoCodec === 'h264') {
        const type = nal[0] & 0x1F;
        if (type === 7 && nal.length >= 4) {
          const profile_idc = nal[1].toString(16).padStart(2, '0');
          const constraint_set = nal[2].toString(16).padStart(2, '0');
          const level_idc = nal[3].toString(16).padStart(2, '0');
          parsedCodec = `avc1.${profile_idc}${constraint_set}${level_idc}`;
        }
        if (type === 5) {
          isKeyframe = true;
        }
      } else if (config.videoCodec === 'h265') {
        const type = (nal[0] >> 1) & 0x3F;
        if (type >= 16 && type <= 23) {
          isKeyframe = true;
        }
      }
    }

    const transferableBuffer = esData.slice().buffer;
    workerCtx.postMessage(
      {
        type: 'VIDEO',
        codec: config.videoCodec,
        parsedCodec,
        pts: timeSeconds,
        data: new Uint8Array(transferableBuffer),
        isKeyframe,
      },
      [transferableBuffer]
    );
    return;
  }

  if (streamBuffer.length + newBytes.length > MAX_STREAM_BUFFER) {
    logError('Stream buffer overflow, resetting stream state');
    streamBuffer = new Uint8Array(0);
    streamVideoChunks = [];
    streamVideoChunksLen = 0;
    streamAudioChunks = [];
    streamAudioChunksLen = 0;
    return;
  }

  if (streamBuffer.length === 0) {
    streamBuffer = newBytes;
  } else {
    const combined = new Uint8Array(streamBuffer.length + newBytes.length);
    combined.set(streamBuffer, 0);
    combined.set(newBytes, streamBuffer.length);
    streamBuffer = combined;
  }

  let offset = 0;
  const len = streamBuffer.length;
  const view = new DataView(streamBuffer.buffer, streamBuffer.byteOffset, streamBuffer.byteLength);

  while (offset + 188 <= len) {
    if (streamBuffer[offset] !== 0x47) {
      let found = false;
      for (let i = offset + 1; i + 188 <= len; i++) {
        if (streamBuffer[i] === 0x47) {
          offset = i;
          found = true;
          break;
        }
      }
      if (!found) {
        offset = len - 187;
        break;
      }
    }

    const header = view.getUint32(offset, false);
    const payloadStart = (header & 0x400000) !== 0;
    const pid = (header >> 8) & 0x1FFF;
    const adaptationFieldControl = (header >> 4) & 0x03;

    if (adaptationFieldControl === 0 || adaptationFieldControl === 2) {
      offset += 188;
      continue;
    }

    let payloadOffset = 4;
    if (adaptationFieldControl === 3) {
      const adaptationLen = streamBuffer[offset + 4];
      payloadOffset += 1 + adaptationLen;
    }

    const packetPayload = streamBuffer.subarray(offset + payloadOffset, offset + 188);

    if (pid === 0) {
      let payOffset = 0;
      if (payloadStart) {
        const pointerField = packetPayload[0];
        payOffset = 1 + pointerField;
      }
      if (payOffset < packetPayload.length) {
        const tableId = packetPayload[payOffset];
        if (tableId === 0x00) {
          const sectionLength = ((packetPayload[payOffset + 1] & 0x0F) << 8) | packetPayload[payOffset + 2];
          let entryOffset = payOffset + 8;
          const endOffset = payOffset + 3 + sectionLength - 4;
          while (entryOffset < endOffset && entryOffset + 4 <= packetPayload.length) {
            const programNum = (packetPayload[entryOffset] << 8) | packetPayload[entryOffset + 1];
            const programPID = ((packetPayload[entryOffset + 2] & 0x1F) << 8) | packetPayload[entryOffset + 3];
            if (programNum !== 0) {
              streamPmtPID = programPID;
            }
            entryOffset += 4;
          }
        }
      }
    } else if (pid === streamPmtPID) {
      let payOffset = 0;
      if (payloadStart) {
        const pointerField = packetPayload[0];
        payOffset = 1 + pointerField;
      }
      if (payOffset < packetPayload.length) {
        const tableId = packetPayload[payOffset];
        if (tableId === 0x02) {
          const sectionLength = ((packetPayload[payOffset + 1] & 0x0F) << 8) | packetPayload[payOffset + 2];
          const programInfoLength = ((packetPayload[payOffset + 10] & 0x0F) << 8) | packetPayload[payOffset + 11];
          let entryOffset = payOffset + 12 + programInfoLength;
          const endOffset = payOffset + 3 + sectionLength - 4;
          while (entryOffset < endOffset && entryOffset + 5 <= packetPayload.length) {
            const streamType = packetPayload[entryOffset];
            const elementaryPID = ((packetPayload[entryOffset + 1] & 0x1F) << 8) | packetPayload[entryOffset + 2];
            const esInfoLength = ((packetPayload[entryOffset + 3] & 0x0F) << 8) | packetPayload[entryOffset + 4];
            if (streamType === 0x1b || streamType === 0x24 || streamType === 0xe0) {
              streamVideoPID = elementaryPID;
            } else if (streamType === 0x0f || streamType === 0x03 || streamType === 0x04 || streamType === 0x11) {
              streamAudioPID = elementaryPID;
            }
            entryOffset += 5 + esInfoLength;
          }
        }
      }
    } else if (pid === streamVideoPID) {
      if (payloadStart) {
        if (streamVideoChunksLen > 0) {
          processVideoPES(mergeChunks(streamVideoChunks, streamVideoChunksLen), streamLastVideoPTS);
        }
        streamVideoChunks = [packetPayload.slice()];
        streamVideoChunksLen = packetPayload.length;
        streamLastVideoPTS = parsePESHeaderPTS(packetPayload);
      } else {
        if (streamVideoChunksLen + packetPayload.length > MAX_PES_BUFFER) {
          logWarn('Video PES buffer overflow, resetting chunks');
          streamVideoChunks = [];
          streamVideoChunksLen = 0;
        } else {
          streamVideoChunks.push(packetPayload.slice());
          streamVideoChunksLen += packetPayload.length;
        }
      }
    } else if (pid === streamAudioPID) {
      if (payloadStart) {
        if (streamAudioChunksLen > 0) {
          processAudioPES(mergeChunks(streamAudioChunks, streamAudioChunksLen), streamLastAudioPTS);
        }
        streamAudioChunks = [packetPayload.slice()];
        streamAudioChunksLen = packetPayload.length;
        streamLastAudioPTS = parsePESHeaderPTS(packetPayload);
      } else {
        if (streamAudioChunksLen + packetPayload.length > MAX_PES_BUFFER) {
          logWarn('Audio PES buffer overflow, resetting chunks');
          streamAudioChunks = [];
          streamAudioChunksLen = 0;
        } else {
          streamAudioChunks.push(packetPayload.slice());
          streamAudioChunksLen += packetPayload.length;
        }
      }
    }

    offset += 188;
  }

  if (offset > 0) {
    streamBuffer = streamBuffer.subarray(offset);
    if (streamBuffer.byteOffset > 1024 * 1024) {
      streamBuffer = streamBuffer.slice();
    }
  }
}

// Reassembly helper (avoids O(n²) appendBuffer copies)
function processVideoPES(pes: Uint8Array, ptsRaw: number) {
  // Strip PES header to extract video elementary stream payload
  let payloadOffset = 6;
  if (pes.length > 8) {
    const headerLen = pes[8];
    payloadOffset += 3 + headerLen;
  }

  if (payloadOffset >= pes.length) return;
  const esData = pes.subarray(payloadOffset);

  // Sync timeline
  const { sec: timeSeconds, pts, offset } = getTimelineTime(ptsRaw, previousVideoPTS, videoOffset);
  previousVideoPTS = pts;
  videoOffset = offset;

  if (config.videoCodec === 'mjpeg') {
    // MJPEG stream -> Demux raw JPG file directly
    // Look for SOI start of image (FFD8) and EOI end of image (FFD9)
    let jpegStart = -1;
    for (let i = 0; i < esData.length - 1; i++) {
      if (esData[i] === 0xFF && esData[i + 1] === 0xD8) {
        jpegStart = i;
        break;
      }
    }
    if (jpegStart !== -1) {
      const jpegBuffer = esData.slice(jpegStart);
      const transferable = jpegBuffer.buffer;
      workerCtx.postMessage(
        {
          type: 'VIDEO',
          codec: 'mjpeg',
          pts: timeSeconds,
          data: jpegBuffer,
          isKeyframe: true,
        },
        [transferable]
      );
    }
    return;
  }

  // H.264 / H.265 Annex B NAL unit extraction
  const nalUnits = extractAnnexBNALUnits(esData);
  let isKeyframe = false;
  let parsedCodec: string | undefined = undefined;

  for (const nal of nalUnits) {
    if (nal.length === 0) continue;

    if (config.videoCodec === 'h264') {
      const type = nal[0] & 0x1F;
      
      // NAL type 7 is Sequence Parameter Set (SPS)
      if (type === 7 && nal.length >= 4) {
        const profile_idc = nal[1].toString(16).padStart(2, '0');
        const constraint_set = nal[2].toString(16).padStart(2, '0');
        const level_idc = nal[3].toString(16).padStart(2, '0');
        parsedCodec = `avc1.${profile_idc}${constraint_set}${level_idc}`;
      }
      
      if (type === 5) {
        isKeyframe = true;
      }
    } else if (config.videoCodec === 'h265') {
      const type = (nal[0] >> 1) & 0x3F;
      if (type >= 16 && type <= 23) {
        isKeyframe = true;
      }
    }
  }

  // Transfer elementary streams to main thread (zero-copy)
  const transferableBuffer = esData.slice().buffer;
  workerCtx.postMessage(
    {
      type: 'VIDEO',
      codec: config.videoCodec,
      parsedCodec,
      pts: timeSeconds,
      data: new Uint8Array(transferableBuffer),
      isKeyframe,
    },
    [transferableBuffer]
  );
}

function processAudioPES(pes: Uint8Array, ptsRaw: number) {
  let payloadOffset = 6;
  if (pes.length > 8) {
    const headerLen = pes[8];
    payloadOffset += 3 + headerLen;
  }

  if (payloadOffset >= pes.length) return;
  const esData = pes.subarray(payloadOffset);

  // Sync timeline
  const { sec: timeSeconds, pts, offset } = getTimelineTime(ptsRaw, previousAudioPTS, audioOffset);
  previousAudioPTS = pts;
  audioOffset = offset;

  // Split into AAC ADTS frames
  let index = 0;
  while (index < esData.length - 7) {
    // ADTS sync word is 12 bits: 0xFFF
    const isSync = esData[index] === 0xFF && (esData[index + 1] & 0xF0) === 0xF0;
    if (isSync) {
      // Parse frame length (13 bits in header bytes 3, 4, 5)
      const len =
        ((esData[index + 3] & 0x03) << 11) |
        (esData[index + 4] << 3) |
        ((esData[index + 5] & 0xE0) >> 5);

      if (len > 0 && index + len <= esData.length) {
        const adtsFrame = esData.slice(index, index + len);
        const transferable = adtsFrame.buffer;

        workerCtx.postMessage(
          {
            type: 'AUDIO',
            codec: 'aac',
            pts: timeSeconds,
            data: adtsFrame,
          },
          [transferable]
        );
        index += len;
      } else {
        index++;
      }
    } else {
      index++;
    }
  }
}

function detectFMP4Keyframe(data: Uint8Array): boolean {
  if (config.videoCodec === 'mjpeg') return true;
  if (data.length < 5) return false;
  
  if (config.videoCodec === 'h264') {
    let lengthSize = 4;
    if (currentAVCC && currentAVCC.length >= 5) {
      lengthSize = (currentAVCC[4] & 0x03) + 1;
    }
    
    let offset = 0;
    while (offset + lengthSize < data.length) {
      let size = 0;
      if (lengthSize === 4) {
        size = (data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3];
      } else if (lengthSize === 2) {
        size = (data[offset] << 8) | data[offset + 1];
      } else if (lengthSize === 1) {
        size = data[offset];
      } else if (lengthSize === 3) {
        size = (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
      }
      
      if (size <= 0 || offset + lengthSize + size > data.length) break;
      
      const type = data[offset + lengthSize] & 0x1F;
      if (type === 5) {
        return true;
      }
      offset += lengthSize + size;
    }
  } else if (config.videoCodec === 'h265') {
    let lengthSize = 4;
    if (currentHVCC && currentHVCC.length >= 22) {
      lengthSize = (currentHVCC[21] & 0x03) + 1;
    }
    
    let offset = 0;
    while (offset + lengthSize < data.length) {
      let size = 0;
      if (lengthSize === 4) {
        size = (data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3];
      } else if (lengthSize === 2) {
        size = (data[offset] << 8) | data[offset + 1];
      } else if (lengthSize === 1) {
        size = data[offset];
      } else if (lengthSize === 3) {
        size = (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
      }
      
      if (size <= 0 || offset + lengthSize + size > data.length) break;
      
      const type = (data[offset + lengthSize] >> 1) & 0x3F;
      if (type >= 16 && type <= 23) {
        return true;
      }
      offset += lengthSize + size;
    }
  }
  
  return false;
}

function deliverFMP4Frame(data: Uint8Array, isKeyframe: boolean, ptsSeconds?: number) {
  // Prefer the real track-timeline PTS (from tfdt + trun); fall back to wall
  // clock only when timing metadata is unavailable.
  const timeSeconds = ptsSeconds !== undefined ? ptsSeconds : (performance.now() - rawStartTime) / 1000;

  const transferableBuffer = data.slice().buffer;
  
  const msg: {
    type: 'VIDEO';
    codec: 'h264' | 'h265' | 'mjpeg';
    pts: number;
    data: Uint8Array;
    isKeyframe: boolean;
    description?: Uint8Array;
    parsedCodec?: string;
  } = {
    type: 'VIDEO',
    codec: config.videoCodec,
    pts: timeSeconds,
    data: new Uint8Array(transferableBuffer),
    isKeyframe,
  };
  
  if (config.videoCodec === 'h264' && currentAVCC) {
    msg.description = currentAVCC;
    if (currentParsedCodec) {
      msg.parsedCodec = currentParsedCodec;
    }
  } else if (config.videoCodec === 'h265' && currentHVCC) {
    msg.description = currentHVCC;
  }
  
  workerCtx.postMessage(msg, [transferableBuffer]);
}

/** Wrap a raw fMP4 AAC sample in ADTS and deliver it to the audio pipeline. */
function deliverFMP4Audio(aac: Uint8Array, ptsSeconds: number) {
  if (!audioConfig) return;
  const adts = buildAdtsFrame(audioConfig, aac);
  const transferable = adts.buffer;
  workerCtx.postMessage(
    {
      type: 'AUDIO',
      codec: 'aac',
      pts: ptsSeconds,
      data: adts,
    },
    [transferable]
  );
}

function processFMP4Box(type: string, boxData: Uint8Array) {
  if (type === 'moov') {
    logWarn('Processing moov box');
    fmp4TimelineOffset = null;
    
    // Parse track types, per-track timescales, and the audio AAC config.
    trackTypes.clear();
    trackTimescales.clear();
    audioConfig = null;
    const traks = findBoxes(boxData, 'trak');
    logWarn(`Found ${traks.length} tracks in moov`);
    for (const trak of traks) {
      const tkhd = findBox(trak, 'tkhd');
      const hdlr = findBox(trak, 'hdlr');
      if (tkhd && hdlr) {
        const trackId = parseTrackID(tkhd);
        const handler = parseHandlerType(hdlr);
        const mdhd = findBox(trak, 'mdhd');
        const timescale = mdhd ? parseMdhdTimescale(mdhd) : 0;
        if (timescale > 0) trackTimescales.set(trackId, timescale);
        logWarn(`Track ID: ${trackId} | Handler: ${handler} | Timescale: ${timescale}`);
        if (handler === 'vide') {
          trackTypes.set(trackId, 'video');
        } else if (handler === 'soun') {
          trackTypes.set(trackId, 'audio');
          const cfg = parseAudioSpecificConfig(trak);
          if (cfg) {
            audioConfig = cfg;
            logWarn(`Parsed audio config: AOT=${cfg.objectType}, ${cfg.sampleRate}Hz, ${cfg.channels}ch`);
          } else {
            logWarn('Audio track present but esds/AudioSpecificConfig could not be parsed — audio disabled.');
          }
        }
      }
    }

    const avcc = findBox(boxData, 'avcC');
    if (avcc) {
      currentAVCC = new Uint8Array(avcc);
      logWarn(`Extracted avcC: ${currentAVCC.length} bytes`);
      if (currentAVCC.length >= 5) {
        const lengthSizeMinusOne = currentAVCC[4] & 0x03;
        logWarn(`Parsed lengthSizeMinusOne from avcC: ${lengthSizeMinusOne} -> lengthSize: ${lengthSizeMinusOne + 1}`);
      }
      if (currentAVCC.length >= 4) {
        const profile = currentAVCC[1].toString(16).padStart(2, '0');
        const compat = currentAVCC[2].toString(16).padStart(2, '0');
        const level = currentAVCC[3].toString(16).padStart(2, '0');
        currentParsedCodec = `avc1.${profile}${compat}${level}`;
        logWarn(`Parsed H.264 profile from avcC: ${currentParsedCodec}`);
      }
    }
    const hvcc = findBox(boxData, 'hvcC');
    if (hvcc) {
      currentHVCC = new Uint8Array(hvcc);
      logWarn(`Extracted hvcC: ${currentHVCC.length} bytes`);
      if (currentHVCC.length >= 22) {
        const lengthSizeMinusOne = currentHVCC[21] & 0x03;
        logWarn(`Parsed lengthSizeMinusOne from hvcC: ${lengthSizeMinusOne} -> lengthSize: ${lengthSizeMinusOne + 1}`);
      }
    }
  } else if (type === 'moof') {
    logWarn('Processing moof box');
    currentFragmentSamples = [];
    
    const trafs = findBoxes(boxData, 'traf');
    logWarn(`Found ${trafs.length} track fragments in moof`);
    
    for (let i = 0; i < trafs.length; i++) {
      const traf = trafs[i];
      const tfhd = findBox(traf, 'tfhd');
      const trun = findBox(traf, 'trun');
      const tfdt = findBox(traf, 'tfdt');
      if (tfhd && trun) {
        const { trackId, defaultSampleDuration } = parseTfhd(tfhd);
        const parsedSamples = parseTRUN(trun);

        // trun may omit per-sample durations; fall back to the tfhd default.
        if (defaultSampleDuration > 0) {
          for (const s of parsedSamples) {
            if (s.duration === 0) s.duration = defaultSampleDuration;
          }
        }

        const baseMediaDecodeTime = tfdt ? parseTfdtBaseMediaDecodeTime(tfdt) : 0;

        let trackType = trackTypes.get(trackId);
        if (!trackType) {
          // Fallback if trackTypes mapping is missing
          trackType = i === 0 ? 'video' : 'audio';
        }

        logWarn(`Fragment ${i}: Track ID: ${trackId} | Type: ${trackType} | Samples: ${parsedSamples.length} | baseMediaDecodeTime: ${baseMediaDecodeTime}`);

        currentFragmentSamples.push({
          trackId,
          type: trackType,
          samples: parsedSamples,
          baseMediaDecodeTime,
        });
      }
    }
  } else if (type === 'mdat') {
    if (currentFragmentSamples.length > 0) {
      let mdatOffset = 0;
      
      for (const trackFrag of currentFragmentSamples) {
        const totalSamples = trackFrag.samples.length;
        if (totalSamples === 0) continue;

        let hasZeroSize = false;
        for (const sample of trackFrag.samples) {
          if (sample.size === 0) {
            hasZeroSize = true;
            break;
          }
        }

        let distributedSize = 0;
        if (hasZeroSize) {
          distributedSize = Math.floor((boxData.length - mdatOffset) / totalSamples);
        }

        // Track timescale → seconds. Audio timescale usually equals the sample
        // rate; fall back sensibly if mdhd was missing.
        const timescale = trackTimescales.get(trackFrag.trackId) ||
          (trackFrag.type === 'audio' ? (audioConfig?.sampleRate || 44100) : 90000);

        // Running decode time (in track ticks) across this fragment's samples.
        let dtsTicks = trackFrag.baseMediaDecodeTime;

        for (const sample of trackFrag.samples) {
          const sampleSize = sample.size > 0 ? sample.size : distributedSize;
          if (mdatOffset + sampleSize > boxData.length) {
            logError(`Sample size ${sampleSize} exceeds mdat payload size ${boxData.length - mdatOffset}`);
            break;
          }

          const sampleData = boxData.subarray(mdatOffset, mdatOffset + sampleSize);
          let ptsSeconds = (dtsTicks + sample.compositionOffset) / timescale;

          if (fmp4TimelineOffset === null) {
            fmp4TimelineOffset = ptsSeconds;
            logWarn(`Established fMP4 timeline offset: ${fmp4TimelineOffset}s`);
          }
          ptsSeconds -= fmp4TimelineOffset;

          if (trackFrag.type === 'video') {
            const isKey = detectFMP4Keyframe(sampleData);
            deliverFMP4Frame(sampleData, isKey, ptsSeconds);
          } else if (trackFrag.type === 'audio') {
            deliverFMP4Audio(sampleData, ptsSeconds);
          }

          dtsTicks += sample.duration;
          mdatOffset += sampleSize;
        }
      }
      currentFragmentSamples = []; // Clear
    } else {
      // Fallback
      const isKeyframe = detectFMP4Keyframe(boxData);
      deliverFMP4Frame(boxData, isKeyframe);
    }
  }
}
