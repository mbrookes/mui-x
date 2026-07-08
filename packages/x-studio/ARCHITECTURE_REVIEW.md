# Architecture / tech-debt review — `@mui/x-studio`

Independent review of `packages/x-studio/src/`, covering the current working tree. Full reads:
the state layer (`store/StudioController.ts`, `store/docTransforms.ts`,
`internals/rankFilterScope.ts`, `context/selectors.ts`, `context/StudioContext.tsx`), the data
pipeline (`internals/StudioPipeline.ts`, `enrichedRowsCache.ts`, `resolvedRowsCache.ts`,
`StudioRequestCache.ts`, `filterScoping.ts`, `useWidgetRows.ts`, `useAdapterRows.ts`,
`queryDescriptor.ts`, `chartTypeRegistry.ts`), the chart widget stack (`StudioChartWidget.tsx`,
`chartTypeDefs.tsx`, `useChartWidgetData.ts`), the compose drawer core
(`ChartSetupPanel.tsx`, `GridSetupPanel.tsx`, the shared `CrossFilterModeSection.tsx` /
`fieldCatalog.ts`, KPI/Map panel interaction sections, `ChartTypePicker.tsx` wiring), the canvas
(`StudioCanvas.tsx`, `StudioWidgetCard.tsx` core), the registry layer (`widgetRegistry.ts`,
`builtinWidgetDefs.ts`, `widgetUtils.tsx`), and `Studio.tsx`/`StudioContent.tsx`. Triaged
(skimmed or grep-audited rather than read line-by-line, as lower-risk periphery): locales, icons,
the chat panel, `server/createBatchingAdapter.ts`, per-chart renderer internals
(`StudioBarChart.tsx` etc.), map/KPI widget internals, filters-drawer UI, and benchmarks.
Cross-package claims were verified against `packages/x-studio-schema`
(`applyMutation.ts`, `widgetTypes.ts`, `widgetTypeGuards.ts`, `configKeyValidation.ts`,
`statePersistence.ts`) and `packages/x-studio-ai-middleware` (`executeToolOnState.ts`) source
directly, not taken from comments or `ARCHITECTURE.md`. Line numbers refer to the current working
tree. Both Tier 1 findings were additionally **verified by executing them** against the real
`StudioController` in a scratch vitest run (not just by reading).

**Partition/invariant sanity-check:** the doc/session/runtime partition holds up under direct
inspection. `commitState` (`StudioController.ts:117-165`) pushes an undo entry only when
`nextState.doc !== current.doc`, so session/runtime-only commits are structurally non-undoable
regardless of the `undoable` flag; `undo`/`redo` swap only `doc` plus the one documented
cross-partition normalization (`normalizeSessionAfterDocSwap`, nulling a dangling
`selectedWidgetId`). The shared reducer really is doc-only (`applyDocMutation` takes a
`StudioDoc`; handlers cannot reach session/runtime by type), and the AI middleware's
`executeToolOnState` computes `nextState` through the same `applyMutation` the client applies via
`applyExternalMutation`, with wire-sourced mutations gated through `parseStateMutation`
(`applyStateMutation.ts`). Persistence (`statePersistence.ts:319-339`) serializes the doc only and
strips cross-filter/interactive filter entries; migrations fail closed on registry gaps and
partial docs. `carryTransientDocState` does carry interactive filters, both cross-filter dashboard
toggles, and `activePageId` across **both** undo and redo (pinned by tests) — but it carries
`activePageId` without checking the incoming doc contains that page, which is Tier 1 finding 1.2.
The one documented chart dispatch cast (`StudioChartWidget.tsx:719-726`) is sound for every real
`StudioChartType`: the looked-up key and `renderContext.config.chartType` are derived from the
same object. The only soft spot is the `?? CHART_TYPE_DEFS.bar` fallback
(`StudioChartWidget.tsx:597`): a hand-edited persisted doc with an unknown `chartType` string
renders through `renderBar` with that string flowing into `StudioBarChart`'s `chartType` prop —
degraded-but-harmless, and unreachable through any in-app write path.

---

## Tier 1: Correctness & Security

### 1.1 `crossFilterMode` writes are silently stripped for grid / KPI / map widgets — three setup-panel "Interactions" toggles are dead

