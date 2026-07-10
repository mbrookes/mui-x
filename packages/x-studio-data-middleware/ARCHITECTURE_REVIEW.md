# Architecture Review — iteration 8 (fresh, ground-up)

Scope: every file under `packages/x-studio-data-middleware/src/`, cross-checked against
`ARCHITECTURE.md`. No findings carried over from prior rounds; every invariant was re-derived
from the current source. All SQL-rendering claims below were verified against **real Knex**
(`knex@^3.1.0`, `pg` dialect, `.toString()`/`.toSQL()`), and the availability claims were
verified by driving `handleBatchQuery` end-to-end against the package's own `mockDb` with
deliberately-throwing cache providers.

**Result: 0 Tier 1 findings, 2 Tier 2 findings, 3 Tier 3 notes.**

---

## Tier 1 — security (0 findings)

None found. What was specifically re-verified, and how:

1. **Zero-Knowledge Rule (table allowlist).** `assertTablesAllowed`
   (`src/shared/assertTablesAllowed.ts`) runs before any query is built, over the whole batch,
   covering `widget.table` + every `joins[].table` on reads (`handler.ts:80-86`) and every
   `mutation.table` on writes (`handleMutation.ts:75-78`). Traced every `db(...)` construction
   site — `buildSecureQuery` (`queryBuilder.ts:73`), `buildInsertMutation`/`buildUpdateMutation`/
   `buildDeleteMutation` (`mutationBuilder.ts:328,348,388`) — all reachable only through the two
   handlers' post-allowlist paths (direct exports of the builders exist for tests, but the
   package's public `index.ts` exports only the two handlers plus cache/claims utilities).
   A table referenced _only_ via a qualified column string (`other.col` in a filter/where) is not
   in the FROM clause, so it renders as a dangling qualified reference that every mainstream DB
   rejects — fail-closed, no data path.
2. **Column allowlist / writableColumns.** `validateQueryPlan` runs `validateDescriptorColumns`
   over `columns`, `filters`, `orderBy` (with the documented agg-alias exemption), `aggregations`,
   and both sides of every `join.on` pair (left vs. primary table, right vs. joined table);
   `validateMutation` checks `where[].column` (columnAllowlist) and `values` keys
   (writableColumns) through the same `checkColumnAgainstAllowlist`. Both lookups —
   `resolveAlias`'s `columnAliases` and `checkColumnAgainstAllowlist`'s `allowlist[table]` — are
   own-property-gated, so prototype-chain keys fail closed. The `SELECT *` bypass stays closed:
   `synthesizeProjectionFromAllowlist` throws on a missing entry, emits `<table>.*` for `['*']`,
   and projects exactly the allowlisted columns otherwise. Alias resolution funnels through the
   single `resolveAlias`, and execution reads only pre-resolved `ColumnRef`s off the
   `ValidatedQueryPlan`, so validation and execution structurally cannot diverge.
3. **Row-level security (tenancy / regionIds / department).** One shared
   `emitSecurityPredicates` (`shared/predicates.ts:240-291`) drives both WHERE and ON placement.
   Re-rendered with real Knex: INNER joins scope both tables in WHERE; a LEFT join's joined table
   and a RIGHT join's primary table are scoped inside that join's ON via `andOnVal`/`andOnIn`
   (values parameterized), with the non-nullable side still in WHERE — confirmed for all three
   join types. `regionIds: []` renders `1 = 0` on reads and throws on writes;
   `department: ''` emits a real predicate; region values are emitted in both numeric and string
   form (`in (5, '5')`), matching the mutation value-validator. Joined tables inherit the primary
   table's resolved columns unless explicitly opted out (`perTable[t] = null` whole-table, or
   per-dimension `null`), and `compileSecurityPolicy` throws on the single-tenant +
   `perTable[t].tenant` contradiction.
