import type { StudioFilterState } from '../models';
import { sortLabels, type XGroupBy } from './temporalUtils';
import { applyXGroupBy, isEmptyXValue, toXValue } from './chartValues';
import {
  accumulateValue,
  createAggregateAccumulator,
  finalizeAccumulator,
  type AggregateAccumulator,
} from './aggregate';

type Row = Record<string, unknown>;

/** The per-series aggregation functions the chart aggregators understand. */
type ChartAggFn = 'sum' | 'count' | 'avg' | 'min' | 'max';

export interface AggregatedData {
  labels: (string | number)[];
  values: number[];
}

/**
 * Multi-series aggregated data for grouped/stacked charts
 */
export interface MultiSeriesData {
  labels: (string | number)[];
  seriesNames: (string | number)[];
  seriesData: Record<string | number, (number | null)[]>;
}

/**
 * Aggregate multiple Y fields against the same X axis (for multi-series charts)
 */
export interface MultiYSeriesData {
  labels: (string | number)[];
  series: Array<{ fieldId: string; values: number[] }>;
}

/**
 * Apply a rank filter to already-aggregated chart data.
 * Ranks by the aggregated value (the bar/slice height) and keeps top/bottom N.
 */
export function applyRankToAggregated(
  data: AggregatedData,
  rankFilter: StudioFilterState | null,
): AggregatedData {
  if (!rankFilter) {
    return data;
  }
  const n = Math.round(Number(rankFilter.value));
  if (!Number.isFinite(n) || n <= 0) {
    return data;
  }
  const dir = rankFilter.rankDirection ?? 'top';
  const pairs = data.labels.map((label, i) => ({ label, value: data.values[i] }));
  pairs.sort((a, b) => (dir === 'top' ? b.value - a.value : a.value - b.value));
  const sliced = pairs.slice(0, n);
  return {
    labels: sliced.map((p) => p.label),
    values: sliced.map((p) => p.value),
  };
}

/**
 * Apply a rank filter to multi-series aggregated data.
 * Ranking score per label is computed according to `rankFilter.rankMultiSeriesBy`:
 * - `undefined` / `'__sum'`: sum of all series values (default)
 * - `'__avg'`: average across all series
 * - `'__max'`: maximum value across all series
 * - `'__min'`: minimum value across all series
 * - `<fieldId>`: use only the series with that fieldId
 */
export function applyRankToMultiSeries(
  data: MultiYSeriesData,
  rankFilter: StudioFilterState | null,
): MultiYSeriesData {
  if (!rankFilter) {
    return data;
  }
  const n = Math.round(Number(rankFilter.value));
  if (!Number.isFinite(n) || n <= 0) {
    return data;
  }
  const dir = rankFilter.rankDirection ?? 'top';
  const rankBy = rankFilter.rankMultiSeriesBy ?? '__sum';

  const scores = data.labels.map((_, i) => {
    if (rankBy === '__sum') {
      return data.series.reduce((acc, s) => acc + (s.values[i] ?? 0), 0);
    }
    if (rankBy === '__avg') {
      const count = data.series.length;
      if (count === 0) {
        return 0;
      }
      return data.series.reduce((acc, s) => acc + (s.values[i] ?? 0), 0) / count;
    }
    if (rankBy === '__max') {
      return Math.max(...data.series.map((s) => s.values[i] ?? -Infinity));
    }
    if (rankBy === '__min') {
      return Math.min(...data.series.map((s) => s.values[i] ?? Infinity));
    }
    // rank by a specific series fieldId
    const series = data.series.find((s) => s.fieldId === rankBy);
    return series ? (series.values[i] ?? 0) : 0;
  });

  const indices = data.labels.map((_, i) => i);
  indices.sort((a, b) => (dir === 'top' ? scores[b] - scores[a] : scores[a] - scores[b]));
  const keepIndices = new Set(indices.slice(0, n));
  const keepMask = data.labels.map((_, i) => keepIndices.has(i));
  return {
    labels: data.labels.filter((_, i) => keepMask[i]),
    series: data.series.map((s) => ({
      ...s,
      values: s.values.filter((_, i) => keepMask[i]),
    })),
  };
}

/**
 * Apply a rank filter to seriesField aggregated data (MultiSeriesData).
 * Ranks the series dimension (e.g. countries) by their total value across all x-labels,
 * and keeps the top/bottom N series.
 */
