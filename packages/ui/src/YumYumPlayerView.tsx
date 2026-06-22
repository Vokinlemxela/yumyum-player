"use client";
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, Slider, Spinner } from './index.js';

// ====================================================================
// YumYumPlayerView — reusable, YouTube-style chrome around a YumYumPlayer
// instance. The player is created by the host via the `createPlayer`
// callback (so this component stays free of any streaming/RTSP/plugin
// knowledge), and this view owns the <canvas>, the control bar, the
// timeline scrubber, volume, speed, autoplay (persisted to localStorage),
// fullscreen, Picture-in-Picture, keyboard shortcuts and auto-hide.
//
// All styling is self-contained (inline styles + a single injected
// stylesheet) so the component renders correctly in any host app, with
// or without Tailwind — it does NOT rely on the host's CSS pipeline.
// ====================================================================

/**
 * Minimal structural contract of the player this view drives. The real
 * `YumYumPlayer` from `@yumyum-player/core` satisfies it structurally, so the
 * UI package needs no build-time dependency on core.
 */
export interface PlayerHandle {
  play(): Promise<void>;
  pause(): void;
  seek(timeSeconds: number): void;
  setVolume(volume: number): void;
  mute(isMuted: boolean): void;
  setPlaybackRate(rate: number): void;
  getPlaybackRate(): number;
  getCurrentTime(): number;
  getDuration(): number;
  getTelemetry(): {
    currentPTS: number;
    duration: number;
    bufferedEnd: number;
    playbackState: string;
    playbackRate: number;
    renderedFrames: number;
    activeCodec: string;
    queueLength: number;
    decodedFrames?: number;
    effectiveFps?: number;
  };
  on(event: string, callback: (...args: unknown[]) => void): void;
  off(event: string, callback: (...args: unknown[]) => void): void;
  unlockAudio?(): Promise<void>;
  destroy(): void;
}

export type PlayerControlKey =
  | 'play' | 'volume' | 'timeline' | 'time' | 'speed' | 'settings' | 'pip' | 'fullscreen';

export interface YumYumPlayerViewProps {
  /**
   * Construct + load a player against the given canvas. Resolves once the
   * stream is loaded; `isLive` disables seeking and shows a LIVE badge.
   */
  createPlayer: (canvas: HTMLCanvasElement) => Promise<{ player: PlayerHandle; isLive: boolean }>;
  /** Accent color for the progress bar, handle and active controls. */
  accentColor?: string;
  /** Controlled playback speed: when this prop changes it is applied live. */
  playbackRate?: number;
  /** Toggle visibility of individual controls. Omitted keys default to visible. */
  controls?: Partial<Record<PlayerControlKey, boolean>>;
  /** Milliseconds of mouse inactivity before controls auto-hide while playing. */
  autoHideDelay?: number;
  /** localStorage namespace for persisted volume/muted/rate/autoplay/loop. */
  persistKeyPrefix?: string;
  lang?: 'ru' | 'en';
  className?: string;
  overlayTopLeft?: React.ReactNode;
  overlayTopRight?: React.ReactNode;
  badges?: { label: string; variant?: 'rec' | 'primary' | 'warning' | 'neutral' }[];
  /** Control layout mode: 'full' (default player UI), 'minimal' (volume + fullscreen floating), or 'none' (hidden). */
  chrome?: 'full' | 'minimal' | 'none';
  /**
   * Called with the live player handle once it is created (and with `null` when
   * it is torn down / re-created). Lets the host drive playback imperatively
   * (mute/setVolume/setPlaybackRate/seek/play/pause) — e.g. a VMS that renders
   * its own control bar with `chrome:'none'`.
   */
  onReady?: (player: PlayerHandle | null) => void;
}

const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

const STRINGS = {
  ru: { speed: 'Скорость', normal: 'Обычная', autoplay: 'Автовоспроизведение', loop: 'Повтор', live: 'В ЭФИРЕ', settings: 'Настройки', on: 'Вкл', off: 'Выкл', noVideo: 'Видео отсутствует' },
  en: { speed: 'Speed', normal: 'Normal', autoplay: 'Autoplay', loop: 'Loop', live: 'LIVE', settings: 'Settings', on: 'On', off: 'Off', noVideo: 'No video' },
};

// Затяжной сталл (тиков по 250мс), после которого вместо крутящегося лоадера
// показываем заглушку «Видео отсутствует»: данных явно нет (дыра в записи,
// пропавший сигнал), а не короткая буферизация.
const SIGNAL_LOST_TICKS = 20; // ~5 секунд

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const ss = s.toString().padStart(2, '0');
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

