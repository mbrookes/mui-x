import type {
  StudioFilterWidgetType,
  StudioWidgetKind,
  StudioGridSummaryAggregation,
  StudioBarLayout,
  StudioCrossFilterMode,
  StudioKpiAggregation,
  StudioChartType,
} from './baseTypes';

// ── Widget-config building blocks ───────────────────────────────────────────────

/** A visual style applied to cells matching a conditional format rule. */
export interface StudioConditionalFormatStyle {
  backgroundColor?: string;
  color?: string;
  fontWeight?: 'bold' | 'normal';
}

/** A single conditional formatting rule for a grid column. */
export interface StudioConditionalFormat {
  /** The column field this rule applies to. */
  fieldId: string;
  /** Comparison operator. Only single-value operators are supported (no 'between'). */
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
  /** The value to compare against (not used for is_empty / is_not_empty). */
  value?: unknown;
  /** Style to apply to the cell when the rule matches. */
  style: StudioConditionalFormatStyle;
}

/**
 * A column definition for a grid widget.
 *
 * Replaces the previous `string[]` columns format to carry per-column
 * aggregation and (optionally) cross-source metadata.
 */
export interface StudioGridColumn {
  /** Field ID within the source identified by `sourceId` or `widget.sourceId`. */
  fieldId: string;
  /**
   * Source ID for this column. When set and different from `widget.sourceId`,
   * the column's data is pulled from a related source via the declared
   * `StudioRelationship`. Both `many-to-one` and `many-to-many` relationships
   * are supported. For `many-to-one`, the widget's primary source must be the
   * "many" side. For `many-to-many`, the widget source is one of the two endpoint
   * sources; data is fetched through the junction table.
   */
  sourceId?: string;
  /**
   * Aggregation function applied when `gridGroupByField` is active, or when
   * this column references a related source at a coarser grain (fan-out).
   * Falls back to `StudioDataField.defaultAggregationFn` then `'sum'` for
   * numeric fields if absent.
   */
  aggregationFn?: StudioGridSummaryAggregation;
  /** Column header label override (defaults to `StudioDataField.label`). */
  label?: string;
}

export interface StudioChartSeries {
  fieldId: string;
  /** Optional display label for this series in legends and tooltips. */
  label?: string;
  /**
   * Series render type for mixed charts.
   * - `'bar'` (default): renders as a bar/column
   * - `'line'`: renders as a line (with optional markers)
   *
   * Only used when `chartType === 'mixed'`.
   */
  seriesType?: 'bar' | 'line';
  /** Alias for `seriesType` — preferred spelling in config objects. */
  type?: 'bar' | 'line';
  /** Aggregation function applied to this series. @default 'sum' */
  yAggregation?: 'sum' | 'count' | 'avg' | 'min' | 'max';
  /**
   * Optional data source for this series, enabling cross-source blending on a
   * `'mixed'` chart. When set to a source other than the widget's primary
   * `sourceId`, the series is aggregated independently in that source and aligned
   * onto the chart's shared categorical `xField` (which must exist with the same
   * field id in every source used). When omitted, the series reads from the
   * widget's primary source. Only honoured for `chartType === 'mixed'`.
   */
  sourceId?: string;
}

/**
 * A single reference-line annotation drawn on a chart widget.
 */
export interface StudioChartAnnotation {
  id: string;
  /** 'y' = horizontal line at a numeric y-axis value; 'x' = vertical line at an x-axis label value */
  axis: 'y' | 'x';
  /** Numeric value for y-axis lines; for x-axis band-scale charts, a string matching the axis label */
  value: number | string;
  /** Short label shown at the end of the line. Omit for an unlabelled marker. */
  label?: string;
}

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

// ── Per-kind widget configuration ───────────────────────────────────────────────
//
// `StudioWidgetConfig` below is the flat union of every widget kind's config keys
// (all optional, because a widget currently carries keys from other kinds). The
// per-kind interfaces below name each kind's slice so setup panels can reference a
// focused shape; the combined `StudioWidgetConfig` remains structurally identical to
// its historical single-interface form.

