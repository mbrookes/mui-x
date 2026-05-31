---
title: Studio — Date range filter
productId: x-studio
packageName: '@mui/x-studio'
githubLabel: 'scope: studio'
---

# Studio — Date range filter

<p class="description">A date range bar above the canvas lets viewers filter all widgets by a single date range with preset shortcuts.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader"}}

## Overview

`StudioDateRangeBar` renders above the canvas when at least one visible `date` or `datetime` field exists in the registered data sources.
It combines a field selector with preset shortcuts: **All time**, **YTD**, **This month**, **Last 3 months**, and **Last 12 months**.

Selecting a preset creates a page-level filter tagged with `isDashboardDateRange: true`.
The filter is hidden from the filters drawer and the quick-filter bar.
Selecting **All time** removes the filter.

## Stored filter shape

The date range bar writes into the regular `state.filters` array, so it is serialized with the rest of the dashboard state.
The stored filter uses `scope: 'page'`, `operator: 'between'`, and `isDashboardDateRange: true`:

```ts
{
  id: 'dashboard-date-range-page-1',
  scope: 'page',
  pageId: 'page-1',
  isDashboardDateRange: true,
  dateRangePreset: 'last_3_months',
  field: 'orderDate',
  fieldType: 'date',
  filterSourceId: 'orders',
  filterMode: 'condition',
  operator: 'between',
  value: {
    from: '2026-01-01',
    to: '2026-03-31',
  },
}
```

The selected field is kept in local component state, so switching to **All time** clears the filter without forgetting the user's last field selection.

## Preset helper

`computeDateRangePreset` is exported for custom integrations:

```ts
import { computeDateRangePreset } from '@mui/x-studio';

const { from, to } = computeDateRangePreset('last_3_months');
```

`computeDateRangePreset()` returns ISO date strings for `'this_month'`, `'last_3_months'`, `'last_12_months'`, and `'ytd'`.

## Localization

The preset labels are driven by `localeText` tokens:

- `dateRangePresetAllTime`
- `dateRangePresetYTD`
- `dateRangePresetThisMonth`
- `dateRangePresetLast3Months`
- `dateRangePresetLast12Months`

See [Localization](/x/react-studio/customization/localization/) for the full token list.

## Feature flags

`featureFlags.dateRangeBar` (default: `true`) controls whether the date range bar is rendered by `StudioCanvas`. Set it to `false` to hide the bar:

```tsx
<Studio
  featureFlags={{ dateRangeBar: false }}
  // ...
/>
```

When `dateRangeBar` is `false` and an active dashboard date-range filter exists, the quick-filter bar surfaces those filters as removable chips so they remain visible and can be cleared.

`featureFlags.filters` hides the filters drawer and the quick-filter bar.
`StudioDateRangeBar` is rendered by `StudioCanvas`, so composed apps that want to hide every filter control should omit that bar explicitly.

## Widget example

Any widget that shares the selected date field will react to the dashboard date range.
For example, a line chart grouped by month:

```ts
const widget = {
  id: 'revenue-by-month',
  kind: 'chart',
  title: 'Revenue by month',
  sourceId: 'orders',
  config: {
    chartType: 'line',
    xField: 'orderDate',
    xGroupBy: 'month',
    yField: 'revenue',
    yAggregation: 'sum',
  },
};
```

## See also

- [Global filters](/x/react-studio/features/global-filters/) — page-level filter state and operators
- [Localization](/x/react-studio/customization/localization/) — override preset labels
