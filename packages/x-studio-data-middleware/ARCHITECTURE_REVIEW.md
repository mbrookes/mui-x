# Architecture / Tech-Debt Review — `@mui/x-studio-data-middleware`

Independent review of `packages/x-studio-data-middleware/src`, verified against current source
(not `ARCHITECTURE.md`, which is treated as a possibly-stale map). Every finding cites
file:line and describes a concrete failure scenario.

Two sanity-checks requested up front, both verified against the real code:

- **"`buildSecureQuery`/`executeForTier`/`runPreflight` never call `resolveAlias`."** HOLDS.
  A grep for `resolveAlias` across `router/*.ts` finds only doc-comment mentions — the only
  runtime callers are `shared/columnValidation.ts` and `security/validateQueryPlan.ts`. The
  three enforcement functions read pre-resolved `ColumnRef`s off the plan. No stray direct call.
- **"Every mutation builder threads the SAME `CompiledSecurityPolicy`."** HOLDS.
  `handleMutation` (`mutations/handleMutation.ts:60`) compiles one `policy` and passes that exact
  object to `validateMutation` and all three builders (`:101, :111, :123, :128`).
  `validateMutation` and each builder call `resolvePrimaryCols(table, policy)` on the identical
  object, so no two builders in a batch can resolve security columns inconsistently.

---

## Tier 1: Correctness & Security

### 1.1 — Column allowlist is fully bypassed when `columns` is empty/omitted (`SELECT *`) — HIGH

**Files:** `router/execute.ts:69-74`; enabled by `security/types.ts:170` (`columns?` optional) and
`shared/columnValidation.ts:105-152` (only validates _referenced_ columns).

`executeForTier` only adds a projection when `queryPlan.columns.length > 0`. When a widget omits
`columns` (or sends `columns: []`), no `.select()` is ever called, so Knex emits `SELECT *` and
returns **every physical column of the table (and every joined table)** — including columns the
host deliberately kept out of `columnAllowlist`.

Failure scenario: host configures `columnAllowlist: { employees: ['id', 'name', 'department'] }`
to hide `salary`/`ssn`. A client POSTs `{ id: 'w', table: 'employees' }` with no `columns`.
`validateQueryPlan` finds nothing to validate (no columns/filters/orderBy referenced), passes, and
the client tier returns raw rows with all columns, `salary`/`ssn` included. The result is then
cached. The allowlist — whose stated purpose (`types.ts:437` "SECURITY INVARIANT #2") is to stop
column probing — provides zero projection protection in its most common bypass.

Fix sketch: when a `columnAllowlist` is configured, a widget with no explicit projection must
resolve to the allowlisted column set for its table(s) (i.e. synthesize the projection from the
allowlist, or reject an empty projection under an allowlist) rather than falling through to
`SELECT *`.

### 1.2 — Qualified `values` keys bypass tenant/region/department scope validation on mutations — HIGH

**Files:** `mutations/mutationBuilder.ts:63-106` (`validateSecurityColumnValues`) vs.
`:154-158` (`writableColumns` check) and `:177-185` (`buildInsertMutation`).

`validateSecurityColumnValues` detects the tenant/region/department columns by **exact key match**
(`Object.prototype.hasOwnProperty.call(values, cols.tenant)` where `cols.tenant` is the _unqualified_
name, e.g. `tenant_id`). The `writableColumns` check on the very next lines uses
`checkColumnAgainstAllowlist`, which **splits on the first dot** and validates `table.column`
against the named table. These two validators disagree about what a column key is.

Failure scenario (region bypass): caller has `regionIds: [5]`,
`writableColumns: { orders: ['*'] }` (or a list that includes `region_id`). Client sends
`insert` with `values: { 'orders.region_id': 6 }`.

- `validateSecurityColumnValues` looks for key `'region_id'`, finds only `'orders.region_id'`,
  so the "region outside caller scope" check is **skipped** — the row is stamped into region 6.
- `checkColumnAgainstAllowlist('orders.region_id', …)` splits to `orders`/`region_id` and passes.

The same trick bypasses the tenant-column-set rejection (`:68`): a client can send
`values: { 'orders.tenant_id': 'other-tenant' }`; the exact-key guard misses it, and
`buildInsertMutation` then separately sets the _unqualified_ `values['tenant_id']`, leaving the
client's dotted key in the insert payload as well (behavior then depends on how Knex renders a
dotted insert key — at best an error, at worst two tenant writes). The region/department path has
no compensating stamp, so region/department scope is genuinely defeated when `writableColumns`
permits the column.

