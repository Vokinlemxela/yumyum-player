import { defineConfig } from 'tsup';
import { inlineWorker } from './scripts/inline-worker.mjs';

// Pre-build step: bundle & inline the DemuxerWorker (generates the git-ignored
// src/demux/DemuxerWorkerInline.ts). Shared with the pretest/pretypecheck hooks.
inlineWorker();

export default defineConfig([
  // Main SDK bundle
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'es2022',
    outDir: 'dist',
    splitting: false,
    treeshake: true,
  },
]);
