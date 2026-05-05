/**
 * Vitest configuration for x-studio pipeline benchmarks.
 *
 * Run with:  pnpm bench
 * Or from root:  pnpm --filter "@mui/x-studio" run bench
 *
 * Uses the Node environment — no DOM, no React, no jsdom startup overhead.
 * Only files matching **\/benchmarks\/*.bench.ts are included.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(CURRENT_DIR, '../../');

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@mui/x-studio',
        replacement: resolve(CURRENT_DIR, './src'),
      },
    ],
  },
  test: {
    name: 'x-studio-bench',
    environment: 'node',
    include: ['src/benchmarks/**/*.bench.ts'],
    globals: true,
    passWithNoTests: true,
    benchmark: {
      // Warm-up iterations before sampling
      warmupIterations: 3,
      // Number of samples for mean/p75/p99 calculation
      iterations: 10,
      reporters: ['default'],
    },
  },
});
