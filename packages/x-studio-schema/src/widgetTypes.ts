import type {
  StudioFilterWidgetType,
  StudioWidgetKind,
  BuiltinStudioWidgetKind,
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
   * Series render type for mixed charts (canonical spelling).
   * - `'bar'` (default): renders as a bar/column
   * - `'line'`: renders as a line (with optional markers)
   *
   * Only used when `chartType === 'mixed'`. `normalizeChartSeries` rewrites the
   * deprecated `seriesType` alias onto this field on read/write, so consumers can
   * always read `type` alone; when both are present `type` wins.
   */
  type?: 'bar' | 'line';
  /**
   * @deprecated Use {@link type} instead. Legacy alias for the render type;
   * normalized to `type` by `normalizeChartSeries` on every load and live write.
   */
  seriesType?: 'bar' | 'line';
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

// ── Chart widget configuration ──────────────────────────────────────────────────
//
// Unlike the flat `StudioChartConfig` below (kept as the generic/patch type),
// `StudioChartWidgetConfig` is a genuine discriminated union over `chartType`.
// `StudioChartType` is a CLOSED union — there is no consumer-extensible custom
// chart type (per AGENTS.md, custom charts are custom WIDGETS, never new chart
// types) — so a bare `config.chartType === 'gauge'` check narrows natively, no
// runtime guard required at each `===` site. The per-family interfaces group the
// keys each chart sub-shape actually reads (verified against `chartTypeDefs.tsx`
// and `chartTypeRegistry.ts`), so e.g. a `gauge` config can no longer statically
// carry `sankeyTargetField`.

/**
 * Keys shared by EVERY chart sub-shape, regardless of `chartType`.
 *
 * `crossFilterMode` used to live here, but it is read by every widget kind's
 * runtime (not chart-only), so it now lives on {@link StudioSharedWidgetConfig}.
 * This interface is retained as the chart-family base (currently empty) so the
 * family interfaces and `StudioChartConfig` keep a stable common ancestor.
 */
export interface StudioChartConfigBase {}

/**
 * Category/value sort keys shared by the cartesian families that support axis
 * sorting (bar, line/area, mixed). Funnel supports `chartSortBy` only (no
 * direction) and declares it directly; heatmap uses its own `heatSortBy`/
 * `heatSortDirection` pair instead.
 */
export interface StudioChartSortConfig {
  /**
   * How to sort chart x-axis categories.
   * - 'category': sort labels alphabetically / numerically (default).
   * - 'value': sort by the aggregated y-value.
   * - 'natural': preserve data insertion order (no explicit sort).
   */
  chartSortBy?: 'category' | 'value' | 'natural';
  /** Sort direction for chartSortBy. @default 'asc' */
  chartSortDirection?: 'asc' | 'desc';
}

/**
 * Bar family (`bar` / `bar-stacked` / `bar-100`) — all three rendered by
 * `renderBar` in `chartTypeDefs.tsx`.
 *
 * The discriminant is OPTIONAL on this family only: an absent `chartType` means
 * `'bar'` (encoding the runtime default `config.chartType ?? 'bar'`), which makes
 * the empty config `{}` a valid bar config — relied on by the
 * `chart-type-picker-empty` screenshot seed.
 */
export interface StudioBarFamilyChartConfig extends StudioChartConfigBase, StudioChartSortConfig {
  /** Chart sub-type. Absent means `'bar'`. @default 'bar' */
  chartType?: 'bar' | 'bar-stacked' | 'bar-100';
  /** X-axis field (categorical or date). For date fields, combine with `xGroupBy`. */
  xField?: string;
  /** Y-axis numeric field for single-series charts. Prefer `ySeries` for multi-series. */
  yField?: string;
  /** How to aggregate the y-axis values. Defaults to 'sum'. Use 'count' when yField is a string field. */
  yAggregation?: 'sum' | 'count' | 'avg' | 'min' | 'max';
  /** Multiple Y-axis series (preferred over yField when present) */
  ySeries?: StudioChartSeries[];
  /** Secondary Y field for grouped/stacked charts */
  yField2?: string;
  /** Group/series field for grouped or stacked bar charts */
  seriesField?: string;
  /** Granularity to truncate the x-axis date/datetime field before grouping. */
  xGroupBy?: 'day' | 'week' | 'month' | 'quarter' | 'year';
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
   * Font size in px for axis tick labels.
   * When undefined, the chart inherits the default theme font size.
   */
  axisTickFontSize?: number;
  /**
   * Reference lines drawn on the chart.
   * Each annotation renders as a horizontal (`axis: 'y'`) or vertical (`axis: 'x'`) line.
   */
  annotations?: StudioChartAnnotation[];
}

/**
 * Line/area family (`line` / `area` / `area-stacked` / `area-100`) — all four
 * rendered by `renderLineArea` in `chartTypeDefs.tsx`. This is the ONLY family
 * that supports `forecast`.
 */
export interface StudioLineAreaFamilyChartConfig
  extends StudioChartConfigBase, StudioChartSortConfig {
  /** Chart sub-type. */
  chartType: 'line' | 'area' | 'area-stacked' | 'area-100';
  /** X-axis field (categorical or date). For date fields, combine with `xGroupBy`. */
  xField?: string;
  /** Y-axis numeric field for single-series charts. Prefer `ySeries` for multi-series. */
  yField?: string;
  /** How to aggregate the y-axis values. Defaults to 'sum'. Use 'count' when yField is a string field. */
  yAggregation?: 'sum' | 'count' | 'avg' | 'min' | 'max';
  /** Multiple Y-axis series (preferred over yField when present) */
  ySeries?: StudioChartSeries[];
  /** Secondary Y field for grouped/stacked charts */
  yField2?: string;
  /** Group/series field for grouped or stacked charts */
  seriesField?: string;
  /** Granularity to truncate the x-axis date/datetime field before grouping. */
  xGroupBy?: 'day' | 'week' | 'month' | 'quarter' | 'year';
  /**
   * Font size in px for axis tick labels.
   * When undefined, the chart inherits the default theme font size.
   */
  axisTickFontSize?: number;
  /**
   * Reference lines drawn on the chart.
   * Each annotation renders as a horizontal (`axis: 'y'`) or vertical (`axis: 'x'`) line.
   */
  annotations?: StudioChartAnnotation[];
  /**
   * Forecast/trend configuration for line and area charts.
   * When enabled, a linear extrapolation is rendered beyond the last data point
   * as a dashed line, optionally with a shaded confidence band.
   * Only supported with a single y-field.
   */
  forecast?: StudioWidgetForecast;
}

/** Mixed (bar + line) chart — rendered by `renderMixed`. Supports a dual Y axis. */
export interface StudioMixedChartConfig extends StudioChartConfigBase, StudioChartSortConfig {
  /** Chart sub-type. */
  chartType: 'mixed';
  /** X-axis field (categorical or date). For date fields, combine with `xGroupBy`. */
  xField?: string;
  /** Y-axis numeric field for single-series charts. Prefer `ySeries` for multi-series. */
  yField?: string;
  /** How to aggregate the y-axis values. Defaults to 'sum'. Use 'count' when yField is a string field. */
  yAggregation?: 'sum' | 'count' | 'avg' | 'min' | 'max';
  /** Multiple Y-axis series (preferred over yField when present) */
  ySeries?: StudioChartSeries[];
  /** Secondary Y field for grouped/stacked charts */
  yField2?: string;
  /** Group/series field for grouped or stacked charts */
  seriesField?: string;
  /** Granularity to truncate the x-axis date/datetime field before grouping. */
  xGroupBy?: 'day' | 'week' | 'month' | 'quarter' | 'year';
  /**
   * Mixed chart (bar + line): when `true`, bar series use the left Y axis and line series
   * use an independent right Y axis. Useful when bar and line series have different scales
   * (e.g. revenue bars vs. margin-% line).
   * @default false
   */
  dualYAxis?: boolean;
  /**
   * Font size in px for axis tick labels.
   * When undefined, the chart inherits the default theme font size.
   */
  axisTickFontSize?: number;
  /**
   * Reference lines drawn on the chart.
   * Each annotation renders as a horizontal (`axis: 'y'`) or vertical (`axis: 'x'`) line.
   */
  annotations?: StudioChartAnnotation[];
}

/** Heatmap chart — rendered by `renderHeatmap`. */
export interface StudioHeatmapChartConfig extends StudioChartConfigBase {
  /** Chart sub-type. */
  chartType: 'heatmap';
  /** Column (X) axis field. */
  xField?: string;
  /**
   * The field used as the row (Y) axis. `xField` is the column axis,
   * `yField` / `ySeries[0]` is the colour-intensity value.
   */
  heatYField?: string;
  /** Colour-intensity value field (single). Prefer over `ySeries`. */
  yField?: string;
  /** Colour-intensity value series; `ySeries[0].fieldId` is used as the value field fallback. */
  ySeries?: StudioChartSeries[];
  /** How to aggregate the colour-intensity value. @default 'sum' */
  yAggregation?: 'sum' | 'count' | 'avg' | 'min' | 'max';
  /** Granularity to truncate the x-axis date/datetime field before grouping. */
  xGroupBy?: 'day' | 'week' | 'month' | 'quarter' | 'year';
  /**
   * Colour scheme for the intensity scale.
   * @default 'primary'
   */
  heatColorScheme?: 'primary' | 'success' | 'warning' | 'error';
  /**
   * Position of the continuous-colour legend.
   * - `'bottom'` (default) — gradient bar below the chart
   * - `'top'` — gradient bar above the chart
   * - `'left'` — vertical gradient bar to the left
   * - `'right'` — vertical gradient bar to the right
   * - `'hidden'` — legend not rendered
   * @default 'bottom'
   */
  heatLegendPosition?: 'bottom' | 'top' | 'left' | 'right' | 'hidden';
  /** Alignment of the legend along its cross axis. @default 'center' */
  heatLegendAlign?: 'start' | 'center' | 'end';
  /**
   * Which axis's labels to sort.
   * - `'x-axis'`: sort column-axis labels alphabetically / numerically.
   * - `'y-axis'`: sort row-axis labels alphabetically / numerically.
   * - `'natural'`: preserve data insertion order (no explicit sort).
   * @default undefined (x-axis sorted ascending, y-axis in insertion order)
   */
  heatSortBy?: 'x-axis' | 'y-axis' | 'natural';
  /** Sort direction for heatSortBy. @default 'asc' */
  heatSortDirection?: 'asc' | 'desc';
  /**
   * Font size in px for axis tick labels.
   * When undefined, the chart inherits the default theme font size.
   */
  axisTickFontSize?: number;
}

/** Funnel chart — rendered by `renderFunnel`. */
export interface StudioFunnelChartConfig extends StudioChartConfigBase {
  /** Chart sub-type. */
  chartType: 'funnel';
  /** Stage (category) field. */
  xField?: string;
  /** Value field (single). Prefer over `ySeries`. */
  yField?: string;
  /** Value series; `ySeries[0].fieldId` is used as the value field fallback. */
  ySeries?: StudioChartSeries[];
  /** How to aggregate the funnel stage value. Defaults to 'sum'. */
  yAggregation?: 'sum' | 'count' | 'avg' | 'min' | 'max';
  /**
   * How to sort funnel stages (category / value / natural). Funnel has no sort
   * DIRECTION — `buildFunnelStages` reads only `chartSortBy`.
   */
  chartSortBy?: 'category' | 'value' | 'natural';
  // NOTE: funnelConversionBar, funnelExitStage, exitLabel, exitValue were
  // removed in June 2026 when the custom funnel was replaced with
  // @mui/x-charts-pro FunnelChart. The conversion-bar overlay mode was dropped
  // by design (x-charts-pro renders its own funnel shape). No schema migration
  // is needed — x-studio state is not published.
  /**
   * Explicit category order for funnel stages.
   * Stages are displayed in the given order (top to bottom); any stages not
   * listed appear at the end sorted by value descending.
   * When omitted the funnel is sorted by value descending (widest first).
   */
  funnelCategoryOrder?: string[];
  /**
   * Opt into **cumulative "reached stage"** counts. When set, the
   * funnel counts deals whose numeric reached-depth (this field) is at or beyond
   * each stage, which is monotonically non-increasing by construction (never
   * > 100%). The snapshot count (`stage === label`) is kept for a
   * "currently in stage: N" tooltip. When omitted, the funnel uses the legacy
   * per-stage snapshot aggregation.
   */
  funnelReachedField?: string;
  /**
   * The ordered sequential stage labels for the cumulative mode
   * (must exclude any terminal exit stage such as `Closed Lost`). Required
   * together with `funnelReachedField`.
   */
  funnelStageSequence?: string[];
  /**
   * How section labels display their values.
   * - `'value'`: the raw aggregated value (default)
   * - `'percent'`: each section as a percentage of the total
   * - `'conversion'`: each section as a percentage of the largest section —
   *   equivalent to the old conversion-bar overlay
   * @default 'value'
   */
  funnelLabelFormat?: 'value' | 'percent' | 'conversion';
  /**
   * Where section labels are placed.
   * - `'inside'`: label inside the section body (default)
   * - `'outside-start'`: for vertical layout — to the left
   * - `'outside-end'`: for vertical layout — to the right; recommended with `'conversion'`
   * @default 'inside'
   */
  funnelLabelPlacement?: 'inside' | 'outside-start' | 'outside-end';
  /**
   * Gap in pixels between funnel sections.
   * @default 0
   */
  funnelGap?: number;
  /**
   * Shape/curve interpolation style for the sections.
   * @default 'linear'
   */
  funnelCurve?: 'linear' | 'bump' | 'step' | 'pyramid';
  /**
   * Visual style for sections.
   * `'outlined'` uses a border with translucent fill; `'filled'` uses a solid fill.
   * @default 'filled'
   */
  funnelVariant?: 'filled' | 'outlined';
}

/** Gantt / timeline chart — rendered by `renderGantt`. Uses no cartesian fields. */
export interface StudioGanttChartConfig extends StudioChartConfigBase {
  /** Chart sub-type. */
  chartType: 'gantt';
  /** Field providing the row label (Y axis). */
  ganttLabelField?: string;
  /** Date or datetime field marking the start of each bar. */
  ganttStartField?: string;
  /** Date or datetime field marking the end of each bar. */
  ganttEndField?: string;
  /** Optional categorical field used to colour-code bars. */
  ganttColorField?: string;
}

/** Sankey diagram — rendered by `renderSankey`. */
export interface StudioSankeyChartConfig extends StudioChartConfigBase {
  /** Chart sub-type. */
  chartType: 'sankey';
  /** Source ("from") node field. */
  xField?: string;
  /** Link weight value field (single). Prefer over `ySeries`. */
  yField?: string;
  /** Link weight value series; `ySeries[0].fieldId` is used as the value field fallback. */
  ySeries?: StudioChartSeries[];
  /**
   * Target ("to") node field. The source ("from") node uses `xField`
   * and the link weight uses `yField`. Links are summed per unique source→target pair.
   */
  sankeyTargetField?: string;
  /**
   * Where each link draws its colour from.
   * - 'source': colour links by their source node (default)
   * - 'target': colour links by their target node
   * @default 'source'
   */
  sankeyLinkColor?: 'source' | 'target';
  /**
   * Render the aggregated value as a label on each link.
   * @default false
   */
  sankeyShowValues?: boolean;
}

/**
 * Pie/donut family (`pie` / `donut`) — both rendered by `renderPieDonut`.
 *
 * Extends `StudioChartSortConfig` and carries `xGroupBy` because the sort and
 * date-group-by keys are read one layer ABOVE `renderPieDonut`, in the shared
 * `useChartWidgetData` aggregation that builds the pie/donut `chartData` — the
 * compose drawer's Sort and Group-by controls write them for pie/donut too.
 */
export interface StudioPieFamilyChartConfig extends StudioChartConfigBase, StudioChartSortConfig {
  /** Chart sub-type. */
  chartType: 'pie' | 'donut';
  /** Slice (category) field. */
  xField?: string;
  /** Value field (single). Prefer over `ySeries`. */
  yField?: string;
  /**
   * How to aggregate the slice values. Defaults to 'sum'; the compose drawer sets
   * this to `'count'` for a field-less pie/donut (a per-category row tally).
   */
  yAggregation?: 'sum' | 'count' | 'avg' | 'min' | 'max';
  /** Value series (preferred over yField when present). */
  ySeries?: StudioChartSeries[];
  /** Group/series field used to split into multiple concentric rings. */
  seriesField?: string;
  /**
   * Granularity to truncate a date/datetime slice field (`xField`) before grouping.
   * Read by the shared `useChartWidgetData` aggregation that feeds `renderPieDonut`.
   */
  xGroupBy?: 'day' | 'week' | 'month' | 'quarter' | 'year';
  /**
   * Label shown on each arc.
   * - 'value': the formatted numeric value
   * - 'percent': percentage of the total (per ring for multi-ring charts)
   * - 'none': no arc labels (default)
   */
  pieArcLabel?: 'value' | 'percent' | 'none';
  /**
   * Minimum arc angle in degrees required to show an arc label.
   * Slices smaller than this will not be labelled. @default 20
   */
  pieArcLabelMinAngle?: number;
  /**
   * Maximum number of slices to show before grouping the remainder
   * into an "Other" slice. @default undefined (no grouping)
   */
  pieMaxSlices?: number;
  /**
   * Place the legend below the chart and render percentages alongside
   * labels. When false (default) the built-in MUI X Charts legend is used, which
   * appears to the right of the chart.
   * @default false
   */
  pieLegendBelow?: boolean;
}

/** Scatter / bubble chart — rendered by `renderScatter`. Renders RAW rows (no aggregation). */
export interface StudioScatterChartConfig extends StudioChartConfigBase {
  /** Chart sub-type. */
  chartType: 'scatter';
  /** X-axis numeric field. */
  xField?: string;
  /** Y-axis numeric field. */
  yField?: string;
  /**
   * Y-field series mirror. The scatter setup panel writes `yField` and a
   * single-entry `ySeries` together; auto-title derivation reads `ySeries[0]`.
   */
  ySeries?: StudioChartSeries[];
  /** Secondary Y field for the scatter Y axis. */
  yField2?: string;
  /** Categorical field used to split points into colour-coded series. */
  scatterColorField?: string;
  /**
   * Numeric field to use as per-point bubble size.
   * When set, renders as a bubble chart with variable marker radii (sqrt-scaled).
   */
  scatterSizeField?: string;
  /** Bubble chart: minimum marker radius in pixels. @default 4 */
  scatterMinRadius?: number;
  /** Bubble chart: maximum marker radius in pixels. @default 40 */
  scatterMaxRadius?: number;
  /**
   * Font size in px for axis tick labels.
   * When undefined, the chart inherits the default theme font size.
   */
  axisTickFontSize?: number;
  /**
   * Reference lines drawn on the chart.
   * Each annotation renders as a horizontal (`axis: 'y'`) or vertical (`axis: 'x'`) line.
   */
  annotations?: StudioChartAnnotation[];
}

/** Gauge chart — rendered by `renderGauge`. */
export interface StudioGaugeChartConfig extends StudioChartConfigBase {
  /** Chart sub-type. */
  chartType: 'gauge';
  /** Value field whose aggregate drives the gauge needle. */
  yField?: string;
  /** How to aggregate the gauge value. @default 'sum' */
  yAggregation?: 'sum' | 'count' | 'avg' | 'min' | 'max';
  /** Minimum value for gauge chart. @default 0 */
  gaugeMin?: number;
  /** Maximum value for gauge chart. @default 100 */
  gaugeMax?: number;
}

/**
 * Discriminated union of every chart sub-shape, keyed by `chartType`. Because
 * `StudioChartType` is closed, a bare `config.chartType === 'gauge'` narrows this
 * union natively (no runtime guard needed). This is the type of a chart widget's
 * `config` (`StudioWidgetConfigByKind.chart`).
 */
export type StudioChartWidgetConfig =
  | StudioBarFamilyChartConfig
  | StudioLineAreaFamilyChartConfig
  | StudioMixedChartConfig
  | StudioHeatmapChartConfig
  | StudioFunnelChartConfig
  | StudioGanttChartConfig
  | StudioSankeyChartConfig
  | StudioPieFamilyChartConfig
  | StudioScatterChartConfig
  | StudioGaugeChartConfig;

/**
 * Maps each `StudioChartType` literal to the family config interface that governs
 * it. The single source of truth wiring a `chartType` discriminant to its precise
 * config shape (the chart-level analogue of `StudioWidgetConfigByKind`).
 */
export interface StudioChartConfigByType {
  bar: StudioBarFamilyChartConfig;
  'bar-stacked': StudioBarFamilyChartConfig;
  'bar-100': StudioBarFamilyChartConfig;
  line: StudioLineAreaFamilyChartConfig;
  area: StudioLineAreaFamilyChartConfig;
  'area-stacked': StudioLineAreaFamilyChartConfig;
  'area-100': StudioLineAreaFamilyChartConfig;
  mixed: StudioMixedChartConfig;
  heatmap: StudioHeatmapChartConfig;
  funnel: StudioFunnelChartConfig;
  gantt: StudioGanttChartConfig;
  sankey: StudioSankeyChartConfig;
  pie: StudioPieFamilyChartConfig;
  donut: StudioPieFamilyChartConfig;
  scatter: StudioScatterChartConfig;
  gauge: StudioGaugeChartConfig;
}

/**
 * Fail-closed compile-time assertion that EVERY `StudioChartType` literal has an
 * entry in `StudioChartConfigByType`. Resolves to `true` when the map is complete;
 * otherwise to a descriptive error tuple naming the uncovered chart types, which
 * makes the `CHART_TYPES_COVERED` line below fail to compile. Adding a chart type
 * to `StudioChartType` without a `StudioChartConfigByType` entry is a build error.
 */
type AssertChartTypesCovered =
  Exclude<StudioChartType, keyof StudioChartConfigByType> extends never
    ? true
    : [
        'StudioChartConfigByType is missing chart types:',
        Exclude<StudioChartType, keyof StudioChartConfigByType>,
      ];
const CHART_TYPES_COVERED: AssertChartTypesCovered = true;
void CHART_TYPES_COVERED;

/** The precise family config shape for a chart of type `T`. */
export type StudioChartConfigOfType<T extends StudioChartType> = StudioChartConfigByType[T];

/**
 * Flat, all-optional chart config bag — the deliberate GENERIC / PATCH type, kept
 * (like the widget-kind migration's flat `StudioWidgetConfig`) for code that
 * operates across chart types by design: the reducer, `updateWidgetConfig`, the AI
 * tool-argument builder, the cross-type query-descriptor registry, and the compose
 * drawer's shared top controls. It is RECOMPOSED from the family interfaces (via
 * `Partial<Omit<…, 'chartType'>>`) so it can never structurally drift from them.
 *
 * IMPORTANT — key retention across chartType switches: a widget's STORED config
 * legitimately keeps keys authored under a previously-selected chartType (e.g.
 * switching bar → gauge → bar preserves `xField` / `ySeries`). This is deliberate
 * UX driven by `applyMutation`'s merge (patch, not replace) semantics — it is why
 * no schema migration strips these keys. Consequently, readers of the NARROW
 * `StudioChartWidgetConfig` union must always gate on `chartType` rather than
 * assuming the absence of another family's keys; a stray `sankeyTargetField` on a
 * config whose `chartType` is now `'gauge'` is expected, not corrupt.
 */
export interface StudioChartConfig
  extends
    StudioChartConfigBase,
    // `crossFilterMode` and the other card-chrome keys are shared across every
    // widget kind (see `StudioSharedWidgetConfig`); the flat chart patch view
    // still surfaces them so cross-type consumers (the reducer, the AI system
    // prompt builder) can read them off a chart config.
    Partial<StudioSharedWidgetConfig>,
    Partial<Omit<StudioBarFamilyChartConfig, 'chartType'>>,
    Partial<Omit<StudioLineAreaFamilyChartConfig, 'chartType'>>,
    Partial<Omit<StudioMixedChartConfig, 'chartType'>>,
    Partial<Omit<StudioHeatmapChartConfig, 'chartType'>>,
    Partial<Omit<StudioFunnelChartConfig, 'chartType'>>,
    Partial<Omit<StudioGanttChartConfig, 'chartType'>>,
    Partial<Omit<StudioSankeyChartConfig, 'chartType'>>,
    Partial<Omit<StudioPieFamilyChartConfig, 'chartType'>>,
    Partial<Omit<StudioScatterChartConfig, 'chartType'>>,
    Partial<Omit<StudioGaugeChartConfig, 'chartType'>> {
  /** Chart sub-type. Determines which other config keys are relevant. @default 'bar' */
  chartType?: StudioChartType;
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
  /**
   * How this widget responds to incoming cross-filters from other widgets.
   * Read by every widget kind's runtime (not chart-only), so it lives on the shared
   * config surface. See {@link StudioCrossFilterMode} for details.
   * @default 'cross-highlight'
   */
  crossFilterMode?: StudioCrossFilterMode;
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

/**
 * Maps each built-in widget kind to its OWN config interface (the shared
 * `StudioSharedWidgetConfig` slice is added separately by
 * `StudioWidgetConfigForKind`, so it is intentionally not repeated here). This
 * is the single source of truth wiring a `widget.kind` discriminant to the
 * precise config shape valid for that kind.
 */
export interface StudioWidgetConfigByKind {
  grid: StudioGridConfig;
  chart: StudioChartWidgetConfig;
  kpi: StudioKpiConfig;
  text: StudioTextConfig;
  filter: StudioFilterWidgetConfig;
  pivot: StudioPivotConfig;
  map: StudioMapConfig;
}

/**
 * The precise config shape for a widget of kind `K`: the shared config chrome
 * plus that kind's own config interface. For an unknown / consumer-defined
 * custom kind (a `K` that is not one of the built-in kinds), only the shared
 * config plus `customConfig` is allowed — a custom widget has no built-in
 * per-kind config surface.
 */
export type StudioWidgetConfigForKind<K extends StudioWidgetKind> = StudioSharedWidgetConfig &
  (K extends keyof StudioWidgetConfigByKind
    ? StudioWidgetConfigByKind[K]
    : { customConfig?: Record<string, unknown> });

/**
 * A widget of a single, statically-known kind `K`. Its `config` is narrowed to
 * exactly `StudioWidgetConfigForKind<K>`, so a Chart-only config key no longer
 * type-checks on a Grid widget. The non-`config` fields are identical for every
 * kind (this is the discriminated-union member shape).
 */
export interface StudioWidgetOf<K extends StudioWidgetKind> {
  id: string;
  kind: K;
  title: string;
  /** 'auto' = recompute from config on every change (default). 'manual' = user-set title. */
  titleMode?: 'auto' | 'manual';
  subtitle?: string;
  /** 'auto' = recompute from config on every change (default). 'manual' = user-set subtitle. */
  subtitleMode?: 'auto' | 'manual';
  sourceId?: string;
  config: StudioWidgetConfigForKind<K>;
}

/**
 * A Studio widget: a discriminated union over the built-in kinds (each with its
 * kind-specific `config`), plus a catch-all member for consumer-defined custom
 * kinds. Narrowing on `widget.kind` (e.g. `if (widget.kind === 'chart')`)
 * refines `widget.config` to that kind's precise config shape.
 *
 * Code that must operate on a widget's config BEFORE its kind is known, or
 * across kinds by design (the reducer, `StudioController.updateWidgetConfig`,
 * the AI tool-argument builder, cross-kind registries), uses the flat
 * `StudioWidgetConfig` patch type instead.
 */
export type StudioWidget =
  | { [K in BuiltinStudioWidgetKind]: StudioWidgetOf<K> }[BuiltinStudioWidgetKind]
  | StudioWidgetOf<string & {}>;

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
   * Per-widget explicit column span in the `GRID_COLS = 24` unit system. The reducer
   * (`applyMutation.ts`) clamps each span to `MIN_SPAN` (6, ≈¼ row) … `GRID_COLS`
   * (24); a row whose spans sum above `GRID_COLS` is rebalanced or dropped by
   * `setWidgetColSpan`/`enforceLayoutColSpans`. Widgets absent from this map take
   * equal shares of the remaining space (`flex: 1`). See `applyMutation.ts` for the
   * authoritative clamping/rebalancing rules.
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
