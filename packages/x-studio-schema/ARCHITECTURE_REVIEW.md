# Architecture review — `@mui/x-studio-schema` (iteration 7, fresh pass)

Scope: every file under `packages/x-studio-schema/src/` (all 18 runtime/type modules plus the
7 test files were read in full), cross-checked against `ARCHITECTURE.md`, the last fix round
(`dc6b6df` / `e6de8e6` and predecessors), and the two consuming boundaries
(`@mui/x-studio-ai-middleware/src/executeToolOnState.ts`, `@mui/x-studio`'s
`StudioController` / `StudioChartWidget` call sites) where a finding's impact depends on them.
The full suite (`vitest --config vitest.config.node.mts --run`) passes: 7 files, 396 tests.

Verdict: **no Tier 1 findings.** The reducer is pure, deterministic, doc-partition-confined,
and honors the reference-equality no-op contract in every handler I traced; the prototype-hazard
guards are consistent at all three trust boundaries; migration is fail-closed at every step I
could construct an input for. What remains is a set of **five Tier 2 correctness/robustness
gaps** — three of them validation _asymmetries_ between the wire boundary
(`parseStateMutation`) / load boundary and the AI-tool boundary, exactly the class the previous
rounds have been closing one at a time.

---

## Tier 1 — real bugs / security issues

None found.

Checked specifically (and found sound):

- **Prototype pollution.** Every `record[key] = value` bracket write in `applyMutation.ts` is
  behind `isSafePatchKey`/`Object.hasOwn`; both `pages`-map rebuilds use `Object.fromEntries`;
  the load boundary screens `pages`/`widgets` own keys; the wire boundary rejects unsafe ids and
  unsafe own keys on every config-carrying arg. Object-spread paths (`{ ...updated,
...definedChanges }`, config merges) use define-semantics and cannot re-prototype.
- **Undo-stack integrity.** Every handler returns the same doc reference on a true no-op,
  including the merge-shaped ones (`updateWidget.changes`, `applyBulkUpdate.updatedWidgets`);
  I could not construct a re-delivered mutation that pushes a _scalar-only_ spurious undo entry.
  (Object-valued config keys compared by reference is an explicitly documented trade-off, not a
  regression.)
- **Determinism / partition confinement.** No `Date.now()`/randomness in the reducer
  (`renameAIThread.updatedAt` is producer-stamped); `applyDocMutation` is typed over `StudioDoc`
  so `session`/`runtime` are unreachable at compile time.
- **Migration fail-closure.** Non-integer `schemaVersion` (incl. `NaN`, `0.5`), newer-version,
  registry-gap, clone-failure, and nested-shape (`pages[*]`, `widgets[*].config`, `filters[*]`,
  `filters[*].scope`) paths all reject with named errors; the `0 → 1` identity entry exists;
  the fast path validates too.

---

## Tier 2 — correctness / robustness gaps

### 2.1 Load boundary never reconciles `widget.id` / `page.id` with their record keys

