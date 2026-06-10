import React, { useRef } from 'react';

// Full YouTube-style player chrome (timeline, volume, speed, autoplay, PiP, fullscreen).
export { YumYumPlayerView } from './YumYumPlayerView.js';
export type { YumYumPlayerViewProps, PlayerHandle, PlayerControlKey } from './YumYumPlayerView.js';

// ==================== PREMIUM BADGE ====================
export interface BadgeProps {
  label: string;
  variant?: 'primary' | 'warning' | 'neutral';
}

export const Badge: React.FC<BadgeProps> = ({ label, variant = 'neutral' }) => {
  const getStyles = () => {
    switch (variant) {
      case 'primary':
        return 'bg-accent-primary/10 text-accent-primary border-accent-primary/30';
      case 'warning':
        return 'bg-accent-warning/10 text-accent-warning border-accent-warning/30';
      default:
        return 'bg-surface text-text-secondary border-border-elite';
    }
  };

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono font-bold tracking-wider uppercase border ${getStyles()}`}>
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
  const getStyles = () => {
    if (variant === 'ghost') {
      return 'border-0 bg-transparent hover:bg-white/5';
    }
    return active 
      ? 'p-2 border border-accent-primary bg-accent-primary/5 text-accent-primary shadow-[0_0_8px_rgba(0,255,102,0.1)]' 
      : 'p-2 border hover:bg-surface-hover hover:border-text-secondary/30 bg-surface border-border-elite';
  };

  return (
    <button
      className={`flex items-center justify-center rounded transition-all duration-200 cursor-pointer text-text-primary
        ${getStyles()}
        ${className}`}
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
      className={`relative h-1.5 w-full bg-border-elite/60 rounded-full cursor-pointer overflow-hidden group select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background ${className}`}
    >
      {/* Elapsed Fill */}
      <div
        className="absolute h-full left-0 top-0 bg-accent-primary group-hover:bg-accent-primary/90 transition-colors"
        style={{ width: `${value}%` }}
      />
      {/* Handle */}
      <div
        className="absolute top-1/2 -translate-y-1/2 h-3 w-3 rounded-full bg-text-primary border border-accent-primary shadow opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ left: `calc(${value}% - 6px)` }}
      />
    </div>
  );
};

// ==================== BUFFERING SPINNER ====================
export const Spinner: React.FC = () => {
  return (
    <div className="flex items-center justify-center pointer-events-none" role="status" aria-label="Loading...">
      <svg
        className="animate-spin h-10 w-10 text-accent-primary"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
      >
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="3"
        />
        <path
          className="opacity-75"
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
  return (
    <input
      className={`bg-black border border-border-elite rounded px-3 py-2 text-[10px] font-mono text-white focus:outline-none focus:border-accent-primary transition-all ${className}`}
      {...props}
    />
  );
};

// ==================== SELECT PRIMITIVE ====================
export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {}

export const Select: React.FC<SelectProps> = ({ children, className = '', ...props }) => {
  return (
    <select
      className={`bg-black border border-border-elite rounded px-2 py-1.5 text-[10px] font-mono text-white focus:outline-none transition-all ${className}`}
      {...props}
    >
      {children}
    </select>
  );
};

