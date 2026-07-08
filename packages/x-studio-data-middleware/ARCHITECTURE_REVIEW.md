# Architecture Review — `@mui/x-studio-data-middleware`

Independent, adversarial review of the current source (not of `ARCHITECTURE.md`'s
claims). Baseline confirmed green before review: `tsc -p tsconfig.json` clean and
`vitest --project "x-studio-data-middleware" --run` = 382 passed / 16 files.

Deliberate tradeoffs documented in `ARCHITECTURE.md` (batch-vs-per-widget
validation isolation, joined-table security-column inheritance, `db: any` duck
typing, `sortedStringify` array-order significance, the demo JWT verifier) were
verified against the code and are **not** re-flagged.

---

## Tier 1 — Correctness & Security

### 1.1 HAVING operator allowlist is bypassable via prototype-inherited keys — `src/router/queryBuilder.ts:140-155`

`applyHaving` maps the client-supplied HAVING operator through a plain object
literal and guards only on falsiness:

```ts
const opMap: Record<HavingPredicate['operator'], string> = {
  eq: '=',
  gt: '>',
  lt: '<',
  gte: '>=',
  lte: '<=',
};
const op = opMap[h.operator];
if (!op) {
  throw new Error(`... Unsupported HAVING operator "${h.operator}" ...`);
}
query.havingRaw(`?? ${op} ?`, [h.alias, h.value]);
```

`opMap[h.operator]` is an unguarded bracket lookup on an object that inherits from
`Object.prototype`. `h.operator` is client JSON — its TS type
(`'eq'|'gt'|'lt'|'gte'|'lte'`) is not a runtime guarantee (the same reasoning the
package already applied to `orderBy[].direction` and `agg.alias`). When a client
sends an operator that names an inherited member — `"toString"`, `"valueOf"`,
`"constructor"`, `"hasOwnProperty"`, etc. — `opMap["toString"]` resolves to
`Object.prototype.toString` (a **function**, hence truthy), so the `!op` guard does
**not** fire. `op` is then string-coerced by the template literal into the
`havingRaw` fragment, e.g. `?? function toString() { [native code] } ?`.

Nothing upstream validates the HAVING operator: `validateHavingAliases`
(`shared/columnValidation.ts:178`) checks only `h.alias`; there is no HAVING-operator
allowlist anywhere else (confirmed by grep — this is the sole handler). Note the
read filter path does **not** have this bug: `applyPredicate` uses
`SAFE_OPERATORS.has(predicate.operator)` (a `Set`, immune to inherited keys). The
HAVING path is the one operator gate that diverges from that fail-closed pattern,
violating documented invariant #5 ("operators reach SQL only through an allowlist").

Failure scenario: a widget with a valid aggregation and
`having: [{ alias: '<valid agg alias>', operator: 'toString', value: 1 }]`.
`validateQueryPlan` passes (alias matches, aggregation present), the query is forced
to the `db` tier, and `applyHaving` interpolates the native-function source string
straight into `havingRaw` instead of rejecting the operator. On a real Knex/SQL
backend this produces broken raw SQL (per-widget error). In the in-memory mock the
regex simply fails to match, so the HAVING predicate is **silently dropped** and the
widget returns unfiltered aggregated groups — a behavior divergence between mock and
production that masks the bug in tests.

Exploitability caveat (stated honestly): the interpolated token is a fixed
engine-provided native-function string, not attacker-chosen text, so this is not a
path to arbitrary SQL exfiltration on its own, and the tenant/region/department
`WHERE` scope (applied earlier in `buildSecureQuery`) is unaffected — this is not a
cross-tenant RLS leak. It is nonetheless a real defect: the operator allowlist is
bypassable, an unvalidated, non-parameterized token reaches raw SQL, and the guard
gives a false sense of fail-closed safety.

Suggested fix: gate with an own-property check or reuse the `Set`/`Map` pattern used
for `SAFE_OPERATORS`, e.g.
`if (!Object.prototype.hasOwnProperty.call(opMap, h.operator)) { throw ... }` before
the lookup (or make `opMap` a `Map` and use `opMap.get(h.operator)`). Add a
regression test with `operator: 'toString'` / `'constructor'`.

---

## Tier 2 — Design smells

### 2.1 A large NON-aggregation query routed to the `db` tier silently changes result semantics — `src/router/execute.ts:88-103`, `src/router/tierDecision.ts:34-45`

`decideTierWithCache` forces `db` for aggregation descriptors, **and also** returns
`db` from `tierFromRowCount` whenever the preflight `COUNT(*)` exceeds
`serverMemoryTier` (default 100_000) — including for descriptors with **no**
`aggregations`. `executeForTier`'s `'db'` branch, however, is written assuming
aggregation push-down:

