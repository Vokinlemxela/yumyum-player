import { IStreamLoader, LoaderFactory, LoaderDeps } from './IStreamLoader.js';

/**
 * Maps URL schemes (e.g. `http`, `ws`) to loader factories and resolves the
 * right loader for a given URL. This is the extension seam that lets Pro
 * packages register additional transports (e.g. low-latency WebSocket streaming)
 * without the core importing them.
 */
export class LoaderRegistry {
  private factories = new Map<string, LoaderFactory>();
  private defaultFactory: LoaderFactory | null = null;

  /** Extract the scheme of a URL, defaulting to `http` for relative paths. */
  static schemeOf(url: string): string {
    const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(url);
    return match ? match[1].toLowerCase() : 'http';
  }

  /** Register a factory for one or more URL schemes. */
  register(schemes: string | string[], factory: LoaderFactory): void {
    const list = Array.isArray(schemes) ? schemes : [schemes];
    for (const scheme of list) {
      this.factories.set(scheme.toLowerCase(), factory);
    }
  }

  /** Register the fallback factory used for any unregistered scheme. */
  registerDefault(factory: LoaderFactory): void {
    this.defaultFactory = factory;
  }

  /** Whether a factory is registered for the given scheme. */
  has(scheme: string): boolean {
    return this.factories.has(scheme.toLowerCase());
  }

  /**
   * Create a loader for the URL: an exact scheme match wins, otherwise the
   * default factory is used. Returns `null` when neither is available.
   */
  create(url: string, deps: LoaderDeps): IStreamLoader | null {
    const factory = this.factories.get(LoaderRegistry.schemeOf(url)) ?? this.defaultFactory;
    return factory ? factory(deps) : null;
  }
}
