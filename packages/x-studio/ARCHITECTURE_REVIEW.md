# Architecture review — fresh pass (2026-07-10)

Full clean-slate review of `packages/x-studio` source (state/controller, pipeline L1–L4, all 7 widget kinds, cross-filtering, setup panels, filters drawer/widget, AI/chat, server adapters, CSV export). Every finding below was verified against the current source, and for each bug pattern the whole package was swept for sibling sites.

**Summary: 6 Tier 1 · 12 Tier 2 · 15 Tier 3.**

Recurring themes (the general invariants violated, each shows up in several findings):

- **T-A — Emitted-filter fidelity**: a widget that _emits_ a filter (cross-filter/interactive) must emit a `(field, value, filterSourceId, fieldType)` tuple that `resolveRows`/`compileRowTest` can actually evaluate against the _owning_ source's normalized rows. Chart and Map got owner-aware fixes; Grid and one chart click path did not (1.1, 1.2).
- **T-B — `selectFiltersForWidget` is the single scoping authority**: any hand-rolled `scope.kind` match without pageId/disabled/source checks diverges from what the engine applies (2.3; previously fixed at the KPI's other call sites).
- **T-C — Widget-kind capability expansions outgrow their gates**: rank filters and cross-filter emission were extended to more widget kinds, but chart-only/chart+grid-only gates remain in selectors, renderers, and panels (2.2, 3.8, and the `ySeries` precedence family).
- **T-D — Adapter translation must warn-or-degrade, never silently drop or mistranslate** (1.5, 2.5, 2.6, 2.7, 3.6).
- **T-E — Date-only bounds vs `datetime` columns**: the preset path resolves end bounds to end-of-day; user-authored bounds do not (1.3).

---

## Tier 1

### 1.1 Grid cross-filter emission mis-attributes the field's owning source (and has no leaf-row guard)

- **Files:** `src/components/widgets/StudioGridWidget/StudioGridWidget.tsx:718-744` (`handleCellClick`; emission at `:740` — `applyCrossFilter(widget.id, fieldId, value, widget.sourceId)`).
- **Invariant (T-A):** the emitted `filterSourceId` must be the source that _owns_ the clicked field. Chart derives it via `chartSupport.fieldOwners` (`StudioChartWidget.tsx:404`), Map via `config.mapCountrySourceId ?? widget.sourceId` (`StudioMapWidget.tsx:579`), the filter widget only offers own-source fields (`StudioFilterWidget.tsx:236`). The grid passes `widget.sourceId` unconditionally, although `config.columns` entries carry a per-column `sourceId` and cross-source columns are first-class (rendered, clickable, exported).
- **Failure scenario:** an `orders` grid with a configured cross-source column `customers.segment`. Clicking a segment cell emits `{field: 'segment', filterSourceId: 'orders'}`. In `dataSourceGraph.resolveRows`, every same-source target widget treats it as a _native_ filter (`filterSourceId === widgetSourceId`), evaluates `row['segment']` — which is `undefined` at L3 (cross-source display columns are enriched only _after_ filtering, per-widget, via `enrichIfNeeded`) — and drops every row. Widgets on other sources semi-join against `orders` rows that also lack `segment` → zero matches. One click blanks (cross-filter mode) or fully dims (cross-highlight mode) the dashboard. The explicit-`filterSourceId` also defeats `resolveRows`' expression-owner rerouting (`dataSourceGraph.ts:244-257`, which only fires when `filterSourceId` is unset), so a related-source _calculated_ column is equally broken.
- **Secondary scenario (same handler):** with `gridGroupByField` set, DataGridPremium renders a grouping column; clicking a group cell emits a filter on the internal grouping field (`__row_group_by_columns_group__`) — a field no source has — with the same blank-the-dashboard result. Only `params.id === '__summary__'` is guarded.
- **Sibling sites:** chart/map/filter-widget emissions are all correct (swept every `applyCrossFilter`/`applyInteractiveFilter` caller); this is the one divergent emitter. (Chart has its own, different emission bug — see 1.2.)
- **Fix direction:** resolve the clicked field's owner: `config.columns?.find((c) => c.fieldId === fieldId)?.sourceId ?? exprOwner?.sourceId ?? widget.sourceId`, and skip non-leaf rows (`params.rowNode.type !== 'leaf'`). Also pass `fieldType` for date columns (mirrors chart's period path).

### 1.2 Un-grouped temporal line/area axis click emits a cross-filter that matches zero rows

