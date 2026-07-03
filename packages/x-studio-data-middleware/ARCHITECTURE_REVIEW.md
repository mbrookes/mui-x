# Architecture review — `@mui/x-studio-data-middleware`

Independent ground-up review of the package as of 2026-07-03. Every claim below was verified
against the current source under `packages/x-studio-data-middleware/src/`; `ARCHITECTURE.md` was
used as a map only. Findings are grouped by the project's four-tier taxonomy and ranked by
severity within each tier.

Overall assessment: the core read-path security model (shared predicate module, unconditional
security predicates applied first, parameterized bindings everywhere, fail-closed read-path
column allowlist, HMAC-scoped cache keys) is sound and well tested. The serious problems are
concentrated on the **mutation path's handling of the newer `securityColumns` config** and one
**cache-staleness bug in the default data-cache provider**.

---

## Tier 1 — Correctness / security bugs

### 1.1 CRITICAL — INSERT tenant stamping ignores `securityColumns`; cross-tenant row injection

- `src/mutations/mutationBuilder.ts:96-110` (`buildInsertMutation`), `:70-74` (`validateMutation`
  tenant-column rejection), and `src/mutations/handleMutation.ts:94` (call site).

`buildInsertMutation` only stamps `claims.tenantId` when the **legacy** `tenantColumn` option is
set, and `handleMutation` passes only `tenantColumn` to it — `securityColumns` is never consulted
on the insert path:

```ts
// handleMutation.ts:94
const result = await buildInsertMutation(db, claims, descriptor, tenantColumn);
// mutationBuilder.ts:105-107
if (tenantColumn) {
  values[tenantColumn] = claims.tenantId;
}
```

Likewise `validateMutation`'s "client may not set the tenant column" check compares only against
`options.tenantColumn` (`col === options.tenantColumn`, line 70).

Consequence: a deployment that configures tenancy **only** through the newer shape —
`securityColumns: { tenant: 'tenant_id' }` (or a `perTable` override) — gets correct read/update/
delete scoping (`resolvePrimarySecurityColumns` falls through `override → config → tenantColumn`),
but INSERTs are **not stamped with the caller's tenant at all**, and the client may freely supply
`tenant_id: 'victim-tenant'` in `values` (the rejection check passes because
`options.tenantColumn` is `undefined`). That is a cross-tenant write: an attacker can create rows
that appear inside another tenant's dashboards. The same mismatch occurs when `tenantColumn` and
`securityColumns.perTable[table].tenant` disagree — inserts stamp the wrong column.

This directly contradicts design invariant #2 in `ARCHITECTURE.md` ("update/delete always
overwrite/strip `values[tenantColumn]` … nor move a row to another tenant") for the insert case.

**Recommendation:** resolve the tenant column once via
`resolvePrimarySecurityColumns(descriptor.table, options.securityColumns, options.tenantColumn)`
in both `validateMutation` (for the values rejection) and `buildInsertMutation` (for stamping),
exactly as `buildUpdateMutation`/`buildDeleteMutation` already do. Add the missing test (see 4.1).

### 1.2 HIGH — `LRUCacheProvider` uses `updateAgeOnGet: true`; hot cache entries never expire

- `src/cache/LRUCacheProvider.ts:69`.

The default data-cache provider configures `lru-cache` with `updateAgeOnGet: true`. In
`lru-cache`, this resets an entry's TTL clock on every `get()` — a key read more often than every
30 s (the default TTL) **never expires**. A dashboard that polls a widget on any interval shorter
than the TTL will be served the same cached rows indefinitely; the only refresh path left is
`deleteByTag` from `handleMutation`, which does not fire for out-of-band writes (ETL jobs, other
services, direct DB writes). The TTL is supposed to be the staleness bound; this option silently
removes it for exactly the entries that matter most.

Note the behavioral drift with `RedisCacheProvider`, which (correctly) does not refresh TTL on
read — the same deployment behaves differently on one node vs. multi-node.

