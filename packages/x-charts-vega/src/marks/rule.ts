import type { CompiledUnit, UnitContext } from '../compile/context';

/*
 * OWNERSHIP: the "arc/pie mark" work unit also owns this file (small).
 *
 * Implement translation of the `rule` mark to `ChartsReferenceLine`s:
 * - a rule with only `y` (datum or single aggregated value) → horizontal
 *   reference line (`referenceLines: [{axis: 'y', value}]`);
 * - only `x` → vertical reference line;
 * - rules spanning x→x2/y→y2 segments per datum → gap (no x-charts segment
 *   primitive);
 * - mark color/strokeDash → lineStyle.
 */
export function compileRuleMark(ctx: UnitContext): CompiledUnit {
  ctx.gaps.add({
    code: 'mark:rule-not-implemented',
    message: 'The rule mark compiler is not implemented yet.',
    severity: 'unsupported',
    path: ctx.unit.path,
  });
  return { series: [], plots: [] };
}
