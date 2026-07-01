import { Logger } from '../utils/Logger.js';
import { WebGLContextPool } from './WebGLContextPool.js';

export interface YUVFrameData {
  width: number;
  height: number;
  yPlane: Uint8Array;
  uPlane: Uint8Array;
  vPlane: Uint8Array;
}

const THEME = {
  COLORS: {
    BLACK: '#000000',
    BACKGROUND: '#050505',
    BORDER: 'rgba(220, 20, 60, 0.15)',
    CRIMSON: '#DC143C',
    TEXT_MUTED: 'rgba(255, 255, 255, 0.35)',
    PULSE_BASE: '220, 20, 60',
  },
  FONTS: {
    WARNING: 'bold 13px monospace',
    SUBTITLE: '9px monospace',
  }
} as const;

export class WebGLVideoRenderer {
  private gl: WebGL2RenderingContext | null = null;
  private canvas2dCtx: CanvasRenderingContext2D | null = null;
  private yuvProgram: WebGLProgram | null = null;
  private rgbaProgram: WebGLProgram | null = null;
  private vertexShader: WebGLShader | null = null;
  private yuvFragmentShader: WebGLShader | null = null;
  private rgbaFragmentShader: WebGLShader | null = null;
  private yTexture: WebGLTexture | null = null;
  private uTexture: WebGLTexture | null = null;
  private vTexture: WebGLTexture | null = null;
  private rgbaTexture: WebGLTexture | null = null;
  private buffer: WebGLBuffer | null = null;
  
  private lastWidth = 0;
  private lastHeight = 0;
  private lastRgbaWidth = 0;
  private lastRgbaHeight = 0;
  private isFallbackMode = false;
  private lastPlaceholderLogTime = 0;
  private lastYuvLogTime = 0;
  private cachedImageData: ImageData | null = null;

  // Context Pool & observablity properties
  private hasGLSlot = false;
  private hasJSSlot = false;
  private isOverflow = false;
  private currentRenderMode: 'webgl' | '2d-fallback' | '2d-overflow' | 'js-fallback' | 'js-fallback-dropped' = 'webgl';

  public onFallback?: (reason: 'overflow' | 'lost' | 'unavailable') => void;

  // Cached locations to prevent dynamically querying them on the hot path
  private yuvLocations = {
    aPos: -1,
    aTex: -1,
    uY: null as WebGLUniformLocation | null,
    uU: null as WebGLUniformLocation | null,
    uV: null as WebGLUniformLocation | null,
  };
  private rgbaLocations = {
    aPos: -1,
    aTex: -1,
    uRgba: null as WebGLUniformLocation | null,
  };

  constructor(
    private canvas: HTMLCanvasElement,
    private placeholderStyle: 'black' | 'no-signal' | 'none' = 'black',
    private logger: Logger
  ) {
    canvas.addEventListener('webglcontextlost', this.handleContextLost);
    canvas.addEventListener('webglcontextrestored', this.handleContextRestored);
  }

  private handleContextLost = (e: Event) => {
    e.preventDefault();
    this.logger.warn('WebGL context lost.');
    this.isFallbackMode = true;
    this.onFallback?.('lost');
    if (this.hasGLSlot) {
      WebGLContextPool.releaseGLSlot(this);
      this.hasGLSlot = false;
    }
  };

  private handleContextRestored = () => {
    this.logger.debug('WebGL context restored. Re-acquiring GL slot.');
    this.hasGLSlot = WebGLContextPool.acquireGLSlot(this);
    
    if (this.hasGLSlot) {
      if (this.hasJSSlot) {
        WebGLContextPool.releaseJSSlot(this);
        this.hasJSSlot = false;
      }
      this.isFallbackMode = false;
      this.isOverflow = false;
      this.currentRenderMode = 'webgl';
      this.gl = null;
      this.yuvProgram = null;
      this.rgbaProgram = null;
      this.vertexShader = null;
      this.yuvFragmentShader = null;
      this.rgbaFragmentShader = null;
      this.buffer = null;
      this.yTexture = null;
      this.uTexture = null;
      this.vTexture = null;
      this.rgbaTexture = null;
      this.lastRgbaWidth = 0;
      this.lastRgbaHeight = 0;
    } else {
      this.isFallbackMode = true;
      this.isOverflow = true;
      this.currentRenderMode = '2d-overflow';
      this.onFallback?.('overflow');
    }
  };

