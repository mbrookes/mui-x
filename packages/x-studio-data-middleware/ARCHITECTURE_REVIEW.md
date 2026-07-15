# x-studio-data-middleware — Clean-slate Architecture & Correctness Review

**Tier1: 0 / Tier2: 1 / Tier3: 3**

Reviewer pass: read the current source top-to-bottom (handler, security/, router/, shared/,
cache/, mutations/). This is a genuinely mature, defense-in-depth package; the security-critical
paths (allowlist enforcement, tenant scoping, identifier construction, cache-key scoping) are
sound. Findings below are honest and one Tier-2 is a documented-intentional inconsistency worth a
maintainer decision, not a live exploit.

---

## Tier 1 — security / data-loss / correctness

**None.** The following were audited adversarially and found sound:

- **Table allowlist (Zero-Knowledge Rule).** `assertTablesAllowed` (shared/assertTablesAllowed.ts)
  exact-matches every primary + joined table before any query builds; table names reach Knex only
  as escaped identifiers. Qualified column references to non-declared tables are either
  allowlist-rejected (`checkColumnAgainstAllowlist` fail-closed on a table with no entry) or become
  a plain SQL error (no implicit join), never a leak.
- **Identifier construction / SQL injection.** Every client-controlled identifier token is either
  Knex `??`-bound or charset-restricted: aggregation aliases and expression-field output aliases
  (`SAFE_ALIAS_PATTERN`, columnValidation.ts:236 / validateQueryPlan.ts:209), ORDER BY direction
  (`SAFE_ORDER_BY_DIRECTION`, validateQueryPlan.ts:175), filter operators (`SAFE_OPERATORS`),
  HAVING operators + aggregate funcs (own-property-gated `opMap`/`HAVING_FUNC_MAP`,
  queryBuilder.ts:251/270), and the SELECT-side agg func (exhaustive `switch` with a fail-closed
  `default throw`, execute.ts:167-178). `havingRaw` re-emits `FUNC(??) op ?` with only fixed-map
  tokens interpolated.
- **Alias-resolution drift.** `resolveAlias` is the single resolution site, own-property-gated
  against prototype-pollution keys (columnValidation.ts:50). `ValidatedQueryPlan` structurally
  removes `columnAliases` and raw logical names past the validation boundary, so validation and
  execution provably agree on the physical column. The branded `ColumnRef` prevents an unresolved
  string from reaching an enforcement site.
- **SELECT \* allowlist bypass.** `synthesizeProjectionFromAllowlist` (validateQueryPlan.ts:248)
  correctly fail-closes: a no-columns/no-aggregations widget under a `columnAllowlist` gets an
  explicit projection (or a throw for a table with no entry), and `['*']` is scoped to
  `<primaryTable>.*` so a joined table's stricter allowlist can't be bypassed by a bare `SELECT *`.
- **Cross-tenant cache scoping.** `generateCacheKey` folds `policy.digest` (which hashes tenancy +
  securityColumns + columnAllowlist, compileSecurityPolicy.ts:105) and the caller's claims into the
  HMAC security hash; the tenant id is URL-encoded so a colon in the id can't shift segment
  boundaries. The key uniquely determines the row set (descriptor→queryHash, claims+policy→
  securityHash); no unhashed input changes the returned rows. `schemaAllowlist`/`thresholds` are
  correctly excluded (they don't change an allowed query's rows). Data/tier planes are namespaced
  (`TIER_CACHE_KEY_PREFIX`) so a shared Redis client can't cross-clobber.
- **Row-level security placement.** Tenant/region/department predicates are applied first and
  cannot be AND-ed away; outer-join nullable-side scoping is correctly moved into the JOIN `ON`
  clause (predicates.ts:240) to avoid silently degrading LEFT/RIGHT joins to INNER while still
  tenant-checking matched rows; joined tables are fail-closed (inherit primary scope unless an
  explicit `perTable[t] = null`). Empty-vs-undefined region (`[]` → `1=0`, not dropped) and
  empty-string department (`!== undefined`) fail-closed distinctions are correct on both read and
  write paths.
- **Mutation path.** Tenant force-stamped and stripped from client values; qualified value keys
  rejected; region/department in-scope enforcement including the INSERT-omission gap
  (`resolveInsertScopeStamps`); UPDATE/DELETE require a WHERE; empty-`in` throws on writes.

---

## Tier 2 — robustness / consistency

### 2.1 Per-widget error isolation does not cover the pre-`Promise.all` validation stage

**Files:** `src/handler.ts:81` (`assertTablesAllowed`) and `src/handler.ts:99-101`
(`validateQueryPlan` map), which throw synchronously **before** the `Promise.all` at
handler.ts:103; the throwing validators live in `security/validateQueryPlan.ts:371-391` and
`shared/columnValidation.ts`.

**What's wrong.** The stated invariant is: _a single widget's failure must produce that widget's
`{ error }` result, not reject the whole batch's `Promise.all`._ `processWidget`'s try/catch
(handler.ts:138-258) upholds this for cache/preflight/execute failures. But two whole classes of
**client-input** error are evaluated for every widget _before_ the `Promise.all` and therefore
reject the entire batch:

- `assertTablesAllowed` — one widget naming a non-allowlisted table fails the whole page.
- `validateQueryPlan` — one widget with an invalid HAVING alias, an unsafe aggregation/output
  alias, a non-`asc/desc` ORDER BY direction, or a column-allowlist violation fails the whole page.

This produces an inconsistency where two client-input validation errors of similar nature get
opposite treatment: an **unsupported filter operator** (predicates.ts:338) or an **unsupported
aggregation func** (execute.ts:173) throws _inside_ `executeForTier` and is isolated to the one
widget, while an **invalid ORDER BY direction** or **HAVING alias** on a sibling widget throws in
`validateQueryPlan` and takes down every widget on the page — including well-formed ones from the
same tenant.

