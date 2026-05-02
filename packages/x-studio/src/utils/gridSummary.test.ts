import { describe, expect, it } from 'vitest';
import type { StudioDataField } from '../models/studio';
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
    const rows = [{ id: '1', revenue: 1000 }, { id: '2', revenue: 2000 }];
    const result = computeGridSummary(rows, fields, { fields: { revenue: 'sum' } });
    // Should include a currency symbol
    expect(result.revenue).toMatch(/Total:.*\$.*3/);
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
});
