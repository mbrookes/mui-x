# Architecture Review — `@mui/x-studio-data-middleware` (iteration 5)

Fresh, from-scratch review of the **current** state of `packages/x-studio-data-middleware/src`,
performed by reading every source file directly (not trusting prior rounds) and
cross-referencing `ARCHITECTURE.md`. Scope emphasis: `security/`, `router/execute.ts`,
`mutations/`, `cache/`, `shared/columnValidation.ts`.

## Summary

**No Tier 1 (security / correctness) findings.** The load-bearing security machinery is
sound in the current source:

- **SQL-injection surface is clean.** Every value reaches Knex via a `?` binding; every
  identifier reaches Knex either via a `??` binding (`db.raw('?? as ??')`,
  `havingRaw('?? op ?')`), Knex's object/alias-map aggregate form
  (`query.sum({ [alias]: col })`), or Knex's own identifier-quoting builder methods
  (`.select`/`.groupBy`/`.orderBy`/`.on`/`.where`/`.whereIn`). The only interpolated
  identifier strings — `qualify()`'s `` `${table}.${col}` `` and the security-predicate
  `` `${table}.${col}` `` in `shared/predicates.ts` — are built from allowlist-checked
  table names and host-configured (not client) column names, and are still escaped by
  Knex as identifiers. Every client-controlled free-form token that reaches an
  interpolated position is additionally charset-/allowlist-constrained fail-closed:
  `agg.alias` (`validateAggregationAliases`), a renamed projection `outputAlias`
  (`validateOutputAliases`), `orderBy[].direction` (`validateOrderByDirections`), and the
  HAVING operator (own-property `opMap` guard in `queryBuilder.ts:156`). All four run
  unconditionally, independent of `columnAllowlist`.
