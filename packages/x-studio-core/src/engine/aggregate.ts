/**
 * Shared numeric aggregation primitives.
 *
 * Before this module, five separate reducers each hand-rolled sum/avg/min/max/count with subtly
 * different null / boolean / NaN handling — the divergence behind the "measure expressions count
 * null rows as 0" bug:
 *
 * - `computeAggregate`   (`StudioKpiWidget/kpiUtils.ts`)  — the reference, correct one
 * - `aggregateValues`    (`StudioMapWidget/StudioMapWidget.tsx`)
 * - `addToAgg`/`resolveAgg` (`StudioPivotWidget/pivotUtils.ts`)
 * - `aggregate`          (`utils/expressionEvaluator.ts`)  — the buggy one
 * - `CellAcc`/`finalizeCell` (`internals/aggregators.ts`)
 *
 * All five now route through the single null-skip + boolean-coercion policy here
 * so they can no longer drift apart.
 *
 * Two shapes are provided:
 * - array-based reduction ({@link aggregateNumbers}) for callers that already hold
 *   the value list (KPI, map, expression measures);
 * - a streaming accumulator ({@link AggregateAccumulator} + helpers) for callers
 *   that fold values one at a time over large row sets without buffering them
 *   (pivot matrix cells, multi-series chart aggregation).
 */

import type { StudioExpressionField, StudioAggregationFn } from '../models';
// `expressionEvaluator` imports the pure primitives at the top of this module, so this is a
// module cycle — a deliberate one. Both sides consume the other only from FUNCTION BODIES
// (never at module-evaluation time) and both export hoisted function declarations, so the
// live bindings are resolved by the time either is called. Keeping `resolveMeasureAggregate`
// here is what lets every bucket-producing path (KPI, pivot, charts) reach measure evaluation
// through the one aggregation module instead of each re-deriving it.
import { evaluateMeasure } from '../utils/expressionEvaluator';

/**
 * Aggregation functions supported over a value set.
 *
 * The `count` family carries three DIFFERENT questions, and every path in the package
 * must answer each of them the same way:
 * - `count` — `COUNT(*)`: how many ROWS landed here, regardless of whether this
 *   particular measure had a usable value in them. This is the semantic the KPI
 *   (`computeAggregate`), the grid footer/group-by (`gridGrouping.aggregateValues`),
 *   the pivot (`pivotUtils.resolveAgg`) and all three chart aggregators already use,
 *   so it is THE meaning of the bare name `count`.
 * - `count_non_null` — `COUNT(col)`: how many rows had a non-null value for the
 *   measure. Standard SQL's column count. Distinct name, distinct number.
 * - `count_distinct` — `COUNT(DISTINCT col)` over the RAW values.
 *
 * `count_non_null` is deliberately NOT part of the persisted `StudioKpiAggregation` /
 * `StudioGridSummaryAggregation` unions: it exists here so the semantic has a name and
 * a single implementation, and so no path can quietly re-use `count` to mean it.
 *
 * Making it USER-SELECTABLE is a bigger change than widening those two unions, and widening them
 * alone is worse than leaving it internal — a doc carrying `count_non_null` would then LOAD and
 * be silently mis-answered. Everything below has to move in the same commit:
 * - `utils/gridSummary.aggregationLabel` ends in `default: return ''`, so a grid summary cell
 *   would render its number with no label at all;
 * - `utils/gridSummary`'s non-numeric fallback (`agg !== 'count' && agg !== 'count_distinct'`)
 *   silently downgrades anything else to `count` on a string column — a DIFFERENT number than
 *   the user asked for, which is exactly the finding-M8 class this module exists to prevent;
 * - `internals/chartTypeRegistry.AggFn` and `server/aggregationPushdown` are a separate union
 *   and a separate client-only allow-list. Note the wire protocol's `count` already IS
 *   `COUNT(column)`, so `count_non_null` is the one count that could push down faithfully —
 *   `isClientOnlyAggFn` would need to say so rather than inherit `count`'s exclusion;
 * - `components/StudioComposeDrawer/{KpiSetupPanel,GridSetupPanel}` and
 *   `StudioExpressionFieldDialog/ExpressionNodeEditor` own the option lists, and
 *   `x-studio-ai-middleware/studioAITools` enumerates the fns for the model.
 * The KPI (`kpiUtils.computeAggregate`), the grid group-by (`gridGrouping.aggregateValues`) and
 * the expression evaluator already route through `aggregateCellValues` and would answer
 * correctly today; `StudioMapWidget` is unaffected (its own `SAFE_MAP_AGGREGATIONS` allow-list).
 */
