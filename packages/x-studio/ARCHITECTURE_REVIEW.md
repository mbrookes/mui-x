# Architecture review — iteration 10 (fresh, ground-up)

Scope: `packages/x-studio` working tree as of `0267aa9`. Everything below was re-derived
from current source, not carried over from prior rounds. Per this round's directive, each
cross-cutting pattern found (or fixed in a prior round) was explicitly swept across **all
seven widget kinds** plus the export / AI-summary / pipeline-façade consumers; the sweep
matrix is at the end.

Finding count: **1 Tier 1, 6 Tier 2**.

---

## Tier 1

### 1.1 Map widget: a related-source _calculated_ (expression) field as `mapValueField`/`mapCountryField` never resolves — blank map, wrong "No data"

The iter-9-era fix for "related-source calculated columns need an L2 pass before the
cross-source join" was applied **inside the grid widget only**, as a supplemental local
pass — the shared enrichment call that the map widget relies on was left unfixed. The
grid's own comment documents the shared gap it is compensating for:

- `src/components/widgets/StudioGridWidget/StudioGridWidget.tsx:478-511` — "`useWidgetRows`'s
  cross-source enrichment reads the related source's RAW rows, so a related-source
  _calculated_ column resolves to `undefined`. Supplementally L2-enrich just those columns
  here…" (grid = fixed locally).
- `src/internals/useWidgetRows.ts:507-519` — the shared `enrichIfNeeded` calls
  `enrichWithCrossSourceFields(rows, widget.sourceId, allCrossSourceFieldRefs, dataSources,
relationships)` **without the `expressionFields` parameter**. The function's expression
  handling (`src/internals/crossSourceEnrichment.ts:70-124`) is entirely gated on that
  parameter (`if (expressionFields.length > 0)`), so with it omitted the related source's
  raw rows are indexed and the calculated column copies `undefined` onto every widget row.
- The map widget is the _other_ consumer of this shared pass: `mapCrossSourceFields`
  (`useWidgetRows.ts:480-494`) feeds `mapCountryField`/`mapValueField` refs into the same
  un-parameterized call, and `StudioMapWidget` has **no** supplemental pass of its own.

**Reachable from the UI**: `MapSetupPanel` deliberately offers expression fields from
_every_ visible source in both pickers — string expression fields for the region field
(`src/components/StudioComposeDrawer/MapSetupPanel.tsx:71-88`) and numeric expression
fields for the value field (`MapSetupPanel.tsx:120-140`) — and stores
`mapValueSourceId`/`mapCountrySourceId` when the picked field's source differs from the
widget's (`MapSetupPanel.tsx:154-172, 215-221`).

**Failure scenario**: widget on `orders`, related source `customers` has a calculated
numeric field `lifetime_value` (or a calculated string field `country_normalized`). Pick it
as the map's value (or region) field. Every row's enriched value is `undefined`;
`coerceAggregateValue` skips every row (`StudioMapWidget.tsx:315-318`) — for a value field
the map renders every region blank/absent; for a region field `normalize(undefined)` nulls
every row and the widget shows the "No data" overlay while the setup panel says the
configuration is valid.

**Additional affected sites (fix together, same invariant):**

- `src/components/widgets/StudioMapWidget/StudioMapWidget.tsx:183-198` — the value-field
  `fieldDef` lookup for the cross-source case checks `dataSources[valueSourceId]?.fields`
  only, never that source's expression fields, so even once the value resolves, a
  cross-source calculated field loses its format/currency/precision in tooltip + legend
  (the same-source branch right below it _does_ fall back to `expressionFields`).
- `src/components/StudioChatPanel/generateInsight.ts:676-682` — `buildMapWidgetSummary`'s
  own `enrichWithCrossSourceFields` call also omits `expressionFields`, so the AI-facing
  map summary has the identical blind spot (today it "agrees" with the broken render; after
  fixing the render it must be fixed too or the two diverge).