**Why it matters.** A dashboard page batches many widgets. A single malformed (or maliciously
crafted) widget descriptor breaks the entire page's data load rather than degrading to that one
widget showing an error. For a multi-tenant analytics surface this is a self-inflicted
availability footgun and a visible violation of the isolation contract.

**Note on intent.** The handler comment (handler.ts:96-98) says this is deliberate: "Compiled
synchronously (before `Promise.all`) so a validation error still rejects the whole batch, exactly
as the previous validation loops did." So this is a _known_ divergence carried over from the
pre-refactor loops. It is surfaced here because it contradicts the isolation invariant as written
and treats otherwise-identical client-input errors inconsistently — a maintainer should confirm
whether whole-batch rejection is truly desired.

**Fix direction.** If per-widget isolation is the intended contract, move the per-widget
`assertTablesAllowed(w.table + joins)` and `validateQueryPlan(descriptor)` calls _inside_
`processWidget`'s try block (compute `plans[index]` lazily there), so a validation throw becomes
that widget's `{ error }` result. Keep them synchronous-per-widget but caught. If whole-batch
rejection is intended, make it uniform: reject the batch for unsupported-operator/func too, and
update the invariant wording. Either way, remove the inconsistency.

---

## Tier 3 — minor / doc / comment drift

### 3.1 `invalidatePrefix` is glob-injectable via Redis metacharacters in the tenant id

**Files:** `src/cache/RedisCacheProvider.ts:216-218` (`pattern = \`${this.prefix}${prefix}\*\``,
fed to `SCAN MATCH`); tenant encoding at `src/security/cacheKey.ts:123`.

`generateCacheKey` URL-encodes the tenant segment, which fixes the _colon_ boundary problem — but
`encodeURIComponent` leaves Redis glob metacharacters `*`, `?`, and (via its allowed set) does not
neutralize `[` for SCAN semantics (`[` is percent-encoded, but `*`/`?` are not). A `tenantId`
containing `*` (e.g. `ac*e`) yields a prefix that, when a host passes it to `invalidatePrefix`,
becomes a `SCAN MATCH studio:v1:ac*e:*` glob that also matches unrelated tenants
(`studio:v1:acXXXe:...`). Impact is **over-eviction** (extra DB load), not a cross-tenant data
read, and it only triggers on host-initiated `invalidatePrefix` with an exotic tenant id — hence
Tier 3. Fix: escape glob metacharacters (`*?[]^\`) when building the SCAN pattern, or document
that tenant ids must be glob-safe (the extractPrefix doc at LRUCacheProvider.ts:184 only calls out
the colon issue, not glob chars).

### 3.2 Tier cache is not invalidated on mutation → stale reported `rowCount` for ≤ tier TTL

**Files:** `src/mutations/handleMutation.ts:170` (`deleteByTag` targets only the data cache);
tier cache written at `src/router/tierDecision.ts:130`, read into the response `rowCount` at
`src/handler.ts:199`.

A mutation invalidates the _data_ cache by tag but not the _tier_ cache. For a non-aggregation
widget served from a tier-cache hit, the response `rowCount` (the preflight `COUNT(*)`) can be
stale by up to the tier TTL (default 30s) after an insert/delete changes the row total. The
returned **rows** are always fresh (they re-run through `executeForTier`), so this is a
cosmetic/total-count staleness only, TTL-bounded and arguably acceptable — but it is an
undocumented asymmetry with the data-cache invalidation. Consider tagging tier entries and
evicting them on mutation, or documenting that `rowCount` is best-effort within the tier TTL.

### 3.3 `MapTierCacheProvider` default TTL comment vs `RedisTierCacheProvider` — verify parity note

**File:** `src/cache/MapTierCacheProvider.ts:29-42`. The docblock reconciling the "three 5-minute
defaults" is accurate for the code as written (handler always passes 30s explicitly). This is
purely a documentation-hygiene note: the three files now agree, but the standalone-usage default
(300s) differing from the handler default (30s) is a latent surprise for anyone using
`MapTierCacheProvider`/`RedisTierCacheProvider` outside `handleBatchQuery`. No code change needed;
flagged only so the divergence stays intentional.

---

## Verified-sound areas (explicitly checked, no finding)

- `sortedStringify` canonicalization — JSON-typed serialization makes cross-descriptor hash
  collisions within a tenant practically impossible; array-order significance and `undefined`
  handling are load-bearing and documented.
- `extractSecurityClaims` — always computes HS256 and length-checks before `timingSafeEqual`, so
  the classic `alg:none`/algorithm-confusion attack is not exploitable (the header `alg` is
  ignored); `regionIds` is runtime-validated to `number[]`.
- Prototype-pollution gates (`hasOwnProperty`) are present at every client-keyed lookup:
  `resolveAlias`, `checkColumnAgainstAllowlist`, `synthesizeProjectionFromAllowlist`,
  `lookupPerTableOverride`, `applyHaving` opMap/func map, `validateSecurityColumnValues`.
- Cache read/write error isolation (best-effort in front of the authoritative DB) is correct on
  all three planes (data get/set, tier get/set) and in post-mutation invalidation — failures
  degrade with a `console.warn`, never fail the widget/mutation.
- The `tier !== 'db' || !hasAggregations` cache-population gate is correct: non-aggregation db-tier
  raw slices are cached; aggregation results are not; agg vs non-agg descriptors never share a
  cache key (the `aggregations` field is in the query hash).
- HAVING portability fix (re-emitting `SUM(col) > ?` rather than the SELECT alias) is correct for
  Postgres/MySQL/SQLite.
- `limit: 0` handled via `!== undefined` (not truthiness) across all tier branches.
