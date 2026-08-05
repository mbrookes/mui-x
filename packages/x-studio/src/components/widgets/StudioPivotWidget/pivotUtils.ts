import {
  accumulateValue,
  coerceAggregateValue,
  createAggregateAccumulator,
  finalizeAccumulator,
  type AggregateAccumulator,
} from '../../../internals/aggregate';
import { escapeCsvCell } from '../../../internals/csvUtils';
import { downloadCsv } from '../../../internals/widgetUtils';
import { formatFieldValue, formatNumber } from '../../../internals/numberFormat';
import { evaluateMeasure } from '../../../utils/expressionEvaluator';
import { lookup } from '../../../utils/safeLookup';
import type { StudioDataField, StudioExpressionField } from '../../../models';

// Re-exported so existing importers of `./pivotUtils` keep working unchanged —
// the Blob/`createObjectURL`/anchor-click download plumbing now lives in one
// place (`internals/widgetUtils.tsx`), shared with the grid's CSV export, instead
// of being duplicated near-line-for-line here with its own (missing) filename
// sanitization.
export { downloadCsv };

// ── Aggregation ───────────────────────────────────────────────────────────────

// The per-cell accumulator is the shared one, so the pivot matrix, the chart
// aggregators and the KPI/map reducers all apply a single null/boolean policy.
//
//
// `rowCount` is tracked separately from the accumulator's own `count` (which
// only advances for usable/coerced measure values, and backs `avg`'s
// denominator). `count` aggregation means COUNT(*) semantics — every row for
// a cell counts, regardless of whether its measure value is null/non-numeric
//  — so it can't reuse the accumulator's null-skipping `count`.
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

/** The aggregation functions a pivot cell can be reduced with. */
export type PivotAggregation = 'sum' | 'avg' | 'count' | 'min' | 'max';

const PIVOT_AGGREGATIONS = new Set<string>(['sum', 'avg', 'count', 'min', 'max']);

/**
 * Validates a doc-/AI-authored `config.pivotAggregation` at the widget boundary.
 *
 * `pivotAggregation` is TYPED as the five-name union, but that type is not enforced at
 * the load/AI-tool boundary — `configKeyValidation` screens config key NAMES, never
 * their values. An unrecognized name used to fall through every `if` in `resolveAgg`
 * and land on the `sum` branch, so the pivot rendered a SUM while the user's config
 * asserted a different measure entirely, with no error anywhere. Returning `null`
 * instead makes every cell render as "no value" (`—` on screen, empty in the CSV),
 * which is visible rather than silently wrong. Mirrors the `SAFE_MAP_COLOR_SCHEMES`
 * allow-list `StudioMapWidget` applies to its own unvalidated config value.
 *
 * `undefined` is the legitimate "not configured" case and resolves to the documented
 * `sum` default.
 */
export function resolvePivotAggregation(fn: string | undefined): PivotAggregation | null {
  if (fn === undefined) {
    return 'sum';
  }
  return PIVOT_AGGREGATIONS.has(fn) ? (fn as PivotAggregation) : null;
}

export function resolveAgg(agg: AggState | undefined, fn: PivotAggregation): number | null {
  if (fn === 'count') {
    // COUNT(*) semantics: every row that landed in this cell counts, even one
    // whose measure value was null/non-numeric. A cell that
    // never occurred in the input (`agg` undefined) still has no data, so it
    // stays `null` — same as every other aggregation function.
    return agg ? agg.rowCount : null;
  }
  return finalizeAccumulator(agg?.acc, fn);
}