// ── localStorage helpers (SSR/quota safe) ──────────────────────────
function readStore<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
function writeStore(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore quota / private mode errors */
  }
}

// ── Self-contained stylesheet (injected once) ──────────────────────
const STYLE_ID = 'yyv-styles';
const STYLE = `
.yyv-root{position:relative;width:100%;height:100%;background:#000;overflow:hidden;user-select:none;outline:none;font-family:ui-sans-serif,system-ui,sans-serif}
.yyv-root.yyv-nocursor{cursor:none}
.yyv-canvas{position:relative;z-index:1;width:100%;height:100%;object-fit:contain;display:block;background:#000}
/* PiP mirror: a REAL, full-size <video> painted *behind* the canvas. It must
   not be 1px / opacity:0 — browsers suspend frame production for effectively
   invisible videos, so requestPictureInPicture() then resolves but opens an
   empty window (silent no-op). The opaque canvas on top (z-index:1) is what
   the user actually sees; this mirror is fully occluded but still painted. */
.yyv-pipvideo{position:absolute;inset:0;z-index:0;width:100%;height:100%;object-fit:contain;background:#000;pointer-events:none}
.yyv-center{position:absolute;inset:0;margin:auto;height:64px;width:64px;border-radius:50%;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;border:none;cursor:pointer;z-index:10;transition:background .15s}
.yyv-center:hover{background:rgba(0,0,0,.8)}
.yyv-spin{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:10}
.yyv-spin svg{animation:yyv-rot 1s linear infinite;height:48px;width:48px}
@keyframes yyv-rot{to{transform:rotate(360deg)}}
.yyv-error{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#f87171;font:13px ui-monospace,monospace;z-index:20;pointer-events:none}
.yyv-novideo{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#000;color:#8b8b93;font:600 13px ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase;z-index:15;pointer-events:none}
.yyv-overlay-tl{position:absolute;top:8px;left:8px;z-index:50;display:flex;gap:6px;pointer-events:none}
.yyv-overlay-tl > *, .yyv-overlay-tr > *{pointer-events:auto}
.yyv-overlay-tr{position:absolute;top:8px;right:8px;z-index:50;display:flex;gap:6px;pointer-events:none}
.yyv-bar{position:absolute;left:0;right:0;bottom:0;z-index:30;padding:36px 12px 10px;background:linear-gradient(to top,rgba(0,0,0,.9),rgba(0,0,0,.45) 55%,transparent);transition:opacity .2s;color:#fff}
.yyv-bar.yyv-hidden{opacity:0;pointer-events:none}
.yyv-bar-minimal{background:none !important;padding:0 !important;height:40px;bottom:8px;left:8px;right:8px;display:flex;align-items:center;justify-content:space-between;pointer-events:none;transition:opacity .2s, transform .2s}
.yyv-bar-minimal.yyv-hidden{opacity:0;pointer-events:none;transform:translateY(4px)}
.yyv-bar-minimal .yyv-row{width:100%;display:flex;justify-content:space-between;align-items:center}
.yyv-bar-minimal .yyv-vol, .yyv-bar-minimal .yyv-btn-fullscreen{pointer-events:auto;background:rgba(0,0,0,.6);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.12);border-radius:6px;transition:background .15s, border-color .15s}
.yyv-bar-minimal .yyv-vol{display:flex;align-items:center;padding:4px 6px;height:30px;box-sizing:border-box}
.yyv-bar-minimal .yyv-btn-fullscreen{width:30px;height:30px;display:flex;align-items:center;justify-content:center;margin-left:auto}
.yyv-bar-minimal .yyv-vol:hover, .yyv-bar-minimal .yyv-btn-fullscreen:hover{background:rgba(0,0,0,.8);border-color:rgba(255,255,255,.25)}
.yyv-row{display:flex;align-items:center;gap:14px}
.yyv-btn{background:none;border:none;color:#fff;cursor:pointer;padding:0;margin:0;display:flex;align-items:center;justify-content:center;opacity:.92;transition:opacity .15s,transform .15s;line-height:0}
.yyv-btn:hover{opacity:1}
.yyv-spacer{flex:1}
.yyv-time{font:600 12px/1 ui-monospace,monospace;color:rgba(255,255,255,.92);white-space:nowrap}
.yyv-tlrow{margin-bottom:6px;display:flex;align-items:center;min-height:18px}
.yyv-tlwrap{position:relative;width:100%;padding:7px 0;cursor:pointer;touch-action:none}
.yyv-tl{position:relative;height:5px;width:100%;background:rgba(255,255,255,.3);border-radius:999px;transition:height .1s}
.yyv-tlwrap:hover .yyv-tl{height:7px}
.yyv-tlbuf{position:absolute;left:0;top:0;height:100%;background:rgba(255,255,255,.45);border-radius:999px}
.yyv-tlplayed{position:absolute;left:0;top:0;height:100%;border-radius:999px}
.yyv-tlhandle{position:absolute;top:50%;height:14px;width:14px;border-radius:50%;box-shadow:0 0 3px rgba(0,0,0,.7);opacity:0;transform:translate(-50%,-50%);transition:opacity .12s}
.yyv-tlwrap:hover .yyv-tlhandle,.yyv-tlwrap.yyv-scrub .yyv-tlhandle{opacity:1}
.yyv-tip{position:absolute;bottom:20px;transform:translateX(-50%);background:rgba(0,0,0,.9);color:#fff;font:11px/1 ui-monospace,monospace;padding:3px 6px;border-radius:4px;pointer-events:none;white-space:nowrap}
.yyv-live{display:flex;align-items:center;gap:6px;font:700 11px/1 ui-monospace,monospace;color:#ff3b30;letter-spacing:.12em}
.yyv-livedot{height:8px;width:8px;border-radius:50%;background:#ff3b30;animation:yyv-pulse 1.4s infinite}
@keyframes yyv-pulse{0%,100%{opacity:1}50%{opacity:.3}}
.yyv-vol{display:flex;align-items:center;gap:8px}
.yyv-volrange{width:0;opacity:0;height:4px;cursor:pointer;transition:width .2s,opacity .2s;vertical-align:middle}
.yyv-vol:hover .yyv-volrange,.yyv-volrange:focus{width:74px;opacity:1}
.yyv-menu{position:absolute;bottom:42px;right:0;width:190px;max-height:60vh;overflow-y:auto;background:rgba(22,22,22,.98);border:1px solid rgba(255,255,255,.15);border-radius:8px;color:#fff;font:12px/1.2 ui-sans-serif,system-ui,sans-serif;padding:4px 0;box-shadow:0 10px 30px rgba(0,0,0,.55);z-index:40}
.yyv-mi{width:100%;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;background:none;border:none;color:#fff;cursor:pointer;text-align:left;font:inherit}
.yyv-mi:hover{background:rgba(255,255,255,.1)}
.yyv-sep{margin:4px 0;border-top:1px solid rgba(255,255,255,.1)}
.yyv-mlabel{padding:5px 12px;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:rgba(255,255,255,.5)}
`;

function ensureStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = STYLE;
  document.head.appendChild(el);
}

// ── Inline SVG icons ────────────────────────────────────────────────
const ic = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'currentColor' } as const;
const PlayIcon = () => <svg {...ic}><path d="M8 5v14l11-7z" /></svg>;
const PauseIcon = () => <svg {...ic}><path d="M6 5h4v14H6zm8 0h4v14h-4z" /></svg>;
const VolumeHighIcon = () => <svg {...ic}><path d="M3 10v4h4l5 5V5L7 10H3zm13.5 2a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z" /></svg>;
const VolumeMuteIcon = () => <svg {...ic}><path d="M3 10v4h4l5 5V5L7 10H3zm18.3-1.3-1.4-1.4L17 10.2 14.1 7.3l-1.4 1.4L15.6 12l-2.9 2.9 1.4 1.4L17 13.4l2.9 2.9 1.4-1.4L18.4 12z" /></svg>;
const GearIcon = () => <svg {...ic}><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" /></svg>;
const PipIcon = () => <svg {...ic}><path d="M19 7h-8v6h8V7zm2-4H3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 16.01H3V4.98h18v14.03z" /></svg>;
const FullscreenIcon = () => <svg {...ic}><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" /></svg>;
const FullscreenExitIcon = () => <svg {...ic}><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" /></svg>;
const CheckIcon = () => <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z" /></svg>;

