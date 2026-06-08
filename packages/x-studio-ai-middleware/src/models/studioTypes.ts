/**
 * Local copy of the MUI X Studio data model types used by this package.
 *
 * These types are structurally equivalent to (and kept in sync with) the types
 * exported by `@mui/x-studio`. TypeScript structural typing ensures that values
 * produced by `@mui/x-studio` are assignable to these types at the app boundary.
 *
 * Note: React-specific fields (icon, component, setupPanel) are omitted from
 * `StudioCustomWidgetDef` — the server only needs the serializable metadata.
 */

// ── Primitives / shared ───────────────────────────────────────────────────────

export type StudioMode = 'edit' | 'view';
export type StudioDrawer = 'data' | 'compose' | 'filters';

export type BuiltinStudioWidgetKind =
  | 'grid'
  | 'chart'
  | 'kpi'
  | 'text'
  | 'filter'
  | 'pivot'
  | 'map';

/** All widget kinds: built-in plus any consumer-defined custom kind. */
export type StudioWidgetKind = BuiltinStudioWidgetKind | (string & {});

export type StudioFilterWidgetType = 'date-range' | 'multi-select' | 'toggle' | 'slider';

export type StudioChartType =
  | 'bar'
  | 'bar-stacked'
  | 'bar-100'
  | 'line'
  | 'area'
  | 'area-stacked'
  | 'area-100'
  | 'mixed'
  | 'heatmap'
  | 'funnel'
  | 'gantt'
  | 'pie'
  | 'donut'
  | 'scatter'
  | 'gauge';

export type StudioBarLayout = 'grouped' | 'stacked' | 'horizontal';
export type StudioNumberFormat = 'integer' | 'decimal' | 'percent' | 'currency';
export type StudioKpiAggregation = 'sum' | 'avg' | 'count' | 'min' | 'max' | 'count_distinct';
export type StudioGridSummaryAggregation = 'sum' | 'avg' | 'count' | 'min' | 'max' | 'count_distinct';
export type StudioCrossFilterMode = 'cross-highlight' | 'cross-filter' | 'none';

export type StudioFilterOperator =
  | 'equals'
  | 'not_equals'
  | 'in'
  | 'not_in'
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
  seriesType?: 'bar' | 'line';
}

export interface StudioMetricRef {
  sourceId: string;
  rowId: string;
  field: string;
}

export interface StudioChartAnnotation {
  id: string;
  axis: 'y' | 'x';
  value: number | string;
  label?: string;
}

export interface StudioConditionalFormatStyle {
  backgroundColor?: string;
  color?: string;
  fontWeight?: 'bold' | 'normal';
}

export interface StudioConditionalFormat {
  fieldId: string;
  operator:
    | 'equals'
    | 'not_equals'
    | 'greater_than'
    | 'less_than'
    | 'greater_than_or_equal'
    | 'less_than_or_equal'
    | 'contains'
    | 'is_empty'
    | 'is_not_empty';
  value?: unknown;
  style: StudioConditionalFormatStyle;
}

export interface StudioGridColumn {
  fieldId: string;
  sourceId?: string;
  aggregationFn?: StudioGridSummaryAggregation;
  label?: string;
}

// ── Data types ────────────────────────────────────────────────────────────────

/** Named field capabilities (server-side, no React). */
export type FieldCapability = 'numeric' | 'categorical' | 'temporal' | 'rankTarget';

export interface StudioDataField {
  id: string;
  label: string;
  description?: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'datetime';
  hidden?: boolean;
  generated?: boolean;
  format?: StudioNumberFormat;
  precision?: number;
  currencyCode?: string;
  capabilities?: FieldCapability[];
  defaultAggregationFn?: StudioGridSummaryAggregation;
  aiDescription?: string;
  aiAggregation?: 'sum' | 'avg' | 'min' | 'max';
}

