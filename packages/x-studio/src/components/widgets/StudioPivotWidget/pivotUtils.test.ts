import { describe, expect, it, vi, afterEach } from 'vitest';
import type { StudioExpressionField } from '../../../models';
import {
  resolveAgg,
  buildPivotMatrix,
  pivotToCsv,
  downloadCsv,
  roundPivotValue,
  resolvePivotAggregation,
  resolvePivotCellValue,
  formatPivotCellValue,
  MAX_PIVOT_CATEGORIES,
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
    // 'count' is COUNT(*), not COUNT(v) — all 4 rows count, including the two
    // null/undefined-valued ones (finding 2.7); sum/avg/min still only see the
    // two usable values.
    expect(resolveAgg(cell, 'count')).toBe(4);
    expect(resolveAgg(cell, 'avg')).toBe(15);
    expect(resolveAgg(cell, 'min')).toBe(10);
  });

  // ─── `count` means COUNT(*), not COUNT(valueField) (finding 2.7) ────────────

  it('count includes every row for a cell/row/column/grand total, even when the measure is entirely null', () => {
    // Region 'x'/'y' has a value field set, but every measure value is unusable.
    // Under the old (buggy) policy this cell/row/col disappeared entirely from a
    // 'count' aggregation — it must instead report the row count (3), matching
    // KPI's computeAggregate and the chart's aggregateByField/aggregateByTwoFields.
    const matrix = buildPivotMatrix(
      [
        { r: 'x', c: 'y', v: null },
        { r: 'x', c: 'y', v: 'not-a-number' },
        { r: 'x', c: 'y', v: undefined },
      ],
      'r',
      'c',
      'v',
    );
    expect(resolveAgg(matrix.cells.get('x')!.get('y'), 'count')).toBe(3);
    expect(resolveAgg(matrix.rowTotals.get('x'), 'count')).toBe(3);
    expect(resolveAgg(matrix.colTotals.get('y'), 'count')).toBe(3);
    expect(resolveAgg(matrix.grandTotal, 'count')).toBe(3);
    // sum/avg/min/max still have no usable data for this cell.
    expect(resolveAgg(matrix.cells.get('x')!.get('y'), 'sum')).toBe(null);
  });

  it('a cell/row/column that never occurred in the data still reports null for count, not 0', () => {
    const matrix = buildPivotMatrix(ROWS, 'region', 'product', 'amount');
    // APAC has no product B row at all.
    expect(resolveAgg(matrix.cells.get('APAC')!.get('B'), 'count')).toBe(null);
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

  // ─── Non-transitive comparator on mixed numeric/alphanumeric labels (finding 3.5) ──

  it('produces a total, transitive order for a mix of numeric and alphanumeric category strings', () => {
    const matrix = buildPivotMatrix(
      [
        { r: '10', c: 'x', v: 1 },
        { r: '1a', c: 'x', v: 1 },
        { r: '2', c: 'x', v: 1 },
      ],
      'r',
      'c',
      'v',
    );
    // The old per-pair comparator cycled: "2" < "10" numerically, but "10" < "1a" < "2"
    // lexicographically — a non-transitive comparator whose sort order was
    // implementation-defined. Numeric-looking labels ("2", "10") must sort before
    // non-numeric ones ("1a"), and stay ordered numerically among themselves.
    expect(matrix.rowValues).toEqual(['2', '10', '1a']);
  });

  it('does not treat distinct whitespace-only category strings as equal (Number(" ") === 0)', () => {
    const matrix = buildPivotMatrix(
      [
        { r: ' ', c: 'x', v: 1 },
        { r: '  ', c: 'x', v: 1 },
        { r: '0', c: 'x', v: 1 },
      ],
      'r',
      'c',
      'v',
    );
    // All three categories are distinct and must all be present — a whitespace string
    // must not be coerced to the number 0 and collide with the literal "0" category.
    expect(matrix.rowValues).toHaveLength(3);
    expect(new Set(matrix.rowValues)).toEqual(new Set([' ', '  ', '0']));
  });
});

// ─── Measure-expression `pivotValueField` (architecture review: pivot had no
// `evaluateMeasure` path — a measure aggregates itself over a row set and has no
// per-row value, so `row[valueField]` always read `undefined`) ────────────────

