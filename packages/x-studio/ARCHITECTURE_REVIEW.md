# x-studio architecture review — iteration 5 (fresh)

Synthesized from five independent, exhaustive sub-reviews covering: (1) store/context/persistence
(`StudioController.ts`, `docTransforms.ts`, `StudioContext.tsx`, `selectors.ts`, `Studio`/`StudioDashboard`
shell), (2) widget renderers (chart/grid/kpi/map/pivot), (3) compose drawer / filters drawer / widget edit
dialog / expression dialog / data drawer, (4) canvas / chat panel / AI text widget / shell / i18n, and
(5) data pipeline internals (L2/L3/L4 caches, adapters, aggregation). Each sub-review cross-checked its
claims against current source (file/line) and against `ARCHITECTURE.md`'s documented invariants before
reporting. Overlapping findings from different sub-reviews describing the same root cause are merged below.

## Tier 1 — real bugs / security issues with concrete failure scenarios

### 1.1 `privateMode` is silently bypassed by two AI request paths

- **Files**: `components/StudioChatPanel/createWidgetFromDescription.ts:79-127`,
  `components/widgets/StudioTextWidget/useTextWidgetAI.ts:213-229`
- `studioBackendAdapter.ts`'s main chat path carefully enforces `privateMode` (schema-only prompts, no real
  row values sent). Neither of these two other AI entry points reads `config.privateMode`/`aiConfig.privateMode`
  at all:
  - `createWidgetFromDescription`'s `/widget` request sends every source's id/label/`aiDescription`, all field
    metadata, and for low-cardinality fields the **actual distinct data values** (`cardinality = "${vals.length}: ${vals.join('|')}"`,
    sourced from real rows via `fieldDistinctValues`). `DescribeWidgetSection` gates only on `aiConfig?.endpoint`
    - `features.aiChat` — with `privateMode: true` this box still leaks row values on every use.
  - `useTextWidgetAI` POSTs `dashboardState` (every widget config, filter, field name, layout) and `pageSnapshot`
    (CSV-style sampled real row values from sibling widgets) to `/chat` unconditionally.
- **Repro**: set `privateMode: true`, then either (a) use "describe a widget to create it", or (b) add an
  AI-mode text widget to a page with other data widgets. Real row values reach the LLM provider despite the
  documented guarantee that private mode sends "no widget configurations, field names… or row values".
- **Fix direction**: gate both payloads behind `!privateMode` (omit `cardinality`/`aiDescription`/`dashboardState`/`pageSnapshot`,
  or the whole `sources` payload) and forward `privateMode` to the server so it can also refuse to comply.

### 1.2 `setDataSourceAdapter` has no same-adapter guard — refetch storm / possible update loop via `StudioDashboard`

- **File**: `store/StudioController.ts:680-686` (+ `commitDataSourcePatch`, 387-406), `components/Studio/StudioDashboard.tsx:182-189`
- `setDataSourceAdapter` unconditionally invalidates the request cache and commits a new source object even
  when `adapter === existing.adapter`. `StudioDashboard` re-runs it for every entry whenever its `dataAdapters`
  prop changes **by identity**. A host passing an inline `dataAdapters={{ orders: ordersAdapter }}` map alongside
  an `onStateChange` that stores the new state creates: commit → `onStateChange` → parent re-render → new inline
  map identity → effect refires → commit again → … an unbounded loop, with every iteration also invalidating and
  refetching every source's rows from the server.
- **Fix direction**: early-return in `setDataSourceAdapter` when the adapter reference is unchanged; optionally
  add the same value-equality guard to `commitDataSourcePatch` that `commitDocPatch` has.

### 1.3 Window-level undo/redo shortcuts fire across every mounted Studio instance simultaneously

- **File**: `internals/useStudioKeyboardShortcuts.ts:68`, `components/Studio/StudioContent.tsx:127`
- Registers `window.addEventListener('keydown', …)` unconditionally per instance, with no scoping to the
  Studio root, no focus-containment check, and no `mode` gate (fires even in view-only embeds).
- **Repro**: mount two `<StudioDashboard>`s (an explicitly supported scenario per `selectors.ts:326-330`).
  Ctrl+Z undoes the most recent action in **both** dashboards from one keypress.
- **Fix direction**: scope the listener to the Studio root (focus-within / `event.currentTarget` containment),
  or a module-level "active instance" arbiter; gate on edit mode for embeds.

