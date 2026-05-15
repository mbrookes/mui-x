---
title: Studio - Global filters
productId: x-studio
packageName: '@mui/x-studio'
githubLabel: 'scope: studio'
---

# Studio - Global filters

<p class="description">Apply persistent filters across a page or individual widgets — with conditions, multi-select, top-N ranking, and dynamic metric references.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader"}}

## Filter scopes

Every `StudioFilterState` has a `scope` that determines which widgets it affects:

| Scope | Description |
| :--- | :--- |
| `'page'` | Applied to every widget on the current page that has the matching field. |
| `'widget'` | Applied to a single widget, identified by `widgetId`. |
| `'cross-filter'` | Emitted by a user click on a chart or grid. Automatically cleared when the user clicks again. See [Cross-filters](/x/react-studio/features/cross-filters/). |
| `'interactive'` | Emitted by a filter widget (slider, toggle, date range, multi-select). Managed automatically by Studio. |

Use `page` for global constraints (for example, restrict all charts to the current fiscal year). Use `widget` for per-chart overrides (for example, a "Top 5" rank filter on one chart only).

## Condition filters

The most common filter type. Compares a field value against a literal using one of the available operators:

```ts
{
  id: 'year-filter',
  scope: 'page',
  field: 'orderDate',
  fieldType: 'date',
  operator: 'between',
  value: '2024-01-01',
  value2: '2024-12-31',
}
```

### Operators

| Operator | Applies to | Description |
| :--- | :--- | :--- |
| `equals` | all | Field equals value. |
| `not_equals` | all | Field does not equal value. |
| `in` | string, number | Field value is one of an array of values. |
| `contains` | string | Field contains the substring. |
| `does_not_contain` | string | Field does not contain the substring. |
| `starts_with` | string | Field starts with the substring. |
| `not_starts_with` | string | Negated starts-with. |
| `ends_with` | string | Field ends with the substring. |
| `not_ends_with` | string | Negated ends-with. |
| `is_empty` | all | Field is null, undefined, or empty string. |
| `is_not_empty` | all | Field is not null/undefined/empty. |
| `greater_than` | number, date | Field > value. |
| `less_than` | number, date | Field < value. |
| `greater_than_or_equal` | number, date | Field ≥ value. |
| `less_than_or_equal` | number, date | Field ≤ value. |
| `between` | number, date | `value ≤ field ≤ value2`. |

### Compound conditions

Combine two conditions on the same field using `conjunction`:

```ts
{
  id: 'date-range',
  scope: 'page',
  field: 'orderDate',
  operator: 'greater_than_or_equal',
  value: '2024-01-01',
  conjunction: 'and',
  operator2: 'less_than_or_equal',
  value2: '2024-12-31',
}
```

## Rank / top-N filters

Use `filterMode: 'rank'` to keep only the top or bottom N items by a numeric measure:

```ts
{
  id: 'top-10-products',
  scope: 'widget',
  widgetId: 'chart-revenue-by-product',
  field: 'productName',
  filterMode: 'rank',
  rankDirection: 'top',
  value: 10,           // keep top 10
  rankByField: 'revenue',
}
```

| Property | Description |
| :--- | :--- |
| `rankDirection` | `'top'` keeps the highest values; `'bottom'` keeps the lowest. |
| `value` | How many items to keep. |
| `rankByField` | Numeric field to rank by. Required when the filtered field is non-numeric (for example rank product names by their total revenue). |
| `rankMultiSeriesBy` | How to aggregate multi-series values for ranking: `'__sum'`, `'__avg'`, `'__max'`, `'__min'`, or a specific series field ID. |

## Metric references (dynamic values)

Replace a filter's literal `value` with a live lookup from a metrics data source using `valueRef`. This makes filter thresholds data-driven:

```ts
{
  id: 'threshold-filter',
  scope: 'page',
  field: 'daysActive',
  operator: 'greater_than',
  valueRef: {
    sourceId: 'kpi-metrics',   // the data source holding the metric
    rowId: 'BM-012',           // which row
    field: 'value',            // which field on that row
  },
}
```

Whenever the `kpi-metrics` data source updates, the filter threshold automatically re-evaluates. The metrics source is typically declared with `hidden: true` so it doesn't appear in the widget picker.

## Cross-source filters

A page filter can target a field that lives on a related source. Set `filterSourceId` to the source that owns the field. Studio resolves the join path automatically using the declared [relationships](/x/react-studio/data/relationships/):

```ts
{
  id: 'country-filter',
  scope: 'page',
  field: 'country',
  filterSourceId: 'customers', // field is on customers, not orders
  operator: 'equals',
  value: 'Germany',
}
```

## Preloading filters via initialState

Pass filters as part of `initialState` to start the dashboard with pre-applied constraints. Users can still modify them in edit mode unless you hide the Filters drawer.

```tsx
const initialState = createDefaultStudioState({
  filters: [
    {
      id: 'default-year',
      scope: 'page',
      field: 'year',
      operator: 'equals',
      value: 2024,
    },
  ],
});
```

## Reading filter state

```tsx
import { useStudioSelector, selectFilters, selectPartitionedFilters } from '@mui/x-studio';

// All filters
const allFilters = useStudioSelector(selectFilters);

// Pre-bucketed by scope (more efficient for components that only care about one scope)
const { page, byWidgetId, cross, interactive } = useStudioSelector(selectPartitionedFilters);
```
