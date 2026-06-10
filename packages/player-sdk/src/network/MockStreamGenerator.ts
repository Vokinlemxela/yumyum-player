import { Segment } from './StreamLoader.js';

export class MockStreamGenerator {
  public static triggerMockPackets(
    segment: Segment,
    currentSegmentIndex: number,
    onMockPacket: ((packet: Uint8Array, type: 'video' | 'audio', pts: number, isKey: boolean) => void) | null
  ) {
    const isHEVC = segment.url.includes('mock://hevc');
    const isMJPEG = segment.url.includes('mock://mjpeg');
    const isSilent = segment.url.includes('mock://silent');

    const framesPerSegment = 60; // 30fps * 2s
    const startPTS = currentSegmentIndex * segment.duration;

    // Audio frequency setup
    const sampleRate = 44100;
    const samplesPerFrame = 1024; // Standard AAC frame size

    for (let f = 0; f < framesPerSegment; f++) {
      const framePTS = startPTS + (f * (1 / 30));
      const timestampUs = Math.floor(framePTS * 1000000);

      // 1. Generate Video packets
      let videoPacketSize = 10000;
      if (isMJPEG) {
        // Make simple solid JPEG colors dynamically to verify MJPEG
        const jpeg = this.generateMockJPEG(f);
        onMockPacket?.(jpeg, 'video', timestampUs, true);
      } else {
        // Synthetic packet for the canvas mock renderer. Tagged with the "YUMM"
        // magic (0x59 0x55 0x4D 0x4D) — NOT a valid Annex-B start code, so a real
        // H.264/HEVC stream can never be mistaken for a mock packet.
        const dummyNAL = new Uint8Array(videoPacketSize);
        dummyNAL[0] = 0x59; dummyNAL[1] = 0x55; dummyNAL[2] = 0x4D; dummyNAL[3] = 0x4D;

        const isKey = f % 30 === 0;
        onMockPacket?.(dummyNAL, 'video', timestampUs, isKey);
      }

      // 2. Generate Audio PCM directly to verify AAC pipeline (unless silent video)
      if (!isSilent && !isMJPEG) {
        const audioPTS = startPTS + (f * (samplesPerFrame / sampleRate));
        const audioUs = Math.floor(audioPTS * 1000000);
        
        // Generate pure smooth 440Hz sine wave (A4 note)
        const left = new Float32Array(samplesPerFrame);
        for (let i = 0; i < samplesPerFrame; i++) {
          const t = audioPTS + (i / sampleRate);
          left[i] = Math.sin(2 * Math.PI * 440 * t) * 0.15; // Low volume comfort tone
        }
        
        // Send directly as decoded Float32 PCM to mimic AAC decoded state
        onMockPacket?.(new Uint8Array(left.buffer), 'audio', audioUs, true);
      }
    }
  }

  // Generates small elegant colored mock JPEGs to verify MJPEG decoding
  private static generateMockJPEG(frameIndex: number): Uint8Array {
    // Smallest valid 1x1 colored JPEG file array
    return new Uint8Array([
      0xFF, 0xD8, // SOI
      0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x60, 0x00, 0x60, 0x00, 0x00,
      0xFF, 0xDB, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09, 0x09, 0x08,
      0x0A, 0x0C, 0x14, 0x0D, 0x0C, 0x0B, 0x0B, 0x0C, 0x19, 0x12, 0x13, 0x0F, 0x14, 0x1D, 0x1A, 0x1F, 0x1E, 0x1D,
      0x1A, 0x1C, 0x1C, 0x20, 0x24, 0x2E, 0x27, 0x20, 0x22, 0x2C, 0x23, 0x1C, 0x1C, 0x28, 0x37, 0x29, 0x2C, 0x30,
      0x31, 0x34, 0x34, 0x34, 0x1F, 0x27, 0x39, 0x3D, 0x38, 0x32, 0x3C, 0x2E, 0x33, 0x34, 0x32,
      0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, // 1x1 image
      0xFF, 0xC4, 0x00, 0x1F, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B,
      0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00, 0x37, 0xFF, 0xD9 // EOI
    ]);
  }
}