**Fix direction / invariant**: _every_ `enrichWithCrossSourceFields` call site passes the
expression-field list (the function already scopes the L2 pass to only the requested
calculated-column ids, so this is cheap); the widget-local supplemental pass in
`StudioGridWidget` then becomes redundant and can be removed rather than kept as a second
idiom. `useWidgetRows` already subscribes to the right scoped list (`expressionFields` from
`relevantSourceIds`, line 166-170) — it just doesn't thread it through. Note the map's
FK-dedup (`valueFkField`, `StudioMapWidget.tsx:175-181`) already keys off the FK and is
unaffected by this change.

(Related, deliberate-but-worth-recording: `enrichWithCrossSourceFields` only supports
direct many-to-one relationships (`crossSourceEnrichment.ts:98-104`), while `MapSetupPanel`
offers fields from _all_ visible sources including unrelated / M:N-only-reachable ones —
such a pick silently renders a blank map with no support warning, unlike the chart's
`analyzeChartSupport` fail-closed overlay. Not counted as a separate finding since the
"full universe" picker is documented as intentional, but the map is now the only
cross-source-capable widget kind with no support guard at all.)

---

## Tier 2

### 2.1 Widget-scoped **rank** (Top-N) filters are authorable on grid / KPI / map / pivot / filter widgets but are applied by **no** data path — silently ignored

`selectFiltersForWidget` unconditionally excludes `filterMode === 'rank'` from the
`widget` scope (`src/internals/filterScoping.ts:49`). The only post-aggregation
re-application in the package is the **chart** hook's `widgetRankFilter`
(`src/components/widgets/StudioChartWidget/useChartWidgetData.ts:123-136`, applied via
`applyRankTo*` throughout that file) and its AI-summary mirror
(`generateInsight.ts`). `useWidgetRows` collects `widgetScopedRankFilters` **only to widen
`usedFieldIds`** (`src/internals/useWidgetRows.ts:225-231, 244-257`) — it never applies
them on either the sync or the adapter path.

Meanwhile the authoring surface offers rank mode for every widget kind with the
`widgetFilters` capability: grid/kpi/filter/pivot/map are all `widgetFilters: true`
(`src/internals/builtinWidgetDefs.ts:176, 200, 225, 238, 249`), and
`WidgetFilterRow`/`FilterModeToggle` gate the Rank toggle only on per-page rank uniqueness,
never on widget kind (`src/components/StudioFiltersDrawer/WidgetFilterRow.tsx:89-90,
180-184`, `FilterModeToggle.tsx:41-47`). Note the contrast: a **page-scoped** rank filter
IS applied to every widget kind as a dataset-level reduction
(`src/internals/filterUtils.ts:449-495`), so the semantics for non-chart kinds already
exist and work — only the widget-scoped variant falls through the crack.

