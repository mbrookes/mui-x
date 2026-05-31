import type { StudioController } from '../store/StudioController';
import type { StudioAIConfig } from './studioAdapter';
import type { StudioChartAnnotation } from '../models/baseTypes';
import { buildAISystemPrompt } from '../internals/buildAISystemPrompt';

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

  const userPrompt = `${widgetDesc}\n\n${buildInsightPrompt(type, forecastPeriods)}`;

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

  const systemPrompt =
    'You are a data analyst AI assistant. ' +
    'The user has detected statistical anomalies in a chart. ' +
    'Provide a concise (3–5 sentence) explanation of possible causes for these outliers. ' +
    'Be specific to the widget context. Avoid generic disclaimers.';

  const userPrompt =
    `Widget: "${widget.title}" (kind: ${widget.kind}, chart type: ${widget.config?.chartType ?? 'unknown'}).\n` +
    `Anomalous data points detected at the following categories: ${anomalyLabels}.\n\n` +
    'Explain briefly why these data points might be anomalous and suggest possible business or data-quality reasons.';

  const text = await callInsightEndpoint(aiConfig, systemPrompt, userPrompt, signal);
  return { text };
}