  private initWebGL() {
    const gl = this.gl!;

    // Compile Vertex Shader
    const vsSource = `#version 300 es
      in vec2 a_position;
      in vec2 a_texCoord;
      out vec2 v_texCoord;
      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        v_texCoord = a_texCoord;
      }
    `;
    const vs = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(vs, vsSource);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      this.logger.error('Vertex shader compile error:', gl.getShaderInfoLog(vs));
      this.fallbackTo2D();
      return;
    }
    this.vertexShader = vs;

    // Compile YUV Fragment Shader (BT.709 Color conversion matrix)
    const yuvFsSource = `#version 300 es
      precision mediump float;
      in vec2 v_texCoord;
      out vec4 fragColor;
      
      uniform sampler2D u_yTexture;
      uniform sampler2D u_uTexture;
      uniform sampler2D u_vTexture;
      
      void main() {
        float y = texture(u_yTexture, v_texCoord).r;
        float u = texture(u_uTexture, v_texCoord).r;
        float v = texture(u_vTexture, v_texCoord).r;
        
        // Limited range adjustments (standard BT.709 video range 16-235)
        y = (y - 16.0/255.0) * (255.0/219.0);
        u = (u - 128.0/255.0) * (255.0/224.0);
        v = (v - 128.0/255.0) * (255.0/224.0);
        
        // BT.709 conversion matrix
        vec3 rgb;
        rgb.r = y + 1.5748 * v;
        rgb.g = y - 0.1873 * u - 0.4681 * v;
        rgb.b = y + 1.8556 * u;
        
        fragColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
      }
    `;
    const yuvFs = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(yuvFs, yuvFsSource);
    gl.compileShader(yuvFs);
    if (!gl.getShaderParameter(yuvFs, gl.COMPILE_STATUS)) {
      this.logger.error('YUV Fragment shader compile error:', gl.getShaderInfoLog(yuvFs));
      this.fallbackTo2D();
      return;
    }
    this.yuvFragmentShader = yuvFs;

    // Compile RGBA Fragment Shader
    const rgbaFsSource = `#version 300 es
      precision mediump float;
      in vec2 v_texCoord;
      out vec4 fragColor;
      
      uniform sampler2D u_rgbaTexture;
      
      void main() {
        fragColor = texture(u_rgbaTexture, v_texCoord);
      }
    `;
    const rgbaFs = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(rgbaFs, rgbaFsSource);
    gl.compileShader(rgbaFs);
    if (!gl.getShaderParameter(rgbaFs, gl.COMPILE_STATUS)) {
      this.logger.error('RGBA Fragment shader compile error:', gl.getShaderInfoLog(rgbaFs));
      this.fallbackTo2D();
      return;
    }
    this.rgbaFragmentShader = rgbaFs;

    // Link YUV Program
    this.yuvProgram = gl.createProgram()!;
    gl.attachShader(this.yuvProgram, vs);
    gl.attachShader(this.yuvProgram, yuvFs);
    gl.linkProgram(this.yuvProgram);
    if (!gl.getProgramParameter(this.yuvProgram, gl.LINK_STATUS)) {
      this.logger.error('YUV Shader linking error:', gl.getProgramInfoLog(this.yuvProgram));
      this.fallbackTo2D();
      return;
    }

    // Link RGBA Program
    this.rgbaProgram = gl.createProgram()!;
    gl.attachShader(this.rgbaProgram, vs);
    gl.attachShader(this.rgbaProgram, rgbaFs);
    gl.linkProgram(this.rgbaProgram);
    if (!gl.getProgramParameter(this.rgbaProgram, gl.LINK_STATUS)) {
      this.logger.error('RGBA Shader linking error:', gl.getProgramInfoLog(this.rgbaProgram));
      this.fallbackTo2D();
      return;
    }

    // Setup full-screen quad (flipping texture coordinate V-axis for standard video decoding output)
    const vertices = new Float32Array([
      // position (x, y)  texCoord (u, v)
      -1.0, -1.0,         0.0, 1.0,
       1.0, -1.0,         1.0, 1.0,
      -1.0,  1.0,         0.0, 0.0,
       1.0,  1.0,         1.0, 0.0,
    ]);

    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    // Setup uniform and attribute locations
    this.yuvLocations.aPos = gl.getAttribLocation(this.yuvProgram, 'a_position');
    this.yuvLocations.aTex = gl.getAttribLocation(this.yuvProgram, 'a_texCoord');
    this.yuvLocations.uY = gl.getUniformLocation(this.yuvProgram, 'u_yTexture');
    this.yuvLocations.uU = gl.getUniformLocation(this.yuvProgram, 'u_uTexture');
    this.yuvLocations.uV = gl.getUniformLocation(this.yuvProgram, 'u_vTexture');

