import { describe, it, expect } from 'vitest';
import { shouldDecodeFrame } from '../index.js';

describe('shouldDecodeFrame — keyframe-only gate', () => {
  describe('normal speeds (< 4×)', () => {
    it('accepts keyframes at 1×', () => {
      expect(shouldDecodeFrame(1, true)).toBe(true);
    });

    it('accepts non-keyframes at 1×', () => {
      expect(shouldDecodeFrame(1, false)).toBe(true);
    });

    it('accepts keyframes at 2×', () => {
      expect(shouldDecodeFrame(2, true)).toBe(true);
    });

    it('accepts non-keyframes at 2×', () => {
      expect(shouldDecodeFrame(2, false)).toBe(true);
    });

    it('accepts non-keyframes at 0.25×', () => {
      expect(shouldDecodeFrame(0.25, false)).toBe(true);
    });

    it('accepts non-keyframes at 1.75×', () => {
      expect(shouldDecodeFrame(1.75, false)).toBe(true);
    });
  });

  describe('high speed ×4 (boundary)', () => {
    it('accepts keyframes at exactly 4×', () => {
      expect(shouldDecodeFrame(4, true)).toBe(true);
    });

    it('discards non-keyframes at exactly 4×', () => {
      expect(shouldDecodeFrame(4, false)).toBe(false);
    });
  });

  describe('high speed ×16', () => {
    it('accepts keyframes at 16×', () => {
      expect(shouldDecodeFrame(16, true)).toBe(true);
    });

    it('discards non-keyframes at 16×', () => {
      expect(shouldDecodeFrame(16, false)).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('discards non-keyframes at rates above 16×', () => {
      expect(shouldDecodeFrame(32, false)).toBe(false);
    });

    it('accepts keyframes at rates above 16×', () => {
      expect(shouldDecodeFrame(32, true)).toBe(true);
    });

    it('accepts non-keyframes at 3.99× (just below threshold)', () => {
      expect(shouldDecodeFrame(3.99, false)).toBe(true);
    });

    it('discards non-keyframes at 4.01× (just above threshold)', () => {
      expect(shouldDecodeFrame(4.01, false)).toBe(false);
    });
  });
});
