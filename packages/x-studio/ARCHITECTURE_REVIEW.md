# x-studio architecture review — Iteration 12

Summary: 3 Tier 1, 5 Tier 2, 4 Tier 3.

Fresh, clean-slate pass over `@mui/x-studio` (store/controller, context/selectors, the L1–L4
data pipeline and its caches, chart aggregation and grain resolution, the widget kinds and their
aggregation, the setup panels, the server adapters, and the AI/chat surface), cross-read against
`packages/x-studio/ARCHITECTURE.md` and, for the wire contract, `packages/x-studio-data-middleware`.
Every finding was re-verified first-hand against current source (`/home/user/mui-x`, commit
`b361319`) with an exact file:line and a reachable scenario; anything that could not be stood
behind was dropped. Where a finding depends on cross-package behavior that could not be re-run in
this session, the confidence is stated inline.

## Verified SOUND (spot-checked first-hand)

- **Filter scoping/evaluation** (`filterScoping.ts`, `filterUtils.ts`): day-granularity date
  comparison, `not_in` exclude, `between`-on-non-orderable fail-closed, `filter-then-rank` order,
  `isConditionComplete`/`isFilterComplete` gating — all correct in-memory.
- **L2/L3/L4 caches** (`enrichedRowsCache`, `resolvedRowsCache`, `rcfaCache`): per-entry
  dependency tracking (own rows, joined foreign rows via `collect*SourceIds`, expression-field
  object refs, relationships ref, filter fingerprint); absent sources recorded as `null` to
  invalidate on late load. No blanket-invalidation gaps.
- **Grain resolution** (`grainResolution.ts`): anchor- and M:N-remote-scoped filter re-application
  before the expansion join; `analyzeChartSupport` fails mixed grains closed.
- **Aggregate policy** (`aggregate.ts`): `coerceAggregateValue`/`countDistinct` and
  `count`=COUNT(\*) vs null-skip split applied uniformly across KPI/pivot/heatmap/chart/grid;
  loop-reduce min/max.
- **Join-key coercion** (`normalizeJoinKey`) consistent across L2/L3/L4/grid/map.
- **KPI trend math** (`kpiUtils.ts`) and the four `widgetFilters`/`crossFilterAllPages` threadings.
- **Undo/redo integrity** (`StudioController`): doc-only snapshots, `carryTransientDocState`
  coverage, `normalizeSessionAfterDocSwap` at all four sites, value-equality bails on undoable
  writers, `commitMutations` no-op-on-transform-output with presence-guarded transforms.
- **Privacy** (`studioBackendAdapter.ts`, `useTextWidgetAI.ts`, `createWidgetFromDescription.ts`):
  every outgoing `/chat`, `/widget`, `/approval` request gates `pageSnapshot`/`dashboardState`/
  `richContext`/`aiDescription`/`cardinality` behind `privateMode`; `/approval` bodies carry no
  tool results; SSE `state-mutation` runs through `parseStateMutation` + `sanitizeServerWidgetConfig`.
- **CSV export**: `escapeCsvCell` formula-injection guard (runtime-type-aware), centralized
  `downloadCsv` filename sanitization, adapter/live cacheKey parity via `buildWidgetQueryDescriptor`.
- **`StudioRequestCache`**: TTL+LRU, in-flight dedup, generation-tagged invalidation.
- **`StudioDashboard` config-swap**: upsert + prune + adapter re-application ordering.

---

# Tier 1 — data-correctness / errors reachable through normal UI

## T1.1 — Incomplete filter condition is pushed to the adapter server as a real predicate

- **Location:** `packages/x-studio/src/server/createBatchingAdapter.ts:1291` (`isOpValueServerTranslatable`
  — no completeness gate on the first condition); reachable from the drawer's add-filter default at
  `packages/x-studio/src/components/StudioFiltersDrawer/StudioFiltersDrawer.tsx:281-284` (`{ field: '',
operator: 'equals', value: '' }`).
- **Invariant:** _A leaf is pushed to the server only with EXACTLY the in-memory evaluator's
  semantics._ In-memory, an incomplete filter is a no-op — `applyFilters` → `isFilterComplete`
  (`filterUtils.ts:490`) drops a filter whose `field` is empty or whose `value` is `''`/`null`.
  `isOpValueServerTranslatable` gates only on operator mapping, empty-`in`, and `between` bounds —
  never on first-condition completeness — while `selectFiltersForWidget` passes incomplete filters
  through.
