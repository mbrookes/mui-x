import { describe, expect, it } from 'vitest';
import {
  accumulateValue,
  aggregateNumbers,
  coerceAggregateValue,
  countDistinct,
  createAggregateAccumulator,
  finalizeAccumulator,
} from './aggregate';
import { computeAggregate } from '../components/widgets/StudioKpiWidget/kpiUtils';
import { computeGridSummary } from '../utils/gridSummary';
import { buildGroupedGridRows } from '../utils/gridGrouping';
import { evaluateMeasure } from '../utils/expressionEvaluator';
import type { StudioDataField, StudioExpressionField } from '../models';

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

  it('parses numeric strings to their number (finding 1.6 — CSV/JSON measures)', () => {
    expect(coerceAggregateValue('5')).toBe(5);
    expect(coerceAggregateValue('12')).toBe(12);
    expect(coerceAggregateValue('-2.5')).toBe(-2.5);
    expect(coerceAggregateValue('0')).toBe(0);
    expect(coerceAggregateValue(' 7 ')).toBe(7); // surrounding whitespace tolerated
  });

  it('skips null, undefined, NaN, non-numeric strings and objects (returns null)', () => {
    expect(coerceAggregateValue(null)).toBe(null);
    expect(coerceAggregateValue(undefined)).toBe(null);
    expect(coerceAggregateValue(NaN)).toBe(null);
    expect(coerceAggregateValue('n/a')).toBe(null);
    expect(coerceAggregateValue('abc')).toBe(null);
    expect(coerceAggregateValue('12abc')).toBe(null); // partially-numeric is not a number
    expect(coerceAggregateValue('')).toBe(null); // empty string is not 0
    expect(coerceAggregateValue('   ')).toBe(null); // whitespace-only is not 0
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

describe('countDistinct', () => {
  it('counts distinct raw values including non-numeric strings and dates', () => {
    expect(countDistinct(['US', 'US', 'EU'])).toBe(2);
    expect(countDistinct([1, 1, 2, 3])).toBe(3);
    const d1 = new Date('2024-01-01');
    // Distinctness is by reference for objects — two separate Date instances are distinct.
    expect(countDistinct([d1, d1])).toBe(1);
  });

  it('excludes null and undefined (SQL COUNT(DISTINCT) semantic)', () => {
    expect(countDistinct(['US', null, 'EU', undefined, 'US'])).toBe(2);
    expect(countDistinct([null, undefined])).toBe(0);
    expect(countDistinct([])).toBe(0);
  });

  it('counts an empty string and 0 as real (non-null) distinct values', () => {
    expect(countDistinct(['', 'a', ''])).toBe(2);
    expect(countDistinct([0, 0, 1])).toBe(2);
  });

  it('accepts any iterable', () => {
    expect(countDistinct(new Set(['a', 'b', 'a']))).toBe(2);
  });
});

// ─── count_distinct invariant across KPI / grid / measure paths (finding 2.23) ──
//
// The three call sites historically disagreed: the KPI path counted null/undefined
// as a distinct value; the grid paths excluded nulls; the measure-expression path
// coerced values to numbers first, collapsing a distinct count over a string field to
// 0. All three must now return the SAME number for the same data — the documented
// "KPI over a raw field and a measure expression return the same number" invariant.
describe('count_distinct is identical across the KPI, grid, and measure paths', () => {
  const gridField = (id: string): StudioDataField => ({ id, label: id, type: 'string' });

  /** All four production distinct-count paths over the same rows/field. */
  function distinctCounts(rows: Record<string, unknown>[], field: string) {
    // KPI path
    const kpi = computeAggregate(rows, field, 'count_distinct');

    // Grid group-by path: fold every row into one group and read the aggregate.
    const grouped = buildGroupedGridRows(
      rows.map((r) => ({ ...r, __g: 'all' })),
      '__g',
      ['__g', field],
      { [field]: 'count_distinct' },
      'w',
    );
    const grid = grouped[0]?.[field] as number;

    // Grid footer summary path: parse the "Unique: N" formatted string back to a number.
    const summary = computeGridSummary(rows, [gridField(field)], {
      fields: { [field]: 'count_distinct' },
    });
    const gridSummary = Number((summary[field] ?? '').replace(/[^\d.-]/g, ''));

    // Measure-expression path
    const measure: StudioExpressionField = {
      id: 'distinctMeasure',
      label: 'Distinct',
      sourceId: 'src',
      isMeasure: true,
      expression: { id: field, aggregation: 'count_distinct' },
    };
    const measureValue = evaluateMeasure(measure, rows, []);

    return { kpi, grid, gridSummary, measure: measureValue };
  }

  it('agrees on a string field with duplicates', () => {
    const rows = [{ region: 'US' }, { region: 'US' }, { region: 'EU' }, { region: 'APAC' }];
    const { kpi, grid, gridSummary, measure } = distinctCounts(rows, 'region');
    expect(kpi).toBe(3);
    expect(grid).toBe(3);
    expect(gridSummary).toBe(3);
    expect(measure).toBe(3);
  });

  it('agrees when null/undefined/missing values are present (all exclude them)', () => {
    const rows = [
      { region: 'US' },
      { region: 'US' },
      { region: 'EU' },
      { region: null },
      { region: undefined },
      {}, // missing key → undefined
    ];
    const { kpi, grid, gridSummary, measure } = distinctCounts(rows, 'region');
    // 2 distinct non-null regions (US, EU) — NOT 3 (the old KPI path counted the null
    // group) and NOT 0 (the old measure path coerced strings to NaN and dropped them).
    expect(kpi).toBe(2);
    expect(grid).toBe(2);
    expect(gridSummary).toBe(2);
    expect(measure).toBe(2);
  });

  it('agrees on a numeric field too', () => {
    const rows = [{ score: 10 }, { score: 10 }, { score: 20 }, { score: null }];
    const { kpi, grid, gridSummary, measure } = distinctCounts(rows, 'score');
    expect(kpi).toBe(2);
    expect(grid).toBe(2);
    expect(gridSummary).toBe(2);
    expect(measure).toBe(2);
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
