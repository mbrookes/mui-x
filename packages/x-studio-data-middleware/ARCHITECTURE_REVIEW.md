# Architecture review — iteration 10

Scope: full re-read of `packages/x-studio-data-middleware/src/` (all non-test sources), with an
independent re-derivation of every invariant listed below — not a diff review of iter9's fix.
Recent history checked (`git log`): iter7 qualified filter columns, iter8 qualified renamed
projection columns + guarded tier-cache I/O, iter9 qualified join ON-pair columns.

Verdict: **0 Tier 1, 4 Tier 2** (one of them security-posture-critical under host misconfiguration,
the rest robustness/invariant-consistency). The three-round column-qualification invariant is now
genuinely closed — the exhaustive site inventory is below, not asserted from the prior rounds.

---

## Tier 1 — real bugs / client-exploitable security issues

None found. Every client-triggerable path I could construct (details in the sweep sections) is
either parameterized, charset-gated, allowlist-gated, own-property-gated, or fails closed with a
per-widget/per-mutation error.

---

## Tier 2 — correctness / robustness gaps

### 2.1 `mode: 'multi-tenant'` with an empty/undefined `tenantColumn` silently disables ALL tenant scoping (fail-open under misconfiguration)

**Sites:**

- `src/security/compileSecurityPolicy.ts:155-173` — `compileSecurityPolicy` performs no runtime
  validation of `tenancy.tenantColumn`; `resolvedTenantColumn = tenancy.tenantColumn` (line 158)
  passes `''`/`undefined` straight through.
- `src/shared/predicates.ts:252` — `if (securityColumns.tenant)` is a **truthiness** gate, so a
  resolved tenant column of `''` emits **no tenant predicate** on any table, read or write.
- `src/mutations/mutationBuilder.ts:317` (`if (cols.tenant)` — insert force-stamp skipped),
  `:96` (client-supplied-tenant rejection skipped), `:367` (update tenant-strip skipped).
- `src/shared/predicates.ts:42-50` — `resolveDimension('' , fallback)` returns `''` (empty string
  is neither `null` nor nullish), so `perTable[t] = { tenant: '' }` is an **undocumented third
  sentinel** that behaves exactly like the per-dimension `null` drop — and, unlike `null`, it does
  NOT trip the single-tenant contradiction check (`compileSecurityPolicy.ts:161-163` filters on
  `Boolean(entry.tenant)`). Same applies to `region: ''` / `department: ''` and to the top-level
  `securityColumns.region = ''` / `.department = ''` (`predicates.ts:83-84`, `139-140`).

