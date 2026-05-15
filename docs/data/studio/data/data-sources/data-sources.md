---
title: Studio - Inline data sources
productId: x-studio
packageName: '@mui/x-studio'
githubLabel: 'scope: studio'
---

# Studio - Inline data sources

<p class="description">Define data sources with inline rows for in-memory filtering, grouping, and aggregation — no server required.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader"}}

## Overview

A **data source** is the unit of data in Studio.
Each source has a label, a list of field definitions, and optionally an array of rows.
Studio uses the field definitions to build the widget configuration UI and to drive filtering, grouping, and aggregation at runtime.

```ts
import type { StudioDataSource } from '@mui/x-studio';

const ordersSource: StudioDataSource = {
  id: 'orders',
  label: 'Orders',
  fields: [
    { id: 'orderId', label: 'Order ID', type: 'string' },
    { id: 'category', label: 'Category', type: 'string' },
    { id: 'revenue', label: 'Revenue', type: 'number', aggregatable: true },
    { id: 'orderDate', label: 'Order Date', type: 'date' },
    { id: 'isPaid', label: 'Paid', type: 'boolean' },
  ],
  rows: [
    { orderId: 'O-001', category: 'Electronics', revenue: 250, orderDate: '2024-01-15', isPaid: true },
    { orderId: 'O-002', category: 'Clothing', revenue: 85, orderDate: '2024-01-16', isPaid: false },
    // ...
  ],
};
```

Pass data sources in `initialState.dataSources`:

```ts
const initialState: Partial<StudioState> = {
  dataSources: {
    [ordersSource.id]: ordersSource,
  },
};
```

## `StudioDataSource`

| Property | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `id` | `string` | ✓ | Unique identifier for the source. Must be stable — used as a key in serialized state. |
| `label` | `string` | ✓ | Display name shown in the data drawer and widget selects. |
| `fields` | `StudioDataField[]` | ✓ | Field definitions — see below. |
| `rows` | `Record<string, unknown>[]` | | Inline data rows. Required when no adapter is attached. |
| `hidden` | `boolean` | | When `true`, hides the source from the data drawer and widget config selects. Use for join-only sources. |

## `StudioDataField`

Each field describes one column of the data source:

| Property | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `id` | `string` | ✓ | Must match the row object key. |
| `label` | `string` | ✓ | Display name in the UI. |
| `type` | `FieldType` | ✓ | One of `'string'`, `'number'`, `'date'`, `'datetime'`, `'boolean'`. |
| `aggregatable` | `boolean` | | When `true`, Studio can sum, average, count, etc. this field on charts and KPIs. Usually set on numeric fields. |
| `format` | `StudioNumberFormat` | | Display format for numbers: `'number'`, `'currency'`, `'percent'`, `'compact'`. |
| `currencyCode` | `string` | | ISO 4217 currency code used when `format` is `'currency'` (e.g. `'USD'`). |

## Field types

### `'string'`

Used for categorical dimensions (axes, group-by, pie sectors) and in multi-select filter widgets.
Studio automatically computes distinct values for string fields at ingestion time (`fieldDistinctValues`), making filter dropdowns instant.

### `'number'`

Used for metrics and chart values.
Set `aggregatable: true` to allow sum, average, count distinct, min, and max aggregations on charts and KPIs.

### `'date'` and `'datetime'`

Row values must be ISO 8601 strings (`'2024-01-15'`) or `Date` objects.
Studio uses date fields in date-range filter widgets and for time-series chart axes (with automatic day/week/month/quarter/year bucketing).

### `'boolean'`

Used in toggle filter widgets.

## Multiple data sources and relationships

Provide multiple sources in `initialState.dataSources`.
Define **relationships** between them so Studio can join them for cross-source dimensions.
A relationship links two sources via a shared field (like a foreign key):

```ts
import type { StudioRelationship } from '@mui/x-studio';

const orderCustomerRelationship: StudioRelationship = {
  id: 'rel-orders-customers',
  sourceId: 'orders',
  sourceField: 'customerId',      // field in the orders source
  targetId: 'customers',
  targetField: 'id',              // field in the customers source
  type: 'many-to-one',
};
```

Pass relationships in `initialState.relationships`:

```ts
const initialState: Partial<StudioState> = {
  dataSources: {
    orders: ordersSource,
    customers: customersSource,
  },
  relationships: [orderCustomerRelationship],
};
```

Once a relationship is defined, chart and KPI widgets on the `orders` source can use `customers.name` or `customers.segment` as dimensions, even though those fields live in a different source.

## Hiding sources

Some sources exist only to provide joined dimensions and shouldn't appear in the UI:

```ts
{
  id: 'order-items',
  label: 'Order Items',
  hidden: true, // hidden from data drawer; only reachable via relationships
  fields: [...],
  rows: [...],
}
```

## Large datasets

Inline rows are processed in-memory by Studio.
For large datasets (tens of thousands of rows), consider:

- Using an async adapter to push filtering and aggregation to the server.
  See [Async adapters](/x/react-studio/data/async-adapters .
- Using the `?rows=N` URL parameter in `examples/x-studio` to benchmark performance.
  Studio uses `useDeferredValue` for cross-filter recomputation so the UI remains responsive.

## Updating data at runtime

Rows are part of `StudioState`.
You can update them via `loadSerializedState` if you have a full serialized snapshot, but a more common pattern for live data is to use an async adapter that Studio calls whenever the query descriptor changes.

## TypeScript: sharing field IDs

Define field IDs as string constants to avoid typos when referencing them in initial state and adapters:

```ts
// fields.ts
export const ORDERS_SOURCE_ID = 'orders' as const;
export const FIELD_CATEGORY = 'category' as const;
export const FIELD_REVENUE = 'revenue' as const;

// usage
const ordersSource: StudioDataSource = {
  id: ORDERS_SOURCE_ID,
  label: 'Orders',
  fields: [
    { id: FIELD_CATEGORY, label: 'Category', type: 'string' },
    { id: FIELD_REVENUE, label: 'Revenue', type: 'number', aggregatable: true },
  ],
  rows: [],
};
```

## See also

- [Async adapters](/x/react-studio/data/async-adapters/) — delegate filtering and aggregation to your server for large datasets
- [Relationships](/x/react-studio/data/relationships/) — join sources so widgets can use fields across tables
- [Calculated columns](/x/react-studio/features/calculated-columns/) — add derived fields without modifying source data
- [Measures](/x/react-studio/features/measures/) — add pre-aggregated metrics for KPI and chart widgets
