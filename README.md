**English** · [Русский](./README.ru.md)

# Yum-yum Player 🎬

> Ultra-low-latency, multi-codec video engine for the browser.
> Hardware decoding (WebCodecs) + WebGL2 rendering, with a plugin seam for extensions.
>
> Website: **[yumyum.video](https://yumyum.video)**

**Yum-yum Player** plays video using the browser's own hardware decoders and
renders straight to a `<canvas>` with WebGL2. It handles **HLS** out of the box,
ships a self-contained demuxer and audio pipeline (no extra files to host), and
exposes a small public plugin API for extensions.

This is the **free, MIT-licensed** part of the project.

## Packages

| Package | Description |
|---|---|
| [`@yumyum-player/core`](./packages/player-sdk) | The engine: WebCodecs decoding (H.264 / native HEVC / MJPEG), AAC audio, HLS (MPEG-TS & fMP4), WebGL2 rendering, A/V sync, and the plugin seam. |
| [`@yumyum-player/ui`](./packages/ui) | A reusable, framework-light React player shell `<YumYumPlayerView>` — timeline, volume, speed, PiP, fullscreen, hotkeys. |

## Quick start

```bash
npm install @yumyum-player/core
```

```ts
import { YumYumPlayer } from '@yumyum-player/core';

const canvas = document.querySelector('canvas')!;
const player = new YumYumPlayer({ canvas });

await player.load('https://example.com/stream.m3u8'); // or 'mock://h264' to try without a server
await player.play();
```

Full API, configuration and the plugin authoring guide are in the
[core README](./packages/player-sdk/README.md).

## Commercial add-ons (Pro)

Two optional closed-source modules attach through the same public plugin seam —
the free core never imports them and stays fully usable on its own:

- **Universal software HEVC/H.265** — decodes HEVC where the browser has no
  native support (WASM).
- **Ultra-low-latency live WebSocket streaming** — sub-200ms `ws://`/`wss://`
  transport plus an on-prem RTSP→MPEG-TS repackaging server.

They're distributed separately under a commercial license. Without the streaming
plugin, `ws://` URLs simply return a clear "requires the streaming add-on" error.

## Development (monorepo)

```bash
npm install
npm run build      # build all packages
npm test           # run unit tests
npm run typecheck  # type-check
```

Built with [Turborepo](https://turbo.build/). Requires Node.js 18+.

## License

MIT — see [LICENSE](./LICENSE).