/**
 * Hard cap on the number of row / column categories a pivot matrix will hand back, per axis.
 *
 * The categories are DATA-DERIVED (`new Set` over every filtered row) and `PivotSetupPanel`
 * offers every string/boolean field as Rows/Columns with no cardinality filter, while
 * `PivotTable` materializes `rowValues × colValues` as plain DOM with no virtualization.
 * Choosing a high-cardinality id column on a 50k-row source therefore asked for 50 001
 * `<th>` plus `rows × 50 000` `<td>` on a table ~4.5M px wide inside a 300px scroll box —
 * the tab hangs, with no error and no affordance to recover. Past this cap the table is
 * unreadable anyway, so the useful behaviour is to show a bounded, deterministic prefix and
 * say so, mirroring every other bounded derived list in the package
 * (`MAX_FILLED_TEMPORAL_LABELS`, `MAX_FORECAST_PERIODS`, `ARIA_LABEL_MAX_LINKS`,
 * `MAX_STATS_ROWS`).
 */
export const MAX_PIVOT_CATEGORIES = 200;

export interface PivotMatrix {
  /** Row categories to render — capped at {@link MAX_PIVOT_CATEGORIES}. */
  rowValues: string[];
  /** Column categories to render — capped at {@link MAX_PIVOT_CATEGORIES}. */
  colValues: string[];
  /**
   * Distinct row categories present in the data, BEFORE the {@link MAX_PIVOT_CATEGORIES}
   * cap. Greater than `rowValues.length` exactly when the axis was truncated, which is
   * what `PivotTable` discloses in its caption.
   */
  rowValueCount: number;
  /** Distinct column categories present in the data, before the cap. */
  colValueCount: number;
  /** cells[rowVal][colVal] */
  cells: Map<string, Map<string, AggState>>;
  rowTotals: Map<string, AggState>;
  colTotals: Map<string, AggState>;
  grandTotal: AggState;
}

/**
 * Sorts a category set with {@link naturalCompare} and then takes the first
 * {@link MAX_PIVOT_CATEGORIES} entries, so truncation is deterministic (a stable prefix of
 * the same order the user sees) rather than dependent on row arrival order.
 */
