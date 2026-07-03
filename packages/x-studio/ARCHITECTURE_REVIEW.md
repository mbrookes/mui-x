# Architecture & technical-debt review (Fable)

Independent review by the Fable model, run in two passes: (1) a review of `ARCHITECTURE.md` across all three Studio packages, verified against source and extended with new findings; (2) a dedicated technical-debt sweep of this package's UI/component layer and its internals/state layer. Read-only analysis — no code was changed to produce this report. See also [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the baseline this review evaluates.

Findings marked **cross-cutting** also appear in [`x-studio-ai-middleware/ARCHITECTURE_REVIEW.md`](../x-studio-ai-middleware/ARCHITECTURE_REVIEW.md) since they span both packages.

---

## Part 1 — Architecture proposals concerning this package

### Proposal: End the hand-synced duplication between x-studio and ai-middleware with a shared zero-dependency package (cross-cutting)

**Problem**: The "structural typing boundary" (ai-middleware ARCHITECTURE invariant #7) has already produced three parallel copies that must be maintained by hand:

- `detectAnomaliesIQR` (`packages/x-studio/src/internals/anomalyDetection.ts:16-36`) vs `mcpDetectAnomaliesIQR` + `mcpMedian` (`packages/x-studio-ai-middleware/src/mcp.ts:383-408`) — byte-for-byte identical logic today; nothing enforces they stay so.
- `createDefaultWidget` duplicated wholesale: `packages/x-studio/src/internals/widgetFactory.ts:14-94` vs `packages/x-studio-ai-middleware/src/models/studioTypes.ts:508-557` — identical branch-for-branch. If a default config changes in one, AI-created widgets and UI-created widgets get different defaults.
- The entire 557-line `models/studioTypes.ts` re-declares `StudioState`/`StudioWidget`/etc. from the client package.
- Tell-tale smell: `packages/x-studio/src/internals/widgetFactory.ts:7` imports `from '@mui/x-studio'` — a self-import inside its own package, clearly a copy that drifted across the boundary.

**Architectural cost**: Every `StudioState` shape change is a two-package edit with no compiler assistance (structural typing means drift surfaces as a runtime mismatch in AI tool behavior, not a type error). The stated rationale — keeping the middleware dependency-free — does not require duplication: it only requires not depending on a package with React peer deps.

**Recommended change**: Create an unpublished-or-published `@mui/x-studio-schema` package (zero runtime deps, no React, no Node built-ins) containing: (a) all `StudioState`/widget/filter/expression/AI-protocol types, (b) pure functions both sides need — `createDefaultWidget`, `createDefaultStudioState`, `detectAnomaliesIQR`/`median`, and the `StateMutation` reducers (see the AI-mutations proposal below). `@mui/x-studio` and `@mui/x-studio-ai-middleware` both depend on it; `models/studioTypes.ts` becomes `export * from '@mui/x-studio-schema'`. This preserves the framework-agnostic invariant exactly (the schema package is pure) while deleting the drift surface.

**Effort/risk**: Medium-large mechanically (import-path churn across both packages) but low semantic risk — it's a move, not a rewrite. Needs monorepo release wiring (catalog entry, build config). Biggest payoff of any proposal for long-term maintenance.

### Proposal: AI mutation semantics are implemented three times and already disagree (cross-cutting)

**Problem**: Every AI tool's state effect exists twice as executable code: the server computes `nextState` inline (`packages/x-studio-ai-middleware/src/executeToolOnState.ts`, e.g. `add_widget` at 102-141 appends `[widget.id]` to `activePage.widgetRows`), and the client independently re-derives the same effect by mapping the `StateMutation` to controller methods (`packages/x-studio/src/components/StudioChatPanel/applyStateMutation.ts:13-140` → `StudioController.addWidget`, `store/StudioController.ts:382-409`). Today they agree ("append as a new row") only by parallel authorship. There is already a live divergence: the server appends to _its_ `state.dashboard.activePageId` (`executeToolOnState.ts:123`), while the client's `controller.addWidget` uses the _client's current_ `activePageId` (`StudioController.ts:384`) — if the user switches pages while the model is thinking, the model is told the widget landed on page A while it actually rendered on page B, and every subsequent turn reasons about the wrong layout. `applyStateMutation` also bypasses controller semantics for `addPage`/`applyBulkUpdate` via raw `setState` (lines 15-28, 95-111), so those two paths skip label-logging that other mutations get.

**Architectural cost**: The AI feature's core correctness contract — "server-threaded state equals client-applied state" — is unenforced and already violated in a reachable scenario. Every new tool doubles the divergence surface.

**Recommended change**: Make `StateMutation` the single semantic authority. In the shared schema package (above), define pure reducers `applyMutation(state: StudioState, mutation: StateMutation): StudioState` — one per mutation type. The server's `executeToolOnState` becomes "parse args → build mutation → `nextState = applyMutation(state, mutation)`"; the client's `applyStateMutation` becomes `controller.commitExternal(applyMutation(controller.getState(), mutation), label)`. Fix the page-targeting divergence by making mutations carry their target explicitly (`addWidget` args gain `pageId`, chosen by the server), so both sides apply to the same page regardless of client navigation.

**Effort/risk**: Medium. The reducer extraction is mechanical; the behavioral change is `pageId`-explicit targeting, which is strictly more correct. Undo/label integration on the client needs one new controller entry point.

### Proposal: Widget-kind registry — the registry already half-exists; built-ins should live in it

**Problem**: Verified, and worse than the docs say. Kind dispatch is hardcoded in at least five client locations, not three: `StudioWidgetCard.tsx:711-914` (render + per-kind context menus at 450-504) plus a hardcoded kind-list literal at 235; `StudioComposeDrawer.tsx:83-89`; `StudioWidgetEditDialog.tsx:197-203`; `StudioWidgetEditDialog/BuiltinWidgetPreview.tsx:38-58`; `internals/widgetFactory.ts:20-93` (default configs, with the same hardcoded kind-array at line 77). Cross-package, a sixth and seventh: `x-studio-ai-middleware/src/widgetConfigMeta.ts:6-70` and the middleware's `createDefaultWidget` copy. Meanwhile the exact registry abstraction needed already exists for custom widgets: `CustomWidgetMap = ReadonlyMap<string, StudioCustomWidgetDef>` (`internals/StudioUIConfigContext.ts:1994-1995`), where each def carries `component`, `setupPanel`, `defaultConfig`.

**Live divergence already present** (found independently during the tech-debt sweep, see Part 2 below): `StudioComposeDrawer.tsx` renders `customDef?.setupPanel` for custom widgets, but `StudioWidgetEditDialog.tsx` has **no custom-widget handling at all** — editing a custom widget via the built-in edit dialog shows a blank Setup tab while its preview renders fine.

**Architectural cost**: Adding a widget kind is currently a 7+-site scavenger hunt across two packages; the compiler catches none of the misses (each dispatch site silently renders nothing for an unknown kind). The hardcoded kind-array literals at `StudioWidgetCard.tsx:235` and `widgetFactory.ts:77` are the classic forgotten-eighth-place.

**Recommended change**: Define `BUILTIN_WIDGET_DEFS: Record<StudioBuiltinWidgetKind, StudioWidgetDef>` in `internals/` where `StudioWidgetDef` extends the existing `StudioCustomWidgetDef` shape with the extra hooks built-ins need (`previewComponent`, `defaultConfig`, `capabilities: { export: 'csv' | 'png', filters: boolean, ... }`). Change `useCustomWidgetMap()` to a `useWidgetDefMap()` that layers custom defs over built-ins. Each dispatch site becomes a single map lookup; `widgetFactory` reads `def.defaultConfig`; a `satisfies Record<StudioWidgetKind, ...>` constraint makes a missed registration a compile error.

**Effort/risk**: Medium — mostly mechanical extraction of existing JSX into `component` fields. Risk: per-kind props differ slightly (`dataSource`, `pageId` etc. at `StudioWidgetCard.tsx:890-916`), so the def's component signature must take a normalized prop bag; that normalization is the only design work.

### Proposal: Fan-out/double-counting-safe aggregation — unify at the row-grain layer, not the aggregation layer

**Problem**: Verified — two independent solutions to double-counting: chart L4 re-anchors the _row set_ to the fan-out source's grain (`internals/chartAggregation.ts:390-449` anchor selection, 494-670 re-anchored row construction) then aggregates normally; grids keep fanned-out rows and dedupe _inside each aggregation call_ via FK (`utils/gridGrouping.ts:53-75` `symmetricAggregate`). These are semantically different algorithms: `symmetricAggregate` collapses null and empty-string FKs into one bucket (`String(row[fkField] ?? '')`, line 64), dedupes per-group (so a related row spanning two groups is counted once _per group_, correct for sums but with different `avg` denominators than the chart's anchor-row approach), and only handles direct many-to-one (`gridGrouping.ts:100-105`), while charts additionally handle many-to-many via junction anchoring (`chartAggregation.ts:403-419`). A chart and a grid grouping the same measure over the same join can legitimately disagree today, and only one of the two gets fixed when a bug is found.

