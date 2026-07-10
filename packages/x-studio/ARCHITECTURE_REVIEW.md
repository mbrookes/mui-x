# Architecture review — iteration 8 (fresh ground-up pass)

Scope: full re-read of `packages/x-studio/ARCHITECTURE.md` cross-checked against the current
source, with depth prioritized on the data pipeline (`internals/dataSourceGraph.ts`,
`grainResolution.ts`, `chartSupport.ts`, `filterUtils.ts`, `filterScoping.ts`,
`aggregators.ts`, the three cache layers, `useWidgetRows`/`useChartRows`/
`useChartWidgetData`/`useBlendedSeriesRows`), the controller (`store/StudioController.ts`,
`store/docTransforms.ts`), and the non-React consumers of the pipeline
(`StudioPipeline.ts`, `widgetExport.ts`, `generateInsight.ts`, `StudioKpiWidget.tsx`).

All findings below were re-derived from the current working tree; none is a carry-over
assumption from earlier rounds. Counts: **3 Tier 1**, **5 Tier 2**, plus 2 doc-staleness
notes.

---

## Tier 1 — data-integrity bugs

### 1.1 M:1-anchored chart with an M:N (or junction-owned) dimension silently mis-attributes the measure

**Where:**

- `src/internals/chartSupport.ts:229-259` (anchor selection, branch "y owned by a single
  foreign source"), `:305-326` (per-field owner loop), `:37-65` (`isSafeWidgetBridgeOwner`)
- `src/internals/grainResolution.ts:306-315` (M:1 branch resolves non-anchor dimensions via
  `enrichRowsWithRelatedFields`)
- `src/internals/dataSourceGraph.ts:536-557` (the deliberately first-match-only M:N display
  lookup)

**What's wrong:** Iteration 7's `junctionAnchorForWidgetMeasure` fix
(`chartSupport.ts:260-296`) only covers the topology where **every y-measure is
widget-owned**. When the measure is owned by a _directly-related many-side source_ (the M:1
anchor branch at `:229-246`), a grouping dimension owned by the **remote endpoint or the
junction of an M:N relationship** with the widget source still sails through the owner loop:
`isSafeWidgetBridgeOwner` returns `true` for both (`:51-53` matches the M:N relationship
type, `:58-64` matches the junction). `resolveRowsAtGrain` then takes the many-to-one anchor
branch, and the M:N dimension is resolved by `enrichRowsWithRelatedFields`'s
**first-match-only** junction lookup — whose own doc comment
(`dataSourceGraph.ts:365-368`) claims "this first-match lookup is reached only for genuine
display columns", which this path falsifies.

**Concrete failure:** sources `orders` (widget), `order_items` (M:1, many side of orders),
`tags` (M:N with orders via `order_tags`). Chart on `orders`, y = `order_items.total`
(anchor = `order_items`), x (or series) = `tags.name`. `analyzeChartSupport` reports
**supported**; each order is attributed to ONE arbitrary tag, so "sum of item total by tag"
silently under-counts every multi-tag order — the exact bug class finding 1.1 (iter 7) fixed
for widget-owned measures. Variant: if the dimension is owned by the **junction source**
itself (e.g. `order_tags.weight_class`), `enrichRowsWithRelatedFields` cannot resolve
junction-owned fields at all (it only checks relationship _endpoints_, `:440` / `:492`), so
every row reads `undefined` — an empty or single-bucket chart that the guard reported as
supported.

**Fix direction:** in the owner loop (`chartSupport.ts:305-326`), when
`anchorSourceId !== widgetSourceId` and the anchor is NOT an M:N junction, fail closed with
`mixed_cross_source_fields` for any non-y field whose owner is reachable from the widget
source **only** via an M:N relationship (remote endpoint or junction). There is genuinely no
single grain combining an `order_items`-level measure with a tag fan-out, so fail-closed is
correct — matching the existing "two distinct M:N remote dimensions" fail-closed behaviour.

### 1.2 KPI grain anchoring never re-applies anchor-scoped filters — the iter-6 "filter resurrection" fix bypassed on the whole KPI path

**Where:** `src/components/widgets/StudioKpiWidget/StudioKpiWidget.tsx` — all four
`resolveChartRowsForAggregation` call sites: `:130-139` (`computePeriodValue`, trend),
`:389-398` (`useKpiGrainAnchoredRows`, headline), `:616-625` (sparkline cross-source time
field), `:784-793` (fixed-period trend). Every one passes 8 arguments, so the trailing
`widgetFilters` parameter defaults to `[]`.

**What's wrong:** the L4 anchor-source filter re-application (grainResolution.ts finding
1.4/2.3 from iter 6/7 — `anchorScopedFilters` applied to anchor rows before the expansion
join) was threaded through the _chart_ path only (`useChartWidgetData` →
`useChartRows` → `resolveChartRowsForAggregation`). The KPI widget calls the same L4 core
directly with no filter set, so L3's semi-join is the only enforcement: the expansion join
reads **all** of a surviving widget row's anchor rows straight from the unfiltered store.

