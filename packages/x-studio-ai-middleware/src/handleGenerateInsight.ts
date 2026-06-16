/**
 * `handleGenerateInsight` — simple text-generation request for widget insights.
 *
 * Unlike `handleAIChat`, this function:
 * - Runs a single LLM call (no tools, no agentic loop)
 * - Returns a `Promise<string>` (plain text, not SSE)
 * - Is used for summary, analysis, forecast, and anomaly-explanation requests
 *
 * PURE FUNCTION GUARANTEE: no HTTP framework imports, no global state.
 */

import { WIDGET_CONFIG_DESCRIPTION } from './studioAITools';

export interface GenerateInsightOptions {
  /** LLM endpoint (OpenAI-compatible, e.g. `https://api.openai.com/v1/chat/completions`) */
  endpoint: string;
  /** API key sent as `Authorization: Bearer <apiKey>` */
  apiKey?: string;
  /** Model name. Defaults to `'gpt-4o'`. */
  model?: string;
  /** Extra headers forwarded to the LLM endpoint */
  headers?: Record<string, string>;
}

export interface GenerateInsightRequest {
  /** The insight type requested by the client */
  insightType: 'summary' | 'analysis' | 'forecast' | 'anomaly' | 'correlation';
  /** Widget kind (e.g. `'bar-chart'`, `'kpi'`) for context */
  widgetKind: string;
  /** Human-readable widget title */
  widgetTitle: string;
  /**
   * Compact data payload: field labels + sampled rows.
   * Serialized by the client from the widget's current data.
   */
  dataSummary: string;
  /** Number of forecast periods (only used when `insightType === 'forecast'`) */
  forecastPeriods?: number;
  /** AbortSignal to cancel the request */
  signal?: AbortSignal;
}

const INSIGHT_SYSTEM_PROMPTS: Record<GenerateInsightRequest['insightType'], string> = {
  summary:
    'You are a concise business analyst. Write a 3–4 sentence plain-English summary of the widget data provided. ' +
    'Cover the key values, scale of the data, and any immediately obvious trend or pattern. ' +
    'Always write complete sentences — never cut off mid-thought. No preamble.',
  analysis:
    'You are a data analyst. Provide a 4–6 sentence analysis of the widget data: identify trends, patterns, outliers, or noteworthy comparisons. ' +
    'Be specific and quantitative where possible. Always write complete sentences. No preamble.',
  forecast:
    'You are a forecasting analyst. Based on the historical data provided, write a 3–5 sentence forecast. ' +
    'Mention expected direction, magnitude if estimable, and any important caveats. ' +
    'Always write complete sentences. No preamble.',
  anomaly:
    'You are a data quality analyst. The following data contains one or more anomalies. ' +
    'Write a 3–4 sentence plain-English explanation of the anomaly, why it stands out, and a likely cause. ' +
    'Always write complete sentences. No preamble.',
  correlation:
    'You are a data analyst specialising in correlation analysis. ' +
    'You will be given pairwise Pearson r values and a data sample. ' +
    'Write a 4–6 sentence plain-English interpretation: explain what the correlations mean, ' +
    'which relationships are strongest, whether they are positive or negative, ' +
    'and any business implications. Be specific. Always write complete sentences. No preamble.',
};

/**
 * Generate a single-paragraph insight for a studio widget.
 *
 * @param request - Insight type, widget metadata, and data summary.
 * @param options - LLM connection options (endpoint, apiKey, model).
 * @returns The generated insight text.
 */
export async function handleGenerateInsight(
  request: GenerateInsightRequest,
  options: GenerateInsightOptions,
): Promise<string> {
  const { insightType, widgetKind, widgetTitle, dataSummary, forecastPeriods, signal } = request;
  const { endpoint, apiKey, model = 'gpt-4o', headers: extraHeaders } = options;

  const systemPrompt = INSIGHT_SYSTEM_PROMPTS[insightType];

  let userContent = `Widget type: ${widgetKind}\nTitle: "${widgetTitle}"\n\nData:\n${dataSummary}`;
  if (insightType === 'forecast' && forecastPeriods) {
    userContent += `\n\nForecast horizon: ${forecastPeriods} periods.`;
  }

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
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      max_tokens: 600,
      temperature: 0.4,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => response.statusText);
    throw new Error(`Insight generation failed: ${response.status} ${errText}`);
  }

  const json = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };

  return json.choices[0]?.message?.content?.trim() ?? '';
}

/**
 * Generate a short title + one-sentence description for a chat session.
 *
 * @param firstMessage - The user's first message in the chat.
 * @param options - LLM connection options.
 * @returns `{ title, description }` JSON object.
 */
export async function handleGenerateTitle(
  firstMessage: string,
  options: GenerateInsightOptions,
): Promise<{ title: string; description: string }> {
  const { endpoint, apiKey, model = 'gpt-4o', headers: extraHeaders } = options;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content:
            'Generate a short title (max 6 words) and a one-sentence description for a ' +
            "dashboard analytics chat session based on the user's first message. " +
            'Respond ONLY with valid JSON: {"title": "...", "description": "..."}',
        },
        { role: 'user', content: firstMessage },
      ],
      max_tokens: 100,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    throw new Error(`Title generation failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };

  try {
    return JSON.parse(data.choices[0].message.content) as { title: string; description: string };
  } catch {
    return { title: firstMessage.slice(0, 40), description: '' };
  }
}

// ── Widget creation ───────────────────────────────────────────────────────────

export interface CreateWidgetRequest {
  /** Natural-language description of the widget to create */
  description: string;
  /** Available data sources (sent by client so server has full field context) */
  sources: Array<{
    id: string;
    label: string;
    fields: Array<{ id: string; type: string; label?: string }>;
  }>;
}

export interface CreateWidgetResponse {
  kind: string;
  title: string;
  sourceId?: string;
  config?: Record<string, unknown>;
}

/**
 * Ask the LLM to create a widget from a natural-language description.
 * Returns a plain JSON object (not SSE) with `kind`, `title`, `sourceId`, `config`.
 */
export async function handleCreateWidget(
  request: CreateWidgetRequest,
  options: GenerateInsightOptions,
): Promise<CreateWidgetResponse> {
  const { description, sources } = request;
  const { endpoint, apiKey, model = 'gpt-4o', headers: extraHeaders } = options;

  const sourceLines = sources
    .map((s) => {
      const fields = s.fields
        .map((f) => `${f.id} (${f.type}${f.label ? `, "${f.label}"` : ''})`)
        .join(', ');
      return `  - ${s.label} [id: ${s.id}]: ${fields}`;
    })
    .join('\n');

  const systemPrompt =
    'You are a dashboard widget builder. The user will describe a widget they want.\n' +
    'Respond ONLY with valid JSON: {"kind":"...","title":"...","sourceId":"...","config":{...}}\n\n' +
    'Widget kinds: chart, kpi, grid, filter, pivot, map, text.\n\n' +
    `${WIDGET_CONFIG_DESCRIPTION}\n\n` +
    `Available data sources:\n${sourceLines || '  (none yet)'}\n\n` +
    'Pick sensible field selections. Prefer numeric fields for values/Y-axis and categorical/date fields for grouping/X-axis.';

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: description },
      ],
      max_tokens: 500,
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    throw new Error(`Widget creation failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };

  try {
    return JSON.parse(data.choices[0].message.content) as CreateWidgetResponse;
  } catch {
    throw new Error('AI returned invalid widget configuration.');
  }
}