export function applyRankToSeriesFieldData(
  data: MultiSeriesData,
  rankFilter: StudioFilterState | null,
): MultiSeriesData {
  if (!rankFilter) {
    return data;
  }
  const n = Math.round(Number(rankFilter.value));
  if (!Number.isFinite(n) || n <= 0) {
    return data;
  }
  const dir = rankFilter.rankDirection ?? 'top';
  const scored = data.seriesNames.map((name) => ({
    name,
    score: (data.seriesData[name] ?? []).reduce<number>((acc, v) => acc + (v ?? 0), 0),
  }));
  scored.sort((a, b) => (dir === 'top' ? b.score - a.score : a.score - b.score));
  const keepNames = new Set(scored.slice(0, n).map((s) => s.name));
  return {
    labels: data.labels,
    seriesNames: data.seriesNames.filter((name) => keepNames.has(name)),
    seriesData: Object.fromEntries(
      Object.entries(data.seriesData).filter(([name]) => keepNames.has(name as string | number)),
    ),
  };
}

/**
 * Reorder `labels` (assumed already naturally sorted) according to the chart's
 * sort settings. Extracted so the four generic aggregators share one ordering
 * implementation instead of copy-pasting the value/categoryOrder/desc branches.
 *
 * Priority: `sortBy: 'value'` (needs `valueOf`) > `categoryOrder` > `sortDirection`.
 * Always returns a new array; never mutates the input.
 *
 * - `'value'` — sort by `valueOf(label)`; ascending when `sortDirection === 'asc'`,
 *   otherwise descending (the default for value sorts).
 * - `categoryOrder` — labels present in `categoryOrder` come first in that order,
 *   remaining labels appended alphabetically; the whole list is reversed for `'desc'`.
 * - otherwise — natural order, reversed only when `sortDirection === 'desc'`.
 */
function orderLabels(
  labels: (string | number)[],
  opts: {
    sortBy?: 'category' | 'value' | 'natural';
    sortDirection?: 'asc' | 'desc';
    categoryOrder?: string[];
    valueOf?: (label: string | number) => number;
  },
): (string | number)[] {
  const { sortBy, sortDirection, categoryOrder, valueOf } = opts;

  if (sortBy === 'value' && valueOf) {
    const dir = sortDirection === 'asc' ? 1 : -1;
    return labels
      .map((label) => ({ label, value: valueOf(label) }))
      .sort((a, b) => (a.value - b.value) * dir)
      .map((p) => p.label);
  }

  if (categoryOrder && categoryOrder.length > 0) {
    const orderMap = new Map(categoryOrder.map((v, i) => [v, i]));
    const sorted = [...labels].sort((a, b) => {
      const ai = orderMap.get(String(a)) ?? Infinity;
      const bi = orderMap.get(String(b)) ?? Infinity;
      if (ai !== bi) {
        return ai - bi;
      }
      // Both absent from orderMap — sort alphabetically
      return String(a).localeCompare(String(b));
    });
    if (sortDirection === 'desc') {
      sorted.reverse();
    }
    return sorted;
  }

  if (sortDirection === 'desc') {
    return [...labels].reverse();
  }

  return labels;
}

/**
 * Per-cell streaming accumulator shared by the multi-series aggregators. Backed by
 * the shared {@link AggregateAccumulator} so the chart aggregators, the pivot
 * matrix and the KPI/map reducers all apply one null/boolean-coercion policy.
 */
type CellAcc = AggregateAccumulator;

/** Fold `value` into the accumulator stored at `key`, creating it on first sight. */
function accumulateCell<K>(map: Map<K, CellAcc>, key: K, value: number): void {
  let acc = map.get(key);
  if (!acc) {
    acc = createAggregateAccumulator();
    map.set(key, acc);
  }
  accumulateValue(acc, value);
}

/**
 * Reduce a per-cell accumulator to a single value according to `aggregation`.
 * Returns `null` for an empty cell so callers can distinguish "no data" from 0.
 */
const finalizeCell = finalizeAccumulator;

