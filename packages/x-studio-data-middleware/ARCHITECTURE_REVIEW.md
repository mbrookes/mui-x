# Architecture Review — `@mui/x-studio-data-middleware`

**Iteration 12 · ninth review in the streak** (eight consecutive prior reviews closed with no Tier 1 / Tier 2 findings).

Summary: 0 Tier 1, 0 Tier 2, 1 Tier 3.

This was a fresh, clean-slate read of the whole package (`handler.ts`, `mutations/*`, `router/*`,
`security/*`, `shared/*`, `cache/*`) cross-referenced against `ARCHITECTURE.md`. I deliberately
tried to construct a reachable SQL-injection, cross-tenant/region/department leak, cache-key
collision, or scope bypass through the real public API (`handleBatchQuery` / `handleMutation` /
`generateCacheKey` / `extractSecurityClaims`). **I could not construct any of them.** The security
core remains genuinely strong; the single finding below is a cosmetic stale-comment refinement with
no behavioral impact.

---

## Verification highlights (attack scenarios tried and found correctly defended)

These are the concrete break attempts I made against the public API. Each is defended — the fix
round can trust them without re-deriving.

### SQL injection

- **Every raw-SQL interpolation site is identifier/value-bound.** The only `db.raw`/`havingRaw`
  calls are `execute.ts` `db.raw('?? as ??', [qualify(col.physical), col.outputAlias])` and
  `queryBuilder.ts` `query.havingRaw('${func}(??) ${op} ?', [physical, h.value])`. In both, the
  column is `??`-bound and the value `?`-bound; `func` comes from the own-property-gated
  `HAVING_FUNC_MAP`, `op` from the own-property-gated `opMap`. No client string ever reaches raw SQL
  text.
- **Client identifier tokens are charset-gated before interpolation.** `agg.alias`
  (`validateAggregationAliases`), expression-field `outputAlias` (`validateOutputAliases`), and
  `orderBy[].direction` (`validateOrderByDirections`) all run **unconditionally** in
  `validateQueryPlan` — independent of whether a `columnAllowlist` is configured — against
  `SAFE_ALIAS_PATTERN` / `SAFE_ORDER_BY_DIRECTION`. Filter operators are gated by `SAFE_OPERATORS`;
  HAVING operators by an own-property `opMap` check.
- **Table-qualification concatenation (`${table}.${col}`)** in `queryBuilder`/`execute` feeds Knex
  identifier positions (`.where`, `.orderBy`, `.select`, `.groupBy`, `.on`), which Knex escapes — no
  raw string concatenation into SQL.
- **Prototype-chain lookups:** every client-keyed plain-object lookup is
  `Object.prototype.hasOwnProperty.call`-gated — `resolveAlias`'s `aliases[column]`,
  `checkColumnAgainstAllowlist`'s `allowlist[table]`, `synthesizeProjectionFromAllowlist`'s
  `columnAllowlist[table]`, `lookupPerTableOverride`'s `perTable[table]`, `applyHaving`'s
  `opMap[operator]` / `HAVING_FUNC_MAP[func]`, and `validateSecurityColumnValues`'s
  `hasOwnProperty(values, cols.*)`. A `"constructor"`/`"__proto__"`/`"toString"`-named table,
  column, or operator resolves to "no entry" / literal string / throw — never a truthy inherited
  member. `compileSecurityPolicy`'s `Object.keys(perTable)` / `Object.keys(columnAllowlist)`
  iterations touch own enumerable keys only.

### Cross-tenant / region / department leak

- **Fail-closed tenancy is enforced at runtime, not just in types.** `compileSecurityPolicy` throws
  when `multi-tenant` + `tenantColumn` is empty/whitespace/non-string, and when any per-table
  dimension override or top-level `region`/`department` is an empty/whitespace/non-string value
  (`isUsableColumnName`/`assertOptionalColumnName`). `undefined` (inherit) and `null` (documented
  drop) stay valid. The `single-tenant` + `perTable[t].tenant` contradiction throws.