### 1.4 Empty-page drop target (and the canvas `ResizeObserver`) go dead after a populated→empty transition

- **Files**: `components/StudioCanvas/useStudioDropTarget.ts:32-50`, `StudioCanvas.tsx:561-625, 591-627+`
- Both hooks have a `[ref]`-only effect dependency and read `ref.current` once. The empty-state `Paper` (drop
  target) and the populated-state root `Box` (resize-observed) are different DOM nodes rendered in mutually
  exclusive branches of the same persistent, memoized `StudioCanvas` component — so the very first time the
  page's emptiness flips _after mount_ (delete the last widget, or later add one back), the effect never re-runs
  and the hook keeps referencing a detached/never-attached node.
- **Repro (drop target)**: edit mode, page with one widget → delete it → drag a widget type onto the empty-state
  card → no hover highlight, drop does nothing. **Repro (resize observer)**: mount empty → populate → resize the
  window → `canvasWidth` never updates, so the responsive stack tiers are computed from a stale width.
- **Fix direction**: use a callback ref (register/unregister on attach/detach) instead of a stored `RefObject`,
  or key the effect on whether the empty/populated branch is active.

### 1.5 `rcfaCache` (L4) serves stale rows when a non-anchor related source's rows change

- **File**: `internals/chartSupport.ts:308-427` (cache in `resolveChartRowsForAggregation`), cross-referenced
  against `internals/grainResolution.ts:74-92, 128-131, 182-188`
- The cache is keyed on `widgetRows × anchorRows × configKey` and validated only against `relationships` and
  expression-field refs — but grain resolution also reads rows from related sources that are **neither** the
  widget's own source nor the anchor (enrichment joins, M:N remote-endpoint rows, many-to-one third-source
  rows). None of those row references are tracked by the cache key.
- **Repro**: chart on `orders` with `seriesField = customers.segment` (many-to-one). Update `customers`' rows via
  `setDataSourceRows`. `filteredRows`/`anchorRows`/relationships/expression-fields are all unchanged by identity
  → cache hit → chart keeps rendering the old segment values indefinitely.
- **Fix direction**: have `resolveRowsAtGrain` report every foreign source it actually read (mirroring
  `resolveRows`'s `collectJoinedSourceIds`) and fold those row refs into the cache-validity check.

### 1.6 Page-scoped rank filters serialize as a bogus server predicate on adapter sources, and the rank is never applied there

- **Files**: `internals/filterScoping.ts:42-47`, `internals/queryDescriptor.ts:18-30, 179-185`,
  `server/createBatchingAdapter.ts:1183-1197, 1344`
- `filterScoping.ts`'s `page`-scope case includes `'rank'`-mode filters when building the descriptor (only the
  `widget` case excludes them), but `filterStateToLeaf` drops `filterMode` entirely — the leaf becomes an
  `equals`/default-operator condition against the rank's default value (`10`). The adapter either sends a
  nonsensical `field eq 10` predicate, or (on the residual path) `leafToClientFilterState` hardcodes
  `filterMode: 'condition'`, applying it as a literal value filter. Neither path performs the actual top-N/bottom-N
  rank reduction that the in-memory (`compileRowTest`/`applyFilters`) path does.
- **Fix direction**: strip `filterMode === 'rank'` leaves before building the server descriptor and apply the
  rank client-side afterward, mirroring the sync path.

### 1.7 Relationship-aware batching adapter silently drops filters on arithmetic expression fields

- **File**: `server/createBatchingAdapter.ts:1018-1027`
- A page filter on an arithmetic `FunctionExpression` field (e.g. `margin = price - cost`) with a translatable
  operator is routed to `partition.predicates`, `resolve()` returns `{skip: true}` for it, and the predicate is
  dropped from the request with **no warning and no addition to the client-side residual filter list** —
  contradicting the module's own documented contract ("degrades to client-side enforcement rather than being
  silently dropped"). The raw inputs are already selected and client-side re-enrichment already happens, so
  routing these leaves to the client residual would work.
- **Fix direction**: when `resolve()` reports `skip`, divert the leaf into the client-side filter list (or at
  minimum call `warnAdapterDivergence`).

### 1.8 `avg` + `xGroupBy` on an adapter source computes an unweighted average of averages (silently wrong numbers)

- **File**: `server/createBatchingAdapter.ts` (request-body builders, ~904-915/1059-1082), consumed by
  `useChartWidgetData`'s re-bucketing via `applyXGroupBy`/`aggregators.ts:239-305`
