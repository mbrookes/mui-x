import { sortLabels, type XGroupBy } from '../temporalUtils';
import { applyXGroupBy, toXValue } from '../chartValues';

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
  const cellSum = new Map<string, number>();
  const cellCount = new Map<string, number>();

  for (const row of rows) {
    const raw = toXValue(row[xField]);
    const xVal = String(applyXGroupBy(raw, xGroupBy));
    const yVal = String(row[yField] ?? '');
    if (!xVal || !yVal) {
      continue;
    }
    const numVal = Number(row[valueField]);
    // Skip rows where the value field is null/undefined/NaN (e.g. in-transit
    // shipments with no actual delivery date produce a null datediff)
    if (Number.isNaN(numVal) || row[valueField] == null) {
      continue;
    }
    xSet.add(xVal);
    ySet.add(yVal);
    const key = `${xVal}\x00${yVal}`;
    const prev = cellSum.get(key) ?? 0;
    const count = (cellCount.get(key) ?? 0) + 1;
    cellCount.set(key, count);

    if (yAggregation === 'count') {
      cellSum.set(key, count);
    } else if (yAggregation === 'sum' || yAggregation === 'avg') {
      cellSum.set(key, prev + numVal);
    } else if (yAggregation === 'min') {
      cellSum.set(key, count === 1 ? numVal : Math.min(prev, numVal));
    } else if (yAggregation === 'max') {
      cellSum.set(key, count === 1 ? numVal : Math.max(prev, numVal));
    }
  }

  // Finalise averages
  const cellMap = new Map<string, number>();
  for (const [key, sum] of cellSum) {
    if (yAggregation === 'avg') {
      cellMap.set(key, sum / (cellCount.get(key) ?? 1));
    } else {
      cellMap.set(key, sum);
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