**Architectural cost**: Correctness parity between widget kinds is the product's credibility ("why does the chart say 4.2M and the table 4.6M?"). Two implementations means such tickets get fixed twice or diverge.

**Recommended change**: Don't merge the aggregation functions — merge the _grain resolution_. Extract the L4 re-anchoring core from `chartAggregation.ts` into `internals/grainResolution.ts` with signature `resolveRowsAtGrain(widgetRows, requestedFields, anchorSourceId, dataSources, relationships, expressionFields): Row[]`. Grid grouping then becomes: detect fan-out columns (reuse `analyzeChartSupport`'s owner analysis), call `resolveRowsAtGrain`, and run the plain `aggregateGridValue` — deleting `symmetricAggregate` and its cross-source FK map plumbing (`gridGrouping.ts:92-127`). Grids inherit many-to-many support for free.

**Effort/risk**: Large-ish and the riskiest proposal here: grid group-row composition (non-aggregated "first row" columns, `gridGrouping.ts:173`) must be re-derived from anchored rows, and existing dashboards' grid numbers may _change where the old dedupe was subtly wrong_ — that's the point, but it needs golden tests comparing chart totals vs grid totals over shared fixtures before and after.

### Proposal: No integrity validation on deserialized dashboard state

**Problem**: `validateStateStructure` accepts anything object-shaped (`store/statePersistence.ts:136-141`); `deserializeState` (statePersistence.ts:249-286) restores `pages`/`widgets`/`dashboard` verbatim with no checks that `dashboard.activePageId` exists in `pages`, that every ID in `page.widgetRows` exists in `widgets`, or that `filters[].scope` references live widgets. Downstream code assumes integrity: `StudioController.addWidget` dereferences `state.pages[state.dashboard.activePageId].widgetRows` with no null guard (`store/StudioController.ts:384-385`) — a dashboard persisted with a since-removed page ID throws a `TypeError` deep in the controller on the first widget add.

