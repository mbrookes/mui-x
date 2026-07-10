# Architecture Review — `@mui/x-studio-data-middleware` (eighth review)

**Summary: 0 Tier 1, 0 Tier 2, 3 Tier 3.**

This is a from-scratch review of the current `src/` tree, cross-referenced against
`ARCHITECTURE.md`, with no carry-over assumptions from the seven prior rounds. The
security core held up again: I could not construct a reachable SQL-injection,
cross-tenant-leak, cache-key-collision, or scope-bypass scenario through the real
public API surface (`handleBatchQuery` / `handleMutation` / `generateCacheKey` /
`extractSecurityClaims`).

Verification highlights (things I checked and found correct, so they are **not**
findings):

- **Cache-key completeness.** Every input that affects a query's rows is folded
  into the key: `tenantId`/`regionIds`/`department` (HMAC'd `securityHash`),
  `tenancy`+`securityColumns`+`columnAllowlist` (via `policy.digest` → `securityHash`),
  and the full descriptor minus `id` (`queryHash`). Inputs that legitimately do
  **not** affect rows are correctly omitted: `roleIds` (never used in query
  building — confirmed by grep), `schemaAllowlist` (only gates allow/reject, never
  changes rows for an allowed table), `writableColumns` (write path only), and
  `thresholds` (for non-aggregation queries all three tiers emit the identical
  `select/orderBy/limit`; aggregation queries are never cached — so tier choice
  cannot change cached rows, and `thresholds` is deliberately re-derived at read
  time rather than keyed).
- **SQL construction.** Every value is `?`-bound; every identifier reaches Knex via
  `??`, the object/alias-map aggregate form, `andOnVal`/`andOnIn`, or a Knex
  identifier-quoting builder method. The only interpolated-before-Knex strings are
  `` `${table}.${col}` `` qualification strings, which Knex still escapes as
  identifiers, and the four client-controlled free tokens (`agg.alias`,
  `outputAlias`, `orderBy.direction`, HAVING `operator`) are each fail-closed
  allowlisted before use.
- **Prototype-chain gating** is now uniform across every client-keyed plain-object
  lookup (`resolveAlias`, `checkColumnAgainstAllowlist`,
  `synthesizeProjectionFromAllowlist`, `lookupPerTableOverride`, `applyHaving`'s
  `opMap`, `validateSecurityColumnValues`'s `hasOwnProperty` guards).
- **Fail-closed tenancy/dimension validation** in `compileSecurityPolicy` and the
  `single-tenant`+`perTable.tenant` contradiction throw behave as documented.

The three Tier 3 items below are consistency/robustness refinements with no
data-correctness or security impact reachable through the public API.

---

## Tier 3

### 3.1 — Data-cache hit echoes a stale `tier` verbatim instead of re-deriving it from `cached.rowCount`

**Tier:** 3
**File:** `src/handler.ts:170` (the `tier: cached.tier ?? 'server'` echo on a data-cache hit).

**Invariant being violated (general):** _A cached tier decision must be
reinterpreted under the reader's current `thresholds`, never trusted verbatim,
because `thresholds` is folded into neither the cache key nor the policy digest._
This is exactly the invariant the seventh review's finding 2.4 established.

**Sibling-site sweep.** There are exactly two sites in the package that read a
persisted tier off a cache entry and turn it into a reported/returned tier:

- `src/router/tierDecision.ts:116-117` — the **tier-cache** hit path. This site
  correctly re-derives: `const tier = tierFromRowCount(cached.rowCount, thresholds)`
  (finding 2.4).
- `src/handler.ts:170` — the **data-cache** hit path. This site trusts
  `cached.tier` verbatim, even though the same entry persists `cached.rowCount`
  (line 176) and `resolvedThresholds` is available a few lines later
  (lines 182-185). This is the one-sibling-fixed-not-the-other gap.

**Concrete scenario.** Node runs `thresholds = { client: 10_000, server: 100_000 }`.
A non-aggregation widget with a preflight `rowCount` of 50 000 executes at tier
`server`, and the raw rows are cached with `{ tier: 'server', rowCount: 50000 }`.
Ops widens `clientTier` to 60 000 (config rollout / different cluster node).
Within the data-cache TTL (default 30 s) a repeat request hits the data cache and
reports `tier: 'server'`, whereas the deployment now classifies 50 000 rows as
`client`.

**Why this is only Tier 3 (not 2).** Impact is limited to the advisory `tier`
enum in the response. Cached entries always hold **raw** rows (aggregation results
are never cached), so the rows returned are identical regardless of the tier
label; no data-correctness or security effect, and it self-heals within the
≤30 s data-cache TTL. It does not change which query executes (unlike the tier
cache, where a stale tier would have driven the actual execution — the reason 2.4
mattered more). Still worth folding in for consistency with the accepted 2.4
invariant.

**Fix direction.** Compute `resolvedThresholds` before the data-cache-hit block
and return `tier: tierFromRowCount(cached.rowCount ?? cached.rows.length, resolvedThresholds)`
(with the same `'server'`/`rows.length` fallbacks for pre-field entries), mirroring
`tierDecision.ts`. `tierFromRowCount` would need to be exported (it is currently
module-private to `tierDecision.ts`), or a small shared helper introduced.

---

### 3.2 — `LRUCacheProvider` silently drops oversized entries; behavior diverges from the other providers

**Tier:** 3
**File:** `src/cache/LRUCacheProvider.ts:66-81` (`maxSize` / `sizeCalculation`, no explicit `maxEntrySize`).

**Invariant being violated (general):** _The four shipped cache providers should
agree on the observable outcome of a `set()`, so a host can swap providers (the
package's stated design goal, e.g. `ttl: 0` flooring parity) without a silent
behavior change._

**Mechanism.** `lru-cache` v11 defaults `maxEntrySize` to `maxSize` when only
`maxSize` is given, and in `set()` it **silently no-ops** (does not store, does not
throw) any entry whose computed size exceeds `maxEntrySize`
(`node_modules/lru-cache/.../index.js` ~line 911). Here `maxSize` defaults to
128 MB and `sizeCalculation = rows.length * 512 + 64`, so any result exceeding
~262 000 rows is silently not cached. This interacts with the seventh review's
finding 3.2, which newly caches non-aggregation `db`-tier results — precisely the
results most likely to be large (they reach `db` only because their preflight
`COUNT(*)` exceeded `serverMemoryTier`, default 100 000).

**Sibling-site sweep.** Only `LRUCacheProvider` has a byte-size bound.
`RedisCacheProvider` has no size bound (TTL only), so it _would_ cache the same
large entry; `MapTierCacheProvider` bounds by entry **count** (`max`), not size,
and stores only tiny `TierEntry` objects. So the divergence is: an oversized
result caches under Redis but not under the in-process LRU, with no signal either
way.

**Why Tier 3.** This is degradation, not incorrectness — the oversized result is
still fetched and returned; it just re-queries on every request. The `set()` call
is already wrapped in `try/catch` in `handler.ts`, but `lru-cache` doesn't throw
here, so the catch never fires and nothing is logged.

**Fix direction.** Either document the ceiling explicitly, or set
`maxEntrySize: maxSizeBytes` (making the drop intentional and consistent) and/or
log when `sizeCalculation` exceeds it. At minimum, note in `ARCHITECTURE.md` that
`LRUCacheProvider` will not cache a single result larger than `maxSizeBytes`,
unlike the Redis provider.

---

### 3.3 — Region/department in-`values` scope validation is not duplicated into `buildUpdateMutation` as defense-in-depth (only tenant is)

**Tier:** 3
**File:** `src/mutations/mutationBuilder.ts:342-372` (`buildUpdateMutation`).

**Invariant being violated (general):** _Each mutation builder re-applies its
security invariants independently, so a direct caller that skips `validateMutation`
still cannot violate them (the package's stated "defense-in-depth in the builders"
posture)._

**Observation.** The builders already re-run several checks defensively even
though `handleMutation` always calls `validateMutation` first:
`rejectQualifiedValueKeys` (insert + update), the tenant force-stamp (insert), the
tenant strip (update), `applySecurityPredicates` WHERE scoping (update + delete),
and — for insert — `resolveInsertScopeStamps` (`buildInsertMutation:326`). The one
value-scope check that is **not** re-run in the builder is
`validateSecurityColumnValues`'s region/department-in-`values` check for UPDATE.
`buildUpdateMutation` strips the tenant column from `values` but does not reject an
out-of-scope `region_id`/`department` in `values`; that rejection lives only in
`validateMutation` (`validateSecurityColumnValues`, line 274).

**Sibling-site sweep.** Of the three builders: `buildInsertMutation` re-validates
region/department scope (via `resolveInsertScopeStamps`); `buildDeleteMutation` has
no `values`, so region/department-in-`values` is N/A; `buildUpdateMutation` is the
sole builder that carries `values` but does not re-check their region/department
scope. So this is a single-site asymmetry, not a widespread pattern.

**Reachability.** **Not reachable through the public API** —
`handleMutation → processMutation` always runs `validateMutation` before
`buildUpdateMutation` (`handleMutation.ts:117`), and the WHERE-clause security
predicate (which _is_ in the builder) already constrains _which_ rows an UPDATE can
touch to the caller's own region/department. The gap is only that a direct
(unit-test) caller of `buildUpdateMutation` could set those rows' region/department
column to an out-of-scope value. This is why it is Tier 3 (defense-in-depth
asymmetry), not a live security finding.

**Fix direction.** For symmetry with `buildInsertMutation`'s defensive
`resolveInsertScopeStamps` call, have `buildUpdateMutation` also call
`validateSecurityColumnValues(values, claims, cols)` before `query.update(values)`
(after the tenant strip), so the builder cannot re-tenant _or_ re-region/department
a row regardless of whether validation ran.

---

## Notes on areas explicitly examined and cleared

- **Outer-join security-predicate placement** (`queryBuilder.ts`) — the WHERE/ON
  split is correct for `left`/`right`/`inner`. For the exotic multi-`right`-join
  case the primary predicate is repeated into each right join's ON clause; this is
  idempotent (`A.tenant = X` AND-ed with itself) and not a leak.
- **Region string+number matching** (`predicates.ts:299`,
  `emitSecurityPredicates`) — `flatMap(id => [id, String(id)])` cannot over-match
  to an unauthorized region (`5`/`'5'` only), and `[].flatMap` stays `[]`, so the
  empty-scope `1 = 0` behavior is preserved.
- **`sortedStringify` / policy digest / cache hashes** all funnel through one
  serializer; array order significant, `undefined`≠`null` — consistent between the
  digest and both hashes.
- **`extractPrefix` colon boundary** is exact because `generateCacheKey`
  `encodeURIComponent`s the tenant segment; hashes are hex (colon-free).
- **`RedisCacheProvider` tag indexes** (`__tag__:` forward / `__ktag__:` reverse)
  are prefix-namespaced and the forward-index expiry is extend-only — no premature
  `deleteByTag` breakage.