- **Reachable scenario:** On an **adapter-backed** source, clicking "Add filter" and then picking a
  field but not yet typing a value yields `{ field: 'status', operator: 'equals', value: '' }`. That
  leaf is declared translatable and shipped as `status = ''`: a string column silently returns only
  empty-string rows (widget blanks); a numeric column on Postgres throws `invalid input syntax`
  (widget flips to the error overlay) — all before the user has finished authoring the filter. The
  identical dashboard on in-memory rows correctly shows every row until the filter is complete.
- **Sibling sweep:** `createSimpleAdapter` POSTs the same incomplete leaf inside the raw descriptor
  (host-defined semantics); `buildQueryDescriptor` (`internals/queryDescriptor.ts:255`) folds the
  incomplete leaf into `cacheKey` with no completeness gate, so it also churns a server round-trip
  per keystroke. The in-memory path (`useWidgetRows`) is unaffected.
- **Fix direction:** prune incomplete filters in `buildQueryDescriptor` before `filtersToFilterNode`
  (fixes both adapters and stabilizes the cacheKey), or gate `isOpValueServerTranslatable`/
  `partitionFilterNode` on the already-imported `isConditionComplete` so incomplete leaves route to
  `clientLeaves` (self-healing — `applyFilters` re-drops them).
- **Confidence:** high (in-adapter code and drawer default read first-hand; middleware error
  behavior per the wire-contract sub-audit).

## T1.2 — `leafToPredicates` emits an incomplete second condition its own translatability check omitted

- **Location:** `packages/x-studio/src/server/createBatchingAdapter.ts:1410`
  (`if (leaf.op2 && leaf.value2 !== undefined)`) vs `:1321`
  (`isLeafServerTranslatable` derives second-condition presence via
  `isConditionComplete(leaf.op2, leaf.value2)`).
- **Invariant:** the two functions must agree on what "has a second condition" means. They disagree
  exactly when `op2` is set but `value2` is incomplete (`value2 === ''`): `isConditionComplete`
  returns `false` (so the leaf is declared fully translatable on its first condition), yet
  `leafToPredicates` still emits the second predicate because `'' !== undefined`.
- **Reachable scenario:** `SecondCondition.tsx:42` initializes a new secondary condition as
  `{ operator2: operators[0].value /* 'equals' */, value2: '', conjunction: 'and' }` the instant the
  user clicks "+ Add condition". The leaf passes translatability as a single condition, but
  `leafToPredicates` ships a phantom `col = ''` — string column empties the widget, numeric column on
  PG errors. If the user then switches `op2` to `contains` (no value), `mapOperator('contains')` is
  `null`, so the emitted predicate has `operator: null` and the middleware's `SAFE_OPERATORS` check
  throws → the whole widget errors. In-memory, the incomplete secondary is ignored
  (`compileRowTest`, `filterUtils.ts:205`).
- **Sibling sweep:** this is the false-_positive_ mirror of the already-fixed 2.8 (which fixed only
  the false-_negative_ direction in `isLeafServerTranslatable`); `leafToPredicates` was left on the
  bare `value2 !== undefined` gate.
- **Fix direction:** change `leafToPredicates`'s gate to
  `if (leaf.op2 !== undefined && isConditionComplete(leaf.op2, leaf.value2))`; the `mapOperator(...)!`
  assertions below then become genuinely safe because translatability vetted `op2`.
- **Confidence:** high (both gates read first-hand).

## T1.3 — Date inequalities / `between` pushed server-side with silently different day granularity

- **Location:** `packages/x-studio/src/server/createBatchingAdapter.ts:1352,1362`
  (`warnServerLeafDivergence` covers only `not_equals` and date `equals`) vs `filterUtils.ts:155-169,
318-459` (`compileDateBound`: a bare-date bound compares at **day** granularity in-memory).
- **Invariant:** in-memory, `<= '2026-07-10'` on a `datetime` column includes the whole of Jul 10,
  and a `between` upper bound covers the full last day (the finding-1.3 day-granularity fix). The
  `gt/gte/lt/lte/between` operators are server-translatable, so the bare-date string ships as-is and
  the server runs `col <= '2026-07-10'` / `whereBetween`, excluding everything after midnight of the
  boundary day.
- **Reachable scenario:** a drawer "On or before" / "Before" / "After" filter, or a **custom**
  dashboard date range (`resolveDateRangePreset` appends `T23:59:59.999Z` only for _non-custom_
  presets), on an adapter-backed `datetime` source: adapter-backed widgets are missing the entire
  last day of the range relative to the in-memory rendering of the same source — silently, because
  no warning fires.
