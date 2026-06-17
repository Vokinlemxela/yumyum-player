"use client";
import React, { useEffect, useRef } from 'react';

// Full YouTube-style player chrome (timeline, volume, speed, autoplay, PiP, fullscreen).
export { YumYumPlayerView } from './YumYumPlayerView.js';
export type { YumYumPlayerViewProps, PlayerHandle, PlayerControlKey } from './YumYumPlayerView.js';

const STYLE_ID = 'yyp-primitives-styles';
const STYLE = `
.yyp-badge{display:inline-flex;align-items:center;padding:2px 6px;border-radius:3px;font-family:ui-monospace,SF Mono,Menlo,monospace;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;border:1px solid}
.yyp-badge-primary{background:rgba(0,255,102,.06);color:var(--yyp-accent,#00ff66);border-color:rgba(0,255,102,.3)}
.yyp-badge-warning{background:rgba(255,173,0,.08);color:var(--yyp-warning,#ffad00);border-color:rgba(255,173,0,.35)}
.yyp-badge-neutral{background:var(--yyp-surface,#0a0a0a);color:var(--yyp-text-secondary,#a0a0a0);border-color:var(--yyp-border,#1a1a1a)}
.yyp-badge-rec{background:rgba(255,69,58,.08);color:#ff453a;border-color:rgba(255,69,58,.4);animation:yyp-pulse 1.4s infinite}

.yyp-btn{display:inline-flex;align-items:center;justify-content:center;border-radius:4px;border:1px solid;cursor:pointer;font-family:ui-monospace,SF Mono,Menlo,monospace;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;transition:all .2s;color:var(--yyp-text,#fff)}
.yyp-btn-default{background:var(--yyp-surface,#0a0a0a);border-color:var(--yyp-border,#1a1a1a)}
.yyp-btn-default:hover{background:var(--yyp-surface-hover,#121212);border-color:rgba(160,160,160,.3)}
.yyp-btn-active{background:rgba(0,255,102,.05);border-color:var(--yyp-accent,#00ff66);color:var(--yyp-accent,#00ff66);box-shadow:0 0 8px rgba(0,255,102,.1)}
.yyp-btn-ghost{border:none;background:transparent;padding:0;height:auto}
.yyp-btn-ghost:hover{background:rgba(255,255,255,.05)}
.yyp-btn:active{transform:scale(.95)}

.yyp-input{background:#000;border:1px solid var(--yyp-border,#1a1a1a);border-radius:4px;padding:8px 10px;color:#fff;font-family:ui-monospace,SF Mono,Menlo,monospace;font-size:12px;outline:none;transition:border-color .15s}
.yyp-input:focus{border-color:var(--yyp-accent,#00ff66)}
.yyp-input::placeholder{color:rgba(160,160,160,.45)}

.yyp-select{background:#000;border:1px solid var(--yyp-border,#1a1a1a);border-radius:4px;padding:6px 8px;color:#fff;font-family:ui-monospace,SF Mono,Menlo,monospace;font-size:12px;outline:none;transition:border-color .15s}
.yyp-select:focus{border-color:var(--yyp-accent,#00ff66)}

.yyp-slider{position:relative;height:6px;width:100%;background:rgba(255,255,255,.15);border-radius:999px;cursor:pointer;overflow:hidden;outline:none;user-select:none}
.yyp-slider-fill{position:absolute;height:100%;left:0;top:0;background:var(--yyp-accent,#00ff66);transition:background-color .15s}
.yyp-slider-handle{position:absolute;top:50%;transform:translate(-50%,-50%);height:10px;width:10px;border-radius:50%;background:#fff;border:1px solid var(--yyp-accent,#00ff66);box-shadow:0 0 3px rgba(0,0,0,.5);opacity:0;transition:opacity .15s}
.yyp-slider:hover .yyp-slider-handle,.yyp-slider:focus-visible .yyp-slider-handle{opacity:1}

.yyp-spinner{display:inline-flex;align-items:center;justify-content:center;pointer-events:none}
.yyp-spinner-svg{animation:yyp-rot 1s linear infinite;height:40px;width:40px;color:var(--yyp-accent,#00ff66)}

@keyframes yyp-rot{to{transform:rotate(360deg)}}
@keyframes yyp-pulse{0%,100%{opacity:1}50%{opacity:.3}}
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
  variant?: 'primary' | 'warning' | 'neutral' | 'rec';
}

export const Badge: React.FC<BadgeProps> = ({ label, variant = 'neutral' }) => {
  useEffect(() => {
    ensureStyles();
  }, []);

  const getVariantClass = () => {
    switch (variant) {
      case 'primary':
        return 'yyp-badge-primary';
      case 'warning':
        return 'yyp-badge-warning';
      case 'rec':
        return 'yyp-badge-rec';
      default:
        return 'yyp-badge-neutral';
    }
  };

  return (
    <span className={`yyp-badge ${getVariantClass()}`}>
      {label}
    </span>
  );
};

// ==================== BRUTALIST BUTTON ====================
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  variant?: 'default' | 'ghost';
}

export const Button: React.FC<ButtonProps> = ({ children, active, variant = 'default', className = '', ...props }) => {
  useEffect(() => {
    ensureStyles();
  }, []);

  const getVariantClass = () => {
    if (variant === 'ghost') {
      return 'yyp-btn-ghost';
    }
    return active ? 'yyp-btn-active' : 'yyp-btn-default';
  };

  return (
    <button
      className={`yyp-btn ${getVariantClass()} ${className}`}
      aria-pressed={active}
      {...props}
    >
      {children}
    </button>
  );
};

// ==================== SLIDER (VOLUME / TIMELINE) ====================
export interface SliderProps {
  value: number; // 0 to 100
  onChange: (value: number) => void;
  className?: string;
  hoverPreview?: boolean;
}

export const Slider: React.FC<SliderProps> = ({ value, onChange, className = '' }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  useEffect(() => {
    ensureStyles();
  }, []);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (!containerRef.current) return;
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
    const x = e.clientX - rect.left;
    const pct = Math.max(0, Math.min(100, (x / rect.width) * 100));
    onChange(pct);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    let step = 1;
    if (e.shiftKey) {
      step = 10;
    }

    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      onChange(Math.min(100, value + step));
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      onChange(Math.max(0, value - step));
    } else if (e.key === 'Home') {
      e.preventDefault();
      onChange(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      onChange(100);
    }
  };

  return (
    <div
      ref={containerRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="slider"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
      className={`yyp-slider ${className}`}
    >
      <div className="yyp-slider-fill" style={{ width: `${value}%` }} />
      <div className="yyp-slider-handle" style={{ left: `calc(${value}% - 5px)` }} />
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
export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

export const Input: React.FC<InputProps> = ({ className = '', ...props }) => {
  useEffect(() => {
    ensureStyles();
  }, []);

  return (
    <input
      className={`yyp-input ${className}`}
      {...props}
    />
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

