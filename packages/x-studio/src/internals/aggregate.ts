/**
 * Shared numeric aggregation primitives.
 *
 * Before this module, five separate reducers each hand-rolled sum/avg/min/max/count
 * with subtly different null / boolean / NaN handling — the divergence behind the
 * "measure expressions count null rows as 0" bug (review finding 1.6):
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

/** Aggregation functions supported over a numeric value set. */
export type AggregateFn = 'sum' | 'avg' | 'count' | 'min' | 'max' | 'count_distinct';

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
 *   skipping every value and rendering flat-zero charts (finding 1.6). Empty /
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
  if (fn === 'count') {
    return values.length;
  }
  if (fn === 'count_distinct') {
    return new Set(values).size;
  }
  if (values.length === 0) {
    // The empty-set policy, decided deliberately and shared with `gridGrouping.ts`'s
    // `aggregateValues` (H4):
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
