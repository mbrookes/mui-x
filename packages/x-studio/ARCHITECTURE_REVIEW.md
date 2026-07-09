# x-studio architecture review — iteration 6 (fresh)

Synthesized from five independent, exhaustive sub-reviews covering: (1) store/context/state
(`StudioController.ts`, `docTransforms.ts`, `Studio`/`StudioDashboard`/`StudioContent` shell,
keyboard shortcuts), (2) data pipeline internals (L2/L3/L4 caches, grain resolution, adapters,
filter/rank semantics), (3) AI/chat/privacy (`StudioChatPanel`, `useTextWidgetAI`,
`studioBackendAdapter`), (4) widget renderers (chart/grid/kpi/map/pivot), and (5) UI shell/canvas/
compose-drawer/filters-drawer/edit-dialog/i18n. Each sub-review verified its claims against current
source (file/line) and cross-checked `ARCHITECTURE.md`'s documented invariants before reporting;
several findings were confirmed via an executed repro (vitest run), not just static tracing.
Overlapping findings describing the same root cause from different angles are merged below.

## Tier 1 — real bugs with concrete failure scenarios

### 1.1 `StudioDashboard` config swap never (re-)registers adapters for sources the new config introduces or re-adds

- **Files**: `components/Studio/StudioDashboard.tsx:158-208`, `store/StudioController.ts:713-729`
- The `dataAdapters` registration effect runs only on `[dataAdapters]` identity change; the
  config-swap effect runs only on `[config]` and never re-applies `dataAdapters`. Since
  `setDataSourceAdapter` no-ops when the source doesn't exist yet (and hosts are steered toward a
  **stable** `dataAdapters` map, precisely so they don't need to pass a fresh object each render),
  the two effects can permanently miss each other.
