# Architecture Review — `@mui/x-studio-data-middleware`

Iteration 3. Fresh, adversarial, cross-file read of `src/` from scratch. Baseline
confirmed before findings: `tsc -p tsconfig.json` is clean (the only errors in the
worktree are `Cannot find module 'lru-cache'`, an artifact of the worktree having no
linked `node_modules`; with `lru-cache@11` resolvable, `tsc` exits 0), and the full
package suite passes (`403 passed / 403`, 17 files) via the repo-root `vitest`.

## Summary

The package is in good shape and the previous two iterations clearly hardened the
obvious injection/bypass surfaces (identifier binding everywhere, fail-closed
operator/alias/direction allowlists, HAVING own-property guard, the compiled-policy
digest folded into the cache key, joined-table default scoping, `SELECT *` synthesis
for no-column widgets). I tried hard to break tenant isolation, identifier injection,
and cache-key collisions across security contexts and could **not**.

I did find **one real, empirically-confirmed column-allowlist bypass (Tier 1)**: the
`SELECT *` synthesis that was added to close the no-column bypass is **not
join-aware**. When the primary table's allowlist entry is the `['*']` wildcard and the
widget declares a join, the synthesis takes its "leave projection empty" opt-out path
and the query executes as a bare `SELECT *`, which returns **every column of every
joined table** — including columns the joined table's own allowlist entry restricts.
This is a within-tenant column-visibility bypass (tenant isolation itself still holds).

Tier 2 and Tier 3 contain lower-severity design smells; none is a security hole on its
own.

---

## Tier 1 — Correctness & Security

### 1.1 `SELECT *` column-allowlist bypass on joined tables when the primary entry is `['*']`

**Files:**

- `src/security/validateQueryPlan.ts:204-226` (`synthesizeProjectionFromAllowlist`)
- `src/security/validateQueryPlan.ts:327-329` (call site)
- `src/router/execute.ts:66-73` and `:101-113` (no `.select()` when `plan.columns` is empty → Knex `SELECT *`)

**What the code does.** `synthesizeProjectionFromAllowlist` exists specifically to
stop a no-column/no-aggregation widget from emitting `SELECT *` under a configured
allowlist. But its `['*']` branch returns early and leaves the projection empty:

```ts
// validateQueryPlan.ts
if (allowed.includes('*')) {
  // Explicit opt-out — leave the projection empty so Knex keeps SELECT *.
  return;
}
plan.columns = allowed.map((col) => ({ physical: asColumnRef(col) }));
```

It only ever inspects `columnAllowlist[table]` for the **primary** table. It never
considers that the widget may `JOIN` other tables. Downstream, `executeForTier` only
calls `.select(...)` when `plan.columns.length > 0` (`execute.ts:69`, `:102`); with an
empty projection the query runs as a bare `SELECT *`, which in SQL returns all columns
of **all** joined tables.

**Concrete failure scenario.** Host config (a plausible, protection-expecting config —
"orders fully visible, customers restricted to `id`"):

```ts
columnAllowlist: { orders: ['*'], customers: ['id'] }
```

Malicious widget descriptor:

```jsonc
{
  "id": "w1",
  "table": "orders",
  "joins": [
    { "table": "customers", "type": "left", "on": [["orders.customer_id", "customers.id"]] },
  ],
  // no `columns`, no `aggregations`
}
```

- `validateDescriptorColumns` passes: the only column references are the `join.on`
  pair, and both (`orders.customer_id` under `orders:['*']`, `customers.id` under
  `customers:['id']`) are allowlisted.
- `synthesizeProjectionFromAllowlist('orders', …)` sees `orders: ['*']` and returns
  early → `plan.columns` stays `[]`.
- `executeForTier` (client/server tier, or the db-tier non-aggregation fallback) skips
  `.select()` → `SELECT * FROM orders LEFT JOIN customers …`.
- The response rows contain **every `customers` column** (e.g. `customers.ssn`,
  `customers.credit_limit`), even though `customers` is allowlisted to `['id']` only.

Note the asymmetry that makes this a genuine bypass rather than an accepted opt-out: a
client that names the column **explicitly** (`"columns": ["customers.ssn"]`) is
correctly rejected by `validateDescriptorColumns`, but the same client reaches the same
data implicitly by sending **no** columns.

