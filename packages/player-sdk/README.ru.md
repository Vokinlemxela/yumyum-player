[English](./README.md) · **Русский**

# @yumyum-player/core

> Мультикодек-видеодвижок для браузера со сверхнизкой задержкой.
> Аппаратное декодирование (WebCodecs) + рендеринг на WebGL2, с plugin-швом для расширений.

`@yumyum-player/core` — **бесплатное ядро Yum-yum Player под лицензией MIT**. Оно
декодирует видео аппаратными декодерами браузера (WebCodecs) и рендерит прямо в
`<canvas>` через WebGL2. Проигрывает **HLS** «из коробки» и содержит
самодостаточные демуксер и аудио-конвейер — никаких дополнительных файлов
размещать не нужно.

Всё, что описано здесь, **бесплатно и работает автономно**. Опциональные
коммерческие дополнения (универсальный программный HEVC, WS-стриминг низкой
задержки) подключаются через тот же публичный plugin-шов — см.
**[Коммерческие дополнения](#коммерческие-дополнения-pro)**.

---

## Установка

```bash
npm install @yumyum-player/core
```

Самодостаточно: демуксер MPEG-TS/fMP4 (Web Worker) и PCM-аудио-ворклет встроены
как Blob на этапе сборки — копировать/раздавать дополнительные файлы не нужно.

---

## Быстрый старт

```ts
import { YumYumPlayer } from '@yumyum-player/core';

const canvas = document.querySelector('canvas')!;
const player = new YumYumPlayer({ canvas });

await player.load('https://example.com/stream.m3u8');
await player.play();
```

Можно попробовать без сервера, на встроенных синтетических потоках:
`player.load('mock://h264')` (также работают `mock://hevc`, `mock://mjpeg`).

---

## Что поддерживает бесплатное ядро

| Область | Поддержка |
|---|---|
| Видео (аппаратно, WebCodecs) | **H.264 / AVC**, **HEVC / H.265** *(там, где браузер декодирует нативно)*, **MJPEG** |
| Аудио | **AAC** — нативный `AudioDecoder` с двойной стратегией (raw-frame + ADTS) и Web Audio (`decodeAudioData`) fallback для браузеров без нативного AAC; ресемплированный PCM играется через `AudioWorklet` |
| Транспорт | **HLS** (сегменты MPEG-TS *и* fMP4), тестовые потоки `mock://` |
| Рендеринг | **WebGL2** YUV-шейдеры, авто-фолбэк на 2D-canvas |
| A/V-синхронизация | мастер-часы привязаны к аппаратному времени аудио (гладкие, монотонные) |
| Устойчивость | hot-recovery декодера и смена профиля (SPS/PPS), backpressure очереди кадров, валидация сегментов по синхробайту MPEG-TS, восстановление к live-краю |

Демуксинг MPEG-TS/fMP4 (включая извлечение AAC-аудио и H.264/HEVC NAL-юнитов)
**полностью в бесплатном ядре**. Живой WebSocket-транспорт (`ws://`/`wss://`) и
универсальный программный HEVC — **коммерческие дополнения**; без плагина
стриминга `ws://`-URL отклоняются понятной ошибкой-апселлом.

---

## Конфигурация

```ts
new YumYumPlayer({
  canvas,                       // обязательный HTMLCanvasElement
  volume: 0.8,                  // 0..1, по умолчанию 1
  muted: false,                 // по умолчанию false
  placeholderStyle: 'black',    // 'black' | 'no-signal' | 'none' — при потере сигнала
  logLevel: 'silent',           // 'silent' | 'error' | 'warn' | 'info' | 'debug'
  forceSoftwareHevc: false,     // предпочесть зарегистрированный 'h265-sw' нативному HEVC
  plugins: [],                  // модули-расширения (см. Плагины / Коммерческие дополнения)
});
```

---

## API

```ts
// Жизненный цикл
await player.load(url);        // HLS .m3u8, mock://h264|hevc|mjpeg (ws:// требует плагин)
await player.play();
player.pause();
player.seek(seconds);          // no-op на live-потоках
player.destroy();              // освобождает worker, декодеры, WebGL и аудио

// Аудио
player.setVolume(0.5);         // 0..1
player.mute(true);

// Скорость
player.setPlaybackRate(1.5);   // масштабирует мастер-часы; на ≠ 1× звук приглушается
player.getPlaybackRate();      // → number

// Время и информация
player.getCurrentTime();       // секунды (мастер-часы)
player.getDuration();          // секунды (Infinity для live)
player.getBufferedEnd();       // самая дальняя забуференная позиция (с)
player.getTelemetry();         // поля ниже
player.state;                  // 'IDLE' | 'LOADING' | 'LOADED' | 'PLAYING' | 'PAUSED' | 'DESTROYED'

// События
player.on('play' | 'pause' | 'ended' | 'error', cb);
player.off(event, cb);
```

`getTelemetry()` возвращает:

```ts
{
  activeCodec, decodingStrategy,        // напр. 'h265', 'hardware' | 'software'
  playbackState, playbackRate,
  currentPTS, duration, bufferedEnd,
  renderedFrames, droppedFrames, queueLength,
  backpressureActive,
}
```

`MultiCodecPlayer` экспортируется как алиас `YumYumPlayer` для обратной совместимости.

### Подсказки кодека

Если HLS/WS-URL не раскрывает кодек, добавьте подсказку, чтобы выбрать нужный
декодер. Используйте **query-параметр**, а не `#fragment` (WebSocket-URL
запрещают фрагменты):

```
/live/stream.m3u8?codec=h265
```

`mock://hevc`, `mock://mjpeg`, `mock://h264` определяются автоматически.

---

## Плагины (шов расширения)

Плеер не «зашивает» опциональные декодеры/транспорты — они регистрируются через
небольшой публичный plugin-API. Плагин добавляет **декодер** (под ключом кодека)
и/или **загрузчик** (под схемами URL):

```ts
import type { PlayerPlugin } from '@yumyum-player/core';

export function myPlugin(): PlayerPlugin {
  return {
    name: 'my-plugin',
    install(ctx) {
      // ctx.logger; в фабрики передаются deps: { onFrame, onError, logger }
      ctx.registerDecoder('h265-sw', (deps) => new MyHevcDecoder(deps));
      ctx.registerLoader(['ws', 'wss'], (deps) => new MyLoader(deps));
    },
  };
}

new YumYumPlayer({ canvas, plugins: [myPlugin()] });
```

Как работает маршрутизация:

- **Декодеры** ключуются по кодеку (`'h264'`, `'h265'`, `'mjpeg'`, `'aac'`). Когда
  нативный HEVC недоступен (или `forceSoftwareHevc: true`), HEVC-декодер ядра
  делегирует декодеру, зарегистрированному под `'h265-sw'`. Ключ маршрутизации
  демуксера (`'h265'`) не меняется — меняется только то, *чем* декодируются кадры.
- **Загрузчики** ключуются по схеме URL. Ядро регистрирует загрузчик HLS/`mock`;
  плагин может зарегистрировать `ws`/`wss`. `load(url)` выбирает загрузчик по схеме.

Экспортируемые контракты: `PlayerPlugin`, `PluginContext`, `DecoderFactory`,
`DecoderDeps`, `IBaseDecoder`, `IStreamLoader`, `LoaderFactory`, `LoaderDeps`,
`LoaderKind`, `DecodedFrame`, `YUVFrameData`, `Segment`, `Logger`, `LogLevel`.

---

## Коммерческие дополнения (Pro)

Два опциональных модуля с закрытым кодом подключаются через тот же plugin-шов.
Бесплатное ядро **их не импортирует** и полностью работает без них;
распространяются отдельно по коммерческой лицензии.

- **Универсальный программный HEVC/H.265** — декодирует HEVC там, где у браузера
  нет нативной поддержки, через декодер, зарегистрированный под швом `h265-sw`
  (также используется при `forceSoftwareHevc: true`).
- **Живой WebSocket-стриминг сверхнизкой задержки** — регистрирует загрузчик
  `ws://`/`wss://` (+ on-prem сервер RTSP→MPEG-TS). Без него `ws://`/`wss://`-URL
  падают с понятной ошибкой «требуется streaming-дополнение».

Plugin-API для их подключения полностью публичный — см. раздел **Плагины** выше.

---

## Поддержка браузеров

Требуются `WebCodecs` (`VideoDecoder`/`AudioDecoder`), `Web Workers` и canvas
(предпочтительно WebGL2, есть 2D-фолбэк). Chrome/Edge 94+, свежий Safari. Какие
кодеки браузер декодирует нативно — зависит от платформы; в бесплатном ядре
**HEVC только аппаратный/нативный** — для универсального HEVC используйте
дополнение `@yumyum-player/hevc-wasm`. Браузеры без нативного AAC автоматически
переходят на Web Audio-декодирование.

## Лицензия

MIT — см. [LICENSE](./LICENSE).