- **Doc divergence:** ARCHITECTURE.md's Server-adapters section explicitly promises a one-time
  `warnAdapterDivergence` for "`equals`/**inequalities** on a `date`/`datetime` field", but
  `warnServerLeafDivergence` only warns for `equals` — so the reachable inequality/`between`
  divergence is fully silent.
- **Sibling sweep:** the class this re-introduces on the wire was fixed in-memory in `compileDateBound`
  and its `>`/`>=`/`<`/`<=`/`between` branches; `createSimpleAdapter` inherits the same host-facing
  divergence.
- **Fix direction:** translate faithfully — bare-date `lte` on datetime → `lt next-day`, `between
[from,to]` → `[from, to+1d)` via `lt` (all expressible on the wire); at minimum extend
  `warnServerLeafDivergence` to the inequality/`between` ops so the doc's promise holds.
- **Confidence:** high on the divergence (both sides read first-hand); classified new because the
  documented deliberate divergence covers only date _equality_ and the promised inequality warning
  is absent.

---

# Tier 2 — robustness / consistency invariant gaps

## T2.1 — The non-React pipeline façade cannot apply widget-scoped rank filters (grid export diverges from screen)

- **Location:** `packages/x-studio/src/internals/StudioPipeline.ts:157` (`resolveWidgetRows` — no
  widget-kind / `includeWidgetRank` channel); the omission bites at
  `packages/x-studio/src/internals/filterScoping.ts:66` (the `widget`-scope case defaults
  `includeWidgetRank = false`, excluding rank leaves). Consumer:
  `packages/x-studio/src/components/StudioWidgetCard/widgetExport.ts:112`.
- **Invariant:** _A widget-scoped rank (Top-N) filter is enforced at L3 as a dataset-level reduction
  for every non-chart widget kind_ — exactly what `useWidgetRows.ts:313` encodes via
  `includeWidgetRank = !isWidgetOfKind(widget, 'chart')`, and what `makeSelectWidgetRankFilter`
  (`context/selectors.ts:537`) relies on when it (deliberately) grants the "Top N" chip to
  grid/KPI/map/pivot, not just charts.
- **Reachable scenario:** a **grid** widget with a widget-scoped `Top 5 by revenue` rank filter shows
  5 rows on screen (`useWidgetRows` passes `includeWidgetRank = true`). CSV export runs rows through
  `pipeline.resolveWidgetRows(...)`, but `StudioPipeline.resolveWidgetRows` takes only
  `(widgetId, sourceId, rows, pageId, options)` — no widget kind, no `includeWidgetRank` — so its
  `selectFiltersForWidget` call uses the `false` default and drops the widget-scoped rank. The CSV
  contains all rows, not the top 5. (Page-scoped rank is unaffected — it flows through
  `applyFilters` regardless.) The method's JSDoc ("Rank filters … are excluded") is also stale:
  page-scoped rank _is_ applied.
- **Sibling sweep:** `generateInsight.ts:790` (`buildWidgetDataSummary`) — the AI grid/pivot raw-row
  summary describes unranked rows (the chart summary re-applies its own rank at `:423`, so charts are
  covered); `richContext.ts:131` uses a synthetic widget id so no `scope:'widget'` filter matches
  (unaffected).
- **Fix direction:** add an `includeWidgetRank` option to `StudioPipeline.resolveWidgetRows` (or pass
  the widget so it can derive `!isWidgetOfKind(widget,'chart')`), thread it into that call site, and
  have `widgetExport.ts` / the grid-pivot branch of `buildWidgetDataSummary` pass `true` for
  non-chart kinds; correct the stale JSDoc.
- **Confidence:** high (all sites read first-hand).

## T2.2 — `buildWidgetDataSummary` resolves its date filter against the raw dashboard-wide filter list

- **Location:** `packages/x-studio/src/components/StudioChatPanel/generateInsight.ts:803`
  (`findDateFilter(state.doc.filters, widget.id, source)`); `findDateFilter` at
  `packages/x-studio/src/components/widgets/StudioKpiWidget/kpiUtils.ts:167`.
