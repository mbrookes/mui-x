import type { CompiledUnit, UnitContext } from '../compile/context';

/*
 * OWNERSHIP: the "rect/heatmap mark" work unit owns this file.
 *
 * Translate the `rect` mark (2D heatmap cells) to an x-charts-pro
 * `type: 'heatmap'` series rendered by the shell's <HeatmapPlot />:
 * - both positional channels discrete (nominal/ordinal/binned/timeUnit —
 *   the pipeline rewrites those to synthetic discrete fields) → cell grid:
 *   series data is `[xIndex, yIndex, value][]` (verify the exact
 *   HeatmapValueType tuple in packages/x-charts-pro/src/models/seriesType/
 *   heatmap.ts) with indexes into ctx.x.categories / ctx.y.categories;
 * - the cell value comes from the color channel (quantitative, usually
 *   aggregated — already folded to a synthetic field by the pipeline);
 * - color scale → a zAxis entry (`CompiledUnit.zAxis`) carrying a
 *   ContinuousColorConfig from resolveColor's `colorMap` (see
 *   ../compile/color.ts) or a sensible default ramp;
 * - return plots: ['heatmap'];
 * - gaps: rect as filled interval (x2/y2 spans), rect without discrete
 *   axes on both channels, missing color value channel.
 */
export function compileRectMark(ctx: UnitContext): CompiledUnit {
  ctx.gaps.add({
    code: 'mark:rect-not-implemented',
    message: 'The rect/heatmap mark compiler is not implemented yet.',
    severity: 'unsupported',
    path: ctx.unit.path,
  });
  return { series: [], plots: [] };
}
