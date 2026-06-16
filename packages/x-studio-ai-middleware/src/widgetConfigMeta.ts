import type { BuiltinStudioWidgetKind } from './models/studioTypes';

// ── Widget kind one-liners ────────────────────────────────────────────────────

/** One-line description of each built-in widget kind, used in the system prompt and widget picker. */
export const WIDGET_KIND_DESCRIPTIONS = {
  chart:
    'Chart (bar, line, area, pie, donut, scatter, heatmap, funnel, gantt, gauge, mixed multi-series)',
  grid: 'Data grid / table',
  kpi: 'KPI card (single metric with optional sparkline/gauge and trend)',
  text: 'Text / markdown card',
  filter: 'Interactive filter widget (date range, multi-select, toggle, slider)',
  pivot: 'Pivot table (cross-tabulation with row/column dimensions and value aggregation)',
  map: 'Choropleth world map (country-level data visualisation)',
} satisfies Record<BuiltinStudioWidgetKind, string>;

// ── Per-kind config key documentation ─────────────────────────────────────────

/**
 * Lines of documentation for each widget kind's config keys.
 * The first element is the primary entry; remaining elements are continuation detail or
 * sub-type entries (e.g. heatmap, funnel, gantt as named sub-entries under chart).
 *
 * Used by `buildWidgetConfigDescription()` to generate the string embedded in the
 * `add_widget` tool schema — this is the single source of truth for which config
 * keys the LLM knows about per kind.
 *
 * When adding a new config field to `StudioWidgetConfig`, add its AI-facing
 * documentation here (and in the JSDoc on the TypeScript interface).
 */
const KIND_CONFIG_LINES: Record<BuiltinStudioWidgetKind, string[]> = {
  chart: [
    'chart: chartType (bar|line|area|pie|donut|scatter|bar-stacked|bar-100|area-stacked|area-100|heatmap|funnel|gantt|gauge|mixed), xField, yField, yAggregation (sum|count|avg|min|max — use "count" when yField is a string/boolean; default "sum"), seriesField;',
    '  barLayout: "horizontal" — use for >5 categories, long names, or ranking charts; do NOT use for time-series;',
    '  chartSortBy: "value"|"category", chartSortDirection: "asc"|"desc" — for ranked bar charts;',
    '  xGroupBy: "day"|"week"|"month"|"quarter"|"year" — required when xField is date/datetime;',
    '  scatterColorField: categorical field to colour scatter points; scatterSizeField: numeric field for bubble size (scatter→bubble);',
    '  pieArcLabel: "value"|"percent"|"none" — labels shown on pie/donut arcs;',
    '  heatColorScheme: "primary"|"success"|"warning"|"error" — colour palette for heatmap;',
    '  heatLegendPosition: "bottom"|"top"|"left"|"right"|"hidden" — heatmap legend placement (default "bottom");',
    '  heatLegendAlign: "start"|"center"|"end" — heatmap legend cross-axis alignment (default "center");',
    '  heatSortBy: "x-axis"|"y-axis"|"natural" — which heatmap axis labels to sort; heatSortDirection: "asc"|"desc";',
    '  crossFilterMode: "cross-highlight"|"cross-filter"|"none" — how widget responds to cross-filter events (default: "cross-highlight");',
    '  crossFilterField: field ID to emit when a bar/point is clicked (default: xField);',
    '  yField2: second numeric field for a secondary scatter axis or additional bar series;',
    'heatmap: xField (columns), heatYField (rows), yField (intensity), yAggregation, heatColorScheme, heatLegendPosition, heatLegendAlign, heatSortBy, heatSortDirection;',
    'funnel: xField (stages), yField (value), yAggregation (use "count" when yField is string);',
    'gantt: ganttLabelField, ganttStartField (date), ganttEndField (date), ganttColorField (optional);',
    'gauge: yField, yAggregation, gaugeMin (default 0), gaugeMax;',
    'mixed: ySeries (array of {fieldId, label, type: bar|line, yAggregation, sourceId}), dualYAxis (boolean) — set a per-series sourceId to overlay a metric from a different source onto the shared categorical xField (the join key must exist with the same id in every source used);',
  ],
  kpi: [
    'kpi: kpiValueField, kpiAggregation (sum|avg|count|min|max), kpiSparkline (boolean), kpiSparklinePlotType (line|bar|gauge), kpiSparklineGaugeMin, kpiSparklineGaugeMax, kpiSparklineCumulative (boolean), kpiSparklineGranularity ("day"|"week"|"month"|"quarter"|"year"),',
    '  kpiTrend (boolean), kpiTrendComparison ("previous-period"|"previous-calendar-period"|"year-over-year"), kpiTrendInvert (boolean — true if lower is better),',
    '  kpiTarget (number), kpiTargetRef (StudioMetricRef ID);',
  ],
  grid: [
    'grid: columns (array of field IDs), gridSortField (field ID), gridSortDirection ("asc"|"desc"), gridGroupByField (categorical field to group rows);',
  ],
  text: [
    'text: textContent (markdown string). Optional: textSubtitle, textBody, textTitleFontFamily, textTitleFontSize, textTitleColor, textTitleAlign (and equivalents for subtitle/body sections).',
  ],
  filter: ['filter: filterWidgetType (date-range|multi-select|toggle|slider), filterWidgetField;'],
  pivot: [
    'pivot: pivotRowField, pivotColField, pivotValueField, pivotAggregation (sum|count|avg|min|max), pivotShowTotals (boolean);',
  ],
  map: [
    'map: mapCountryField, mapValueField, mapAggregation (sum|count|avg|min|max), mapColorScheme (blues|reds|greens|oranges|purples), mapCrossFilterEmit (boolean — emit cross-filter on country click).',
  ],
};

