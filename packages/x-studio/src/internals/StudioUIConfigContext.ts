'use client';
// ── Studio UI-config context ─────────────────────────────────────────────────
//
// This file owns the React context/provider/hooks for Studio's UI config. Two
// large, cohesive sections that used to live here were extracted to keep this
// file focused on its context identity:
//
//   - `./localeText`       — the `StudioLocaleText` interface + the English
//                            `DEFAULT_STUDIO_LOCALE_TEXT` default (by far the
//                            largest section).
//   - `./widgetRegistry`   — the widget-kind registry TYPES
//                            (`StudioWidgetRenderProps`, `StudioWidgetCapabilities`,
//                            `StudioWidgetDef`).
//
// Both are re-exported below so every existing deep import of these symbols from
// `internals/StudioUIConfigContext` keeps resolving unchanged (compatibility façade).

import * as React from 'react';
import type {
  StudioFeatureFlags,
  KpiFeatureFlags,
  ChartFeatureFlags,
  GridFeatureFlags,
  StudioCustomWidgetDef,
} from '../models';
import type { StudioAIConfig } from '../components/StudioChatPanel/studioBackendAdapter';
import {
  getBuiltInGeographyDefinitions,
  type StudioMapGeographyDefinition,
} from '../components/widgets/StudioMapWidget/geographyLoaders';
import { DEFAULT_STUDIO_LOCALE_TEXT } from './localeText';
import type { StudioLocaleText } from './localeText';

// ── Compatibility façade re-exports ─────────────────────────────────────────
export { DEFAULT_STUDIO_LOCALE_TEXT };
export type { StudioLocaleText };
export type {
  StudioWidgetRenderProps,
  StudioWidgetCapabilities,
  StudioWidgetDef,
} from './widgetRegistry';

// ── Config context ──────────────────────────────────────────────────────────

interface StudioUIConfig {
  /**
   * Controls how the table widget's data source is determined.
   * - `'explicit'` (default): a data source picker is shown at the top of the
   *   table setup panel — the user must choose a source before adding columns.
   * - `'implicit'`: no source picker is shown. The source is inferred from the
   *   first column the user adds (Tableau / Power BI style). Removing all
   *   columns resets the source so a different one can be chosen.
   */
  tableSourceMode: 'explicit' | 'implicit';
  /** Runtime feature flags controlling which UI features are available. */
  featureFlags: StudioFeatureFlags;
  /**
   * Locale text overrides. Any tokens not provided fall back to the English defaults.
   * Pass the full `StudioLocaleText` object (e.g. `ptBRLocaleText`) or a partial
   * override to change individual strings.
   */
  localeText: StudioLocaleText;
  /**
   * BCP-47 language tag every `Intl` formatter in the package resolves against
   * (numbers, currencies, dates, month names, region names).
   * `undefined` falls back to the runtime/browser locale.
   */
  locale?: string;
  /**
   * AI/LLM configuration for the natural language widget creator and AI chat assistant.
   * When provided, the "Describe a widget" prompt appears in the compose drawer.
   * Set to `null` to disable AI features even if the config object exists.
   */
  aiConfig?: StudioAIConfig | null;
  /**
   * Consumer-defined custom widget kinds.
   * Widgets registered here appear in the widget picker and are rendered on the canvas.
   * See {@link StudioCustomWidgetDef} for the registration shape.
   */
  customWidgets?: StudioCustomWidgetDef[];
  /**
   * Additional map geography definitions to register alongside the built-in `'world'`,
   * `'usa'`, and `'europe'` geographies.
   *
   * Each entry defines how to load the topology, how to normalise raw data values to
   * feature IDs, and how the geography appears in the Map Setup panel (label, field
   * label, and help text).
   *
   * @example
   * ```tsx
   * const geographies = {
   *   'uk-counties': {
   *     label: 'United Kingdom',
   *     fieldLabel: 'County field',
   *     fieldHint: 'A field containing UK county names.',
   *     loader: async () => { ... },
   *     normalizer: (v) => String(v).trim().toLowerCase(),
   *   },
   * };
   * <Studio geographies={geographies} />
   * ```
   */
  geographies?: Record<string, StudioMapGeographyDefinition>;
  /**
   * Optional callback invoked when the user clicks the filter panel button in the quick filter bar.
   * When provided, a filter icon button appears in the bar. Use this in composed apps where the
   * filter side panel is replaced by a modal dialog or other custom UI.
   * When omitted, no filter icon button is shown.
   */
  onOpenFilterPanel?: () => void;
}

