import type { FieldCapability } from '../utils/fieldCapabilities';

export type StudioMode = 'edit' | 'view';

export type StudioDrawer = 'data' | 'compose' | 'filters';

export type StudioWidgetKind = 'grid' | 'chart' | 'kpi' | 'text' | 'filter' | 'pivot' | 'map';

export type StudioFilterWidgetType = 'date-range' | 'multi-select' | 'toggle' | 'slider';

/**
 * Runtime feature flags for the Studio dashboard.
 * All flags default to `true` (feature enabled) when not specified.
 *
 * Pass via the `featureFlags` prop on `<Studio>` or `<StudioProvider>`.
 */
export interface StudioFeatureFlags {
  /**
   * Show the compose (edit) panel and data drawer, and allow switching to edit mode.
   * Set to `false` to lock the dashboard in a view-only, non-editable state.
   * @default true
   */
  compose?: boolean;
  /**
   * Show the filters sidebar panel and quick filter bar.
   * Set to `false` to hide all filter UI from end users.
   * @default true
   */
  filters?: boolean;
  /**
   * Allow saving and loading named filter presets ("Saved Views") in the filters panel.
   * @default true
   */
  savedFilterViews?: boolean;
  /**
   * Show the data drawer for managing data sources, fields, expression fields,
   * and relationships.
   * @default true
   */
  dataManagement?: boolean;
  /**
   * Enable the AI chat assistant panel.
   * Requires `aiConfig` to also be provided — this flag only controls visibility.
   * @default true
   */
  aiChat?: boolean;

  // ── Widget kind availability ───────────────────────────────────────────────

  /**
   * Allow adding table/grid widgets. Set to `false` to hide grid from the widget picker.
   * @default true
   */
  allowGrid?: boolean;
  /**
   * Allow adding chart widgets. Set to `false` to hide chart from the widget picker.
   * @default true
   */
  allowChart?: boolean;
  /**
   * Allow adding KPI widgets. Set to `false` to hide KPI from the widget picker.
   * @default true
   */
  allowKpi?: boolean;
  /**
   * Allow adding text/markdown widgets. Set to `false` to hide text from the widget picker.
   * @default true
   */
  allowText?: boolean;
  /**
   * Allow adding interactive filter widgets. Set to `false` to hide filter widgets from the picker.
   * @default true
   */
  allowFilter?: boolean;
  /**
   * Allow adding pivot table widgets. Set to `false` to hide pivot from the widget picker.
   * @default true
   */
  allowPivot?: boolean;
  /**
   * Allow adding choropleth map widgets. Set to `false` to hide map from the widget picker.
   * @default true
   */
  allowMap?: boolean;

  // ── KPI widget features ────────────────────────────────────────────────────

  /**
   * Show the sparkline configuration section in the KPI setup panel.
   * Set to `false` to hide sparkline controls from editors and to prevent the
   * sparkline from rendering on existing widgets.
   * @default true
   */
  kpiSparkline?: boolean;
  /**
   * Show the period-over-period trend indicator configuration in the KPI setup panel.
   * Set to `false` to hide trend controls and suppress trend badge rendering.
   * @default true
   */
  kpiTrend?: boolean;
  /**
   * Show the target line configuration in the KPI setup panel.
   * Set to `false` to hide target controls and suppress target line rendering.
   * @default true
   */
  kpiTarget?: boolean;

  // ── Chart widget features ──────────────────────────────────────────────────

  /**
   * Show the reference-line annotations configuration in the chart setup panel.
   * Set to `false` to hide annotation controls and suppress annotation rendering.
   * @default true
   */
  chartAnnotations?: boolean;

  // ── Grid widget features ───────────────────────────────────────────────────

  /**
   * Show the "Group by" field picker in the grid setup panel.
   * Set to `false` to hide groupBy controls from editors.
   * @default true
   */
  gridGroupBy?: boolean;
  /**
   * Show the summary (totals) row configuration in the grid setup panel.
   * Set to `false` to hide summary controls from editors and suppress the pinned footer row.
   * @default true
   */
  gridSummary?: boolean;
  /**
   * Show the conditional formatting configuration in the grid setup panel.
   * Set to `false` to hide conditional format controls from editors and suppress conditional
   * formatting in the rendered table.
   * @default true
   */
  gridConditionalFormats?: boolean;

  // ── Cross-widget features ──────────────────────────────────────────────────

  /**
   * Enable drilldown — clicking a data point or row to open a secondary widget panel.
   * Set to `false` to hide drilldown configuration and suppress drilldown panel rendering.
   * @default true
   */
  drilldown?: boolean;
}

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
  | 'mixed'
  | 'heatmap'
  | 'funnel'
  | 'gantt'
  | 'pie'
  | 'donut'
  | 'scatter'
  | 'gauge'
  // Legacy aliases kept for backwards compatibility
  | 'bar-grouped';

export type StudioBarLayout = 'grouped' | 'stacked' | 'horizontal';

export type StudioNumberFormat = 'integer' | 'decimal' | 'percent' | 'currency';

export type StudioKpiAggregation = 'sum' | 'avg' | 'count' | 'min' | 'max';

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
  operator: 'equals' | 'not_equals' | 'greater_than' | 'less_than' | 'greater_than_or_equal' | 'less_than_or_equal' | 'contains' | 'is_empty' | 'is_not_empty';
  /** The value to compare against (not used for is_empty / is_not_empty). */
  value?: unknown;
  /** Style to apply to the cell when the rule matches. */
  style: StudioConditionalFormatStyle;
}


export type StudioGridSummaryAggregation = 'sum' | 'avg' | 'count' | 'min' | 'max' | 'count_distinct';

/**
 * Aggregation function for a grid column — a superset of `StudioGridSummaryAggregation`.
 * @deprecated Prefer `StudioGridSummaryAggregation` directly; this alias is kept for compatibility.
 */
export type StudioGridColumnAggFn = StudioGridSummaryAggregation;

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
  aggregationFn?: StudioGridColumnAggFn;
  /** Column header label override (defaults to `StudioDataField.label`). */
  label?: string;
}

/**
 * Normalise a column entry that may be either a legacy `string` field ID or a
 * `StudioGridColumn` object. Call this when reading persisted state.
 */
export function normalizeGridColumn(col: string | StudioGridColumn): StudioGridColumn {
  return typeof col === 'string' ? { fieldId: col } : col;
}

export type StudioFilterOperator =
  | 'equals'
  | 'in'
  | 'not_in'
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
  /**
   * Series render type for mixed charts.
   * - `'bar'` (default): renders as a bar/column
   * - `'line'`: renders as a line (with optional markers)
   *
   * Only used when `chartType === 'mixed'`.
   */
  seriesType?: 'bar' | 'line';
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
