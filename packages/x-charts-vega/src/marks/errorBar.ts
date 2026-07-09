import type { CompiledUnit, UnitContext } from '../compile/context';

/*
 * OWNERSHIP: the "errorbar/errorband" work unit owns this file.
 *
 * Translate the Vega-Lite composite `errorbar` and `errorband` marks to
 * `{kind: 'errorBars'}` / `{kind: 'band'}` overlays (rendered by
 * src/overlays/ErrorBars.tsx):
 * - group rows by the categorical/temporal positional channel; per group
 *   compute the interval per `extent`: 'stderr' (default, mean ± stderr),
 *   'stdev' (mean ± stdev), 'ci' (approximate as mean ± 1.96×stderr — Vega
 *   uses bootstrapped CIs, note the approximation in a 'partial' gap), 'iqr'
 *   (q1..q3) — reuse evaluateAggregate ops from ../transforms/aggregateOps;
 * - errorbar → errorBars overlay items (category, lower, upper, optional
 *   center=mean); errorband → band overlay points sorted by x;
 * - both orientations for errorbar; errorband is x-ordered only (transposed
 *   band → 'partial' gap);
 * - color from static mark/value color; color-field split → 'partial' gap;
 * - these marks are usually LAYERED with line/point marks — the pipeline
 *   already flattens layers, nothing special needed;
 * - return { series: [], plots: [], overlays: [...] }.
 */
export function compileErrorBarMark(ctx: UnitContext): CompiledUnit {
  ctx.gaps.add({
    code: 'mark:errorbar-not-implemented',
    message: 'The errorbar/errorband mark compiler is not implemented yet.',
    severity: 'unsupported',
    path: ctx.unit.path,
  });
  return { series: [], plots: [] };
}
