# Architecture / tech-debt review — `@mui/x-studio-data-middleware`

Independent review of `packages/x-studio-data-middleware/src/` (all 45 files read in full),
covering the current working tree. Line numbers refer to the current working tree.

This package changed substantially since the previous review: the SELECT-\* allowlist bypass,
the qualified-`values`-key mutation bypass, and the missing ORDER-BY-direction validation
(old findings 1.1/1.2/1.3) are all now **fixed** — `synthesizeProjectionFromAllowlist`,
`rejectQualifiedValueKeys`, and `validateOrderByDirections` respectively, each with dedicated
tests. Tenancy is now a required, fail-closed decision (`TenancyConfig`), `security/types.ts`
is a thin re-export facade over `authTypes`/`queryTypes`/`mutationTypes`, `columnAllowlist` is
folded into the policy digest, and alias resolution is consolidated into a single
`ValidatedQueryPlan`. The old review's findings were re-derived from scratch and are **not**
carried forward except where still true.

**Security sanity-check.** Under direct inspection the three core invariants hold:

- **Tenancy isolation is fail-closed.** `handleBatchQuery`/`handleMutation` both call
  `compileSecurityPolicy({ tenancy, ... })` once at the top (`handler.ts:87`,
  `handleMutation.ts:62`), before any query is built. `tenancy` is a required field; a runtime
  caller that omits it makes `compileSecurityPolicy` read `tenancy.mode` on `undefined` and throw,
  rejecting the whole request — there is no code path that resolves to an unscoped, all-tenant
  query by omission. `single-tenant` is the _only_ way to get no tenant predicate, and it must be
  declared explicitly; `single-tenant` + a `perTable[t].tenant` override is a contradiction that
  throws (`compileSecurityPolicy.ts:160-173`). The tenant predicate is applied first, before user
  filters, on the primary table and (by default, fail-closed inheritance) every joined table
  (`queryBuilder.ts:106-116`, `predicates.ts:128-162`); on writes the tenant column is stamped on
  INSERT and stripped from UPDATE `values` and appended to the WHERE unconditionally
  (`mutationBuilder.ts:202-289`). The internal query/execute functions that skip validation are
  **not** part of the public surface — `index.ts` exports only `handleBatchQuery`,
  `handleMutation`, `generateCacheKey`, `extractSecurityClaims` and the cache providers — so the
  no-throw direct-caller paths (`toValidatedQueryPlan`/`toCompiledSecurityPolicy` on a raw
  descriptor) are reachable only from tests, not from client input.
- **Column-allowlist enforcement is complete over every reference that reaches SQL.**
  `validateDescriptorColumns` (`columnValidation.ts:105-152`) checks projection columns, filter
  predicates, ORDER BY, aggregation targets, and **both sides** of every `join.on` pair — each
  after `resolveAlias`, and each against the table it will actually execute against (the join
  right-side against `join.table`, not the primary). `synthesizeProjectionFromAllowlist`
  (`validateQueryPlan.ts:204-226`) closes the no-columns `SELECT *` hole fail-closed. HAVING can
  only name an aggregation alias (`validateHavingAliases`), and aggregation aliases are
  charset-restricted (`validateAggregationAliases`) since they are string-interpolated. A
  `columnAliases` entry can only relabel a column the caller could already reach, because both
  validation and execution resolve through the _same_ `resolveAlias` and the executor reads
  pre-resolved `ColumnRef`s off the plan (verified: no `resolveAlias` call exists anywhere under
  `router/`). One real defect exists in this area, but it is fail-_closed_ (over-rejection, not a
  leak) — see finding 1.1.
- **Cache-key / policy-digest correctness holds.** The key is
  `studio:v1:<tenantId>:<securityHash>:<queryHash>` (`cacheKey.ts:112`), where `securityHash` is an
  HMAC over `{tenantId, regionIds(sorted), department, policyDigest}` and `policyDigest` folds
  `tenancy`, `securityColumns`, **and** `columnAllowlist` (`compileSecurityPolicy.ts:105-114`).
  Two tenants cannot collide (tenantId is both a literal key segment and inside the HMAC); two
  requests differing only in `columnAllowlist`, tenancy scope, or security columns get different
  keys (traced through `compileSecurityPolicy.test.ts` and `cacheKeyPolicyDigest.test.ts`, which
  pin exactly this). The single canonical serializer (`canonicalize.ts`) feeds both the cache hash
  and the digest, so they cannot drift. A missing HMAC secret throws (fail-closed). Cache reads are
  never served across a policy/tenant boundary because the key encodes all of them.

Net: the security-critical machinery is genuinely hardened and well-tested. The findings below are
one real correctness bug (fail-closed, so not a leak, but it breaks a normal feature combination),
a few maintainability/defense-in-depth observations, and minor/cosmetic items.

---

## Tier 1: Correctness & Security

### 1.1 An ORDER BY on an aggregation alias is falsely rejected whenever a `columnAllowlist` is configured

- `shared/columnValidation.ts:123-125` (the `orderBy` loop in `validateDescriptorColumns`)
- consumed by `security/validateQueryPlan.ts:319-321`
- contrast with the _correct_ handling in `security/validateQueryPlan.ts:262-275` (`buildPlan`)

