import { TimingPolicy } from '../sync/TimingPolicy.js';

export class WebGLContextPool {
  private static activeGLRenderers = new Set<unknown>();
  private static activeJSRenderers = new Set<unknown>();

  public static acquireGLSlot(renderer: unknown): boolean {
    if (this.activeGLRenderers.has(renderer)) {
      return true;
    }
    if (this.activeGLRenderers.size >= TimingPolicy.MAX_GL_CONTEXTS) {
      return false;
    }
    this.activeGLRenderers.add(renderer);
    return true;
  }

  public static releaseGLSlot(renderer: unknown): void {
    this.activeGLRenderers.delete(renderer);
  }

  public static acquireJSSlot(renderer: unknown): boolean {
    if (this.activeJSRenderers.has(renderer)) {
      return true;
    }
    if (this.activeJSRenderers.size >= TimingPolicy.MAX_JS_CELLS) {
      return false;
    }
    this.activeJSRenderers.add(renderer);
    return true;
  }

  public static releaseJSSlot(renderer: unknown): void {
    this.activeJSRenderers.delete(renderer);
  }

  public static getGLCount(): number {
    return this.activeGLRenderers.size;
  }

  public static getJSCount(): number {
    return this.activeJSRenderers.size;
  }

  public static clear(): void {
    this.activeGLRenderers.clear();
    this.activeJSRenderers.clear();
  }
}