/**
 * Generates the widget config description string embedded in the `add_widget` and
 * `update_widget` tool schemas. Derive this from `KIND_CONFIG_LINES` so that both
 * the schema and the prompt stay in sync automatically.
 */
export function buildWidgetConfigDescription(): string {
  const lines: string[] = ['Widget configuration. Keys depend on the widget kind:'];
  for (const kindLines of Object.values(KIND_CONFIG_LINES)) {
    lines.push(...kindLines);
  }
  lines.push(
    'For custom widget kinds registered by the app, pass any config keys the custom widget expects.',
  );
  return lines.join('\n');
}

// ── Chart types reference ─────────────────────────────────────────────────────

/**
 * Per-chart-type required and optional config key reference lines.
 * Rendered as the `## Chart Types` section in the system prompt.
 * Add a new entry here when a new chartType is introduced.
 */
export const CHART_TYPE_DOCS: string[] = [
  'bar / bar-stacked / bar-100: xField (categorical), yField, yAggregation. Optional: barLayout ("horizontal"), seriesField, chartSortBy ("value"|"category"), chartSortDirection ("asc"|"desc"), xGroupBy.',
  'line / area / area-stacked / area-100: xField (date/datetime), yField, yAggregation, xGroupBy. Optional: seriesField.',
  'pie / donut: xField (categorical, ≤7 values), yField, yAggregation. Optional: pieArcLabel ("value"|"percent"|"none").',
  'scatter: xField (numeric), yField (numeric). Optional: scatterColorField (categorical), scatterSizeField (numeric for bubbles), yField2.',
  'heatmap: xField (columns), heatYField (rows), yField (intensity), yAggregation. Optional: heatColorScheme ("primary"|"success"|"warning"|"error"), heatLegendPosition ("bottom"|"top"|"left"|"right"|"hidden"), heatLegendAlign ("start"|"center"|"end").',
  'funnel: xField (stages in order), yField, yAggregation (use "count" for string yField).',
  'gantt: ganttLabelField, ganttStartField (date), ganttEndField (date). Optional: ganttColorField.',
  'gauge: yField, yAggregation, gaugeMin (default 0), gaugeMax. No xField.',
  'mixed: ySeries (array of {fieldId, label, type: "bar"|"line", yAggregation, sourceId}). Optional: dualYAxis (boolean). Set a per-series sourceId to overlay a metric from another source — xField must be a categorical field present (same id) in every source used.',
];

/** Appended after `CHART_TYPE_DOCS` in the Chart Types section. */
export const KPI_SPARKLINE_DOC =
  'KPI sparkline plotType: line, bar, gauge (kpiSparklineGaugeMin, kpiSparklineGaugeMax).';
