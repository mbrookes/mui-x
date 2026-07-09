# Architecture Review — iteration 6 (fresh, from-scratch)

Scope: every file under `packages/x-studio-data-middleware/src`, cross-referenced against
`ARCHITECTURE.md`. All findings below were verified by tracing the current source, not carried
over from prior rounds.

**Headline: zero Tier 1 findings.** The security core held up again under a fresh review:

- Every client-supplied _value_ reaches Knex through a `?` binding; every client-supplied
  _identifier_ goes through `??` bindings, Knex's alias-map/builder methods, or a fail-closed
  charset/allowlist check first (`SAFE_ALIAS_PATTERN`, `SAFE_OPERATORS`, `validateOrderByDirections`,
  the `applyHaving` own-property-gated opMap). I found no string-concatenated SQL path.
- Tenant/region/department predicates are applied first, from one shared implementation, on both
  read and write paths; joined tables are scoped by default; `regionIds: []` vs `undefined` and
  `department: ''` vs `undefined` are handled fail-closed; INSERT force-stamps tenant and
  fail-closes omitted region/department; UPDATE strips the tenant column.
- Cache keys HMAC the claims and fold in the policy digest; the tenant segment is URL-encoded;
  I could not construct a cross-tenant cache read or a key collision across tenants/policies.

What remains is a set of Tier 2 correctness/staleness bugs (none of which cross a tenant
boundary) and Tier 3 polish items.

---

## Tier 2 — correctness / staleness bugs worth fixing

### 2.1 Data cache and tier cache share the exact same key string → Redis plane collision

**Where:** `src/handler.ts:152` (one `cacheKey` per widget), `src/handler.ts:182-189` (that same
key passed to `decideTierWithCache`), `src/router/tierDecision.ts:78,89`
(`tierCacheProvider.get/set(cacheKey)`), `src/cache/RedisTierCacheProvider.ts:113`
(`prefix` defaults to `''`), and the **"Combining with RedisCacheProvider"** docblock example at
`src/cache/RedisTierCacheProvider.ts:49-62`, which constructs both providers on one Redis client
with **no `keyPrefix` on either**.

**Trace:** `processWidget` uses one `generateCacheKey(...)` result both as the data-cache key and
as the tier-cache key. With the in-process providers this is harmless (two separate stores). With
the documented combined-Redis setup, both providers write to the _same Redis key_
`studio:v1:<tenant>:<sec>:<query>`: `decideTierWithCache` SETs a `TierEntry` JSON, then the data
cache SET overwrites it with a `CacheEntry` JSON (and the data TTL).

**Failure scenarios:**

1. The tier cache silently never works — every data-cache write clobbers the tier entry, so after
   data-TTL expiry the tier entry is gone too and the COUNT(\*) preflight re-runs every time. The
   entire point of the second plane ("longer-lived tier decisions") is defeated, with no error.
2. Race window: between the tier-cache SET and the data-cache SET, a concurrent request's
   data-cache `get` JSON-parses the `TierEntry` as a `CacheEntry`: `cached` is truthy,
   `cached.rows` is `undefined`, and `handler.ts:159-172` returns `{ rows: undefined, tier,
rowCount }` — a malformed widget result shipped to the client.
3. Symmetrically, a tier-cache `get` can parse a `CacheEntry` as a `TierEntry` and read
   `tier`/`rowCount` off it — plausible-looking garbage routing.

**Fix direction:** namespace the planes structurally — e.g. `RedisTierCacheProvider` defaults its
`keyPrefix` to `'tier:'`, or (better, provider-independent) `decideTierWithCache`/`handler.ts`
prefixes the tier key (`` `tier:${cacheKey}` ``) so no provider pairing can ever collide. Fix the
docblock example either way, and add a test that the two planes use distinct keys.

### 2.2 `handleMutation` cannot invalidate the read path's default cache → guaranteed staleness for zero-config hosts

**Where:** `src/handler.ts:51-59` (`getDefaultCache()` module singleton used when
`options.cacheProvider` is omitted) vs `src/mutations/handleMutation.ts:151-153`
(`if (cacheProvider) { await cacheProvider.deleteByTag(...) }` — no default, silently skipped).

