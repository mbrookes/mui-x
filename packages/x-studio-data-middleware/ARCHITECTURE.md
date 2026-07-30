# Architecture

Internal reference for how `@mui/x-studio-data-middleware` is put together. For install and quick-start, see [`README.md`](./README.md).

## Contents

- [Overview](#overview)
- [Public API surface](#public-api-surface)
- [Module map](#module-map)
- [Read path](#read-path)
- [Tier decision](#tier-decision)
- [Write path](#write-path)
- [Security model](#security-model)
- [Query construction](#query-construction)
- [Mutation builders](#mutation-builders)
- [Caching layer](#caching-layer)
- [Input bounds](#input-bounds)
- [Key design invariants](#key-design-invariants)
- [Extension points](#extension-points)
- [Testing conventions](#testing-conventions)

## Overview

A framework-agnostic, driver-agnostic server middleware. It turns a batch of widget query/mutation descriptors sent by an MUI X Studio dashboard into parameterized SQL, executed through a host-supplied Knex instance, with multi-tenant row-level security and a two-plane (data + tier) caching system.

- **Framework-agnostic** — no HTTP framework imports anywhere in `src/`.
- **Driver-agnostic** — no literal `import … from 'knex'`; `db` is duck-typed as `any` and only touched through Knex's chainable builder API.

Two pure entry points:

- `handleBatchQuery(body, claims, options)` — reads. Routes each widget query through the cheapest adequate execution tier (`client` / `server` / `db`) and caches results.
- `handleMutation(body, claims, options)` — writes (insert/update/delete). Enforces tenant-safety invariants and invalidates the read cache.

Everything else in the package exists to support those two functions. The host application parses the HTTP request body, calls `extractSecurityClaims()` to obtain verified claims, supplies a configured Knex instance, and writes the returned response object back to the HTTP response.

**Tenancy is a required, explicit, fail-closed decision.** Both option shapes carry a mandatory `tenancy: TenancyConfig` — either `{ mode: 'multi-tenant', tenantColumn }` or `{ mode: 'single-tenant' }`. There is no default and no silent-omission path: a deployment cannot express "I forgot to configure a tenant column" and thereby fall into an unscoped, cross-tenant-leaking query. The unsafe state must be unreachable by leaving a field unset; it can only be reached by explicitly declaring `single-tenant`.

All errors thrown by this package are prefixed `MUI X Studio Server:` (a handful of older sites still read `MUI X:`; `sanitizeBoundaryError` matches on the shared `MUI X` stem, so both are treated as this package's own).

## Public API surface

Exported from `src/index.ts`:

| Category              | Exports                                                                                                                                                                                                                                                                                                                                                                                                                            |
| :-------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Handlers              | `handleBatchQuery` (`handler.ts`), `handleMutation` (`mutations/handleMutation.ts`)                                                                                                                                                                                                                                                                                                                                                |
| Security              | `extractSecurityClaims`, `generateCacheKey`                                                                                                                                                                                                                                                                                                                                                                                        |
| Cache interfaces      | `CacheProvider`, `CacheEntry`, `TierCacheProvider`, `TierEntry`                                                                                                                                                                                                                                                                                                                                                                    |
| Cache implementations | `LRUCacheProvider`, `MapTierCacheProvider`, `RedisCacheProvider` (+ `RedisClient`, `RedisCacheProviderOptions`), `RedisTierCacheProvider` (+ `RedisTierCacheProviderOptions`)                                                                                                                                                                                                                                                      |
| Types                 | `JwtSecurityClaims`, `BatchQueryRequest`/`Response`, `BatchWidgetDescriptor`, `WidgetQueryResult`, `FilterPredicate`, `HavingPredicate`, `OrderBy`, `AggregationSpec`, `JoinDescriptor`, `SemiJoinDescriptor`, `SecurityColumns`, `SecurityColumnOverride`, `SecurityColumnsConfig`, `TenancyConfig`, `HandleBatchQueryOptions`, `MutationDescriptor`/`MutationResult`, `BatchMutationRequest`/`Response`, `HandleMutationOptions` |

Everything under `router/`, `shared/`, `mutations/mutationBuilder.ts`, and the internals of `security/` (`compileSecurityPolicy`, `validateQueryPlan`, `canonicalize`, `cacheKey`'s helpers) is deliberately **not** exported.

## Module map

| Path                                | Responsibility                                                                                                                                                                                                                                                                                                                                                            |
| :---------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `handler.ts`                        | `handleBatchQuery` — request-shape validation and bounds (see [Input bounds](#input-bounds)), one-time policy compilation, per-widget allowlist + plan validation, bounded-concurrency fan-out, single-flight dedup, cache read/write, batch assembly. Owns `MAX_WIDGETS_PER_BATCH` (50), `MAX_CONCURRENT_WIDGET_QUERIES` (6), `mapWithConcurrency`, `runWidgetPipeline`. |
| `router/preflight.ts`               | `runPreflight` — `COUNT(*)` → row count. Nothing else lives here.                                                                                                                                                                                                                                                                                                         |
| `router/execute.ts`                 | `executeForTier` — builds and runs the real query per tier (projection / GROUP BY / aggregation / ORDER BY / LIMIT), reading pre-resolved `ColumnRef`s off the plan. Owns `MAX_RESULT_ROWS`, `MAX_ROWS_PER_REQUEST`, `RowBudget`, `createRowBudget`, `chargeRowBudgetOrThrow`, and the shared `runBounded` helper.                                                        |
| `router/queryBuilder.ts`            | `buildSecureQuery` — the single choke point where joins, security predicates, user filters and HAVING are applied.                                                                                                                                                                                                                                                        |
| `router/tierDecision.ts`            | `decideTierWithCache` — client/server/db decision tree plus tier-cache read/write, both failure-isolated. Owns `TIER_CACHE_KEY_PREFIX` and the exported `tierFromRowCount`, the single "what tier do we report" rule both cache planes call.                                                                                                                              |
| `mutations/handleMutation.ts`       | `handleMutation` — request-shape validation, batch-wide allowlist check, sequential per-mutation dispatch, cache invalidation, and the opt-in `atomic` transaction path.                                                                                                                                                                                                  |
| `mutations/mutationBuilder.ts`      | `validateMutation`, `buildInsertMutation`/`buildUpdateMutation`/`buildDeleteMutation`, plus module-private `resolvePrimaryCols`, `assertValueKeysWellFormed`, `validateSecurityColumnValues`, `resolveInsertScopeStamps`, `validateMutationValues`.                                                                                                                       |
| `shared/predicates.ts`              | The single source of truth for row-level security and structured-filter translation, shared by the read and write builders.                                                                                                                                                                                                                                               |
| `shared/columnValidation.ts`        | `resolveAlias`, `qualifyAgainst`, `qualifiedTableOf`, `assertSingleDotReference`, `assertNoImplicitAlias`, `assertColumnReferenceShape`, `isWildcardReference`, `validateWildcardProjection`, `checkColumnAgainstAllowlist`, `validateDescriptorColumns`, `validateProjectionKeyCollisions`, `validateHavingAliases`, `validateAggregationAliases`, `SAFE_ALIAS_PATTERN`. |
| `shared/assertTablesAllowed.ts`     | `assertTablesAllowed`, `assertQualifiedColumnsAllowed` (read), `assertQualifiedWhereColumnsAllowed` (write) — all three sharing one `checkQualifiedColumn` implementation — plus `collectSemiJoinTables`, which flattens a `semiJoins` tree to every table it references at every nesting level (the one helper both the allowlist check and the cache-tag write call).   |
| `shared/sanitizeError.ts`           | `sanitizeBoundaryError` — per-item boundary error classification.                                                                                                                                                                                                                                                                                                         |
| `shared/allowlistShape.ts`          | `assertStringArrayAllowlist`, `assertPerTableAllowlist` — the runtime shape guards for the host-supplied allowlists.                                                                                                                                                                                                                                                      |
| `shared/limits.ts`                  | `MAX_ARRAY_ITEMS_PER_DESCRIPTOR` (200), `MAX_STRING_LENGTH` (1024), `MAX_STRING_VALUE_LENGTH` (8192), `MAX_PREDICATE_VALUES_PER_DESCRIPTOR` (2000), `MAX_SEMI_JOIN_DEPTH` (2).                                                                                                                                                                                            |
| `security/compileSecurityPolicy.ts` | `compileSecurityPolicy`, `SecurityPolicyOptions`, `CompiledSecurityPolicy`, `computePolicyDigest`.                                                                                                                                                                                                                                                                        |
| `security/validateQueryPlan.ts`     | `validateQueryPlan`, `ValidatedQueryPlan`, `ColumnRef`, `AGGREGATE_SQL_FUNCTIONS`, `synthesizeProjectionFromAllowlist`.                                                                                                                                                                                                                                                   |
| `security/canonicalize.ts`          | `sortedStringify` — the one deterministic serializer feeding both cache hashes and the policy digest.                                                                                                                                                                                                                                                                     |
| `security/extractSecurityClaims.ts` | Demo JWT verifier → `JwtSecurityClaims` (the trust-boundary object).                                                                                                                                                                                                                                                                                                      |
| `security/cacheKey.ts`              | `generateCacheKey` — HMAC security hash + SHA-256 query-shape hash, with a bounded LRU memo.                                                                                                                                                                                                                                                                              |
| `security/types.ts`                 | Compatibility facade re-exporting `authTypes.ts` (claims/tenancy/security-column config), `queryTypes.ts` (read-path wire types) and `mutationTypes.ts` (write-path wire types + both `Handle*Options`).                                                                                                                                                                  |
| `cache/`                            | Provider interfaces plus the shared entry guards (`CACHE_TIERS`, `isCacheTier`, `isCacheEntryShape`, `isTierEntryShape` in `types.ts`), LRU/Map (in-process) and Redis (multi-node) implementations; `defaultProviders.ts` (process-wide singletons), `redisCompat.ts` (shared wire-shape helpers), `ttl.ts` (`floorTtlMs`).                                              |
| `benchmarks/`                       | Standalone perf harness (`pnpm bench`) over cache keying, hit/miss, invalidation, preflight, and full-pipeline cold/warm.                                                                                                                                                                                                                                                 |

## Read path

`handleBatchQuery(body, claims, options)`.

### 0. Request-shape validation

`assertValidBatchQueryRequest(body)` runs before anything else and rejects the **whole request** — never a silent truncation, and never a per-widget error, because a malformed or oversized batch is a defect in the request itself rather than in one widget's data:

- a non-object/`null` body, or a missing/non-array `widgets`;
- a batch over `MAX_WIDGETS_PER_BATCH` (50);
- a `null`/non-object `widgets[]` element, or one missing a string `id`/`table`;
- a present-but-non-array `filters` / `orderBy` / `aggregations` / `joins` / `columns` / `having`;
- a present `columnAliases` that is not a plain object with only string values;
- every count, length and product bound described in [Input bounds](#input-bounds).

Rejecting element shapes up front matters more than it looks. Before this gate existed, a malformed descriptor reached `processWidget`'s `try`, whose own `catch` dereferences `descriptor.id` to build the `{ error }` result — so it threw a _second_, unguarded `TypeError` from inside the catch. Every downstream `for…of` over a non-array collection had the same shape: a raw `TypeError` that `sanitizeBoundaryError` could only degrade to a generic message, instead of this package's own precise error.

### 1. Compile the security policy once

`compileSecurityPolicy({ tenancy, securityColumns, columnAllowlist, schemaAllowlist })` resolves the row-level-security column names for every table into one `CompiledSecurityPolicy` and computes its `digest`. The same object is threaded into every widget's cache-key generation, preflight and execution — no enforcement site re-runs the `perTable[table] ?? default` chain itself. This is also the single config choke point where the host-supplied allowlists' **runtime shape** is asserted — see [Allowlist shape](#allowlist-shape-sharedallowlistshapets).

### 2. Per-widget validation (inside the widget's error boundary)

Both steps below run **inside `processWidget`'s `try`**, so a violation becomes that widget's `{ error }` result while well-formed siblings on the same page still resolve.

**Table allowlist (Zero-Knowledge Rule).** `assertTablesAllowed()` checks `widget.table` and every `widget.joins[].table` against `options.schemaAllowlist`. `assertQualifiedColumnsAllowed()` then extends the identical rule to every table-**qualified** column reference in `columns`, `filters[].column`, `orderBy[].column`, the physical side of `columnAliases`, `aggregations[].column`, and both sides of every `joins[].on` pair.

That second check runs **unconditionally**, independent of `columnAllowlist`. The only other rejection of such a reference is `validateDescriptorColumns()`, which runs only when a `columnAllowlist` is supplied — so a `schemaAllowlist`-only deployment otherwise had no clean rejection for a qualified reference naming an unregistered table. The query still failed, but as an opaque driver error rather than this package's own actionable one.

**Plan validation and resolution.** `validateQueryPlan(descriptor, columnAllowlist)` runs the validator chain and resolves every column reference exactly once into a `ValidatedQueryPlan` — see [Query construction](#query-construction).

### 3. Bounded, deduplicated fan-out

Widgets are processed **concurrently but boundedly** via `mapWithConcurrency(body.widgets, MAX_CONCURRENT_WIDGET_QUERIES, …)`, an order-preserving worker pool of 6. All widgets share one `BatchRequestContext` carrying the compiled policy and three request-wide governors:

- **`rowBudget`** — the shared `RowBudget` (see [The row budget](#the-row-budget)).
- **the worker pool** — a bare `Promise.all` let one request start all 50 widgets at once, so the only thing limiting real concurrency was the host's Knex pool, which the host sizes for its whole application rather than for one request. One caller could drain it out from under every other request in the process.
- **`inFlight`** — a single-flight map keyed by `cacheKey`. The widget `id` is deliberately excluded from the query hash, so N structurally identical widgets resolve to one key; they used to all start together, all miss the not-yet-populated cache, and each run its own preflight plus query. They now share one in-progress `runWidgetPipeline()` promise — the id-independent half of the pipeline (cache read → tier decision → execute → cache write) — and each caller re-attaches its own `{ id }`. The derived promise (including its `.finally` cleanup) is what is stored, so every awaiter observes the same promise and a rejection can never surface as an unhandled rejection.

None of this weakens **per-widget error isolation**: a failed widget returns `{ id, rows: [], tier: 'db', rowCount: 0, error }`. The `error` string is classified through `sanitizeBoundaryError` — this package's own `MUI X`-prefixed messages pass through verbatim (deliberate, actionable, safe), while any other thrown value, notably a raw driver message like `no such column: orders.secret`, is a schema oracle: it is `console.warn`-ed server-side and replaced with a generic client-facing message, even when no `columnAllowlist` is configured.

### 4. Per-widget pipeline

1. **Cache key** — `generateCacheKey(claims, descriptor, undefined, policy.digest, cacheScope)`. This call lives **inside** the `try`: `generateCacheKey` throws when no HMAC secret is configured, and a missing-secret throw must produce that widget's `{ error }` rather than reject the whole batch.
2. **Data-cache check** — a hit returns the cached rows immediately, reporting the entry's `rowCount` (falling back to `rows.length`) and a `tier` **re-derived** from that count via `tierFromRowCount(rowCount, thresholds)` — the same rule, from the same exported function, the tier plane applies (see [Tier decision](#tier-decision)). `get()` is wrapped in its own `try`/`catch`: a throwing backend is a logged miss, not a widget failure, since the cache sits in front of — not instead of — the authoritative DB read. The returned entry is also **shape-checked before it is trusted**, through the shared `isCacheEntryShape()`: `rows` must be an array, and a _present_ `tier`/`rowCount` must be a real tier / a finite number. Any failure takes the same degradation path as a read failure. See [invariant 12](#key-design-invariants).

   Re-deriving rather than echoing `cached.tier` is what keeps the two planes from disagreeing. `thresholds` is folded into neither the cache key nor the policy digest, so an entry written by a node running `clientTier: 10_000` is read back by a mid-rollout node running `clientTier: 1_000`; echoing would report `'client'` for a widget the reader's own config calls `'server'`. The rows are identical either way — the client's in-browser filter/aggregate decision is not. Aggregation results never reach this cache (see step 6), so a stored `rowCount` is always a preflight `COUNT(*)`, exactly the input `tierFromRowCount` expects. A useful side effect: the reported `tier` and `rowCount` are now mutually consistent by construction.

3. **Tier decision** — on a miss, `decideTierWithCache()`.
4. **Execution** — `executeForTier(db, claims, descriptor, tier, policy, plan, rowBudget)`.
5. **`rowCount`** — for an aggregation descriptor, overridden to the actual number of result groups.
6. **Cache write** — results are stored together with the `rowCount` that produced them whenever `tier !== 'db'` **or** the descriptor has no aggregations. A non-aggregation `db`-tier result is a plain, reusable raw-row slice, the same shape the other tiers return; only a true aggregation push-down is left uncached. Writes are tagged with the primary table, **every joined table, and every semi-joined table at every nesting level** (via `collectSemiJoinTables`) — tagging only the primary would leave a result stale until TTL after a mutation to a table it depended on. A semi-joined table contributes no _columns_ to the result but does decide which rows are in it, so omitting it would be the same staleness bug in a less obvious shape. Persisting `rowCount` is what lets a later hit report the same total as the cold miss rather than the possibly limit-truncated `rows.length`. `set()` is likewise `try`/`catch`-wrapped: the rows are already fetched, so a write failure logs and returns the uncached result rather than discarding successful work.

Returns `{ pageId, results }`.

## Tier decision

`decideTierWithCache()` (`router/tierDecision.ts`) is the single source of truth for routing.

1. **Aggregation queries** (`descriptor.aggregations?.length > 0`) are forced to tier `'db'` immediately — no `COUNT(*)`, no tier-cache read or write. Row count is irrelevant once the result is a set of aggregated groups.
2. **Tier-cache hit** — short-circuits, but only after `Number.isFinite(cached.rowCount)` holds. A non-numeric `rowCount` makes every `tierFromRowCount` comparison false, which silently routed the widget to `'db'` and reported the nonsense value as the client-facing `rowCount`; an invalid entry is warned about once and treated as a MISS.

   On a valid hit the cached `rowCount` is reused (skipping `runPreflight`), but the **tier is re-derived** from it via `tierFromRowCount(cached.rowCount, thresholds)` against the _caller's current_ thresholds rather than trusting the cached `tier`. `thresholds` is folded into neither the tier-cache key nor the policy digest, so an entry may have been written under a different threshold config (mid-rollout, or another node during a deploy). Re-deriving makes a cached decision reinterpretable under the reader's own config with no key change and no extra I/O — only `cached.tier` was stale-prone, since `cached.rowCount` is still the true preflight count.

   **`tierFromRowCount` is exported, and the data plane calls it too.** "What tier do we report on a cache hit" was implemented twice, with deliberately opposite behavior: this site re-derived while `handler.ts` echoed the data-cache entry's stored `tier` — and neither site referenced the other, so the disagreement was pinned by two test suites that never mentioned each other. Both planes store the originating `rowCount` next to the tier, so both can re-derive; one exported function is now the only implementation. A change to how a cached tier is reported must land here, or a widget's reported tier starts depending on which cache happened to serve it.

3. **Tier-cache miss** — `runPreflight()` runs a `COUNT(*)` through `buildSecureQuery()` (full security and user-filter predicates, no SELECT) and `tierFromRowCount()` maps it against `DEFAULT_THRESHOLDS = { client: 10_000, server: 100_000 }` (overridable via `options.thresholds.clientTier` / `serverMemoryTier`). The decision is persisted only when a `tierCacheTtlMs` was given.

Both `tierCacheProvider.get()` and `.set()` are individually `try`/`catch`-wrapped, mirroring the data cache: a down tier-cache backend degrades to the preflight `COUNT(*)` (or to an uncached decision) instead of failing every non-aggregation widget while the DB itself is healthy.

**Known preflight tradeoff (deliberate, not fixed).** For a descriptor with a 1:many join, this `COUNT(*)` counts the joined, row-multiplied result rather than distinct primary-table rows, which can mis-route `tierFromRowCount` — for example, tripping `serverMemoryTier` on join fan-out alone. This is routing/performance only, never correctness: whichever tier is picked, `executeForTier` applies the same security predicates, user filters and effective limit, so rows are always correct and bounded, just possibly served by a heavier tier — the safe direction to be wrong in. A `COUNT(DISTINCT <pk>)` correction was rejected because `BatchWidgetDescriptor` declares no primary-key column, so the only column-agnostic fallback (`SELECT COUNT(*) FROM (SELECT DISTINCT t.* …)`) would add a DISTINCT-over-every-column subquery to exactly the join-heavy queries this fast path exists to route quickly.

**This tradeoff does not apply to a semi-join.** `column IN (SELECT …)` filters the primary table's rows without multiplying them, so for a descriptor whose cross-source filtering goes through `semiJoins` rather than `joins`, the preflight `COUNT(*)` and the returned row count agree exactly — pinned in a test. That is a second reason the x-studio emitter prefers a semi-join over a `LEFT JOIN` for a one-to-many filter: it fixes the routing inaccuracy as well as the wrong aggregate.

## Write path

`handleMutation(body, claims, options)`.

### 0. Request-shape validation

`assertValidBatchMutationRequest(body)` mirrors the read path's guard and likewise rejects the whole request: a non-object/`null` body or missing/non-array `mutations`; a batch over `MAX_MUTATIONS_PER_BATCH` (50); a `null`/non-object `mutations[]` element; a present-but-non-array `where`; a `null`/primitive `where[]` element; a present-but-non-plain-object `values`; plus every bound in [Input bounds](#input-bounds).

Up-front validation matters more here than on the read path: the table-allowlist check below runs `body.mutations.map((m) => m.table)` _before_ `processMutation`'s `try` exists, so a malformed descriptor used to throw with no error boundary at all. A well-formed non-null `where[]` element (even `{}` or `{ column: 5 }`) is left to `checkQualifiedColumn`'s own "column must be a string" throw — only the entries that would crash the `.column` dereference itself are caught up front.

A non-object `values` is worth calling out separately: it reached the builders' `descriptor.values ?? {}` / `{ ...descriptor.values }` / `Object.keys(values)`, none of which throw for it (an array indexes as `'0'`, `'1'`, …; a string indexes by character; `null` or a number silently becomes `{}`), producing a silently degraded insert/update instead of a clean failure.

### 1. Policy and table allowlist

`compileSecurityPolicy({ tenancy, securityColumns, columnAllowlist, schemaAllowlist, writableColumns })` runs once for the whole batch — the same four digest-bearing inputs the read path compiles, so the two digests are comparable, **plus `writableColumns`, which is passed for runtime shape validation only and is deliberately NOT folded into the digest** (the read path never consumes that option, so folding it in would change read-path cache keys for a value they do not use). See [Allowlist shape](#allowlist-shape-sharedallowlistshapets). `schemaAllowlist` used to be omitted here, which was inert (the write path never consumes `policy.digest`; invalidation is by table tag, not by key) but wrong on the field's own terms: it is THE zero-config data-source separator, so a digest without it does not identify the data source at all. Then `assertTablesAllowed()` checks every mutation's table, and `assertQualifiedWhereColumnsAllowed(mutation.where, schemaAllowlist)` extends the Zero-Knowledge rule to a mutation's one qualified-column shape, `where[].column` — a table a mutation never joins and `assertTablesAllowed` therefore never sees. Like the base check it runs unconditionally and aborts the **whole batch**: a mutation batch is not a set of independent read widgets, so a table violation is treated as a malformed request rather than partially applied.

### 2. Sequential per-mutation dispatch

Mutations run **sequentially** — a `for…await` loop, not `Promise.all` — with per-item error isolation (`{ id, ok: false, error }`, sanitized identically to the read path). Running in array order makes a batch like `[insert row, update that row]` deterministic: the update observes the insert's effect instead of racing it. Batch sizes are small in practice, so this trades a little latency for correctness.

Each mutation runs `validateMutation()` then dispatches to a builder — see [Mutation builders](#mutation-builders) for what those enforce.

The dispatch `switch`'s `default` arm is unreachable (`operation` is validated against exactly `['insert','update','delete']` earlier) but is not dead code: it assigns `descriptor.operation` to a `never`-typed local, so adding a new operation to the union without a `case` fails the build, then throws defensively at runtime as a backstop.

**`rowsAffected`** is derived from the raw Knex return value, which is driver-dependent and carries no reliable row count: SQLite/MySQL resolve an insert to `[lastInsertId]` (length 1, only coincidentally a row count) while PostgreSQL resolves to `[]` without `.returning()`. Since a `MutationDescriptor` insert always writes exactly one row, the insert branch treats **any** array result as `rowsAffected: 1`; a numeric result (a driver returning a plain count) is used as-is.

### 3. Cache invalidation

On success, `deleteByTag(descriptor.table)` evicts every cached read tagged with that table. This is the entire invalidation story — there is no manual invalidation endpoint. The semantics are precise:

- **Not opt-in.** A successful mutation _always_ invalidates. Omitting `options.cacheProvider` falls back to the same process-wide default singleton (`cache/defaultProviders.ts`) that `handleBatchQuery` populates by default, so a zero-config host observes its own writes. The option only chooses _which_ cache is evicted — passing it on only one of the two paths evicts a cache nobody reads while the one that is read serves pre-mutation rows for a full TTL.
- **Best-effort, never fails a committed write.** A throwing `deleteByTag` is caught and logged and the mutation still reports `ok: true`. Flipping a committed write to failed would prompt a retry that duplicates the row — strictly worse than a cache stale for at most its TTL. That degradation lives in one shared `invalidateTableCache(table, provider)` helper used by both paths.
- **Under `atomic`**, invalidation runs once per **distinct** table **after** the commit, and only if every item succeeded.
- **Eviction alone is not enough, so `deleteByTag` also stamps an invalidation epoch.** `deleteByTag` can only evict keys that already **exist**, and a read in flight is about to write one. The ordering, reachable entirely through public entry points: `handleBatchQuery` executes its SELECT and gets pre-mutation rows → the mutation commits and calls `deleteByTag`, which finds no key for that not-yet-written result → the read completes and stores those stale rows under that key, tagged with the mutated table. Every reader sharing the security profile would then be served pre-mutation rows for the whole TTL — the "always invalidates" guarantee failing on the **success** path, not just the documented failure path. This is staleness only, never a cross-tenant read: security predicates are applied at query time, so the stale rows are always in scope for whoever reads them.

  The fix is the mirror image of the one the atomic path already had. That path defers eviction past the commit because "evicting inside the transaction would let a concurrent read re-cache rows that are about to roll back" — closing the **pre**-commit direction. The **post**-commit direction is closed by a per-tag epoch: `deleteByTag` records `Date.now()` for the tag (**even when it matched nothing** — that is the racing case), `runWidgetPipeline` timestamps itself before executing its query, and before its `cacheProvider.set()` it asks `wereTagsInvalidatedSince(tags, thatTimestamp)`. If any tag was invalidated at or after it, the cache write is **skipped**; the rows are still returned to the caller whose query genuinely saw them. Both shipped `CacheProvider`s implement it (the LRU with a `Map<tag, number>`; Redis with a `__taginv__:<tag>` timestamp string, retained 5 minutes).

  **The hook is optional, with a documented fallback**, because `CacheProvider` is host-pluggable and a newly required method would break every host implementation. A provider that omits it answers "not invalidated" and keeps the previous behavior exactly — a race window bounded by the TTL. A hook that **throws** answers the other way, "treat as invalidated", so the write is dropped: the cost is a re-query, versus a stale answer for a full TTL. On a multi-node Redis deployment both sides of the comparison are `Date.now()` values from middleware processes, so the residual window is bounded by clock skew between nodes.

### Opt-in atomic batches

Passing `atomic: true` (an `AtomicMutationOptions` intersection on `handleMutation`'s `options`; folding it into `HandleMutationOptions` proper is a follow-up) routes the batch through `runAtomicBatch()`: one `db.transaction(...)` whose `trx` handle replaces `db` for every builder call, rolling back on the **first** failure.

Per-item isolation stays the default and is deliberate, but it left a host with no way to get atomicity even when it explicitly wanted it — `[insert parent, insert child-referencing-parent]` with a failing second item committed the parent and returned `[{ok:true},{ok:false}]`, with no mechanism to undo the orphan.

After a rollback every item reports `ok: false` (the failing one keeps its own sanitized error, the rest carry a "rolled back" message), because reporting an item as `ok: true` when its row no longer exists is a lie the client acts on. An injected `db` with no `transaction` method is rejected up front rather than silently degrading to per-item semantics under a flag promising the opposite. Invalidation is deferred past the commit because evicting mid-transaction would let a concurrent read re-populate the cache with rows that are about to roll back — and a rollback changed nothing to evict.

**The rollback sentinel carries the results, and the discrimination is on its TYPE.** The callback must throw to make the driver roll back, so the per-item results are assembled inside it; they travel out on an `AtomicRollback extends Error` instance, and `err instanceof AtomicRollback` is true for exactly that throw and nothing else. That distinction is what separates the two failure modes a single `catch` sees:

- **A failure raised by the transaction machinery itself** — including one that only surfaces at **COMMIT**, after the callback already resolved with a full set of `ok: true` results (a serialization failure, a deferred-constraint violation, a lost connection, a deadlock) — is reported as **all items failed**. Keying off "were results assembled?" instead of the sentinel type is what previously made this case return those `ok: true` results: the batch reported every write as succeeded while the database had committed nothing, and the early return also skipped the post-commit invalidation gate. The client acted on that.
- **A `transaction()` that resolves without ever running the callback to completion** (a host stub that never awaits it) leaves the results unassigned, and is likewise reported as all items failed with a message naming the cause — rather than returning an empty `results` array that silently drops every mutation the client asked about.

## Security model

### Claims (`security/authTypes.ts`)

```ts
interface JwtSecurityClaims {
  tenantId: string; // primary isolation boundary
  userId: string;
  roleIds: string[];
  regionIds?: number[]; // optional row-level region restriction
  department?: string; // optional row-level department restriction
}
```

The package never authenticates; it only consumes pre-verified claims the host constructs.

### Tenancy and security columns (`security/authTypes.ts`)

```ts
interface SecurityColumns {
  tenant?: string;
  region?: string;
  department?: string;
}

interface SecurityColumnOverride {
  // string → rename this dimension's column for this table
  // undefined/absent → inherit the default
  // null → DROP just this dimension, keeping the others (crucially, tenant)
  tenant?: string | null;
  region?: string | null;
  department?: string | null;
}

interface SecurityColumnsConfig {
  region?: string;
  department?: string;
  // A whole-entry `null` marks a shared/lookup table (no tenant column) that
  // must join UNSCOPED — distinct from a per-dimension `null`.
  perTable?: Record<string, SecurityColumnOverride | null>;
}

type TenancyConfig = { mode: 'multi-tenant'; tenantColumn: string } | { mode: 'single-tenant' };
```

The global tenant column is declared in exactly one place, the required `tenancy` posture. The top-level `region`/`department` act as primary-table defaults (defaulting further to `region_id` / `department`).

The **three-way override semantics per dimension** are load-bearing. `perTable.audit_log = { region: null, department: null }` keeps the inherited tenant predicate for a joined table that carries `tenant_id` but has no region/department column — without it, a region-restricted caller would have to reach for the whole-table opt-out and lose tenant scoping too. The whole-entry `perTable[table] = null` is reserved for a genuinely shared/lookup table (a country-codes table) with no tenant column at all: a table joins fully unscoped only when the host explicitly declares it shared.

### `CompiledSecurityPolicy` (`security/compileSecurityPolicy.ts`)

The single boundary object every enforcement site resolves security columns through, instead of each site running the `perTable[table]?.X ?? default` chain itself.

```ts
interface SecurityPolicyOptions {
  tenancy: TenancyConfig; // REQUIRED
  securityColumns?: SecurityColumnsConfig;
  columnAllowlist?: Record<string, string[]>; // shape-validated; folded into the digest
  schemaAllowlist?: string[]; // shape-validated; folded into the digest
  writableColumns?: Record<string, string[]>; // shape-validated ONLY — never folded into the digest
}

interface CompiledSecurityPolicy {
  forPrimaryTable(table: string): SecurityColumns;
  forJoinedTable(table: string): SecurityColumns | undefined; // undefined only for perTable[table] = null
  readonly digest: string;
  readonly tenancy: TenancyConfig;
}
```

- `forPrimaryTable`/`forJoinedTable` delegate to `resolvePrimarySecurityColumns`/`resolveJoinSecurityColumns` (`shared/predicates.ts`). Compiling changes **where** the resolution chain runs (once, at the top of each handler), never **what** it resolves to.
- **Runtime validation, not just types.** `compileSecurityPolicy` throws when a `multi-tenant` `tenantColumn` is empty, whitespace-only or non-string, and likewise for any per-table dimension override or top-level `region`/`department`. `undefined` (inherit) stays valid everywhere. **`null` is valid only inside `perTable`**, where it is the documented drop sentinel: a top-level `securityColumns.region`/`.department` of `null` is rejected, because `resolveDimension`'s top-level fallback is `config?.region ?? 'region_id'` and `null ?? 'region_id'` is `'region_id'` — so a host writing `{ region: null }` to mean "this deployment has no region column" would silently get the **default** column scoped instead. That direction is fail-closed (over-scoped, not leaking), but it makes the same literal mean two opposite things one level apart, so it is refused and the `perTable` alternative named. The realistic misconfiguration is `tenantColumn: process.env.TENANT_COLUMN!` with the variable unset — every downstream truthiness gate would silently treat that as "not scoped", so a deployment that believed it was multi-tenant would run every read and write fully unscoped across tenants.
- A `single-tenant` deployment that also sets `perTable[table].tenant` is a contradiction and throws. A per-table tenant scope under `single-tenant` would either be silently ignored (reintroducing a cross-tenant leak) or silently contradict the declared mode; it refuses to resolve the ambiguity either way. A region/department-only override or a `perTable[table] = null` opt-out does not trip it.
- **Dual acceptance.** `isCompiledSecurityPolicy()` / `toCompiledSecurityPolicy()` let `buildSecureQuery`, `runPreflight`, `executeForTier` and every mutation builder accept either the compiled policy (returned as-is on the request path) or raw `SecurityPolicyOptions` (compiled on the spot, for direct unit-test callers). `SINGLE_TENANT_POLICY_DIGEST` is the digest of `{ mode: 'single-tenant' }` with nothing else, used as `generateCacheKey`'s default.

### Allowlist shape (`shared/allowlistShape.ts`)

`schemaAllowlist: string[]`, `columnAllowlist: Record<string, string[]>` and `writableColumns: Record<string, string[]>` are enforced by TypeScript alone — and TypeScript is not present at runtime for a host that reads its configuration from an environment variable, a JSON/YAML file or a database row. `assertStringArrayAllowlist` / `assertPerTableAllowlist` assert the shape at runtime instead, for the same reason and at the same choke point as the `tenantColumn` check above.

The failure this closes is that **every membership check in this package is `Array.prototype.includes`**, which on a string silently degrades to `String.prototype.includes` — SUBSTRING matching, so the allowlist fails **OPEN**. `schemaAllowlist: process.env.STUDIO_TABLES` set to `'orders_public'` admits the never-allowlisted `orders` table, because `'orders_public'.includes('orders')` is `true`. `columnAllowlist: { orders: 'id,status' }` admits any substring, including the **empty** string — reachable, because `checkColumnAgainstAllowlist` splits a qualified reference at its first dot, so `columns: ['orders.']` yields `column === ''`.

Validation runs at `compileSecurityPolicy`, the one config choke point both handlers execute before touching any allowlist, and is **re-asserted at all five membership sites** (`assertTablesAllowed`, `assertQualifiedColumnsAllowed`, `assertQualifiedWhereColumnsAllowed`, `checkColumnAgainstAllowlist`, `synthesizeProjectionFromAllowlist`), because those are exported and reachable by direct callers that never compile a policy. Fail closed in both places.

`writableColumns` is accepted by `compileSecurityPolicy` for this validation **only** — it reaches `checkColumnAgainstAllowlist` through `mutationBuilder`, so it needs the same guard, but it is deliberately kept out of `digest` (see below).

### The policy digest

`digest` is a stable SHA-256 (16 hex chars) over the `sortedStringify`'d `{ tenancy, securityColumns }` pair, plus `columnAllowlist` and `schemaAllowlist` when supplied. It is computed once and folded into the cache key. Each per-table column list and the schema list are sorted first for order-independence, and each optional field is only present in the hashed input when supplied — so an omitted allowlist yields a byte-identical digest to one computed before the field existed. `writableColumns` is the one `SecurityPolicyOptions` field that is **not** hashed: the write path never consumes the digest, and the read path never consumes the option, so folding it in would only churn read-path cache keys for a value they do not use.

**Both handlers compile the same four digest-bearing inputs.** Only `handleBatchQuery` consumes the digest today (the write path invalidates by table tag, not by key), but the two calls must stay identical: a digest that means one thing on the read path and another on the write path is a trap for anyone comparing them, and it would silently fail to separate two databases the first time the write path keys off it.

What each inclusion buys:

| Folded in                    | Prevents                                                                                                                                                               |
| :--------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenancy`, `securityColumns` | Two nodes running a differently-resolved row-level-security policy serving one another's cached rows for the same claims (mid-rollout, tightening a `perTable` scope). |
| `columnAllowlist`            | Results computed under a looser allowlist being served stale after the host locks column visibility down.                                                              |
| `schemaAllowlist`            | Two option sets in one process exposing different tables — the ordinary shape of "one process, two databases" — colliding on identical keys, at zero configuration.    |

### Predicates (`shared/predicates.ts`)

The single source of truth for row-level security and structured-filter translation, used identically by `buildSecureQuery` (reads) and `buildUpdateMutation`/`buildDeleteMutation` (writes). Every caller applies security predicates **first**, then user filters, so the scope can never be overridden or AND-ed away.

- **`SAFE_OPERATORS`** — the only filter operators ever translated to SQL: `eq`, `neq`, `in`, `lt`, `lte`, `gt`, `gte`, `like`, `between`. Anything outside always throws, on both paths — never silently dropped.

  **`like` emits the 3-arg `.where(column, 'like', pattern)`, never `.whereLike(column, pattern)`.** The two Knex builders look interchangeable and compile identically on pg and better-sqlite3, but Knex's MySQL query compiler hard-codes a trailing `COLLATE utf8_bin` on `whereLike` only. On MySQL 8, whose default charset is utf8mb4, an explicit `utf8_bin` collation against a utf8mb4 operand raises `ER_CANT_AGGREGATE_2COLLATIONS` / `ER_COLLATION_CHARSET_MISMATCH` — which `sanitizeBoundaryError` then classifies as a driver message and replaces with the generic per-widget error, so `like` was silently dead on every MySQL deployment, on the read _and_ write paths, with no diagnostic.

  Consequence for hosts: **on MySQL, `like` now follows the column's own collation** — case-**insensitive** under the usual `utf8mb4_0900_ai_ci` default — rather than the forced binary comparison the `utf8_bin` suffix imposed. That matches what pg (case-sensitive `LIKE`) and SQLite (ASCII-case-insensitive `LIKE`) already did: `like` means "whatever the dialect's `LIKE` means for this column". `whereILike` was deliberately **not** used as the fix — it renders pg's `ilike`, which would make one dialect case-insensitive by fiat while leaving the others alone.

  This is pinned by real-Knex SQL-string assertions (mysql2 / pg / better-sqlite3) in `shared/__tests__/predicates.test.ts`. The mock-DB suites record the Knex **method name**, not the SQL a dialect compiles it to, and structurally cannot catch a dialect bug — which is why this one survived. `applyPredicate`'s `switch` is the only site that translates the operator, so read and write got the fix together.

- **`resolvePrimarySecurityColumns` / `resolveJoinSecurityColumns`** — resolve tenant/region/department column names for the primary and joined tables respectively.

  Joined tables are scoped **by default**: a joined table with no `perTable` entry inherits the primary table's resolved column names, so an unregistered join cannot fan out to every tenant's rows. The concrete leak is a tenant-filtered primary `LEFT JOIN`ed on a non-unique key like `region_id`, pulling in other tenants' rows.

  Both resolvers honor a whole-table `null` opt-out identically, whether the table is primary or joined — otherwise a shared lookup table queried _as_ the primary table would emit a predicate on a non-existent column and fail every such request forever. Both read `perTable[table]` through the module-private `lookupPerTableOverride()`, own-property-gated like every other client-keyed lookup in the package.

- **`applySecurityPredicates(query, table, claims, securityColumns, mode)`** — emits `tenant = claims.tenantId`, `region IN claims.regionIds`, `department = claims.department` for whichever dimensions have both a configured column and a claim.
- **`applySecurityPredicatesToJoinOn(...)`** — the ON-clause analogue, for the nullable side of an outer join. See [Outer-join predicate placement](#outer-join-predicate-placement).
- **`applySecurityPredicatesOrNull(...)`** — the `(predicate) OR <join-key> IS NULL` relaxation, used in exactly one narrow case. See [Multiple RIGHT joins](#multiple-right-joins).

Both the WHERE and ON emitters delegate to one module-private `emitSecurityPredicates()` that decides which dimensions apply and to what values; only the final `.where`/`.whereIn` vs `.andOnVal`/`.andOnIn` calls differ. The two placements therefore cannot drift on scoping semantics.

#### Three distinctions the dimensions must preserve

**Region: `undefined` vs `[]`.** `regionIds === undefined` means this deployment is not region-scoped (no predicate). `regionIds === []` means the caller is authorized for **zero** regions: on `'read'` it emits `whereIn(col, [])`, which Knex renders as `1 = 0`; on `'write'` it **throws** rather than silently widening the mutation. Dropping it would fail open.

**Department: defined vs truthy.** The department dimension gates on `claims.department !== undefined`, not truthiness. An empty-string department claim is a defined (if unusual) scope, not "unscoped" — under a truthiness check, `department === ''` was indistinguishable from "no department scoping" and a caller whose claim happened to be `''` saw and affected every department in its tenant.

**Region values: the string form only.** The predicate emits exactly one comparison value per region — the canonical decimal `String(id)` — and lets the engine coerce it. Emitting **both** forms (`IN (5, '5')`) is what a row-level-security predicate must not do: on MySQL, mixing a numeric literal with a TEXT column forces numeric coercion of the whole comparison, so `region_id = 5` also matches rows stored as `'05'`, `' 5'`, `'5.0'` or `'5abc'` — a caller scoped to region 5 seeing region `'05'`'s rows, that is, a **widening** of the security scope. The string direction is safe both ways: a canonical decimal string coerces to exactly one number against a numeric column, and stays an exact string comparison against a TEXT one. The number → string direction has no such guarantee.

#### User-filter translation

`applyPredicates` / `applyPredicate` translate `FilterPredicate[]` into `.where`/`.whereIn`/`.whereLike`/`.whereBetween`. `applyPredicate` emits whatever column string it is handed verbatim — table-qualification is the caller's responsibility (see [Query construction](#query-construction)).

The `mode: 'read' | 'write'` parameter governs exactly one intentional divergence, and it is a divergence in how a match-nothing filter is _reported_, never in whether it applies:

- **An empty `in` list means "match nothing" on both paths.** On `'read'` it falls through to `whereIn(column, [])`, which the pinned `knex@3.2.10` short-circuits to `where(false)` → `1 = 0`.

  The read path used to **drop** it ("autoRemove"), justified in a code comment _and_ in a test named "skips an empty `in` list (autoRemove) rather than emitting WHERE x IN ()", on the claim that the alternative was malformed SQL. That claim was false, and the drop failed **open**: a Studio filter widget with an empty selection returned the entire tenant-scoped table, with the preflight reporting the full unfiltered total as `rowCount`.

  Decisively, the same file's `regionIds: []` handling had always relied on the correct behavior, its docblock explicitly noting that dropping it "would fail OPEN" — two paths in one file held contradictory beliefs about the identical Knex call. The rendered SQL is now pinned against real Knex on both paths.

- **On `'write'` an empty `in` throws.** A mutation that matches nothing is almost certainly a client bug, and the failure mode of getting it wrong — a full-tenant UPDATE/DELETE, if the predicate were ever dropped — is unrecoverable, so the write path refuses instead of guessing.

Every value-bearing operator runtime-guards its value's shape, since `FilterPredicate.value`'s TypeScript type is not a runtime guarantee (it is client JSON): `in` requires `Array.isArray` (a bare string's truthy `.length` would slip past the empty-list check), `between` requires a two-element array (whose destructure would otherwise yield `undefined` bounds), `like` requires a string, and the scalar comparators require a scalar — string/number/boolean/`Date`. `in` and `between` additionally validate each **element**'s shape, not just the container's.

`null` is deliberately allowed for `eq`/`neq` so they can special-case it to `.whereNull`/`.whereNotNull`: the 3-arg `.where(col, '=', null)` renders the never-true `col = NULL`, because Knex's null→`whereNull` conversion applies only to the 2-arg and `'is'` forms. All of these remain fully parameterized — they are fail-closed error-message guards, not new security boundaries.

### Outer-join predicate placement

A joined table's row-level-security predicate placed in WHERE silently degrades a LEFT/RIGHT JOIN into an INNER JOIN. For `orders LEFT JOIN customers`, an `orders` row with no matching customer produces a NULL-extended row whose `customers.tenant_id` is NULL, so `WHERE customers.tenant_id = :tenant` is false and the row the caller explicitly asked to keep is dropped. The symmetric case holds for a RIGHT JOIN via the _primary_ table's predicate.

`buildSecureQuery` routes the nullable side's predicate into the join's own ON clause instead:

| Join type | Nullable side     | Placement                                                                                                                                                   |
| :-------- | :---------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `left`    | the joined table  | `policy.forJoinedTable(join.table)`'s predicate goes inside that join's `.on(...)` callback; the table is skipped in the WHERE loop.                        |
| `right`   | the primary table | `policy.forPrimaryTable(...)`'s predicate goes into the **first** right join's ON clause only; the primary table is skipped in its usual WHERE application. |
| `inner`   | neither           | WHERE placement is equivalent and unchanged.                                                                                                                |

Scoping in ON still tenant-checks every _matched_ joined row, so there is no cross-tenant fan-out through a join; it only stops a security predicate from discarding a genuinely-unmatched outer row. `applySecurityPredicatesToJoinOn` uses Knex's `andOnVal`/`andOnIn` — the ON-clause analogues of `.where`/`.whereIn` that bind their argument as a **value**, not an identifier — so tenant/region/department values stay parameterized exactly as on the WHERE path.

#### Multiple RIGHT joins

Chained joins associate **left-to-right**: `(A RIGHT JOIN B) RIGHT JOIN C` computes `A RIGHT JOIN B` first, so by the time that intermediate result reaches the second right join, both `A` and `B` are already fully resolved — matched, or legitimately NULL because the first join found no match or `A`'s own security predicate excluded it. That has two separate consequences.

**ON clause — inject the primary table's predicate into exactly one join, the first right join.** Re-adding it to a second right join's ON clause re-tests a primary-table column (for example, `sales.tenant_id`) that is now legitimately NULL for rows where the first join's table genuinely matched. `NULL = :tenant` reads as unknown, so the second join treats it as "no match" and NULL-extends the **whole accumulated left side** — wiping out the first join's table's own already-resolved, legitimate columns, not just the primary table's. For `sales RIGHT JOIN customers RIGHT JOIN orders`:

```sql
select * from "sales"
  right join "customers" on "sales"."customer_id" = "customers"."id" and "sales"."tenant_id" = 'acme'
  right join "orders" on "customers"."id" = "orders"."customer_id"
  where "customers"."tenant_id" = 'acme' and "orders"."tenant_id" = 'acme'
```

`firstRightJoinIndex` is the one join where the primary table is a direct participant and could first become null-extended; injecting there and only there applies the predicate at the single point it is semantically correct — the same principle a LEFT join's predicate already follows.

**WHERE clause — a joined table's predicate is safe as a plain WHERE only at the last right join, and before that only for a table whose own join type is `inner`.** The split above only special-cases the _primary_ table. A joined table sitting before the last right join is at risk of being null-extended by a **later** right join regardless of its own type (an inner-joined table between two right joins is equally exposed), so a plain WHERE there could silently drop rows the later join was meant to preserve.

For an earlier join whose own type is `inner`, `buildSecureQuery` computes `lastRightJoinIndex` and routes that table's predicate through `applySecurityPredicatesOrNull()` — exactly as strict as the WHERE form, but wrapped in `(predicate) OR <join-key> IS NULL` via `joinNullIndicatorColumn()`, so the null check fires only for a row genuinely null-extended by the later right join.

> **A join whose own type is `right` is excluded from this relaxation and always gets the strict, unconditional predicate.** This exclusion is the single most security-critical branch in the file — it is the difference between a routing inefficiency and a genuine cross-tenant leak — and must not be casually reversed.
>
> A right-joined table is the **preserved** side of its own join — every one of its rows is kept whether or not that join's `on` matched — so, unlike an inner-joined table, a NULL in its own join-key column is **not** proof that the row was null-extended by a later join. A genuinely-participating, real row can carry an actual NULL there (an untouched nullable FK), completely independent of any later join. Trusting that NULL as the relaxation's indicator would let such a row — which may belong to a **wrong tenant**, since its real security predicate is false — satisfy the `OR … IS NULL` branch and bypass the predicate entirely: a real cross-tenant leak, reachable through an ordinary (if unusual) descriptor shape.
>
> `joinNullIndicatorColumn()` therefore refuses to derive an indicator for a `right`-typed join at all, returning `undefined`, and `buildSecureQuery` falls through to the strict WHERE form. This is fail-closed: at worst it drops a row a later right join legitimately preserved — the routing case the relaxation exists to avoid — but it can never leak.

`joinNullIndicatorColumn()` derives `<join-key>` from the join's own first `on` pair's right-hand column, which the documented `JoinDescriptor.on` convention says belongs to `join.table` — but nothing upstream proves that. `validateDescriptorColumns` only checks an _unqualified_ right-hand column against `join.table`'s allowlist entry; a client-qualified reference naming a different table is checked against that other table's entry and passes. So when the resolved reference is explicitly qualified, the helper verifies the qualifying table really is `join.table` and throws fail-closed otherwise, rather than handing the relaxation a column whose nullability has nothing to do with `join.table`.

### Cache keys (`security/cacheKey.ts`)

`generateCacheKey(claims, descriptor, hmacSecret?, policyDigest?, cacheScope?)` produces `studio:v1:<encodeURIComponent(tenantId)>:<securityHash>:<queryHash>`.

**`securityHash`** — HMAC-SHA256 (16 hex chars) over a `sortedStringify`'d `{ tenantId, regionIds (sorted), department, policyDigest, cacheScope? }` profile, keyed by `hmacSecret` (defaulting to `CACHE_HMAC_SECRET ?? JWT_SECRET ?? ''`). It **throws** if no secret is configured — an empty key would make the hash guessable, breaking the "a client can't forge another tenant's cache key" guarantee. `policyDigest` defaults to `SINGLE_TENANT_POLICY_DIGEST` so direct callers stay deterministic. Users with identical row-level permissions _and_ identical policy digests intentionally share a hash, and thus a cache entry, for cache efficiency.

**Domain separation, because the key is shared by default.** The HMAC input is prefixed with the fixed, NUL-terminated tag `CACHE_KEY_HMAC_DOMAIN` (`'mui-x-studio-cache-key:v1\0'`) before the profile. In the zero-extra-config deployment the same secret that signs bearer tokens also derives cache keys — and cache keys are written to Redis, appear in logs, and are readable by anyone with cache access. Prefixing means a cache-key digest and a JWT signature are computed over provably disjoint input spaces, so neither is an oracle for the other under the shared key; the NUL byte cannot occur in the JSON profile, so the tag is unambiguous rather than merely a prefix. Changing the tag (or its `:v1`) invalidates every existing entry, deliberately — the derivation itself changed. The `JWT_SECRET` fallback is additionally `console.warn`-ed **once per process** at first use: not practically exploitable given the separation, but a key with two purposes has twice the blast radius on disclosure, and the fallback is otherwise silent.

**Data-source separation on two axes.** The key is otherwise derived only from `(claims, policy, descriptor)`, so one process serving two logical databases through one shared provider — and the zero-config default provider is a process-wide singleton — would produce identical keys and serve DB-A's rows for DB-B. `schemaAllowlist` is folded into the policy digest automatically, covering the ordinary case where the two data sources expose different tables at zero configuration. The optional `cacheScope` covers what table sets cannot distinguish: two data sources with _identical_ schemas, for example, one database per region. Both are folded in only when present, so existing keys stay byte-identical.

**`queryHash`** — SHA-256 (16 hex chars) over the widget descriptor with `id` excluded (so structurally identical widgets share an entry — this is also what makes single-flight dedup possible), serialized via `sortedStringify`. The case-insensitive SQL tokens `joins[].type` and `orderBy[].direction` are lowercased on **hash-input copies** first, so `LEFT`/`left` share a key without ever mutating the host-owned descriptor.

This hashes the descriptor **as received, unvalidated** — `filters[].value` in particular has not yet passed the shape guards — which is precisely why `sortedStringify`'s own recursion-depth cap has to be the thing that fails closed on a pathological value, rather than reordering cache-key generation after validation.

**Tenant segment encoding.** `encodeURIComponent(claims.tenantId)`, not the raw value: `LRUCacheProvider.extractPrefix` recovers the tenant-scoped invalidation prefix by scanning to the 3rd colon, so a `tenantId` containing a `:` (`org:1234`) would shift every boundary and collapse distinct tenants into one eviction bucket. This affects only prefix-invalidation granularity — the HMAC'd `securityHash` already covers `tenantId` verbatim, so it was never a cross-tenant read risk.

**Memoization.** A module-level `Map` bounded at `SECURITY_HASH_MEMO_MAX_SIZE = 1000` pays the HMAC cost at most once per unique `(hmacSecret, permission set, policyDigest, cacheScope)`. Eviction is true **LRU**, not FIFO: a `Map` only updates a key's position on insertion, so evicting `keys().next().value` used to discard the _hottest_ profile on every miss once full. `touchMemoEntry()` re-sets the key on a hit. Performance only — the computed hash is identical either way.

### Canonical serialization (`security/canonicalize.ts`)

`sortedStringify(obj)` is the single deterministic serializer shared by both cache hashes and the policy digest. Keeping one implementation guarantees they can never canonicalize identical inputs differently; it is deliberately not forked into per-file copies.

Its contract, all of it load-bearing for existing hashes:

- Object keys are recursively sorted alphabetically at every depth, so property insertion order never affects output.
- **Array element order is preserved and IS significant** — two inputs whose arrays differ only in order serialize differently.
- `undefined` serializes via plain `JSON.stringify` semantics, distinct from `null`.
- A `toJSON` method is honoured **before** the plain-object branch, so a `Date` (a supported `FilterPredicate.value` shape) serializes to its ISO string. A `Date` has zero own enumerable keys, so the object branch would serialize every distinct date identically and collide two widgets differing only in a `Date` bound onto one entry. Routing through `JSON.stringify` only changes the hash for previously-colliding inputs, so it can never un-share a legitimately shared entry.
- Recursion is capped at `MAX_SORTED_STRINGIFY_DEPTH = 50`, throwing cleanly rather than recursing further — defense in depth for the unvalidated-descriptor ordering described above.

### `extractSecurityClaims` (`security/extractSecurityClaims.ts`)

A **demonstration** HMAC-SHA256 (HS256) JWT verifier — pure, no HTTP dependency — intended to be replaced in production with a real IdP verification library (`jose`, `jsonwebtoken`). Its hardening exists because the JWT payload is client-controlled JSON and every `JwtPayload` field is therefore typed `unknown` at this boundary; the normalizers are what establish the runtime guarantees `JwtSecurityClaims` advertises.

- Requires a non-empty `jwtSecret` (default `process.env.JWT_SECRET`) — an empty key would accept forged tokens, that is, no authentication.
- Parses `"Bearer <token>"`, splits header/payload/signature, and recomputes HS256 over `header.payload`. It compares signature **lengths before** `timingSafeEqual`, which otherwise throws a `RangeError` on a mismatch instead of failing cleanly.
- Requires `exp` to be present **and a finite number**. Presence alone was not enough: `payload.exp < now` silently evaluates to `false` for any non-numeric operand, so `{}`, `"banana"` or `NaN` produced a token that never expired.
- Requires `tenantId` and `sub`. Presence checks only catch _falsy_ values, so `normalizeTenantId`/`normalizeSub` additionally require a non-empty string — a truthy number or object used to flow through into `tenantId: string`/`userId: string` without ever having been one.
- `normalizeRegionIds` coerces to `number[]`: `undefined` passes through, a non-array throws, and each element must be a real number or a **non-empty numeric string**, gated on the _input_ type **before** coercion. `Number(...)` coerces far too eagerly to lean on `Number.isFinite` alone — `Number(true) === 1`, `Number('') === 0`, `Number('  ') === 0` all pass — so a boolean or blank string would silently become region id `1` or `0`, widening or corrupting scope. This also closes a cache-key-fragmentation footgun: `computeSecurityHash` sorts `regionIds` with `(a, b) => a - b`, a no-op on strings, so an unvalidated `["5","6"]` claim could hash two identically-scoped callers to different keys.
- `normalizeRoleIds` defaults a missing claim to `[]`, rejects a non-array, and requires string elements; `normalizeDepartment` allows `undefined` and rejects any other non-string.

## Query construction

### `ValidatedQueryPlan` (`security/validateQueryPlan.ts`)

The read-path boundary object produced once per widget. Every field is already alias-resolved, and it deliberately carries **no `columnAliases` map and no raw logical column names**, so the ambiguous client form is structurally unreachable past this boundary. `ColumnRef` is a branded `string` whose only mint point is `asColumnRef()` inside this module, so a downstream function that wants a `ColumnRef` cannot be handed an unresolved logical name — TypeScript enforces that structurally rather than by convention.

| Field                                | Contents                                                                                                                                                                    |
| :----------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `columns: PlanProjectionColumn[]`    | A `physical` `ColumnRef`, plus — only for an expression field whose logical id differs from its physical column — an `outputAlias` (executed as `physical AS outputAlias`). |
| `filters: ResolvedFilterPredicate[]` | The `FilterPredicate` union with `column` narrowed to `ColumnRef`.                                                                                                          |
| `joins: ResolvedJoin[]`              | Every `on` pair carries a `ColumnRef` on both sides; `type` is lowercased onto the plan.                                                                                    |
| `aggregations: PlanAggregation[]`    | `physical`/`func`/`alias`, plus a precomputed `pureMeasure`.                                                                                                                |
| `orderBy: PlanOrderBy[]`             | Either an `aggAlias` (used as-is) or a `physical` `ColumnRef` (qualified at execution time).                                                                                |
| `having`, `table`, `limit`           | Carried through unchanged.                                                                                                                                                  |

`pureMeasure` flags a measure like `SUM(total) AS total` that must appear only in the aggregate clause, never in GROUP BY. It is computed as `agg.alias === resultKeyOf(physical)` — the **last dot-segment of the resolved physical**, not the raw `agg.column`. `SAFE_ALIAS_PATTERN` forbids `.`, so a raw-string `agg.alias === agg.column` test could never match a table-qualified column (`SUM(orders.amount) AS amount`) and wrongly left that measure in GROUP BY, silently changing the query's grain.

**Dual acceptance.** `isValidatedQueryPlan()` / `toValidatedQueryPlan()` mirror the policy's pattern: an already-compiled plan is returned as-is; a raw descriptor from a direct caller is resolved on the spot via `buildPlan` — **without** re-running the validators, deliberately, so `buildSecureQuery`/`executeForTier`'s direct (test) callers keep their no-throw, resolution-only behavior. That is why several validators in this file stay non-string-tolerant on the direct-caller branch: coercing or optional-chaining there preserves the documented no-throw contract instead of crashing on `undefined.lastIndexOf`, and lets the real validator report the real problem when the request path does run.

### The validator chain

`validateQueryPlan(descriptor, columnAllowlist?)` runs these in order. Everything except the last is **unconditional** — independent of whether a `columnAllowlist` is configured.

1. **`validateHavingAliases`** — every `having[].alias` must match a declared `aggregations[].alias`; a `having` clause on a widget with no aggregations is rejected; each `having[].value` must be a **finite number** (the documented HAVING contract is numeric-only). This is what stops HAVING from reaching arbitrary raw columns, and the value check fails closed at validation rather than letting a non-scalar expand into malformed SQL at `havingRaw`.
2. **`validateWildcardProjection`** — see [Wildcards and projection keys](#wildcards-and-projection-keys).
3. **`validateProjectionKeyCollisions`** — two directly-projected columns whose result-row key collides (`orders.category` and `customers.category` both keying as `category`) are rejected. Runs before the aggregation check so the more fundamental collision is reported first.
4. **`validateAggregationAliases`** — every `aggregations[].alias` must match `SAFE_ALIAS_PATTERN` (`[A-Za-z0-9_-]+`), be no longer than `MAX_STRING_LENGTH`, and be **unique** — including against every projected column's result-row key. Two aggregations sharing an alias both pass the charset check but `execute.ts` SELECTs them under the same row key (one silently dropped) and `applyHaving` binds to whichever `find` returns first. A projected column that IS the aggregation's own pure measure is excluded, since `execute.ts` projects it only inside the aggregate clause; membership is compared on primary-table-qualified physicals so an unqualified column and its qualified aggregation still match.
5. **`validateOutputAliases`** — for every `columns[]` entry that resolves to a _different_ physical column (and so becomes an `outputAlias`), the logical id must match the same `SAFE_ALIAS_PATTERN`, imported from `shared/columnValidation.ts` rather than duplicated. This is the one client-controlled identifier that reaches an interpolated `db.raw('?? as ??', …)`; a direct, non-renamed reference never reaches the alias position and is skipped.

   The charset **includes the hyphen** on purpose: the x-studio client mints expression-field logical ids as `expr-<timestamp>-<counter>` and sends them verbatim, so a hyphen-excluding charset wrongly rejected _every_ join expression-field widget. The hyphen stays injection-safe because both alias positions are Knex identifier-escaped, so it becomes a quoted identifier exactly like an underscore; `;`, spaces, quotes and parens remain rejected.

6. **`validateOrderByDirections`** — every `orderBy[].direction` must be `asc`/`desc`, case-insensitively.

   **This is not an injection guard**, contrary to what it once claimed. Verified against the pinned `knex@3.2.10`: `lib/formatter/wrappingFormatter.js`'s `direction()` replaces anything that is not case-insensitively `asc`/`desc` with `asc`, so `orderBy('a', 'asc; drop table x')` emits `order by "a" asc` and the token never reaches the SQL. The validator earns its place by turning two **silent** failures into a clear per-widget error: a typo'd or wrong-case direction Knex would quietly rewrite to `asc` (returning correctly-shaped but wrongly-ordered rows, which a paginated widget shows as wrong data), and a non-string direction, which throws a raw `TypeError` from inside Knex.

7. **`validateJoinTypes`** — every present `joins[].type` must be `inner`/`left`/`right` (case-insensitive, via `SAFE_JOIN_TYPE`). `buildSecureQuery` matches on exact lowercase `=== 'left'`/`=== 'right'` both to pick the join method **and** to decide whether the joined-table security predicate lands in ON or WHERE, so an unrecognized value (`'full'`), a typo, or a wrong-case `'LEFT'` would fall through every check — silently degrading the join to INNER _with the predicate misplaced_.

   It does **not** mutate the caller's descriptor: a pure validator must not rewrite the host-owned parsed request body. Canonical lowercasing happens where the value is consumed instead — `buildPlan` lowercases onto the **plan**, `computeQueryHash` onto a **hash-input copy**.

8. **`validateJoinOnPairs`** — every present `joins[].on` must be a non-empty array, and each pair must be a real join key rather than a tautology.

   _Empty `on`:_ `buildSecureQuery` iterates `join.on` with a plain `for…of` to emit each `.on(left, '=', right)`, so nothing previously required that loop to run even once. Postgres renders a condition-less join as a syntax error, but **MySQL silently accepts it as a valid CROSS JOIN** — a tenant-bounded cartesian product returning wrong, row-multiplied results instead of failing at all.

   _Tautological `on`:_ a pair like `[['customers.id', 'customers.id']]` passes both allowlists (both are real, allowed columns) but emits `customers.id = customers.id`, which some engines execute as an unconditional match — again a cartesian product within the tenant-scoped rows. So, per pair (each side resolved via `resolveAlias` first): a qualified **right**-hand side must name `join.table`, and a qualified **left**-hand side must name the primary table or a table joined _earlier_ in the same descriptor, never `join.table` itself. An unqualified side is left unconstrained, since Knex auto-qualifies it at build time.

9. **`validateLimit`** — `descriptor.limit` must be a non-negative integer, so a malformed value becomes a per-widget error rather than being silently coerced by the driver into returning every tenant-scoped row.
10. **`validateDescriptorColumns`** — **only** when `options.columnAllowlist` is supplied. Checks `columns`, `filters[].column`, `orderBy[].column`, `aggregations[].column` and both sides of every `joins[].on` pair via the shared `checkColumnAgainstAllowlist()`, resolving each through `resolveAlias` first.

    For a join `on` pair the **left** side is validated against the primary table and the **right** against `join.table`, matching the `[primaryColumn, joinedColumn]` convention, so an unqualified right-side column is checked against the allowlist for the table Knex will actually resolve it against. The check is **fail-closed**: a referenced table with no allowlist entry at all rejects the request (a table opts out by listing `['*']`). An `orderBy[].column` naming a declared aggregation alias is skipped — an alias is never going to appear in a host's list of physical columns, and it is separately charset-validated.

Because every resolution path funnels through `resolveAlias` and `checkColumnAgainstAllowlist` validates whatever physical column comes out, **an alias can only ever relabel a column the caller could already reach — never escalate past the allowlist**.

### Wildcards and projection keys

`resultKeyOf` maps a reference to its result-row key: the last dot-segment (`orders.category` → `category`), or the logical id for a renamed expression field. `validateProjectionKeyCollisions` exists because two columns sharing a key silently overwrite one another in every row — pg and mysql2 both key rows by field name, last-wins.

A **wildcard** breaks that check, because its expansion is unknown: this package holds no schema metadata, and `resultKeyOf` would hand back the literal `"*"`, a key no row actually carries. So `isWildcardReference` (a bare `*` or a trailing `.*`) feeds two rules:

- **`validateWildcardProjection`** admits a wildcard **only as the entire projection** — the sole `columns` entry, unrenamed, with no aggregations. Then there is nothing to collide with and the row shape is exactly one table's columns. `['orders.*', 'customers.name']` keyed as `['*', 'name']`, reported no collision, and returned rows where `customers.name` overwrote `orders.name`. A wildcard reached through `columnAliases` would emit `SELECT "orders".* as "all"`, a syntax error on every dialect. A wildcard alongside an aggregation is rejected because the expansion may contain the aggregation's alias.
- A wildcard **contributes no key** to `projectionKeys`, so the fictional `"*"` is never compared against a real key.

**Implicit projections are always anchored to one table.** A widget with no `columns` and no `aggregations` would make `execute.ts` skip `.select()` and Knex emit a bare `SELECT *`. Two branches replace that:

- With a `columnAllowlist`: `synthesizeProjectionFromAllowlist()` projects exactly the allowlisted physical columns, or — for a `['*']` entry — an explicit `<table>.*`. It throws fail-closed when the table has no entry, reusing `checkColumnAgainstAllowlist`'s "has no entry" message so the extracted error code matches. `['*']` means "all columns of _this_ table", which SQL expresses as `orders.*`: leaving the projection empty would emit a bare `SELECT *` that also returns every column of every joined table, bypassing that table's own stricter entry.
- With **no** allowlist but **with a join**: the projection is anchored to `<primaryTable>.*` anyway. This is the README quick-start deployment shape and it was entirely unguarded — a bare `SELECT *` across a join folds every column of every joined table into one row object, so each shared name (`id`, `name`, `created_at`, `tenant_id`) collapses last-wins and `orders.id` silently becomes `customers.id`. A client that wants joined-table columns names them explicitly, which routes them back through the collision check.

Without a join, `SELECT *` already names exactly one table's columns and is left untouched. Aggregation widgets are exempt from both branches — the db tier emits only aggregation/GROUP BY clauses, and a `<table>.*` entry would land in GROUP BY.

### `buildSecureQuery` (`router/queryBuilder.ts`)

`buildSecureQuery(db, claims, descriptor, options, plan?)` builds — but does not execute — a Knex query. `options` resolves through `toCompiledSecurityPolicy`, `plan` through `toValidatedQueryPlan`; on the request path both are already compiled and are returned as-is.

Order of construction:

1. **Joins** — one `join`/`leftJoin`/`rightJoin` call per `queryPlan.joins[]`, with one `.on()` per `[left, right]` pair inside a single callback, so a composite-key join produces one join clause rather than one per pair (avoiding "table name not unique" errors). For an outer join the ON callback also emits the nullable side's security predicate.
2. **Security predicates** — `applySecurityPredicates` in `'read'` mode for the primary table (unless it is the nullable side of a right join) and for each joined table not already handled in its own ON clause.
3. **User filters** — `applyPredicates(query, qualifiedFilters, 'read')` over the plan's already-resolved columns. No re-resolution happens here.
4. **HAVING** — `applyHaving()` per `queryPlan.having[]` entry.

**Every read-path column reference that reaches raw SQL is table-qualified**, through the single exported `qualifyAgainst(table, reference)` helper (`shared/columnValidation.ts`): SELECT/GROUP BY/ORDER BY/aggregations via `execute.ts`, all three security-predicate dimensions, user filter columns, and both sides of every join `on` pair. The rule is "prefix with the given table unless the reference already contains a dot", and a client-qualified reference is left untouched.

That rule previously had seven independent copies across the validation stage and three enforcement sites, in an area whose own comments record hitting the resulting divergence twice. Minting it once is what keeps the validator and the executor from disagreeing about which table an unqualified column belongs to — the same class of structural guarantee `resolveAlias` provides for alias resolution. A bare `*` is qualified too, deliberately: an unqualified `*` under a join projects every column of every joined table.

The three **security-predicate** dimensions were the last holdout, and only became true as claimed in F3: `emitSecurityPredicates` built its tenant/region/department references with a bare `` `${table}.${securityColumns.X}` `` template — an eighth copy of the rule, divergent on exactly one input. `qualifyAgainst` leaves an already-dotted reference alone; the template always prefixed. So a host configuring `securityColumns: { region: 'customers.region_id' }` (or the tenant/department analogue) emitted the three-segment `orders.customers.region_id`, and every read _and_ write for that deployment failed with a driver error `sanitizeBoundaryError` then masked behind the generic per-widget message. Config-only and fail-closed — no leak — but exactly the drift the single helper exists to remove. Both emitters (`applySecurityPredicates` and `applySecurityPredicatesToJoinOn`) share the one `emitSecurityPredicates` body, so routing it through the helper fixed the WHERE and ON placements together.

**HAVING operator mapping** goes through a fixed `{ eq, gt, lt, gte, lte }` table, gated by `Object.prototype.hasOwnProperty.call` before the lookup. `opMap` is a plain object literal inheriting from `Object.prototype`, so an unguarded bracket lookup would let a client operator naming an inherited member (`"toString"`, `"constructor"`) resolve to a truthy inherited function and defeat a bare falsiness check.

#### HAVING re-emits the aggregate expression

`havingRaw('?? op ?', [alias, value])` — referencing the SELECT output alias — is invalid on PostgreSQL (`42703 column "…" does not exist`); standard SQL does not allow HAVING to reference a SELECT-list alias, though MySQL and SQLite tolerate it. (This is why the jsdom `mockDb` suite, which is not a real SQL engine, never caught it.)

`applyHaving()` instead looks up the matching `PlanAggregation` for `h.alias` — guaranteed to exist on the request path, since `validateHavingAliases` already rejected a mismatch — and re-emits `FUNC(??) op ?`, with `FUNC` read from the shared `AGGREGATE_SQL_FUNCTIONS` table and the aggregation's physical column qualified through `qualifyAgainst`. The identifier stays `??`-bound and the value `?`-bound; only fixed, own-property-gated tokens are ever interpolated as raw text.

### `executeForTier` (`router/execute.ts`)

Resolves `queryPlan = plan ?? toValidatedQueryPlan(descriptor)` and reads pre-resolved `ColumnRef`s off it — it never calls `resolveAlias` itself.

- **`'client'` / `'server'`** — rebuild via `buildSecureQuery`, `.select()` each projection column through the shared `projectColumn()` helper, `.orderBy()`, then `runBounded`. `projectColumn` qualifies the source column in **both** branches: an entry with an `outputAlias` emits `db.raw('?? as ??', [qualify(physical), outputAlias])`, since an unqualified renamed column is exactly as ambiguous under a join as an unqualified direct one. Only the SELECT-list _source_ is qualified — the output row key is untouched, so client row shapes are unaffected. An ORDER BY targeting an aggregation alias is left unqualified, since it is not a physical column.
- **`'db'` without aggregations** — a plain, non-aggregating descriptor whose preflight exceeded `serverMemoryTier` lands here too (`tierFromRowCount` routes purely on row count). It falls back to the **same** plain select/orderBy/limit shape as the other tiers. Running the GROUP-BY logic instead would either GROUP BY every projected column (silently de-duplicating rows the other tiers return raw) or, with no columns either, emit an unbounded `SELECT *` over a slice already known to exceed the server-memory threshold.
- **`'db'` with aggregations** — splits `queryPlan.columns` into GROUP BY dimensions vs pure measures, comparing **primary-table-qualified physicals on both sides** so a qualified measure (`orders.amount`) and an unqualified projected column (`amount`) still match and the measure stays out of GROUP BY. Then, per aggregation:

  ```ts
  if (!Object.prototype.hasOwnProperty.call(AGGREGATE_SQL_FUNCTIONS, agg.func)) {
    throw new Error(/* MUI X Studio Server: … not supported … */);
  }
  query[agg.func]({ [agg.alias]: col });
  ```

  `agg.func` is client-JSON-sourced, so its TypeScript type is not a runtime guarantee: membership is checked as an **own property** of the shared `AGGREGATE_SQL_FUNCTIONS` table before dispatch, and anything else fails closed. Silently omitting the aggregation would surface as a confusing, silently-incomplete result rather than a clear error. The table's five keys _are_ the five Knex builder method names, so the dispatch reads straight off it — and it is the same table `applyHaving` uses, so the SELECT and HAVING paths cannot drift on which aggregate functions exist. This replaced a five-arm `switch` annotated "same five as execute.ts" from the other side of that pair.

  Knex's object/alias-map form (`{ [alias]: column }`) routes both the column and the alias through Knex's own identifier-wrapping, rather than building a `` `col as alias` `` fragment by interpolation.

### The row budget

`MAX_RESULT_ROWS` (100_000) bounds one widget's query and `MAX_WIDGETS_PER_BATCH` (50) bounds how many widgets a request may contain — but nothing bounded their **product**: 50 unbounded widgets could put 5,000,000 rows in the `results` array and serialize them all again into the JSON body. `MAX_ROWS_PER_REQUEST` (deliberately `=== MAX_RESULT_ROWS`) is the request-wide ceiling that makes the per-widget limits **compose rather than multiply**.

**Every one of `executeForTier`'s three exit paths goes through one `runBounded(query, clientLimit, budget)` helper**, which applies the effective limit, runs the query, and charges the rows returned. Routing them through a single helper is what stops them drifting on how the limit is derived, forgetting to charge, or returning a silently-shortened result.

```text
widgetLimit(clientLimit)   = clamp(clientLimit ?? MAX_RESULT_ROWS, 0, MAX_RESULT_ROWS)
effectiveLimit(cl, budget) = min(widgetLimit(cl), budget.remaining)
```

`??` only substitutes on `undefined`, so a client `limit: 0` — a legitimate "return zero rows" request — still limits to zero rather than being read as "no limit".

**Degradation is an ERROR, never a shorter success.** Three things throw:

1. An already-exhausted budget fails the widget **without issuing a query at all** — `LIMIT 0` would cost a round-trip per remaining widget, exactly the fan-out the budget exists to contain, and an empty success would report "0 rows out of `rowCount`" as the real answer.
2. A charge that no longer fits, because concurrent widgets consumed the allowance while this query was in flight.
3. An applied LIMIT that came from the **budget** rather than the client's own `limit`/`MAX_RESULT_ROWS`, and that the query filled — meaning more matching rows exist behind it. This test is deliberately fail-closed: such a result _may_ have had nothing more to give, but that is indistinguishable from truncation without fetching an extra row.

**"Without issuing a query at all" is enforced at TWO places, and the request path needs the earlier one.** The exhaustion check inside `executeForTier` cannot deliver that guarantee on its own, because `runWidgetPipeline` runs the tier decision — and therefore `runPreflight`'s `COUNT(*)` — before it ever calls `executeForTier`. While that was the only check, a starved widget skipped the data round-trip but still paid a full `COUNT(*)`, built through `buildSecureQuery` with every join, semi-join subquery and filter applied and deliberately carrying no LIMIT: usually the **more** expensive of the two round-trips being suppressed. One request could spend the whole budget on widget 0 and still run 49 full counts for distinct-shaped siblings. `runWidgetPipeline` now checks `rowBudget.remaining <= 0` immediately after the data-cache read and before the tier decision, raising the same error from the same exported `rowBudgetExhaustedError` factory. `executeForTier` keeps its own check as defense in depth — for direct callers that thread a budget without the handler, and for exhaustion that lands in the window between the two, since concurrent widgets charge in between. The cache-**hit** path needs no such guard: it costs no database work, and its own charge already fails a widget whose cached rows no longer fit.

The reason is that a truncated result is undetectable data loss. It is indistinguishable from a normal limited page — the client reports "N of M rows" with no way to tell that the server, not the query, chose N — and `handler.ts` would then **cache** that slice under a key with no budget dimension and serve it as a complete answer for the whole TTL, to every user sharing the security profile. Making degradation an error makes the result structurally uncacheable: it never returns, so it never reaches `cacheProvider.set`.

**Charged at all three points where rows enter the response**, exactly once each: the query that fetched them (`runBounded`), a data-cache hit, and every extra widget that attaches to a single-flighted pipeline. `chargeRowBudgetOrThrow` is exported for the latter two. Charging only the first left the other two free — N deduped widgets shared one charge while each still serialized its own copy, and a batch of pre-warmed cache hits was never charged at all. A failed charge leaves `remaining` **untouched**, so a smaller sibling later in the batch is still servable; rows fetched and then dropped stay charged, so the next widget cannot re-issue the identical about-to-be-truncated query.

**What this bounds, exactly.** The **response**: `sum(results[].rows.length) <= MAX_ROWS_PER_REQUEST`. It is _not_ a live-memory cap on executing queries — up to `MAX_CONCURRENT_WIDGET_QUERIES` queries can each read the same remaining allowance before any has rows to charge, so peak simultaneous materialization is bounded by `MAX_ROWS_PER_REQUEST + (MAX_CONCURRENT_WIDGET_QUERIES − 1) × MAX_RESULT_ROWS`. The concurrency cap, not the budget, is what bounds peak memory.

> **This is post-hoc accounting, not up-front reservation, and that is deliberate.** Reserving each query's full limit would make the peak exact — but since `MAX_ROWS_PER_REQUEST` equals `MAX_RESULT_ROWS`, the first widget with no client `limit` would reserve the **entire** request budget and starve every sibling on a page whose widgets simply omit `limit`, which dashboard pages routinely do. A bounded transient overshoot behind an already-capped concurrency window is the far better failure.

A direct caller (unit tests) omits the budget entirely, which reproduces the previous per-widget-only `MAX_RESULT_ROWS` behavior exactly.

## Mutation builders

Every function in `mutations/mutationBuilder.ts` takes `policy: CompiledSecurityPolicy | SecurityPolicyOptions` and resolves the primary table's security columns via `resolvePrimaryCols(table, policy)`. There is no legacy string/loose-option arm: the only way to configure tenancy is the `tenancy` field.

- **`assertValueKeysWellFormed(values, table)`** — the **unconditional** identifier-shape gate on every `values` key, run at all three write entry points (`validateMutation`, `buildInsertMutation`, `buildUpdateMutation`). Any key containing a `.` is rejected: mutation `values` always target exactly one table, so keys must be bare column names, and a qualified key (`orders.region_id`) is malformed on two counts — Knex renders it as a qualified identifier in an INSERT column list or UPDATE SET clause (invalid SQL on mainstream databases), and, more importantly, it would slip past `validateSecurityColumnValues`'s bare-name scope matching, letting a caller stamp a value outside their scope. It then runs the shared `assertColumnReferenceShape()` (length cap + `assertNoImplicitAlias`; the any-dot rejection above already subsumes `assertSingleDotReference` for this reference class).

  Those shape checks previously ran **only** inside `checkColumnAgainstAllowlist`, that is, only when `writableColumns` happened to be configured — the one conditionally-run identifier check in the package, while every sibling entry point (`assertQualifiedColumnsAllowed` on reads, `assertQualifiedWhereColumnsAllowed` for `where[].column` in the same batch) ran them unconditionally. On a `schemaAllowlist`-only deployment, `values: { "status as x": "shipped" }` reached real Knex as `update "orders" set "status" as "x" = 'shipped'`. That fails **closed** — a syntax error, both halves identifier-quoted, nothing injectable — but it surfaces as an opaque driver error `sanitizeBoundaryError` flattens into the generic message, which is exactly what `assertNoImplicitAlias` exists to prevent. **Shape is always answerable, so it is always answered; only MEMBERSHIP stays gated on the allowlist that defines it.**

- **`validateMutation(descriptor, claims, { writableColumns, columnAllowlist, policy })`** runs, in order:
  1. `update`/`delete` **must** carry at least one `where` predicate (insert exempt) — prevents accidental full-table mutations.
  2. An `update` with empty or omitted `values` is rejected. Zero keys means zero writable-column checks, so it previously passed everything for the trivial reason that there was nothing to check, and reached Knex's own unsanitized "Empty .update() call detected". Insert is exempt — an insert with no client values is still a valid, tenant/scope-stamped row.
  3. `where[].column` against `columnAllowlist` (when supplied) via the shared fail-closed `checkColumnAgainstAllowlist()`. The `values`-key **membership** check against `writableColumns` (same helper) runs at the very END of the function, and is the only step gated on that allowlist.
  4. `assertValueKeysWellFormed()` — unconditional key shape (qualified, over-long, `" as "`-bearing).
  5. `validateSecurityColumnValues()` — rejects a client-supplied tenant column outright, and a client-supplied region/department value outside the caller's claims (a region-5 caller cannot stamp a row into region 6).
  6. `validateMutationValues()` — every `values` entry must be a scalar (`string`/`number`/`boolean`/`null`/`Date`), mirroring the read path's guard. Ordered **last** on purpose, so a non-scalar in a _security_ column keeps step 5's more specific message.
- **`resolveInsertScopeStamps(values, claims, cols)`** — INSERT-only fail-closed region/department scope. Tenant is force-stamped unconditionally, but region/department were validated only when the client _supplied_ them, so a region-restricted caller could simply omit `region_id` and mint a region-NULL row escaping its own read scope (bounded within the tenant, but visible to region-unrestricted users). For each dimension, if the caller carries a scope and the column is configured but absent from `values`, it either derives an unambiguous in-scope value to stamp — a single authorized region, or the caller's own department — or **throws** when the server cannot unambiguously pick one (zero or multiple authorized regions). It never mutates `values`, so `validateMutation` can call it purely for the throw while `buildInsertMutation` calls it again to apply the stamps.
- **`buildInsertMutation`** — re-runs the value-key shape gate, unconditionally sets `values[cols.tenant] = claims.tenantId` (overriding any client value), merges in the scope stamps, then `db(table).insert(values)`.
- **`buildUpdateMutation` / `buildDeleteMutation`** — `applySecurityPredicates` in `'write'` mode first (unconditional, unbypassable), then `applyPredicates(query, descriptor.where, 'write')`. `buildUpdateMutation` additionally re-runs the value-key shape gate and **strips the tenant column** from `values`, so a row can never be re-tenanted.

**Defense in depth at the builder boundary.** Both update and delete re-assert the WHERE-required invariant, and update re-asserts non-empty `values`, at the top of the builder — plus `assertValueKeysWellFormed`, `validateSecurityColumnValues` and `validateMutationValues` re-run there. The public `handleMutation` always calls `validateMutation` first, so this closes a defense-in-depth gap rather than a live vulnerability: these are the single most important write invariants, and a direct caller of the builders that skipped validation could otherwise have emitted an unscoped, full-table UPDATE/DELETE.

**Scalar and type-normalization details worth keeping.** `validateMutationValues` exists because `values` keys were validated three ways but the values themselves were only ever length-checked, and only when they already were strings — so `{ notes: { … } }` reached `db(table).insert(values)` directly, where mysql2 coerces the object to the literal `"[object Object]"` and **silently writes it** (data corruption reported as `ok: true`) while pg raises an opaque driver error that flattens into the generic message. Neither is diagnosable. A host with a genuine JSON column serializes it itself, which also brings it under `MAX_STRING_VALUE_LENGTH`.

Region and department comparisons both normalize each side with `String(...)`. `claims.department` is typed `string` and `claims.regionIds` `number[]`, but a deployment whose column is number- or TEXT-typed sends the other type, and a strict `!==` would never match `5` against `"5"` — spuriously rejecting a legitimate in-scope write. Normalizing keeps the check fail-closed (an out-of-scope value still throws) while tolerating the mismatch. Before comparing, a non-scalar region value is rejected outright: `String([5])` is `"5"`, so an array would otherwise coincidentally stringify-match a permitted entry.

**Non-disclosure.** Every row-level-security rejection names the offending **column** only in a server-side `console.warn`, never in the client-facing error. These messages are `MUI X`-prefixed, so `sanitizeBoundaryError` passes them through verbatim — naming the column turned a rejected write into a schema oracle, letting a caller probe `values: { tenant_id: 1 }`, `{ org_id: 1 }`, … until the wording changed and read out the deployment's tenancy/region/department schema. The client still learns the **class** of violation, which is all it needs to fix its own request. This matches the split `assertTablesAllowed`/`checkColumnAgainstAllowlist` already apply to allowlist rejections.

## Caching layer

Two independent planes exist because tier boundaries shift far less often than the underlying data:

- **Data cache** (`CacheProvider`) — actual result rows, keyed by `generateCacheKey()`. Short TTL (LRU default 30s, Redis default 60s).
- **Tier cache** (`TierCacheProvider`) — only the routing decision (`tier`, `rowCount`), never row data. Longer-lived, so repeated cold data-cache misses skip the preflight entirely. `handler.ts`'s `DEFAULT_TIER_CACHE_TTL_MS = 30_000` is what's used in practice (always passed explicitly); provider-level defaults apply only to standalone usage. `tierCacheTtlMs: 0` disables the plane entirely (`handler.ts` then passes `null` as the provider).

Both planes derive their key from the same `generateCacheKey()` output, so `handler.ts` prefixes the tier plane's with `TIER_CACHE_KEY_PREFIX` (`'tier:'`). This namespacing is structural, not provider-specific: it holds even when a host points both providers at one underlying store, where an identical key string would otherwise let the two planes overwrite each other.

### Provider contracts (`cache/types.ts`)

- `CacheProvider.get/set/invalidatePrefix/deleteByTag` — `set()` takes `{ ttlMs?, tags? }`. `invalidatePrefix(prefix)` removes all keys sharing a prefix (tenant-scoped eviction; a caller constructing a tenant prefix must `encodeURIComponent` the tenant id the same way the key format does). `deleteByTag(tag)` removes all entries written with a matching tag (table-level invalidation after a mutation). Both are documented as O(matched entries), not full scans.
- `CacheProvider.wereTagsInvalidatedSince(tags, sinceMs)` — **optional**, one boolean read. It closes the write-after-invalidate race described under [Cache invalidation](#3-cache-invalidation); an implementation that provides it must record `deleteByTag`'s timestamp **even for a tag that matched no keys**, and must answer `true` when freshness cannot be established. Omitting it is supported and keeps the previous (racy) behavior — see that section for the full fallback contract.
- `TierCacheProvider.get/set/invalidatePrefix` — no tagging; tier entries aren't invalidated per-table.
- `CacheEntry` carries `{ rows, cachedAt, tier?, rowCount? }`. `tier` and `rowCount` are optional for backward compatibility with older entries; an absent `rowCount` falls back to `rows.length`, and the reported tier is derived from whichever count that yields. `cachedAt` is written but never read back by this package — it is diagnostic metadata only, which is why it carries no shape check. A stored `tier` is likewise persisted for diagnostics rather than reported verbatim (see the [read path](#read-path)).
- **No-mutation contract on `get`** — the caller must treat the entry and its `rows` as read-only, since an in-process provider may hand back the stored object by reference. Mutating it would corrupt the shared entry for every other reader and make a warm hit behave differently from a cold fetch.

  **The same contract extends to `BatchQueryResponse.results`.** Two results in one response may share a `rows` array _instance_: single-flight dedup collapses structurally identical widgets onto one pipeline (and one cache-hit `rows` object), and each of them returns that object rather than a copy. Cloning per widget would defeat the dedup's memory benefit, which is most of its point — so the aliasing is deliberate and documented on `WidgetQueryResult.rows` instead. A host that post-processes `results[i].rows` **in place** mutates every deduped sibling, and only when the client happens to send identical widgets, so it presents as an intermittent bug.

- **The write side is partially, not fully, defended.** `handleBatchQuery` hands `set()` a shallow copy (`{ rows: [...rows], … }`) rather than the array it also returns to the host. An in-process provider stores what it is given by reference (`LRUCacheProvider` clones only on `get`), so passing the same array made the host's own result and the process-wide cache one object: a host that `splice`d, `sort`ed or truncated `results[i].rows` wrote straight into the cache, and every hit for the whole TTL served the mutated array to every user sharing the security profile.

  **The residual is real and was not fixed.** The copy severs the **array** identity only — the row **objects** are still shared, so a host that mutates a row in place (`results[i].rows[0].total = 0`) still writes into the cached entry. Closing that needs a `structuredClone` on the write side, which would defeat the memory rationale for the single-flight dedup, so it was deliberately not taken; the no-mutation contract above remains what governs in-place row edits.

- **JSON-serializability contract on `rows`** — a remote provider round-trips through `JSON.stringify`/`parse`, so a `Date`, `Map`/`Set`, `undefined` or `BigInt` does not survive a warm hit the way it does in-process. Normalize such columns (for example, to ISO strings) before caching so cold and warm hits are value-identical across every provider.
- **A stored entry is untrusted input**, not a type guarantee — see [invariant 12](#key-design-invariants).

### `ttlMs: 0` flooring (`cache/ttl.ts`)

All four shipped providers agree that an explicit `ttlMs: 0` means "expire almost immediately" (floored to 1 second), never "immortal". `lru-cache` natively treats `{ ttl: 0 }` as "no TTL — never expires", the opposite convention, so both in-process providers pass every `ttlMs` through `floorTtlMs()` (`MIN_TTL_MS = 1000`) in their constructors and in `set()`. It rewrites only the literal `0`; `undefined` and any other TTL, including a legitimate sub-second one, pass through. This matches the Redis providers' own `Math.max(1, ttlSeconds)`, so swapping an in-process cache for a Redis-backed one cannot silently change what `ttlMs: 0` means.

### `LRUCacheProvider` (in-process data cache)

Backed by `lru-cache` with **size-based bounding**: `maxSize` in bytes (default 128 MB) plus a `sizeCalculation` estimate, rather than an unbounded entry count.

The estimate measures a **bounded, strided sample** of the rows (`SIZE_SAMPLE_ROWS = 20` probes spread evenly across `rows.length`, via `sampleRowIndex`), takes their real `JSON.stringify` size, and extrapolates across `rows.length`. A purely count-based estimate (`rows.length * avgBytesPerRow`) is O(1) but assumes every row is roughly the configured average, so a result set with large TEXT/JSON values could push real memory far past `maxSizeBytes` while the LRU believed it was under budget. Measuring a fixed number of rows rather than stringifying the whole result keeps the callback cheap regardless of `rows.length`. A row that cannot be stringified at all (a `BigInt` field) falls back to `avgBytesPerRow` rather than throwing out of a cache write.

**The sample is strided, not a prefix, because row order is a client input.** `execute.ts` applies every `orderBy` entry of a widget descriptor before the LIMIT, so while the callback sampled `rows[0..19]` the caller also chose which rows the byte budget measured: a descriptor ordered to put tiny rows in front of a large TEXT/JSON tail was accounted at the floor — with the defaults a 100k-row result estimated at roughly 51 MB while retaining roughly 800 MB — so the 128 MB budget admitted several such entries and held each for the full TTL, with the overshoot growing linearly in real row size. Striding removes that choice: no contiguous run of rows can hide the rest, and reversing a result set cannot change its accounting.

**What the `Math.max(sampledAverage, avgBytesPerRow)` floor does and does not guarantee.** It guarantees the estimate is never _below_ the **configured** baseline, so a pathologically small or unserializable sample can't under-report a schema known to carry larger rows. It does **not** guarantee the estimate is at or above the entry's _real_ size — outside the sampled rows this is still an extrapolation, and a skewed result set can still be under-estimated. Sub-O(N) accounting can't be exact; what striding buys is that the residual error is no longer client-steerable.

A per-entry ceiling is available as the opt-in `maxEntryBytes` option (`lru-cache`'s `maxEntrySize`), **disabled by default**. `MAX_RESULT_ROWS` (100,000 rows) is a legitimate, fully bounded result shape this cache exists to serve, so any fixed fraction of `maxSizeBytes` would make a class of legal queries permanently uncacheable — trading a byte-accounting correction for a re-query-on-every-request regression. `lru-cache` already stops a single entry from durably exceeding the _whole_ budget (an entry estimated above `maxSize` is evicted by the size-eviction loop right after insertion); the option exists for hosts that would rather keep many medium results than one very large one.

`get()` returns an independent `structuredClone` of the stored entry, backstopping the interface's no-mutation contract. Configured with `updateAgeOnGet: false` — `ttlMs` is a staleness bound, not an idle timeout, so a hot key still expires on schedule and out-of-band writes (ETL jobs, other services) are picked up within the advertised TTL. This mirrors `RedisCacheProvider`, which likewise never refreshes TTL on read.

Two secondary indexes are kept in sync via the LRU's `dispose` callback, which fires on both explicit delete and eviction:

- **Prefix index** (`Map<prefix, Set<key>>`) — the tenant prefix (`studio:v1:<encoded tenant>:`, found by scanning to the 3rd colon) maps to its member keys, making `invalidatePrefix()` O(matched keys), with a full-scan fallback for prefixes that don't match the indexed shape.
- **Tag index** (`Map<tag, Set<key>>`) plus a reverse **key→tags** index — populated from `opts.tags` at `set()` time. `deleteByTag()` looks up the tag's key set directly; the reverse index lets `dispose` clean up only the tags belonging to the evicted key.

### `MapTierCacheProvider` (in-process tier cache)

Also `lru-cache`-backed, bounded by **both** entry count (`max: maxEntries`, default 10,000) and TTL — a plain `Map` would have no entry bound and could grow unboundedly under a stream of unique query shapes. TTLs are floored the same way. Exposes a `size` getter (calling `purgeStale()` first) for tests. `invalidatePrefix()` does a linear scan, acceptable at this plane's much smaller scale.

### Redis providers

`RedisCacheProvider` implements `CacheProvider` against a minimal structural `RedisClient` interface compatible with both `ioredis` and node-redis v4+, auto-detecting the family via `detectClientStyle()` or honouring an explicit `clientStyle`. `RedisTierCacheProvider` is structurally parallel but simpler — no tagging.

Two client-family disagreements are normalized once in `cache/redisCompat.ts` rather than duplicated per provider: `SET key value EX seconds` (ioredis positional vs node-redis `{ EX: seconds }`) via `setEx()`, and SCAN reply shape (ioredis `[cursor, keys]` tuple vs node-redis `{ cursor, keys }`) via `scanKeyPages()`. Set commands for tag indexing differ too (`sadd`/`smembers`/`srem` vs `sAdd`/`sMembers`/`sRem`); the provider checks both and `console.warn`s **once** if neither is present, rather than silently no-op'ing invalidation.

**Tag indexing** maintains two Redis SETs per tagged write: a forward index `<prefix>__tag__:<tag>` and a reverse index `<prefix>__ktag__:<key>`, both namespaced by `keyPrefix` so two deployments sharing one Redis never collide on either. The reverse index's expiry mirrors its data key's. The forward index's expiry is only ever **extended**, never shortened — `extendTagIndexExpiry()` reads the remaining `TTL` first and calls `EXPIRE` only if the new value would outlive the current one. One forward-index key is shared across every entry carrying that tag, so unconditionally resetting it to a later, shorter-TTL write's expiry would let the index expire while an earlier, longer-TTL entry sharing the tag is still live, silently breaking `deleteByTag` for it.

**Bounded key handling** is load-bearing, not a micro-optimization. `deleteByTag()` evicts through the shared `delKeys()` helper in fixed batches (`DEL_BATCH_SIZE = 500`), never a variadic `del(...keys)` spread. Spreading an unbounded key list past V8's argument limit (~64k–125k, engine- and stack-dependent) throws `RangeError: Maximum call stack size exceeded` **before Redis is contacted at all** — and `handleMutation` then swallowed that as a best-effort warning while reporting `ok: true`, so the cache silently stopped being invalidated and every read served pre-mutation rows for the full TTL, precisely when the tag held the most entries.

That ceiling is reachable and **self-reinforcing**: `handleBatchQuery` tags every entry with its primary table, every joined table _and_ every semi-joined table, so a busy multi-tenant deployment accumulates one forward-index member per (tenant × security profile × query shape) within one 60s TTL — on the order of 200k keys — and the set only grows while invalidation keeps failing. `tagKey` is deleted **last**, so a failure mid-drain leaves the index pointing at already-deleted keys (which a retry simply re-deletes) rather than orphaning live keys with no index.

`invalidatePrefix()` uses `SCAN` (never the blocking `KEYS`) via `scanKeyPages()`, **streaming one cursor page at a time** and deleting incrementally instead of materializing the whole matching key set — the same `RangeError` plus a memory spike proportional to the keyspace. Deleting while the cursor is open is safe: SCAN guarantees every key present for the whole iteration is returned. `sAdd()` batches for the same reason.

**Deserialization is shape-checked**, not asserted: `get()` runs `isCacheEntryShape` / `isTierEntryShape` over the parsed value instead of `JSON.parse(raw) as CacheEntry`. Any value that merely parses as JSON — a host key colliding with ours when no `keyPrefix` is set, a partially-written value, an entry from an older schema — was previously served to the read path as a result set.

Both guards live in `cache/types.ts`, next to the interfaces they describe, and both are shared with their non-Redis reader (`handler.ts` and `router/tierDecision.ts` respectively) so a provider and a handler can never disagree about what a usable entry is. They apply the **same field rules**: `tier` must be one of `CACHE_TIERS` (`client`/`server`/`db`) and `rowCount` must be `Number.isFinite` — the difference is only that `TierEntry` declares both required while `CacheEntry` declares both optional, so on the data plane an _absent_ field is a documented legacy shape while a _present but invalid_ one fails the whole entry. `CACHE_TIERS` is one exported constant precisely so the two providers cannot drift on it. A failure is a MISS, warned about once per provider instance (the usual cause recurs on every read of that key and would otherwise flood the logs).

## Input bounds

No shape a client can send may drive unbounded work, and **each dimension needs its own cap — bounding one says nothing about the others.** Enforcement is up front and fail-fast in `assertValidBatchQueryRequest` / `assertValidBatchMutationRequest`, before any policy compilation or query building, plus a second time at the shared identifier choke points both paths funnel through (`shared/assertTablesAllowed.ts`, `shared/columnValidation.ts`). Violations always **reject** the request; nothing is ever silently truncated.

| Dimension        | Cap                                                                                                                                                                                     | Bounds                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| :--------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Count**        | `MAX_WIDGETS_PER_BATCH` / `MAX_MUTATIONS_PER_BATCH` (50)                                                                                                                                | Items per request.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
|                  | `MAX_ARRAY_ITEMS_PER_DESCRIPTOR` (200)                                                                                                                                                  | Every collection inside one descriptor: `filters`, `orderBy`, `aggregations`, `joins`, `columns`, `having`, an `in`-list, a mutation's `where` array and `values` key count, a single `joins[].on` sub-array, and a `columnAliases` key count.                                                                                                                                                                                                                                      |
|                  | `MAX_RESULT_ROWS` (100_000)                                                                                                                                                             | Rows any one query may return.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Length**       | `MAX_STRING_LENGTH` (1024)                                                                                                                                                              | An individual identifier — table/column/alias names, `columnAliases` keys and values, a mutation's `values` keys.                                                                                                                                                                                                                                                                                                                                                                   |
|                  | `MAX_STRING_VALUE_LENGTH` (8192)                                                                                                                                                        | An individual business-data string — a `filters[]`/`where[]` scalar or `in`-list element, a mutation's `values` string value.                                                                                                                                                                                                                                                                                                                                                       |
| **Nesting**      | `MAX_SEMI_JOIN_DEPTH` (2)                                                                                                                                                               | How deep a `semiJoins` tree may nest. Each level is another subquery whose tables, columns and predicates all have to be allowlist-checked and built, and no Studio dashboard produces more than two (a direct one-to-many filter, or a two-hop many-to-many filter through a junction table).                                                                                                                                                                                      |
|                  | `MAX_SORTED_STRINGIFY_DEPTH` (50)                                                                                                                                                       | `sortedStringify`'s recursion.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Product**      | `MAX_ARRAY_ITEMS_PER_DESCRIPTOR` on the **sum** of `joins[].on` lengths, and `MAX_PREDICATE_VALUES_PER_DESCRIPTOR` (2000) on the **sum** of `filters[].value` / `where[].value` lengths | Total join conditions per widget and total predicate comparison values per descriptor, each _in addition to_ its per-item cap. The predicate-value sum spans `semiJoins[].filters` at every nesting level too, not just the descriptor's own `filters`.                                                                                                                                                                                                                             |
|                  | `MAX_ARRAY_ITEMS_PER_DESCRIPTOR` on the **sum** of `semiJoins` entries across every nesting level                                                                                       | Total semi-joins per widget. A nested tree can sit under the per-array cap at every individual level and still sum to an unbounded number of table references to allowlist-check and subqueries to build, so the depth cap alone does not bound it.                                                                                                                                                                                                                                 |
|                  | `MAX_ARRAY_ITEMS_PER_DESCRIPTOR` on each `semiJoins[].filters` array **and** on its **sum** across every nesting level                                                                  | A semi-join's own `filters` array length, capped independently of `MAX_PREDICATE_VALUES_PER_DESCRIPTOR` above: that cap only counts a predicate's `.value`, so a predicate with no `operator`/`value` (for example `{ column: 'orders.status' }`) contributes nothing to it and left the number of predicate _objects_ unbounded — unbounded allowlist-check, cache-key-hash, and subquery-build work per widget before a malformed predicate is ever rejected at query-build time. |
|                  | `MAX_ROWS_PER_REQUEST`                                                                                                                                                                  | `widgets × rows` — see [The row budget](#the-row-budget).                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Simultaneity** | `MAX_CONCURRENT_WIDGET_QUERIES` (6)                                                                                                                                                     | In-flight widget pipelines.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

Why each of the less obvious ones exists:

- **Per-descriptor counts.** The batch caps bound only the _number_ of widgets/mutations, not the size of any single well-formed-looking one's own arrays — a single-widget batch could otherwise smuggle in an arbitrarily large array. A `columnAliases` needs its own `Object.keys(...).length` check plus a plain-object/string-values shape guard, since it is a `Record<string,string>` and falls outside the `Array.isArray` loop entirely.
- **String length.** A charset pattern like `SAFE_ALIAS_PATTERN` constrains _which_ characters a string may contain, never _how many_ — so it is not a length bound, and an arbitrarily long all-legal-characters alias used to pass. Nothing bounded string length anywhere, so a perfectly well-shaped request (one widget, every array under its count cap) could carry a 50MB `table`, `column` or filter value: it passed every check, was recursively serialized and SHA-256/HMAC-hashed once per widget (up to 50×), and reached the database as an expensive bound parameter. The identifier/value split exists because an identifier is developer-authored and never legitimately long, while a filter value is real business data.
- **Product.** 200 joins × 200 `on` pairs each individually satisfies both count caps while still demanding 40,000 join conditions to allowlist-check, alias-resolve and build for one widget — and ~2,000,000 across a 50-widget batch, before any query reaches the database. The identical gap exists for predicate **values**: 200 filters × a 200-element `in` list each is 40,000 bind parameters per descriptor (2,000,000 per batch), every one of them canonicalized and hashed into the cache key and then shipped to the database.

  `MAX_PREDICATE_VALUES_PER_DESCRIPTOR` is deliberately a separate constant at **2000**, not a reuse of `MAX_ARRAY_ITEMS_PER_DESCRIPTOR` (200). A legitimate dashboard genuinely carries several multi-select `in` filters at once — a page filter plus two cross-filters, each with a long selection — so a summed cap of 200 would reject a shape the per-predicate cap already admits individually (two 150-value `in` filters). 2,000 leaves room for ten fully-maxed `in` lists per descriptor while still cutting the worst case 20× at both the descriptor and batch level.

- **Simultaneity.** A count cap says nothing about how many items run _at once_, and the resource exhausted is then the **host's**: without the worker pool, one request could drain a Knex pool the host sized for its entire application. Duplicate work is collapsed rather than merely bounded, via the single-flight map.

When adding a new client-supplied field, cap whichever of these five dimensions it opens.

## Key design invariants

These must hold for any change to this package to be safe.

1. **Zero-Knowledge Rule** — nothing outside `schemaAllowlist` / `columnAllowlist` / `writableColumns` is ever reachable. Table names are checked _before_ any query is built via the shared `assertTablesAllowed()`; column references via `checkColumnAgainstAllowlist()`/`validateDescriptorColumns()` — so the read and write paths can't independently drift on what "allowed" means. **The allowlists themselves are runtime-shape-checked**, at `compileSecurityPolicy` and again at every membership site: membership is `Array.prototype.includes`, so a host that hands over a string where an array was expected degrades to substring matching and the allowlist fails OPEN. See [Allowlist shape](#allowlist-shape-sharedallowlistshapets).

   The two paths place the table check differently **on purpose**: the write path checks the whole batch up front and rejects the entire request (a mutation batch is not a set of independent widgets), whereas the read path checks _inside_ each widget's `try` so one bad descriptor yields that widget's `{ error }` while siblings still resolve. Both extend the rule unconditionally to every table-qualified column reference that could otherwise name a table invisible to `assertTablesAllowed`, sharing one `checkQualifiedColumn()` implementation so their error text can't drift.

   **Identifier SHAPE is checked unconditionally; only MEMBERSHIP is gated on the allowlist that defines it.** "Is this string even a column reference?" (length cap, multi-dot, Knex's implicit `" as "` alias) is always answerable, so it is always answered — `assertQualifiedColumnsAllowed` on reads, `assertQualifiedWhereColumnsAllowed` for a mutation's `where[].column`, and `assertValueKeysWellFormed` for a mutation's `values` keys, all sharing one `assertColumnReferenceShape()`. "Is this column allowed?" needs an allowlist, so it runs only when one is configured. A shape check that quietly rides along on a membership check is the failure mode here: the `values`-key checks did exactly that, and a `schemaAllowlist`-only deployment therefore got an opaque driver error where every sibling reference got this package's own.

   No implicit projection may fall back to a bare `SELECT *` — see [Wildcards and projection keys](#wildcards-and-projection-keys).

   **Allowlist rejections name only the offending table/column, never the full allowlist.** The complete enumeration is `console.warn`-ed server-side for operator debugging; the thrown error a caller receives omits it, so enumerating the server's schema map is not possible for an authenticated caller. Row-level-security rejections on the write path follow the identical split.

2. **Security predicates are unconditional, applied first, from one shared implementation, compiled once per request.** `applySecurityPredicates` runs before any user filter in both `buildSecureQuery` and the mutation builders. Column names come from `resolvePrimarySecurityColumns`/`resolveJoinSecurityColumns`, but no enforcement site calls them directly — `compileSecurityPolicy()` runs the chain once per request and hands back a policy every builder reads from, so INSERT tenant-stamping cannot diverge from how reads/updates/deletes resolve the same column.

   A client can never override, remove or AND-away these predicates, move a row into another tenant/region/department, or slip a value past scope validation with a qualified key. A joined table is scoped by default unless explicitly opted out, and `regionIds: []` is treated distinctly from `regionIds: undefined`.

   "Applied first, from one shared implementation" holds for **placement** too: for an outer join the nullable side's predicate moves from WHERE into that join's own ON clause, and both emitters share one `emitSecurityPredicates()` so they can never resolve the same table's scope differently. See [Outer-join predicate placement](#outer-join-predicate-placement) — especially the right-join exclusion from the `OR … IS NULL` relaxation, which is what keeps a multi-right-join shape from leaking across tenants.

   A **semi-join** is the third placement, alongside WHERE and ON: its predicate goes **inside the subquery**, once per nesting level, resolved through the same `policy.forJoinedTable` a joined table uses. Applied only to the outer query, the inner `SELECT` would return every tenant's foreign keys, and any outer row whose own correctly-scoped key happens to collide with one of them survives a filter it never matched. That leak returns no foreign row at all, so nothing in the response reveals it — which is why the placement is an invariant rather than an optimisation.

3. **Tenancy is explicit and fail-closed, enforced at RUNTIME, not just in the types.** `tenancy` is required with no default; the only way to reach an unscoped query is to explicitly declare `{ mode: 'single-tenant' }`. `compileSecurityPolicy` throws on the `single-tenant` + `perTable[].tenant` contradiction, and on an empty/whitespace/non-string `tenantColumn` or dimension override. `policy.tenancy.mode === 'multi-tenant'` is the one tenancy check, and it comes from the same required input the resolvers use, so it cannot drift from enforcement.

4. **Operator allowlisting and read/write predicate semantics are shared.** `SAFE_OPERATORS` and `applyPredicates`/`applyPredicate` are the only place operators are translated to SQL, for both paths; adding one covers both. `mode` is the only intentional divergence, and it is a divergence in how a match-nothing filter is _reported_, not in whether it applies: an empty `in` emits `1 = 0` on read and **throws** on write, and is never dropped on either.

   **A filter the client asked for must never widen the result set.** When two paths in one file appear to disagree about what a Knex call does, the disagreement itself is the bug — verify against the pinned Knex, and pin the rendered SQL in a test.

5. **All SQL goes through Knex's binding/quoting, never raw string-concatenated SQL.** Every _value_ reaches Knex via a `?` binding. Every _identifier_ reaches it via a `??` binding, Knex's object/alias-map form (`query[agg.func]({ [alias]: col })`), Knex's ON-clause value bindings (`andOnVal`/`andOnIn`), or Knex's own identifier-quoting builder methods (`.select`/`.groupBy`/`.orderBy`/`.on`).

   The one identifier string still assembled by interpolation is `qualifyAgainst`'s `` `${table}.${col}` `` qualification, fed to those builder methods — still escaped as an identifier by Knex, not spliced into raw SQL.

   As defense in depth, the free-form client-supplied tokens in these paths are additionally constrained to fail-closed allowlists **that all run unconditionally**, independent of any `columnAllowlist`: `agg.alias` to a charset _and_ a length, `outputAlias` to the same charset, `orderBy[].direction` to `asc`/`desc`, `join.type` to `inner`/`left`/`right`, `agg.func` to `AGGREGATE_SQL_FUNCTIONS`, and the HAVING operator to `opMap`'s five keys.

   **Every client-keyed plain-object lookup is own-property-gated** (`Object.prototype.hasOwnProperty.call`) — `resolveAlias`'s `columnAliases`, `checkColumnAgainstAllowlist`'s and `synthesizeProjectionFromAllowlist`'s `allowlist[table]`, `lookupPerTableOverride`'s `perTable[table]`, `applyHaving`'s `opMap`, and the aggregate-function dispatch. A client key naming an inherited member (`"constructor"`, `"toString"`, `"__proto__"`) must resolve to the literal string or a fail-closed "no entry", never a truthy inherited value.

6. **Cache keys are opaque and policy-scoped.** `generateCacheKey` HMACs the security-claims portion so a client cannot guess or enumerate another tenant's key, and folds in the policy digest covering `tenancy`, `securityColumns`, `columnAllowlist` **and `schemaAllowlist`**. The digest and both hashes canonicalize through the single shared `sortedStringify`, so they can never disagree about how identical inputs serialize.

7. **No hard Knex/Redis dependency in source.** `db` is typed `any` and only called through Knex's chainable builder API; `RedisClient` is a minimal structural interface compatible with both client families. Don't add a literal `import … from 'knex'` or a specific Redis import to core logic. `knex` appears in `package.json` only as a `peerDependencies` entry (plus `devDependencies` for type-checking).

8. **Two independent cache planes** — data (rows, short TTL) and tier (routing decisions only, longer TTL), because tier boundaries shift far less often than the data. `tierCacheTtlMs: 0` disables the tier plane.

9. **Batch-level isolation, request-level rejection.** Allowlist and tenancy-config violations reject the whole batch — nothing partially executes against disallowed tables. Per-item _execution_ errors are isolated to that one widget/mutation. On the write path this sits on top of **sequential** execution and remains the default, with all-or-nothing available only as an explicit `atomic: true` opt-in. On the read path it coexists with bounded concurrency and single-flight dedup: a shared pipeline still yields each duplicate widget its own `{ id }` and its own `{ error }`.

10. **Column-reference resolution and validation are compiled once per widget, into a typed boundary.** `resolveAlias()` is the one function mapping a logical id to a physical column, but `buildSecureQuery`/`executeForTier` never call it: `validateQueryPlan()` runs it and the validators exactly once and returns a `ValidatedQueryPlan` of branded `ColumnRef`s carrying no raw logical names and no `columnAliases` map. Because every downstream site reads the same pre-resolved refs, a filter predicate and a join predicate referencing the same logical column are _structurally_ guaranteed to resolve to the same physical column. The same reasoning made `qualifyAgainst` a single exported helper.

11. **Every client-controlled input dimension is bounded** — count, length, nesting, product, and simultaneity. See [Input bounds](#input-bounds).

12. **Anything read back from the cache is untrusted input — every consumed field, not just the obvious one.** The backing store is host-pluggable and may be shared (a colliding host key, a partially-written value, an older schema, a buggy custom provider), so every reader shape-checks before trusting and degrades a structurally invalid entry to a MISS, reusing the same path a backend failure takes.

    There are exactly four readers, and they run two shared guards from `cache/types.ts`:

    | Reader                                | Guard                                                                                                             | Fields validated                                |
    | :------------------------------------ | :---------------------------------------------------------------------------------------------------------------- | :---------------------------------------------- |
    | `handler.ts` (data plane)             | `isCacheEntryShape`                                                                                               | `rows` (array); `tier`, `rowCount` when present |
    | `RedisCacheProvider.get`              | `isCacheEntryShape`                                                                                               | same                                            |
    | `router/tierDecision.ts` (tier plane) | `isTierEntryShape` via the provider, plus its own `Number.isFinite(rowCount)` second line for non-Redis providers | `tier`, `rowCount` (both required)              |
    | `RedisTierCacheProvider.get`          | `isTierEntryShape`                                                                                                | same                                            |

    `CacheEntry.cachedAt` is deliberately **not** validated: it is written and never read back, so there is no consumer for a bad value to mislead. Individual `rows[]` objects are likewise not inspected — they are opaque payload this package forwards without interpreting.

    Silently trusting a field costs more than a crash would: a non-numeric `rowCount` made every `tierFromRowCount` comparison false and routed widgets to the `db` tier under a nonsense count, with nothing failing; and an out-of-union `tier` reached a `WidgetQueryResult` the Studio client switches on to decide whether to filter and aggregate in-browser. **When a field is added to either entry type, add it to the corresponding guard — or state, as `cachedAt` does, why no reader can be misled by it.**

13. **A degraded result is an error, never a quieter success — and must never be cached.** Anything that shortens a result for a reason the client did not ask for (the row budget, today) throws rather than returning rows. A truncated result is indistinguishable from a normal limited page, and caching one serves undetectable data loss as a complete answer for the whole TTL, to every user sharing the security profile. Making degradation an error makes uncacheability _structural_ rather than a flag someone must remember to check.

## Extension points

- **New cache backend** — implement `CacheProvider` and/or `TierCacheProvider` and pass it via `options.cacheProvider`/`options.tierCacheProvider`. A Redis-compatible provider should reuse `detectClientStyle()` and `setEx()`/`scanKeyPages()`/`delKeys()` rather than re-deriving the wire-shape differences — and must **stream** `scanKeyPages()` rather than accumulate, and delete through `delKeys()` rather than spread a key list into one variadic `del(...)`. A `get()` that deserializes from a shared store must shape-check what it returns rather than asserting the stored type.
- **New filter operator** — add it to `SAFE_OPERATORS` and the `switch` in `applyPredicate` (`shared/predicates.ts`); this single change covers both paths.
- **New join type** — extend `JoinDescriptor.type` (`security/queryTypes.ts`), the `SAFE_JOIN_TYPE` allowlist and `ResolvedJoin.type` union (`security/validateQueryPlan.ts`), and the join-method branch in `buildSecureQuery`. Then **decide whether the new type has a nullable side**; if so, route that side's security predicate through `applySecurityPredicatesToJoinOn` (ON clause) rather than `applySecurityPredicates` (WHERE), the way `left`/`right` do, to avoid re-introducing the outer-join row-drop bug.
- **New semi-join shape** — a `SemiJoinDescriptor` is a _second table reference_, so it has to clear every gate a join does, plus one more. Extend `SemiJoinDescriptor` (`security/queryTypes.ts`), `validateSemiJoins` and `ResolvedSemiJoin` (`security/validateQueryPlan.ts`), and `applySemiJoins` (`router/queryBuilder.ts`). Then confirm all four: the table reaches `assertTablesAllowed` through `collectSemiJoinTables`; both column references pass `validateDescriptorColumns` **against the table each actually resolves against** (the outer column against the enclosing table, the projected column against the semi-join's own); the qualification rule is enforced in both directions, because a semi-join's two references have exactly one correct pairing and getting either wrong is a silently different filter rather than a syntax error; and **the security predicate is applied inside the subquery, at every nesting level**. The negated (anti-join) form is deliberately absent — `NOT IN` over a NULL-bearing subquery excludes every row.
- **New aggregate function** — add it to `AGGREGATE_SQL_FUNCTIONS` (`security/validateQueryPlan.ts`). Both `execute.ts`'s dispatch and `applyHaving`'s SQL emission read off that one table; the key must be the Knex builder method name.
- **New security dimension** (beyond tenant/region/department) — extend `SecurityColumns`/`SecurityColumnsConfig` (`security/authTypes.ts`) and the corresponding branch in the shared `emitSecurityPredicates()`. Since both the WHERE and ON emitters delegate to it, one change covers reads, writes and both join placements. For a value carried in mutation `values`, also extend `validateSecurityColumnValues()`.

## Testing conventions

`src/__tests__/mockDb.ts` is an in-memory, Knex-_compatible_ (not a real SQL engine) fake covering the subset of the builder API this package calls, so the full pipeline can be exercised without a native SQLite dependency.

**Its limitation is architecturally load-bearing, not an implementation detail.** It is not a SQL engine and it never merges joined columns, which is exactly why three separate rounds of unqualified-column-reference bugs (filter columns, renamed projection columns, join `on` pairs) survived review after review, and why a PostgreSQL-invalid HAVING clause shipped. **Anything that depends on real dialect behavior must additionally be pinned with real-Knex `.toString()` renders** — several suites do this deliberately, pinning both the correct shape and the pre-fix broken one.

**A stub that swallows a callback tests nothing inside it.** `buildSecureQuery` emits every join as `join(table, function () { this.on(…) })`, and that callback is where `applySecurityPredicatesToJoinOn` places the outer-join security predicate — the entire ON-vs-WHERE placement rule. Every end-to-end join test in `handler.test.ts` used to stub the join as `qb.leftJoin = () => qb`, which discards the callback, so none of that code ran in any `handleBatchQuery` test even though one of them claimed to "verify the full code path runs". They now install `installRecordingJoins()`, which actually invokes the callback against a recording `on`/`andOnVal`/`andOnIn` context and asserts what the ON clause contained: the client's own qualified pair, the joined table's tenant predicate in ON for a LEFT join, and the **primary** table's predicate in the first right join's ON for a RIGHT join. `router/__tests__/queryBuilder.test.ts` covers those branches against real Knex; what was missing here was the handler-level composition (compiled policy → validated plan → builder) reaching a real ON clause at all.

| Suite                                                    | Focus                                                                                                                                                                                                                                                                                                                                                                                                                     |
| :------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `__tests__/handler.test.ts`                              | The largest end-to-end suite — allowlisting (including the host allowlists' runtime shape), tenant isolation, tiering, caching (including that the returned rows array is not the cached one), HAVING, aggregation push-down, per-widget failure isolation, request-shape and size/length caps, the concurrency/dedup/budget governors, the data-cache entry shape checks, and the two planes' tier-reporting parity.     |
| `__tests__/requestRowBudget.test.ts`                     | The row budget through a real `handleBatchQuery`: a starved widget errors with **no cache entry written**, entry count always equals the number of _served_ widgets, and each of the three charge paths keeps `sum(rows.length) <= MAX_ROWS_PER_REQUEST` while smaller siblings stay servable. Also counts `COUNT(*)` **preflights**, pinning that a widget starved before it starts issues no round-trip of either kind. |
| `__tests__/defaultCacheSharing.test.ts`                  | A zero-config read populates the process-wide default cache and a subsequent mutation actually invalidates it.                                                                                                                                                                                                                                                                                                            |
| `__tests__/readWriteCacheRace.test.ts`                   | Holds a read's SELECT open, commits + invalidates a mutation underneath it, and asserts the racing read does not re-cache pre-mutation rows. Also pins the documented fallback for a provider without `wereTagsInvalidatedSince`.                                                                                                                                                                                         |
| `security/__tests__/canonicalize.test.ts`                | `sortedStringify`'s contract directly, decoupled from its two consumers so they can't silently diverge.                                                                                                                                                                                                                                                                                                                   |
| `security/__tests__/compileSecurityPolicy.test.ts`       | Resolution-chain parity against the underlying resolvers across a config matrix, plus every fail-closed throw and digest sensitivity.                                                                                                                                                                                                                                                                                     |
| `security/__tests__/validateQueryPlan.test.ts`           | Alias-resolution parity for every plan field, each validator, the projection/wildcard rules, and the dual-acceptance branch deliberately **not** running validators.                                                                                                                                                                                                                                                      |
| `security/__tests__/cacheKey*.test.ts`                   | Determinism, claim and policy-digest scoping, order-independence, key format, tenant-segment encoding, the empty-secret throw, and LRU-not-FIFO memo behavior.                                                                                                                                                                                                                                                            |
| `security/__tests__/extractSecurityClaims.test.ts`       | The demo verifier's every fail-closed branch and the normalized claim shape.                                                                                                                                                                                                                                                                                                                                              |
| `router/__tests__/queryBuilder.test.ts`                  | Predicate ordering, region/department scope distinctions, join placement, HAVING re-emission, and column qualification — the last three with real-Knex renders.                                                                                                                                                                                                                                                           |
| `router/__tests__/execute.test.ts`                       | Recorded-builder regressions the mock cannot express: an implicit projection under a join emits `orders.*`, and a renamed projection's `?? as ??` carries the _qualified_ source.                                                                                                                                                                                                                                         |
| `router/__tests__/preflight.test.ts`                     | `COUNT(*)` coercion and ORDER BY qualification across tiers.                                                                                                                                                                                                                                                                                                                                                              |
| `router/__tests__/tierDecision.test.ts`                  | Forced db tier, thresholds, provider-failure degradation, tier re-derivation from a cached `rowCount`, and non-finite `rowCount` falling back to the preflight. Its data-plane counterpart lives in `handler.test.ts`; the parity between them is pinned there.                                                                                                                                                           |
| `shared/__tests__/columnValidation.test.ts`              | Own-property gating, multi-dot rejection, and `" as "` rejection with a legitimate `as`-containing column still passing — all through the allowlist-gated path; the UNGATED path is pinned in `mutationBuilder.test.ts`.                                                                                                                                                                                                  |
| `shared/__tests__/predicates.test.ts`                    | Own-property gating on `perTable`, and the empty-`in` read/write split at both the recorded-call and rendered-SQL level.                                                                                                                                                                                                                                                                                                  |
| `mutations/__tests__/mutationBuilder.test.ts`            | Every write invariant, scope stamping and its fail-closed throws, the scalar-values guard at both boundaries, the `values`-key shape checks with NO `writableColumns` configured, and that no rejection names the security column.                                                                                                                                                                                        |
| `mutations/__tests__/handleMutation.test.ts`             | Batch-level rejection vs per-item isolation, invalidation (default singleton and best-effort degradation), sequential ordering, driver-dependent `rowsAffected`, and the full `atomic` suite.                                                                                                                                                                                                                             |
| `mutations/__tests__/handleMutationPolicyInputs.test.ts` | What the write path hands `compileSecurityPolicy`, and that the resulting digest matches the read path's for the same options. Its own file because it module-mocks the compiler — the argument is not otherwise observable, since the write path never consumes the digest.                                                                                                                                              |
| `cache/__tests__/*.test.ts`                              | Per provider: TTL semantics and `ttlMs: 0` parity across all four, prefix/tag invalidation with `dispose` cleanup, real byte-budget eviction under large-payload rows, `keyPrefix` namespacing, `SCAN`-not-`KEYS`, batched-and-streaming large-scale invalidation, and the deserialization shape checks.                                                                                                                  |
| `cache/__tests__/redisCompat.test.ts`                    | `delKeys` batch boundaries and coverage; `scanKeyPages` yielding one page per round-trip, plus its fallbacks.                                                                                                                                                                                                                                                                                                             |
| `benchmarks/run.ts`                                      | `pnpm --filter "@mui/x-studio-data-middleware" bench` — cache keying, LRU hit/miss, `invalidatePrefix` at scale, `runPreflight`, and cold/warm `handleBatchQuery`.                                                                                                                                                                                                                                                        |