export interface StudioDataSource {
  id: string;
  label: string;
  fields: StudioDataField[];
  rows?: Record<string, unknown>[];
  hidden?: boolean;
  fieldDistinctValues?: Record<string, string[]>;
  aiDescription?: string;
  // adapter omitted — server-side code never calls getRows()
}

// ── Expression types ──────────────────────────────────────────────────────────

export type StudioExpressionOperator =
  | 'add' | 'subtract' | 'multiply' | 'divide' | 'modulo'
  | 'equals' | 'notEqual' | 'lessThan' | 'greaterThan'
  | 'lessThanOrEqual' | 'greaterThanOrEqual'
  | 'and' | 'or' | 'not' | 'negate' | 'if' | 'in'
  | 'isTrue' | 'isFalse' | 'isNull' | 'isNotNull' | 'datediff';

export interface StudioFunctionExpression {
  operator: StudioExpressionOperator;
  inputs: StudioExpression[];
}
export interface StudioValueExpression {
  type: 'number' | 'string' | 'boolean';
  value: string | number | boolean | null;
}
export interface StudioFieldExpression {
  id: string;
  aggregation?: StudioKpiAggregation;
}
export interface StudioJoinFieldExpression {
  joinSourceId: string;
  fieldId: string;
}
export type StudioExpression =
  | StudioFunctionExpression
  | StudioValueExpression
  | StudioFieldExpression
  | StudioJoinFieldExpression;

export interface StudioExpressionField {
  id: string;
  label: string;
  description?: string;
  sourceId: string;
  isMeasure: boolean;
  expression: StudioExpression;
  type?: StudioDataField['type'];
  format?: StudioNumberFormat;
  precision?: number;
  currencyCode?: string;
  hidden?: boolean;
}

export interface StudioRelationship {
  id: string;
  sourceId: string;
  sourceField: string;
  targetId: string;
  targetField: string;
  type: 'many-to-one' | 'one-to-one' | 'many-to-many';
  junctionSourceId?: string;
  junctionSourceField?: string;
  junctionTargetField?: string;
  predefined?: boolean;
}

// ── Widget types ──────────────────────────────────────────────────────────────

