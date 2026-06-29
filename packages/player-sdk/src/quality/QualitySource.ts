export interface QualityLevel {
  id: string;
  label: string;
  url: string;
  kind: 'main' | 'sub' | 'auto' | string;
  width?: number;
  height?: number;
  fps?: number;
  bitrateKbps?: number;
  codecs?: string;
}

export interface QualitySource {
  getLevels(): QualityLevel[];
  getActiveId(): string;
  switchQuality(id: string): Promise<void> | void;
}