- **Joined tables are scoped by default (fail-closed).** `resolveJoinSecurityColumns` inherits the
  primary table's resolved tenant/region/department columns for any join with no `perTable` entry;
  only an explicit `perTable[t] = null` opts a table fully out. A non-unique join key (e.g.
  `region_id`) cannot fan out to other tenants.
- **Outer-join placement is correct.** The nullable side's predicate goes into the JOIN `ON` clause
  (`applySecurityPredicatesToJoinOn` via `andOnVal`/`andOnIn`), not `WHERE` — so a LEFT/RIGHT JOIN
  isn't silently degraded to INNER while every _matched_ joined row stays tenant-checked. Verified
  the multi-join case: `hasRightJoin` skips the primary's `WHERE` predicate but every `right` join
  re-emits the primary predicate in its own `ON`, so the primary is always scoped somewhere.
- **Empty-scope semantics fail closed.** `regionIds === undefined` (not region-scoped) is
  distinguished from `regionIds === []` (zero regions): reads emit `whereIn(col, [])` → `1 = 0`
  (matches nothing, not dropped); writes throw. `department === ''` is a defined scope (`!== undefined`
  gate), not "unscoped."
- **Mutations cannot escalate scope.** Tenant is force-stamped on INSERT and stripped from UPDATE
  `values`; `validateSecurityColumnValues` rejects a client-supplied tenant column and any
  region/department value outside the caller's claims (with fail-closed non-scalar region rejection
  and string-normalized comparison); `resolveInsertScopeStamps` fails closed when a
  region/department-restricted caller omits the column. Qualified `values` keys are rejected both in
  `validateMutation` and again (defense-in-depth) in the builders.
- **Region numeric/TEXT reconciliation is restrictive-only.** `flatMap((id) => [id, String(id)])`
  adds the string form of the _same_ permitted region ids; it can only match rows already inside the
  caller's region set, never a different region.

### Cache-key collision / wrong-rows

- **Every input that affects returned rows is folded into the key.** `generateCacheKey` =
  `studio:v1:<encodeURIComponent(tenantId)>:<HMAC(tenantId, sorted regionIds, department,
policyDigest)>:<SHA256(descriptor − id)>`. The `policyDigest` folds `tenancy` + `securityColumns`
  - `columnAllowlist` (the last drives `synthesizeProjectionFromAllowlist`, which changes the
    projected columns), so a differently-scoped node never serves another's rows. I confirmed no
    row-affecting input is omitted: `roleIds`/`userId` don't affect row scoping; `thresholds` is
    deliberately excluded but only selects a tier, and (a) aggregation queries bypass the tier cache
    entirely, (b) for non-aggregation queries all three tiers return the same raw filtered rows, and
    the tier is re-derived from `cached.rowCount` under the _reader's_ current thresholds in
    `decideTierWithCache`, so a stale `cached.tier` can never mislabel or misroute.
- **Tenant-segment encoding keeps prefix invalidation exact.** `encodeURIComponent(tenantId)` keeps
  the tenant a colon-free segment so `LRUCacheProvider.extractPrefix`'s 3rd-colon scan can't be
  shifted by a `tenantId` containing `:`. (The HMAC already covers `tenantId` verbatim, so this was
  never a cross-tenant read risk regardless.)
- **Data plane vs. tier plane never collide.** `handler.ts` prefixes the tier-plane key with
  `TIER_CACHE_KEY_PREFIX` (`'tier:'`) before calling `decideTierWithCache`, so on a shared Redis
  client the two planes cannot overwrite each other.
- **`sortedStringify` is the single canonical serializer** feeding both the cache-key hashes and the
  policy digest, so the two can't canonicalize identical inputs differently.

### Scope bypass

