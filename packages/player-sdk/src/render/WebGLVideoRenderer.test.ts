import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebGLVideoRenderer, YUVFrameData } from './WebGLVideoRenderer.js';
import { WebGLContextPool } from './WebGLContextPool.js';
import { Logger } from '../utils/Logger.js';

describe('WebGLVideoRenderer & WebGLContextPool', () => {
  let logger: Logger;
  let mockCanvas: any;
  let mockGL: any;
  let mock2D: any;

  beforeEach(() => {
    logger = new Logger('test', 'silent');
    WebGLContextPool.clear();

    // Reset static probe state so context tests run fresh
    (WebGLVideoRenderer as any)._webgl2Usable = true;

    // Create minimal mock WebGL2 context
    mockGL = {
      createShader: vi.fn().mockReturnValue({}),
      shaderSource: vi.fn(),
      compileShader: vi.fn(),
      getShaderParameter: vi.fn().mockReturnValue(true),
      createProgram: vi.fn().mockReturnValue({}),
      attachShader: vi.fn(),
      linkProgram: vi.fn(),
      getProgramParameter: vi.fn().mockReturnValue(true),
      createBuffer: vi.fn().mockReturnValue({}),
      bindBuffer: vi.fn(),
      bufferData: vi.fn(),
      useProgram: vi.fn(),
      uniform1i: vi.fn(),
      getUniformLocation: vi.fn().mockReturnValue({}),
      getAttribLocation: vi.fn().mockReturnValue(1),
      enableVertexAttribArray: vi.fn(),
      vertexAttribPointer: vi.fn(),
      viewport: vi.fn(),
      clear: vi.fn(),
      activeTexture: vi.fn(),
      bindTexture: vi.fn(),
      texSubImage2D: vi.fn(),
      createTexture: vi.fn().mockReturnValue({}),
      texParameteri: vi.fn(),
      texStorage2D: vi.fn(),
      deleteTexture: vi.fn(),
      deleteShader: vi.fn(),
      deleteProgram: vi.fn(),
      deleteBuffer: vi.fn(),
      drawArrays: vi.fn(),
      getExtension: vi.fn().mockReturnValue({ loseContext: vi.fn() }),
    };

    // Create mock 2D context
    mock2D = {
      createImageData: vi.fn().mockReturnValue({ data: new Uint8Array(16) }),
      putImageData: vi.fn(),
      drawImage: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      fillText: vi.fn(),
    };

    mockCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn().mockImplementation((type: string) => {
        if (type === 'webgl2') return mockGL;
        if (type === '2d') return mock2D;
        return null;
      }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('allocates context pool slot and renders WebGL on first frame', () => {
    const renderer = new WebGLVideoRenderer(mockCanvas, 'black', logger);
    expect(WebGLContextPool.getGLCount()).toBe(0);

    const frame: YUVFrameData = {
      width: 320,
      height: 180,
      yPlane: new Uint8Array(320 * 180),
      uPlane: new Uint8Array(160 * 90),
      vPlane: new Uint8Array(160 * 90),
    };

    renderer.renderYUV(frame);

    expect(WebGLContextPool.getGLCount()).toBe(1);
    expect(renderer.getRenderMode()).toBe('webgl');
    expect(mockCanvas.getContext).toHaveBeenCalledWith('webgl2', expect.any(Object));
    expect(mockGL.useProgram).toHaveBeenCalled();

    renderer.destroy();
    expect(WebGLContextPool.getGLCount()).toBe(0);
  });

  it('caches shader locations and does not query getAttrib/UniformLocation on hot path', () => {
    const renderer = new WebGLVideoRenderer(mockCanvas, 'black', logger);
    const frame: YUVFrameData = {
      width: 320,
      height: 180,
      yPlane: new Uint8Array(320 * 180),
      uPlane: new Uint8Array(160 * 90),
      vPlane: new Uint8Array(160 * 90),
    };

    // First frame initializes shaders and queries locations
    renderer.renderYUV(frame);
    const initialAttribCalls = mockGL.getAttribLocation.mock.calls.length;
    const initialUniformCalls = mockGL.getUniformLocation.mock.calls.length;
    expect(initialAttribCalls).toBeGreaterThan(0);
    expect(initialUniformCalls).toBeGreaterThan(0);

    // Second frame should NOT invoke getAttribLocation or getUniformLocation
    mockGL.getAttribLocation.mockClear();
    mockGL.getUniformLocation.mockClear();

    renderer.renderYUV(frame);
    expect(mockGL.getAttribLocation).not.toHaveBeenCalled();
    expect(mockGL.getUniformLocation).not.toHaveBeenCalled();

    renderer.destroy();
  });

  it('enforces context limit and triggers overflow fallback', () => {
    const renderers: WebGLVideoRenderer[] = [];
    const fallbacks: string[] = [];

    // Create 10 renderers
    for (let i = 0; i < 10; i++) {
      const r = new WebGLVideoRenderer(mockCanvas, 'black', logger);
      r.onFallback = (reason) => {
        fallbacks.push(reason);
      };
      renderers.push(r);
    }

    const frame = {
      width: 320,
      height: 180,
      close: vi.fn(),
    } as any;

    // Render on all of them
    for (const r of renderers) {
      r.renderVideoFrame(frame);
    }

    // Limit is 8 GL slots (TimingPolicy.MAX_GL_CONTEXTS)
    expect(WebGLContextPool.getGLCount()).toBe(8);

    // The first 8 should be webgl, remaining 2 should be overflowed
    expect(renderers[0].getRenderMode()).toBe('webgl');
    expect(renderers[7].getRenderMode()).toBe('webgl');
    expect(renderers[8].getRenderMode()).toBe('2d-overflow');
    expect(renderers[9].getRenderMode()).toBe('2d-overflow');

    expect(fallbacks).toContain('overflow');
    expect(fallbacks).toHaveLength(2);

    // Clean up
    for (const r of renderers) {
      r.destroy();
    }
    expect(WebGLContextPool.getGLCount()).toBe(0);
  });

  it('drops raw YUV frames if JS fallback cell limit is exceeded', () => {
    const renderers: WebGLVideoRenderer[] = [];
    // Disable webgl2 entirely so all renderers fall back to JS per-pixel YUV rendering
    (WebGLVideoRenderer as any)._webgl2Usable = false;

    for (let i = 0; i < 4; i++) {
      renderers.push(new WebGLVideoRenderer(mockCanvas, 'black', logger));
    }

    const frame: YUVFrameData = {
      width: 160,
      height: 90,
      yPlane: new Uint8Array(160 * 90),
      uPlane: new Uint8Array(80 * 45),
      vPlane: new Uint8Array(80 * 45),
    };

    for (const r of renderers) {
      r.renderYUV(frame);
    }

    // TimingPolicy.MAX_JS_CELLS is 2
    expect(WebGLContextPool.getJSCount()).toBe(2);
    expect(renderers[0].getRenderMode()).toBe('js-fallback');
    expect(renderers[1].getRenderMode()).toBe('js-fallback');
    expect(renderers[2].getRenderMode()).toBe('js-fallback-dropped');
    expect(renderers[3].getRenderMode()).toBe('js-fallback-dropped');

    for (const r of renderers) {
      r.destroy();
    }
    expect(WebGLContextPool.getJSCount()).toBe(0);
  });

  it('prevents visual resize flash for degenerate microscopic initial frames', () => {
    const renderer = new WebGLVideoRenderer(mockCanvas, 'black', logger);

    // Initialize with a real size frame
    const realFrame = {
      width: 1280,
      height: 720,
      close: vi.fn(),
    } as any;
    renderer.renderVideoFrame(realFrame);
    expect(mockCanvas.width).toBe(1280);
    expect(mockCanvas.height).toBe(720);

    // Now render a degenerate 16x16 frame
    const degenerateFrame = {
      width: 16,
      height: 16,
      close: vi.fn(),
    } as any;
    renderer.renderVideoFrame(degenerateFrame);

    // Canvas size should remain 1280x720, avoiding visual layout flash!
    expect(mockCanvas.width).toBe(1280);
    expect(mockCanvas.height).toBe(720);

    renderer.destroy();
  });
});