**Empirical verification.** Exercising the real `validateQueryPlan` + `executeForTier`
(not the mock, which no-ops joins and never merges joined columns — so this path is
entirely untested) confirms both halves:

- `validateQueryPlan(descriptor, { orders: ['*'], customers: ['id'] }).columns` is
  `[]` (empty) — no join-aware restriction is synthesized.
- `executeForTier(..., 'client', ...)` makes **zero** `.select()` calls against a
  recording query builder → the emitted query is a bare `SELECT *`.

**Why it matters.** The column allowlist is presented throughout the code and docs as
a security control ("so unlisted tables cannot be probed", "locks column visibility
down"). This path silently defeats it for the joined table. Tenant/region/department
scoping still applies to the joined table (so it is _not_ a cross-tenant leak), but it
is a real within-tenant column-confidentiality bypass.

**Suggested fix.** The `['*']` wildcard means "all columns _of this table_", which SQL
expresses precisely as `orders.*` — not bare `*`. When the primary entry is `['*']`,
synthesize an explicit primary-table wildcard projection (`{ physical: 'orders.*' }`,
or `${table}.*`) instead of returning early with an empty projection. That keeps the
single-table `SELECT *` semantics the opt-out intends while restricting a joined query
to primary-table columns (joined columns must then be named explicitly, which routes
them back through `checkColumnAgainstAllowlist`). The non-wildcard branch is already
safe — it emits only `orders.<col>` entries.

---

## Tier 2 — Design smells

### 2.1 Non-aggregation queries above `serverMemoryTier` return unbounded raw rows

**File:** `src/router/execute.ts:101-113` (db-tier non-aggregation fallback), and the
`'client'`/`'server'` branches when no `limit` is set.

A plain (non-aggregation) descriptor whose preflight `COUNT(*)` exceeds
`serverMemoryTier` (default 100 000) is routed to the `'db'` tier, where — having no
aggregation to push down — it falls back to the same plain `select`/`orderBy`/`limit`
shape and, absent a client `limit`, streams **every** matching row to the caller. The
whole point of tiering is to avoid moving huge result sets; this fallback does exactly
that for the largest tier. It's flagged in the code comment as an intentional
row-shape-preserving fallback, and it's not a _security_ problem (rows are still
tenant/region/department scoped), but it is a latent memory/DoS smell: a client can
force a full-table transfer of a >100k-row tenant slice by sending a broad,
limit-less, non-aggregating descriptor. Consider an enforced server-side cap (or
rejecting a limit-less non-aggregation descriptor that lands in the db tier).

### 2.2 Batch-abort vs per-widget error isolation is inconsistent between validation and execution

**Files:** `src/handler.ts:112-114` (synchronous `validateQueryPlan` map) vs
`src/handler.ts:155-231` (`processWidget` try/catch).

A validation failure in `validateQueryPlan` (bad HAVING alias, unsafe aggregation
alias, non-`asc`/`desc` direction, disallowed column) throws out of `handleBatchQuery`
and rejects the **entire** batch, while a failure discovered during execution (unknown
filter operator in `applyPredicate`, unsupported `agg.func` in `executeForTier`, any DB
error) is caught per-widget and returned as `{ error }` for just that widget. Both
behaviors are individually defensible and documented, but the split means two
client-controlled, fail-closed rejections of very similar nature (an unknown _filter_
operator vs an unknown _HAVING_ operator; an unsafe _alias_ vs an unsupported _func_)
have opposite blast radius. Worth consciously picking one contract; today it's an
accident of _where_ each check happens to run.

---

## Tier 3 — Minor / cosmetic

### 3.1 Region scope check in mutations can be satisfied by a coincidentally-stringifying non-scalar

**File:** `src/mutations/mutationBuilder.ts:120`
(`claims.regionIds.some((id) => String(id) === String(region))`).

`region` is untrusted JSON. `String([5])` is `"5"` and `String({toString:...})` can't
occur over JSON, but an **array** value `[5]` (or `["5"]`) stringifies to `"5"` and
passes the scope check against `claims.regionIds === [5]`. The value then written is
the array, not a scalar — a data-quality wart more than an escalation (the value is
still semantically "region 5", within scope). A `typeof region !== 'object'` guard
(or comparing against a `Set` of normalized scalars) would tighten this. Very low
severity.

