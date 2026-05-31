---
title: Studio - KPI widget
description: The KPI widget displays a single aggregated metric with an optional sparkline, trend badge, prefix, suffix, and compact formatting.
---

# Studio - KPI widget

<p class="description">The KPI widget displays a single aggregated metric with an optional sparkline, trend badge, prefix, suffix, and compact formatting.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader", "design": false}}

## Overview

`StudioKpiWidget` is designed to surface a single headline number — revenue, user count,
conversion rate, and so on. It reads one numeric field from a data source, aggregates
it, and optionally plots a sparkline using a secondary time-series field.

## Configuration

```ts
interface StudioKpiConfig {
  dataSourceId: string;
  valueField: string; // numeric or measure field id
  aggregation: StudioAggregation; // 'sum' | 'avg' | 'count' | 'min' | 'max'
  label?: string; // card title text (defaults to field label)
  prefix?: string; // rendered before the value, e.g. '$'
  suffix?: string; // rendered after the value, e.g. '%'
  compact?: boolean; // abbreviate large numbers (1 200 000 → 1.2M)
  invertTrend?: boolean; // treat decrease as positive (e.g. for costs)
  sparkline?: StudioKpiSparkline;
}

interface StudioKpiSparkline {
  enabled: boolean;
  xField: string; // date or ordinal field for the time axis
  groupBy?: StudioGroupBy;
}

type StudioAggregation = 'sum' | 'avg' | 'count' | 'min' | 'max';
type StudioGroupBy = 'day' | 'week' | 'month' | 'quarter' | 'year';
```

## Basic example

```ts
const kpiConfig: StudioKpiConfig = {
  dataSourceId: 'orders',
  valueField: 'revenue',
  aggregation: 'sum',
  label: 'Total Revenue',
  prefix: '$',
  compact: true,
};
```

Rendered: **$1.4M** with the label "Total Revenue".

## Prefix and suffix

Use `prefix` and `suffix` for currency symbols, unit labels, and percentage signs.

```ts
const kpiConfig: StudioKpiConfig = {
  dataSourceId: 'sessions',
  valueField: 'conversionRate',
  aggregation: 'avg',
  label: 'Conversion Rate',
  suffix: '%',
};
```

## Compact formatting

Set `compact: true` to abbreviate large numbers using SI suffixes (K, M, B).
The threshold is 10 000 — numbers below that are shown in full.

| Raw value     | Compact display |
| :------------ | :-------------- |
| 999           | 999             |
| 1 234         | 1.23K           |
| 1 200 000     | 1.2M            |
| 4 500 000 000 | 4.5B            |

## Trend badge

When comparing against a previous period is configured (in the Studio sidebar), a
badge below the headline value shows the percentage change and an up/down arrow.
By default, an increase is positive (green) and a decrease is negative (red).

For KPIs where a lower value is better (such as error rate or cost), set
`invertTrend: true` to flip the colour logic.

```ts
const kpiConfig: StudioKpiConfig = {
  dataSourceId: 'incidents',
  valueField: 'errorRate',
  aggregation: 'avg',
  invertTrend: true, // decrease in error rate → green trend badge
};
```

## Sparkline

Add a sparkline to give context over time. Configure a `date` field for `xField` and
choose a time bucket via `groupBy`.

```ts
const kpiConfig: StudioKpiConfig = {
  dataSourceId: 'revenue',
  valueField: 'amount',
  aggregation: 'sum',
  sparkline: {
    enabled: true,
    xField: 'date',
    groupBy: 'month',
  },
};
```

:::info
The sparkline uses the same data source and applies the same active filters. It does
not emit cross-filter events when clicked.
:::

## Target line

Enable `kpiTarget` to draw a horizontal reference line on the sparkline at a target
value. Set `kpiTargetRef` to a `StudioMetricRef`, the same reference type used for
dynamic filter thresholds.

```ts
interface StudioMetricRef {
  sourceId: string;   // ID of the data source containing the metric
  fieldId: string;    // field to read the value from
  rowId?: string;     // optional: specific row ID (for example, a business metric row)
}

{
  kind: 'kpi',
  config: {
    kpiValueField: 'revenue',
    kpiAggregation: 'sum',
    kpiSparkline: true,
    kpiTarget: true,
    kpiTargetRef: {
      sourceId: 'businessMetrics',
      fieldId: 'value',
      rowId: 'BM-REVENUE-TARGET',
    },
  },
}
```

When both `kpiTrend` and `kpiTarget` are enabled, the trend badge compares the
headline value against the target instead of the previous period. The reference line
still appears on the sparkline even when `kpiTrend` is disabled.

:::info
Set `featureFlags.kpiTarget` to `false` to hide this feature in the UI.
:::

## Trend badge styling

The trend badge is displayed as a pill chip: a semi-transparent background in the trend colour (8% alpha) and a 1 px solid border. Green indicates a positive trend, red indicates a negative trend (or vice-versa when `invertTrend` is set).

## Gauge sparkline

Set `sparkline.type` to `'gauge'` to render the KPI sparkline as a radial gauge instead of a line/area chart:

```ts
const kpiConfig: StudioKpiConfig = {
  dataSourceId: 'revenue',
  valueField: 'amount',
  aggregation: 'sum',
  sparkline: {
    enabled: true,
    type: 'gauge',
    min: 0,
    max: 1000000,
  },
};
```

The gauge renders using `@mui/x-charts` `<Gauge>` with the current aggregated value mapped between `min` and `max`.

## Rendering with `StudioKpiWidget`

```tsx
import { StudioKpiWidget } from '@mui/x-studio';

<StudioKpiWidget config={kpiConfig} width={300} height={160} />;
```

## Resize behaviour

KPI widgets can be resized horizontally via the drag handle that appears between adjacent widgets in edit mode.

| Configuration      | Minimum column span |
| :----------------- | :------------------ |
| With sparkline     | 6 columns (25%)     |
| Without sparkline  | 4 columns (~17%)    |

Disabling the sparkline allows the KPI card to be resized down to 4 columns (one-sixth of the 24-column grid), useful when several metrics need to fit side-by-side in a compact row.

## See also

- [Measures](/x/react-studio/features/measures/) — define pre-aggregated metrics that appear in the KPI value picker
- [Global filters](/x/react-studio/features/global-filters/) — filters applied before KPI aggregation
- [Chart widget](/x/react-studio/widgets/chart/) — visualise the same metric over time as a series
- [Inline data sources](/x/react-studio/data/data-sources/) — `aggregatable: true` marks fields for KPI use