**Trace/repro:** a host that calls both `handleBatchQuery` and `handleMutation` without passing a
`cacheProvider` (the simplest possible integration; `index.ts`'s own usage example passes none)
gets reads cached in `handler.ts`'s private singleton `LRUCacheProvider`, while every mutation
skips invalidation entirely — `handleMutation` has no access to that singleton. Sequence: read
widget over `orders` (cached, 30s TTL) → `handleMutation` insert into `orders` succeeds → re-read
within 30s returns the pre-insert rows. The documented invariant ("after each successful mutation
… deleteByTag is called automatically … the host does not need to invalidate manually",
`handleMutation.ts:17-20`) silently does not hold in the default configuration.

**Fix direction:** either share the default: export/reuse `getDefaultCache()` from
`handleMutation` when `options.cacheProvider` is omitted; or make the option required-ish
(document loudly + `console.warn` once when mutations run without a cache provider while the
query side would default one). Add an end-to-end test: query → mutate → query with both handlers
on default options must observe the write.

### 2.3 Joined-table security predicates go in WHERE, degrading LEFT/RIGHT JOINs to INNER JOINs

**Where:** `src/router/queryBuilder.ts:85-116` (joins built, then `applySecurityPredicates` per
joined table), `src/shared/predicates.ts:190-228` (`query.where(`${table}.${col}`, '=', ...)` /
`whereIn`).

**Trace/repro:** multi-tenant deployment, widget `{ table: 'orders', joins: [{ table:
'customers', type: 'left', on: [['orders.customer_id', 'customers.id']] }] }`. The inherited
joined-table scope emits `WHERE customers.tenant_id = :tenant` in the WHERE clause. For any
`orders` row with no matching customer, `customers.tenant_id` is NULL, the predicate is false,
and the row is dropped — the client asked for a LEFT JOIN precisely to keep those rows. Since
joined tables are scoped **by default**, effectively _every_ `type: 'left'` join in a multi-tenant
deployment silently behaves as `inner`. Same for `type: 'right'`: the _primary_ table's tenant
predicate in WHERE eliminates the unmatched joined-side rows the RIGHT JOIN was meant to preserve.
Security is unaffected (this fails closed — rows are dropped, never leaked), but the results are
wrong, and the jsdom test suite can't see it (`mockDb` is not a SQL engine and "never merges
joined columns" per `ARCHITECTURE.md`).

**Fix direction:** for outer joins, apply the joined table's security predicates inside the join's
ON clause (Knex `this.on(...).andOnVal(col, '=', claims.tenantId)` / `onIn`) instead of WHERE; keep
WHERE placement for inner joins (equivalent) and for the primary table of left joins. Alternatively
document the limitation explicitly in `ARCHITECTURE.md`/`JoinDescriptor` — today neither doc
mentions it. Pin with a recording-builder test asserting the predicate lands in the ON clause for
`type: 'left'`.

### 2.4 Unguarded prototype-chain lookups on client-controlled keys (`resolveAlias`, `allowlist[table]`)

**Where:**

- `src/shared/columnValidation.ts:50-52` — `resolveAlias`: `descriptor.columnAliases?.[column] ?? column`;
- `src/shared/columnValidation.ts:78` — `checkColumnAgainstAllowlist`: `allowlist[table]` where
  `table` comes from a client-qualified column name (`physical.slice(0, dotIdx)`);
- `src/security/validateQueryPlan.ts:253` — `synthesizeProjectionFromAllowlist`: `columnAllowlist[table]`.

**Trace:** this is exactly the bug class already fixed in `applyHaving`
(`queryBuilder.ts:156` own-property gate, with regression tests at
`queryBuilder.test.ts:740`) — but the fix was not applied to these sibling lookups:

1. Widget `{ columnAliases: {}, columns: ['constructor'] }` (or `'toString'`, `'__proto__'`, …):
   `resolveAlias` returns the **inherited `Object.prototype` member** (a truthy function/object),
   not the string. With a `columnAllowlist` configured, `checkColumnAgainstAllowlist` then calls
   `physical.indexOf('.')` on a function → `TypeError` → the _entire batch_ is rejected with an
   internal error instead of a clean validation message. Without an allowlist, the non-string
   `ColumnRef` flows into `db.raw('?? as ??', [Function, 'constructor'])` / Knex builder calls.
2. Filter variant `{ columnAliases: {}, filters: [{ column: 'constructor', operator: 'eq', value: 1 }] }`
   without an allowlist: the resolved "column" is a function; Knex's `.where(fn, '=', v)` treats a
   function first-argument as a grouped-where callback, so the user's filter is **silently
   dropped** (only that user's own filter — security predicates use host-config column names, so
   there is no scope bypass).
3. Qualified reference `constructor.x` / `__proto__.x` in `filters`/`columns` with an allowlist:
   `allowlist['constructor']` is truthy-inherited, so the fail-closed _"has no entry"_ branch at
   `columnValidation.ts:79` is bypassed; the code then crashes on `allowed.includes` (TypeError)
   instead of throwing the intended error.

No tenant/scope bypass is reachable (the inherited values are fixed built-ins, not
attacker-controlled strings, and Knex escapes or throws), so this is Tier 2 defense-in-depth +
robustness, not Tier 1 — but it directly contradicts invariant 5's stated posture, and the package
already ships the pattern for exactly this reason in `applyHaving`.

**Fix direction:** gate every client-keyed lookup with `Object.prototype.hasOwnProperty.call`
(or `Object.hasOwn`): `resolveAlias` returns `column` unless `columnAliases` _own_-has it (and
additionally require the mapped value to be a string); `checkColumnAgainstAllowlist` /
`synthesizeProjectionFromAllowlist` treat a non-own `allowlist[table]` as "no entry" (the existing
fail-closed throw). Extend the `queryBuilder.test.ts:740` prototype-key matrix to cover
`columnAliases` and qualified-table lookups.

### 2.5 HAVING references the output alias — invalid SQL on PostgreSQL

**Where:** `src/router/queryBuilder.ts:163` — `query.havingRaw(`?? ${op} ?`, [h.alias, h.value])`;
aggregates are emitted as `sum({ [agg.alias]: col })` in `src/router/execute.ts:145-172`.

**Trace/repro:** descriptor `aggregations: [{ column: 'revenue', func: 'sum', alias:
'total_revenue' }], having: [{ alias: 'total_revenue', operator: 'gt', value: 10000 }]` compiles
to `... GROUP BY category HAVING "total_revenue" > 10000`. PostgreSQL (and standard SQL) does not
allow referencing a SELECT output alias in HAVING — this errors with `42703 column "total_revenue"
does not exist`. It works on MySQL/SQLite (which is what the examples/tests run), so every HAVING
widget hard-fails on the most common production database while the test suite stays green. The
package advertises itself as driver-agnostic.

**Fix direction:** compile HAVING from the aggregation spec rather than the alias: look up the
matching `PlanAggregation` (the alias is already validated to match one) and emit
`havingRaw(`${FUNC}(??) ${op} ?`, [agg.physical, h.value])` with `FUNC` from the same fixed
five-entry map used in `execute.ts` — identifiers stay `??`-bound, values stay `?`-bound, and the
SQL is portable. Note in the test suite that `mockDb` can't catch dialect issues.

### 2.6 A cache-backend failure poisons otherwise-successful work (committed mutations reported as failed)

**Where:** `src/mutations/handleMutation.ts:151-153` (`await cacheProvider.deleteByTag(...)`
inside the same `try` as the DB write) and `src/handler.ts:157,219` (`cacheProvider.get`/`set`
awaited inside `processWidget`'s `try`).

**Trace/repro (write side — the important one):** Redis-backed `cacheProvider`, Redis is down.
`buildInsertMutation` commits the row, then `deleteByTag` throws, the catch at
`handleMutation.ts:156-162` returns `{ ok: false, error }` — the client is told a _committed_
insert failed. Any reasonable client retry produces a **duplicate row**. Read side: rows are
fetched from the DB successfully, then `cacheProvider.set` throws and the catch discards them,
returning `{ rows: [], error }`; likewise a failing `cacheProvider.get` fails the widget instead
of falling through to the DB — a cache outage becomes a data outage.

**Fix direction:** treat the cache as best-effort around the authoritative operation: wrap the
`deleteByTag` call in its own try/catch (log + still return `ok: true`, or return `ok: true` with
a `warning` field — a stale cache for ≤TTL is strictly better than signaling failure for a
committed write); on the read path, catch `get` errors as a miss and `set` errors as a no-op after
the rows are already in hand. Add tests with a throwing cache provider.

---

## Tier 3 — polish, robustness, doc drift

### 3.1 `perTable[table] = null` (shared-table opt-out) is ignored when that table is the PRIMARY table

`src/shared/predicates.ts:75-86`: `resolvePrimarySecurityColumns` reads `override?.tenant` — for a
whole-entry `null` override that is `undefined`, so the table _inherits_ the tenant column. A host
that declares `country_codes: null` (shared lookup, no tenant column) gets it joined unscoped
(by design), but a widget selecting `table: 'country_codes'` directly gets
`WHERE country_codes.tenant_id = :t` → SQL error on a nonexistent column. Fail-closed, but an
undocumented asymmetry: a table the host explicitly declared "has no tenant column" is unqueryable
as a primary table. Either honor the whole-entry `null` in `resolvePrimarySecurityColumns` too, or
document that shared tables are join-only.

### 3.2 `normalizeRegionIds` accepts booleans and empty/whitespace strings

`src/security/extractSecurityClaims.ts:54-65`: `Number(true)` → `1`, `Number('')`/`Number(' ')` →
`0`, all finite, so `regionIds: [true, '']` becomes `[1, 0]` — a malformed issuer claim is
silently coerced into two concrete region grants instead of throwing like other malformed
elements. Tighten to `typeof id === 'number' || (typeof id === 'string' && id.trim() !== '')`.

### 3.3 `extractSecurityClaims` does not type-check `tenantId` / `sub` / `department` / `roleIds`

`src/security/extractSecurityClaims.ts:133-143`: only truthiness is checked. A numeric `tenantId`
(e.g. `123`) or an object `department` passes through into `JwtSecurityClaims` typed as
`string`, then into `encodeURIComponent`, `sortedStringify`, and Knex bindings. Nothing breaks
tenancy (the same value is used consistently for keying and predicates), but the demo verifier is
the documented trust boundary and should enforce the declared claim types the way it now does for
`regionIds`.

### 3.4 Redis glob metacharacters in `tenantId` survive into `invalidatePrefix` patterns

`encodeURIComponent` does not escape `*`, `?`, `(`, `)`, `!` (`src/security/cacheKey.ts:123`). A
host-constructed tenant prefix for a tenant id containing `*` becomes a `SCAN MATCH` pattern
(`RedisCacheProvider.ts:217`) matching _other tenants'_ keys — over-eviction only (availability,
never disclosure), and only for exotic tenant ids, but worth either escaping glob chars in the
tenant segment or documenting alongside the existing "encode the tenant id the same way" note.

### 3.5 Non-aggregation `db`-tier results are unbounded

A widget with no `limit` whose tenant slice exceeds `serverMemoryTier` ships the entire (>100k
row) slice to the client and caches it (`handler.ts:218-224`; one 100k-row entry ≈ 51 MB of the
LRU's 128 MB budget at the default `avgBytesPerRow`). The routing tiers exist to avoid exactly
this. Consider a host-configurable `maxRows`/forced-limit clamp for non-aggregation db-tier
queries. (Deliberate per ARCHITECTURE.md's iter-5 reasoning; flagging the missing server-side
bound, not the caching.)

### 3.6 Preflight COUNT(\*) counts join fan-out, not primary rows

`runPreflight` counts the joined result set (`preflight.ts:54`), so a 1:N join can multiply the
count and push a small query into the `server`/`db` tier. Routing-only effect (never a security or
result-correctness issue). A `COUNT(DISTINCT <primary pk>)` or count-without-joins-when-possible
would be more faithful; probably fine to document instead.

### 3.7 Minor API/consistency nits

- `LRUCacheProviderOptions` and `MapTierCacheProviderOptions` are not exported (`index.ts`
  exports the two Redis option types) — inconsistent public surface for hosts typing their config.
- On a tier-cache hit, the (up to `tierCacheTtlMs` stale) `rowCount` is persisted into the fresh
  data-cache entry (`handler.ts:191,221`) and echoed on subsequent hits; freshly-executed rows are
  paired with a stale total. Harmless at 30s TTLs; would bite if a host raises `tierCacheTtlMs`.
- `generateCacheKey` is called _outside_ `processWidget`'s try (`handler.ts:152`), so a missing
  `CACHE_HMAC_SECRET` rejects the whole batch as an unhandled throw rather than per-widget errors.
  Arguably correct for a config error; noting the asymmetry with everything else being isolated.

---

## Doc drift check (`ARCHITECTURE.md` vs code)

The doc is otherwise accurate and current (module map, invariants 1–10, test inventory all match
the source). Two places where it is misleading given the findings above:

- "there is no manual invalidation endpoint" / handleMutation invalidation description omits that
  the read path's _default_ cache is unreachable from the write path (finding 2.2).
- The two-cache-planes section never states that both planes are keyed by the identical string,
  which is the precondition for finding 2.1; the `RedisTierCacheProvider` combining example is
  actively wrong.

## Verdict

No Tier 1 security findings — the SQL-injection surface, tenant/row-scope enforcement, and
cache-key tenant/policy isolation all check out clean for the third consecutive iteration.
Six substantiated Tier 2 items remain, clustered in the _operational_ seams (cache plane
composition, default-config invalidation, outer-join semantics, dialect portability,
failure-mode reporting) rather than the security core.