/**
 * The aggregation vocabulary. An alias of `@mui/x-studio-schema`'s `StudioAggregationFn`, which is
 * where the union now lives: it has three implementers that must agree — these aggregators, the
 * wire protocol, and the executor capability model — so it belongs in the package all three
 * already depend on. The name is kept because ~40 call sites read it.
 */
export type AggregateFn = StudioAggregationFn;

/**
 * Coerce a raw cell value to a number for aggregation, or `null` when the value
 * must be skipped. Mirrors the KPI widget's `computeAggregate` policy (the
 * reference "correct" behaviour):
 * - booleans → 0/1 (so `avg` yields a ratio);
 * - finite numbers → themselves;
 * - numeric strings (`"12"`, `"-2.5"`) → their parsed number. CSV/JSON sources
 *   have no native number type, so measures routinely arrive as numeric strings;
 *   parsing them here keeps every accumulator (KPI, pivot, map, chart) in agreement
 *   with the `Number.isNaN(Number(v))` pre-detect the chart aggregators use to
 *   decide whether a field is numeric. Without this, a numeric-string measure
 *   passed the pre-detect as "numeric" but was then rejected by this coercion,
 *   skipping every value and rendering flat-zero charts. Empty /
 *   whitespace-only strings are NOT numeric (`Number('')` is `0`), so they skip;
 * - everything else (null, undefined, NaN, non-numeric strings, objects) → `null`
 *   (skipped).
 *
 * Skipping (rather than coercing to 0) keeps null/non-numeric rows out of `avg`
 * denominators and `min`/`max` comparisons.
 */
