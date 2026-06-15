import type { StudioController } from '../../store/StudioController';
import type { StudioAIConfig } from './studioBackendAdapter';
import type { StudioChartAnnotation, StudioKpiAggregation } from '../../models/baseTypes';
import type { StudioState, StudioFilterState } from '../../models/stateTypes';
import type { StudioWidget } from '../../models/widgetTypes';
import type { StudioDataSource } from '../../models/dataTypes';
import { createStudioPipeline } from '../../internals/StudioPipeline';
import { pearsonCorrelation, interpretCorrelation } from '../../internals/forecastUtils';
import {
  computeAggregate,
  findDateFilter,
  extractDateRange,
  computePreviousPeriodRange,
} from '../widgets/StudioKpiWidget/kpiUtils';
import {
  aggregateByField,
  aggregateByTwoFields,
  aggregateMultipleSeries,
  aggregateHeatmap,
  resolveChartRowsForAggregation,
  type AggregatedData,
  type MultiSeriesData,
  type MultiYSeriesData,
  type HeatmapData,
} from '../../internals/chartAggregation';
import { detectWidgetAnomalies } from '../../internals/anomalyDetection';

// ── Public types ──────────────────────────────────────────────────────────────

export interface StudioInsightOptions {
  /**
   * Type of insight to generate:
   * - `'summary'`: A brief plain-language summary of what the widget shows.
   * - `'analysis'`: A deeper analysis of trends, patterns, or notable values.
   * - `'forecast'`: A short-term forecast based on the visible data.
   * - `'anomaly'`: An AI explanation of detected anomalies (internal use).
   * - `'correlation'`: Pearson r correlation analysis between numeric fields.
   */
  type: 'summary' | 'analysis' | 'forecast' | 'anomaly' | 'correlation';
  /**
   * Number of forecast periods to predict.
   * Only used when `type = 'forecast'`. Defaults to 6.
   */
  forecastPeriods?: number;
  /** Optional AbortSignal to cancel the request. */
  signal?: AbortSignal;
}

