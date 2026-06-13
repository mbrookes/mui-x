import type {
  StudioFilterWidgetType,
  StudioWidgetKind,
  StudioGridColumn,
  StudioGridSummaryAggregation,
  StudioChartSeries,
  StudioMetricRef,
  StudioChartAnnotation,
  StudioBarLayout,
  StudioCrossFilterMode,
  StudioKpiAggregation,
  StudioChartType,
  StudioConditionalFormat,
} from './baseTypes';

// ── Forecast ──────────────────────────────────────────────────────────────────

/**
 * Forecast/trend overlay configuration for chart widgets.
 *
 * When `enabled` is `true`, the chart extends the x-axis by `periods` steps and
 * overlays a dashed trend line computed from the historical series data.
 * Optionally, a semi-transparent confidence band (±1 standard error of regression)
 * is drawn around the trend line.
 *
 * Only applied to `chartType: 'line' | 'area'` widgets with a single y-field.
 */
export interface StudioWidgetForecast {
  /** Whether the forecast overlay is active. @default false */
  enabled: boolean;
  /**
   * Number of future periods to project beyond the last data point.
   * @default 3
   */
  periods?: number;
  /**
   * Regression method.
   * - `'linear'` — ordinary least squares linear regression (default, only supported value)
   * @default 'linear'
   */
  method?: 'linear';
  /**
   * When `true`, renders a shaded band around the trend line representing
   * ±1 standard error of the regression residuals.
   * @default false
   */
  showConfidenceBands?: boolean;
}