### 3.2 Region uses string-coercion tolerance; department uses strict `!==`

**File:** `src/mutations/mutationBuilder.ts:120` (region, coerced) vs `:133` (department,
`values[cols.department] !== claims.department`, strict).

The two row-level dimensions handle client/claim type mismatches differently. Region
deliberately tolerates a TEXT-vs-number mismatch; department rejects any non-identical
value. `department` is typed `string` on both sides so strict compare is fine in
practice, but the inconsistency is a readability/foot-gun smell if a deployment ever
carries a non-string department claim.

### 3.3 `applySecurityPredicates` emits duplicate `whereIn` values for numeric regions

**File:** `src/shared/predicates.ts:178`
(`claims.regionIds.flatMap((id) => [id, String(id)])`).

For a numeric region column, `region IN ($1, $2, …)` carries both `5` and `"5"` for
every region id — 2× the bind parameters, all collapsing to the same value under
parameterized type inference. Correct, but wasteful for large `regionIds`. (The dual
form is deliberate — see Notes — this is only about the redundant _numeric_-column
case.)

### 3.4 Redis reverse-index key is not prefixed by `keyPrefix`

**File:** `src/cache/RedisCacheProvider.ts:263-265` (`keyTagsKey` returns
`` `__ktag__:${key}` `` with no `this.prefix`, whereas `tagKey` at `:258-260` is
prefixed).

Internally consistent (the embedded `key` is already prefixed, and `deleteByTag` /
`invalidatePrefix` both round-trip through the same helper), so nothing breaks. But two
deployments sharing one Redis with different `keyPrefix`es keep their `__ktag__:` keys
in a shared, un-prefixed namespace — cosmetically inconsistent with the forward index
and the stated purpose of `keyPrefix`.

---

## Notes on documented tradeoffs (checked, found correct-by-design)

- **Tenant isolation cannot be OR-ed away.** Every user filter goes through
  `.where`/`.whereIn`/… (AND), never `.orWhere`, and `applySecurityPredicates` runs
  first. I could not construct any descriptor (filters, HAVING, joins, orderBy,
  aggregations) that removes or widens the tenant predicate. Solid.
- **Cache-key scoping across security contexts.** `generateCacheKey` folds `tenantId`,
  sorted `regionIds`, `department`, and `policy.digest` (which itself covers `tenancy`,
  `securityColumns`, and `columnAllowlist`) into the HMAC security hash, and prefixes
  the key with the raw `tenantId`. Different scopes → different keys; the tier cache
  uses the same scoped key in a separate provider. I tried to find two distinct
  security contexts that collide and could not.
- **Joined-table default scoping (fail-closed).** `resolveJoinSecurityColumns` inherits
  the primary table's resolved tenant/region/department columns unless `perTable[t] =
null`. A joined table that lacks a `region_id`/`department` column will make the query
  _error_ (fail-closed) rather than leak — correct posture.
- **`limit: 0` gated on `!== undefined`, not truthiness** — verified in all three
  `executeForTier` branches; a zero limit correctly returns zero rows.
- **HAVING operator own-property guard** (`Object.prototype.hasOwnProperty.call(opMap,
h.operator)`) correctly defeats the `"toString"`/`"constructor"` inherited-member
  bypass; `havingRaw('?? op ?', …)` binds alias and value.
- **INSERT forces the tenant column but only _validates_ region/department when
  present.** A region-scoped caller can insert a row that omits the region column
  (→ NULL/DB-default). This looks asymmetric next to the forced tenant column, but it is
  the reasonable design: `tenantId` is a single value and can be forced, whereas
  `regionIds` is a _set_ with no single value to stamp. The omitted-region row is
  invisible to region-scoped reads (`region IN (…)` never matches NULL) and still
  tenant-scoped, so it is not a cross-tenant or read-side escalation. Left as a
  deliberate tradeoff, not a defect.
- **`extractSecurityClaims` ignores the JWT `alg` header.** It always enforces HS256
  over `header.payload`, so an `alg:none`/alg-confusion token fails signature
  verification — the demo verifier is fail-closed for its stated scope (and is
  explicitly a replace-in-production stub).