- **Invariant:** _A widget's date filter is resolved from the filters that actually scope to it._
  `findDateFilter` itself does not check `disabled`, page id, or `dashboard-date-range` source id
  (kpiUtils.ts:172), so callers must pass a pre-scoped list. The KPI widget always does —
  `StudioKpiWidget.tsx:285/692/868` pass `scopedFilters` (from `selectFiltersForWidget`).
  `generateInsight` passes raw `state.doc.filters`.
- **Reachable scenario:** when the AI builds a KPI/data summary, `findDateFilter` can pick up a
  **disabled** date filter, a page date filter from a **different page**, or a `dashboard-date-range`
  filter for a **different source**. The summary's `Date range:` line and the previous-period trend
  window (`buildKpiWidgetSummary`, `:327`) are then computed over a window that does not apply to the
  widget — the model is told the wrong active range / trend.
- **Sibling sweep:** the four `findDateFilter` call sites are the definition plus
  `StudioKpiWidget.tsx:285/692/868` (all pre-scoped, correct) and `generateInsight.ts:803` (the only
  unscoped caller).
- **Fix direction:** scope through `selectFiltersForWidget(state.doc.filters, { widgetId, widgetSourceId,
activePageId, crossFilterAllPages })` before `findDateFilter`, matching the KPI widget; or make
  `findDateFilter` itself reject disabled/off-scope filters.
- **Confidence:** high.

## T2.3 — Empty-selection ("any value") filter inverts to match-NOTHING on the adapter path

- **Location:** `packages/x-studio/src/server/createBatchingAdapter.ts:1291` (empty-`in` routed to
  the client residual) + `:1482-1494` (`leafToClientFilterState` hardcodes `filterMode: 'condition'`)
  - `packages/x-studio/src/internals/queryDescriptor.ts:19-24` (`filterStateToLeaf` drops `filterMode`).
- **Invariant:** an empty selection means "no selection → match everything" — `isFilterComplete`'s
  selection branch (`filterUtils.ts:495`) drops an empty selection array in-memory, and the drawer
  renders it as "any value". But the empty-`in` special case in `isOpValueServerTranslatable` is only
  correct for _condition-mode_ `in` (matches nothing). Because `filterStateToLeaf` drops `filterMode`
  and `leafToClientFilterState` re-stamps it as `'condition'`, the leaf is re-applied client-side as a
  complete condition-mode `in []` (`isConditionComplete('in', [])` is `true` since `[] != null`),
  which excludes every row.
- **Reachable scenario:** a page-scoped selection filter with all values unchecked on an
  adapter-backed source: adapter-backed widgets blank out, while the identical in-memory dashboard
  shows all rows. (When the server aggregates, the residual is dropped with a warning — accidentally
  correct — so this bites the raw-row query path.)
- **Sibling sweep:** `filterMode` is dropped in exactly one place (`filterStateToLeaf`) and re-forced
  to `'condition'` in one place (`leafToClientFilterState`); no other leaf conversion preserves it.
- **Fix direction:** carry `filterMode` on `StudioFilterNode` leaves (and preserve it in
  `leafToClientFilterState`), or treat an empty-array leaf as a no-op in `partitionFilterNode` to
  match selection semantics.
- **Confidence:** high on the empty-selection inversion mechanism (leaf conversions read first-hand);
  medium on the exact operator (`in` vs `equals`) the selection toggle writes, which could not be
  re-verified this session.

## T2.4 — Rank-by-measure + server-pushed aggregation ranks over distinct-collapsed groups

- **Location:** `packages/x-studio/src/internals/queryDescriptor.ts:266-273` (widens `select` with
  `rankByField`); the client rank reduction is `filterUtils.ts:537-548`, applied to adapter rows via
  `useWidgetRows.ts:377-406`.
- **Invariant:** the client-side rank reduction must see raw rows so `totals += Number(row[rankByField])`
  sums correctly per group. When the widget also pushes a `sum`/`min`/`max` aggregation, the
  middleware GROUP BYs every projected non-measure column — so `rankByField` becomes a grouping
  dimension and duplicate `(groupKey, rankByFieldValue)` pairs collapse to one row. The client then
  sums the collapsed rows and picks the wrong Top-N vs the identical in-memory dashboard. No warning
  fires; the widget's own displayed sum stays correct (sums of partial sums), making the wrong
  selection extra confusing.
- **Reachable scenario:** a page-scoped "Top N by measure" filter on a chart with a pushable
  aggregation over a batching adapter.
- **Sibling sweep:** mirrors the existing `count` / `avg`+`xGroupBy` / incoming-cross-filter cases
  that already force raw-row fetch + client aggregation; rank was not added to that set.