**Recommendation:** set `updateAgeOnGet: false` (the `lru-cache` default). If read-driven
retention is desired for LRU _ordering_, that already happens via recency; it must not extend TTL.
Add a test asserting an entry expires after `ttlMs` even under continuous reads (see 4.2).

### 1.3 MODERATE — HAVING-alias validation only runs when `columnAllowlist` is configured

- `src/handler.ts:93-97` (gate) and `:196-209` (the check, inside `validateColumns`).

The "HAVING alias must match a declared aggregation alias" security check lives inside
`validateColumns()`, which is only invoked when `options.columnAllowlist` is supplied. Without a
column allowlist (explicitly supported, "backward compatible" per `security/types.ts`), a client
can send `having: [{ alias: 'any_real_column', operator: 'gt', value: N }]` with **no**
aggregations. `buildSecureQuery` then emits `havingRaw('?? > ?', [alias, value])`
(`router/queryBuilder.ts:102-130`) — injection-safe via `??` binding, but it turns HAVING into a
comparison oracle on arbitrary columns the widget never selected, and produces confusing SQL
errors from the COUNT(\*) preflight for non-aggregated queries. The check does not depend on the
allowlist at all — it validates `having[].alias` against `descriptor.aggregations[].alias`, both
part of the descriptor.

`ARCHITECTURE.md` (§ Read path, step 2) presents this check as _the_ thing that "stops HAVING
from reaching arbitrary raw columns" — that claim is only true when a column allowlist is set.

**Recommendation:** hoist the HAVING-alias loop out of `validateColumns` into `handleBatchQuery`
so it runs unconditionally for every widget. Also reject `having` on descriptors with no
`aggregations` (currently guaranteed only as a side effect of the alias-set being empty).

### 1.4 MODERATE — Write-path column validation is fail-open per table (read path is fail-closed)

- `src/mutations/mutationBuilder.ts:49-62` (`where` columns) and `:65-84` (`values` keys).

Both write-path checks skip validation when the target table has no allowlist entry:

- `where` predicates: `if (allowed && !allowed.includes(column))` — a qualified column
  `sometable.col` where `sometable` has no `columnAllowlist` entry passes silently.
- `values` keys: the whole block is inside `if (allowed)` — a table present in `schemaAllowlist`
  but missing from `writableColumns` accepts **every** column, including `region_id` /
  `department` / any other sensitive column.

The read path (`handler.ts:136-172`) was deliberately hardened to fail closed, with an explicit
`['*']` wildcard escape hatch, and its docblock explains why fail-open is a probing hole. The
write path never got the same treatment — and it also does not honor `'*'`, so a host that uses
the wildcard convention on reads gets spurious rejections on writes for the same table.

**Recommendation:** mirror the read-path semantics: when `columnAllowlist` / `writableColumns`
is supplied, a referenced table with no entry is an error; support `['*']` as the explicit
opt-out. Best done by sharing one implementation (see 2.2).

### 1.5 MODERATE — INSERT enforces tenant only; region/department scope not applied to inserts

- `src/mutations/mutationBuilder.ts:96-110`.

Reads, updates and deletes all enforce region/department claims via `applySecurityPredicates`,
but INSERT neither stamps nor validates them. A user restricted to `regionIds: [5]` can insert
rows with `region_id: 6` (subject only to `writableColumns`, which is fail-open per 1.4). The row
lands in a slice of data the writer cannot even read back — and pollutes region-6 users' widgets.

**Recommendation:** at minimum document this asymmetry in `HandleMutationOptions.securityColumns`;
preferably validate `values[regionColumn] ∈ claims.regionIds` and
`values[departmentColumn] === claims.department` when those claims are present, in
`validateMutation`.

### 1.6 LOW — Mutations in a batch execute concurrently with no ordering or atomicity

- `src/mutations/handleMutation.ts:64-67` (`Promise.all(body.mutations.map(...))`).