**Where:** `src/statePersistence.ts:444-492` (`deserializeState`'s widget screen/normalize pass)
and `src/applyMutation.ts:339-404` (`normalizePersistedPages`).

**What's wrong:** the reducer treats id↔map-key desync as a first-class invariant — a
`changes.id` is rejected at BOTH the wire boundary (`parseStateMutation.ts:334-336`) and inside
the reducer (`applyMutation.ts:687`) precisely because "writing it through `changes` would desync
`widget.id` from its key and split every id-keyed invariant." But a persisted doc where the
desync _already exists_ (`widgets: { "w-a": { "id": "w-b", … } }`, or the `pages` analogue) loads
verbatim: `deserializeState` screens keys for safety and record-ness only, and
`normalizePersistedPages` never looks at `page.id`. This is the same "invariant enforced
everywhere except the load boundary" pattern that iteration 6 fixed for
`dashboard.activePageId`.

**Failure scenario:** a hand-edited/shared dashboard carries `widgets: { "w-a": { "id": "w-b",
…} }`. The canvas renders the widget from `widgetRows: [["w-a"]]` via the record key, but every
edit affordance passes `widget.id` (`"w-b"`) back: `updateWidget`/`removeWidget`/
`setWidgetColSpan` all hit the `Object.hasOwn(state.widgets, widgetId)` guard and become
**silent no-ops** — the user edits/deletes the widget and nothing happens, with no error
anywhere. A cross-filter the widget emits is scoped to `sourceWidgetId: "w-b"`, which no removal
path can ever clean up (`removeWidgetIds` only sees candidates drawn from row/key ids).

**Fix direction:** in `deserializeState`'s widget pass, re-stamp `id: key` when
`widget.id !== key` (one spread in the existing `.map`); same for `page.id` inside
`normalizePersistedPages`' rebuild branch. Re-stamping (rather than dropping) preserves the
user's data and matches the reconciliation style of the `activePageId` fix. Add round-trip
regression tests in `statePersistence.test.ts`.

### 2.2 `parseStateMutation` accepts an arbitrary `chartType` value through every UPDATE-shaped config channel

**Where:** `src/parseStateMutation.ts:316-386` (`updateWidget` validator: `args.config` and
`args.changes.config`) and `:491-498` (`applyBulkUpdate.updatedWidgets[].config`).

**What's wrong:** on the full-widget path (`addWidget` / `addedWidgets`), an explicit
`config.chartType` must be a string AND a member of the closed `StudioChartType` union
(`parseStateMutation.ts:202-205` — "there are no custom chart types"). On the three
update-shaped config channels, the config interior is an entirely unchecked leaf — including
`chartType` itself. The documented "STATELESS" limitation (`parseStateMutation.ts:192-201`,
echoed in `ARCHITECTURE.md` §configKeyValidation) only justifies skipping the chart-_family
key_ check (which needs the existing widget to resolve an omitted discriminant); the
_membership_ check on an explicitly-present `chartType` needs no state at all, and the AI-tool
boundary performs it (`executeToolOnState.ts` `invalidChartConfigKeyError` →
`isStudioChartType`, a hard error). So the two boundaries disagree: the middleware rejects
`update_widget { config: { chartType: 'bogus' } }`, but the client's wire gate accepts the same
payload — and also accepts `chartType: 42` / `chartType: {}` (not even a string).

**Failure scenario:** a buggy or compromised SSE producer (the exact threat
`parseStateMutation` exists for) sends `updateWidget` with `config: { chartType: 'trendline' }`.
It validates, applies, and **persists**. The client silently renders the widget as a bar chart
(`StudioChartWidget.tsx:631` falls back to `CHART_TYPE_DEFS.bar`), and — worse — every
_subsequent legitimate_ AI `update_widget` against that widget now hard-fails: the middleware
seeds its running chart-type map from the stored config and `invalidChartConfigKeyError`
returns `unknown chartType 'trendline'` for any config patch that doesn't itself overwrite
`chartType`. The widget is wedged against AI edits until a user manually re-picks a chart type.

**Fix direction:** in the `updateWidget` validator (both the `args.config` and
`args.changes.config` branches) and the `updatedWidgets[]` loop, when the record has an own
`chartType` with a non-`undefined` value, require `isString(v) && isStudioChartType(v)` —
mirroring the `validateWidget` check verbatim. (`chartType: undefined` must stay legal: it is
the sanctioned patch-delete of the key.)

### 2.3 `validateWidget`'s chart-family check is bypassable by omitting `chartType`, and both its comment and `ARCHITECTURE.md` misstate why

**Where:** `src/parseStateMutation.ts:192-210` (the `widget.config.chartType !== undefined`
gate); comment at `:196-201`; `ARCHITECTURE.md` §configKeyValidation ("even a widget with an
omitted `chartType` cannot be chart-family-validated here because the parser has no access to
'the existing widget' to resolve the discriminant").

**What's wrong:** for an `addWidget` / `applyBulkUpdate.addedWidgets` payload there IS no
existing widget — the effective chart type of a fresh config with no `chartType` is `'bar'` _by
definition_ (`resolveChartType`'s `?? 'bar'`; the empty config is a valid bar config). The
middleware's own add path applies exactly that rule: `buildWidgetFromArgs`
(`executeToolOnState.ts:372-379`) calls `invalidChartConfigKeyError(config, undefined)`, which
resolves `'bar'` and **rejects** e.g. `{ sankeyTargetField: 'x' }` with no `chartType`. The
parser instead skips the family check entirely when `chartType` is absent. Result:
`addWidget { kind: 'chart', config: { sankeyTargetField: 'x' } }` passes the wire gate while
the semantically identical `{ chartType: 'bar', sankeyTargetField: 'x' }` is rejected — the
fail-closed family check is defeated by simply deleting one key, and the wire boundary is
strictly weaker than the AI-tool boundary for the same payload. The "cannot be validated"
rationale is only true for `updateWidget` config _patches_; for full-widget adds it is wrong,
and `ARCHITECTURE.md` repeats the wrong version.

**Failure scenario:** low severity in isolation (a stray foreign-family key on a stored config
is tolerated by the key-retention feature), but it silently voids the guarantee the boundary
advertises — a widget the middleware itself would refuse to build validates cleanly when
replayed at the client, so the server-threaded state and client-applied state can diverge for
exactly the payload class this check was added to reject.

**Fix direction:** when `widget.kind === 'chart'` and `config.chartType` is absent, run
`validateChartConfigKeysForType('bar', widget.config)` (same effective-type rule as the
middleware). This is compatible with the documented "full-widget variants carry FRESHLY-BUILT
configs only" constraint — a round-tripped stored config already must go through
`stripForeignFamilyKeys` first. Update the in-file comment and the `ARCHITECTURE.md` sentence
to scope the statelessness caveat to `updateWidget` patches only.

### 2.4 `deserializeState`'s "total over nested-corrupt docs" direct-call surface still lets `widgets[*].config: null` through

**Where:** `src/statePersistence.ts:454-457` (the widget-entry screen drops non-record
_widgets_ but keeps a record widget whose `config` is not a record).

**What's wrong:** iteration 6 explicitly established that `deserializeState` "is a public API
callable directly on a `SerializedStudioState` (its documented 'total over nested-corrupt docs'
surface)" and used that contract to justify defensively dropping corrupt `filters` entries and
junk `ai` even though `migrateState` already rejects them. The same contract is not honored for
`widget.config`: a direct call with `widgets: { w1: { id: 'w1', kind: 'chart', title: '',
config: null } }` sails through (the normalize pass reads `config?.columns` with optional
chaining, so `deserializeState` itself doesn't throw) and installs a live widget whose first
render throws — `StudioChartWidget.tsx:470` reads `config.chartType` off `null`
(`TypeError: Cannot read properties of null`), taking the canvas down. `migrateState` names the
field (`widgets["w1"].config`), but nothing forces a host to pair the two calls, and the whole
point of the iter-6 fixes was that the direct path must not install state that throws later.

**Failure scenario:** host app persists/loads its own docs and calls `deserializeState`
directly (the API contract permits it); a hand-edited doc with `"config": null` on one widget
crashes the dashboard at first paint instead of degrading.

**Fix direction:** in the same `.filter` that drops non-record widget values, either drop a
widget whose `config` is not a record, or (gentler, matching the `relationships`-style
coercions) rebuild it with `config: {}`. One regression test alongside the existing
"null widget value is dropped" case.

### 2.5 Two reducer handlers throw — instead of no-op — on parser-bypassing partial payloads, against the file's own convention

**Where:** `src/applyMutation.ts:959-974` (`setWidgetColSpan`) and `:1150-1206`
(`applyBulkUpdate`).

**What's wrong:** the file has a deliberate, repeatedly-stated convention of being _total_ over
mutations "the server constructs WITHOUT the parser" — `updateWidget` guards `config: null` and
`changes.config: null`, `normalizeConfigChartSeries` tolerates a non-record config,
`normalizeChartSeries` tolerates `ySeries: [null]`, `addWidget` tolerates a null config, all
justified by that exact threat. Two paths break the convention:

- `setWidgetColSpan`: `const rowWidgetIds = currentRow ?? args.rowWidgetIds` then
  `rowWidgetIds.filter(...)` (`:967`). For a widget that is in `state.widgets` but on no page
  (the documented not-yet-placed case) and a payload missing `rowWidgetIds`, this is a
  `TypeError` mid-apply rather than a guarded fallback — even though the producer's own rule
  (`executeToolOnState.ts:776`, `currentRow ?? [widgetId]`) shows the correct default.
- `applyBulkUpdate`: the three widget-delta fields are defensively defaulted
  (`removedWidgetIds ?? []`, `addedWidgets ?? []`, `updatedWidgets ?? []` at `:1178`, `:1237`,
  `:1248`, `:1275`) but the two layout fields are not — `widgetRows.map(...)` (`:1188`) and
  `Object.keys(widgetColSpans)` (`:1201`) throw on an absent field. The handler is
  half-tolerant of exactly the partial-payload class its own `?? []`s anticipate.

**Failure scenario:** a future middleware tool (or a test fixture) builds one of these
mutations by hand — the established pattern in `executeToolOnState.ts`, which never runs
`parseStateMutation` — and omits a field. Instead of the graceful degraded apply every sibling
handler provides, `applyMutation` throws mid-agentic-turn (server) or mid-SSE-apply (client),
aborting the whole commit.

**Fix direction:** `const rowWidgetIds = currentRow ?? args.rowWidgetIds ?? [widgetId];` in
`setWidgetColSpan`, and `(widgetRows ?? [])` / `(widgetColSpans ?? {})` (or an
`isRecord`-guarded read) in `applyBulkUpdate`. Both are behavior-preserving for all
parser-validated and current-producer input.

---

## Notes below the reporting threshold (no action required; recorded for transparency)

- **Config-interior own `__proto__` keys persist benignly on non-patch write paths.** The
  `updateWidget` config-PATCH loop filters `isSafePatchKey` per key, but `changes.config`
  (wholesale), `addWidget.widget.config`, and both `applyBulkUpdate` config paths install/merge
  via object spread. Spread uses define-semantics, so there is **no pollution** — but a
  server-built payload's own `"__proto__"` config key persists into the live doc and round-trips
  (the load boundary screens `pages`/`widgets` record keys, not config interiors). Junk-data
  hygiene only; the wire boundary already rejects it via `hasUnsafeOwnKeys`.
- **`addFilter` can install permanently-orphaned page/widget-scoped filters.** The reducer
  applies the filter verbatim (documented), so a `widget`-scoped filter naming a nonexistent
  widget persists forever as dead weight — the only cleanup trigger (widget removal) can never
  fire. Cross-filter/interactive variants of the same problem are already neutralized at both
  persistence directions. Harmless (a filter scoped to a nonexistent widget affects no rows).
- **`ARCHITECTURE.md` §factories abbreviates the id format** — the random suffix is
  `Math.random().toString(36).slice(2, 6)` (4 chars), not the full `random.toString(36)` the
  doc writes. Cosmetic.
- **`anomalyDetection.ts` uses `Array.prototype.toSorted`** (ES2023) — fine for the stated
  Node ≥ 17 toolchain floor and current browsers, noted only because the package otherwise
  advertises very broad importability.

## ARCHITECTURE.md accuracy

Cross-checked every checkable claim (module inventory, 14 mutation kinds, the seven test files,
the no-test-file rationales for `widgetTypeGuards`/`unsafeKeys`/`aiToolRegistry`, the
`STUDIO_CHART_TYPES` runtime length pin in `configKeyValidation.test.ts:256`, serialization
strip/omit semantics, migration fail-closed paths, the `GRID_COLS`/`MIN_SPAN` single-source
claim, consumer wiring). One substantive inaccuracy found, folded into finding **2.3**: the
§configKeyValidation sentence claiming an omitted `chartType` "cannot be chart-family-validated
here because the parser has no access to 'the existing widget'" is wrong for the
`addWidget`/`addedWidgets` path, where no existing widget exists and the effective type is
`'bar'` by definition. Everything else matched the current source.

## Summary

| Tier | Count | Findings                                                                                                                                                                                                                                                                                                                 |
| ---- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | 0     | —                                                                                                                                                                                                                                                                                                                        |
| 2    | 5     | 2.1 id↔key desync unreconciled at load; 2.2 update-path `chartType` membership unvalidated at the wire; 2.3 chart-family check bypassable by omitting `chartType` (+ doc misstatement); 2.4 `widgets[*].config: null` survives the direct-call load surface; 2.5 two handlers throw on parser-bypassing partial payloads |
