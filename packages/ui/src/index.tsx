"use client";
import React, { useEffect, useRef } from 'react';

// Full YouTube-style player chrome (timeline, volume, speed, autoplay, PiP, fullscreen).
export { YumYumPlayerView } from './YumYumPlayerView.js';
export type { YumYumPlayerViewProps, PlayerHandle, PlayerControlKey } from './YumYumPlayerView.js';

const STYLE_ID = 'yyp-primitives-styles';
// Дизайн-токены библиотеки. Значения-дефолты = тёмная палитра DESIGN.md
// (лестница высот 2026-07-01), чтобы библиотека выглядела корректно и без
// приложения. Приложение переопределяет любой --yyp-* своим маппингом.
const MONO = `ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,monospace`;
const RING = `0 0 0 2px rgba(var(--yyp-accent-rgb,16,185,129),.5)`;
const STYLE = `
/* ==================== BADGE / CHIP ==================== */
.yyp-badge{display:inline-flex;align-items:center;padding:2px 6px;border-radius:var(--yyp-radius-xs,2px);font-family:${MONO};font-size:9px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;border:1px solid;font-variant-numeric:tabular-nums}
.yyp-badge-primary{background:rgba(var(--yyp-accent-rgb,16,185,129),.1);color:var(--yyp-accent,#10b981);border-color:rgba(var(--yyp-accent-rgb,16,185,129),.3)}
.yyp-badge-warning{background:rgba(var(--yyp-warning-rgb,245,165,36),.1);color:var(--yyp-warning,#f5a524);border-color:rgba(var(--yyp-warning-rgb,245,165,36),.3)}
.yyp-badge-danger{background:rgba(var(--yyp-danger-rgb,244,80,106),.1);color:var(--yyp-danger,#f4506a);border-color:rgba(var(--yyp-danger-rgb,244,80,106),.3)}
.yyp-badge-info{background:rgba(var(--yyp-blue-rgb,59,130,246),.1);color:var(--yyp-blue,#3b82f6);border-color:rgba(var(--yyp-blue-rgb,59,130,246),.3)}
.yyp-badge-neutral{background:var(--yyp-surface-2,#1e2228);color:var(--yyp-text-2,#a9b2bb);border-color:var(--yyp-border,#2c323a)}
.yyp-badge-rec{background:rgba(var(--yyp-danger-rgb,244,80,106),.1);color:var(--yyp-danger,#f4506a);border-color:rgba(var(--yyp-danger-rgb,244,80,106),.4);animation:yyp-pulse 1.4s infinite}

/* ==================== BUTTON ==================== */
.yyp-btn{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:var(--yyp-control-h,32px);padding:0 12px;box-sizing:border-box;border-radius:var(--yyp-radius-sm,5px);border:1px solid;cursor:pointer;font-family:${MONO};font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;font-variant-numeric:tabular-nums;transition:background var(--yyp-transition-fast,.12s),border-color var(--yyp-transition-fast,.12s),transform var(--yyp-transition-fast,.12s);color:var(--yyp-text,#f0f2f4)}
.yyp-btn-sm{height:var(--yyp-control-h-sm,28px);padding:0 10px}
.yyp-btn-lg{height:var(--yyp-control-h-lg,36px);padding:0 16px}
.yyp-btn:focus-visible{outline:none;box-shadow:${RING}}
.yyp-btn:active{transform:scale(.95)}
.yyp-btn:disabled,.yyp-btn[aria-disabled="true"]{opacity:.5;cursor:not-allowed}
.yyp-btn:disabled:active,.yyp-btn[aria-disabled="true"]:active{transform:none}
.yyp-btn-default{background:var(--yyp-surface-2,#1e2228);border-color:var(--yyp-border,#2c323a)}
.yyp-btn-default:hover:not(:disabled){background:var(--yyp-surface-3,#262b31);border-color:var(--yyp-border-strong,#3a424c)}
.yyp-btn-active{background:rgba(var(--yyp-accent-rgb,16,185,129),.1);border-color:var(--yyp-accent,#10b981);color:var(--yyp-accent,#10b981)}
.yyp-btn-ghost{border:1px solid transparent;background:transparent}
.yyp-btn-ghost:hover:not(:disabled){background:var(--yyp-surface-2,#1e2228)}
.yyp-btn.primary{color:var(--yyp-bg,#0b0d0f);background:var(--yyp-accent,#10b981);border-color:var(--yyp-accent,#10b981)}
.yyp-btn.primary:hover:not(:disabled){background:var(--yyp-accent-hover,#34d399);border-color:var(--yyp-accent-hover,#34d399)}
.yyp-btn.danger{color:var(--yyp-bg,#0b0d0f);background:var(--yyp-danger,#f4506a);border-color:var(--yyp-danger,#f4506a)}
.yyp-btn.danger:hover:not(:disabled){filter:brightness(1.1)}
.yyp-btn-ghost.danger{color:var(--yyp-danger,#f4506a);background:transparent;border-color:transparent}
.yyp-btn-ghost.danger:hover:not(:disabled){background:rgba(var(--yyp-danger-rgb,244,80,106),.1)}
.yyp-btn.icon{width:var(--yyp-control-h-sm,28px);height:var(--yyp-control-h-sm,28px);min-width:var(--yyp-control-h-sm,28px);padding:0}
.yyp-btn-loading{color:transparent!important}
.yyp-btn-loading .yyp-btn-spin{position:absolute;top:50%;left:50%;width:14px;height:14px;margin:-7px 0 0 -7px;border:2px solid rgba(var(--yyp-text-rgb,240,242,244),.3);border-top-color:currentColor;border-radius:50%;color:var(--yyp-text,#f0f2f4);animation:yyp-rot .8s linear infinite}

/* ==================== INPUT / SELECT (утоплены) ==================== */
.yyp-input{height:var(--yyp-control-h,32px);box-sizing:border-box;background:var(--yyp-input-bg,#0e1013);border:1px solid var(--yyp-border-strong,#3a424c);border-radius:var(--yyp-radius-sm,5px);padding:0 10px;color:var(--yyp-text,#f0f2f4);font-family:${MONO};font-size:12px;font-variant-numeric:tabular-nums;outline:none;transition:border-color var(--yyp-transition-fast,.12s),box-shadow var(--yyp-transition-fast,.12s)}
textarea.yyp-input{height:auto;padding:8px 10px;line-height:1.5}
.yyp-input:focus{border-color:var(--yyp-accent,#10b981);box-shadow:0 0 0 2px rgba(var(--yyp-accent-rgb,16,185,129),.15)}
.yyp-input:disabled{opacity:.5;cursor:not-allowed}
.yyp-input::placeholder{color:var(--yyp-text-3,#6a727b)}
.yyp-input-error{border-color:var(--yyp-danger,#f4506a)}
.yyp-input-error:focus{border-color:var(--yyp-danger,#f4506a);box-shadow:0 0 0 2px rgba(var(--yyp-danger-rgb,244,80,106),.15)}

.yyp-select{height:var(--yyp-control-h,32px);box-sizing:border-box;background:var(--yyp-input-bg,#0e1013);border:1px solid var(--yyp-border-strong,#3a424c);border-radius:var(--yyp-radius-sm,5px);padding:0 32px 0 10px;color:var(--yyp-text,#f0f2f4);font-family:${MONO};font-size:12px;outline:none;cursor:pointer;appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23a9b2bb' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3e%3cpolyline points='6 9 12 15 18 9'%3e%3c/polyline%3e%3c/svg%3e");background-repeat:no-repeat;background-position:right 10px center;background-size:14px;transition:border-color var(--yyp-transition-fast,.12s),box-shadow var(--yyp-transition-fast,.12s)}
.yyp-select:focus{border-color:var(--yyp-accent,#10b981);box-shadow:0 0 0 2px rgba(var(--yyp-accent-rgb,16,185,129),.15)}
.yyp-select:disabled{opacity:.5;cursor:not-allowed}

/* ==================== CHECKBOX / RADIO ==================== */
.yyp-check{width:14px;height:14px;min-width:14px;min-height:14px;margin:0;cursor:pointer;accent-color:var(--yyp-accent,#10b981)}
.yyp-check:focus-visible{outline:none;box-shadow:${RING};border-radius:var(--yyp-radius-xs,2px)}
.yyp-check:disabled{opacity:.5;cursor:not-allowed}

/* ==================== TOGGLE (SWITCH) ==================== */
.yyp-toggle{position:relative;display:inline-flex;align-items:center;width:38px;height:22px;flex:0 0 auto;border:none;padding:0;border-radius:999px;background:var(--yyp-input-bg,#0e1013);box-shadow:inset 0 0 0 1px var(--yyp-border-strong,#3a424c);cursor:pointer;transition:background var(--yyp-transition-normal,.2s)}
.yyp-toggle-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--yyp-text-2,#a9b2bb);transition:transform var(--yyp-transition-normal,.2s),background var(--yyp-transition-normal,.2s)}
.yyp-toggle[aria-checked="true"]{background:var(--yyp-accent,#10b981);box-shadow:inset 0 0 0 1px var(--yyp-accent,#10b981)}
.yyp-toggle[aria-checked="true"] .yyp-toggle-knob{transform:translateX(16px);background:var(--yyp-bg,#0b0d0f)}
.yyp-toggle:focus-visible{outline:none;box-shadow:${RING}}
.yyp-toggle:disabled{opacity:.5;cursor:not-allowed}

/* ==================== SLIDER ==================== */
.yyp-slider{position:relative;height:6px;width:100%;background:var(--yyp-input-bg,#0e1013);border-radius:999px;cursor:pointer;overflow:hidden;outline:none;user-select:none}
.yyp-slider-disabled{opacity:.5;cursor:not-allowed}
.yyp-slider-disabled .yyp-slider-handle{display:none}
.yyp-slider:focus-visible{box-shadow:${RING}}
.yyp-slider-fill{position:absolute;height:100%;left:0;top:0;background:var(--yyp-accent,#10b981);transition:background-color var(--yyp-transition-fast,.15s)}
.yyp-slider-handle{position:absolute;top:50%;transform:translate(-50%,-50%);height:10px;width:10px;border-radius:50%;background:var(--yyp-text,#f0f2f4);border:1px solid var(--yyp-accent,#10b981);box-shadow:0 0 3px rgba(0,0,0,.5);opacity:0;transition:opacity var(--yyp-transition-fast,.15s)}
.yyp-slider:hover .yyp-slider-handle,.yyp-slider:focus-visible .yyp-slider-handle{opacity:1}

/* ==================== SPINNER ==================== */
.yyp-spinner{display:inline-flex;align-items:center;justify-content:center;pointer-events:none}
.yyp-spinner-svg{animation:yyp-rot 1s linear infinite;height:40px;width:40px;color:var(--yyp-accent,#10b981)}

@keyframes yyp-rot{to{transform:rotate(360deg)}}
@keyframes yyp-pulse{0%,100%{opacity:1}50%{opacity:.3}}
@media (prefers-reduced-motion:reduce){
  .yyp-badge-rec{animation:none}
  .yyp-spinner-svg,.yyp-btn-loading .yyp-btn-spin{animation-duration:1.5s}
  .yyp-btn:active{transform:none}
  .yyp-btn,.yyp-input,.yyp-select,.yyp-toggle,.yyp-toggle-knob,.yyp-slider-fill{transition:none}
}
`;

function ensureStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = STYLE;
  document.head.appendChild(el);
}

// ==================== PREMIUM BADGE ====================
export interface BadgeProps {
  label: string;
  variant?: 'primary' | 'warning' | 'danger' | 'info' | 'neutral' | 'rec';
}

export const Badge: React.FC<BadgeProps> = ({ label, variant = 'neutral' }) => {
  useEffect(() => {
    ensureStyles();
  }, []);

  return (
    <span className={`yyp-badge yyp-badge-${variant}`}>
      {label}
    </span>
  );
};

// ==================== BRUTALIST BUTTON ====================
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  /** primary/danger также можно задать через className (обратная совместимость). */
  variant?: 'default' | 'ghost' | 'primary' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  /** Показать спиннер и заблокировать кнопку. */
  loading?: boolean;
}

export const Button: React.FC<ButtonProps> = ({
  children,
  active,
  variant = 'default',
  size = 'md',
  loading = false,
  className = '',
  disabled,
  ...props
}) => {
  useEffect(() => {
    ensureStyles();
  }, []);

  let variantClass: string;
  if (variant === 'ghost') variantClass = 'yyp-btn-ghost';
  else if (variant === 'primary') variantClass = 'primary';
  else if (variant === 'danger') variantClass = 'danger';
  else variantClass = active ? 'yyp-btn-active' : 'yyp-btn-default';
  const sizeClass = size === 'sm' ? 'yyp-btn-sm' : size === 'lg' ? 'yyp-btn-lg' : '';

  return (
    <button
      className={`yyp-btn ${variantClass} ${sizeClass} ${loading ? 'yyp-btn-loading' : ''} ${className}`}
      aria-pressed={active}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      {...props}
    >
      {loading && <span className="yyp-btn-spin" aria-hidden="true" />}
      {children}
    </button>
  );
};

