import type { FieldCapability } from '../utils/fieldCapabilities';

export type StudioMode = 'edit' | 'view';

export type StudioDrawer = 'data' | 'compose' | 'filters';

export type StudioWidgetKind = 'grid' | 'chart' | 'kpi' | 'text' | 'filter';

export type StudioFilterWidgetType = 'date-range' | 'multi-select' | 'toggle' | 'slider';

/**
 * Controls how a chart widget responds to incoming cross-filters from other widgets.
 * - `'cross-highlight'` (default): shows the full dataset as a faded ghost behind the
 *   filtered subset — communicates proportion ("what share does this selection represent?").
 * - `'cross-filter'`: redraws the chart using only the filtered rows — focuses on the subset
 *   and lets axes rescale to the filtered data.
 * - `'none'`: ignores all cross-filters and always shows the full unfiltered dataset.
 */
export type StudioCrossFilterMode = 'cross-highlight' | 'cross-filter' | 'none';

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

export type StudioBarLayout = 'grouped' | 'stacked' | 'horizontal';

export type StudioNumberFormat = 'integer' | 'decimal' | 'percent' | 'currency';

export type StudioKpiAggregation = 'sum' | 'avg' | 'count' | 'min' | 'max';

/** Aggregation function to show in the grid summary (totals) row. */
export type StudioGridSummaryAggregation = 'sum' | 'avg' | 'count' | 'min' | 'max';

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
  /** Optional field used to group raw rows into one aggregated grid row per unique value. */
  gridGroupByField?: string;
  /** Per-column aggregations applied when gridGroupByField is set. */
  gridAggregations?: Record<string, StudioGridSummaryAggregation>;
  /** Default sort field for the grid. */
  gridSortField?: string;
  /** Default sort direction for the grid. @default 'asc' */
  gridSortDirection?: 'asc' | 'desc';
  // Chart config
  chartType?: StudioChartType;
  barLayout?: StudioBarLayout;
  xField?: string;
  yField?: string;
  /** How to aggregate the y-axis values. Defaults to 'sum'. Use 'count' when yField is a string field. */
  yAggregation?: 'sum' | 'count' | 'avg' | 'min' | 'max';
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
  // KPI trend indicator
  /** When true, shows a period-over-period percentage change badge below the headline value. */
  kpiTrend?: boolean;
  /**
   * How to determine the comparison (previous) period.
   * - 'previous-period': shift the current window back by its own duration (default)
   * - 'previous-calendar-period': previous calendar month / quarter / year
   * - 'year-over-year': same window shifted back exactly one year
   */
  kpiTrendComparison?: 'previous-period' | 'previous-calendar-period' | 'year-over-year';
  /**
   * When true, reverses the colour coding so that an increase shows as red and a
   * decrease shows as green. Use for cost, error-rate, or other "lower is better" metrics.
   */
  kpiTrendInvert?: boolean;
  // Grid summary (totals) row
  /**
   * Aggregation to show in the pinned summary footer for each field.
   * Only fields included in this map will have a summary cell rendered.
   * Numeric-only aggregations (sum, avg, min, max) are ignored for non-number fields.
   */
  gridSummaryFields?: Record<string, StudioGridSummaryAggregation>;
  // Grid cross-filter
  /** Field used when a row is selected to emit a cross-filter to other widgets. Defaults to the first visible grid column. */
  crossFilterField?: string;
  /**
   * How this chart widget responds to incoming cross-filters from other widgets.
   * See {@link StudioCrossFilterMode} for details.
   * @default 'cross-highlight'
   */
  crossFilterMode?: StudioCrossFilterMode;
  // Text config
  textSubtitle?: string;
  textBody?: string;
  // Text formatting — undefined means "use the default" and is never persisted
  /** Font family for the title section. undefined = theme default. */
  textTitleFontFamily?: 'serif' | 'monospace';
  /** Font size in px for the title section. undefined = variant default (~20px). */
  textTitleFontSize?: number;
  /** CSS colour for the title section. undefined = theme text.primary. */
  textTitleColor?: string;
  /** Text alignment for the title section. undefined = left. */
  textTitleAlign?: 'left' | 'center' | 'right';
  /** Font family for the subtitle section. undefined = theme default. */
  textSubtitleFontFamily?: 'serif' | 'monospace';
  /** Font size in px for the subtitle section. undefined = variant default (~16px). */
  textSubtitleFontSize?: number;
  /** CSS colour for the subtitle section. undefined = theme text.secondary. */
  textSubtitleColor?: string;
  /** Text alignment for the subtitle section. undefined = left. */
  textSubtitleAlign?: 'left' | 'center' | 'right';
  /** Font family for the body section. undefined = theme default. */
  textBodyFontFamily?: 'serif' | 'monospace';
  /** Font size in px for the body section. undefined = variant default (~14px). */
  textBodyFontSize?: number;
  /** CSS colour for the body section. undefined = theme text.primary. */
  textBodyColor?: string;
  /** Text alignment for the body section. undefined = left. */
  textBodyAlign?: 'left' | 'center' | 'right';
  // Filter widget config
  filterWidgetType?: StudioFilterWidgetType;
  /** Field ID to filter on */
  filterWidgetField?: string;
  /** Source ID for the filter field — only needed when the field belongs to a related source */
  filterWidgetSourceId?: string;
  /** Optional label override shown above the control */
  filterWidgetLabel?: string;
  /** Minimum value for slider filter widgets */
  filterWidgetMin?: number;
  /** Maximum value for slider filter widgets */
  filterWidgetMax?: number;
  /** Step increment for slider filter widgets */
  filterWidgetStep?: number;
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
  /**
   * Per-widget explicit column span (3–12).
   * Widgets absent from this map take equal shares of the remaining space (`flex: 1`).
   * The total columns in a row do not need to sum to 12 — any remainder is left as
   * whitespace when all widgets in the row have explicit spans.
   */
  widgetColSpans?: Record<string, number>;
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
  capabilities?: FieldCapability[];
}

