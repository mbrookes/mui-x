import type { VegaAggregateOp } from '../types';
import { toNumber } from '../compile/fieldTypes';

/** Linear-interpolation quantile (matches d3.quantile) over a pre-sorted array. */
function quantile(sorted: readonly number[], p: number): number | null {
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
 * aggregation. Returns undefined for ops that are not implemented so callers
 * can report a gap.
 */
export function evaluateAggregate(
  op: VegaAggregateOp,
  values: unknown[],
): number | null | undefined {
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
    case 'product':
      return numbers.length === 0 ? null : numbers.reduce((acc, value) => acc * value, 1);
    default:
      return undefined;
  }
}
