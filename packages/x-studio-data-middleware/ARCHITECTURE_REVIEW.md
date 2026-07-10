# Architecture review — `@mui/x-studio-data-middleware` (iteration 9)

Fresh, ground-up review of every file under `packages/x-studio-data-middleware/src/`,
re-derived from the current working tree rather than carried over from prior rounds.
Emphasis, per the review charter, on the security invariants: the Zero-Knowledge
Rule (`schemaAllowlist` / `columnAllowlist` / `writableColumns`), row-level security
(tenancy / region / department), and the now-"complete" column-qualification
convention.

**Result: 0 Tier 1 findings, 1 Tier 2 finding.**

The Tier 2 finding is the same _shape_ as the fourth review's finding 2.1 (unqualified
filter columns) and the fifth review's finding 2.2 (unqualified renamed projection
columns): it is a fail-closed correctness gap under joins, **not** a security bypass —
no tenant/row-scope boundary is crossed and no allowlist is evaded. It is the one
remaining read-path column reference that reaches raw SQL without qualification, which
the last two rounds' qualification sweep did not reach.

---

## Tier 2

### 2.1 — Join `ON`-pair columns are the last unqualified read-path column reference; an unqualified `on` column shared across both joined tables renders ambiguous SQL that Postgres/MySQL reject

**Where:** `src/router/queryBuilder.ts:113-115`

```js
query[joinMethod](join.table, function joinOn(this: any) {
  for (const [left, right] of join.on) {
    this.on(left, '=', right);   // <-- left/right emitted verbatim, never qualify()'d
  }
  ...
});
```

The join `ON`-pair columns (`ResolvedJoin.on`, built in
`security/validateQueryPlan.ts:308` via `resolve(left)`/`resolve(right)`) are
alias-resolved but **not table-qualified**. `buildSecureQuery` hands them straight to
Knex's `.on(left, '=', right)`. Every _other_ read-path column reference is now
qualified before it reaches raw SQL:

- SELECT / GROUP BY / ORDER BY / aggregation columns — `execute.ts`'s `qualify()`
- all three security-predicate dimensions — `emitSecurityPredicates` (`${table}.${col}`)
- user filter columns — `buildSecureQuery`'s qualify-if-no-dot pass (finding 2.1, iter7)
- renamed projection source columns — `projectColumn`'s `qualify(col.physical)` (finding 2.2, iter8)

The join `on` pair is the sole remaining exception.

**Why it's reachable (not merely theoretical):** `JoinDescriptor.on` is typed
`[string, string][]`, and the package _deliberately accepts unqualified join columns
as valid input_ — `validateDescriptorColumns` (`shared/columnValidation.ts:167-189`)
explicitly validates the left side against the primary table and the right side against
`join.table`, and `handler.test.ts:384` pins an **unqualified right-side `id`** as a
legitimate, allowlist-checked reference. So a valid, allowlist-passing descriptor can
carry unqualified `on` columns.

**Failure scenario:** an unqualified `on` column whose name exists on _both_ the
primary and the joined table renders an ambiguous identifier. Verified against real
Knex (pg dialect):

```
on: [['region_id', 'region_id']]   ->  ... on "region_id" = "region_id" ...
on: [['customer_id', 'id']]        ->  ... on "customer_id" = "id" ...   (if "id" exists on both)
```

Postgres rejects both with `42702 column reference "..." is ambiguous`; MySQL with
`ER_NON_UNIQ_ERROR`. In a multi-tenant schema this is common, not exotic: joined
tables routinely share `id`, `tenant_id`, `region_id`, `created_at`, `status`, so an
unqualified `on` reference to any of them is ambiguous. The widget then returns a
per-widget `error` result (fail-closed) rather than data.

Why every prior round missed it: the in-memory `mockDb` fake is not a SQL engine and
never resolves column ambiguity, and every join test fixture uses fully-qualified
`on` pairs (`'sales.customer_id', 'customers.id'`) — so the unqualified-shared-name
case is untested, exactly as the last two qualification findings were.

**Severity rationale (Tier 2, not Tier 1):** this is a correctness/robustness gap, not
a leak. The security predicates (tenant/region/department) are still applied correctly
and unconditionally, and the column allowlist is still enforced against the correct
table (left→primary, right→joined). An ambiguous `ON` fails the query closed; it does
not widen scope or cross a tenant boundary.

