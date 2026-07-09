import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  resolveAgg,
  buildPivotMatrix,
  pivotToCsv,
  downloadCsv,
  type PivotMatrix,
} from './pivotUtils';

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

  // ─── Shared aggregation policy via `coerceAggregateValue` (finding 1.4) ─────

  it('skips null/undefined measure values instead of coercing them to 0', () => {
    // A hand-rolled `Number(v ?? 0)` would count these as 0, inflating `avg`'s
    // denominator and dragging `min` toward 0. `coerceAggregateValue` skips them.
    const matrix = buildPivotMatrix(
      [
        { r: 'x', c: 'y', v: 10 },
        { r: 'x', c: 'y', v: null },
        { r: 'x', c: 'y', v: undefined },
        { r: 'x', c: 'y', v: 20 },
      ],
      'r',
      'c',
      'v',
    );
    const cell = matrix.cells.get('x')!.get('y');
    expect(resolveAgg(cell, 'sum')).toBe(30);
    expect(resolveAgg(cell, 'count')).toBe(2);
    expect(resolveAgg(cell, 'avg')).toBe(15);
    expect(resolveAgg(cell, 'min')).toBe(10);
  });

  it('skips non-numeric string measure values instead of letting them poison the sum with NaN', () => {
    const matrix = buildPivotMatrix(
      [
        { r: 'x', c: 'y', v: 10 },
        { r: 'x', c: 'y', v: 'not-a-number' },
      ],
      'r',
      'c',
      'v',
    );
    // A hand-rolled `Number('not-a-number' ?? 0)` is `NaN`, and `sum += NaN`
    // poisons the cell's sum, its row/column totals, and the grand total.
    expect(resolveAgg(matrix.cells.get('x')!.get('y'), 'sum')).toBe(10);
    expect(resolveAgg(matrix.rowTotals.get('x'), 'sum')).toBe(10);
    expect(resolveAgg(matrix.colTotals.get('y'), 'sum')).toBe(10);
    expect(resolveAgg(matrix.grandTotal, 'sum')).toBe(10);
  });

  it('still records a row/column category even when every measure value in it is unusable', () => {
    const matrix = buildPivotMatrix([{ r: 'x', c: 'y', v: null }], 'r', 'c', 'v');
    // The category exists (membership), it just has no aggregate to show.
    expect(matrix.rowValues).toEqual(['x']);
    expect(matrix.colValues).toEqual(['y']);
    expect(resolveAgg(matrix.cells.get('x')!.get('y'), 'sum')).toBe(null);
  });

  // ─── Natural sort of row/column categories (finding 3.4) ────────────────────

  it('sorts numeric-looking row/column category strings numerically, not lexicographically', () => {
    const matrix = buildPivotMatrix(
      [
        { r: '2', c: 'x', v: 1 },
        { r: '10', c: 'x', v: 1 },
        { r: '1', c: 'x', v: 1 },
      ],
      'r',
      'c',
      'v',
    );
    // Lexicographic order would be ['1', '10', '2'].
    expect(matrix.rowValues).toEqual(['1', '2', '10']);
  });

  it('falls back to lexicographic order for non-numeric category strings', () => {
    const matrix = buildPivotMatrix(ROWS, 'region', 'product', 'amount');
    expect(matrix.rowValues).toEqual(['APAC', 'EMEA']);
    expect(matrix.colValues).toEqual(['A', 'B']);
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

  // ─── CSV formula injection is neutralized (finding 1.8) ──────────────────────

  it('neutralizes spreadsheet formula injection in row and column labels', () => {
    const evil = buildPivotMatrix(
      [{ region: '=HYPERLINK("http://evil")', product: '+cmd', amount: 1 }],
      'region',
      'product',
      'amount',
    );
    const lines = pivotToCsv(evil, 'sum', false).split('\n');
    // Header column label starting with '+' is prefixed with a single quote.
    expect(lines[0]).toBe('"","\'+cmd"');
    // Row label starting with '=' is prefixed with a single quote.
    expect(lines[1]).toBe('"\'=HYPERLINK(""http://evil"")",1');
    // The raw formula must never appear unescaped at the start of a cell.
    expect(lines[1].startsWith('"=')).toBe(false);
  });

  it('does not corrupt legitimate negative numeric cells', () => {
    const negMatrix = buildPivotMatrix([{ r: 'x', c: 'y', v: -5 }], 'r', 'c', 'v');
    // Numeric cell stays a bare -5, not quoted or prefixed.
    expect(pivotToCsv(negMatrix, 'sum', false)).toContain(',-5');
  });

  // ─── Locale-aware "Total" caption (finding 3.2) ──────────────────────────────

  it('defaults the totals caption to the English literal "Total" when no label is passed', () => {
    const csv = pivotToCsv(matrix, 'sum', true);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('"","A","B","Total"');
    expect(lines[lines.length - 1].startsWith('"Total"')).toBe(true);
  });

  it('uses a caller-supplied totals label (e.g. a localized string) instead of the hardcoded "Total"', () => {
    const csv = pivotToCsv(matrix, 'sum', true, 'Gesamt');
    const lines = csv.split('\n');
    expect(lines[0]).toBe('"","A","B","Gesamt"');
    expect(lines[lines.length - 1].startsWith('"Gesamt"')).toBe(true);
    expect(csv).not.toContain('Total');
  });
});

// ─── Shared CSV download plumbing (architecture review 3.3) ───────────────────

describe('downloadCsv (re-exported from internals/widgetUtils)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('triggers a browser download via the shared helper', () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const appendSpy = vi.spyOn(document.body, 'appendChild').mockImplementation((el) => el);
    vi.spyOn(document.body, 'removeChild').mockImplementation((el) => el);

    downloadCsv('a,b\n1,2', 'my pivot.csv');

    expect(appendSpy).toHaveBeenCalledOnce();
    const link = appendSpy.mock.calls[0][0] as unknown as HTMLAnchorElement;
    // Sanitized the same way the grid's CSV export is (finding 3.3) — the pivot
    // path previously downloaded `widget.title` completely unsanitized.
    expect(link.download).toBe('my_pivot.csv');
  });
});