**Architectural cost**: Persisted dashboards live in host databases and localStorage, get hand-edited, truncated, and produced by older/newer app builds; the deserialize boundary is exactly where garbage must be stopped. Today the failure mode is a delayed, unattributable crash rather than a load-time diagnostic — expensive support burden for an embedded product where MUI doesn't control the storage.

**Recommended change**: Add a `repairStateIntegrity(state): { state, warnings[] }` pass at the end of `deserializeState`: drop `widgetRows` entries with no matching widget, drop widgets on no page into a recovery row (or delete), reset `activePageId` to the first page if dangling, drop filters scoped to missing widgets. Return warnings through the existing `MigrationResult.errors`-style channel so hosts can log them. This mirrors the migration system's philosophy (state is upgraded/sanitized before any application code sees it) and makes migrations themselves safer to write.

**Effort/risk**: Small-medium; pure additive function plus tests with corrupted fixtures. Only behavioral risk is that previously-crashing states now load with repairs — an improvement.

### Smaller observations relevant to this package

- **`studioRequestCache` is a module singleton** (`internals/StudioRequestCache.ts`, imported at `StudioController.ts:33`): two `<Studio>` instances on one page with different adapters but a colliding `sourceId` share cache entries and invalidations. Keys should incorporate a per-controller/adapter identity, or the cache should live on the controller.
- **Client-side `createDefaultWidget` IDs are `widget-${kind}-${Date.now()}`** (`internals/widgetFactory.ts:18`) — collision-prone under programmatic use; the ai-middleware's `executeToolOnState.ts:117` already fixed this with a random suffix on the server side. Align the client (fold into the shared-package proposal above).
- **Verification note on the seeded "widget registry" and "fan-out aggregation" items**: both confirmed accurate in the original `ARCHITECTURE.md`, and both undercounted in scope — see the two proposals above for the corrected picture.

