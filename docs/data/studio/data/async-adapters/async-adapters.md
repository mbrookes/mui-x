---
title: Studio - Async adapters
productId: x-studio
packageName: '@mui/x-studio'
githubLabel: 'scope: studio'
---

# Studio - Async adapters

<p class="description">Delegate row-fetching, filtering, grouping, and aggregation to a server-side handler for large datasets or existing APIs.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader"}}

## Overview

By default, Studio processes all data in-memory using the `rows` array you provide on each source.
An **async adapter** replaces this in-memory pipeline: Studio calls your `getRows()` method whenever the query for a widget changes, and you return the result from your server.

Use an adapter when:

- Your dataset is too large to load entirely into the browser
- You already have a server-side API that handles filtering and aggregation
- You need server-controlled access to data (authorization, row-level security)

## Implementing an adapter

An adapter is a plain object with a single `getRows` method:

```ts
import type {
  StudioDataSourceAdapter,
  StudioQueryDescriptor,
  StudioQueryResult,
} from '@mui/x-studio';

const ordersAdapter: StudioDataSourceAdapter = {
  async getRows(descriptor: StudioQueryDescriptor): Promise<StudioQueryResult> {
    const response = await fetch('/api/orders/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(descriptor),
    });
    return response.json(); // { rows: [...] }
  },
};
```

## Attaching an adapter

Attach an adapter after mount using `setDataSourceAdapter` on the `StudioHandle` ref (or directly on the `StudioController`):

```tsx
const studioRef = React.useRef<StudioHandle>(null);

React.useEffect(() => {
  studioRef.current?.setDataSourceAdapter('orders', ordersAdapter);
}, []);

<Studio ref={studioRef} initialState={initialState} />;
```

When an adapter is attached, Studio ignores the `rows` array on that source for all widget queries.
Remove an adapter by passing `undefined`:

```ts
studioRef.current?.setDataSourceAdapter('orders', undefined);
// Studio falls back to in-memory rows
```

## `StudioQueryDescriptor`

Studio builds a `StudioQueryDescriptor` for each widget whenever its query changes (for example, a filter is applied or the chart type changes).
Your adapter receives this descriptor and must return matching rows.

```ts
interface StudioQueryDescriptor {
  /** The data source ID this query is for. */
  sourceId: string;
  /** The widget ID that triggered this query. */
  widgetId: string;
  /** Field IDs the widget needs — only fetch/return these columns. */
  select: string[];
  /** Recursive filter tree. Apply these filters server-side. */
  filter?: StudioFilterNode;
  /** For chart/KPI: the x-axis or grouping field ID. */
  groupBy?: string;
  /** For chart/KPI: aggregations to apply. Return pre-aggregated rows. */
  aggregations?: {
    field: string;
    fn: 'sum' | 'avg' | 'count' | 'min' | 'max' | 'count_distinct';
    alias: string;
  }[];
  /** Time-series bucketing (charts with date x-axis). */
  xGroupBy?: 'day' | 'week' | 'month' | 'quarter' | 'year';
  /**
   * Stable hash of all query-shape fields (sourceId, select, filter, groupBy,
   * xGroupBy, aggregations). Studio computes this — you do not need to hash it yourself.
   *
   * Note: widgetId is intentionally excluded from the hash. Two widgets that
   * request the same source with the same filters and select share one cache
   * entry and one in-flight request, avoiding redundant server calls.
   */
  cacheKey: string;
}
```

### Returning pre-aggregated data

When `aggregations` is set, return **pre-aggregated rows** — one row per group:

```ts
// descriptor.aggregations = [
//   { field: 'revenue', fn: 'sum', alias: 'revenue_sum' },
//   { field: 'orderId', fn: 'count', alias: 'orderId_count' },
// ]
// descriptor.groupBy = 'category'

// Return one row per category:
return {
  rows: [
    { category: 'Electronics', revenue_sum: 45000, orderId_count: 182 },
    { category: 'Clothing', revenue_sum: 29000, orderId_count: 134 },
  ],
};
```

When `aggregations` is not set (for example, for a grid widget), return **raw filtered rows** matching `select` and `filter`.

### The filter tree

`descriptor.filter` is a recursive `StudioFilterNode` tree:

```ts
type StudioFilterNode =
  | { type: 'and'; children: StudioFilterNode[] }
  | { type: 'or'; children: StudioFilterNode[] }
  | { type: 'leaf'; field: string; operator: StudioFilterOperator; value: unknown };
```

