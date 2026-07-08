import type { VegaAggregateOp } from '../types';
import { toNumber } from '../compile/fieldTypes';

/**
 * Shared aggregate-op evaluation for both encoding-level and transform-level
 * aggregation. Returns undefined for ops that are not implemented so callers
 * can report a gap.
 */
export function evaluateAggregate(op: VegaAggregateOp, values: unknown[]): number | null | undefined {
  const numbers = values.map(toNumber).filter((value): value is number => value != null);
  switch (op) {
    case 'count':
      return values.length;
    case 'valid':
      return values.filter((value) => value != null).length;
    case 'missing':
      return values.filter((value) => value == null).length;
    case 'distinct':
      return new Set(values.map((value) => `${typeof value}:${String(value)}`)).size;
    case 'sum':
      return numbers.reduce((acc, value) => acc + value, 0);
    case 'mean':
    case 'average':
      return numbers.length === 0 ? null : numbers.reduce((acc, value) => acc + value, 0) / numbers.length;
    case 'min':
      return numbers.length === 0 ? null : Math.min(...numbers);
    case 'max':
      return numbers.length === 0 ? null : Math.max(...numbers);
    case 'median': {
      if (numbers.length === 0) {
        return null;
      }
      const sorted = [...numbers].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    }
    case 'variance': {
      if (numbers.length < 2) {
        return null;
      }
      const mean = numbers.reduce((acc, value) => acc + value, 0) / numbers.length;
      return numbers.reduce((acc, value) => acc + (value - mean) ** 2, 0) / (numbers.length - 1);
    }
    case 'stdev': {
      const variance = evaluateAggregate('variance', values);
      return variance == null ? null : Math.sqrt(variance);
    }
    default:
      return undefined;
  }
}