---

## Part 2 — Technical debt: UI/component layer (`src/components/`)

No TODO/FIXME/HACK markers exist anywhere in the directory — the debt below is all structural. Ordered by impact.

**1. `StudioChartWidget` is a ~3,140-line single React component**
`src/components/widgets/StudioChartWidget/StudioChartWidget.tsx:149-3292`
One `React.memo` function renders every chart type via a sequential if-chain (`gauge` :986, `scatter` :1420, mixed :1655, bar :1684, pie/donut :1900, line :2909, area :3042...). Each branch re-derives axes, formatters, ghost-bar alignment, and cross-filter context inline — e.g. the multi-Y axis construction at :1712-1735 is near-identical to the area-chart version after :2550; there are 8 non-null assertions (`scatterSeries!` :1423, :1459; `effectiveSingleSeriesData!` :2813, :2823, :2919, :3054; `singleSeriesChartData!` :2949, :3083) that only hold because of the if-order, and 5 `react/jsx-no-constructed-context-values` suppressions (:1757, :2198, :2395, :2825, :2835). Any change to shared behavior (forecast, ghost bars, annotations) must be applied N times. Fix: the file already demonstrates the right pattern — `StudioFunnelChart.tsx`, `StudioGanttChart.tsx`, `StudioSankeyChart.tsx` are extracted per-type renderers. Extract bar/line/area/pie/scatter/mixed/gauge the same way, passing a shared `ChartRenderContext`.

**2. The three StudioCanvas "tests" are mirror tests — they exercise zero production code**
`src/components/StudioCanvas/StudioCanvas.regressions.test.ts` (113 lines), `StudioCanvas.responsive.test.ts` (139), `StudioCanvas.gridLines.test.ts` (175) import only `vitest` and re-implement copies of `getWidgetMinSpan`, the responsive span math, and the grid-line math inline. They pass forever regardless of what `StudioCanvas.tsx` actually does — worse than no tests, they create false confidence in exactly the drag/layout math they claim to cover. No test anywhere imports `StudioCanvas`, `RowResizeHandle`, `useStudioDropTarget`, `useStudioDraggable`, `createClonePreview`, `StudioDragLayer`, `StudioCrossFilterBar`, or `StudioDateRangeBar`. Fix: export the real functions (e.g. `getWidgetMinSpan` at `StudioCanvas.tsx:39`) and import them in the tests; add a rendered test for `RowResizeHandle`'s snap math (`:127-168`) and keyboard path (`:47-97`).

**3. `handleDrop` re-implements controller mutations inline — and is untestable**
`src/components/StudioCanvas/StudioCanvas.tsx:131-239`
The drop handler builds widget rows, redistributes col-spans (`destSpanTotal` :197-206), and performs cross-page moves (:211-221) via raw `controller.updateState()`, even though `StudioController` already owns `addWidget` (`store/StudioController.ts:382`), `moveWidgetToPage` (:1405), and `setWidgetLayout` (used by the keyboard-move path in `StudioWidgetCard.tsx:341`). Two divergent implementations of "move widget" (pointer vs keyboard); drop-created widgets bypass whatever `addWidget` does (e.g. inferred titles via `applyInferredTitles`); and because the logic lives in a component closure it's exactly the code finding #2 shows has no real test. Fix: move the row-splice/cross-page logic into controller methods (`insertWidgetAt`, `moveWidgetTo(rowIndex, colIndex)`) and unit-test them against the store.

**4. Widget-kind dispatch is copy-pasted 4+ times — with a real divergence bug already**
See "Widget-kind registry" proposal in Part 1 above for the full writeup; this is where the custom-widget/edit-dialog divergence was found.

