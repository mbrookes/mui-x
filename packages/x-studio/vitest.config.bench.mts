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
      // Sampling parameters are NOT configurable here. `BenchmarkUserOptions` declares only
      // include/exclude/includeSource/reporters/outputFile/compare/outputJson/includeSamples;
      // vitest passes tinybench's `time`/`iterations`/`warmupTime`/`warmupIterations` as the
      // THIRD argument of `bench()`. This block previously carried `warmupIterations: 3` and
      // `iterations: 10` with comments describing what they did — excess properties, dropped
      // silently at runtime, so every number this suite ever produced was sampled at
      // tinybench's defaults. They now live in `BENCH_SAMPLING` in `pipeline.bench.ts`, where
      // they take effect. No test could have caught this (`passWithNoTests: true` plus the
      // `include` glob means the project is green when it runs nothing); the typecheck can,
      // which is why `tsconfig.json` now includes `vitest.config.*.mts`.
      reporters: ['default'],
    },
  },
});
