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
  | 'sankey'
  | 'pie'
  | 'donut'
  | 'scatter'
  | 'gauge';

export type StudioBarLayout = 'grouped' | 'stacked' | 'horizontal';

export type StudioNumberFormat = 'integer' | 'decimal' | 'percent' | 'currency';

export type StudioKpiAggregation = 'sum' | 'avg' | 'count' | 'min' | 'max' | 'count_distinct';

export type StudioGridSummaryAggregation =
  | 'sum'
  | 'avg'
  | 'count'
  | 'min'
  | 'max'
  | 'count_distinct';

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