**What's wrong / failure scenario:** The package's central posture (ARCHITECTURE.md: "a deployment
cannot express 'I forgot to configure a tenant column'") holds only at the TypeScript level.
`TenancyConfig.tenantColumn: string` is not a runtime guarantee: the realistic path is
`tenancy: { mode: 'multi-tenant', tenantColumn: process.env.TENANT_COLUMN! }` with the env var
unset (→ `undefined`) or set to `''`. The deployment then _believes_ it declared multi-tenant, but
every read is fully unscoped cross-tenant, inserts are never tenant-stamped, and a client may write
the real tenant column via `values` (nothing rejects it, since the policy doesn't know its name) —
the exact cross-tenant-leak state the required-`tenancy` design was built to make unreachable.
Nothing throws, nothing warns; the policy digest even dutifully caches the unscoped results.

**Fix direction (invariant: fail-closed tenancy — the unsafe state must be unreachable except by an
explicit `single-tenant` declaration, enforced at RUNTIME, not just in types):** in
`compileSecurityPolicy`, throw when `tenancy.mode === 'multi-tenant'` and `tenantColumn` is not a
non-empty string; additionally reject `''` (as distinct from the documented `null`/`string`
semantics) for every dimension in `SecurityColumnOverride` and for top-level
`securityColumns.region`/`department` — `compileSecurityPolicy` is already the single choke point
where the config enters, so one validation there covers reads and writes alike.

### 2.2 Two `perTable[table]` lookups are not own-property-gated — the last unguarded table-keyed prototype-chain reads in the package

**Sites:**

- `src/shared/predicates.ts:80` (`resolvePrimarySecurityColumns`): `config?.perTable?.[table]`
- `src/shared/predicates.ts:128` (`resolveJoinSecurityColumns`): `config?.perTable?.[table]`

`table` is client JSON (`descriptor.table` / `joins[].table`). Every OTHER client-keyed object
lookup in the package is gated by `Object.prototype.hasOwnProperty.call` (full inventory in the
sweep section below); these two are not. A table named `constructor` / `toString` / `__proto__`
resolves `override` to a truthy inherited object (e.g. `Object.prototype` itself for `__proto__`)
instead of `undefined`.

**Why it is currently NOT exploitable (verified, not assumed):** (a) such a table name must first
pass `assertTablesAllowed` against the host's `schemaAllowlist`, so a client cannot reach these
lookups with an arbitrary key unless the host literally allowlists a table named like an
`Object.prototype` member; (b) even then, no inherited member is `null` (so the whole-table
unscoped opt-out cannot be triggered) and none has own `tenant`/`region`/`department` properties,
so `resolveDimension(override?.X, fallback)` returns the same defaults as a missing entry —
behavior is byte-identical to "no per-table entry".

**Why it is still a real Tier 2:** it breaks the package's own uniformly-applied invariant
("every table-keyed lookup is own-property-gated before reading"), and its safety rests on the
_incidental_ shape of `Object.prototype` rather than on the gate. Either a future
`SecurityColumnOverride` semantic that distinguishes "entry present" from "entry absent" (e.g. an
`in`-style check), or third-party prototype pollution in the host process (`Object.prototype.<table
name> = { tenant: null }` would flip scoping for that table for _every_ request — the gated sites
are immune to exactly this, these two are not), silently converts it into a scoping bypass.

**Fix direction (invariant: `Object.hasOwn` guard on every table-keyed lookup):** mirror
`resolveAlias` — resolve `override` to the entry only when
`config?.perTable && Object.prototype.hasOwnProperty.call(config.perTable, table)`, else
`undefined`. Two-line change, both sites.

### 2.3 `generateCacheKey` runs outside `processWidget`'s try — a throwing key generation escapes the per-widget error-isolation contract

**Site:** `src/handler.ts:138` — `const cacheKey = generateCacheKey(...)` executes before the
`try` block that begins at `handler.ts:141`; everything else in `processWidget` is inside it.

**Failure scenario:** `generateCacheKey` throws when no HMAC secret is configured
(`CACHE_HMAC_SECRET` and `JWT_SECRET` both unset — `cacheKey.ts:105-111`). That throw rejects
`processWidget`'s promise, which rejects the `Promise.all` at `handler.ts:102`, so
`handleBatchQuery` **rejects wholesale** instead of returning the documented structured
`BatchQueryResponse` with per-widget `{ error }` results. A host that writes
`res.json(await handleBatchQuery(...))` without its own catch turns a config error into an
unhandled rejection / hung request rather than a clean 200-with-errors or mapped 500. This is the
one statement in the per-widget pipeline exempt from the error-isolation invariant that every other
widget-scoped failure (validation aside, which is deliberately batch-fatal _before_ execution)
honors.

**Fix direction (invariant: per-widget error isolation — every widget-scoped operation runs inside
the widget's try):** move the `generateCacheKey` call to the first line inside the `try`. (If
fail-loud-on-missing-secret for the whole batch is the intended behavior instead, hoist the secret
check to `handleBatchQuery`'s top, next to `compileSecurityPolicy`, so it fails the batch
_explicitly and before any DB work_ rather than via a rejected `Promise.all`.)

### 2.4 Tier-cache entries are reused across differing `thresholds` config (cross-node / mid-rollout), unlike every other cache plane — low severity

**Sites:** `src/router/tierDecision.ts:108-110` (cached `tier` returned verbatim);
`src/security/cacheKey.ts` / `compileSecurityPolicy.ts:105-114` (`thresholds` is folded into
neither the key nor the policy digest).

**What's wrong / failure scenario:** the package explicitly engineered against mid-rollout
cache-plane divergence — `policy.digest` is folded into the key so "two nodes running a
differently-resolved security policy never share a cache entry". `thresholds` gets no such
treatment: with a shared `RedisTierCacheProvider`, a node running `clientTier: 100` reuses a
`{ tier: 'client', rowCount: 9000 }` decision written by a node running the default `10_000`
(and vice-versa during a threshold rollout), shipping a 9k-row raw slice to a client the local
config says should have been server/db-tier. Bounded by `tierCacheTtlMs` (30 s default) and with
no scoping impact (all tiers return identically security-scoped rows) — hence low severity.

**Fix direction (invariant: a cached decision must be reinterpretable under the reader's config):**
the entry already persists the input (`rowCount`); re-map at read time —
`tierFromRowCount(cached.rowCount, thresholds)` on a tier-cache hit instead of trusting
`cached.tier` — which fixes cross-node divergence AND single-node threshold changes with no key
change and no extra I/O. (Data-plane `CacheEntry.tier` echo has the same cosmetic staleness but
changes no routing; not worth churn.)

---

## Exhaustive sweeps performed (independent re-derivation, per invariant)

### A. Every raw-SQL column-identifier site (the 3-round piecemeal invariant)

Built by grepping every `.raw(`/`havingRaw`/`.on(`/`andOnVal`/`andOnIn`/`.where*`/`.orderBy(`/
`.groupBy(`/`.select(`/`.count(`/`.sum(`–`.max(` call in non-test sources and classifying each:

| #   | Site                                                                                                                                                     | Identifier                                                                                                                                                                    | Qualified?                                                                                    | Verdict |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------- |
| 1   | `execute.ts:70` `db.raw('?? as ??', [qualify(col.physical), col.outputAlias])`                                                                           | renamed projection source + output alias                                                                                                                                      | source `qualify()`d (iter8); alias is not a column (charset-gated by `validateOutputAliases`) | OK      |
| 2   | `execute.ts:71` direct projection                                                                                                                        | `qualify(col.physical)`                                                                                                                                                       | yes                                                                                           | OK      |
| 3   | `execute.ts:85/115/137` `.select(...)`                                                                                                                   | plan columns via `projectColumn`                                                                                                                                              | yes (via 1/2)                                                                                 | OK      |
| 4   | `execute.ts:92/118/187` `.orderBy(orderColumnOf(ob), dir)`                                                                                               | physical → `qualify()`; `aggAlias` deliberately unqualified (not a physical column)                                                                                           | yes                                                                                           | OK      |
| 5   | `execute.ts:138` `.groupBy(qualify(c.physical))`                                                                                                         | yes                                                                                                                                                                           | yes                                                                                           | OK      |
| 6   | `execute.ts:153-165` `sum/avg/count/min/max({ [agg.alias]: qualify(agg.physical) })`                                                                     | column `qualify()`d; alias charset-gated                                                                                                                                      | yes                                                                                           | OK      |
| 7   | `queryBuilder.ts:127-129` join ON pair                                                                                                                   | left→primary table, right→`join.table` unless already dotted (iter9) — matches `validateDescriptorColumns`'s left/right allowlist convention exactly                          | yes                                                                                           | OK      |
| 8   | `queryBuilder.ts:188-193` user filter columns                                                                                                            | qualify-if-no-dot with primary table (iter7), then `applyPredicates`                                                                                                          | yes                                                                                           | OK      |
| 9   | `queryBuilder.ts:279-282` `havingRaw('FUNC(??) op ?', [physical, value])`                                                                                | `agg.physical` qualify-if-no-dot with primary table; FUNC/op from own-property-gated fixed maps                                                                               | yes                                                                                           | OK      |
| 10  | `predicates.ts:252-289` `emitSecurityPredicates`                                                                                                         | always emits `` `${table}.${col}` `` for all three dimensions, both WHERE (`.where`/`.whereIn`) and ON (`.andOnVal`/`.andOnIn`) emitters via the single shared implementation | yes, by construction                                                                          | OK      |
| 11  | `preflight.ts:54` `.count('* as row_count')`                                                                                                             | fixed literal, no client token                                                                                                                                                | n/a                                                                                           | OK      |
| 12  | `validateQueryPlan.ts:278` synthesized `<table>.*` wildcard projection                                                                                   | qualified by construction                                                                                                                                                     | yes                                                                                           | OK      |
| 13  | Write path: `mutationBuilder.ts` `applySecurityPredicates` (qualified `table.col`), `applyPredicates(where)` (bare), `insert/update(values)` (bare keys) | mutations never join — a single-table query has no ambiguity; qualified `values` keys are _rejected_ (`rejectQualifiedValueKeys`)                                             | n/a by design                                                                                 | OK      |

No unqualified read-path column reference reaches raw SQL. Also verified valida­tion/execution
parity on each: every identifier above comes off the `ValidatedQueryPlan` (single `resolveAlias`
funnel), and the qualification convention at each execution site matches the table the same
reference was allowlist-checked against (incl. the left/right join-ON convention).

### B. Zero-Knowledge Rule (`assertTablesAllowed`)

Every `db(<table>)` entry point enumerated: `buildSecureQuery` (`db(queryPlan.table)` — reached
only via `processWidget`/`runPreflight`/`executeForTier`, all downstream of
`handler.ts:80-86`'s batch-wide check over `w.table` + all `w.joins[].table`; `plan.table`/
`plan.joins[].table` are carried from the descriptor unchanged by `buildPlan`), and the three
mutation builders (`db(descriptor.table)` — downstream of `handleMutation.ts:75-78`). No other
`db(...)` call site exists in non-test source. Qualified column strings naming a foreign table
cannot widen the FROM/JOIN set (they either fail the fail-closed column allowlist, or produce a
DB-side "missing FROM-clause entry" error — never a fetch). No bypass found.

### C. Row-level-security placement across every join/subquery/aggregation shape

Re-derived per shape from `queryBuilder.ts:102-168`: inner → both tables WHERE; left → joined
table in its ON (`applySecurityPredicatesToJoinOn`), primary WHERE; right → primary in that join's
ON, joined table WHERE (it is the preserved, non-nullable side); mixed multi-join → each left
join's table in its own ON, `hasRightJoin` correctly suppresses the primary WHERE only when ≥1
right join exists and re-emits the primary predicate inside _every_ right join's ON (duplication is
AND-semantics-harmless). Opt-out (`forJoinedTable → undefined`) no-ops all emitters. WHERE/ON
emitters share one `emitSecurityPredicates` (no drift possible on region `undefined`-vs-`[]`,
department `''`, or the numeric+string region list). Aggregations/HAVING/preflight all sit on top
of `buildSecureQuery`, so no aggregation shape can shed a predicate; HAVING-without-aggregation is
rejected before preflight can ever run a HAVING'd COUNT. No leak shape found. (The one genuine
scoping hole found this round is config-side, not join-shape-side: finding 2.1.)

### D. Prototype-chain guards on client-keyed lookups

Gated (verified each): `resolveAlias` aliases lookup (`columnValidation.ts:62`),
`checkColumnAgainstAllowlist` (`:100`), `synthesizeProjectionFromAllowlist`
(`validateQueryPlan.ts:257`), HAVING `opMap` (`queryBuilder.ts:251`), `HAVING_FUNC_MAP`
(`queryBuilder.ts:270`), all five `values[...]` scope reads in `mutationBuilder.ts`
(`:96/:110/:152/:198/:218`). **Not gated:** the two `perTable[table]` reads — finding 2.2.
(`compileSecurityPolicy.ts:161` uses `Object.entries`, own-props only — safe.)

### E. Cache failure isolation — complete I/O-site inventory

Exactly five cache-touching call sites exist in request-path code (grep-verified; nothing else
outside `cache/` and benchmarks): data `get` (`handler.ts:148`) ✔ guarded→miss; data `set`
(`handler.ts:223`) ✔ guarded→serve-uncached; tier `get` (`tierDecision.ts:99`) ✔ guarded→preflight;
tier `set` (`tierDecision.ts:122`) ✔ guarded→decided-uncached; `deleteByTag`
(`handleMutation.ts:170`) ✔ guarded→`ok: true` + warn. There is **no 6th unguarded cache I/O
site**. The one widget-scoped statement outside any guard is not cache I/O but key _generation_ —
finding 2.3. Provider internals re-checked: Redis `get` JSON-parse guarded; `ttlMs: 0` floored
consistently across all four providers; LRU dispose keeps prefix/tag indexes coherent on
overwrite/evict; tag-index expiry never shortened.

### F. Iter7–9 fix-consistency check

The three qualification fixes agree with each other and with validation: filters (iter7) and
HAVING qualify with the primary table iff undotted; renamed projections (iter8) qualify the
_source_ only, never the output alias; join ON pairs (iter9) qualify left→primary/right→joined,
byte-matching `validateDescriptorColumns`'s check convention. No newly-introduced divergence found.