export function aggregateByField(
  rows: Row[],
  xField: string,
  yField: string,
  xGroupBy?: XGroupBy,
  yAggregation: 'sum' | 'count' | 'avg' | 'min' | 'max' = 'sum',
  sortBy?: 'category' | 'value' | 'natural',
  sortDirection?: 'asc' | 'desc',
  categoryOrder?: string[],
): AggregatedData {
  const grouped = new Map<string | number, number>();
  const counts = new Map<string | number, number>();

  // Pre-detect: if the yField is non-numeric (e.g. a string ID), fall back to
  // count so callers that omit yAggregation don't get NaN in the chart.
  let effectiveAggregation = yAggregation;
  if (effectiveAggregation !== 'count') {
    for (const row of rows) {
      const v = row[yField];
      if (v !== null && v !== undefined) {
        if (Number.isNaN(Number(v))) {
          effectiveAggregation = 'count';
        }
        break;
      }
    }
  }

  for (const row of rows) {
    if (isEmptyXValue(row[xField])) {
      continue;
    }
    const raw = toXValue(row[xField]);
    const xVal = applyXGroupBy(raw, xGroupBy);
    const count = (counts.get(xVal) ?? 0) + 1;
    counts.set(xVal, count);

    if (effectiveAggregation === 'count') {
      grouped.set(xVal, count);
    } else {
      const yVal = Number(row[yField] ?? 0);
      const prev = grouped.get(xVal) ?? 0;
      if (effectiveAggregation === 'sum') {
        grouped.set(xVal, prev + yVal);
      } else if (effectiveAggregation === 'avg') {
        // Store running sum; divide by count at the end
        grouped.set(xVal, prev + yVal);
      } else if (effectiveAggregation === 'min') {
        grouped.set(xVal, count === 1 ? yVal : Math.min(prev, yVal));
      } else if (effectiveAggregation === 'max') {
        grouped.set(xVal, count === 1 ? yVal : Math.max(prev, yVal));
      }
    }
  }

  if (effectiveAggregation === 'avg') {
    for (const [key, sum] of grouped) {
      grouped.set(key, sum / (counts.get(key) ?? 1));
    }
  }

  const labels = orderLabels(sortLabels(Array.from(grouped.keys())), {
    sortBy,
    sortDirection,
    categoryOrder,
    valueOf: (label) => grouped.get(label) ?? 0,
  });
  const values = labels.map((label) => grouped.get(label) ?? 0);

  return { labels, values };
}

/**
 * Aggregate data by two fields: one for x-axis labels, one for series grouping
 */
export function aggregateByTwoFields(
  rows: Row[],
  xField: string,
  seriesField: string,
  yField: string,
  xGroupBy?: XGroupBy,
  sortBy?: 'category' | 'value' | 'natural',
  sortDirection?: 'asc' | 'desc',
  categoryOrder?: string[],
  yAggregation: 'sum' | 'count' | 'avg' | 'min' | 'max' = 'sum',
): MultiSeriesData {
  // First pass: collect all unique x values and series values
  const xValuesSet = new Set<string | number>();
  const seriesValuesSet = new Set<string | number>();

  // Map: xValue -> seriesValue -> per-cell accumulator (sum/count/min/max).
  const dataMap = new Map<string | number, Map<string | number, CellAcc>>();

  for (const row of rows) {
    if (isEmptyXValue(row[xField])) {
      continue;
    }
    const raw = toXValue(row[xField]);
    const xVal = applyXGroupBy(raw, xGroupBy);
    const seriesVal = toXValue(row[seriesField]);
    const yVal = Number(row[yField] ?? 0);

    xValuesSet.add(xVal);
    seriesValuesSet.add(seriesVal);

    let seriesMap = dataMap.get(xVal);
    if (!seriesMap) {
      seriesMap = new Map();
      dataMap.set(xVal, seriesMap);
    }
    accumulateCell(seriesMap, seriesVal, yVal);
  }

  const seriesNames = sortLabels(Array.from(seriesValuesSet));

  // Resolve a single cell to its aggregated value; `null` when the cell has no
  // data so line/area charts render visible gaps instead of collapsing to zero.
  const cellValue = (label: string | number, seriesName: string | number): number | null =>
    finalizeCell(dataMap.get(label)?.get(seriesName), yAggregation);

  const labels = orderLabels(sortLabels(Array.from(xValuesSet)), {
    sortBy,
    sortDirection,
    categoryOrder,
    // For multi-series, 'value' sorts by the total across all series.
    valueOf: (label) =>
      seriesNames.reduce<number>((sum, seriesName) => sum + (cellValue(label, seriesName) ?? 0), 0),
  });

  const seriesData: Record<string | number, (number | null)[]> = {};
  for (const seriesName of seriesNames) {
    seriesData[seriesName] = labels.map((label) => cellValue(label, seriesName));
  }

  return { labels, seriesNames, seriesData };
}

