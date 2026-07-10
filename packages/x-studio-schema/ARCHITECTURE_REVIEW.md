# Architecture review — `packages/x-studio-schema` (iteration 10)

Fresh, ground-up review of every file in `src/` against the current working tree
(branch `claude/branch-identification-y0rapm`; last schema commits: `7461e99`,
`aa8133b`, `5447f04`). All 435 tests in the package's 7 test files pass on this
tree (`vitest --config packages/x-studio-schema/vitest.config.node.mts --run`).

Per this round's methodology directive, every finding below was swept for
sibling instances across the whole package before being written up, and each
finding enumerates ALL sites of its bug shape, not just the first one noticed.

**Summary: 0 Tier-1 findings, 2 Tier-2 findings** (each a multi-site
sibling-pattern finding). The sibling sweeps of the pattern classes fixed in
the last three rounds are documented at the end.

---

## Tier 2

### T2-1 — `validateFilter` accepts any string as `filter.operator`: the wire boundary and the AI-tool boundary disagree on the identical payload, and the client evaluator fails OPEN on the junk that gets through

**Sites (all of them):**

- `src/parseStateMutation.ts:308-310` — `validateFilter` checks
  `filter.operator` with `isString` only; no membership check against the
  closed 17-member `StudioFilterOperator` union (`src/baseTypes.ts:68-85`).
- `src/parseStateMutation.ts:298-312` — the sibling closed-union leaf fields on
  `StudioFilterState` are not checked at all: `operator2`
  (`StudioFilterOperator` — shares the exact hazard below when a compound
  filter's second condition carries it), `filterMode`
  (`'condition' | 'selection' | 'rank'`), `conjunction` (`'and' | 'or'`),
  `rankDirection` (`'top' | 'bottom'`), `dateRangePreset` (11-member union,
  display-only, lowest stakes).
- The schema exports **no runtime operator list**, which is why
  `@mui/x-studio-ai-middleware/src/executeToolOnState.ts:297-340` maintains its
  own hand-built `VALID_FILTER_OPERATORS` record (locked with
  `satisfies Record<StudioFilterOperator, true>`) — its comment says outright:
  _"The schema package exports the operator TYPE but no runtime list, so this
  derived constant is the executor's authoritative source of truth."_

**What's wrong.** This package's established rule — applied in iter7-9 fixes —
is that a closed-union field which downstream code branches on gets a
**membership** check at the wire boundary, not just a typeof check:
`scope.kind` is membership-checked against `FILTER_SCOPE_REQUIRED_IDS`
(`parseStateMutation.ts:260-283`), `titleMode`/`subtitleMode` against
`isOptionalTitleMode` (:60-62), and `chartType` against `isStudioChartType` on
all five config-carrying channels (findings 2.2/2.3). `filter.operator` is the
one closed union at this boundary that only gets `isString` — even though the
validator's own doc comment (:292-296) names "an active-but-unevaluable filter
that silently renders every widget in scope empty" as the exact reason
`field`/`operator` are checked at all. A junk _string_ operator has the same
failure mode as the non-string `operator: {}` the current check rejects.

Meanwhile the AI-tool boundary **does** membership-check the same value
(`invalidFilterOperatorError`, `executeToolOnState.ts:333-340`), so the two
trust boundaries disagree on an identical payload — the same
two-boundaries-disagree class that finding 2.3 (iter7) fixed for an
omitted-`chartType` chart config.

**Concrete failure scenario.** An `addFilter` SSE payload with
`operator: 'equal'` (typo'd by a hand-built producer, a forward-incompatible
server, or a buggy custom skill) passes `parseStateMutation` and installs into
`doc.filters`. The client's evaluator hits its fail-open default —
`@mui/x-studio/src/internals/filterUtils.ts:398-399`,
`default: return () => true;` — so the filter chip renders as ACTIVE while
filtering **nothing**. The dashboard now visibly claims "Region = EMEA" while
showing all regions: silently wrong displayed data, with no error anywhere
(strictly worse than a rejected mutation, which at least logs a reason). The
same payload sent through the `add_page_filter` AI tool is rejected with a
named error — the boundaries disagree.

**Suggested fix direction (general invariant, not one call site).** Every
closed union that ANY trust boundary must membership-check gets exactly one
shared runtime list in this package — the `STUDIO_CHART_TYPES` /
`isStudioChartType` pattern (`widgetTypeGuards.ts:86-126`), including its
`AssertAll…Listed` completeness lock. Concretely: export
`STUDIO_FILTER_OPERATORS` / `isStudioFilterOperator` from the schema; use it in
`validateFilter` for `operator` and for a **present** `operator2` (absent stays
legal); replace the middleware's hand-copied `VALID_FILTER_OPERATORS` with the
shared list so the wire and AI boundaries can never drift again (the middleware
copy is today compile-locked but is precisely the "per-package hand-copy"
shape this package exists to eliminate). While in there, decide `filterMode` /
`conjunction` / `rankDirection` explicitly — either membership-check them with
the same tiny-literal pattern as `isOptionalTitleMode`, or document why the
evaluator's degradation for each is acceptable (today: junk `filterMode` falls
through to condition mode; junk `conjunction` behaves as `'and'` —
tolerable-but-undocumented).

