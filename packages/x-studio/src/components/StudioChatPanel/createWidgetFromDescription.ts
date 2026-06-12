import type { StudioController } from '../../store/StudioController';
import type { StudioWidget, StudioWidgetKind } from '../../models';
import { createDefaultWidget } from '../../internals/widgetUtils';
import type { StudioAIConfig } from './studioBackendAdapter';

export interface CreateWidgetResult {
  success: boolean;
  error?: string;
}

/**
 * Asks the backend to create a widget from a natural-language description.
 * POSTs to `aiConfig.endpoint` + `/widget` with the description and data-source context.
 * The server returns a `StudioWidget`-shaped object which is applied via the controller.
 */
export async function createWidgetFromDescription(
  description: string,
  config: StudioAIConfig,
  controller: StudioController,
): Promise<CreateWidgetResult> {
  const state = controller.getState();
  const sources = Object.values(state.dataSources)
    .filter((s) => !s.hidden)
    .map((s) => ({
      id: s.id,
      label: s.label,
      aiDescription: s.aiDescription,
      fields: s.fields
        .filter((f) => !f.hidden)
        .map((f) => {
          const vals = s.fieldDistinctValues?.[f.id];
          let cardinality: string | undefined;
          if (vals) {
            if (vals.length <= 8) {
              cardinality = `${vals.length}: ${vals.join('|')}`;
            } else if (vals.length <= 30) {
              cardinality = `${vals.length} values`;
            }
          }
          return {
            id: f.id,
            type: f.type,
            label: f.label,
            ...(f.format ? { format: f.format } : {}),
            ...(f.aiDescription ? { aiDescription: f.aiDescription } : {}),
            ...(f.defaultAggregationFn ? { defaultAggregationFn: f.defaultAggregationFn } : {}),
            ...(cardinality ? { cardinality } : {}),
          };
        }),
    }));

  const url = `${config.endpoint.replace(/\/?$/, '')}/widget`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.headers ?? {}),
      },
      body: JSON.stringify({ description, sources }),
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

  const kind = String(data.kind ?? 'chart') as StudioWidgetKind;
  const source = data.sourceId ? state.dataSources[String(data.sourceId)] : sources[0];

  const base = createDefaultWidget(kind);
  const widget: StudioWidget = {
    ...base,
    title: data.title ? String(data.title) : base.title,
    sourceId: source?.id ?? base.sourceId,
    config: { ...base.config, ...((data.config as StudioWidget['config']) ?? {}) },
  };

  controller.addWidget(widget);
  return { success: true };
}
