import type { StudioController } from '../../store/StudioController';
import type { BuiltinStudioWidgetKind, StudioWidget, StudioWidgetKind } from '../../models';
import { createDefaultWidget } from '../../internals/widgetUtils';
import { sanitizeWidgetConfigForChartType } from '../../internals/widgetConfigSanitization';
import { DEFAULT_STUDIO_LOCALE_TEXT } from '../../internals/localeText';
import type { StudioLocaleText } from '../../internals/localeText';
import type { StudioAIConfig } from './studioBackendAdapter';

export interface CreateWidgetResult {
  success: boolean;
  error?: string;
}

/** The finite, enumerable set of built-in widget kinds (`BuiltinStudioWidgetKind`). */
const VALID_WIDGET_KINDS: readonly BuiltinStudioWidgetKind[] = [
  'grid',
  'chart',
  'kpi',
  'text',
  'filter',
  'pivot',
  'map',
];

/**
 * Whether `value` is a recognized built-in widget kind. `data.kind` comes back
 * from the `/widget` endpoint's JSON response — server-side validation may not
 * cover every field, so this closes the gap client-side rather than trusting
 * whatever string the AI response contains.
 */
function isValidWidgetKind(value: unknown): value is BuiltinStudioWidgetKind {
  return typeof value === 'string' && (VALID_WIDGET_KINDS as readonly string[]).includes(value);
}

/**
 * Validates and strips a server-returned widget config the same way
 * `StudioController.updateWidgetConfig` guards a runtime config patch: it drops
 * any key that isn't valid for the widget `kind`, and — for charts — any key that
 * isn't valid for the resolved chart type.
 *
 * The `/widget` endpoint returns untrusted JSON. Unlike the sibling SSE
 * `state-mutation` path (which runs `parseStateMutation` before committing), this
 * path used to spread `data.config` straight into a committed widget, so a
 * malformed or unexpected server response could inject arbitrary config keys.
 * This guard closes that gap, mirroring the shallow key-presence checks used
 * everywhere else in the package.
 *
 * Thin wrapper over the shared {@link sanitizeWidgetConfigForChartType}: this is
 * a from-scratch CREATE (no prior widget to fall back on), so an absent/invalid
 * `chartType` falls back to the factory default (`'bar'`) — unlike
 * `StudioController.sanitizeWidgetConfigForKind`'s UPDATE path, which falls back
 * to the existing widget's own stored chart type.
 */
function sanitizeServerWidgetConfig(
  kind: StudioWidgetKind,
  rawConfig: Record<string, unknown>,
): Record<string, unknown> {
  return sanitizeWidgetConfigForChartType(kind, rawConfig, 'bar');
}

/**
 * Asks the backend to create a widget from a natural-language description.
 * POSTs to `aiConfig.endpoint` + `/widget` with the description and data-source context.
 * The server returns a `StudioWidget`-shaped object which is applied via the controller.
 *
 * `localeText` is optional so existing callers/tests that don't pass it fall back to
 * the English defaults; the only in-app caller (`DescribeWidgetSection`) forwards the
 * active `useStudioLocaleText()` bundle so the surfaced error strings are localized.
 */
export async function createWidgetFromDescription(
  description: string,
  config: StudioAIConfig,
  controller: StudioController,
  localeText: StudioLocaleText = DEFAULT_STUDIO_LOCALE_TEXT,
): Promise<CreateWidgetResult> {
  const state = controller.getState();
  // Private mode: the client must genuinely NOT send real row values, author-written
  // descriptions, or any other data-derived signal to the LLM provider — mirroring
  // `studioBackendAdapter.ts`'s schema-only stance (which gates `pageSnapshot`/
  // `dashboardState`/`richContext` behind the same flag) rather than relying on the
  // server honouring `privateMode`. In private mode we still send the field *schema*
  // (ids/labels/types/formats) so the server can construct a valid widget, but never
  // the `cardinality` string (built from actual distinct row values via
  // `fieldDistinctValues`) or the `aiDescription` metadata. `privateMode` is also
  // forwarded in the body so the server can additionally refuse to comply.
  const privateMode = config.privateMode === true;
  const sources = Object.values(state.runtime.dataSources).flatMap((s) => {
    if (s.hidden) {
      return [];
    }
    return [
      {
        id: s.id,
        label: s.label,
        ...(privateMode ? {} : { aiDescription: s.aiDescription }),
        fields: s.fields.flatMap((f) => {
          if (f.hidden) {
            return [];
          }
          let cardinality: string | undefined;
          if (!privateMode) {
            const vals = s.fieldDistinctValues?.[f.id];
            if (vals) {
              if (vals.length <= 8) {
                cardinality = `${vals.length}: ${vals.join('|')}`;
              } else if (vals.length <= 30) {
                cardinality = `${vals.length} values`;
              }
            }
          }
          return [
            {
              id: f.id,
              type: f.type,
              label: f.label,
              ...(f.format ? { format: f.format } : {}),
              ...(!privateMode && f.aiDescription ? { aiDescription: f.aiDescription } : {}),
              ...(f.defaultAggregationFn ? { defaultAggregationFn: f.defaultAggregationFn } : {}),
              ...(cardinality ? { cardinality } : {}),
            },
          ];
        }),
      },
    ];
  });

  const url = `${config.endpoint.replace(/\/?$/, '')}/widget`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.headers ?? {}),
      },
      body: JSON.stringify({ description, sources, privateMode }),
    });
  } catch {
    return { success: false, error: localeText.aiCreateWidgetNetworkError };
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    return {
      success: false,
      error: localeText.aiCreateWidgetRequestFailed(
        response.status,
        errorText ? errorText.slice(0, 120) : '',
      ),
    };
  }

  let data: Record<string, unknown>;
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    return { success: false, error: localeText.aiCreateWidgetInvalidResponse };
  }

  const kind: StudioWidgetKind = isValidWidgetKind(data.kind) ? data.kind : 'chart';
  const requestedSourceId = data.sourceId ? String(data.sourceId) : undefined;
  const requestedSource = requestedSourceId
    ? state.runtime.dataSources[requestedSourceId]
    : undefined;
  // A truthy `sourceId` that doesn't resolve to a real, visible data source (e.g. the
  // model hallucinates a label like "Sales" instead of the actual id "src1", or names a
  // source the host deliberately hid) must not silently commit a widget with
  // `sourceId: undefined` — fall back to the first available (non-hidden) source exactly
  // like the no-`sourceId` case below, so both paths consistently exclude hidden sources.
  const source = requestedSource && !requestedSource.hidden ? requestedSource : sources[0];

  const base = createDefaultWidget(kind);
  const rawConfig =
    data.config && typeof data.config === 'object' && !Array.isArray(data.config)
      ? (data.config as Record<string, unknown>)
      : {};
  const safeConfig = sanitizeServerWidgetConfig(kind, rawConfig);
  const widget: StudioWidget = {
    ...base,
    title: data.title ? String(data.title) : base.title,
    sourceId: source?.id ?? base.sourceId,
    config: { ...base.config, ...safeConfig } as StudioWidget['config'],
  };

  controller.addWidget(widget);
  return { success: true };
}
