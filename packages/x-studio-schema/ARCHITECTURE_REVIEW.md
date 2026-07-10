# Architecture review — `@mui/x-studio-schema` (fresh pass, iteration 11)

**Summary: 0 Tier-1, 1 Tier-2, 6 Tier-3 findings.**

Scope: full read of every runtime module (`applyMutation.ts`, `parseStateMutation.ts`,
`statePersistence.ts`, `configKeyValidation.ts`, `widgetTypeGuards.ts`, `factories.ts`,
`temporalUtils.ts`, `anomalyDetection.ts`, `unsafeKeys.ts`, `aiToolRegistry.ts`, `index.ts`)
plus every type module, cross-checked against the consuming packages where a failure
scenario depends on them. After 10 prior fix rounds the core surfaces are in genuinely
good shape: the mutation reducer's no-op/idempotency/prototype-hygiene contracts held up
under adversarial reading, the three mapped-type exhaustiveness locks are real, the
compile-time key-tuple locks in `configKeyValidation.ts` cover every current chart family
and widget kind (no newly-added config shape has skipped validation — `forecast`,
`heatYField`, the funnel cumulative-mode keys, `mapLegendAlign`, etc. are all present in
their tuples and `AssertKeysCovered`-locked), and I found **no Tier-1 issue**. The one
Tier-2 finding is a sibling-site gap of an invariant the previous rounds established but
applied to only two of the five persisted collections.

---

## Finding 1 (Tier 2) — `relationships` / `expressionFields` / `filterPresets` entries are never screened: a single junk entry loads cleanly, crashes the client on first use, and round-trips through autosave forever

**Files:**

- `packages/x-studio-schema/src/statePersistence.ts:600-604` (`deserializeState` — container-only `Array.isArray` coercion for the three collections)
- `packages/x-studio-schema/src/statePersistence.ts:181-228` (`findMissingRequiredField` — no check at all for these fields, not even container type)
- `packages/x-studio-schema/src/statePersistence.ts:416-418` (`serializeDoc` — `.length > 0` container checks re-persist junk entries verbatim)

**Invariant violated (general form):** _every persisted collection's ENTRIES are screened at
the load boundary before installing into the live doc — not just the container._ Prior
rounds established and enforced this invariant for four collections: `pages[*]` and
`widgets[*]` (non-record values dropped, unsafe keys dropped, id↔key reconciled),
`filters[*]` (non-record / scope-less entries dropped, `statePersistence.ts:588-594`), and
`ai.threads[*]` (non-record entries dropped, T2-3, `statePersistence.ts:550-555`). The three
remaining persisted collections got only a _container_-level `Array.isArray` coercion, so
`relationships: [null]`, `expressionFields: [null]`, and `filterPresets: [null]` (or any
non-record entry — a string, a number) all install into the live `doc` verbatim.

**This is reachable through the NORMAL load path, not just the direct-call surface:**
`StudioController.loadSerializedState` runs `migrateState` → `deserializeState`
(`packages/x-studio/src/store/StudioController.ts:2292-2296`), and `findMissingRequiredField`
does not name any of these three fields, so migration succeeds.