- **Fix direction:** when rank filters are present alongside a pushable aggregation, route to raw
  rows + client aggregation (add a `hasRankFilters` descriptor flag mirroring
  `hasIncomingCrossOrInteractiveFilters`, folded into the cacheKey only when aggregations exist).
- **Confidence:** medium-high — the `select` widening and client rank application were read
  first-hand; the middleware GROUP BY collapse was verified by the wire-contract sub-audit against
  `x-studio-data-middleware/src/execute.ts`, not re-run here.

## T2.5 — `PageFilterRow` resolves the field's type without source scoping (asymmetric with `WidgetFilterRow`)

- **Location:** `packages/x-studio/src/components/StudioFiltersDrawer/PageFilterRow.tsx:47`
  (`fields.find((f) => f.id === filter.field)` — ignores `filter.filterSourceId`) vs the
  source-scoped sibling `WidgetFilterRow.tsx:59-61` (`effectiveSourceId = filter.filterSourceId ??
widgetSourceId`; matches on `o.id === filter.field && o.sourceId === effectiveSourceId`).
- **Invariant:** a filter's field type must be resolved from the field on _its own_ source, so the
  operator list and the non-undoable operator-repair effect act on the right type.
- **Reachable scenario:** a host/AI-authored page filter with no stored `fieldType` whose field id
  collides across two sources with different types (e.g. `status` string on A, number on B). The
  wrong twin's type drives `getOperators`, and because the repair guard fires on `fieldType ===