// ── Timeline scrubber with buffered bar + hover tooltip ─────────────
const Timeline: React.FC<{
  currentTime: number;
  duration: number;
  buffered: number;
  accent: string;
  onSeek: (t: number) => void;
  onScrubStart: () => void;
  onScrubEnd: () => void;
  onScrubMove: (t: number) => void;
}> = ({ currentTime, duration, buffered, accent, onSeek, onScrubStart, onScrubEnd, onScrubMove }) => {
  const ref = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false); // synchronous guard (state lags for fast clicks)
  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);

  const timeAt = (clientX: number): number => {
    const rect = ref.current!.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return pct * duration;
  };

  const handleDown = (e: React.PointerEvent) => {
    if (!ref.current || !Number.isFinite(duration) || duration <= 0) return;
    e.preventDefault();
    draggingRef.current = true;
    setDragging(true);
    try { ref.current.setPointerCapture(e.pointerId); } catch { /* noop */ }
    onScrubStart();
    onScrubMove(timeAt(e.clientX));
  };
  const handleMove = (e: React.PointerEvent) => {
    if (!ref.current || !Number.isFinite(duration) || duration <= 0) return;
    const rect = ref.current.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setHover({ x: pct * 100, t: pct * duration });
    if (draggingRef.current) onScrubMove(pct * duration);
  };
  const handleUp = (e: React.PointerEvent) => {
    if (!draggingRef.current || !ref.current) return;
    draggingRef.current = false;
    setDragging(false);
    try { ref.current.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    onSeek(timeAt(e.clientX));
    onScrubEnd();
  };

  const has = Number.isFinite(duration) && duration > 0;
  const pct = has ? Math.min(100, (currentTime / duration) * 100) : 0;
  const bufPct = has ? Math.min(100, (buffered / duration) * 100) : 0;

  return (
    <div
      ref={ref}
      className={`yyv-tlwrap${dragging ? ' yyv-scrub' : ''}`}
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onPointerUp={handleUp}
      onPointerLeave={() => setHover(null)}
    >
      <div className="yyv-tl">
        <div className="yyv-tlbuf" style={{ width: `${bufPct}%` }} />
        <div className="yyv-tlplayed" style={{ width: `${pct}%`, backgroundColor: accent }} />
        <div className="yyv-tlhandle" style={{ left: `${pct}%`, backgroundColor: accent }} />
      </div>
      {hover && has && (
        <div className="yyv-tip" style={{ left: `${hover.x}%` }}>{formatTime(hover.t)}</div>
      )}
    </div>
  );
};