**Concrete failure scenarios** (all from a shared/hand-edited persisted doc — the exact
untrusted boundary the package's own docs name for the sibling screens):

1. `expressionFields: [null]` — loads fine; the first widget evaluation with a source hits
   `expressionFields.filter((ef) => ef.sourceId === sourceId …)` in
   `packages/x-studio/src/internals/enrichedRowsCache.ts:164` (and
   `internals/grainResolution.ts:131`) → `TypeError: Cannot read properties of null
(reading 'sourceId')` → canvas crash on first paint.
2. `relationships: [null]` — `relationships.find((r) => r.sourceId === …)` in
   `packages/x-studio/src/internals/queryDescriptor.ts:126` (and the L4 join path) throws
   the same way for any cross-source widget.
3. `filterPresets: [null]` — the filters drawer's preset matching
   (`packages/x-studio/src/components/StudioFiltersDrawer/StudioFiltersDrawer.tsx:223`,
   reading `p.id` per entry) throws on drawer render; `applyFilterPreset`
   (`packages/x-studio/src/store/docTransforms.ts:367`, `idMap.set(f.id, …)`) throws on
   apply.
4. **Nested sibling site:** a well-formed preset whose inner `filters` array carries a
   `null` entry (`filterPresets: [{ id, name, filters: [null] }]`) crashes
   `applyFilterPreset`'s id-remap loop the same way — the per-entry screen, wherever it is
   added, should also require `filters` to be an array of records on each surviving preset.
   (A cross-filter/interactive _scope_ inside a preset filter is, by contrast, harmless:
   `applyFilterPreset` re-stamps every applied filter's scope to
   `{ kind: 'page', pageId: activePageId }`, so the serialize/deserialize scope-strip
   invariant is not bypassable through presets.)

**Why this is worse than a one-off crash:** `serializeDoc` re-persists the junk verbatim
(its `relationships.length > 0` / `filterPresets?.length` checks are container-only), so
the corruption **round-trips through every autosave and undo snapshot indefinitely** — the
same deferred-landmine class the T2-3 (`ai.threads`) and `filters[null]` fixes closed.
There is no test coverage: `statePersistence.test.ts` pins container coercion
(`relationships: "junk"` → `[]`) but never a junk _entry_.

**Sibling sweep result:** the gap is exactly these three collections plus the nested
`filterPresets[*].filters`. All other persisted collections (`pages`, `widgets`,
`filters`, `ai.threads`) are already screened per-entry. Deeper leaves this package never
reads (`ai.threads[*].messages`, `expressionFields[*].expression` interior) are consistent
with the package's stated "screen what other code keys/iterates on" depth rule only if the
three collections above are fixed — the client iterates all three on hot paths.

**Fix direction:** in `deserializeState`, filter each of the three arrays with the same
`isRecord` per-entry screen the `filters` line already uses (for `filterPresets`,
additionally require `Array.isArray(p.filters)` and screen its entries with `isRecord`),
reference-stable when nothing is dropped. Optionally mirror the `filters[i]`-style named
checks into `findMissingRequiredField` so `migrateState` reports them by name. Add the
missing per-entry regression tests alongside the existing container-coercion ones.

---

## Finding 2 (Tier 3) — closed-union leaf fields membership-checked at the wire boundary are not checked at the load boundary (`operator`/`operator2`, `chartType`, filter `scope.kind`)

**Files:**

- `packages/x-studio-schema/src/parseStateMutation.ts:334-339` (wire: `operator`/`operator2` membership, T2-1), `:136-141` + `:243-249` (wire: `chartType` membership, finding 2.2), `:272-287` (wire: `scope.kind` membership)
- `packages/x-studio-schema/src/statePersistence.ts:458-521` (load: widget `config.chartType` never membership-checked), `:588-594` (load: filter entries checked for record-ness and the two stripped scope kinds only — `operator` and an unknown `scope.kind` load verbatim)

**Invariant violated:** _a closed-union leaf whose junk value produces a silent fail-open
(not a crash) must be membership-checked at every untrusted boundary._ The package's own
T2-1 rationale says an unrecognized `operator` "installs a filter chip that renders as
ACTIVE while filtering nothing" and its finding-2.2 rationale says a junk stored
`chartType` "wedges every later legitimate AI `update_widget` on that widget (the
middleware hard-errors on an unknown stored chartType)". Both hazards were closed at the
wire boundary but remain fully open at the load boundary, which the package's own docs
treat as an equally untrusted surface (shared/hand-edited docs) and where prototype-key,
shape, and id↔key screening were all added for exactly that reason.

**Concrete failure scenario:** a hand-edited doc with `filters: [{ …, operator: 'equal' }]`
(plausible typo for `'equals'`) loads verbatim → active chip, filters nothing — the exact
silently-wrong-data failure T2-1 exists to prevent. A doc with
`widgets.w1.config.chartType: 'trendline'` loads verbatim → blank/default chart
client-side, and the AI middleware hard-errors on the next `update_widget` targeting it.

