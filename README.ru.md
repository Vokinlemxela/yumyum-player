[English](./README.md) · **Русский**

# Yum-yum Player 🎬

> Мультикодек-видеодвижок для браузера со сверхнизкой задержкой.
> Аппаратное декодирование (WebCodecs) + рендеринг на WebGL2, с plugin-швом для расширений.

**Yum-yum Player** проигрывает видео аппаратными декодерами браузера и рендерит
прямо в `<canvas>` через WebGL2. Поддерживает **HLS** «из коробки», содержит
самодостаточные демуксер и аудио-конвейер (никаких дополнительных файлов
размещать не нужно) и предоставляет небольшой публичный plugin-API для расширений.

Это **бесплатная часть проекта под лицензией MIT**.

## Пакеты

| Пакет | Описание |
|---|---|
| [`@yumyum-player/core`](./packages/player-sdk) | Движок: декодирование WebCodecs (H.264 / нативный HEVC / MJPEG), AAC-аудио, HLS (MPEG-TS и fMP4), рендеринг WebGL2, A/V-синхронизация и plugin-шов. |
| [`@yumyum-player/ui`](./packages/ui) | Переиспользуемая, лёгкая по зависимостям React-обвязка плеера `<YumYumPlayerView>` — таймлайн, громкость, скорость, PiP, fullscreen, хоткеи. |

## Быстрый старт

```bash
npm install @yumyum-player/core
```

```ts
import { YumYumPlayer } from '@yumyum-player/core';

const canvas = document.querySelector('canvas')!;
const player = new YumYumPlayer({ canvas });

await player.load('https://example.com/stream.m3u8'); // или 'mock://h264', чтобы попробовать без сервера
await player.play();
```

Полный API, конфигурация и гайд по написанию плагинов — в
[README ядра](./packages/player-sdk/README.ru.md).

## Коммерческие дополнения (Pro)

Два опциональных модуля с закрытым кодом подключаются через тот же публичный
plugin-шов — бесплатное ядро их не импортирует и полностью работает само по себе:

- **Универсальный программный HEVC/H.265** — декодирует HEVC там, где у браузера
  нет нативной поддержки (WASM).
- **Живой WebSocket-стриминг сверхнизкой задержки** — транспорт `ws://`/`wss://`
  (суб-200мс) + on-prem сервер перепаковки RTSP→MPEG-TS.

Распространяются отдельно по коммерческой лицензии. Без плагина стриминга
`ws://`-URL просто возвращают понятную ошибку «требуется streaming-дополнение».

## Разработка (монорепо)

```bash
npm install
npm run build      # сборка всех пакетов
npm test           # юнит-тесты
npm run typecheck  # проверка типов
```

Собрано на [Turborepo](https://turbo.build/). Требуется Node.js 18+.

## Лицензия

MIT — см. [LICENSE](./LICENSE).