/** Grid / table widget configuration. */
export interface StudioGridConfig {
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
  /**
   * Primary key field for write-back mutations.
   *
   * When set together with a data source adapter that implements `submitMutation`,
   * grid cells become editable and changes are persisted to the server via
   * `adapter.submitMutation()`. The PK field itself is always read-only.
   *
   * @example 'id'
   */
  gridPkField?: string;
  /**
   * Aggregation to show in the pinned summary footer for each field.
   * Only fields included in this map will have a summary cell rendered.
   * Numeric-only aggregations (sum, avg, min, max) are ignored for non-number fields.
   */
  gridSummaryFields?: Record<string, StudioGridSummaryAggregation>;
  /** Field used when a row is selected to emit a cross-filter to other widgets. Defaults to the first visible grid column. */
  crossFilterField?: string;
}

/**
 * Chart widget configuration.
 *
 * Covers every chart sub-shape (bar / line / area / mixed / heatmap / gantt /
 * funnel / sankey / pie / donut / scatter / gauge). Sub-shape-specific keys are
 * grouped by prefix; which keys are relevant depends on `chartType`.
 */
export interface StudioChartConfig {
  /** Chart sub-type. Determines which other config keys are relevant. @default 'bar' */
  chartType?: StudioChartType;
  /** Bar orientation. `'horizontal'` — prefer for >5 categories, long labels, or ranking lists. */
  barLayout?: StudioBarLayout;
  /**
   * Maximum characters per line for horizontal bar chart category labels.
   * Long labels are word-wrapped at this width (inserting `\n`).
   * `0` or omitted means no wrapping.
   */
  barBandLabelWrap?: number;
  /**
   * Maximum number of lines for wrapped band labels.
   * @default 2
   */
  wrapBandLabelMaxLines?: number;
  /**
   * Ratio of band width reserved for the gap between categories (0–1).
   * Maps to `categoryGapRatio` on the band axis. Default is 0.2.
   */
  barCategoryGapRatio?: number;
  /**
   * Minimum height (px) per band row for horizontal bar charts.
   * When set, the chart container expands so every row is at least this tall,
   * giving wrapped multi-line labels enough vertical room.
   */
  barMinBandSize?: number;
  /**
   * Maximum number of categories shown in a bar chart.
   * The top N−1 categories by value are shown; remaining values are summed into an "Other" bar.
   */
  barMaxCategories?: number;
  /**
   * Font size in px for axis tick labels across all chart types.
   * When undefined, the chart inherits the default theme font size.
   */
  axisTickFontSize?: number;
  /** X-axis field (categorical or date). For date fields, combine with `xGroupBy`. */
  xField?: string;
  /** Y-axis numeric field for single-series charts. Prefer `ySeries` for multi-series. */
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
   * - 'natural': preserve data insertion order (no explicit sort).
   */
  chartSortBy?: 'category' | 'value' | 'natural';
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
   * Heatmap chart: position of the continuous-colour legend.
   * - `'bottom'` (default) — gradient bar below the chart
   * - `'top'` — gradient bar above the chart
   * - `'left'` — vertical gradient bar to the left
   * - `'right'` — vertical gradient bar to the right
   * - `'hidden'` — legend not rendered
   * @default 'bottom'
   */
  heatLegendPosition?: 'bottom' | 'top' | 'left' | 'right' | 'hidden';
  /** Heatmap chart: alignment of the legend along its cross axis. @default 'center' */
  heatLegendAlign?: 'start' | 'center' | 'end';
  /**
   * Heatmap chart: which axis's labels to sort.
   * - `'x-axis'`: sort column-axis labels alphabetically / numerically.
   * - `'y-axis'`: sort row-axis labels alphabetically / numerically.
   * - `'natural'`: preserve data insertion order (no explicit sort).
   * @default undefined (x-axis sorted ascending, y-axis in insertion order)
   */
  heatSortBy?: 'x-axis' | 'y-axis' | 'natural';
  /** Heatmap chart: sort direction for heatSortBy. @default 'asc' */
  heatSortDirection?: 'asc' | 'desc';
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
  // NOTE: funnelConversionBar, funnelExitStage, exitLabel, exitValue were
  // removed in June 2026 when the custom funnel was replaced with
  // @mui/x-charts-pro FunnelChart. The conversion-bar overlay mode was dropped
  // by design (x-charts-pro renders its own funnel shape). No schema migration
  // is needed — x-studio state is not published.
  /**
   * Funnel chart: explicit category order for funnel stages.
   * Stages are displayed in the given order (top to bottom); any stages not
   * listed appear at the end sorted by value descending.
   * When omitted the funnel is sorted by value descending (widest first).
   */
  funnelCategoryOrder?: string[];
  /**
   * Funnel chart: opt into **cumulative "reached stage"** counts. When set, the
   * funnel counts deals whose numeric reached-depth (this field) is at or beyond
   * each stage, which is monotonically non-increasing by construction (never
   * > 100%). The snapshot count (`stage === label`) is kept for a
   * "currently in stage: N" tooltip. When omitted, the funnel uses the legacy
   * per-stage snapshot aggregation.
   */
  funnelReachedField?: string;
  /**
   * Funnel chart: the ordered sequential stage labels for the cumulative mode
   * (must exclude any terminal exit stage such as `Closed Lost`). Required
   * together with `funnelReachedField`.
   */
  funnelStageSequence?: string[];
  /**
   * Funnel chart: how section labels display their values.
   * - `'value'`: the raw aggregated value (default)
   * - `'percent'`: each section as a percentage of the total
   * - `'conversion'`: each section as a percentage of the largest section —
   *   equivalent to the old conversion-bar overlay
   * @default 'value'
   */
  funnelLabelFormat?: 'value' | 'percent' | 'conversion';
  /**
   * Funnel chart: where section labels are placed.
   * - `'inside'`: label inside the section body (default)
   * - `'outside-start'`: for vertical layout — to the left
   * - `'outside-end'`: for vertical layout — to the right; recommended with `'conversion'`
   * @default 'inside'
   */
  funnelLabelPlacement?: 'inside' | 'outside-start' | 'outside-end';
  /**
   * Funnel chart: gap in pixels between funnel sections.
   * @default 0
   */
  funnelGap?: number;
  /**
   * Funnel chart: shape/curve interpolation style for the sections.
   * @default 'linear'
   */
  funnelCurve?: 'linear' | 'bump' | 'step' | 'pyramid';
  /**
   * Funnel chart: visual style for sections.
   * `'outlined'` uses a border with translucent fill; `'filled'` uses a solid fill.
   * @default 'filled'
   */
  funnelVariant?: 'filled' | 'outlined';
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
  /**
   * Pie/donut chart: maximum number of slices to show before grouping the remainder
   * into an "Other" slice. @default undefined (no grouping)
   */
  pieMaxSlices?: number;
  /**
   * Pie/donut chart: place the legend below the chart and render percentages alongside
   * labels. When false (default) the built-in MUI X Charts legend is used, which
   * appears to the right of the chart.
   * @default false
   */
  pieLegendBelow?: boolean;
  /** Minimum value for gauge chart. @default 0 */
  gaugeMin?: number;
  /** Maximum value for gauge chart. @default 100 */
  gaugeMax?: number;
  /**
   * How this chart widget responds to incoming cross-filters from other widgets.
   * See {@link StudioCrossFilterMode} for details.
   * @default 'cross-highlight'
   */
  crossFilterMode?: StudioCrossFilterMode;
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
}

