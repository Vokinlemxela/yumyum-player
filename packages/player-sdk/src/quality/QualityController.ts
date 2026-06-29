import { QualitySource, QualityLevel } from './QualitySource.js';
import { StreamSignals } from './Signals.js';
import { TimingPolicy } from '../sync/TimingPolicy.js';
import { Logger } from '../utils/Logger.js';

export interface QualityControllerOptions {
  mode?: 'auto' | 'manual';
  cooldownSeconds?: number;
  downDwellSeconds?: number;
  upDwellSeconds?: number;
  safetyFactor?: number;
  upHeadroomFactor?: number;
  droppedFpsThreshold?: number;
  fpsRatioThreshold?: number;
  queueStarvationThreshold?: number;
}

export class QualityController {
  private mode: 'auto' | 'manual' = 'manual';
  private maxAllowedKind: 'main' | 'sub' | null = null;
  private lastSwitchTime = 0;
  private lastSwitchReason = 'None';
  private downDwellStartTime: number | null = null;
  private upDwellStartTime: number | null = null;

  // Options/parameters
  private readonly cooldownMs: number;
  private readonly downDwellMs: number;
  private readonly upDwellMs: number;
  private readonly safetyFactor: number;
  private readonly upHeadroomFactor: number;
  private readonly droppedFpsThreshold: number;
  private readonly fpsRatioThreshold: number;
  private readonly queueStarvationThreshold: number;

  public onQualitySwitch: ((toId: string, reason: string) => void) | null = null;

  constructor(
    private readonly source: QualitySource,
    private readonly logger: Logger,
    options: QualityControllerOptions = {}
  ) {
    this.mode = options.mode ?? 'manual';
    this.cooldownMs = (options.cooldownSeconds ?? TimingPolicy.ABR_COOLDOWN_SECONDS) * 1000;
    this.downDwellMs = (options.downDwellSeconds ?? TimingPolicy.ABR_DOWN_DWELL_SECONDS) * 1000;
    this.upDwellMs = (options.upDwellSeconds ?? TimingPolicy.ABR_UP_DWELL_SECONDS) * 1000;
    this.safetyFactor = options.safetyFactor ?? TimingPolicy.ABR_SAFETY_FACTOR;
    this.upHeadroomFactor = options.upHeadroomFactor ?? TimingPolicy.ABR_UP_HEADROOM_FACTOR;
    this.droppedFpsThreshold = options.droppedFpsThreshold ?? TimingPolicy.ABR_DROPPED_FPS_THRESHOLD;
    this.fpsRatioThreshold = options.fpsRatioThreshold ?? TimingPolicy.ABR_FPS_RATIO_THRESHOLD;
    this.queueStarvationThreshold = options.queueStarvationThreshold ?? TimingPolicy.ABR_QUEUE_STARVATION_THRESHOLD;
  }

  public getMode(): 'auto' | 'manual' {
    return this.mode;
  }

  public setMode(mode: 'auto' | 'manual'): void {
    if (this.mode !== mode) {
      this.logger.info(`ABR Mode changed to: ${mode}`);
      this.mode = mode;
      this.downDwellStartTime = null;
      this.upDwellStartTime = null;
    }
  }

  public getMaxQualityKind(): 'main' | 'sub' | null {
    return this.maxAllowedKind;
  }

  public setMaxQualityKind(kind: 'main' | 'sub' | null): void {
    if (this.maxAllowedKind !== kind) {
      this.logger.info(`ABR density limit restriction changed to: ${kind}`);
      this.maxAllowedKind = kind;
      this.downDwellStartTime = null;
      this.upDwellStartTime = null;
      
      // If we are in auto mode, apply the restriction immediately
      if (this.mode === 'auto') {
        this.evaluateRestriction();
      }
    }
  }

