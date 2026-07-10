# x-studio architecture review — iteration 9

Fresh ground-up review of `packages/x-studio` (2026-07-10). Focus areas per the review brief: the
L2/L3/L4 data pipeline (`src/internals/`), controller/store (`src/store/`), cross-widget/cross-source
interactions, KPI-class L4 filter-parity gaps in the other widget kinds, and consistency of the
iteration-8 fixes. All file references are relative to `packages/x-studio/src` unless noted; line
numbers reflect the current working tree.

Summary: **3 Tier 1** findings, **11 Tier 2** findings, plus 2 borderline notes. The iteration-8 KPI
fix is structurally complete (all 4 call sites thread `widgetFilters`), but two follow-on gaps in the
_inputs_ it threads (findings 1.3 and 2.2) partially defeat it for expression-field and
cross-page-cross-filter shapes.

---

## Tier 1 — data-integrity bugs (silently wrong rendered numbers)

### 1.1 Map widget silently aggregates the fan-in topology charts/KPI fail closed on — inflated sums

- **Where:** `components/widgets/StudioMapWidget/StudioMapWidget.tsx:234-289` (`regionData` memo),
  `components/StudioComposeDrawer/MapSetupPanel.tsx:96-138` (`numericFields`),
  `internals/crossSourceEnrichment.ts:55-100`.
- **What's wrong:** `MapSetupPanel` offers `mapValueField` from **every visible source** ("the join
  enrichment in useWidgetRows handles the actual data binding"). That enrichment
  (`enrichWithCrossSourceFields`, via `buildManyToOneRelationshipIndex`) copies a one-side value onto
  every many-side widget row — the exact fan-in topology `grainResolution.ts:83-90` documents as
  requiring per-group dedup and that `chartSupport.ts:338-348` fails closed on for charts
  (`mixed_cross_source_fields`) and the grid dedupes by FK
  (`StudioGridWidget.tsx` `makeFanoutSafeAggregationFunction` / `utils/gridGrouping.ts:91`
  `symmetricAggregate`). The map's `regionData` then reduces `row[valueField]` **once per widget
  row** with no FK dedup.
- **Failure scenario:** map on `order_items`, `mapValueField = orders.total`, aggregation `sum` by
  country → each order's total is counted once per line item. A grid summing the identical column
  dedupes correctly; a chart/KPI refuses the config outright. Three widget kinds give three different
  answers for the same measure; the map's is silently inflated (`avg` is fan-out-weighted too).
  Secondary: picking a value field from an **unrelated** source is allowed by the panel but
  `enrichWithCrossSourceFields` skips it silently (`crossSourceEnrichment.ts:62-68`) → blank map,
  no diagnostic.
- **Fix direction:** dedupe by the relationship's FK before reducing (map analogue of
  `symmetricAggregate` — per-region `Map<fkKey, value>` for cross-source value fields), or run the
  map's value-field resolution through an `analyzeChartSupport`-style guard and fail closed with a
  setup-panel error; restrict `MapSetupPanel`'s value-field list to the widget source + grain-safe
  related sources.

### 1.2 Grid pinned summary row (footer totals) is wrong for cross-source and expression columns

- **Where:** `components/widgets/StudioGridWidget/StudioGridWidget.tsx:736-747` (passes only
  `dataSource.fields`), `utils/gridSummary.ts:30-41` (missing-field-def → `isNumeric` false →
  silent degrade to `'count'`) and `:47-77` (per-row reduce, no FK dedup),
  `components/StudioComposeDrawer/GridSetupPanel.tsx:200-231` + `:389-408` (summary aggregation is
  configurable for primary expression fields AND many-to-one related-source columns).
- **What's wrong:** `computeGridSummary` resolves field defs from the widget source's _physical_
  fields only. A cross-source column (composite `sourceId/fieldId` key, translated to a bare id) or a
  calculated column finds no def, so a configured `sum`/`avg`/`min`/`max` silently degrades to
  `'count'`. Even with the def resolved, the reduce is per-row with no FK dedup, so a cross-source
  numeric footer sum would double-count exactly the fan-out that the same grid's _group_ totals
  already dedupe via `makeFanoutSafeAggregationFunction`.
