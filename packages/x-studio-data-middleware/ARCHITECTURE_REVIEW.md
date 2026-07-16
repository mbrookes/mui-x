# Architecture & Correctness Review — `@mui/x-studio-data-middleware`

Fresh, clean-slate review of `packages/x-studio-data-middleware/src/**`. Scope: SQL
construction, tenant/row-level isolation, cache-key scoping, allowlist enforcement,
mutation write-path guards, cache providers.

**Tiers: 0/0/2**

This is the fourteenth from-scratch review, and — consistent with the prior thirteen —
it surfaces **no Tier 1 (security) and no Tier 2 (robustness/correctness) findings**.
The two Tier 3 items below are low-impact consistency/hardening observations, neither
reachable as a defect through the public API. I verified every client-controlled
identifier and value path end-to-end rather than pattern-matching; the summary of that
verification is in the "What was verified" section so the null result is auditable.

---

## Tier 1 — Security / correctness bugs

None.

## Tier 2 — Robustness / consistency

None actionable.

## Tier 3 — Minor / consistency / hardening

### 3.1 — Filter/limit value _shape_ guards are incomplete relative to the `in`/`between` precedent

**Where:**

- `src/shared/predicates.ts:394-396` (`like`), `:349-393` (`eq`/`neq`/`lt`/`lte`/`gt`/`gte`)
- `src/router/execute.ts:96-98`, `:121-123`, `:190-192` (`limit`)

**What:** `FilterPredicate.value` and `descriptor.limit` are client JSON, so their
TypeScript types are not runtime guarantees. The package already recognizes this and
fails closed with a clear message for two cases: `in` requires `Array.isArray(value)`
(`predicates.ts:362-368`) and `between` requires a two-element array
(`predicates.ts:402-410`). The remaining value-bearing operators do **not** get an
analogous shape guard:

- `like` (`predicates.ts:395`) passes `value` straight to `query.whereLike(column, value)`.
  A non-string value (`{operator:'like', value:['a','b']}` or an object) reaches Knex as a
  malformed-but-still-parameterized binding, surfacing as a confusing DB error rather than
  the clear "expected a string" message the `in`/`between` guards produce.
- The scalar comparison operators (`eq`/`neq`/`lt`/…) similarly accept any JSON value; a
  bare object or `undefined` reaches `.where(col, op, value)` and produces a raw Knex
  "Undefined binding(s)" / type error.
- `limit` is gated only on `!== undefined` (`execute.ts:96`), never coerced/validated to a
  non-negative integer. A malformed `limit` (string, object, negative) is handled entirely
  by Knex's own `.limit()` coercion, whose behavior varies by dialect (typically ignored
  with a logged warning, i.e. "no limit").

**Why it matters:** This is **not** a security issue — every value stays parameterized, so
there is no injection, and none of these cases crosses a tenant boundary. It is a
consistency/robustness gap: the package deliberately established the "guard the client-JSON
value shape and throw a clear, per-widget error" pattern for `in`/`between`, and `like`,
the scalar operators, and `limit` are the tokens that skipped it. Worst case today is a
degraded error message (per-widget-isolated) or, for a malformed `limit`, silently
returning all _tenant-scoped_ rows instead of the requested page.

**Fix:** Mirror the existing guards. In `applyPredicate`, add `typeof value === 'string'`
(or scalar) checks for `like` / scalar operators with the same "MUI X Studio Server: …
requires a … value, but received …" message shape used by `in`/`between`. For `limit`,
validate `Number.isInteger(limit) && limit >= 0` in `validateQueryPlan`/`buildPlan` (the
unconditional-validator stage) and throw fail-closed otherwise, so a malformed limit
becomes a per-widget `{ error }` rather than a silent full-scope read.

### 3.2 — Mutation _builder_ defense-in-depth is narrower than `validateMutation` for present, out-of-scope region/department values

**Where:** `src/mutations/mutationBuilder.ts:304-329` (`buildInsertMutation`),
`:342-372` (`buildUpdateMutation`); the out-of-scope-value check lives only in
`validateSecurityColumnValues` (`:91-161`), called only from `validateMutation` (`:274`).

**What:** The builders re-apply _some_ row-level-security guards independently of
`validateMutation`, as documented defense-in-depth: `buildInsertMutation` force-stamps the
tenant column (`:317-319`) and re-runs `resolveInsertScopeStamps` (`:326`, which throws on
an _omitted_ region when the caller has zero/many regions); `buildUpdateMutation` strips the
tenant column (`:367-369`) and re-runs the security predicates. But neither builder re-runs
`validateSecurityColumnValues`, so a **present** out-of-scope value in `values` — e.g.
`{region_id: 999}` from a caller scoped to region 5 — is caught _only_ by
`validateMutation`. `resolveInsertScopeStamps` skips a region that is already present
(`:198-199`), and `buildUpdateMutation` performs no value-scope check at all, so a direct
builder call bypassing `validateMutation` would insert/update a row into region 999.

