import type { StudioController } from '../store/StudioController';
import type { StudioAIConfig } from './studioAdapter';
import type { StudioChartAnnotation } from '../models/baseTypes';
import type { StudioState } from '../models/stateTypes';
import type { StudioWidget } from '../models/widgetTypes';
import { buildAISystemPrompt } from '../internals/buildAISystemPrompt';
import { createStudioPipeline } from '../internals/StudioPipeline';

// ── Public types ──────────────────────────────────────────────────────────────

export interface StudioInsightOptions {
  /**
   * Type of insight to generate:
   * - `'summary'`: A brief plain-language summary of what the widget shows.
   * - `'analysis'`: A deeper analysis of trends, patterns, or notable values.
   * - `'forecast'`: A short-term forecast based on the visible data.
   * - `'anomaly'`: An AI explanation of detected anomalies (internal use).
   */
  type: 'summary' | 'analysis' | 'forecast' | 'anomaly';
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
   * Row selection strategy when the dataset exceeds MAX_DATA_ROWS:
   * - `'aggregate'`: bucket rows into groups and aggregate numeric fields per bucket —
   *   best for summary/analysis/forecast on dense time-series (every period represented)
   * - `'tail'`: most recent N rows — retained for backwards compat; superseded by aggregate for forecast
   * - `'stride'`: evenly distributed sample — kept for non-numeric/non-time widget kinds
   * - `'anomaly'`: guarantees anomaly rows are included, fills remainder with stride —
   *   never aggregate here (would smooth out the outliers)
   * - `'head'`: first N rows (legacy; only suitable for small datasets)
   */
  sampling?: 'head' | 'tail' | 'stride' | 'aggregate' | 'anomaly';
  /** X-axis values identifying anomaly rows — only used when sampling === 'anomaly' */
  anomalyAxisValues?: string[];
}

