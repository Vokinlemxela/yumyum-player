**English** · [Русский](https://github.com/Vokinlemxela/yumyum-player/blob/main/packages/player-sdk/README.ru.md)

# @yumyum-player/core

> Ultra-low-latency, multi-codec video engine for the browser.
> Hardware decoding (WebCodecs) + WebGL2 rendering, with a plugin seam for extensions.

`@yumyum-player/core` is the **free, MIT-licensed core** of Yum-yum Player. It
decodes video with the browser's own hardware decoders (WebCodecs) and renders
straight to a `<canvas>` with WebGL2. It plays **HLS** out of the box and ships a
self-contained demuxer and audio pipeline — no extra files to host.

Everything documented here is **free and works standalone**. Optional commercial
add-ons (universal software HEVC, low-latency WebSocket streaming) attach through
the same public plugin seam described below — see **[Commercial add-ons](#commercial-add-ons)**.

---

## Install

```bash
npm install @yumyum-player/core
```

Self-contained: the MPEG-TS/fMP4 demuxer (Web Worker) and the PCM audio worklet
are inlined as Blobs at build time — nothing extra to copy or serve.

---

## Quick start

```ts
import { YumYumPlayer } from '@yumyum-player/core';

const canvas = document.querySelector('canvas')!;
const player = new YumYumPlayer({ canvas });

await player.load('https://example.com/stream.m3u8');
await player.play();
```

Try it with no server using the built-in synthetic streams:
`player.load('mock://h264')` (`mock://hevc`, `mock://mjpeg` also work).

---

## What the free core supports

| Area | Supported |
|---|---|
| Video (hardware, WebCodecs) | **H.264 / AVC**, **HEVC / H.265** *(where the browser decodes it natively)*, **MJPEG** |
| Audio | **AAC** — native `AudioDecoder` with a dual strategy (raw-frame + ADTS) and a Web Audio (`decodeAudioData`) fallback for browsers without native AAC; resampled PCM played through an `AudioWorklet` |
| Transport | **HLS** (MPEG-TS *and* fMP4 segments), `mock://` test streams |
| Adaptive (ABR) | multi-variant HLS / Main-Sub renditions with a closed-loop quality controller (throughput + decode-headroom, hysteresis), `auto`/`manual` modes and a grid-density ceiling |
| Rendering | **WebGL2** YUV shaders with a process-wide context budget (auto-demote to 2D / `lowPower` on big walls), automatic 2D-canvas fallback |
| A/V sync | single audio-mastered clock anchored to the audio hardware time (smooth, monotonic) with a dead-band + correction cooldown |
| Resilience | 24/7 live reconnect (unbounded, jittered backoff) + bounded HLS 404-resync, decoder hot-recovery & profile (SPS/PPS) switching, frame-queue backpressure, MPEG-TS sync-byte segment validation, live-edge recovery |

Demuxing of MPEG-TS/fMP4 (including extracting AAC audio and H.264/HEVC NAL
units) is **entirely in the free core**. Live WebSocket transport (`ws://`/`wss://`)
and universal software HEVC are **commercial add-ons**; without the streaming
plugin, `ws://` URLs are rejected with a clear upsell error.

---

## Configuration

```ts
new YumYumPlayer({
  canvas,                       // required HTMLCanvasElement
  volume: 0.8,                  // 0..1, default 1
  muted: false,                 // default false
  placeholderStyle: 'black',    // 'black' | 'no-signal' | 'none' — shown on signal gap
  logLevel: 'silent',           // 'silent' | 'error' | 'warn' | 'info' | 'debug'
  forceSoftwareHevc: false,     // prefer a registered 'h265-sw' decoder over native HEVC
  targetFps: 8,                 // skip frames to target specific fps, default: undefined (off)
  renderFps: 8,                 // restrict rendering loop frequency, default: undefined (off)
  lowPower: false,              // preset for economical grid tile settings (targetFps=8, renderFps=8, minimal buffer)
  plugins: [],                  // extension modules (see Plugins / Commercial add-ons)
});
```

---

## API

```ts
// Lifecycle
await player.load(url);        // HLS .m3u8, mock://h264|hevc|mjpeg (ws://, WHEP need plugins)
await player.play();
player.pause();
player.seek(seconds);          // no-op on live streams
player.destroy();              // releases worker, decoders, WebGL and audio

// Audio & Unlocking
player.setVolume(0.5);         // 0..1
player.mute(true);
await player.unlockAudio();    // explicitly unlock Web Audio context on a user gesture

// Speed & Low Power
player.setPlaybackRate(1.5);   // scales the master clock; audio is muted at ≠ 1×
player.getPlaybackRate();      // → number
player.setLowPower(true);      // dynamically toggle economical lowPower mode

// Quality & ABR (Adaptive Bitrate)
player.getQualityLevels();     // → QualityLevel[] { id, name, resolution, width, height, bitrate, kind: 'main' | 'sub' }
player.getActiveQuality();     // → active level ID or 'auto'
await player.setQuality('sub');// set quality level ID, alias ('main' | 'sub'), or 'auto'
player.getQualityMode();       // → 'auto' | 'manual'
player.setQualityMode('auto'); // set ABR mode
player.getMaxQualityKind();    // → 'main' | 'sub' | null
player.setMaxQualityKind('sub');// restrict ABR ceiling (e.g. for grid density limits)

// Time, Timeline & Coverage
player.getCurrentTime();       // seconds (master clock)
player.getDuration();          // seconds (Infinity for live)
player.getBufferedEnd();       // furthest buffered media position (s)
player.isBuffering();          // → boolean (true if playback is currently stalled waiting for data)
player.getWallClockTime();     // → number | null (absolute epoch ms from PROGRAM-DATE-TIME)
player.seekToWallClock(ms);    // → boolean (seek to absolute wall-clock epoch ms)
player.getCoverage();          // → WallClockRange { startMs, endMs, gaps: { startMs, endMs }[] } | null
player.getTelemetry();         // see fields below
player.state;                  // 'IDLE' | 'LOADING' | 'LOADED' | 'PLAYING' | 'PAUSED' | 'DESTROYED'

// Events
// Subscriptions support: 'play', 'pause', 'ended', 'error', 'waiting' (stalled),
// 'playing' (stalled recovery), 'qualitychange', 'signals', 'renderfallback'
player.on('qualitychange', (id) => console.log('Quality changed to:', id));
player.off(event, cb);
```

`getTelemetry()` returns:

```ts
{
  activeCodec, decodingStrategy,        // e.g. 'h264' | 'h265' | 'mjpeg', 'WebCodecs (GPU)' | 'WASM Fallback'
  playbackState, playbackRate,
  currentPTS, duration, bufferedEnd,
  renderedFrames, droppedFrames, decodedFrames,
  effectiveFps, queueLength,
  backpressureActive,
  throughputKbps,                       // network throughput in Kbps (EWMA)
  qualityMode,                          // 'auto' | 'manual'
  lastSwitchReason,                     // e.g. 'throughput_drop', 'low_power_restriction'
  maxAllowedKind,                       // 'main' | 'sub' | null
  renderMode,                           // rendering mode ('WebGL2' | '2D fallback')
  connectionState,                      // loader state ('connected' | 'reconnecting' | 'disconnected')
  lastError,
}
```

`MultiCodecPlayer` is exported as an alias of `YumYumPlayer` for back-compat.

### Codec hints

When an HLS/WS URL doesn't reveal the codec, append a hint so the right decoder
is selected. Use a **query parameter**, never a `#fragment` (WebSocket URLs
forbid fragments):

```
/live/stream.m3u8?codec=h265
```

`mock://hevc`, `mock://mjpeg`, `mock://h264` are detected automatically.

---

## Plugins (extension seam)

The player never hard-codes optional decoders or transports — they register
through a small, public plugin API. A plugin adds a **decoder** (under a codec
key) and/or a **loader** (under URL schemes):

```ts
import type { PlayerPlugin } from '@yumyum-player/core';

export function myPlugin(): PlayerPlugin {
  return {
    name: 'my-plugin',
    install(ctx) {
      // ctx.logger; deps passed to factories: { onFrame, onError, logger }
      ctx.registerDecoder('h265-sw', (deps) => new MyHevcDecoder(deps));
      ctx.registerLoader(['ws', 'wss'], (deps) => new MyLoader(deps));
    },
  };
}

new YumYumPlayer({ canvas, plugins: [myPlugin()] });
```

How routing works:

- **Decoders** are keyed by codec (`'h264'`, `'h265'`, `'mjpeg'`, `'aac'`). When
  native HEVC is unavailable (or `forceSoftwareHevc: true`), the core's HEVC
  decoder delegates to a decoder registered under `'h265-sw'`. The demuxer's
  routing key (`'h265'`) doesn't change — only *what* decodes the frames.
- **Loaders** are keyed by URL scheme. The core registers the HLS/`mock` loader;
  a plugin can register `ws`/`wss`. `load(url)` picks the loader by scheme.

Exported contracts: `PlayerPlugin`, `PluginContext`, `DecoderFactory`,
`DecoderDeps`, `IBaseDecoder`, `IStreamLoader`, `LoaderFactory`, `LoaderDeps`,
`LoaderKind`, `DecodedFrame`, `YUVFrameData`, `Segment`, `Logger`, `LogLevel`.

---

## Commercial add-ons (Pro)

Two optional closed-source modules attach through the plugin seam above. The free
core **never imports them** and stays fully usable without them; they're
distributed separately under a commercial license.

- **Universal software HEVC/H.265** — decodes HEVC where the browser has no
  native support, via a decoder registered under the `h265-sw` seam (also used
  when `forceSoftwareHevc: true`).
- **Ultra-low-latency live WebSocket streaming** — registers a `ws://`/`wss://`
  loader (plus an on-prem RTSP→MPEG-TS server). Without it, `ws://`/`wss://` URLs
  fail with a clear "requires the streaming add-on" upsell error.

The plugin API used to attach them is fully public — see **Plugins** above.

---

## Browser support

Requires `WebCodecs` (`VideoDecoder`/`AudioDecoder`), `Web Workers` and a canvas
(WebGL2 preferred, 2D fallback). Chrome/Edge 94+, recent Safari. Which codecs the
browser decodes natively varies by platform; in the free core **HEVC is
hardware/native-only** — use the `@yumyum-player/hevc-wasm` add-on for universal
HEVC. Browsers without native AAC fall back to Web Audio decoding automatically.

## License

MIT — see [LICENSE](./LICENSE).