export interface StudioWidgetConfig {
  // Grid
  columns?: StudioGridColumn[];
  gridGroupByField?: string;
  gridAggregations?: Record<string, StudioGridSummaryAggregation>;
  gridSortField?: string;
  gridSortDirection?: 'asc' | 'desc';
  gridHeight?: number;
  gridConditionalFormats?: StudioConditionalFormat[];
  gridSummaryFields?: Record<string, StudioGridSummaryAggregation>;
  crossFilterField?: string;
  crossFilterMode?: StudioCrossFilterMode;
  // Chart
  chartType?: StudioChartType;
  barLayout?: StudioBarLayout;
  xField?: string;
  yField?: string;
  yAggregation?: 'sum' | 'count' | 'avg' | 'min' | 'max';
  ySeries?: StudioChartSeries[];
  yField2?: string;
  seriesField?: string;
  xGroupBy?: 'day' | 'week' | 'month' | 'quarter' | 'year';
  chartSortBy?: 'category' | 'value';
  chartSortDirection?: 'asc' | 'desc';
  scatterColorField?: string;
  scatterSizeField?: string;
  scatterMinRadius?: number;
  scatterMaxRadius?: number;
  dualYAxis?: boolean;
  heatYField?: string;
  heatColorScheme?: 'primary' | 'success' | 'warning' | 'error';
  ganttLabelField?: string;
  ganttStartField?: string;
  ganttEndField?: string;
  ganttColorField?: string;
  pieArcLabel?: 'value' | 'percent' | 'none';
  pieArcLabelMinAngle?: number;
  gaugeMin?: number;
  gaugeMax?: number;
  annotations?: StudioChartAnnotation[];
  // KPI
  kpiValueField?: string;
  kpiAggregation?: StudioKpiAggregation;
  kpiCompact?: boolean;
  kpiPrefix?: string;
  kpiSuffix?: string;
  kpiSparkline?: boolean;
  kpiSparklineField?: string;
  kpiSparklineSourceId?: string;
  kpiSparklinePlotType?: 'line' | 'bar' | 'gauge';
  kpiSparklineArea?: boolean;
  kpiSparklineGranularity?: 'day' | 'week' | 'month' | 'quarter' | 'year';
  kpiSparklineCumulative?: boolean;
  kpiSparklineGaugeMin?: number;
  kpiSparklineGaugeMax?: number;
  kpiTrend?: boolean;
  kpiTrendComparison?: 'previous-period' | 'previous-calendar-period' | 'year-over-year';
  kpiTrendInvert?: boolean;
  kpiTarget?: boolean;
  kpiTargetRef?: StudioMetricRef;
  // Text
  textSubtitle?: string;
  textBody?: string;
  textTitleFontFamily?: 'serif' | 'monospace';
  textTitleFontSize?: number;
  textTitleColor?: string;
  textTitleAlign?: 'left' | 'center' | 'right';
  textSubtitleFontFamily?: 'serif' | 'monospace';
  textSubtitleFontSize?: number;
  textSubtitleColor?: string;
  textSubtitleAlign?: 'left' | 'center' | 'right';
  textBodyFontFamily?: 'serif' | 'monospace';
  textBodyFontSize?: number;
  textBodyColor?: string;
  textBodyAlign?: 'left' | 'center' | 'right';
  // Filter widget
  filterWidgetType?: StudioFilterWidgetType;
  filterWidgetField?: string;
  filterWidgetSourceId?: string;
  filterWidgetMin?: number;
  filterWidgetMax?: number;
  filterWidgetStep?: number;
  // Pivot
  pivotRowField?: string;
  pivotColField?: string;
  pivotValueField?: string;
  pivotAggregation?: 'sum' | 'avg' | 'count' | 'min' | 'max';
  pivotShowTotals?: boolean;
  // Map
  mapCountryField?: string;
  mapCountrySourceId?: string;
  mapValueField?: string;
  mapValueSourceId?: string;
  mapAggregation?: 'sum' | 'count' | 'avg' | 'min' | 'max';
  mapGeography?: 'world' | 'usa' | 'europe' | (string & {});
  mapColorScheme?: 'blues' | 'reds' | 'greens' | 'oranges' | 'purples';
  mapLegendZeroMin?: boolean;
  mapCrossFilterEmit?: boolean;
  mapLegendPosition?: 'bottom' | 'top' | 'left' | 'right' | 'hidden';
  // Shared
  measures?: string[];
  dimensions?: string[];
  customConfig?: Record<string, unknown>;
}

export interface StudioWidget {
  id: string;
  kind: StudioWidgetKind;
  title: string;
  titleMode?: 'auto' | 'manual';
  subtitle?: string;
  subtitleMode?: 'auto' | 'manual';
  sourceId?: string;
  config: StudioWidgetConfig;
}

export interface StudioPageTheme {
  pageBackground?: string;
  cardBackground?: string;
  cardPadding?: number;
  cardRadius?: number;
  cardBorder?: boolean;
  cardBorderColor?: string;
  cardBorderWidth?: number;
}

export interface StudioPage {
  id: string;
  title: string;
  widgetRows: string[][];
  widgetColSpans?: Record<string, number>;
  theme?: StudioPageTheme;
  stackBreakpoint?: number;
}

// ── State types ───────────────────────────────────────────────────────────────

export type StudioDateRangePreset =
  | 'this_month'
  | 'last_3_months'
  | 'last_12_months'
  | 'ytd'
  | 'custom';

