# Architecture

Internal reference for how `@mui/x-studio-data-middleware` is put together. For install/quick-start, see [`README.md`](./README.md).

## Overview

`@mui/x-studio-data-middleware` is a framework-agnostic (no HTTP framework imports), driver-agnostic (no literal `import ... from 'knex'` in source — `db` is duck-typed as `any` and only called through Knex's chainable builder API) server middleware. It turns a batch of widget query/mutation descriptors sent by an MUI X Studio dashboard into parameterized SQL, executed through a host-supplied Knex instance, with multi-tenant row-level security and a two-plane (data + tier) caching system.

Two pure entry points:

- `handleBatchQuery(body, claims, options)` — reads. Routes each widget query through the cheapest adequate execution tier (`client` / `server` / `db`) and caches results.
- `handleMutation(body, claims, options)` — writes (insert/update/delete). Enforces tenant-safety invariants and invalidates the read cache.

Everything else in the package exists to support those two functions. The host application is responsible for parsing the HTTP request body, calling `extractSecurityClaims()` to obtain verified claims, providing a configured Knex instance, and writing the returned response object back to the HTTP response.

## Public API surface (`src/index.ts`)

- Handlers: `handleBatchQuery` (`src/handler.ts`), `handleMutation` (`src/mutations/handleMutation.ts`)
- Security: `extractSecurityClaims` (`src/security/extractSecurityClaims.ts`), `generateCacheKey` (`src/security/cacheKey.ts`)
- Cache: interfaces `CacheProvider`, `CacheEntry`, `TierCacheProvider`, `TierEntry` (`src/cache/types.ts`); implementations `LRUCacheProvider`, `MapTierCacheProvider`, `RedisCacheProvider` (+ `RedisClient`, `RedisCacheProviderOptions`), `RedisTierCacheProvider` (+ `RedisTierCacheProviderOptions`)
- Types (all from `src/security/types.ts`): `JwtSecurityClaims`, `BatchQueryRequest`/`BatchQueryResponse`, `BatchWidgetDescriptor`, `WidgetQueryResult`, `FilterPredicate`, `HavingPredicate`, `OrderBy`, `AggregationSpec`, `JoinDescriptor`, `SecurityColumns`, `SecurityColumnsConfig`, `HandleBatchQueryOptions`, `MutationDescriptor`/`MutationResult`, `BatchMutationRequest`/`BatchMutationResponse`, `HandleMutationOptions`

Internals of `router/`, `mutations/mutationBuilder.ts`, `shared/predicates.ts`, `shared/columnValidation.ts`, `shared/assertTablesAllowed.ts`, and `security/cacheKey.ts`'s helper functions are intentionally not exported — only the two handlers, the security/cache utilities above, and their types are public.

## Module map

| Path                                | Responsibility                                                                                                                                                                                                      |
| :---------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `handler.ts`                        | `handleBatchQuery` — pure orchestration: upfront allowlist checks, per-widget tier routing + cache, batch assembly                                                                                                  |
| `router/preflight.ts`               | `runPreflight` — COUNT(\*) → row count. Nothing else lives here.                                                                                                                                                    |
| `router/execute.ts`                 | `executeForTier` — builds/runs the real query per tier (projection / GROUP BY / aggregation / ORDER BY / LIMIT)                                                                                                     |
| `router/queryBuilder.ts`            | `buildSecureQuery` — single choke point where joins, security predicates, filters, and HAVING are applied                                                                                                           |
| `router/tierDecision.ts`            | `decideTierWithCache` — client/server/db decision tree + tier-cache read/write                                                                                                                                      |
| `mutations/handleMutation.ts`       | `handleMutation` — allowlist validation, sequential per-mutation dispatch + cache invalidation                                                                                                                      |
| `mutations/mutationBuilder.ts`      | `validateMutation`, `buildInsertMutation`/`buildUpdateMutation`/`buildDeleteMutation`                                                                                                                               |
| `shared/predicates.ts`              | `applyPredicates`, `applySecurityPredicates`, `SAFE_OPERATORS`, security-column resolution — shared by the read and write builders                                                                                  |
| `shared/columnValidation.ts`        | `checkColumnAgainstAllowlist`, `validateDescriptorColumns`, `validateHavingAliases` — fail-closed column-allowlist and HAVING-alias checks shared by the read (`handler.ts`) and write (`mutationBuilder.ts`) paths |
| `shared/assertTablesAllowed.ts`     | `assertTablesAllowed` — the Zero-Knowledge table-allowlist check shared by `handler.ts` and `handleMutation.ts`                                                                                                     |
| `security/extractSecurityClaims.ts` | Demo JWT verifier → `JwtSecurityClaims` (the trust boundary object)                                                                                                                                                 |
| `security/cacheKey.ts`              | `generateCacheKey` — HMAC security hash + SHA-256 query-shape hash                                                                                                                                                  |
| `security/types.ts`                 | All wire/option type definitions, including `SecurityColumns`/`SecurityColumnsConfig`                                                                                                                               |
| `cache/`                            | `CacheProvider`/`TierCacheProvider` interfaces + LRU/Map (in-process) and Redis (multi-node) implementations; `cache/redisCompat.ts` holds wire-shape helpers shared by both Redis providers                        |
| `benchmarks/`                       | Standalone perf harness (`pnpm bench`) over cache keying, cache hit/miss, invalidation, preflight, and full-pipeline cold/warm                                                                                      |

## Core data flow

### Read path — `handleBatchQuery(body, claims, options)`

1. **Table allowlist** ("Zero-Knowledge Rule"): every `widget.table` plus all `widget.joins[].table`, across the _whole_ batch, is checked against `options.schemaAllowlist` via the shared `assertTablesAllowed()` (`shared/assertTablesAllowed.ts`). Any violation rejects the entire request before any query is built.
2. **HAVING-alias validation** — runs **unconditionally** for every widget via `validateHavingAliases()` (`shared/columnValidation.ts`), independent of whether a column allowlist is configured: `having[].alias` must match a declared `aggregations[].alias`, and a `having` clause on a widget with no `aggregations` at all is rejected. This is what stops HAVING from reaching arbitrary raw columns.
3. **Column allowlist** (only when `options.columnAllowlist` is supplied): `validateDescriptorColumns()` (`shared/columnValidation.ts`) checks `columns`, `filters[].column`, `orderBy[].column`, `aggregations[].column`, and both sides of every `joins[].on` pair against the allowlist via the shared `checkColumnAgainstAllowlist()`, resolving `columnAliases` first. This check is **fail-closed**: if a referenced table has no entry in `columnAllowlist` at all, the request is rejected (a table can opt out of column checking by listing `['*']`). The same `checkColumnAgainstAllowlist()` helper is reused, unmodified, by the write path's `validateMutation()`.
4. Each widget in the batch is processed **in parallel** (`Promise.all`) via `processWidget()`, with **per-widget error isolation** — a failed widget returns `{ id, rows: [], tier: 'db', rowCount: 0, error }` rather than failing the whole batch. Per widget:
   - Compute `cacheKey = generateCacheKey(claims, descriptor)`.
   - **Data cache check**: on a hit, return the cached rows immediately, echoing back the `tier` stored on the cache entry (falls back to `'server'` for legacy entries that predate the `tier` field — this avoids silently reporting a `'client'`-tier result as `'server'`), and echoing the `rowCount` persisted on the cache entry (falling back to `cached.rows.length` for legacy entries written before `rowCount` was persisted) — see `CacheEntry` under "Caching layer" below.
   - On a miss, call `decideTierWithCache()` (see Tier decision below) to determine `'client' | 'server' | 'db'`.
   - `executeForTier()` (`router/execute.ts`) builds and runs the real query via `buildSecureQuery()`: `'client'`/`'server'` tiers return raw filtered rows (SELECT/ORDER BY/LIMIT); `'db'` tier pushes a GROUP BY/aggregate query down to the database. Both tiers table-qualify unqualified ORDER BY columns (matching how SELECT/GROUP BY are already qualified) to avoid ambiguous-column errors under joins; an ORDER BY targeting an aggregation alias is left unqualified since it isn't a physical column.
   - For aggregation descriptors, the reported `rowCount` is overridden to the actual number of result groups (the tier decision itself bypasses COUNT(\*) for aggregations — see below).
   - Non-`'db'` results are written into the data cache together with the `rowCount` that produced them, tagged with the primary table name **and** every joined table name — tagging only the primary table would leave a joined result stale until TTL after a mutation to the joined table. Persisting `rowCount` on the entry (rather than only `rows`) is what lets a later cache hit report the same total as the original cold miss instead of the (possibly limit-truncated) `rows.length`.
5. Returns `{ pageId, results }`.

### Tier decision (`router/tierDecision.ts`)

`decideTierWithCache()` is the single source of truth for routing:

1. **Aggregation queries** (`descriptor.aggregations?.length > 0`) are forced to tier `'db'` immediately — no COUNT(\*), no tier-cache read or write. The row count is irrelevant once the result is a set of aggregated groups rather than raw rows.
2. Otherwise, a **tier-cache hit** short-circuits: the previously-decided tier and preflight row count are reused, skipping `runPreflight`.
3. On a **tier-cache miss**, `runPreflight()` (`router/preflight.ts`) runs a `COUNT(*)` through `buildSecureQuery()` (full security + user-filter predicates applied, no SELECT/columns) and `tierFromRowCount()` maps it to a tier using `DEFAULT_THRESHOLDS = { client: 10_000, server: 100_000 }` (overridable via `options.thresholds.clientTier` / `serverMemoryTier`). If a `tierCacheTtlMs` was given, the decision is persisted to the tier cache.

### Write path — `handleMutation(body, claims, options)`

1. Same upfront table-allowlist check across all mutations, via the same shared `assertTablesAllowed()` used by the read path (rejects the whole request on violation).
2. Each mutation is processed **sequentially** — a `for...await` loop in `handleMutation()`, not `Promise.all` — via `processMutation()`, with per-item error isolation (`{ id, ok: false, error }` on failure — doesn't abort the batch). Running in array order (rather than concurrently) makes a batch like `[insert row, update that row]` deterministic: the update observes the insert's effect instead of racing it. Batch sizes are small in practice, so this trades a small amount of latency for correctness.
   - `validateMutation()`: `update`/`delete` **must** carry at least one `where` predicate (insert is exempt) — prevents accidental full-table mutations. `where[].column` is validated against `columnAllowlist` (when supplied) via the shared `checkColumnAgainstAllowlist()`; `values` keys are validated against `writableColumns` the same way. It also resolves the table's security columns via `resolvePrimarySecurityColumns()` and calls `validateSecurityColumnValues()`, which rejects a client-supplied tenant column outright, and rejects a client-supplied region/department value that falls outside the caller's `regionIds`/`department` claims — so a region-5 caller cannot stamp a row into region 6.
   - Dispatch to `buildInsertMutation` / `buildUpdateMutation` / `buildDeleteMutation`.
   - On success, if `options.cacheProvider` is supplied, `cacheProvider.deleteByTag(descriptor.table)` evicts every cached read result tagged with that table — this is the entire cache-invalidation story; there is no manual invalidation endpoint.
3. Returns `{ results }`.

## Shared predicate / security-predicate model (`src/shared/predicates.ts`)

This module is the single source of truth for row-level security and structured-filter translation, used identically by both the read path (`router/queryBuilder.ts`'s `buildSecureQuery`) and the write path (`mutations/mutationBuilder.ts`'s `buildUpdateMutation`/`buildDeleteMutation`).

- **`SAFE_OPERATORS`** — a `Set` of the only filter operators ever translated to SQL: `eq`, `neq`, `in`, `lt`, `lte`, `gt`, `gte`, `like`, `between`. An operator outside this set always throws, on both reads and writes — never silently dropped.
- **`resolvePrimarySecurityColumns(table, config, tenantColumnFallback)`** — resolves the tenant/region/department column names for a query's _primary_ table. Falls back to hardcoded `region_id` / `department`, and to the legacy `tenantColumn` option for the tenant column, so deployments that only set `tenantColumn` keep working unchanged.
- **`resolveJoinSecurityColumns(table, config)`** — resolves security columns for a _joined_ table. A joined table is only scoped when it has an explicit `securityColumns.perTable[table]` entry that declares a `tenant` column; without one it's treated as a shared/lookup table and receives no predicate. Region/department are opt-in per joined table with no defaults, since an arbitrary joined table can't be assumed to have those columns.
- **`applySecurityPredicates(query, table, claims, securityColumns)`** — applies `WHERE table.tenant = claims.tenantId`, `WHERE table.region IN claims.regionIds` (only when `regionIds` is non-empty), and `WHERE table.department = claims.department` (only when present), for whichever dimensions have both a configured column name and a matching claim. Called **before** any user-supplied filter/WHERE in every caller, so it can never be overridden or AND-ed away.
- **`applyPredicates(query, predicates, mode)`** / **`applyPredicate`** — translate `FilterPredicate[]` into Knex `.where`/`.whereIn`/`.whereLike`/`.whereBetween` calls. The `mode: 'read' | 'write'` parameter governs one deliberate divergence:
  - An empty `in` list means "match nothing." On `'read'` this is a no-op and the predicate is silently dropped (mirrors the client's empty-selection semantics — a widget with no selected values should show nothing extra removed).
  - On `'write'`, dropping an empty `in` would silently widen a scoped UPDATE/DELETE into an unscoped, full-tenant mutation, so it **throws** instead.
  - An unrecognized operator always throws, in both modes.

Both `buildSecureQuery` (reads) and `buildUpdateMutation`/`buildDeleteMutation` (writes) call `applySecurityPredicates` first, then `applyPredicates` with the appropriate `mode`, guaranteeing the tenant/region/department scope is applied identically and cannot be bypassed from either path.

## Security & claims model

### `JwtSecurityClaims` (`src/security/types.ts`)

```ts
interface JwtSecurityClaims {
  tenantId: string; // primary isolation boundary
  userId: string;
  roleIds: string[];
  regionIds?: number[]; // optional row-level region restriction
  department?: string; // optional row-level department restriction
}
```

The package never authenticates; it only consumes pre-verified claims that the host constructs (typically via `extractSecurityClaims`).

### `SecurityColumns` / `SecurityColumnsConfig` (`src/security/types.ts`)

```ts
interface SecurityColumns {
  tenant?: string;
  region?: string;
  department?: string;
}

interface SecurityColumnsConfig extends SecurityColumns {
  perTable?: Record<string, SecurityColumns>;
}
```

The top-level `tenant`/`region`/`department` act as defaults for the primary table (defaulting further to `tenantColumn`, `'region_id'`, and `'department'` respectively). `perTable` overrides per table and is the only way to security-scope a _joined_ table — see `resolveJoinSecurityColumns` above. This shape is passed as `HandleBatchQueryOptions.securityColumns` / `HandleMutationOptions.securityColumns` and consumed exclusively through `src/shared/predicates.ts`.

### `extractSecurityClaims` (`src/security/extractSecurityClaims.ts`)

A demonstration HMAC-SHA256 (HS256) JWT verifier — pure, no HTTP dependency — intended to be replaced in production with a real IdP verification library (`jose`, `jsonwebtoken`, etc.). It:

- Requires a non-empty `jwtSecret` (defaults to `process.env.JWT_SECRET`); throws if empty rather than verifying against an empty key.
- Parses `"Bearer <token>"`, splits the JWT into header/payload/signature, and recomputes the HS256 signature over `header.payload`.
- Compares expected vs. actual signature lengths **before** calling `timingSafeEqual` (which otherwise throws a `RangeError` on mismatched lengths instead of failing cleanly) — a truncated/garbage signature surfaces as a normal auth error.
- Checks `exp` against the current time, and requires `tenantId` and `sub` in the payload.
- Returns `{ tenantId, userId: sub, roleIds, regionIds, department }`.

### `generateCacheKey` (`src/security/cacheKey.ts`)

Produces a key of the form `studio:v1:<tenantId>:<securityHash>:<queryHash>`:

- **`securityHash`** — HMAC-SHA256 (16 hex chars) over a sorted-JSON `{ tenantId, regionIds (sorted), department }` profile, keyed by `hmacSecret` (default `CACHE_HMAC_SECRET`, falling back to `JWT_SECRET`). Two users with identical row-level permissions intentionally share a hash (and thus a cache entry) for cache efficiency. Memoized in a module-level `Map` bounded to `MAX_MEMO_SIZE = 1_000` entries (oldest evicted on overflow) so the HMAC cost is paid at most once per unique permission set.
- **`queryHash`** — SHA-256 (16 hex chars) over the widget descriptor with `id` excluded (so two structurally identical widgets share a cache entry) and object keys recursively sorted (so property insertion order never affects the hash; array/filter order is preserved and _does_ affect it).
- Throws if no HMAC secret is configured — an empty key would make the security hash guessable, breaking the "a client can't forge another tenant's cache key" guarantee.

## Query path in detail

### `buildSecureQuery` (`router/queryBuilder.ts`)

Given a validated `BatchWidgetDescriptor`, builds (but does not execute) a Knex query in this order:

1. **Joins** — for each `descriptor.joins[]`, a single `join`/`leftJoin`/`rightJoin` call with one `.on()` per `[left, right]` pair inside a callback, so a composite-key join produces one join clause, not one per pair (avoiding "table name not unique" SQL errors).
2. **Security predicates** — `applySecurityPredicates` for the primary table (via `resolvePrimarySecurityColumns`), then for each joined table (via `resolveJoinSecurityColumns`, which no-ops for tables without a `perTable` tenant column).
3. **User filters** — each predicate's column is first resolved through `descriptor.columnAliases` (logical ID → physical column, the same resolution `validateDescriptorColumns` already applies when checking the column against `columnAllowlist`), then `applyPredicates(query, resolvedFilters, 'read')` builds the WHERE clause against the resolved physical column. Filter columns must be alias-resolved before execution for the same reason SELECT/ORDER BY/aggregation columns already are (`execute.ts`'s `physicalCol`) — otherwise a client could pass an allowlisted alias for validation while the WHERE clause silently ran against the real, unresolved (and potentially non-allowlisted) column name.
4. **HAVING** — `applyHaving()` for each `descriptor.having[]` entry, using `query.havingRaw('?? op ?', [alias, value])` (identifier-bound alias, parameterized value); the alias is pre-validated by `handler.ts` (via `validateHavingAliases()` in `shared/columnValidation.ts`) against `aggregations[].alias`.

### `runPreflight` (`router/preflight.ts`) / `executeForTier` (`router/execute.ts`)

`preflight.ts` holds only the COUNT(\*) logic; the tier-specific SELECT/GROUP BY/aggregate construction lives in the sibling `router/execute.ts`.

- `runPreflight()` calls `buildSecureQuery(...).count('* as row_count')` and returns just the numeric row count (coercing a string result). It does not decide the tier itself — that logic lives entirely in `tierDecision.ts`.
- `executeForTier()` (`router/execute.ts`):
  - `'client'`/`'server'`: rebuilds via `buildSecureQuery`, adds a `.select()` projecting each `descriptor.columns` entry (resolving `columnAliases` — `SELECT physical AS logical` via `db.raw('?? as ??', ...)` for expression/cross-source fields, otherwise table-qualifying bare columns to avoid join ambiguity), then `.orderBy()`/`.limit()`. ORDER BY columns are table-qualified the same way SELECT columns are (an aggregation alias is left as-is, since it isn't a physical column) — this applies to both tiers, not just SELECT/GROUP BY.
  - `'db'`: rebuilds via `buildSecureQuery`, splits `columns` into GROUP BY dimension columns vs. pure-measure columns (columns whose aggregation alias equals the column name, e.g. `SUM(total) AS total`, which must appear only in the aggregate clause, not GROUP BY), qualifies unqualified columns with the primary table to avoid ambiguous-column errors under joins, applies `.sum()/.avg()/.count()/.min()/.max()` per `AggregationSpec`, then `.orderBy()` (mapping an ORDER BY on an aggregation alias to itself, since it isn't a physical column, and otherwise table-qualifying it like SELECT/GROUP BY) and `.limit()`.

## Mutation path in detail (`mutations/mutationBuilder.ts`)

- **`validateMutation`** — requires `where` for `update`/`delete`; resolves the table's security columns via `resolvePrimarySecurityColumns()` (the shared `securityColumns`-or-`tenantColumn` resolution used everywhere else); validates `where[].column` against `columnAllowlist` (when supplied) and `values` keys against `writableColumns`, both via the shared `checkColumnAgainstAllowlist()` from `shared/columnValidation.ts` (fail-closed, `'*'`-aware — a referenced table with no allowlist entry is rejected). It also calls `validateSecurityColumnValues()`, which throws if the client-supplied `values` set the tenant column directly, or set a region/department value outside the caller's `claims.regionIds`/`claims.department` — independent of the writable-columns check.
- **`buildInsertMutation`** — resolves the tenant column via `resolvePrimarySecurityColumns(table, securityColumns, tenantColumn)` and unconditionally sets `values[cols.tenant] = claims.tenantId` (overriding any client-supplied value) before `db(table).insert(values)`. Resolving through `resolvePrimarySecurityColumns` (rather than only the legacy `tenantColumn` option) is what makes INSERT tenant-stamping work for deployments that configure tenancy solely through `securityColumns`/`securityColumns.perTable`.
- **`buildUpdateMutation`** / **`buildDeleteMutation`** — resolve security columns via `resolvePrimarySecurityColumns`, call `applySecurityPredicates` first (unconditional, unbypassable scope), then `applyPredicates(query, descriptor.where, 'write')` (empty `in` throws rather than widening the mutation). `buildUpdateMutation` additionally strips the tenant column from the client's `values` so a row can never be re-tenanted.

## Caching layer (`src/cache/`)

Two independent cache planes exist because tier boundaries shift far less often than the underlying data:

- **Data cache** (`CacheProvider`) — caches actual result rows, keyed by `generateCacheKey()`. Short TTL (LRU default 30s, Redis default 60s).
- **Tier cache** (`TierCacheProvider`) — caches only the routing decision (`tier`, `rowCount`) from a preflight, not row data. Longer-lived so repeated cold data-cache misses skip the COUNT(\*) preflight entirely. `handler.ts`'s own `DEFAULT_TIER_CACHE_TTL_MS = 30_000` is what's actually used in practice (always passed explicitly to `set()`); provider-level defaults (`MapTierCacheProvider` 300_000ms, `RedisTierCacheProvider` 300s) only apply to standalone usage outside `handler.ts`. Setting `HandleBatchQueryOptions.tierCacheTtlMs = 0` disables the tier cache entirely (`handler.ts` passes `null` as the provider in that case).

### `CacheProvider` / `TierCacheProvider` interfaces (`cache/types.ts`)

- `CacheProvider.get/set/invalidatePrefix/deleteByTag` — `set()` takes `{ ttlMs?, tags? }`. `invalidatePrefix(prefix)` removes all keys sharing a prefix (used for tenant-scoped eviction — the Studio key format embeds `tenantId` as the 3rd segment). `deleteByTag(tag)` removes all entries written with a matching tag (used for table-level invalidation after a mutation). Both are documented as O(matched entries), not full scans.
- `TierCacheProvider.get/set/invalidatePrefix` — no tagging; simpler shape since tier entries aren't invalidated per-table.
- `CacheEntry` carries `{ rows, cachedAt, tier?, rowCount? }` — `tier` and `rowCount` are both optional for backward compatibility with entries written before those fields existed; `handler.ts` falls back to `'server'` and `cached.rows.length` respectively when reading such legacy entries.

### `LRUCacheProvider` (in-process data cache)

Backed by `lru-cache`'s `LRUCache` with **size-based bounding**: `maxSize` in bytes (default 128 MB) plus a fast `sizeCalculation` estimate (`rows.length * avgBytesPerRow(512) + 64`, avoiding an O(N) `JSON.stringify` on every write) rather than an unbounded entry count. Configured with `updateAgeOnGet: false` — `ttlMs` is a staleness bound, not an idle timeout, so a hot key read more often than `ttlMs` still expires on schedule and out-of-band writes (ETL jobs, other services, direct DB writes) are picked up within the advertised TTL; this mirrors `RedisCacheProvider`, which likewise never refreshes TTL on read. Maintains two secondary indexes kept in sync via the LRU's `dispose` callback (fired on both explicit delete and LRU eviction):

- **Prefix index** (`Map<prefix, Set<key>>`) — the tenant-scoped prefix (`studio:v1:<tenantId>:`, derived by finding the 3rd colon) maps to its member keys, making `invalidatePrefix()` O(matched keys) with a full-scan fallback for prefixes that don't match the indexed shape.
- **Tag index** (`Map<tag, Set<key>>`) plus a reverse **key→tags index** (`Map<key, Set<tag>>`) — populated at `set()` time from `opts.tags`. `deleteByTag()` looks up the tag's key set directly; the reverse index lets `dispose` clean up only the tags that belonged to the evicted key (O(tags on that key), not O(all tags)).

### `MapTierCacheProvider` (in-process tier cache)

Also backed by `lru-cache`, bounded by **both** entry count (`max: maxEntries`, default 10,000) and TTL — replacing an earlier hand-rolled `Map` that had no entry-count bound and could grow unboundedly under a stream of unique query shapes. Exposes a `size` getter (calls `purgeStale()` first) for test/introspection use. `invalidatePrefix()` does a linear scan of `cache.keys()` (acceptable at this cache's much smaller scale than the data cache).

### `RedisCacheProvider` (multi-node data cache)

Implements `CacheProvider` against a minimal structural `RedisClient` interface compatible with both `ioredis` and node-redis v4+, auto-detecting which client family it was given (`detectClientStyle()`, exported for reuse by `RedisTierCacheProvider`) or honoring an explicit `clientStyle` option. It normalizes two API differences between the client families:

- **`SET key value EX seconds`** — ioredis takes positional args (`set(key, value, 'EX', seconds)`); node-redis v4 takes an options object (`set(key, value, { EX: seconds })`). `redisSetEx()` picks the right shape based on `clientStyle`.
- **Set commands for tag indexing** — ioredis exposes lowercase `sadd`/`smembers`/`srem`; node-redis v4 exposes camelCase `sAdd`/`sMembers`/`sRem`. The provider checks for either naming convention (`tagOpsSupported()`, `sAdd()`/`sMembers()`/`sRem()` normalization helpers) and calls `console.warn` **once** (`warnedTagsUnavailable` guard) if neither is present, rather than silently no-op'ing invalidation.

TTL default is 60 seconds (`defaultTtlSeconds`), floored to a minimum of 1 second (`Math.max(1, ttlSeconds)`) so a `ttlMs: 0` doesn't send `EX 0` to Redis. Tag-based invalidation maintains two Redis SET structures per tagged write: a forward index `__tag__:<tag>` (tag → data keys) and a reverse index `__ktag__:<key>` (data key → its tags). The reverse index's expiry mirrors the data key's own TTL. The forward index's expiry is only ever **extended**, never shortened: `extendTagIndexExpiry()` reads the client's remaining `TTL` first (when the client implements it) and calls `EXPIRE` only if the new TTL would leave the index outliving its current expiry; when the client has no `TTL` command it falls back to the previous unconditional-extend behavior. This matters because one forward-index key is shared across every entry tagged with that tag — unconditionally resetting it to a later, shorter-TTL write's expiry would let the index expire while an earlier, longer-TTL entry sharing the tag is still live, silently breaking `deleteByTag` for that entry. `deleteByTag()` evicts all matching data keys, their reverse-index entries, and the forward index itself in one round trip. `invalidatePrefix()` uses `SCAN` (never the blocking `KEYS`) via the shared `scanKeys()` helper (`cache/redisCompat.ts`), cleaning up the reverse/forward indexes for every key it removes.

### `RedisTierCacheProvider` (multi-node tier cache)

Structurally parallel to `RedisCacheProvider` but simpler — no tagging, since tier decisions aren't invalidated per-table. Same `RedisClient` duck-typed interface, same `detectClientStyle()`/`clientStyle` override, same `SCAN`-based `invalidatePrefix()`. Default TTL is 300 seconds when `set()` is called without an explicit `ttlMs` (a case that essentially never occurs when driven through `handler.ts`, which always supplies its own 30s default explicitly).

### `cache/redisCompat.ts` — shared Redis wire-shape helpers

`RedisCacheProvider` and `RedisTierCacheProvider` both need to normalize the same two client-family disagreements: `SET key value EX seconds` (ioredis positional args vs. node-redis v4's `{ EX: seconds }` options object) and `SCAN` reply shape (ioredis's `[cursor, keys]` tuple vs. node-redis v4's `{ cursor, keys }` object). Rather than each provider carrying its own copy, `setEx(redis, style, key, value, seconds)` and `scanKeys(redis, style, pattern, count)` live once in `cache/redisCompat.ts` and are imported by both `RedisCacheProvider.ts` and `RedisTierCacheProvider.ts`. `scanKeys()` falls back to a single `KEYS` call for clients without `scan`, and to `[]` when neither is available.

## Testing conventions

- **`src/__tests__/mockDb.ts`** — an in-memory, Knex-_compatible_ (not a real SQL engine) fake covering the subset of the Knex builder API this package actually calls: `where`/`whereIn`/`whereLike`/`whereBetween`, `havingRaw`, `count`/`sum`/`avg`/`min`/`max`, `select`/`groupBy`/`orderBy`/`limit`, and a narrow `db.raw('?? as ??', [...])` implementation (only that one binding shape, matching what `executeForTier` actually emits for `columnAliases` projections). Used to exercise the full pipeline without a native SQLite driver dependency.
- **`src/__tests__/handler.test.ts`** — the largest end-to-end suite; covers `generateCacheKey`, `extractSecurityClaims`, and `handleBatchQuery` scenarios together: fail-closed column allowlisting (including the `'*'` wildcard opt-out and join.on validation), schema allowlist enforcement, tenant isolation across two tenants, all filter operators, `columnAliases` projection, batch assembly, data-cache hit/tier-echo/tag-scoped-to-joins/tenant-isolation, tier-cache population and bypass (`tierCacheTtlMs: 0`), aggregation push-down (forced db tier, GROUP BY, global aggregation, `rowCount` = group count, LIMIT), HAVING (the alias-must-match-aggregation security check enforced even with no `columnAllowlist` configured, and rejection of a `having` clause with no `aggregations` at all), a stable `rowCount` across a cold miss and a subsequent cache hit when `limit` truncates the rows, JOIN column-ambiguity qualification, and partial-batch failure isolation.
- **`src/cache/__tests__/LRUCacheProvider.test.ts`** — key overwrite, a dedicated "TTL expiry under continuous reads" regression section asserting an entry still expires on schedule even when read more often than its TTL (`updateAgeOnGet: false`), prefix-index invalidation (including the tenant-isolation guarantee and the non-indexed-prefix scan fallback), `deleteByTag` (including multi-tag entries and `dispose`-driven tagIndex cleanup on eviction), and real byte-budget eviction under `maxSizeBytes` pressure (including that a larger multi-row entry gets evicted sooner than several small ones).
- **`src/cache/__tests__/MapTierCacheProvider.test.ts`** — basic get/set/TTL-expiry/prefix-invalidation/size, plus a dedicated "bounded size" section verifying LRU eviction once `maxEntries` is exceeded, that an unbounded stream of unique query shapes never grows past `maxEntries`, and that recently-read entries survive over untouched ones.
- **`src/cache/__tests__/RedisCacheProvider.test.ts`** and **`RedisTierCacheProvider.test.ts`** — JSON roundtrip get/set, TTL conversion/flooring (`ttlMs: 0` → 1s floor, verified against both ioredis- and node-redis-v4-shaped fake clients), `keyPrefix` namespacing, `deleteByTag`/`invalidatePrefix` correctness (including the no-matching-keys no-op case and combining `keyPrefix` with an invalidation prefix), tag/reverse-index expiry parity (including that a later short-TTL write for the same tag does not shorten the forward tag index's existing expiry), `SCAN`-vs-`KEYS` usage, and explicit **node-redis v4 client compatibility** cases (the `{ EX }` options-object `set()` form, and that `deleteByTag` actually deletes and doesn't warn against a node-redis-v4-shaped client).
- **`src/mutations/__tests__/mutationBuilder.test.ts`** — `validateMutation` invariants (WHERE required, writable/where column allowlists, tenant-column rejection), each builder's tenant-stamping/scoping/values-stripping behavior, dedicated **INSERT tenant stamping via securityColumns** and **INSERT region/department scope validation** sections (tenant resolved from `securityColumns`/`perTable` with no `tenantColumn` set, a client-supplied tenant value rejected, an insert's region/department values checked against the caller's claims), a **write-path column validation (fail-closed + wildcard)** section, a **write-path predicate safety** section asserting the empty-`in`-throws and unknown-operator-throws behavior from `shared/predicates.ts`, operator coverage (`between`/`like`/`lte`/`gte`) confirmed to still respect tenant scoping, and write-path security scoping (region-restricted update/delete, custom region column name).
- **`src/mutations/__tests__/handleMutation.test.ts`** — table allowlist enforcement, successful insert/update/delete, per-mutation error isolation, cache invalidation via `deleteByTag` after success (and skip on failure / absence of a cache provider), where-column allowlist enforcement, the empty-`in` write guard end-to-end, tenant isolation (insert always stamps `tenant_id`, update cannot cross tenants; a dedicated section repeats this when tenancy is configured via `securityColumns` only), and a **batch ordering** section asserting mutations are processed sequentially so `[insert, update-that-row]` observes the insert's effect deterministically.
- **`src/router/__tests__/queryBuilder.test.ts`** — security predicates (tenant/region/department, applied before user filters), all filter operators including the empty-`in` autoRemove-on-read and the unsupported-operator throw, join method selection (`leftJoin`/`rightJoin`/inner default) and composite-key single-join-call behavior, join-before-security-predicate ordering, and configurable `securityColumns` (custom names, defaults, joined-table opt-in/opt-out).
- **`src/router/__tests__/preflight.test.ts`** — imports `runPreflight` from `../preflight` and `executeForTier` from `../execute`; covers COUNT(\*) result coercion (string → number, missing → zero), and `executeForTier`'s ORDER BY column qualification for both the db tier (aggregation-alias mapping vs. table-qualified physical columns) and the client/server tiers.
- **`src/router/__tests__/tierDecision.test.ts`** — aggregation-forced db tier (and that it skips both preflight and tier-cache reads), default/custom thresholds, tier-cache hit short-circuiting, the "omitted `tierCacheTtlMs`" decide-without-cache-write mode, and tier-cache population/non-population on preflight miss.
- **`src/security/__tests__/cacheKey.test.ts`** — determinism, row-level claim scoping (department/region differences produce different keys; `roleIds`/`userId` are excluded from the security profile), order-independence guarantees (regionIds order, descriptor property order, filter-predicate property order), query-shape scoping, HMAC-secret scoping, key-format assertions, and the fail-closed empty-secret throw.
- **`src/benchmarks/run.ts`** (`pnpm --filter "@mui/x-studio-data-middleware" bench`) — a standalone (non-test-runner) perf harness measuring, at 5 warmup + 50 timed iterations: cache-key generation cost, LRU hit/miss, LRU set+get, `invalidatePrefix` cost at scale, `runPreflight` cost, and full `handleBatchQuery` cold/warm/tier-cache-only scenarios, using a deterministic row generator (`src/benchmarks/syntheticData.ts`) so runs are comparable across commits.

## Key design invariants

These must hold for any change to this package to be safe:

1. **Zero-Knowledge Rule** — nothing outside `schemaAllowlist` / `columnAllowlist` / `writableColumns` is ever reachable. Checked _before_ any query is built, for the whole batch at once (not per-widget), via the shared `assertTablesAllowed()` (`shared/assertTablesAllowed.ts`) and `checkColumnAgainstAllowlist()`/`validateDescriptorColumns()` (`shared/columnValidation.ts`) — so one bad descriptor can't slip through alongside valid ones, and the read and write paths can't independently drift on what "allowed" means.
2. **Security predicates are unconditional and applied first, from one shared implementation** — `applySecurityPredicates` (tenant/region/department) runs before any user-supplied filter or WHERE in both `buildSecureQuery` and the mutation builders. The tenant/region/department column names themselves are resolved by the single shared `resolvePrimarySecurityColumns()` (honoring `securityColumns` first, then the legacy `tenantColumn`) in **all four** places that need them — `buildSecureQuery`, `buildInsertMutation`, `buildUpdateMutation`, and `buildDeleteMutation` — so INSERT tenant-stamping can't silently diverge from how reads/updates/deletes resolve the same column. update/delete always overwrite/strip `values[tenantColumn]`; insert unconditionally sets it and additionally rejects an out-of-scope client-supplied region/department value via `validateSecurityColumnValues()`. A client can never override, remove, or "AND-away" these predicates, nor move a row to (or write a new row into) another tenant/region/department.
3. **Operator allowlisting and read/write predicate semantics are shared** — `SAFE_OPERATORS` and `applyPredicates`/`applyPredicate` in `src/shared/predicates.ts` are the only place operators are translated to SQL, for both reads and writes; adding an operator here automatically covers both paths, and the `mode: 'read' | 'write'` parameter is the only intentional divergence (empty `in`: dropped on read, throws on write).
4. **All SQL goes through Knex's binding/quoting, never raw string-concatenated SQL** — every _value_ reaches Knex via a `?` binding, and every _identifier_ reaches Knex either via a `??` binding (`db.raw('?? as ??', ...)`, `havingRaw('?? op ?', ...)`) or via Knex's own identifier-quoting builder methods (`.select`/`.groupBy`/`.orderBy`/`.on`/`.sum`/`.avg`/`.count`/`.min`/`.max`), which escape the interpolated identifier they are handed. So although a few identifier strings are assembled by interpolation before being passed to a builder method — the aggregation projection (`` `${col} as ${agg.alias}` `` in `execute.ts`) and the `qualify()`-built `` `${table}.${col}` `` strings fed to `.select`/`.groupBy`/`.orderBy` — they are still escaped as identifiers by Knex, not spliced into raw SQL. As defense in depth the one free-form, client-supplied token in that path, `agg.alias`, is additionally constrained to a safe identifier charset (`validateAggregationAliases()` in `shared/columnValidation.ts`) before interpolation.
5. **Cache keys are opaque** — `generateCacheKey` HMACs the security-claims portion so a client cannot guess or enumerate another tenant's cache key.
6. **No hard Knex/Redis dependency in source** — `db` is typed `any` and only called through Knex's chainable builder API (duck typing); `RedisClient` is a minimal structural interface compatible with both `ioredis` and node-redis v4+. Don't add a literal `import ... from 'knex'` or a specific Redis client import to core logic. `knex` appears in `package.json` only as a `peerDependencies` entry (plus `devDependencies` for local type-checking) — never as a direct `dependencies` entry and never imported by `src/` — so a consumer's own Knex install is what's actually used at runtime.
7. **Two independent cache planes** — the data cache (rows, short TTL) and the tier cache (routing decisions only, longer TTL) are separate because tier boundaries shift far less often than the underlying data. `tierCacheTtlMs: 0` disables the tier cache.
8. **Batch-level isolation, request-level rejection** — allowlist violations reject the whole batch (fail fast, nothing partially executes against disallowed tables); per-item _execution_ errors (a bad filter value, a DB error) are isolated to that one widget/mutation result. On the write path this isolation is layered on top of **sequential** (not concurrent) execution — mutations still run one at a time, in order, so a later item in the same batch can depend on an earlier one's effect.

## Extension points

- **New cache backend**: implement `CacheProvider` and/or `TierCacheProvider` (`cache/types.ts`) and pass it via `options.cacheProvider`/`options.tierCacheProvider` — `LRUCacheProvider`/`MapTierCacheProvider`/`RedisCacheProvider`/`RedisTierCacheProvider` are just the provided implementations. A new Redis-compatible provider can reuse `detectClientStyle()` (`RedisCacheProvider.ts`) and `setEx()`/`scanKeys()` (`cache/redisCompat.ts`) instead of re-deriving the ioredis/node-redis wire-shape differences.
- **New filter operator**: add it to `SAFE_OPERATORS` and the `switch` in `applyPredicate` in `src/shared/predicates.ts` — this single change covers both the read and write paths since both builders call through this module.
- **New join type**: extend `JoinDescriptor.type` in `security/types.ts` and the join-method branch in `buildSecureQuery` (`router/queryBuilder.ts`).
- **New security dimension** (beyond tenant/region/department): extend `SecurityColumns`/`SecurityColumnsConfig` in `security/types.ts` and the corresponding branch in `applySecurityPredicates` (`shared/predicates.ts`) — it will apply uniformly to reads and writes. For a value carried in mutation `values` (like region/department today), also extend `validateSecurityColumnValues()` in `mutations/mutationBuilder.ts` so out-of-scope writes are rejected.
