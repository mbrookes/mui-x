---
title: Studio - Measures
productId: x-studio
packageName: '@mui/x-studio'
githubLabel: 'scope: studio'
---

# Studio - Measures

<p class="description">Define reusable aggregate metrics — total revenue, average order value, conversion rate — that automatically respect the active filters on the page.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader"}}

## What is a measure?

A measure is a `StudioExpressionField` with `isMeasure: true`. Unlike a [calculated column](/x/react-studio/features/calculated-columns/) (which runs once per row), a measure aggregates the **entire filtered dataset** down to a single scalar value.

Measures are ideal for KPI tiles: the headline number you see in a card is typically a measure — Total Revenue, Average Order Size, Unique Customers, and so on.

## StudioExpressionField (measure)

```ts
interface StudioExpressionField {
  id: string;
  label: string;
  sourceId: string;
  isMeasure: true;            // aggregate measure
  expression: StudioExpression;
  type?: 'number' | 'string' | 'boolean';
  format?: StudioNumberFormat;
  currencyCode?: string;
  hidden?: boolean;
}
```

## Aggregation operators

Use the aggregate operators inside the expression tree. They accept a field reference and compute over all rows in the current filtered view:

| Operator | Description |
| :--- | :--- |
| `sum` | Sum of all non-null values. |
| `avg` | Arithmetic mean. |
| `count` | Count of non-null values. |
| `min` | Minimum value. |
| `max` | Maximum value. |

```ts
// Total revenue measure
{
  id: 'total-revenue',
  label: 'Total Revenue',
  sourceId: 'orders',
  isMeasure: true,
  format: 'currency',
  currencyCode: 'USD',
  expression: {
    operator: 'sum',
    args: [{ id: 'revenue' }],
  },
}
```

## Composite measures

Combine aggregate sub-expressions with arithmetic to create derived metrics:

```ts
// Average order value = Total Revenue ÷ Order Count
{
  id: 'aov',
  label: 'Avg Order Value',
  sourceId: 'orders',
  isMeasure: true,
  format: 'currency',
  currencyCode: 'USD',
  expression: {
    operator: 'divide',
    args: [
      { operator: 'sum', args: [{ id: 'revenue' }] },
      { operator: 'count', args: [{ id: 'id' }] },
    ],
  },
}
```

## Using measures in KPI widgets

Set a KPI's `kpiValueField` to a measure ID and `kpiAggregation` to `'sum'` (the aggregation inside the measure itself takes effect; the widget-level aggregation is ignored when the field is a measure):

```ts
// widget config
{
  kpiValueField: 'total-revenue',
  kpiAggregation: 'sum',
}
```

## Using measures in rank filters

Rank a categorical dimension by a measure using `filterMode: 'rank'`:

```ts
{
  id: 'top-10-categories',
  scope: 'widget',
  widgetId: 'chart-revenue-by-category',
  field: 'category',
  filterMode: 'rank',
  rankDirection: 'top',
  value: 10,
  rankByField: 'total-revenue', // a measure ID
}
```

## Filter-awareness

Measures automatically respect the active `page` and `widget` scoped filters. When the user adjusts a date range slider or a multi-select filter widget, all KPIs that use measures on the same source immediately recompute.

Cross-filters also apply: clicking a chart bar to filter the page causes all measure KPIs to recompute against the filtered row set.

## Preloading measures

```tsx
const initialState = createDefaultStudioState({
  expressionFields: [
    {
      id: 'total-revenue',
      label: 'Total Revenue',
      sourceId: 'orders',
      isMeasure: true,
      format: 'currency',
      currencyCode: 'USD',
      expression: { operator: 'sum', args: [{ id: 'revenue' }] },
    },
    {
      id: 'aov',
      label: 'Avg Order Value',
      sourceId: 'orders',
      isMeasure: true,
      format: 'currency',
      currencyCode: 'USD',
      expression: {
        operator: 'divide',
        args: [
          { operator: 'sum', args: [{ id: 'revenue' }] },
          { operator: 'count', args: [{ id: 'id' }] },
        ],
      },
    },
  ],
});
```

Measures appear in KPI value pickers alongside physical fields for the matching source.
