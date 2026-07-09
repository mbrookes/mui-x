import { describe, expect, it } from 'vitest';
import {
  accumulateValue,
  aggregateNumbers,
  coerceAggregateValue,
  createAggregateAccumulator,
  finalizeAccumulator,
} from './aggregate';

describe('coerceAggregateValue', () => {
  it('coerces booleans to 0/1', () => {
    expect(coerceAggregateValue(true)).toBe(1);
    expect(coerceAggregateValue(false)).toBe(0);
  });

  it('passes finite numbers through', () => {
    expect(coerceAggregateValue(5)).toBe(5);
    expect(coerceAggregateValue(-2.5)).toBe(-2.5);
    expect(coerceAggregateValue(0)).toBe(0);
  });

  it('skips null, undefined, NaN, strings and objects (returns null)', () => {
    expect(coerceAggregateValue(null)).toBe(null);
    expect(coerceAggregateValue(undefined)).toBe(null);
    expect(coerceAggregateValue(NaN)).toBe(null);
    expect(coerceAggregateValue('5')).toBe(null);
    expect(coerceAggregateValue('n/a')).toBe(null);
    expect(coerceAggregateValue({})).toBe(null);
  });
});

describe('aggregateNumbers', () => {
  const values = [1, 2, 3, 4];

  it('reduces sum/avg/min/max', () => {
    expect(aggregateNumbers(values, 'sum')).toBe(10);
    expect(aggregateNumbers(values, 'avg')).toBe(2.5);
    expect(aggregateNumbers(values, 'min')).toBe(1);
    expect(aggregateNumbers(values, 'max')).toBe(4);
  });

  it('counts elements and distinct elements', () => {
    expect(aggregateNumbers([1, 1, 2], 'count')).toBe(3);
    expect(aggregateNumbers([1, 1, 2], 'count_distinct')).toBe(2);
  });

  it('returns 0 for empty sum/avg/min/max but 0 count / 0 distinct too', () => {
    expect(aggregateNumbers([], 'sum')).toBe(0);
    expect(aggregateNumbers([], 'avg')).toBe(0);
    expect(aggregateNumbers([], 'min')).toBe(0);
    expect(aggregateNumbers([], 'max')).toBe(0);
    expect(aggregateNumbers([], 'count')).toBe(0);
    expect(aggregateNumbers([], 'count_distinct')).toBe(0);
  });

  // Regression (finding 1.5): `Math.min(...values)` / `Math.max(...values)` throw
  // `RangeError: Maximum call stack size exceeded` past ~125k args, so a KPI/map widget
  // configured with min/max over a large filtered set crashed mid-render. The loop-based
  // reduction handles arbitrarily large arrays.
  it('computes min/max over a large array without a RangeError', () => {
    const big = new Array<number>(200_000);
    for (let i = 0; i < big.length; i += 1) {
      big[i] = i;
    }
    expect(() => aggregateNumbers(big, 'min')).not.toThrow();
    expect(aggregateNumbers(big, 'min')).toBe(0);
    expect(aggregateNumbers(big, 'max')).toBe(big.length - 1);
  });
});

describe('streaming accumulator', () => {
  it('folds values and finalizes each function', () => {
    const acc = createAggregateAccumulator();
    accumulateValue(acc, 2);
    accumulateValue(acc, 8);
    expect(finalizeAccumulator(acc, 'sum')).toBe(10);
    expect(finalizeAccumulator(acc, 'avg')).toBe(5);
    expect(finalizeAccumulator(acc, 'count')).toBe(2);
    expect(finalizeAccumulator(acc, 'min')).toBe(2);
    expect(finalizeAccumulator(acc, 'max')).toBe(8);
  });

  it('returns null for an empty or missing accumulator', () => {
    expect(finalizeAccumulator(undefined, 'sum')).toBe(null);
    expect(finalizeAccumulator(createAggregateAccumulator(), 'sum')).toBe(null);
    // A never-folded accumulator has min=Infinity/max=-Infinity — surfaced as null,
    // never as the sentinel infinity value.
    const empty = createAggregateAccumulator();
    expect(finalizeAccumulator(empty, 'min')).toBe(null);
    expect(finalizeAccumulator(empty, 'max')).toBe(null);
  });
});
