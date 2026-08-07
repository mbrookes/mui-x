/**
 * Chart aggregation — composition point.
 *
 * The implementation was split into focused modules; this file stays as the stable
 * import path (`./chartAggregation`) that existing consumers already reference:
 *
 * - `chartSupport.ts`  — relationship / chart-support analysis + fan-out-safe row
 *   resolution (`analyzeChartSupport`, `resolveChartRowsForAggregation`, …).
 * - `aggregators.ts`   — generic aggregators (`aggregateByField`, `aggregateByTwoFields`,
 *   `aggregateMultipleSeries`, `aggregateBlendedSeries`) + the rank-on-aggregated helpers,
 *   sharing one `orderLabels` sort implementation.
 * - `chartShapes/`     — chart-type-specific prep (scatter / heatmap / sankey / funnel).
 *
 * The prior L4 row re-anchoring and join-key coercion already live in
 * `grainResolution.ts` / `joinKeys.ts`; `chartSupport.ts` delegates to them.
 */
export * from './chartSupport';
export * from './aggregators';
export * from './chartShapes';
