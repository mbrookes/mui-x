'use client';
import * as React from 'react';
import type {
  StudioFeatureFlags,
  KpiFeatureFlags,
  ChartFeatureFlags,
  GridFeatureFlags,
  StudioCustomWidgetDef,
} from '../models';
import type { StudioAIConfig } from '../StudioChatPanel/studioAdapter';
import {
  BUILT_IN_GEOGRAPHY_DEFINITIONS,
  type StudioMapGeographyDefinition,
} from '../StudioMapWidget/geographyLoaders';

// ── Locale text ─────────────────────────────────────────────────────────────

/**
 * All translatable string tokens used by the Studio UI.
 * Pass a `Partial<StudioLocaleText>` to `<Studio localeText={…} />` to override
 * any subset of strings. Tokens not included in the partial fall back to
 * `DEFAULT_STUDIO_LOCALE_TEXT`.
 */
export interface StudioLocaleText {
  // ── Drawer titles ──────────────────────────────────────────────────────────
  dataDrawerTitle: string;
  composeDrawerTitle: string;
  filtersDrawerTitle: string;

  // ── Date range presets ─────────────────────────────────────────────────────
  dateRangePresetAllTime: string;
  dateRangePresetYTD: string;
  dateRangePresetThisMonth: string;
  dateRangePresetLast3Months: string;
  dateRangePresetLast12Months: string;

  // ── Filters drawer ─────────────────────────────────────────────────────────
  filterSearchPlaceholder: string;
  filtersSectionPageFiltersTitle: string;
  filtersSectionNoFilters: string;
  filtersSectionNoMatchingFilters: string;
  filtersAddFilterTooltip: string;
  filtersSavedViewsTitle: string;
  filtersSaveViewTooltip: string;
  filtersSaveViewButton: string;
  filtersSaveViewPlaceholder: string;
  filtersDeleteViewTooltip: string;
  filtersNoSavedViews: string;
  filtersAddDataSourceHint: string;

  // ── Widget empty / error states ────────────────────────────────────────────
  widgetConfigureChartHint: string;
  widgetConfigureGaugeHint: string;
  widgetConfigurePivotHint: string;
  widgetConfigureMapHint: string;
  widgetNoData: string;
  widgetLoadError: string;

  // ── Quick filter bar ───────────────────────────────────────────────────────
  quickFilterBarOpenFilters: string;
  quickFilterBarClearAll: string;

  // ── Widget card actions ────────────────────────────────────────────────────
  widgetEditTooltip: string;
  widgetExportCsvTooltip: string;
  widgetExportPngTooltip: string;
  widgetExpandTooltip: string;
  widgetMoveToPageLabel: string;

  // ── AI assistant ───────────────────────────────────────────────────────────
  aiAssistantOpenTooltip: string;
  aiAssistantCloseTooltip: string;

  // ── Natural language widget creation ──────────────────────────────────────
  aiCreateWidgetLabel: string;
  aiCreateWidgetPlaceholder: string;
  aiCreateWidgetButton: string;
  aiCreateWidgetLoading: string;
  aiCreateWidgetError: string;
}

