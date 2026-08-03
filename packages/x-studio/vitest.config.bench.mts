/**
 * Vitest configuration for x-studio pipeline benchmarks.
 *
 * Run with:  pnpm bench:vitest
 * Or from root:  pnpm --filter "@mui/x-studio" run bench:vitest
 *
 * NOT `pnpm bench`: that script is `tsx src/benchmarks/run.ts`, a standalone runner with its own
 * timing loop that never reads this file. This header used to name it, so the one command it
 * told you to run was the one command that ignores every setting below.
 *
 * Uses the Node environment — no DOM, no React, no jsdom startup overhead.
 * Only files matching `src/benchmarks/**\/*.bench.ts` are run — see `benchmark.include`, which
 * is the option bench mode reads. `test.include` is NOT it: with the glob written only there,
 * vitest ran with its own default `**\/*.{bench,benchmark}.?(c|m)[jt]s?(x)` — printed by vitest
 * itself on a no-match run — so the filter this header described was never the one in force.
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
    // Kept for a plain `vitest --config vitest.config.bench.mts` (test mode); bench mode does
    // not read it. The glob that actually selects benchmark files is `benchmark.include`.
    include: ['src/benchmarks/**/*.bench.ts'],
    globals: true,
    // A run that matches no file still exits 0 ("No benchmark files found, exiting with code
    // 0"), so this project is green when it runs nothing. Deliberate — the benchmarks are not a
    // pass/fail suite — but it does mean nothing here is protected by a red run.
    passWithNoTests: true,
    benchmark: {
      include: ['src/benchmarks/**/*.bench.ts'],
      // Sampling parameters are NOT configurable here. `BenchmarkUserOptions` declares only
      // include/exclude/includeSource/reporters/outputFile/compare/outputJson/includeSamples;
      // vitest passes tinybench's `time`/`iterations`/`warmupTime`/`warmupIterations` as the
      // THIRD argument of `bench()`. This block previously carried `warmupIterations: 3` and
      // `iterations: 10` — excess properties, dropped silently at runtime. Moving them to
      // `bench()`'s third argument made the API accept them but did NOT make them bind:
      // measured, a 10,000x change in `iterations` moved the sample count by less than two
      // runs at a fixed value moved it. `pipeline.bench.ts` carries the numbers and the reason
      // this suite now samples at tinybench's defaults on purpose.
      reporters: ['default'],
    },
  },
});
