---
title: Studio - Chart widget
description: The chart widget renders bar, line, area, mixed, heatmap, funnel, gantt, sankey, pie, donut, and scatter visualisations from a Studio data source.
---

# Studio - Chart widget

<p class="description">The chart widget renders bar, line, area, mixed, heatmap, funnel, gantt, sankey, pie, donut, and scatter visualisations from a Studio data source.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader", "design": false}}

## Overview

`StudioChartWidget` renders one of the supported chart types driven by the fields and data source you configure in the sidebar.
The same `StudioWidgetConfig` can also be set programmatically with `StudioController`.
It integrates with the MUI X Charts library for rendering and participates in the Studio cross-filter system.

## Chart types

| Type               | `type` value   | Notes                                                                                                                                                                                                                                                                   |
| :----------------- | :------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Grouped bar        | `bar`          | Default; grouped when multiple series                                                                                                                                                                                                                                   |
| Stacked bar        | `bar-stacked`  | Stacks series as absolute values                                                                                                                                                                                                                                        |
| 100 % stacked bar  | `bar-100`      | Stacks series as percentages                                                                                                                                                                                                                                            |
| Line               | `line`         | X axis is typically a category or time field                                                                                                                                                                                                                            |
| Area               | `area`         | Fills below the line                                                                                                                                                                                                                                                    |
| Stacked area       | `area-stacked` |                                                                                                                                                                                                                                                                         |
| 100 % stacked area | `area-100`     |                                                                                                                                                                                                                                                                         |
| Mixed              | `mixed`        | Bar + line overlay on shared axes; requires 2+ measure fields; each `ySeries` entry can set `seriesType` to `'bar'` or `'line'`; optional `dualYAxis` adds an independent right Y axis                                                                                  |
| Heatmap            | `heatmap`      | Uses `xField` for columns, `heatYField` for rows, and `yField` for colour intensity; `heatColorScheme` supports `primary`, `success`, `warning`, and `error`                                                                                                            |
| Funnel             | `funnel`       | Uses `xField` for stage and `yField` for value; stages are sorted by value descending with drop-off and retention percentages. Set `funnelReachedField` (+ `funnelStageSequence`) for a monotonic cumulative "reached stage" funnel — see [Funnel modes](#funnel-modes) |
| Gantt              | `gantt`        | Swimlane timeline using `ganttLabelField`, `ganttStartField`, `ganttEndField`, and optional `ganttColorField`; includes a date axis, grid lines, and tooltips                                                                                                           |
| Sankey             | `sankey`       | Flow diagram using `xField` for source node, `sankeyTargetField` for target node, and `yField` for the link value (summed per source→target pair); `sankeyLinkColor` (`'source'` or `'target'`) and `sankeyShowValues` control link appearance                          |
| Pie                | `pie`          | No X axis; single numeric value series                                                                                                                                                                                                                                  |
| Donut              | `donut`        | Like pie with a centre hole                                                                                                                                                                                                                                             |
| Scatter            | `scatter`      | Requires `xField` and `yField`                                                                                                                                                                                                                                          |

## Configuration

```ts
interface StudioChartConfig {
  type: StudioChartType;
  dataSourceId: string;
  xField?: string; // category or time axis field id
  series: StudioChartSeries[];
  splitBy?: string; // field id to split series dynamically
  groupBy?: StudioGroupBy; // time granularity for date fields
}

interface StudioChartSeries {
  id: string;
  valueField: string; // numeric or measure field id
  label?: string; // display label for legend
  aggregation?: StudioAggregation; // 'sum' | 'avg' | 'count' | 'min' | 'max' | 'none'
}

type StudioGroupBy = 'day' | 'week' | 'month' | 'quarter' | 'year';
type StudioAggregation = 'sum' | 'avg' | 'count' | 'min' | 'max' | 'none';
```

## Axes

**X axis** — accepts any field from the data source. When the field type is `date`, the
`groupBy` option controls the time bucket (day, week, month, quarter, year).
Category string fields produce one bar/point per unique value.

**Y axis** — automatically generated from the configured series. Values are aggregated by
the `aggregation` function before rendering.

## Funnel modes

A funnel chart has two counting modes:

- **Snapshot (default)** — counts (or sums) the rows _currently in_ each stage. This is
  only monotonic if each stage genuinely contains a subset of the previous one; with
  independent per-stage data a later stage can exceed an earlier one (retention > 100%).
- **Cumulative "reached stage"** — set `funnelReachedField` to a numeric depth field and
  `funnelStageSequence` to the ordered stage labels. Each stage then counts rows whose depth
  is _at or beyond_ that stage, which is monotonically non-increasing by construction, so the
  funnel can never exceed 100%. The snapshot count is kept for a "currently in stage: N"
  tooltip. Use `funnelExitStage` to mark a terminal exit (for example `Closed Lost`) that is
  excluded from the sequential conversion math and rendered as a separate exit stat. Set
  `funnelConversionBar: true` to render the same cumulative counts as a step-conversion bar
  (one bar per stage transition) instead of the funnel trapezoids.

```ts
const funnelConfig = {
  chartType: 'funnel',
  xField: 'stage', // snapshot stage label
  yField: 'id',
  funnelReachedField: 'stageReached', // numeric furthest-reached depth
  funnelStageSequence: [
    'Prospecting',
    'Qualification',
    'Proposal',
    'Negotiation',
    'Closed Won',
  ],
  funnelExitStage: 'Closed Lost', // terminal exit, shown as a side stat
};
```

## Multi-series

Add multiple entries to the `series` array to render stacked or grouped series. Each
entry can target a different numeric field or measure.

```ts
const chartConfig: StudioChartConfig = {
  type: 'bar-stacked',
  dataSourceId: 'orders',
  xField: 'month',
  series: [
    { id: 's1', valueField: 'revenue', label: 'Revenue', aggregation: 'sum' },
    { id: 's2', valueField: 'refunds', label: 'Refunds', aggregation: 'sum' },
  ],
};
```

## Counting rows without a measure field

A `count` aggregation tallies rows and ignores the measure field, so a single-series chart is
valid with **no Y (measure) field** — it renders one count per category. This is the only valid
configuration when the data source has no numeric field to plot (for example, counting contacts
per department on a CRM contacts source).

To build one from the setup panel, pick a chart type and an X field, then leave the measure field
empty: the aggregation locks to **Count**. The resulting config carries `yAggregation: 'count'`
with no `yField`/`ySeries`:

```ts
const chartConfig: StudioWidgetConfig = {
  chartType: 'bar',
  xField: 'department',
  yAggregation: 'count', // counts rows per department — no measure field needed
};
```

:::info
A fieldless count is only available for single-series charts. Split-by and multiple measure
series aggregate a value field, so they require a measure field and disable the no-field count.
:::

## Split-by

The `splitBy` option dynamically creates one series per unique value of the specified field.
This is useful when you do not know the category names at build time.

```ts
const chartConfig: StudioChartConfig = {
  type: 'line',
  dataSourceId: 'revenue',
  xField: 'month',
  splitBy: 'region', // one line per unique region value
  series: [{ id: 's1', valueField: 'amount', aggregation: 'sum' }],
};
```

:::info
`splitBy` overrides the `series` array — only the first series entry is used as the
value configuration.
:::

## Scatter chart color-by field

Use `scatterColorField?: string` to split a scatter chart into one colour-coded series per category and show a legend.
Categories are derived from the full unfiltered row set so series ordering stays stable as filters change.

```ts
const chartConfig: StudioWidgetConfig = {
  chartType: 'scatter',
  xField: 'price',
  yField: 'quantity',
  scatterColorField: 'region',
};
```

## Scatter bubble size

Set `scatterSizeField?: string` to a numeric field to turn a scatter chart into a bubble
chart: each point's marker radius scales with that field's value. Optionally bound the
radius range with `scatterMinRadius` and `scatterMaxRadius` (pixels).

```ts
const chartConfig: StudioWidgetConfig = {
  chartType: 'scatter',
  xField: 'price',
  yField: 'quantity',
  scatterSizeField: 'revenue', // bubble area encodes revenue
  scatterMinRadius: 4, // default
  scatterMaxRadius: 40, // default
};
```

This uses the native bubble support in `@mui/x-charts` rather than a Studio-specific
prop: each point carries a `sizeValue`, and the size field is mapped to a marker radius
by a continuous `sizeMap` on the chart's `zAxis` (with the usual square-root area
scaling). When `scatterSizeField` is omitted, the chart renders fixed-radius markers.