```ts
const measureColSet = new Set(queryPlan.aggregations.filter(a => a.pureMeasure)...);
const dimensionColumns = queryPlan.columns.filter(c => !measureColSet.has(c.physical));
if (dimensionColumns.length > 0) {
  query.select(dimensionColumns.map(projectColumn));
  query.groupBy(dimensionColumns.map(c => qualify(c.physical)));   // <-- GROUP BY with no aggregate
}
for (const agg of queryPlan.aggregations) { ... }                  // <-- empty, no-op
```

With no aggregations, the loop is a no-op and every projected column is emitted as a
GROUP BY dimension — i.e. the result is silently de-duplicated (`SELECT col1,col2 ...
GROUP BY col1,col2`) rather than the raw rows a `client`/`server`-tier answer would
return for the same descriptor. If the widget also declares no `columns` (and no
allowlist to synthesize a projection), the branch adds neither `select` nor
`groupBy`, so Knex emits an unbounded `SELECT *` over a >100k-row tenant slice.

This is not a security leak (the tenant/region/department predicates from
`buildSecureQuery` are still applied), but it is a real correctness/robustness
divergence that only appears once a tenant's row count crosses the server threshold —
exactly the case that is hardest to catch in tests. Suggested direction: either route
non-aggregation queries away from the `db` tier (cap them at `server`, or require a
`limit`), or make the `db` branch fall back to a plain `select`/`limit` when
`aggregations.length === 0` so the row shape matches the other tiers.

---

## Tier 3 — Minor / cosmetic

### 3.1 Stale, security-relevant doc comment: joins are no longer "primary table only" — `src/security/queryTypes.ts:98-104`

`BatchWidgetDescriptor.joins`' JSDoc still states: _"Security predicates are applied
to the primary table only."_ This contradicts the current implementation:
`resolveJoinSecurityColumns` (`shared/predicates.ts:89`) scopes joined tables **by
default** (inheriting the primary table's resolved columns), and `buildSecureQuery`
(`router/queryBuilder.ts:114-116`) applies `applySecurityPredicates` to every joined
table. The comment is not just stale but actively misleading on a security property
(it implies unregistered joins fan out unscoped, the exact leak the code now closes).
Update it to describe the default-scoped-with-`perTable[table] = null`-opt-out
behavior.

### 3.2 Incomplete doc: `columnAllowlist` validates more than it claims — `src/security/mutationTypes.ts:157-168`

`HandleBatchQueryOptions.columnAllowlist`'s JSDoc says validation covers
"`descriptor.columns`, `descriptor.filters[].column`, and `descriptor.orderBy[].column`".
The actual `validateDescriptorColumns` (`shared/columnValidation.ts:105-166`) also
validates `aggregations[].column` and **both sides of every `joins[].on` pair**.
Since the join-`on` check is a genuine security control (an attacker-controlled join
condition), the doc understating coverage is worth correcting.

### 3.3 Region-scope value check is type-strict and will fail-closed on string-typed region ids — `src/mutations/mutationBuilder.ts:112-113`

`validateSecurityColumnValues` does `const region = values[cols.region] as number;`
then `claims.regionIds.includes(region)`. `Array.prototype.includes` uses
SameValueZero (strict) equality, so a client-supplied string region value (`"5"`)
against numeric `claims.regionIds` (`[5]`) — or vice-versa — never matches and the
write is rejected. This is the safe (fail-closed) direction, so it is not a
vulnerability, but a deployment whose region column is text-typed would see
legitimate scoped writes rejected with a confusing "outside the caller's permitted
regions" error. Consider normalizing both sides (e.g. `String(...)`) or documenting
that `regionIds` and the region column must be numeric.

---

## Summary

- **Tier 1: 1** — HAVING operator allowlist bypass via prototype-inherited keys (`queryBuilder.ts:140-155`).
- **Tier 2: 1** — non-aggregation query on the `db` tier silently GROUP-BYs / `SELECT *`s (`execute.ts:88-103`).
- **Tier 3: 3** — stale "primary table only" join doc; incomplete `columnAllowlist` coverage doc; type-strict region-scope comparison.

No cross-tenant RLS-leak, SQL-injection-via-identifier, or cache-key-collision
defect was found beyond the items above; the compiled-policy digest, `sortedStringify`
canonicalization, `SAFE_OPERATORS`/alias/direction guards, join-security inheritance,
and cache tag/prefix indexes all hold up under adversarial reading.
