import {
  accumulateValue,
  coerceAggregateValue,
  createAggregateAccumulator,
  finalizeAccumulator,
  type AggregateAccumulator,
} from '../../../internals/aggregate';
import { escapeCsvCell } from '../../../internals/csvUtils';
import { downloadCsv } from '../../../internals/widgetUtils';

// Re-exported so existing importers of `./pivotUtils` keep working unchanged —
// the Blob/`createObjectURL`/anchor-click download plumbing now lives in one
// place (`internals/widgetUtils.tsx`), shared with the grid's CSV export, instead
// of being duplicated near-line-for-line here with its own (missing) filename
// sanitization (finding 3.3).
export { downloadCsv };

// ── Aggregation ───────────────────────────────────────────────────────────────

// The per-cell accumulator is the shared one, so the pivot matrix, the chart
// aggregators and the KPI/map reducers all apply a single null/boolean policy
// (finding 2.1).
//
// `rowCount` is tracked separately from the accumulator's own `count` (which
// only advances for usable/coerced measure values, and backs `avg`'s
// denominator). `count` aggregation means COUNT(*) semantics — every row for
// a cell counts, regardless of whether its measure value is null/non-numeric
// (finding 2.7) — so it can't reuse the accumulator's null-skipping `count`.
interface AggState {
  acc: AggregateAccumulator;
  rowCount: number;
}

function emptyAgg(): AggState {
  return { acc: createAggregateAccumulator(), rowCount: 0 };
}

function addToAgg(agg: AggState, v: number) {
  accumulateValue(agg.acc, v);
}

export function resolveAgg(
  agg: AggState | undefined,
  fn: 'sum' | 'avg' | 'count' | 'min' | 'max',
): number | null {
  if (fn === 'count') {
    // COUNT(*) semantics: every row that landed in this cell counts, even one
    // whose measure value was null/non-numeric (finding 2.7). A cell that
    // never occurred in the input (`agg` undefined) still has no data, so it
    // stays `null` — same as every other aggregation function.
    return agg ? agg.rowCount : null;
  }
  return finalizeAccumulator(agg?.acc, fn);
}

export interface PivotMatrix {
  rowValues: string[];
  colValues: string[];
  /** cells[rowVal][colVal] */
  cells: Map<string, Map<string, AggState>>;
  rowTotals: Map<string, AggState>;
  colTotals: Map<string, AggState>;
  grandTotal: AggState;
}

export function buildPivotMatrix(
  rows: Record<string, unknown>[],
  rowField: string,
  colField: string,
  valueField: string | undefined,
): PivotMatrix {
  const rowSet = new Set<string>();
  const colSet = new Set<string>();
  const cells = new Map<string, Map<string, AggState>>();
  const rowTotals = new Map<string, AggState>();
  const colTotals = new Map<string, AggState>();
  const grandTotal = emptyAgg();

  for (const row of rows) {
    const rv = String(row[rowField] ?? '');
    const cv = String(row[colField] ?? '');
    // Route the raw cell value through the shared null-skip + boolean-coercion
    // policy every other aggregation reducer uses (finding 1.4) — hand-rolling
    // `Number(v ?? 0)` silently turned null/undefined into `0` (inflating `avg`
    // denominators and dragging `min` toward 0) and any non-numeric string into
    // `NaN` (poisoning the shared accumulator's running `sum` for the cell, its
    // row/column totals, and the grand total). When there's no value field the
    // measure is always `1`, never coerced.
    const v = valueField ? coerceAggregateValue(row[valueField]) : 1;

    // Row/column categories are membership, not measurement: a row/column still
    // exists even when this particular row's measure is unusable, so it's
    // recorded here regardless of whether `v` below turned out to be null.
    rowSet.add(rv);
    colSet.add(cv);

    // The row's cell-map entry is membership too — a caller doing
    // `matrix.cells.get(rv)` for a row/column pair that occurred in the input
    // should get an (possibly empty) Map, not undefined, even when every
    // measure value for that row turned out to be unusable.
    if (!cells.has(rv)) {
      cells.set(rv, new Map());
    }

    // cell
    const rowCells = cells.get(rv)!;
    if (!rowCells.has(cv)) {
      rowCells.set(cv, emptyAgg());
    }
    const cellAgg = rowCells.get(cv)!;

    // row total
    if (!rowTotals.has(rv)) {
      rowTotals.set(rv, emptyAgg());
    }
    const rowTotalAgg = rowTotals.get(rv)!;

    // col total
    if (!colTotals.has(cv)) {
      colTotals.set(cv, emptyAgg());
    }
    const colTotalAgg = colTotals.get(cv)!;

    // `count` means COUNT(*) semantics — every row landing in this cell/row/col/
    // grand-total counts, regardless of whether its measure value is
    // null/non-numeric (finding 2.7). Increment unconditionally, before the
    // null skip below, so a cell/region whose measure values are all unusable
    // still reports its row count instead of disappearing entirely.
    cellAgg.rowCount += 1;
    rowTotalAgg.rowCount += 1;
    colTotalAgg.rowCount += 1;
    grandTotal.rowCount += 1;

    if (v === null) {
      // Unusable measure value (null/undefined/NaN/non-numeric/object) — skip
      // it for sum/avg/min/max, don't zero it, mirroring
      // `coerceAggregateValue`'s policy.
      continue;
    }

    addToAgg(cellAgg, v);
    addToAgg(rowTotalAgg, v);
    addToAgg(colTotalAgg, v);
    addToAgg(grandTotal, v);
  }

  return {
    rowValues: [...rowSet].sort(naturalCompare),
    colValues: [...colSet].sort(naturalCompare),
    cells,
    rowTotals,
    colTotals,
    grandTotal,
  };
}