function toCategoryAxis(values: Set<string>): { values: string[]; total: number } {
  const sorted = [...values].sort(naturalCompare);
  return { values: sorted.slice(0, MAX_PIVOT_CATEGORIES), total: sorted.length };
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
    // `rowField`/`colField`/`valueField` are doc-authored field ids, so every per-row read
    // goes through the prototype-chain-safe `lookup` (see `utils/safeLookup`): a bare
    // `row["constructor"]` resolves the inherited function, which `String(...)` would turn
    // into a pivot row/column category literally titled with the function's source text.
    const rv = String(lookup(row, rowField) ?? '');
    const cv = String(lookup(row, colField) ?? '');
    // Route the raw cell value through the shared null-skip + boolean-coercion
    // policy every other aggregation reducer uses — hand-rolling
    // `Number(v ?? 0)` silently turned null/undefined into `0` (inflating `avg`
    // denominators and dragging `min` toward 0) and any non-numeric string into
    // `NaN` (poisoning the shared accumulator's running `sum` for the cell, its
    // row/column totals, and the grand total). When there's no value field the
    // measure is always `1`, never coerced.
    const v = valueField ? coerceAggregateValue(lookup(row, valueField)) : 1;

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
    // null/non-numeric. Increment unconditionally, before the
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

  const rowAxis = toCategoryAxis(rowSet);
  const colAxis = toCategoryAxis(colSet);

  return {
    rowValues: rowAxis.values,
    colValues: colAxis.values,
    rowValueCount: rowAxis.total,
    colValueCount: colAxis.total,
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
    // Prototype-chain-safe reads, same rationale as `buildPivotMatrix` above.
    const rv = String(lookup(row, rowField) ?? '');
    const cv = String(lookup(row, colField) ?? '');
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

  const rowAxis = toCategoryAxis(rowSet);
  const colAxis = toCategoryAxis(colSet);

  return {
    rowValues: rowAxis.values,
    colValues: colAxis.values,
    rowValueCount: rowAxis.total,
    colValueCount: colAxis.total,
    cells,
    rowTotals,
    colTotals,
    grandTotal: toAgg(grandTotalRows),
  };
}

/**
 * Natural-sort comparator for pivot row/column category strings:
 * when both operands parse as finite numbers, compare numerically (so `"2"`
 * sorts before `"10"`); otherwise fall back to a plain lexicographic
 * comparison. Deliberately simple (no locale-aware collation, no dependency) —
 * this only needs to fix the numeric-looking-string case, not general natural
 * sort of mixed alphanumeric tokens.
 *
 * 3.5: the original version compared ANY pair whose operands both individually
 * parsed as numbers using `numA - numB`, and fell back to lexicographic comparison
 * otherwise — a per-pair decision. For a mixed list like `["10", "1a", "2"]`,
 * `compare("2", "10")` used the numeric branch (`2 < 10`) while `compare("10",
 * "1a")` and `compare("1a", "2")` fell back to lexicographic (`"10" < "1a"` and
 * `"1a" < "2"`), producing a non-transitive comparator (`2 < 10 < 1a < 2`) whose
 * result `Array.prototype.sort` order is implementation-defined. It also let a
 * whitespace-only string (`Number(' ') === 0`) sort as if it were `0`, so distinct
 * blank-looking labels compared equal instead of retaining stable relative order.
 * Fix: partition into "this operand parses as a number" up front (blank/whitespace
 * excluded — `Number.isFinite` on a coerced `Number(a.trim())` restricted to
 * non-empty, non-whitespace strings), sort all-numeric operands before all
 * non-numeric ones, and only compare same-partition operands against each other
 * (numerically within the numeric partition, lexicographically within the rest) —
 * this makes the comparator's ordering total and transitive.
 */
function parseNumericLabel(v: string): number | null {
  if (v.trim() === '') {
    return null;
  }
  const num = Number(v);
  return Number.isFinite(num) ? num : null;
}

function naturalCompare(a: string, b: string): number {
  const numA = parseNumericLabel(a);
  const numB = parseNumericLabel(b);
  if (numA !== null && numB !== null) {
    return numA - numB;
  }
  // Numeric-looking labels always sort before non-numeric ones, so operands from
  // different partitions never fall back to a lexicographic comparison that could
  // contradict the numeric partition's own ordering.
  if (numA !== null) {
    return -1;
  }
  if (numB !== null) {
    return 1;
  }
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

// ── Cell value resolution & formatting ────────────────────────────────────────

/**
 * Shared rounding precision for pivot cell values — the CSV export and the
 * on-screen `PivotTable` must agree, or an exported cell can differ from the
 * displayed cell in the third decimal (classic for `avg`).
 *
 * A `count` is a row count, never a fractional measure, so it rounds to a whole number
 * (it already is one; the branch documents the intent and guards a measure matrix's
 * `rowCount` from ever picking up a `.00` tail downstream).
 */
export function roundPivotValue(v: number, aggFn?: PivotAggregation): number {
  if (aggFn === 'count') {
    return Math.round(v);
  }
  return Math.round(v * 100) / 100;
}

/**
 * THE single resolution path for one pivot cell — used by both `PivotTable` (screen) and
 * `pivotToCsv` (export), so the two can never drift on either the aggregation applied or
 * the rounding. Returns `null` for "no value", which the screen renders as
 * `—` and the CSV as an empty cell.
 *
 * A `null` `aggFn` means the configured aggregation name failed validation
 * (see {@link resolvePivotAggregation}) — every cell then resolves to "no value" rather
 * than silently falling back to a different measure than the one configured.
 */
export function resolvePivotCellValue(
  agg: AggState | undefined,
  aggFn: PivotAggregation | null,
): number | null {
  if (aggFn === null) {
    return null;
  }
  const raw = resolveAgg(agg, aggFn);
  return raw === null ? null : roundPivotValue(raw, aggFn);
}

/**
 * Formats a resolved pivot cell for DISPLAY, using the value field's own definition —
 * the same `formatFieldValue` the grid/KPI/map cells use, so a currency measure renders
 * `€1,234` in the pivot too instead of a bare `1234.00`.
 *
 * Every cell used to go through `formatNumber(v, 'decimal')`, which pins BOTH fraction
 * digits at 2: a `count` aggregation rendered `12.00 / 5.00 / 1.00` on screen while the
 * CSV wrote `12 / 5 / 1`, breaking the very screen-agrees-with-export invariant
 * {@link roundPivotValue} exists to hold.
 *
 * A `count` is a plain row count and is NOT in the value field's unit (a currency
 * column's count is an integer, not an amount), so it is formatted as an integer
 * regardless of the field's format — mirroring the grid's
 * `makeFanoutSafeAggregationFunction` `hasCellUnit: fn !== 'count'` policy.
 */
export function formatPivotCellValue(
  value: number,
  aggFn: PivotAggregation | null,
  valueField?: Pick<StudioDataField, 'type' | 'format' | 'currencyCode' | 'precision'>,
): string {
  if (aggFn === 'count') {
    return formatNumber(value, 'integer');
  }
  if (valueField?.type === 'number') {
    return formatFieldValue(value, valueField);
  }
  return formatNumber(value);
}

// ── CSV export ────────────────────────────────────────────────────────────────

/**
 * CSV cells stay machine-readable (raw digits, no grouping separators or currency
 * symbols — a `1,234` cell would break the row's column alignment), but they carry the
 * exact same NUMBER the screen shows, because both sides resolve through
 * {@link resolvePivotCellValue}.
 */
function formatCsvCell(v: number | null): string {
  if (v === null) {
    return '';
  }
  return String(v);
}

export function pivotToCsv(
  matrix: PivotMatrix,
  aggFn: PivotAggregation | null,
  showTotals: boolean,
  // REQUIRED — deliberately no default. `StudioPivotWidget` passes
  // `localeText.pivotTotalLabel`, the same locale key `PivotTable.tsx` uses for the
  // on-screen "Total" caption, so the CSV export and the rendered table agree
  // in every locale. This used to default to the English literal `'Total'`, which meant any
  // caller that forgot the argument silently shipped an English-only CSV beside a fully
  // localized table — a mixed-language export with nothing to flag it.
  totalLabel: string,
): string {
  const { rowValues, colValues } = matrix;
  // Label cells (header row + row labels + the totals caption) come from user data,
  // so they go through `escapeCsvCell`, which neutralizes spreadsheet formula
  // injection (a label like `=HYPERLINK(...)`) on top of standard CSV quoting.
  // Numeric cells (`formatCsvCell`) are emitted raw — escaping them would
  // corrupt legitimate negatives like `-5`.
  const header = ['', ...colValues, ...(showTotals ? [totalLabel] : [])];
  const lines: string[] = [header.map((h) => escapeCsvCell(h)).join(',')];

  for (const rv of rowValues) {
    const rowCells = matrix.cells.get(rv);
    const cells = colValues.map((cv) =>
      formatCsvCell(resolvePivotCellValue(rowCells?.get(cv), aggFn)),
    );
    const rowTotal = showTotals
      ? formatCsvCell(resolvePivotCellValue(matrix.rowTotals.get(rv), aggFn))
      : undefined;
    const line = [escapeCsvCell(rv), ...cells, ...(rowTotal !== undefined ? [rowTotal] : [])];
    lines.push(line.join(','));
  }

  if (showTotals) {
    const totals = colValues.map((cv) =>
      formatCsvCell(resolvePivotCellValue(matrix.colTotals.get(cv), aggFn)),
    );
    const grand = formatCsvCell(resolvePivotCellValue(matrix.grandTotal, aggFn));
    lines.push([escapeCsvCell(totalLabel), ...totals, grand].join(','));
  }

  return lines.join('\n');
}
