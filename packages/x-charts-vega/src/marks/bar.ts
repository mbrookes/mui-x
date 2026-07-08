import type { CompiledUnit, UnitContext } from '../compile/context';

/*
 * OWNERSHIP: the "bar mark" work unit owns this file.
 *
 * Implement translation of the `bar` (and rectangular `rect`-as-bar) mark to
 * x-charts `type: 'bar'` series:
 * - vertical bars (band x, quantitative y) and horizontal bars (quantitative
 *   x, band y → series `layout: 'horizontal'`);
 * - color-field splitting into one series per group (use
 *   `resolveColor(ctx.encoding, ...)` from ../compile/color), aligning each
 *   series' `data` array to `ctx.x.categories` (null for empty cells);
 * - stacking: Vega-Lite default stacks bars sharing a category —
 *   `stack: 'zero'`/default → same `stack` id; `'normalize'` → also
 *   `stackOffset: 'expand'`; `'center'` → `stackOffset: 'silhouette'`;
 *   `stack: null` + xOffset → grouped bars (no stack id);
 * - static mark/value colors via `color` on the series.
 * Report gaps for x2/y2 ranged bars and corner radius via ctx.gaps.
 */
export function compileBarMark(ctx: UnitContext): CompiledUnit {
  ctx.gaps.add({
    code: 'mark:bar-not-implemented',
    message: 'The bar mark compiler is not implemented yet.',
    severity: 'unsupported',
    path: ctx.unit.path,
  });
  return { series: [], plots: [] };
}
