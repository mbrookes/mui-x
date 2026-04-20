import type { StudioFilterState } from '../models';

type Row = Record<string, unknown>;

function matchesFilter(row: Row, filter: StudioFilterState): boolean {
  const rowVal = row[filter.field];
  const filterVal = filter.value;

  switch (filter.operator) {
    case 'equals':
      // eslint-disable-next-line eqeqeq
      return rowVal == filterVal;
    case 'not_equals':
      // eslint-disable-next-line eqeqeq
      return rowVal != filterVal;
    case 'contains':
      return String(rowVal ?? '').toLowerCase().includes(String(filterVal ?? '').toLowerCase());
    case 'greater_than':
      return Number(rowVal) > Number(filterVal);
    case 'less_than':
      return Number(rowVal) < Number(filterVal);
    case 'greater_than_or_equal':
      return Number(rowVal) >= Number(filterVal);
    case 'less_than_or_equal':
      return Number(rowVal) <= Number(filterVal);
    default:
      return true;
  }
}

export function applyFilters(rows: Row[], filters: StudioFilterState[]): Row[] {
  if (filters.length === 0) {
    return rows;
  }

  return rows.filter((row) => filters.every((f) => matchesFilter(row, f)));
}

export interface AggregatedData {
  labels: (string | number)[];
  values: number[];
}

export function aggregateByField(rows: Row[], xField: string, yField: string): AggregatedData {
  const grouped = new Map<string | number, number>();

  for (const row of rows) {
    const xVal = row[xField] as string | number;
    const yVal = Number(row[yField] ?? 0);
    const key = xVal ?? '(empty)';

    grouped.set(key, (grouped.get(key) ?? 0) + yVal);
  }

  const labels = Array.from(grouped.keys());
  const values = labels.map((label) => grouped.get(label) ?? 0);

  return { labels, values };
}

/**
 * Multi-series aggregated data for grouped/stacked charts
 */
export interface MultiSeriesData {
  labels: (string | number)[];
  seriesNames: (string | number)[];
  seriesData: Record<string | number, number[]>;
}

/**
 * Aggregate data by two fields: one for x-axis labels, one for series grouping
 */
export function aggregateByTwoFields(
  rows: Row[],
  xField: string,
  seriesField: string,
  yField: string,
): MultiSeriesData {
  // First pass: collect all unique x values and series values
  const xValuesSet = new Set<string | number>();
  const seriesValuesSet = new Set<string | number>();
  
  // Map: xValue -> seriesValue -> sum
  const dataMap = new Map<string | number, Map<string | number, number>>();

  for (const row of rows) {
    const xVal = (row[xField] as string | number) ?? '(empty)';
    const seriesVal = (row[seriesField] as string | number) ?? '(empty)';
    const yVal = Number(row[yField] ?? 0);

    xValuesSet.add(xVal);
    seriesValuesSet.add(seriesVal);

    if (!dataMap.has(xVal)) {
      dataMap.set(xVal, new Map());
    }
    const seriesMap = dataMap.get(xVal)!;
    seriesMap.set(seriesVal, (seriesMap.get(seriesVal) ?? 0) + yVal);
  }

  const labels = Array.from(xValuesSet);
  const seriesNames = Array.from(seriesValuesSet);

  // Build series data arrays
  const seriesData: Record<string | number, number[]> = {};
  for (const seriesName of seriesNames) {
    seriesData[seriesName] = labels.map((label) => {
      const seriesMap = dataMap.get(label);
      return seriesMap?.get(seriesName) ?? 0;
    });
  }

  return { labels, seriesNames, seriesData };
}

/**
 * Scatter chart data point
 */
export interface ScatterDataPoint {
  x: number;
  y: number;
  id: number;
}

/**
 * Prepare data for scatter charts
 */
export function prepareScatterData(rows: Row[], xField: string, yField: string): ScatterDataPoint[] {
  return rows.map((row, index) => ({
    x: Number(row[xField] ?? 0),
    y: Number(row[yField] ?? 0),
    id: index,
  }));
}
