# Architecture Review — `@mui/x-studio-data-middleware`

Fresh, independent adversarial review of the current source (read cross-file, not
trusting prior review summaries or `ARCHITECTURE.md` claims). Verified against the
actual code in `src/security/`, `src/router/`, `src/mutations/`, `src/cache/`,
`src/shared/`, plus the type/handler entry points.

Baseline confirmed green at review time:

- `tsc -p tsconfig.json` — no errors.
- `vitest --project "x-studio-data-middleware" --run` — 397 tests passed (17 files).

## Summary

The package is in strong shape. Every previously-hardened surface I re-checked
holds up under the actual code:

- **Tenancy is fail-closed** — `tenancy` is required with no default; the only
  unscoped path is an explicit `{ mode: 'single-tenant' }`, and
  `compileSecurityPolicy` throws on the `single-tenant` + `perTable[t].tenant`
  contradiction (`compileSecurityPolicy.ts:160-173`).
- **Joined tables inherit scope by default**; only `perTable[t] = null` opts out
  (`shared/predicates.ts:89-107`) — verified `buildSecureQuery` applies
  `forJoinedTable` per join (`router/queryBuilder.ts:114-116`).
- **HAVING operator lookup** is gated by an own-property check, closing the
  `Object.prototype` inherited-key bypass (`router/queryBuilder.ts:156`).
- **Non-aggregation query routed to the `db` tier** falls back to plain
  `select`/`orderBy`/`limit` rather than GROUP-BYing everything or emitting an
  unbounded `SELECT *` (`router/execute.ts:99-110`).
- **Region-scope value comparison** normalizes both sides to strings in the
  mutation value validator (`mutations/mutationBuilder.ts:120`).
- **Column allowlist is fail-closed** (no table entry → reject) and the
  `SELECT *` bypass is closed via `synthesizeProjectionFromAllowlist`
  (`security/validateQueryPlan.ts:204-226, 327-329`).
- **All values reach Knex via `?` bindings; all identifiers via `??` bindings,
  the object/alias-map aggregate form, or Knex identifier-quoting builder
  methods.** The three free-form client tokens (agg alias, ORDER BY direction,
  HAVING operator) are each constrained to fail-closed allowlists that run
  unconditionally.
- **Cache keys are HMAC'd and fold the compiled policy digest** (tenancy +
  securityColumns + columnAllowlist), so differently-scoped nodes never share
  entries and tightening the allowlist invalidates looser-allowlist results
  (`security/cacheKey.ts`, `security/compileSecurityPolicy.ts:105-114`). The
  query-shape hash includes `columnAliases`, so aliased queries can't collide.
- **Read/write predicate translation is genuinely shared** through
  `shared/predicates.ts`, with the empty-`in` (drop on read / throw on write) and
  empty-`regionIds` (`1=0` on read / throw on write) divergences the only
  deliberate ones.

I could not construct a working allowlist / tenant-scope / region-scope /
operator-allowlist bypass, an identifier-injection path, or a cross-tenant
cache-key collision against the current code.

---

## Tier 1 — Correctness & Security

**No actionable findings.**

I specifically tried and failed to break:

- Column-allowlist evasion via `columnAliases` (every resolution funnels through
  the one `resolveAlias`, and `checkColumnAgainstAllowlist` validates whatever
  physical column comes out; join `on` validates the right side against the
  _joined_ table).
- Identifier injection through `qualify()`'s `` `${table}.${col}` `` strings —
  they are handed to Knex builder methods that identifier-quote them, and without
  a `columnAllowlist` the deployment has explicitly opted out of column-level
  restriction (a documented, discouraged posture) while Knex escaping still
  blocks raw-SQL injection.
- HAVING reaching a raw column or an inherited `opMap` member (own-property gate
  - `validateHavingAliases`).
- Scope escalation via mutation `values` (tenant rejected/stamped, region/dept
  validated fail-closed, table-qualified keys rejected before the bare-name scope
  check).