**Concrete failure:** KPI on `customers`, value field `orders.total` (anchor = `orders`,
the supported one-side→many-side direction), page filter `orders.status = 'paid'`
(`filterSourceId: 'orders'`). Headline, trend AND sparkline sum paid **and** unpaid orders
for every customer with at least one paid order — while a bar chart with the identical
configuration on the same page (post-iter-6) shows only paid orders. Two widgets over the
same data on the same page disagree.

**Fix direction:** compute the widget's resolved filter set the same way
`useChartWidgetData.ts:151-178` does (`selectFiltersForWidget` with `include` matching the
rows baseline in use — the KPI already resolves scoped filters for its trend/subtitle via
the same authority) and pass it as the `widgetFilters` argument at all four call sites.
`resolveChartRowsForAggregation` already folds the anchor-scoped fingerprint into its cache
key, so no extra cache plumbing is needed.

### 1.3 L4 anchor/remote filter re-application is blind to expression-field filters (two facets)

**Where:**

- `src/internals/grainResolution.ts:109` (`anchorScopedFilters`), `:199`
  (`remoteScopedFilters`) — both match on **explicit** `f.filterSourceId` only
- `src/internals/chartSupport.ts:519-523` (cache key, same explicit-only predicate)
- `src/internals/grainResolution.ts:281-300` (M:1 branch enrichment scoped to
  `anchorFieldIds`), `:104` + `:221-238` (M:N junction enrichment gated on
  `needsExpressionEnrichment` over _requested_ fields only)
- Contrast with L3, which handles both correctly: `dataSourceGraph.ts:244-257` derives
  `filterSourceId` for a foreign-owned expression field, and `:295-311` enriches foreign
  rows with `usedFieldIds: undefined` (all fields) before evaluating the filter.

**Facet (a) — derived ownership is never re-derived at L4.** A page filter authored in the
filters drawer on an expression field owned by another source carries **no**
`filterSourceId` (L3 derives the owner on the fly). Such a filter is invisible to
`anchorScopedFilters`/`remoteScopedFilters` _and_ to the L4 cache key, so the anchor-row
resurrection bug that iter 6/7 fixed persists for exactly this filter shape. Concrete: page
filter on `orders.margin_bucket` (a calculated column on `orders`, no `filterSourceId`),
chart on `customers` with y = `orders.total` (anchor = orders): L3 keeps customers with ≥ 1
high-margin order; L4 expands to **all** their orders — low-margin totals resurrected.

**Facet (b) — filters WITH explicit `filterSourceId` on an anchor-owned expression field
are evaluated against unenriched rows.** In the M:1 branch, anchor-row enrichment is scoped
to `anchorFieldIds` (the _requested_ anchor-owned chart fields); in the M:N branch, junction
enrichment runs only when a _requested_ field is a junction expression column. A filter
field outside the requested set is therefore never computed, and `applyFilters` evaluates
`undefined` against the filter value — dropping **every** anchor/junction row and rendering
the chart empty, even though L3 (which enriches the foreign source fully) had correctly kept
the widget rows. This is reachable from normal UI: click a bar on chart A (on `orders`)
whose xField is an `orders` expression field — `applyCrossFilter` stamps
`filterSourceId = fieldOwners.get(xField)` (`StudioChartWidget.tsx:395`) — and chart B on
`customers` with y = `orders.total` goes blank instead of cross-filtering. (The M:N
_remote_-endpoint branch already handles this correctly, enriching with all fields at
`grainResolution.ts:203-214` — only the anchor/junction subsets are affected.)

**Fix direction:** (a) derive an effective `filterSourceId` for expression-owned filter
fields once (extract/reuse the L3 derivation in `resolveRows`) and use it both in
`resolveRowsAtGrain`'s two subset computations and in `resolveChartRowsForAggregation`'s
`anchorScopedFilterKey`. (b) union the anchor/junction-scoped filters' `field` ids into the
`usedFieldIds` passed to `enrichSourceRowsWithExpressions`, and force the junction
enrichment when any anchor-scoped filter references a junction-owned expression field.