`validateDescriptorColumns` validates every `orderBy[].column` against the column allowlist as if it
were a physical column:

```ts
for (const ob of descriptor.orderBy ?? []) {
  check(ob.column, 'orderBy'); // -> checkColumnAgainstAllowlist, throws if not allowlisted
}
```

But an ORDER BY target is frequently an **aggregation alias**, not a physical column — e.g. "top
regions by `total_revenue`". The plan _builder_ correctly distinguishes the two cases
(`buildPlan` at `validateQueryPlan.ts:262-275` checks `aggAliasSet.has(ob.column)` and keeps an
aggregation alias as `aggAlias`, resolving only true physical columns). The _validator_ has no such
exclusion, and it runs first (`validateQueryPlan.ts:319-321`, before `buildPlan`), so it throws on
the alias before the builder ever sees it. A host allowlists _physical_ columns, never the client's
freely-chosen aggregation aliases, so the alias is essentially never present in the allowlist.

I confirmed this empirically by running `validateQueryPlan` on
`{ columns:['region'], aggregations:[{column:'amount',func:'sum',alias:'total_revenue'}],
orderBy:[{column:'total_revenue',direction:'desc'}] }` with `columnAllowlist { sales:['region','amount'] }`:
it throws `Column "total_revenue" on table "sales" is not in the column allowlist (orderBy)`.

**Failure scenario:** not a cross-tenant leak — it is fail-_closed_ (a legitimate query is
rejected). A dashboard widget doing "sum amount by region, ordered by the sum, descending" — the
single most common aggregation shape — returns `{ rows: [], error: 'Column "total_revenue" ... not
in the column allowlist (orderBy)' }` for **every** deployment that turns on `columnAllowlist`.
Because column-level security is exactly the posture a security-conscious host enables, the bug
preferentially breaks the hardened deployments. It is entirely untested: the aggregation+ORDER BY
tests (`handler.test.ts:980-1124`) never pass a `columnAllowlist`, and the HAVING tests that _do_
pass one (`handler.test.ts:1156-1347`) never combine it with an ORDER BY on the alias — so the gap
sits precisely between two test clusters.