A batch like `[insert row, update that row]` races: `Promise.all` starts all mutations
concurrently, so ordering depends on the driver. Clients typically assume a mutation batch runs
in array order (that is what "batch" implies for writes), and nothing documents otherwise. There
is also no transaction: a mid-batch failure leaves earlier mutations committed (per-item error
isolation is deliberate, but the _concurrency_ is not called out anywhere).

**Recommendation:** process mutations sequentially (`for … await`) — batch sizes are small and
correctness beats latency on the write path — or document the concurrency contract explicitly in
`BatchMutationRequest`.

### 1.7 LOW — Cache hits misreport `rowCount` when `limit` truncates the result

- `src/handler.ts:229-238` (hit path: `rowCount: cached.rows.length`) vs. `:257` (miss path:
  preflight count).

On a cold miss, a non-aggregated widget reports `rowCount` = COUNT(\*) result (e.g. 5 000) while
`rows` is truncated to `descriptor.limit` (e.g. 100). On the subsequent cache hit for the same
request, `rowCount` becomes `cached.rows.length` (100). Any client logic keyed on `rowCount`
(pagination, "showing X of Y" labels, tier heuristics) sees the value flip between requests.

**Recommendation:** persist `rowCount` on `CacheEntry` (alongside the existing `tier` field, with
the same optional/backward-compatible treatment) and echo it on hits.

### 1.8 LOW — `db`-tier fallback for large _non-aggregated_ queries silently deduplicates rows

- `src/router/preflight.ts:102-135` (db branch), reachable via `tierFromRowCount` returning
  `'db'` for > `server` threshold rows with no `aggregations`.

With no `AggregationSpec`s, `measureColSet` is empty, so **every** selected column goes into both
SELECT and GROUP BY — the widget receives `SELECT DISTINCT`-equivalent rows instead of raw rows,
with `rowCount` still reporting the raw preflight count. `security/types.ts:151` documents "the
db tier returns grouped rows without aggregation", but the result-shape change is invisible to
the client (the `tier` field is the only hint) and the rowCount/rows mismatch is unambiguous.

**Recommendation:** for the non-aggregated db tier, drop the `groupBy` and return plain
`SELECT … LIMIT` rows (the tier is about _where_ work happens, not about changing semantics), or
make the dedup explicit in `WidgetQueryResult`.

### 1.9 LOW — Redis tag forward-index TTL is overwritten by the most recent write

- `src/cache/RedisCacheProvider.ts:195-204`.

`set()` refreshes `EXPIRE __tag__:<tag>` to the **current** entry's TTL. If entry A is written
with `ttlMs: 300_000` and entry B (same tag) later with `ttlMs: 1_000`, the shared forward index
expires after 1 s — after which `deleteByTag(tag)` finds no members and A survives until its own
TTL despite a mutation. Not reachable through `handler.ts` today (it never passes `ttlMs`, so all
writes share `defaultTtl`), but the public `CacheProvider.set(opts.ttlMs)` contract invites
per-entry TTLs.

**Recommendation:** only extend, never shorten: skip the `EXPIRE` when the index's remaining TTL
(via `TTL` command) exceeds the new value, or unconditionally set the index expiry to the
provider's max expected TTL.

### 1.10 LOW — Module-level default caches are shared across all callers, keyed without DB identity

- `src/handler.ts:42-57`.

`defaultCache` / `defaultTierCache` are process-global singletons, and `generateCacheKey` encodes
tenant + claims + query shape but **not** which `db` the query ran against. A single process
serving two databases (e.g. staging + prod Knex instances, or per-customer DBs sharing a tenant-id
scheme) through the default providers will cross-serve cached rows between databases. It also
quietly contradicts the file's own "PURE FUNCTION GUARANTEE: No global state mutation" docblock
(lines 13-17).

**Recommendation:** document that the default providers are process-global and single-DB only,
and warn hosts with multiple `db` instances to pass distinct `cacheProvider`s. (Embedding a DB
identity in the key is not possible while `db` is opaque.)