/** Pre-built map from `kind` → `StudioCustomWidgetDef` for fast lookup. */
type CustomWidgetMap = ReadonlyMap<string, StudioCustomWidgetDef>;

export const StudioUIConfigContext = React.createContext<StudioUIConfig>({
  tableSourceMode: 'explicit',
  featureFlags: {},
  localeText: DEFAULT_STUDIO_LOCALE_TEXT,
});

/** Returns the resolved UI config including feature flags. */
export function useStudioUIConfig(): StudioUIConfig {
  return React.useContext(StudioUIConfigContext);
}

/** Returns the custom widget definitions indexed by kind for O(1) lookup. */
export function useCustomWidgetMap(): CustomWidgetMap {
  const { customWidgets } = useStudioUIConfig();
  return React.useMemo(
    () => new Map((customWidgets ?? []).map((d) => [d.kind, d])),
    [customWidgets],
  );
}

/**
 * Returns all geography definitions — built-ins merged with any consumer-provided
 * overrides from `<Studio geographies={…} />`.
 *
 * Consumer entries take precedence, so a consumer can override a built-in geography
 * by registering a definition under the same key (`'world'`, `'usa'`, `'europe'`).
 */
export function useStudioGeographies(): Record<string, StudioMapGeographyDefinition> {
  const { geographies, localeText } = useStudioUIConfig();
  // Depend on `geographies` itself, not on a derived key list. A prior version keyed this
  // memo on `JSON.stringify(Object.keys(geographies ?? {}))` — a proxy that only tracked the
  // SET of registered geography keys. That went stale whenever a consumer updated a
  // definition's actual content (a corrected `normalizer`, an updated `loader`, a renamed
  // `label`) without adding or removing a key: the key list was unchanged, so the memo never
  // recomputed and every caller kept the old definition for the lifetime of the mount. This
  // is the same fix, for the same reason, as the sibling `useWidgetDefMap` in
  // `builtinWidgetDefs.ts` — see the long comment there. Keying on the object reference
  // directly recomputes whenever the caller passes a new `geographies` value, which is the
  // correct signal for content changes (a consumer that mutates a definition in place without
  // producing a new object reference is already outside React's change-detection contract).
  //
  // `localeText` joins the dependency list because the built-ins' region field label/hint now
  // come from it (they used to be English literals baked into the definitions module), so a
  // locale change has to rebuild them.
  return React.useMemo(
    () => ({ ...getBuiltInGeographyDefinitions(localeText), ...geographies }),
    [geographies, localeText],
  );
}

/**
 * Returns the resolved locale text with consumer overrides merged over defaults.
 * Use this hook in any component that renders user-visible strings.
 */
export function useStudioLocaleText(): StudioLocaleText {
  const { localeText } = useStudioUIConfig();
  return localeText;
}

/**
 * Returns the BCP-47 tag passed as `<Studio locale={…} />`, or `undefined` when the host
 * did not set one (formatters then resolve to the runtime/browser locale).
 *
 * Use this in React components that build their own `Intl` formatters. Non-React helpers
 * should call `getStudioLocale()` from `internals/studioLocale` instead.
 *
 * @returns The active BCP-47 language tag, or `undefined`.
 */
export function useStudioLocale(): string | undefined {
  const { locale } = useStudioUIConfig();
  return locale;
}

/**
 * Flat resolved feature flags — all nested sub-flags are unwound into top-level booleans.
 * This is the internal type returned by `useStudioFeatures()` and consumed by UI components.
 * The public API (`StudioFeatureFlags`) supports nested objects; resolution happens here.
 */