- `packages/x-studio-schema/src/widgetTypes.ts:202-209` (`crossFilterMode` declared only on `StudioChartConfigBase`)
- `packages/x-studio-schema/src/configKeyValidation.ts:58-64` (`SHARED_CONFIG_KEYS` — no `crossFilterMode`), `:69-80` (grid), `:324-344` (kpi), `:390-404` (map)
- `packages/x-studio/src/store/StudioController.ts:900-923` (the kind-level write guard that drops it)
- Write sites: `components/StudioComposeDrawer/GridSetupPanel.tsx:691-700`, `KpiSetupPanel.tsx:448-455`, `MapSetupPanel.tsx:270-278` (all via the shared `CrossFilterModeSection`, which calls `updateWidgetConfig(widgetId, { crossFilterMode })`)
- Read sites that honor it for these kinds: `internals/useWidgetRows.ts:268-271`, `components/widgets/StudioGridWidget/StudioGridWidget.tsx:200-206`, `components/widgets/StudioKpiWidget/StudioKpiWidget.tsx:748-750`

`crossFilterMode` is a genuinely cross-kind key: the runtime honors it for every widget kind
(`useWidgetRows` resolves `effectiveRows`/ghost behavior from it; the grid widget even carries a
comment saying it is "declared on the chart config but honored" cross-kind). But the two-level
write-side validator added with the config-key migration treats it as chart-only: it appears in
every chart-family tuple and nowhere else. `StudioController.updateWidgetConfig`'s kind guard
therefore flags it as invalid for `grid`/`kpi`/`map` and drops it from the patch.

Empirically verified against the real controller: `updateWidgetConfig('grid1', { crossFilterMode:
'none' })` leaves the config untouched, logs `MUI X Studio: Ignoring config key(s) not valid for a
'grid' widget … crossFilterMode`, **and still pushes an undo entry** (see 2.2). The existing panel
tests don't catch this because they mock the controller and assert only that `updateWidgetConfig`
_was called_ (`MapSetupPanel.test.tsx:176-214`, `KpiSetupPanel.test.tsx:141-175`) — the strip
happens inside the real controller they never exercise. The same schema table drives the AI
middleware (`executeToolOnState.ts:119-124`), so an AI `update_widget` setting `crossFilterMode`
on a non-chart widget is rejected as a hard tool error too.

**Failure scenario:** in edit mode, open a grid/KPI/map widget's setup panel → Interactions →
click "None" (or "Filter"). Nothing changes: the toggle snaps back to its previous value, the
widget keeps responding to cross-filters, a dev-only console warning fires, and a junk undo entry
is pushed. The feature is unreachable for all three kinds; only chart widgets can change
cross-filter mode.

**Fix:** move `crossFilterMode` into `StudioSharedWidgetConfig` (and `SHARED_CONFIG_KEYS`) — it is
already read cross-kind, so the shared bag is its honest home — or add it to the
grid/kpi/map config interfaces and their key tuples (the `AssertKeysCovered` locks will force the
tuples to follow the interfaces). Add a non-mocked controller round-trip test per panel
(`updateWidgetConfig` → read back from `getState()`).

### 1.2 `carryTransientDocState` carries a dangling `activePageId` across undo of `addPage` (and redo of `removePage`)

- `packages/x-studio/src/store/StudioController.ts:238-249` (unconditional `activePageId` overlay), `:1630-1651` (`undo`), `:1655-1671` (`redo`)

`carryTransientDocState` overlays the _current_ doc's `activePageId` onto the swapped-in doc so an
unrelated Ctrl+Z doesn't yank the user back to an old page. The interactive-filter carry prunes
entries whose `sourceWidgetId` no longer exists in the incoming doc, but the `activePageId` carry
has no equivalent existence check: when the current active page **is itself the thing the swap
removes**, the carried id points at a page the incoming doc doesn't contain.

Empirically verified: `addPage('Second')` (undoable; creates + activates the page) followed by
`undo()` yields `doc.pages = { 'page-1' }` with `doc.dashboard.activePageId = 'page-<ts>'` — a
dangling reference. `selectActivePage` returns `undefined`, so `StudioCanvas` falls into its
"empty dashboard" placeholder (`StudioCanvas.tsx:532-563`), and every active-page-guarded
controller method (`addWidget`, `setWidgetLayout`, `duplicateWidget`, `updateActivePage`,
`setPageStackBreakpoint`, …) silently no-ops until the user manually clicks a page tab. The redo
mirror (redo of `removePage` while navigated onto the doomed page) dangles the same way. The test
suite pins the carry only for pages that exist in both docs
(`StudioController.test.ts:2537-2576`), so this gap is untested.

