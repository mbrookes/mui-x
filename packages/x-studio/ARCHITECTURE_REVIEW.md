# Architecture review — iteration 7 (fresh, ground-up)

Scope: `packages/x-studio`, reviewed from current source on branch
`claude/branch-identification-y0rapm` (post-iter6, i.e. after commits 492bc56, 134663e,
e3cf678, ff4e402, 4cfb3b6, 4f21040, a26ccb7). All findings below were re-derived from
the current code — none is a carry-over from a prior round. Only Tier 1 (real bug /
data-integrity) and Tier 2 (real correctness/robustness gap) findings are reported,
plus documentation-accuracy notes as requested.

Reviewed in depth: `ARCHITECTURE.md` (all 387 lines), `internals/dataSourceGraph.ts`,
`grainResolution.ts`, `chartSupport.ts`, `filterUtils.ts`, `filterScoping.ts`,
`resolvedRowsCache.ts`, `enrichedRowsCache.ts`, `normalizedRowsCache` usage,
`computedCache.ts`, `crossSourceEnrichment.ts`, `aggregators.ts`, `queryDescriptor.ts`,
`useWidgetRows.ts`, `useAdapterRows.ts`, `useChartRows.ts`, `StudioRequestCache.ts`,
`StudioPipeline.ts`, `utils/expressionEvaluator.ts`, `store/StudioController.ts` (all
2258 lines), `store/docTransforms.ts`, `context/selectors.ts`,
`StudioChartWidget/useChartWidgetData.ts`, `useBlendedSeriesRows.ts`,
`StudioChartWidget.tsx` (guard chain / cross-filter emission),
`StudioGridWidget` fan-out aggregation, `StudioWidgetCard/widgetExport.ts`,
`server/createBatchingAdapter.ts` (aggregation-strip and filter-partition paths),
`internals/fieldCatalog.ts`, `ChartSetupPanel.tsx`, plus the relevant test suites
(`grainResolution.test.ts`, `__fixtures__/fanOutGolden.test.ts`,
`chartAggregation.test.ts`) to check which behaviors are asserted as intended.

---

## Tier 1 — data-integrity bugs

### 1.1 A many-to-many remote dimension with a widget-owned measure silently attributes each widget row to only its FIRST junction link

- **Where:**
  - `src/internals/chartSupport.ts:51-53` (`isSafeWidgetBridgeOwner` returns `true`
    for a `many-to-many` relationship unconditionally) and `:223-255`
    (`analyzeChartSupport` only selects a junction anchor when the **y** field's owner
    is cross-source — a widget-owned y keeps `anchorSourceId = widgetSourceId`).
  - `src/internals/grainResolution.ts:111-131` (no-re-anchor branch delegates to
    `enrichRowsWithRelatedFields`).
  - `src/internals/dataSourceGraph.ts:530-551` — the M:N two-hop enrichment lookup is
    explicitly **first-match-only**: `// widgetJoinValue → first target field value`.
    Its own doc comment (`:361-363`) says this is "suitable for display columns;
    aggregate queries should use `resolveChartRowsForAggregation`" — but
    `resolveChartRowsForAggregation` is exactly the caller that lands here for this
    topology.

- **What's wrong:** For a chart whose grouping dimension (x, series, or a non-xy
  `extraField`) is owned by the **remote endpoint of a many-to-many relationship**
  while the measure is owned by the **widget source** (e.g. widget on `orders`,
  x = `tags.name`, y = `sum(orders.total)`, `orders ↔ tags` via `order_tags`),
  `analyzeChartSupport` reports the configuration **supported** (the M:N branch of
  `isSafeWidgetBridgeOwner` blesses it), but L4 never re-anchors: each order is
  enriched with the tag from its _first_ junction row only (arbitrary — junction array
  order) and every other tag link is silently discarded.

