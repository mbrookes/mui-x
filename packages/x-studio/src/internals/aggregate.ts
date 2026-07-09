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
 * - everything else (null, undefined, NaN, strings, objects) → `null` (skipped).
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
  return null;
}

/**
 * Reduce an array of already-coerced numeric values to a single aggregate.
 *
 * - `count` returns the element count of `values`;
 * - `count_distinct` returns the number of distinct values;
 * - `sum`/`avg`/`min`/`max` return 0 for an empty set.
 *
 * Note: `count` over a row set that should include null rows must be computed by
 * the caller from `rows.length` (see `computeAggregate`), not by passing a
 * null-filtered value array here.
 */
export function aggregateNumbers(values: number[], fn: AggregateFn): number {
  if (fn === 'count') {
    return values.length;
  }
  if (fn === 'count_distinct') {
    return new Set(values).size;
  }
  if (values.length === 0) {
    return 0;
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
