# Architecture

Internal reference for how `@mui/x-studio` is put together. For install/quick-start, see [`README.md`](./README.md).

## Overview

`x-studio` is an embedded analytics dashboard builder: a single `<Studio>` React component that lets end users compose pages of widgets (charts, grids, KPIs, maps, pivots, filters, text) backed by pluggable data sources, with an optional AI chat assistant that can drive the same authoring actions a human would through the UI.

The package is organized around four layers:

1. **State** — `StudioController` (a `Store<StudioState>` with undo/redo) is the single source of truth; there is no local component state for dashboard content, layout, filters, or selection.
2. **Data pipeline** — a layered, aggressively-cached row-transformation pipeline (`internals/`) that turns raw `dataSources[id].rows` into the exact rows a widget renders.
3. **UI** — a React component tree (`components/`) that reads/writes the controller exclusively through `useStudioSelector`/`useStudioController` and never holds layout or dashboard state itself.
4. **Server adapters** — optional (`server/`) helpers for wiring a widget's data to a remote backend (e.g. `@mui/x-studio-data-middleware`) instead of in-memory rows, including automatic request batching and cross-source join resolution.

The state-model layer sits one level below `x-studio` itself: `@mui/x-studio-schema` (`packages/x-studio-schema`) owns every `StudioState`/widget/data/expression/AI-protocol type, `createDefaultStudioState`/`createDefaultWidget`, the pure `applyMutation` reducer, and anomaly-detection math. `x-studio` (client) and `@mui/x-studio-ai-middleware` (server) both depend on it, so a `StudioState` shape change is made in exactly one place.

## Directory layout

```
packages/x-studio-schema/src/     Dependency-free shared types + pure functions (see below)
packages/x-studio/src/
  store/                          StudioController, statePersistence
  context/                        StudioProvider, useStudioSelector, selectors.ts
  internals/                      Data pipeline, caches, chart aggregation, widget registry, i18n plumbing
  components/
    Studio/                       Studio, StudioDashboard, StudioContent, sidebar chrome
    StudioCanvas/                 Drag-and-drop grid layout engine
    StudioChatPanel/              AI assistant panel + backend adapter
    StudioComposeDrawer/          "Add/edit widget" authoring drawer + per-kind setup panels
    StudioDataDrawer/             Data sources, relationships, expression fields UI
    StudioFiltersDrawer/          Page/widget filters UI
    StudioWidgetCard/             Per-widget chrome (title, actions, export)
    StudioWidgetEditDialog/       Modal widget editor (filters, formatting)
    StudioExpressionFieldDialog/  Calculated-field / measure editor
    widgets/                      The 7 built-in widget kind implementations
  models/                         Thin re-exports of @mui/x-studio-schema + React-only custom-widget types
  utils/                          expressionEvaluator, gridGrouping, gridSummary, fieldCapabilities
  locales/                        Translation bundles (enUS, fr, de, es, ptBR)
  server/                         createBatchingAdapter, createSimpleAdapter
  benchmarks/                     vitest bench + a standalone tsx runner for the row pipeline
  icons/                          Custom SVG icon set (field types, chart types, widget kinds)
  themeAugmentation/               MUI theme defaultProps augmentation
```

## The shared schema package (`@mui/x-studio-schema`)

`packages/x-studio-schema/src/index.ts` is the single source of truth for the data model:

- `baseTypes.ts`, `dataTypes.ts`, `widgetTypes.ts`, `expressionTypes.ts`, `stateTypes.ts`, `aiTypes.ts` — every `StudioState`, widget, data-source, filter, expression, and AI-protocol type.
- `createDefaultStudioState` (`stateTypes.ts`) — builds the default `StudioState` (one page, no widgets, `schemaVersion: 1`).
- `createDefaultWidget` (`widgetFactory.ts`) — the single factory both the UI ("Add widget" drawer) and the AI (`addWidget` tool) use, so UI-created and AI-created widgets always start from the same defaults.
- `applyMutation` / `mutationLabel` (`applyMutation.ts`) — the pure reducer that maps a `StateMutation` (see AI integration below) onto a `StudioState`. It is the _one_ implementation of every mutation's effect: the AI middleware server computes its threaded `nextState` with it, and the client's `StudioController.applyExternalMutation` applies the identical function to the incoming SSE event, so the two sides can never disagree about what a tool call did (page-targeting, config merge order, etc. are handled once).
- `detectAnomaliesIQR` / `median` (`anomalyDetection.ts`) — Tukey IQR outlier detection, shared so the AI's anomaly-detection tool and the chart widget's client-side detection agree.

It has **zero runtime dependencies** (no React, no Node built-ins) so it is importable from both a browser bundle and a server bundle. `packages/x-studio/src/models/index.ts` is a thin re-export (`export * from '@mui/x-studio-schema'`) plus the package's own React-dependent `customWidgetTypes.ts` (custom-widget registration types, which reference `React.ReactNode`/`React.ComponentType` and so cannot live in the dependency-free schema package). Application code should still import types from `@mui/x-studio`'s public surface (or `../models` internally) — the schema package is an implementation detail two packages happen to share, not a place app code imports from directly.

Anything that is _only_ a pure state-shape transform (mutation reducers, default-state/default-widget factories, anomaly math) belongs in the schema package. Anything that touches React, MUI components, the DOM, or in-memory row data (the pipeline, caches, chart rendering) stays in `x-studio`.

## State management

### `StudioController` (`src/store/StudioController.ts`)

Wraps a `Store<StudioState>` from `@mui/x-internals/store` (`packages/x-internals/src/store/Store.ts`) — a minimal observable with `state`, `subscribe(listener)`, `setState(next)`, and `getSnapshot()`, built to back `useSyncExternalStore`. `StudioController` never mutates `StudioState` in place; every method computes a brand-new object and passes it to a private `commitState`, which:

