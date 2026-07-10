# Architecture Review — `@mui/x-studio-data-middleware` (iteration 7)

Fresh, ground-up review of the current working tree (`packages/x-studio-data-middleware/src`),
re-derived from source with the security invariants (Zero-Knowledge Rule / `schemaAllowlist`,
row-level security via tenancy/`securityColumns`, `columnAllowlist`, `writableColumns`) getting
the most scrutiny. No prior finding was assumed to still apply. `ARCHITECTURE.md` was cross-checked
against the code.

## Summary

- **Tier 1 (security bugs / bypasses): 0**
- **Tier 2 (real correctness/robustness gaps): 1**
- **Tier 3 (minor / test-coverage): 1**

The security core continues to hold: every DB-reaching path routes through
`assertTablesAllowed` → `validateQueryPlan`/`validateMutation` (column allowlist) →
`compileSecurityPolicy` (tenant/region/department) before any SQL is built, and every
client-controlled identifier reaches Knex only via `??`/object-alias-map bindings or the
charset/own-property-gated allowlists. The one Tier 2 finding is a correctness gap (a legitimate
query erroring under joins), not a leak.

---

## Tier 2

### 2.1 — User-filter predicate columns are not table-qualified on the read path; a join with a shared column name makes the emitted WHERE ambiguous

**Files:**

- `src/router/queryBuilder.ts:161` — `applyPredicates(query, queryPlan.filters as FilterPredicate[], 'read')`
- `src/shared/predicates.ts:313-397` — `applyPredicate` emits `query.where(column, …)` with the bare resolved column
- Contrast with `src/router/execute.ts:57-70` (`qualify()` applied to SELECT / GROUP BY / ORDER BY / aggregations) and `src/shared/predicates.ts:252-289` (security predicates emitted as `` `${table}.${col}` ``)

**What's wrong.** Every column reference on the read path is table-qualified to avoid
"ambiguous column" errors under joins — SELECT, GROUP BY, ORDER BY, aggregations
(`execute.ts`'s `qualify()`), and all three security-predicate dimensions
(`emitSecurityPredicates` emits `` `${table}.${securityColumns.x}` ``). The **user filter
predicates are the sole exception**: `buildSecureQuery` passes `queryPlan.filters` straight to
`applyPredicates(..., 'read')`, whose `ColumnRef`s are `resolveAlias` output only (physical, but
_unqualified_ when the descriptor referenced an unqualified column). `applyPredicate` then emits
`query.where('<col>', op, value)` with no table prefix.

`validateDescriptorColumns` (`shared/columnValidation.ts:129-190`) resolves an unqualified filter
column against the **primary** table (`descriptor.table` is the default table), so validation
_intends_ it as the primary table's column — but execution emits it unqualified, so the database,
not validation, resolves it.

**Concrete failure scenario.** A widget joins two tables that share a column name (extremely
common: `region_id`, `id`, `status`, `created_at`, `tenant_id`) and filters on that column
unqualified. Verified render against Knex (pg):

```
select "sales"."id" from "sales"
  left join "customers" on "sales"."customer_id" = "customers"."id"
  where "sales"."tenant_id" = 'acme' and "region_id" = 5
```

On PostgreSQL / MySQL this raises `column reference "region_id" is ambiguous` (SQLite is laxer).
The widget fails and returns an isolated `{ error }` result — a **legitimate, fully-allowlisted
query that the middleware built itself fails to run**. The mock DB (`__tests__/mockDb.ts`) is not a
real SQL engine and never merges joined columns, so no test catches it — the same reason the
outer-join and HAVING-alias dialect bugs from prior rounds went unnoticed.

This is **not** a security leak: SQL rejects an ambiguous reference outright (fail-closed error),
it never silently resolves to the wrong table. It is a correctness/robustness gap and an internal
inconsistency with the deliberate qualification everywhere else — `execute.ts` even documents ORDER
BY qualification with _"an order column shared by both joined tables is otherwise ambiguous,"_ the
exact condition that also applies to filters.

**Suggested fix direction.** Qualify unqualified resolved filter columns with the primary table on
the read path, mirroring `execute.ts`'s `qualify()` (leave columns already containing a `.`
untouched, so a client-qualified `customers.region_id` is respected). The cleanest place is inside
`buildSecureQuery` before calling `applyPredicates` (map `queryPlan.filters` through a
qualify-if-no-dot pass), keeping the shared `applyPredicate` and the write path — which has no
joins — unchanged. Add a `queryBuilder.test.ts` case with a join + unqualified filter asserting the
emitted `where` arg is primary-qualified.

---

## Tier 3

### 3.1 — Empty region scope (`regionIds: []`) on the nullable side of an outer join is unpinned by tests (behavior verified correct in the current Knex)

**Files:**

- `src/shared/predicates.ts:216-231` (`applySecurityPredicatesToJoinOn` → `andOnIn`)
- `src/router/queryBuilder.ts:117-125` (nullable-side ON placement)
- `src/router/__tests__/queryBuilder.test.ts:480-578` (outer-join placement suite)

**What's wrong (coverage only).** The `regionIds: []` ("authorized for zero regions") read-path
semantics rely on the empty-`in` list rendering as a match-nothing predicate. The **WHERE** path is
tested (`queryBuilder.test.ts:141` → `whereIn(col, [])` → `1 = 0`), and the outer-join **ON** path
is tested only with a _non-empty_ region set (`:554` uses `regionIds: [1, 2]`). The combination
that matters for fail-open — `regionIds: []` **and** an outer join to a region-scoped nullable
table, which routes through `andOnIn(col, [])` — has no regression test. If any Knex version dropped
an empty `onIn` instead of rendering it false, a zero-region caller's LEFT/RIGHT join would fail
open and pull in same-tenant rows from unauthorized regions on the nullable side.