- Neither adapter transmits `xGroupBy` to the server, so the server aggregates `avg` at the raw x-grain and
  returns one average per raw date; the client then re-buckets by month/etc. and averages those per-day
  averages — mathematically wrong unless every day has an equal row count. `sum`/`min`/`max` re-aggregate
  correctly across grains; `count` is already special-cased to route client-side; `avg` is the one silent
  wrong-number case.
- **Fix direction**: treat `avg` + `xGroupBy` like `count` — fetch raw rows (or `sum`+`count`) and finalize the
  average client-side.

### 1.9 Non-xy chart families (heatmap/funnel/sankey/gantt/gauge) aggregate un-enriched rows, so a cross-source extra-dimension field that passes the support guard renders blank

- **Files**: `internals/chartTypeDefs.tsx` (`renderHeatmap:432-459`, `renderFunnel:499-553`,
  `renderSankey:593-597`, `renderGantt:631-635`, `renderGauge:653-657`), `internals/chartSupport.ts:172-186,
271-289, 346-348`, `internals/useChartRows.ts:47-56`, `internals/useChartWidgetData.ts:163-220`
- These five renderers all aggregate `ctx.filteredRows` (raw L3 output), never `ctx.enrichedRows`. But
  `useChartRows`/`resolveChartRowsForAggregation` only ever enrich x/y/series fields — `heatYField`,
  `funnelReachedField`, `sankeyTargetField`, and the Gantt fields are never threaded into the requested-fields
  set for L4 resolution, even though `analyzeChartSupport` explicitly validates them and reports a one-hop
  related-source field as **supported**.
- **Repro**: widget on `orders`, heatmap `x=orders.date`, `heatY=customers.region` (many-to-one), `value=orders.total`.
  The support guard passes (the field resolves to a valid related source), the unsupported-overlay never shows,
  and `aggregateHeatmap` reads `row['region']` → `undefined` for every row → one blank bucket. Directly
  contradicts `ARCHITECTURE.md`'s claim that "an unresolvable extra dimension field correctly makes the guard
  report the chart unsupported" — the _resolvable_ case is the one that's broken.
- **Fix direction**: thread `extraFields` (heatY/funnelReached/sankeyTarget/gantt\*) through
  `useChartRows`/`resolveChartRowsForAggregation`'s requested-fields set and `configKey`, and switch these five
  renderers to read from `ctx.enrichedRows`.

### 1.10 Editing a measure expression's formula leaves the KPI headline and sparkline stale while the trend updates

- **File**: `components/widgets/StudioKpiWidget/StudioKpiWidget.tsx:293-300, 452-456, 614-616`,
  cross-referenced against `internals/resolvedRowsCache.ts:102`, `internals/enrichedRowsCache.ts:159`
- `useKpiValue`'s cache key (`kpi-value:${field}:measure:${id}`) and the sparkline's cache key both lack any
  fingerprint of the measure expression's actual content. Measures are deliberately excluded from row-identity
  cache invalidation, so editing a measure's formula changes `expressionFields` but busts neither the rows
  reference nor the cache key — `cachedCompute` keeps serving the pre-edit number. The filter-based trend
  resolves fresh rows independently, so it picks up the new formula while the headline/sparkline don't,
  producing a visibly inconsistent delta.
- **Repro**: KPI measure `revenue_per_order = sum(total)/count()`; edit the formula to `sum(total)`; headline
  and sparkline don't change until an unrelated filter/data edit busts row identity by chance.
- **Fix direction**: fold a content fingerprint of `measureExprField.expression` into both cache keys.

### 1.11 Grid cross-source display columns are configurable but never actually render, while CSV export renders them

- **File**: `components/widgets/StudioGridWidget/StudioGridWidget.tsx:48-58, 182-185`, cross-referenced against
  `components/StudioComposeDrawer/GridSetupPanel.tsx:185-217`, `internals/useWidgetRows.ts:431-476`,
  `internals/widgetExport.ts:70-93`
- `computeOrderedFieldIds` filters configured column ids down to own-source fields only, so a configured
  cross-source column (which the setup panel explicitly lets you add, and which row-enrichment and CSV export
  both explicitly support) produces no `GridColDef` and silently disappears from the grid — while
  `buildCsvContent` (not filtered to own-source ids) exports it fully populated. On-screen and exported columns
  diverge in both directions.
