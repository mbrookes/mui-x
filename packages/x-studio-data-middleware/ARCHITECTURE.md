# Architecture

Internal reference for how `@mui/x-studio-data-middleware` is put together. For install/quick-start, see [`README.md`](./README.md).

## Overview

This package is a framework-agnostic (no HTTP imports), driver-agnostic (no `knex` import, only structural typing) server middleware that turns a batch of widget query/mutation descriptors into SQL, executed through a host-supplied Knex instance, with multi-tenant row-level security and a two-plane caching system.

Two pure entry points, both `(body, claims, options) => Promise<Response>`:

- `handleBatchQuery` — reads. Routes each widget query through the cheapest adequate execution tier (client / server-memory / db) and caches results.
- `handleMutation` — writes (insert/update/delete). Enforces tenant-safety invariants and invalidates the read cache.

Everything else in the package exists to support those two functions.

## Public API surface (`src/index.ts`)

- Handlers: `handleBatchQuery`, `handleMutation`
- Security: `extractSecurityClaims`, `generateCacheKey`
- Cache: interfaces `CacheProvider`, `TierCacheProvider`; implementations `LRUCacheProvider`, `MapTierCacheProvider`, `RedisCacheProvider`, `RedisTierCacheProvider`
- Types: `JwtSecurityClaims`, `BatchQueryRequest`/`BatchQueryResponse`, `BatchWidgetDescriptor`, `WidgetQueryResult`, `FilterPredicate`, `OrderBy`, `AggregationSpec`, `JoinDescriptor`, `HandleBatchQueryOptions`, `MutationDescriptor`/`MutationResult`, `BatchMutationRequest`/`BatchMutationResponse`, `HandleMutationOptions`

Internals of `router/`, `mutations/mutationBuilder.ts`, and `security/cacheKey.ts` are intentionally not exported — only the two handlers and their types are public.

## Module map

| Path | Responsibility |
| :-- | :-- |
| `handler.ts` | `handleBatchQuery` — allowlist validation, per-widget tier routing + cache, batch assembly |
| `router/preflight.ts` | `runPreflight` (COUNT(\*) → tier), `executeForTier` (builds/runs the real query per tier) |
| `router/queryBuilder.ts` | `buildSecureQuery` — the single choke point where joins, security predicates, filters, and having are applied |
| `router/tierDecision.ts` | `decideTier`/`decideTierWithCache` — client/server/db tier decision tree + tier-cache read/write |
| `mutations/handleMutation.ts` | `handleMutation` — allowlist validation, per-mutation dispatch + cache invalidation |
| `mutations/mutationBuilder.ts` | `validateMutation`, `buildInsertMutation`/`buildUpdateMutation`/`buildDeleteMutation` |
| `security/extractSecurityClaims.ts` | Demo JWT verifier → `JwtSecurityClaims` (the trust boundary object) |
| `security/cacheKey.ts` | `generateCacheKey` — HMAC security hash + SHA-256 query-shape hash |
| `security/types.ts` | All wire/option type definitions |
| `cache/` | `CacheProvider`/`TierCacheProvider` interfaces + LRU (in-process) and Redis (multi-node) implementations |
| `benchmarks/` | Standalone perf harness (`pnpm bench`) over cache keying, cache hit/miss, invalidation, preflight, and full-pipeline cold/warm |

## Core data flow

### Read path — `handleBatchQuery(body, claims, options)`

1. **Table allowlist** ("Zero-Knowledge Rule"): every `widget.table` + all `widget.joins[].table` across the whole batch is checked against `options.schemaAllowlist`; any violation rejects the *entire* request before any query is built.
2. **Column allowlist**: `columns`/`filters[].column`/`orderBy[].column`/`aggregations[].column` are checked against `options.columnAllowlist`, resolving `columnAliases` first. `having[].alias` must match a declared `aggregations[].alias` — this is what stops HAVING from reaching arbitrary raw columns.
3. Each widget in the batch is processed **in parallel** (`Promise.all`), with **per-widget error isolation** — a failed widget returns `{ rows: [], tier: 'db', rowCount: 0, error }` rather than failing the batch. Per widget:
   - Compute `cacheKey = generateCacheKey(claims, descriptor)`.
   - Data cache hit → return cached rows immediately (reported `tier: 'server'`).
   - Miss → `decideTierWithCache`: aggregation descriptors are forced to tier `'db'` immediately (no COUNT(\*), no tier-cache I/O). Otherwise check the tier cache; on miss, `runPreflight` runs a `COUNT(*)` through `buildSecureQuery` and maps the count to `'client' | 'server' | 'db'` via `options.thresholds` (default 10k / 100k rows), then persists the decision to the tier cache.
   - `executeForTier` builds and runs the real query via `buildSecureQuery` again: `'client'`/`'server'` tiers return raw filtered rows (SELECT/ORDER BY/LIMIT); `'db'` tier pushes a GROUP BY/aggregate query down to the database.
   - Non-`'db'` results are written into the data cache, tagged with the primary table name.