I verified the **current** Knex renders it correctly:

```
... left join "customers" on "sales"."customer_id" = "customers"."id"
    and "customers"."tenant_id" = 'acme' and 1 = 0
```

So this is **not a live bug** — it is an unpinned, security-relevant seam in a package that treats
Knex as a version-agnostic peer dependency. Recommend adding a `queryBuilder.test.ts` regression
asserting that `regionIds: []` + a LEFT (and RIGHT) join emits `andOnIn(col, [])` (paralleling the
existing WHERE-path `regionIds: []` test), so a future Knex upgrade that changed empty-`onIn`
rendering would trip a test rather than silently regress row-level security.

---

## Invariants specifically re-verified (and how)

1. **Zero-Knowledge table allowlist.** `assertTablesAllowed` is called in both handlers _before_
   any query build, over the whole batch including every `joins[].table`
   (`handler.ts:80-86`, `handleMutation.ts:75-78`). No `db(...)` call exists that isn't downstream
   of it. Confirmed by reading every `db(` / builder call site in `queryBuilder.ts`,
   `execute.ts`, `preflight.ts`, `mutationBuilder.ts`.

2. **Column allowlist is fail-closed and single-sourced.** `checkColumnAgainstAllowlist` rejects a
   table with no entry (`columnValidation.ts:103-109`), is `'*'`-aware, and is reused verbatim by
   read (`validateDescriptorColumns`) and write (`validateMutation`). Join `on` pairs validate
   left-vs-primary / right-vs-joined (`columnValidation.ts:167-189`). The `SELECT *` bypass is
   closed by `synthesizeProjectionFromAllowlist` including the `['*']` → `<table>.*` (not bare `*`)
   and the fail-closed no-entry throw (`validateQueryPlan.ts:248-282`). Own-property gating on
   `allowlist[table]` / `columnAliases[column]` confirmed in all three lookup sites
   (`columnValidation.ts:62`, `:100`, `validateQueryPlan.ts:257`).

3. **Tenancy is required and fail-closed.** `SecurityPolicyOptions.tenancy` is non-optional;
   `compileSecurityPolicy` is the only interpreter and throws on the `single-tenant` +
   `perTable[t].tenant` contradiction (`compileSecurityPolicy.ts:160-173`). `forPrimaryTable` /
   `forJoinedTable` delegate to the shared resolvers; joined tables scope-by-default (inherit) and
   only opt out via explicit `perTable[t] = null` (`predicates.ts:123-142`).

4. **Security predicates unconditional, first, one implementation, correct placement.** Both WHERE
   (`applySecurityPredicates`) and ON (`applySecurityPredicatesToJoinOn`) delegate to one
   `emitSecurityPredicates` (`predicates.ts:240-291`). Outer-join nullable-side routing verified in
   `queryBuilder.ts:102-154`; the `hasRightJoin` primary-WHERE-skip is correct even with mixed
   join types (traced multi-join cases). Region `undefined`-vs-`[]` and department empty-string
   distinctions present on both read and write. Write-path empty-region **throws**; INSERT
   omission is closed by `resolveInsertScopeStamps` (throw on 0/many regions, auto-stamp on 1).
   Tenant force-stamped on INSERT, stripped on UPDATE, qualified-key rejection in both
   validate and build (`mutationBuilder.ts`).

5. **No raw client SQL.** Every value is `?`-bound; every identifier reaches Knex via `??`
   (`havingRaw('FUNC(??) op ?')` with own-property-gated `FUNC`/op maps — `queryBuilder.ts:198-251`),
   object/alias-map aggregates (`execute.ts:145-173`), `andOnVal`/`andOnIn` (ON values), or Knex's
   own identifier-quoting builders fed `qualify()` strings. Client-controlled tokens
   (`agg.alias`, `outputAlias`, `orderBy.direction`, HAVING/filter operators) all pass
   fail-closed charset/allowlist/own-property checks that run unconditionally
   (`validateQueryPlan.ts`, `columnValidation.ts`, `predicates.ts`).

6. **Cache keys are policy-scoped and tenant-isolated.** `securityHash` HMACs
   `{tenantId, regionIds(sorted), department, policyDigest}`; `policyDigest` folds `tenancy` +
   `securityColumns` + `columnAllowlist` via the single `sortedStringify`
   (`cacheKey.ts`, `compileSecurityPolicy.ts:105-114`). Tenant segment URL-encoded so a `:` in the
   id can't shift the invalidation-prefix boundary (`cacheKey.ts:123`, `LRUCacheProvider.ts:191-206`).
   Tier plane namespaced by `TIER_CACHE_KEY_PREFIX` (`handler.ts:185`); cache get/set/deleteByTag
   failures degrade (best-effort) without poisoning results or flipping a committed write
   (`handler.ts:147-235`, `handleMutation.ts:169-178`). Cache writes tag primary + all joined
   tables (`handler.ts:226`). No cache-invalidation skip found after a write.

7. **Doc accuracy.** `ARCHITECTURE.md` matches the code on every claim spot-checked (region
   numeric+string emission, outer-join placement, HAVING re-emission, `ttlMs:0` flooring, default
   cache singleton, dual-acceptance policy/plan coercion). The doc is silent on read-path filter
   qualification — that silence is exactly the gap in finding 2.1; no _incorrect_ doc claim was
   found.