- **Fix direction**: resolve cross-source columns' field defs from `dataSources[c.sourceId]` and include them in
  `orderedFieldIds`/`columnVisibilityModel`.

### 1.12 KPI filter-based trend's previous-period window day-shifts for non-UTC viewers

- **File**: `StudioKpiWidget.tsx:293-300`, cross-referenced against `internals/kpiUtils.ts:262-268`
- Serializes the previous-period window boundaries via `date.toISOString().slice(0, 10)` against boundaries
  computed in **local** time (`computePreviousPeriodRange`) — for a UTC+ viewer, local midnight day-shifts
  backward when serialized to ISO/UTC; for a UTC- viewer, the end boundary shifts forward a day. This directly
  contradicts the package's own documented policy of avoiding exactly this `toISOString()` day-shift pattern
  (`temporalUtils.toLocalYmd` exists specifically to prevent it).
- **Fix direction**: format the boundaries via local Y/M/D components (reuse `toLocalYmd`), not `toISOString()`.

### 1.13 GridSetupPanel: re-selecting the already-active data source wipes all columns and field-bound config

- **File**: `components/StudioComposeDrawer/GridSetupPanel.tsx:311-321`, cross-referenced against
  `components/StudioComposeDrawer/KpiSetupPanel.tsx:254-258`
- `handleSourceChange` unconditionally commits `clearFieldBoundGridConfig` with no `nextSourceId === widget?.sourceId`
  guard (the KPI sibling panel has this guard). Since MUI `useAutocomplete`'s single-select equality is
  reference equality and both the picker's value and its options are freshly-mapped objects every render,
  clicking the _already selected_ source in the dropdown fires `onChange` with a different object reference.
- **Repro**: grid widget on "Orders" with curated columns/sort/conditional formats → open the data-source picker
  → click "Orders" again (no actual change intended) → every field-bound setting is wiped in one undoable commit.
- **Fix direction**: add the same early-return guard the KPI panel already has.

### 1.14 Filter operator switch destroys a configured relative-date value in both the drawer and the edit dialog

- **Files**: `components/StudioFiltersDrawer/FilterBody.tsx:94-102`,
  `components/StudioWidgetEditDialog/FilterRow.tsx:210-218`
- The "reset the value when leaving `between`" predicate (`value !== null && typeof value === 'object' && !Array.isArray(value)`)
  is also true for a `RelativeDateValue` (`{relative: true, amount, unit, direction}`), which is a fully
  supported scalar filter value, not a `between`-shaped one.
- **Repro**: date filter, operator "On", value = relative "7 days ago" → switch operator to "Before" (scalar→scalar)
  → value silently resets to `''`, discarding the relative-date configuration.
- **Fix direction**: exclude `isRelativeDateValue(filter.value)` (already exported from `filterDrawerUtils.ts:60`)
  from the reset predicate in both files.

### 1.15 SecondCondition's `operator2` has neither the between-shape reset nor the operator-repair effect that `operator` has

- **File**: `components/StudioFiltersDrawer/SecondCondition.tsx:92-95`, cross-referenced against
  `PageFilterRow.tsx:105-113`, `WidgetFilterRow.tsx:110-118`
- The primary condition resets `value` when the operator leaves `between`, and a non-undoable effect repairs an
  invalid stored `operator`. The second condition's operator handler does neither for `operator2`/`value2`.
- **Repro**: number filter → add a second condition → operator2 = Between, fill from/to → switch operator2 to
  "=" → `value2` stays `{from,to}`, evaluates as `NaN` (silently matches nothing) and renders as `[object Object]`.
- **Fix direction**: mirror both the shape-reset and the repair effect for `operator2`/`value2`.

### 1.16 GaugeConfigSection switches source without folding in stale widget-filter removal

- **File**: `components/StudioComposeDrawer/ChartSetupPanel/GaugeConfigSection.tsx:94-101`
- Folds `sourceId`+`yField` into one undoable `updateWidget` commit (correct undo folding) but passes no
  `removeFilterIds` and doesn't even receive `allFilters` — unlike every sibling setup panel (Chart, KPI, Grid),
  which fold stale-filter removal into the same commit specifically because a stranded widget-scoped filter
  silently excludes every row.
- **Repro**: chart with a widget-scoped filter on a field of source A → switch chart type to Gauge → pick a
  value field from unrelated source B → widget re-sourced to B, stale A-field filter remains and excludes every
  row → blank gauge with no explanation.
