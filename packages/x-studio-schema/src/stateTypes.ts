import type {
  StudioMode,
  StudioDrawer,
  StudioFilterOperator,
  StudioCrossFilterMode,
} from './baseTypes';
import type { StudioWidget, StudioPage, StudioPageTheme } from './widgetTypes';
import type { StudioDataSource, StudioDataField, StudioRelationship } from './dataTypes';
import type { StudioExpressionField } from './expressionTypes';
import type { StudioAIState } from './aiTypes';

// `createDefaultStudioState` lives in `./factories` (grouped with the other runtime
// factories). Re-exported here so pre-existing deep imports (`./stateTypes`) keep working.
export { createDefaultStudioState } from './factories';

/**
 * Typed filter scope — a discriminated union that encodes scope and all
 * scope-dependent identifiers in a single field.
 *
 * This is the sole scope descriptor for `StudioFilterState`.
 */
export type StudioFilterScope =
  | { kind: 'page'; pageId?: string }
  | { kind: 'widget'; widgetId: string }
  | { kind: 'cross-filter'; sourceWidgetId: string; pageId: string }
  | { kind: 'interactive'; sourceWidgetId: string; pageId: string }
  /** Replaces isDashboardDateRange: true + filterSourceId. The filter applies only to
   *  widgets whose sourceId matches and runs on the given page. */
  | { kind: 'dashboard-date-range'; sourceId: string; pageId: string };

/**
 * Preset options for the dashboard-level date range bar. Each preset resolves to a
 * concrete start/end window at evaluation time; `'custom'` uses user-supplied dates.
 * - `'this_month'` — first day of the current month through today
 * - `'last_3_months'` — three months ago through today
 * - `'last_12_months'` — twelve months ago through today
 * - `'ytd'` — January 1 of the current year through today
 * - `'this_calendar_year'` — January 1 through December 31 of the current year
 * - `'last_calendar_year'` — the full previous calendar year
 * - `'last_2_calendar_years'` — the two full previous calendar years
 * - `'this_quarter'` — the current calendar quarter
 * - `'last_quarter'` — the previous calendar quarter
 * - `'this_and_last_quarter'` — the current and previous calendar quarters
 * - `'custom'` — user-supplied start/end dates
 */
export type StudioDateRangePreset =
  | 'this_month'
  | 'last_3_months'
  | 'last_12_months'
  | 'ytd'
  | 'this_calendar_year'
  | 'last_calendar_year'
  | 'last_2_calendar_years'
  | 'this_quarter'
  | 'last_quarter'
  | 'this_and_last_quarter'
  | 'custom';

export interface StudioFilterState {
  id: string;
  field: string;
  /** The data type of the field — used for type-aware comparisons and UI */
  fieldType?: StudioDataField['type'];
  /** Determines which input/evaluation mode is used. Defaults to 'condition'. */
  filterMode?: 'condition' | 'selection' | 'rank';
  // condition mode
  operator: StudioFilterOperator;
  value: unknown;
  /** Optional second condition for compound filters (e.g. date ≥ X AND date ≤ Y) */
  conjunction?: 'and' | 'or';
  operator2?: StudioFilterOperator;
  value2?: unknown;
  // rank mode
  rankDirection?: 'top' | 'bottom';
  /** Numeric field to aggregate by when ranking a non-numeric dimension (e.g. rank countries by revenue). */
  rankByField?: string;
  /**
   * Controls how scores are computed when ranking multi-series chart data.
   * - `'__sum'` (default): sum all series values per label
   * - `'__avg'`: average all series values per label
   * - `'__max'`: maximum value across series per label
   * - `'__min'`: minimum value across series per label
   * - `<fieldId>`: rank by the values of the specific series with that fieldId
   */
  rankMultiSeriesBy?: string;
  /**
   * For cross-source widget filters: the data source this filter's field belongs to.
   * When set (and different from the widget's source), the join path is resolved
   * automatically via the declared relationships in StudioState.
   */
  filterSourceId?: string;
  /**
   * The preset that was used to compute the date range when the scope is `dashboard-date-range`.
   * Stored for display purposes so the bar can show the active preset.
   */
  dateRangePreset?: StudioDateRangePreset;
  /**
   * IDs of other page filters that this filter depends on for cascading.
   * When any listed filter has an active (effective) value, this filter's available
   * options are narrowed to only those values that exist in the filtered dataset.
   * Purely a UX hint — does not affect how filters are evaluated against rows.
   */
  dependsOn?: string[];
  /** When `true`, the filter is temporarily inactive without being removed. */
  disabled?: boolean;
  /**
   * Typed scope — a discriminated union that encodes scope and all
   * scope-dependent identifiers in a single, exhaustive field.
   */
  scope: StudioFilterScope;
}

export interface StudioShellState {
  openDrawers: Record<StudioDrawer, boolean>;
  selectedWidgetId: string | null;
  selectedFieldId: string | null;
  selectedSourceId: string | null;
}

export interface StudioDashboardState {
  id: string;
  title: string;
  activePageId: string;
  /** Default theme applied to all pages unless overridden by a page-level theme. */
  defaultTheme?: StudioPageTheme;
  /**
   * Global cross-filter mode override. When set, overrides each widget's own
   * `crossFilterMode` setting for all charts on the dashboard.
   * `null` means "per chart" — each widget uses its own setting.
   */
  globalCrossFilterMode?: StudioCrossFilterMode | null;
  /**
   * When `true`, cross-filters created by clicking a chart are applied to
   * widgets on ALL pages, not just the page where the click occurred.
   */
  crossFilterAllPages?: boolean;
}

export interface StudioFilterPreset {
  id: string;
  name: string;
  /** Snapshot of page-scoped filters at the time of saving. */
  filters: StudioFilterState[];
}

export interface StudioState {
  schemaVersion: 1;
  mode: StudioMode;
  dashboard: StudioDashboardState;
  pages: Record<string, StudioPage>;
  widgets: Record<string, StudioWidget>;
  dataSources: Record<string, StudioDataSource>;
  relationships: StudioRelationship[];
  filters: StudioFilterState[];
  /** User-authored expression fields (calculated columns and measures). Persisted. */
  expressionFields: StudioExpressionField[];
  /** Saved filter presets (named snapshots of page-level filters). */
  filterPresets?: StudioFilterPreset[];
  shell: StudioShellState;
  /**
   * AI assistant conversation state. Persisted alongside the dashboard so
   * conversation history travels with the saved state.
   *
   * When `undefined`, no threads exist yet. The `StudioChatPanel` creates
   * the first thread on the user's first message.
   */
  ai?: StudioAIState;
}
