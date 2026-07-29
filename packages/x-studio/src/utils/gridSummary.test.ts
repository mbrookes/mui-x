import { describe, expect, it } from 'vitest';
import type { StudioDataField } from '../models';
import { computeGridSummary, aggregationLabel } from './gridSummary';

function numField(id: string, label = id): StudioDataField {
  return { id, label, type: 'number' };
}

function strField(id: string, label = id): StudioDataField {
  return { id, label, type: 'string' };
}

const ROWS: Record<string, unknown>[] = [
  { id: '1', amount: 100, qty: 2, name: 'Alpha' },
  { id: '2', amount: 200, qty: 4, name: 'Beta' },
  { id: '3', amount: 150, qty: 3, name: 'Gamma' },
];

describe('computeGridSummary', () => {
  it('returns empty object when summaryFields config is empty', () => {
    const result = computeGridSummary(ROWS, [numField('amount')], { fields: {} });
    expect(result).toEqual({});
  });

  it('computes sum for a numeric field', () => {
    const result = computeGridSummary(ROWS, [numField('amount')], {
      fields: { amount: 'sum' },
    });
    expect(result.amount).toBe('Total: 450');
  });

  it('computes average for a numeric field', () => {
    const result = computeGridSummary(ROWS, [numField('amount')], {
      fields: { amount: 'avg' },
    });
    expect(result.amount).toBe('Avg: 150');
  });

  it('computes count for a numeric field', () => {
    const result = computeGridSummary(ROWS, [numField('amount')], {
      fields: { amount: 'count' },
    });
    expect(result.amount).toBe('Count: 3');
  });

  it('computes min for a numeric field', () => {
    const result = computeGridSummary(ROWS, [numField('amount')], {
      fields: { amount: 'min' },
    });
    expect(result.amount).toBe('Min: 100');
  });

  it('computes max for a numeric field', () => {
    const result = computeGridSummary(ROWS, [numField('amount')], {
      fields: { amount: 'max' },
    });
    expect(result.amount).toBe('Max: 200');
  });

  it('computes multiple fields in one call', () => {
    const result = computeGridSummary(ROWS, [numField('amount'), numField('qty')], {
      fields: { amount: 'sum', qty: 'count' },
    });
    expect(result.amount).toBe('Total: 450');
    expect(result.qty).toBe('Count: 3');
  });

  it('falls back to count for a string field with a numeric aggregation', () => {
    const result = computeGridSummary(ROWS, [strField('name')], {
      fields: { name: 'sum' },
    });
    // sum on string field → falls back to count
    expect(result.name).toBe('Count: 3');
  });

  it('allows count on string fields', () => {
    const result = computeGridSummary(ROWS, [strField('name')], {
      fields: { name: 'count' },
    });
    expect(result.name).toBe('Count: 3');
  });

  it('returns 0 for sum/avg/min/max when all values are missing', () => {
    const rows = [{ id: '1' }, { id: '2' }] as Record<string, unknown>[];
    const result = computeGridSummary(rows, [numField('amount')], {
      fields: { amount: 'sum' },
    });
    expect(result.amount).toBe('Total: 0');
  });

  it('ignores NaN values when computing numeric aggregations', () => {
    const rows = [
      { id: '1', amount: 100 },
      { id: '2', amount: Number.NaN },
      { id: '3', amount: 200 },
    ] as Record<string, unknown>[];
    const result = computeGridSummary(rows, [numField('amount')], {
      fields: { amount: 'sum' },
    });
    expect(result.amount).toBe('Total: 300');
  });

  it('ignores non-numeric values (strings) when computing sum', () => {
    const rows = [
      { id: '1', amount: 50 },
      { id: '2', amount: 'n/a' },
      { id: '3', amount: 150 },
    ] as Record<string, unknown>[];
    const result = computeGridSummary(rows, [numField('amount')], {
      fields: { amount: 'sum' },
    });
    expect(result.amount).toBe('Total: 200');
  });

  // ─── Shared `coerceAggregateValue` policy (finding 2.13) ───────────────────────

  it('coerces numeric strings into the sum instead of excluding them', () => {
    // Old behaviour: `typeof v === 'number'` excludes "50" entirely (not just NaN
    // strings like 'n/a'). coerceAggregateValue parses it so grid agrees with
    // KPI/Chart/Pivot over the same field.
    const rows = [
      { id: '1', amount: '50' },
      { id: '2', amount: 150 },
    ] as Record<string, unknown>[];
    const result = computeGridSummary(rows, [numField('amount')], {
      fields: { amount: 'sum' },
    });
    expect(result.amount).toBe('Total: 200');
  });

  it('coerces booleans to 0/1 instead of excluding them', () => {
    const rows = [
      { id: '1', flag: true },
      { id: '2', flag: false },
      { id: '3', flag: true },
    ] as Record<string, unknown>[];
    const result = computeGridSummary(rows, [numField('flag')], {
      fields: { flag: 'avg' },
    });
    // (1 + 0 + 1) / 3 = 0.6666… -> formatted with the default 2-fraction-digit format.
    expect(result.flag).toBe('Avg: 0.67');
  });

  // ─── count_distinct: null-excluding, raw-value distinctness (finding 2.23) ─────

  it('count_distinct on a string field excludes null/undefined and counts raw values', () => {
    const rows = [
      { id: '1', region: 'US' },
      { id: '2', region: 'US' },
      { id: '3', region: 'EU' },
      { id: '4', region: null },
      { id: '5' }, // missing key
    ] as Record<string, unknown>[];
    const result = computeGridSummary(rows, [strField('region')], {
      fields: { region: 'count_distinct' },
    });
    // 2 distinct non-null regions (US, EU) — agrees with the KPI and measure paths.
    expect(result.region).toBe(`${aggregationLabel('count_distinct')} 2`);
  });

  // ─── count_non_null: COUNT(column), distinct from COUNT(*) ────────────────────

  it('count_non_null counts only rows that have a value, unlike count', () => {
    // The whole reason `count_non_null` needs its own name: over the SAME rows and the SAME
    // column it must answer a different number than `count`. 5 rows, 3 with a value.
    const rows = [
      { id: '1', region: 'US' },
      { id: '2', region: 'US' },
      { id: '3', region: 'EU' },
      { id: '4', region: null },
      { id: '5' }, // missing key
    ] as Record<string, unknown>[];

    const nonNull = computeGridSummary(rows, [strField('region')], {
      fields: { region: 'count_non_null' },
    });
    const allRows = computeGridSummary(rows, [strField('region')], {
      fields: { region: 'count' },
    });

    expect(nonNull.region).toBe(`${aggregationLabel('count_non_null')} 3`);
    expect(allRows.region).toBe(`${aggregationLabel('count')} 5`);
  });

  it('count_non_null on a STRING field is not downgraded to count (non-numeric fallback)', () => {
    // The fallback rewrites a numeric aggregation to `count` on a non-numeric column. All three
    // counts read the raw cell, so each must be exempt — letting `count_non_null` fall through
    // would silently answer "how many rows" for a user who asked "how many have a value", and a
    // string column is exactly where those two numbers differ most often.
    const rows = [
      { id: '1', name: 'Alpha' },
      { id: '2', name: null },
      { id: '3', name: 'Gamma' },
    ] as Record<string, unknown>[];

    const result = computeGridSummary(rows, [strField('name')], {
      fields: { name: 'count_non_null' },
    });

    // 2, not 3 — and labelled as the aggregation actually requested.
    expect(result.name).toBe(`${aggregationLabel('count_non_null')} 2`);
  });

  it('labels a count_non_null summary cell rather than rendering a bare number', () => {
    // `aggregationLabel` ends in `default: return ''`, so a union member with no case renders
    // its number with NO prefix at all — the failure mode that made widening the persisted
    // union alone worse than leaving the aggregation internal.
    expect(aggregationLabel('count_non_null')).toBe('Values:');
    expect(aggregationLabel('count_non_null')).not.toBe('');
  });

  it('avg over an all-null/non-numeric field is omitted, not shown as 0 (finding 2.13)', () => {
    const rows = [
      { id: '1', amount: null },
      { id: '2', amount: 'not-a-number' },
    ] as Record<string, unknown>[];
    const result = computeGridSummary(rows, [numField('amount')], {
      fields: { amount: 'avg' },
    });
    expect(result.amount).toBeUndefined();
  });

  it('handles empty rows array gracefully', () => {
    const result = computeGridSummary([], [numField('amount')], {
      fields: { amount: 'sum' },
    });
    expect(result.amount).toBe('Total: 0');
  });

  it('handles empty rows array for count', () => {
    const result = computeGridSummary([], [numField('qty')], {
      fields: { qty: 'count' },
    });
    expect(result.qty).toBe('Count: 0');
  });

  it('only produces keys for fields listed in config', () => {
    const result = computeGridSummary(ROWS, [numField('amount'), numField('qty')], {
      fields: { amount: 'sum' },
    });
    expect(Object.keys(result)).toEqual(['amount']);
  });

  it('handles a field not present in the data source fields array (unknown field)', () => {
    // Field not in the fields array → treated as non-numeric, falls back to count for numeric aggs
    const result = computeGridSummary(ROWS, [], {
      fields: { unknownField: 'sum' },
    });
    // fieldDef is undefined → isNumeric is false → count fallback
    expect(result.unknownField).toBe('Count: 3');
  });

  it('applies field format when formatting sum', () => {
    const fields: StudioDataField[] = [
      { id: 'revenue', label: 'Revenue', type: 'number', format: 'currency', currencyCode: 'USD' },
    ];
    const rows = [
      { id: '1', revenue: 1000 },
      { id: '2', revenue: 2000 },
    ];
    const result = computeGridSummary(rows, fields, { fields: { revenue: 'sum' } });
    // Should include a currency symbol
    expect(result.revenue).toMatch(/Total:.*\$.*3/);
  });

  // ─── Cross-source / expression column footer totals (finding 1.2) ──────────────
  //
  // A footer Sum on a cross-source (many-to-one joined) column whose value is fanned
  // out onto every widget row sharing the same FK must dedupe by FK before summing —
  // otherwise it counts each linked one-side record once per many-side row, disagreeing
  // with the grid's *grouped* view of the same column. And its field def must be resolved
  // (as `number`) from the merged cross-source/expression field list, or the numeric
  // aggregation silently degrades to a `count`.

  it('degrades a cross-source sum to count when no field def is resolved (the finding-1.2 bug)', () => {
    // `order_items` grid rows enriched with `orders.total`; no def for `total` → non-numeric.
    const rows = [
      { id: 'i1', orderId: 'ord1', total: 100 },
      { id: 'i2', orderId: 'ord1', total: 100 },
      { id: 'i3', orderId: 'ord2', total: 50 },
    ] as Record<string, unknown>[];
    const result = computeGridSummary(rows, [], { fields: { total: 'sum' } });
    // No resolved def → isNumeric false → count fallback (the broken behaviour).
    expect(result.total).toBe('Count: 3');
  });

  it('FK-dedupes a fanned-out cross-source footer sum when the FK map is provided', () => {
    const rows = [
      { id: 'i1', orderId: 'ord1', total: 100 },
      { id: 'i2', orderId: 'ord1', total: 100 }, // same order → fanned out
      { id: 'i3', orderId: 'ord2', total: 50 },
    ] as Record<string, unknown>[];
    const result = computeGridSummary(
      rows,
      [numField('total')],
      { fields: { total: 'sum' } },
      undefined,
      new Map([['total', 'orderId']]),
    );
    // 100 (ord1, once) + 50 (ord2) = 150 — matches the grouped view, NOT the 250 a naive
    // per-row sum would produce.
    expect(result.total).toBe('Total: 150');
  });

  it('without the FK map, the same fanned-out column double-counts (baseline for the fix)', () => {
    const rows = [
      { id: 'i1', orderId: 'ord1', total: 100 },
      { id: 'i2', orderId: 'ord1', total: 100 },
      { id: 'i3', orderId: 'ord2', total: 50 },
    ] as Record<string, unknown>[];
    const result = computeGridSummary(rows, [numField('total')], { fields: { total: 'sum' } });
    expect(result.total).toBe('Total: 250');
  });

  it('FK-dedup drops an unlinked (null FK) row rather than counting it', () => {
    const rows = [
      { id: 'i1', orderId: 'ord1', total: 100 },
      { id: 'i2', orderId: null, total: 999 }, // unlinked → contributes nothing
    ] as Record<string, unknown>[];
    const result = computeGridSummary(
      rows,
      [numField('total')],
      { fields: { total: 'sum' } },
      undefined,
      new Map([['total', 'orderId']]),
    );
    expect(result.total).toBe('Total: 100');
  });

  it('resolves an expression-field footer sum from the merged field list (no count degrade)', () => {
    // A calculated `price - cost` margin column: given its resolved (number) def, the
    // footer sums instead of degrading to count.
    const rows = [
      { id: '1', margin: 10 },
      { id: '2', margin: 15 },
    ] as Record<string, unknown>[];
    const result = computeGridSummary(rows, [numField('margin')], { fields: { margin: 'sum' } });
    expect(result.margin).toBe('Total: 25');
  });
});