- Tier/data cache collisions across tenants or policies (tenant is a literal key
  segment; policy digest is folded into the HMAC'd security hash; both caches key
  off the same `generateCacheKey`).

---

## Tier 2 — Design smells

### 2.1 The security WHERE predicate assumes a numeric region column, while the mutation value-validator explicitly supports a TEXT region column

`validateSecurityColumnValues` normalizes both sides to strings precisely because
"a deployment whose region column is TEXT-typed sends a string region value"
(`mutations/mutationBuilder.ts:113-126`). That deployment shape is therefore an
explicitly-supported case.

But the actual row-level-security **predicate** emits a raw numeric binding for
both reads and writes:

```ts
// shared/predicates.ts:156
query.whereIn(`${table}.${securityColumns.region}`, claims.regionIds); // number[]
```

`claims.regionIds` is `number[]`. For a TEXT-typed region column, `region_id IN
(5)` is DB-dependent: PostgreSQL raises a type error (`operator does not exist:
text = integer`), which surfaces as a per-widget error / failed mutation; MySQL
and SQLite coerce. So the exact TEXT-region deployment the value-validator was
written to accommodate would see scoped reads/writes error out or behave
inconsistently.

This is **not a security leak** — it fails closed (errors or under-matches, never
over-matches). It is an internal inconsistency: one part of the region-scope
handling anticipates TEXT columns and another does not. Low confidence /
environment-dependent (the in-memory `mockDb` and the SQLite-oriented benchmarks
never exercise a TEXT region column), but worth reconciling — either normalize the
predicate the same way, or document that region columns must be numeric and drop
the string-normalization in the value validator so the two halves agree.

---

## Tier 3 — Minor / cosmetic

### 3.1 `limit: 0` is treated as "no limit" (returns all scoped rows)

`router/execute.ts` gates the LIMIT clause on truthiness in all three tier
branches:

```ts
if (queryPlan.limit) {
  query.limit(queryPlan.limit);
}
```

(`execute.ts:82-84`, `106-108`, `174-176`.) A client sending `limit: 0` (a
plausible "return zero rows" request) gets **every** matching row instead. The
result is still tenant/region-scoped, so this is not a security issue — just an
over-return edge case. If `limit: 0` is meaningful in this API, use
`queryPlan.limit !== undefined` (and ideally validate `limit` is a non-negative
integer). If it isn't meaningful, no change needed.

### 3.2 Unreachable `default: break` in `applyPredicate`

`shared/predicates.ts:236-237` has a `default: break` at the end of the operator
`switch`, but every reachable operator is a member of `SAFE_OPERATORS` (checked at
the top of the function, throwing otherwise) and each has an explicit `case`. The
`default` arm is dead. Harmless defensive code — noted only for completeness; safe
to leave or remove.

---

## Notes on documented tradeoffs (verified, NOT re-flagged)

Per the review brief, these are documented deliberate choices and I confirmed the
code matches the documentation rather than treating them as defects:

- **`db: any` duck typing** — no literal `knex` import in `src/`; `knex` is a
  peer/dev dependency only (verified against `package.json`).
- **Batch-level rejection vs per-item execution isolation** — reads run in
  parallel with per-widget `{ error }` isolation; writes run sequentially (for
  `[insert, update-that-row]` determinism) with per-item isolation. Matches
  `handler.ts` / `handleMutation.ts`.
- **Region/department join-inheritance semantics** and the `perTable[t] = null`
  opt-out — matches `resolveJoinSecurityColumns`.
- **Three independent tier-cache TTL defaults** (handler 30s explicit vs provider
  300s standalone) — accurate as documented; handler always passes its TTL
  explicitly.
- **`sortedStringify` array-order-significant / `undefined`≠`null` semantics** —
  single shared serializer feeding both cache hashes and the policy digest.
- **`toValidatedQueryPlan` / `toCompiledSecurityPolicy` dual-acceptance skipping
  validators on the raw-descriptor branch** — deliberate for direct/test callers;
  the request path always threads pre-validated artifacts.