// ==================== SLIDER (VOLUME / TIMELINE) ====================
export interface SliderProps {
  value: number;
  onChange: (value: number) => void;
  /** Диапазон значения. По умолчанию 0..100 (обратная совместимость). */
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  className?: string;
  hoverPreview?: boolean;
}

export const Slider: React.FC<SliderProps> = ({
  value,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  disabled = false,
  className = '',
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  useEffect(() => {
    ensureStyles();
  }, []);

  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  const snap = (v: number) => {
    const snapped = Math.round((v - min) / step) * step + min;
    // Убираем ошибки плавающей точки, ориентируясь на десятичные знаки шага.
    const decimals = (String(step).split('.')[1] || '').length;
    return Number(clamp(snapped).toFixed(decimals));
  };
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;

  const handlePointerDown = (e: React.PointerEvent) => {
    if (disabled || !containerRef.current) return;
    isDragging.current = true;
    containerRef.current.setPointerCapture(e.pointerId);
    updateValue(e);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDragging.current) return;
    updateValue(e);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!isDragging.current) return;
    isDragging.current = false;
    if (containerRef.current) {
      try {
        containerRef.current.releasePointerCapture(e.pointerId);
      } catch (err) {}
    }
  };

  const updateValue = (e: React.PointerEvent) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onChange(snap(min + frac * (max - min)));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    const big = e.shiftKey ? step * 10 : step;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      onChange(snap(value + big));
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      onChange(snap(value - big));
    } else if (e.key === 'Home') {
      e.preventDefault();
      onChange(min);
    } else if (e.key === 'End') {
      e.preventDefault();
      onChange(max);
    }
  };

  return (
    <div
      ref={containerRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onKeyDown={handleKeyDown}
      tabIndex={disabled ? -1 : 0}
      role="slider"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-disabled={disabled || undefined}
      className={`yyp-slider ${disabled ? 'yyp-slider-disabled' : ''} ${className}`}
    >
      <div className="yyp-slider-fill" style={{ width: `${pct}%` }} />
      <div className="yyp-slider-handle" style={{ left: `calc(${pct}% - 5px)` }} />
    </div>
  );
};

