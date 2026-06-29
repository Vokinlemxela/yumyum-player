export interface StreamSignals {
  throughputKbps: number;
  throughputSamples: number;
  droppedFps: number;
  effectiveFps: number;
  targetFps: number;
  avgQueueLen: number;
  decoderReady: boolean;
  ts: number;
}