describe('buildPivotMatrix — measureContext', () => {
  const avgAmount: StudioExpressionField = {
    id: 'avgAmount',
    label: 'Avg Amount',
    sourceId: 'sales',
    isMeasure: true,
    expression: { id: 'amount', aggregation: 'avg' },
  };

  it('evaluates the measure over each cell bucket instead of reading the raw field per row', () => {
    const rows = [
      { region: 'EMEA', product: 'A', amount: 10 },
      { region: 'EMEA', product: 'A', amount: 20 },
      { region: 'APAC', product: 'A', amount: 100 },
    ];
    const matrix = buildPivotMatrix(rows, 'region', 'product', 'avgAmount', {
      measureField: avgAmount,
      expressionFields: [avgAmount],
    });

    // avg(10, 20) = 15 for the EMEA/A cell; a single 100 for APAC/A.
    expect(resolveAgg(matrix.cells.get('EMEA')!.get('A'), 'sum')).toBe(15);
    expect(resolveAgg(matrix.cells.get('APAC')!.get('A'), 'sum')).toBe(100);
  });

  it('resolves to the same value regardless of the caller-selected aggregation fn (a measure self-aggregates)', () => {
    const rows = [
      { region: 'EMEA', product: 'A', amount: 10 },
      { region: 'EMEA', product: 'A', amount: 20 },
    ];
    const matrix = buildPivotMatrix(rows, 'region', 'product', 'avgAmount', {
      measureField: avgAmount,
      expressionFields: [avgAmount],
    });

    const cell = matrix.cells.get('EMEA')!.get('A');
    // sum/avg/min/max of a single evaluated number are all that same number —
    // `pivotAggregation` never re-derives a different answer for a measure.
    expect(resolveAgg(cell, 'sum')).toBe(15);
    expect(resolveAgg(cell, 'avg')).toBe(15);
    expect(resolveAgg(cell, 'min')).toBe(15);
    expect(resolveAgg(cell, 'max')).toBe(15);
  });

  it('count still means COUNT(*) over the bucket, not the evaluated measure value', () => {
    const rows = [
      { region: 'EMEA', product: 'A', amount: 10 },
      { region: 'EMEA', product: 'A', amount: 20 },
      { region: 'EMEA', product: 'A', amount: 30 },
    ];
    const matrix = buildPivotMatrix(rows, 'region', 'product', 'avgAmount', {
      measureField: avgAmount,
      expressionFields: [avgAmount],
    });

    expect(resolveAgg(matrix.cells.get('EMEA')!.get('A'), 'count')).toBe(3);
  });

  it('still records row/column totals and the grand total via the measure', () => {
    const rows = [
      { region: 'EMEA', product: 'A', amount: 10 },
      { region: 'EMEA', product: 'B', amount: 30 },
      { region: 'APAC', product: 'A', amount: 100 },
    ];
    const matrix = buildPivotMatrix(rows, 'region', 'product', 'avgAmount', {
      measureField: avgAmount,
      expressionFields: [avgAmount],
    });

    expect(resolveAgg(matrix.rowTotals.get('EMEA'), 'sum')).toBe(20); // avg(10, 30)
    expect(resolveAgg(matrix.colTotals.get('A'), 'sum')).toBe(55); // avg(10, 100)
    expect(resolveAgg(matrix.grandTotal, 'sum')).toBe(
      (10 + 30 + 100) / 3, // avg over all three rows
    );
  });
});