// ==================== BUFFERING SPINNER ====================
export const Spinner: React.FC = () => {
  useEffect(() => {
    ensureStyles();
  }, []);

  return (
    <div className="yyp-spinner" role="status" aria-label="Loading...">
      <svg
        className="yyp-spinner-svg"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
      >
        <circle
          style={{ opacity: 0.25 }}
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="3"
        />
        <path
          style={{ opacity: 0.75 }}
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
        />
      </svg>
    </div>
  );
};

// ==================== INPUT PRIMITIVE ====================
export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Подсветить рамкой ошибки. */
  error?: boolean;
}

export const Input: React.FC<InputProps> = ({ className = '', error, type, ...props }) => {
  useEffect(() => {
    ensureStyles();
  }, []);

  // Чекбоксы/радио не должны получать «текстовый» стиль .yyp-input
  // (иначе искажаются) — это снимает костыль-сброс на стороне приложения.
  const isCheck = type === 'checkbox' || type === 'radio';
  const base = isCheck ? 'yyp-check' : `yyp-input${error ? ' yyp-input-error' : ''}`;

  return (
    <input
      type={type}
      className={`${base} ${className}`}
      aria-invalid={error || undefined}
      {...props}
    />
  );
};

// ==================== CHECKBOX PRIMITIVE ====================
export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {}

export const Checkbox: React.FC<CheckboxProps> = ({ className = '', ...props }) => {
  useEffect(() => {
    ensureStyles();
  }, []);

  return <input type="checkbox" className={`yyp-check ${className}`} {...props} />;
};

// ==================== TOGGLE (SWITCH) PRIMITIVE ====================
export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
  id?: string;
}

export const Toggle: React.FC<ToggleProps> = ({ checked, onChange, disabled, className = '', ...rest }) => {
  useEffect(() => {
    ensureStyles();
  }, []);

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={`yyp-toggle ${className}`}
      onClick={() => !disabled && onChange(!checked)}
      {...rest}
    >
      <span className="yyp-toggle-knob" aria-hidden="true" />
    </button>
  );
};

// ==================== SELECT PRIMITIVE ====================
export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {}

export const Select: React.FC<SelectProps> = ({ children, className = '', ...props }) => {
  useEffect(() => {
    ensureStyles();
  }, []);

  return (
    <select
      className={`yyp-select ${className}`}
      {...props}
    >
      {children}
    </select>
  );
};

// ==================== TEXTAREA PRIMITIVE ====================
export interface TextAreaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

export const TextArea: React.FC<TextAreaProps> = ({ className = '', ...props }) => {
  useEffect(() => {
    ensureStyles();
  }, []);

  return (
    <textarea
      className={`yyp-input resize-none ${className}`}
      {...props}
    />
  );
};