Translate this to your server's query language.
For SQL, a simple recursive translator looks like:

```ts
function toSQL(node: StudioFilterNode): string {
  if (node.type === 'and') {
    return node.children.map(toSQL).join(' AND ');
  }
  if (node.type === 'or') {
    return `(${node.children.map(toSQL).join(' OR ')})`;
  }
  // leaf
  switch (node.operator) {
    case 'equals':
      return `${node.field} = ${quote(node.value)}`;
    case 'notEquals':
      return `${node.field} != ${quote(node.value)}`;
    case 'greaterThan':
      return `${node.field} > ${node.value}`;
    case 'lessThan':
      return `${node.field} < ${node.value}`;
    case 'contains':
      return `${node.field} LIKE '%${node.value}%'`;
    case 'in':
      return `${node.field} IN (${(node.value as string[]).map(quote).join(', ')})`;
    // handle remaining operators...
    default:
      return 'TRUE';
  }
}
```

## Caching with `cacheKey`

`descriptor.cacheKey` is a stable hash of the query shape (`sourceId`, `select`, `filter`, `groupBy`, `xGroupBy`, `aggregations`). It deliberately excludes `widgetId`.

This means two widgets that request the **same source with the same filters** produce an identical `cacheKey`. Your adapter (and, on the server side, `handleBatchQuery`) can therefore share one cache entry and one in-flight request across both widgets — halving the load for dashboards with related widgets.

Use the key to avoid re-fetching when a widget re-renders without a query change:

```ts
const cache = new Map<string, StudioQueryResult>();

const adapter: StudioDataSourceAdapter = {
  async getRows(descriptor) {
    if (cache.has(descriptor.cacheKey)) {
      return cache.get(descriptor.cacheKey)!;
    }
    const result = await fetchFromServer(descriptor);
    cache.set(descriptor.cacheKey, result);
    return result;
  },
};
```

For production use, consider a proper LRU cache (for example, `lru-cache`) and cache invalidation on data mutations.

