---
title: Studio - Relationships
productId: x-studio
packageName: '@mui/x-studio'
githubLabel: 'scope: studio'
---

# Studio - Relationships

<p class="description">Declare foreign-key relationships between data sources so Studio can join them for calculated columns, cross-source filters, and KPI lookups.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader"}}

## Overview

A relationship links two data sources along a foreign key. Once declared, Studio uses the relationship automatically wherever a widget references a field from a related source — including expression fields, cross-source filter resolution, and KPI sparklines.

## StudioRelationship

```ts
interface StudioRelationship {
  id: string;
  sourceId: string; // The "many" side (e.g. 'orders')
  sourceField: string; // FK field on the many side (e.g. 'customerId')
  targetId: string; // The "one" side (e.g. 'customers')
  targetField: string; // PK field on the one side (e.g. 'id')
  type: 'many-to-one' | 'one-to-one';
}
```

| Property      | Description                                                                       |
| :------------ | :-------------------------------------------------------------------------------- |
| `id`          | Unique stable identifier for the relationship.                                    |
| `sourceId`    | The "many" side — the source that holds the foreign key.                          |
| `sourceField` | The FK field name on the many side.                                               |
| `targetId`    | The "one" side — the lookup / dimension source.                                   |
| `targetField` | The PK field name on the one side.                                                |
| `type`        | `'many-to-one'` for typical FK lookups; `'one-to-one'` for 1:1 enrichment tables. |

## Declaring relationships

Pass relationships as part of `initialState` or set them from the data drawer in edit mode.

```tsx
import { Studio, createDefaultStudioState } from '@mui/x-studio';

const initialState = createDefaultStudioState({
  relationships: [
    {
      id: 'orders-customers',
      sourceId: 'orders', // orders.customerId → customers.id
      sourceField: 'customerId',
      targetId: 'customers',
      targetField: 'id',
      type: 'many-to-one',
    },
    {
      id: 'orders-products',
      sourceId: 'orders', // orders.productId → products.id
      sourceField: 'productId',
      targetId: 'products',
      targetField: 'id',
      type: 'many-to-one',
    },
  ],
});

const dataSources = [
  { id: 'orders', label: 'Orders', fields: ordersFields, rows: ordersRows },
  {
    id: 'customers',
    label: 'Customers',
    fields: customersFields,
    rows: customersRows,
  },
  { id: 'products', label: 'Products', fields: productsFields, rows: productsRows },
];

<Studio initialState={initialState} dataSources={dataSources} />;
```

## What relationships enable

### Join field expressions

A `StudioJoinFieldExpression` pulls a field value from a related source via the declared relationship. Use it in a calculated column to denormalise a dimension attribute onto the fact rows:

```ts
// A calculated column on 'orders' that brings in the customer's region
const customerRegion: StudioExpressionField = {
  id: 'customer-region',
  label: 'Customer Region',
  sourceId: 'orders',
  isMeasure: false,
  expression: {
    joinSourceId: 'customers', // target source
    fieldId: 'region', // field on customers
  },
};
```

Studio resolves the path `orders.customerId → customers.id` automatically — no explicit relationship ID needed in the expression.

### Cross-source widget filters

A filter can target a field that belongs to a related source. Studio walks the declared relationships to translate the filter value into the correct row subset for the widget's primary source:

```ts
// A page filter on orders filtered by customers.country
{
  id: 'country-filter',
  field: 'country',
  filterSourceId: 'customers', // field lives here
  operator: 'equals',
  value: 'Germany',
  scope: 'page',
}
```

### KPI sparklines from related sources

When a KPI's sparkline time field lives on a related source, declare `kpiSparklineSourceId` in the widget config to point Studio at the right source for the time axis.

## L4: Cross-source chart aggregation

When a chart widget's y-field (or series field) lives on a related source, Studio runs an extra pipeline layer — **L4** — after the standard filter pass.

L4 re-projects the already-filtered rows onto the correct aggregation grain.
For example, if a chart is on the `order_items` source but the y-field is `orders.revenue`, Studio uses the declared `order_items → orders` relationship to join, then re-groups by the chart's x-field.

This happens automatically and requires no extra configuration beyond the relationship declaration.
L4 is only applied when a cross-source join is actually required — if all widget fields live on the primary source, it is skipped entirely.

To observe L4 in isolation, use [`createStudioPipeline`](/x/react-studio/resources/pipeline/#createstudiopipeline) outside React:

```ts
import { createStudioPipeline } from '@mui/x-studio';

const pipeline = createStudioPipeline(controller.getState());

// L3: filter to the widget's effective rows
const filtered = pipeline.resolveWidgetRows(
  widget.id,
  widget.sourceId,
  source.rows,
  activePageId,
);

// L4: re-anchor to the correct aggregation grain for the chart
const chartRows = pipeline.resolveChartRows(
  filtered,
  widget.sourceId,
  xField,
  yFields,
  seriesField,
);
```

## Hidden join-only sources

If a dimension source should not appear in the widget picker (because users should never chart it directly), set `hidden: true` on its `StudioDataSource`:

```tsx
{
  id: 'customers',
  label: 'Customers',
  fields: customersFields,
  rows: customersRows,
  hidden: true, // won't appear in Add Widget source select
}
```

## Using with async adapters

Relationships work with async adapters too. The adapter receives the full `StudioQueryDescriptor` including any cross-source filter conditions. Resolve them server-side using the declared foreign keys, or expand them into a WHERE clause that joins the tables.

## See also

- [Inline data sources](/x/react-studio/data/data-sources/) — define the sources that relationships connect
- [Cross-filters](/x/react-studio/features/cross-filters/) — cross-filter emission resolved across related sources automatically
- [Calculated columns](/x/react-studio/features/calculated-columns/) — expression fields can reference joined sources via `StudioJoinFieldExpression`