    this.rgbaLocations.aPos = gl.getAttribLocation(this.rgbaProgram, 'a_position');
    this.rgbaLocations.aTex = gl.getAttribLocation(this.rgbaProgram, 'a_texCoord');
    this.rgbaLocations.uRgba = gl.getUniformLocation(this.rgbaProgram, 'u_rgbaTexture');

    gl.useProgram(this.yuvProgram);
    gl.uniform1i(this.yuvLocations.uY, 0);
    gl.uniform1i(this.yuvLocations.uU, 1);
    gl.uniform1i(this.yuvLocations.uV, 2);

    gl.useProgram(this.rgbaProgram);
    gl.uniform1i(this.rgbaLocations.uRgba, 0);
  }

  private fallbackTo2D() {
    this.gl = null;
    this.canvas2dCtx = this.canvas.getContext('2d');
    this.isFallbackMode = true;
  }

  /**
   * Detects (once per page) whether WebGL2 actually works — context creation AND
   * shader compilation — using a throwaway canvas, so probing never poisons a
   * real render canvas. Returns false on browsers/GPUs where WebGL2 is missing
   * or broken (e.g. context exhaustion, disabled hardware acceleration).
   */
  private static _webgl2Usable: boolean | null = null;
  private static webgl2Usable(): boolean {
    if (WebGLVideoRenderer._webgl2Usable !== null) return WebGLVideoRenderer._webgl2Usable;
    let ok = false;
    try {
      if (typeof document !== 'undefined') {
        const probe = document.createElement('canvas');
        const gl = probe.getContext('webgl2');
        if (gl) {
          const vs = gl.createShader(gl.VERTEX_SHADER);
          if (vs) {
            gl.shaderSource(vs, '#version 300 es\nvoid main(){ gl_Position = vec4(0.0); }');
            gl.compileShader(vs);
            ok = !!gl.getShaderParameter(vs, gl.COMPILE_STATUS);
          }
          const lose = gl.getExtension('WEBGL_lose_context');
          if (lose) lose.loseContext();
        }
      }
    } catch {
      ok = false;
    }
    WebGLVideoRenderer._webgl2Usable = ok;
    return ok;
  }

  private allocateTextures(width: number, height: number) {
    const gl = this.gl!;

    // Clean up old textures if size changed
    this.cleanupTextures();

    // Helper to create R8 texture
    const createTexture = (w: number, h: number) => {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return tex;
    };

    this.yTexture = createTexture(width, height);
    this.uTexture = createTexture(width >> 1, height >> 1);
    this.vTexture = createTexture(width >> 1, height >> 1);

    this.lastWidth = width;
    this.lastHeight = height;
  }

  private cleanupTextures() {
    if (this.gl) {
      if (this.yTexture) this.gl.deleteTexture(this.yTexture);
      if (this.uTexture) this.gl.deleteTexture(this.uTexture);
      if (this.vTexture) this.gl.deleteTexture(this.vTexture);
      if (this.rgbaTexture) this.gl.deleteTexture(this.rgbaTexture);
      this.yTexture = null;
      this.uTexture = null;
      this.vTexture = null;
      this.rgbaTexture = null;
      this.lastRgbaWidth = 0;
      this.lastRgbaHeight = 0;
    }
  }

  public getRenderMode(): 'webgl' | '2d-fallback' | '2d-overflow' | 'js-fallback' | 'js-fallback-dropped' {
    return this.currentRenderMode;
  }

  private tryInitWebGL(): boolean {
    if (this.gl || this.canvas2dCtx) {
      return !!this.gl;
    }

    if (WebGLVideoRenderer.webgl2Usable()) {
      this.hasGLSlot = WebGLContextPool.acquireGLSlot(this);
      if (this.hasGLSlot) {
        this.gl = this.canvas.getContext('webgl2', {
          alpha: false,
          depth: false,
          stencil: false,
          antialias: false,
          premultipliedAlpha: false,
          preserveDrawingBuffer: true,
          powerPreference: 'high-performance',
        });
      } else {
        this.logger.warn('WebGL2 context limit exceeded; forcing 2D overflow mode.');
        this.isOverflow = true;
        this.isFallbackMode = true;
        this.currentRenderMode = '2d-overflow';
        this.onFallback?.('overflow');
      }
    }

    if (this.gl) {
      if (this.hasJSSlot) {
        WebGLContextPool.releaseJSSlot(this);
        this.hasJSSlot = false;
      }
      this.initWebGL();
      this.currentRenderMode = 'webgl';
      return true;
    } else {
      if (this.hasGLSlot) {
        WebGLContextPool.releaseGLSlot(this);
        this.hasGLSlot = false;
      }
      if (!this.isOverflow) {
        this.logger.warn('WebGL2 unavailable; rendering via 2D canvas.');
        this.currentRenderMode = '2d-fallback';
        this.onFallback?.('unavailable');
      } else {
        this.currentRenderMode = '2d-overflow';
      }
      this.canvas2dCtx = this.canvas.getContext('2d');
      this.isFallbackMode = true;
      return false;
    }
  }

  public renderYUV(frame: YUVFrameData) {
    this.tryInitWebGL();

    if (this.isFallbackMode || this.canvas2dCtx) {
      if (!this.canvas2dCtx) {
        // Canvas cannot provide a 2D context (already webgl-bound); skip safely.
        if (performance.now() - this.lastYuvLogTime > 4000) {
          this.logger.warn('No 2D context available for YUV rendering; frame dropped.');
          this.lastYuvLogTime = performance.now();
        }
        this.currentRenderMode = 'js-fallback-dropped';
        return;
      }

      // Check JS per-pixel fallback cell limit
      if (!this.hasJSSlot) {
        this.hasJSSlot = WebGLContextPool.acquireJSSlot(this);
      }

      if (!this.hasJSSlot) {
        if (performance.now() - this.lastYuvLogTime > 4000) {
          this.logger.warn('JS per-pixel YUV rendering limit exceeded; frame dropped.');
          this.lastYuvLogTime = performance.now();
        }
        this.currentRenderMode = 'js-fallback-dropped';
        return;
      }

      this.currentRenderMode = 'js-fallback';
      const { width, height, yPlane, uPlane, vPlane } = frame;
      
      const now = performance.now();
      if (now - this.lastYuvLogTime > 4000) {
        this.logger.debug(`Rendering YUV via optimized 2D fallback software converter (${width}x${height})`);
        this.lastYuvLogTime = now;
      }

      // Adjust canvas resolution if video dimensions changed
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
      }

      // Cache ImageData when video dimensions are identical to avoid massive GC churn
      if (!this.cachedImageData || this.cachedImageData.width !== width || this.cachedImageData.height !== height) {
        this.cachedImageData = this.canvas2dCtx!.createImageData(width, height);
      }
      const imgData = this.cachedImageData;
      const rgba = imgData.data;

      const chromaWidth = width >> 1;
      let rgbaIdx = 0;
      for (let y = 0; y < height; y++) {
        const yRow = y * width;
        const chromaRow = (y >> 1) * chromaWidth;
        
        for (let x = 0; x < width; x++) {
          const yVal = yPlane[yRow + x];
          const uVal = uPlane[chromaRow + (x >> 1)] - 128;
          const vVal = vPlane[chromaRow + (x >> 1)] - 128;

          // Fast integer approximation of YUV to RGB (BT.709 — matches WebGL shader)
          const r = yVal + ((vVal * 1613) >> 10);
          const g = yVal - ((uVal * 192 + vVal * 479) >> 10);
          const b = yVal + ((uVal * 1901) >> 10);

          rgba[rgbaIdx]     = r < 0 ? 0 : r > 255 ? 255 : r;
          rgba[rgbaIdx + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
          rgba[rgbaIdx + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
          rgba[rgbaIdx + 3] = 255; // Alpha
          rgbaIdx += 4;
        }
      }

      this.canvas2dCtx!.putImageData(imgData, 0, 0);
      return;
    }

    this.currentRenderMode = 'webgl';
    const gl = this.gl!;
    const { width, height, yPlane, uPlane, vPlane } = frame;

    // Adjust canvas resolution if video dimensions changed
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }

    if (this.lastWidth !== width || this.lastHeight !== height) {
      this.allocateTextures(width, height);
    }

    gl.viewport(0, 0, width, height);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Bind shaders
    gl.useProgram(this.yuvProgram);

    // Upload Y Plane
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.yTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RED, gl.UNSIGNED_BYTE, yPlane);

    // Upload U Plane
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.uTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width >> 1, height >> 1, gl.RED, gl.UNSIGNED_BYTE, uPlane);

    // Upload V Plane
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.vTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width >> 1, height >> 1, gl.RED, gl.UNSIGNED_BYTE, vPlane);

    // Bind buffer and setup attributes
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);

    gl.enableVertexAttribArray(this.yuvLocations.aPos);
    gl.vertexAttribPointer(this.yuvLocations.aPos, 2, gl.FLOAT, false, 16, 0);

    gl.enableVertexAttribArray(this.yuvLocations.aTex);
    gl.vertexAttribPointer(this.yuvLocations.aTex, 2, gl.FLOAT, false, 16, 8);

    // Draw
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private renderCount = 0;

  public renderVideoFrame(frame: VideoFrame | ImageBitmap) {
    this.renderCount++;
    const isThrottle = this.renderCount % 60 === 1;

    this.tryInitWebGL();

    const width = 'displayWidth' in frame ? frame.displayWidth : frame.width;
    const height = 'displayHeight' in frame ? frame.displayHeight : frame.height;

    if (isThrottle) {
      this.logger.debug(`renderVideoFrame #${this.renderCount} | Dim: ${width}x${height} | Canvas: ${this.canvas.width}x${this.canvas.height} | WebGL: ${!!this.gl}`);
    }

    // Maintain aspect ratio, with a minimum display size to prevent microscopic canvas sizing
    let targetWidth = width;
    let targetHeight = height;
    const isDegenerate = width <= 16 && height <= 16;
    if (isDegenerate) {
      if (this.canvas.width > 0 && this.canvas.height > 0) {
        targetWidth = this.canvas.width;
        targetHeight = this.canvas.height;
      } else {
        targetWidth = 640;
        targetHeight = 360;
      }
    }

    if (this.canvas.width !== targetWidth || this.canvas.height !== targetHeight) {
      this.canvas.width = targetWidth;
      this.canvas.height = targetHeight;
      this.logger.debug(`Adjusted canvas size to: ${targetWidth}x${targetHeight}`);
    }

    // If WebGL is active and not lost, upload and render VideoFrame via GPU texture
    if (this.gl && this.rgbaProgram && !this.isFallbackMode) {
      this.currentRenderMode = 'webgl';
      const gl = this.gl;
      gl.viewport(0, 0, targetWidth, targetHeight);
      gl.clear(gl.COLOR_BUFFER_BIT);

      // Lazily create RGBA texture and allocate immutable storage if size changed
      if (!this.rgbaTexture || this.lastRgbaWidth !== width || this.lastRgbaHeight !== height) {
        if (this.rgbaTexture) {
          gl.deleteTexture(this.rgbaTexture);
        }
        this.rgbaTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.rgbaTexture);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        this.lastRgbaWidth = width;
        this.lastRgbaHeight = height;
      }

      gl.useProgram(this.rgbaProgram);

      // Upload RGBA frame using zero-reallocation sub-image updates
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.rgbaTexture);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, frame);

      // Setup attributes
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      
      gl.enableVertexAttribArray(this.rgbaLocations.aPos);
      gl.vertexAttribPointer(this.rgbaLocations.aPos, 2, gl.FLOAT, false, 16, 0);

      gl.enableVertexAttribArray(this.rgbaLocations.aTex);
      gl.vertexAttribPointer(this.rgbaLocations.aTex, 2, gl.FLOAT, false, 16, 8);

      // Draw quad
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return;
    }

    if (this.canvas2dCtx) {
      this.currentRenderMode = this.isOverflow ? '2d-overflow' : '2d-fallback';
      try {
        this.canvas2dCtx.drawImage(frame, 0, 0, targetWidth, targetHeight);
      } catch (err) {
        this.logger.error('drawImage failed:', err);
      }
    } else {
      if (isThrottle) {
        this.logger.warn('Cannot render frame: canvas2dCtx and WebGL are both null');
      }
    }
  }

  /**
   * Render the gap placeholder. Note: the pulse animation is synchronized with
   * performance.now(), meaning it naturally freezes if the animation frame loop
   * (requestAnimationFrame) is stalled. This is a deliberate resource-hygiene
   * design choice to prevent unnecessary CPU/timer wakeups when the stream is not ticking.
   */
  public drawGapPlaceholder() {
    if (this.placeholderStyle === 'none') {
      return;
    }

    const now = performance.now();
    if (now - this.lastPlaceholderLogTime > 3000) {
      this.logger.debug(`Gap placeholder active. Style: ${this.placeholderStyle} | WebGL active: ${!!this.gl}`);
      this.lastPlaceholderLogTime = now;
    }

    // 1. If WebGL context is active, clear to solid black.
    // Text drawing in WebGL is highly complex, and pure black is a universally clean, zero-overhead fallback.
    if (this.gl) {
      const gl = this.gl;
      gl.viewport(0, 0, this.canvas.width || 640, this.canvas.height || 360);
      gl.clearColor(0.0, 0.0, 0.0, 1.0); // Pure black
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }

    // 2. 2D Canvas rendering — only if a 2D context ALREADY exists. Do NOT
    // acquire one here: the placeholder runs before the first frame, and a
    // canvas that gets a 2D context can never return a webgl2 context, which
    // would force the slow software YUV path forever. Let the first real frame
    // choose the context (webgl2 for YUV).
    const ctx = this.canvas2dCtx;
    if (!ctx) return;
    
    const w = this.canvas.width || 640;
    const h = this.canvas.height || 360;
    
    if (this.placeholderStyle === 'black') {
      // Clean, solid black frame
      ctx.fillStyle = THEME.COLORS.BLACK;
      ctx.fillRect(0, 0, w, h);
      return;
    }

    // Otherwise, draw the elegant 'no-signal' brutalist cyberpunk overlay
    // 1. Draw elegant dark background
    ctx.fillStyle = THEME.COLORS.BACKGROUND;
    ctx.fillRect(0, 0, w, h);
    
    // 2. Draw subtle dark red border and grid lines
    ctx.strokeStyle = THEME.COLORS.BORDER;
    ctx.lineWidth = 1;
    ctx.strokeRect(10, 10, w - 20, h - 20);
    
    ctx.beginPath();
    ctx.moveTo(15, 15);
    ctx.lineTo(w - 15, h - 15);
    ctx.moveTo(w - 15, 15);
    ctx.lineTo(15, h - 15);
    ctx.stroke();
    
    // 3. Draw a pulsing red warning indicator
    const pulse = 0.5 + Math.abs(Math.sin(performance.now() / 300)) * 0.5;
    ctx.fillStyle = `rgba(${THEME.COLORS.PULSE_BASE}, ${pulse})`;
    ctx.beginPath();
    ctx.arc(w / 2, h / 2 - 20, 8, 0, Math.PI * 2);
    ctx.fill();
    
    // 4. Draw high-tech minimalist text
    ctx.fillStyle = THEME.COLORS.CRIMSON;
    ctx.font = THEME.FONTS.WARNING;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('NO SIGNAL / FRAME DROPPED', w / 2, h / 2 + 15);
    
    ctx.fillStyle = THEME.COLORS.TEXT_MUTED;
    ctx.font = THEME.FONTS.SUBTITLE;
    ctx.fillText('AWAITING NEXT KEYFRAME...', w / 2, h / 2 + 35);
  }

  public destroy() {
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored);

    if (this.hasGLSlot) {
      WebGLContextPool.releaseGLSlot(this);
      this.hasGLSlot = false;
    }
    if (this.hasJSSlot) {
      WebGLContextPool.releaseJSSlot(this);
      this.hasJSSlot = false;
    }

    this.cleanupTextures();
    if (this.gl) {
      const gl = this.gl;
      if (this.buffer) {
        gl.deleteBuffer(this.buffer);
        this.buffer = null;
      }
      if (this.vertexShader) {
        gl.deleteShader(this.vertexShader);
        this.vertexShader = null;
      }
      if (this.yuvFragmentShader) {
        gl.deleteShader(this.yuvFragmentShader);
        this.yuvFragmentShader = null;
      }
      if (this.rgbaFragmentShader) {
        gl.deleteShader(this.rgbaFragmentShader);
        this.rgbaFragmentShader = null;
      }
      if (this.yuvProgram) {
        gl.deleteProgram(this.yuvProgram);
        this.yuvProgram = null;
      }
      if (this.rgbaProgram) {
        gl.deleteProgram(this.rgbaProgram);
        this.rgbaProgram = null;
      }
      const ext = gl.getExtension('WEBGL_lose_context');
      if (ext) {
        ext.loseContext();
      }
    }
    this.gl = null;
    this.canvas2dCtx = null;
    this.cachedImageData = null;
  }
}