**5. Cross-filter value equality has three different semantics across widget kinds**
Chart uses loose `==` (`StudioChartWidget.tsx:499-501` `looseEq`); Grid uses `String(a) === String(b)` (`StudioGridWidget.tsx:262`); and `chartWidgetHelpers.ts:108` exports a third normalization (`normalizeCrossFilterValue`, ISO-string for dates). These disagree on real inputs (`'' == 0` is true but `String('') !== String(0)`; `null == undefined` is true), so "click same value to clear the filter" toggles correctly in one widget kind and double-applies in another depending on column type. Fix: one exported `crossFilterValueEquals(a, b)` (co-located with `normalizeCrossFilterValue`), used by chart, grid, and map, with a unit test covering number/string/date/null.

**6. Filter operator metadata duplicated and divergent, both copies bypassing i18n**
`StudioWidgetEditDialog/FilterRow.tsx:27-73` vs `StudioFiltersDrawer/filterDrawerUtils.ts:8-53`. The sets disagree: FilterRow offers `between` and `is_empty/is_not_empty` for numbers/dates; the drawer's table doesn't have `between` but has `not_starts_with`/`not_ends_with` which FilterRow lacks. Consequence: a `between` widget filter created in the edit dialog can't be round-tripped when re-edited in the filters drawer. Both tables also hardcode English labels even though the package ships de/es/fr/ptBR locales and `FilterRow.tsx:14` already imports `useStudioLocaleText`. Fix: single operator-metadata module keyed by field type, labels from `localeText`, consumed by both surfaces.

**7. SSE streaming + state-stripping copy-pasted into the text widget**
`widgets/StudioTextWidget/useTextWidgetAI.ts:134-199` duplicates `StudioChatPanel/studioBackendAdapter.ts`: the strip-rows/adapter serialization (:134-146 vs adapter :219-228) and the hand-rolled `data:`-line SSE parse loop (:165-199 vs adapter :281-300). The copy is also lower-fidelity — it needs `source as unknown as { rows?; adapter? }` (:139) where the adapter destructures typed. Any protocol change (event names, buffering, abort handling) must be fixed twice. Fix: export `serializeDashboardState(state)` and a small `parseSSEStream(response, onEvent)` from a shared module and use them in both.

**8. Two `makeValueFormatter` functions with the same name and different behavior**
`widgets/StudioChartWidget/chartWidgetHelpers.ts:92-106` (exported: always returns a formatter, falls back to `String(value)`) vs `widgets/StudioChartWidget/lineSeries.ts:5-19` (private: returns `undefined` when no format). Identical name, silently different output — axis/tooltip number formatting differs depending on which code path built the series. Fix: delete the `lineSeries.ts` copy, import the shared one, make the "no format → undefined" behavior an explicit option.

**9. `useChartWidgetData` (837 lines) is tested only for cross-source blending**
`widgets/StudioChartWidget/useChartWidgetData.ts` — `useChartWidgetData.test.tsx` (244 lines) covers blended series/outer-join/count only. Untested: the cross-filter ghost baseline memos (`allChartData`/`allSeriesFieldData`/`allMultiYData` :567/:614/:656), rank-filter separation (:89), stable color assignment (:436/:475), scatter series (:694-776), and adapter-backed foreign fetch promise plumbing (:266-347). This is the data spine of every chart widget; regressions here render wrong numbers, not crashes. Fix: table-driven unit tests per memo, starting with ghost alignment.

**10. Row `key={row.join('-')}` remounts every widget in a row on layout change; `hydratedWidgets` papers over it and leaks**
`StudioCanvas.tsx:279` keys each row by its joined widget IDs, so adding/moving/removing any widget in a row changes the key and remounts all its siblings — discarding widget-local state. The module-level `const hydratedWidgets = new Set<string>()` (`StudioWidgetCard.tsx:140`) exists specifically to hide the resulting blank-flash, and it grows forever, is shared across all `Studio` instances on a page, and is never cleared when widgets/dashboards are deleted. Fix: key rows by a stable row identity (or key the widget Boxes by `widgetId` instead of the row), then delete `hydratedWidgets`.

