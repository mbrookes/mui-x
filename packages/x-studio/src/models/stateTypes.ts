import type {
  StudioMode,
  StudioDrawer,
  StudioFilterWidgetType,
  StudioFilterOperator,
  StudioMetricRef,
} from './baseTypes';
import type { StudioWidget, StudioPage, StudioPageTheme } from './widgetTypes';
import type { StudioDataSource, StudioDataField } from './dataTypes';
import type { StudioExpressionField, StudioRelationship } from './expressionTypes';

export type StudioDateRangePreset = 'this_month' | 'last_3_months' | 'last_12_months' | 'ytd' | 'custom';

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
  /** When set, overrides `value` with a live lookup from a metric data source. */
  valueRef?: StudioMetricRef;
  /** Optional second condition for compound filters (e.g. date ≥ X AND date ≤ Y) */
  conjunction?: 'and' | 'or';
  operator2?: StudioFilterOperator;
  value2?: unknown;
  /** When set, overrides `value2` with a live lookup from a metric data source. */
  value2Ref?: StudioMetricRef;
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
  scope: 'page' | 'widget' | 'cross-filter' | 'interactive';
  widgetId?: string;
  /** For cross-filters: the widget ID that originated the filter */
  sourceWidgetId?: string;
  /** For cross-filters: the page on which the filter was applied */
  pageId?: string;
  /**
   * For cross-source widget filters: the data source this filter's field belongs to.
   * When set (and different from the widget's source), the join path is resolved
   * automatically via the declared relationships in StudioState.
   */
  filterSourceId?: string;
  /**
   * When `true`, this filter was created by the dashboard date-range bar and is
   * managed exclusively by that component — it is hidden from the filters drawer
   * and quick-filter bar.
   */
  isDashboardDateRange?: true;
  /**
   * The preset that was used to compute the date range when `isDashboardDateRange` is true.
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
