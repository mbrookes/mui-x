---
title: Studio - Grid widget
description: The grid widget renders a data table with configurable columns, sorting, filtering, CSV export, and an optional summary row.
---

# Studio - Grid widget

<p class="description">The grid widget renders a data table from a data source, with configurable columns, sorting, grouping, aggregation, CSV export, and cross-filter support.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader", "design": false}}

## Overview

`StudioGridWidget` wraps the MUI X Data Grid to render tabular data from a Studio
data source. Configure which columns to show, their order, default sort, grouping,
and aggregation in the Studio sidebar. The table participates in cross-filter
emission and responds to cross-filters from other widgets.

## Columns

Each column in the `columns` array is described by a `StudioGridColumn`:

```ts
interface StudioGridColumn {
  fieldId: string; // field ID from the data source
  sourceId?: string; // omit for the primary source; set for cross-source columns
}
```

The `fieldId` maps to a field declared on the data source. When `sourceId` is
omitted the column comes from the widget's primary data source.

## Cross-source columns

Tables can display columns from related (many-to-one) data sources alongside
primary-source columns. Add a column with both `fieldId` and `sourceId` to pull
in a field from a different source that is joined to the primary source via a
[relationship](/x/react-studio/data/relationships/).

```ts
// Primary source: 'orders'. Related source: 'customers' (orders.customerId → customers.id)
const columns: StudioGridColumn[] = [
  { fieldId: 'orderId' },
  { fieldId: 'amount' },
  { fieldId: 'country', sourceId: 'customers' }, // field from the related source
];
```

Studio resolves the join path automatically using the declared relationship. The
column renders `customers.country` for each order row without any extra wiring.

## Summary row

Pin a per-column aggregation row at the bottom of the table using `gridSummaryFields`:

```ts
{
  gridSummaryFields: {
    amount: 'sum',
    quantity: 'sum',
    unitPrice: 'avg',
    orderId: 'count',
  },
}
```

Supported aggregations: `'sum'`, `'avg'`, `'count'`, `'min'`, `'max'`.

## Conditional formatting

Use `gridConditionalFormats` to apply rule-based styles to cells. Each rule targets
one field, checks a condition, and applies a style when the condition matches.

```ts
interface StudioConditionalFormat {
  fieldId: string;
  operator:
    | 'equals'
    | 'not_equals'
    | 'greater_than'
    | 'less_than'
    | 'greater_than_or_equal'
    | 'less_than_or_equal'
    | 'contains'
    | 'is_empty'
    | 'is_not_empty';
  value?: unknown;
  style: {
    backgroundColor?: string;
    color?: string;
    fontWeight?: 'bold' | 'normal';
  };
}

{
  gridConditionalFormats: [
    {
      fieldId: 'margin',
      operator: 'less_than',
      value: 0,
      style: {
        backgroundColor: '#fde8e8',
        color: '#c62828',
        fontWeight: 'bold',
      },
    },
    {
      fieldId: 'margin',
      operator: 'greater_than_or_equal',
      value: 0.2,
      style: {
        backgroundColor: '#e8f5e9',
        color: '#2e7d32',
      },
    },
  ],
}
```

Rules are evaluated in order, and the first matching rule wins. Use `is_empty` and
`is_not_empty` when you only need to test whether a cell has a value — these
operators do not use the `value` field.

:::info
Set `featureFlags.gridConditionalFormats` to `false` to hide this feature in the UI.
:::

## Group by

Group rows by a field value and aggregate the remaining columns:

```ts
{
  gridGroupByField: 'category',
  gridAggregations: {
    revenue: 'sum',
    orders: 'count',
    avgValue: 'avg',
  },
}
```

When `gridGroupByField` is set, each unique value of that field becomes a group row.
Columns listed in `gridAggregations` show the aggregated value; other columns are blank.

## Default sort

Set the initial sort column and direction:

```ts
{
  gridSortField: 'createdAt',
  gridSortDirection: 'desc', // 'asc' | 'desc'
}
```

Users can still click column headers to override the sort at runtime.

## Cross-filter emission

When a row is clicked, the table emits a cross-filter for the field specified by
`crossFilterField`. All other widgets on the same page that share the filtered field
(or can resolve it through a relationship) react automatically.

```ts
{
  crossFilterField: 'category', // clicking a row emits category = <row value>
}
```

If `crossFilterField` is not set, the first visible column is used by default.

## Cross-filter recipient

The table responds to incoming cross-filters emitted by charts and other widgets.
The behavior is controlled by `crossFilterMode` in the widget config:

```ts
{
  crossFilterMode: 'cross-highlight', // default — dims non-matching rows (30% opacity)
  crossFilterMode: 'cross-filter',    // hides non-matching rows entirely
  crossFilterMode: 'none',            // ignores all incoming cross-filters
}
```

| Value | Behavior |
| `'cross-filter'` | Non-matching rows are hidden. Only rows that match the cross-filter are shown. |
| `'none'` | The table ignores all incoming cross-filters entirely. |

:::info
Interactive filter-widget selections (from the Filters panel) always hard-filter the
table regardless of `crossFilterMode`. This matches Tableau and Power BI behavior:
explicit filter selections are always enforced.
:::

## Table source mode

The `tableSourceMode` prop on `Studio` (or `StudioComposeDrawer`) controls how the
data source is chosen in the table setup panel:

- `'explicit'` (default) — a data source picker appears at the top of the setup
  panel. The user must choose a source before adding columns.
- `'implicit'` — no source picker is shown. The source is inferred from the first
  column the user adds (Tableau / Power BI style). Removing all columns resets
  the source.

See [`Studio.tableSourceMode`](/x/react-studio/getting-started/studio/#tablesourcemode)
for details.

## Full config example

```ts
const widgetConfig = {
  // Columns — mix of primary-source and cross-source
  columns: [
    { fieldId: 'orderId' },
    { fieldId: 'createdAt' },
    { fieldId: 'amount' },
    { fieldId: 'country', sourceId: 'customers' },
  ],

  // Summary row: total amount, order count
  gridSummaryFields: {
    amount: 'sum',
    orderId: 'count',
  },

  // Default sort: newest orders first
  gridSortField: 'createdAt',
  gridSortDirection: 'desc',

  // Cross-filter emission: clicking a row filters by category
  crossFilterField: 'category',

  // Cross-filter receipt: dim non-matching rows when a chart is clicked
  crossFilterMode: 'cross-highlight',
};
```

## See also

- [Cross-filters](/x/react-studio/features/cross-filters/) — cross-filter emission and receipt across widgets
- [Relationships](/x/react-studio/data/relationships/) — cross-source columns and FK resolution
- [Async adapters](/x/react-studio/data/async-adapters/) — server-side sorting, filtering, and pagination
- [Calculated columns](/x/react-studio/data/calculated-columns/) — derived fields computed from existing data