- **Fix direction**: thread `allFilters`/`fieldCatalog`/`relationships` into `GaugeConfigSection` and pass
  `removeFilterIds` like the other panels.

### 1.17 Filters drawer's `between` numeric bounds commit one undoable store write per keystroke

- **File**: `components/StudioFiltersDrawer/FilterValueInput.tsx:90-115`
- The two `between` number `TextField`s call `controller.updateFilter` directly on every keystroke — no
  debounce (the existing 150ms debounce covers only the scalar text/autocomplete paths) and no buffer, unlike
  the edit dialog's `BufferedTextField` for the identical `between` shape.
- **Repro**: typing "1500" into the "From" bound produces 4 separate undoable commits and 4 full pipeline
  recomputes; Ctrl+Z un-types one digit at a time.
- **Fix direction**: route the bounds through the existing debounce, or a buffer-then-commit-on-blur pattern
  matching the edit dialog.

## Tier 2 — design inconsistencies / missing safeguards

- **2.1** `StudioDashboard` config swap leaks stale data sources: `loadSerializedState` preserves the _previous_
  controller's entire `runtime.dataSources` and only upserts the new config's sources, so a source removed from
  the new config survives forever (`StudioDashboard.tsx:162-176`, `StudioController.ts:1976-1980`) — and
  `StudioDateRangeBar`'s coverage-expansion effect will keep minting a `dashboard-date-range` filter for it.
- **2.2** `createDefaultStudioState` can mint a state with a dangling `activePageId` when a host's
  `initialState.doc.pages` override doesn't include the default `activePageId`'s key — silently breaks "Add
  widget" with no warning (`factories.ts:258-266`).
- **2.3** Date-range doc transforms (`setDashboardDateRange`, `setWidgetDateRange`, `setDashboardDateRangeAll` in
  `docTransforms.ts`) violate the module's own documented identity-preservation contract — a clear-when-already-clear
  allocates a fresh array and commits an undoable no-op, clearing the redo stack. The preset transforms
  (`deleteFilterPreset`, `renameFilterPreset`) honor the contract; these three don't.
- **2.4** `updateState` (`StudioController.ts:561-572`) is the one commit path that doesn't spread `...state`,
  dropping the `__cacheKey__` reselect-memoization tag and skipping any no-op guard — a content-identical patch
  is still an undoable, redo-clearing commit.
- **2.5** `crossFilterMode` is honored only by bar/line/pie/scatter; heatmap/funnel/sankey/gantt/gauge always
  aggregate `ctx.filteredRows` regardless of mode, so a `'none'`-mode gauge/funnel still reacts to sibling
  cross-filters (same lines as finding 1.9).
- **2.6** Pivot widget ignores `crossFilterMode` entirely — no grand-total mode, no cross-highlight ghost, unlike
  every sibling widget kind; a measure-expression `pivotValueField` also silently reads `undefined` (no
  `evaluateMeasure` path) (`StudioPivotWidget.tsx:35-46`).
- **2.7** Blended mixed charts drop the widget rank filter (`useChartWidgetData.ts:247-283` lacks the
  `applyRankToMultiSeries` call `multiYData` has) and compute a dead ghost aggregation nothing consumes.
- **2.8** Fixed-period KPI trend breaks when `kpiSparklineSourceId` points at a related source: `fixedDateField`
  is read directly off `currentRows`, which never has that field in the cross-source case
  (`StudioKpiWidget.tsx:741-744`).
- **2.9** Adapter-backed grid CSV export is always empty — `runWidgetExport` only reads in-memory `source.rows`,
  never fetched adapter rows, with no guard/message (`widgetExport.ts:50-68`).
- **2.10** Grid CSV export drifts from on-screen rendering for expression-field columns: header/format resolved
  via `expressionFields` on screen but `buildCsvContent`'s `fieldMap` is `dataSource.fields` only
  (`widgetUtils.tsx:518`).
- **2.11** Map value-field lookup ignores expression fields and cross-source fields, unlike the enrichment
  `useWidgetRows.ts` already performs for the same field — tooltip/legend lose format/currency/precision
  (`StudioMapWidget.tsx:143-146`).
- **2.12** `FilterValueInput`'s 150ms debounce timer is never cancelled on unmount/mode-change — a mode switch
  within the debounce window lets a stale commit land on the new mode's value shape.