4. Returns `{ pageId, results }`.

### Write path — `handleMutation(body, claims, options)`

1. Same upfront table-allowlist check across all mutations (rejects the whole request on violation).
2. Each mutation processed in parallel with per-item error isolation (`{ ok: false, error }` on failure, doesn't abort the batch):
   - `validateMutation`: `update`/`delete` **must** carry ≥1 `where` predicate (insert is exempt) — prevents accidental full-table mutations. `where[].column` validated against `columnAllowlist`; `values` keys validated against `writableColumns`, explicitly rejecting the tenant column if the client tries to set it.
   - Dispatch to `buildInsertMutation` / `buildUpdateMutation` / `buildDeleteMutation`.
   - On success, if `options.cacheProvider` is supplied, `cacheProvider.deleteByTag(descriptor.table)` evicts every cached read result for that table — this is the entire cache-invalidation story, no manual invalidation endpoint needed.
3. Returns `{ results }`.

## Key design invariants

These must hold for any change to this package to be safe:

1. **Zero-Knowledge Rule** — nothing outside `schemaAllowlist` / `columnAllowlist` / `writableColumns` is ever reachable, checked *before* any query is built, for the whole batch at once (not per-widget) so one bad descriptor can't slip through alongside valid ones.
2. **Security predicates are unconditional and injected first** — tenant (`WHERE table.tenantColumn = claims.tenantId`), region, and department predicates are applied in `buildSecureQuery`/the mutation builders *before* any user-supplied filter or WHERE, and update/delete always overwrite `values[tenantColumn]`/strip it from client `values`. A client can never override, remove, or "AND-away" these predicates, nor move a row to another tenant.
3. **All SQL is parameterized** — every value and identifier reaches Knex via `?`/`??` bindings (`db.raw('?? as ??', ...)`, `havingRaw('?? op ?', ...)`). No string-concatenated SQL anywhere.
4. **Cache keys are opaque** — `generateCacheKey` HMACs the security-claims portion specifically so a client cannot guess or enumerate another tenant's cache key.
5. **No hard Knex/Redis dependency** — `db` is typed `any` and only called through Knex's chainable builder API (duck typing); `RedisClient` is a minimal structural interface compatible with both `ioredis` and `node-redis` v4+. Don't add a literal `import ... from 'knex'` or a specific Redis client import to core logic.
6. **Two independent cache planes** — the *data* cache (`CacheProvider`, rows, short TTL ~30–60s) and the *tier* cache (`TierCacheProvider`, routing decisions only, longer TTL ~5min) are separate because tier boundaries shift far less often than the underlying data. `tierCacheTtlMs: 0` disables the tier cache for benchmarking/testing.
7. **Batch-level isolation, request-level rejection** — allowlist violations reject the whole batch (fail fast, nothing partially executes against disallowed tables); per-item *execution* errors (a bad filter value, a DB error) are isolated to that one widget/mutation result.

## Testing & benchmarks

- `src/__tests__/` covers `handler.ts` end-to-end against an in-memory `mockDb.ts` (a Knex-compatible fake, not a real SQL engine).
- `src/benchmarks/run.ts` (`pnpm --filter "@mui/x-studio-data-middleware" bench`) measures, at 5 warmup + 50 timed iterations: cache-key generation cost, LRU hit/miss, LRU set+get, `invalidatePrefix` cost at scale, `runPreflight` cost, and full `handleBatchQuery` cold/warm/tier-cache-only scenarios, using a deterministic `syntheticData.ts` row generator so runs are comparable across commits.

## Extension points

- **New cache backend**: implement `CacheProvider` and/or `TierCacheProvider` (see `cache/types.ts`) and pass it via `options.cacheProvider`/`options.tierCacheProvider` — `LRUCacheProvider`/`RedisCacheProvider` are just the two provided implementations.
- **New filter operator**: add to the `SAFE_OPERATORS` allowlist and `applyPredicate` in `router/queryBuilder.ts`, and mirror it in `mutations/mutationBuilder.ts`'s `applyMutationPredicate` (these two are currently independent implementations of the same operator set — keep them in sync by hand).
- **New join type**: extend `JoinDescriptor.type` in `security/types.ts` and the join-application branch in `buildSecureQuery`.