undefined` (PageFilterRow.tsx:118) rather than resolved-but-wrong, the `{ undoable: false }` repair
  effect can permanently rewrite a valid stored `between`/`greater_than` to `equals` — the exact
  hazard the operator-repair guard was added to close, defeated by picking the wrong field's type.
- **Sibling sweep:** `WidgetFilterRow` already scopes by `effectiveSourceId`; `PageFilterRow` is the
  lone unscoped field-type lookup. (Drawer-authored page filters always stamp `filterSourceId` for
  cross-source picks, so this is host/AI-authoring-reachable.)
- **Fix direction:** mirror `WidgetFilterRow`'s `filter.filterSourceId`-scoped lookup in
  `PageFilterRow`.
- **Confidence:** medium (narrow precondition; the sibling asymmetry is confirmed first-hand).

---

# Tier 3 — minor

## T3.1 — AI trend previous-period bounds day-shift through UTC

- **Location:** `packages/x-studio/src/components/StudioChatPanel/generateInsight.ts:337,339`
  (`prevRange.start.toISOString().slice(0, 10)` / `prevRange.end.toISOString().slice(0, 10)`).
- **Invariant:** `computePreviousPeriodRange` (`kpiUtils.ts:247`) builds boundaries in **local** time
  (`new Date(year, month, day, …)`); `kpiUtils.ts:202` (`toLocalYmd`) and `StudioKpiWidget.tsx:330`
  were both switched off `toISOString().slice(0,10)` for this reason.
- **Reachable scenario:** for a non-UTC viewer the inclusive end (or start) bound shifts one calendar
  day (e.g. `America/New_York`: local Jan 31 23:59 → `toISOString()` → `2026-02-01`), so the AI
  previous-period value / trend % in the widget summary is computed over a window off by a day at one
  edge — the same bug already fixed in the KPI widget, never propagated here.
- **Sibling sweep:** package sweep for `toISOString().slice(0, 10)` on local-time boundary Dates finds
  only `generateInsight.ts:337/339`; the other hits (`temporalUtils.ts:58/102`, `filterUtils.ts:94`)
  operate on already-canonical/zoned values.
- **Fix direction:** reuse the exported `toLocalYmd` (`kpiUtils.ts`) for the `prevRange` serialization.
- **Confidence:** high.

## T3.2 — Chart empty-x bucket: English-only label and heatmap/aggregator divergence

- **Location:** `packages/x-studio/src/internals/chartValues.ts:35` (`toXValue`) / `:51`
  (`isEmptyXValue`) — both accept a `localeText` no caller passes; and
  `packages/x-studio/src/internals/chartShapes/heatmap.ts:74`.
- **Invariant (a):** the null/undefined x bucket should render the translated `chartEmptyCategoryLabel`
  token (`internals/localeText.ts:917`). Every caller — `aggregators.ts:276/279/354/357/359/456/459`
  and `StudioPieChart.tsx:200/203` — omits `localeText`, so non-English locales always show the
  English literal `'(empty)'`.
- **Invariant (b):** the generic aggregators skip empty-x rows (`if (isEmptyXValue(row[xField]))
continue`), but `aggregateHeatmap` computes `xVal = String(applyXGroupBy(toXValue(row[xField])…))`
  with no `isEmptyXValue` guard (only `!xVal`), and `toXValue(null)` returns the truthy `'(empty)'` —
  so a null x survives as an `'(empty)'` **column** in a heatmap while a bar/line chart over the same
  field drops those rows. Two chart families disagree on the same data.
- **Sibling sweep:** every `toXValue`/`isEmptyXValue` caller omits `localeText`; `aggregateHeatmap` is
  the only aggregation entry point missing the `isEmptyXValue` guard the generic aggregators apply.
- **Fix direction:** thread the widget's `localeText` into `toXValue`/`isEmptyXValue` at the aggregator
  boundaries (or resolve the label once at the chart), and add the `isEmptyXValue` guard to
  `aggregateHeatmap` so null-x rows are dropped consistently with the other families.
- **Confidence:** high (all sites read first-hand).

## T3.3 — Latent rank/undo invariant gaps reachable only via host `applyExternalMutation`

- **Locations & invariants:**
  - `packages/x-studio/src/store/StudioController.ts:1632-1643` — `updateFilter`'s rank guard only
    runs when _switching to_ rank (`switchingToRank`); a `changes.scope` that re-points an
    _already-rank_ filter into another page's context bypasses `hasConflictingRankFilter` and can land
    two rank filters in one page context (the one-rank-per-page invariant). All shipped call sites
    (`PageFilterRow`/`WidgetFilterRow`/`WidgetFiltersPanel`) pass row-level deltas and never patch
    `scope`, so this is host-API-only.
  - `StudioController.ts:472-476` — `applyExternalMutation`'s dead-undo special-case lists only
    `setActivePage`/`renameAIThread`; the reducer's `addPage`-for-an-existing-id branch
    (`applyMutation.ts` `addPage`) produces an `activePageId`-only doc diff (a transient-carried
    field), so a re-delivered AI `addPage` commits _undoably_, pushing an undo entry
    `carryTransientDocState` can revert nothing while clearing the redo stack.
  - `StudioController.ts:1584-1587` — `addRelationship` has no duplicate-id/exists guard (unlike
    `addExpressionField` / the reducer's `addFilter` idempotency), so a double-add appends a second
    entry that `update`/`remove` then both touch.
- **Reachable scenario:** only through a host constructing mutations and calling the public
  `applyExternalMutation`/controller methods (a typed, in-process API documented as trusting its
  input) or an at-least-once SSE re-delivery; not reachable from the drawer/canvas UI or the current
  AI tool set (`add_page_filter`/`add_widget_filter` never set `filterMode`).
- **Fix direction:** run `hasConflictingRankFilter` in `updateFilter` whenever `target.filterMode ===
'rank' && 'scope' in changes`; extend the transient-only classification to any reducer result that
  differs only in transient-carried fields; add a `some(r => r.id === id)` bail in `addRelationship`.
- **Confidence:** high on mechanics, low on severity (latent / host-API-only).

## T3.4 — Cross-source cascading "Depends on" narrowing silently empties the child filter's options

- **Location:** `packages/x-studio/src/components/StudioFiltersDrawer/PageFilterRow.tsx:66-83`
  (`dependencyOptions` offers every other page filter with no source restriction) +
  `useFieldValues.ts` (`applyParentFilters` narrows by naive `row[f.field]` against the child's own
  source rows).
- **Invariant:** a cross-source dependency should be resolved through a declared join path (as
  `dataSourceGraph.resolveRows` does), not by comparing the parent's field name against the child
  source's raw rows.
- **Reachable scenario:** page filter A on `customers.country`, page filter B on `orders.status` with
  `dependsOn: [A]`. Once A has selections, every `orders` row reads `row['country'] ?? '' = ''`, fails
  the set test, and B's value list renders empty — even though the engine would resolve the same
  cross-source predicate via `findJoinPath`.
- **Sibling sweep:** `WidgetFilterRow` never passes `parentFilters`, so only page-filter cascades are
  affected.
- **Fix direction:** restrict `dependencyOptions` to parents whose owning source matches the child's,
  or semi-join through `findJoinPath` in `applyParentFilters`.
- **Confidence:** medium (behavior confirmed; may be an accepted limitation rather than a defect).