4. **Write-path scope.** INSERT force-stamps the tenant column and applies
   `resolveInsertScopeStamps` (single-region auto-stamp, otherwise throw on omission); UPDATE
   strips the tenant column from `values`; UPDATE/DELETE apply `applySecurityPredicates` in
   `'write'` mode before user WHERE; client-supplied region/department values are scope-validated
   (non-scalar region rejected before the string-normalized comparison); table-qualified `values`
   keys are rejected in `validateMutation` _and_ again in the insert/update builders.
5. **Raw-SQL surface.** Every value reaches Knex via `?` bindings or builder methods; every
   identifier via `??`, the object/alias-map aggregate form, or builder methods. The free-form
   client tokens that reach interpolated positions are all charset/allowlist-gated
   unconditionally: `agg.alias` and renamed-projection `outputAlias` (`SAFE_ALIAS_PATTERN`),
   `orderBy[].direction` (`asc|desc`), HAVING operator and func (own-property-gated fixed maps).
   `applyHaving` re-emits `FUNC(??) op ?` with only fixed tokens interpolated.
6. **Cache-key isolation.** `generateCacheKey` = `studio:v1:<encodeURIComponent(tenant)>:
<HMAC(claims+policyDigest)>:<sha256(descriptor sans id)>`; the policy digest covers `tenancy`,
   `securityColumns`, and `columnAllowlist`; the tier plane is namespaced with `tier:`
   (`handler.ts:185`); throws on an empty HMAC secret. Read-cache entries are tagged with the
   primary _and_ every joined table, and every successful mutation calls
   `deleteByTag(descriptor.table)` — no successful write path skips invalidation.
7. **Iteration 7's filter-qualification fix introduces no new ambiguity or bypass.** Verified by
   render: an unqualified resolved filter column is prefixed with the primary table
   (`"orders"."region_id" = 9` under a join), a client-qualified (`customers.x`) or
   alias-resolved-to-qualified column is left untouched, and the qualification happens _after_
   allowlist validation of the identical resolved column (`validateDescriptorColumns` checks
   unqualified filter columns against the primary table — the same table the qualification pass
   prefixes, so validation and execution agree). A filter that legitimately targets a joined
   table must be qualified (directly or via a `columnAliases` entry mapping to
   `customers.col`), which both validates and executes against the joined table. Expression-field
   filters resolve through `resolveAlias` before qualification, so a logical id mapping to a
   qualified physical column is preserved as-is.

---

## Tier 2 — correctness / robustness (2 findings)

### 2.1 Tier-cache I/O is not failure-isolated: a down tier-cache backend fails every non-aggregation widget instead of degrading to the preflight

- **Where:** `src/router/tierDecision.ts:93` (`await tierCacheProvider.get(cacheKey)`) and
  `src/router/tierDecision.ts:104` (`await tierCacheProvider.set(...)`), reached from
  `src/handler.ts:181-190`.
- **What's wrong:** Finding 2.6 (iteration 6) established the availability posture "the cache
  sits in front of, not instead of, the authoritative DB" and wrapped the **data** cache's
  `get` (`handler.ts:147-156`) and `set` (`handler.ts:222-234`) in their own `try`/`catch`,
  degrading a throwing backend to a miss / an uncached-but-served result. The **tier** cache got
  no such guard: `decideTierWithCache` awaits `tierCacheProvider.get()` and `.set()` bare, and
  the only enclosing `try` is `processWidget`'s outer catch-all, which converts the throw into a
  per-widget **error result** (`{ rows: [], tier: 'db', rowCount: 0, error }`).