**Suggested fix direction:** mirror the filter-qualification fix (finding 2.1, iter7).
Qualify an unqualified `on` column with the table it conventionally belongs to — the
**left** side with the primary table, the **right** side with `join.table` — leaving a
column that already contains a `.` untouched. This exactly matches the left→primary /
right→joined convention `validateDescriptorColumns` already uses, so validation and
execution stay in lockstep. Cleanest either in `buildSecureQuery`'s join loop
(alongside the existing filter qualify-if-no-dot pass) or when `buildPlan` constructs
`ResolvedJoin.on`. Add a real-Knex `.toString()` regression pinning the pre-fix
ambiguous shape and the post-fix qualified shape for a shared-column-name `on` pair,
plus an unqualified-both-sides case, mirroring the existing filter-qualification
sub-suite in `queryBuilder.test.ts`.

---

## What was re-verified and found sound (no finding)

Every item below was checked against the current source (and, where a rendering claim
was involved, against real Knex `.toString()` with the pg dialect), not assumed from
prior rounds.

**Security-boundary reachability (Zero-Knowledge Rule).** Every path that reaches the
DB is gated:

- Reads: `handleBatchQuery` → `assertTablesAllowed` (whole batch, before any build) →
  `validateQueryPlan` per widget (unconditional HAVING/agg-alias/output-alias/order-by
  validators + fail-closed `validateDescriptorColumns` when a `columnAllowlist` is set)
  → `runPreflight`/`executeForTier`, both funneling through `buildSecureQuery`.
- Writes: `handleMutation` → `assertTablesAllowed` → `validateMutation`
  (writable/where allowlists, qualified-key rejection, scope-value validation) →
  `buildInsert/Update/DeleteMutation`, each resolving cols through the compiled policy
  and calling `applySecurityPredicates` first.
  There is no builder or `db(...)` call site that bypasses these. Confirmed by
  enumerating every `.raw/.select/.where/.whereIn/.whereLike/.whereBetween/.groupBy/
.orderBy/.having/.havingRaw/.on/.andOnVal/.andOnIn/.count/.sum/.avg/.min/.max/
.insert/.update/.delete` call site in `src/` (excluding tests).

**Row-level-security correctness across join types.** Re-rendered with real Knex:

- inner join → both sides scoped in WHERE (equivalent);
- LEFT join → joined (nullable) side scoped in the join's `ON` via `andOnVal`/`andOnIn`,
  primary in WHERE — the NULL-extended row survives, matched joined rows still
  tenant-checked;
- RIGHT join → primary (nullable) side scoped in `ON`, joined (preserved) side in WHERE;
- **mixed LEFT+RIGHT in one query** → `hasRightJoin` skips the primary WHERE and the
  primary predicate lands in the right join's `ON`; the left-joined table stays in its
  own `ON`; the right-joined table in WHERE. Rendered SQL shows no dropped or
  misplaced tenant predicate.
  The `forJoinedTable(table) === undefined` opt-out (`perTable[table] = null`) correctly
  emits no predicate (early return in `emitSecurityPredicates`), and the per-dimension
  `null` (`resolveDimension`) drops only that dimension while keeping tenant scoping.
  WHERE and `ON` emitters share `emitSecurityPredicates`, so the `undefined`-vs-`[]`
  region and empty-string-department distinctions cannot drift between placements.

