import * as React from 'react';
import type { StudioFeatureFlags } from '../models';
import type { StudioAIConfig } from '../StudioChatPanel/studioAdapter';

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
}

export const StudioUIConfigContext = React.createContext<StudioUIConfig>({
  tableSourceMode: 'explicit',
  featureFlags: {},
  localeText: DEFAULT_STUDIO_LOCALE_TEXT,
});

/** Returns the resolved UI config including feature flags. */
export function useStudioUIConfig(): StudioUIConfig {
  return React.useContext(StudioUIConfigContext);
}

/**
 * Returns the resolved locale text with consumer overrides merged over defaults.
 * Use this hook in any component that renders user-visible strings.
 */
export function useStudioLocaleText(): StudioLocaleText {
  const { localeText } = useStudioUIConfig();
  return localeText;
}

/** Returns the active feature flags. All flags default to `true` when not explicitly set. */
export function useStudioFeatures(): Required<StudioFeatureFlags> {
  const { featureFlags } = useStudioUIConfig();
  return {
    compose: featureFlags.compose ?? true,
    filters: featureFlags.filters ?? true,
    savedFilterViews: featureFlags.savedFilterViews ?? true,
    dataManagement: featureFlags.dataManagement ?? true,
    aiChat: featureFlags.aiChat ?? true,
    grid: featureFlags.grid ?? true,
    chart: featureFlags.chart ?? true,
    kpi: featureFlags.kpi ?? true,
    text: featureFlags.text ?? true,
    filter: featureFlags.filter ?? true,
    pivot: featureFlags.pivot ?? true,
    map: featureFlags.map ?? true,
    kpiSparkline: featureFlags.kpiSparkline ?? true,
    kpiTrend: featureFlags.kpiTrend ?? true,
    kpiTarget: featureFlags.kpiTarget ?? true,
    chartAnnotations: featureFlags.chartAnnotations ?? true,
    gridGroupBy: featureFlags.gridGroupBy ?? true,
    gridSummary: featureFlags.gridSummary ?? true,
    gridConditionalFormats: featureFlags.gridConditionalFormats ?? true,
    calculatedFields: featureFlags.calculatedFields ?? true,
    kpiCalculatedFields: featureFlags.kpiCalculatedFields ?? true,
    chartCalculatedFields: featureFlags.chartCalculatedFields ?? true,
    gridCalculatedFields: featureFlags.gridCalculatedFields ?? true,
  };
}