function selectSampleRows(
  rows: Record<string, unknown>[],
  options: DataSummaryOptions,
  xFieldId: string | undefined,
): { sample: Record<string, unknown>[]; label: string } {
  const total = rows.length;
  if (total <= MAX_DATA_ROWS) {
    return { sample: rows, label: `${total} row${total !== 1 ? 's' : ''}` };
  }

  const { sampling = 'stride', anomalyAxisValues = [] } = options;

  if (sampling === 'tail') {
    return {
      sample: rows.slice(-MAX_DATA_ROWS),
      label: `most recent ${MAX_DATA_ROWS} of ${total}`,
    };
  }

  if (sampling === 'anomaly' && xFieldId && anomalyAxisValues.length > 0) {
    // Build a stride-based index set, then merge in anomaly row indices so
    // the anomalous data points are always present in the sample.
    const anomalySet = new Set(anomalyAxisValues.map(String));
    const stride = Math.ceil(total / MAX_DATA_ROWS);
    const strideIndices = rows.map((_, i) => i).filter((i) => i % stride === 0);
    const anomalyIndices = rows.reduce<number[]>((acc, r, i) => {
      if (anomalySet.has(String(r[xFieldId] ?? ''))) {
        acc.push(i);
      }
      return acc;
    }, []);
    const allIndices = [...new Set([...strideIndices, ...anomalyIndices])]
      .sort((a, b) => a - b)
      .slice(0, MAX_DATA_ROWS);
    return {
      sample: allIndices.map((i) => rows[i]),
      label: `${allIndices.length} of ${total} rows (including anomaly points)`,
    };
  }

  // stride (default) — distributed sample covers the full date/value range
  const stride = Math.ceil(total / MAX_DATA_ROWS);
  const sample = rows.filter((_, i) => i % stride === 0).slice(0, MAX_DATA_ROWS);
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
): { sample: Record<string, unknown>[]; label: string } {
  const total = rows.length;
  if (total <= MAX_DATA_ROWS) {
    return { sample: rows, label: `${total} row${total !== 1 ? 's' : ''}` };
  }

  const bucketSize = Math.ceil(total / MAX_DATA_ROWS);
  const sample: Record<string, unknown>[] = [];

  for (let i = 0; i < total; i += bucketSize) {
    const bucket = rows.slice(i, i + bucketSize);
    const row: Record<string, unknown> = {};

    for (const id of fieldIds) {
      const field = sourceFields.find((f) => f.id === id);
      const isNumeric = field?.type === 'number';
      const aggFn = field?.aiAggregation ?? (isNumeric ? 'avg' : 'first');

      if (aggFn === 'first' || !isNumeric) {
        row[id] = bucket[0][id];
      } else {
        const nums = bucket
          .map((r) => r[id])
          .filter((v): v is number => typeof v === 'number' && isFinite(v));
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
  const parts: string[] = [];
  for (const id of fieldIds) {
    const field = sourceFields.find((f) => f.id === id);
    if (field?.type !== 'number' && field?.type !== 'integer') {
      continue;
    }
    const values = rows
      .map((r) => r[id])
      .filter((v): v is number => typeof v === 'number' && isFinite(v));
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
function buildWidgetDataSummary(
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

  const { sampling = 'stride' } = options;
  const { sample, label } =
    sampling === 'aggregate'
      ? aggregateRows(filteredRows, fieldIds, source.fields)
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

function buildInsightPrompt(type: StudioInsightOptions['type'], forecastPeriods: number): string {
  const instructions: Record<StudioInsightOptions['type'], string> = {
    summary:
      'Write a brief 2–3 sentence plain-language summary of what this widget shows. ' +
      'Focus on the main value, trend, or comparison visible in the data.',
    analysis:
      'Provide a short analytical commentary (3–5 sentences) on this widget. ' +
      'Highlight notable trends, outliers, comparisons, or patterns in the data. ' +
      'Be specific and actionable where possible.',
    forecast:
      `Based on the trend visible in this widget, forecast the next ${forecastPeriods} periods. ` +
      'Be concise (2–4 sentences). Acknowledge uncertainty where appropriate. ' +
      'If the data does not support a forecast, say so briefly.',
    anomaly: 'Explain the anomalies detected in this widget. ' + 'Be concise and business-focused.',
  };
  return instructions[type];
}

async function callInsightEndpoint(
  config: StudioAIConfig,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const { endpoint, apiKey, model = 'gpt-4o', headers: extraHeaders } = config;

  const response = await fetch(endpoint, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => response.statusText);
    throw new Error(`AI request failed (${response.status}): ${errText.slice(0, 120)}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error('AI returned an empty response.');
  }
  return text.trim();
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

  const source = widget.sourceId ? state.dataSources[widget.sourceId] : undefined;
  const sourceDesc = source
    ? `Data source: ${source.label}. Fields: ${source.fields
        .filter((f) => !f.hidden)
        .map((f) => `${f.id} (${f.type}${f.aiDescription ? ` — ${f.aiDescription}` : ''})`)
        .join(', ')}.`
    : 'No data source configured.';

  const widgetDesc =
    `Widget: "${widget.title}" (kind: ${widget.kind}). ` +
    `Config: ${JSON.stringify(widget.config ?? {})}. ${sourceDesc}`;

  const systemPrompt =
    'You are a data analyst AI assistant for an analytics dashboard. ' +
    'The user is asking you to generate an insight about a specific dashboard widget. ' +
    'Be concise, factual, and business-focused. Do not repeat the widget title.';

  const dataSummary = buildWidgetDataSummary(widget, state, {
    sampling: 'aggregate',
  });
  const userPrompt = dataSummary
    ? `${widgetDesc}\n\n${dataSummary}\n\n${buildInsightPrompt(type, forecastPeriods)}`
    : `${widgetDesc}\n\n${buildInsightPrompt(type, forecastPeriods)}`;

  const text = await callInsightEndpoint(aiConfig, systemPrompt, userPrompt, signal);
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
  const dashboardState = buildAISystemPrompt(controller.getState());

  const systemPrompt =
    'You are a data analyst AI assistant for an analytics dashboard. ' +
    'The user wants a brief narrative summary of their entire dashboard. ' +
    'Summarise what the dashboard covers, highlight key metrics or trends visible across ' +
    'the widgets, and provide a 3–6 sentence executive summary. ' +
    'Be concise and business-focused.';

  const userPrompt =
    `Here is the current dashboard state:\n\n${dashboardState}\n\n` +
    'Write a brief executive summary of this dashboard.';

  const text = await callInsightEndpoint(aiConfig, systemPrompt, userPrompt, signal);
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

  const systemPrompt =
    'You are a data analyst AI assistant. ' +
    'The user has detected statistical anomalies in a chart. ' +
    'Provide a concise (3–5 sentence) explanation of possible causes for these outliers. ' +
    'Be specific to the widget context. Avoid generic disclaimers.';

  const userPrompt =
    `Widget: "${widget.title}" (kind: ${widget.kind}, chart type: ${widget.config?.chartType ?? 'unknown'}).\n` +
    `Anomalous data points detected at the following categories: ${anomalyLabels}.\n` +
    (dataSummary ? `\n${dataSummary}\n\n` : '\n') +
    'Explain briefly why these data points might be anomalous and suggest possible business or data-quality reasons.';

  const text = await callInsightEndpoint(aiConfig, systemPrompt, userPrompt, signal);
  return { text };
}