- **Concrete failure:** `orders = [o1 (total 100, tags A+B), o2 (total 50, tag B)]`.
  "Sum of order total by tag" renders `A: 100, B: 50` (or `A: 0, B: 150`, depending on
  junction row order) instead of the join semantic `A: 100, B: 150`. No warning, no
  unsupported overlay — silently wrong numbers, sensitive to input ordering
  (non-deterministic across data refreshes that reorder junction rows). The same
  applies to a fieldless-count chart ("count of orders by tag").

- **Contrast with the tested path:** `__fixtures__/fanOutGolden.test.ts` scenario 2
  covers y-on-junction (anchor = junction, correct). No test covers
  y-on-widget-source + dimension-on-M:N-remote; the guard reports it supported, so it
  is reachable directly from `ChartSetupPanel` (the x-field picker offers remote-source
  fields via `reachableFields`).

- **Fix direction:** In `analyzeChartSupport`, when any requested **dimension** field
  (non-y) is owned by an M:N remote endpoint and the y fields are widget-owned, either
  (a) anchor on the junction source — the M:N branch of `resolveRowsAtGrain` already
  merges `{...widgetRow, ...remoteRow, ...jRow}` per junction row, which yields the
  correct "an order contributes to every tag it has" join semantics — or (b) fail
  closed with `mixed_cross_source_fields` so the chart shows the unsupported overlay
  instead of wrong numbers. (a) is preferable; it needs the widget-owned y values to be
  read from the merged widget-row fields, which the branch already does.

---

## Tier 2 — correctness / robustness gaps

### 2.1 Chart support analysis runs against own-source-only expression fields — a cross-source calculated dimension is falsely reported "unsupported"

- **Where:**
  - `src/components/widgets/StudioChartWidget/useChartWidgetData.ts:80-84` — the hook
    subscribes with `makeSelectExpressionFieldsForSource(widget.sourceId ?? '')`
    (own source **only**) and passes that list into `analyzeChartSupport` (`:245-273`).
  - `src/components/widgets/StudioChartWidget/StudioChartWidget.tsx:122-126` — same
    scoped selector feeds the widget's dependency-source helpers.
  - Compare `src/internals/useWidgetRows.ts:142-161`, which deliberately subscribes to
    own **+ directly-related** sources' expression fields, and
    `ChartSetupPanel.tsx:79-87`, which uses the **full** `selectExpressionFields` list
    for its own `analyzeChartSupport` call (`:186-209`).

- **What's wrong:** `findDirectFieldOwner` → `hasRowLevelField`
  (`chartSupport.ts:22-35`) resolves a related-source field either from
  `source.fields` **or** from `expressionFields` filtered by that source. With the
  own-source-only list, an expression field owned by a _related_ source can never be
  found, so `analyzeChartSupport` returns
  `{ supported: false, reason: 'field_not_found_or_not_direct' }`.

- **Concrete failure:** Add a calculated column `customer_tier` on `customers`
  (one-hop from `orders`). In the chart setup panel, pick it as the x (or split-by)
  field of an `orders` chart — the panel's own support check (full expression list)
  says it's fine and commits the config. The rendered widget then shows the
  "fields … not available on the widget source or a directly related source" overlay
  (`StudioChartWidget.tsx:659-698`) and `useChartRows` returns `[]` — even though the
  pipeline underneath (`resolveChartRowsForAggregation`, which re-runs
  `analyzeChartSupport` with the **full** list it receives from `useChartRows`'
  `selectExpressionFields`) supports the configuration. The panel and the widget
  permanently disagree.

- **Fix direction:** Subscribe with `makeSelectExpressionFieldsForSources(own +
one-hop-related ids)` (the exact pattern `useWidgetRows` uses), in both
  `useChartWidgetData.ts` and `StudioChartWidget.tsx`, so the outer guard sees the same
  ownership universe the pipeline does.

### 2.2 Blended mixed-chart foreign series: hand-rolled filter scoping leaks cross-page filters, never resolves date-range presets, and drops expression fields