- **Concrete failure scenario (verified end-to-end):** a multi-node host wires
  `RedisTierCacheProvider` (typically on the same Redis as the data cache). Redis goes down.
  The data-cache `get` throws → correctly degraded to a miss → execution proceeds to
  `decideTierWithCache` → the tier-cache `get` throws → the widget fails. Driving
  `handleBatchQuery` against `mockDb` with a throwing tier provider returns
  `{ id: 'w1', rows: [], tier: 'db', rowCount: 0, error: 'redis tier cache down' }`, while the
  identical widget with (only) a throwing **data** cache returns the full rows from the DB. So
  the exact outage class finding 2.6 was written for still takes down every non-aggregation
  widget — the DB is healthy, the preflight could have run, and even the `.set()` failure case
  (line 104) discards a **preflight decision already in hand**. Aggregation widgets are immune
  only because they bypass the tier cache entirely.
- **Fix direction:** mirror the data-cache guards. In `decideTierWithCache`, wrap the `get` in
  `try`/`catch` (treat a throw as a tier-cache miss, `console.warn` once per call) and the `set`
  in `try`/`catch` (warn and return the already-computed decision). Doing it inside
  `tierDecision.ts` keeps the posture with the plane it protects; alternatively `handler.ts`
  could pass a fault-tolerant wrapper. Add a `handler.test.ts` case: throwing
  `tierCacheProvider.get`/`.set` still serves rows from the DB (the current suite covers
  throwing `cacheProvider` only).

### 2.2 Renamed (expression-field) projection columns are the last unqualified read-path column reference — ambiguous-column error under a join, in all three tiers

- **Where:** `src/router/execute.ts:62-65` (`projectColumn`:
  `db.raw('?? as ??', [col.physical, col.outputAlias])` — no `qualify()` on the physical
  column), used at `execute.ts:79` (client/server tier), `execute.ts:109` (db-tier
  non-aggregation fallback), and `execute.ts:131` (db-tier dimension SELECT).