**Sibling sites:** `filters[*].operator`, `filters[*].operator2`, `filters[*].scope.kind`
(a junk kind like `'pages'` also escapes `removePage`'s `'pageId' in f.scope` cleanup and
`dropWidgetScopedFilters`, surviving as a permanent inert entry), and
`widgets[*].config.chartType`. The safe-degrading leaves (`filterMode`, `conjunction`,
`rankDirection`, `dateRangePreset`, `titleMode`) are deliberately unchecked at the wire
boundary and need nothing at load either.

**Why Tier 3:** requires a hand-edited doc, produces wrong display / a wedged tool rather
than a crash or data loss, and the fix has a real semantic choice to make (drop the filter
entry vs. keep it disabled; drop the `chartType` key vs. the widget). Worth doing for
wire/load symmetry, not urgent.

**Fix direction:** in `deserializeState`'s filter screen, additionally require
`isStudioFilterOperator(f.operator)` (and `operator2` when present) and
`Object.hasOwn(FILTER_SCOPE_REQUIRED_IDS, f.scope.kind)`-equivalent membership (the table
would need exporting or duplicating as a small local list); in the widget normalization
loop, drop a present non-member `chartType` key (letting the `'bar'` fallback apply) the
way junk `columns` is left for validation — or, more conservatively, only fix `operator`,
which is the silent-fail-open case.

---

## Finding 3 (Tier 3) — `applyBulkUpdate`: a present-but-non-array `widgetRows` coerces to `[]` and wipes the active page's layout, contradicting the T1-1 rationale that absence must preserve it

**File:** `packages/x-studio-schema/src/applyMutation.ts:1277-1284`.