- **2.13** `ChartSetupPanel`'s "unsupported configuration" alert (`getChartSupportMessage`) is hardcoded English
  while the canvas renderer's equivalent message for the same reasons is fully localized via existing
  `chartUnsupported*` locale keys.
- **2.14** `removeExpressionField` has no reference-check/cleanup — deleting a calculated field silently strands
  every widget/expression/filter that uses it, with no confirmation (`StudioController.ts:778-791`).
- **2.15** `useFieldValues` ignores the filter's own `filterSourceId` (cross-source id collisions pollute the
  value list) and is unbounded — `SelectionFilterInput` renders every distinct value as an unvirtualized
  checkbox row.
- **2.16** Edit-dialog `FilterRow` renders an invalid stored `operator` raw with no fallback, unlike the drawer
  rows which both fall back and self-repair (`FilterRow.tsx:203`).
- **2.17** Heatmap/funnel violate the package-wide `count`/coercion aggregation policy: heatmap skips
  null-measure rows _before_ counting (undercounts a `count` heatmap) and uses raw `Number(...)` instead of
  `coerceAggregateValue`; funnel has the same raw-`Number` issue.
- **2.18** `enrichedRowsCache`'s dependency collection only checks _top-level_ `isJoinFieldExpression`, missing
  nested join expressions inside e.g. an `if(...)` — causes both a slow per-row linear-scan fallback and a stale
  cache (the foreign source's rows aren't tracked as a dependency).
- **2.19** `createSimpleAdapter` doesn't do any of what `ARCHITECTURE.md` says both adapters do (translate
  filter nodes, resolve relative dates, handle count/count_distinct) — it POSTs the raw descriptor unmodified.
  Doc is wrong, or the adapter is missing the same safeguards the batching adapter has.
- **2.20** Cross-endpoint enrichment in the batching adapter keys/probes joins by raw field value, bypassing
  the shared `normalizeJoinKey` policy — a numeric FK against a string PK silently fails to enrich.
- **2.21** Relative-date filters are cached forever (no time dependency in the cache fingerprint) while preset
  filters get a fresh fingerprint daily — a long-lived dashboard crossing midnight serves a stale relative-date
  window.
- **2.22** `equals`/`not_equals` on a `datetime` field compares full ISO strings (exact-midnight only), contradicting
  `ARCHITECTURE.md`'s claim that in-memory equality matches the whole day against a DATETIME column.
- **2.23** `count_distinct` counts null/undefined as a distinct value in the KPI path but not in grid
  summary/grouping, and coerces non-numeric values to 0 in the measure-expression path — three different
  answers for the same aggregation over the same data, contradicting the documented "KPI over a raw field and a
  measure expression return the same number" invariant.
- **2.24** Date-range preset month arithmetic (`setMonth`/`setFullYear` without clamping the day first) overflows
  on month-end days (e.g. "last 3 months" from May 31 lands on Mar 3, not end-of-Feb).
- **2.25** Numeric `between` truthiness-checks its bounds, so a genuine `0` bound is treated as absent (admits
  values outside the intended range, or marks the condition incomplete) — same issue the batching adapter
  deliberately mirrors, so both need fixing together.
- **2.26** Inactive (kept-alive, clip-path-hidden) pages remain keyboard-focusable; a hidden `RowResizeHandle`'s
  keyboard path writes span commits onto the _active_ page using the hidden page's widget ids.
- **2.27** Canvas geometry (`RowResizeHandle`, grid-line overlay) has no RTL support anywhere — drag/arrow-key
  math and overlay positioning would be wrong under an RTL theme.
- **2.28** Chat tool-card icon/label maps have drifted from the AI tool registry: `list_pages` (in the registry)
  is missing from the maps and renders unlabeled; `get_current_date` (in the maps + locale bundles) isn't in the
  registry at all.
- **2.29** `StudioChatPanelProps.initialPrompt`'s JSDoc claims auto-submit on mount; only `pendingMessage`
  actually auto-submits — `initialPrompt` only pre-fills the composer.

## Tier 3 — minor / cosmetic

- Hardcoded English strings not routed through `localeText` in several places: chart "(filtered out)"/"X / Y"
  ghost tooltip text, Gantt "Duration:" label, expand-dialog fallback title "Chart"; `StudioWidgetEditDialog`'s
  "{kind} preview" suffix; `StudioExpressionFieldDialog`'s "Expression" heading;
  `GridConditionalFormatSection`'s `placeholder="value"`; `ColorInput`'s aria-label suffix; AI request
  error strings in `createWidgetFromDescription`/`useTextWidgetAI`; the chat panel's `displayName: 'You'`.