- **Files:** `src/components/widgets/StudioChartWidget/StudioChartWidget.tsx:439` (`filterValue = label instanceof Date ? label.toISOString() : label`), emission at `:456`/`:484`/`:486` (no `fieldType` passed); reached from `StudioLineAreaChart.tsx` `onAxisClick` (all three line/area paths — `:305`, `:430`, `:595`).
- **Invariant (T-A).** With `xField` of type `date` and Group By = **None** (a first-class setup-panel option), the line/area x-axis is `scaleType: 'utc'`, so `onAxisClick` delivers a `Date`. The `Date → period key` handling exists only inside the `xGroupBy` branch (`:406-436`); without `xGroupBy` the code emits `label.toISOString()` (`'2024-01-15T00:00:00.000Z'`) as an `equals` filter with **no `fieldType`**. `compileSingleCondition` (`internals/filterUtils.ts:176-194`) only day-normalizes date equality when `fieldType` is set; otherwise it does loose `row[field] == filterVal`, and L1-normalized `date` cells are `'2024-01-15'` → never equal.
- **Failure scenario:** click a point/axis label on an un-grouped daily line chart → every same-source widget filters to zero rows (blank in `'filter'` mode, all-ghost in `'cross-highlight'`), while the source chart's own selection highlight doesn't even light up (`getSelectedDataIndices` compares day-truncated labels against the full ISO string). Shift-click multi-select (`'in'`, loose `==` at `filterUtils.ts:200`) fails identically.
- **Sibling sites:** bar (band axis → string labels), pie slice clicks, grid/map emissions don't produce `Date` values; the grouped (`xGroupBy`) chart path correctly emits `between` + `fieldType: 'date'`. This is the only `Date`-valued emission path.
- **Fix direction:** when `label instanceof Date` outside the `xGroupBy` branch, emit the day key (`toISOString().slice(0, 10)`) and pass `fieldType: 'date'` (or route through the existing period→`between` machinery with `'day'` granularity).

### 1.3 Date-only upper bounds on `datetime` columns silently exclude the entire last day

- **Files:** `src/internals/filterUtils.ts:272-356` (`greater_than`/`less_than`/`*_or_equal`/`between` datetime branches — `toComparable(dateOnlyString, 'datetime')` → full-ISO midnight, `temporalUtils.ts:106-119`); authored from `src/components/widgets/StudioFilterWidget/StudioFilterWidget.tsx:240-249` (date-range control) and `:335-348` (date slider), `src/components/StudioFiltersDrawer/FilterValueInput.tsx:140-173` + `DateValueInput.tsx` (drawer `between` and single-sided ops), `src/components/StudioWidgetEditDialog/FilterRow.tsx` (between bounds).
- **Invariant (T-E):** the codebase already encodes the intended semantics — `resolveDateRangePreset` appends `T23:59:59` to a datetime preset's end bound (`filterUtils.ts:32`), and `equals`/`not_equals` compare at day granularity (`toDayComparable`, `:181-191`). But a _user-authored_ date-only bound (`'2026-07-10'`) against a datetime column compiles to `<= '2026-07-10T00:00:00.000Z'`, excluding everything after midnight of the last day.
- **Failure scenario:** a date-range filter widget on a `datetime` column with To = Jul 10 drops all Jul 10 rows; drawer "at or before Jul 10" (labelled inclusively) excludes essentially all of Jul 10 — while "At Jul 10" (`equals`) on the same column matches the whole day. A row can _equal_ Jul 10 yet not be _at-or-before_ Jul 10.
- **Secondary (same area):** the preset path itself mixes timezone semantics: `from: 'YYYY-MM-DD'` parses as UTC midnight while `to: 'YYYY-MM-DDT23:59:59'` parses as _local_ time (ES spec date-only vs date-time forms), so in non-UTC zones the two ends of one preset window use different zones.
- **Sibling sites:** all listed authoring surfaces share the one compile path, so one fix covers them. The batching adapter deliberately push-downs date bounds with a `warnAdapterDivergence` about exactly this class (`createBatchingAdapter.ts:1289-1313`) — the in-memory evaluator has the same flaw un-warned.
- **Fix direction:** in `compileSingleCondition`'s datetime branches, when the filter-side value is a bare `YYYY-MM-DD`, compare at day granularity (`toDayComparable` both sides; `>=`/`<=`/`between`-to inclusive of the day, `>`/`<` exclusive), or normalize upper bounds to end-of-day the way the preset path does.

### 1.4 `privateMode` leak: "Explain anomalies" embeds real data values in the outgoing prompt