export function aggregateMultipleSeries(
  rows: Row[],
  xField: string,
  yFields: string[],
  xGroupBy?: XGroupBy,
  sortBy?: 'category' | 'value' | 'natural',
  sortDirection?: 'asc' | 'desc',
  categoryOrder?: string[],
  /**
   * Per-series aggregation. Accepts either a single fn applied to every field
   * (back-compat with callers that aggregate uniformly), or a `fieldId → fn` map
   * so each series honours its own `StudioChartSeries.yAggregation` (finding 1.4).
   * Fields absent from the map default to `'sum'`.
   */
  yAggregation: ChartAggFn | Record<string, ChartAggFn> = 'sum',
): MultiYSeriesData {
  // Pre-detect non-numeric fields so callers that omit yAggregation don't get NaN.
  // A non-numeric field is always aggregated as a count regardless of yAggregation.
  const useCount = new Set<string>();
  for (const fieldId of yFields) {
    for (const row of rows) {
      const v = row[fieldId];
      if (v !== null && v !== undefined) {
        if (Number.isNaN(Number(v))) {
          useCount.add(fieldId);
        }
        break;
      }
    }
  }

  const configuredAggregation = (fieldId: string): ChartAggFn =>
    typeof yAggregation === 'string' ? yAggregation : (yAggregation[fieldId] ?? 'sum');

  const fieldAggregation = (fieldId: string): ChartAggFn =>
    useCount.has(fieldId) ? 'count' : configuredAggregation(fieldId);

  const labelOrder: (string | number)[] = [];
  const labelSet = new Set<string | number>();
  // Map: label → fieldId → per-cell accumulator (sum/count/min/max).
  const dataMap = new Map<string | number, Map<string, CellAcc>>();

  for (const row of rows) {
    if (isEmptyXValue(row[xField])) {
      continue;
    }
    const raw = toXValue(row[xField]);
    const xVal = applyXGroupBy(raw, xGroupBy);
    if (!labelSet.has(xVal)) {
      labelSet.add(xVal);
      labelOrder.push(xVal);
      dataMap.set(xVal, new Map());
    }
    const fieldMap = dataMap.get(xVal)!;
    for (const fieldId of yFields) {
      // For count fields the value is irrelevant — accumulateCell only counts rows.
      accumulateCell(fieldMap, fieldId, Number(row[fieldId] ?? 0));
    }
  }

  const cellValue = (label: string | number, fieldId: string): number =>
    finalizeCell(dataMap.get(label)?.get(fieldId), fieldAggregation(fieldId)) ?? 0;

  const sortedLabels = orderLabels(sortLabels(labelOrder), {
    sortBy,
    sortDirection,
    categoryOrder,
    valueOf: (label) => yFields.reduce((sum, fId) => sum + cellValue(label, fId), 0),
  });

  const series = yFields.map((fieldId) => ({
    fieldId,
    values: sortedLabels.map((label) => cellValue(label, fieldId)),
  }));

  return { labels: sortedLabels, series };
}

/**
 * One series for {@link aggregateBlendedSeries}. Each carries its own already-resolved
 * `rows` so the series can originate from a different data source than its siblings.
 */
export interface BlendedSeriesInput {
  /** Field id aggregated for this series (within its own `rows`). */
  fieldId: string;
  /** Rows for this series, already filtered/resolved from its own source. */
  rows: Row[];
  /** Per-series aggregation. @default 'sum' */
  yAggregation?: 'sum' | 'count' | 'avg' | 'min' | 'max';
}

/**
 * Aggregate several series that may originate from DIFFERENT data sources onto a
 * single shared categorical x-axis ("data blending"). Each series is aggregated
 * independently within its own `rows` by `xField`, then all series are aligned on
 * the union of category labels (outer join). Missing category/series combinations
 * are filled with 0, matching {@link aggregateMultipleSeries}.
 *
 * Unlike {@link aggregateMultipleSeries}, the returned `series` preserve the input
 * order and count 1:1 (no de-duplication by `fieldId`), so two series sharing a
 * field id across different sources remain distinct.
 */
export function aggregateBlendedSeries(
  series: BlendedSeriesInput[],
  xField: string,
  xGroupBy?: XGroupBy,
  sortBy?: 'category' | 'value' | 'natural',
  sortDirection?: 'asc' | 'desc',
  categoryOrder?: string[],
): MultiYSeriesData {
  // Aggregate each series within its own rows (independent grain per source).
  const perSeries = series.map((s) =>
    aggregateByField(s.rows, xField, s.fieldId, xGroupBy, s.yAggregation),
  );

  // Per-series label → value maps, plus the union of labels in first-seen order.
  const seen = new Set<string | number>();
  const union: (string | number)[] = [];
  const valueMaps = perSeries.map((agg) => {
    const m = new Map<string | number, number>();
    agg.labels.forEach((label, i) => {
      m.set(label, agg.values[i]);
      if (!seen.has(label)) {
        seen.add(label);
        union.push(label);
      }
    });
    return m;
  });

  // Order labels consistently with the other aggregators.
  const sortedLabels = orderLabels(sortLabels(union), {
    sortBy,
    sortDirection,
    categoryOrder,
    valueOf: (label) => valueMaps.reduce((sum, m) => sum + (m.get(label) ?? 0), 0),
  });

  return {
    labels: sortedLabels,
    series: series.map((s, i) => ({
      fieldId: s.fieldId,
      values: sortedLabels.map((label) => valueMaps[i].get(label) ?? 0),
    })),
  };
}