export interface StudioWidgetConfig {
  // Grid config
  /** Ordered list of visible columns. Use `normalizeGridColumn()` when reading persisted state. */
  columns?: StudioGridColumn[];
  /** Optional field used to group raw rows into one aggregated grid row per unique value. */
  gridGroupByField?: string;
  /** Per-column aggregations applied when gridGroupByField is set. */
  gridAggregations?: Record<string, StudioGridSummaryAggregation>;
  /** Default sort field for the grid. */
  gridSortField?: string;
  /** Default sort direction for the grid. @default 'asc' */
  gridSortDirection?: 'asc' | 'desc';
  /** Height of the grid in pixels. @default 400 */
  gridHeight?: number;
  /** Conditional formatting rules applied to grid cells. */
  gridConditionalFormats?: StudioConditionalFormat[];
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
  /**
   * How to sort chart x-axis categories.
   * - 'category': sort labels alphabetically / numerically (default).
   * - 'value': sort by the aggregated y-value.
   */
  chartSortBy?: 'category' | 'value';
  /** Sort direction for chartSortBy. @default 'asc' */
  chartSortDirection?: 'asc' | 'desc';
  /** Scatter chart: categorical field used to split points into colour-coded series. */
  scatterColorField?: string;
  /**
   * Scatter chart: numeric field to use as per-point bubble size.
   * When set, renders as a bubble chart with variable marker radii (sqrt-scaled).
   */
  scatterSizeField?: string;
  /** Bubble chart: minimum marker radius in pixels. @default 4 */
  scatterMinRadius?: number;
  /** Bubble chart: maximum marker radius in pixels. @default 40 */
  scatterMaxRadius?: number;
  /**
   * Mixed chart (bar + line): when `true`, bar series use the left Y axis and line series
   * use an independent right Y axis. Useful when bar and line series have different scales
   * (e.g. revenue bars vs. margin-% line).
   * @default false
   */
  dualYAxis?: boolean;
  /**
   * Heatmap chart: the field used as the row (Y) axis. `xField` is the column axis,
   * `yField` is the colour-intensity value.
   */
  heatYField?: string;
  /**
   * Heatmap chart: colour scheme for the intensity scale.
   * @default 'primary'
   */
  heatColorScheme?: 'primary' | 'success' | 'warning' | 'error';
  /**
   * Gantt / timeline chart: field providing the row label (Y axis).
   */
  ganttLabelField?: string;
  /**
   * Gantt / timeline chart: date or datetime field marking the start of each bar.
   */
  ganttStartField?: string;
  /**
   * Gantt / timeline chart: date or datetime field marking the end of each bar.
   */
  ganttEndField?: string;
  /**
   * Gantt / timeline chart: optional categorical field used to colour-code bars.
   */
  ganttColorField?: string;
  /**
   * Funnel chart: explicit category order for funnel stages.
   * Stages are displayed in the given order (top to bottom); any stages not
   * listed appear at the end sorted by value descending.
   * When omitted the funnel is sorted by value descending (widest first).
   */
  funnelCategoryOrder?: string[];
  /**
   * Sankey chart: target ("to") node field. The source ("from") node uses `xField`
   * and the link weight uses `yField`. Links are summed per unique source→target pair.
   */
  sankeyTargetField?: string;
  /**
   * Sankey chart: where each link draws its colour from.
   * - 'source': colour links by their source node (default)
   * - 'target': colour links by their target node
   * @default 'source'
   */
  sankeyLinkColor?: 'source' | 'target';
  /**
   * Sankey chart: render the aggregated value as a label on each link.
   * @default false
   */
  sankeyShowValues?: boolean;
  /**
   * Pie/donut chart: label shown on each arc.
   * - 'value': the formatted numeric value
   * - 'percent': percentage of the total (per ring for multi-ring charts)
   * - 'none': no arc labels (default)
   */
  pieArcLabel?: 'value' | 'percent' | 'none';
  /**
   * Pie/donut chart: minimum arc angle in degrees required to show an arc label.
   * Slices smaller than this will not be labelled. @default 20
   */
  pieArcLabelMinAngle?: number;
  /** Minimum value for gauge chart. @default 0 */
  gaugeMin?: number;
  /** Maximum value for gauge chart. @default 100 */
  gaugeMax?: number;
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
  kpiSparklinePlotType?: 'line' | 'bar' | 'gauge';
  kpiSparklineArea?: boolean;
  kpiSparklineGranularity?: 'day' | 'week' | 'month' | 'quarter' | 'year';
  /** When true, the sparkline shows a cumulative running total instead of per-period values. */
  kpiSparklineCumulative?: boolean;
  /** Minimum value for the gauge sparkline. @default 0 */
  kpiSparklineGaugeMin?: number;
  /** Maximum value for the gauge sparkline. The KPI headline value is plotted against this cap. */
  kpiSparklineGaugeMax?: number;
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
  // KPI target line
  /** When true, shows a horizontal reference line on the sparkline and (when kpiTrend is also enabled) compares the headline value against the target instead of the previous period. */
  kpiTarget?: boolean;
  /** Reference to the metric row/field that provides the target value. */
  kpiTargetRef?: StudioMetricRef;
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
  /** Markdown content for a text/markdown widget (alternative to textBody for raw markdown). */
  textContent?: string;
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
  /** Minimum value for slider filter widgets */
  filterWidgetMin?: number;
  /** Maximum value for slider filter widgets */
  filterWidgetMax?: number;
  /** Step increment for slider filter widgets */
  filterWidgetStep?: number;
  // Pivot table config
  /** Field used as row groups (vertical axis of the pivot table). */
  pivotRowField?: string;
  /** Field used as column headers (horizontal axis of the pivot table). */
  pivotColField?: string;
  /**
   * Numeric field to aggregate into each cell.
   * Optional when `pivotAggregation` is `'count'` (which counts rows, not values).
   */
  pivotValueField?: string;
  /**
   * Aggregation function applied to `pivotValueField` per (row, column) cell.
   * @default 'sum'
   */
  pivotAggregation?: 'sum' | 'avg' | 'count' | 'min' | 'max';
  /** When true, a Totals row and Totals column are shown. @default true */
  pivotShowTotals?: boolean;
  // Chart annotations
  /**
   * Reference lines drawn on chart widgets.
   * Each annotation renders as a horizontal (`axis: 'y'`) or vertical (`axis: 'x'`) line.
   * Not supported for pie / donut / gauge chart types.
   */
  annotations?: StudioChartAnnotation[];
  /**
   * Forecast/trend configuration for line and area charts.
   * When enabled, a linear extrapolation is rendered beyond the last data point
   * as a dashed line, optionally with a shaded confidence band.
   * Only supported for `chartType: 'line' | 'area'` with a single y-field.
   */
  forecast?: StudioWidgetForecast;
  // Map / choropleth widget config
  /**
   * Field providing the country identifier (ISO alpha-2, alpha-3, or full English name).
   * Rows are grouped by this field before applying mapAggregation.
   */
  mapCountryField?: string;
  /** Source ID for mapCountryField — required when the field comes from a related source. */
  mapCountrySourceId?: string;
  /** Numeric field to aggregate per country. Required unless mapAggregation is 'count'. */
  mapValueField?: string;
  /** Source ID for mapValueField — required when the field comes from a related source. */
  mapValueSourceId?: string;
  /** Aggregation applied to mapValueField per country group. @default 'sum' */
  mapAggregation?: 'sum' | 'count' | 'avg' | 'min' | 'max';
  /**
   * Which built-in map to render, or a custom key registered via the `geographies` prop.
   * - `'world'`  → world countries (ISO alpha-2 feature IDs, e.g. `'US'`, `'FR'`)
   * - `'usa'`    → US states (2-letter postal abbreviations, e.g. `'CA'`, `'TX'`)
   * - `'europe'` → European countries subset (ISO alpha-2 feature IDs)
   * @default 'world'
   */
  mapGeography?: 'world' | 'usa' | 'europe' | (string & {});
  /**
   * Sequential colour ramp applied to the value scale.
   * @default 'blues'
   */
  mapColorScheme?: 'blues' | 'reds' | 'greens' | 'oranges' | 'purples';
  /**
   * When `true`, the colour scale minimum is clamped to `0` instead of the
   * lowest data value. Useful when the lowest value is non-zero but you want
   * the colour ramp to communicate magnitude relative to zero.
   * @default false
   */
  mapLegendZeroMin?: boolean;
  /**
   * When `true`, clicking a map region emits a cross-filter on `mapCountryField`
   * that other widgets can respond to. Clicking the same region again clears
   * the filter.
   * @default false
   */
  mapCrossFilterEmit?: boolean;
  /**
   * Position of the continuous-colour legend on the map widget.
   * - `'bottom'` (default) — gradient bar below the map
   * - `'top'` — gradient bar above the map
   * - `'left'` — vertical gradient bar to the left
   * - `'right'` — vertical gradient bar to the right
   * - `'hidden'` — legend not rendered
   * @default 'bottom'
   */
  mapLegendPosition?: 'bottom' | 'top' | 'left' | 'right' | 'hidden';
  // Shared
  measures?: string[];
  dimensions?: string[];

  // ── Custom widget configuration ────────────────────────────────────────────

  /**
   * Arbitrary JSON-serializable configuration for consumer-defined custom widget kinds.
   * Built-in widget kinds never write to this field.
   * Must be plain JSON (no functions, class instances, Date objects, etc.) to survive
   * state serialization/deserialization.
   */
  customConfig?: Record<string, unknown>;
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
  /**
   * Canvas width (in px) below which all widgets stack to full width in view mode.
   * When set, overrides the global `stackBreakpoint` prop on `Studio`.
   * Set to `0` to disable responsive stacking for this page.
   */
  stackBreakpoint?: number;
}
