# `@mui/x-studio-server`

Framework-agnostic server middleware for [MUI X Studio](https://mui.com/x/react-studio/) data pipelines.

Provides a single `handleBatchQuery()` pure function that accepts a batch of widget queries, applies multi-tenant row-level security predicates, routes each query through the optimal execution tier (client / server-memory / database), and returns cached results — all without any HTTP framework dependency.

## Installation

```bash
npm install @mui/x-studio-server knex lru-cache
```

`knex` is a peer dependency. Bring your own database driver (`pg`, `mysql2`, `better-sqlite3`, etc.).

## Quick start

```ts
import express from 'express';
import knex from 'knex';
import { handleBatchQuery, extractSecurityClaims, LRUCacheProvider } from '@mui/x-studio-server';

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
  │    ├── schema allowlist check
  │    └── per widget:
  │         ├── server cache check  (HMAC-scoped LRU)
  │         ├── COUNT(*) pre-flight (< 1ms on indexed tables)
  │         ├── client tier  (≤10k rows) — raw rows, client filters
  │         ├── server tier  (≤100k rows) — aggregate + cache
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

Cache keys incorporate a security hash so users with different row-level permissions never share cache entries. The client's `cacheKey` is never used server-side.

## API

### `handleBatchQuery(body, claims, options)`

| Parameter | Type | Description |
| :--- | :--- | :--- |
| `body` | `BatchQueryRequest` | Parsed request body from the client |
| `claims` | `JwtSecurityClaims` | Pre-verified JWT claims |
| `options.db` | `Knex.Knex` | **Required.** Configured Knex instance |
| `options.schemaAllowlist` | `string[]` | **Required.** Permitted table names |
| `options.cacheProvider` | `CacheProvider` | Default: shared `LRUCacheProvider` |
| `options.thresholds.clientTier` | `number` | Default: `10_000` |
| `options.thresholds.serverMemoryTier` | `number` | Default: `100_000` |

### `extractSecurityClaims(authorizationHeader, secret)`

Verifies an `Authorization: Bearer <token>` HS256 JWT. Throws on any verification failure.

### `generateCacheKey(claims, descriptor, hmacSecret?)`

Generates a deterministic, security-scoped cache key: `studio:v1:<tenantId>:<securityHash>:<queryHash>`. The `queryHash` excludes `widgetId` so widgets with identical queries share one entry.

### `LRUCacheProvider`

In-process size-bounded LRU cache. Constructor options: `maxSizeBytes` (default 128 MB), `ttlMs` (default 30 s).

### `CacheProvider` interface

Implement this interface to use Redis or any other cache backend. Methods: `get(key)`, `set(key, value, ttlSeconds?)`, `invalidatePrefix(prefix)`.

## Routing thresholds (benchmark baseline)

Measured on `node:sqlite` in-memory, covering indexes:

| Row count | COUNT(\*) | GROUP BY SUM | Full scan |
| :--- | :--- | :--- | :--- |
| 10 k | 0.07 ms | 1.65 ms | 12 ms |
| 100 k | 0.73 ms | 18 ms | 127 ms |
| 1 M | 7 ms | 207 ms | 2 200 ms |

Default thresholds (`clientTier: 10_000`, `serverMemoryTier: 100_000`) are derived from these measurements. Tune with `options.thresholds` for your database and hardware.

## Full documentation

[https://mui.com/x/react-studio/data/server-middleware/](https://mui.com/x/react-studio/data/server-middleware/)

## License

This package is part of [MUI X](https://github.com/mui/mui-x) and follows the same licensing terms.