**Fix:** in the `orderBy` loop of `validateDescriptorColumns`, skip any `ob.column` that matches a
declared aggregation alias (mirror `buildPlan`'s `aggAliasSet.has(...)` check), validating only
targets that are not aggregation aliases. This keeps physical ORDER BY columns fail-closed while
letting a legitimate alias through — and the executor already handles the alias correctly, so no
downstream change is needed. Add a `handler.test.ts` case combining `columnAllowlist` +
`aggregations` + `orderBy` on the alias to pin it.

---

## Tier 2: Design smells / maintainability risks

### 2.1 Validation errors reject the whole batch; execution errors are isolated per-widget

- `handler.ts:112-114` (synchronous `validateQueryPlan` map, outside the per-widget try/catch)
- `handler.ts:155-230` (per-widget try/catch swallows execution errors into `result.error`)

`assertTablesAllowed`, `compileSecurityPolicy` and the per-widget `validateQueryPlan` all run
_before_ `Promise.all`, outside `processWidget`'s try/catch, so any validation throw rejects the
entire `handleBatchQuery` promise. A DB error during execution, by contrast, is caught and returned
as a single widget's `error` field while siblings succeed. The asymmetry is deliberate and
documented (`handler.ts:110-111`), and defensible as "malformed request = reject the batch". But the
consequence is that **one** client widget with, say, a bad ORDER BY direction, an unlisted column,
or — per finding 1.1 — an ORDER BY on an aggregation alias, takes down every other widget's result
in the same batch. For a dashboard that batches many independent widgets, a single malformed (or
1.1-tripping) widget blanks the whole page rather than showing an error on just that tile. Worth
reconsidering whether descriptor-validation failures should also be per-widget-isolated (returned as
that widget's `error`) so the blast radius matches the execution path. This is a design decision,
not a defect — flagged so the tradeoff is explicit.

### 2.2 Aggregate expressions are built by string interpolation, not bindings — the one spot that departs from the package's `??`/`.where()` discipline

- `router/execute.ts:107-126` (`query.sum(\`${col} as ${agg.alias}\`)`, and `avg`/`count`/`min`/`max`)

Everywhere else, identifiers reach Knex through `.where(col, op, val)`, `.select([...])`,
`.on(l,'=',r)` or the `??` identifier binding — Knex escapes them. The aggregate clause is the lone
exception: it concatenates `col` (= `qualify(agg.physical)`) and `agg.alias` into a template string
and hands the result to `query.sum(...)`. This is **not** currently exploitable: `agg.alias` is
charset-restricted to `[A-Za-z0-9_]` (`validateAggregationAliases`), Knex's aggregate helpers
still identifier-escape the parsed `col`, and when a `columnAllowlist` is configured `agg.physical`
is a host-declared allowlisted column. The residual risk is that when no `columnAllowlist` is set
(the documented opt-in gap), `col` is a raw client column name whose safety rests entirely on Knex's
internal parsing of the `"x as y"` aggregate string — a thinner guarantee than the explicit bindings
used elsewhere, and one that a Knex version change could quietly weaken. Consider using Knex's
object/`??` form for the aggregate column+alias to match the rest of the package's defense-in-depth
posture. Low urgency; noted because it is the single interpolation-built identifier in an otherwise
binding-disciplined codebase.

### 2.3 Fail-closed region/department inheritance onto joined tables is correct but operationally sharp

- `shared/predicates.ts:89-107` (`resolveJoinSecurityColumns` inherits _region_ and _department_, not just tenant)

The fail-closed default that a joined table inherits the primary's _tenant_ column closes a real
cross-tenant fan-out and is a good call. But the same resolver also inherits the primary's `region`
(`region_id`) and `department` column names onto every unregistered joined table, and
`applySecurityPredicates` will emit `whereIn('joined.region_id', ...)` / `where('joined.department',
...)` whenever the caller's claims carry those dimensions. A joined table that has a tenant column
but _no_ `region_id`/`department` column then produces a "no such column" SQL error — surfacing as
that widget's `error`, i.e. fail-closed, but as an opaque DB error rather than a clear config
message. The escape hatch (`perTable[t] = null`, or per-column overrides) exists and is documented,
but hosts must remember to configure it for every region/department-unscoped join. Consider either
inheriting only the tenant column by default (region/department are more schema-specific), or
detecting the missing-column case and raising a config-oriented error. Deliberate tradeoff, not a
bug — flagged for operability.

### 2.4 `unknown` aggregation `func` is silently dropped rather than rejected

- `router/execute.ts:105-126` (the `switch (agg.func)` has a `default: break`)

`agg.func` is typed `'sum'|'avg'|'count'|'min'|'max'` but originates from client JSON and is never
runtime-validated (unlike `agg.alias`, filter operators, and ORDER BY direction, which all are). An
out-of-set `func` falls through the `switch` default and the aggregation is silently omitted — the
query still runs, returning a GROUP BY with a missing measure column, which the client may
misinterpret. Not a security issue (nothing unsafe reaches SQL), but inconsistent with the package's
otherwise-thorough "types are not runtime guarantees" validation and produces a confusing silent
result instead of a clean rejection. Add `func` to the fail-closed validators.

---

## Tier 3: Minor / cosmetic

### 3.1 Stale test comment claims the cache key does not fold in `columnAllowlist`

- `src/__tests__/handler.test.ts:250-252`

The comment reads "the cache key does not fold in `columnAllowlist` (pre-existing gap), so identical
descriptors across these sibling tests would otherwise share one entry." That gap is closed:
`compileSecurityPolicy` folds `columnAllowlist` into `policy.digest` (`compileSecurityPolicy.ts:105-114`)
and the handler threads `policy.digest` into `generateCacheKey` (`handler.ts:152`). The test still
passes (it uses a fresh `cacheProvider` anyway), but the comment now misdescribes the code and
should be corrected to avoid misleading a future reader into thinking the fold does not happen.

### 3.2 `extractPrefix` comment is off-by-one in its description

- `src/cache/LRUCacheProvider.ts:176-188`

The comment says "Find the 4th colon (index after `studio:v1:<tenantId>:`)" but the loop returns on
`colons === 3`, which is correct (`studio:v1:acme:` contains three colons). The code is right; the
"4th colon" wording is confusing and should read "3rd colon".

### 3.3 `db: any` throughout the query/mutation path

- `handler.ts:139`, `mutationBuilder.ts:66`/`144`, `router/*.ts`, both `Handle*Options.db`

Knex is typed as `any` to avoid a hard import-time dependency (documented, and Knex is only a peer
dependency). Reasonable, but it means the whole query-construction surface is unchecked against the
real Knex builder types — a signature drift (e.g. a renamed `.havingRaw`/`.whereLike`) would only
surface at runtime. A single internal `type KnexQueryBuilder` alias (even a hand-written structural
subset of the methods actually used) applied at the boundaries would recover most of the safety
without adding a dependency. Very low priority.

### 3.4 Cohesion is otherwise good — what was checked

`shared/` genuinely centralizes the security-critical logic consumed by both read and write paths
(`predicates.ts`, `columnValidation.ts`, `assertTablesAllowed.ts`); `compileSecurityPolicy` and
`validateQueryPlan` are each threaded once and re-used; the two Redis providers share
`redisCompat.ts`; `canonicalize.ts` is the single serializer behind both hashes. `router/` is
cleanly split (`preflight.ts` = COUNT only, `execute.ts` = projection/aggregation, `queryBuilder.ts`
= predicates/joins, `tierDecision.ts` = routing). No god-file in the runtime path; the largest file
is `handler.test.ts` (1516 lines), which is a test file sectioned by `describe` blocks. The
`security/types.ts` facade split called out in the brief is clean — `types.ts` is a 22-line
re-export shim over `authTypes`/`queryTypes`/`mutationTypes`, and no stale pre-hardening JSDoc
survives the split (the old review's finding 1.4 is resolved: `authTypes.ts:66-96` and
`mutationTypes.ts:176-208` both describe the current fail-closed inheritance).