- Pushes the previous state onto an undo stack (capped at `MAX_UNDO_HISTORY = 100`) unless the caller passes `{ undoable: false }` (used for high-frequency/transient changes like interactive filter selection, drawer toggles, active-page switches).
- Clears the redo stack on every new undoable commit.
- Optionally appends a `{ label, at }` entry to a capped recent-mutation log (`MAX_MUTATION_LOG = 20`), surfaced to the AI assistant via `getRecentMutations()` so the model has a sense of what the user changed recently.
- Calls `store.setState(nextState)`, which synchronously notifies subscribers.

Every mutation — dragging a widget, editing a filter, an AI tool call — funnels through one of `StudioController`'s ~40 methods (`addWidget`, `updateWidget`, `setWidgetLayout`, `addFilter`, `applyCrossFilter`, `setDashboardDateRange`, `addPage`, `duplicateWidget`, …). There is no other path to change dashboard state.

**AI mutations** are special: `applyExternalMutation(mutation, label?)` calls the shared `applyMutation(state, mutation)` reducer from `@mui/x-studio-schema` (rather than re-deriving the effect via a hand-written controller call), then commits the result through the normal undo/label machinery. This guarantees the client-applied state cannot diverge from the state the AI middleware server already threaded to the model.

Other responsibilities live directly on the controller:

- **Undo/redo**: `undo()`/`redo()`/`canUndo()`/`canRedo()` pop/push the two stacks directly against `store.setState`.
- **Persistence**: `serializeState()`, `loadSerializedState()` (applies migrations, resets history), `serializeSession()`/`restoreSession()` (see Persistence below).
- **Title inference**: `applyInferredTitles` re-derives a widget's auto title/subtitle from its data source whenever `updateWidget`/`updateWidgetConfig` changes something that could affect it, unless the caller explicitly set a title/subtitle.
- **Layout math**: `setWidgetColSpan`, `setWidgetColSpanInRow`, `setAdjacentWidgetColSpans` clamp spans to a 3–12 column range and rebalance sibling widgets in the same row so a manual resize never produces a >12-column row.
- **Async adapter bookkeeping**: `upsertDataSource`/`setDataSourceAdapter` invalidate the module-singleton `studioRequestCache` (`StudioRequestCache.ts`) for the affected source.

### React integration (`src/context/StudioContext.tsx`)

`StudioProvider` puts the `StudioController` instance into `StudioContext` (plain `React.createContext<StudioController | null>`) and wraps UI configuration (`tableSourceMode`, `featureFlags`, merged `localeText`, `aiConfig`, `customWidgets`, `geographies`) into a second `StudioUIConfigContext.Provider`.