- `duplicateWidget`'s "(copy)" title suffix is transient — the next auto-title inference silently drops it for
  auto-titled widgets.
- `StudioDashboard`'s prop docs claim `serializeState()`'s output is an acceptable `config` value; it isn't
  (wrong shape, would throw on load).
- `carryTransientDocState` can assign `activePageId: undefined` in the zero-pages edge case (reducer instead
  uses `''`).
- Session serialization strips cross-filter entries from every undo/redo history snapshot, so a redo of an
  "apply cross-filter" step consumes a step and visibly does nothing after a session restore.
- `commitDocPatch({})` isn't guarded as a no-op (latent — no current caller passes an empty patch).
- Handful of accessibility gaps: `TabbedSidebar`'s tablist doesn't implement roving-tabindex/arrow-key nav per
  APG; `StudioDateRangeBar` uses a hardcoded (collision-prone) DOM id instead of `useId()`; `ChartSvg` icon
  wrapper missing `aria-hidden` (siblings have it).
- Closing the overlay chat panel mid-stream (`unmountOnExit`) silently truncates the in-flight response, the
  same class of bug the thread-switch path was already fixed for.
- Rank-by-field totals and the numeric-rank comparator use raw `Number(...)` instead of `coerceAggregateValue`.
- Forecast lower confidence band clamps at 0 unconditionally, wrong for metrics that can go negative.
- Mixed-format date columns only infer normalization format from the first non-null sample value.
- `GridSetupPanel`'s per-column aggregation maps are keyed by bare `fieldId`, colliding across sources when a
  related-source column's id matches a primary column's id.
- `GridConditionalFormatSection` doesn't reset operator/value when the rule's field type changes (contrast
  `FilterRow`, which does).
- `DateValueInput` only parses string date values, not numeric timestamps or `Date` objects.
- `isFilterEffective` treats an empty `{from: '', to: ''}` between-filter as "effective".

## Test-coverage gaps worth closing

- No test exercises the populated→empty→populated canvas transition for either the drop target or the resize
  observer (findings 1.4/2.2 twins).
- No test asserts `privateMode: true` payload shape for `createWidgetFromDescription` or `useTextWidgetAI`
  (would have caught 1.1).
- No test pins `setDataSourceAdapter` idempotency/cache-invalidation behavior (1.2).
- No test covers a cross-source extra-dimension field for heatmap/funnel/sankey/gantt end-to-end (1.9).
- No test edits a measure's expression and asserts the KPI headline/sparkline update (1.10).
- The existing cross-source grid-column test bypasses the production column-def path via `slotProps` — a test
  using only `config.columns` would have caught 1.11.
- No timezone-parameterized test around the KPI trend's ISO-string window boundary (1.12).
- No test covers `operator2`/`value2`'s between-shape interaction (1.15).
- No test asserts `STUDIO_TOOL_LABEL_KEYS` parity against the AI tool registry (2.28).
- No test pins multi-instance Studio keyboard-shortcut scoping (1.3).

## Explicitly checked and confirmed sound (not findings)

Reducer no-op contracts and `Object.hasOwn` transform guards; undo/redo transient carry (interactive filters,
cross-filter toggles, `activePageId`, `doc.ai`); `MAX_UNDO_HISTORY` capping; `StudioRequestCache` generation
tagging (closes in-flight write-back and join-stale-promise holes); `useChatThreads`' synchronous
read-before-write pattern; per-instance selector memoization; buffer-then-commit-on-blur pattern (verified
correctly implemented across Gauge, sliders, radii, funnel gap, min-angle, annotations, conditional formats,
ColorInput, grid height); source-switch undo folding (correct in Chart/KPI/Grid/Filter/Map/Pivot — Gauge's gap
is filter-removal only, finding 1.16); non-undoable self-repair effects; `WidgetFilterRow` delta-only commits;
interactive-filter clear routing; the SQL-injection-adjacent adapter safeguards (OR groups, empty `in`,
single-bound `between`, case-sensitivity, COUNT(\*)); drag-flag leak paths; stream-settlement once-guards;
`applyStateMutation` trust boundary; `sanitizeServerWidgetConfig`; locale bundle parity (spot-checked all
parameterized functions across fr/de/es/ptBR).