### 1.11 INFO — Error strings leak schema/SQL details to the client

- `src/handler.ts:287-295` and `src/mutations/handleMutation.ts:139-145` return `err.message`
  verbatim in the per-item result; driver errors typically embed full SQL text (including bound
  tenant values and column names). Allowlist-violation errors also echo the entire
  `schemaAllowlist` (`handler.ts:86-89`, `handleMutation.ts:57-60`), handing a prober the full
  table inventory. Deliberate DX trade-offs, but worth an explicit "sanitize in production" note
  in the README, or a `redactErrors` option.

### 1.12 INFO — ORDER BY columns are not table-qualified

- `src/router/preflight.ts:91-94` and `:161-170`. SELECT and GROUP BY qualify unqualified columns
  with the primary table to avoid join ambiguity, but ORDER BY does not — an unqualified order
  column shared by both joined tables fails with "ambiguous column" only when ordering. Apply the
  same `qualify()` helper (excluding aggregation aliases, as the db branch already distinguishes).

---

## Tier 2 — Structural duplication

### 2.1 Redis plumbing duplicated between the two Redis providers

- `src/cache/RedisCacheProvider.ts:334-366` and `src/cache/RedisTierCacheProvider.ts:149-181`
  contain **byte-identical** `scanKeys()` implementations (cursor loop, ioredis vs node-redis
  reply-shape normalization). The `SET key value EX seconds` client-style branching is also
  implemented twice (`redisSetEx` at `RedisCacheProvider.ts:260-266` vs inline at
  `RedisTierCacheProvider.ts:134-138`), as are the constructor option quartets
  (`defaultTtl`/`prefix`/`clientStyle`/`scanCount`). `detectClientStyle` is already shared —
  the precedent exists.

**Recommendation:** extract a `src/cache/redisCompat.ts` with `scanKeys(redis, style, pattern,
count)` and `setEx(redis, style, key, value, seconds)`; both providers shrink by ~50 lines and a
future client-quirk fix lands in one place.

### 2.2 Column-reference validation implemented twice, already drifted

- `src/handler.ts:136-210` (`validateColumns`) vs `src/mutations/mutationBuilder.ts:49-62`.

Both split qualified `table.column` names and check a per-table allowlist, but they have already
diverged in security-relevant ways: fail-closed + `'*'` wildcard on reads vs fail-open + no
wildcard on writes (finding 1.4). This is the textbook "same concept, two implementations, silent
drift" case — and it sits on the security boundary.

**Recommendation:** move a single `checkColumnAgainstAllowlist(rawColumn, defaultTable,
allowlist, context)` (fail-closed, wildcard-aware, alias-resolving hook) into `src/shared/` next
to `predicates.ts`, and call it from both paths.

### 2.3 Table-allowlist check + error message duplicated

- `src/handler.ts:79-90` vs `src/mutations/handleMutation.ts:52-61`: same filter, same error text
  (including the "Allowed tables:" disclosure discussed in 1.11). Trivial to share via a
  `assertTablesAllowed(tables, schemaAllowlist)` helper in `src/shared/`. Low risk today, but the
  error-message wording has to be updated in two places (and `extract-error-codes` will mint two
  codes for one message).

### 2.4 Cache providers are tested twice, in two files that can drift

- `src/__tests__/handler.test.ts` contains full `describe('LRUCacheProvider')` (line 607),
  `describe('MapTierCacheProvider')` (line 638) and `describe('RedisTierCacheProvider')`
  (line 784) suites, while dedicated, more thorough suites exist in
  `src/cache/__tests__/{LRUCacheProvider,MapTierCacheProvider,RedisTierCacheProvider,RedisCacheProvider}.test.ts`.
  The handler-file copies are strict subsets (basic get/set/TTL/prefix). Two homes for the same
  assertions means a behavior change gets "fixed" in one and silently diverges in the other.

