# Architecture & technical-debt review (Fable)

Independent review by the Fable model, run in two passes: (1) a review of `ARCHITECTURE.md` across all three Studio packages, verified against source and extended with new findings; (2) a dedicated technical-debt sweep of this package. Read-only analysis — no code was changed to produce this report. See also [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the baseline this review evaluates.

None of the findings below are cross-cutting with the other two packages — this package has no dependency on `@mui/x-studio` or `@mui/x-studio-ai-middleware`.

---

## Part 1 — Architecture proposals concerning this package

### Proposal: Row-level security is asymmetric — read path enforces region/department, write path doesn't; joins are never security-scoped

**Problem**: `buildSecureQuery` applies three security predicates to reads — tenant, region, department (`router/queryBuilder.ts:77-87`). The mutation builders apply **only** the tenant predicate: `buildUpdateMutation` (`mutations/mutationBuilder.ts:126-128`) and `buildDeleteMutation` (`mutationBuilder.ts:160-162`) never add `regionIds`/`department` scoping. Additionally, all security predicates are applied to `descriptor.table` only — joined tables get none (`queryBuilder.ts:61-73`; documented as a caveat in `security/types.ts:133` but not reflected in `ARCHITECTURE.md`'s invariant #2, which claims "a client can never override, remove, or AND-away these predicates"). The region/department column names are hardcoded literals `region_id`/`department` (`queryBuilder.ts:82,86`) in an otherwise schema-agnostic package — only `tenantColumn` is configurable.

**Architectural cost**: A user whose JWT restricts them to region 5 can UPDATE/DELETE any row in _any region_ of their tenant — the invariant "security predicates are unconditional" silently holds only for reads. Joined tables can leak rows belonging to other tenants whenever join keys collide across tenants. Any deployment whose region column isn't literally named `region_id` gets a SQL error on every query for users carrying `regionIds` claims.

**Recommended change**: Extract a single `applySecurityPredicates(query, table, claims, securityConfig)` used by both `buildSecureQuery` and all three mutation builders. Replace the hardcoded column names with a config shape: `securityColumns?: { tenant?: string; region?: string; department?: string }` (per-table overrides: `Record<string, {...}>`), defaulting to current names for compatibility. Call it for `descriptor.table` **and** for each `join.table` that has a configured tenant column (tables without one are declared "shared" explicitly, making cross-tenant exposure an opt-in, not a default).

**Effort/risk**: Medium. Hosts whose joined tables genuinely are shared (lookup tables) need the opt-out; adding predicates to joins changes result sets for existing deployments, so gate the join-scoping behind an option defaulting on with a clear changelog entry. Write-path region scoping is a pure tightening — low break risk, high win.

### Proposal: Empty-`IN` predicate silently bypasses the "UPDATE/DELETE must have a WHERE" invariant

**Problem**: `validateMutation` enforces ≥1 `where` predicate for update/delete (`mutations/mutationBuilder.ts:34-39`). But `applyMutationPredicate` **drops** an `in` predicate whose value array is empty (`mutationBuilder.ts:184-189`, copied from `router/queryBuilder.ts:150-157`). So `{operation: 'delete', table: 'orders', where: [{column: 'id', operator: 'in', value: []}]}` passes validation, the predicate is dropped, and the query becomes `DELETE FROM orders WHERE tenant_id = ?` — a full-tenant-table wipe, precisely what invariant #4 exists to prevent. On the read path the drop is defensible (mirrors the client's empty-selection-means-no-filter semantics in `x-studio/src/internals/filterUtils.ts:105-111,342-343`), but on the write path "no filter" means "mutate everything," inverting the intent from match-nothing to match-all. **The tech-debt sweep below found this is worse than it looks**: the write-path operator switch has **no `SAFE_OPERATORS` guard at all** (unlike the read path), so an unrecognized/typo'd operator is also silently dropped rather than rejected — a second, independent path to the same table-wipe outcome.

**Architectural cost**: Direct data-loss bug reachable from a single malformed client request (e.g. a UI that builds the `in` list from a selection that happens to be empty). Plus the documented keep-in-sync-by-hand burden for every new operator.

**Recommended change**: Create `src/shared/predicates.ts` exporting `applyPredicates(query, predicates, mode: 'read' | 'write')` and `countEffectivePredicates(predicates)`. In `'write'` mode, an empty `in` **throws** (`MUI X Studio Server: "in" predicate with an empty value list would make the mutation unscoped...`) and an unrecognized operator also throws (matching the read path's `SAFE_OPERATORS` check, currently absent on write); in `'read'` mode an empty `in` is dropped as today. `validateMutation` switches from `where.length >= 1` to `countEffectivePredicates(where) >= 1`. Both builders delete their local switches.

**Effort/risk**: Small (one new module, two call-site swaps, tests for the empty-IN delete case and the unknown-operator case). Risk: near zero — the only behavior change is rejecting requests that today destroy data.

### Proposal: Fail-open security defaults — empty-string JWT/HMAC secrets and per-table column allowlist holes

**Problem**: Three independent fail-open paths:

- `extractSecurityClaims(header, jwtSecret = process.env.JWT_SECRET ?? '')` (`security/extractSecurityClaims.ts:36`) — if `JWT_SECRET` is unset, verification proceeds with an **empty HMAC key**, so anyone can forge a valid HS256 token. It never throws on missing secret.
- Same pattern in `generateCacheKey` (`security/cacheKey.ts:98`): `hmacSecret = ... ?? ''` breaks the documented "opaque, cannot guess another tenant's key" guarantee (invariant #4).
- `validateColumns` checks `if (allowed && !allowed.includes(column))` (`handler.ts:145-146`) — any table _without_ an entry in `columnAllowlist` passes all columns, and a client can dodge validation entirely by table-qualifying a column with a name that has no allowlist entry. Also, `join.on` column pairs are never validated at all, even though `security/types.ts:53-54` explicitly claims "Column names in `on` predicates are validated against `columnAllowlist`" — the docs and type comments assert a check that doesn't exist.
- Minor: `timingSafeEqual` throws `RangeError` on length mismatch (`extractSecurityClaims.ts:58`) instead of a clean auth error.

**Architectural cost**: The package's entire security story ("Zero-Knowledge Rule", trust boundary at `JwtSecurityClaims`) rests on these functions; a forgotten env var currently degrades to _no authentication_ with zero warning. `join.on` is a live probing channel (`join other ON orders.secret_col = other.public_col` and observe row counts).

**Recommended change**: Throw at call time when the effective secret is empty (`if (!jwtSecret) throw new Error('MUI X Studio Server: JWT_SECRET is not configured...')`; same for the cache HMAC). Make the column allowlist fail-closed when provided: a referenced table with no allowlist entry is an error (mirroring `schemaAllowlist`'s all-or-nothing posture, with an explicit `'*'` escape hatch per table). Validate both sides of every `join.on` pair in `validateColumns`, making the code match its own type docs. Wrap `timingSafeEqual` with a length pre-check.

**Effort/risk**: Small. Fail-closed allowlisting could break hosts relying on partial allowlists — release note covers it.

### Proposal: Multi-condition joins build invalid SQL

**Problem**: `JoinDescriptor.on` is typed `[string, string][]` — explicitly an array of column pairs (`security/types.ts:68`). But `buildSecureQuery` loops `for (const [left, right] of join.on) { query[joinMethod](join.table, left, '=', right); }` (`router/queryBuilder.ts:70-72`) — calling Knex's join once **per pair**, which joins the same table twice. Two `on` pairs produce `JOIN t ON a=b JOIN t ON c=d` → "table name not unique" error on real databases (the in-memory `mockDb.ts` test double doesn't catch this).

**Architectural cost**: Any composite-key join (common: `(tenant_id, order_id)` pairs — exactly what the security-scoping proposal above wants for joins) fails at runtime in production while passing tests. Silent trap baked into the public wire type.

**Recommended change**:

```ts
query[joinMethod](join.table, function joinOn() {
  for (const [left, right] of join.on) {
    this.on(left, '=', right);
  }
});
```

Add a real-SQL test (a dev-dep like `better-sqlite3`, test-only — doesn't violate the no-Knex-import invariant, which applies to core logic) covering a two-pair join.

**Effort/risk**: Small; single-pair behavior is unchanged, multi-pair goes from broken to working.

### Smaller observation relevant to this package

- **`handler.ts:42-57` module-level default cache singletons** contradict the file's own "no global state mutation" banner (line 16); harmless functionally (keys are claims-scoped) but the pure-function claim in `ARCHITECTURE.md` is overstated — `options.cacheProvider` should be documented as effectively required for multi-config hosts. (See the tech-debt sweep's finding #13 below for the fuller picture, including an unbounded default tier cache.)

### Verification notes on the two seeded items from this package

- **Filter-operator duplication** (`applyPredicate` vs `applyMutationPredicate`) — confirmed, and upgraded: the duplication is currently hiding the data-loss bug above (empty-`IN` + no operator guard on write), which makes it clearly worth fixing now, not just a style cleanup.
- **Multi-column join bug** — confirmed as a genuine runtime SQL error against real databases, invisible in the current test suite because the mock DB doesn't validate join uniqueness.

---

## Part 2 — Technical debt: this package (full sweep)

Ordered by impact. No TODO/FIXME/HACK markers exist anywhere in the package (grep confirmed) — the debt below is entirely unmarked.

**1. `knex` is already a hard dependency, so the `db: any` justification is void — type safety is recoverable for free**
`package.json:23,28` vs. `security/types.ts:266,329`, `router/queryBuilder.ts:52`, `router/preflight.ts:44,79`, `mutations/mutationBuilder.ts:92,118,153`, `handler.ts:184`. Every `db` parameter is `any` with the comment "typed as any to avoid hard Knex dependency at import time" — but `package.json` lists `knex: ^3.1.0` in **both** `dependencies` and `peerDependencies`. The dependency the `any` is supposed to avoid is already there. All query-builder call sites (`.where`, `.sum`, `.havingRaw`, join methods) are unchecked as a result — exactly how the multi-column-join bug above survived. Fix: use `import type { Knex } from 'knex'` (erased at runtime, works fine as a peer-only dep) and type `db: Knex`; or follow the package's own precedent — the minimal structural `RedisClient` interface in `RedisCacheProvider.ts:61-72` — and define a ~15-method `MinimalKnex` interface. Remove `knex` from `dependencies` (keep the peer); also move `rimraf` (`package.json:25`) to `devDependencies`.

**2. Duplicated filter-operator logic with behavioral drift: unknown operators throw on read, silently drop on write**
`router/queryBuilder.ts:132-182` (`applyPredicate`) vs `mutations/mutationBuilder.ts:175-213` (`applyMutationPredicate`). See the empty-`IN` proposal in Part 1 for the full writeup — this is the duplication that hides that bug.

**3. Cache tags omit joined tables → mutations serve stale joined query results**
`handler.ts:238-243` (tags only `descriptor.table`) vs `mutations/handleMutation.ts:121-123` (`deleteByTag(descriptor.table)`). A cached query on `orders` joined to `customers` is tagged only `['orders']`. A mutation to `customers` invalidates only the `customers` tag, so the cached joined rows survive until TTL — a silent data-staleness bug that contradicts the documented guarantee in `handleMutation.ts:17-20`. Fix: `tags: [descriptor.table, ...(descriptor.joins?.map((j) => j.table) ?? [])]` at `handler.ts:242`. Relatedly, mutations never touch the **tier** cache — a bulk insert/delete that crosses a tier threshold leaves a wrong tier cached for the full tier TTL; document this or add tag support to the tier cache.

**4. `decideTier` is dead production code duplicating `decideTierWithCache`, including a leftover empty `if` block**
`router/tierDecision.ts:56-90` vs `:97-124`. Only `decideTierWithCache` is used by production code (`handler.ts:215`); `decideTier` isn't exported from `index.ts` and is referenced only by its own tests. It also contains an empty `if (tierCacheProvider) { /* stale comment */ }` block (lines 82-87) describing a design that was never implemented. Fix: delete `decideTier`, make `tierCacheTtlMs` an optional param of `decideTierWithCache` (rename to `decideTier`), port the tests.

**5. `runPreflight` duplicates the threshold constants and tier mapping, and its tier output is discarded in production**
`router/preflight.ts:29-30,50-51,59-66` vs `router/tierDecision.ts:29,34-45`; `handler.ts:210-218`. `DEFAULT_CLIENT_THRESHOLD`/`DEFAULT_SERVER_MEMORY_THRESHOLD` (10k/100k) and the rowCount→tier ladder both exist in two files. The handler then resolves thresholds itself and uses only `runPreflight`'s `.rowCount` — the `tier` it computes is dead in the main path. Fix: make `runPreflight` a pure COUNT(\*) runner returning `rowCount` only (its docblock already claims this); import `DEFAULT_THRESHOLDS`/`tierFromRowCount` from `tierDecision.ts` anywhere a mapping is still needed.

**6. Redis providers: documented node-redis v4 compatibility doesn't hold, and the resulting no-ops are silent**
`cache/RedisCacheProvider.ts:24-30,61-72,114` and `RedisTierCacheProvider.ts:24-31,105`. The docblocks promise compatibility with "node-redis (v4+)", but `set(key, value, 'EX', ttlSeconds)` is the ioredis positional signature — node-redis v4 takes `set(key, value, { EX })`; and node-redis v4 exposes camelCase `sAdd`/`sMembers`/`sRem`, so `this.redis.sadd`/`smembers` checks are `undefined` → tag indexing and `deleteByTag` become **silent no-ops**. With node-redis v4, mutations stop invalidating the cache and nobody is told. Fix: detect capability once in the constructor and either adapt (map camelCase methods, wrap `set`) or warn loudly when tag invalidation is unavailable; add an integration-style test with a node-redis-v4-shaped fake.

**7. Redis tag/reverse-index keys have no TTL and are never fully cleaned → unbounded Redis growth**
`cache/RedisCacheProvider.ts:118-125` (SADD without expiry), `:151-167` (`deleteByTag` deletes data keys + forward set but leaves each key's `__ktag__` reverse set). Data keys expire via `EX`, but `__tag__:<tag>` and `__ktag__:<key>` sets never do — a slow, unbounded memory leak in the shared Redis instance. `invalidatePrefix` also uses `KEYS pattern` (an O(N) blocking command Redis docs forbid in production) instead of `SCAN`; the per-tag/per-key `await` loops should be pipelined. Fix: set an expiry on index sets on each write; delete `__ktag__:<key>` outright in `deleteByTag`; switch `KEYS` to `SCAN`.

**8. Error-handling gaps: malformed requests and pass-through DB errors**
`handler.ts:78`, `mutations/handleMutation.ts:52`, `handler.ts:252-259`, `security/extractSecurityClaims.ts:58`. A body missing `widgets`/`mutations` throws a raw `TypeError` instead of a `MUI X Studio Server:` message. `processWidget`'s catch forwards `err.message` verbatim into the client-visible response — raw Knex/driver errors reach the browser un-contextualized. `extractSecurityClaims`'s `timingSafeEqual` throws a cryptic `RangeError` for a truncated/garbage signature instead of "JWT signature verification failed". Fix: validate request shape upfront with a clear error; wrap widget/mutation errors with context; length-check the signature before `timingSafeEqual`.

**9. Three divergent mock-DB implementations across the test suite**
`__tests__/mockDb.ts` (324 lines, read path), two copies of `createMutableMockDb` in `mutations/__tests__/mutationBuilder.test.ts` and `handleMutation.test.ts` (the second literally commented "same as mutationBuilder.test.ts"), plus a fourth call-recording builder in `router/__tests__/queryBuilder.test.ts`. The duplicated mutation mocks support only `=, !=, <, >` (no `lte/gte/in-empty/between/like`) and resolve qualified columns differently from `mockDb.ts` — semantics silently differ between suites, and the narrow operator set is why the mutation predicate paths (finding 2, and the empty-`IN` case) have no coverage. Fix: extend `__tests__/mockDb.ts` with the mutation verbs and delete both inline copies.

**10. Missing test coverage in the highest-risk areas**
No test that `where: [{ operator: 'in', value: [] }]` on update/delete widens the write to the whole tenant. `LRUCacheProvider.test.ts` never exercises `maxSizeBytes`/`sizeCalculation`/TTL expiry under real byte-pressure eviction. `RedisCacheProvider.set` with `ttlMs: 0` produces `SET … EX 0` (a Redis error); `RedisTierCacheProvider.ts:104` guards with `Math.max(1, …)` but `RedisCacheProvider.ts:112` does not — untested parity gap. `mockDb.ts` has no `db.raw()`, so any descriptor using `columnAliases` crashes — only the error path for expression fields is tested, not the success path. Fix: add the mutation-predicate cases, an LRU byte-eviction test, a `ttlMs: 0` parity test for both Redis providers (with the `Math.max(1, …)` guard added), and a `raw()` implementation in `mockDb.ts`.

**11. `orderBy` ignores `columnAliases` on the db tier but not on client/server tiers**
`router/preflight.ts:108` (`query.orderBy(physicalCol(ob.column), …)`) vs `:178` (`query.orderBy(ob.column, …)`). Ordering an aggregation query by an expression field emits `ORDER BY "expr-order-country"` — a nonexistent column against a real database — while `mockDb.ts` sorts by output-row key and hides it. Fix: use `physicalCol(ob.column)` at line 178 too, unless it matches an aggregation alias.

**12. Data-cache hits misreport the routing tier as `'server'`**
`handler.ts:199-205`; `CacheEntry` (`cache/types.ts:42-45`) stores no tier. Any cache hit returns `tier: 'server'` even if the entry was produced by the `client` tier. Per `WidgetQueryResult`'s contract, `'client'` tells the browser to filter rows itself — a client-tier result replayed as `'server'` can change client-side behavior on the second request. Fix: persist `tier` in `CacheEntry` and echo it on hits.

**13. Module-level default cache singletons and an unbounded default tier cache**
`handler.ts:42-57`; `cache/MapTierCacheProvider.ts:25-49`. `defaultCache`/`defaultTierCache` are process-global — every caller that omits providers shares them (cross-configuration bleed, test pollution). `MapTierCacheProvider` never evicts by size: expired entries are removed only if that exact key is `get()` again, so a stream of unique query shapes grows the Map indefinitely, unlike the byte-bounded LRU data cache next to it. There's also a three-way TTL-default inconsistency: the handler default is 30s, `MapTierCacheProvider.set` defaults to 300s, and its docblock/`RedisTierCacheProvider` both advertise 5 min "the default" — three different defaults for the same knob. Fix: cap the tier map (reuse `lru-cache` with `max`+`ttl`, already a dependency); document or key defaults per options object; reconcile the TTL documentation.

**14. Minor: option-type duplication, missing export, stale comments**
`HandleMutationOptions` and `HandleBatchQueryOptions` duplicate `db`/`schemaAllowlist`/`columnAllowlist`/`tenantColumn`/`cacheProvider` with near-identical 20-line docblocks — extract a shared base interface. `HavingPredicate` is part of the public `BatchWidgetDescriptor` API but isn't exported from `src/index.ts` — consumers can't name the type. `LRUCacheProvider.ts:172`'s comment says "Find the 4th colon" while the code stops at the 3rd; `benchmarks/run.ts:282`'s "TTL=0 → never caches" comment is backwards for lru-cache semantics.

**Benchmark/mock realism**: beyond findings 10/11, `mockDb.ts` resolves synchronously (no I/O, so `Promise.all` fan-out in `handler.ts:98` is never truly concurrent), implements `!=`/`whereIn` with JS semantics (NULL rows pass `!=`, unlike SQL three-valued logic), makes `whereLike` case-insensitive (real Postgres `LIKE` is case-sensitive), and has no `join`/`raw` at all — so the benchmark numbers measure JS array filtering, and no benchmark or handler test can exercise joined or expression-field queries end-to-end.
