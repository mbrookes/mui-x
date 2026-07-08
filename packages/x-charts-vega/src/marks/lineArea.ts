import type { CompiledUnit, UnitContext } from '../compile/context';

/*
 * OWNERSHIP: the "line & area marks" work unit owns this file.
 *
 * Implement translation of `line`, `area`, and `trail` marks to x-charts
 * `type: 'line'` series:
 * - `area` → `area: true`; `trail` → line + gap (width encoding unsupported);
 * - series `data` arrays index-aligned to `ctx.x.categories` (band/point/
 *   temporal axes), `null` for missing cells so gaps render;
 * - color-field splitting into one series per group (resolveColor);
 * - `mark.interpolate` → series `curve` ('monotone' → 'monotoneX', 'step*' →
 *   step variants, 'natural' → 'natural', 'basis' → 'bumpX'? — map what
 *   exists, gap the rest);
 * - `mark.point`/point overlays → `showMark: true` and the shell's MarkPlot;
 * - area stacking (`stack` zero/normalize/center like bars, `'expand'`/
 *   `'silhouette'` offsets);
 * - `strokeDash`, `opacity` static props where series support exists, gaps
 *   otherwise.
 */
export function compileLineAreaMark(ctx: UnitContext): CompiledUnit {
  ctx.gaps.add({
    code: 'mark:line-not-implemented',
    message: 'The line/area mark compiler is not implemented yet.',
    severity: 'unsupported',
    path: ctx.unit.path,
  });
  return { series: [], plots: [] };
}