/** KPI widget configuration (headline metric + optional sparkline & trend badge). */
export interface StudioKpiConfig {
  /** Field whose values are aggregated to produce the headline metric. */
  kpiValueField?: string;
  /** Aggregation applied to `kpiValueField`. @default 'sum' */
  kpiAggregation?: StudioKpiAggregation;
  /** When true, formats the headline value in compact notation (e.g. 1.2M instead of 1,200,000). */
  kpiCompact?: boolean;
  /** String prepended to the formatted headline value (e.g. `'$'`). */
  kpiPrefix?: string;
  /** String appended to the formatted headline value (e.g. `'%'`). */
  kpiSuffix?: string;
  // KPI sparkline
  /** When true, renders a small chart below the headline value. */
  kpiSparkline?: boolean;
  /** Time/date field to group rows by for the sparkline. Auto-detected from date filters if omitted. */
  kpiSparklineField?: string;
  /** Source ID for the sparkline time field — only needed when field is from a related source. */
  kpiSparklineSourceId?: string;
  /** Visual style of the sparkline. @default 'line' */
  kpiSparklinePlotType?: 'line' | 'bar' | 'gauge';
  /** When true, fills the area under a line sparkline. */
  kpiSparklineArea?: boolean;
  /** Time bucket for grouping rows in the sparkline. Auto-detected from date filters when omitted. */
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
  /**
   * When set, the trend is computed over a fixed rolling window ending today rather than
   * the active date filter. The headline value is unaffected (all-time total). Requires a
   * date field in the source — auto-detected from `kpiSparklineField` when set.
   * - 'month': last 30 days vs. the 30 days before
   * - 'quarter': last 90 days vs. the 90 days before
   * - 'year': last 365 days vs. the 365 days before
   */
  kpiTrendFixedPeriod?: 'month' | 'quarter' | 'year';
  /** Maximum value for the gauge sparkline. Used as the arc end when kpiSparklinePlotType is 'gauge'. @default 100 */
  kpiSparklineGaugeMax?: number;
}

