import {
  accumulateValue,
  coerceAggregateValue,
  createAggregateAccumulator,
  finalizeAccumulator,
  type AggregateAccumulator,
} from '../../../internals/aggregate';
import { escapeCsvCell } from '../../../internals/csvUtils';
import { downloadCsv } from '../../../internals/widgetUtils';
import { evaluateMeasure } from '../../../utils/expressionEvaluator';
import type { StudioExpressionField } from '../../../models';

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

/**
 * Passed to {@link buildPivotMatrix} when `pivotValueField` resolves to a MEASURE
 * expression field (`isMeasure: true`) rather than a plain data-source field — a
 * measure aggregates itself (e.g. `sum(total)/count()`) and must be evaluated once
 * over the FULL set of rows in each cell/row-total/col-total/grand-total bucket via
 * `evaluateMeasure`, not read per-row via `row[valueField]` (which is always
 * `undefined` for a measure, since a measure has no per-row value at all).
 */
export interface PivotMeasureContext {
  measureField: StudioExpressionField;
  expressionFields: StudioExpressionField[];
}

export function buildPivotMatrix(
  rows: Record<string, unknown>[],
  rowField: string,
  colField: string,
  valueField: string | undefined,
  measureContext?: PivotMeasureContext,
): PivotMatrix {
  if (measureContext) {
    return buildMeasurePivotMatrix(rows, rowField, colField, measureContext);
  }
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
 * Measure-expression variant of {@link buildPivotMatrix} (see {@link PivotMeasureContext}).
 * Row/column categories are bucketed by MEMBERSHIP first — mirroring the streaming
 * variant above, a row/column exists once any row lands in it, even if the measure
 * later evaluates to `null` for that bucket — then each bucket's full row list is
 * reduced to a single number via `evaluateMeasure` (which self-aggregates; the caller's
 * chosen `pivotAggregation` fn does not apply, matching the KPI widget's handling of a
 * measure-expression value field). The single evaluated number is folded into an
 * `AggState`'s accumulator exactly once, so `resolveAgg`'s `sum`/`avg`/`min`/`max`
 * branches all resolve to that same number (a single-value sum/avg/min/max are
 * identical) with no change required to `resolveAgg`, `PivotTable`, or `pivotToCsv`.
 * `count` still means COUNT(*) over the bucket's raw row count (`rowCount`), matching
 * every other cell's `count` semantics.
 */
function buildMeasurePivotMatrix(
  rows: Record<string, unknown>[],
  rowField: string,
  colField: string,
  { measureField, expressionFields }: PivotMeasureContext,
): PivotMatrix {
  const rowSet = new Set<string>();
  const colSet = new Set<string>();
  const cellRows = new Map<string, Map<string, Record<string, unknown>[]>>();
  const rowTotalRows = new Map<string, Record<string, unknown>[]>();
  const colTotalRows = new Map<string, Record<string, unknown>[]>();
  const grandTotalRows: Record<string, unknown>[] = [];

  for (const row of rows) {
    const rv = String(row[rowField] ?? '');
    const cv = String(row[colField] ?? '');
    rowSet.add(rv);
    colSet.add(cv);

    if (!cellRows.has(rv)) {
      cellRows.set(rv, new Map());
    }
    const rowCellMap = cellRows.get(rv)!;
    if (!rowCellMap.has(cv)) {
      rowCellMap.set(cv, []);
    }
    rowCellMap.get(cv)!.push(row);

    if (!rowTotalRows.has(rv)) {
      rowTotalRows.set(rv, []);
    }
    rowTotalRows.get(rv)!.push(row);

    if (!colTotalRows.has(cv)) {
      colTotalRows.set(cv, []);
    }
    colTotalRows.get(cv)!.push(row);

    grandTotalRows.push(row);
  }

  const toAgg = (bucketRows: Record<string, unknown>[]): AggState => {
    const acc = createAggregateAccumulator();
    const value = evaluateMeasure(measureField, bucketRows, expressionFields);
    if (value !== null) {
      accumulateValue(acc, value);
    }
    return { acc, rowCount: bucketRows.length };
  };

  const cells = new Map<string, Map<string, AggState>>();
  for (const [rv, colMap] of cellRows) {
    const outMap = new Map<string, AggState>();
    for (const [cv, bucketRows] of colMap) {
      outMap.set(cv, toAgg(bucketRows));
    }
    cells.set(rv, outMap);
  }

  const rowTotals = new Map<string, AggState>();
  for (const [rv, bucketRows] of rowTotalRows) {
    rowTotals.set(rv, toAgg(bucketRows));
  }

  const colTotals = new Map<string, AggState>();
  for (const [cv, bucketRows] of colTotalRows) {
    colTotals.set(cv, toAgg(bucketRows));
  }

  return {
    rowValues: [...rowSet].sort(naturalCompare),
    colValues: [...colSet].sort(naturalCompare),
    cells,
    rowTotals,
    colTotals,
    grandTotal: toAgg(grandTotalRows),
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