/**
 * Natural-sort comparator for pivot row/column category strings (finding 3.4):
 * when both operands parse as finite numbers, compare numerically (so `"2"`
 * sorts before `"10"`); otherwise fall back to a plain lexicographic
 * comparison. Deliberately simple (no locale-aware collation, no dependency) —
 * this only needs to fix the numeric-looking-string case, not general natural
 * sort of mixed alphanumeric tokens.
 */
function naturalCompare(a: string, b: string): number {
  if (a !== '' && b !== '') {
    const numA = Number(a);
    const numB = Number(b);
    if (Number.isFinite(numA) && Number.isFinite(numB)) {
      return numA - numB;
    }
  }
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

// ── Rounding ──────────────────────────────────────────────────────────────────

/**
 * Shared rounding precision for pivot cell values — the CSV export and the
 * on-screen `PivotTable` must agree, or an exported cell can differ from the
 * displayed cell in the third decimal (classic for `avg`) (finding 3.2).
 */
export function roundPivotValue(v: number): number {
  return Math.round(v * 100) / 100;
}

// ── CSV export ────────────────────────────────────────────────────────────────

function formatCell(v: number | null): string {
  if (v === null) {
    return '';
  }
  return String(roundPivotValue(v));
}

export function pivotToCsv(
  matrix: PivotMatrix,
  aggFn: 'sum' | 'avg' | 'count' | 'min' | 'max',
  showTotals: boolean,
  // Defaults to the English literal so existing callers (and the existing test
  // suite) keep working unchanged; `StudioPivotWidget` passes
  // `localeText.pivotTotalLabel` — the same locale key `PivotTable.tsx` already
  // uses for the on-screen "Total" caption (finding 3.2) — so the CSV export and
  // the rendered table agree in every locale instead of the CSV silently staying
  // English-only.
  totalLabel: string = 'Total',
): string {
  const { rowValues, colValues } = matrix;
  // Label cells (header row + row labels + the totals caption) come from user data,
  // so they go through `escapeCsvCell`, which neutralizes spreadsheet formula
  // injection (a label like `=HYPERLINK(...)`) on top of standard CSV quoting
  // (finding 1.8). Numeric cells (`formatCell`) are emitted raw — escaping them would
  // corrupt legitimate negatives like `-5`.
  const header = ['', ...colValues, ...(showTotals ? [totalLabel] : [])];
  const lines: string[] = [header.map((h) => escapeCsvCell(h)).join(',')];

  for (const rv of rowValues) {
    const rowCells = matrix.cells.get(rv);
    const cells = colValues.map((cv) => formatCell(resolveAgg(rowCells?.get(cv), aggFn)));
    const rowTotal = showTotals
      ? formatCell(resolveAgg(matrix.rowTotals.get(rv), aggFn))
      : undefined;
    const line = [escapeCsvCell(rv), ...cells, ...(rowTotal !== undefined ? [rowTotal] : [])];
    lines.push(line.join(','));
  }

  if (showTotals) {
    const totals = colValues.map((cv) => formatCell(resolveAgg(matrix.colTotals.get(cv), aggFn)));
    const grand = formatCell(resolveAgg(matrix.grandTotal, aggFn));
    lines.push([escapeCsvCell(totalLabel), ...totals, grand].join(','));
  }

  return lines.join('\n');
}
