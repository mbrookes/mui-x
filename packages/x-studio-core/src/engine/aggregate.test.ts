import { describe, expect, it } from 'vitest';
import {
  accumulateValue,
  aggregateCellValues,
  aggregateNumbers,
  coerceAggregateValue,
  compareRankScores,
  countDistinct,
  createAggregateAccumulator,
  finalizeAccumulator,
  reduceRankScore,
  resolveMeasureAggregate,
} from './aggregate';
import { computeAggregate } from './kpiUtils';
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

  // `count_non_null` shares the `count` branch on purpose: `values` reaching this reducer is
  // already the coerced, null-skipped list, so "count of elements" and "count of non-null
  // elements" are the same number here (the true `COUNT(*)` including null rows is computed
  // upstream from the RAW cells by `aggregateCellValues`/`computeAggregate`). Every other
  // caller of this exported function reaches it directly, so without this the fn would fall
  // through to the `default:` sum branch and return the TOTAL of the values instead of how
  // many there are — a silently wrong KPI/aggregation number rather than a crash.
  it('treats count_non_null exactly like count over an already-null-skipped list', () => {
    expect(aggregateNumbers([1, 1, 2], 'count_non_null')).toBe(3);
    // Not the sum (4) and not the distinct count (2).
    expect(aggregateNumbers([1, 1, 2], 'count_non_null')).toBe(
      aggregateNumbers([1, 1, 2], 'count'),
    );
    // …and an empty set counts 0, not `null` (the empty-set policy for avg/min/max).
    expect(aggregateNumbers([], 'count_non_null')).toBe(0);
  });

  // Regression (H4). `avg`/`min`/`max` used to return 0 for an empty set, which invents a
  // data point ("Oslo, 0 °C") and disagreed with both siblings that reduce the same input:
  // `finalizeAccumulator` below and `gridGrouping.ts`'s `aggregateValues` (see its
  // "avg over an all-null/non-numeric group returns null" test) — so a KPI showed "0"
  // where the grid over the same field showed nothing.
  it('returns null for an empty avg/min/max, but 0 for an empty sum/count', () => {
    expect(aggregateNumbers([], 'avg')).toBe(null);
    expect(aggregateNumbers([], 'min')).toBe(null);
    expect(aggregateNumbers([], 'max')).toBe(null);
    // `sum` over nothing is the additive identity — 0 is the honest answer, and it matches
    // `gridGrouping.ts`'s `aggregateValues`.
    expect(aggregateNumbers([], 'sum')).toBe(0);
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

// ─── Cross-path aggregation invariant (findings 2.23 / M8) ────────────────────
//
// "A KPI over a raw field and a KPI over an equivalent measure expression return the
// same number" is a documented invariant of this package. It is enforced here by
// running the SAME rows/field/aggregation through every production path at once.
//
// The fixtures deliberately contain nulls: an aggregation name whose two definitions
// differ only in how they treat missing values coincides on fully-populated data, so a
// table without nulls proves nothing at all about the thing that actually broke.

const gridField = (id: string): StudioDataField => ({ id, label: id, type: 'string' });

/** All four production aggregation paths over the same rows / field / function. */
function crossPathAggregate(
  rows: Record<string, unknown>[],
  field: string,
  fn: 'count' | 'count_distinct',
) {
  // KPI path
  const kpi = computeAggregate(rows, field, fn);

  // Grid group-by path: fold every row into one group and read the aggregate.
  const grouped = buildGroupedGridRows(
    rows.map((r) => ({ ...r, __g: 'all' })),
    '__g',
    ['__g', field],
    { [field]: fn },
    'w',
  );
  const grid = grouped[0]?.[field] as number;

  // Grid footer summary path: parse the "Unique: N" / "Count: N" string back to a number.
  const summary = computeGridSummary(rows, [gridField(field)], { fields: { [field]: fn } });
  const gridSummary = Number((summary[field] ?? '').replace(/[^\d.-]/g, ''));

  // Measure-expression path
  const measure: StudioExpressionField = {
    id: `${fn}Measure`,
    label: fn,
    sourceId: 'src',
    isMeasure: true,
    expression: { id: field, aggregation: fn },
  };
  const measureValue = evaluateMeasure(measure, rows, []);

  return { kpi, grid, gridSummary, measure: measureValue };
}

// `count` is `COUNT(*)` — how many ROWS, regardless of whether this measure had a usable
// value in them. The measure-expression path used to answer two OTHER questions under the
// same name (a count of numerically-valid values for a numeric-like field, a non-null
// `COUNT(col)` for a non-numeric one), so a KPI over `amount` with aggregation `count` read
// 10 while a KPI over the measure `count(amount)` read 7 on the same 10 rows — same
// dashboard, same question, two answers (finding M8).
describe('count is identical across the KPI, grid, and measure paths', () => {
  it('counts every row of a numeric field, nulls included', () => {
    // The exact repro: 10 orders, `amount` null on 3.
    const rows = [
      { amount: 10 },
      { amount: 20 },
      { amount: null },
      { amount: 30 },
      { amount: null },
      { amount: 40 },
      { amount: 50 },
      { amount: undefined },
      { amount: 60 },
      { amount: 70 },
    ];
    const { kpi, grid, gridSummary, measure } = crossPathAggregate(rows, 'amount', 'count');
    // 10 — NOT 7 (the old measure path's count of numerically-valid values).
    expect(kpi).toBe(10);
    expect(grid).toBe(10);
    expect(gridSummary).toBe(10);
    expect(measure).toBe(10);
  });

  it('counts every row of a non-numeric field, nulls included', () => {
    const rows = [{ status: 'paid' }, { status: null }, { status: 'unpaid' }, {}];
    const { kpi, grid, gridSummary, measure } = crossPathAggregate(rows, 'status', 'count');
    // 4 — NOT 2 (the old measure path's SQL `COUNT(col)` for a non-numeric field).
    expect(kpi).toBe(4);
    expect(grid).toBe(4);
    expect(gridSummary).toBe(4);
    expect(measure).toBe(4);
  });

  it('agrees on a fully-populated field too', () => {
    const rows = [{ region: 'US' }, { region: 'EU' }, { region: 'US' }];
    const { kpi, grid, gridSummary, measure } = crossPathAggregate(rows, 'region', 'count');
    expect(kpi).toBe(3);
    expect(grid).toBe(3);
    expect(gridSummary).toBe(3);
    expect(measure).toBe(3);
  });
});

// count_distinct historically disagreed too: the KPI path counted null/undefined as a
// distinct value; the grid paths excluded nulls; the measure-expression path coerced values
// to numbers first, collapsing a distinct count over a string field to 0 (finding 2.23).
describe('count_distinct is identical across the KPI, grid, and measure paths', () => {
  it('agrees on a string field with duplicates', () => {
    const rows = [{ region: 'US' }, { region: 'US' }, { region: 'EU' }, { region: 'APAC' }];
    const { kpi, grid, gridSummary, measure } = crossPathAggregate(
      rows,
      'region',
      'count_distinct',
    );
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
    const { kpi, grid, gridSummary, measure } = crossPathAggregate(
      rows,
      'region',
      'count_distinct',
    );
    // 2 distinct non-null regions (US, EU) — NOT 3 (the old KPI path counted the null
    // group) and NOT 0 (the old measure path coerced strings to NaN and dropped them).
    expect(kpi).toBe(2);
    expect(grid).toBe(2);
    expect(gridSummary).toBe(2);
    expect(measure).toBe(2);
  });

  it('agrees on a numeric field too', () => {
    const rows = [{ score: 10 }, { score: 10 }, { score: 20 }, { score: null }];
    const { kpi, grid, gridSummary, measure } = crossPathAggregate(rows, 'score', 'count_distinct');
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

describe('aggregateCellValues', () => {
  // One entry per row, `undefined` where the key is missing.
  const cells = [10, null, '20', undefined, 'n/a', true];

  it('separates the three count questions (finding M8)', () => {
    // COUNT(*) — every row, whatever it held.
    expect(aggregateCellValues(cells, 'count')).toBe(6);
    // COUNT(col) — the non-null/undefined entries: 10, '20', 'n/a', true.
    expect(aggregateCellValues(cells, 'count_non_null')).toBe(4);
    // COUNT(DISTINCT col) — over the RAW values, nulls excluded.
    expect(aggregateCellValues(cells, 'count_distinct')).toBe(4);
  });

  it('coerces and null-skips for sum/avg/min/max', () => {
    // Usable: 10, 20 (numeric string), 1 (boolean). 'n/a'/null/undefined are skipped.
    expect(aggregateCellValues(cells, 'sum')).toBe(31);
    expect(aggregateCellValues(cells, 'avg')).toBe(31 / 3);
    expect(aggregateCellValues(cells, 'min')).toBe(1);
    expect(aggregateCellValues(cells, 'max')).toBe(20);
  });

  it('keeps the documented empty-set policy', () => {
    expect(aggregateCellValues([], 'count')).toBe(0);
    expect(aggregateCellValues([], 'count_non_null')).toBe(0);
    expect(aggregateCellValues([], 'sum')).toBe(0);
    expect(aggregateCellValues([], 'avg')).toBe(null);
    expect(aggregateCellValues([], 'min')).toBe(null);
    expect(aggregateCellValues([], 'max')).toBe(null);
    // All-null rows still COUNT(*) as rows, but have no sum/avg to report.
    expect(aggregateCellValues([null, undefined], 'count')).toBe(2);
    expect(aggregateCellValues([null, undefined], 'count_non_null')).toBe(0);
    expect(aggregateCellValues([null, undefined], 'avg')).toBe(null);
  });
});

// ─── Rank scoring shared by the row-level and post-aggregation rankers (M9) ────
describe('reduceRankScore', () => {
  it('skips nulls instead of folding them in as 0', () => {
    expect(reduceRankScore([-500, null, undefined], 'sum')).toBe(-500);
    expect(reduceRankScore([2, null, 4], 'avg')).toBe(3);
    expect(reduceRankScore([5, null, 3], 'min')).toBe(3);
    expect(reduceRankScore([5, null, 3], 'max')).toBe(5);
  });

  it('returns null — not 0 — for a candidate with no usable measurement', () => {
    expect(reduceRankScore([], 'sum')).toBe(null);
    expect(reduceRankScore([null, undefined, null], 'sum')).toBe(null);
    expect(reduceRankScore([null], 'min')).toBe(null);
  });
});

describe('compareRankScores', () => {
  it('sorts a null ("no data") score LAST in both directions', () => {
    // Top-N: a no-data candidate must not outrank a real negative measurement.
    expect([-500, null, -200].toSorted((a, b) => compareRankScores(a, b, 'top'))).toEqual([
      -200,
      -500,
      null,
    ]);
    // Bottom-N: nor undercut a real positive one.
    expect([500, null, 200].toSorted((a, b) => compareRankScores(a, b, 'bottom'))).toEqual([
      200,
      500,
      null,
    ]);
  });

  it('compares two no-data candidates as equal (never NaN)', () => {
    expect(compareRankScores(null, null, 'top')).toBe(0);
    expect(compareRankScores(undefined, null, 'bottom')).toBe(0);
    expect(compareRankScores(3, 3, 'top')).toBe(0);
  });
});

describe('resolveMeasureAggregate', () => {
  const revenuePerOrder: StudioExpressionField = {
    id: 'revPerOrder',
    label: 'Revenue / order',
    sourceId: 'src',
    isMeasure: true,
    expression: {
      operator: 'divide',
      inputs: [
        { id: 'revenue', aggregation: 'sum' },
        { id: 'revenue', aggregation: 'count' },
      ],
    },
  };

  it('evaluates the measure over the whole row set', () => {
    const rows = [{ revenue: 100 }, { revenue: 200 }, { revenue: 300 }];
    expect(resolveMeasureAggregate(rows, 'revPerOrder', [revenuePerOrder])).toBe(200);
  });

  it('returns null (never 0) for an empty row set', () => {
    expect(resolveMeasureAggregate([], 'revPerOrder', [revenuePerOrder])).toBe(null);
  });

  it('returns null for a field id that is not a measure expression field', () => {
    const rows = [{ revenue: 100 }];
    // A plain data-source field…
    expect(resolveMeasureAggregate(rows, 'revenue', [revenuePerOrder])).toBe(null);
    // …and a row-level (non-measure) expression column.
    const column: StudioExpressionField = {
      id: 'doubled',
      label: 'Doubled',
      sourceId: 'src',
      isMeasure: false,
      expression: {
        operator: 'multiply',
        inputs: [{ id: 'revenue' }, { type: 'number', value: 2 }],
      },
    };
    expect(resolveMeasureAggregate(rows, 'doubled', [column])).toBe(null);
  });

  it('still returns a genuine 0', () => {
    const zeroSum: StudioExpressionField = {
      id: 'zero',
      label: 'Zero',
      sourceId: 'src',
      isMeasure: true,
      expression: { id: 'revenue', aggregation: 'sum' },
    };
    expect(resolveMeasureAggregate([{ revenue: 0 }], 'zero', [zeroSum])).toBe(0);
  });

  // The documented "or a non-finite result" clause. `evaluateMeasure` only nulls out an
  // EXACT divide/modulo-by-zero, so a denominator that is merely tiny (or an overflowing
  // product) escapes it as ±Infinity. Letting that through is not a cosmetic difference:
  // `Infinity` is a number, so it survives every downstream `typeof v === 'number'` /
  // null-check, wins any Top-N and any descending value sort against every real datum, and
  // renders as a bar/point of unbounded extent that collapses the axis scale for the whole
  // chart. `null` ("not measured") is the only honest answer.
  it('returns null for a non-finite measure result (overflow / denormal denominator)', () => {
    const ratio: StudioExpressionField = {
      id: 'ratio',
      label: 'a / b',
      sourceId: 'src',
      isMeasure: true,
      expression: {
        operator: 'divide',
        inputs: [
          { id: 'a', aggregation: 'sum' },
          { id: 'b', aggregation: 'sum' },
        ],
      },
    };
    // `sum(b)` is denormal, not exactly 0 — so `evaluateMeasure`'s divide-by-zero guard
    // does NOT fire and the raw quotient is `Infinity`.
    const denormalRows = [{ a: 1, b: Number.MIN_VALUE }];
    expect(resolveMeasureAggregate(denormalRows, 'ratio', [ratio])).toBe(null);

    const product: StudioExpressionField = {
      id: 'product',
      label: 'a * a',
      sourceId: 'src',
      isMeasure: true,
      expression: {
        operator: 'multiply',
        inputs: [
          { id: 'a', aggregation: 'sum' },
          { id: 'a', aggregation: 'sum' },
        ],
      },
    };
    // 1e200 * 1e200 overflows the double range → `Infinity`.
    expect(resolveMeasureAggregate([{ a: 1e200 }], 'product', [product])).toBe(null);

    // Negative overflow is nulled too, so a `-Infinity` can never lead a bottom-N.
    expect(resolveMeasureAggregate([{ a: 1, b: -Number.MIN_VALUE }], 'ratio', [ratio])).toBe(null);
  });
});
