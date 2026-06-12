import type { StudioWidget } from '../models';
import type { StudioChartAnnotation } from '../models/baseTypes';
import { normalizeToDate, periodKeyToDateRange, truncateToGranularity } from './temporalUtils';

// ── Statistical helpers ───────────────────────────────────────────────────────

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Detects outliers using the Tukey IQR fences method.
 * Points outside [Q1 - 1.5·IQR, Q3 + 1.5·IQR] are flagged.
 * Returns a Set of outlier indices into the original `values` array.
 */
export function detectAnomaliesIQR(values: number[]): Set<number> {
  if (values.length < 4) {
    return new Set();
  }
  const sorted = values.toSorted((a, b) => a - b);
  const q1 = median(sorted.slice(0, Math.floor(sorted.length / 2)));
  const q3 = median(sorted.slice(Math.ceil(sorted.length / 2)));
  const iqr = q3 - q1;
  if (iqr === 0) {
    return new Set();
  }
  const lower = q1 - 1.5 * iqr;
  const upper = q3 + 1.5 * iqr;
  const result = new Set<number>();
  for (let i = 0; i < values.length; i++) {
    if (values[i] < lower || values[i] > upper) {
      result.add(i);
    }
  }
  return result;
}

/**
 * Detects outliers using the Z-score method.
 * Points where |z| > threshold are flagged.
 * Returns a Set of outlier indices into the original `values` array.
 */
export function detectAnomaliesZScore(values: number[], threshold = 2.5): Set<number> {
  if (values.length < 2) {
    return new Set();
  }
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  const std = Math.sqrt(variance);
  if (std === 0) {
    return new Set();
  }
  const result = new Set<number>();
  for (let i = 0; i < values.length; i++) {
    if (Math.abs((values[i] - mean) / std) > threshold) {
      result.add(i);
    }
  }
  return result;
}

// ── Chart types that support anomaly detection ────────────────────────────────

const SUPPORTED_CHART_TYPES = new Set([
  'bar',
  'bar-stacked',
  'bar-100',
  'line',
  'area',
  'area-stacked',
  'area-100',
  'scatter',
]);

// ── Widget-level entry point ──────────────────────────────────────────────────

/**
 * Detects anomalies in a chart widget's data rows.
 *
 * Extracts numeric y-axis values (using `yField` or the first `ySeries` field),
 * runs IQR detection, and returns `StudioChartAnnotation[]` (x-axis reference
 * lines at the category labels of anomalous data points).
 *
 * Returns an empty array when:
 * - The widget is not a `'chart'` kind
 * - The chart type is unsupported (pie, donut, gauge, funnel, gantt, heatmap, mixed)
 * - No x/y fields are configured
 * - No anomalies are detected
 */
export function detectWidgetAnomalies(
  widget: StudioWidget,
  rows: Record<string, unknown>[],
): StudioChartAnnotation[] {
  if (widget.kind !== 'chart') {
    return [];
  }
  const { config } = widget;
  const chartType = config.chartType ?? 'bar';
  if (!SUPPORTED_CHART_TYPES.has(chartType)) {
    return [];
  }

  const xField = config.xField;
  const xGroupBy = config.xGroupBy;
  const yField =
    config.yField ??
    (config.ySeries && config.ySeries.length > 0 ? config.ySeries[0].fieldId : undefined);

  if (!xField || !yField) {
    return [];
  }

  if (!rows.length) {
    return [];
  }

  const labels: Array<string | number> = [];
  const values: number[] = [];

  for (const row of rows) {
    const rawX = row[xField];
    const rawY = row[yField];
    if (rawY == null || typeof rawY !== 'number') {
      continue;
    }

    let normalizedX: string | number | null = null;

    if (xGroupBy) {
      const periodKey = truncateToGranularity(rawX, xGroupBy);
      if (periodKey) {
        const periodRange = periodKeyToDateRange(periodKey);
        const fromDate = periodRange ? normalizeToDate(periodRange.from) : null;
        normalizedX = fromDate ? fromDate.getTime() : periodKey;
      }
    } else if (typeof rawX === 'number' || typeof rawX === 'string') {
      const maybeDate = normalizeToDate(rawX);
      normalizedX = maybeDate ? maybeDate.getTime() : rawX;
    } else if (rawX instanceof Date && !Number.isNaN(rawX.getTime())) {
      normalizedX = rawX.getTime();
    }

    if (normalizedX == null || normalizedX === '') {
      continue;
    }

    labels.push(normalizedX);
    values.push(rawY);
  }

  if (values.length < 4) {
    return [];
  }

  const outlierIndices = detectAnomaliesIQR(values);
  const annotations: StudioChartAnnotation[] = [];
  const seenValues = new Set<string>();
  let counter = 0;
  for (const idx of outlierIndices) {
    const value = labels[idx];
    const dedupeKey = `${typeof value}:${String(value)}`;
    if (seenValues.has(dedupeKey)) {
      continue;
    }
    seenValues.add(dedupeKey);

    annotations.push({
      id: `anomaly-${widget.id}-${counter++}`,
      axis: 'x',
      value,
      label: '⚠',
    });
  }
  return annotations;
}
