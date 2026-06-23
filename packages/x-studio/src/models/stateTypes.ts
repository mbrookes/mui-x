import type { StudioMode, StudioDrawer, StudioFilterOperator } from './baseTypes';
import type { StudioWidget, StudioPage, StudioPageTheme } from './widgetTypes';
import type { StudioDataSource, StudioDataField } from './dataTypes';
import type { StudioExpressionField, StudioRelationship } from './expressionTypes';
import type { StudioAIState } from './aiTypes';

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
  scopeV2: StudioFilterScope;
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

const defaultPageId = 'page-1';

export function createDefaultStudioState(overrides?: Partial<StudioState>): StudioState {
  const baseState: StudioState = {
    schemaVersion: 1,
    mode: 'edit',
    dashboard: {
      id: 'dashboard-1',
      title: 'Untitled Dashboard',
      activePageId: defaultPageId,
    },
    pages: {
      [defaultPageId]: {
        id: defaultPageId,
        title: 'Page 1',
        widgetRows: [], // No widgets by default
      },
    },
    widgets: {},
    dataSources: {},
    relationships: [],
    filters: [],
    expressionFields: [],
    shell: {
      openDrawers: {
        data: true,
        compose: true,
        filters: false,
      },
      selectedWidgetId: null,
      selectedFieldId: null,
      selectedSourceId: null,
    },
  };

  return {
    ...baseState,
    ...overrides,
    dashboard: {
      ...baseState.dashboard,
      ...overrides?.dashboard,
    },
    shell: {
      ...baseState.shell,
      ...overrides?.shell,
      openDrawers: {
        ...baseState.shell.openDrawers,
        ...overrides?.shell?.openDrawers,
      },
      selectedFieldId: overrides?.shell?.selectedFieldId ?? null,
      selectedSourceId: overrides?.shell?.selectedSourceId ?? null,
    },
    pages: overrides?.pages ?? baseState.pages,
    widgets: overrides?.widgets ?? baseState.widgets,
    dataSources: overrides?.dataSources ?? baseState.dataSources,
    relationships: overrides?.relationships ?? baseState.relationships,
    filters: overrides?.filters ?? baseState.filters,
    expressionFields: overrides?.expressionFields ?? baseState.expressionFields,
  };
}
