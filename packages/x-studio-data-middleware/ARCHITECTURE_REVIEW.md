# Architecture & Correctness Review — `@mui/x-studio-data-middleware`

Fresh review performed against the current source in `packages/x-studio-data-middleware/src/`
(not the architecture doc or training data). Focus areas per the review brief: SQL
injection / allowlist bypass, tenant-isolation failures, cache poisoning / key
collisions, and query-plan / mutation / cache correctness.

**Scope note:** this package has already been hardened over three prior review rounds.
The core security boundaries verified this round are, to my reading, sound:

- Every value reaches Knex through a `?` binding and every identifier through a `??`
  binding, Knex's object/alias-map aggregate form, or Knex's own quoting builder
  methods (`.select`/`.groupBy`/`.orderBy`/`.on`). No client string is
  concatenated into raw SQL. The one interpolated token per free-form channel
  (`agg.alias`, `orderBy[].direction`, HAVING `operator`) is additionally
  constrained to a fail-closed allowlist, and the HAVING `opMap` lookup is gated by
  an own-property check so an inherited `Object.prototype` member cannot resolve.
- Column-reference resolution funnels through the single `resolveAlias`, is compiled
  once per widget into a branded-`ColumnRef` `ValidatedQueryPlan`, and validation +
  execution structurally read the same resolved columns, closing the historical
  alias-vs-execution drift. The `SELECT *` synthesis (`synthesizeProjectionFromAllowlist`)
  correctly qualifies the `['*']` opt-out to `<table>.*` so joined-table columns are
  not leaked.
- Tenant scoping is applied first and unbypassable on both read and write builders;
  the tenant column is force-stamped on INSERT and stripped/overwritten on
  UPDATE/DELETE; qualified `values` keys are rejected; `single-tenant` +
  `perTable[].tenant` is a fail-closed throw.
- Cache keys HMAC the claim profile AND fold in the compiled-policy digest (which
  covers tenancy, `securityColumns`, and `columnAllowlist`), and carry the plaintext
  `tenantId` as segment 3, so a cross-tenant or cross-policy cache-entry collision is
  not reachable. `sortedStringify` is the single canonicalizer for both hashes and the
  digest.

The findings below are the residual issues I could substantiate with a concrete
mechanism.

---

## Tier 1 — Security / correctness bugs with a clear repro

**None found.** I could not construct a repro for a SQL injection, a column/table
allowlist bypass, a cross-tenant read/write, or a cross-tenant cache collision against
the current source. The paths that historically carried those bugs (SELECT-\* on joined
tables, alias-vs-execution divergence, the mutationBuilder `typeof object` guard, the
Redis key-tag prefix) are closed and regression-pinned in the test suite.

---

## Tier 2 — Lower-severity real issues

### 2.1 — Joined-table region/department inheritance has no "tenant-only" opt-out; region/department-restricted callers cannot join tables that lack those columns

**Mechanism.** `resolveJoinSecurityColumns` (`shared/predicates.ts`) resolves a joined
table with no `perTable` entry to
`{ tenant: resolvedTenantColumn, region: config?.region ?? 'region_id', department: config?.department ?? 'department' }`
— i.e. it inherits **all three** dimensions, not just tenant. `applySecurityPredicates`
then emits, for that joined table, `WHERE joined.region_id IN (...)` and
`WHERE joined.department = ...` whenever the caller carries `regionIds` / `department`.
There is no way to express "scope this joined table by tenant but it has no region/
department column": a partial `perTable` override still defaults the missing names
(`override?.region ?? config?.region ?? 'region_id'`), and the only way to suppress the
region/department predicate is `perTable[table] = null`, which also drops the tenant
predicate (the fan-out protection).

**Trigger.** A caller with `regionIds` (or `department`) set runs a widget that JOINs a
table which carries `tenant_id` but not `region_id` / `department` (e.g. an audit-log or
line-item table), with no `perTable` entry for it.

**Consequence.** The emitted `WHERE joined.region_id IN (...)` references a non-existent
column → the widget fails with a DB error (fail-closed, so no leak, but the join is
unusable for every region/department-restricted user). The host's only escape is
`perTable[table] = null`, which re-opens the very cross-tenant fan-out the default
inheritance exists to prevent (if the join key is non-unique). The design conflates the
tenant fan-out concern (which genuinely warrants default inheritance) with region/
department scoping (which does not — and cannot be individually disabled).

Suggested direction: allow a per-table override to explicitly null out an individual
dimension (e.g. `perTable[table] = { region: null }`) so a joined table can stay
tenant-scoped while dropping region/department, without falling all the way to a fully
unscoped `null`.