- `useStudioController()` — throws if called outside a `StudioProvider`.
- `useStudioState()` — subscribes to the _entire_ state (rarely used directly; prefer a selector).
- `useStudioSelector(selector)` — `controller.store.use(selector)`, a `useSyncExternalStore`-based hook that only re-renders when the selected slice changes (by `Object.is`).
- A library of reusable selectors lives in `src/context/selectors.ts`: simple property selectors (`selectFilters`, `selectDataSources`, `selectRelationships`, `selectWidgets`, `selectMode`, `selectActivePage`, …) and selector _factories_ for per-ID/per-page lookups (`makeSelectExpressionFieldsForSource(s)`, `makeSelectPartitionedFiltersForPage(pageId)`, `makeSelectActiveCrossFilter`, `makeSelectIncomingCrossFilters`). Factories are memoized per call site with `React.useMemo` so each widget subscribes to only the state slice it actually needs — e.g. `useWidgetRows` computes `relevantSourceIds` (a widget's own source plus its directly-related sources) and builds a scoped expression-field selector from it, so adding an expression field to an unrelated source never re-renders this widget.

Concretely, for a drag-and-drop widget move: `useStudioDraggable`/`useStudioDropTarget` (built on `@atlaskit/pragmatic-drag-and-drop`) report the drop to `StudioCanvas`'s drop handler, which recomputes the target page's `widgetRows` (and, for cross-page moves, the source page's) and commits it via a single `controller.updateState({ pages, shell })` call.

## Data pipeline

The pipeline turns `dataSources[id].rows` into the rows a specific widget renders, in four numbered layers plus a widget-facing hook that stitches them together.

### L1 — Normalize (`src/internals/normalizedRowsCache.ts`)

`getCachedNormalizedDataSource(dataSource, usedFieldIds?)` calls `normalizeDataSourceRows` (`chartUtils.ts`) to canonicalize date/datetime values and pre-build per-field distinct-value indexes, then caches the result in a `WeakMap<Row[], Map<fieldSetKey, entry>>` keyed on the source's `rows` array. When `usedFieldIds` is passed, normalization is scoped to only the fields a given widget actually uses ("lazy-by-widget"), so adding an unused field to a different widget's config is zero cost — each field set gets its own cache slot.

### L2 — Enrich (`src/internals/enrichedRowsCache.ts`)

`getCachedEnrichedRows(rows, sourceId, expressionFields, dataSources, relationships, usedFieldIds?)` evaluates non-measure `StudioExpressionField`s (calculated columns, including cross-source `JoinFieldExpression`s) via `enrichRowsWithExpressions` (`utils/expressionEvaluator.ts`) and merges the computed values onto each row. Caching is two-level (`rows` WeakMap → `fieldSetKey` Map); a cache entry is invalidated only if its own rows changed, a _relevant_ expression-field object changed (by reference — editing a formula replaces the object), a joined foreign source's rows changed, or a relevant relationship changed. `expandWithDependencies` walks each requested field's transitive expression dependencies (field A referencing field B pulls B in too) so a widget only pays for the expressions it actually needs. Measure expressions (`isMeasure: true`) are excluded from row-level enrichment entirely.

### L3 — Filter (`src/internals/filterScoping.ts`, `dataSourceGraph.ts`, `resolvedRowsCache.ts`)

1. `selectFiltersForWidget(filters, { widgetId, widgetSourceId, activePageId, include, crossFilterAllPages })` is the single source of truth for filter _scoping_ — it decides which of `StudioState.filters` apply to a given widget by switching on `scope.kind` (`page` / `widget` / `cross-filter` / `interactive` / `dashboard-date-range`), and finally runs `resolveDateRangePresets` to turn a stored preset into concrete from/to bounds computed at query time (so a stored filter never holds a stale absolute date). The `include` parameter (`'all' | 'no-cross' | 'no-chart-cross'`) lets a single scoping function serve all three baselines `useWidgetRows` needs.
2. `resolveRows` (`dataSourceGraph.ts`) takes the scoped filters and does the actual row filtering: it separates _native_ filters (same source as the widget) from _cross-filters_ (`filterSourceId` differs, or the field is an expression owned by another source), resolves a `JoinPath` for each cross-filter via `findJoinPath` (one-hop direct relationship, or two-hop via a many-to-many junction), semi-joins the widget rows against the matching foreign rows, and finally runs `applyFilters`/`compileRowTest` (`filterUtils.ts`) for the native (and, for one-hop matches, already-filtered) rows.
3. `resolveRowsCached` (`resolvedRowsCache.ts`) wraps `resolveRows` with a `WeakMap<Row[], Map<cacheKey, entry>>` cache. The cache key folds in a content-based `filterFingerprint` of every scoped filter (operator, value, mode, rank settings, field type, target source — not just id/value, so an operator edit alone invalidates the entry) plus the sorted `usedFieldIds` set. A hit is only served if every foreign source actually joined against (tracked via a `collectJoinedSourceIds` out-param) still has the same `rows` reference, `relationships` is the same array, and every relevant (non-measure) expression field on the widget source or a joined source is still the same object.

### L4 — Re-anchor (chart widgets only) (`src/internals/grainResolution.ts`, `chartAggregation.ts`/`chartSupport.ts`)

When a chart's x/y/series fields span more than one related source, aggregating the L3 result directly can double-count or under-count due to fan-out joins. `chartSupport.analyzeChartSupport` determines each requested field's owning source (`findDirectFieldOwner`, walking one-hop and many-to-many relationships) and whether the configuration can be safely aggregated (`isSafeWidgetBridgeOwner`). When it can, `resolveChartRowsForAggregation` calls the shared L4 core, `grainResolution.resolveRowsAtGrain(widgetRows, widgetSourceId, anchorSourceId, requestedFields, fieldOwners, …)`, which re-derives the row grain relative to the chosen `anchorSourceId`:

- **No re-anchor** (`anchorSourceId === widgetSourceId`) — just enrich with related fields (`enrichRowsWithRelatedFields`, one-hop or two-hop display-column joins) and, if needed, expression fields.
- **Many-to-one anchor** (widget is the "one" side, anchor is the "many" side) — expand each widget row into one row per matching anchor-source row, merging in the requested anchor fields plus any remaining widget fields via FK lookup.
- **Many-to-many anchor** (anchor is a junction source) — walk the junction rows, keeping only those linking to an allowed widget row, merging widget row + remote row + junction row per output row.

This function is deliberately scoped to the "fan-out" direction only (grouping dimension on the coarser side); the opposite "fan-in" direction (aggregate a one-side measure grouped by a many-side field, e.g. a grid summing `orders.total` grouped by `order_items.category`) has no single global grain and instead uses a per-group dedup helper, `utils/gridGrouping.symmetricAggregate` — `analyzeChartSupport` never selects an anchor that would need it, so charts never hit that path.

All cross-source joins everywhere in the pipeline — L3 semi-joins, L4 re-anchoring, display-column enrichment, and grid fan-out dedup — share one join-key coercion policy: `normalizeJoinKey` (`src/internals/joinKeys.ts`). It maps `null`/`undefined` → `null` (so a missing FK never spuriously matches an empty key), `Date` → its ISO string, and everything else → `String(value)` (so a numeric FK and a string PK compare equal). `indexRowsByKey` and `collectKeySet` build `Map`/`Set` lookups on top of this policy and are reused by `dataSourceGraph.ts`, `grainResolution.ts`, `crossSourceEnrichment.ts`, and `utils/gridGrouping.ts`.

### Aggregate & render

Per-chart-type aggregation lives in `internals/aggregators.ts` (`aggregateByField`, `aggregateByTwoFields`, `aggregateMultipleSeries`, `aggregateBlendedSeries`, plus shared `orderLabels` sorting and rank-on-aggregated-value helpers) and `internals/chartShapes/` (one file per chart-type-specific shaping step: `scatter.ts`, `heatmap.ts`, `sankey.ts`, `funnel.ts`). `internals/chartAggregation.ts` is a stable composition barrel: `export * from './chartSupport'`, `'./aggregators'`, `'./chartShapes'` — existing `chartAggregation` imports keep working while the implementation is split across focused modules. After aggregation: temporal label-gap-filling (`temporalUtils.ts`), forecast overlay (`forecastUtils.ts` — linear-regression projection), anomaly annotation (`anomalyDetection.ts` — Tukey IQR over the aggregated series), and number formatting (`numberFormat.ts`), before handing off to `@mui/x-charts`. Grid widgets substitute `utils/gridGrouping.ts`/`utils/gridSummary.ts` (group-by aggregation and footer totals) for the chart-specific aggregation step.

### `useWidgetRows` (`src/internals/useWidgetRows.ts`)

The central widget-facing hook. It branches on whether the widget's data source has an `adapter`:

- **Sync (in-memory) path**: computes `usedFieldIds` from the widget's config plus active filter fields, runs L1 (`getCachedNormalizedDataSource`) once per render, then a memoized `computeFilteredRows(include)` callback calls `selectFiltersForWidget` + `resolveRowsCached` (L2+L3) for whichever of the three filter baselines is requested.
- **Async adapter path**: builds a `StudioQueryDescriptor` (`queryDescriptor.ts`), checks the module-singleton `studioRequestCache` (30s TTL, in-flight dedup — see `StudioRequestCache.ts`), calls `dataSource.adapter.getRows(descriptor)` in a `useEffect`, and re-applies L2 client-side on the returned rows (adapters return physical columns only; the server cannot compute a calculated field) plus cross-filters/interactive filters (`enrichIfNeeded`/`computeFilteredRows` reuse the exact same `selectFiltersForWidget` + `resolveRowsCached` calls as the sync path, just scoped to `include: 'no-cross' | 'no-chart-cross'`, so the two paths can't disagree about scoping).

The hook returns three row baselines plus derived flags, all built to make cross-filter/cross-highlight rendering correct and cheap:

- `filteredRows` — every active filter applied (page + widget + cross-filter + interactive).
- `filteredRowsNoCross` — page + widget filters only; identical reference to `filteredRows` when there are no incoming cross/interactive filters (downstream memos short-circuit automatically).
- `filteredRowsNoChartCross` — page + widget + interactive, but _not_ chart-click cross-filters; the correct "all rows" baseline for a grid's cross-highlight overlay, because interactive (filter-widget) selections are always hard filters (BI convention) while chart-click cross-filters drive a dim/highlight overlay instead of removing rows.
- `hasCrossFilters` / `hasChartCrossFilters` / `shouldShowGhost` — whether a ghost/ghost-bar overlay should render (only for `crossFilterMode === 'cross-highlight'` and an actual chart-click cross-filter — interactive selections never trigger the ghost).
- `effectiveRows` — the widget's primary dataset, selecting `filteredRowsNoCross` in `crossFilterMode === 'none'` and `filteredRows` otherwise.
- `isLoading` / `isRecomputing` / `isError` / `errorMessage` — adapter fetch state (`isLoading`/`isError`) and a `useDeferredValue`-driven `isRecomputing` flag for page/widget filter changes on the sync path (used to show a subtle loading overlay without blocking the UI).

Cross-source display columns (grid columns or map fields referencing a many-to-one related source) go through a separate, source-scoped enrichment step — `enrichWithCrossSourceFields`/`enrichWithCrossSourceColumns` (`crossSourceEnrichment.ts`) — applied after filtering via the `enrichIfNeeded` callback, itself a no-op (reference-preserving) when the widget has no cross-source columns.

### The recurring design theme

Every cache in `internals/` (`normalizedRowsCache`, `enrichedRowsCache`, `resolvedRowsCache`, the L4 anchor path, `computedCache.ts`) uses **per-entry dependency tracking instead of blanket invalidation** — an entry stays valid unless the _specific_ upstream references it actually depends on (its own rows, the specific expression-field objects it evaluated, the specific foreign sources it joined against, the filter fingerprint) changed. An unrelated edit elsewhere on the dashboard never forces recomputation for a given widget. New caching code in this package should follow the same pattern.

### The non-React pipeline façade (`src/internals/StudioPipeline.ts`)

`createStudioPipeline(state)` builds a small pure-TypeScript object (`resolveWidgetRows`, `resolveChartRows`, `getEnrichedRows`) closing over a snapshot of `{ dataSources, relationships, expressionFields, filters }`, delegating to the exact same cached pipeline functions the React hook layer uses. It exists for callers outside a render cycle: CSV export, the `benchmarks/` suite (`pipeline.bench.ts`, `run.ts`), and pipeline unit tests (`StudioPipeline.test.ts`).

## Widget system

Seven built-in widget kinds live under `src/components/widgets/`: `StudioChartWidget`, `StudioGridWidget`, `StudioKpiWidget`, `StudioMapWidget`, `StudioPivotWidget`, `StudioTextWidget`, `StudioFilterWidget`.

### The registry (`src/internals/builtinWidgetDefs.ts`)

`BUILTIN_WIDGET_DEFS` is a `Record<BuiltinStudioWidgetKind, StudioWidgetDef>` — one entry per built-in kind, each with a `label`, a render wrapper component (`GridWidgetRender`, `ChartWidgetRender`, …), a `setupPanel` wrapper for the compose drawer, an `aiInsight` flag, and a `capabilities` object (`export: 'csv' | 'png'`, `expand`, `widgetFilters`, `minHeight`, `contentSx`, `skeletonHeight(widget)`). It is declared `satisfies Record<BuiltinStudioWidgetKind, StudioWidgetDef>`, so omitting a kind when adding a new one to `StudioWidgetKind` is a compile error rather than a silent runtime gap. `useWidgetDefMap()` merges this registry with any consumer-registered `customWidgets` (custom entries win on a kind collision) into one `ReadonlyMap<string, StudioWidgetDef>` — the single lookup every kind-dispatch site (widget card, compose drawer, edit dialog) uses; built-in and custom kinds are otherwise indistinguishable to callers.

### `StudioChartWidget` (`src/components/widgets/StudioChartWidget/`)

`StudioChartWidget.tsx` (~3000 lines) is still the largest single widget file: it directly renders bar (grouped/stacked/100%/horizontal variants), line, area (plain/stacked/100%), pie/donut, and heatmap chart types inline, using `@mui/x-charts`' `BarChart`/`LineChart`/`PieChart` and `@mui/x-charts-premium`'s `HeatmapPremium`, wired up with cross-filter highlighting (`CrossFilterGhostBar`, `PieCrossHighlight*`), per-field tooltips (`StudioChartFieldTooltip.tsx`), forecast overlays, and anomaly-detection reference lines. Other chart types are extracted into their own components and delegated to:

- `StudioGaugeChart.tsx` — gauge charts (thin wrapper over `@mui/x-charts`' `Gauge`).
- `StudioScatterChart.tsx` — scatter plots.
- `StudioMixedChart.tsx` — mixed bar+line combination charts.
- `StudioFunnelChart.tsx` — funnel charts (uses `chartShapes/funnel.ts` for shaping).
- `StudioGanttChart.tsx` — Gantt/timeline charts.
- `StudioSankeyChart.tsx` — Sankey diagrams (uses `chartShapes/sankey.ts`).

Supporting modules: `useChartWidgetData.ts` (data-fetch/aggregation orchestration hook), `lineSeries.ts` (`buildMultiYLineSeries`), `chartWidgetHelpers.ts` (value formatters, `crossFilterValueEquals`/`normalizeCrossFilterValue` — the equality check used to decide whether a clicked data point matches an incoming cross-filter value, `densifyBarLabels`, `alignFilteredToAllLabels`), and the cross-filter/source-selection React contexts (`CrossFilterBarContext.ts`, `SourceSelectionContext.ts`, `PieCrossHighlightContext.ts`).

### Other built-in widgets

- `StudioGridWidget` — data table; group-by via `utils/gridGrouping.ts`, footer totals via `utils/gridSummary.ts`.
- `StudioKpiWidget` — single-metric card; `kpiUtils.ts` computes the aggregate + period-over-period trend, `KpiSparkline.tsx`/`KpiTrend.tsx`/`KpiValue.tsx` render the pieces.
- `StudioMapWidget` — choropleth map; `geographyLoaders.ts` lazily loads topojson for built-in (`world`/`usa`/`europe`) and consumer-registered geographies, `countryUtils.ts` normalizes country-name/code matching, `StudioMapShapePlot.tsx` renders shapes.
- `StudioPivotWidget` — pivot table; `pivotUtils.ts` computes the cross-tab, `PivotTable.tsx` renders it.
- `StudioTextWidget` — markdown text block (`renderMarkdown.tsx`); `useTextWidgetAI.ts` supports AI-assisted content generation/refresh.
- `StudioFilterWidget` — an on-canvas filter control; per-control-type implementations under `controls/` (`DateRangeControl`, `MultiSelectControl`, `SliderControl`, `ToggleControl`).

### Custom widgets

Consumers register `StudioCustomWidgetDef[]` (kind, label, `component: React.ComponentType<StudioCustomWidgetProps>`, optional `setupPanel`, `requiresDataSource`, `aiInsight`, `defaultConfig`, `fullBleed`, `shouldHide`) via `Studio`'s (or `StudioProvider`'s) `customWidgets` prop. `useWidgetDefMap()` folds them into the same registry `BUILTIN_WIDGET_DEFS` populates, so custom and built-in widgets are dispatched identically everywhere. `StudioCustomWidgetProps.dataSource.rows` includes L2 enrichment (expression fields pre-resolved) but not filters/cross-filters — a custom widget that needs those calls `useStudioSelector` itself. See `AGENTS.md`/`CLAUDE.md`'s "x-studio custom charts" guidance: a bespoke chart type belongs in an app-level custom widget composing the public `@mui/x-charts*` APIs — never patched into the shipping `x-charts*` packages.

## Canvas / layout (`src/components/StudioCanvas/StudioCanvas.tsx`)

`StudioCanvas` renders the active page's `widgetRows` (`string[][]`, each inner array a row of side-by-side widget IDs) as a flex grid. Key exported helpers:

- `getWidgetMinSpan(widget)` — minimum resizable column span (`MIN_SPAN` from `canvasGridConstants.ts`, i.e. `GRID_COLS / 4`; a KPI widget without a sparkline gets a smaller `KPI_NO_SPARKLINE_MIN_SPAN = 4` since it doesn't need room for a chart).
- `LiveDragState` — `{ leftId, rightId, leftSpanLive, totalSpan }`, the transient (non-committed) state of an in-progress between-widget resize drag.
- `computeGridLineLefts(row, widgetColSpans, liveDrag)` — computes CSS `left` values for the column-divider overlay lines shown during a resize drag, one per grid-column boundary.

Drag-and-drop uses `@atlaskit/pragmatic-drag-and-drop` via `useStudioDraggable.ts`/`useStudioDropTarget.ts` (canvas-widget and compose-drawer-widget drag types defined in `studioWidgetDndTypes.ts`), with `@atlaskit/pragmatic-drag-and-drop-auto-scroll` wired in for autoscroll near the viewport edge. `StudioDragLayer.tsx` renders the floating drag preview; `createClonePreview.ts` builds it. `InsertionPoint.tsx` and `WidgetGap.tsx` render the drop-target affordances between/around widgets. `RowResizeHandle.tsx` is the draggable divider between two widgets in the same row, committing through `StudioController.setAdjacentWidgetColSpans`. `StudioDateRangeBar.tsx` is the dashboard-level date-range control; `StudioCrossFilterBar.tsx` shows the active cross-filter mode/scope toggle; `StudioQuickFilterBar.tsx` surfaces active page filters as removable chips.

Test files co-located with the canvas target specific concerns: `StudioCanvas.gridLines.test.ts` (grid-line math), `StudioCanvas.responsive.test.ts` (stack-breakpoint behavior), `StudioCanvas.regressions.test.ts` (layout regressions), `StudioCanvas.remount.test.tsx` (state continuity across remounts).

## Filters

`StudioFilterState.scope` (defined in `@mui/x-studio-schema`'s `stateTypes.ts`) is a discriminated union — `{ kind: 'page' }`, `{ kind: 'widget'; widgetId }`, `{ kind: 'cross-filter'; sourceWidgetId; pageId }`, `{ kind: 'interactive'; sourceWidgetId; pageId }`, `{ kind: 'dashboard-date-range'; sourceId; pageId }` — the sole scope descriptor; there is no separate `widgetId`/`pageId`/`isDashboardDateRange` field to keep in sync. `internals/filterScoping.ts`'s `selectFiltersForWidget` is the single scoping authority consumed by both the sync and async-adapter code paths in `useWidgetRows` and by the non-React `StudioPipeline`.

- `src/components/StudioFiltersDrawer/` — the page/widget filter authoring UI: `PageFilterRow.tsx`/`WidgetFilterRow.tsx` (row UI), `FilterValueInput.tsx`/`DateValueInput.tsx`/`RelativeDateInput.tsx`/`SelectionFilterInput.tsx`/`RankFilterInput.tsx` (per-mode value editors), `CrossFilterSection.tsx`/`InteractiveFilterSection.tsx` (read-only summaries of live cross-filter/interactive state), `filterDrawerUtils.ts` (`getOperators` and other drawer-specific helpers), `useFieldValues.ts` (distinct-value fetching for selection filters).
- `filterOperatorMetadata.ts` is the single source of truth for which `StudioFilterOperator`s are valid per field type (`string`/`number`/`date`/`datetime`/`boolean`) and their display labels, shared by both `StudioWidgetEditDialog/FilterRow.tsx` and `StudioFiltersDrawer/filterDrawerUtils.ts`.
- `src/components/StudioCanvas/StudioQuickFilterBar.tsx` — canvas-level chip row for active page filters (enable/disable/remove without opening the drawer).
- Cross-filter value comparison (deciding whether a clicked chart data point matches an existing cross-filter's stored value) is centralized in `chartWidgetHelpers.ts`'s `crossFilterValueEquals`/`normalizeCrossFilterValue` (used by `StudioChartWidget` when rendering cross-highlight state) rather than being re-implemented per chart type.
- Filter _evaluation_ (turning a `StudioFilterState` into a per-row predicate) lives in `internals/filterUtils.ts` (`applyFilters`, `compileRowTest`, `resolveDateRangePresets`, relative-date resolution).

## Persistence & schema migrations (`src/store/statePersistence.ts`)

`CURRENT_SCHEMA_VERSION` is an integer (currently `1`) stamped onto every persisted `StudioState`.

- `serializeState(state)` → `SerializedStudioState`: `dashboard`, `pages`, `widgets`, `filters` (with `scope.kind === 'cross-filter'` entries stripped — cross-filters are runtime-only interaction state, never something you'd want to reload into), `relationships`, `expressionFields`, `filterPresets`, and `ai` (only when at least one thread exists). **`dataSources` and `shell` are never persisted** — data sources are host-injected at runtime, and `shell` (open drawers, selection) is transient UI state.
- `deserializeState(serialized, dataSources, shellOverrides?)` → full `StudioState`, re-injecting the host's live `dataSources` and defaulting `shell` from `createDefaultStudioState()` merged with any `shellOverrides`. Also runs `normalizeGridColumn` over any grid widget's `config.columns` for forward-compatible column-shape normalization.
- `migrateState(raw)` reads `raw.schemaVersion` (defaulting to `0` for pre-versioned payloads), refuses to "migrate" from a _newer_ version than the running code supports, and otherwise applies the `migrations` registry (keyed by the **old** version number) sequentially, one version at a time, collecting per-step errors into a `MigrationResult`.
- **Migration policy** (documented at length in the source, and worth restating because it's easy to violate by accident): never add a `fooV2`-shaped parallel field when a type's shape needs to change. Keep exactly one clean field name in the TypeScript interfaces, bump `CURRENT_SCHEMA_VERSION`, and add a migration function keyed by the previous version that rewrites old persisted shapes into the new one — the running code only ever reads the new shape. Add a fixture-based test in `statePersistence.test.ts` for each migration.
- `StudioController.serializeSession()`/`restoreSession()` go one level further, capturing the present state _and_ the undo/redo stacks (`SerializedStudioSession` — each entry pairs a `mode` with a `SerializedStudioState`) so a page reload can resume with full undo history, not just the current dashboard. Restoring drops any individual history entry that fails to migrate rather than aborting the whole restore.

## AI integration

`x-studio` is UI-only — no LLM calls happen inside this package. `StudioAIConfig.endpoint` points at an `@mui/x-studio-ai-middleware` HTTP handler (see `examples/x-studio-dev-server`), which owns the API key, system prompt construction, and server-side tool execution.

- `src/components/StudioChatPanel/StudioChatPanel.tsx` — the chat UI, built on `@mui/x-chat`'s `ChatBox`/`ChatMessage`/`useChat`/`useChatComposer` headless primitives. `STUDIO_TOOL_ICONS`/`STUDIO_TOOL_LABELS` map each AI tool name (`add_widget`, `update_widget`, `set_widget_layout`, `add_page_filter`, `summarise_page`, …) to an icon/label for the inline tool-call cards.
- `studioBackendAdapter.ts`'s `createBackendChatAdapter` is the thin transport: serializes skills (stripping non-JSON `execute` functions before sending), POSTs a `StudioAIRequest` to `${endpoint}/chat`, parses the `StudioAISSEEvent` SSE stream (`sseUtils.ts`), feeds text deltas into the chat UI, and applies `state-mutation` events to the local controller.
- `applyStateMutation.ts` is a one-line wrapper: `controller.applyExternalMutation(mutation)`, which runs the mutation through the shared `applyMutation` reducer from `@mui/x-studio-schema` — the same reducer the AI middleware runs server-side, so a mutation like `addWidget` always lands on the server-chosen page regardless of what page happens to be active locally.
- `richContext.ts` builds `StudioAIRichContext` — purely-additive, client-derived signal (field statistics, recent mutations, current selection) attached to every chat request so the model has more to work with without the user typing extra detail.
- `generateInsight.ts` / `createWidgetFromDescription.ts` call the middleware's `/insight` and `/widget` endpoints respectively (one-shot widget insight text and "describe a widget in English" widget creation).
- `useSpeechRecognition.ts` wraps the Web Speech API for voice input into the chat composer.
- `StudioAIToolName` (`studioAITools.ts`) and `StateMutation`/`SerializableSkill`/`StudioAIState`/`StudioAIChatThread` (re-exported from `@mui/x-studio-schema`'s `aiTypes.ts`) are the client-visible subset of the AI protocol; the server-only pieces (`StudioAISkill.execute`, `SkillExecuteResult`, `StudioDataResolver`, rate-limiting/usage types) live exclusively in `@mui/x-studio-ai-middleware`.

## Internationalization

`src/internals/StudioUIConfigContext.ts` defines `StudioLocaleText` — an interface of every translatable string token used by the UI (drawer titles, date-range preset labels, filter-drawer strings, widget empty/error states, quick-filter-bar strings, widget-card action tooltips, and more) — plus `DEFAULT_STUDIO_LOCALE_TEXT`, the English defaults. `StudioProvider`/`Studio`'s `localeText` prop is merged shallowly over the defaults, so a consumer can override a handful of tokens without supplying the whole set.

`src/locales/` ships ready-made bundles: `enUS.ts` (canonical source), `fr.ts`, `de.ts`, `es.ts`, `ptBR.ts`, each exporting both a raw `xxLocaleText` object and an MUI-`xxLocale`-shaped `Localization` object (`getStudioLocalization` in `locales/utils/getStudioLocalization.ts` builds the latter from the former, matching the `components.MuiStudio.defaultProps.localeText` shape other MUI X packages use for theme-level localization). `locales/index.ts` re-exports everything; `locales.test.ts` asserts every locale bundle has the same key set as `enUS` (no missing/extra tokens).

`useStudioLocaleText()` is the hook widgets/drawers call to read the merged locale object; `useStudioFeatures()`/`useStudioUIConfig()`/`useStudioGeographies()`/`useCustomWidgetMap()` (same file) resolve the other pieces of `StudioUIConfigContext` — runtime feature flags (`StudioFeatureFlags`, all default `true`), the full UI config object, the merged built-in + consumer-registered map geography registry, and the merged custom-widget map, respectively.

## Public API surface

Exported from `src/index.ts`:

- **Root components**: `Studio` (full authoring UI, imperative `StudioHandle` ref), `StudioDashboard` (embed-first, view-oriented wrapper over `Studio` that takes a pre-built `config: StudioState` + `dataAdapters` map and resets the dashboard whenever `config` changes by reference — for displaying a live dashboard without exposing the authoring UI).
- **Layout**: `StudioCanvas`, `StudioDateRangeBar`, `StudioWidgetCard`, `StudioWidgetEditDialog`, `StudioNoDataOverlay`, `DrawerPanel`/`DrawerPanelContext` exports, `TabbedSidebar`.
- **Widgets**: `StudioGridWidget`, `StudioChartWidget` (+ `CHART_MIN_HEIGHT`), `StudioKpiWidget`, `StudioTextWidget`, `StudioFilterWidget` (+ per-control prop types), `StudioPivotWidget`, `StudioMapWidget` (+ `GeographyLoader`/`StudioMapGeographyDefinition`).
- **Drawers/dialogs**: `StudioDataDrawer`, `StudioComposeDrawer` (+ `InlineFormulaBar`, `DataSourceFieldSelect`), `StudioFiltersDrawer`, `StudioExpressionFieldDialog`.
- **Context**: `StudioProvider`, `useStudioController`, `useStudioSelector`, `useStudioState`, `useStudioFeatures`, `useStudioUIConfig`, `useStudioLocaleText`, `useStudioGeographies`, `useCustomWidgetMap`, `CanvasScrollContext`, and the `context/selectors.ts` selector library.
- **Locales**: `enUS`, `frLocaleText`/`fr`, `deLocaleText`/`de`, `esLocaleText`/`es`, `ptBRLocaleText`/`ptBR`, `getStudioLocalization`.
- **Widget utilities**: `WIDGET_TYPES` (picker metadata), `createDefaultWidget`.
- **Controller/state**: `StudioController`, `createStudioController`, `createDefaultStudioState`, `serializeState`/`deserializeState`/`migrateState`, `CURRENT_SCHEMA_VERSION`, `computeDateRangePreset`.
- **AI/Chat**: `StudioChatPanel`, `createBackendChatAdapter`, `applyStateMutation`, `useSpeechRecognition`, and the client-side AI protocol type subset (`StateMutation`, `SerializableSkill`, `StudioAIToolName`, `StudioAIState`, `StudioAIChatThread`).
- **Server adapters**: `createBatchingAdapter`, `createSimpleAdapter`.
- **Models**: the full `StudioState`/`StudioWidget`/`StudioDataSource`/`StudioFilterState`/expression-AST/feature-flag type surface (re-exported transitively from `@mui/x-studio-schema` via `models/index.ts`).
- **Brand**: `StudioWordmark`.

`StudioController`'s concrete class, `internals/`, and most of `models/customWidgetTypes.ts`'s implementation detail are reachable but are not meant to be constructed directly by consumers outside of `Studio`'s imperative `StudioHandle` ref: `undo`/`redo`/`canUndo`/`canRedo`, `setMode`, `setActivePage`, `removePage`, `reorderPages`, `getState`, `serializeState`/`loadSerializedState`, `serializeSession`/`restoreSession`, `setDataSourceAdapter`, `setDataSourceRows`.

### Server adapters (`src/server/`)

`StudioDataSourceAdapter` is the contract for wiring a data source to a remote backend instead of in-memory rows: `getRows(descriptor: StudioQueryDescriptor): Promise<StudioQueryResult>` (and an optional `submitMutation`). Two ready-made implementations:

- `createSimpleAdapter(url, options?)` — one HTTP request per `getRows` call.
- `createBatchingAdapter(url, options?)` — a DataLoader-style client-side batcher: because each widget has its own `cacheKey` (it includes `widgetId`), N widgets on a page would otherwise fire N independent requests that miss any server-side batching window. This collects all descriptors requested within a scheduling window (microtask tick by default) and POSTs them as one batch request, routing responses back to each widget by an `id` field. One loader instance is shared per endpoint URL, not per data source. It also supports automatic cross-source JOIN generation when given `dataSources`/`relationships`, mirroring `@mui/x-studio-data-middleware`'s server-side join handling.

Both adapters translate `StudioFilterNode`s into the middleware's `FilterPredicate`/`AggregationSpec` wire shapes and resolve relative-date values (`isRelativeDateValue`/`resolveRelativeDate`, `internals/filterUtils.ts`) before sending.

## Testing & benchmarks

- Nearly every file in `internals/`, `store/`, and `context/` has a co-located `*.test.ts`; UI components under `components/` similarly co-locate `.test.tsx` files (e.g. widget-specific cross-filter tests like `StudioGridWidget.crossFilter.test.tsx`, `StudioChartWidget.donutHighlight.test.tsx`, canvas-specific tests like `StudioCanvas.gridLines.test.ts`).
- `src/internals/__fixtures__/fanOutGolden.test.ts` is a golden-file regression test for the fan-out/grain-resolution behavior described in the L4 section above.
- `src/internals/renderPerf.test.tsx` guards against render-count regressions in the hot widget-rendering path.
- `benchmarks/` (`pnpm --filter "@mui/x-studio" bench`, or `bench:vitest` for the vitest-bench variant) measures each pipeline layer independently — L1 `normalizeDataSourceRows`, L2 `enrichRowsWithExpressions`, L3 `resolveRows` cold vs. `resolveRowsCached` warm, L4 `resolveChartRowsForAggregation` cold vs. cache-hit, and the L5 aggregation functions — using a deterministic `syntheticData.ts` generator, so pipeline performance work has a repeatable baseline. The methodology mirrors `@mui/x-studio-data-middleware`'s benchmarks for cross-package comparability.
- `packages/x-studio-schema` has its own `vitest.config.node.mts` and test suite (e.g. `applyMutation.test.ts`) run independently of `x-studio`'s browser/jsdom test projects, reflecting that the schema package has no DOM/React dependency.

## Extension points

- **New built-in widget kind**: add the kind string to `StudioWidgetKind` (`@mui/x-studio-schema`'s `baseTypes.ts` / `widgetTypes.ts`), create `components/widgets/Studio<Kind>Widget/`, add a default-config case to `createDefaultWidget` (`@mui/x-studio-schema`'s `widgetFactory.ts`), and add an entry to `BUILTIN_WIDGET_DEFS` (`internals/builtinWidgetDefs.ts`) — the `satisfies Record<BuiltinStudioWidgetKind, StudioWidgetDef>` clause makes a missed registration a compile error.
- **Custom widget kind** (app-level, no fork required): register a `StudioCustomWidgetDef` via `Studio`'s `customWidgets` prop; folded into the same registry `useWidgetDefMap()` returns, so it is rendered/dispatched identically to a built-in kind.
- **New data source backend**: implement `StudioDataSourceAdapter` directly, or use `createSimpleAdapter`/`createBatchingAdapter` against an existing endpoint (the latter also supports automatic cross-source JOIN generation when given `dataSources`/`relationships`).
- **New expression operator**: add a case to `evaluateFunctionExpression` (`utils/expressionEvaluator.ts`) — its `switch`'s exhaustiveness check (`const exhaustiveCheck: never = operator`) forces every call site to be updated.
- **New AI mutation type**: add the variant to `StateMutation` (`@mui/x-studio-schema`'s `aiTypes.ts`) and a case to `applyMutation`/`mutationLabel` (`applyMutation.ts`) — both switches have an exhaustiveness guard (`const exhaustiveCheck: never = mutation`), so a missed case fails to compile in both the client and the AI middleware server that share the file.
- **New locale**: add a language file under `locales/` following the `Localization`/`getStudioLocalization` shape used by `enUS.ts`, matching the full `StudioLocaleText` interface in `internals/StudioUIConfigContext.ts`; `locales.test.ts` will fail if any token is missing.
- **A `StudioState` shape change that breaks deserialization of persisted dashboards**: bump `CURRENT_SCHEMA_VERSION` (`store/statePersistence.ts`), add a migration keyed by the previous version, add a `statePersistence.test.ts` fixture — see Persistence above.
