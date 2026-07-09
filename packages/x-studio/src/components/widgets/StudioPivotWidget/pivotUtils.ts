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
type AggState = AggregateAccumulator;

function emptyAgg(): AggState {
  return createAggregateAccumulator();
}

function addToAgg(agg: AggState, v: number) {
  accumulateValue(agg, v);
}

export function resolveAgg(
  agg: AggState | undefined,
  fn: 'sum' | 'avg' | 'count' | 'min' | 'max',
): number | null {
  return finalizeAccumulator(agg, fn);
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
    // row/column totals, and the grand total). For `count`, the value itself is
    // irrelevant (we're counting rows), so it's always `1`, never coerced.
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

    if (v === null) {
      // Unusable measure value (null/undefined/NaN/non-numeric/object) — skip
      // it, don't zero it, mirroring `coerceAggregateValue`'s policy.
      continue;
    }

    // cell
    const rowCells = cells.get(rv)!;
    if (!rowCells.has(cv)) {
      rowCells.set(cv, emptyAgg());
    }
    addToAgg(rowCells.get(cv)!, v);

    // row total
    if (!rowTotals.has(rv)) {
      rowTotals.set(rv, emptyAgg());
    }
    addToAgg(rowTotals.get(rv)!, v);

    // col total
    if (!colTotals.has(cv)) {
      colTotals.set(cv, emptyAgg());
    }
    addToAgg(colTotals.get(cv)!, v);

    // grand total
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

// ── CSV export ────────────────────────────────────────────────────────────────

function formatCell(v: number | null): string {
  if (v === null) {
    return '';
  }
  return String(Math.round(v * 1000) / 1000);
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