describe('aggregationLabel', () => {
  it.each([
    ['sum', 'Total:'],
    ['avg', 'Avg:'],
    ['count', 'Count:'],
    ['min', 'Min:'],
    ['max', 'Max:'],
  ] as const)('returns correct label for %s', (agg, expected) => {
    expect(aggregationLabel(agg)).toBe(expected);
  });

  it('uses custom localeText when provided', () => {
    const custom = {
      gridSummaryLabelSum: 'Soma:',
      gridSummaryLabelAvg: 'Méd:',
      gridSummaryLabelCount: 'Cont:',
      gridSummaryLabelCountDistinct: 'Únicos:',
      gridSummaryLabelMin: 'Mín:',
      gridSummaryLabelMax: 'Máx:',
    } as import('../internals/StudioUIConfigContext').StudioLocaleText;
    expect(aggregationLabel('sum', custom)).toBe('Soma:');
    expect(aggregationLabel('avg', custom)).toBe('Méd:');
    expect(aggregationLabel('count', custom)).toBe('Cont:');
    expect(aggregationLabel('count_distinct', custom)).toBe('Únicos:');
    expect(aggregationLabel('min', custom)).toBe('Mín:');
    expect(aggregationLabel('max', custom)).toBe('Máx:');
  });
});

describe('computeGridSummary with custom localeText', () => {
  it('uses custom sum label', () => {
    const lt = {
      gridSummaryLabelSum: 'Summe:',
    } as import('../internals/StudioUIConfigContext').StudioLocaleText;
    const result = computeGridSummary(
      ROWS,
      [numField('amount')],
      { fields: { amount: 'sum' } },
      lt,
    );
    expect(result.amount).toBe('Summe: 450');
  });

  it('uses custom count label', () => {
    const lt = {
      gridSummaryLabelCount: 'Total:',
    } as import('../internals/StudioUIConfigContext').StudioLocaleText;
    const result = computeGridSummary(
      ROWS,
      [numField('amount')],
      { fields: { amount: 'count' } },
      lt,
    );
    expect(result.amount).toBe('Total: 3');
  });
});
