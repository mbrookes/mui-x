---
title: Studio - Server middleware
productId: x-studio
packageName: '@mui/x-studio-middleware'
githubLabel: 'scope: studio'
---

# Studio - Server middleware

<p class="description">A framework-agnostic Node.js middleware that handles batched widget queries with JWT security, multi-tenant isolation, adaptive routing, and in-process LRU caching.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader"}}

## Overview

`@mui/x-studio-middleware` is the server-side counterpart to the [`createBatchingAdapter`](/x/react-studio/data/async-adapters/#batching-multiple-widgets-into-one-request) client utility. Together they replace N independent widget HTTP requests with a single batched `POST` that is processed securely and efficiently on the server.

The package is intentionally framework-agnostic — it exports a pure `handleBatchQuery()` function with no HTTP imports. You wire it into Express, Fastify, Next.js API routes, or any other handler yourself.

Key capabilities:

- **Security** — JWT verification, tenant isolation, row-level security predicates applied before every query
- **Adaptive routing** — a pre-flight `COUNT(*)` selects the optimal execution strategy based on dataset size
- **Server-side caching** — a size-bounded LRU cache with HMAC-scoped keys prevents cross-tenant data leakage
- **Pluggable** — swap the cache provider, override routing thresholds, or bring your own Knex instance

### End-to-end pipeline

```text
Browser — N widgets
  │  buildQueryDescriptor()  (per widget, excludes widgetId from cacheKey)
  │  StudioRequestCache       deduplicates in-flight calls by cacheKey
  │  createBatchingAdapter()  50 ms window → single POST per tick
  ▼
POST /api/studio-data
  │  extractSecurityClaims()  JWT HS256 verification → JwtSecurityClaims
  │  handleBatchQuery()
  │    ├── schema allowlist check (all tables validated upfront)
  │    └── per widget (in parallel):
  │         ├── server LRU cache lookup  (HMAC-scoped key, excludes widgetId)
  │         ├── COUNT(*) pre-flight      (~0.1–1 ms on indexed tables)
  │         │      ≤ 10 k  → client tier  (raw rows, client filters in-browser)
  │         │      ≤ 100 k → server tier  (raw rows, cached for reuse)
  │         │      > 100 k → db tier      (GROUP BY push-down, not cached)
  │         └── executeForTier()          Knex parameterized query
  ▼
BatchQueryResponse  { pageId, results: [{ id, rows, tier, rowCount }] }
  │  createBatchingAdapter()  routes each result back to originating widget
  ▼
Widget renders with fresh rows
```

## Installation

<codeblock storageKey="package-manager">

```bash npm
npm install @mui/x-studio-middleware knex lru-cache
```

```bash pnpm
pnpm add @mui/x-studio-middleware knex lru-cache
```

```bash yarn
yarn add @mui/x-studio-middleware knex lru-cache
```

</codeblock>

`knex` is a peer dependency — the package uses it for query building but never creates a database connection itself. Bring your own database driver (`pg`, `mysql2`, `better-sqlite3`, etc.).

## Quick start (Express)

```ts
import express from 'express';
import knex from 'knex';
import {
  handleBatchQuery,
  extractSecurityClaims,
  LRUCacheProvider,
} from '@mui/x-studio-middleware';

const db = knex({ client: 'pg', connection: process.env.DATABASE_URL });
const cache = new LRUCacheProvider({
  maxSizeBytes: 256 * 1024 * 1024,
  ttlMs: 60_000,
});

const app = express();
app.use(express.json());

app.post('/api/studio-data', async (req, res) => {
  try {
    // 1. Extract and verify JWT — throws if invalid
    const claims = extractSecurityClaims(
      req.headers.authorization,
      process.env.JWT_SECRET!,
    );

    // 2. Handle the batch
    const result = await handleBatchQuery(req.body, claims, {
      db,
      cacheProvider: cache,
      schemaAllowlist: ['orders', 'customers', 'products'],
    });

    res.json(result);
  } catch (err) {
    const status = (err as Error).message.includes('JWT') ? 401 : 500;
    res.status(status).json({ error: (err as Error).message });
  }
});
```

On the client, point `createBatchingAdapter` at the same endpoint:

```ts
import { createBatchingAdapter } from '@mui/x-studio';

const source: StudioDataSource = {
  id: 'orders',
  label: 'Orders',
  fields: [...],
  adapter: createBatchingAdapter('/api/studio-data', {
    fetchFn: (url, init) =>
      fetch(url, {
        ...init,
        headers: { ...init?.headers, Authorization: `Bearer ${getToken()}` },
      }),
  }),
};
```

## Security

### JWT verification

`extractSecurityClaims(authorizationHeader, secret)` verifies an HS256 JWT and returns a `JwtSecurityClaims` object. The function throws if the token is missing, malformed, expired, or has an invalid signature.

```ts
interface JwtSecurityClaims {
  tenantId: string; // primary multi-tenant isolation boundary
  userId: string; // authenticated user
  roleIds: string[]; // role assignments
  regionIds?: number[]; // optional row-level region restriction
  department?: string; // optional row-level department restriction
}
```

**Never pass user-supplied values directly as claims.** The host application is responsible for constructing `JwtSecurityClaims` from a trusted, pre-verified source (JWT, session, OAuth token).

### Row-level security predicates

Every query built by `handleBatchQuery` applies security predicates **before** any user-supplied filters:

- `tenant_id = :tenantId` — always applied
- `region_id IN (:regionIds)` — applied when `claims.regionIds` is present
- `department = :department` — applied when `claims.department` is present

These predicates use Knex parameterized bindings (OWASP Defense in Depth #1) — raw user input is never string-concatenated into SQL.

### Schema allowlist

The `schemaAllowlist` option lists the only table names the middleware is permitted to query. Any request referencing a table not in the allowlist is rejected before any query is built:

```ts
await handleBatchQuery(req.body, claims, {
  db,
  schemaAllowlist: ['orders', 'customers'], // only these two tables may be queried
});
```

This enforces the Zero-Knowledge Rule: the middleware never has hardcoded table names — all access is controlled by the host application.

### Source ID to table name

`createBatchingAdapter` sends the Studio data source's `id` as the `table` field in every batch widget descriptor. If your source IDs follow the convention `source-<table-name>`, you can derive the SQL table name programmatically rather than maintaining an explicit mapping:

```ts
function sourceIdToTable(sourceId: string): string {
  return sourceId.replace(/^source-/, '').replace(/-/g, '_');
}

// "source-orders"       → "orders"
// "source-order-items"  → "order_items"
// "source-customers"    → "customers"
```

Use this in your handler before checking the allowlist. Return empty rows (not an error) for unknown or unmapped sources so adding a new data source to the dashboard doesn't break existing widgets while a server deploy is in progress:

```ts
app.post('/api/studio-data', async (req, res) => {
  const results = await Promise.all(
    req.body.widgets.map(async (widget) => {
      const table = sourceIdToTable(widget.table);
      if (!allowlist.includes(table)) {
        console.warn(
          `[studio] Unknown source "${widget.table}" — returning empty rows`,
        );
        return { id: widget.id, rows: [], tier: 'client', rowCount: 0 };
      }
      // ... execute query
    }),
  );
  res.json({ pageId: req.body.pageId, results });
});
```

### Cache key isolation

Server-side cache keys are structured as:

```text
studio:v1:<tenantId>:<securityHash>:<queryHash>
```

- **`tenantId`** — primary namespace; different tenants never share cache entries
- **`securityHash`** — HMAC-SHA256 of `{tenantId, regionIds, department}`; users with the same row-level permissions share entries for efficiency
- **`queryHash`** — SHA-256 of the query shape (`table`, `columns`, `filters`, `orderBy`, `limit`) excluding `widgetId` so widgets with identical queries share one cache entry

The client-supplied `cacheKey` from `StudioQueryDescriptor` is **never used server-side** — it contains no security dimensions.

## Adaptive routing

When a batch request arrives, the middleware determines the optimal execution strategy using a pre-flight `COUNT(*)` query:

```text
incoming request
      │
      ▼
 COUNT(*) pre-flight   ~0.1–0.7 ms
      │
      ├── rows ≤ 10,000  ──►  client tier
      │                        return raw rows; client filters in-browser
      │
      ├── rows ≤ 100,000 ──►  server tier
      │                        aggregate server-side; cache result
      │
      └── rows > 100,000 ──►  db tier
                               push full aggregation to database
```

The pre-flight is consistently 5–20× faster than the actual query, making it a safe overhead even for the smallest datasets.

### Routing threshold benchmark

Measured on `node:sqlite` in-memory with covering indexes. Use these numbers as a guide when choosing `thresholds` for your database:

| Row count | COUNT(\*) | Full scan | GROUP BY SUM |
| :-------- | :-------- | :-------- | :----------- |
| 10 k      | 0.07 ms   | 12 ms     | 1.65 ms      |
| 100 k     | 0.73 ms   | 127 ms    | 18 ms        |
| 1 M       | 7 ms      | 2,200 ms  | 207 ms       |

The default thresholds (`clientTier: 10_000`, `serverMemoryTier: 100_000`) are derived from these measurements. Networked databases will have higher latencies — tune accordingly.

### Customising thresholds

```ts
await handleBatchQuery(req.body, claims, {
  db,
  schemaAllowlist: ['orders'],
  thresholds: {
    clientTier: 5_000, // default: 10,000
    serverMemoryTier: 50_000, // default: 100,000
  },
});
```

### DB push-down aggregation columns

When the row count exceeds `serverMemoryTier`, the middleware uses database-side aggregation (`GROUP BY`). It identifies aggregation columns by a name prefix convention on the `columns` list in the `BatchWidgetDescriptor`:

| Prefix   | SQL aggregate | Example column name | SQL fragment                          |
| :------- | :------------ | :------------------ | :------------------------------------ |
| `sum_`   | `SUM`         | `sum_revenue`       | `SUM(revenue) AS sum_revenue`         |
| `avg_`   | `AVG`         | `avg_order_value`   | `AVG(order_value) AS avg_order_value` |
| `count_` | `COUNT`       | `count_orders`      | `COUNT(orders) AS count_orders`       |

All other columns in the list are treated as `GROUP BY` keys. For example, `columns: ['region', 'sum_revenue', 'count_orders']` produces:

```sql
SELECT region, SUM(revenue) AS sum_revenue, COUNT(orders) AS count_orders
FROM orders
WHERE tenant_id = ? -- security predicate
GROUP BY region
```

`createBatchingAdapter` maps Studio widget `aggregations` descriptors to this naming convention automatically when preparing the batch request.

## Caching

### `LRUCacheProvider`

The default cache is an in-process LRU, bounded by total byte size:

```ts
import { LRUCacheProvider } from '@mui/x-studio-middleware';

const cache = new LRUCacheProvider({
  maxSizeBytes: 128 * 1024 * 1024, // 128 MB (default)
  ttlMs: 30_000, // 30 seconds (default)
});
```

| Option         | Type     | Default              | Description                                                                                              |
| :------------- | :------- | :------------------- | :------------------------------------------------------------------------------------------------------- |
| `maxSizeBytes` | `number` | `134217728` (128 MB) | Maximum total memory for cached rows. Least-recently-used entries are evicted when the limit is reached. |
| `ttlMs`        | `number` | `30000`              | Time-to-live in milliseconds. Matches the client-side `StudioRequestCache` TTL by default.               |

`LRUCacheProvider` is suitable for single-node deployments. For horizontally scaled (multi-instance) setups, provide a Redis-backed implementation (see [Custom cache provider](#custom-cache-provider)).

### Invalidating stale data

When your data changes, call `invalidatePrefix` to evict all cache entries for a tenant:

```ts
// Evict all cached queries for tenant 'acme'
await cache.invalidatePrefix('studio:v1:acme:');

// Evict everything
await cache.invalidatePrefix('studio:v1:');
```

### Custom cache provider

Implement `CacheProvider` to use Redis, Memcached, or any other store:

```ts
import type { CacheProvider, CacheEntry } from '@mui/x-studio-middleware';
import { createClient } from 'redis';

export class RedisCacheProvider implements CacheProvider {
  private client = createClient({ url: process.env.REDIS_URL });

  async get(key: string): Promise<CacheEntry | undefined> {
    const raw = await this.client.get(key);
    return raw ? JSON.parse(raw) : undefined;
  }

  async set(key: string, value: CacheEntry): Promise<void> {
    await this.client.setEx(key, 30, JSON.stringify(value)); // 30s TTL
  }

  async invalidatePrefix(prefix: string): Promise<void> {
    const keys = await this.client.keys(`${prefix}*`);
    if (keys.length > 0) {
      await this.client.del(keys);
    }
  }
}
```

Pass your provider to `handleBatchQuery`:

```ts
await handleBatchQuery(req.body, claims, {
  db,
  cacheProvider: new RedisCacheProvider(),
  schemaAllowlist: ['orders'],
});
```

## `handleBatchQuery` reference

```ts
handleBatchQuery(
  body: BatchQueryRequest,
  claims: JwtSecurityClaims,
  options: HandleBatchQueryOptions,
): Promise<BatchQueryResponse>
```

### `HandleBatchQueryOptions`

| Option                        | Type            | Default            | Description                                                                                          |
| :---------------------------- | :-------------- | :----------------- | :--------------------------------------------------------------------------------------------------- |
| `db`                          | `Knex.Knex`     | —                  | **Required.** Configured Knex instance. The package never creates connections itself.                |
| `schemaAllowlist`             | `string[]`      | —                  | **Required.** Table names the middleware may query. Any other table name in the request is rejected. |
| `cacheProvider`               | `CacheProvider` | `LRUCacheProvider` | Cache backend. Defaults to a shared in-process LRU instance.                                         |
| `thresholds.clientTier`       | `number`        | `10000`            | Max row count for the client-tier strategy.                                                          |
| `thresholds.serverMemoryTier` | `number`        | `100000`           | Max row count for the server-memory strategy. Rows above this use DB push-down.                      |

### `BatchQueryRequest`

The shape of the JSON body the client sends:

```ts
interface BatchQueryRequest {
  pageId: string;
  widgets: BatchWidgetDescriptor[];
}

interface BatchWidgetDescriptor {
  id: string; // widget ID — used to route the response back
  table: string; // table / data source to query
  columns?: string[]; // projection — only return these columns
  filters?: FilterPredicate[];
  orderBy?: OrderBy[];
  limit?: number;
}

interface FilterPredicate {
  column: string;
  operator: 'eq' | 'neq' | 'in' | 'lt' | 'lte' | 'gt' | 'gte' | 'like' | 'between';
  value:
    | string
    | number
    | boolean
    | string[]
    | number[]
    | [string, string]
    | [number, number];
}
```

### `BatchQueryResponse`

```ts
interface BatchQueryResponse {
  pageId: string;
  results: WidgetQueryResult[];
}

interface WidgetQueryResult {
  id: string; // echoes BatchWidgetDescriptor.id for client routing
  rows: Record<string, unknown>[];
  tier: 'client' | 'server' | 'db'; // which routing tier served this widget
  rowCount: number; // total matching rows (before limit)
  error?: string; // set if this widget's query failed
}
```

## Next.js example

```ts
// app/api/studio-data/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { handleBatchQuery, extractSecurityClaims } from '@mui/x-studio-middleware';
import { db, cache } from '@/lib/db';

export async function POST(req: NextRequest) {
  try {
    const claims = extractSecurityClaims(
      req.headers.get('authorization') ?? undefined,
      process.env.JWT_SECRET!,
    );
    const body = await req.json();
    const result = await handleBatchQuery(body, claims, {
      db,
      cacheProvider: cache,
      schemaAllowlist: ['orders', 'customers', 'products'],
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    const status = message.includes('JWT') ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
```

## Security checklist

Before deploying to production:

- [ ] Set `JWT_SECRET` (or `CACHE_HMAC_SECRET`) as an environment variable — never hardcode
- [ ] Populate `schemaAllowlist` with only the tables your dashboard needs
- [ ] Validate JWT claims in your auth middleware before passing them to `handleBatchQuery`
- [ ] Remove the dev fallback (`claims = demoUser`) from your handler
- [ ] Use HTTPS in production so JWTs are not transmitted in plaintext
- [ ] For multi-node deployments, replace `LRUCacheProvider` with a Redis-backed provider to avoid cache inconsistency between instances

## See also

- [Async adapters](/x/react-studio/data/async-adapters/) — how to implement and attach data source adapters
- [Async adapters — batching](/x/react-studio/data/async-adapters/#batching-multiple-widgets-into-one-request) — `createBatchingAdapter` client utility
- [Global filters](/x/react-studio/features/global-filters/) — filter state that adapters receive via `StudioQueryDescriptor`
- [Cross-filters](/x/react-studio/features/cross-filters/) — click-driven filters that flow through the adapter pipeline