**Failure scenario:** user adds a page (auto-navigated to it), then presses Ctrl+Z to undo the
add. The canvas goes blank ("empty dashboard"), the page tabs show no active page, and further
edit gestures on the canvas do nothing. No crash, but the user appears stuck until they click a
tab.

**Fix:** in `carryTransientDocState`, only overlay `activePageId` when
`Object.hasOwn(incomingDoc.pages, currentDoc.dashboard.activePageId)`; otherwise keep the incoming
doc's own (always-valid) `activePageId`. Add undo-of-`addPage` / redo-of-`removePage` tests.

## Tier 2: Design smells / maintainability risks

### 2.1 Pie/donut sort controls and the funnel sort-direction toggle are dead UI (chart-type-level strip)

- `components/StudioComposeDrawer/ChartSetupPanel/ChartSetupPanel.tsx:475-539` (sort controls shown for every type except scatter/heatmap/sankey/gauge/gantt — i.e. **including pie, donut, funnel**)
- `packages/x-studio-schema/src/configKeyValidation.ts:228-245` (`PIE_FAMILY_CHART_KEYS` — no `chartSortBy`/`chartSortDirection`), `:182-201` (`FUNNEL_CHART_KEYS` — `chartSortBy` only)
- `store/StudioController.ts:936-961` (the chart-type write guard that strips them)
- `useChartWidgetData.ts:300-339` (`aggregateByField` **does** consume `chartSortBy`/`chartSortDirection` for the pie/donut data path)

Same mechanism as 1.1, one level down. The setup panel renders "Sort by" + direction for pie/donut,
but `StudioPieFamilyChartConfig` doesn't extend `StudioChartSortConfig`, so the validator strips
every write. This is a three-way inconsistency: the **render path supports** pie/donut sorting
(`chartData` is built by `aggregateByField` with both sort params — a pie that _retained_
`chartSortBy` from a previous bar incarnation sorts correctly), the **type/validator forbid** it,
and the **panel offers** it. For funnel, `chartSortBy` writes work but the direction toggle
(`buildFunnelStages` never reads a direction) is offered and stripped.

**Failure scenario:** user configures a pie chart, sets "Sort by → Value": the select never
changes, a dev warning fires, and an undo entry is pushed (2.2). On a funnel, flipping asc/desc
does the same.

**Fix:** add `StudioChartSortConfig` to the pie family (type + tuple) since the aggregation path
already honors it; for funnel, hide the direction toggle in the panel (it is genuinely
meaningless there) rather than widening the schema.

### 2.2 An all-stripped (or empty) config patch still commits an undoable step

- `store/StudioController.ts:969-985` (dispatches `updateWidget` with the possibly-empty `effectiveConfig`)
- `packages/x-studio-schema/src/applyMutation.ts:367-383` (the `config` branch rebuilds `nextConfig` and the widget object even when the patch is `{}` or value-identical)

