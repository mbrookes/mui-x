import {
  validateConfigKeysForKind,
  validateChartConfigKeysForType,
  isStudioChartType,
} from '@mui/x-studio-schema';
import type { StudioController } from '../../store/StudioController';
import type {
  BuiltinStudioWidgetKind,
  StudioChartType,
  StudioWidget,
  StudioWidgetKind,
} from '../../models';
import { createDefaultWidget } from '../../internals/widgetUtils';
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
 */
function sanitizeServerWidgetConfig(
  kind: StudioWidgetKind,
  rawConfig: Record<string, unknown>,
): Record<string, unknown> {
  // Kind-level guard: e.g. a Chart-only key returned for a Grid widget. For a
  // custom / unknown kind `validateConfigKeysForKind` returns `[]` (no restriction).
  const invalidKindKeys = validateConfigKeysForKind(kind, rawConfig);
  let config =
    invalidKindKeys.length > 0
      ? Object.fromEntries(
          Object.entries(rawConfig).filter(([key]) => !invalidKindKeys.includes(key)),
        )
      : rawConfig;

  if (kind !== 'chart') {
    return config;
  }

  // Chart-type guard. An unknown / malformed `chartType` fails closed: drop it so
  // the merged widget keeps the factory default ('bar') and its keys are validated
  // against a real family rather than an empty allow-list that would strip everything.
  const rawChartType = config.chartType;
  let chartType: StudioChartType = 'bar';
  if (typeof rawChartType === 'string' && isStudioChartType(rawChartType)) {
    chartType = rawChartType;
  } else if (rawChartType !== undefined) {
    // Drop the bogus chartType so the merged widget keeps the valid factory default.
    config = Object.fromEntries(Object.entries(config).filter(([key]) => key !== 'chartType'));
  }

  const invalidChartKeys = validateChartConfigKeysForType(chartType, config);
  if (invalidChartKeys.length > 0) {
    config = Object.fromEntries(
      Object.entries(config).filter(([key]) => !invalidChartKeys.includes(key)),
    );
  }
  return config;
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
  const source = data.sourceId ? state.runtime.dataSources[String(data.sourceId)] : sources[0];

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