export interface ResolvedStudioFeatures {
  // ── Top-level flags ────────────────────────────────────────────────────────
  compose: boolean;
  filters: boolean;
  quickFilter: boolean;
  crossFilterBar: boolean;
  savedFilterViews: boolean;
  dataManagement: boolean;
  relationships: boolean;
  widgetFilters: boolean;
  aiChat: boolean;
  aiInsights: boolean;
  export: boolean;
  // ── Widget kind availability ───────────────────────────────────────────────
  grid: boolean;
  chart: boolean;
  kpi: boolean;
  text: boolean;
  filter: boolean;
  pivot: boolean;
  map: boolean;
  // ── KPI sub-flags ──────────────────────────────────────────────────────────
  kpiSparkline: boolean;
  kpiTrend: boolean;
  kpiCalculatedFields: boolean;
  // ── Chart sub-flags ────────────────────────────────────────────────────────
  chartAnnotations: boolean;
  chartCalculatedFields: boolean;
  // ── Grid sub-flags ─────────────────────────────────────────────────────────
  gridGroupBy: boolean;
  gridSummary: boolean;
  gridConditionalFormats: boolean;
  gridCalculatedFields: boolean;
  // ── Global ─────────────────────────────────────────────────────────────────
  calculatedFields: boolean;
}

/**
 * Resolves a sub-flag from a widget-kind flag that may be boolean or an object.
 * - `false` / `undefined parent` disabled → sub-flag is also disabled
 * - `true` or `undefined` → sub-flag defaults to `true`
 * - object → reads the specific sub-key, defaulting to `true`
 */
function resolveSubFlag<T extends object>(
  widgetFlag: boolean | T | undefined,
  subKey: keyof T,
): boolean {
  if (widgetFlag === false) {
    return false;
  }
  if (widgetFlag === undefined || widgetFlag === true) {
    return true;
  }
  return ((widgetFlag as T)[subKey] as boolean | undefined) ?? true;
}

/**
 * Returns the active feature flags as a flat resolved object. Most flags default to `true`;
 * `quickFilter` and `crossFilterBar` default to `false` (opt-in features).
 */
export function useStudioFeatures(): ResolvedStudioFeatures {
  const { featureFlags } = useStudioUIConfig();
  const { kpi, chart, grid } = featureFlags;
  return {
    compose: featureFlags.compose ?? true,
    filters: featureFlags.filters ?? true,
    quickFilter: featureFlags.quickFilter ?? false,
    crossFilterBar: featureFlags.crossFilterBar ?? false,
    savedFilterViews: featureFlags.savedFilterViews ?? true,
    dataManagement: featureFlags.dataManagement ?? true,
    relationships: featureFlags.relationships ?? true,
    widgetFilters: featureFlags.widgetFilters ?? true,
    aiChat: featureFlags.aiChat ?? true,
    aiInsights: featureFlags.aiInsights ?? true,
    export: featureFlags.export ?? true,
    // Widget kinds: enabled when the flag is not `false` (true, undefined, or an object all enable the kind)
    grid: grid !== false,
    chart: chart !== false,
    kpi: kpi !== false,
    text: featureFlags.text ?? true,
    filter: featureFlags.filter ?? true,
    pivot: featureFlags.pivot ?? true,
    map: featureFlags.map ?? true,
    // KPI sub-flags
    kpiSparkline: resolveSubFlag<KpiFeatureFlags>(kpi, 'sparkline'),
    kpiTrend: resolveSubFlag<KpiFeatureFlags>(kpi, 'trend'),
    kpiCalculatedFields: resolveSubFlag<KpiFeatureFlags>(kpi, 'calculatedFields'),
    // Chart sub-flags
    chartAnnotations: resolveSubFlag<ChartFeatureFlags>(chart, 'annotations'),
    chartCalculatedFields: resolveSubFlag<ChartFeatureFlags>(chart, 'calculatedFields'),
    // Grid sub-flags
    gridGroupBy: resolveSubFlag<GridFeatureFlags>(grid, 'groupBy'),
    gridSummary: resolveSubFlag<GridFeatureFlags>(grid, 'summary'),
    gridConditionalFormats: resolveSubFlag<GridFeatureFlags>(grid, 'conditionalFormats'),
    gridCalculatedFields: resolveSubFlag<GridFeatureFlags>(grid, 'calculatedFields'),
    // Global
    calculatedFields: featureFlags.calculatedFields ?? true,
  };
}