**Invariant violated:** _a malformed layout field must never be interpreted as "replace the
layout with nothing"._ T1-1 established this for the ABSENT case (`widgetRows: undefined`
now reconciles against the page's existing rows). The present-but-junk case
(`widgetRows: null`, from a hand-built server payload — `parseStateMutation` rejects it on
the wire) takes the third branch and coerces to `[]`, which un-places every widget on the
active page and then lets `enforceLayoutColSpans` drop all their spans as orphans — the
exact blank-page outcome T1-1 was about. The chosen coercion is documented ("the same
'stay total, don't throw on `.map`' coercion `widgetColSpans` gets"), but the analogy is
imperfect: junk `widgetColSpans → {}` is harmless (spans merge/replace), junk
`widgetRows → []` is destructive. Treating a non-array `widgetRows` as ABSENT
(`page.widgetRows ?? []`) is equally total and strictly safer.

**Sibling sweep:** `setWidgetLayout.args.rows` has no such branch (the wire type is
required and the reducer would throw on `null.map` for a parser-bypassing payload — but
that handler documents no totality contract over hand-built junk, unlike `applyBulkUpdate`
which explicitly does). No other handler interprets a non-array as "empty layout".

**Fix direction:** change the third branch to `safeRows = page.widgetRows ?? []` and update
the comment + add a regression test (`widgetRows: null` leaves layout untouched).

---

## Finding 4 (Tier 3) — own-unsafe-key screening is asymmetric across the reducer's config channels: verbatim-install channels can persist an own `__proto__` config key that then round-trips forever

**Files:**

- Screened (per-key `isSafePatchKey`): `packages/x-studio-schema/src/applyMutation.ts:697-713` (`updateWidget` config-patch loop).
- Unscreened (whole record installed/merged verbatim): `applyMutation.ts:759-764` (`updateWidget` `changes.config` wholesale replacement), `:1437-1449` (`applyBulkUpdate.updatedWidgets[].config` spread-merge), `:634-645` (`addWidget` — `widget.config` installed as-is), `:1392-1403` (`applyBulkUpdate.addedWidgets`); and `statePersistence.ts:458-521` (`deserializeState` screens the `widgets` record's KEYS but never the config's own interior keys).

**Invariant violated:** _no own `__proto__`/`constructor`/`prototype` key ever enters the
doc_ — currently guaranteed only on the wire path (`parseStateMutation`'s
`hasUnsafeOwnKeys` covers all four config channels) and on the one key-by-key reducer
channel. A server-built mutation that bypasses the parser (the established
`executeToolOnState` pattern the reducer's other defense-in-depth guards exist for) with
`changes: { config: JSON.parse('{"__proto__":{}}') }` installs the config verbatim; the
key is inert inside this package (every rebuild uses spread/`Object.fromEntries`
define-semantics, and the patch loop skips it), but it serializes
(`JSON.stringify` includes an own `__proto__` data property), survives
`deserializeState` (config interior unscreened), and round-trips indefinitely — a latent
hazard for any downstream consumer that rebuilds a config with bracket assignments.

**Why Tier 3:** no pollution is reachable inside this package; the wire boundary already
rejects it; only hand-built server payloads create it, and the persisted key is inert
junk. This is a uniformity gap, not a live vector.

**Fix direction:** cheapest single point — strip unsafe own keys from a config once in
`coerceWidgetConfig`/`normalizeConfigChartSeries` (add channels) or screen config interior
keys at the load boundary alongside the existing widget-key screen. Alternatively accept
and document the asymmetry in ARCHITECTURE.md (the current text implies uniform coverage).

---

## Finding 5 (Tier 3) — `deserializeState` rebuilds every widget with a non-empty `columns`/`ySeries` on every load, even when normalization is an identity

**File:** `packages/x-studio-schema/src/statePersistence.ts:505-521`.

The empty-array reference-stability fix (documented in the code: "an empty `columns: []` …
is left untouched for reference stability") stopped churn only for the empty case. For a
non-empty, already-canonical `columns`/`ySeries` — the common case for every configured
grid and chart widget — `columns.map(normalizeGridColumn)` / `ySeries.map(normalizeChartSeries)`
mint a fresh array (the inner entries ARE reference-stable, the array and hence the config
and widget are not), so every load rebuilds nearly every widget object.
`normalizeConfigChartSeries` in `applyMutation.ts:180-202` already demonstrates the
changed-flag pattern that makes this identity-preserving. Impact is one-time-per-load
reference churn (defeats cross-load memoization only), so Tier 3.

**Sibling sweep:** `normalizePersistedPages` and the `filters`/`ai.threads` screens are all
already identity-preserving on the no-op path; this is the only load-boundary normalizer
that is not.

**Fix direction:** track whether any entry changed (as `normalizeConfigChartSeries` does)
and return `[id, base]` when nothing did.

---

## Finding 6 (Tier 3) — `truncateToPeriod`'s `new Date(...)` fallback makes period keys environment-dependent for non-canonical strings, undercutting the module's cross-package agreement goal

**File:** `packages/x-studio-schema/src/temporalUtils.ts:56-68` (fallback), `:32-53` (fast path).

The module exists so "the client's chart date-bucketing and the AI's `summarise_page`
grouping always agree on where a period boundary falls" (ARCHITECTURE.md). Canonical ISO
strings, offset-carrying strings, `Date`s, and numeric timestamps are all deterministic.
But a non-canonical string — `'2024-6-1'` (fails the `value[4] === '-'` fast-path shape),
`'06/01/2024'`, etc. — falls back to `new Date(value)`, which parses in the HOST's local
timezone; the subsequent `getUTC*` reads then bucket it by UTC. A browser in Tokyo buckets
`'06/01/2024'` (local midnight June 1 = May 31 15:00 UTC) into `2024-05-31`, while a UTC
server buckets it into `2024-06-01` — the two consumers disagree on the period key for the
identical row value. Also `'2024-6-1'` and `'2024-06-01'` can land in different buckets on
the same non-UTC host.

**Why Tier 3:** only non-ISO date strings from host data sources trigger it, the ambiguity
is inherent to local-format strings, and no in-repo producer emits them. Worth a doc note
(the current JSDoc implies general safety for "other Date-parseable strings") and possibly
a lenient-ISO widening of the fast path (`YYYY-M-D`); a full fix is not warranted.

---

## Finding 7 (Tier 3) — `addFilter` accepts `cross-filter`/`interactive` scopes anchored to nonexistent widgets, installing a session-lifetime orphan filter with no clearing affordance

**Files:** `packages/x-studio-schema/src/applyMutation.ts:1180-1196` (verbatim append, no
existence check), `packages/x-studio-schema/src/parseStateMutation.ts:264-287`
(`validateFilterScope` accepts all five kinds).

**Invariant violated:** _a cross-filter/interactive entry must always have a live source
widget as its clearing affordance._ The load boundary refuses to install these scopes
precisely because "an orphaned cross-filter naming a widget the doc doesn't contain would
otherwise permanently filter its page with no surviving affordance to clear it"
(`statePersistence.ts:574-587`) — the reducer's cleanup only fires on widget REMOVAL,
which never fires for a widget that never existed. Yet the wire boundary accepts an
`addFilter` with `scope: { kind: 'cross-filter', sourceWidgetId: 'no-such-widget', … }`
and the reducer appends it verbatim, producing exactly that orphan for the live session
(it is stripped at the next persist, so the damage is session-scoped — hence Tier 3, and
no current producer emits such a payload; it requires a buggy/hostile server).

**Fix direction:** either reject `cross-filter`/`interactive` scopes outright in
`validateFilter` (no legitimate server-side producer exists today — cross-filters are a
client gesture), or have the `addFilter` handler no-op when
`scope.sourceWidgetId` is not in `state.widgets` (mirroring `setWidgetColSpan`'s
unknown-widget guard).

---

## Explicitly checked and found sound (no finding)

- **Reducer dispatch and all 14 handlers**: `Object.hasOwn` discipline is uniform; every
  no-op path returns the same reference (verified per handler, including the merge-shaped
  ones); `undefined`-valued patch keys, the unset denylist, and the four-step
  `updateWidget` order match the documented contract; `applyBulkUpdate`'s three
  partial-payload shapes behave as documented (the T1-1/T2-2 fixes are correctly in
  place). A `removedWidgetIds` entry still named in the bulk's own `widgetRows` resolves
  to KEEP (fail-safe) — defensible, not a bug.
- **Exhaustiveness locks**: `MUTATION_HANDLERS` / `MUTATION_ARG_VALIDATORS` mapped types,
  `AssertChartTypesCovered`, `AssertAllChartTypesListed`, `AssertAllFilterOperatorsListed`,
  and every per-family `AssertKeysCovered` are all present and correctly formed; the key
  tuples were diffed against the interfaces by hand — complete, including the newest
  config keys (`forecast`, `funnelReachedField`/`funnelStageSequence`, `mapLegendAlign`,
  `barMinBandSize`, `kpiSparklineGaugeMax`).
- **`OptionalWidgetField` vs the runtime unset denylist**: `StudioWidget`'s optional keys
  are exactly `titleMode`/`subtitle`/`subtitleMode`/`sourceId`; the reducer's
  `id`/`kind`/`title`/`config` denylist matches the required set. The parser comment
  "titleMode/subtitleMode are the only other fields a wholesale changes merge can carry"
  is accurate against the current `StudioWidgetOf` shape.
- **`migrateState`**: fail-closed version derivation, gap-is-hard-failure, clone-failure
  totality, and post-migration nested validation all verified; the fast path's same-
  reference return is deliberate and safe.
- **`aiToolRegistry`**: the MCP-only data tools (`describe_data_source`,
  `get_field_values`, `compute_field_stats`, `get_recent_changes`, `render_chart`) are
  deliberately outside the registry with their own `EXTRA_TOOL_TITLES` path in the
  middleware (`mcp/toolMetadata.ts`) — not a drift.
- **`makeIdFactory`, `anomalyDetection`, `unsafeKeys`, `normalizeChartSeries`**: no issues;
  `detectAnomaliesIQR` is total over `NaN` inputs (returns no anomalies rather than
  throwing).