**11. Type-safety escape hatches on closed unions**
`StudioComposeDrawer/GridSetupPanel.tsx:488,639` — `type={(fieldInfo?.type ?? 'string') as any}` disables exhaustiveness on the closed `FieldType` union. `widgets/StudioMapWidget/geographyLoaders.ts:75-79` — `topo: any` plus `as unknown as ExtendedFeatureCollection`. `StudioCanvas/useStudioDraggable.ts:60` — a cast that erases `StudioDragItem` at the DnD boundary.

**12. Dead barrel re-exports**
Nothing outside tests imports these; `src/index.ts` cherry-picks from source files instead: `widgets/StudioKpiWidget/index.ts:2-7`, `StudioWidgetEditDialog/index.ts:3`, `widgets/StudioMapWidget/index.ts:3-4`, `StudioCanvas/index.ts:2`. Trim barrels to what's actually consumed.

Also noted: `StudioFiltersDrawer` remains a knowingly-unsplit multi-section file (482 lines + 20 sibling files) — its util layer is well-tested, so the pressing issue there is only finding #6, not file size. Untested heavyweight panels (`GridSetupPanel.tsx` 780 lines, `KpiSetupPanel.tsx` 487, `InlineFormulaBar.tsx`'s `buildExpression` with `parseFloat(x) || 0` fallbacks) are the natural next tier of test targets after findings #2/#3/#9.

---

## Part 3 — Technical debt: internals/state layer (`src/internals/`, `src/store/`, `src/context/`, `src/utils/`)

Ordered by impact.

**1. `resolvedRowsCache` filter fingerprint omits operator/field/mode — stale rows after editing a filter**
`internals/resolvedRowsCache.ts:100-108`. The inner cache key is only `` `${f.id}:${JSON.stringify(f.value ?? '')}` ``, but a compiled row-test also depends on `operator`, `field`, `fieldType`, `operator2`/`value2`/`conjunction`, `filterMode`, `rankDirection`, `rankByField` (`filterUtils.ts:101-321`). `StudioController.updateFilter` accepts arbitrary partial changes, so changing a filter's operator from `equals` to `not_equals` (same id, same value) keeps the same cache key, `isEntryValid` passes, and every widget on the source silently shows the _old_ filtered rows until something else invalidates. This is exactly the stale-data class the per-entry-invalidation design exists to prevent, and it is untested — `resolvedRowsCache.test.ts` covers value changes, ref changes, and foreign-row changes, but never an operator/field edit. Fix: fingerprint the full behavioral content (`sortedStringify` of `{field, operator, value, value2, operator2, conjunction, filterMode, fieldType, rankDirection, rankByField, disabled}` — the `sortedStringify` helper already exists in `queryDescriptor.ts:18`), and add the missing test.

**2. `resolvedRowsCache` dependency tracking misses two foreign-row dependencies created inside `resolveRows`**
`internals/resolvedRowsCache.ts:39-58` vs `internals/dataSourceGraph.ts:181-184` and `:246`. `isEntryValid` only re-checks `dataSources[f.filterSourceId].rows` for filters that _arrive_ with a `filterSourceId`. But `resolveRows` itself creates two more foreign-row dependencies the cache never records: a page filter targeting an expression field owned by a different source is rerouted as a cross-filter with a **derived** `filterSourceId` that the cache entry never tracks; and two-hop many-to-many semi-joins read `dataSources[joinPath.junctionSourceId].rows`, also untracked. Refreshing either foreign source serves a stale semi-join. Fix: have `resolveRows` expose the set of source IDs it actually joined against, and record those rows refs in the cache entry; add tests mirroring the existing "cross-filter foreign source rows change" test for both paths.