**Why it matters:** This is **not reachable through the public API.** The builders are not
exported (`index.ts` exports only `handleBatchQuery`/`handleMutation`), and
`handleMutation`→`processMutation` _always_ calls `validateMutation` before dispatching to a
builder (`handleMutation.ts:117-121`), which is where `validateSecurityColumnValues` runs.
So on every production path the present-value scope check does execute. The observation is
that the builders' _stated_ defense-in-depth posture (re-stamp/re-scope so a direct caller
can't escape) is asymmetric: it covers tenant (both ops) and region/department _omission_
(insert) but not region/department _present-out-of-scope_ (either op). It is a hardening
gap for hypothetical internal/test callers, not a live vulnerability.

**Fix (optional hardening):** Have `buildInsertMutation` and `buildUpdateMutation` call
`validateSecurityColumnValues(values, claims, cols)` after resolving `cols`, so the
present-value scope check is enforced at the builder boundary too — making the builders'
defense-in-depth symmetric with `validateMutation` and closing the internal-caller gap.
Alternatively, tighten the ARCHITECTURE/builder docs to state precisely which guards the
builders re-apply (tenant + insert-omission only), so the defense-in-depth claim is not
read as broader than it is.

---

## What was verified (basis for the zero Tier 1/2 result)

- **Every client-controlled identifier reaching SQL is Knex-escaped**, not string-spliced:
  `execute.ts` `qualify()` → `.select`/`.groupBy`/`.orderBy`; `db.raw('?? as ??', …)` for
  aliased projections (both `??`-bound, output alias additionally charset-checked by
  `validateOutputAliases`); `havingRaw('FUNC(??) op ?', …)` with `FUNC`/`op` from
  own-property-gated maps and column `??`-bound; `query.sum({[alias]: col})` object-form
  aggregates; join `.on(qualifiedLeft,'=',qualifiedRight)`; security predicates
  `.where`/`.whereIn`/`.andOnVal`/`.andOnIn`. No raw concatenation of a client value into
  SQL text exists anywhere.
- **Column-allowlist coverage is complete and fail-closed.** `validateDescriptorColumns`
  covers columns, filters, orderBy (aggAlias-exempt, and the alias is charset-checked +
  its underlying column allowlist-checked), aggregations, and both sides of every `join.on`
  pair (left→primary, right→joined). `checkColumnAgainstAllowlist` and
  `synthesizeProjectionFromAllowlist` are `hasOwnProperty`-gated; the `['*']` opt-out
  synthesizes `<table>.*` (primary-only) so joined columns can't leak past a stricter join
  allowlist. HAVING can only reference a declared aggregation alias
  (`validateHavingAliases`, unconditional). No client column reference reaches Knex without
  passing this stage when an allowlist is configured.
- **Tenant/row-scope isolation holds on both paths.** `applySecurityPredicates` is applied
  first and unconditionally; the `region` `undefined`-vs-`[]` and `department`
  `undefined`-vs-`''` distinctions fail closed (`1=0` on read, throw on write for empty
  region); outer-join nullable-side predicates correctly move to the ON clause via one
  shared `emitSecurityPredicates`; region matching emits both numeric and string forms for
  TEXT/NUMERIC column parity. Writes force-stamp/strip tenant, reject qualified `values`
  keys, and validate present + omitted region/department scope (`handleMutation` path).
  `compileSecurityPolicy` fails closed at runtime on an empty/whitespace/non-string
  tenant/dimension column and on the single-tenant + `perTable.tenant` contradiction.
- **Cache keys are fully tenant/user/policy-scoped.** `generateCacheKey` HMACs
  `{tenantId, regionIds(sorted), department, policyDigest}` (the digest folding
  tenancy + securityColumns + columnAllowlist through the single shared `sortedStringify`),
  URL-encodes the tenant segment so a colon can't shift prefix boundaries, throws on a
  missing HMAC secret (inside `processWidget`'s try for per-widget isolation), and the memo
  is keyed by `(secret, profile)`. The tier plane is namespaced with `tier:` so it can't
  collide with the data plane on a shared store. `regionIds` is normalized to `number[]` at
  the claims boundary so the sort comparator can't fragment keys. No path lets one tenant's
  claims produce another tenant's key or read another tenant's entry.
- **Cache invalidation is correctly scoped.** Data entries are tagged with primary + all
  joined tables; `deleteByTag` (LRU forward/reverse index; Redis forward/reverse SET index
  with expiry-extend-never-shorten) evicts exactly the matching keys.
  `invalidatePrefix` escapes Redis glob metacharacters on both providers so a tenant id
  containing `*`/`?`/`[` can't over-evict. The tier cache's non-invalidation on write is
  correctly documented as a best-effort `rowCount` (rows are always re-read fresh).
- **Per-widget/per-mutation isolation invariants hold** as documented (validation moved
  inside `processWidget`'s try; reads parallel with `{error}` isolation; writes sequential
  with `{ok:false}` isolation; cache get/set/deleteByTag failures degrade rather than
  fail/poison). None of the recently-hardened items (per-widget table+plan validation,
  `escapeRedisGlob` on both providers, best-effort tier `rowCount`) is a regression.