- **Files:** `src/components/StudioWidgetCard/widgetInsightPrompts.ts:32-44` (`buildAnomalyExplainPrompt` interpolates `JSON.stringify(annotation.value)` — actual x-axis data values of the anomalous points); `src/components/StudioWidgetCard/useStudioWidgetInsights.ts:64-72` (`handleAnomalyExplain`, no `privateMode` awareness); delivered via `StudioContent.tsx:141-145` → chat `pendingMessage` → `studioBackendAdapter.sendMessage` (message text is always sent).
- **Invariant:** with `aiConfig.privateMode: true`, no real row values may be computed into any outgoing request — enforced client-side in every other builder (`studioBackendAdapter.ts` pageSnapshot/dashboardState/richContext, `createWidgetFromDescription.ts` cardinality/aiDescription, `useTextWidgetAI.ts` snapshot/state).
- **Failure scenario:** private mode on; user enables anomaly detection on a chart whose x-field is e.g. customer name or region, clicks "Explain anomalies" → the literal values are baked into the auto-submitted user message and reach the LLM provider.
- **Sibling sites:** `buildInsightPrompt` sends only the widget title (fine); `chatSuggestions.ts` embeds field/source _labels_ only (consistent with the documented schema-allowed policy). This is the sole row-value leak path.
- **Fix direction:** thread `aiConfig.privateMode` into `useStudioWidgetInsights`; under private mode omit the per-annotation value lines (or disable the action).

### 1.5 Batching adapter sends a second-condition `between` value as `{from,to}` — the middleware rejects the whole widget query

- **Files:** `src/server/createBatchingAdapter.ts:1320-1344` (`leafToPredicates`: the `{from,to}` → `[lo,hi]` tuple conversion at `:1325-1333` runs only for the FIRST condition; the `op2`/`value2` predicate at `:1336-1342` pushes `value2` raw); `:1251-1273` (`isLeafServerTranslatable` accepts `op2: 'between'` — `isFullyBoundedBetween` at `:1209-1222` accepts the `{from,to}` object shape — so the leaf is classified server-translatable rather than falling back to the client residual).
- **Invariant (T-D).**
- **Failure scenario:** drawer filter "amount > 0 AND amount between 10–20" (`SecondCondition.tsx` manages exactly this `operator2: 'between'` shape) on a batching-adapter source → wire predicate `{operator: 'between', value: {from: 10, to: 20}}` → `x-studio-data-middleware` throws for non-array between values → the batch entry errors and the widget shows an error state instead of rows.
- **Sibling sites:** the first-condition path and `resolveRelativeDate` handling are correct; no other emitter of wire `between` values exists.
- **Fix direction:** factor the object→tuple conversion out of the first-predicate branch and apply it to the `op2` predicate too.

### 1.6 A gantt chart created from scratch can never acquire a data source from its own setup panel

