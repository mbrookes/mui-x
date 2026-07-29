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
 * Controls how a chart widget responds to incoming cross-filters from other widgets.
 * - `'cross-highlight'` (default): shows the full dataset as a faded ghost behind the
 *   filtered subset — communicates proportion ("what share does this selection represent?").
 * - `'cross-filter'`: redraws the chart using only the filtered rows — focuses on the subset
 *   and lets axes rescale to the filtered data.
 * - `'none'`: ignores cross-filters contributed by OTHER widgets and shows the full
 *   dataset with respect to those — but this is NOT "always show everything unfiltered":
 *   an interactive filter-widget selection is a hard filter, not a cross-filter, and
 *   deliberately still applies even in `'none'` mode (a documented invariant enforced
 *   elsewhere in the pipeline — interactive filters are never dropped by cross-filter
 *   mode, only a chart's own cross-filter CONTRIBUTION is suppressed).
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
  | 'sankey'
  | 'pie'
  | 'donut'
  | 'scatter'
  | 'gauge';

export type StudioBarLayout = 'grouped' | 'stacked' | 'horizontal';

export type StudioNumberFormat = 'integer' | 'decimal' | 'percent' | 'currency';

/**
 * `count` vs `count_non_null` vs `count_distinct` are three DIFFERENT numbers, and the
 * distinction is the whole reason they have separate names:
 * - `count` is SQL's `COUNT(*)` — how many ROWS landed in the bucket, whether or not this
 *   particular measure had a usable value in them.
 * - `count_non_null` is SQL's `COUNT(column)` — how many of those rows actually had a value.
 * - `count_distinct` is `COUNT(DISTINCT column)` over the RAW values.
 *
 * All three are meaningful for EVERY field type (they read the raw cell, never the numeric
 * coercion `sum`/`avg`/`min`/`max` apply), so any option list offering one must offer all
 * three — see `GridSetupPanel`'s `STRING_AGGREGATIONS` and `KpiSetupPanel`'s per-type lists.
 */
/**
 * The full 7-member value-aggregation union shared by KPI and Grid-summary fields — every
 * aggregation that reads a raw cell (as opposed to {@link StudioSeriesAggregation}'s
 * chart/pivot/map subset, which never distinguishes `count`/`count_non_null`/
 * `count_distinct`). {@link StudioKpiAggregation} and {@link StudioGridSummaryAggregation}
 * were previously two byte-for-byte-identical unions declared independently; both are kept
 * as aliases of this one so existing imports of either name keep working unchanged.
 */
export type StudioValueAggregation =
  | 'sum'
  | 'avg'
  | 'count'
  | 'count_non_null'
  | 'min'
  | 'max'
  | 'count_distinct';

export type StudioKpiAggregation = StudioValueAggregation;

export type StudioGridSummaryAggregation = StudioValueAggregation;

/**
 * The 5-member aggregation-function subset offered by chart/map/pivot series fields
 * (`yAggregation` on every chart family, `mapAggregation`, `pivotAggregation`): the raw
 * cell-vs-value distinctions ({@link StudioValueAggregation}'s `count_non_null` /
 * `count_distinct`) don't apply once values are already bucketed by a series key, so
 * only `count`'s plain row-count reading is offered.
 */
export type StudioSeriesAggregation = 'sum' | 'avg' | 'count' | 'min' | 'max';

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