export interface StudioInsightResult {
  /** The generated insight text (plain text or markdown). */
  text: string;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

const MAX_DATA_ROWS = 100;

interface DataSummaryOptions {
  /**
   * Row selection strategy when the dataset exceeds the row cap:
   * - `'aggregate'`: bucket rows into groups and aggregate numeric fields per bucket —
   *   best for summary/analysis/forecast on dense time-series (every period represented)
   * - `'stride'`: evenly distributed sample — kept for non-numeric/non-time widget kinds
   * - `'anomaly'`: guarantees anomaly rows are included, fills remainder with stride —
   *   never aggregate here (would smooth out the outliers)
   */
  sampling?: 'stride' | 'aggregate' | 'anomaly';
  /** X-axis values identifying anomaly rows — only used when sampling === 'anomaly' */
  anomalyAxisValues?: string[];
  /**
   * Maximum number of rows/buckets to include in the CSV sample.
   * Defaults to MAX_DATA_ROWS (100). Use a smaller value (e.g. 15) for contexts
   * where token budget is tight, such as the `summarise_page` tool snapshot.
   * The numeric stats block (min/max/mean) is always computed from the full dataset.
   */
  maxRows?: number;
}

function selectSampleRows(
  rows: Record<string, unknown>[],
  options: DataSummaryOptions,
  xFieldId: string | undefined,
): { sample: Record<string, unknown>[]; label: string } {
  const total = rows.length;
  const maxRows = options.maxRows ?? MAX_DATA_ROWS;
  if (total <= maxRows) {
    return { sample: rows, label: `${total} row${total !== 1 ? 's' : ''}` };
  }

  const { sampling = 'stride', anomalyAxisValues = [] } = options;

  if (sampling === 'anomaly' && xFieldId && anomalyAxisValues.length > 0) {
    // Build a stride-based index set, then merge in anomaly row indices so
    // the anomalous data points are always present in the sample.
    const anomalySet = new Set(anomalyAxisValues.map(String));
    const stride = Math.ceil(total / maxRows);
    const strideIndices = rows.flatMap((_, i) => (i % stride === 0 ? [i] : []));
    const anomalyIndices = rows.reduce<number[]>((acc, r, i) => {
      if (anomalySet.has(String(r[xFieldId] ?? ''))) {
        acc.push(i);
      }
      return acc;
    }, []);
    const allIndices = [...new Set([...strideIndices, ...anomalyIndices])]
      .toSorted((a, b) => a - b)
      .slice(0, maxRows);
    return {
      sample: allIndices.map((i) => rows[i]),
      label: `${allIndices.length} of ${total} rows (including anomaly points)`,
    };
  }

  // stride (default) — distributed sample covers the full date/value range
  const stride = Math.ceil(total / maxRows);
  const sample = rows.filter((_, i) => i % stride === 0).slice(0, maxRows);
  return {
    sample,
    label: `${sample.length} of ${total} rows (sampled)`,
  };
}

type SourceField = { id: string; label?: string; type?: string; aiAggregation?: string };

/**
 * Aggregates rows into at most MAX_DATA_ROWS buckets by computing per-bucket
 * statistics for numeric fields and taking the first value for others.
 *
 * This ensures every part of the date range is represented — nothing is silently
 * dropped between stride points — making it the best choice for summary, analysis,
 * and forecast on dense time-series data.
 */
function aggregateRows(
  rows: Record<string, unknown>[],
  fieldIds: string[],
  sourceFields: SourceField[],
  maxRows: number = MAX_DATA_ROWS,
): { sample: Record<string, unknown>[]; label: string } {
  const total = rows.length;
  if (total <= maxRows) {
    return { sample: rows, label: `${total} row${total !== 1 ? 's' : ''}` };
  }

  const bucketSize = Math.ceil(total / maxRows);
  const sample: Record<string, unknown>[] = [];

  const fieldById = new Map(sourceFields.map((f) => [f.id, f]));

  for (let i = 0; i < total; i += bucketSize) {
    const bucket = rows.slice(i, i + bucketSize);
    const row: Record<string, unknown> = {};

    for (const id of fieldIds) {
      const field = fieldById.get(id);
      const isNumeric = field?.type === 'number';
      const aggFn = field?.aiAggregation ?? (isNumeric ? 'avg' : 'first');

      if (aggFn === 'first' || !isNumeric) {
        row[id] = bucket[0][id];
      } else {
        const nums = bucket
          .map((r) => r[id])
          .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
        if (nums.length === 0) {
          row[id] = null;
        } else if (aggFn === 'sum') {
          row[id] = nums.reduce((a, b) => a + b, 0);
        } else if (aggFn === 'min') {
          row[id] = Math.min(...nums);
        } else if (aggFn === 'max') {
          row[id] = Math.max(...nums);
        } else {
          // avg (default for number fields)
          const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
          row[id] = Math.round(avg * 100) / 100;
        }
      }
    }

    sample.push(row);
  }

  return {
    sample,
    label: `${sample.length} aggregated buckets of ~${bucketSize} rows (${total} total)`,
  };
}

function buildNumericStats(
  rows: Record<string, unknown>[],
  fieldIds: string[],
  sourceFields: Array<{ id: string; label?: string; type?: string }>,
): string {
  const fieldById = new Map(sourceFields.map((f) => [f.id, f]));
  const parts: string[] = [];
  for (const id of fieldIds) {
    const field = fieldById.get(id);
    if (field?.type !== 'number' && field?.type !== 'integer') {
      continue;
    }
    const values = rows
      .map((r) => r[id])
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (values.length === 0) {
      continue;
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    parts.push(
      `${field.label ?? id}: min=${min}, max=${max}, mean=${Math.round(avg)}, median=${Math.round(median)}`,
    );
  }
  return parts.join(' | ');
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function buildKpiWidgetSummary(
  widget: StudioWidget,
  source: StudioDataSource,
  filteredRows: Record<string, unknown>[],
  state: StudioState,
  dateFilter: StudioFilterState | undefined,
  currentRange: { start: Date; end: Date } | null,
): string {
  const cfg = widget.config;
  const valueField: string | undefined = cfg.kpiValueField;
  const agg: string = cfg.kpiAggregation ?? (valueField ? 'sum' : 'count');

  if (!valueField && agg !== 'count') {
    return '';
  }

  const value = computeAggregate(filteredRows, valueField ?? '', agg as StudioKpiAggregation);
  const fieldLabel = valueField
    ? (source.fields.find((f) => f.id === valueField)?.label ?? valueField)
    : 'rows';

  const lines: string[] = [
    `Aggregation: ${agg} of ${filteredRows.length} rows`,
    `Value: ${cfg.kpiPrefix ?? ''}${value}${cfg.kpiSuffix ?? ''} (${fieldLabel})`,
  ];

  if (cfg.kpiTarget && cfg.kpiTargetValue !== undefined) {
    lines.push(`Target: ${cfg.kpiPrefix ?? ''}${cfg.kpiTargetValue}${cfg.kpiSuffix ?? ''}`);
  }

  if (cfg.kpiSparklinePlotType === 'gauge') {
    const gMax = cfg.kpiTargetValue ?? 100;
    lines.push(`Gauge range: 0 – ${gMax}`);
  }

  // Trend: compare current value against previous period or target
  if (cfg.kpiTrend && valueField) {
    if (cfg.kpiTarget && cfg.kpiTargetValue !== undefined && cfg.kpiTargetValue !== 0) {
      const delta = (value - cfg.kpiTargetValue) / Math.abs(cfg.kpiTargetValue);
      lines.push(`Trend: ${delta >= 0 ? '+' : ''}${Math.round(delta * 100)}% vs target`);
    } else if (dateFilter && currentRange) {
      const comparisonMode = cfg.kpiTrendComparison ?? 'previous-period';
      const prevRange = computePreviousPeriodRange(
        currentRange.start,
        currentRange.end,
        comparisonMode,
      );
      const prevDateFilter: StudioFilterState = {
        ...dateFilter,
        operator: 'greater_than_or_equal',
        value: prevRange.start.toISOString().slice(0, 10),
        operator2: 'less_than_or_equal',
        value2: prevRange.end.toISOString().slice(0, 10),
        conjunction: 'and',
      };
      const prevPipeline = createStudioPipeline({
        ...state,
        filters: state.filters.map((f) => (f.id === dateFilter.id ? prevDateFilter : f)),
      });
      const prevRows = prevPipeline.resolveWidgetRows(
        widget.id,
        widget.sourceId as string,
        source.rows as Record<string, unknown>[],
        state.dashboard.activePageId,
      );
      const prevValue = computeAggregate(prevRows, valueField, agg as StudioKpiAggregation);
      const label = comparisonMode === 'year-over-year' ? 'YoY' : 'vs previous period';
      lines.push(
        `Previous period (${formatDate(prevRange.start)} – ${formatDate(prevRange.end)}): ${cfg.kpiPrefix ?? ''}${prevValue}${cfg.kpiSuffix ?? ''}`,
      );
      if (prevValue !== 0) {
        const delta = (value - prevValue) / Math.abs(prevValue);
        lines.push(`Trend: ${delta >= 0 ? '+' : ''}${Math.round(delta * 100)}% ${label}`);
      }
    }
  }

  if (valueField) {
    const stats = buildNumericStats(filteredRows, [valueField], source.fields);
    if (stats) {
      lines.push(`Stats: ${stats}`);
    }
  }

  return lines.join('\n');
}

const CHART_RAW_ROW_FALLBACK = new Set(['scatter', 'gantt', 'sankey']);

function buildChartWidgetSummary(
  widget: StudioWidget,
  source: StudioDataSource,
  filteredRows: Record<string, unknown>[],
  state: StudioState,
  maxRows: number,
): string {
  const cfg = widget.config;
  const xField: string | undefined = cfg.xField;
  if (!xField) {
    return '';
  }

  const chartType: string = cfg.chartType ?? 'bar';
  const seriesField: string | undefined = cfg.seriesField;
  const yField: string | undefined = cfg.yField;
  const ySeries: Array<{ fieldId: string; sourceId?: string }> = cfg.ySeries ?? [];
  const yAggregation: string = cfg.yAggregation ?? 'sum';
  const xGroupBy = cfg.xGroupBy;
  const sortBy = cfg.chartSortBy;
  const sortDir = cfg.chartSortDirection;
  const xOrder = source.fields.find((f) => f.id === xField)?.orderedValues;

  let activeYFields: string[] = [];
  if (ySeries.length > 0) {
    activeYFields = ySeries.map((s) => s.fieldId).filter(Boolean);
  } else if (yField) {
    activeYFields = [yField];
  }

  const isBlended = ySeries.some((s) => s.sourceId && s.sourceId !== widget.sourceId);
  if (isBlended || CHART_RAW_ROW_FALLBACK.has(chartType)) {
    return '';
  }

  const enrichedRows = resolveChartRowsForAggregation(
    filteredRows,
    widget.sourceId,
    xField,
    activeYFields,
    seriesField,
    state.dataSources,
    state.relationships,
    state.expressionFields,
  );

  const yFieldLabel = (id: string) => source.fields.find((f) => f.id === id)?.label ?? id;

  const lines: string[] = [];

  if (chartType === 'heatmap') {
    const heatY: string | undefined = cfg.heatYField;
    const heatValue: string | undefined = cfg.yField;
    if (!heatY || !heatValue) {
      return '';
    }
    const result: HeatmapData = aggregateHeatmap(
      enrichedRows,
      xField,
      heatY,
      heatValue,
      xGroupBy,
      yAggregation as 'sum' | 'count' | 'avg' | 'min' | 'max',
    );
    const xSlice = result.xLabels.slice(0, maxRows);
    lines.push(
      `Heatmap (${yAggregation} of ${yFieldLabel(heatValue)} by ${xField} × ${heatY}):`,
      `${result.xLabels.length} x-values × ${result.yLabels.length} y-values${ 
        result.xLabels.length > maxRows ? `, showing first ${maxRows}` : ''}`,
      ['', ...result.yLabels].join(','),
    );
    for (const xLabel of xSlice) {
      const row = result.yLabels.map((yLabel) =>
        String(result.cells.get(`${xLabel}::${yLabel}`) ?? 0),
      );
      lines.push([xLabel, ...row].join(','));
    }
  } else if (seriesField && activeYFields.length === 1) {
    const result: MultiSeriesData = aggregateByTwoFields(
      enrichedRows,
      xField,
      seriesField,
      activeYFields[0],
      xGroupBy,
      sortBy,
      sortDir,
      xOrder,
    );
    const total = result.labels.length;
    const slice = result.labels.slice(0, maxRows);
    lines.push(
      `Aggregated by ${xField}${xGroupBy ? ` (${xGroupBy})` : ''} × ${seriesField} (sum of ${yFieldLabel(activeYFields[0])})`,
      `${total} x-values${total > maxRows ? `, showing first ${maxRows}` : ''}`,
      [xField, ...result.seriesNames].join(','),
    );
    for (let i = 0; i < slice.length; i += 1) {
      const vals = result.seriesNames.map((s) => String(result.seriesData[s]?.[i] ?? 0));
      lines.push([slice[i], ...vals].join(','));
    }
  } else if (activeYFields.length > 1 && !seriesField) {
    const result: MultiYSeriesData = aggregateMultipleSeries(
      enrichedRows,
      xField,
      activeYFields,
      xGroupBy,
      sortBy,
      sortDir,
      xOrder,
    );
    const total = result.labels.length;
    const slice = result.labels.slice(0, maxRows);
    lines.push(
      `Aggregated by ${xField}${xGroupBy ? ` (${xGroupBy})` : ''} (multiple measures)`,
      `${total} x-values${total > maxRows ? `, showing first ${maxRows}` : ''}`,
      [xField, ...result.series.map((s) => yFieldLabel(s.fieldId))].join(','),
    );
    for (let i = 0; i < slice.length; i += 1) {
      const vals = result.series.map((s) => String(s.values[i] ?? 0));
      lines.push([slice[i], ...vals].join(','));
    }
  } else {
    const yF = activeYFields[0] ?? '';
    const result: AggregatedData = aggregateByField(
      enrichedRows,
      xField,
      yF,
      xGroupBy,
      yAggregation as 'sum' | 'count' | 'avg' | 'min' | 'max',
      sortBy,
      sortDir,
      xOrder,
    );
    const total = result.labels.length;
    const slice = result.labels.slice(0, maxRows);
    lines.push(
      `Aggregated by ${xField}${xGroupBy ? ` (${xGroupBy})` : ''} (${yAggregation} of ${yF ? yFieldLabel(yF) : 'rows'})`,
      `${total} categories${total > maxRows ? `, showing first ${maxRows}` : ''}`,
      [xField, yF ? yFieldLabel(yF) : 'count'].join(','),
    );
    for (let i = 0; i < slice.length; i += 1) {
      lines.push([slice[i], String(result.values[i])].join(','));
    }
  }

  if (activeYFields.length > 0) {
    const stats = buildNumericStats(filteredRows, activeYFields, source.fields);
    if (stats) {
      lines.push(`Stats: ${stats}`);
    }
  }

  const anomalies = detectWidgetAnomalies(widget, filteredRows);
  if (anomalies.length > 0) {
    lines.push(`Anomalies detected at: ${anomalies.map((a) => String(a.value)).join(', ')}`);
  }

  return lines.join('\n');
}

function buildMapWidgetSummary(
  widget: StudioWidget,
  source: StudioDataSource,
  filteredRows: Record<string, unknown>[],
  maxRows: number,
): string {
  const cfg = widget.config;
  const countryField: string | undefined = cfg.mapCountryField;
  const valueField: string | undefined = cfg.mapValueField;
  const agg: string = cfg.mapAggregation ?? 'sum';

  if (!countryField) {
    return '';
  }

  const result: AggregatedData = aggregateByField(
    filteredRows,
    countryField,
    valueField ?? '',
    undefined,
    (valueField ? agg : 'count') as 'sum' | 'count' | 'avg' | 'min' | 'max',
    'value',
    'desc',
  );

  const total = result.labels.length;
  const slice = result.labels.slice(0, maxRows);
  const valueLabel = valueField
    ? (source.fields.find((f) => f.id === valueField)?.label ?? valueField)
    : 'count';

  const lines: string[] = [
    `Aggregated by country (${agg} of ${valueLabel})`,
    `${total} countries${total > maxRows ? `, showing top ${maxRows}` : ''}`,
    `Country,${valueLabel}`,
    ...slice.map((label, i) => `${label},${result.values[i]}`),
  ];

  if (valueField) {
    const stats = buildNumericStats(filteredRows, [valueField], source.fields);
    if (stats) {
      lines.push(`Stats: ${stats}`);
    }
  }

  return lines.join('\n');
}

function csvRow(row: Record<string, unknown>, fieldIds: string[]): string {
  return fieldIds
    .map((id) => {
      const v = row[id];
      const s = v === null || v === undefined ? '' : String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    })
    .join(',');
}

/**
 * Builds a compact CSV data summary for a widget's relevant fields.
 * Applies the widget's active filters via the pipeline so the data
 * matches what the user actually sees.
 *
 * Uses type-aware sampling to maximise AI usefulness:
 * - forecast → tail slice (most recent data)
 * - anomaly  → guaranteed anomaly rows + stride fill
 * - all else → stride sample across the full range
 *
 * Always includes a numeric stats preamble (min/max/avg) from the full
 * filtered dataset so the AI has global context even when rows are sampled.
 */
export function buildWidgetDataSummary(
  widget: StudioWidget,
  state: StudioState,
  options: DataSummaryOptions = {},
): string {
  if (!widget.sourceId) {
    return '';
  }
  const source = state.dataSources[widget.sourceId];
  if (!source) {
    return '';
  }
  const rawRows = source.rows;
  if (!rawRows || rawRows.length === 0) {
    if (source.adapter) {
      return 'Data is loaded via a server adapter — raw rows are not available locally.';
    }
    return '';
  }

  // Apply the widget's active filters so data matches what the user sees
  const pipeline = createStudioPipeline(state);
  const filteredRows = pipeline.resolveWidgetRows(
    widget.id,
    widget.sourceId,
    rawRows,
    state.dashboard.activePageId,
  );

  const maxRows = options.maxRows ?? MAX_DATA_ROWS;

  // Compute the active date range once — used in every widget kind's output
  const dateFilter = findDateFilter(state.filters, widget.id, source);
  const currentRange = dateFilter ? extractDateRange(dateFilter) : null;
  const dateRangeLine = currentRange
    ? `Date range: ${formatDate(currentRange.start)} – ${formatDate(currentRange.end)}`
    : '';

  const prefix = (body: string) => (dateRangeLine ? `${dateRangeLine}\n${body}` : body);

  // Dispatch to widget-type-specific builders that represent what the widget actually displays
  if (widget.kind === 'kpi') {
    return prefix(
      buildKpiWidgetSummary(widget, source, filteredRows, state, dateFilter, currentRange),
    );
  }
  if (widget.kind === 'chart') {
    const summary = buildChartWidgetSummary(widget, source, filteredRows, state, maxRows);
    if (summary) {
      return prefix(summary);
    }
    // Fall through to raw-row path for scatter/gantt/sankey/blended
  }
  if (widget.kind === 'map') {
    return prefix(buildMapWidgetSummary(widget, source, filteredRows, maxRows));
  }

  // Raw-row path: grid, pivot, and chart fallbacks
  const cfg = widget.config;
  let fieldIds: string[] = [];
  let xFieldId: string | undefined;

  if (widget.kind === 'grid') {
    fieldIds = (cfg.columns ?? []).map((c: { fieldId: string }) => c.fieldId).slice(0, 8);
  } else if (widget.kind === 'pivot') {
    if (cfg.pivotRowField) {
      fieldIds.push(cfg.pivotRowField);
    }
    if (cfg.pivotColField) {
      fieldIds.push(cfg.pivotColField);
    }
    if (cfg.pivotValueField) {
      fieldIds.push(cfg.pivotValueField);
    }
  } else if (widget.kind === 'chart') {
    xFieldId = cfg.xField as string | undefined;
    if (cfg.xField) {
      fieldIds.push(cfg.xField);
    }
    if (cfg.yField) {
      fieldIds.push(cfg.yField);
    } else if (cfg.ySeries?.[0]) {
      fieldIds.push(cfg.ySeries[0].fieldId);
    }
    if (cfg.seriesField) {
      fieldIds.push(cfg.seriesField);
    }
  }

  // Deduplicate and keep only fields that actually exist in the data
  fieldIds = [...new Set(fieldIds)].filter(
    (id) => id && rawRows.some((r: Record<string, unknown>) => id in r),
  );

  if (fieldIds.length === 0) {
    return '';
  }

  const { sampling = 'stride' } = options;
  const { sample, label } =
    sampling === 'aggregate'
      ? aggregateRows(filteredRows, fieldIds, source.fields, maxRows)
      : selectSampleRows(filteredRows, options, xFieldId);

  // Stats computed from ALL filtered rows (not just sample) for global context
  const stats = buildNumericStats(filteredRows, fieldIds, source.fields);

  const headers = fieldIds.map((id) => {
    const field = source.fields.find((f) => f.id === id);
    return field?.label ?? id;
  });

  const lines: string[] = [`Data sample (${label}):`];
  if (stats) {
    lines.push(`Stats: ${stats}`);
  }
  lines.push(headers.join(','), ...sample.map((row) => csvRow(row, fieldIds)));

  return prefix(lines.join('\n'));
}

async function callInsightEndpoint(
  config: StudioAIConfig,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const url = `${config.endpoint.replace(/\/?$/, '')}/insight`;

  const response = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      ...(config.headers ?? {}),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => response.statusText);
    throw new Error(`AI request failed (${response.status}): ${errText.slice(0, 120)}`);
  }

  const data = (await response.json()) as { text?: string };
  if (!data.text) {
    throw new Error('AI returned an empty response.');
  }
  return data.text;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generates an AI insight for a specific widget.
 * Uses the widget's current configuration and data source metadata to build context.
 *
 * @param widgetId - ID of the widget to generate an insight for.
 * @param controller - The `StudioController` instance.
 * @param aiConfig - LLM endpoint configuration.
 * @param options - Insight type and optional settings.
 */
export async function generateWidgetInsight(
  widgetId: string,
  controller: StudioController,
  aiConfig: StudioAIConfig,
  options: StudioInsightOptions,
): Promise<StudioInsightResult> {
  const { type, forecastPeriods = 6, signal } = options;
  const state = controller.getState();
  const widget = state.widgets[widgetId];

  if (!widget) {
    throw new Error(`Widget "${widgetId}" not found.`);
  }

  if (type === 'correlation') {
    return generateCorrelationInsight(widgetId, controller, aiConfig, { signal });
  }

  const dataSummary = buildWidgetDataSummary(widget, state, {
    sampling: 'aggregate',
  });

  const text = await callInsightEndpoint(
    aiConfig,
    {
      insightType: type,
      widgetKind: widget.kind,
      widgetTitle: widget.title,
      dataSummary,
      forecastPeriods: type === 'forecast' ? forecastPeriods : undefined,
    },
    signal,
  );
  return { text };
}

/**
 * Builds a pairwise Pearson correlation matrix string for the numeric fields
 * in a widget's data source. Used to augment the data summary for the AI.
 *
 * Returns an empty string when fewer than 2 numeric fields are available.
 */
export function buildCorrelationSummary(widget: StudioWidget, state: StudioState): string {
  if (!widget.sourceId) {
    return '';
  }
  const source = state.dataSources[widget.sourceId];
  if (!source?.rows?.length) {
    return '';
  }

  // Collect numeric field IDs from the widget config
  const cfg = widget.config;
  const candidateFieldIds: string[] = [];
  if (cfg.yField) {
    candidateFieldIds.push(cfg.yField);
  }
  if (cfg.ySeries?.length) {
    cfg.ySeries.forEach((s: { fieldId: string }) => candidateFieldIds.push(s.fieldId));
  }
  if (cfg.kpiValueField) {
    candidateFieldIds.push(cfg.kpiValueField);
  }

  // Also consider all numeric fields in the source that are used by the widget
  const numericFields = source.fields.filter(
    (f) => f.type === 'number' && candidateFieldIds.includes(f.id),
  );

  if (numericFields.length < 2) {
    // For single-field widgets, correlate against all other numeric fields in the source
    source.fields
      .filter((f) => f.type === 'number' && !candidateFieldIds.includes(f.id))
      .slice(0, 3)
      .forEach((f) => numericFields.push(f));
  }

  if (numericFields.length < 2) {
    return '';
  }

  // Extract value arrays
  const valueArrays: Record<string, (number | null)[]> = {};
  numericFields.forEach((field) => {
    valueArrays[field.id] = source.rows!.map((row) => {
      const v = row[field.id];
      return typeof v === 'number' ? v : null;
    });
  });

  // Compute pairwise Pearson r
  const lines: string[] = ['Pairwise correlations (Pearson r):'];
  for (let i = 0; i < numericFields.length; i += 1) {
    for (let j = i + 1; j < numericFields.length; j += 1) {
      const fa = numericFields[i];
      const fb = numericFields[j];
      const r = pearsonCorrelation(valueArrays[fa.id], valueArrays[fb.id]);
      if (r !== null) {
        const label = `${fa.label ?? fa.id} vs ${fb.label ?? fb.id}`;
        lines.push(`  ${label}: r=${r.toFixed(3)} (${interpretCorrelation(r)})`);
      }
    }
  }

  return lines.length > 1 ? lines.join('\n') : '';
}

/**
 * Generates an AI insight describing the correlations between numeric fields
 * in a chart or KPI widget.
 *
 * Computes client-side Pearson r values and sends them to the LLM for
 * plain-language interpretation.
 *
 * @param widgetId - ID of the widget to analyse.
 * @param controller - The `StudioController` instance.
 * @param aiConfig - LLM endpoint configuration.
 * @param options - Optional settings (signal only).
 */
export async function generateCorrelationInsight(
  widgetId: string,
  controller: StudioController,
  aiConfig: StudioAIConfig,
  options?: Pick<StudioInsightOptions, 'signal'>,
): Promise<StudioInsightResult> {
  const signal = options?.signal;
  const state = controller.getState();
  const widget = state.widgets[widgetId];

  if (!widget) {
    throw new Error(`Widget "${widgetId}" not found.`);
  }

  const correlationSummary = buildCorrelationSummary(widget, state);
  if (!correlationSummary) {
    return {
      text: 'Not enough numeric fields to compute correlations for this widget.',
    };
  }

  const dataSummary = buildWidgetDataSummary(widget, state, { sampling: 'aggregate' });
  const combined = `${correlationSummary}\n\nData sample:\n${dataSummary}`;

  const text = await callInsightEndpoint(
    aiConfig,
    {
      insightType: 'correlation',
      widgetKind: widget.kind,
      widgetTitle: widget.title,
      dataSummary: combined,
    },
    signal,
  );
  return { text };
}

/**
 * Generates an AI narrative summary of the entire active dashboard page.
 * Describes all widgets on the active page and asks the AI for a cohesive summary.
 *
 * @param controller - The `StudioController` instance.
 * @param aiConfig - LLM endpoint configuration.
 * @param options - Optional settings (signal only).
 */
export async function generateDashboardSummary(
  controller: StudioController,
  aiConfig: StudioAIConfig,
  options?: Pick<StudioInsightOptions, 'signal'>,
): Promise<StudioInsightResult> {
  const signal = options?.signal;
  const state = controller.getState();

  // Build a compact summary of all widgets on the active page
  const page = state.pages[state.dashboard.activePageId];
  const widgetIds = (page?.widgetRows ?? []).flat();
  const widgetSummaries = widgetIds
    .flatMap((id: string) => {
      const w = state.widgets[id];
      if (!w) {
        return [];
      }
      const dataSummary = buildWidgetDataSummary(w, state, { sampling: 'stride' });
      return [`### ${w.title} (${w.kind})\n${dataSummary || '(no data)'}`];
    })
    .join('\n\n');

  const text = await callInsightEndpoint(
    aiConfig,
    {
      insightType: 'summary',
      widgetKind: 'dashboard',
      widgetTitle: page?.title ?? 'Dashboard',
      dataSummary: widgetSummaries,
    },
    signal,
  );
  return { text };
}

/**
 * Generates an AI explanation for anomalies detected in a chart widget.
 * Sends the anomalous category labels and values to the LLM and asks for
 * a plain-language explanation of possible causes.
 *
 * @param widgetId - ID of the widget the anomalies belong to.
 * @param anomalies - The detected anomaly annotations (x-axis reference lines).
 * @param controller - The `StudioController` instance.
 * @param aiConfig - LLM endpoint configuration.
 * @param options - Optional settings (signal only).
 */
export async function generateAnomalyExplanation(
  widgetId: string,
  anomalies: StudioChartAnnotation[],
  controller: StudioController,
  aiConfig: StudioAIConfig,
  options?: Pick<StudioInsightOptions, 'signal'>,
): Promise<StudioInsightResult> {
  const signal = options?.signal;
  const state = controller.getState();
  const widget = state.widgets[widgetId];

  if (!widget) {
    throw new Error(`Widget "${widgetId}" not found.`);
  }

  const anomalyLabels = anomalies.map((a) => String(a.value)).join(', ');
  const dataSummary = buildWidgetDataSummary(widget, state, {
    sampling: 'anomaly',
    anomalyAxisValues: anomalies.map((a) => String(a.value)),
  });

  const text = await callInsightEndpoint(
    aiConfig,
    {
      insightType: 'anomaly',
      widgetKind: widget.kind,
      widgetTitle: widget.title,
      dataSummary: `Anomalous data points at: ${anomalyLabels}\n\n${dataSummary}`,
    },
    signal,
  );
  return { text };
}