The controller's no-op story (reference-preserving helpers + `commitMutation`'s same-reference
check) is meticulous for unknown-id writes, but the reducer's `updateWidget` `config` branch
unconditionally rebuilds `{ ...existing.config }` and re-wraps the widget whenever a `config`
patch is _present_, even if it changes nothing. Combined with 1.1/2.1, every click on a dead
toggle pushes a junk undo entry, runs title inference, and notifies every subscriber. The same
holds for a value-identical patch (e.g. re-committing the current `crossFilterMode` via the
toggle's deselect behavior).

**Failure scenario:** user clicks a dead pie "Sort by" option three times, then hits Ctrl+Z
expecting to revert their last real edit — the first three undos visibly do nothing.

**Fix:** in the reducer's `config` branch, track whether any key actually changed
(`delete` of a present key, or `nextConfig[key] !== existing value`) and skip the rebuild when
nothing did — mirroring the branch's own `unsetConfigKeys` bookkeeping; and/or have
`updateWidgetConfig` early-return when `effectiveConfig` strips to `{}`.

### 2.3 Every chart-type switch to a non-bar family fires a spurious dev warning (`barLayout`)

- `components/StudioComposeDrawer/ChartSetupPanel/ChartSetupPanel.tsx:236-241` (`handleChartTypeChange` always includes `barLayout: newBarLayout`)
- `components/StudioComposeDrawer/ChartTypePicker.tsx:116` (non-bar options pass `barLayout: undefined`)
- `store/StudioController.ts:936-961` (the guard validates `Object.keys(effectiveConfig)`, which includes `undefined`-valued keys)

Switching bar → line (or any non-bar family) sends `{ chartType: 'line', barLayout: undefined }`;
the chart-type guard flags `barLayout` as invalid for `line` and warns. Nothing is corrupted — the
strip only cancels a key _deletion_, and key retention across type switches is by design — but the
warning is noise on a bread-and-butter gesture, which trains developers to ignore the guard's
genuine warnings (the ones 1.1/2.1 produce).

**Failure scenario:** dev builds a bar chart, clicks "Line" in the type picker → console shows
`Ignoring config key(s) not valid for chart type 'line' … barLayout` despite a fully correct
action.

**Fix:** have both validators skip `undefined`-valued keys (an `undefined` can only ever _delete_
a key, never persist a wrong-family value), or have `handleChartTypeChange` omit `barLayout` when
`newBarLayout === undefined`.

## Tier 3: Minor / cosmetic

### 3.1 Millisecond-resolution ids survive in four controller paths

- `store/StudioController.ts:1282` (`interactive-…-${Date.now()}`), `:1330` (`cross-filter-…-${Date.now()}`), `:1366` (`preset-${Date.now()}`), `:1465` (`page-${Date.now()}`)

`duplicateWidget` was specifically converted to collision-resistant `createWidgetId()` (its own
comment cites the rapid-double-invocation risk), but these four still use `Date.now()`. Two
`addPage` calls in the same millisecond (AI bulk turn, double-click) collide; the reducer's
idempotent `addPage` then silently _re-activates_ the first page instead of creating the second,
and the caller's returned id points at the wrong page. Interactive/cross-filter ids are
replace-per-widget so collisions are harmless there; presets and pages are not.
**Fix:** reuse `createWidgetId`'s scheme for page/preset ids.

### 3.2 `deleteFilterPreset`/`renameFilterPreset` on a preset-less doc commit an undoable `filterPresets: []`

- `store/docTransforms.ts:241-258`

When `doc.filterPresets` is `undefined`, `presets` is a fresh `[]`, which is never
reference-equal to `undefined`, so `commitDocPatch`'s guard doesn't fire: deleting/renaming an
unknown preset on a dashboard that never had presets materializes `filterPresets: []` as an
undoable, subscriber-notifying step. **Fix:** return `doc` unchanged when `doc.filterPresets` is
absent/empty and nothing matched.

### 3.3 `useWidgetDefMap` memo key covers only the _kind list_, not def contents

- `internals/builtinWidgetDefs.ts:279-293`

The memo key is `JSON.stringify(customWidgets?.map((d) => d.kind))`, labeled "a deep-equality
proxy for customWidgets" — it isn't: a consumer swapping a def's `component`/`setupPanel`/
`capabilities` for an existing kind won't refresh the registry until a kind is added/removed.
Custom defs are usually static module constants, so impact is low. **Fix:** key on the array
reference (documenting that defs must be referentially stable), or compare defs by reference in
the memo.

### 3.4 `serializeDoc`'s comment contradicts the controller's cross-filter undo semantics

- `packages/x-studio-schema/src/statePersistence.ts:310-318` vs `packages/x-studio/src/store/StudioController.ts:215-217`

The persistence comment says cross-filter _and_ interactive entries are "carried forward across
undo/redo by `StudioController.carryTransientDocState`". Only interactive entries are;
cross-filters are deliberately undoable/time-travelled (controller comment + the pinning test
"still time-travels cross-filters"). The _code_ (strip both at the persistence boundary) is
correct either way; only the rationale is wrong. Comment-only fix.

### 3.5 Heatmap/funnel/sankey query descriptors miss the `ySeries[0]` value-field fallback their renderers use

- `internals/chartTypeRegistry.ts:147-163` (heatmap), `:170-187` (funnel), `:211-227` (sankey) — collect `config.yField` only
- `components/widgets/StudioChartWidget/chartTypeDefs.tsx:406`, `:470-471`, `:570` — renderers fall back to `config.ySeries?.[0]?.fieldId`

A config carrying the value field only in `ySeries` (no `yField`) renders fine in-memory but,
on an adapter-backed source, the SELECT (via `collectSelectFields`) omits the column — and the
same field set drives lazy enrichment (`usedFieldIds`), so an expression value field would not be
enriched either. Unreachable through the setup panels (they always write `yField` and `ySeries`
together) — only AI- or host-authored configs hit it. **Fix:** mirror the renderers' fallback in
the three descriptors (the `xyDescriptor` already collects `ySeries` fields).

### 3.6 Grid source change wipes non-field-bound config keys

- `components/StudioComposeDrawer/GridSetupPanel.tsx:252-257`

`handleSourceChange` replaces the whole config with `{ columns: [] }` (the `changes.config`
reducer branch is a wholesale replace). Field-referencing keys (columns, sort, group-by,
conditional formats) _should_ reset, but `gridHeight`, `titleFontSize`, and `cardExpandTitle` are
source-independent and get wiped too. Minor UX papercut; fix by resetting only the field-bound
keys (via `unsetConfigKeys`) instead of replacing the bag.

## Areas verified clean

- **Widget-kind narrowing:** the catch-all `StudioWidgetOf<string & {}>` member genuinely defeats
  native discrimination, and the code respects that: every cross-kind site that reads per-kind
  config either goes through `isWidgetOfKind` (`useWidgetRows.ts:438`, `StudioCanvas.tsx:41`,
  `widgetUtils.tsx:105/140`, `selectors.ts:538`) or widens explicitly to the flat
  `StudioWidgetConfig` with a comment stating why (`useWidgetRows.ts:430`,
  `queryDescriptor.ts:200`, `inferWidgetTitles`, `buildCsvContent`). No bare
  `widget.kind === 'x'` site reads a kind-specific config key unsoundly; the bare comparisons that
  remain are boolean-only dispatch. The per-kind registry wrappers' casts
  (`builtinWidgetDefs.ts:51-135`) are guarded by the registry keying itself.
- **Chart-type narrowing:** `StudioChartWidgetConfig` is a closed union and narrows natively;
  `ChartSetupPanel` dispatches every per-type section through a bare
  `chartConfig.chartType === '…'` check with no casts, and each section reads only its family's
  keys (checked all ten against their family interfaces — the only mismatches are the _panel-level_
  sort controls in 2.1, which sit outside the per-type sections). The one dispatch cast is
  contained and sound (see the sanity-check paragraph).
- **Pipeline layering & caches:** L2→L3 always flows through `resolveRowsCached` →
  `resolveRows` (both sync and adapter paths funnel through `selectFiltersForWidget`, the single
  scoping implementation); L4 (`useChartRows`/`resolveChartRowsForAggregation`) is applied on top
  for charts. `resolvedRowsCache` records _absent_ foreign sources as `null` so a late data load
  invalidates (the old review's staleness bug is fixed), fingerprints every behavioral filter
  field, caps entries with LRU, and tracks relevant expression-field object identity.
  `enrichedRowsCache` is widget-scoped with transitive dependency expansion.
  `StudioRequestCache.addInflight` takes an explicit `sourceId` (passed at the one call site,
  `useAdapterRows.ts:109-114`) and uses a generation token so a mid-flight invalidation can't
  re-seed stale results.
- **Adapter cross-filter baseline:** `buildQueryDescriptor` uses `include: 'no-cross'` so
  cross/interactive filters never reach the server or churn the cacheKey; they are enforced
  client-side in `useWidgetRows.computeFilteredRows`. The old review's "unrecoverable baseline"
  finding is fixed.
- **Cross-filter/retention invariants:** chart-type switches retain prior fields (the validator
  checks only the incoming patch, never the stored config — pinned by controller tests);
  `duplicateWidget` clones config wholesale and re-ids widget-scoped filters, keeping the managed
  `widget-date-range-<id>` scheme intact; `removeWidget`/`removePage`/`applyBulkUpdate` all funnel
  orphan cleanup through the shared `removeWidgetIds` primitive with a cross-page survival guard.
- **Reducer hardening:** prototype-pollution guards (`UNSAFE_KEYS`, `Object.hasOwn` lookups) are
  consistently applied at every record rebuild and untrusted-id lookup in `applyMutation.ts`;
  the client validates SSE mutations through `parseStateMutation` before they reach the
  controller.
- **Security:** no `eval`/`new Function`/`dangerouslySetInnerHTML` under `src/`; the markdown
  renderer keeps `disableParsingRawHTML: true` plus a URL-protocol sanitizer; expression
  evaluation is AST-walking, not string-eval.
- **Persistence:** `serializeDoc` spreads the doc (new fields can't be forgotten), strips
  transient filter scopes, and migrations fail closed on gaps, newer versions, and partial docs;
  `deserializeState` normalizes legacy leaf shapes at the load boundary only.
