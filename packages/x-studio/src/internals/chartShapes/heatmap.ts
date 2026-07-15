import { sortLabels, type XGroupBy } from '../temporalUtils';
import { applyXGroupBy, isEmptyXValue, toXValue } from '../chartValues';
import {
  accumulateValue,
  coerceAggregateValue,
  createAggregateAccumulator,
  finalizeAccumulator,
  type AggregateAccumulator,
} from '../aggregate';

type Row = Record<string, unknown>;

export interface HeatmapData {
  /** Unique values for the column (X) axis, ordered. */
  xLabels: string[];
  /** Unique values for the row (Y) axis, ordered. */
  yLabels: string[];
  /** Aggregated value for each (xLabel, yLabel) cell. Missing cells default to 0. */
  cells: Map<string, number>;
  minValue: number;
  maxValue: number;
}

/**
 * Orders `labels` by `preferred` (a field's `orderedValues`): known labels first
 * in `preferred` order, then any remaining labels naturally sorted. Used so a
 * heatmap axis follows a domain order (e.g. pipeline stages) rather than A–Z.
 */
function orderLabelsByPreferred(labels: string[], preferred: string[]): string[] {
  const orderMap = new Map(preferred.map((value, index) => [value, index]));
  const known = labels
    .filter((label) => orderMap.has(label))
    .sort((a, b) => (orderMap.get(a) as number) - (orderMap.get(b) as number));
  const unknown = sortLabels(labels.filter((label) => !orderMap.has(label))) as string[];
  return [...known, ...unknown];
}

/**
 * Aggregates rows into a heatmap grid.
 *
 * @param rows - The rows to aggregate.
 * @param xField - Column (X) axis field (categorical or date).
 * @param yField - Row (Y) axis field (categorical).
 * @param valueField - Numeric field to aggregate per cell.
 * @param xGroupBy - Optional date granularity to truncate the X axis values.
 * @param yAggregation - Aggregation function to apply per cell (default: 'sum').
 */
export function aggregateHeatmap(
  rows: Row[],
  xField: string,
  yField: string,
  valueField: string,
  xGroupBy?: XGroupBy,
  yAggregation: 'sum' | 'count' | 'avg' | 'min' | 'max' = 'sum',
  xOrder?: string[],
  yOrder?: string[],
  sortBy?: 'x-axis' | 'y-axis' | 'natural',
  sortDirection?: 'asc' | 'desc',
): HeatmapData {
  const xSet = new Set<string>();
  const ySet = new Set<string>();
  // Per-cell streaming accumulator for sum/avg/min/max (advances only on coerced-numeric
  // measures), kept separate from an unconditional per-cell row count. This mirrors the
  // package-wide aggregate policy (map/pivot/KPI): `'count'` is COUNT(*) — every row that
  // lands in a cell, including null/non-numeric-measure rows — while sum/avg/min/max skip
  // non-numeric values via `coerceAggregateValue` (finding 2.17). Previously the heatmap
  // skipped null/NaN-measure rows BEFORE counting (undercounting `count` and making a cell
  // whose measures are all null vanish) and used raw `Number(...)` (turning an empty-string
  // cell into 0, inflating sum/avg).
  const cellAcc = new Map<string, AggregateAccumulator>();
  const cellRowCount = new Map<string, number>();

  for (const row of rows) {
    // Drop a null/undefined/empty x the same way the generic aggregators do (T3.2b):
    // without this guard, `toXValue(null)` resolves to the truthy `'(empty)'` bucket
    // label, so a null x survived as an `'(empty)'` COLUMN here while a bar/line chart
    // over the same field silently dropped those rows — the two chart families
    // disagreed on the same data.
    if (isEmptyXValue(row[xField])) {
      continue;
    }
    const raw = toXValue(row[xField]);
    const xVal = String(applyXGroupBy(raw, xGroupBy));
    const yVal = String(row[yField] ?? '');
    if (!xVal || !yVal) {
      continue;
    }
    xSet.add(xVal);
    ySet.add(yVal);
    const key = `${xVal}\x00${yVal}`;
    cellRowCount.set(key, (cellRowCount.get(key) ?? 0) + 1);

    const numVal = coerceAggregateValue(row[valueField]);
    if (numVal !== null) {
      let acc = cellAcc.get(key);
      if (!acc) {
        acc = createAggregateAccumulator();
        cellAcc.set(key, acc);
      }
      accumulateValue(acc, numVal);
    }
  }

  // Every cell that occurred (by row count) gets a value: `'count'` reads the unconditional
  // row count; sum/avg/min/max read the accumulator (a cell with only null measures finalises
  // to `null` → shown as 0 rather than disappearing).
  const cellMap = new Map<string, number>();
  for (const [key, rowCount] of cellRowCount) {
    if (yAggregation === 'count') {
      cellMap.set(key, rowCount);
    } else {
      cellMap.set(key, finalizeAccumulator(cellAcc.get(key), yAggregation) ?? 0);
    }
  }

  // Build x-axis labels: orderedValues > explicit sort > default (alphabetical).
  let xLabels: string[];
  if (xOrder && xOrder.length > 0) {
    xLabels = orderLabelsByPreferred([...xSet], xOrder);
  } else if (sortBy === 'x-axis') {
    const sorted = sortLabels([...xSet]) as string[];
    xLabels = sortDirection === 'desc' ? sorted.toReversed() : sorted;
  } else if (sortBy === 'natural' || sortBy === 'y-axis') {
    xLabels = [...xSet];
  } else {
    xLabels = sortLabels([...xSet]) as string[];
  }

  // Build y-axis labels: orderedValues > explicit sort > default (insertion order).
  let yLabels: string[];
  if (yOrder && yOrder.length > 0) {
    yLabels = orderLabelsByPreferred([...ySet], yOrder);
  } else if (sortBy === 'y-axis') {
    const sorted = sortLabels([...ySet]) as string[];
    yLabels = sortDirection === 'desc' ? sorted.toReversed() : sorted;
  } else {
    yLabels = [...ySet];
  }

  let minValue = Infinity;
  let maxValue = -Infinity;
  for (const v of cellMap.values()) {
    if (v < minValue) {
      minValue = v;
    }
    if (v > maxValue) {
      maxValue = v;
    }
  }
  if (minValue === Infinity) {
    minValue = 0;
    maxValue = 0;
  }

  return { xLabels, yLabels, cells: cellMap, minValue, maxValue };
}
