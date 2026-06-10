import { defineConfig } from 'vitest/config';

// The UI package ships React components but had no test harness. This config
// runs the component tests in a jsdom DOM (the transformer handles the
// automatic JSX runtime, matching tsconfig `jsx: "react-jsx"`). No real
// WebCodecs/AudioContext is touched — the player is mocked at the
// `PlayerHandle` seam; see vitest.setup.ts for the PointerEvent polyfill.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