- **Repro A**: host mounts with a stable `dataAdapters = { orders, customers }` and a config using
  only `orders`. At mount, `setDataSourceAdapter('customers', …)` no-ops (source doesn't exist yet).
  Later the host swaps in a config that adds the `customers` source — it's installed adapter-less,
  the adapters effect never re-runs, and every `customers` widget silently renders from (usually
  absent) static rows. **Repro B**: config B drops `orders`, config C re-adds it — the adapter
  registered at mount is gone and never re-applied.
- **Fix direction**: after the upsert/prune loop in the config-swap effect, re-apply the current
  `dataAdapters` (read via a ref so the effect's deps stay `[config]`), relying on
  `setDataSourceAdapter`'s existing same-reference guard for idempotence.

### 1.2 L3 `resolvedRowsCache` misses the joined-source-rows dependency of L2 enrichment (confirmed via executed repro)

- **Files**: `internals/resolvedRowsCache.ts:114-147`, `internals/dataSourceGraph.ts:200-209, 288-299`
- `resolveRows` enriches widget rows (and each cross-filter's foreign rows) via
  `getCachedEnrichedRows`, but never threads that function's `collectJoinedSourceIds` out-param into
  its own cache-validity tracking — the mechanism the L4 `rcfaCache` already uses. A
  `JoinFieldExpression` column's _target_ source is therefore invisible to the L3 cache entry.
- **Repro (executed)**: widget on `orders` with expression column `customer_name =
join(customers.name)`; host refreshes `customers` rows via `setDataSourceRows` (`orders` rows ref
  unchanged) → the cache keeps serving the old entry, and every widget on `orders` shows stale
  customer names — including filters _on_ that expression column, which keep matching against the
  stale values — until an unrelated cache-key change happens.
- **Fix direction**: thread a `collectJoinedSourceIds` set through both `getCachedEnrichedRows`
  calls in `resolveRows` into `crossFilterSourceRows`'s dependency tracking.

### 1.3 Many-to-many anchor branch drops third-source dimension fields the support guard promised (confirmed via executed repro)

- **File**: `internals/grainResolution.ts:117-161`
- `analyzeChartSupport` reports "supported" for a config whose y lives on the M:N junction while
  x/series is owned by a _third_ source reachable many-to-one from the widget source. But the M:N
  branch of `resolveRowsAtGrain` merges only `{...widgetRow, ...remoteRow, ...jRow}` — it never
  calls `enrichRowsWithRelatedFields` for the third source (unlike the many-to-one branch), and
  ignores expression enrichment for junction-owned expression fields.
- **Repro (executed)**: orders⇄products via `order_products`, chart y=`order_products.quantity`,
  x=`customers.segment` (orders→customers many-to-one): support guard says supported, anchor =
  junction, output rows have `segment === undefined` → every row falls into an empty-x bucket / gets
  skipped — chart renders blank while claiming the config is supported.
- **Fix direction**: in the M:N branch, run `enrichRowsWithRelatedFields` for the third source
  before building the row lookup (mirroring the many-to-one branch), and honor expression
  enrichment for junction-owned expression fields.

### 1.4 L4 re-anchoring reads raw (unfiltered) anchor rows, resurrecting rows an anchor-source filter excluded

- **File**: `internals/grainResolution.ts:150, 189`
- L3 applies an anchor-source-field filter as a semi-join (keep widget rows with ≥1 matching anchor
  row). L4 then expands each surviving widget row back to **all** of its anchor rows read directly
  from the unfiltered data-source store — re-including exactly the anchor rows the filter excluded.
- **Repro**: chart on `customers` (x=`segment`, y=`orders.amount`, anchor=`orders`) with a page
  filter or chart-click cross-filter `orders.status = 'paid'`. Rendered value = sum of **all**
  orders (paid + unpaid) for customers with at least one paid order, instead of the sum of paid
  orders — contradicting standard SQL JOIN+WHERE semantics and the app's own same-source filtering.
  A cross-filter click therefore highlights/filters to numerically wrong bars.
- **Fix direction**: apply the anchor-source-scoped subset of the widget's resolved filters to the
  anchor rows before the expansion join, in both the M:N and many-to-one branches.

### 1.5 `useTextWidgetAI`'s snapshot memo ignores `doc.filters`/`doc.expressionFields`/`doc.relationships` — AI text describes stale, pre-filter data

- **File**: `components/widgets/StudioTextWidget/useTextWidgetAI.ts:169-192`
- The snapshot memo's reactive triggers are `selectActivePage`, `selectDashboard`, `selectWidgets`,
  `selectDataSources` — none of which change identity when a filter is added/edited (filters live at
  `doc.filters`, a separate partition). The memo's own comment documents this exact bug class for
  `widgets`/`dataSources` but missed the filter partition.
- **Repro**: user adds a page filter ("region = EMEA"); every sibling widget re-renders filtered,
  but the text widget's AI narrative still describes the unfiltered numbers — and clicking
  "refresh" resends the same stale snapshot (the refresh effect keys off the memoized snapshot,
  and `refreshSeq` isn't a memo dependency), regenerating the same wrong analysis.
- **Fix direction**: add `selectFilters`/`selectExpressionFields`/`selectRelationships` as reactive
  triggers on the snapshot memo.

### 1.6 Grid widget ignores `crossFilterMode: 'none'` and the dashboard-wide `globalCrossFilterMode` override

- **File**: `components/widgets/StudioGridWidget/StudioGridWidget.tsx:335-343, 553`
- The grid resolves its mode locally as `widget.config.crossFilterMode ?? 'cross-highlight'`, but
  the row baselines it actually consumes come from `useWidgetRows`, which resolves
  `globalCrossFilterMode ?? config.crossFilterMode ?? 'cross-highlight'`. The grid destructures only
  `filteredRows`/`filteredRowsNoChartCross` — never `effectiveRows` — so both the widget-level
  `'none'` setting and the dashboard-wide mode toggle are silently ignored.
- **Repro**: set the grid's Interactions to "None" (offered by `GridSetupPanel`), click a bar in a
  sibling chart — the grid's rows and summary row shrink to the selection anyway. Every other widget
  kind (chart/KPI/map/pivot, and CSV export) is global-mode-aware; the on-screen grid is the one
  holdout.
- **Fix direction**: resolve the effective mode the same way `useWidgetRows` does (or export the
  resolved mode from it), and use `effectiveRows`/`filteredRowsNoCross` for `'none'`.

### 1.7 Date-range bar's coverage-reconciliation effect silently and non-undoably deletes a `'custom'` dashboard date range

- **Files**: `components/StudioCanvas/StudioDateRangeBar.tsx:99-126`, `store/docTransforms.ts:69-97, 155-198`
- The reconciliation effect fires whenever any source lacks a `dashboard-date-range` filter on its
  first date field, calling `setDashboardDateRangeAll(..., activePreset, undefined, undefined,
{undoable: false})` — always passing `undefined` for custom bounds. For `activePreset ===
'custom'`, this builds an empty filter set, whose length mismatch against the existing custom
  filters triggers a commit that **removes every existing custom date-range filter for the page**,
  and because the commit is non-undoable, **there's no Ctrl+Z recovery**.
- **Repro**: an AI tool call or host sets a custom range on a dashboard with 2+ sources (or a second
  source is injected after a persisted single-source custom range loads). On the next render, the
  custom range vanishes and the Select flips to "All time" — no user action, no undo.
- **Fix direction**: when `activePreset === 'custom'`, read existing `from`/`to` from the current
  filter and thread them through the reconciliation call (or skip reconciliation for `'custom'`
  entirely); make the reconciliation additive (only create filters for sources actually missing
  coverage) rather than rebuild-all.

## Tier 2 — design inconsistencies / missing safeguards

- **2.1** AI-driven `setActivePage`/`renameAIThread` wire mutations push dead undo entries that
  destroy the redo stack: both mutations touch only transient-carried doc fields (`activePageId`,
  `doc.ai`), so their undo entry can never actually revert anything — `carryTransientDocState`
  overlays the current value right back — yet the commit still clears the redo stack. The
  controller's own `setActivePage` already special-cases `undoable: false`; the AI wire path
  (`executeToolOnState.ts`'s `applyExternalMutation`) doesn't. (`store/StudioController.ts:444-460,
162-170, 277-339`)
- **2.2** `setAdjacentWidgetColSpans` has no value-equality no-op guard: a resize-handle click with
  zero pointer movement still commits a fresh spans record, pushing a phantom undoable entry and
  clearing the redo stack — the exact click-without-move case the sibling cancel-drag path already
  guards against. (`store/StudioController.ts:1069-1101`, `RowResizeHandle.tsx:155-176`)
- **2.3** Config swap / `loadSerializedState` force-resets `session.mode` to `'edit'`: initial mount
  respects `config.session.mode`, but a subsequent `config` prop swap goes through
  `deserializeState`, which hardcodes `mode: 'edit'` — silently flipping a view-mode embed into
  edit-mode layout (drag affordances appear, quick-filter/cross-filter bars vanish) on the first
  config refresh, even with `compose: false`. (`x-studio-schema/src/statePersistence.ts:509-515`,
  `store/StudioController.ts:2104-2121`)
- **2.4** Rank-vs-condition filter ordering diverges between the in-memory and adapter paths (rank
  applied globally-then-EU-filtered in-memory vs. EU-filtered-then-ranked on adapters) — same
  dashboard, different numbers depending on whether the source is adapter-backed.
  (`internals/filterUtils.ts:440-469`, `internals/useWidgetRows.ts:317-360`)
- **2.5** `rankByField` never enters `usedFieldIds`/the adapter SELECT: a "top 5 by profit" rank
  filter on a chart displaying revenue fetches rows without a `profit` column on adapter sources,
  so the aggregate-rank path computes `Number(row['profit'] ?? 0)` = 0 for every row → arbitrary
  "top 5" in insertion order. (`internals/useWidgetRows.ts:213-223`)
- **2.6** Disabled widget rank filters still apply to charts: `widgetRankFilter`'s match has no
  `!f.disabled` guard, unlike every other filter-selection path. Toggling a Top-N filter off in the
  drawer leaves the chart still reduced to N categories. (`useChartWidgetData.ts:81-88`)
- **2.7** `utils/gridGrouping.ts` (`buildGroupedGridRows`/`symmetricAggregate`) is dead in
  production — the live grid grouping path uses DataGridPremium's native
  `rowGroupingModel`/`aggregationModel` over rows already fanned out by per-widget-row cross-source
  enrichment, double-counting exactly the fan-out `symmetricAggregate` exists to dedupe.
  `fanOutGolden.test.ts` only exercises the unreached helper. ARCHITECTURE.md's claim that grids
  "substitute `gridGrouping.ts`" is stale.
- **2.8** Adapter push-down silently drops a valueless second filter condition (`is_empty`/
  `is_not_empty` with no value): `hasSecondCondition`'s `value2 !== undefined` check doesn't match
  the in-memory evaluator's `isConditionComplete`, which treats valueless operators as present.
  (`server/createBatchingAdapter.ts:1216-1230`)
- **2.9** Incoming cross-filters/interactive filters empty out server-aggregated adapter widgets:
  they're enforced client-side over rows that, when the descriptor pushed aggregation down, are
  one-per-group with only grouped/alias columns — a cross-filter on any other field reads
  `undefined` and drops every row. Clicking a bar in chart A can blank an unrelated adapter-backed
  chart B. (`internals/useWidgetRows.ts:317-361`)
- **2.10** Nested join expressions lose their FK column on the adapter path:
  `expandToNativeFields` handles a top-level `JoinFieldExpression` but a `FunctionExpression`
  wrapping one (e.g. `if(customers.country == 'US', 1, 0)`) contributes neither the logical field
  nor the FK to the SELECT — client re-enrichment then evaluates against `undefined`, silently
  taking the else-branch on every row. (`internals/queryDescriptor.ts:100-111`)
- **2.11** Simple-mode batching adapter emits `ORDER BY <expression-field-id>` unresolved, failing
  the whole batch entry with "no such column" when the ORDER BY field is a calculated field —
  relationship-aware mode already strips this case, simple mode doesn't.
  (`server/createBatchingAdapter.ts:919`)
- **2.12** Blended mixed chart: two series sharing a field id across different sources are
  config-matched to the same `ySeries` entry (`find` by `fieldId` alone) — the second series renders
  with the wrong chart type/label/format/axis routing, even though its data values are correct.
  (`components/widgets/StudioChartWidget/StudioMixedChart.tsx:80-91, 124-137`)
- **2.13** Cross-filter "filtered / total" tooltip text is hardcoded English
  (`chartWidgetHelpers.ts:281, 302` — `"(filtered out)"`) with no locale token, unlike everything
  else in the same tooltip.
- **2.14** View-mode widget toolbar (export/expand) is mouse-hover-only — `showViewActions` gates on
  a `hovered` flag set only by `onMouseEnter`, with no `:focus-within` equivalent; a keyboard-only
  user can never reach these actions in view mode (edit mode has a keyboard path via card
  selection). (`components/StudioWidgetCard/StudioWidgetCard.tsx:393`)
- **2.15** Date-only values day-shift on display for viewers west of UTC: Gantt chart items and
  `formatAbsoluteDate` parse canonical `'YYYY-MM-DD'` via `new Date(raw)` (UTC midnight) then format
  via local `toLocaleDateString` — the display-side twin of the ingestion day-shift bugs prior
  iterations already fixed. (`StudioGanttChart.tsx:24-30`, `internals/widgetUtils.tsx:306-315`)
- **2.16** Autocomplete `'reset'` echo destroys the redo stack ~150ms after an undo/redo of a
  string-filter value: an external value change (undo, redo, preset apply, AI mutation) triggers
  MUI's Autocomplete reset effect, which calls `onInputChange(value, 'reset')`; the drawer's
  free-solo handler schedules its debounce unconditionally, eventually re-committing the
  content-identical value as a fresh, undoable, redo-clearing commit.
  (`components/StudioFiltersDrawer/FilterValueInput.tsx:192-215`, `store/StudioController.ts:1492-1541`)
- **2.17** The non-undoable operator "self-repair" effect can permanently rewrite a valid date/
  number operator to `'equals'` when the field type is transiently unresolvable (async adapter
  source not yet injected): `getOperators(undefined)` returns STRING_OPERATORS, the effect sees a
  stored `between`/`greater_than` as "invalid" for a string field and rewrites it — a persisted,
  non-undoable doc change triggered merely by rendering the drawer during a load race.
  (`components/StudioFiltersDrawer/PageFilterRow.tsx:48, 108-122`, `WidgetFilterRow.tsx:62, 117-131`)
- **2.18** Widget-edit dialog's `FilterRow` renders rank- and selection-mode filters through a
  condition-only editor: `WidgetFiltersPanel` only excludes `dateRangePreset` filters, so a
  selection filter's array value renders/commits as a joined string (silently deactivating it) and
  a rank filter gets a meaningless operator select that can write junk keys onto it.
  (`components/StudioWidgetEditDialog/WidgetFiltersPanel.tsx:76-85`, `FilterRow.tsx:268-275`)
- **2.19** Switching an existing condition filter to Rank mode doesn't clear a non-numeric `field`:
  `buildModeReset` doesn't touch `field`, so a filter already configured on a string field can flip
  to rank mode and keep it — the numeric-rank sort then produces `NaN` comparators (no-op sort),
  showing an arbitrary "Top N" with no feedback. (`components/StudioFiltersDrawer/filterDrawerUtils.ts:302-313`)
- **2.20** `SelectionFilterInput`'s high-cardinality cap hint is hardcoded English, self-acknowledged
  in a code comment deferring "a follow-up localization pass" that never happened.
- **2.21** No `privateMode` regression test exists for the main chat adapter
  (`studioBackendAdapter.test.ts`, 926 lines, zero occurrences of `privateMode`) despite this being
  the exact class of bug (privateMode bypass) found and fixed twice in prior iterations for the
  other two AI request paths — a refactor could silently reintroduce the bug here with no test to
  catch it.
- **2.22** Overlay chat panel has no dialog semantics: no `role="dialog"`/`aria-labelledby`, no
  Escape-to-close handler anywhere in the file (despite the `onClose` JSDoc promising "close button
  or backdrop click" — no backdrop exists either), no focus management on open/close.
  (`components/StudioChatPanel/StudioChatPanel.tsx:97, 490-544`)
- **2.23** Single fixed text-part id merges post-tool-call assistant text into the pre-tool-call
  text block, rendering the conclusion spliced above a dangling tool card instead of below it, on
  any multi-step agentic turn with a preamble. (`components/StudioChatPanel/studioBackendAdapter.ts:181, 326-336`)

## Tier 3 — minor / cosmetic / test-coverage gaps

- `usePageChartColors` is a stub returning `undefined` — the entire `chartColors` prop chain
  through bar/pie/scatter/KPI-sparkline/widget-card is permanently dead code.
- Anomaly `trimEdges` trims by array index, not chronological period — wrong points get suppressed
  when `chartSortBy: 'value'` is active.
- Hex-alpha string concatenation (`${baseColor}40`) for pie-ring dimming silently breaks (renders
  fully opaque) when a host supplies a non-hex color (`var(...)`, `rgb(...)`) — already documented
  as a known footgun in a sibling file's comment but not fixed here.
- i18n stragglers: Gantt tooltip "Duration:", slider min/max aria-labels, adapter-cache-miss CSV
  message, expand-dialog fallback title "Chart", built-in geography labels, `Intl.DisplayNames`
  pinned to `'en'`, chat panel `displayName: 'You'`, chat suggestion chips' submitted English prompt
  text (visibly rendered as "the user's own message" even under a non-English locale), speech
  recognition never setting `recognition.lang`.
- KPI's local `crossFilterMode` resolution omits `globalCrossFilterMode` (may be deliberate
  grand-total semantics, but diverges silently from the documented precedence); KPI's "ignoring
  filters" info icon doesn't check `pageId`/`disabled`, so it can show for filters that would never
  apply.
- Single-series bar ghost "Other" bucket sum can exceed its own baseline due to an empty-label
  inclusion mismatch between the ghost and baseline aggregation.
- `exportChartToPng` has no `img.onerror`, leaking an object URL and silently no-oping on a failed
  SVG-blob load.
- Cross-filter chip label ignores expression fields, showing the raw field id instead of its label.
- Forecast lower confidence band clamped at 0 unconditionally — wrong for legitimately negative
  series (net margin).
- ARCHITECTURE.md line documenting multi-Y line/area cross-highlight as a deliberate no-op is now
  stale (the behavior was fixed by a prior iteration; the doc wasn't updated).
- An empty active page unmounts every keep-alive page (the `isEmptyPage` branch skips the
  `mountedPageIds` keep-alive container entirely), defeating the clip-path keep-alive design for
  every _other_ mounted page whenever the active one happens to be empty.
- Static DOM id in `FieldDetailView.tsx` (`labelId="field-number-format-label"`) breaks the
  documented multi-instance guarantee (duplicate ids across two mounted `<Studio>`s);
  `StudioDateRangeBar.tsx` already demonstrates the `React.useId()` fix elsewhere in the same
  package.
- Per-column aggregation menus in `GridSetupPanel` are keyed by bare `fieldId`, colliding for
  cross-source columns sharing a field id with a primary column.
- `CrossFilterModeSection`'s deselect-click on an already-`undefined`-mode button commits an
  undoable no-op (new config key, zero visual effect).
- Filters drawer lists interactive filters from all pages (no `pageId` check), while the filter
  engine correctly scopes them to the active page — cosmetic drawer/engine mismatch.
- Various dead/misleading fallback strings and doc/impl mismatches (nonexistent `fetchRows` method
  in `StudioDashboard` JSDoc; `chatBox.messages`"cannot be overridden" docstring contradicted by
  actual honor-if-present code; `filterFingerprint` foldig in a dead `disabled` key already filtered
  out upstream).
- `getExpressionFieldReferenceCount` misses `rankByField`/`rankMultiSeriesBy` references, so
  deleting a measure used only as a rank's sort key reports zero references.
- Test gaps (numerous, tied to the findings above): no test for L3 joined-source-row invalidation;
  no M:N third-source dimension test; no sync-vs-adapter rank-ordering test; `gridGrouping`'s golden
  test asserts an unreached path; no date-range-bar reconciliation test; no Autocomplete-reset-echo
  regression test; no `WidgetFiltersPanel` test with a rank/selection-mode filter; no grid
  `crossFilterMode: 'none'` test; no `privateMode` test for the main chat adapter;
  `generateInsight.test.ts` doesn't cover per-series `yAggregation`/rank/heatmap paths.

## Suspected, then cleared (verified sound, not findings)

`commitMutations` no-op/transform ordering; `__cacheKey__` reselect-tag survival across commits;
`StudioRequestCache` generation/in-flight-race handling; `carryTransientDocState`'s
interactive-filter pruning; `duplicateWidget`'s unconditional selection transform (safe — its fold
can never no-op); `enrichedRowsCache`'s forward-only relationship tracking (matches the expression
evaluator's own forward-only join resolution — no asymmetry); `avg` push-down without `xGroupBy`
(mathematically an identity, not a bug); batching-window result cross-wiring
(`batchEntryId`-keyed, safe); heatmap/sankey adapter GROUP BY (the middleware groups by every
selected non-measure column, so extra dimensions survive); grid CSV export's cross-filter-mode
resolution (unlike the on-screen grid, the export path already reads `globalCrossFilterMode`
correctly); mid-stream chat thread-switch controlled-prop resync (suppressed correctly via
`syncingControlledModelsRef`); mid-stream stop finalization (x-chat's own abort listener handles
it independent of the adapter's chunk); `selectSampleRows` anomaly-reservation arithmetic (bounded
correctly); server-controlled `kind`/`sourceId` in AI-created widgets (fail-closed via
`Object.hasOwn` checks and `sanitizeServerWidgetConfig`); canvas drop-target/resize-observer
staleness across empty↔populated transitions (fixed correctly in iteration 5 — re-verified);
`KpiSetupPanel`'s aggregation repair loop (self-terminating, non-undoable, never destructive unlike
the filter-operator repair effect above).
