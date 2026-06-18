/**
 * LLM utility helpers — title generation and widget creation.
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
  /** Hard cap on output tokens. Omit to use the model's default (unlimited). */
  maxTokens?: number;
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