### 2.2 — INSERT does not enforce region/department scope when the client omits the column

**Mechanism.** Tenant isolation on INSERT is enforced by force-stamping
(`buildInsertMutation` sets `values[cols.tenant] = claims.tenantId` unconditionally).
Region/department, by contrast, are only checked by `validateSecurityColumnValues`, and
that check is gated on the value being _present_:
`cols.region && claims.regionIds !== undefined && Object.prototype.hasOwnProperty.call(values, cols.region)`.
If the client simply omits `region_id` (and `department`) from `values`, no region/
department validation runs and nothing stamps them.

**Trigger.** A region-restricted caller (`regionIds: [5]`) issues
`{ operation: 'insert', table: 'orders', values: { status: 'x' } }` (no `region_id`).

**Consequence.** The row is inserted with the caller's tenant but a NULL / DB-default
region (and department). A caller authorized only for region 5 thereby creates a row that
does not belong to region 5 — escaping their own row-level read scope on the write path.
This is bounded to _within_ the tenant (tenant_id is still correctly stamped), so it is
not a cross-tenant leak, but it is a genuine row-level-security write gap: reads/updates/
deletes are region-scoped, yet a restricted user can mint region-unscoped rows that
region-unrestricted users in the tenant then see. Because the server cannot pick a region
for a multi-region caller, auto-stamping isn't always possible — but a single-region
caller could be stamped, and a caller with `regionIds` set arguably should be _required_
to supply an in-scope region on insert rather than silently allowed to omit it.

---

## Tier 3 — Architectural debt / hardening

### 3.1 — `in` / `between` filter values are not runtime-validated as arrays

`applyPredicate` (`shared/predicates.ts`) trusts the TypeScript shape of
`FilterPredicate.value`, which is not a runtime guarantee (the value is client JSON). For
`operator: 'in'` with a string value, `value.length === 0` is false for a non-empty
string, so `query.whereIn(column, 'abc')` is called with a non-array; for
`operator: 'between'` with a short/non-array value, `const [lo, hi] = value` yields
`undefined` bounds. Both remain parameterized (no injection) and cannot widen a
mutation (the write-path empty-`in` throw still fires for a true empty array), so this is
a robustness gap, not a security hole — but it surfaces as malformed SQL / a confusing DB
error rather than a clean "expected an array" rejection. A cheap `Array.isArray` guard on
these two operators would fail closed with a clear message, matching the fail-closed
posture used everywhere else.

### 3.2 — `tenantId` is used verbatim as a cache-key segment and as the prefix-index boundary

`generateCacheKey` builds `studio:v1:${claims.tenantId}:<securityHash>:<queryHash>`, and
`LRUCacheProvider.extractPrefix` derives the tenant-scoped invalidation prefix by scanning
to the **3rd colon**. A `tenantId` containing a `:` (e.g. `org:1234`) shifts every segment
boundary: the derived prefix becomes `studio:v1:org:` instead of `studio:v1:org:1234:`, so
`invalidatePrefix` can over-match (collapsing multiple tenants that share a colon-prefixed
id into one eviction bucket). This does **not** enable a cross-tenant data read — full keys
still differ, and the securityHash independently HMACs the tenantId — so it is a
prefix-invalidation-granularity bug, not a leak. If tenant ids can ever contain a colon,
either encode the tenant segment (e.g. URL-encode) or store the tenant boundary length
explicitly rather than recovering it by colon-counting.

### 3.3 — Demo `extractSecurityClaims` omits several standard JWT checks

`extractSecurityClaims` is explicitly documented as a demo to be replaced. Worth recording
for that replacement: it ignores the JWT `alg` header entirely and always recomputes
HS256 — which is actually _safe_ against algorithm-confusion (an attacker cannot force
`alg: none` or an RS/HS swap), but it also skips `nbf` (not-before), `aud`, and `iss`
validation, and accepts a token with no `exp` at all (the `exp` check is gated on
`payload.exp !== undefined`). A production IdP verifier (jose / jsonwebtoken) should cover
these. No action needed in this package beyond keeping the "replace in production" guidance
prominent.

### 3.4 — Minor inconsistency: output aliases are not charset-validated, aggregation aliases are

An expression-field output alias (`PlanProjectionColumn.outputAlias`, the client's logical
column id) reaches `db.raw('?? as ??', [physical, outputAlias])` without the
`SAFE_ALIAS_PATTERN` charset check that `agg.alias` gets. Both are `??`-bound and therefore
Knex-escaped, so neither is injectable — this is purely a consistency observation, not a
vulnerability. If the intent is defense-in-depth on every client-controlled identifier
token (as the aggregation-alias comment states), the output alias is the one such token
that skips it.