- **Where:** `src/components/widgets/StudioChartWidget/useBlendedSeriesRows.ts`
  - `:64-75` — `pageFilters` keeps every `scope.kind === 'page'` /
    `'dashboard-date-range'` filter **without checking `scope.pageId`** (and without
    checking `dashboard-date-range`'s `scope.sourceId`).
  - `:110-112` — "applicable" = the field merely exists on the foreign source.
  - `:136-148` — the sync path feeds `spec.applicable` straight into
    `resolveRowsCached` **without** `resolveDateRangePresets`, and with
    `expressionFields: []`.
  - `:171-181` — the adapter path builds a descriptor with **no** `expressionFields`
    argument, and adapter-returned rows are never L2-enriched.

- **What's wrong (three facets, one root cause — this module hand-rolls scoping
  instead of routing through `selectFiltersForWidget`, the documented "single scoping
  authority"):**
  1. **Cross-page leak (sync path):** a page filter authored on page B constrains the
     foreign series of a blended chart on page A (if the field id exists on the
     foreign source), while the chart's _primary_ series is scoped to page A only via
     `selectFiltersForWidget`. The same chart mixes two different filter universes.
     (The adapter path is _not_ affected — `buildQueryDescriptor` re-scopes
     `spec.applicable` through `selectFiltersForWidget` with `activePageId = pageId`.)
  2. **Preset date ranges silently ignored (sync path):** a non-custom
     `dashboard-date-range` filter stores `value: null` and is only materialized by
     `resolveDateRangePresets` (which `selectFiltersForWidget` applies —
     `filterScoping.ts:84`). Passed raw, `isFilterComplete` →
     `isConditionComplete('between', null)` is `false` (`filterUtils.ts:416-421`), so
     the filter is treated as incomplete and skipped. Result: with "Last 30 days"
     active, the blended chart's primary series is date-filtered while every foreign
     series aggregates **all-time** data on the same axes. (A `'custom'` preset works,
     which makes the preset case easy to miss in testing.)
  3. **Foreign expression-field series render zero:** `ySeries` pickers offer
     expression fields of reachable sources (`buildFieldCatalog`, policy `'all'`), but
     the sync path passes `expressionFields: []` to `resolveRowsCached` (no L2
     enrichment → every cell `undefined` → `coerceAggregateValue` skips all → series
     of zeros), and the adapter path puts the raw expression id in the server SELECT
     (no `expandToNativeFields` — `buildQueryDescriptor` is called without the
     expression list) and never re-enriches the response.

- **Fix direction:** Build each foreign spec's filter set with
  `selectFiltersForWidget(filters, { widgetId: syntheticId, widgetSourceId: sid,
activePageId: pageId, include: 'no-cross' })` (which also resolves presets), and
  thread the real `expressionFields` (scoped to the foreign source) through both
  `resolveRowsCached` and `buildQueryDescriptor`, plus a `getCachedEnrichedRows` pass
  over adapter-returned foreign rows (mirroring `useWidgetRows`'
  `enrichedAdapterRows`).

### 2.3 L4 many-to-many expansion re-applies junction-scoped filters but not REMOTE-endpoint-scoped ones — the same "resurrection" class as iter6's finding 1.4

- **Where:** `src/internals/grainResolution.ts:109` (`anchorScopedFilters` keeps only
  `filterSourceId === anchorSourceId`) and `:198-226` (M:N branch: junction rows are
  filtered by the anchor subset, then expanded and merged with remote rows read from
  the **unfiltered** `remoteRowLookup`); cache key at `chartSupport.ts:457-463` folds
  in only the anchor-scoped fingerprint (consistent with the buggy behavior, so no
  stale-cache aggravation — but also no invalidation if fixed without updating it).

- **What's wrong:** Iter6's fix (finding 1.4) re-applies the filter subset scoped to
  the **anchor** source before the expansion join. But for a junction-anchored chart,
  a filter scoped to the **M:N remote endpoint** (`filterSourceId === remoteSourceId`)
  is enforced at L3 only as a semi-join on the _widget_ rows ("keep orders having ≥ 1
  matching tag"), and the L4 expansion then walks **every** junction row of each
  surviving widget row — including links to remote rows the filter excluded.

- **Concrete failure:** `orders ↔ tags` via `order_tags`; chart on `orders`,
  y = `sum(order_tags.weight)` (junction measure → anchor = junction),
  x = `tags.category`; page filter (or another widget's cross-filter)
  `tags.category = 'priority'` (`filterSourceId: 'tags'` — both `PageFilterRow.tsx:183`
  and chart cross-filter emission set it). Expected: only `priority` buckets. Actual:
  every category of every order that has ≥ 1 priority tag appears, with weights summed
  for excluded categories too — exactly the "paid + unpaid orders" shape iter6 fixed
  for the anchor source, one relationship hop further out.

- **Fix direction:** In the M:N branch, additionally compute
  `remoteScopedFilters = widgetFilters.filter(f => f.filterSourceId === remoteSourceId)`,
  apply them (via `applyFilters`, after enriching remote rows if needed) before
  building `remoteRowLookup`, and drop junction rows whose `junctionTargetField` key
  is absent from the filtered remote key set. Fold the remote-scoped fingerprint into
  the `rcfa` cache key alongside the anchor-scoped one.

### 2.4 `makeSelectIncomingCrossFilters` ignores `crossFilterAllPages` — the chart's "has incoming cross-filter" signal disagrees with the rows it renders

- **Where:** `src/context/selectors.ts:434-449` (hard `f.scope.pageId === pageId`
  test, no all-pages escape) vs `src/internals/useWidgetRows.ts:282-292`
  (`hasChartCrossFilters` honors `crossFilterAllPages || f.scope.pageId === pageId`)
  and `filterScoping.ts:53-58` (row scoping honors it too). Consumed at
  `StudioChartWidget.tsx:138` / `:625` (`hasIncomingCrossFilters`, passed to every
  renderer for hover/highlight gating and used by
  `hasIncomingCrossFilterOnDependency`, `:257-271`).

- **What's wrong:** With the dashboard-level "apply cross-filters across pages" toggle
  on (`setCrossFilterAllPages(true)`), a cross-filter emitted on page A **does**
  filter/ghost a chart on page B (`useWidgetRows` scoping honors the flag, so
  `filteredRows`, `shouldShowGhost`, ghost baselines are all active), but the page-B
  chart's `incomingCrossFilters` is empty — so the renderer-level gating that depends
  on `hasIncomingCrossFilters` (stale-hover suppression, cross-filter dependency
  checks driving highlight state) behaves as if no cross-filter were incoming. The
  data and the interaction layer disagree about the same filter. Minor/visual in
  impact, but it is a genuine split-brain between two "is this cross-filter active
  here" definitions that the architecture elsewhere goes out of its way to unify
  (cf. the shared `isActiveCrossFilter` predicate).

- **Fix direction:** Give `makeSelectIncomingCrossFilters` an `allPages` parameter
  (or read `state.doc.dashboard.crossFilterAllPages` inside the selector) and match
  `useWidgetRows`' predicate: `crossFilterAllPages || f.scope.pageId === pageId`.

---

## Documentation accuracy (ARCHITECTURE.md cross-check)

### D.1 Cross-filter undoability described contradictorily

`ARCHITECTURE.md:74` says `{ undoable: false }` is "used for transient doc writes like
interactive/**cross-filter** selection", but `ARCHITECTURE.md:68` ("`applyCrossFilter`
is deliberately undoable"), `:108` ("Cross-filter entries themselves are NOT carried,
because they are undoable by design"), and the code
(`StudioController.ts:1744-1773` — `applyCrossFilter` commits with the default
`undoable: true` and a log label; only `applyInteractiveFilter` at `:1694-1723` passes
`{ undoable: false }`) all agree that cross-filters ARE undoable. Line 74 should say
"interactive-filter selection" only.

Everything else spot-checked in the doc matched the code, including: the three-partition
state model and `commitState`/`commitMutations` semantics; `carryTransientDocState`'s
interactive/toggle/`activePageId`/`doc.ai` carry list; `commitDocPatch`'s no-op guard
and the identity-preserving doc transforms; `setDashboardDateRangeAll`'s
additive/field-preserving reconciliation; the L1–L4 cache dependency-tracking
descriptions (including `collectJoinedSourceIds` / `collectReadSourceIds` threading and
the `rcfa` anchor-filter cache key); `filterFingerprint`'s relative-date day-folding;
the adapter `count`/`avg`+`xGroupBy`/cross-filter aggregation-strip routing and the
`${widgetId}::${cacheKey}` batch id; `StudioRequestCache`'s generation tagging and LRU
cap; and `useWidgetRows`' three baselines and adapter-path rank re-application.

---

## Areas examined with no actionable findings

- `filterUtils.ts` (operator compilation incl. `between` fail-closed, day-granular
  date equality, rank ordering after condition filters), `filterScoping.ts`,
  `resolvedRowsCache.ts` (fingerprint coverage, LRU, absence-as-null dependency
  records), `enrichedRowsCache.ts` (transitive dependency expansion, joined-source
  tracking incl. nested joins), `computedCache.ts`, `crossSourceEnrichment.ts`
  (incl. row-identity tagging), `normalizedRowsCache` call sites.
- `aggregators.ts` (per-series aggregation precedence, count = COUNT(\*) semantics,
  rank-on-aggregated helpers incl. numeric-series-name coercion),
  `expressionEvaluator.ts` (cycle guards at both write and eval time, measure null
  policy, normalized join keys; note: a join expression nested inside a function
  bypasses the prebuilt index and falls back to the O(N×M) slow path — correct, just
  slower; not reported as a finding).
- `StudioController.ts` end to end: undo/redo doc-swap fix-ups, `commitMutations`
  transform-after-fold no-op logic, unknown-id guards on every transform, adapter
  same-reference/upsert/prune lifecycle (with `StudioDashboard`'s re-application
  contract), `duplicateWidget` composition (shared `config` reference is safe under
  the immutable-update discipline), session serialize/restore.
- `docTransforms.ts` (identity preservation on every no-op path; preset re-id on
  apply).
- `queryDescriptor.ts` / `createBatchingAdapter.ts` interplay for the new
  `hasIncomingCrossOrInteractiveFilters` strip (cache-key folding only when
  aggregations exist is correct in both directions), rank-field SELECT widening,
  nested-join FK widening.
- `useAdapterRows.ts` + `StudioRequestCache.ts` (mid-flight invalidation, in-flight
  dedup, cancelled-effect loading-state reset).
- `StudioGridWidget`'s fan-out-safe aggregation (dedupe-key fallback to the
  materialized row id is sound given the grid's synthetic-id row memo) and
  `widgetExport.ts` (cross-source enrichment on export, adapter-cache seeding).

## Summary

- **Tier 1: 1 finding** (1.1 — M:N remote dimension + widget-owned measure silently
  aggregates against only the first junction link per row).
- **Tier 2: 4 findings** (2.1 support-guard expression-field scoping split-brain;
  2.2 blended foreign-series scoping — cross-page leak, unresolved presets, dropped
  expression fields; 2.3 L4 M:N remote-filter resurrection; 2.4
  `makeSelectIncomingCrossFilters` vs `crossFilterAllPages`).
- **Doc: 1 accuracy fix** (D.1 cross-filter undoability wording at
  `ARCHITECTURE.md:74`).