---

### T2-2 — the three UPDATE-shaped config channels in the reducer accept an **array** (and, on the bulk path, any truthy primitive) as a widget `config`, where every sibling site in the package treats non-record ≡ null/array/primitive uniformly

**Sites (all of them, with the exact junk class each accepts):**

1. `src/applyMutation.ts:667` — `updateWidget`'s `config`-patch guard is
   `config !== null && typeof config === 'object'`. An **array** passes;
   `Object.entries(patch)` then merges its index keys (`"0"`, `"1"`, …) into
   the widget's live config.
2. `src/applyMutation.ts:741` — `updateWidget`'s `changes.config`
   wholesale-replacement guard is `value && typeof value === 'object'`. An
   **array** passes and — because `normalizeConfigChartSeries` and
   `shallowRecordEqual` are both array-tolerant — is installed **as the
   widget's `config` verbatim** (`widget.config` becomes an array).
3. `src/applyMutation.ts:1414` — `applyBulkUpdate`'s `updatedWidgets[].config`
   guard is bare truthiness (`if (update.config)`). An **array** merges index
   keys via `{ ...existing.config, ...update.config }`, and a truthy
   **string** does too (`...'abc'` spreads to `{0:'a',1:'b',2:'c'}`).

**Contrast with every sibling site, which excludes arrays (and primitives):**
`coerceWidgetConfig` (`applyMutation.ts:216`) — the T2-2/iter8 fix guarding the
two ADD sites — uses `!== null && typeof === 'object' && !Array.isArray(...)`;
`deserializeState`'s load-boundary coercion (`statePersistence.ts:480-488`)
excludes arrays; `parseStateMutation`'s `isRecord` (:42-44) excludes arrays on
every wire channel; `normalizePersistedPages`' span/record checks exclude
arrays. The three sites above are the only config-accepting channels in the
package whose "is this a record" test is a weaker ad-hoc shape.