## Pie and donut arc labels

Use `pieArcLabel?: 'value' | 'percent' | 'none'` to control the label shown on each arc.
The default is `'none'`. Set `pieArcLabelMinAngle?: number` to hide labels for small slices; the default is `20` degrees.
For multi-ring pie and donut charts, percentages are calculated from each ring total.

```ts
const chartConfig: StudioWidgetConfig = {
  chartType: 'donut',
  xField: 'quarter',
  seriesField: 'region',
  yField: 'revenue',
  pieArcLabel: 'percent',
  pieArcLabelMinAngle: 12,
};
```

## Date grouping

When `xField` points to a `date` field, set `groupBy` to control bucketing:

```ts
const chartConfig: StudioChartConfig = {
  type: 'area',
  dataSourceId: 'events',
  xField: 'createdAt', // field type: 'date'
  groupBy: 'month', // group rows into monthly buckets
  series: [{ id: 's1', valueField: 'count', aggregation: 'sum' }],
};
```

## Category order

By default, string x-axis labels are sorted alphabetically. For fields whose values have a natural semantic sequence — like pipeline stages or severity levels — set `orderedValues` on the `StudioDataField` definition. All charts that use that field as their x-axis will automatically respect the declared order.

```ts
const dealsSource: StudioDataSource = {
  id: 'deals',
  label: 'Deals',
  fields: [
    {
      id: 'stage',
      label: 'Stage',
      type: 'string',
      orderedValues: [
        'Prospecting',
        'Qualification',
        'Proposal',
        'Negotiation',
        'Closed Won',
        'Closed Lost',
      ],
    },
    // …
  ],
};
```