**Recommendation:** delete the three provider describes from `handler.test.ts` (keeping only
handler-integration assertions that _use_ the providers) — the dedicated files already cover
everything they do.

### 2.5 Two threshold shapes for one concept

- `HandleBatchQueryOptions.thresholds` uses `{ clientTier, serverMemoryTier }`
  (`security/types.ts:445-450`) while `tierDecision.ts` uses `TierThresholds { client, server }`,
  with a mapping shim in `handler.ts:243-246`. Harmless today, but any third threshold has to be
  added in three places. Recommendation: accept `TierThresholds` in the public options (keeping
  the old keys as deprecated aliases) or centralize the mapping in `tierDecision.ts`.

---

## Tier 3 — God-files / structural cohesion

The package is small (~2 100 non-test source lines) and mostly well factored — `shared/predicates.ts`,
`tierDecision.ts`, `cacheKey.ts` and the cache providers are each genuinely single-purpose. Three
mild issues and two hygiene items:

### 3.1 `router/preflight.ts` is misnamed — it contains the whole execution engine

- `src/router/preflight.ts:63-176`. `runPreflight` (the COUNT(\*), 14 lines) shares the file with
  `executeForTier` (113 lines: projection, alias resolution, GROUP BY/measure splitting,
  aggregation application, ORDER BY mapping, LIMIT — the largest piece of query logic in the
  package). Anyone hunting for "where SELECT clauses are built" will not look in a file named
  `preflight`. Move `executeForTier` to `router/execute.ts` (or fold it into `queryBuilder.ts`,
  which is where the docblock already points readers for query construction).

### 3.2 `handler.ts` mixes four concerns

- `src/handler.ts`: module-global default-provider singletons (42-57), batch-level table
  validation (79-90), the 75-line `validateColumns` (136-210), and per-widget orchestration
  (212-296). The validation half is the natural extraction — a `src/router/validate.ts` (or
  `shared/validation.ts`, combined with 2.2) would leave `handler.ts` as pure orchestration and
  make the fix for 1.3 (unconditional HAVING check) structurally obvious.

### 3.3 `security/types.ts` is a 473-line grab-bag

- Only `JwtSecurityClaims` / `SecurityColumns*` are security types; the rest is the entire wire
  protocol (batch request/response, mutations, join/aggregation specs, both option bags). Not
  urgent, but `models/` or a top-level `types.ts` would stop every module in the package from
  importing "security" for its DTOs.

### 3.4 `package.json` dependency hygiene