**Why it's reachable.** `parseStateMutation` rejects all of this on the wire,
so the exposure is the parser-bypassing server-built mutation — the exact
threat model these same three channels were hardened against in prior rounds
(the `config: null` guard at :667 and the `changes.config: null` guard at :741
are iter8's T1-1/T3.3 fixes, and both carry doc comments naming "a server-built
mutation that bypassed `parseStateMutation`" as their reason to exist). Those
fixes closed the `null` instance of the bug class but used typeof checks that
don't exclude arrays, while the add-site fix from the very same round
(`coerceWidgetConfig`) does — a textbook sibling-instance miss of the kind this
round was directed to hunt.

**Concrete failure scenario.** A future middleware tool hand-builds
`{ type: 'updateWidget', args: { widgetId, changes: { config: someRowsArray } } }`
(e.g. accidentally passing a rows array where a config was meant — the exact
mistake class that produced `config: null` payloads before). Site 2 installs
the array as `widget.config`. Nothing throws immediately — the canvas reads
`config.chartType` → `undefined` → renders a default bar chart, so the
corruption is invisible; `serializeDoc` persists the array; and on the next
reload `deserializeState` silently coerces it to `{}` — the user's widget
config is now different live vs. after reload (a deferred, silent data-loss
divergence rather than a crash, which is what makes it survive testing). Sites
1 and 3 instead pollute the config with index keys (`"0"`, `"1"`) that no
allow-list ever validates again once stored (the write-side key validators only
run on the incoming patch, not the stored config).

**Suggested fix direction (general invariant).** One shared record predicate
for widget configs — the `coerceWidgetConfig` shape (`null`, arrays, AND
primitives all excluded) — applied at **every** reducer channel that reads a
config off a mutation: sites 1 and 2 should treat a non-record as ABSENT
(already the documented contract of their `null` guards; the guard just needs
to actually match the contract), and site 3 should skip a non-record
`update.config` the same way. The invariant to enforce and pin in tests: _a
widget `config` crossing any reducer channel is either a plain record or
ignored; the record test is the single shared `isRecord` shape, never an
ad-hoc `typeof`/truthiness check._ Add the array/string cases to the existing
`config: null` regression tests for all three channels (the current T1-1/T3.3
tests pin only `null`).

---

## Sibling-pattern sweeps performed (pattern classes from the last 3 rounds) — results

Confirming the directive: for every pattern class fixed in iterations 7-9 I
swept the entire package for further instances.

1. **Unguarded bracket lookups keyed by external-ish strings** (iter8
   `MUTATION_HANDLERS[type]`, iter9 `CHART_TYPE_CONFIG_KEYS[chartType]`):
   swept every bracket access in `src/` (grep over `\[[a-zA-Z_.]+\]` plus
   manual read of all hits). All lookup tables are guarded:
   `MUTATION_HANDLERS` (applyMutation.ts:1526, 1554), `MUTATION_ARG_VALIDATORS`
   (parseStateMutation.ts:629), `FILTER_SCOPE_REQUIRED_IDS`
   (parseStateMutation.ts:273), `BUILTIN_OWN_CONFIG_KEYS`
   (configKeyValidation.ts:435), `CHART_TYPE_CONFIG_KEYS`
   (configKeyValidation.ts:487), `BUILTIN_WIDGET_DEFAULTS` (factories.ts:125),
   `migrations[version]` (integer-gated by `Number.isInteger`,
   statePersistence.ts:254/334). Every reducer record read/write from an
   untrusted id goes through `Object.hasOwn` + `isSafePatchKey` or is
   delete-only / own-key iteration. **No remaining instances found.**
2. **Prototype-pollution key writes**: every `record[key] = value` from
   untrusted input is `isSafePatchKey`-gated; both `pages`-map rebuilds use
   `Object.fromEntries`; add-site literal inserts screen ids
   (applyMutation.ts:544, 592, 1362); the load boundary screens `pages` and
   `widgets` keys. **No remaining instances found.**
3. **Partial-payload / null-coercion totality** (iter8 T1-1/T2-\*, iter9
   companion fix): `applyBulkUpdate`'s three layout-omission shapes,
   the colSpans-only merge (aa8133b), `setWidgetColSpan`'s
   `rowWidgetIds` fallback chain, and the load boundary's nested-corruption
   screens (widgets, pages, filters, ai.threads, relationships/
   expressionFields/filterPresets) are all in place and test-pinned — with the
   ONE remaining sibling being the array/primitive gap reported as T2-2 above.
4. **Two-boundaries-disagree validation asymmetries** (iter7 finding 2.3):
   swept every closed union crossing `parseStateMutation` against its
   middleware treatment — `chartType` (aligned), `titleMode`/`subtitleMode`
   (aligned), `scope.kind` (aligned), `filter.operator` (**disagrees** —
   reported as T2-1 above).

## Checked and found clean (not findings)

- **Reference-equality no-op contract**: verified per handler, including the
  merge-shaped ones (`updateWidget`, `applyBulkUpdate.updatedWidgets`) and the
  layout value-equality helpers (`rowsEqual`/`spansEqual` sharing
  `shallowRecordEqual`).
- **`removeWidget`/`removePage`/`applyBulkUpdate` cleanup**: cross-page
  preservation, scoped-filter drops, and span pruning all route through the
  shared `removeWidgetIds`/`dropWidgetScopedFilters`/`removeSpanEntries`/
  `enforceLayoutColSpans`/`dedupeLayoutRows` primitives; no divergent inline
  copy found.
- **Persistence boundary**: `serializeDoc` strip symmetry (cross-filter +
  interactive, on save AND load), empties-are-undefined symmetry, id↔key
  reconciliation for widgets and pages, dangling-`activePageId` reconciliation,
  `migrateState` fail-closed paths (non-integer version, newer-version, registry
  gap, clone failure, nested `findMissingRequiredField`). `deserializeState`'s
  totality is deliberately nested-only (top-level shape is `migrateState`'s
  contract) — consistent with its documented surface.
- **`temporalUtils` fast path**: offset detection (`+`/`-` in the tail),
  range checks, and the `Z`-suffix case are correct; `isoWeek` boundary math
  matches the pinned tests.
- **`aiToolRegistry` vs middleware MCP tools**: the MCP-only data tools
  (`describe_data_source`, `get_field_values`, `render_chart`, …) are
  deliberately outside the registry as `McpExtraToolName`
  (`x-studio-ai-middleware/src/mcp/toolMetadata.ts:20-25`) — not a drift.
- **ARCHITECTURE.md cross-check**: every checked claim (dispatch guards,
  `Object.hasOwn` discipline, colSpans merge semantics, load-boundary screens,
  test inventory) matches the code as of `7461e99`.

Minor observations deliberately NOT reported as findings (Tier 3 / by-design):
the `unsetFields: ['id']` silent-skip vs `changes.id` hard-reject asymmetry
(reducer denylist makes it harmless); `addWidget.pageId`-style optional ids
checked as strings but not `isSafeId` (reducer `Object.hasOwn` guards make an
unsafe id a clean no-op); `findMissingRequiredField` not typing
`dashboard.title`/`activePageId` (the load-boundary reconciliation absorbs it);
`deserializeState`'s `shellOverrides` shallow-merging `openDrawers` where the
factory deep-merges (compile-time-safe today).
