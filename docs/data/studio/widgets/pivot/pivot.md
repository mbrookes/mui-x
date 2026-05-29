---
title: Studio - Pivot widget
description: The pivot table widget cross-tabulates rows and columns from a Studio data source.
---

# Studio - Pivot widget

<p class="description">The pivot table widget cross-tabulates rows and columns from a Studio data source.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader", "design": false}}

## Overview

`StudioPivotWidget` renders a cross-tabulated summary table.
Given a row field, a column field, and an optional value field, it groups data along both axes and calculates an aggregate for each cell.

Pivot tables are useful when you want to compare multiple categories simultaneously — for example, sales by month (rows) and by region (columns).

## Configuration

Configure a pivot widget through the **Setup** tab in the compose sidebar:

| Property | Description |
| :--- | :--- |
| **Row field** | The field whose unique values appear as row labels. |
| **Column field** | The field whose unique values appear as column headers. |
| **Value field** | The numeric field to aggregate in each cell. When omitted, the widget counts rows. |
| **Aggregation** | How to combine multiple values in a cell: `Sum`, `Average`, `Count`, `Min`, or `Max`. Defaults to `Sum`. |
| **Show totals** | Adds a grand-total row and column. Enabled by default. |

## Programmatic configuration

The pivot widget config uses the following shape in the Studio state:

```ts
interface StudioWidgetConfig {
  // ...shared fields...
  pivotRowField?: string;    // field ID for row dimension
  pivotColField?: string;    // field ID for column dimension
  pivotValueField?: string;  // field ID for value cells (optional)
  pivotAggregation?: 'sum' | 'avg' | 'count' | 'min' | 'max';
  pivotShowTotals?: boolean;
}
```

## Export

Click the **Download** button in the top-right of the widget card to export the pivot table as a CSV file.
The exported CSV includes all row and column headers plus totals if **Show totals** is enabled.

## Performance

All pivot computation happens in-browser in the Studio data pipeline.
For datasets with more than a few thousand rows, prefer an async adapter that returns pre-aggregated data — the pivot widget will use the same aggregation path whether data comes from inline rows or an adapter.

See [Async adapters](/x/react-studio/data/async-adapters/) for guidance on server-side aggregation.

## See also

- [Widgets overview](/x/react-studio/widgets/) — all built-in widget types
- [Async adapters](/x/react-studio/data/async-adapters/) — server-side data for large datasets
- [Global filters](/x/react-studio/features/global-filters/) — apply page-level filters to pivot tables