- `knex` appears in **both** `dependencies` and `peerDependencies` — the `dependencies` entry
  forces an install of Knex for every consumer even though `src/` never imports it (the package's
  own invariant #6). Keep it in `peerDependencies` (+ `devDependencies` for local type-checking)
  only. `rimraf` is a build-time tool and belongs in `devDependencies`.

### 3.5 Stale usage example in `RedisTierCacheProvider` docblock

- `src/cache/RedisTierCacheProvider.ts:53-62`: the example calls
  `handleBatchQuery(payload, { db, allowedTables: [...] , ... })` — the option is named
  `schemaAllowlist`, and the mandatory `claims` argument is missing entirely. Copy-pasting the
  example fails to compile; fix the snippet.

---

## Tier 4 — Testing gaps

Existing coverage is genuinely strong (fail-closed read allowlist, tenant isolation both paths,
empty-`in` write guard, node-redis v4 wire shapes, multi-page SCAN, byte-budget LRU eviction).
The gaps cluster exactly where the Tier 1 findings live:

### 4.1 No mutation test uses `securityColumns` for tenancy without legacy `tenantColumn`

- All insert-stamping tests (`src/mutations/__tests__/handleMutation.test.ts:391-403`,
  `mutationBuilder.test.ts:249-262`) pass `tenantColumn: 'tenant_id'`. A single test —
  `handleMutation` insert with `securityColumns: { tenant: 'tenant_id' }` and no `tenantColumn`,
  asserting the stored row carries the caller's tenant and that client-supplied `tenant_id` in
  `values` is rejected — would have caught finding 1.1. This is the highest-value missing test in
  the package.

### 4.2 No test that a data-cache entry actually expires under continuous reads

- `src/cache/__tests__/LRUCacheProvider.test.ts` covers overwrite, prefix/tag invalidation and
  byte eviction, but never TTL expiry at all (the only TTL-expiry tests in the repo are for the
  _tier_ cache). A fake-timers test — write with `ttlMs: 30`, `get()` every 10 ms, assert a miss
  after 30 ms — currently **fails** because of `updateAgeOnGet` (finding 1.2), which is exactly
  why it should exist.

### 4.3 No HAVING test without a `columnAllowlist`

- Every HAVING test (`src/__tests__/handler.test.ts:1044-1129`) supplies `columnAllowlist`. Add:
  (a) `having` with an undeclared alias and **no** `columnAllowlist` is rejected (fails today —
  finding 1.3); (b) `having` present with empty `aggregations` is rejected.

### 4.4 No fail-open write-validation tests

- `mutationBuilder.test.ts` verifies rejection of columns _outside_ an existing allowlist entry
  (lines 208-246) but never the missing-table-entry case (`columnAllowlist`/`writableColumns`
  provided, target table absent → currently passes everything), nor `['*']` wildcard behavior on
  the write path. Pin down whichever semantics 1.4's fix chooses.

### 4.5 No mixed-TTL tag-index test for `RedisCacheProvider`

- `RedisCacheProvider.test.ts:418-436` checks that the tag/reverse indexes _receive_ an expiry,
  but not the shortening interaction in finding 1.9 (long-TTL entry + short-TTL entry sharing a
  tag → `deleteByTag` after the short TTL must still evict the long-lived entry). The fake client
  already tracks per-key TTLs, so this is cheap to add.

### 4.6 No test of intra-batch mutation ordering

- Nothing pins whether `[insert X, update X]` in one batch behaves deterministically
  (finding 1.6). Whatever contract is chosen (sequential or documented-concurrent), encode it.

### 4.7 The non-aggregated `db`-tier fallback path is untested

- Every db-tier test in `handler.test.ts` uses `aggregations`. The `rowCount > serverMemoryTier`,
  no-aggregations route (which currently GROUP BYs all columns — finding 1.8) has zero coverage;
  a test with `thresholds: { serverMemoryTier: 2 }` over 5 rows would document today's dedup
  behavior and catch regressions when 1.8 is addressed.

### 4.8 LOW — `extractSecurityClaims` payload-shape edge cases

- No tests for a payload whose `tenantId` is a non-string truthy value (object/number flows
  straight into cache keys and WHERE bindings), for `nbf`, or for a non-HS256 `alg` header (the
  code always recomputes HS256, so this is safe, but a test would document it). Acceptable for a
  demo-grade verifier, but 1-2 cheap tests would harden the trust boundary object.

---

## What is in good shape (no findings manufactured)

- `shared/predicates.ts` — genuinely single-source for read/write predicate translation; the
  read/write empty-`in` divergence is deliberate, documented, and tested from both sides.
- `security/cacheKey.ts` — deterministic, order-independent, HMAC-scoped, fail-closed on empty
  secret, bounded memo; the test suite covers each property individually.
- `router/tierDecision.ts` — small, pure, exhaustively tested including the aggregation bypass
  and the no-TTL "decide without write" mode.
- Read-path tenant/region/department scoping (`queryBuilder` + `predicates`) — applied before
  user filters, verified for custom column names, joined-table opt-in/opt-out, and predicate
  ordering.
- Redis client-family compatibility (`{ EX }` vs positional, camelCase vs lowercase set ops,
  SCAN reply shapes) — normalized once and tested against both fake client shapes, including the
  warn-once path for clients lacking set commands.