---

## Tier 2 — correctness/robustness gaps

### 2.1 `generateInsight`'s chart data summary bypasses L4 filter re-application, `extraFields`, and the disabled-rank guard

**Where:** `src/components/StudioChatPanel/generateInsight.ts:403-412` (8-arg
`resolveChartRowsForAggregation` call — no `extraFields`, no `widgetFilters`), `:386-389`
(rank-filter lookup without `!f.disabled`).

**What's wrong / failure:** the AI page-snapshot/widget-summary path re-runs L4 itself and
misses three fixes the render path has: (1) anchor-scoped filters are not re-applied, so
for a cross-source chart the numbers the model narrates include resurrected anchor rows the
rendered chart excludes (same mechanics as 1.2); (2) non-xy extra dimensions
(`heatYField`/`funnelReachedField`/`sankeyTargetField`) are not passed, so a cross-source
heatmap/funnel/sankey dimension resolves to `undefined` in the summary while the widget
renders it correctly (the render path threads `chartTypeExtraFields`,
`useChartWidgetData.ts:238-318`); (3) a **disabled** Top-N widget rank filter still reduces
the summary — `useChartWidgetData.ts:117-124` gained the `!f.disabled` guard, this copy did
not. Net effect: the model confidently describes numbers that differ from what the user
sees.

**Fix direction:** mirror the render path — build the same resolved filter set and
per-chart-type extra-fields list, and add the `disabled` guard to the rank lookup.

### 2.2 `StudioPipeline.resolveChartRows` exposes the pre-fix L4 semantics on the public façade

**Where:** `src/internals/StudioPipeline.ts:75-81` (interface), `:174-185`
(implementation) — neither accepts nor threads `widgetFilters`/`extraFields`.

**What's wrong:** the documented non-React entry point ("CSV export handlers, benchmarks,
unit tests") permanently reproduces the anchor-filter resurrection for any external caller,
and cannot resolve non-xy extra dimensions. `ARCHITECTURE.md` describes the filter-threading
as spanning "the whole call chain: `resolveChartRowsForAggregation` → `useChartRows` →
`useChartWidgetData`" — the pipeline façade is a fourth caller the chain skipped.

**Fix direction:** add optional `widgetFilters`/`extraFields` parameters to
`resolveChartRows` (defaulting to today's behaviour), and have it resolve
`selectFiltersForWidget` internally the way `resolveWidgetRows` already does, so a caller
that supplies `widgetId`/`pageId` gets consistent L3+L4 semantics for free.

### 2.3 Blended foreign series ignore filters on the foreign source's own expression fields

**Where:** `src/components/widgets/StudioChartWidget/useBlendedSeriesRows.ts:160-165` — the
applicability gate `.filter((f) => f.field && src.fields.some((fl) => fl.id === f.field))`
checks **native fields only**.

**What's wrong / failure:** a page filter targeting a calculated column on the foreign
source (e.g. `orders.margin_bucket = 'high'` while a mixed chart on `order_items` blends an
`orders` series) is dropped from the foreign series' filter set — even though
`spec.expressionFields` for that source are enriched into the very rows the series
aggregates (`resolveRowsCached(..., spec.expressionFields, usedIds)` at `:212-220`), so the
filter is directly evaluable in-source. Meanwhile the primary series honours the same filter
via L3's derived cross-filter semi-join. Result: the two series of one chart disagree about
an active page filter. (The gate is correct for fields the source genuinely lacks; the gap
is only same-source expression fields.)

**Fix direction:** extend the gate to
`src.fields.some(...) || spec.expressionFields.some((ef) => ef.id === f.field && !ef.isMeasure)`,
and add the filter's field to `usedIds` (already done at `:201-205`).

### 2.4 `aggregateByTwoFields` lacks the non-numeric-measure fallback its two siblings have

**Where:** `src/internals/aggregators.ts:317-387` vs `:262-273` (`aggregateByField`
pre-detect) and `:405-418` (`aggregateMultipleSeries` pre-detect).

**What's wrong / failure:** `aggregateByField` and `aggregateMultipleSeries` both pre-detect
a non-numeric y-field and fall back to `count`; `aggregateByTwoFields` (the split-by path)
does not — `coerceAggregateValue` skips every non-numeric cell, so a split-by chart on a
string measure renders every cell `null` (blank chart), while removing the split-by field
makes the same configuration silently render counts. Inconsistent degradation for the same
user mistake.

**Fix direction:** add the same first-non-null-value pre-detect and count fallback.

### 2.5 `carryTransientDocState` / cross-filter interaction is sound, but `applyFilterPreset` + interactive-filter carry has a subtle asymmetry — reviewed, NOT a bug (recorded to save future rounds the re-derivation)

Verified explicitly: interactive entries are carried by _replacement_ keyed on
source-widget existence in the incoming doc (`StudioController.ts:277-339`); cross-filter
entries deliberately time-travel; `activePageId` falls back to the incoming doc's first
page; `doc.ai` overlays unconditionally. `undo()`/`redo()` push the _store's_ current doc
(with transients) rather than the popped snapshot, which is correct because the carry
re-overlays current transients on every swap. No action needed — this subsection exists so
the next review doesn't re-flag it.

---

## Documentation staleness (fix the comments/doc, not code)

### D.1 `useKpiGrainAnchoredRows`' doc comment describes a direction the guard rejects

`StudioKpiWidget.tsx:347-351` says "a KPI on order_items using orders.revenue …
resolveChartRowsForAggregation re-anchors to the correct aggregation grain (the parent
source rows…)". That is the fan-**in** direction (widget on the many side, value on the one
side), which `analyzeChartSupport` never anchors — branch 1 requires the value source to be
the MANY side (`chartSupport.ts:233-239`), so this configuration returns
`mixed_cross_source_fields` and `isGrainAnchored` stays `false`. The hook actually protects
the opposite direction (KPI on `customers` with `orders.total`). The comment should describe
the supported topology (and, separately, product may want to decide whether the fan-in KPI
case should fail visibly rather than aggregate a field absent from the child rows).

