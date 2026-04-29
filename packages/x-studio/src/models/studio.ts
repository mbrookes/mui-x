import type { FieldCapability } from '../utils/fieldCapabilities';

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

export interface StudioChartSeries {
  fieldId: string;
}

/**
 * A reference to a specific field value within a named row of a data source.
 * Used to make filter values dynamic — driven by a business metric rather than
 * a hardcoded literal.
 *
 * Example: reference BM-012.value (= 6) as the threshold for "months active".
 */
export interface StudioMetricRef {
  /** ID of the data source containing the metric row */
  sourceId: string;
  /** ID of the specific row (e.g. 'BM-012') */
  rowId: string;
  /** Field on that row whose value to use (e.g. 'value') */
  field: string;
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
  /** Granularity to truncate the x-axis date/datetime field before grouping. */
  xGroupBy?: 'day' | 'week' | 'month' | 'quarter' | 'year';
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
  /** 'auto' = recompute from config on every change (default). 'manual' = user-set title. */
  titleMode?: 'auto' | 'manual';
  subtitle?: string;
  /** 'auto' = recompute from config on every change (default). 'manual' = user-set subtitle. */
  subtitleMode?: 'auto' | 'manual';
  sourceId?: string;
  config: StudioWidgetConfig;
}

export interface StudioPageTheme {
  /** Canvas background colour (CSS colour string). Default: theme grey. */
  pageBackground?: string;
  /** Widget card background colour. Default: theme background.paper. */
  cardBackground?: string;
  /** Widget card padding in MUI spacing units (0–4). Default: 2. */
  cardPadding?: number;
  /** Widget card corner radius in px. Default: 4. */
  cardRadius?: number;
  /** Whether widget cards show a border. Default: true. */
  cardBorder?: boolean;
  /** Widget card border colour (CSS colour string). Default: theme divider. */
  cardBorderColor?: string;
  /** Widget card border width in px. Default: 1. */
  cardBorderWidth?: number;
}

export interface StudioPage {
  id: string;
  title: string;
  widgetRows: string[][]; // Each row is an array of widget IDs
  theme?: StudioPageTheme;
}

export interface StudioDataField {
  id: string;
  label: string;
  description?: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'datetime';
  /** When true, the field is hidden from the data drawer and widget config selects */
  hidden?: boolean;
  /** When true, the field value is computed/derived rather than stored directly in source data */
  generated?: boolean;
  /** Display format for number fields */
  format?: StudioNumberFormat;
  /** ISO 4217 currency code for currency format. Defaults to 'USD'. */
  currencyCode?: string;
  /**
   * Override the default type-derived field capabilities.
   * Use sparingly — most fields should rely on type inference.
   * Example: mark a low-cardinality number field as `['categorical']`
   * so it appears in "Split by" pickers instead of numeric y-axis pickers.
   * See `FieldCapability` in `utils/fieldCapabilities` for available values.
   */
  capabilities?: string[];
}

export interface StudioDataSource {
  id: string;
  label: string;
  fields: StudioDataField[];
  rows?: Record<string, unknown>[];
  /** When true, the source is hidden from the data drawer panel and widget config selects */
  hidden?: boolean;
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
