export type StudioMode = 'edit' | 'view';

export type StudioDrawer = 'data' | 'compose' | 'filters';

/**
 * Built-in widget kinds. Use this type for exhaustive switches over built-in widget logic.
 * For code that must also handle consumer-defined custom widget kinds, use {@link StudioWidgetKind}.
 */
export type BuiltinStudioWidgetKind =
  | 'grid'
  | 'chart'
  | 'kpi'
  | 'text'
  | 'filter'
  | 'pivot'
  | 'map';

/**
 * All widget kinds: built-in kinds plus any consumer-defined custom kind identifier.
 * Use namespaced strings for custom kinds (e.g. `'acme-weather'`) to avoid collisions.
 */
export type StudioWidgetKind = BuiltinStudioWidgetKind | (string & {});

export type StudioFilterWidgetType = 'date-range' | 'multi-select' | 'toggle' | 'slider';

/**
 * Runtime feature flags for the Studio dashboard.
 * All flags default to `true` (feature enabled) when not specified.
 *
 * Pass via the `featureFlags` prop on `<Studio>` or `<StudioProvider>`.
 */

/**
 * Feature sub-flags for KPI widgets.
 * Passed as the value of `featureFlags.kpi` to selectively disable individual KPI features
 * while keeping the KPI widget kind available in the widget picker.
 *
 * @example
 * // Disable sparkline and trend but keep KPI otherwise enabled:
 * <Studio featureFlags={{ kpi: { sparkline: false, trend: false } }} />
 */
export interface KpiFeatureFlags {
  /**
   * Show the sparkline configuration section in the KPI setup panel.
   * @default true
   */
  sparkline?: boolean;
  /**
   * Show the period-over-period trend indicator configuration in the KPI setup panel.
   * @default true
   */
  trend?: boolean;
  /**
   * Show the target line configuration in the KPI setup panel.
   * @default true
   */
  target?: boolean;
  /**
   * Show the "Add calculated field" button in the KPI setup panel.
   * Has no effect when the global `calculatedFields` flag is `false`.
   * @default true
   */
  calculatedFields?: boolean;
}

/**
 * Feature sub-flags for chart widgets.
 * Passed as the value of `featureFlags.chart` to selectively disable individual chart features
 * while keeping the chart widget kind available.
 *
 * @example
 * // Disable annotations but keep charts otherwise enabled:
 * <Studio featureFlags={{ chart: { annotations: false } }} />
 */
export interface ChartFeatureFlags {
  /**
   * Show the reference-line annotations configuration in the chart setup panel.
   * @default true
   */
  annotations?: boolean;
  /**
   * Show the "Add calculated field" button in the chart setup panel.
   * Has no effect when the global `calculatedFields` flag is `false`.
   * @default true
   */
  calculatedFields?: boolean;
}

/**
 * Feature sub-flags for table/grid widgets.
 * Passed as the value of `featureFlags.grid` to selectively disable individual grid features
 * while keeping the table widget kind available.
 *
 * @example
 * // Disable group-by and conditional formats but keep grid otherwise enabled:
 * <Studio featureFlags={{ grid: { groupBy: false, conditionalFormats: false } }} />
 */
export interface GridFeatureFlags {
  /**
   * Show the "Group by" field picker in the grid setup panel.
   * @default true
   */
  groupBy?: boolean;
  /**
   * Show the summary (totals) row configuration in the grid setup panel.
   * @default true
   */
  summary?: boolean;
  /**
   * Show the conditional formatting configuration in the grid setup panel.
   * @default true
   */
  conditionalFormats?: boolean;
  /**
   * Show the "Calculated column…" option in the table/grid setup panel's "Add column" menu.
   * Has no effect when the global `calculatedFields` flag is `false`.
   * @default true
   */
  calculatedFields?: boolean;
}

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
   * Show the date range / quick filter bar above the widget canvas.
   * This top-of-canvas bar provides quick date presets and active filter pills.
   * Set to `false` to hide the bar entirely (useful in composed layouts where
   * a custom filter toolbar is provided).
   * @default false
   */
  quickFilter?: boolean;
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
   * Show the relationship management panel in the data drawer.
   * Set to `false` to hide the "Relationships" section, preventing editors from
   * adding or removing cross-source join definitions.
   * @default true
   */
  relationships?: boolean;
  /**
   * Show the per-widget "Filters" tab in the widget edit dialog (`StudioWidgetEditDialog`).
   * Set to `false` to hide the widget-level filter conditions editor from editors.
   * @default true
   */
  widgetFilters?: boolean;
  /**
   * Enable the AI chat assistant panel.
   * Requires `aiConfig` to also be provided — this flag only controls visibility.
   * @default true
   */
  aiChat?: boolean;

  // ── Widget kind availability ───────────────────────────────────────────────

  /**
   * Allow adding table/grid widgets.
   * - `false`: hides grid from the widget picker entirely.
   * - An object: enables the widget kind but selectively disables sub-features.
   *   See {@link GridFeatureFlags} for available sub-flags.
   * @default true
   */
  grid?: boolean | GridFeatureFlags;
  /**
   * Allow adding chart widgets.
   * - `false`: hides chart from the widget picker entirely.
   * - An object: enables the widget kind but selectively disables sub-features.
   *   See {@link ChartFeatureFlags} for available sub-flags.
   * @default true
   */
  chart?: boolean | ChartFeatureFlags;
  /**
   * Allow adding KPI widgets.
   * - `false`: hides KPI from the widget picker entirely.
   * - An object: enables the widget kind but selectively disables sub-features.
   *   See {@link KpiFeatureFlags} for available sub-flags.
   * @default true
   */
  kpi?: boolean | KpiFeatureFlags;
  /**
   * Allow adding text/markdown widgets. Set to `false` to hide text from the widget picker.
   * @default true
   */
  text?: boolean;
  /**
   * Allow adding interactive filter widgets. Set to `false` to hide filter widgets from the picker.
   * @default true
   */
  filter?: boolean;
  /**
   * Allow adding pivot table widgets. Set to `false` to hide pivot from the widget picker.
   * @default true
   */
  pivot?: boolean;
  /**
   * Allow adding choropleth map widgets. Set to `false` to hide map from the widget picker.
   * @default true
   */
  map?: boolean;

  // ── Calculated fields ──────────────────────────────────────────────────────

  /**
   * Master switch for calculated (expression) fields across all widget types.
   * Set to `false` to hide the "Add calculated field" button from all widget setup panels,
   * preventing editors from creating new expression-based columns or measures.
   * Existing expression fields that are already in use remain functional.
   * @default true
   */
  calculatedFields?: boolean;
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

export type StudioKpiAggregation = 'sum' | 'avg' | 'count' | 'min' | 'max' | 'count_distinct';

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

export type StudioGridSummaryAggregation =
  | 'sum'
  | 'avg'
  | 'count'
  | 'min'
  | 'max'
  | 'count_distinct';

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