- **What's wrong:** iteration 7's finding 2.1 closed "the sole" unqualified read-path column
  reference (user filter predicates) and `ARCHITECTURE.md` now states the convention as "every
  OTHER column reference on the read path is table-qualified ... SELECT / GROUP BY / ORDER BY /
  aggregations (`execute.ts`'s `qualify()`)". That claim is only true for the **non-renamed**
  projection branch. A `PlanProjectionColumn` with an `outputAlias` (a `columnAliases` entry
  whose logical id differs from its physical column — the standard expression-field shape) emits
  its physical column into `?? as ??` **without** qualification. Real-Knex render, `pg` dialect,
  descriptor `{ columns: ['revenue', 'status'], columnAliases: { revenue: 'total' }, joins:
[customers] }`:

  ```sql
  select "total" as "revenue", "orders"."status" from "orders"
    inner join "customers" on ... where "orders"."tenant_id" = 't1' ...
  ```

  The direct column is qualified (`"orders"."status"`); the renamed one is not (`"total"`). The
  db tier is inconsistent with itself: the same plan renders
  `select "created_month" as "month", sum("orders"."total") as "sum_total" ... group by
"orders"."created_month"` — the dimension is qualified in GROUP BY but not in SELECT.

- **Concrete failure scenario:** a dashboard defines an expression field
  `revenue → total` on `orders` and the widget joins `customers`, which also has a `total`
  (or `name`, `status`, `amount`, `created_month`, …) column. Postgres/MySQL reject the query —
  `42702 column reference "total" is ambiguous` — and the widget errors, exactly the failure
  mode iteration 7 fixed for filters. Fail-closed (no leak: the allowlist already validated the
  resolved column against the primary table), but a real correctness gap in the shipped
  qualification convention, and the reason it survived four review rounds is the same one the
  doc records for finding 2.5: `mockDb` is not a real SQL engine and never merges joined
  columns, so no test can hit the ambiguity.
- **Fix direction:** in `projectColumn`, qualify the physical column before binding:
  `db.raw('?? as ??', [qualify(col.physical), col.outputAlias])`. Verified render:
  `db.raw('?? as ??', ['orders.total', 'revenue'])` → `"orders"."total" as "revenue"` (Knex
  splits dotted `??` identifiers correctly), and the output row key (`revenue`) is unchanged, so
  client row shapes are unaffected. An alias target already qualified by the client
  (`customers.country`) contains a `.` and passes through untouched, preserving joined-table
  expression fields. One helper covers all three tier call sites. Add a regression to
  `src/router/__tests__/execute.test.ts` (the recording-builder suite added for the `orders.*`
  wildcard — the same technique works here since `mockDb` can't), pinning
  `raw('?? as ??', ['orders.total', 'revenue'])`-shaped output under a join. Update the two
  `ARCHITECTURE.md` passages that currently overstate the convention (the finding-2.1 paragraph
  under "buildSecureQuery" step 3, and the `executeForTier` bullet under "Query path in
  detail"), which this review counts as a stale-doc-claim side of the same finding.

---

## Tier 3 — minor notes (verified, low priority; recorded so the next round doesn't re-derive them)

1. **Tier-cache entries are not threshold-scoped.** `decideTierWithCache` returns
   `cached.tier` verbatim on a hit (`tierDecision.ts:95`). The cache key
   (`tier:` + `generateCacheKey`) covers claims/policy/query shape but not
   `options.thresholds`, so two callers sharing the default tier cache with different thresholds
   (or a host changing thresholds mid-rollout) serve each other's tier decisions for up to
   `tierCacheTtlMs`. The entry already stores `rowCount`; recomputing
   `tierFromRowCount(cached.rowCount, thresholds)` on hit instead of trusting `cached.tier`
   would make the cache threshold-agnostic for free (rows served are identical either way —
   only the reported tier/caching behavior drifts).
2. **Two RIGHT JOINs re-open the finding-2.3 row-drop in composition.** Verified render: with
   `joins: [customers(right), regions(right)]`, `customers` is scoped in WHERE
   (`where "customers"."tenant_id" = 't1'`), but `customers` sits on the nullable side of the
   _second_ right join, so a preserved `regions` row (NULL-extended `customers`) is dropped —
   the same silent outer→inner degradation finding 2.3 fixed for the single-join case.
   Fail-closed (rows dropped, never leaked) and requires a widget with ≥2 right joins, which the
   Studio client never emits today. If multi-outer-join descriptors ever become reachable, the
   nullable-side computation needs to consider join order, not just each join's own type.
3. **An empty `join.on: []` renders a joint with no ON condition.** Verified render (inner join,
   multi-tenant): `select * from "orders" inner join "customers" where "orders"."tenant_id" =
't1' and "customers"."tenant_id" = 't1'` — a syntax error on Postgres, an implicit
   tenant-scoped CROSS JOIN on MySQL (row-count blowup, no cross-tenant exposure since both
   tables stay scoped). Rejecting `on.length === 0` in `validateQueryPlan` (fail-closed, clear
   message) would make the behavior dialect-independent.

---

## Doc cross-check

`ARCHITECTURE.md` is accurate against the current source with one overstatement, folded into
finding 2.2 above: the claim that every read-path column reference other than (pre-iteration-7)
filters is table-qualified via `execute.ts`'s `qualify()` — the renamed-projection
(`outputAlias`) branch of `projectColumn` is not. All other spot-checked claims (tier-cache key
namespacing, default-cache sharing between handlers, ON-clause outer-join placement, HAVING
re-emission, `ttlMs: 0` flooring, region numeric+string matching, insert scope stamps,
own-property gating sites, `SINGLE_TENANT_POLICY_DIGEST` default) match the code as written.

## Verification artifacts

- Real-Knex renders (pg dialect) for: aliased projection under join (finding 2.2, both
  client/server and db tiers), the dotted-`??` fix shape, iteration-7 filter qualification
  (regression-checked, still correct), LEFT/RIGHT ON-clause security placement, two-right-join
  composition, and the empty-`on` join.
- End-to-end `handleBatchQuery` runs against `src/__tests__/mockDb.ts` demonstrating the
  throwing-tier-cache widget failure vs. the throwing-data-cache graceful degradation
  (finding 2.1).