Fix sketch: normalize `values` keys (strip/resolve the qualifier to the target table) **before**
`validateSecurityColumnValues` runs, so the scope check and the writable-columns check agree on the
column identity; or reject qualified keys in `values` outright (a mutation always targets one table).

### 1.3 — `orderBy.direction` is never runtime-validated — MEDIUM

**Files:** `router/execute.ts:80, :134`; type at `security/types.ts:252-255`.

`ob.direction` is forwarded straight into `query.orderBy(col, ob.direction)`. Its TypeScript type is
`'asc' | 'desc'`, but the value originates from client JSON and is never checked at runtime — unlike
`agg.alias` (regex-guarded in `validateAggregationAliases`) and filter operators (`SAFE_OPERATORS`),
both of which the package validates _precisely because_ "types are not runtime guarantees" (see
invariant 4 in `ARCHITECTURE.md`). Safety here rests entirely on the host's Knex version sanitizing
the direction token; the package itself applies no defense-in-depth for the one order-by token it
hands Knex. This is the same drift class the codebase otherwise guards obsessively.

Fix sketch: add a two-value allowlist check (`asc`/`desc`, case-insensitive) in `validateQueryPlan`
(or when building `PlanOrderBy`) and reject anything else, mirroring the `SAFE_OPERATORS` pattern.

### 1.4 — Public `securityColumns` JSDoc documents the OLD fail-OPEN join behavior — MEDIUM (doc, security-relevant)

**File:** `security/types.ts:477-479` (also shipped in `.d.ts` to consumers).

> "Joined tables without a `perTable` entry carrying a `tenant` column are treated as shared and
> receive no predicate."

This is the pre-hardening (fail-open) contract and directly contradicts the _current_ code:
`resolveJoinSecurityColumns` (`shared/predicates.ts:89-107`) now **inherits** the primary table's
security columns for an unregistered join (fail-closed) and only returns `undefined` for the explicit
`perTable[table] = null` opt-out. A host operator reading this JSDoc would believe an unregistered
joined table joins unscoped — the exact cross-tenant fan-out the hardening closed — and might design
their schema/config around a guarantee the code no longer makes (or, worse, a maintainer might "fix"
the code back to match the doc). The correct, fail-closed description already exists a few lines up
at `types.ts:74-83`, so the two blocks in the same file disagree.

Fix sketch: rewrite `:477-479` to match `resolveJoinSecurityColumns` (default inheritance =
fail-closed; `null` = opt-out).

### 1.5 — Demo JWT verifier ignores the JWT `alg` header — LOW (documented demo)

**File:** `security/extractSecurityClaims.ts:60-74`.

The verifier never inspects the header's `alg` field; it unconditionally recomputes HS256 and
compares. Because it _always_ uses HS256 regardless of what the token claims, the classic
`alg:none`/algorithm-confusion attacks do not actually succeed here (a forged `alg:none` token still
fails the HMAC compare). So this is not currently exploitable, and the file is explicitly labeled a
"demonstration implementation" to be replaced in production. Flagged only so the reviewer notes the
missing `alg` pin should NOT be copied into any real replacement. No code change required in this
package beyond the existing "replace me" guidance.

---

## Tier 2: Structural Duplication

### 2.1 — `sortedStringify` duplicated verbatim in two files — LOW/MEDIUM

**Files:** `security/cacheKey.ts:87-98` and `security/compileSecurityPolicy.ts:72-83`.

The same recursive, key-sorting canonical serializer is copy-pasted into both modules (identical
logic). Both feed security-critical hashes — the cache-key security hash and the policy digest.
If one copy is "improved" (e.g. to handle `undefined` vs. missing keys, or `Date`/`bigint`) and the
other is not, the digest and the cache key could canonicalize the same input differently. Since both
already live under `security/`, this should be one shared helper (e.g. `security/canonicalize.ts`).
Not a live bug today, but it is the precise "two independent copies free to drift" pattern the
package elsewhere treats as a defect.

### 2.2 — No other significant read/write duplication

