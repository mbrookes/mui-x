import type { CompiledUnit, UnitContext } from '../compile/context';

/*
 * OWNERSHIP: the "point/scatter marks" work unit owns this file.
 *
 * Implement translation of `point`, `circle`, `square`, and `tick` marks to
 * x-charts `type: 'scatter'` series:
 * - both positional channels quantitative/temporal → scatter data
 *   `{x, y, id}` from raw rows;
 * - one categorical positional channel (strip plot) → scatter against the
 *   band/point axis using category values;
 * - color-field splitting into one series per group (resolveColor);
 * - `size` encoding: quantitative size field has no per-point size support
 *   in MIT scatter — report a `partial` gap (Pro/Premium `zAxis`-style
 *   `sizeValue` may cover it; do not depend on Pro);
 * - `shape` encoding → gap (x-charts scatter markers are uniform);
 * - `tick` → gap noting it renders as points, `square` → gap noting marker
 *   shape is ignored.
 */
export function compilePointMark(ctx: UnitContext): CompiledUnit {
  ctx.gaps.add({
    code: 'mark:point-not-implemented',
    message: 'The point/scatter mark compiler is not implemented yet.',
    severity: 'unsupported',
    path: ctx.unit.path,
  });
  return { series: [], plots: [] };
}