- **Files:** `src/components/StudioComposeDrawer/ChartSetupPanel/GanttFieldsSection.tsx:29-67` (all four pickers call `updateWidgetConfig` only and discard the `sourceId` the `DataSourceFieldSelect` `onChange` supplies); `ChartSetupPanel.tsx:487` (`!isGauge && !isGantt` hides the X-field picker — the panel's ONLY source-adopting control — for gantt); `internals/chartSupport.ts:241-243` (`analyzeChartSupport` returns `{supported: true}` when `widgetSourceId` is undefined, so no warning renders either).
- **Invariant:** every field-picking gesture on a source-less widget must adopt the picked field's source in the same commit (the documented "source-switch undo folding" contract). Gauge has its own adoption (`GaugeConfigSection`), every other chart family adopts via the X-field pick; gantt has neither, and `ChartSetupPanel` has no standalone source picker.
- **Failure scenario:** add a Chart widget (created with `sourceId: undefined`), switch type to Gantt, fill Label/Start/End — the widget's `sourceId` stays undefined, `useWidgetRows` gets `dataSource === undefined`, and the fully-configured widget renders permanently blank with no panel warning.
- **Sibling sites:** ChartSetupPanel X-field (`:498-530`), `GaugeConfigSection:97-130`, `KpiSetupPanel:310-353`, `MapSetupPanel`, `FilterSetupPanel:162-181`, `PivotSetupPanel` all adopt. GanttFieldsSection is the one section with cross-panel field pickers and no adoption.
- **Fix direction:** in each gantt picker's `onChange`, when `sourceId && sourceId !== widget.sourceId`, fold `{ sourceId, config: {...} }` into one `updateWidget` (with `collectStaleWidgetFilterIds` like the X-field path).

---

## Tier 2

### 2.1 KPI filter-based trend computes the previous period from `dataSource.rows` — wrong/∞ deltas on adapter-backed sources

- **Files:** `src/components/widgets/StudioKpiWidget/StudioKpiWidget.tsx:297-333` (`computeFilterBasedTrend` builds `preEnrichedRows` from `dataSource.rows ?? []` and calls `resolveRows` directly).
- **Invariant:** every row baseline a widget renders or derives numbers from must come from the same data path (`useWidgetRows` sync/adapter branches). The headline value uses adapter-fetched rows; the previous-period side of the trend re-reads the in-memory `rows` field, which for adapter sources is empty or a stale preview (`setDataSourceRows`).
- **Failure scenario:** adapter-backed KPI with a page date filter and `kpiTrend` on: current value comes from server rows, previous value computes over `[]` → `previousValue = 0` → the badge shows a bogus ∞ ("new") delta; with stale preview rows it shows an arbitrary number.
- **Sibling sites:** the fixed-period trend and the sparkline correctly use `currentRows` (adapter-aware); `computeFilterBasedTrend` is the only widget-data consumer in the package still reading `dataSource.rows` directly (swept `dataSource.rows`/`source.rows` — the other hits are data-drawer previews, expression preview, and AI snapshot builders where in-memory rows are intended).
- **Fix direction:** either gate the filter-based trend on `!dataSource.adapter` (show no badge instead of a wrong one), or window `currentRows`' superset via a second descriptor fetch; minimally, document/return null when `dataSource.adapter` is set and `dataSource.rows` is empty.

### 2.2 Heatmap and funnel take the measure field from `ySeries[0].fieldId` but ignore `ySeries[0].yAggregation`

- **Files:** `src/components/widgets/StudioChartWidget/chartTypeDefs.tsx:421,434` (renderHeatmap: `heatValueField = config.yField ?? config.ySeries?.[0]?.fieldId` but `heatAggregation = config.yAggregation ?? 'sum'`), `:488,543/553` (renderFunnel, same split); mirrored server-side in `src/internals/chartTypeRegistry.ts:168-170` (heatmap) and `:197-199` (funnel).
- **Invariant (T-C):** the per-series aggregation precedence `ySeries[i].yAggregation ?? config.yAggregation` was fixed for single-series (`useChartWidgetData.ts` `singleSeriesYAggregation`), multi-Y, split-by, blended, and pie rings — heatmap/funnel adopted only the fieldId half of the fallback.
- **Failure scenario:** a bar/mixed chart whose measure carries `ySeries[0].yAggregation: 'avg'` is switched to heatmap or funnel (config-key retention across type switches is a documented feature): the value field survives via the `ySeries[0].fieldId` fallback, but the aggregation silently degrades to `sum` — on both the in-memory and the adapter push-down path (client and server at least agree with each other).
- **Sibling sites:** sankey is documented sum-only (fine); gauge reads only `config.yField`/`config.yAggregation` with no `ySeries` fallback anywhere (internally consistent). Fix must touch `chartTypeDefs.tsx` and `chartTypeRegistry.ts` together to keep client/server parity.
- **Fix direction:** `config.ySeries?.[0]?.yAggregation ?? config.yAggregation ?? 'sum'` wherever the `ySeries[0].fieldId` fallback is used.

### 2.3 KPI date-filter-derived UI bypasses `selectFiltersForWidget` (auto subtitle + sparkline options panel)

- **Files:** `src/internals/widgetUtils.tsx:339-358` (`inferKpiDateSubtitle` — raw `scope.kind` match: no `pageId`, no `disabled`, no `dashboard-date-range` `sourceId`, no `filterSourceId` check; takes `relevant[0]`); consumers `src/components/StudioWidgetCard/StudioWidgetCard.tsx:205` and `src/components/StudioComposeDrawer/FormatPanel.tsx:128` (both pass the raw `allFilters` array). Same pattern in `src/components/StudioComposeDrawer/KpiSparklineOptions.tsx:95-112` (`autoDateFilter` — no `pageId`/`disabled` check, and no native-source check mirroring the renderer's `dateFilterIsNative`).
- **Invariant (T-B):** the KPI's trend, sparkline, and hover filter-summary were all explicitly fixed to route through `selectFiltersForWidget`; these two remaining consumers of the same "find the KPI's date filter" derivation were missed.
- **Failure scenarios:** (a) multi-page dashboard, page A "Last 12 months", page B "This month": a KPI on page B can render the auto subtitle "Last 12 months" (whichever filter comes first in `doc.filters`) while its value is computed under "This month"; a _disabled_ date filter or a different source's dashboard-date-range also drives the subtitle. (b) `KpiSparklineOptions` shows "using date filter X" and _hides the time-field picker_ based on another page's / a disabled / a cross-source date filter that the renderer (correctly) ignores — sparkline enabled, nothing renders, and the control needed to fix it is hidden.
- **Sibling sites:** swept every raw `scope.kind === 'page'|'dashboard-date-range'` match: `kpiUtils.findDateFilter` is fed pre-scoped lists (fine), `StudioQuickFilterBar`/`StudioFiltersDrawer`/`docTransforms`/`selectors.partitionFilters` all check `pageId` (fine). These two are the remaining violators.
- **Fix direction:** scope through `selectFiltersForWidget` (with the widget's page id and `crossFilterAllPages`) before `findDateFilter`-style matching; add the renderer's `!f.filterSourceId || f.filterSourceId === widget.sourceId` check in `KpiSparklineOptions`.

### 2.4 Filters drawer exposes the managed `widget-date-range-*` filter; edits to it are silently discarded

- **Files:** `src/components/StudioFiltersDrawer/StudioFiltersDrawer.tsx:199-201` (`widgetFilters` selects every `scope.kind === 'widget'` filter); contrast `src/components/StudioWidgetEditDialog/WidgetFiltersPanel.tsx:82` (excludes `f.dateRangePreset !== undefined`) and `StudioController.setWidgetDateRange`'s doc ("managed exclusively via the KPI setup panel… the filters drawer hides it").
- **Failure scenario:** give a KPI a "YTD" range in its setup panel, then select the KPI with the filters drawer open: a phantom "Between" card appears (value `null` → renders as incomplete). Editing its from/to dates commits `value: {from,to}` but leaves `dateRangePreset: 'ytd'`, and `resolveDateRangePreset` recomputes `value` from the preset at query time — the edit visibly does nothing. The card's remove button deletes a filter the KPI panel believes it owns.
- **Fix direction:** add `&& f.dateRangePreset === undefined` to the drawer's `widgetFilters` predicate, mirroring `WidgetFiltersPanel`.

### 2.5 Relationship-aware batching adapter silently drops filters on unresolved fields

- **Files:** `src/server/createBatchingAdapter.ts:1084-1086` (`if (r.unresolved) { return []; }` in the server-predicate flatMap — no `warnAdapterDivergence`, no client residual).
- **Invariant (T-D):** every other unfaithful-translation path in the module warns (the `r.skip` computed-field branch directly above it at `:1069-1082`, dropped OR groups, count/count_distinct/avg downgrades, aggregated residuals).
- **Failure scenario:** a filter on a field 2+ relationship hops away (the module's own example: `orders.date` filtering a `products` widget) is dropped with no trace — the widget silently shows _more_ rows than the identical dashboard on an in-memory source.
- **Fix direction:** add the `warnAdapterDivergence` call mirroring the `skip` branch's message (the drop itself is documented as intentional; the silence is the bug).

### 2.6 Simple-mode batching adapter pushes expression-field filters to the server as WHERE/SELECT on nonexistent columns

- **Files:** `src/server/createBatchingAdapter.ts:865-949` (simple-mode branch): server predicates sent with `column: leaf.field` unresolved (`:941` via `partitionFilterNode` at `:909`), and the client-residual projection callback (`:917-922`) unconditionally accepts and SELECTs `leaf.field`.
- **Invariant (T-D).** Relationship-aware mode handles both via `resolve()` → skip+warn and the `isPlainPrimaryField` check (`:1104-1116`); `expandToNativeFields` expands only the _select_ list, never the filter tree (`queryDescriptor.ts:272-277`), so filter leaves keep expression ids. The simple-mode `groupByIsExpressionField` guard (`:930-933`) proves this configuration is considered supported and `expressionFields` is available.
- **Failure scenario:** simple-mode adapter + any translatable filter (e.g. `equals`) on a calculated column → `WHERE "expr-…" = …` → "no such column" → the whole batch entry errors; a client-residual operator (e.g. `contains`) on the same column puts `expr-…` into SELECT with the same result.
- **Fix direction:** in simple mode, route own-source expression-field leaves to the warn machinery (drop or client-side residual on the re-enriched rows) and make the projection callback reject expression ids.

### 2.7 `createSimpleAdapter` reproduces the fixed cross-filter-vs-server-aggregation bug (2.9-class) verbatim

- **Files:** `src/server/createSimpleAdapter.ts:98-126` (descriptor POSTed as-is; no handling of `hasIncomingCrossOrInteractiveFilters`, which its documented server contract at `:13-16` doesn't even mention).
- **Invariant (T-D):** the batching adapter strips server aggregations when the descriptor flags an incoming cross/interactive filter (`createBatchingAdapter.ts:879-886`), because those filters are enforced client-side over returned rows and an aggregated response has no cross-filter columns → every row reads `undefined` → the widget empties.
- **Failure scenario:** a host faithfully implementing the documented contract with `aggregations` support + a chart-click cross-filter targeting a simple-adapter widget → widget goes blank.
- **Fix direction:** mirror the batching adapter — when `descriptor.hasIncomingCrossOrInteractiveFilters && descriptor.aggregations?.length`, strip `aggregations` (dev-warn) before POSTing.

### 2.8 Cascading option narrowing inverts `not_in` parent selections

- **Files:** `src/components/StudioFiltersDrawer/useFieldValues.ts:19-24` (`applyParentFilters`' selection branch ignores `operator` and always filters TO the selected set).
- **Failure scenario:** a `not_in` selection filter (first-class in `compileRowTest` `filterUtils.ts:148-150`, authorable by the AI middleware and hosts) as a `dependsOn` parent → the dependent filter's option list is narrowed to _exactly the excluded values_ — the inverse of the surviving rows. Unlike the deliberately-skipped condition operators (which fall through to no narrowing), this branch actively computes the wrong set.
- **Fix direction:** honor `f.operator === 'not_in'` with the complement test.

### 2.9 ChartSetupPanel ignores `ySeries[].sourceId` (blended series): spurious "unsupported" warnings and stale-source series on edit

- **Files:** `src/components/StudioComposeDrawer/ChartSetupPanel/ChartSetupPanel.tsx:224-236` (support memo feeds ALL `ySeries` fieldIds — including foreign-source blended series — into `analyzeChartSupport`, while the renderer excludes them first, `useChartWidgetData.ts:191-208`); `:311-318`+`:324-326` (`commitYSeries`/`handleSeriesFieldChange` do `{ ...s, fieldId }`, preserving a stale foreign `sourceId` and writing `yField: next[0]?.fieldId` even when series 0 is foreign; the `onChange`'s supplied `sourceId` is discarded).
- **Invariant:** the setup panel must validate the same field set the renderer validates (the panel/canvas-parity contract this panel already implements for scatter/extra fields).
- **Failure scenario:** (a) open an AI/host-authored blended mixed chart in the panel → the panel resolves the foreign series field against the widget's own source and shows the "unsupported" warning + disables valid options while the canvas renders fine. (b) re-point such a series at an own-source field via the picker → `sourceId` stays foreign → the renderer aggregates the new field against the OLD foreign source's rows → silent all-zero series.
- **Fix direction:** exclude `s.sourceId && s.sourceId !== widget.sourceId` series from the panel's support check (mirroring the renderer), and have `handleSeriesFieldChange` set/clear `sourceId` from the picked field's source.

### 2.10 FilterSetupPanel source switch skips stale-widget-filter cleanup

- **Files:** `src/components/StudioComposeDrawer/FilterSetupPanel.tsx:162-181` (adopt branch at `:172-176` folds `sourceId`+config into one `updateWidget` but passes no `removeFilterIds`).
- **Invariant:** the documented source-switch contract — Chart (`ChartSetupPanel.tsx:515-531`), Gauge (`GaugeConfigSection:111-126`), KPI (`KpiSetupPanel:274-289, 335-350`), Grid (`GridSetupPanel:339-382`) all pass `collectStaleWidgetFilterIds(...)`. Filter widgets support widget-scoped filters (`builtinWidgetDefs.ts` `widgetFilters: true`), so the cleanup applies to them too.
- **Failure scenario:** re-point a filter widget's field at another source → widget filters authored against the old source persist in the doc (serialized), render as broken raw-id rows in the edit dialog's Filters tab. (Data impact is limited — the filter widget's option list reads raw source rows — but it violates the contract and leaves permanent doc garbage.)
- **Sibling sites:** MapSetupPanel/PivotSetupPanel adopt only from `sourceId === undefined` (no pre-existing filters possible via UI) — harmless, but the same fold would be cheap defense.
- **Fix direction:** pass `removeFilterIds: collectStaleWidgetFilterIds(allFilters, widgetId, newSourceId, fieldCatalog, relationships)` on the adopt branch.

### 2.11 RelationshipDialog never validates junction distinctness; source/target edits leave a stale junction

- **Files:** `src/components/StudioDataDrawer/RelationshipDialog.tsx:66-73` (`isValid` checks only that the junction trio is non-empty), `:114-117`/`:157-160` (source/target `onChange` clears its own field but never resets `junctionSourceId`/`junction*Field`; the junction Select merely _omits_ the endpoints from its options at `:205-215`, leaving a stale out-of-range value in form state).
- **Failure scenario:** edit A↔B-via-C, change Source to C → the junction Select renders blank (out-of-range) but `form.junctionSourceId === 'C' === sourceId` and Save stays enabled once a join field is re-picked → a committed relationship whose junction IS its own endpoint. All downstream M:N machinery (`chartSupport` junction anchoring, `grainResolution`, `findJoinPath`) assumes junction ≠ endpoints. `junctionSourceField === junctionTargetField` is also accepted (both selects list the same table's fields), mapping both sides of the join to one column.
- **Invariant:** the ARCHITECTURE notes incomplete/degenerate junction configs are supposed to be un-authorable via the dialog ("RelationshipDialog validates both junction fields before saving") — the distinctness half of that validation is missing.
- **Fix direction:** extend `isValid` with `junctionSourceId !== sourceId && junctionSourceId !== targetId` (and `junctionSourceField !== junctionTargetField`), and clear the junction trio in the source/target `onChange` on collision.

### 2.12 TextSetupPanel title commit omits `titleMode: 'manual'` — a deliberately cleared title resurrects

- **Files:** `src/components/StudioComposeDrawer/TextSetupPanel.tsx:38-42` (`handleTitleBlur` commits `{ title: form.title }` only); contrast `FormatPanel.tsx:146-155`, which stamps `titleMode: 'manual'` for exactly this reason.
- **Failure scenario:** clear a text widget's title (commits `title: ''` with no mode), then blur the body field (or toggle AI mode): `updateWidgetConfig`'s title-inference transform sees `!titleMode && !title` → auto → `inferWidgetTitles`' text case resurrects the default title, as an undoable side effect of an unrelated edit.
- **Fix direction:** stamp `titleMode: 'manual'` in `handleTitleBlur`, matching FormatPanel.

---

## Tier 3

### 3.1 KPI headline/sparkline field-def lookup misses related-source physical fields (formatting)

`StudioKpiWidget.tsx:531-543` (`useKpiValue`) and `:1082-1084` (sparkline `fieldDef`) resolve only `dataSource.fields` + expression fields. A grain-anchored KPI (value field owned by a related "many" source — a supported topology, reachable via AI/host `update_widget` since `KpiSetupPanel` re-sources on cross-source picks) loses `format`/`currencyCode`/`precision` and the boolean-avg→percent scaling. The map widget fixed exactly this class (`StudioMapWidget.tsx:201-226` checks `dataSources[valueSourceId]`); the grid resolves via `resolveCrossSourceFieldDefs`. Fix: fall back to the anchor source's fields (resolvable via `analyzeChartSupport`'s `fieldOwners`).

### 3.2 Funnel/sankey value-field defs (and heatmap axis labels) ignore expression fields

`chartTypeDefs.tsx:498` (funnel) and `:599` (sankey) use `dataSource?.fields.find(...)` while heatmap's value def uses `resolveFieldDef` (`:433`) — a calculated value field (offered by the panel) loses currency/precision formatting; heatmap's `xFieldDef`/`yFieldDef` at `:431-432` are native-only too (expression axis fields lose labels). Fix: `resolveFieldDef(fieldId, dataSource, ctx.expressionFields)` at all four sites.

### 3.3 StudioMixedChart never consults expression fields for series labels/formatters

`StudioMixedChart.tsx:96-99` and `:133-138` resolve per-series/axis field defs from physical fields only; `renderMixed` doesn't pass `ctx.expressionFields` down. Every sibling family (bar, line/area via `lineSeries.ts` — whose docstring documents this exact fix — pie, scatter) resolves through `resolveFieldDef`. A calculated mixed-chart measure renders a raw field id as its legend label and unformatted tooltip/axis values. Blended series need the foreign source's expression fields too.

### 3.4 Grouped-ring pie renders rings in first-seen row order

`StudioPieChart.tsx:216-219` — ring categories come from `[...new Set(baseRows.map(categoryKeyOf))]`, unsorted; the single-ring path sorts (`aggregateByField` → `sortLabels`). Temporal rings render in arbitrary chronological order, and the order can visibly swap when the baseline flips between `allEnrichedRows`/`enrichedRows` (cross-filter toggle). Fix: `sortLabels(categories)`.

### 3.5 Gantt time-domain uses `Math.min(...spread)` over per-row items

`StudioGanttChart.tsx:136-137` — spread over one entry per filtered row (the `maxRows` cap applies later) throws `RangeError` past ~125k rows, the exact crash class looped around in `internals/aggregate.ts`, `utils/gridGrouping.ts`, `gridSummary.ts`, and `generateInsight.ts`. Fix: reduce loop.

### 3.6 Shared simple-mode batch loader pins the creating adapter's `expressionFields`

`createBatchingAdapter.ts:288-294` — `createBatchFn` closes over `expressionFields` while the per-endpoint loader registry refreshes only `fetchFn`/`batchDelayMs` (the 3.14 fix). Recreating a simple-mode adapter after calculated columns were added leaves the `groupByIsExpressionField` guard (`:930-933`) evaluating against the stale list → `ORDER BY <expression-id>` → batch entry fails, the exact failure that guard exists to prevent. Fix: move `expressionFields` into the live registry config (like `fetchFn`).

### 3.7 One manual refresh permanently disables the text-widget AI cache for that mount

`useTextWidgetAI.ts:219-236` — the cache-read branch runs only when `refreshSeq === 0` and `refreshSeq` never resets on `cacheKey` change; after one refresh click, every later page/filter/prompt change refetches from the LLM even when a valid cache entry exists. Fix: track `{seq, forKey}` and reset when `cacheKey` changes.

### 3.8 Grid's outgoing-cross-filter lookup ignores the `disabled` flag

`StudioGridWidget.tsx:438-447` matches its active cross-filter without `!f.disabled`, unlike the shared `isActiveCrossFilter` (`context/selectors.ts:405-412`) chart/map use. A cross-filter disabled via the quick-filter-bar chip (`StudioQuickFilterBar.tsx:251` → `toggleFilter`) still row-highlights in the emitting grid, and clicking the same cell _clears_ the disabled filter instead of applying a fresh enabled one. Fix: reuse `makeSelectWidgetActiveCrossFilter`… after fixing 3.9's kind gate.

### 3.9 Widget-card chips lag behind widget-kind capability expansion (map cross-filter, non-chart rank)

`context/selectors.ts:580-591` — `makeSelectWidgetActiveCrossFilter` returns `null` unless `kind` is `chart`/`grid`, so a MAP's emitted cross-filter (`mapCrossFilterEmit`, `StudioMapWidget.tsx:596-602`) never shows the card chip with its onDelete clear affordance (`StudioWidgetCard.tsx:582-599`) — clearing requires re-clicking the region or the drawer. Sibling: `makeSelectWidgetRankFilter` (`selectors.ts:530-549`) is chart-only, but widget-scoped rank filters are now authorable and enforced for every kind (`includeWidgetRank`) — a grid/KPI/map/pivot Top-N shows no "Top N" chip. Invariant (T-C): kind gates in shared selectors must track capability expansions. Fix: derive "can emit"/"can rank" from the widget def/filter set rather than hardcoded kind lists.

### 3.10 Filters-drawer cross-filter section renders `[object Object]` for between/multi-select cross-filters

`CrossFilterSection.tsx:96` uses `String(filter.value)`; a period-click emits `{from,to}` and shift-click emits an array. `internals/crossFilterValueLabel.ts` exists precisely to format these (and its doc says bare `String()` casts must not be re-introduced). Fix: `formatCrossFilterValueLabel(filter.value)`.

### 3.11 Saved-view "active" chip can never match presets containing cascades

`StudioFiltersDrawer.tsx:54-67` — `normalizeFilterForCompare` strips `id`/`scope` but keeps `dependsOn`, whose filter-id values live in different id-spaces on the two sides (live ids vs `${presetId}-*` vs fresh apply-time ids), so `filtersEquivalent` is always false for cascading presets — even immediately after Save/Apply. Fix: normalize `dependsOn` (positional remap within the compared set).

### 3.12 `summarizeFilter` hides a genuine `0` between-bound

`filterDrawerUtils.ts:253-254` uses truthiness on `range.from` — "between 0 and 100" summarizes as "until 100". The evaluator side was fixed with `hasBetweenBound` (`filterUtils.ts:120-123`); the summary wasn't. Reachable with host/AI-authored numeric bounds.

### 3.13 MultiSelectControl "Select all" ignores the active search

`controls/MultiSelectControl.tsx:146-149` selects `values` (all), not the `filtered` subset — the drawer's `SelectionFilterInput` select-all operates on the filtered subset, so the two selection UIs disagree on bulk-action scope.

### 3.14 Date slider mis-commits by one day across DST transitions

`StudioFilterWidget.tsx:186-213, 335-348` — slider positions are `min + k·86 400 000` from a local-midnight min; past a fall-back DST change they land at 23:00 of the previous local day, so `dayjs(v).format('YYYY-MM-DD')` commits one day early and the round-trip nudges the handle — the symptom the midnight-flooring fix targeted, reopened for DST zones. Fix: reconstruct day keys by calendar arithmetic (e.g. dayjs `.add(k, 'day')`) instead of fixed 24h steps.

### 3.15 Widget-edit-dialog FilterRow renders relative-date values as `[object Object]` and clobbers them

`StudioWidgetEditDialog/FilterRow.tsx:271` (`String(filter.value)` for the single-value input) and `:121-124` + `:256/263` (a `RelativeDateValue` passing into the between editor keeps `relative: true` on the committed `{from,to}` object). The operator-switch preservation fix keeps relative values alive, but the editors can't display them; one keystroke + blur replaces the relative value with a garbage string. Evaluation of the polluted object is harmless (only `from`/`to` are read) — display/edit-clobber only.

---

## Notes on scope

- Areas swept and found clean (no findings): controller commit/undo/redo invariants (`commitState`/`commitMutations`/`carryTransientDocState`/value-equality bails), `docTransforms`, the L1–L4 caches (`normalizedRowsCache`/`enrichedRowsCache`/`resolvedRowsCache`/`rcfaCache` dependency tracking), `dataSourceGraph`/`grainResolution` join/anchor logic, `queryDescriptor`/`buildWidgetQueryDescriptor` cache-key parity, pivot matrix/CSV, grid summary/fan-out dedup, CSV escaping, `renderMarkdown` XSS surface (raw HTML disabled, scheme allowlist), SSE/`/widget` wire validation, chat stream lifecycle/thread pinning, `StudioDashboard` config-swap/adapter re-application, keyboard-shortcut scoping, canvas drop/geometry, and the documented deliberate asymmetries (which were left unflagged).
- Several findings intentionally group one _invariant_ with all of its sites rather than splitting per file; fixing the invariant at the shared helper is the intended unit of work in each case.