**Identifier / value binding (invariant 5).** Every value reaches Knex via `?`; every
identifier via `??`, Knex's alias-map form (`query.sum({ [alias]: col })`), ON-clause
value binding (`andOnVal`/`andOnIn`), or a builder method that identifier-escapes its
argument. The only interpolated raw tokens are fixed, own-property-gated map values
(`applyHaving`'s `FUNC`/`op`; the agg-func `switch`) and `${table}.${col}`
qualification strings still passed _as identifiers_ to Knex (`qualify()`, the filter
qualify-pass, `applyHaving`'s physical qualify at line 265). Client-controlled tokens
are additionally charset/allowlist-constrained fail-closed and unconditionally:
`agg.alias` (`validateAggregationAliases`), `outputAlias` (`validateOutputAliases`,
shared `SAFE_ALIAS_PATTERN`), `orderBy.direction` (`validateOrderByDirections`), HAVING
operator (own-property gate). `String(ob.direction).toLowerCase()` in `buildPlan` keeps
the direct-caller path non-throwing while the request path is already validated.

**Prototype-chain lookups.** All client-keyed plain-object reads are `hasOwnProperty`-
gated: `resolveAlias`'s `columnAliases[column]` (and the `typeof mapped === 'string'`
narrowing), `checkColumnAgainstAllowlist`'s `allowlist[table]`,
`synthesizeProjectionFromAllowlist`'s `columnAllowlist[table]`, `applyHaving`'s `opMap`,
and the tenant/region/department `hasOwnProperty` checks in
`validateSecurityColumnValues` / `resolveInsertScopeStamps`. A `column`/`table` naming
`constructor`/`toString`/`__proto__`/`hasOwnProperty` resolves to the literal
string / a fail-closed "no entry", never a truthy inherited member.

**Mutation write-scope.** INSERT force-stamps tenant and fail-closed
stamps-or-throws region/department (`resolveInsertScopeStamps`, gating department on
`!== undefined`); UPDATE strips the tenant column and rejects qualified value keys;
UPDATE/DELETE require a WHERE and apply security predicates in `'write'` mode where an
empty region scope or empty `in` throws rather than widening. The non-scalar region
guard (`typeof region === 'object'`) precedes the string comparison, so an array like
`[5]` (which stringifies to `"5"`) can't slip a non-scalar into the region column.
`compileSecurityPolicy` throws on the single-tenant + `perTable[table].tenant`
contradiction.

**Caching / cache-adjacent I/O — all failure-isolated.** Re-audited every I/O path the
prompt flagged:

- data cache `get`/`set` (`handler.ts`) — each in its own `try/catch`, degrade to
  miss / served-uncached;
- tier cache `get`/`set` (`tierDecision.ts`) — each in its own `try/catch` (iter8 fix),
  degrade to preflight / decided-uncached;
- post-mutation `deleteByTag` (`handleMutation.ts`) — `try/catch`, committed write stays
  `ok: true`.
  There is **no third cache plane** and **no cache-adjacent I/O that isn't guarded**.
  Cache-key computation (`generateCacheKey`/`sortedStringify`/HMAC) is pure and
  in-process (the memo `Map` is bounded to `MAX_MEMO_SIZE`); it can only throw on a
  missing HMAC secret, and that call sits inside `processWidget`'s try/catch, so it
  degrades to a per-widget error rather than an unhandled rejection. Tier-plane keys are
  namespaced with `TIER_CACHE_KEY_PREFIX`, so data and tier planes never collide even on
  one shared Redis client. `floorTtlMs` unifies the `ttlMs: 0` → 1s convention across
  all four providers. `RedisCacheProvider.extendTagIndexExpiry` never shortens a shared
  forward-index TTL. `LRUCacheProvider.extractPrefix`'s 3rd-colon scan is exact because
  `generateCacheKey` URL-encodes the tenant segment.

**Cache-key policy scoping.** `generateCacheKey` folds `policy.digest` (covering
`tenancy`, `securityColumns`, and — when supplied — a column-sorted `columnAllowlist`)
into the HMAC'd security hash, so differently-scoped nodes never share entries and
tightening the allowlist invalidates looser-allowlist results. The digest and both
cache hashes share the single `sortedStringify`.

**No new inconsistency from the iter8 fix round.** The tier-cache `try/catch` guards
mirror the data-cache guards exactly (miss on `get`, logged-and-returned on `set`). The
`projectColumn` change qualifies only `col.physical` (the SELECT-list source), leaving
`col.outputAlias` (the output row key) untouched, so client row shapes are unchanged;
the synthesized `<table>.*` wildcard flows through `qualify()` unchanged (already has a
dot). `measureColSet`/`dimensionColumns` compare pre-qualification `ColumnRef` strings
consistently on both sides.

---

## Verification method notes

- Read all 27 non-test source files in full plus `ARCHITECTURE.md`.
- Enumerated every Knex builder call site in `src/` (grep over the builder-method
  surface) and traced each column argument back to either `qualify()`, the filter
  qualify-pass, a `${table}.${col}` security-predicate construction, or an
  allowlist-derived / plan-resolved `ColumnRef` — the join `ON` pair (finding 2.1) is
  the only one that reaches raw SQL unqualified.
- Rendered the load-bearing claims with a real Knex pg-dialect instance
  (`packages/x-studio-data-middleware/node_modules/knex`): the unqualified join `ON`
  ambiguity, and the mixed LEFT+RIGHT join security-predicate placement.