describe('pivotToCsv', () => {
  const matrix: PivotMatrix = buildPivotMatrix(ROWS, 'region', 'product', 'amount');

  it('emits a header, data rows, and a totals row when showTotals is true', () => {
    const csv = pivotToCsv(matrix, 'sum', true, 'Total');
    // Header and row/col labels are JSON-quoted; numeric cells are emitted raw.
    expect(csv.split('\n')).toEqual([
      '"","A","B","Total"',
      '"APAC",20,,20',
      '"EMEA",10,5,15',
      '"Total",30,5,35',
    ]);
  });

  it('omits the Total column and row when showTotals is false', () => {
    const csv = pivotToCsv(matrix, 'sum', false, 'Total');
    const lines = csv.split('\n');
    expect(lines[0]).toBe('"","A","B"');
    expect(lines).toHaveLength(3); // header + 2 data rows, no totals row
    expect(csv).not.toContain('Total');
  });

  it('rounds values to two decimals (e.g. averages) — same precision as the on-screen table', () => {
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
    expect(pivotToCsv(avgMatrix, 'avg', false, 'Total')).toContain(',1.5');
  });

  // ─── CSV/table rounding parity (finding 3.2) ─────────────────────────────────

  it('rounds a repeating-decimal average to 2 decimals, not 3, matching PivotTable', () => {
    // A hand-rolled `Math.round(v * 1000) / 1000` in the CSV export used to round
    // to 3 decimals while `PivotTable.tsx` rounds to 2, so an exported cell could
    // differ from the on-screen cell in the third decimal.
    const avgMatrix = buildPivotMatrix(
      [
        { r: 'x', c: 'y', v: 1 },
        { r: 'x', c: 'y', v: 1 },
        { r: 'x', c: 'y', v: 2 },
      ],
      'r',
      'c',
      'v',
    );
    // avg = 4 / 3 = 1.3333… -> rounds to 1.33 at 2-decimal precision (would be
    // 1.333 at the old 3-decimal precision).
    const csv = pivotToCsv(avgMatrix, 'avg', false, 'Total');
    expect(csv).toContain(',1.33');
    expect(csv).not.toContain(',1.333');
  });

  // ─── CSV formula injection is neutralized (finding 1.8) ──────────────────────

  it('neutralizes spreadsheet formula injection in row and column labels', () => {
    const evil = buildPivotMatrix(
      [{ region: '=HYPERLINK("http://evil")', product: '+cmd', amount: 1 }],
      'region',
      'product',
      'amount',
    );
    const lines = pivotToCsv(evil, 'sum', false, 'Total').split('\n');
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
    expect(pivotToCsv(negMatrix, 'sum', false, 'Total')).toContain(',-5');
  });

  // ─── Locale-aware "Total" caption (finding 3.2) ──────────────────────────────

  it('defaults the totals caption to the English literal "Total" when no label is passed', () => {
    const csv = pivotToCsv(matrix, 'sum', true, 'Total');
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

describe('roundPivotValue', () => {
  it('rounds to 2 decimal places — the shared precision used by both the CSV export and PivotTable', () => {
    expect(roundPivotValue(4 / 3)).toBe(1.33);
    expect(roundPivotValue(10)).toBe(10);
  });

  it('rounds a count to a whole number — a row count is never fractional', () => {
    expect(roundPivotValue(12, 'count')).toBe(12);
  });
});

// ─── Unvalidated `pivotAggregation` must not silently become a sum (M7) ───────
//
// `configKeyValidation` screens config key NAMES, never their values, so an
// unrecognized `pivotAggregation` used to fall through every branch of `resolveAgg`
// and land on the `sum` path — rendering a sum under a config asserting a different
// measure, with no error anywhere.

describe('resolvePivotAggregation', () => {
  it('accepts every supported aggregation name', () => {
    for (const fn of ['sum', 'avg', 'count', 'min', 'max'] as const) {
      expect(resolvePivotAggregation(fn)).toBe(fn);
    }
  });

  it('defaults to sum when nothing is configured', () => {
    expect(resolvePivotAggregation(undefined)).toBe('sum');
  });

  it('rejects an unrecognized name instead of falling through to sum', () => {
    expect(resolvePivotAggregation('median')).toBe(null);
    expect(resolvePivotAggregation('')).toBe(null);
    // Also rejects inherited Object.prototype member names.
    expect(resolvePivotAggregation('constructor')).toBe(null);
    expect(resolvePivotAggregation('toString')).toBe(null);
  });
});

// ─── Screen and CSV resolve through the same helper (M6) ─────────────────────

describe('resolvePivotCellValue / formatPivotCellValue', () => {
  const matrix: PivotMatrix = buildPivotMatrix(ROWS, 'region', 'product', 'amount');

  it('resolves the same rounded number the CSV writes', () => {
    const cell = matrix.cells.get('EMEA')!.get('A');
    expect(resolvePivotCellValue(cell, 'sum')).toBe(10);
    expect(resolvePivotCellValue(cell, 'count')).toBe(1);
    expect(resolvePivotCellValue(undefined, 'sum')).toBe(null);
  });

  it('resolves every cell to "no value" when the aggregation failed validation', () => {
    const cell = matrix.cells.get('EMEA')!.get('A');
    expect(resolvePivotCellValue(cell, null)).toBe(null);
    // The whole CSV degrades to empty numeric cells rather than a plausible-but-wrong sum.
    expect(pivotToCsv(matrix, null, false, 'Total').split('\n')).toEqual([
      '"","A","B"',
      '"APAC",,',
      '"EMEA",,',
    ]);
  });

  it('formats a count as an integer, never with the 2-decimal tail the CSV lacks', () => {
    // Pre-fix the screen printed `12.00` while the CSV wrote `12`, breaking the very
    // screen-agrees-with-export invariant `roundPivotValue` exists to hold.
    expect(formatPivotCellValue(12, 'count')).toBe('12');
    // A count is not in the value field's unit — a currency column's count is a plain
    // integer (mirrors the grid's `hasCellUnit: fn !== 'count'`).
    expect(formatPivotCellValue(12, 'count', { type: 'number', format: 'currency' })).toBe('12');
  });

  it("formats a value cell in the value field's own format", () => {
    expect(
      formatPivotCellValue(1234, 'sum', {
        type: 'number',
        format: 'currency',
        currencyCode: 'EUR',
      }),
    ).toBe('€1,234');
    expect(formatPivotCellValue(1234, 'sum', { type: 'number', format: 'integer' })).toBe('1,234');
  });

  it('falls back to plain number formatting when the value field is unknown or non-numeric', () => {
    expect(formatPivotCellValue(1234.5, 'sum')).toBe('1,234.5');
    expect(formatPivotCellValue(1234.5, 'sum', { type: 'string' })).toBe('1,234.5');
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

/**
 * `PivotSetupPanel` offers EVERY string/boolean field as Rows/Columns with no cardinality
 * filter, and `PivotTable` materializes `rowValues × colValues` as DOM with no
 * virtualization. Picking a high-cardinality id column (e.g. `Order ID` on a 50k-row
 * source) asked for 50 001 `<th>` plus `rows × 50 000` `<td>` inside a 300px scroll box —
 * the tab hangs with no error, no truncation and no affordance. Every other unbounded
 * derived list in the package is capped (`MAX_FILLED_TEMPORAL_LABELS`,
 * `MAX_FORECAST_PERIODS`, `ARIA_LABEL_MAX_LINKS`, `MAX_STATS_ROWS`); this one was not.
 */
describe('pivot category cap', () => {
  function wideRows(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      r: `row-${String(index).padStart(5, '0')}`,
      c: `col-${String(index).padStart(5, '0')}`,
      v: 1,
    }));
  }

  it('caps both axes at MAX_PIVOT_CATEGORIES', () => {
    const total = MAX_PIVOT_CATEGORIES + 137;
    const matrix = buildPivotMatrix(wideRows(total), 'r', 'c', 'v');
    expect(matrix.rowValues).toHaveLength(MAX_PIVOT_CATEGORIES);
    expect(matrix.colValues).toHaveLength(MAX_PIVOT_CATEGORIES);
  });

  it('reports the full pre-truncation category counts', () => {
    const total = MAX_PIVOT_CATEGORIES + 137;
    const matrix = buildPivotMatrix(wideRows(total), 'r', 'c', 'v');
    expect(matrix.rowValueCount).toBe(total);
    expect(matrix.colValueCount).toBe(total);
  });

  it('truncates deterministically, after the natural sort', () => {
    const total = MAX_PIVOT_CATEGORIES + 137;
    const shuffled = wideRows(total).slice().reverse();
    const matrix = buildPivotMatrix(shuffled, 'r', 'c', 'v');
    expect(matrix.rowValues[0]).toBe('row-00000');
    expect(matrix.rowValues[MAX_PIVOT_CATEGORIES - 1]).toBe(
      `row-${String(MAX_PIVOT_CATEGORIES - 1).padStart(5, '0')}`,
    );
  });

  it('leaves an ordinary pivot untouched and reports counts equal to the rendered lists', () => {
    const matrix = buildPivotMatrix(ROWS, 'region', 'product', 'amount');
    expect(matrix.rowValues).toEqual(['APAC', 'EMEA']);
    expect(matrix.rowValueCount).toBe(matrix.rowValues.length);
    expect(matrix.colValueCount).toBe(matrix.colValues.length);
  });

  it('caps the measure-expression variant the same way', () => {
    const measureField: StudioExpressionField = {
      id: 'm',
      label: 'M',
      sourceId: 's',
      isMeasure: true,
      expression: { id: 'v', aggregation: 'sum' },
    };
    const total = MAX_PIVOT_CATEGORIES + 5;
    const matrix = buildPivotMatrix(wideRows(total), 'r', 'c', undefined, {
      measureField,
      expressionFields: [measureField],
    });
    expect(matrix.colValues).toHaveLength(MAX_PIVOT_CATEGORIES);
    expect(matrix.colValueCount).toBe(total);
  });
});