- **Tenant / row-scope enforcement holds.** `applySecurityPredicates` runs first in
  `buildSecureQuery`, `buildUpdateMutation`, and `buildDeleteMutation`; joined tables are
  fail-closed (inherit the primary table's resolved columns unless explicitly opted out);
  INSERT force-stamps tenant and fail-closed-stamps/throws region/department
  (`resolveInsertScopeStamps`); UPDATE strips the tenant column; `regionIds: []` is treated
  distinctly from `undefined` (match-nothing on read, throw on write). Verified the
  read (`queryBuilder.ts`) and write (`mutationBuilder.ts`) paths resolve columns through
  the same shared resolvers, so they cannot drift.
- **Cache keys are tenant/policy-isolated.** `generateCacheKey` folds the HMAC'd
  `{tenantId, regionIds, department, policyDigest}` security profile plus a distinct
  URL-encoded tenant segment; the policy digest covers `tenancy` + `securityColumns` +
  `columnAllowlist`. The memo map is keyed by the full security profile (no cross-tenant
  collision) and bounded to 1000. Verified no code path produces a key shared across
  tenants or across differently-resolved policies.

The findings below are all Tier 2/3 (hardening / consistency / cosmetic). Several are
already acknowledged in code comments; they are listed for completeness, not because the
package is unsafe.

---

## Tier 2 — worth fixing, not urgent

### 2.1 `ttlMs: 0` has opposite meaning in the in-process vs Redis cache providers

- **Files:** `cache/LRUCacheProvider.ts:112`, `cache/MapTierCacheProvider.ts:80` vs
  `cache/RedisCacheProvider.ts:196` / `cache/RedisTierCacheProvider.ts:132`.
- **Description:** The Redis providers deliberately floor a per-entry `ttlMs: 0` to a
  1-second expiry (`Math.max(1, ttlSeconds)`), and there is an explicit test
  (`RedisCacheProvider.test.ts:216`, "finding 10 — parity") whose comment states the intent
  that both providers "treat `ttlMs: 0` identically (floor to 1 second), **not** 'never
  expires' (the lru-cache convention)". The in-process providers do **not** honor that
  intent: they pass `{ ttl: opts.ttlMs }` straight to `lru-cache`, and `lru-cache` treats
  `{ ttl: 0 }` as **immortal** (never expires) — confirmed against the installed
  `lru-cache` (`getRemainingTTL` returns `Infinity` for a `ttl: 0` entry even with a
  non-zero constructor default).
- **Repro:** `new LRUCacheProvider().set(k, entry, { ttlMs: 0 })` stores `entry` forever;
  `new RedisCacheProvider(redis).set(k, entry, { ttlMs: 0 })` expires it in 1s. A host that
  swaps backends (single-node → multi-node) silently changes semantics; the immortal LRU
  entry also partly defeats the "TTL is a hard staleness bound" guarantee that
  `updateAgeOnGet: false` was chosen to provide.
- **Note:** Not reachable through `handleBatchQuery`/`handleMutation` today — the handler
  never passes `ttlMs` to the data cache, and disables the tier cache (passes a `null`
  provider) rather than setting `ttlMs: 0`. This is purely a direct-host-usage footgun on
  two shipped public classes.
- **Fix direction:** Floor to 1ms (or treat `0` as "use default") in
  `LRUCacheProvider.set` / `MapTierCacheProvider.set` so all four shipped providers agree,
  matching the documented intent already asserted for the Redis side. Add a parity test.

---

## Tier 3 — minor / cosmetic / nice-to-have

### 3.1 `extractSecurityClaims` does not runtime-validate `regionIds` / `roleIds` shape

- **File:** `security/extractSecurityClaims.ts:93-99`.
- **Description:** The demo verifier returns `regionIds: payload.regionIds` verbatim. The
  TS type is `number[]`, but the value is parsed JSON and could be strings (`["5","6"]`),
  a non-array, or objects. Downstream code mostly tolerates strings (the region predicate
  string-normalizes; `validateSecurityColumnValues` compares via `String(...)`), so this is
  not a scope-bypass, but `computeSecurityHash` sorts with `(a,b) => a-b`
  (`cacheKey.ts:49`), which is a no-op/`NaN` on strings — two callers with the same regions
  in a different order would then get different cache keys (harmless fragmentation, not a
  leak).
- **Caveat:** `extractSecurityClaims` is explicitly documented as a demo verifier to be
  replaced in production, so strict input validation is arguably out of scope.
- **Fix direction:** If kept, coerce/validate `regionIds` to `number[]` (or reject
  non-arrays) at the trust boundary; or document that the production verifier must.

### 3.2 Non-aggregation `db`-tier reads return uncached raw rows over a large tenant slice

- **File:** `router/execute.ts:101-113`; caching gate `handler.ts:208`.
- **Description:** A plain (non-aggregation) descriptor whose preflight `COUNT(*)` exceeds
  `serverMemoryTier` is routed to the `db` tier, where it now correctly falls back to a
  plain `select/orderBy/limit` returning **raw** rows — but `handler.ts` skips the data
  cache for every `tier === 'db'` result (the comment "DB push-down returns aggregated
  rows — not suitable for re-filtering" no longer matches this raw-row branch). Such a
  query re-runs on every request and ships a >100k-row slice to the client, which is the
  opposite of what the tiering is meant to avoid.
- **Fix direction:** Consider caching the non-aggregation `db`-tier result (its rows are
  raw and re-usable, unlike a true aggregation push-down), and update the stale comment.
  Purely a performance/consistency concern — no security impact.

### 3.3 `department` scope silently drops on an empty-string claim (fail-open for that dimension)

- **Files:** `shared/predicates.ts:217`, `mutations/mutationBuilder.ts:143,207`.
- **Description:** Department scoping gates on `claims.department` truthiness, so a
  `department: ''` claim emits no department predicate (caller sees/writes all departments
  within their tenant). Region deliberately distinguishes `undefined` from `[]`; department
  has no analogous "authorized for zero departments" state, and `''` is not a meaningful
  department, so this is by-design rather than a live bug — but it is an asymmetry worth a
  one-line note if a future host ever treats `''` as a real sentinel.

### 3.4 `SAFE_ALIAS_PATTERN` duplicated across two files

- **Files:** `shared/columnValidation.ts:203`, `security/validateQueryPlan.ts:192`.
- **Description:** The identical safe-identifier regex is defined twice. Both comments
  acknowledge this is intentional (avoiding a cross-file import to keep each validator
  self-contained), so it is listed only for completeness. Risk if the charset is ever
  tightened in one place but not the other.

### 3.5 Dead `default` arm in the mutation dispatch switch

- **File:** `mutations/handleMutation.ts:134-135`.
- **Description:** `descriptor.operation` is validated against `['insert','update','delete']`
  before the `switch`, so the `default: rowsAffected = 0` arm is unreachable. Harmless
  defensive code; noted only as dead code (mirrors the acknowledged unreachable `default`
  in `shared/predicates.ts:324`).

---

## Areas explicitly verified as sound (no action)

- **Alias-resolution parity:** `resolveAlias` is the single resolution point;
  `validateQueryPlan` produces branded `ColumnRef`s and `buildSecureQuery`/`executeForTier`
  read them off the plan without re-resolving. Filter vs. join vs. projection references to
  the same logical column are structurally guaranteed to resolve identically.
- **`SELECT *` allowlist-bypass closure:** `synthesizeProjectionFromAllowlist` rejects a
  no-entry table fail-closed, emits `<table>.*` (not bare `*`) for `['*']`, and otherwise
  projects exactly the allowlisted columns; aggregation widgets are correctly exempt.
- **`join.on` validation:** left side checked against the primary table, right side against
  the joined table — matches the execution-time resolution.
- **HAVING:** own-property `opMap` guard blocks inherited-member operator names
  (`toString`, `constructor`, …); alias must match a declared aggregation.
- **Cache index integrity (LRU):** prefix + forward-tag + reverse-tag indexes are kept in
  sync via `dispose`; `deleteByTag`/`invalidatePrefix` snapshot before iterating;
  delete-during-`keys()`-iteration is safe in the installed `lru-cache` (verified). The
  3rd-colon prefix scan is exact because the tenant segment is URL-encoded.
- **Redis providers:** forward-tag-index expiry is extend-only (`extendTagIndexExpiry`);
  reverse index mirrors the data key's TTL; `SCAN` (never `KEYS`) is used; ioredis vs
  node-redis wire shapes are normalized in the shared `redisCompat.ts`; missing set-command
  support warns once rather than silently no-op'ing invalidation.
- **Digest / cache-key determinism:** both funnel through the single `sortedStringify`;
  `columnAllowlist` is column-sorted before hashing and only present in the digest input
  when supplied (byte-compatible with an omitted allowlist).
- **Tier cache not invalidated on mutation** is acceptable: it stores only routing
  decisions, the data cache _is_ invalidated by `deleteByTag`, and all security predicates
  are re-applied at execution regardless of the cached tier.
