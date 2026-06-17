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
  for (let i = 0; i < values.length; i += 1) {
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
  for (let i = 0; i < values.length; i += 1) {
    if (Math.abs((values[i] - mean) / std) > threshold) {
      result.add(i);
    }
  }
  return result;
}

// ── Chart types that support anomaly detection ────────────────────────────────

export const SUPPORTED_CHART_TYPES = new Set(['bar', 'bar-stacked', 'bar-100', 'line']);

/**
 * Returns true when a widget supports anomaly detection.
 * Requires a bar or line chart with temporal x-axis grouping (`xGroupBy`).
 */
export function canDetectAnomalies(widget: StudioWidget): boolean {
  if (widget.kind !== 'chart') {
    return false;
  }
  if (!widget.config.xGroupBy) {
    return false;
  }
  return SUPPORTED_CHART_TYPES.has(widget.config.chartType ?? 'bar');
}

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
      id: `anomaly-${widget.id}-${counter}`,
      axis: 'x',
      value,
      label: '⚠',
    });
    counter += 1;
  }
  return annotations;
}

/**
 * Detects anomalies in pre-aggregated chart data.
 *
 * Accepts the labels/values arrays that the chart renders on the x-axis, so
 * annotation x-values always match chart scale labels exactly — including
 * period-key strings used by bar charts with `scaleType: 'band'`.
 *
 * Prefer this over `detectWidgetAnomalies` for bar/line/area charts where the
 * x-axis shows aggregated period totals, not individual data-row values.
 *
 * @param trimEdges - When true, the first and last buckets are excluded from
 *   being flagged (but still included in IQR statistics). Use when `xGroupBy`
 *   is set: edge periods are often partial weeks/months and would otherwise
 *   generate false-positive low outliers.
 */
export function detectChartDataAnomalies(
  widgetId: string,
  labels: (string | number)[],
  values: (number | null)[],
  trimEdges = false,
): StudioChartAnnotation[] {
  const cleanValues: number[] = [];
  const cleanLabels: (string | number)[] = [];
  for (let i = 0; i < labels.length; i += 1) {
    const v = values[i];
    if (v != null) {
      cleanValues.push(v);
      cleanLabels.push(labels[i]);
    }
  }
  if (cleanValues.length < 4) {
    return [];
  }
  const outlierIndices = detectAnomaliesIQR(cleanValues);
  const lastIdx = cleanValues.length - 1;
  const annotations: StudioChartAnnotation[] = [];
  const seen = new Set<string>();
  let counter = 0;
  for (const idx of outlierIndices) {
    if (trimEdges && (idx === 0 || idx === lastIdx)) {
      continue;
    }
    const value = cleanLabels[idx];
    const key = `${typeof value}:${String(value)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    annotations.push({ id: `anomaly-${widgetId}-${counter}`, axis: 'x', value, label: '⚠' });
    counter += 1;
  }
  return annotations;
}