export function coerceAggregateValue(value: unknown): number | null {
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (typeof value === 'number') {
    return Number.isNaN(value) ? null : value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * Reduce an array of already-coerced numeric values to a single aggregate.
 *
 * - `count` returns the element count of `values`;
 * - `count_distinct` returns the number of distinct values;
 * - `sum` returns 0 for an empty set;
 * - `avg`/`min`/`max` return `null` for an empty set.
 *
 * Note: `count` over a row set that should include null rows must be computed by
 * the caller from `rows.length` (see `computeAggregate`), not by passing a
 * null-filtered value array here.
 */
export function aggregateNumbers(values: number[], fn: AggregateFn): number | null {
  if (fn === 'count' || fn === 'count_non_null') {
    // `values` is already the coerced, null-skipped list, so both counts collapse to its
    // length here. Callers that need the true `COUNT(*)` (null rows included) must go
    // through `aggregateCellValues` / `computeAggregate` with the RAW cell values.
    return values.length;
  }
  if (fn === 'count_distinct') {
    return new Set(values).size;
  }
  if (values.length === 0) {
    // The empty-set policy, decided deliberately and shared with `gridGrouping.ts`'s
    // `aggregateValues`:
    // - `sum` → 0. Summing nothing is the additive identity; 0 is the honest answer and
    //   the one every SQL engine and spreadsheet gives.
    // - `avg`/`min`/`max` → `null`. There is no average/minimum/maximum of nothing, so a
    //   0 here INVENTS a data point: an all-null "Oslo" temperature bucket plotted at
    //   0 °C, sorting above a real −4 °C "Rome" under `chartSortBy: 'value'` or a Top-N.
    //   Returning 0 also made this reducer disagree with both of its siblings —
    //   `finalizeAccumulator` below and `gridGrouping.ts`'s `aggregateValues` return
    //   `null` for identical input — so a KPI displayed "0" where the grid showed
    //   nothing, breaking the documented "a KPI over a raw field and over a measure
    //   expression return the same number" invariant.
    return fn === 'sum' ? 0 : null;
  }
  switch (fn) {
    case 'avg':
      return values.reduce((acc, v) => acc + v, 0) / values.length;
    // `Math.min(...values)` / `Math.max(...values)` throw `RangeError: Maximum call
    // stack size exceeded` once `values` is large enough (~125k+ args in Node 22),
    // so reduce with a loop instead — mirrors `utils/gridSummary.ts`.
    case 'min':
      return values.reduce((acc, v) => (v < acc ? v : acc));
    case 'max':
      return values.reduce((acc, v) => (v > acc ? v : acc));
    case 'sum':
    default:
      return values.reduce((acc, v) => acc + v, 0);
  }
}

/**
 * Count of distinct values, excluding `null`/`undefined` — the standard SQL
 * `COUNT(DISTINCT)` semantic.
 *
 * Distinctness is measured over the RAW cell values (strings, dates, numbers, …),
 * never the numeric coercion used for `sum`/`avg`/`min`/`max`. Routing a
 * `count_distinct` through {@link aggregateNumbers} (which sees only the coerced
 * `number[]`) collapses a distinct count over a string field to `0`, because every
 * non-numeric string coerces to `null` and is dropped. This helper is the single
 * source of truth shared by the KPI (`computeAggregate`), grid summary/grouping, and
 * measure-expression paths so all three return the same number for the same data —
 * the documented "KPI over a raw field and a measure expression return the same
 * number" invariant. `null`/`undefined` are a missing value, not a distinct value,
 * so they never contribute to the count (matching standard SQL and the grid paths).
 */
export function countDistinct(values: Iterable<unknown>): number {
  const seen = new Set<unknown>();
  for (const value of values) {
    if (value !== null && value !== undefined) {
      seen.add(value);
    }
  }
  return seen.size;
}

/**
 * Aggregate one RAW cell value per row — the single place that decides what each
 * aggregation NAME means over a row set.
 *
 * Every whole-row-set reducer in the package routes through this, so `count` can no
 * longer mean `COUNT(*)` on one path (KPI / grid footer / chart bars) and "count of
 * numerically-valid values" on another (measure expressions). Before this, a KPI over
 * `amount` with aggregation `count` returned 10 for a 10-row source with 3 null
 * amounts, while a KPI whose value field was the measure `count(amount)` returned 7 —
 * same dashboard, same question, two answers.
 *
 * `values` must contain exactly ONE entry per row (use `undefined` for a missing key),
 * because `count` is defined as `values.length`.
 *
 * - `count` → `values.length` (`COUNT(*)`, null rows included);
 * - `count_non_null` → the number of non-null/undefined entries (`COUNT(col)`);
 * - `count_distinct` → {@link countDistinct} over the RAW values;
 * - `sum`/`avg`/`min`/`max` → {@link aggregateNumbers} over the
 *   {@link coerceAggregateValue}-coerced, null-skipped values.
 */
export function aggregateCellValues(values: readonly unknown[], fn: AggregateFn): number | null {
  if (fn === 'count') {
    return values.length;
  }
  if (fn === 'count_non_null') {
    let count = 0;
    for (const value of values) {
      if (value !== null && value !== undefined) {
        count += 1;
      }
    }
    return count;
  }
  if (fn === 'count_distinct') {
    return countDistinct(values);
  }
  const numeric: number[] = [];
  for (const value of values) {
    const coerced = coerceAggregateValue(value);
    if (coerced !== null) {
      numeric.push(coerced);
    }
  }
  return aggregateNumbers(numeric, fn);
}

/** Streaming accumulator for aggregating values without buffering them. */
export interface AggregateAccumulator {
  sum: number;
  count: number;
  min: number;
  max: number;
}

/** Create a fresh, empty accumulator. */
export function createAggregateAccumulator(): AggregateAccumulator {
  return { sum: 0, count: 0, min: Infinity, max: -Infinity };
}

/** Fold one numeric value into the accumulator. */
export function accumulateValue(acc: AggregateAccumulator, value: number): void {
  acc.sum += value;
  acc.count += 1;
  if (value < acc.min) {
    acc.min = value;
  }
  if (value > acc.max) {
    acc.max = value;
  }
}

/**
 * Resolve a streaming accumulator to its aggregate value, or `null` for an empty
 * accumulator (so callers can distinguish "no data" from a real 0 — line/area
 * charts render gaps rather than collapsing to zero).
 *
 * Note the deliberate divergence from {@link aggregateNumbers} for `sum`: this returns
 * `null` for an empty accumulator where `aggregateNumbers` returns 0. The two answer
 * different questions. `aggregateNumbers` reduces a WHOLE value set the caller chose to
 * aggregate (a KPI, a grid summary), where "the sum of no rows" is meaningfully 0. This
 * resolves ONE CELL of a grid/series that the caller will plot positionally, where the
 * cell must be able to say "no row ever landed here" — a bar/point rendered at 0 is
 * indistinguishable from a genuine zero measurement, and a line collapsing to the axis
 * is a fabricated trend. Both `null`s are then rendered as gaps by the chart layer.
 */
export function finalizeAccumulator(
  acc: AggregateAccumulator | undefined,
  fn: Exclude<AggregateFn, 'count_distinct'>,
): number | null {
  if (!acc || acc.count === 0) {
    return null;
  }
  switch (fn) {
    case 'count':
    case 'count_non_null':
      return acc.count;
    case 'avg':
      return acc.sum / acc.count;
    case 'min':
      return acc.min === Infinity ? null : acc.min;
    case 'max':
      return acc.max === -Infinity ? null : acc.max;
    case 'sum':
    default:
      return acc.sum;
  }
}

// ─── Rank scoring ─────────────────────────────────────────────────────────────

/** Which end of a ranking survives: `'top'` keeps the highest scores, `'bottom'` the lowest. */
export type RankDirection = 'top' | 'bottom';

/**
 * Reduce one rank candidate's measurements to a single score, skipping the `null`s.
 *
 * `null` values are ABSENT measurements, not zeros, so they contribute nothing: they
 * neither add 0 to a sum, nor pull an average toward 0, nor win a `min`/`max` against a
 * real value. When every value is null the candidate has NO DATA and the score is
 * `null` — which {@link compareRankScores} sorts to the losing end in EITHER direction.
 *
 * Shared by the post-aggregation chart rankers (`aggregators.ts`) and the row-level rank
 * filter (`filterUtils.ts`), which used to seed each group at a concrete `0` instead. That
 * made an all-null group win a "Top 1 by profit" against two genuinely negative groups on
 * every row-level widget (grid/KPI/map/pivot/heatmap/funnel), while the bar chart's
 * post-aggregation ranker — already null-aware — picked the real winner.
 */
export function reduceRankScore(
  values: Iterable<number | null | undefined>,
  fn: 'sum' | 'avg' | 'min' | 'max',
): number | null {
  const acc = createAggregateAccumulator();
  for (const value of values) {
    if (value !== null && value !== undefined) {
      accumulateValue(acc, value);
    }
  }
  return finalizeAccumulator(acc, fn);
}

/**
 * Order two rank scores so a `null` ("no data") candidate always LOSES, whichever end of
 * the ranking is being kept.
 *
 * A no-data candidate must never win a slot in a Top-N *or* a Bottom-N: coercing its score
 * to 0 outranks every negative measurement in a Top-N and undercuts every positive one in a
 * Bottom-N, and coercing it to ±Infinity beats every real measurement outright.
 *
 * Equality is tested before subtracting so two no-data candidates compare as 0 rather than
 * producing `NaN`; a NaN comparator is not a consistent ordering, which makes the surviving
 * set engine-dependent.
 */
export function compareRankScores(
  a: number | null | undefined,
  b: number | null | undefined,
  dir: RankDirection,
): number {
  const av = a ?? null;
  const bv = b ?? null;
  if (av === null || bv === null) {
    if (av === bv) {
      return 0;
    }
    return av === null ? 1 : -1;
  }
  if (av === bv) {
    return 0;
  }
  return dir === 'top' ? bv - av : av - bv;
}

// ─── Measure expression fields ────────────────────────────────────────────────

/**
 * Resolve `fieldId` to a MEASURE expression field (`isMeasure: true`), or `undefined`
 * when it is a plain data-source field / a non-measure (row-level) expression column.
 *
 * A measure has no per-row value at all — `enrichRowsWithExpressions` deliberately skips
 * measures, so `row[measureId]` is always `undefined` — and must instead be evaluated once
 * over the FULL row set of each bucket. Callers use this to decide which of the two paths
 * to take before reading `row[fieldId]`.
 */
export function findMeasureExpressionField(
  fieldId: string,
  expressionFields: readonly StudioExpressionField[] | undefined,
): StudioExpressionField | undefined {
  if (!fieldId || !expressionFields || expressionFields.length === 0) {
    return undefined;
  }
  return expressionFields.find((ef) => ef.id === fieldId && ef.isMeasure);
}

/**
 * Aggregate a MEASURE expression field over `rows` — the shared entry point every
 * bucket-producing path (KPI, pivot, and all three chart aggregators) uses so a measure
 * returns the same number wherever it is placed.
 *
 * Returns `null` — never `0` — when the measure cannot be evaluated at all: an empty row
 * set, a `fieldId` that is not a measure expression field, or a non-finite result. This
 * package's doctrine is "null means not measured, not zero": a fabricated 0 is
 * indistinguishable from a genuine zero measurement, so it plots a real bar/point, wins a
 * Top-N against real negative values, and leads a descending value sort.
 *
 * A measure that genuinely evaluates to 0 still returns 0.
 */
export function resolveMeasureAggregate(
  rows: Record<string, unknown>[],
  fieldId: string,
  expressionFields: StudioExpressionField[],
): number | null {
  if (rows.length === 0) {
    return null;
  }
  const measure = findMeasureExpressionField(fieldId, expressionFields);
  if (!measure) {
    return null;
  }
  const value = evaluateMeasure(measure, rows, expressionFields);
  return value === null || !Number.isFinite(value) ? null : value;
}
