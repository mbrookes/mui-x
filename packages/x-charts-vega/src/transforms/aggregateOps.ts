import type { DatasetRow, VegaAggregateOp } from '../types';
import { toNumber } from '../compile/fieldTypes';

/** Aggregate ops whose result is a normal-approximation confidence bound. */
export const APPROXIMATE_CI_OPS = ['ci0', 'ci1'] as const;

/** Linear-interpolation quantile (matches d3.quantile) over a pre-sorted array. */
export function quantile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) {
    return null;
  }
  if (sorted.length === 1) {
    return sorted[0];
  }
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sorted[lower];
  }
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function meanOf(numbers: readonly number[]): number | null {
  return numbers.length === 0
    ? null
    : numbers.reduce((acc, value) => acc + value, 0) / numbers.length;
}

/** Sample variance (divide by n - 1); null for fewer than two values. */
function varianceOf(numbers: readonly number[]): number | null {
  if (numbers.length < 2) {
    return null;
  }
  const mean = meanOf(numbers) as number;
  return numbers.reduce((acc, value) => acc + (value - mean) ** 2, 0) / (numbers.length - 1);
}

/** Population variance (divide by n); null for empty input. */
function variancepOf(numbers: readonly number[]): number | null {
  if (numbers.length === 0) {
    return null;
  }
  const mean = meanOf(numbers) as number;
  return numbers.reduce((acc, value) => acc + (value - mean) ** 2, 0) / numbers.length;
}

/**
 * Shared aggregate-op evaluation for both encoding-level and transform-level
 * aggregation. Returns undefined for ops that are not implemented (or for
 * `argmin`/`argmax` when no `rows` are supplied) so callers can report a gap.
 */
export function evaluateAggregate(
  op: VegaAggregateOp,
  values: unknown[],
): number | null | undefined;
export function evaluateAggregate(
  op: VegaAggregateOp,
  values: unknown[],
  rows?: readonly DatasetRow[],
): number | DatasetRow | null | undefined;
export function evaluateAggregate(
  op: VegaAggregateOp,
  values: unknown[],
  rows?: readonly DatasetRow[],
): number | DatasetRow | null | undefined {
  // Ops over the raw values — no numeric conversion needed.
  switch (op) {
    case 'count':
      return values.length;
    case 'valid':
      return values.filter((value) => value != null).length;
    case 'missing':
      return values.filter((value) => value == null).length;
    case 'distinct':
      return new Set(values.map((value) => `${typeof value}:${String(value)}`)).size;
    default:
      break;
  }

  // argmin/argmax return the whole row at the extreme numeric value. Without
  // `rows` to point back at there is nothing to return — signal "unimplemented"
  // so callers gap, matching the pre-rows behavior.
  if (op === 'argmin' || op === 'argmax') {
    if (rows === undefined) {
      return undefined;
    }
    let bestIndex = -1;
    let bestValue = op === 'argmin' ? Infinity : -Infinity;
    for (let i = 0; i < values.length; i += 1) {
      const n = toNumber(values[i]);
      if (n === null) {
        continue;
      }
      if (op === 'argmin' ? n < bestValue : n > bestValue) {
        bestValue = n;
        bestIndex = i;
      }
    }
    return bestIndex === -1 ? null : (rows[bestIndex] ?? null);
  }

  const numbers = values.map(toNumber).filter((value): value is number => value != null);
  switch (op) {
    case 'sum':
      return numbers.reduce((acc, value) => acc + value, 0);
    case 'mean':
    case 'average':
      return meanOf(numbers);
    case 'min':
      return numbers.length === 0 ? null : Math.min(...numbers);
    case 'max':
      return numbers.length === 0 ? null : Math.max(...numbers);
    case 'median':
    case 'q1':
    case 'q3': {
      if (numbers.length === 0) {
        return null;
      }
      const sorted = [...numbers].sort((a, b) => a - b);
      const p = { median: 0.5, q1: 0.25, q3: 0.75 }[op];
      return quantile(sorted, p);
    }
    case 'variance':
      return varianceOf(numbers);
    case 'stdev': {
      const variance = varianceOf(numbers);
      return variance == null ? null : Math.sqrt(variance);
    }
    case 'variancep':
      return variancepOf(numbers);
    case 'stdevp': {
      const variancep = variancepOf(numbers);
      return variancep == null ? null : Math.sqrt(variancep);
    }
    case 'stderr': {
      const variance = varianceOf(numbers);
      return variance == null ? null : Math.sqrt(variance) / Math.sqrt(numbers.length);
    }
    case 'ci0':
    case 'ci1': {
      // Normal-approximation confidence interval: mean ∓ 1.96·stderr.
      if (numbers.length < 2) {
        return null;
      }
      const mean = meanOf(numbers) as number;
      const variance = varianceOf(numbers) as number;
      const stderr = Math.sqrt(variance) / Math.sqrt(numbers.length);
      return op === 'ci0' ? mean - 1.96 * stderr : mean + 1.96 * stderr;
    }
    case 'product':
      return numbers.length === 0 ? null : numbers.reduce((acc, value) => acc * value, 1);
    default:
      return undefined;
  }
}