- **The `ValidatedQueryPlan` boundary makes the ambiguous logical form structurally unreachable.**
  `resolveAlias` runs once in `buildPlan`; the plan carries only branded `ColumnRef`s and no
  `columnAliases` map. `buildSecureQuery`/`executeForTier` read pre-resolved refs and never call
  `resolveAlias`, so validation and execution cannot resolve a reference differently. An alias can
  only relabel a column the caller could already reach (allowlist checks whatever physical column
  comes out).
- **`SELECT *` allowlist bypass is closed.** A no-columns/no-aggregations widget under a
  `columnAllowlist` gets an explicit projection synthesized (or is rejected fail-closed for a table
  with no entry); a `['*']` entry becomes `<table>.*`, never a bare `*` that would leak joined-table
  columns.
- **`join.on` both sides are allowlist-checked** against the correct table (left→primary,
  right→joined), matching execution-time qualification.
- **Cache/DB failure isolation is fail-safe, not fail-open.** Every cache `get`/`set`/`deleteByTag`
  and tier-cache `get`/`set` is wrapped so a backend failure degrades to a DB read / logged warning,
  never to serving unscoped or stale-scope rows. The authoritative DB read always applies the full
  security predicate set.

### Direct-call-only surface (not reachable through the public API — noted, not a finding)

- `buildSecureQuery` / `executeForTier` / `runPreflight` accept a raw descriptor and, via
  `toValidatedQueryPlan`, resolve a plan **without** re-running the validators (including the
  ORDER-BY-direction charset check; direction is instead `String(...).toLowerCase()`-normalized).
  These functions are **not exported** from `src/index.ts` — the only callers are unit tests. Through
  `handleBatchQuery`, `validateQueryPlan` always runs the full validator set before any plan reaches
  these functions, so the public API is fully guarded. This is documented as deliberate
  behavior-preservation for direct test callers; reporting it would be manufacturing a finding.

---

## Findings

### Tier 3 — stale summary comment in `handler.ts` file docblock

- **File:** `packages/x-studio-data-middleware/src/handler.ts:12`
- **Invariant:** documentation accuracy (stale-comment category); no behavioral impact.
- **Detail:** The top-of-file summary docblock lists step `d. Populates the cache for server/client
tiers`. Since the finding-3.2 change, the actual cache-write gate is
  `if (tier !== 'db' || !hasAggregations)` (`handler.ts:225`) — it caches server/client tiers **and**
  non-aggregation `'db'`-tier results (a large-but-plain raw-row slice), leaving only true
  aggregation push-downs uncached. The detailed inline comment at `handler.ts:209–224` already
  describes this accurately; only the one-line file-header summary was not updated alongside it, so
  it now under-describes what is cached.
- **Reachability:** none — this is a comment, not code. Listed purely as a consistency refinement.
- **Sibling-site sweep:** I checked the other summary/step docblocks that describe cache-write
  behavior. `router/execute.ts:31–37` (the `executeForTier` docblock) and the ARCHITECTURE.md
  read-path step 5 both already state the corrected "non-aggregation db-tier results ARE cached"
  behavior. `mutations/handleMutation.ts`'s docblock describes invalidation, not population, and is
  accurate. So the single `handler.ts:12` line is the lone remaining stale summary; there is no
  broader pattern of drift.
- **Fix direction:** reword `handler.ts:12` to e.g. `d. Populates the cache for client/server tiers
and non-aggregation db-tier results` (or "for every result except aggregation push-downs"), so the
  header summary matches the inline comment and the `tier !== 'db' || !hasAggregations` gate.

---

## Conclusion

The package's security core — parameterized values, allowlisted/Knex-quoted identifiers,
fail-closed tenancy, complete cache keys, prototype-chain-guarded lookups — holds under adversarial
reading. I found **no reachable** SQL-injection, cross-tenant/region/department leak, cache-key
collision, or scope bypass through the public API. The only issue is one cosmetic stale summary
comment (Tier 3). This is a clean review consistent with the eight-review streak.
