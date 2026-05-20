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

Cross-filter emission is automatic — no configuration needed for the chart itself. Charts that are receiving a cross-filter from another widget also show the chip and honor the filter in their own data query.

### Pie chart highlight

When a cross-filter is active, pie charts render a ghost layer (the full unfiltered
dataset at 20% opacity) underneath the filtered slices, so the full picture remains
visible. Each slice also gets a proportional overlay arc: the arc covers the fraction
of the slice angle that corresponds to the filtered value versus the baseline.

For example, if a country's total revenue is $100 K and the cross-filtered subset
accounts for $43 K, the overlay arc covers 43% of that slice's angle. This gives an
immediate visual read of what proportion of each category matches the active filter.

## Grids

Grid cross-filters are opt-in. Set `crossFilterField` in the widget config to the column whose value should be emitted when a row is clicked:

```ts
// widget config
{
  crossFilterField: 'category', // clicking a row emits category = <value>
}
```

When `crossFilterField` is not set, clicking a row does nothing (the grid remains a passive receiver of cross-filters from other widgets).

## Table cross-filter recipient

By default, when a chart cross-filter is active, the table dims non-matching rows
to 30% opacity while keeping them visible. This is `crossFilterMode: 'cross-highlight'`.

Set `crossFilterMode: 'cross-filter'` to hide non-matching rows entirely:

```ts
{
  crossFilterMode: 'cross-filter', // non-matching rows are hidden
}
```

Set `crossFilterMode: 'none'` to make the table ignore all incoming cross-filters.

:::info
Interactive filter-widget selections (from the Filters panel) always hard-filter
the table regardless of `crossFilterMode`. This matches Tableau and Power BI
behavior: explicit user selections are always enforced.
:::

## Receiving cross-filters

All widgets automatically receive and apply cross-filters that target a field in their data source. No configuration is required on the receiving side.

If the cross-filter's field lives on a related source, Studio walks the declared [relationships](/x/react-studio/data/relationships/) to resolve the filter. For example, an orders grid receives a cross-filter on `customers.country` and Studio resolves the FK path `orders.customerId → customers.id` to filter the orders rows automatically.

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

## Per-widget cross-filter mode

By default, when a widget receives a cross-filter it **dims** non-matching data points while keeping them visible. This is called _cross-highlight_ mode. You can change this behavior per widget using `crossFilterMode` in the widget config:

```ts
{
  crossFilterMode: 'cross-highlight', // default — dims non-matching data, keeps them visible
  crossFilterMode: 'cross-filter',    // hides non-matching data entirely (true filtering)
  crossFilterMode: 'none',            // widget ignores all incoming cross-filters
}
```

| Value | Behavior |
| :--- | :--- |
| `'cross-highlight'` | Non-matching data points are dimmed/greyed. The full dataset is still visible. This is the default for all widgets. |
| `'cross-filter'` | Non-matching rows are removed. Only rows that match the cross-filter are shown. Use this to build filter widgets that enforce a strict selection. |
| `'none'` | The widget ignores incoming cross-filters entirely. Use this to keep a reference widget always showing the full picture while others react to user clicks. |

### Example — strictly filtered widget

```ts
const config: StudioWidgetConfig = {
  xField: 'country',
  yField: 'revenue',
  crossFilterMode: 'cross-filter', // clicking a country bar hides all other countries
};
```

### Example — reference widget

```ts
const config: StudioWidgetConfig = {
  xField: 'date',
  yField: 'total',
  crossFilterMode: 'none', // always shows the full time series regardless of cross-filters
};
```

The `crossFilterMode` setting does not affect cross-filter _emission_ — it only changes how the widget _responds_ to filters emitted by other widgets.

The mode can be changed at runtime (it is persisted in widget config):

```ts
studioRef.current?.updateWidget('chart-revenue', (w) => ({
  ...w,
  config: { ...w.config, crossFilterMode: 'cross-filter' },
}));
```

Users can also change it from the widget's settings panel in edit mode.

## Disabling cross-filters

To prevent a specific widget from receiving any cross-filters, set `crossFilterMode: 'none'` in its config. To prevent all widgets on a page from participating, place the widgets on a separate page.

## Using cross-filter state in custom widgets

When building a [custom widget](/x/react-studio/getting-started/composition/), use `useWidgetRows` to get the row arrays that already have cross-filters applied. Three outputs are relevant:

| Output | Description |
| :--- | :--- |
| `effectiveRows` | The rows the widget should render — respects `crossFilterMode` automatically. |
| `filteredRowsNoCross` | Rows with page and widget filters only (no cross-filters). Useful as a ghost/background dataset when `shouldShowGhost` is true. |
| `filteredRowsNoChartCross` | Rows with page, widget, and interactive filters applied, but NOT chart-click cross-filters. Use as the baseline for table cross-highlight (interactive selections always hard-filter). Same reference as `effectiveRows` when no chart cross-filter is active. |
| `shouldShowGhost` | `true` when the widget should render a dimmed background layer. Only set when `crossFilterMode === 'cross-highlight'` (the default) **and** a chart-click cross-filter is active. Interactive filter-widget selections never trigger ghost rendering. |
| `hasCrossFilters` | `true` when at least one incoming cross-filter or interactive filter is active for this widget on the current page. |
| `hasChartCrossFilters` | `true` when at least one chart-click cross-filter is active for this widget. |

```tsx
import { useWidgetRows } from '@mui/x-studio';

function MyChartWidget({ widget, dataSource }) {
  const { effectiveRows, filteredRowsNoCross, shouldShowGhost } = useWidgetRows(widget, dataSource);

  return (
    <div style={{ position: 'relative' }}>
      {shouldShowGhost && (
        <MyChart rows={filteredRowsNoCross} style={{ opacity: 0.25, position: 'absolute', inset: 0 }} />
      )}
      <MyChart rows={effectiveRows} />
    </div>
  );
}
```

Note: `filteredRowsNoCross` returns the same reference as `effectiveRows` when there are no active cross-filters, so the ghost layer is zero-cost when unused.

## See also

- [Global filters](/x/react-studio/features/global-filters/) — page-level and widget-level condition filters
- [Relationships](/x/react-studio/data/relationships/) — cross-filter emission resolved across related sources automatically