Security-column resolution, predicate building, alias resolution, table-allowlist assertion, and the
column-allowlist check are all genuinely centralized (`shared/predicates.ts`,
`shared/columnValidation.ts`, `shared/assertTablesAllowed.ts`, `compileSecurityPolicy`,
`validateQueryPlan`) and consumed by both paths. The two Redis providers already share
`cache/redisCompat.ts`. Nothing else worth flagging here.

---

## Tier 3: God-Files / Cohesion

### 3.1 — `security/types.ts` (515 lines) mixes every wire + option type behind heavy prose JSDoc — LOW

**File:** `security/types.ts`.

It carries read wire types, mutation wire types, both handler option interfaces, the tenancy/security
config types, and multi-paragraph security essays inline. It is _cohesive_ (all are type
declarations) but it is the one file where a maintainer must scroll past unrelated concerns to find
a given type, and — per 1.4 — it is where a stale security paragraph hid. A light split
(`readTypes.ts` / `mutationTypes.ts` / `securityConfigTypes.ts`, re-exported from `types.ts`) would
localize each concern. Low priority; not blocking.

### 3.2 — Otherwise cohesion is good

Source modules are small and single-purpose (`preflight.ts` = COUNT only, `execute.ts` = projection,
`queryBuilder.ts` = predicates/joins, `tierDecision.ts` = routing). No god-file in the runtime path.
`handler.test.ts` is 1410 lines but that is a test file and is sectioned by `describe` blocks.

---

## Tier 4: Testing Gaps

### 4.1 — No test that a configured `columnAllowlist` restricts projection when `columns` is empty — HIGH

Directly tied to finding 1.1. The suite has "global aggregation (no columns)" (`handler.test.ts:939`)
but nothing asserting that a **non-aggregation** widget with an allowlist and no `columns` is
prevented from returning non-allowlisted columns. Because the behavior is currently `SELECT *`, a
test encoding the _intended_ guarantee would fail today and pin the fix. This is exploitable-if-
untested behavior with no coverage.

### 4.2 — No test for qualified `values` keys on mutations — HIGH

Directly tied to finding 1.2. `mutationBuilder.test.ts` covers qualified **WHERE** columns
(`:259`) but there is no case sending a qualified key inside `values` (e.g. `'orders.region_id'` or
`'orders.tenant_id'`). The tenant/region/department scope checks in `validateSecurityColumnValues`
are therefore never exercised against a qualified key, which is exactly where they fail open.

### 4.3 — `orderBy.direction` has no adversarial test — MEDIUM

Tied to 1.3. `preflight.test.ts` exercises ORDER BY column _qualification_ but no test feeds a
non-`asc`/`desc` direction to assert it is rejected (there is nothing to reject today).

### 4.4 — No end-to-end handler test for `tenancy: multi-tenant` + join + `perTable` opt-out/override — MEDIUM

`queryBuilder.test.ts:560-627` covers joined-table scoping (default inheritance, configured tenant
column, `perTable[table] = null` opt-out) at the `buildSecureQuery` unit level, and
`compileSecurityPolicy.test.ts` covers resolution parity. But there is no `handleBatchQuery`-level
test combining multi-tenant tenancy + a real JOIN + a `perTable` override (or `null` opt-out) that
asserts the _joined_ table's tenant predicate (or its deliberate absence) end-to-end through the
cache-key/preflight/execute pipeline. That is the specific combination the prompt calls out, and it
is only covered piecewise, not as an integrated path.

### 4.5 — Digest determinism is tested, but not "config that resolves identically yet serializes differently" — LOW

`cacheKeyPolicyDigest.test.ts` pins order-independence and default-digest behavior. It does not pin
the (benign) case where two syntactically different but semantically identical configs
(e.g. `perTable` absent vs. `perTable: {}`) produce different digests. This only costs a cache miss,
never a leak, so it is low priority — noted for completeness, not as a required test.

---

## Summary

The package's centralization work (single alias resolver, compiled policy threaded once, shared
predicate/allowlist helpers) is real and the two requested invariants both hold. The two most
serious remaining gaps are **fail-open by omission**: an empty projection escapes the column
allowlist via `SELECT *` (1.1), and qualified `values` keys slip past the mutation scope checks
because two validators disagree on what a column key is (1.2). Both are untested (4.1, 4.2). A stale
public JSDoc block (1.4) still advertises the pre-hardening fail-open join contract.