/** Text / markdown widget configuration, including per-section typography overrides. */
export interface StudioTextConfig {
  /** Markdown content for a text/markdown widget (alternative to textBody for raw markdown). */
  textContent?: string;
  /** Subtitle text (HTML string). Rendered between the title and body. */
  textSubtitle?: string;
  /** Body text (HTML string). Rendered below the subtitle. */
  textBody?: string;
  /** When true, textBody is treated as a prompt sent to the AI to generate the widget content. */
  textAiEnabled?: boolean;
  // Text formatting — undefined means "use the default" and is never persisted
  /**
   * Font family for the title section. The keywords `serif` / `monospace` / `sans-serif`
   * map to curated stacks; any other value is used as a literal CSS font-family (e.g.
   * `'Fraunces, "Inter Tight", serif'`). undefined = theme default.
   */
  textTitleFontFamily?: 'serif' | 'monospace' | 'sans-serif' | (string & {});
  /** Font size in px for the title section. undefined = variant default (~20px). */
  textTitleFontSize?: number;
  /** Font weight for the title section (e.g. 300, 400, 600). undefined = variant default. */
  textTitleFontWeight?: number;
  /** CSS colour for the title section. undefined = theme text.primary. */
  textTitleColor?: string;
  /** Text alignment for the title section. undefined = left. */
  textTitleAlign?: 'left' | 'center' | 'right';
  /** Font family for the subtitle section. Named keywords or a literal CSS font-family. undefined = theme default. */
  textSubtitleFontFamily?: 'serif' | 'monospace' | 'sans-serif' | (string & {});
  /** Font size in px for the subtitle section. undefined = variant default (~16px). */
  textSubtitleFontSize?: number;
  /** CSS colour for the subtitle section. undefined = theme text.secondary. */
  textSubtitleColor?: string;
  /** Text alignment for the subtitle section. undefined = left. */
  textSubtitleAlign?: 'left' | 'center' | 'right';
  /** Font family for the body section. Named keywords or a literal CSS font-family. undefined = theme default. */
  textBodyFontFamily?: 'serif' | 'monospace' | 'sans-serif' | (string & {});
  /** Font size in px for the body section. undefined = variant default (~14px). */
  textBodyFontSize?: number;
  /** CSS colour for the body section. undefined = theme text.primary. */
  textBodyColor?: string;
  /** Text alignment for the body section. undefined = left. */
  textBodyAlign?: 'left' | 'center' | 'right';
}

/** Interactive filter widget configuration. */
export interface StudioFilterWidgetConfig {
  /** The type of filter control to render. */
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
}

/** Pivot table widget configuration. */
export interface StudioPivotConfig {
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
}

/** Choropleth map widget configuration. */
export interface StudioMapConfig {
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
  mapLegendAlign?: 'start' | 'center' | 'end';
}

/** Config keys shared across widget kinds (card chrome, custom-widget config). */
export interface StudioSharedWidgetConfig {
  /** Font size in px for the card header title, applied to all widget kinds. undefined = h6 default (~20px). */
  titleFontSize?: number;
  /** Override title shown in the expand dialog. Falls back to widget.title when unset. */
  cardExpandTitle?: string;
  /** Numeric fields to aggregate (used by some custom widgets). */
  measures?: string[];
  /** Categorical / grouping fields (used by some custom widgets). */
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

/**
 * Flat configuration bag for a `StudioWidget`.
 *
 * Composed from the per-kind config interfaces above. Every kind's keys remain
 * optional (via `Partial<...>`) because a widget can carry keys authored while it
 * was a different kind. The shape is structurally identical to the historical
 * single-interface `StudioWidgetConfig`; the split exists only so setup panels can
 * reference a focused per-kind shape.
 */
export interface StudioWidgetConfig
  extends
    StudioSharedWidgetConfig,
    Partial<StudioGridConfig>,
    Partial<StudioChartConfig>,
    Partial<StudioKpiConfig>,
    Partial<StudioTextConfig>,
    Partial<StudioFilterWidgetConfig>,
    Partial<StudioPivotConfig>,
    Partial<StudioMapConfig> {}

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
