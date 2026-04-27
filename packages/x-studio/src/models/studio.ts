export type StudioMode = 'edit' | 'view';

export type StudioDrawer = 'data' | 'compose' | 'filters';

export type StudioWidgetKind = 'grid' | 'chart' | 'kpi' | 'text';

export type StudioChartType =
  | 'bar'
  | 'bar-stacked'
  | 'bar-100'
  | 'line'
  | 'area'
  | 'area-stacked'
  | 'area-100'
  | 'pie'
  | 'donut'
  | 'scatter'
  // Legacy aliases kept for backwards compatibility
  | 'bar-grouped';

export type StudioBarLayout = 'grouped' | 'stacked';

export type StudioNumberFormat = 'integer' | 'decimal' | 'percent' | 'currency';

export type StudioKpiAggregation = 'sum' | 'avg' | 'count' | 'min' | 'max';

export type StudioFilterOperator =
  | 'equals'
  | 'in'
  | 'not_equals'
  | 'contains'
  | 'does_not_contain'
  | 'starts_with'
  | 'not_starts_with'
  | 'ends_with'
  | 'not_ends_with'
  | 'is_empty'
  | 'is_not_empty'
  | 'greater_than'
  | 'less_than'
  | 'greater_than_or_equal'
  | 'less_than_or_equal'
  | 'between';

export interface StudioFieldBinding {
  field: string;
  label?: string;
}

export interface StudioChartSeries {
  fieldId: string;
}

export interface StudioWidgetConfig {
  // Grid config
  columns?: string[];
  // Chart config
  chartType?: StudioChartType;
  barLayout?: StudioBarLayout;
  xField?: string;
  yField?: string;
  /** Multiple Y-axis series (preferred over yField when present) */
  ySeries?: StudioChartSeries[];
  /** Secondary Y field for grouped/stacked charts or scatter Y axis */
  yField2?: string;
  /** Group/series field for grouped or stacked bar charts */
  seriesField?: string;
  // KPI config
  kpiValueField?: string;
  kpiAggregation?: StudioKpiAggregation;
  kpiCompact?: boolean;
  kpiPrefix?: string;
  kpiSuffix?: string;
  // KPI sparkline
  kpiSparkline?: boolean;
  /** Time/date field to group rows by for the sparkline. Auto-detected from date filters if omitted. */
  kpiSparklineField?: string;
  /** Source ID for the sparkline time field — only needed when field is from a related source. */
  kpiSparklineSourceId?: string;
  kpiSparklinePlotType?: 'line' | 'bar';
  kpiSparklineArea?: boolean;
  kpiSparklineGranularity?: 'day' | 'week' | 'month' | 'quarter' | 'year';
  /** When true, the sparkline shows a cumulative running total instead of per-period values. */
  kpiSparklineCumulative?: boolean;
  // Grid cross-filter
  /** Field used when a row is selected to emit a cross-filter to other widgets. Defaults to first string field. */
  crossFilterField?: string;
  // Text config
  textSubtitle?: string;
  textBody?: string;
  // Shared
  measures?: string[];
  dimensions?: string[];
}

export interface StudioWidget {
  id: string;
  kind: StudioWidgetKind;
  title: string;
  sourceId?: string;
  bindings: StudioFieldBinding[];
  config: StudioWidgetConfig;
}

export interface StudioPage {
  id: string;
  title: string;
  widgetRows: string[][]; // Each row is an array of widget IDs
}

export interface StudioDataField {
  id: string;
  label: string;
  description?: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'datetime';
  /** When true, the field is hidden from the data drawer and widget config selects */
  hidden?: boolean;
  /** Display format for number fields */
  format?: StudioNumberFormat;
  /** ISO 4217 currency code for currency format. Defaults to 'USD'. */
  currencyCode?: string;
}

export interface StudioDataSource {
  id: string;
  label: string;
  fields: StudioDataField[];
  rows?: Record<string, unknown>[];
}

export interface StudioRelationship {
  id: string;
  /** The "many" side source ID (e.g. orders) */
  sourceId: string;
  /** The FK field in sourceId (e.g. 'customerId') */
  sourceField: string;
  /** The "one" side source ID (e.g. customers) */
  targetId: string;
  /** The PK field in targetId (e.g. 'id') */
  targetField: string;
  type: 'many-to-one' | 'one-to-one';
}

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
  scope: 'page' | 'widget' | 'cross-filter';
  widgetId?: string;
  /** For cross-filters: the widget ID that originated the filter */
  sourceWidgetId?: string;
  /**
   * For cross-source widget filters: the data source this filter's field belongs to.
   * When set (and different from the widget's source), the join path is resolved
   * automatically via the declared relationships in StudioState.
   */
  filterSourceId?: string;
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
  };
}
