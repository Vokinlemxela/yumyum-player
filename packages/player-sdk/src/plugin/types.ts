import { Logger } from '../utils/Logger.js';
import { IBaseDecoder } from '../decode/DecoderRegistry.js';
import { DecodedFrame } from '../sync/PlaybackController.js';
import { LoaderFactory } from '../network/IStreamLoader.js';

/** Dependencies the player wires into a plugin-supplied video decoder. */
export interface DecoderDeps {
  onFrame: (frame: DecodedFrame) => void;
  onError: (error: Error) => void;
  logger: Logger;
}

/** Constructs a decoder from the player-provided {@link DecoderDeps}. */
export type DecoderFactory = (deps: DecoderDeps) => IBaseDecoder;

/**
 * The surface a plugin uses during {@link PlayerPlugin.install} to extend the
 * player. Plugins never import player internals — they register through here.
 */
export interface PluginContext {
  /**
   * Register (or override) a decoder under a codec key. The player invokes the
   * factory with the wiring callbacks and adds the result to its registry.
   * Example: a WASM HEVC fallback registers under `h265-sw`.
   */
  registerDecoder(key: string, factory: DecoderFactory): void;
  /** Register a stream loader factory for URL scheme(s), e.g. `['ws', 'wss']`. */
  registerLoader(schemes: string | string[], factory: LoaderFactory): void;
  /** A logger scoped to the plugin. */
  readonly logger: Logger;
}

/**
 * A plugin extends the free core with extra decoders and/or stream loaders
 * (e.g. Pro modules: universal HEVC, low-latency streaming). Passed via
 * `PlayerConfig.plugins` and installed once during player construction.
 */
export interface PlayerPlugin {
  readonly name: string;
  install(ctx: PluginContext): void;
}
