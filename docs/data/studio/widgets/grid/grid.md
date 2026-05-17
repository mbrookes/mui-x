---
title: Studio - Grid widget
description: The grid widget renders a data table with configurable columns, sorting, filtering, CSV export, and an optional summary row.
---

# Studio - Grid widget

<p class="description">The grid widget renders a data table with configurable columns, sorting, filtering, CSV export, and an optional summary row.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader", "design": false}}

## Overview

`StudioGridWidget` wraps the MUI X Data Grid to render tabular data from a Studio
data source. Users can configure which columns to show, their order, and their
width in the Studio sidebar. The grid participates in cross-filter emission and
respects all active global filters.

## Configuration

```ts
interface StudioGridConfig {
  dataSourceId: string;
  columns: StudioGridColumn[];
  defaultPageSize?: number;  // rows per page; defaults to 25
  showSummaryRow?: boolean;  // aggregate row pinned at the bottom
  exportCsv?: boolean;       // show CSV export toolbar button
}

interface StudioGridColumn {
  field: string;             // field id from the data source
  headerName?: string;       // display label (defaults to field label)
  width?: number;            // pixel width
  flex?: number;             // flex ratio when set alongside other flex columns
  type?: StudioColumnType;   // overrides the field type for rendering
  aggregation?: StudioAggregation; // aggregation for the summary row
  hide?: boolean;            // hidden by default; user can re-enable via column menu
}

type StudioColumnType = 'string' | 'number' | 'date' | 'boolean';
type StudioAggregation = 'sum' | 'avg' | 'count' | 'min' | 'max';
```

## Basic example

```ts
const gridConfig: StudioGridConfig = {
  dataSourceId: 'orders',
  columns: [
    { field: 'orderId', headerName: 'Order ID', width: 120 },
    { field: 'customer', headerName: 'Customer', flex: 1 },
    { field: 'date', headerName: 'Date', width: 120, type: 'date' },
    { field: 'amount', headerName: 'Amount ($)', width: 130, type: 'number' },
  ],
  defaultPageSize: 50,
};
```

## Summary row

Enable `showSummaryRow: true` and add an `aggregation` value to each numeric column
to display an aggregate row pinned to the bottom of the grid.

```ts
const gridConfig: StudioGridConfig = {
  dataSourceId: 'orders',
  columns: [
    { field: 'customer', headerName: 'Customer', flex: 1 },
    { field: 'amount', headerName: 'Amount ($)', width: 130, aggregation: 'sum' },
    { field: 'items', headerName: 'Items', width: 100, aggregation: 'sum' },
  ],
  showSummaryRow: true,
};
```

## CSV export

Set `exportCsv: true` to show a toolbar with a **Download CSV** button. The export
respects current sorting, filtering, and the column set visible to the user.

```ts
const gridConfig: StudioGridConfig = {
  dataSourceId: 'transactions',
  columns: [/* ... */],
  exportCsv: true,
};
```

## Cross-filter emission

When a user selects a row, the grid emits a cross-filter for the values in the
row's fields. Other widgets on the same page that share the same `dataSourceId`
react automatically.

:::info
Row selection must be enabled (`checkboxSelection` or single-click selection)
for cross-filter emission to trigger. This is controlled in the Studio sidebar.
:::

## Sorting and filtering

The grid supports column-header click sorting and MUI X Data Grid column filters.
These operate on the already-materialised data — for large async datasets, delegate
sorting and filtering to your server via the [async adapter](/x/react-studio/data/async-adapters/).

## Rendering with `StudioGridWidget`

```tsx
import { StudioGridWidget } from '@mui/x-studio';

<StudioGridWidget
  config={gridConfig}
  width={800}
  height={500}
/>
```

## Empty state

When all rows are filtered out, `StudioGridWidget` shows a `StudioNoDataOverlay` (inbox icon + "No data" label) in place of the default "No rows" text that DataGridPro renders by default.

While data is being fetched from an async adapter, the grid shows the DataGridPro loading skeleton (`loading` prop) to distinguish an in-progress fetch from a genuinely empty result set.

### Customising the empty overlay

Pass a custom component via `slotProps.grid.slotProps.dataGrid.slots.noRowsOverlay`:

```tsx
import { StudioNoDataOverlay } from '@mui/x-studio';

// Custom message using the default look
<Studio
  slotProps={{
    canvas: {
      slotProps: {
        widgetCard: {
          slotProps: {
            grid: {
              slotProps: {
                dataGrid: {
                  slots: {
                    noRowsOverlay: () => (
                      <StudioNoDataOverlay message="No results — try adjusting filters" />
                    ),
                  },
                },
              },
            },
          },
        },
      },
    },
  }}
/>
```

## See also

- [Cross-filters](/x/react-studio/features/cross-filters/) — how row selection emits cross-filter events to other widgets
- [Async adapters](/x/react-studio/data/async-adapters/) — server-side sorting, filtering, and pagination for large datasets
- [Global filters](/x/react-studio/features/global-filters/) — page-level filters applied before grid rendering
- [Chart widget](/x/react-studio/widgets/chart/) — companion chart driven by the same data source