- **Failure scenario:** order-items grid with an `orders.total` cross-source column, footer set to
  "Sum" → footer renders "Count: 1,532" while the grouped view of the same column sums correctly —
  visibly disagreeing totals in one widget. A calculated `price - cost` column footer does the same.
- **Fix direction:** pass `expressionFields` and the already-computed `crossSourceFieldDefs`
  (`StudioGridWidget.tsx:~413`) into `computeGridSummary`, and thread `crossSourceFkFields` through
  so it dedupes by FK before reducing (reuse `gridGrouping.ts`'s `aggregateValues` policy).

### 1.3 KPI widget subscribes to own-source-only expression fields — breaks the iteration-8 anchor-filter re-application for expression-field shapes and the trend's cross-source filter routing

- **Where:** `components/widgets/StudioKpiWidget/StudioKpiWidget.tsx:916-920`
  (`makeSelectExpressionFieldsForSource(widget.sourceId ?? '')` — single source), flowing into
  `useKpiGrainAnchoredRows` (`:406-431`), `computePeriodValue` (`:141-152`),
  `computeFilterBasedTrend` (`:293-329`), and the sparkline/fixed-period L4 calls (`:657`, `:834`).
- **What's wrong:** every other consumer of this machinery uses a broader list — `useWidgetRows`
  (which produces this same widget's row baselines) and `useChartWidgetData` subscribe to own +
  one-hop related sources (`useWidgetRows.ts:142-161`), and `useChartRows` passes the _full_ list.
  The KPI's own-source-only list breaks three things that specifically need related/anchor-source
  expression fields:
  1. **Anchor-filter classification** (`grainResolution.ts:28-43` `effectiveFilterSourceId`,
     `:143-145`): a drawer filter on an _anchor-owned expression field_ carries no
     `filterSourceId`; with the anchor source's expression fields absent from the list it is never
     classified anchor-scoped, so it is never re-applied at L4 — the exact "resurrection" bug the
     iteration-8 fix (finding 1.2/1.4) was meant to close persists for this filter shape in the KPI
     while the chart path handles it.
  2. **Anchor-row enrichment** (`grainResolution.ts:265-278`, `:346-357`): a filter that _is_
     classified (explicit `filterSourceId === anchor`) targeting an anchor-owned expression column
     is applied to anchor rows that were never enriched with that column (the own-source-only list
     can't enrich the anchor source) → `applyFilters` evaluates `undefined` → **every anchor row is
     dropped and the KPI reads 0**. Note this zero-out is _newly reachable via iteration 8's
     threading_ — before the fix, no filters were passed at all (rows were resurrected instead).
  3. **Trend previous-period routing** (`StudioKpiWidget.tsx:321-329` → `dataSourceGraph.ts:222-257`):
     `resolveRows` builds its cross-filter-routing `exprFieldIndex` from
     `ef.sourceId !== widgetSourceId` entries — empty with an own-source-only list — so a page
     filter on a related-source expression column is routed as a _native_ filter, evaluates
     `undefined`, and drops every previous-period row. The headline (via `useWidgetRows`'s broader
     list) semi-joins correctly → trend badge shows a bogus ∞/positive delta against a zero
     previous period. The foreign-row enrichment inside the cross-filter path
     (`getCachedEnrichedRows(foreignRows, sid, ownOnlyList)`) is similarly a no-op.
- **Fix direction:** mirror `useWidgetRows`: compute `relevantSourceIds` (own + one-hop related; see
  finding 2.1 for including M:N junctions) and subscribe via
  `makeSelectExpressionFieldsForSources(relevantSourceIds)`.

---

## Tier 2 — correctness / robustness gaps

### 2.1 M:N junction sources are omitted from every `relevantSourceIds` computation — junction-owned expression fields make the widget guard disagree with the setup panel and with L4

- **Where:** `components/widgets/StudioChartWidget/useChartWidgetData.ts:87-100`,
  `components/widgets/StudioChartWidget/StudioChartWidget.tsx:129-142`,
  `internals/useWidgetRows.ts:142-155` — all three add only `rel.sourceId`/`rel.targetId` (the two
  M:N _endpoints_) and never `rel.junctionSourceId`. Contrast `dataSourceGraph.ts:63-83`
  (`getReachableSourceIds`), which does include junctions and is already used by `GridSetupPanel`.
- **What's wrong:** `analyzeChartSupport` resolves a junction-owned field via
  `hasRowLevelField(junctionSourceId, …, expressionFields)` (`chartSupport.ts:22-35`, `:126-139`).
  Physical junction fields come from `source.fields` and resolve fine, but a junction-owned
  **expression field** (a supported topology — `resolveRowsAtGrain` has dedicated junction
  expression enrichment, `grainResolution.ts:256-278`, and `analyzeChartSupport` anchors on a
  junction whose y-field lives there, `chartSupport.ts:280-291`) is only findable through the
  expression-field list. With the scoped list it is invisible, so:
  - `useChartWidgetData`'s guard reports `field_not_found_or_not_direct` → permanent "unsupported"
    overlay, while `ChartSetupPanel` (full list, `ChartSetupPanel.tsx:79`, `:186-209`) validates and
    allows the exact configuration — the same class of disagreement the earlier "finding 2.1" fix
    closed for one-hop sources — and while `useChartRows`/`resolveChartRowsForAggregation` (full
    list) would happily resolve the rows if the guard passed.
  - In `useWidgetRows`' L3, a filter targeting a junction-owned expression column cannot be routed
    or enriched (same mechanism as finding 1.3's item 3).
- **Fix direction:** add `rel.junctionSourceId` for `many-to-many` relationships in the three
  `relevantSourceIds` memos (or replace them with `getReachableSourceIds`, which already has the
  right semantics).

### 2.2 KPI's four `selectFiltersForWidget` calls omit `crossFilterAllPages` — L4/trend scope disagrees with the rendered row baselines when the all-pages toggle is on

- **Where:** `components/widgets/StudioKpiWidget/StudioKpiWidget.tsx:262-267`
  (`computeFilterBasedTrend`), `:608-613` (sparkline), `:777-782` (trend badge), `:959-968`
  (`kpiWidgetFilters`). None passes `crossFilterAllPages`, so it defaults to `false`
  (`filterScoping.ts:30`), while `useWidgetRows` — which produced `currentRows`/`effectiveRows` —
  subscribes to and passes it (`useWidgetRows.ts:164`, `:178`, `:202`), as do `useChartWidgetData`
  (`:151-172`) and `generateInsight.ts` (`:436-442`).
- **Failure scenario:** `crossFilterAllPages: true`, KPI in `'cross-filter'` mode, a chart on
  _another page_ emits a cross-filter. The KPI's rendered rows include that cross-filter (via
  `useWidgetRows`), but `kpiWidgetFilters`/`scopedFilters` exclude it — so (a) an anchor-scoped
  cross-page cross-filter is not re-applied during L4 re-anchoring (row resurrection, the exact
  invariant iteration 8 established), and (b) the trend's previous-period rows are computed without
  the cross-filter while the current headline includes it → wrong delta.
- **Fix direction:** subscribe `selectCrossFilterAllPages` in `StudioKpiWidget` and pass it at all
  four sites (the comments at each site already claim scope parity with the row baselines — this is
  the one missing parameter).

### 2.3 Related-source expression columns: selectable everywhere, resolvable nowhere (grid renders nothing; charts render blank buckets)

- **Where:**
  - Grid: `components/StudioComposeDrawer/GridSetupPanel.tsx:214-231` offers many-to-one
    related-source fields _including that source's expression fields_ (`expression: 'non-measure'`),
    but `internals/crossSourceEnrichment.ts:66-72`+`:97` indexes the related source's **raw** rows
    (no L2 pass), so `relatedRow[fieldId]` is always `undefined` for a related expression field, and
    `StudioGridWidget.tsx:207-223` (`resolveCrossSourceFieldDefs`) resolves only
    `dataSources[c.sourceId]?.fields` → no column def is built either. The column is silently
    absent, no error.
  - Chart: `dataSourceGraph.ts:446-449` (`enrichRowsWithRelatedFields`, direct branch) likewise
    checks only `relatedSource.fields`, while `findDirectFieldOwner` resolves owners from
    `expressionFields` too — so a related-source calculated column used as a chart dimension passes
    `analyzeChartSupport` yet resolves to `undefined` on every row in the no-re-anchor branch → one
    blank bucket. This half is a _documented known limitation_
    (`StudioChartWidget.test.tsx:2269-2274` explicitly notes the fixture renders empty), but the
    current state is guard-passes/data-blank, which contradicts the package's fail-closed
    convention.
- **Fix direction:** in both `enrichWithCrossSourceFields` and `enrichRowsWithRelatedFields`, when a
  requested related field is an expression field owned by the related source, route that source's
  rows through `getCachedEnrichedRows` (scoped to the requested ids) before building the lookup —
  the same pattern `grainResolution.ts` already applies to anchor/junction/remote rows. Extend
  `resolveCrossSourceFieldDefs` to fall back to `expressionFields` owned by `c.sourceId`.
  Alternatively fail closed at the setup panels.

### 2.4 `generateInsight.toPipelineState` drops `crossFilterAllPages`/`globalCrossFilterMode` — AI snapshot L3 and L4 resolve cross-filters differently

- **Where:** `components/StudioChatPanel/generateInsight.ts:250-257` (returns only
  `dataSources`/`relationships`/`expressionFields`/`filters`) vs `:434-442` (chart-summary
  `widgetFilters` built with `state.doc.dashboard.globalCrossFilterMode` and
  `state.doc.dashboard.crossFilterAllPages`); `internals/StudioPipeline.ts:136-177` (the pipeline
  resolves effective mode as `globalCrossFilterMode ?? options.widgetCrossFilterMode ?? …` from its
  snapshot — here always `undefined`).
- **Failure scenario:** (a) dashboard `globalCrossFilterMode: 'none'` — the rendered widget ignores
  cross-filters, but the snapshot's L3 rows hard-apply them, so the AI narrates numbers the user
  isn't seeing; (b) `crossFilterAllPages: true` with a cross-filter from another page — snapshot L3
  skips it while the L4 `widgetFilters` include it, re-applying an anchor-scoped filter to rows L3
  never semi-joined (violating the L3/L4-agreement invariant inside this one code path).
- **Fix direction:** forward both dashboard settings in `toPipelineState`
  (`StudioPipelineState` already accepts them — `widgetExport.ts` passes the full `StudioState` and
  is correct).

### 2.5 AI snapshot sampling drops expression/cross-source columns; map summary is unenriched and unnormalized

- **Where:** `components/StudioChatPanel/generateInsight.ts:772-775` (field membership checked with
  `id in r` against **raw** pre-L2 rows, so enriched expression columns present on `filteredRows`
  are excluded from the sample; cross-source grid columns are never enriched on this path at all);
  `:601-650` (`buildMapWidgetSummary` aggregates `filteredRows[countryField]` with no cross-source
  enrichment and no `normalize()` merge — 'US'/'USA'/'United States' count as three regions while
  the rendered map merges them); `:213-237` (`buildNumericStats` recognizes only `source.fields`,
  so expression measures get no stats line).
- **Failure scenario:** a pivot/grid whose value field is a calculated column → the model is told
  about every column _except_ the one the widget aggregates; a map summary reports region counts
  that disagree with the rendered map.
- **Fix direction:** check membership against an enriched row (e.g. `filteredRows[0]`), mirror
  `widgetExport.ts:119-144`'s cross-source enrichment, and reuse the map widget's normalizer for
  the map summary.

### 2.6 Grid CSV export: cross-source column headers/formatting drift from the rendered grid

- **Where:** `components/StudioWidgetCard/widgetExport.ts:119-144` (values correctly enriched) but
  `internals/widgetUtils.tsx:534-560` (`buildCsvContent`) builds its field map from
  `dataSource.fields` + own expression fields only — no `resolveCrossSourceFieldDefs` equivalent.
- **Failure scenario:** a cross-source column exports with the raw field id as header and no
  number/currency formatting while the on-screen grid shows the related source's label/format.
- **Fix direction:** pass the grid's `crossSourceFieldDefs` into `buildCsvContent`.

### 2.7 `duplicateWidget` bypasses the one-rank-filter-per-page invariant

- **Where:** `store/StudioController.ts:1436-1456` (clones **all** widget-scoped filters, committed
  via raw reducer `addFilter` mutations with no rank check) vs the guard in `addFilter`
  (`:1486-1497`, `hasConflictingRankFilter`); `x-studio-schema/src/applyMutation.ts` `addFilter`
  handler applies verbatim.
- **Failure scenario:** duplicate a widget carrying a widget-scoped Top-N rank filter → two rank
  filters resolve to the same page (the state `addFilter`/`updateFilter` reject and the filters
  drawer assumes cannot exist); subsequent rank edits are rejected with the "only one rank filter"
  warning and the violated invariant persists into the saved doc. Same bypass exists via
  `applyFilterPreset` (a preset page rank filter vs an existing widget-scoped rank filter).
- **Fix direction:** in `duplicateWidget`, drop (or check via `hasConflictingRankFilter`) cloned
  filters with `filterMode === 'rank'`, guard-and-continue style.

### 2.8 Filter presets break `dependsOn` (cascading-filter) linkage on save/apply

- **Where:** `store/docTransforms.ts:310` (`saveFilterPreset` re-keys ids to `${id}-${f.id}`),
  `:343-347` (`applyFilterPreset` mints fresh `createFilterId()`s) — neither remaps
  `filter.dependsOn` (`x-studio-schema/src/stateTypes.ts:99`), which holds _other page filters'
  ids_.
- **Failure scenario:** save cascading Country → City filters as a preset, apply it later — the
  City filter's `dependsOn` points at ids that no longer exist (the apply just replaced them);
  `FilterBody.tsx` silently filters the dangling ids out, so the cascade narrowing quietly stops
  working and dangling ids are persisted.
- **Fix direction:** build an oldId→newId map during `applyFilterPreset`'s re-materialization and
  rewrite `dependsOn` through it (dropping ids that don't resolve within the preset).

### 2.9 `upsertDataSource` has no same-reference guard — every call invalidates the request cache and commits

- **Where:** `store/StudioController.ts:679-715`: unconditional
  `studioRequestCache.invalidateSource(...)` + commit even when the incoming `dataSource` is
  reference-identical to the stored entry. `setDataSourceAdapter` (`:730-741`) got exactly this
  guard for exactly this loop hazard.
- **Failure scenario:** a host re-injects the same source object from an effect/poller — each call
  bumps the source generation, evicts all cached adapter results, and marks in-flight requests
  stale → adapter-backed widgets refetch continuously; paired with `onStateChange`-driven
  re-renders this is an unbounded refetch loop (the `StudioDashboard` path is safe only because it
  keys on `config` identity).
- **Fix direction:** early-return when the resulting entry would be reference-identical to the
  existing one (no adapter carried over, same object), skipping both invalidation and commit.

### 2.10 Phantom redo-clearing commits: `setPageStackBreakpoint` / `updateActivePage` (and `updateRelationship`)

- **Where:** `store/StudioController.ts:1072-1084` and `:1858-1871` — both build a fresh page object
  unconditionally (`{ ...page, ...changes }`), so `commitDocPatch`'s reference-equality no-op guard
  can never fire even for a value-identical write. The codebase systematically eliminated this class
  elsewhere (`setAdjacentWidgetColSpans`, `reorderPages`, docTransforms identity preservation).
- **Failure scenario:** user edits, presses Ctrl+Z (redo pending), then re-confirms the page theme /
  stack breakpoint it already has → redo stack wiped, no-op undo entry inserted.
- **Fix direction:** value-equality bail before committing, matching the sibling writers.
  (`updateRelationship`'s `{ ...rel, ...patch }` has the same hole.)

### 2.11 `applyExternalMutation` silently drops the mutation-log line for `setActivePage`/`renameAIThread`, contradicting two in-code contracts

- **Where:** `store/StudioController.ts:444-472` forces `undoable: false` for these two mutation
  types while asserting "Logging/label behaviour is unchanged"; but `commitState` (`:158-181`) only
  pushes the label _inside the undoable-and-doc-changed branch_, so these mutations are never
  logged — also contradicting `setActivePage`'s own comment (`:1881-1882`, "only the AI-driven
  `applyExternalMutation` path logs `setActivePage`").
- **Failure scenario:** the AI navigates pages / renames a thread; a later
  `get_recent_changes`/`richContext` build omits those events, so the model reasons from an
  incomplete change log.
- **Fix direction:** either record the label whenever `nextState.doc !== current.doc` regardless of
  `undoable` (keeping it out of the `resetHistory` branch), or pass `label: null` for the
  transient-only mutations and fix both comments.

### 2.12 `analyzeChartSupport` junction-anchors M:N relationships that lack `junctionSourceField`/`junctionTargetField` — silent first-match fallback instead of fail-closed

- **Where:** `internals/chartSupport.ts:273-291` and `:304-329` require only `junctionSourceId`
  before anchoring on a junction, but `grainResolution.ts:179`'s M:N branch additionally requires
  both junction fields; when they're absent the call falls through to the
  `enrichRowsWithRelatedFields` fallback (`grainResolution.ts:305-319`) — whose M:N lookup also
  requires the junction fields (`dataSourceGraph.ts:472`) and so silently resolves the dimension to
  `undefined` (blank bucket) or the y to a count fallback, instead of the clean fail-closed
  `mixed_cross_source_fields` state.
- **Reachability:** the RelationshipDialog validates junction fields (`RelationshipDialog.tsx:73`),
  so this only affects host-injected/AI-authored relationship configs — hence Tier 2, robustness.
- **Fix direction:** in all three junction-anchor selection sites (and
  `isSafeWidgetBridgeOwner`/`findDirectFieldOwner`'s junction checks), require
  `junctionSourceField && junctionTargetField` before treating a junction as usable, mirroring
  `findJoinPath`'s completeness check (`dataSourceGraph.ts:133`).

### 2.13 `ChartSetupPanel`'s support check omits `extraFields` and scatter color/size — panel and canvas disagree in the opposite direction from the fixed finding 2.1

- **Where:** `components/StudioComposeDrawer/ChartSetupPanel/ChartSetupPanel.tsx:186-209` calls
  `analyzeChartSupport` with 8 arguments — no `scatterColorField`/`scatterSizeField`/
  `chartTypeExtraFields` — while `useChartWidgetData.ts:267-295` passes all three.
  `HeatmapAxesSection`/the other non-xy sections run no `analyzeCombination` gating of their own.
- **Failure scenario:** pick an unresolvable cross-source `heatYField` (or scatter color/size
  field): the panel shows no warning and doesn't disable the option, while the rendered widget shows
  the "unsupported chart configuration" overlay — the authoring surface says valid, the canvas says
  invalid.
- **Fix direction:** thread the same `chartTypeExtraFields` list (and the scatter aux fields) into
  the panel's `chartSupport` memo, mirroring the widget's call.

---

## Borderline notes (design-ambiguity, flagged but possibly intended)

- **N1. Filter-widget option lists / slider bounds derive from the fully unfiltered source**
  (`StudioFilterWidget.tsx:99-206`): page filters, dashboard date range, and sibling filter-widget
  selections are ignored, so a value excluded by a page filter is still offered (selecting it yields
  empty widgets) and slider bounds can exceed the filtered domain. Excluding the widget's _own_
  filter is trivially satisfied. If "show the full domain" is the intended UX this is fine;
  otherwise derive the baseline from `resolveRowsCached` with page-scoped filters minus the
  widget's own interactive entries.
- **N2. Adapter cold-cache placeholder shows unfiltered rows** (`internals/useAdapterRows.ts:87-91`):
  before the first fetch resolves, `adapterRows` are seeded from raw `source.rows` and the
  client-side pass re-applies only cross/interactive/rank filters (page/widget filters are assumed
  server-side), so the widget briefly renders rows that ignore page/widget filters (under a loading
  flag). Transient; consider filtering the placeholder through `selectFiltersForWidget`
  (`include: 'no-cross'`).

---

## Areas checked and found clean

- **L4 core** (`grainResolution.ts`, `chartSupport.ts`): the iteration-8 anchor/remote filter
  re-application, `effectiveFilterSourceId` derivation, junction expression enrichment, M:N
  remote-endpoint filtering, and the `rcfaCache` key/validity tracking (anchor-scoped filter
  fingerprint, `collectReadSourceIds` row refs, expression-field ref equality) are all internally
  consistent — given a correct expression-field list (see 1.3/2.1).
- **KPI iteration-8 fix structure**: all four `resolveChartRowsForAggregation` call sites thread
  `widgetFilters` whose `include` mode matches the row baseline in use; `generateInsight` and the
  public `StudioPipeline.resolveChartRows` mirror the render call shape (extraFields +
  widgetFilters). The gaps are in the threaded inputs (1.3, 2.2), not the threading.
- **L3** (`dataSourceGraph.resolveRows`, `resolvedRowsCache`, `enrichedRowsCache`): cross-filter
  routing, semi-join key normalization, per-entry dependency tracking (absent-source `null`
  sentinels, derived filter sources, transitive join targets), fingerprint completeness (incl.
  relative-date day-resolution), and LRU capping are correct. `enrichedRowsCache`'s
  relevant-relationship filter matches the evaluator's forward-only M:1 join resolution
  (`expressionEvaluator.ts:133`).
- **Filter evaluation** (`filterUtils.ts`): day-granular date equality, `between` bound/NaN
  handling, selection `not_in`, filter-then-rank ordering — consistent with the adapter push-down
  contract.
- **`filterScoping.selectFiltersForWidget`**: scope switches (incl. `crossFilterAllPages` and the
  self-exclusion rules) consistent with `useWidgetRows`' partitioned baselines and the reducer's
  cross-filter lifecycle. Page filters authored in the drawer always carry `filterSourceId`
  (`PageFilterRow.tsx:183`).
- **`useChartWidgetData`/`useBlendedSeriesRows`**: ghost/baseline filter parity
  (`resolvedFiltersNoCross` ↔ `filteredRowsNoCross`), per-series aggregation precedence, blended
  foreign-series scoping via the shared authority, failed-refetch stale-row clearing — all sound.
- **Pivot widget**: own-source-only config (no cross-source refs), COUNT(\*) semantics, CSV export
  reuses the rendered matrix — no KPI-class exposure.
- **Grid grouping path**: `makeFanoutSafeAggregationFunction`/`symmetricAggregate` share the
  FK-dedup + `aggregateValues` policy; cross-highlight row matching by identity token survives
  enrichment cloning.
- **Controller/undo**: `carryTransientDocState` covers every non-undoably-written doc field in the
  current `StudioDoc`; undo/redo doc-only swaps, `activePageId` re-derivation, dangling-selection
  normalization, `commitMutations` transform-after-fold no-op semantics, `MAX_UNDO_HISTORY`,
  `loadSerializedState`/`serializeSession`/`restoreSession`, and `StudioRequestCache` generation
  tagging are all correct.
- **`useWidgetRows` sync/adapter parity**: both paths route through `selectFiltersForWidget` with
  identical parameters; adapter rows get L2 re-enrichment and client-side rank re-application.