export const YumYumPlayerView: React.FC<YumYumPlayerViewProps> = ({
  createPlayer,
  accentColor = '#00FF66',
  playbackRate,
  controls,
  autoHideDelay = 3000,
  persistKeyPrefix = 'yumyum',
  lang = 'en',
  className = '',
  overlayTopLeft,
  overlayTopRight,
  badges,
  chrome = 'full',
  onReady,
}) => {
  const show = (k: PlayerControlKey) => controls?.[k] !== false;
  const t = STRINGS[lang];
  const K = useCallback((name: string) => `${persistKeyPrefix}:${name}`, [persistKeyPrefix]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pipVideoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<PlayerHandle | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrubbing = useRef(false);
  const loopRef = useRef(false);
  const hoveredRef = useRef(false);
  const pipPreppedRef = useRef(false); // PiP <video> mirror is live and ready
  // onReady kept in a ref so a changing callback prop doesn't re-run the
  // player-creation effect (and thus reload the stream).
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  const [volume, setVolume] = useState(() => readStore<number>(`${persistKeyPrefix}:volume`, 0.8));
  const [muted, setMuted] = useState(() => readStore<boolean>(`${persistKeyPrefix}:muted`, true));
  const [rate, setRate] = useState(() => playbackRate ?? readStore<number>(`${persistKeyPrefix}:rate`, 1));
  const [autoplay, setAutoplay] = useState(() => readStore<boolean>(`${persistKeyPrefix}:autoplay`, false));
  const [loop, setLoop] = useState(() => readStore<boolean>(`${persistKeyPrefix}:loop`, false));

  const [isPlaying, setIsPlaying] = useState(false);
  const [isLive, setIsLive] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [signalLost, setSignalLost] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [pipSupported, setPipSupported] = useState(false);

  loopRef.current = loop;

  useEffect(() => { ensureStyles(); }, []);

  // ── Player lifecycle ──────────────────────────────────────────────
  useEffect(() => {
    if (!canvasRef.current) return;
    setIsReady(false);
    let mounted = true;
    let poll: ReturnType<typeof setInterval> | null = null;
    let created: PlayerHandle | null = null;
    let lastFrames = -1;
    let stallTicks = 0;

    const onEnded = () => {
      if (!mounted) return;
      if (loopRef.current && created) {
        created.seek(0);
        created.play().catch(() => {});
      } else {
        setIsPlaying(false);
      }
    };

    (async () => {
      try {
        const { player, isLive: live } = await createPlayer(canvasRef.current!);
        if (!mounted) { player.destroy(); return; }
        created = player;
        playerRef.current = player;
        onReadyRef.current?.(player);
        setIsLive(live);

        player.setVolume(muted ? 0 : volume);
        player.mute(muted);
        if (rate !== 1) player.setPlaybackRate(rate);

        player.on('ended', onEnded);
        player.on('error', () => { if (mounted) setHasError(true); });
        if (mounted) setIsReady(true);

        if (live || autoplay) {
          player.play().then(() => { if (mounted) setIsPlaying(true); }).catch(() => {});
        }

        poll = setInterval(() => {
          if (!mounted || !created) return;
          const tel = created.getTelemetry();
          if (!scrubbing.current) setCurrentTime(tel.currentPTS);
          setDuration(tel.duration);
          setBuffered(tel.bufferedEnd);
          const playing = tel.playbackState === 'PLAYING';
          setIsPlaying(playing);
          // Stall = playing, queue drained, and no new frame since last tick.
          // Require a few consecutive stalled ticks before showing the spinner
          // so a brief gap (e.g. right after a seek) doesn't flash it, and clear
          // it instantly the moment frames start flowing again.
          const tickStalled = playing && tel.renderedFrames === lastFrames
            && tel.queueLength === 0 && tel.activeCodec !== 'mjpeg';
          stallTicks = tickStalled ? stallTicks + 1 : 0;
          // Короткий сталл — спиннер (буферизация); затяжной — заглушка
          // «видео отсутствует» (данных нет: дыра в записи / потерян сигнал).
          const lost = stallTicks >= SIGNAL_LOST_TICKS;
          setSignalLost(lost);
          setIsBuffering(stallTicks >= 3 && !lost);
          lastFrames = tel.renderedFrames;

          // Eagerly mirror the canvas into the off-screen PiP <video> once frames
          // exist, and keep it playing. This is essential: requestPictureInPicture()
          // must run synchronously inside the click gesture, so the stream must be
          // ready *before* the user clicks (awaiting play()/metadata in the handler
          // consumes the gesture and the browser rejects it).
          if (!pipPreppedRef.current && tel.renderedFrames > 0) {
            const cv = canvasRef.current as (HTMLCanvasElement & { captureStream?(fps?: number): MediaStream }) | null;
            const vid = pipVideoRef.current;
            if (cv && vid && typeof cv.captureStream === 'function') {
              try {
                const prev = vid.srcObject as MediaStream | null;
                if (prev) prev.getTracks().forEach((tr) => tr.stop());
                vid.srcObject = cv.captureStream(30);
                vid.play().catch(() => {});
                pipPreppedRef.current = true;
              } catch { /* captureStream unsupported */ }
            }
          }
        }, 250);
      } catch {
        if (mounted) setHasError(true);
      }
    })();

    return () => {
      mounted = false;
      pipPreppedRef.current = false;
      if (poll) clearInterval(poll);
      if (created) {
        created.off('ended', onEnded);
        try { created.destroy(); } catch { /* noop */ }
      }
      playerRef.current = null;
      onReadyRef.current?.(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createPlayer]);

  // ── Controlled playback rate: apply live when the prop changes ─────
  useEffect(() => {
    if (playbackRate === undefined) return;
    setRate(playbackRate);
    writeStore(K('rate'), playbackRate);
    playerRef.current?.setPlaybackRate(playbackRate);
  }, [playbackRate, K]);

  // ── Fullscreen + PiP capability ───────────────────────────────────
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener('fullscreenchange', onFsChange);
    // PiP needs (a) a canvas we can mirror via captureStream and (b) a PiP API:
    // the standard one (Chrome/Edge/Firefox) or WebKit's presentation-mode API
    // (Safari, which doesn't expose document.pictureInPictureEnabled).
    const canCapture =
      typeof HTMLCanvasElement !== 'undefined' && 'captureStream' in HTMLCanvasElement.prototype;
    const standardPip =
      typeof document !== 'undefined' && document.pictureInPictureEnabled === true;
    const webkitPip =
      typeof HTMLVideoElement !== 'undefined' &&
      typeof (HTMLVideoElement.prototype as unknown as { webkitSetPresentationMode?: unknown }).webkitSetPresentationMode === 'function';
    setPipSupported(canCapture && (standardPip || webkitPip));
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // ── Control actions ───────────────────────────────────────────────
  const togglePlay = useCallback(() => {
    const p = playerRef.current;
    if (!p || hasError) return;
    p.unlockAudio?.().catch(() => {});
    if (isPlaying) { p.pause(); setIsPlaying(false); }
    else { p.play().then(() => setIsPlaying(true)).catch(() => {}); }
  }, [isPlaying, hasError]);

  const applyVolume = useCallback((v: number) => {
    const vol = Math.max(0, Math.min(1, v));
    const isMute = vol === 0;
    setVolume(vol);
    setMuted(isMute);
    writeStore(K('volume'), vol);
    writeStore(K('muted'), isMute);
    const p = playerRef.current;
    if (p) {
      p.unlockAudio?.().catch(() => {});
      p.mute(isMute);
      p.setVolume(vol);
    }
  }, [K]);

  const toggleMute = useCallback(() => {
    const next = !muted;
    setMuted(next);
    writeStore(K('muted'), next);
    const p = playerRef.current;
    if (p) {
      p.unlockAudio?.().catch(() => {});
      p.mute(next);
      p.setVolume(next ? 0 : volume || 0.5);
    }
    if (!next && (volume || 0) === 0) applyVolume(0.5);
  }, [muted, volume, K, applyVolume]);

  const applyRate = useCallback((r: number) => {
    setRate(r);
    writeStore(K('rate'), r);
    playerRef.current?.setPlaybackRate(r);
  }, [K]);

  const relSeek = useCallback((delta: number) => {
    const p = playerRef.current;
    if (!p || isLive) return;
    const target = Math.max(0, Math.min(duration || Infinity, p.getCurrentTime() + delta));
    p.seek(target);
    setCurrentTime(target);
  }, [isLive, duration]);

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen().catch(() => {});
  }, []);

  const togglePip = useCallback(() => {
    const canvas = canvasRef.current;
    const video = pipVideoRef.current as (HTMLVideoElement & {
      webkitSetPresentationMode?(mode: 'picture-in-picture' | 'inline'): void;
      webkitPresentationMode?: string;
    }) | null;
    if (!video) return;

    // Already in PiP → leave it (standard API, then WebKit/Safari).
    if (document.pictureInPictureElement === video) {
      document.exitPictureInPicture().catch(() => {});
      return;
    }
    if (video.webkitPresentationMode === 'picture-in-picture') {
      video.webkitSetPresentationMode?.('inline');
      return;
    }

    // Last-resort prep if the eager setup hasn't run yet (e.g. clicked very early).
    if (!video.srcObject && canvas) {
      const cv = canvas as HTMLCanvasElement & { captureStream?(fps?: number): MediaStream };
      if (typeof cv.captureStream === 'function') {
        try { video.srcObject = cv.captureStream(30); pipPreppedRef.current = true; } catch { /* noop */ }
      }
    }
    // Keep the mirror playing so frames — and therefore metadata — start flowing.
    video.play().catch(() => {});

    const request = () => {
      if (typeof video.requestPictureInPicture === 'function') {
        video.requestPictureInPicture().catch((err) => {
          // eslint-disable-next-line no-console
          console.warn('[YumYumPlayerView] Picture-in-Picture unavailable:', err);
        });
      } else if (typeof video.webkitSetPresentationMode === 'function') {
        // Safari: no standard API — use the WebKit presentation-mode fallback.
        try { video.webkitSetPresentationMode('picture-in-picture'); }
        // eslint-disable-next-line no-console
        catch (err) { console.warn('[YumYumPlayerView] Picture-in-Picture unavailable:', err); }
      }
    };

    // requestPictureInPicture() throws InvalidStateError if the <video> has no
    // metadata yet (the captureStream was only just attached, or the user clicked
    // before the eager prep ran). When that's the case, wait for the first frame's
    // metadata and request then — Chrome keeps the click's transient activation
    // alive for a few seconds, so the user gesture is still valid.
    if (video.readyState >= 1 /* HAVE_METADATA */) {
      request();
    } else {
      video.addEventListener('loadedmetadata', request, { once: true });
    }
  }, []);

  // Exit PiP and release the captured MediaStream when the view unmounts.
  useEffect(() => () => {
    const video = pipVideoRef.current as (HTMLVideoElement & {
      webkitSetPresentationMode?(mode: 'inline'): void;
      webkitPresentationMode?: string;
    }) | null;
    try {
      if (video && document.pictureInPictureElement === video) document.exitPictureInPicture().catch(() => {});
      if (video?.webkitPresentationMode === 'picture-in-picture') video.webkitSetPresentationMode?.('inline');
    } catch { /* noop */ }
    const stream = video?.srcObject as MediaStream | null;
    if (stream) stream.getTracks().forEach((tr) => tr.stop());
    if (video) video.srcObject = null;
  }, []);

  // ── Auto-hide controls while playing ──────────────────────────────
  const revealControls = useCallback(() => {
    hoveredRef.current = true; // any mouse activity over the player arms hotkeys
    setControlsVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (playerRef.current && !scrubbing.current && !settingsOpen) {
        // Only hide while actually playing.
        if (playerRef.current.getTelemetry().playbackState === 'PLAYING') setControlsVisible(false);
      }
    }, autoHideDelay);
  }, [settingsOpen, autoHideDelay]);

  useEffect(() => () => { if (hideTimer.current) clearTimeout(hideTimer.current); }, []);

  // ── Keyboard shortcuts (document-level, gated to hover/fullscreen) ─
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const active = hoveredRef.current || document.fullscreenElement === containerRef.current;
      if (!active) return;
      const tgt = e.target as HTMLElement | null;
      if (tgt && /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName)) return;
      switch (e.key) {
        case ' ': case 'k': e.preventDefault(); togglePlay(); break;
        case 'ArrowLeft': e.preventDefault(); relSeek(-5); break;
        case 'ArrowRight': e.preventDefault(); relSeek(5); break;
        case 'ArrowUp': e.preventDefault(); applyVolume((muted ? 0 : volume) + 0.05); break;
        case 'ArrowDown': e.preventDefault(); applyVolume((muted ? 0 : volume) - 0.05); break;
        case 'm': case 'M': case 'ь': toggleMute(); break;
        case 'f': case 'F': case 'а': toggleFullscreen(); break;
        default: return;
      }
      revealControls();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, relSeek, applyVolume, toggleMute, toggleFullscreen, revealControls, muted, volume]);

  const displayTime = scrubTime !== null ? scrubTime : currentTime;
  const volPct = muted ? 0 : volume * 100;
  const barHidden = isPlaying && !controlsVisible && !settingsOpen;
  
  const barClass = chrome === 'minimal'
    ? `yyv-bar yyv-bar-minimal${barHidden ? ' yyv-hidden' : ''}`
    : `yyv-bar${barHidden ? ' yyv-hidden' : ''}`;

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onMouseEnter={() => { hoveredRef.current = true; }}
      onMouseMove={revealControls}
      onMouseLeave={() => { hoveredRef.current = false; if (isPlaying && !settingsOpen) setControlsVisible(false); }}
      style={{ ['--yy-accent' as string]: accentColor }}
      className={`yyv-root${barHidden ? ' yyv-nocursor' : ''} ${className}`}
    >
      <canvas ref={canvasRef} className="yyv-canvas" onClick={togglePlay} />

      {/* Off-screen video used only as a PiP surface for the canvas stream */}
      <video ref={pipVideoRef} muted playsInline className="yyv-pipvideo" />

      {((badges && badges.length > 0) || overlayTopLeft) && (
        <div className="yyv-overlay-tl">
          {badges?.map((b, i) => (
            <Badge key={i} label={b.label} variant={b.variant} />
          ))}
          {overlayTopLeft}
        </div>
      )}

      {overlayTopRight && (
        <div className="yyv-overlay-tr">
          {overlayTopRight}
        </div>
      )}

      {(!isReady || isBuffering) && !hasError && (
        <div className="yyv-spin" style={{ color: accentColor }}>
          <Spinner />
        </div>
      )}

      {isReady && !isPlaying && !isBuffering && !hasError && (
        <Button variant="ghost" className="yyv-center" onClick={togglePlay} aria-label="Play" style={{ color: accentColor }}>
          <span style={{ display: 'flex', transform: 'scale(1.4)' }}><PlayIcon /></span>
        </Button>
      )}

      {signalLost && !hasError && (
        <div className="yyv-novideo">{t.noVideo}</div>
      )}

      {hasError && <div className="yyv-error">Playback error</div>}

      {chrome !== 'none' && (
        <div
          className={barClass}
          onMouseEnter={() => { if (hideTimer.current) clearTimeout(hideTimer.current); }}
        >
          {chrome !== 'minimal' && show('timeline') && (
            <div className="yyv-tlrow">
              {isLive ? (
                <div className="yyv-live"><span className="yyv-livedot" />{t.live}</div>
              ) : (
                <Timeline
                  currentTime={displayTime}
                  duration={duration}
                  buffered={buffered}
                  accent={accentColor}
                  onScrubStart={() => { scrubbing.current = true; }}
                  onScrubMove={(tt) => setScrubTime(tt)}
                  onScrubEnd={() => { scrubbing.current = false; setScrubTime(null); }}
                  onSeek={(tt) => { playerRef.current?.seek(tt); setCurrentTime(tt); }}
                />
              )}
            </div>
          )}

          <div className="yyv-row">
            {chrome !== 'minimal' && show('play') && (
              <Button variant="ghost" className="yyv-btn" onClick={togglePlay} aria-label={isPlaying ? 'Pause' : 'Play'}>
                {isPlaying ? <PauseIcon /> : <PlayIcon />}
              </Button>
            )}

            {show('volume') && (
              <div className="yyv-vol">
                <Button variant="ghost" className="yyv-btn" onClick={toggleMute} aria-label={muted ? 'Unmute' : 'Mute'}>
                  {muted ? <VolumeMuteIcon /> : <VolumeHighIcon />}
                </Button>
                <Slider
                  value={volPct}
                  onChange={(val) => applyVolume(val / 100)}
                  className="yyv-volrange"
                />
              </div>
            )}

            {chrome !== 'minimal' && show('time') && (
              <span className="yyv-time">
                {isLive ? t.live : `${formatTime(displayTime)} / ${formatTime(duration)}`}
              </span>
            )}

            {chrome !== 'minimal' && <div className="yyv-spacer" />}

            {chrome !== 'minimal' && show('speed') && !show('settings') && (
              <SpeedQuick rate={rate} accent={accentColor} onPick={applyRate} />
            )}

            {chrome !== 'minimal' && show('settings') && (
              <div style={{ position: 'relative' }}>
                <Button
                  variant="ghost"
                  className="yyv-btn"
                  onClick={() => { setSettingsOpen((s) => !s); revealControls(); }}
                  aria-label={t.settings}
                  style={{ transform: settingsOpen ? 'rotate(45deg)' : undefined }}
                >
                  <GearIcon />
                </Button>
                {settingsOpen && (
                  <SettingsMenu
                    lang={lang}
                    accent={accentColor}
                    rate={rate}
                    autoplay={autoplay}
                    loop={loop}
                    onRate={applyRate}
                    onAutoplay={(v) => { setAutoplay(v); writeStore(K('autoplay'), v); }}
                    onLoop={(v) => { setLoop(v); writeStore(K('loop'), v); }}
                  />
                )}
              </div>
            )}

            {chrome !== 'minimal' && show('pip') && pipSupported && (
              <Button variant="ghost" className="yyv-btn" onClick={togglePip} aria-label="Picture in picture">
                <PipIcon />
              </Button>
            )}

            {show('fullscreen') && (
              <Button variant="ghost" className="yyv-btn yyv-btn-fullscreen" onClick={toggleFullscreen} aria-label="Fullscreen">
                {isFullscreen ? <FullscreenExitIcon /> : <FullscreenIcon />}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

// Compact inline speed cycler used when the gear menu is hidden.
const SpeedQuick: React.FC<{ rate: number; accent: string; onPick: (r: number) => void }> = ({ rate, accent, onPick }) => {
  const next = () => {
    const i = PLAYBACK_RATES.indexOf(rate);
    onPick(PLAYBACK_RATES[(i + 1) % PLAYBACK_RATES.length]);
  };
  return (
    <Button variant="ghost" className="yyv-btn" onClick={next} style={{ font: '700 12px/1 ui-monospace,monospace', color: rate !== 1 ? accent : '#fff' }}>
      {rate}×
    </Button>
  );
};

const SettingsMenu: React.FC<{
  lang: 'ru' | 'en';
  accent: string;
  rate: number;
  autoplay: boolean;
  loop: boolean;
  onRate: (r: number) => void;
  onAutoplay: (v: boolean) => void;
  onLoop: (v: boolean) => void;
}> = ({ lang, accent, rate, autoplay, loop, onRate, onAutoplay, onLoop }) => {
  const t = STRINGS[lang];
  const Toggle: React.FC<{ label: string; on: boolean; onClick: () => void }> = ({ label, on, onClick }) => (
    <Button variant="ghost" className="yyv-mi" onClick={onClick}>
      <span>{label}</span>
      <span style={{ fontWeight: 700, fontSize: 10, color: on ? accent : '#888' }}>{on ? t.on : t.off}</span>
    </Button>
  );
  return (
    <div className="yyv-menu">
      <Toggle label={t.autoplay} on={autoplay} onClick={() => onAutoplay(!autoplay)} />
      <Toggle label={t.loop} on={loop} onClick={() => onLoop(!loop)} />
      <div className="yyv-sep" />
      <div className="yyv-mlabel">{t.speed}</div>
      {PLAYBACK_RATES.map((r) => (
        <Button key={r} variant="ghost" className="yyv-mi" onClick={() => onRate(r)}>
          <span>{r === 1 ? t.normal : `${r}×`}</span>
          {rate === r && <span style={{ color: accent, display: 'flex' }}><CheckIcon /></span>}
        </Button>
      ))}
    </div>
  );
};