/** Default English locale text for all Studio UI strings. */
export const DEFAULT_STUDIO_LOCALE_TEXT: StudioLocaleText = {
  // Drawer titles
  dataDrawerTitle: 'Data',
  composeDrawerTitle: 'Compose',
  filtersDrawerTitle: 'Filters',

  // Date range presets
  dateRangePresetAllTime: 'All time',
  dateRangePresetYTD: 'YTD',
  dateRangePresetThisMonth: 'This month',
  dateRangePresetLast3Months: 'Last 3 months',
  dateRangePresetLast12Months: 'Last 12 months',

  // Filters drawer
  filterSearchPlaceholder: 'Search filters\u2026',
  filtersSectionPageFiltersTitle: 'Page filters',
  filtersSectionNoFilters: 'No filters applied.',
  filtersSectionNoMatchingFilters: 'No matching filters.',
  filtersAddFilterTooltip: 'Add filter',
  filtersSavedViewsTitle: 'Saved views',
  filtersSaveViewTooltip: 'Save current page filters as a named view',
  filtersSaveViewButton: 'Save',
  filtersSaveViewPlaceholder: 'View name',
  filtersDeleteViewTooltip: 'Delete view',
  filtersNoSavedViews: 'No saved views. Apply page filters and save them here.',
  filtersAddDataSourceHint: 'Add a data source and widgets first.',

  // Widget states
  widgetConfigureChartHint: 'Use the Setup tab to configure this chart.',
  widgetConfigureGaugeHint: 'Use the Setup tab to choose a gauge value field.',
  widgetConfigurePivotHint: 'Use the Setup tab to configure row, column, and value fields.',
  widgetConfigureMapHint: 'Use the Setup tab to choose a country field and a value field.',
  widgetNoData: 'No data to display.',
  widgetLoadError: 'Failed to load data',

  // Quick filter bar
  quickFilterBarOpenFilters: 'Open filters panel',
  quickFilterBarClearAll: 'Clear all page filters',

  // Widget card actions
  widgetEditTooltip: 'Edit widget',
  widgetExportCsvTooltip: 'Export as CSV',
  widgetExportPngTooltip: 'Export as PNG',
  widgetExpandTooltip: 'Expand chart',
  widgetMoveToPageLabel: 'Move to page',

  // AI assistant
  aiAssistantOpenTooltip: 'Open AI assistant',
  aiAssistantCloseTooltip: 'Close AI assistant',

  // Natural language widget creation
  aiCreateWidgetLabel: 'Describe a widget',
  aiCreateWidgetPlaceholder:
    'e.g. Bar chart showing revenue by country, KPI for total orders\u2026',
  aiCreateWidgetButton: 'Create',
  aiCreateWidgetLoading: 'Creating\u2026',
  aiCreateWidgetError: 'Failed to create widget',
};

// ── Config context ──────────────────────────────────────────────────────────

export interface StudioUIConfig {
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
    // react-doctor-disable-next-line react-doctor/exhaustive-deps -- JSON.stringify proxy for deep equality
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(customWidgets?.map((d) => d.kind))],
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
  const { geographies } = useStudioUIConfig();
  return React.useMemo(
    () => ({ ...BUILT_IN_GEOGRAPHY_DEFINITIONS, ...geographies }),
    // react-doctor-disable-next-line react-doctor/exhaustive-deps -- JSON.stringify proxy for deep equality
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(Object.keys(geographies ?? {}))],
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
 * Flat resolved feature flags — all nested sub-flags are unwound into top-level booleans.
 * This is the internal type returned by `useStudioFeatures()` and consumed by UI components.
 * The public API (`StudioFeatureFlags`) supports nested objects; resolution happens here.
 */
export interface ResolvedStudioFeatures {
  // ── Top-level flags ────────────────────────────────────────────────────────
  compose: boolean;
  filters: boolean;
  savedFilterViews: boolean;
  dataManagement: boolean;
  relationships: boolean;
  widgetFilters: boolean;
  aiChat: boolean;
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
  kpiTarget: boolean;
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

/** Returns the active feature flags as a flat resolved object. All flags default to `true`. */
export function useStudioFeatures(): ResolvedStudioFeatures {
  const { featureFlags } = useStudioUIConfig();
  const { kpi, chart, grid } = featureFlags;
  return {
    compose: featureFlags.compose ?? true,
    filters: featureFlags.filters ?? true,
    savedFilterViews: featureFlags.savedFilterViews ?? true,
    dataManagement: featureFlags.dataManagement ?? true,
    relationships: featureFlags.relationships ?? true,
    widgetFilters: featureFlags.widgetFilters ?? true,
    aiChat: featureFlags.aiChat ?? true,
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
    kpiTarget: resolveSubFlag<KpiFeatureFlags>(kpi, 'target'),
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