export interface StudioFilterState {
  id: string;
  field: string;
  fieldType?: StudioDataField['type'];
  filterMode?: 'condition' | 'selection' | 'rank';
  operator: StudioFilterOperator;
  value: unknown;
  valueRef?: StudioMetricRef;
  conjunction?: 'and' | 'or';
  operator2?: StudioFilterOperator;
  value2?: unknown;
  value2Ref?: StudioMetricRef;
  rankDirection?: 'top' | 'bottom';
  rankByField?: string;
  rankMultiSeriesBy?: string;
  scope: 'page' | 'widget' | 'cross-filter' | 'interactive';
  widgetId?: string;
  sourceWidgetId?: string;
  pageId?: string;
  filterSourceId?: string;
  isDashboardDateRange?: true;
  dateRangePreset?: StudioDateRangePreset;
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
  defaultTheme?: StudioPageTheme;
}

export interface StudioFilterPreset {
  id: string;
  name: string;
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
  expressionFields: StudioExpressionField[];
  filterPresets?: StudioFilterPreset[];
  shell: StudioShellState;
}

// ── Custom widget def (server subset — React fields omitted) ─────────────────

/**
 * Server-side subset of `StudioCustomWidgetDef`.
 * The React `component`, `setupPanel`, and `icon` fields are omitted — the server
 * only needs the serializable metadata to build the AI system prompt.
 */
export interface StudioCustomWidgetDef {
  kind: string;
  label: string;
  description?: string;
  requiresDataSource?: boolean;
  aiInsight?: boolean;
  defaultConfig?: Record<string, unknown>;
}

// ── Test helper ───────────────────────────────────────────────────────────────

const defaultPageId = 'page-1';

/** Creates a default `StudioState` for use in tests and middleware defaults. */
export function createDefaultStudioState(overrides?: Partial<StudioState>): StudioState {
  const baseState: StudioState = {
    schemaVersion: 1,
    mode: 'edit',
    dashboard: { id: 'dashboard-1', title: 'Untitled Dashboard', activePageId: defaultPageId },
    pages: { [defaultPageId]: { id: defaultPageId, title: 'Page 1', widgetRows: [] } },
    widgets: {},
    dataSources: {},
    relationships: [],
    filters: [],
    expressionFields: [],
    shell: {
      openDrawers: { data: true, compose: true, filters: false },
      selectedWidgetId: null,
      selectedFieldId: null,
      selectedSourceId: null,
    },
  };
  return {
    ...baseState,
    ...overrides,
    dashboard: { ...baseState.dashboard, ...overrides?.dashboard },
    shell: {
      ...baseState.shell,
      ...overrides?.shell,
      openDrawers: { ...baseState.shell.openDrawers, ...overrides?.shell?.openDrawers },
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


/**
 * Creates a default `StudioWidget` for the given kind, with sensible empty config.
 * Used by `executeToolOnState` when the `add_widget` tool is called without a full config.
 */
export function createDefaultWidget(
  kind: StudioWidgetKind,
  overrides?: { title?: string; customConfig?: Record<string, unknown> },
): StudioWidget {
  const id = `widget-${kind}-${Date.now()}`;

  if (kind === 'text') {
    return { id, kind, title: overrides?.title ?? 'Text block', config: { textSubtitle: '', textBody: '' } };
  }
  if (kind === 'grid') {
    return { id, kind, title: overrides?.title ?? '', config: { columns: [] } };
  }
  if (kind === 'chart') {
    return { id, kind, title: overrides?.title ?? '', config: { chartType: 'bar' } };
  }
  if (kind === 'filter') {
    return { id, kind, title: overrides?.title ?? 'Filter', config: { filterWidgetType: 'multi-select' as const } };
  }
  if (kind === 'pivot') {
    return { id, kind, title: overrides?.title ?? '', config: { pivotAggregation: 'sum' as const } };
  }
  if (kind === 'map') {
    return { id, kind, title: overrides?.title ?? '', config: { mapAggregation: 'sum' as const } };
  }
  if (!['grid', 'chart', 'kpi', 'text', 'filter', 'pivot', 'map'].includes(kind)) {
    return { id, kind, title: overrides?.title ?? kind, config: { customConfig: overrides?.customConfig ?? {} } };
  }
  // KPI
  return { id, kind, title: overrides?.title ?? '', config: { kpiAggregation: 'sum' } };
}