### D.2 `enrichRowsWithRelatedFields`' "display columns only" claim is violated by finding 1.1

`dataSourceGraph.ts:365-368` asserts the first-match M:N lookup "is reached only for genuine
display columns" because `analyzeChartSupport` junction-anchors that topology. True only for
widget-owned measures; false under an M:1 anchor (finding 1.1). Update alongside the 1.1 fix.

---

## What was checked and found sound

- **Controller/undo**: `commitState`/`commitDocPatch`/`commitMutations` no-op guards,
  undo/redo doc-swap + transient carry + session normalization, `applyExternalMutation`'s
  transient-only mutation handling, adapter lifecycle (`upsertDataSource` adapter
  preservation + unconditional cache invalidation, `setDataSourceAdapter` same-reference
  guard, `removeDataSource`), collision-resistant ids, `duplicateWidget`/`moveWidget`/
  `insertWidgetAt` composition and orphan diagnostics, expression-field cycle guards and
  reference counting, `docTransforms` identity preservation (incl. the additive
  `setDashboardDateRangeAll` and preset re-id on `applyFilterPreset`).
- **Caches**: `resolvedRowsCache` (fingerprint coverage incl. relative-date day-roll,
  absence-as-null foreign-row tracking, LRU), `enrichedRowsCache` (dependency expansion,
  join-source tracking), `rcfaCache` (two-level keying, read-source tracking, anchor/remote
  filter fingerprints — modulo finding 1.3a).
- **Filter evaluation**: `compileRowTest` operator matrix (day-granular date equality,
  between fail-closed on NaN, selection `not_in`, second-condition completeness), rank
  ordering after row filters, `selectFiltersForWidget` scoping incl. `crossFilterAllPages`.
- **Aggregation math**: shared `coerceAggregateValue` policy across chart/pivot/KPI/map/
  grid; `'count'` = COUNT(\*) semantics; blended-series alignment; rank-on-aggregated paths
  (incl. the string-coercion membership fix).
- **`useWidgetRows`**: baseline trio + reference short-circuits, deferred partitioning,
  lazy `usedFieldIds` (rank `rankByField` widening), adapter-path client-side re-enforcement
  of cross/interactive/rank filters, cross-source column enrichment + row identity tagging.
- **iter-7 fixes re-verified from source**: junction anchoring for widget-owned measures
  (incl. composition with a third M:1 source enriched onto widget rows), remote-endpoint
  filter re-application + junction-row drop, chart-support expression scope
  (`relevantSourceIds` parity between `useChartWidgetData`, `StudioChartWidget`, and the
  setup panel), `makeSelectIncomingCrossFilters`' `crossFilterAllPages` handling, blended
  foreign-series scoping through `selectFiltersForWidget` — all correctly in place; the
  gaps found above (1.1, 1.3) are _adjacent_ topologies those fixes did not cover, not
  regressions of the fixes themselves.
