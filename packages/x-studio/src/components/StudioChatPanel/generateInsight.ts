import type { StudioController } from '../../store/StudioController';
import type { StudioAIConfig } from './studioBackendAdapter';
import type { StudioChartAnnotation } from '../../models/baseTypes';
import type { StudioState } from '../../models/stateTypes';
import type { StudioWidget } from '../../models/widgetTypes';
import { createStudioPipeline } from '../../internals/StudioPipeline';
import { pearsonCorrelation, interpretCorrelation } from '../../internals/forecastUtils';

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
   * The numeric stats block (min/max/avg) is always computed from the full dataset.
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
    parts.push(`${field.label ?? id}: min=${min}, max=${max}, avg=${Math.round(avg)}`);
  }
  return parts.join(' | ');
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

  const cfg = widget.config;
  let fieldIds: string[] = [];
  let xFieldId: string | undefined;

  if (widget.kind === 'chart') {
    xFieldId = cfg.xField as string | undefined;
    if (cfg.xField) {
      fieldIds.push(cfg.xField);
    }
    if (cfg.yField) {
      fieldIds.push(cfg.yField);
    }
    if (cfg.ySeries?.length) {
      fieldIds.push(...cfg.ySeries.map((s: { fieldId: string }) => s.fieldId));
    }
    if (cfg.seriesField) {
      fieldIds.push(cfg.seriesField);
    }
    if (cfg.heatYField) {
      fieldIds.push(cfg.heatYField);
    }
    if (cfg.ganttLabelField) {
      fieldIds.push(cfg.ganttLabelField);
    }
    if (cfg.ganttStartField) {
      fieldIds.push(cfg.ganttStartField);
    }
    if (cfg.ganttEndField) {
      fieldIds.push(cfg.ganttEndField);
    }
    if (cfg.ganttColorField) {
      fieldIds.push(cfg.ganttColorField);
    }
    if (cfg.scatterColorField) {
      fieldIds.push(cfg.scatterColorField);
    }
    if (cfg.scatterSizeField) {
      fieldIds.push(cfg.scatterSizeField);
    }
  } else if (widget.kind === 'kpi') {
    if (cfg.kpiValueField) {
      fieldIds.push(cfg.kpiValueField);
    }
    if (cfg.kpiSparklineField) {
      fieldIds.push(cfg.kpiSparklineField);
    }
  } else if (widget.kind === 'grid') {
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
  } else if (widget.kind === 'map') {
    if (cfg.mapCountryField) {
      fieldIds.push(cfg.mapCountryField);
    }
    if (cfg.mapValueField) {
      fieldIds.push(cfg.mapValueField);
    }
  }

  // Deduplicate and keep only fields that actually exist in the data
  fieldIds = [...new Set(fieldIds)].filter(
    (id) => id && rawRows.some((r: Record<string, unknown>) => id in r),
  );

  if (fieldIds.length === 0) {
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

  const { sampling = 'stride', maxRows } = options;
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

  return lines.join('\n');
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