// Filter tree node for QueryDescriptor
export type StudioFilterNode =
  | {
      type: 'leaf';
      field: string;
      op: StudioFilterOperator;
      value: unknown;
      value2?: unknown;
      conjunction?: 'and' | 'or';
      op2?: StudioFilterOperator;
      fieldType?: StudioDataField['type'];
      filterSourceId?: string;
    }
  | { type: 'group'; logic: 'and' | 'or'; children: StudioFilterNode[] };

// Result returned by a data source adapter
export interface StudioQueryResult {
  rows: Record<string, unknown>[];
  totalCount?: number;
  isTruncated?: boolean;
}

// The query descriptor emitted by Studio for a widget
export interface StudioQueryDescriptor {
  sourceId: string;
  widgetId: string;
  /** Field IDs needed for this widget */
  select: string[];
  /** Recursive filter tree built from all active filters for this widget */
  filter?: StudioFilterNode;
  /** For chart/KPI: the x-axis grouping field */
  groupBy?: string;
  /** For chart/KPI: aggregation functions to apply server-side */
  aggregations?: {
    field: string;
    fn: 'sum' | 'avg' | 'count' | 'min' | 'max' | 'count_distinct';
    alias: string;
  }[];
  /** Time-series bucketing granularity */
  xGroupBy?: 'day' | 'week' | 'month' | 'quarter' | 'year';
  /**
   * Stable hash of all other fields. Use as a cache key.
   * The package computes this; the developer need not hash the descriptor.
   */
  cacheKey: string;
}

// Async data source adapter — developer implements this
export interface StudioDataSourceAdapter {
  /**
   * Called when the query descriptor for this source changes.
   * Return pre-aggregated rows when descriptor.aggregations is set,
   * or raw filtered rows otherwise.
   */
  getRows(descriptor: StudioQueryDescriptor): Promise<StudioQueryResult>;
}

export interface StudioDataSource {
  id: string;
  label: string;
  fields: StudioDataField[];
  rows?: Record<string, unknown>[];
  /** When true, the source is hidden from the data drawer panel and widget config selects */
  hidden?: boolean;
  /**
   * Pre-computed sorted distinct string values per native string/boolean field.
   * Built automatically by `normalizeDataSourceRows` at ingestion time.
   * Used by filter widgets to avoid an O(N) scan on every render.
   * Not persisted — derived from `rows` and rebuilt when rows change.
   */
  fieldDistinctValues?: Record<string, string[]>;
  /**
   * Optional async adapter. When set, Studio will call adapter.getRows()
   * whenever the query descriptor changes, instead of using rows directly.
   * rows can be omitted when adapter is provided.
   */
  adapter?: StudioDataSourceAdapter;
}

// ─── Expression field types ───────────────────────────────────────────────────

export type StudioExpressionOperator =
  | 'add'
  | 'subtract'
  | 'multiply'
  | 'divide'
  | 'modulo'
  | 'equals'
  | 'notEqual'
  | 'lessThan'
  | 'greaterThan'
  | 'lessThanOrEqual'
  | 'greaterThanOrEqual'
  | 'and'
  | 'or'
  | 'not'
  | 'negate'
  | 'if'
  | 'in'
  | 'isTrue'
  | 'isFalse'
  | 'isNull'
  | 'isNotNull'
  | 'datediff';

/** A function/operator node with one or more input sub-expressions. */
export interface StudioFunctionExpression {
  operator: StudioExpressionOperator;
  inputs: StudioExpression[];
}

/** A literal constant value. */
export interface StudioValueExpression {
  type: 'number' | 'string' | 'boolean';
  value: string | number | boolean | null;
}

/** A reference to a physical or expression field, with optional aggregation. */
export interface StudioFieldExpression {
  id: string;
  /** Aggregation to apply when this field is used as a measure input. */
  aggregation?: StudioKpiAggregation;
}

/**
 * A reference to a field on a related (joined) record, resolved at evaluation
 * time via the declared source relationships.
 *
 * Example: pull `country` from the customers source for each order row.
 */
export interface StudioJoinFieldExpression {
  joinSourceId: string;
  fieldId: string;
}

export type StudioExpression =
  | StudioFunctionExpression
  | StudioValueExpression
  | StudioFieldExpression
  | StudioJoinFieldExpression;

/** A user-defined computed field derived from an expression tree. */
export interface StudioExpressionField {
  id: string;
  label: string;
  description?: string;
  /** The data source this expression field computes over. */
  sourceId: string;
  /**
   * When true, this is a Measure: a single aggregate value over the full (filtered) dataset.
   * When false (default), this is a Calculated Column: a per-row scalar value.
   */
  isMeasure: boolean;
  expression: StudioExpression;
  /**
   * Output type override. Inferred from the expression tree if omitted.
   * Arithmetic operators infer 'number'; comparison/logical infer 'boolean'.
   */
  type?: StudioDataField['type'];
  /** Display format for numeric expression fields. */
  format?: StudioNumberFormat;
  /** ISO 4217 currency code for currency format. Defaults to 'USD'. */
  currencyCode?: string;
  /** When true, the expression field is hidden from pickers. */
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
