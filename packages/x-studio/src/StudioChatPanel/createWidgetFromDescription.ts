import type { StudioController } from '../store/StudioController';
import type { StudioWidget, StudioWidgetKind } from '../models';
import { createDefaultWidget } from '../internals/widgetUtils';
import type { StudioAIConfig } from './studioAdapter';

/**
 * Focused system prompt for single-turn widget creation.
 * Much smaller than the full multi-turn chat prompt.
 */
function buildWidgetCreationPrompt(controller: StudioController): string {
  const state = controller.getState();
  const sources = Object.values(state.dataSources).filter((s) => !s.hidden);

  const sourceLines = sources
    .map((s) => {
      const fields = s.fields
        .flatMap((f) => (f.hidden ? [] : [`${f.id} (${f.type}, "${f.label}")`]))
        .join(', ');
      return `  - ${s.label} [id: ${s.id}]: ${fields}`;
    })
    .join('\n');

  return (
    `You are a dashboard widget builder. The user will describe a widget they want, ` +
    `and you MUST call add_widget exactly once to create it.\n\n` +
    `Available data sources:\n${sourceLines || '  (none yet)'}\n\n` +
    `Widget kinds: chart (bar, line, area, pie, donut, scatter, bar-stacked, area-stacked), ` +
    `kpi (single aggregated metric), grid (data table), filter (interactive filter control), ` +
    `pivot (cross-tabulation), map (choropleth world map by country), text (static text).\n\n` +
    `Pick sensible field selections from the available sources. ` +
    `Always prefer numeric fields for value/Y fields and categorical/date fields for group-by/X fields.`
  );
}

export interface CreateWidgetResult {
  success: boolean;
  error?: string;
}

/**
 * Makes a single non-streaming AI call to create a widget from a natural-language description.
 * Executes the returned add_widget tool call directly on the controller.
 */
export async function createWidgetFromDescription(
  description: string,
  config: StudioAIConfig,
  controller: StudioController,
): Promise<CreateWidgetResult> {
  const { endpoint, apiKey, model = 'gpt-4o', headers: extraHeaders } = config;

  const systemPrompt = buildWidgetCreationPrompt(controller);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
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
          { role: 'user', content: description },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'add_widget',
              description: 'Adds a widget to the dashboard.',
              parameters: {
                type: 'object',
                properties: {
                  kind: {
                    type: 'string',
                    enum: ['chart', 'grid', 'kpi', 'text', 'filter', 'pivot', 'map'],
                    description: 'Widget type.',
                  },
                  title: { type: 'string', description: 'Widget title.' },
                  sourceId: { type: 'string', description: 'Data source ID.' },
                  config: {
                    type: 'object',
                    description:
                      'Widget config: chart: chartType, xField, yField; kpi: kpiValueField, kpiAggregation; ' +
                      'grid: columns (field ID array); filter: filterWidgetType, filterWidgetField; ' +
                      'pivot: pivotRowField, pivotColField, pivotValueField, pivotAggregation; ' +
                      'map: mapCountryField, mapValueField, mapAggregation.',
                  },
                },
                required: ['kind', 'title'],
              },
            },
          },
        ],
        tool_choice: { type: 'function', function: { name: 'add_widget' } },
      }),
    });
  } catch {
    return { success: false, error: 'Network error. Check your connection and try again.' };
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    return {
      success: false,
      error: `AI request failed (${response.status})${errorText ? `: ${errorText.slice(0, 120)}` : ''}.`,
    };
  }

  let data: Record<string, unknown>;
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    return { success: false, error: 'Invalid response from AI.' };
  }

  const choices = data.choices as
    | Array<{ message: { tool_calls?: Array<{ function: { name: string; arguments: string } }> } }>
    | undefined;
  const toolCall = choices?.[0]?.message?.tool_calls?.[0];

  if (!toolCall || toolCall.function.name !== 'add_widget') {
    return {
      success: false,
      error: 'The AI did not create a widget. Try a more specific description.',
    };
  }

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
  } catch {
    return { success: false, error: 'AI returned invalid widget configuration.' };
  }

  const kind = String(args.kind ?? 'chart') as StudioWidgetKind;

  // Normalize through createDefaultWidget to ensure all required defaults are present,
  // then merge AI-provided fields and config on top.
  const state = controller.getState();
  const sources = Object.values(state.dataSources).filter((s) => !s.hidden);
  const source = args.sourceId ? state.dataSources[String(args.sourceId)] : sources[0];

  const base = createDefaultWidget(kind);
  const widget: StudioWidget = {
    ...base,
    title: args.title ? String(args.title) : base.title,
    sourceId: source?.id ?? base.sourceId,
    config: { ...base.config, ...((args.config as StudioWidget['config']) ?? {}) },
  };

  controller.addWidget(widget);
  return { success: true };
}
