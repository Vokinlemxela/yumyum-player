[English](./README.md) · **Русский**

# @yumyum-player/ui

Переиспользуемая **React-обвязка плеера** для [Yum-yum Player](../player-sdk) —
`<YumYumPlayerView>` — с контролами уровня YouTube: таймлайн-скраббер, громкость,
скорость, автоплей/повтор, Picture-in-Picture, полноэкранный режим и хоткеи.
Также экспортирует небольшие UI-примитивы (`Button`, `Slider`, `Badge`,
`Spinner`, `Input`, `Select`).

Вью развязана с движком: вы передаёте фабрику `createPlayer(canvas)`, которая
возвращает любой объект, реализующий интерфейс `PlayerHandle` — `YumYumPlayer` из
ядра удовлетворяет ему структурно.

## Установка

```bash
npm install @yumyum-player/ui @yumyum-player/core
```

`react` и `react-dom` (18 или 19) — peer-зависимости.

## Использование

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
      // опционально:
      // accentColor="#00ff66"
      // playbackRate={1}
      // controls={{ pip: true, fullscreen: true }}
    />
  );
}
```

Экспортируемые типы: `YumYumPlayerViewProps`, `PlayerHandle`, `PlayerControlKey`.

## Лицензия

MIT — см. [LICENSE](../../LICENSE) репозитория.
