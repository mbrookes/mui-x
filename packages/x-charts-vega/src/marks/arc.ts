import type { CompiledUnit, UnitContext } from '../compile/context';

/*
 * OWNERSHIP: the "arc/pie mark" work unit owns this file.
 *
 * Implement translation of the `arc` mark to an x-charts `type: 'pie'`
 * series:
 * - `theta` (quantitative, often aggregated) → slice `value`; `color` field
 *   → slice `label` (one datum per distinct color value);
 * - `mark.innerRadius`/`outerRadius`/`padAngle`/`cornerRadius` → the pie
 *   series' `innerRadius`/`outerRadius`/`paddingAngle`/`cornerRadius`;
 * - `theta2`/`radius` encodings and non-pie radial layouts → gaps;
 * - text layers on top of arcs (labels) → gap pointing at `arcLabel`.
 *
 * Note the shell renders pie series with <PiePlot /> and no cartesian axes —
 * return `plots: ['pie']` and no axis-aligned data.
 */
export function compileArcMark(ctx: UnitContext): CompiledUnit {
  ctx.gaps.add({
    code: 'mark:arc-not-implemented',
    message: 'The arc/pie mark compiler is not implemented yet.',
    severity: 'unsupported',
    path: ctx.unit.path,
  });
  return { series: [], plots: [] };
}