**Failure scenario**: user opens the filters drawer with a grid (or pivot/map/KPI)
selected, adds a widget filter, switches it to Rank ("Top 5 regions by revenue"). The
filter commits (the controller's rank guards only check page-uniqueness), renders as an
active filter card in the drawer — and has zero effect on the widget, with no warning.

**Fix direction / invariant**: a filter that is authorable against a widget kind must be
enforced by that kind's data path. Either (a) apply widget-scoped rank filters for
non-chart kinds at L3 exactly like page-scoped ones (append them to the scoped set in
`useWidgetRows.computeFilteredRows` for non-chart widgets — `applyFilters`' existing
"filter then rank" dataset reduction is the correct semantics for grid/pivot/map/KPI rows),
or (b) pass a per-kind `disableRank`/hide-rank flag down from the drawer so the mode cannot
be authored where nothing applies it. (a) is preferred; it matches the page-scope
precedent.

### 2.2 Cross-page widget move and filter-preset apply can create the "two rank filters on one page" state every other writer guards against

Iter 9 fixed `duplicateWidget`'s rank-filter bypass; the same-shaped sibling paths were
missed:

- `src/store/StudioController.ts:2078-2109` (`commitWidgetMove`, reached by `moveWidget`
  :2116 — canvas drag-and-drop across pages — and `moveWidgetToPage` :2149 — context menu):
  moving a widget that carries a widget-scoped rank filter onto a page whose context
  already has a rank filter (a page-scoped one, or another widget's) lands two rank filters
  in one page context. `addFilter` (:1555-1566), `updateFilter` (:1626-1633), and
  `duplicateWidget` (:1499) all run `hasConflictingRankFilter`; the move paths run nothing.
  A widget-scoped rank filter follows its widget (`resolveRankFilterPageId` resolves its
  page via the page's `widgetRows`), so the conflict materializes exactly at the move.
- `src/store/docTransforms.ts:356-397` (`applyFilterPreset`): `saveFilterPreset` captures
  page filters _including_ a rank-mode one (:301-333, no rank exclusion); applying that
  preset replaces the active page's **page** filters but leaves widget-scoped filters of
  the page's widgets untouched — so a preset containing a page rank filter applied to a
  page that already has a widget-scoped rank filter produces the same forbidden state. No
  guard runs on this path either.

**Failure scenario**: page A has a chart with a "Top 5" widget rank filter; page B has its
own page-scoped "Top 10" rank filter. Context-menu "Move to page B" on the chart →
two rank filters in page B's context. Both dataset-level reductions then apply
sequentially at L3/aggregation in an order the UI never allows a user to express, and the
filters drawer (whose rank-mode disabling logic assumes at most one —
`WidgetFilterRow.tsx:86-90`) now renders a state its own guard says cannot exist.

**Fix direction / invariant**: every path that can _relocate or re-materialize_ a rank
filter into a page context must run the same shared `hasConflictingRankFilter` check the
add/update/duplicate writers use, guard-and-continue style (drop or disable the incoming
conflicting rank filter with a dev warning, don't block the move/apply itself).

### 2.3 Grid CSV export rebuilds the adapter query descriptor with a drifted signature — false "No data available to export yet" on cache lookup

`runWidgetExport` reconstructs the descriptor to read the same `studioRequestCache` entry
the on-screen grid populated, but calls
`buildQueryDescriptor(widget, filters, pageId, tableName, expressionFields)`
(`src/components/StudioWidgetCard/widgetExport.ts:65-71`) while the on-screen path passes
two more arguments — `relationships` and `crossFilterAllPages`
(`src/internals/useAdapterRows.ts:57-65`). Both feed the `cacheKey`:

- `relationships` widens `select` with the FK column backing a _nested_ join expression
  (`src/internals/queryDescriptor.ts:125-130`) — any widget whose config/filters touch a
  calculated field like `if(customers.country == 'US', 1, 0)` gets a different `select`
  set, hence a different `cacheKey` (:301-311).
- `crossFilterAllPages` flips `hasIncomingCrossOrInteractiveFilters` (:224-230), which is
  folded into the key whenever the widget has aggregations to strip (:308-309) — e.g. a
  grouped grid with an active cross-page cross-filter under the all-pages toggle.

**Failure scenario**: adapter-backed grouped grid displaying rows fine; a nested-join
calculated column is configured (or a cross-page cross-filter is active with
`crossFilterAllPages`). Export → the rebuilt key misses the cache → the code path at
`widgetExport.ts:87-93` downloads the "No data available to export yet. Open the grid so it
can load data…" placeholder even though the grid is open and showing data.

**Fix direction / invariant**: a descriptor is only a valid cache key if it is built with
the _identical_ argument set everywhere; extract one shared "build descriptor for widget
from state" helper used by both `useAdapterRows` and `runWidgetExport` (pass
`state.doc.relationships` and `state.doc.dashboard.crossFilterAllPages` at the export
site), so the signature cannot drift again.

### 2.4 Blended (mixed-chart) foreign series applies another source's filter by field-name collision — `filterSourceId` ignored

`useBlendedSeriesRows`' applicability gate keeps a scoped filter when its `field` exists on
the foreign source or is one of that source's own expression fields
(`src/components/widgets/StudioChartWidget/useBlendedSeriesRows.ts:164-174`) — but never
consults `f.filterSourceId`. Page filters authored in the drawer carry an explicit
`filterSourceId` naming the picked field's owner
(`src/components/StudioFiltersDrawer/PageFilterRow.tsx:183`), and L3 treats
`filterSourceId !== widgetSourceId` as a cross-source **semi-join**, never a native
predicate (`src/internals/dataSourceGraph.ts:237-253`).

**Failure scenario**: mixed chart on `orders` blends a series from `targets`; both sources
have a field literally named `status` (generic column names — `status`, `date`, `total`,
`region`, `name` — collide across CSV uploads constantly). A page filter
`status = 'closed'` authored against `orders` (`filterSourceId: 'orders'`) passes the
field-existence check on `targets` and hard-filters the foreign series against
`targets.status` — a column the author never targeted — while the primary series correctly
semi-joins it through the relationship. The two series silently disagree about scope.

**Fix direction / invariant**: a filter with an explicit `filterSourceId` is only natively
evaluable on that exact source. Add `(!f.filterSourceId || f.filterSourceId === sid)` to
the physical-field branch of the gate (the expression branch already implies ownership via
`ef.sourceId === sid`); an other-source filter stays unconstrained for a foreign series,
matching this module's own documented "must stay unconstrained rather than evaluated
against the wrong column" contract.

### 2.5 KPI hover filter-subtitle: `crossFilterAllPages` omitted (and locale bypass) — the one `selectFiltersForWidget` call in the file that drifts from its four siblings

`src/components/widgets/StudioKpiWidget/StudioKpiWidget.tsx:1094-1099` — the
`filterSubtitle` memo calls `selectFiltersForWidget` without `crossFilterAllPages`, while
every sibling call in the same file passes it (:265-271, :614-620, :787-793, :1009-1015 —
iter 9 added it there specifically so the KPI's scope matches its rendered rows). With the
dashboard-level all-pages toggle on and a cross-filter emitted from another page, the KPI's
headline **is** narrowed by that cross-filter (via `useWidgetRows`) but the hover summary
listing "which filters apply to this KPI" omits it — the exact rendered-vs-described
disagreement the iter-9 fix closed for the numeric paths. Same memo, line :1107:
`summarizeFilter(f)` is called without the `localeText` argument
(`filterDrawerUtils.ts:203-206` defaults to English), bypassing the localization contract
every other `summarizeFilter` caller honors.

Low severity (display-only), but it is the last remaining scope-drifted call site of the
pattern: a repo-wide sweep of all 15 non-test `selectFiltersForWidget` call sites confirms
every other one either passes `crossFilterAllPages` or uses `include: 'no-cross'` (where
the flag is provably irrelevant — the cross-filter branch is the only reader).

**Fix**: pass `crossFilterAllPages` (already subscribed in the component) and `localeText`.

### 2.6 Value-equality bail (iter-9 invariant "no phantom redo-clearing commits"): two sibling writers still missing it

Iter 9 added the value-identical-write bail to `setPageStackBreakpoint`,
`updateActivePage`, `updateRelationship` (whose comment says "matching the sibling
value-equality writers"). Two doc-partition writers of the same shape still commit a
fresh-but-identical object:

- `updateExpressionField` (`src/store/StudioController.ts:854-883`): builds
  `{ ...existing, ...updates }` and a fresh array unconditionally. Re-saving the expression
  dialog with no edits (a real gesture — open, glance, hit Save) pushes a dead undo entry
  and wipes the redo stack.
- `updateFilter` (`src/store/StudioController.ts:1610-1659`): `mapPreservingIdentity`
  protects unknown ids and rejected rank changes, but a value-identical `changes` payload
  still produces `{ ...filter, ...changes }` — reachable from any drawer control that
  re-commits its current value on blur.
- (Same family, cosmetic: `renameFilterPreset` with the unchanged name —
  `src/store/docTransforms.ts:427-430` — builds `{ ...p, name }` fresh.)

Not flagged: `updateDataSourceField` (:810-824) has the same shape but commits through the
non-undoable runtime partition — no undo/redo impact, so it's exempt from this invariant.

**Fix direction**: the same per-key `patch[key] === current[key]` bail `updateRelationship`
uses, inside each mapper.

---

## Cross-cutting sweep matrix (what was checked, per widget kind)

For each pattern fixed in rounds 7–9, every widget kind plus the non-render consumers
(CSV export, `generateInsight`, `StudioPipeline`, `queryDescriptor`) was re-checked in the
current source:

| Pattern                                                                 | chart                                            | grid                                                         | kpi                                                         | map                                                                                                                                                | pivot                                                                 | text | filter                      | export/AI/pipeline                                                                                                                  |
| ----------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------ | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `relevantSourceIds` incl. M:N junction in expression-field subscription | OK (`useChartWidgetData.ts:91-110`)              | OK (`getReachableSourceIds`, `StudioGridWidget.tsx:413-420`) | OK                                                          | own-source only, but map does no L4/L3-cross-routing of its own — shared `useWidgetRows` handles it; cross-source fieldDef gap folded into **1.1** | own-source only — pivot fields are own-source by design (setup panel) | n/a  | own-source only — by design | `generateInsight` OK                                                                                                                |
| `crossFilterAllPages` threading                                         | OK                                               | OK (via `useWidgetRows`)                                     | **2.5** (subtitle only; data paths OK)                      | OK (via `useWidgetRows`)                                                                                                                           | OK (via `useWidgetRows`)                                              | OK   | n/a (emitter)               | `queryDescriptor` OK; `StudioPipeline` documented opt-in; export opts in                                                            |
| `globalCrossFilterMode ?? config ?? default` precedence                 | OK                                               | OK (`StudioGridWidget.tsx:596-614`)                          | OK                                                          | OK (via `effectiveRows`)                                                                                                                           | OK (via `effectiveRows`)                                              | n/a  | n/a                         | export OK (`resolveWidgetRows` options)                                                                                             |
| fan-out/FK-dedup before aggregation                                     | fails closed (support guard)                     | OK (agg fns + footer, `crossSourceFkFields`)                 | fails closed                                                | OK (`valueFkField` dedup)                                                                                                                          | n/a (own-source fields only)                                          | n/a  | n/a                         | insight mirrors map/grid                                                                                                            |
| related-source **expression** field visibility/enrichment               | OK (L4 enriches)                                 | OK (local supplemental pass)                                 | OK (iter-9 fix verified)                                    | **1.1**                                                                                                                                            | n/a                                                                   | n/a  | n/a                         | **1.1** (map insight site)                                                                                                          |
| anchor-scoped filter re-application at L4 (`widgetFilters`)             | OK (`useChartRows` ← `effectiveResolvedFilters`) | n/a (no L4)                                                  | OK (all 4 `resolveChartRowsForAggregation` sites thread it) | n/a                                                                                                                                                | n/a                                                                   | n/a  | n/a                         | `generateInsight` OK; `StudioPipeline.resolveChartRows` exposes params (no production caller omits them — chart export is PNG)      |
| widget-scoped rank filter application                                   | OK (post-agg)                                    | **2.1**                                                      | **2.1**                                                     | **2.1**                                                                                                                                            | **2.1**                                                               | n/a  | **2.1** (authorable, no-op) | insight mirrors chart only                                                                                                          |
| store invariants (iter-9's five) sibling re-check                       | —                                                | —                                                            | —                                                           | —                                                                                                                                                  | —                                                                     | —    | —                           | **2.2** (move/preset rank), **2.6** (value-equality); duplicateWidget/upsertDataSource/mutation-log/redo-clearing re-verified fixed |

Also examined with no findings: `filterScoping.ts` scope switch (incl. rank exclusion
semantics and disabled handling), `dataSourceGraph.resolveRows` expression-ownership
classification, `crossSourceEnrichment` join-key policy and row-identity tagging,
`chartTypeDefs.tsx` renderers (all aggregate `enrichedRows`, none regressed to
`filteredRows`), `useChartRows`, `useAdapterRows` (in-flight dedup/generation guards),
`useBlendedSeriesRows`' failed-refetch clearing, pivot COUNT(\*) semantics and
`buildPivotMatrix` membership, grid footer/grouping dedup and summary field-def merging,
map geography request-id guard and merged-region cross-filter emission, `docTransforms`
date-range identity preservation, `applyFilterPreset`/`saveFilterPreset` `dependsOn`
remapping, filter-widget interactive-filter plumbing, and the chart's period-key
cross-filter conversion (`periodKeyToDateRange`).