Values absent from `orderedValues` are appended at the end, sorted alphabetically among themselves. Setting `chartSortBy: 'value'` in the widget config still overrides `orderedValues` and sorts bars by their aggregated y-value.

## Cross-filter emission

When a user clicks a data point, the chart widget emits a cross-filter
for the value at the clicked category. Other widgets on the same page that share the
same `dataSourceId` (or a related source) react automatically.

Set `crossFilterEnabled: false` in the widget config to disable emission.

```ts
const chartWidgetConfig = {
  type: 'chart',
  config: chartConfig,
  crossFilterEnabled: false,
};
```

## Mixed chart (bar + line)

Use `chartType: 'mixed'` to combine bar and line series on the same X axis.
Mixed charts require two or more measure fields.
Set `seriesType` on each `ySeries` entry to choose bars or lines, and set `dualYAxis: true` to render line series against an independent right Y axis.

```ts
const chartConfig: StudioWidgetConfig = {
  chartType: 'mixed',
  xField: 'month',
  measures: ['revenue', 'marginPct'],
  ySeries: [
    { fieldId: 'revenue', seriesType: 'bar' },
    { fieldId: 'marginPct', seriesType: 'line' },
  ],
  dualYAxis: true,
};
```

## Chart annotations and reference lines

Use `annotations?: StudioChartAnnotation[]` to render `ChartsReferenceLine` markers on bar, line, area, and mixed charts.
Annotations are available in both edit and view mode.
They are not supported for pie, donut, gauge, heatmap, funnel, gantt, or sankey charts.

```ts
type StudioChartAnnotation = {
  id: string;
  axis: 'x' | 'y';
  value: number | string;
  label?: string;
};

const chartConfig: StudioWidgetConfig = {
  chartType: 'line',
  xField: 'month',
  ySeries: [{ fieldId: 'revenue' }],
  annotations: [
    { id: 'target', axis: 'y', value: 100000, label: 'Target' },
    { id: 'launch', axis: 'x', value: '2024-04', label: 'Launch' },
  ],
};
```

## Rendering with `StudioChartWidget`

To render a chart widget outside of the Studio canvas (for example in a preview):

```tsx
import { StudioChartWidget } from '@mui/x-studio';

<StudioChartWidget
  config={chartConfig}
  dataSourceId="orders"
  width={600}
  height={400}
/>;
```

## No data state

When all rows for a chart widget have been filtered out — by a page filter, cross-filter, or adapter returning an empty result — Studio renders a `StudioNoDataOverlay` in place of the empty chart canvas.

The overlay shows a centered inbox icon with a "No data" label in `text.disabled` colour. It appears only after loading is complete so it never flickers during an in-flight adapter fetch.

### Customising the overlay

`StudioNoDataOverlay` is exported from `@mui/x-studio` and accepts a `message` prop. You can pass a fully custom component via the `slots.noDataOverlay` prop on `StudioChartWidget` or at the dashboard level:

```tsx
import { StudioNoDataOverlay } from '@mui/x-studio';

// Custom message using the default look
<StudioChartWidget
  widget={widget}
  dataSource={source}
  slots={{
    noDataOverlay: () => (
      <StudioNoDataOverlay message="No orders match the selected filters" />
    ),
  }}
/>;
```

```tsx
// Fully custom component via Studio's slot chain
function MyEmptyChart() {
  return (
    <Box sx={{ textAlign: 'center', py: 6, color: 'text.disabled' }}>
      <TrendingFlatIcon sx={{ fontSize: 40 }} />
      <Typography variant="body2">Try removing some filters</Typography>
    </Box>
  );
}

<Studio
  slotProps={{
    canvas: {
      slotProps: {
        widgetCard: {
          slotProps: {
            chart: { slots: { noDataOverlay: MyEmptyChart } },
          },
        },
      },
    },
  }}
/>;
```

:::info
The `slots.noDataOverlay` on `StudioChartWidget` is also used when the chart has an unsupported configuration (e.g. missing required fields). If you replace it with a fully custom component, make sure your component handles both the "no data" and "misconfigured" cases, or scope it only to `StudioNoDataOverlay`.
:::

## See also

- [Cross-filters](/x/react-studio/features/cross-filters/) — how chart clicks emit cross-filter events
- [Inline data sources](/x/react-studio/data/data-sources/) — field types recognised by chart axes
- [Measures](/x/react-studio/features/measures/) — pre-aggregated value fields for chart series
- [KPI widget](/x/react-studio/widgets/kpi/) — display a single aggregated value with a sparkline trend
