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

/**
 * Fail the run when a registered benchmark takes ZERO samples.
 *
 * This exists because of what happened without it. For at least three rounds `pnpm bench:vitest`
 * exited 0 in 3.5 s having printed a results table for ONE of the file's ten describe groups:
 * every group that read a variable assigned in `beforeAll` threw on every iteration, because
 * `beforeAll` does not run before a bench body in vitest 4.1.8 bench mode. And a bench body that
 * throws emits no `✓` line, no results table, no error text, and does not affect the exit code —
 * measured with a bench that threw unconditionally. So 28 of 31 benchmarks were inert, the
 * summary still listed all ten groups by name (with no numbers, and one line reading literally
 * `NaNx faster than …`), and three consecutive rounds discussed the SAMPLING PARAMETERS of a
 * suite that was taking no samples.
 *
 * Hoisting the data construction out of `beforeAll` fixes today's instance. This reporter is the
 * part that matters: it turns the next silent instance into a red run. A benchmark that runs is
 * one whose `samples` array is non-empty — everything else about a bench (hz, mean, rme) is
 * derived from that array, and an empty one is the single observable both failure modes share.
 *
 * Known limit, stated rather than left to be rediscovered: this can only judge benchmarks that
 * were REGISTERED. A run that matches no file at all is still green (`passWithNoTests`, below),
 * and so is a file that fails to import.
 */
class ZeroSampleGuard {
  onTestRunEnd(modules: readonly any[]): void {
    const inert: string[] = [];
    let total = 0;
    const walk = (node: any, path: string[]): void => {
      if (node.type === 'test') {
        total += 1;
        // `sampleCount`, not `samples.length`: `benchmark.includeSamples` defaults to false, so
        // the samples ARRAY is dropped from the reported result for every bench including the
        // ones that ran. Reading it flagged all 31 — a guard that fires on everything is the
        // same as no guard, and it took a run to see that rather than a reading of the option.
        const result = node.task?.result?.benchmark;
        if ((result?.sampleCount ?? result?.samples?.length ?? 0) === 0) {
          inert.push([...path, node.name].join(' > '));
        }
        return;
      }
      const next = node.type === 'module' ? path : [...path, node.name];
      for (const child of node.children ?? []) {
        walk(child, next);
      }
    };
    for (const module of modules ?? []) {
      walk(module, []);
    }
    if (inert.length === 0) {
      return;
    }
    process.exitCode = 1;
    const listed = inert.map((name) => `  - ${name}`).join('\n');
    console.error(
      [
        `\nMUI X Studio benchmarks: ${inert.length} of ${total} benchmarks produced ZERO samples.`,
        'A bench body that throws is silent in vitest bench mode — no results table and no error text — so a zero-sample count is the only evidence that it never ran.',
        'Check that nothing the body reads is assigned in a `beforeAll`: that hook does not run before a bench body. Build the data at module or describe scope instead.',
        listed,
      ].join('\n'),
    );
  }
}

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
      reporters: ['default', new ZeroSampleGuard()],
    },
  },
});