**3. Editing an expression-field formula or a relationship serves stale results through two caches**
`internals/resolvedRowsCache.ts:28-29` (stale comment) and `internals/chartAggregation.ts:531`. `resolvedRowsCache`'s comment says expression fields are "intentionally NOT tracked here — enrichedRowsCache handles per-source enrichment invalidation" — true only on a cache _miss_; on a hit, the cached result (embedding values computed with the old formula) is returned without ever consulting `enrichedRowsCache`. Same class in the chart L4 cache (`rcfaCache`): its `configKey` excludes `relationships` and `expressionFields` entirely, so editing a relationship's join fields or an anchor-source expression formula returns a stale joined result while row refs stay unchanged. Fix: include a relationships fingerprint and the relevant expression-field refs in the entry validity check for both caches; add the missing tests.

**4. Fan-out-safe aggregation solved twice, with contradictory join-key semantics**
See the "Fan-out/double-counting-safe aggregation" proposal in Part 1. Additional detail from this sweep: `gridGrouping.ts:64,123` and `crossSourceEnrichment.ts:72,84` coerce join keys with `String(x ?? '')`, while `dataSourceGraph.ts:236,247` and `chartAggregation.ts:605-621` use raw values in `Map`/`Set` — a numeric FK (`5`) against a string PK (`"5"`) joins in the grid path but fails in the chart/filter path, so the same relationship behaves differently per widget kind. Fix: extract one `joinKeys`/`dedupeByFk` module with a single key-coercion policy.

**5. Cross-source join resolution implemented four times**
`dataSourceGraph.ts:64-114` (`findJoinPath`) and `:274-454` (`enrichRowsWithRelatedFields`); `crossSourceEnrichment.ts:28-95`; `utils/gridGrouping.ts:98-127`; `chartAggregation.ts:180-289,576-684`. Each file re-derives "which relationship links source A to source B, which side is the FK, build a PK→row lookup" from scratch — `gridGrouping.ts:99` and `crossSourceEnrichment.ts:54` even share the identical comment. `crossSourceEnrichment.enrichWithCrossSourceFields` is a strict subset of `dataSourceGraph.enrichRowsWithRelatedFields`. Every relationship-model change must be re-implemented in four places. Fix: make `findJoinPath` + a lookup-builder in `dataSourceGraph.ts` the single traversal API; delete the other three's bespoke resolution in favor of it.

**6. Five independent aggregation-primitive implementations, with capability drift**
`chartAggregation.ts:719-803` (`aggregateByField`), `:1173-1271` (`aggregateHeatmap`), `utils/gridGrouping.ts:8-40` (`aggregateGridValue`), `utils/gridSummary.ts:42-75`, `utils/expressionEvaluator.ts:442-462` (`aggregate`). User-visible consequences: `aggregateByTwoFields` (`:817`) and `aggregateMultipleSeries` (`:917`) hard-code sum — no `yAggregation` parameter, so setting `config.yAggregation: 'avg'` on a chart silently stops working the moment a series field is added, while single-series charts honor it. Null handling also differs (grid `avg` excludes nulls from the denominator; chart `avg` coerces null→0 into the sum). Fix: one shared `aggregate(values, fn)` + accumulator module; thread `yAggregation` through the two multi-series aggregators.

