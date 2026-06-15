**English** · [Русский](./README.ru.md)

# @yumyum-player/ui

A reusable **React player shell** for [Yum-yum Player](../player-sdk) —
`<YumYumPlayerView>` — with YouTube-grade controls: timeline scrubber, volume,
playback speed, autoplay/loop, Picture-in-Picture, fullscreen and hotkeys. Also
exports small UI primitives (`Button`, `Slider`, `Badge`, `Spinner`, `Input`,
`Select`).

The view is decoupled from the engine: you pass a `createPlayer(canvas)` factory
that returns any object implementing the `PlayerHandle` interface — the core's
`YumYumPlayer` satisfies it structurally.

## Install

```bash
npm install @yumyum-player/ui @yumyum-player/core
```

`react` and `react-dom` (18 or 19) are peer dependencies.

## Usage

```tsx
import { YumYumPlayerView } from '@yumyum-player/ui';
import { YumYumPlayer } from '@yumyum-player/core';

export function Player() {
  return (
    <YumYumPlayerView
      createPlayer={async (canvas) => {
        const player = new YumYumPlayer({ canvas });
        await player.load('https://example.com/stream.m3u8');
        return { player, isLive: false };
      }}
      // optional:
      // accentColor="#00ff66"
      // playbackRate={1}
      // controls={{ pip: true, fullscreen: true }}
    />
  );
}
```

Exported types: `YumYumPlayerViewProps`, `PlayerHandle`, `PlayerControlKey`.

### Embedding in a host with its own controls (e.g. a VMS)

Set `chrome="none"` to render **no control buttons** — the view still shows the
canvas, intrinsic state overlays (loading spinner, error, "no video") and the
`overlayTopLeft/overlayTopRight/badges` slots. Get the live player via
`onReady` and drive playback yourself:

```tsx
<YumYumPlayerView
  createPlayer={createPlayer}
  chrome="none"
  onReady={(player) => { hostRef.current = player; /* player?.mute(true) ... */ }}
  overlayTopRight={<MyControlBar />}
/>
```

`onReady(player)` fires when the player is created and `onReady(null)` when it is
torn down/recreated. Do fullscreen on your own container element. (`chrome="minimal"`
exists for generic single-player embeds; hosts with their own UI use `none`.)

## License

MIT — see the repository [LICENSE](../../LICENSE).
