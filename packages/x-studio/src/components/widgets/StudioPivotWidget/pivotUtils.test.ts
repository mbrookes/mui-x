import { describe, expect, it } from 'vitest';
import { resolveAgg, buildPivotMatrix, pivotToCsv, type PivotMatrix } from './pivotUtils';

const ROWS = [
  { region: 'EMEA', product: 'A', amount: 10 },
  { region: 'EMEA', product: 'B', amount: 5 },
  { region: 'APAC', product: 'A', amount: 20 },
];

describe('resolveAgg', () => {
  it('returns null for missing or empty aggregates', () => {
    expect(resolveAgg(undefined, 'sum')).toBe(null);
  });

  it('computes each aggregation function', () => {
    const matrix = buildPivotMatrix(
      [
        { r: 'x', c: 'y', v: 2 },
        { r: 'x', c: 'y', v: 8 },
      ],
      'r',
      'c',
      'v',
    );
    const cell = matrix.cells.get('x')!.get('y');
    expect(resolveAgg(cell, 'sum')).toBe(10);
    expect(resolveAgg(cell, 'avg')).toBe(5);
    expect(resolveAgg(cell, 'count')).toBe(2);
    expect(resolveAgg(cell, 'min')).toBe(2);
    expect(resolveAgg(cell, 'max')).toBe(8);
  });
});

describe('buildPivotMatrix', () => {
  it('produces sorted, de-duplicated row and column values', () => {
    const matrix = buildPivotMatrix(ROWS, 'region', 'product', 'amount');
    expect(matrix.rowValues).toEqual(['APAC', 'EMEA']);
    expect(matrix.colValues).toEqual(['A', 'B']);
  });

  it('aggregates cells, row totals, column totals and the grand total', () => {
    const matrix = buildPivotMatrix(ROWS, 'region', 'product', 'amount');
    expect(resolveAgg(matrix.cells.get('EMEA')!.get('A'), 'sum')).toBe(10);
    expect(resolveAgg(matrix.cells.get('EMEA')!.get('B'), 'sum')).toBe(5);
    expect(resolveAgg(matrix.cells.get('APAC')!.get('A'), 'sum')).toBe(20);
    // APAC has no product B
    expect(resolveAgg(matrix.cells.get('APAC')!.get('B'), 'sum')).toBe(null);

    expect(resolveAgg(matrix.rowTotals.get('EMEA'), 'sum')).toBe(15);
    expect(resolveAgg(matrix.colTotals.get('A'), 'sum')).toBe(30);
    expect(resolveAgg(matrix.grandTotal, 'sum')).toBe(35);
    expect(resolveAgg(matrix.grandTotal, 'count')).toBe(3);
  });

  it('counts rows when no value field is provided', () => {
    const matrix = buildPivotMatrix(ROWS, 'region', 'product', undefined);
    expect(resolveAgg(matrix.cells.get('EMEA')!.get('A'), 'count')).toBe(1);
    expect(resolveAgg(matrix.rowTotals.get('EMEA'), 'count')).toBe(2);
    expect(resolveAgg(matrix.grandTotal, 'count')).toBe(3);
  });

  it('buckets missing field values under an empty-string key', () => {
    const matrix = buildPivotMatrix([{ region: 'EMEA', amount: 4 }], 'region', 'product', 'amount');
    expect(matrix.colValues).toEqual(['']);
    expect(resolveAgg(matrix.cells.get('EMEA')!.get(''), 'sum')).toBe(4);
  });
});

describe('pivotToCsv', () => {
  const matrix: PivotMatrix = buildPivotMatrix(ROWS, 'region', 'product', 'amount');

  it('emits a header, data rows, and a totals row when showTotals is true', () => {
    const csv = pivotToCsv(matrix, 'sum', true);
    // Header and row/col labels are JSON-quoted; numeric cells are emitted raw.
    expect(csv.split('\n')).toEqual([
      '"","A","B","Total"',
      '"APAC",20,,20',
      '"EMEA",10,5,15',
      '"Total",30,5,35',
    ]);
  });

  it('omits the Total column and row when showTotals is false', () => {
    const csv = pivotToCsv(matrix, 'sum', false);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('"","A","B"');
    expect(lines).toHaveLength(3); // header + 2 data rows, no totals row
    expect(csv).not.toContain('Total');
  });

  it('rounds values to three decimals (e.g. averages)', () => {
    const avgMatrix = buildPivotMatrix(
      [
        { r: 'x', c: 'y', v: 1 },
        { r: 'x', c: 'y', v: 2 },
      ],
      'r',
      'c',
      'v',
    );
    // avg = 1.5
    expect(pivotToCsv(avgMatrix, 'avg', false)).toContain(',1.5');
  });
});
