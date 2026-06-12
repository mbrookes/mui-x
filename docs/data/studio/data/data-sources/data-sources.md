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
    {
      orderId: 'O-001',
      category: 'Electronics',
      revenue: 250,
      orderDate: '2024-01-15',
      isPaid: true,
    },
    {
      orderId: 'O-002',
      category: 'Clothing',
      revenue: 85,
      orderDate: '2024-01-16',
      isPaid: false,
    },
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

| Property        | Type                        | Required | Description                                                                                                                      |
| :-------------- | :-------------------------- | :------- | :------------------------------------------------------------------------------------------------------------------------------- |
| `id`            | `string`                    | ✓        | Unique identifier for the source. Must be stable — used as a key in serialized state.                                            |
| `label`         | `string`                    | ✓        | Display name shown in the data drawer and widget selects.                                                                        |
| `fields`        | `StudioDataField[]`         | ✓        | Field definitions — see below.                                                                                                   |
| `rows`          | `Record<string, unknown>[]` |          | Inline data rows. Required when no adapter is attached.                                                                          |
| `hidden`        | `boolean`                   |          | When `true`, hides the source from the data drawer and widget config selects. Use for join-only sources.                         |
| `aiDescription` | `string`                    |          | AI-facing description of this source's content. Included in the system prompt to help the AI understand when to use this source. |

## `StudioDataField`

Each field describes one column of the data source:

| Property        | Type                 | Required | Description                                                                                                                                  |
| :-------------- | :------------------- | :------- | :------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`            | `string`             | ✓        | Must match the row object key.                                                                                                               |
| `label`         | `string`             | ✓        | Display name in the UI.                                                                                                                      |
| `type`          | `FieldType`          | ✓        | One of `'string'`, `'number'`, `'date'`, `'datetime'`, `'boolean'`.                                                                          |
| `aggregatable`  | `boolean`            |          | When `true`, Studio can sum, average, count, etc. this field on charts and KPIs. Usually set on numeric fields.                              |
| `format`        | `StudioNumberFormat` |          | Display format for numbers: `'number'`, `'currency'`, `'percent'`, `'compact'`.                                                              |
| `currencyCode`  | `string`             |          | ISO 4217 currency code used when `format` is `'currency'` (e.g. `'USD'`).                                                                    |
| `orderedValues` | `string[]`           |          | Canonical display order for categorical values. When set, chart x-axis labels follow this sequence instead of sorting alphabetically. Values not in the list are appended alphabetically at the end. Use for ordered enumerations such as pipeline stages or severity levels. |
| `aiDescription` | `string`             |          | AI-facing description of this field's meaning. Included in the system prompt to guide the AI in field selection for axes, KPIs, and filters. |

## Field types

| Type         | Used for                                                                          | Notes                                                                                                                                        |
| :----------- | :-------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------- |
| `'string'`   | Categorical dimensions (axes, group-by, pie sectors), multi-select filter widgets | Studio computes distinct values at ingestion (`fieldDistinctValues`), making filter dropdowns instant.                                       |
| `'number'`   | Metrics and chart values                                                          | Set `aggregatable: true` to allow sum, average, count distinct, min, and max aggregations on charts and KPIs.                                |
| `'date'`     | Date-range filters, time-series axes                                              | Row values must be ISO 8601 strings (`'2024-01-15'`) or `Date` objects. Studio buckets by day / week / month / quarter / year automatically. |
| `'datetime'` | Date-time range filters, time-series axes                                         | Same format requirements as `'date'`.                                                                                                        |
| `'boolean'`  | Toggle filter widgets                                                             |                                                                                                                                              |

## Multiple data sources and relationships

Provide multiple sources in `initialState.dataSources`.
Define **relationships** between them so Studio can join them for cross-source dimensions.
A relationship links two sources via a shared field (like a foreign key):

```ts
import type { StudioRelationship } from '@mui/x-studio';

const orderCustomerRelationship: StudioRelationship = {
  id: 'rel-orders-customers',
  sourceId: 'orders',
  sourceField: 'customerId', // field in the orders source
  targetId: 'customers',
  targetField: 'id', // field in the customers source
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

## In-memory processing pipeline

When rows are provided inline (no adapter), Studio runs a multi-layer pipeline to produce the rows each widget renders.
Understanding the layers helps when debugging unexpected filter behaviour or performance issues.

| Layer  | Name                   | What it does                                                                                                                                                                                                                                         |
| :----- | :--------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **L1** | Normalization          | Parses ISO date strings into `Date` objects and builds `fieldDistinctValues` indexes for string fields. Scoped lazily to the fields each widget actually uses — adding an unused field to one widget does not force re-normalization for others.     |
| **L1** | Metric-ref resolution  | Replaces `{ type: 'metric-ref' }` filter values with their current scalar value from a named row in the `businessMetrics` source. Runs once over the merged filter list before filtering.                                                            |
| **L2** | Enrichment             | Appends expression-field values (calculated columns) to each row. Evaluated lazily — only expression fields referenced by the current widget are computed. Transitive dependencies are resolved automatically.                                       |
| **L3** | Filter application     | Applies all active filters scoped to this widget: page, widget, cross-filter (chart-click), and interactive (filter-widget). Results are cached by filter-set fingerprint so widgets with unchanged filters pay zero cost when other widgets change. |
| **L4** | Cross-source re-anchor | For chart widgets whose y-field lives on a related source, re-projects the filtered rows onto the correct aggregation grain. Only runs when a cross-source join is required.                                                                         |

The pipeline produces three row arrays:

| Output                | Description                                                                                                                                      |
| :-------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------- |
| `filteredRows`        | All filters applied (page + widget + cross-filter + interactive).                                                                                |
| `filteredRowsNoCross` | Page and widget filters only — cross-filter and interactive filters excluded. Same reference as `filteredRows` when no cross-filters are active. |
| `effectiveRows`       | The rows the widget should render. Equals `filteredRowsNoCross` when `crossFilterMode: 'none'`; equals `filteredRows` for all other modes.       |

All filter scoping and cache management is handled internally — your component receives `effectiveRows` via `useWidgetRows`.
When an async adapter is attached to a source, the entire in-memory pipeline is bypassed for that source.

## Large datasets

Inline rows are processed in-memory by Studio.
For large datasets (tens of thousands of rows), consider:

- Using an async adapter to push filtering and aggregation to the server.
  See [Async adapters](/x/react-studio/data/async-adapters/).
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
