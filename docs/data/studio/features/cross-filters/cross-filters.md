---
title: Studio - Cross-filters
productId: x-studio
packageName: '@mui/x-studio'
githubLabel: 'scope: studio'
---

# Studio - Cross-filters

<p class="description">Clicking a chart bar or a grid row filters every other widget on the page — wiring interactive exploration without any custom code.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader"}}

## How cross-filters work

When a user clicks a data point on a chart or selects a row in a grid, Studio emits a `cross-filter` scoped `StudioFilterState` into the global filter array. Every other widget on the same page that shares the filtered field (or has a join path to the source) automatically re-queries its rows through that filter. Clicking the same item again, or clicking the close button on the filter chip, clears the cross-filter.

The source widget shows a dismissible chip next to its title indicating the active filter value (for example **Category = Electronics**).

## Charts

Any chart that has a categorical x-axis emits a cross-filter when a bar, line point, or pie slice is clicked. The filter field is the chart's x-axis field.

Cross-filter emission is automatic — no configuration needed for the chart itself. Charts that are receiving a cross-filter from another widget also show the chip and honour the filter in their own data query.

## Grids

Grid cross-filters are opt-in. Set `crossFilterField` in the widget config to the column whose value should be emitted when a row is clicked:

```ts
// widget config
{
  crossFilterField: 'category', // clicking a row emits category = <value>
}
```

When `crossFilterField` is not set, clicking a row does nothing (the grid remains a passive receiver of cross-filters from other widgets).

## Receiving cross-filters

All widgets automatically receive and apply cross-filters that target a field in their data source. No configuration is required on the receiving side.

If the cross-filter's field lives on a related source, Studio walks the declared [relationships](/x/react-studio/data/relationships) to resolve the filter. For example, an orders grid receives a cross-filter on `customers.country` and Studio resolves the FK path `orders.customerId → customers.id` to filter the orders rows automatically.

## Dismissing a cross-filter

Click the **×** on the chip next to the source widget's title, or click the same data point again. Both clear the cross-filter and restore all widgets to their unfiltered state.

## Cross-filter state

Cross-filters are stored in `state.filters` with `scope: 'cross-filter'`:

```ts
{
  id: 'cf-1',
  scope: 'cross-filter',
  field: 'category',
  operator: 'equals',
  value: 'Electronics',
  sourceWidgetId: 'chart-1',  // the widget that emitted it
  pageId: 'page-1',
}
```

You can read active cross-filters using `selectPartitionedFilters`:

```tsx
import { useStudioSelector, selectPartitionedFilters } from '@mui/x-studio';

function CrossFilterBadge() {
  const { cross } = useStudioSelector(selectPartitionedFilters);
  return cross.length > 0 ? <span>{cross.length} active</span> : null;
}
```

## Disabling cross-filters

To prevent a specific widget from receiving cross-filters, there is currently no per-widget opt-out flag — all widgets on the page participate. If you need to isolate a widget, place it on a separate page.
