import {
  accumulateValue,
  createAggregateAccumulator,
  finalizeAccumulator,
  type AggregateAccumulator,
} from '../../../internals/aggregate';
import { escapeCsvCell } from '../../../internals/csvUtils';

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
    // For count, value can be anything (we count rows)
    const v = valueField ? Number(row[valueField] ?? 0) : 1;

    rowSet.add(rv);
    colSet.add(cv);

    // cell
    if (!cells.has(rv)) {
      cells.set(rv, new Map());
    }
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
    rowValues: [...rowSet].toSorted(),
    colValues: [...colSet].toSorted(),
    cells,
    rowTotals,
    colTotals,
    grandTotal,
  };
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
): string {
  const { rowValues, colValues } = matrix;
  // Label cells (header row + row labels + the "Total" caption) come from user data,
  // so they go through `escapeCsvCell`, which neutralizes spreadsheet formula
  // injection (a label like `=HYPERLINK(...)`) on top of standard CSV quoting
  // (finding 1.8). Numeric cells (`formatCell`) are emitted raw — escaping them would
  // corrupt legitimate negatives like `-5`.
  const header = ['', ...colValues, ...(showTotals ? ['Total'] : [])];
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
    lines.push([escapeCsvCell('Total'), ...totals, grand].join(','));
  }

  return lines.join('\n');
}

export function downloadCsv(csv: string, filename: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