**7. `useWidgetRows` God-hook: three copy-pasted pipeline blocks and re-implemented filter scoping**
`internals/useWidgetRows.ts:346-419, 421-471, 479-549` (three near-identical memos differing only in which filter buckets they include) and `:586-647` (three identical `enrichWithCrossSourceFields` memos). The cross-filter/interactive scope predicates are duplicated inline four times even though `filterScoping.ts:20-85` is documented as the "single source of truth for all three data paths" — the adapter path bypasses it and re-encodes the rules by hand (and doesn't honor `crossFilterAllPages` the same way the interactive branch of `selectFiltersForWidget` does). Fix: extract a single `computeFilteredRows(include)` closure reusing `selectFiltersForWidget` (it already supports the three include modes) for both adapter and sync branches; extract one `enrichIfNeeded(rows)` helper. Cuts ~250 duplicated lines.

**8. `enrichedRowsCache` retains rows forever (strong module-level Map) and is shared across Studio instances**
`internals/enrichedRowsCache.ts:42`. Unlike its WeakMap-keyed siblings, this cache is a plain module `Map` keyed by `sourceId` string with entries that strongly hold `rows`/`result`/`joinedSourceRows` and are never evicted — only replaced on access with the same key. Deleting a widget, removing a data source, or unmounting `Studio` leaves the enriched row arrays pinned for the page lifetime; being keyed by bare `sourceId`, two `Studio` instances with same-named sources also share/thrash entries. Fix: restructure as `WeakMap<Row[], Map<fieldSetKey, entry>>` like its siblings.

**9. `chartAggregation.ts` God-file: L4 join resolution, support analysis, a cache, and 8 aggregator families in one module**
1,491 lines mixing relationship analysis, row re-anchoring + its hand-rolled cache, generic aggregators, and chart-type-specific prep. The sort/categoryOrder/desc post-processing block is copy-pasted four times; rank filtering is implemented twice (post-aggregation here, pre-aggregation in `filterUtils.applyFilters`). Fix: split into `chartSupport.ts`, `chartRowResolution.ts`, `aggregators.ts` (with one shared `orderLabels` helper), and `chartShapes/`.

**10. `moveWidgetToPage`: doc comment promises behavior the code doesn't do; dead assignment**
`store/StudioController.ts:1404,1428-1430,1446`. The JSDoc says widget filters scoped to the current page are re-scoped to the target page; the body contains `const updatedFilters = state.filters;` — a no-op passed straight through. Page-scoped cross/interactive filters emitted by the moved widget keep their old `pageId` after the move. The widget's `colSpan` is also dropped from the source page but never carried to the target. Fix: implement the re-scoping or delete the dead variable and correct the comments; add a controller test for widget-move + filter behavior.

**11. `EvaluationContext.allRows` is dead — required by the API, read by nothing**
`utils/expressionEvaluator.ts:43,319,431` and every external caller. Nothing in the evaluator ever reads `context.allRows`; the comment describes a capability that doesn't exist. Related gap: measure evaluation of conditional operators builds a context without `sourceId`/`dataSources`/`joinIndexes`, so a `JoinFieldExpression` nested inside a conditional measure silently evaluates to `null`→0. Fix: delete `allRows` (or implement the documented behavior); hoist the per-row context object out of the field loop.

**12. `StudioRequestCache` doc claims stale-while-revalidate; `get()` hard-expires instead**
`internals/StudioRequestCache.ts:16-17` vs `:40-46`. The stale-serving actually happens in `useWidgetRows`'s React state, not the cache. Also `cacheKey.split(':')[0]` silently corrupts the source index if a `sourceId` ever contains `:`. Fix: correct the comment, store `sourceId` alongside the entry instead of parsing the key.

**13. Two grid systems coexist in `StudioController` span math**
`store/StudioController.ts:36-38` vs `:477,520,529-533`. `GRID_COLS = 24`/`MIN_SPAN_COLS = 6` are defined with a "must match StudioCanvas" warning, but `setWidgetColSpan`/`setWidgetColSpanInRow` clamp with hard-coded `3`/`12` (a 12-column mental model), while `setAdjacentWidgetColSpans` uses `MIN_SPAN_COLS = 6` (24-column model). If the canvas grid changes, half the clamps break silently. Fix: derive all clamps from `GRID_COLS`/`MIN_SPAN_COLS`.

**14. Smaller items**

- `queryDescriptor.test.ts:322` has an unfilled `(BL-XXX)` ticket marker — the only TODO-style marker in the audited surface.
- `restoreSession` migrates the present snapshot twice, papered over with a non-null assertion (`StudioController.ts:1581-1585`).
- Type-guard fragility: the expression model distinguishes variants by structural `'key' in expr` probing instead of a discriminated `kind` tag; three separate walkers depend on guard order staying correct.
- `usedFieldIds` over-collection: `useWidgetRows.ts:256-266` adds the field of _every_ filter in the store (any page, any widget) to a widget's `usedFieldIds`, churning cache keys whenever an unrelated filter appears.

**Positive note on test coverage**: undo/redo and session round-tripping are well covered (`StudioController.test.ts:848-1163`), as are happy-path cache hit/miss cases. The systematic hole is the one pattern shared by findings 1-3: no test anywhere changes a non-row dependency (filter operator, relationship, expression formula, junction/remote rows) while keeping row refs stable — precisely the regime the per-entry invalidation design is supposed to handle.