  public reportSignals(signals: StreamSignals, isLive = false): void {
    if (this.mode !== 'auto') {
      return;
    }

    const now = performance.now();
    if (this.lastSwitchTime > 0 && now - this.lastSwitchTime < this.cooldownMs) {
      return; // Inside cooldown period
    }

    const levels = this.getSortedLevels();
    if (levels.length <= 1) {
      return; // No other quality options
    }

    const activeId = this.source.getActiveId();
    const activeIndex = levels.findIndex(l => l.id === activeId);
    if (activeIndex === -1) {
      return; // Active quality not found in the levels list
    }

    const currentLevel = levels[activeIndex];

    // 1. Evaluate restriction first (e.g. if we are on a restricted level, force down)
    if (this.evaluateRestriction()) {
      return;
    }

    // 2. Down-switch Check (OR logic)
    let isDownTriggered = false;
    let downReason = '';

    // Drops rule
    if (signals.droppedFps > this.droppedFpsThreshold) {
      isDownTriggered = true;
      downReason = `High frame drops: ${signals.droppedFps} FPS`;
    }

    // Lag ratio rule
    if (!isDownTriggered && signals.decoderReady && signals.effectiveFps < signals.targetFps * this.fpsRatioThreshold) {
      isDownTriggered = true;
      downReason = `Low rendering FPS: ${signals.effectiveFps}/${signals.targetFps}`;
    }

    // Queue starvation rule (VOD only to prevent false down-switches on low-latency live streams)
    if (!isDownTriggered && !isLive && signals.decoderReady && signals.avgQueueLen < this.queueStarvationThreshold) {
      isDownTriggered = true;
      downReason = `Frame queue starvation: avg len ${signals.avgQueueLen}`;
    }

    // Throughput safety rule
    if (!isDownTriggered && currentLevel.bitrateKbps && signals.throughputKbps > 0) {
      const requiredBitrate = currentLevel.bitrateKbps * this.safetyFactor;
      if (signals.throughputKbps < requiredBitrate) {
        isDownTriggered = true;
        downReason = `Insufficient bandwidth: ${signals.throughputKbps.toFixed(0)} Kbps < required ${requiredBitrate.toFixed(0)} Kbps`;
      }
    }

    if (isDownTriggered) {
      this.upDwellStartTime = null; // Clear up-dwell
      if (this.downDwellStartTime === null) {
        this.downDwellStartTime = now;
      } else if (now - this.downDwellStartTime >= this.downDwellMs) {
        // Trigger downswitch if we are not already at the lowest quality
        if (activeIndex < levels.length - 1) {
          const nextLevel = levels[activeIndex + 1];
          this.switchQuality(nextLevel.id, `Down-switch: ${downReason}`);
        }
      }
      return; // Evaluated down-switch, don't check up-switch
    } else {
      this.downDwellStartTime = null; // Reset down-dwell
    }

    // 3. Up-switch Check (AND logic)
    // Up-switch checks the next higher level (activeIndex - 1 in sorted list)
    if (activeIndex > 0) {
      const nextHigherLevel = levels[activeIndex - 1];

      // Check if the next higher level violates the current maxAllowedKind restriction
      if (this.maxAllowedKind && nextHigherLevel.kind && nextHigherLevel.kind !== this.maxAllowedKind) {
        this.upDwellStartTime = null;
        return;
      }

      if (nextHigherLevel.bitrateKbps && signals.throughputKbps > 0) {
        const requiredBitrate = nextHigherLevel.bitrateKbps * this.upHeadroomFactor;
        const throughputOk = signals.throughputKbps >= requiredBitrate;
        const noDrops = signals.droppedFps === 0;

        if (throughputOk && noDrops) {
          if (this.upDwellStartTime === null) {
            this.upDwellStartTime = now;
          } else if (now - this.upDwellStartTime >= this.upDwellMs) {
            this.switchQuality(
              nextHigherLevel.id,
              `Up-switch: Bandwidth ${signals.throughputKbps.toFixed(0)} Kbps >= required ${requiredBitrate.toFixed(0)} Kbps`
            );
          }
          return;
        }
      }
    }

    this.upDwellStartTime = null; // Reset up-dwell
  }

  public getDiagnostics() {
    return {
      mode: this.mode,
      maxAllowedKind: this.maxAllowedKind,
      lastSwitchReason: this.lastSwitchReason,
      lastSwitchTime: this.lastSwitchTime,
    };
  }

  /**
   * Forces a down-switch if the active level violates the density limit restriction.
   * Returns true if a switch was performed or is pending (cooldown active).
   */
  private evaluateRestriction(): boolean {
    if (!this.maxAllowedKind) return false;

    const levels = this.getSortedLevels();
    const activeId = this.source.getActiveId();
    const activeIndex = levels.findIndex(l => l.id === activeId);
    if (activeIndex === -1) return false;

    const currentLevel = levels[activeIndex];
    if (currentLevel.kind && currentLevel.kind !== this.maxAllowedKind) {
      // Find the highest available quality level that conforms to the restriction
      const conformingLevel = levels.find(l => l.kind === this.maxAllowedKind || !l.kind);
      if (conformingLevel && conformingLevel.id !== activeId) {
        this.switchQuality(conformingLevel.id, `Force conform to restriction: max kind ${this.maxAllowedKind}`);
        return true;
      }
    }
    return false;
  }

  private switchQuality(id: string, reason: string): void {
    this.logger.info(`[QualityController] Switching quality to ${id}. Reason: ${reason}`);
    this.lastSwitchTime = performance.now();
    this.lastSwitchReason = reason;
    this.downDwellStartTime = null;
    this.upDwellStartTime = null;

    try {
      const res = this.source.switchQuality(id);
      if (res instanceof Promise) {
        res.catch((err) => {
          this.logger.error(`[QualityController] Async error during switchQuality to ${id}:`, err);
        });
      }
      this.onQualitySwitch?.(id, reason);
    } catch (e) {
      this.logger.error(`[QualityController] Failed to switch quality to ${id}:`, e);
    }
  }

  /**
   * Returns quality levels sorted by bitrate descending (highest first).
   * Filters out any 'auto' levels.
   */
  private getSortedLevels(): QualityLevel[] {
    return this.source.getLevels()
      .filter(l => l.id !== 'auto')
      .sort((a, b) => (b.bitrateKbps || 0) - (a.bitrateKbps || 0));
  }
}