When using [`createBatchingAdapter`](#batching-multiple-widgets-into-one-request) together with [`@mui/x-studio-data-middleware`](/x/react-studio/data/server-middleware/), cross-widget deduplication is handled automatically at both layers:

- **Client** — `StudioRequestCache` coalesces concurrent requests with the same `cacheKey` into a single in-flight `getRows()` call.
- **Server** — `generateCacheKey` excludes `widgetId` from the server-side LRU key, so widgets with identical queries share one cache entry regardless of their IDs.

## Mixing inline rows and adapters

You can mix inline and adapter-backed sources in the same dashboard.
Inline sources use the in-memory pipeline; adapter-backed sources call `getRows`.

A common pattern is to define all sources with `rows: []` in `initialState` (so field definitions are available at build time) and then attach adapters after mount:

```ts
const initialState: Partial<StudioState> = {
  dataSources: {
    orders: {
      id: 'orders',
      label: 'Orders',
      fields: [...],
      rows: [], // placeholder — adapter provides real rows
    },
  },
};

// After mount:
studioRef.current?.setDataSourceAdapter('orders', ordersAdapter);
```

## Server-side example

Here is a complete example using a simulated server with a delay to demonstrate the loading state.
Studio shows a spinner on widget cards while their adapter calls are in-flight:

```ts
// simulatedServer.ts
import type {
  StudioDataSourceAdapter,
  StudioQueryDescriptor,
  StudioQueryResult,
} from '@mui/x-studio';

function applyFilter(
  rows: Record<string, unknown>[],
  filter: StudioQueryDescriptor['filter'],
): Record<string, unknown>[] {
  if (!filter) return rows;
  if (filter.type === 'and')
    return filter.children.reduce((r, f) => applyFilter(r, f), rows);
  if (filter.type === 'or') {
    const sets = filter.children.map((f) => applyFilter(rows, f));
    return [...new Set(sets.flat())];
  }
  // leaf
  return rows.filter((row) => {
    const val = row[filter.field];
    switch (filter.operator) {
      case 'equals':
        return val === filter.value;
      case 'contains':
        return String(val)
          .toLowerCase()
          .includes(String(filter.value).toLowerCase());
      case 'in':
        return (filter.value as unknown[]).includes(val);
      case 'greaterThan':
        return Number(val) > Number(filter.value);
      case 'lessThan':
        return Number(val) < Number(filter.value);
      default:
        return true;
    }
  });
}

export function createAdapter(
  rows: Record<string, unknown>[],
): StudioDataSourceAdapter {
  return {
    async getRows(descriptor: StudioQueryDescriptor): Promise<StudioQueryResult> {
      // Simulate network latency
      await new Promise((resolve) => setTimeout(resolve, 300));

      let result = applyFilter(rows, descriptor.filter);

      if (descriptor.aggregations && descriptor.groupBy) {
        // Group and aggregate
        const groups = new Map<unknown, Record<string, unknown>>();
        for (const row of result) {
          const key = row[descriptor.groupBy];
          if (!groups.has(key)) {
            groups.set(key, { [descriptor.groupBy]: key });
          }
          const group = groups.get(key)!;
          for (const agg of descriptor.aggregations) {
            const prev = (group[agg.alias] as number) ?? 0;
            if (agg.fn === 'sum' || agg.fn === 'avg') {
              group[agg.alias] = prev + (Number(row[agg.field]) || 0);
            } else if (agg.fn === 'count') {
              group[agg.alias] = prev + 1;
            }
          }
        }
        result = [...groups.values()];
      }

      return { rows: result };
    },
  };
}
```

## `StudioQueryResult`

Your `getRows` method must return an object with a `rows` array:

```ts
interface StudioQueryResult {
  rows: Record<string, unknown>[];
}
```

## Loading and recomputing states

`useWidgetRows` exposes two status flags that your custom widgets can use to show feedback while new data is being produced:

| Flag            | When true                                                                                                                                                    |
| :-------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isLoading`     | An adapter `getRows()` call is in flight and no prior cached result exists. Studio shows a spinner on built-in widget cards automatically.                   |
| `isRecomputing` | The in-memory sync pipeline has received a new filter state but React's deferred re-render has not yet committed. Always `false` for adapter-backed sources. |

```tsx
import { useWidgetRows } from '@mui/x-studio';

function MyCustomWidget({ widget, dataSource }) {
  const { effectiveRows, isLoading, isRecomputing } = useWidgetRows(
    widget,
    dataSource,
  );

  if (isLoading) return <Skeleton />;
  return <MyChart rows={effectiveRows} dimmed={isRecomputing} />;
}
```

The `StudioRequestCache` that backs the async path gives you stale-while-revalidate behavior by default:
on the first render after a query change it returns the last known rows synchronously (`isLoading: false`),
then updates once the new fetch settles. This means widgets only show the spinner on the very first load —
subsequent filter changes produce an instant render with the old data replaced smoothly.

## Error handling

When `getRows` throws, Studio catches the error and sets an `isError` flag on the affected widget.
Built-in widgets (chart, grid, KPI, pivot) display an error banner automatically when an adapter fails.

### Widget error banner

All built-in widget types show a user-visible error message when their adapter rejects:

- **Chart** — a centered red error text at the chart's configured height.
- **Grid** — a red alert banner above the data grid.
- **KPI** — a red caption above the KPI value.
- **Pivot** — a centered red message replacing the table.

### Custom error messages

To pass a custom error message to the UI, throw an `Error` with the message you want displayed:

```ts
async getRows(descriptor) {
  const response = await fetch('/api/data');
  if (!response.ok) {
    throw new Error('Service unavailable — please try again later.');
  }
  return response.json();
}
```

The error message from the thrown `Error` object is displayed in the widget card.
If you throw a non-Error value, Studio falls back to the locale text's `widgetLoadError` token.

### Returning empty rows on failure

If you prefer a graceful empty state instead of an error banner, catch the error and return `{ rows: [] }`:

```ts
async getRows(descriptor) {
  try {
    return await fetchFromServer(descriptor);
  } catch (error) {
    console.error('[Studio adapter] getRows failed:', error);
    return { rows: [] };
  }
}
```

### `isError` in custom widgets

When building a custom widget with `useWidgetRows`, check the `isError` and `errorMessage` fields:

```tsx
import { useWidgetRows } from '@mui/x-studio';

function MyCustomWidget({ widget, dataSource }) {
  const { effectiveRows, isLoading, isError, errorMessage } = useWidgetRows(
    widget,
    dataSource,
  );

  if (isError) {
    return (
      <div style={{ color: 'red' }}>{errorMessage || 'Failed to load data'}</div>
    );
  }
  if (isLoading) return <Skeleton />;
  return <MyChart rows={effectiveRows} />;
}
```

## `createSimpleAdapter` — one endpoint per source

`createSimpleAdapter` is the simplest way to connect a Studio data source to a dedicated REST endpoint.
Each widget fires one `POST` request to your endpoint, passing the Studio `StudioQueryDescriptor` as the request body.

```ts
import { createSimpleAdapter } from '@mui/x-studio';

const ordersSource: StudioDataSource = {
  id: 'orders',
  label: 'Orders',
  fields: [...],
  adapter: createSimpleAdapter('/api/studio/orders'),
};
```

Your endpoint receives the descriptor as JSON and must return `{ rows: [...] }`:

```ts
// Next.js API route — app/api/studio/orders/route.ts
import type { StudioQueryDescriptor } from '@mui/x-studio';

export async function POST(request: Request) {
  const descriptor: StudioQueryDescriptor = await request.json();

  // Apply filters, aggregations, etc. from the descriptor.
  const rows = await queryDatabase(descriptor);

  return Response.json({ rows });
}
```

### `SimpleAdapterOptions`

```ts
import { createSimpleAdapter, type SimpleAdapterOptions } from '@mui/x-studio';

const adapter = createSimpleAdapter('/api/studio/orders', {
  // Custom fetch (add auth headers, interceptors, etc.)
  fetchFn: (url, init) =>
    fetch(url, {
      ...init,
      headers: { ...init?.headers, Authorization: `Bearer ${token}` },
    }),

  // Transform the descriptor before sending (e.g. rename fields)
  transformDescriptor: (descriptor) => ({
    ...descriptor,
    customParam: 'value',
  }),
});
```

| Option                | Type                      | Default            | Description                                                                                                  |
| :-------------------- | :------------------------ | :----------------- | :----------------------------------------------------------------------------------------------------------- |
| `fetchFn`             | `typeof fetch`            | `globalThis.fetch` | Custom fetch implementation. Useful for auth headers, interceptors, or test mocks.                           |
| `transformDescriptor` | `(descriptor) => unknown` | —                  | Transform the query descriptor before sending. Useful for renaming fields or adding custom query parameters. |

### When to use `createSimpleAdapter` vs `createBatchingAdapter`

| Scenario                                          | Recommendation                                |
| :------------------------------------------------ | :-------------------------------------------- |
| Each data source has its own dedicated endpoint   | `createSimpleAdapter`                         |
| Multiple sources share one endpoint (batch API)   | `createBatchingAdapter`                       |
| Many widgets on the same page with shared sources | `createBatchingAdapter` (fewer HTTP requests) |
| Simple setup with one or two widgets              | Either — `createSimpleAdapter` is less setup  |

## Batching multiple widgets into one request

By default, each widget fires its own `getRows()` call independently. On a page with 10 widgets, this produces 10 separate HTTP requests. Use `createBatchingAdapter` from `@mui/x-studio` to collapse all widget requests within a 50 ms window into a single `POST` request.

```ts
import { createBatchingAdapter } from '@mui/x-studio';

const ordersSource: StudioDataSource = {
  id: 'orders',
  label: 'Orders',
  fields: [...],
  adapter: createBatchingAdapter('https://api.example.com/api/studio-data'),
};
```

All data sources that point to the **same endpoint URL** share one batcher — a page with 10 widgets querying different sources via the same API endpoint produces exactly **one** HTTP request per 50 ms window.

### Batch request format

The adapter sends a single `POST` with all pending widget descriptors.
The `table` field contains the Studio **source ID** for that widget (for example, `source-orders`) — see [Source ID to table name](#source-id-to-table-name) for how your server should map this to a SQL table.

```json
{
  "pageId": "page-1",
  "widgets": [
    {
      "id": "widget-revenue",
      "table": "source-orders",
      "columns": ["date", "total"],
      "filters": []
    },
    {
      "id": "widget-by-country",
      "table": "source-orders",
      "columns": ["country", "total"],
      "filters": [
        { "column": "country", "operator": "in", "value": ["US", "DE", "GB"] }
      ]
    }
  ]
}
```

#### `filters` format

Active page and widget filters are converted from Studio's internal `StudioFilterNode` tree into a flat `FilterPredicate[]` array before being sent in the batch request.
Each predicate has a `column` (the Studio field ID), an `operator`, and a `value`:

```ts
interface FilterPredicate {
  column: string;
  operator: 'eq' | 'neq' | 'in' | 'lt' | 'lte' | 'gt' | 'gte' | 'like' | 'between';
  value?: unknown;
}
```

The operator mapping from Studio's UI to the batch format:

| Studio operator         | Batch `operator` | Notes                                          |
| :---------------------- | :--------------- | :--------------------------------------------- |
| `equals`                | `eq`             | Exact match                                    |
| `not_equals`            | `neq`            |                                                |
| `in`                    | `in`             | Value is an array, for example, `["US", "DE"]` |
| `greater_than`          | `gt`             |                                                |
| `less_than`             | `lt`             |                                                |
| `greater_than_or_equal` | `gte`            |                                                |
| `less_than_or_equal`    | `lte`            |                                                |
| `contains`              | `like`           | Value should be matched with `LIKE %value%`    |
| `between`               | `between`        | Emits two predicates (one `gte`, one `lte`)    |

Group nodes (`and`/`or`) in the filter tree are flattened — all leaf predicates are collected into the flat array. For queries requiring strict `OR` logic between predicates, implement that server-side based on your schema knowledge.

### Source ID to table name

Studio sends the data source's `id` as the `table` field in each batch widget descriptor.
If your source IDs follow the convention `source-<table-name>` (for example, `source-orders`, `source-order-items`), you can derive the SQL table name by stripping the prefix and replacing hyphens with underscores:

```ts
function sourceIdToTable(sourceId: string): string {
  return sourceId.replace(/^source-/, '').replace(/-/g, '_');
}

// "source-orders"       → "orders"
// "source-order-items"  → "order_items"
// "source-customers"    → "customers"
```

Always validate the derived name against your [schema allowlist](/x/react-studio/data/server-middleware/#schema-allowlist) before querying, and return empty rows (not an error) for unknown source IDs to avoid 500s when new sources are added to the dashboard before the server is updated.

### Batch response format

Your server must return results keyed by the widget `id`:

```json
{
  "pageId": "page-1",
  "results": [
    { "id": "widget-revenue", "rows": [...], "tier": "client", "rowCount": 2000 },
    { "id": "widget-by-country", "rows": [...], "tier": "client", "rowCount": 2000 }
  ]
}
```

### `BatchingAdapterOptions`

```ts
import { createBatchingAdapter, type BatchingAdapterOptions } from '@mui/x-studio';

const adapter = createBatchingAdapter('/api/studio-data', {
  batchDelayMs: 50, // default — window to collect widget requests
  fetchFn: myFetch, // custom fetch (for auth headers, interceptors, etc.)
});
```

| Option         | Type           | Default            | Description                                                                |
| :------------- | :------------- | :----------------- | :------------------------------------------------------------------------- |
| `batchDelayMs` | `number`       | `50`               | Window in milliseconds to collect widget requests before dispatching.      |
| `fetchFn`      | `typeof fetch` | `globalThis.fetch` | Custom fetch implementation. Useful for adding auth headers or test mocks. |

### Adding auth headers

```ts
const adapter = createBatchingAdapter('/api/studio-data', {
  fetchFn: (url, init) =>
    fetch(url, {
      ...init,
      headers: {
        ...init?.headers,
        Authorization: `Bearer ${getAccessToken()}`,
      },
    }),
});
```

### Server-side counterpart

`createBatchingAdapter` is designed to work with the [`@mui/x-studio-data-middleware`](/x/react-studio/data/server-middleware/) package, which provides a framework-agnostic `handleBatchQuery()` handler that processes the batch, applies security predicates, and routes queries to the optimal execution tier. See the [Server middleware](/x/react-studio/data/server-middleware/) guide for the full server setup.

## See also

- [Inline data sources](/x/react-studio/data/data-sources/) — synchronous inline rows for smaller datasets
- [Relationships](/x/react-studio/data/relationships/) — declare foreign-key joins between data sources
- [Server middleware](/x/react-studio/data/server-middleware/) — `@mui/x-studio-data-middleware` batch handler with security, caching, and adaptive routing
- [Save & load](/x/react-studio/persistence/save-and-load/) — persist and restore dashboard state; adapters are re-attached after load
