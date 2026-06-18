# `@mui/x-studio-data-middleware`

Framework-agnostic server middleware for [MUI X Studio](https://mui.com/x/react-studio/) data pipelines.

Provides a single `handleBatchQuery()` pure function that accepts a batch of widget queries, applies multi-tenant row-level security predicates, routes each query through the optimal execution tier (client / server-memory / database), and returns cached results — all without any HTTP framework dependency.

## Installation

```bash
npm install @mui/x-studio-data-middleware knex lru-cache
```

`knex` is a peer dependency. Bring your own database driver (`pg`, `mysql2`, `better-sqlite3`, etc.).

## Quick start

```ts
import express from 'express';
import knex from 'knex';
import {
  handleBatchQuery,
  extractSecurityClaims,
  LRUCacheProvider,
} from '@mui/x-studio-data-middleware';

const db = knex({ client: 'pg', connection: process.env.DATABASE_URL });
const cache = new LRUCacheProvider({ maxSizeBytes: 256 * 1024 * 1024 });

const app = express();
app.use(express.json());

app.post('/api/studio-data', async (req, res) => {
  try {
    const claims = extractSecurityClaims(req.headers.authorization, process.env.JWT_SECRET!);
    const result = await handleBatchQuery(req.body, claims, {
      db,
      cacheProvider: cache,
      schemaAllowlist: ['orders', 'customers', 'products'],
    });
    res.json(result);
  } catch (err) {
    res.status(err.message.includes('JWT') ? 401 : 500).json({ error: err.message });
  }
});
```

On the client, use `createBatchingAdapter` from `@mui/x-studio`:

```ts
import { createBatchingAdapter } from '@mui/x-studio';

const source = {
  id: 'orders',
  fields: [...],
  adapter: createBatchingAdapter('/api/studio-data', {
    fetchFn: (url, init) => fetch(url, {
      ...init,
      headers: { ...init?.headers, Authorization: `Bearer ${getToken()}` },
    }),
  }),
};
```

## Architecture

```text
Browser (N widgets)
  │  createBatchingAdapter — 50ms batch window
  │  one POST per tick
  ▼
POST /api/studio-data
  │  extractSecurityClaims()  — JWT HS256 verification
  │  handleBatchQuery()
  │    ├── schema allowlist check  (table names)
  │    ├── column allowlist check  (column names, if columnAllowlist is set)
  │    └── per widget:
  │         ├── data cache check     (HMAC-scoped LRU / Redis)    ← hit: return rows
  │         ├── tier cache check     (MapTierCacheProvider)        ← hit: skip COUNT(*)
  │         ├── COUNT(*) pre-flight  (< 1ms on indexed tables)    ← miss only
  │         ├── client tier  (<=10k rows) — raw rows, client filters
  │         ├── server tier  (<=100k rows) — aggregate + cache
  │         └── db tier      (>100k rows) — DB push-down GROUP BY
  ▼
BatchQueryResponse  { pageId, results: [{ id, rows, tier, rowCount }] }
```

## Security model

Every query applies security predicates **first**, before any user-supplied filters:

- `tenant_id = :tenantId` — always (multi-tenant isolation)
- `region_id IN (:regionIds)` — when `claims.regionIds` is set
- `department = :department` — when `claims.department` is set

All values use Knex parameterized bindings — never string concatenation.

Table names are validated against `schemaAllowlist` before any query is built. Column names are validated against `columnAllowlist` when provided — this prevents clients from filtering or sorting on security-sensitive columns (such as `password_hash`) that are not intended to be exposed.

Cache keys incorporate a security hash so users with different row-level permissions never share cache entries. The client's `cacheKey` is never used server-side.

## API

### `handleBatchQuery(body, claims, options)`

| Parameter                             | Type                       | Description                                                     |
| :------------------------------------ | :------------------------- | :-------------------------------------------------------------- |
| `body`                                | `BatchQueryRequest`        | Parsed request body from the client                             |
| `claims`                              | `JwtSecurityClaims`        | Pre-verified JWT claims                                         |
| `options.db`                          | `Knex.Knex`                | **Required.** Configured Knex instance                          |
| `options.schemaAllowlist`             | `string[]`                 | **Required.** Permitted table names                             |
| `options.columnAllowlist`             | `Record<string, string[]>` | Per-table column allowlist — strongly recommended in production |
| `options.cacheProvider`               | `CacheProvider`            | Default: shared `LRUCacheProvider`                              |
| `options.tierCacheProvider`           | `TierCacheProvider`        | Default: shared `MapTierCacheProvider` (see below)              |
| `options.tierCacheTtlMs`              | `number`                   | Default: `300_000` (5 min). Set `0` to disable tier cache.      |
| `options.thresholds.clientTier`       | `number`                   | Default: `10_000`                                               |
| `options.thresholds.serverMemoryTier` | `number`                   | Default: `100_000`                                              |
| `options.tenantColumn`                | `string`                   | Column used for tenant isolation (e.g. `'tenant_id'`)           |

### Column allowlist (recommended)

```ts
const result = await handleBatchQuery(req.body, claims, {
  db,
  schemaAllowlist: ['orders', 'customers'],
  columnAllowlist: {
    orders: ['id', 'customer_id', 'total_amount', 'created_at', 'status'],
    customers: ['id', 'name', 'region_id', 'department'],
  },
});
```

If a request references a column not in the list, `handleBatchQuery` throws before any query is executed. When `columnAllowlist` is omitted, no column-level validation is applied (backward-compatible, but not recommended for production).

### Aggregation specs

Use `aggregations` on a `BatchWidgetDescriptor` for DB push-down queries instead of the legacy `sum_`/`avg_`/`count_` column name prefix convention:

```ts
// Preferred
{
  table: 'orders',
  columns: ['status', 'region_id'],
  aggregations: [
    { column: 'total_amount', func: 'sum', alias: 'revenue' },
    { column: 'id', func: 'count', alias: 'order_count' },
  ],
}

// Legacy (deprecated — still supported for backward compatibility)
{
  table: 'orders',
  columns: ['status', 'region_id', 'sum_total_amount', 'count_id'],
}
```

### HAVING filters

Use `having` on a `BatchWidgetDescriptor` to filter aggregated results after `GROUP BY`. Each entry references an aggregation alias — never a raw column name (validated by the middleware before execution):

```ts
{
  table: 'orders',
  columns: ['region'],
  aggregations: [
    { column: 'total_amount', func: 'sum', alias: 'revenue' },
    { column: 'id', func: 'count', alias: 'order_count' },
  ],
  having: [
    { alias: 'revenue', operator: 'gt', value: 10000 },
  ],
}
// → SELECT region, SUM(total_amount) AS revenue, COUNT(id) AS order_count
//   FROM orders WHERE tenant_id = ?
//   GROUP BY region HAVING revenue > 10000
```

`HavingPredicate` supports `eq`, `gt`, `lt`, `gte`, and `lte`. Only numeric comparisons are allowed.

### Joins

Multi-table queries are supported via `joins` on a `BatchWidgetDescriptor`. All joined table names must appear in `schemaAllowlist`:

```ts
{
  table: 'orders',
  columns: ['orders.id', 'orders.status', 'customers.name'],
  joins: [
    {
      table: 'customers',
      type: 'left',
      on: [['orders.customer_id', 'customers.id']],
    },
  ],
  filters: [{ column: 'customers.region_id', operator: 'eq', value: 3 }],
}
```

Security predicates are applied to the primary table only (`orders.tenant_id = :tenantId`).

### `extractSecurityClaims(authorizationHeader, secret)`

Verifies an `Authorization: Bearer <token>` HS256 JWT. Throws on any verification failure.

### `generateCacheKey(claims, descriptor, hmacSecret?)`

Generates a deterministic, security-scoped cache key: `studio:v1:<tenantId>:<securityHash>:<queryHash>`. The `queryHash` excludes `widgetId` so widgets with identical queries share one entry.

### `LRUCacheProvider`

In-process size-bounded LRU cache. Constructor options: `maxSizeBytes` (default 128 MB), `ttlMs` (default 30 s), `avgBytesPerRow` (default 512 — tune upward for schemas with large text columns). **Not suitable for multi-node deployments** — each process maintains an independent cache. Use `RedisCacheProvider` instead.

### `MapTierCacheProvider`

Lightweight in-process tier routing cache. Stores the routing tier (`client` / `server` / `db`) and preflight row count per query key, with per-entry TTL. This avoids re-running a `COUNT(*)` preflight on repeated cold data-cache misses within the tier-cache window.

```text
Steady-state request pattern (data cache TTL = 30 s, tier cache TTL = 5 min):

t=0s   cold miss  → COUNT(*) preflight runs, tier cached, data fetched and cached
t=30s  cold miss  → tier cache hit, COUNT(*) skipped, data fetched and cached  ← 49–53% faster
t=60s  cold miss  → tier cache hit, COUNT(*) skipped ...
t=300s cold miss  → tier expired, COUNT(*) runs again, tier re-cached
```

The tier cache is enabled by default. To disable it for a specific call, pass `tierCacheTtlMs: 0`:

```ts
await handleBatchQuery(body, claims, {
  db,
  schemaAllowlist: ['orders'],
  tierCacheTtlMs: 0, // always run COUNT(*) preflight
});
```

For multi-node deployments implement the `TierCacheProvider` interface against Redis (same pattern as `CacheProvider`) and pass it via `options.tierCacheProvider`.

### `RedisCacheProvider`

Distributed cache backed by any Redis-compatible client (`ioredis` or `node-redis` v4+):

```ts
import Redis from 'ioredis';
import { RedisCacheProvider } from '@mui/x-studio-data-middleware';

const redis = new Redis({ host: 'localhost', port: 6379 });
const cache = new RedisCacheProvider(redis, {
  defaultTtlSeconds: 60,
  keyPrefix: 'studio:prod:',
});
```

Constructor options: `defaultTtlSeconds` (default `60`), `keyPrefix` (optional — use when sharing a Redis instance across deployments).

### `RedisTierCacheProvider`

Distributed tier routing cache backed by any Redis-compatible client. Use this in multi-node deployments so all instances share the same tier routing state — otherwise each node runs its own COUNT(\*) preflight after the data cache expires.

```ts
import Redis from 'ioredis';
import { RedisCacheProvider, RedisTierCacheProvider } from '@mui/x-studio-data-middleware';

const redis = new Redis({ host: 'localhost', port: 6379 });

await handleBatchQuery(payload, {
  db,
  allowedTables: [...],
  cacheProvider:     new RedisCacheProvider(redis, { defaultTtlSeconds: 30 }),
  tierCacheProvider: new RedisTierCacheProvider(redis, { defaultTtlSeconds: 300 }),
});
```

Constructor options: `defaultTtlSeconds` (default `300`), `keyPrefix` (optional). The `set(key, value, ttlMs?)` call converts milliseconds to seconds (rounds up), matching the `TierCacheProvider` interface which uses `ttlMs`.

### `CacheProvider` interface

Implement this interface to use a custom data cache backend (e.g. Redis). Methods: `get(key)`, `set(key, value, ttlSeconds?)`, `invalidatePrefix(prefix)`.

### `TierCacheProvider` interface

Implement this interface to use a custom tier routing cache backend (e.g. Redis for multi-node). Methods: `get(key)`, `set(key, value, ttlMs?)`, `invalidatePrefix(prefix)`. Built-in implementations: `MapTierCacheProvider` (in-process `Map` with per-entry TTL) and `RedisTierCacheProvider` (distributed).

## Routing thresholds (benchmark baseline)

Measured on `node:sqlite` in-memory, covering indexes:

| Row count | COUNT(\*) | GROUP BY SUM | Full scan |
| :-------- | :-------- | :----------- | :-------- |
| 10 k      | 0.07 ms   | 1.65 ms      | 12 ms     |
| 100 k     | 0.73 ms   | 18 ms        | 127 ms    |
| 1 M       | 7 ms      | 207 ms       | 2 200 ms  |

Default thresholds (`clientTier: 10_000`, `serverMemoryTier: 100_000`) are derived from these measurements. Tune with `options.thresholds` for your database and hardware.

## Full documentation

[https://mui.com/x/react-studio/data/server-middleware/](https://mui.com/x/react-studio/data/server-middleware/)

## License

This package is part of [MUI X](https://github.com/mui/mui-x) and follows the same licensing terms.
