import type { CompiledUnit, UnitContext } from '../compile/context';

/*
 * OWNERSHIP: the "boxplot" work unit owns this file.
 *
 * Translate the Vega-Lite composite `boxplot` mark to a `{kind: 'boxes'}`
 * overlay (rendered by src/overlays/BoxPlot.tsx — no x-charts series):
 * - group rows by the categorical positional channel (ctx.x/ctx.y categories,
 *   both orientations); per group compute q1/median/q3 via the quantile
 *   helpers in ../transforms/aggregateOps (or a local sorted-quantile — reuse
 *   evaluateAggregate where possible);
 * - whiskers: Vega-Lite default `extent: 1.5` → 1.5×IQR clamped to the data
 *   extent, values beyond → `outliers`; `extent: 'min-max'` → full extent,
 *   no outliers; numeric extent k → k×IQR;
 * - color: static mark/value color or resolveColor staticColor; a color
 *   FIELD split → 'partial' gap (one box per category, no dodging);
 * - mark.size → widthRatio approximation; opacity/median/box sub-mark
 *   configs → 'ignored' gaps where unmappable;
 * - return { series: [], plots: [], overlays: [{kind: 'boxes', ...}] }.
 * The category axis resolves through scales.ts automatically (boxplot's
 * categorical channel is nominal/ordinal); the value axis is the continuous
 * channel — verify both exist, else gap like the bar compiler does.
 */
export function compileBoxplotMark(ctx: UnitContext): CompiledUnit {
  ctx.gaps.add({
    code: 'mark:boxplot-not-implemented',
    message: 'The boxplot mark compiler is not implemented yet.',
    severity: 'unsupported',
    path: ctx.unit.path,
  });
  return { series: [], plots: [] };
}
