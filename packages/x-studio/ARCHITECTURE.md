# Architecture

Internal reference for how `@mui/x-studio` is put together. For install/quick-start, see [`README.md`](./README.md).

## Overview

`x-studio` is an embedded analytics dashboard builder: a single `<Studio>` React component that lets end users compose pages of widgets (charts, grids, KPIs, maps, pivots, filters, text) backed by pluggable data sources, with an optional AI chat assistant that can drive the same authoring actions a human would through the UI.

The package is organized around four largely independent layers:

1. **State** — `StudioController` (a `Store<StudioState>` with undo/redo) is the single source of truth; there is no local component state for dashboard content, layout, filters, or selection.
2. **Data pipeline** — a layered, aggressively-cached row-transformation pipeline (`internals/`) that turns raw `dataSources[id].rows` into the exact rows a widget renders.
3. **UI** — a React component tree (`components/`) that reads/writes the controller exclusively through `useStudioSelector`/`useStudioController` and never holds layout or dashboard state itself.
4. **Server adapters** — optional (`server/`) helpers for wiring a widget's data to a remote backend (e.g. `@mui/x-studio-data-middleware`) instead of in-memory rows, including automatic request batching and cross-source join resolution.

## Public API surface (`src/index.ts`)

- Root components: `Studio` (full authoring UI), `StudioDashboard` (embed-first, view-oriented wrapper)
- Layout: `StudioCanvas`, `StudioDateRangeBar`, `StudioWidgetCard`, `StudioWidgetEditDialog`, `StudioNoDataOverlay`
- Widgets: `StudioGridWidget`, `StudioChartWidget`, `StudioKpiWidget`, `StudioTextWidget`, `StudioFilterWidget`, `StudioPivotWidget`, `StudioMapWidget` (+ per-widget prop/slot types)
- Drawers: `StudioDataDrawer` (and others reachable via `Studio`'s slot props, not all individually exported)
- AI/Chat: `StudioChatPanel`, `createBackendChatAdapter`, `applyStateMutation`, `useSpeechRecognition`, plus the client-side subset of AI protocol types (`StateMutation`, `SerializableSkill`, `StudioAIToolName`, `StudioAIState`, `StudioAIChatThread` — the `StudioAISkill`/execute-side types live in `@mui/x-studio-ai-middleware`)
- Server adapters: `createBatchingAdapter`, `createSimpleAdapter` (+ options types)
- State/schema: `computeDateRangePreset`, `CURRENT_SCHEMA_VERSION`
- Models: the full `StudioState`/`StudioWidget`/`StudioDataSource`/`StudioFilterState`/expression-AST/feature-flag type surface (re-exported from `models/`)
- Brand: `StudioWordmark`

`StudioController` itself, `statePersistence`'s `serializeState`/`deserializeState`/`migrateState`, and most of `internals/` are **not** part of the public surface — they're reached indirectly through `Studio`'s imperative `StudioHandle` ref (undo/redo, `serializeState`/`loadSerializedState`, `serializeSession`/`restoreSession`, `setDataSourceAdapter`, etc.) or are pure internal implementation detail.

## Module map

| Path                                                                             | Responsibility                                                                                                                                                                                                                                                        |
| :------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `store/StudioController.ts`                                                      | Owns `Store<StudioState>`; every imperative mutation method; undo/redo (max 100) + capped AI mutation log (max 20)                                                                                                                                                    |
| `store/statePersistence.ts`                                                      | `serializeState`/`deserializeState`/`migrateState`; schema versioning                                                                                                                                                                                                 |
| `context/StudioContext.tsx`                                                      | `StudioProvider`, `useStudioController`, `useStudioState`, `useStudioSelector` (React context wiring around the controller + UI config)                                                                                                                               |
| `context/selectors.ts`                                                           | Library of module-level selectors and per-ID selector factories for `useStudioSelector`                                                                                                                                                                               |
| `internals/StudioPipeline.ts`                                                    | `createStudioPipeline` — non-React façade over the row pipeline (CSV export, benchmarks, tests)                                                                                                                                                                       |
| `internals/*Cache.ts`                                                            | The cache chain: `normalizedRowsCache` (L1) → `enrichedRowsCache` (L2) → `resolvedRowsCache` (L1.5+L3) → chart-grain cache (L4, in `chartAggregation.ts`) → `computedCache` (generic downstream memo); `StudioRequestCache` is the separate async-adapter fetch cache |
| `internals/filter*.ts`                                                           | `selectFiltersForWidget` (scope resolution), `applyFilters`/`compileRowTest` (the filter engine)                                                                                                                                                                      |
| `internals/chart*.ts`                                                            | `chartTypeRegistry` (per-chart-type field/aggregation descriptors), `chartAggregation` (L4 re-anchoring + all aggregation implementations)                                                                                                                            |
| `internals/dataSourceGraph.ts`, `crossSourceEnrichment.ts`, `queryDescriptor.ts` | Cross-source joins/relationships, display-column enrichment, async-adapter query descriptor building                                                                                                                                                                  |
| `internals/forecastUtils.ts`, `anomalyDetection.ts`                              | Linear-regression forecasting; Tukey IQR anomaly detection over aggregated chart data                                                                                                                                                                                 |
| `internals/useWidgetRows.ts`                                                     | The central widget-facing hook — bridges sync in-memory and async-adapter data sources through the whole cache chain                                                                                                                                                  |
| `internals/StudioUIConfigContext.ts`                                             | `StudioLocaleText`/`DEFAULT_STUDIO_LOCALE_TEXT`, feature-flag resolution, custom-widget/geography registries                                                                                                                                                          |
| `utils/expressionEvaluator.ts`                                                   | Expression-field (calculated column/measure) AST evaluator, validator, cycle detector                                                                                                                                                                                 |
| `utils/gridGrouping.ts`, `gridSummary.ts`                                        | Grid group-by aggregation (fan-out-safe) and footer totals                                                                                                                                                                                                            |
| `components/Studio/`                                                             | Top-level shell: `Studio.tsx`, `StudioDashboard.tsx`, `StudioContent.tsx`, drawer/sidebar chrome                                                                                                                                                                      |
| `components/StudioCanvas/`                                                       | The drag-and-drop widget grid layout engine                                                                                                                                                                                                                           |
| `components/widgets/`                                                            | The 7 built-in widget kind implementations                                                                                                                                                                                                                            |
| `components/Studio*Drawer/`, `Studio*Dialog/`                                    | Data management, compose, filters drawers; expression-field and widget-edit dialogs                                                                                                                                                                                   |
| `server/createBatchingAdapter.ts`, `createSimpleAdapter.ts`                      | `StudioDataSourceAdapter` implementations for remote data sources                                                                                                                                                                                                     |
| `models/`                                                                        | All `StudioState`/widget/data/expression/AI type definitions, one file per concern                                                                                                                                                                                    |
| `locales/`, `icons/`, `themeAugmentation/`                                       | i18n (`StudioLocaleText` translations, MUI `xxLocale`-shaped), custom SVG icon set, MUI theme `defaultProps` augmentation                                                                                                                                             |

## Core data flow

### 1. State mutation (any user or AI action)

Every mutation — dragging a widget, editing a filter, an AI tool call — funnels through one of `StudioController`'s methods, which compute a new immutable `StudioState`, push the previous state onto the undo stack (unless `undoable: false`), optionally append a labeled entry to the capped AI mutation log, and call `store.setState(nextState)`. `Store` (from `@mui/x-internals/store`) notifies subscribers; every `useStudioSelector(selector)` call site (`useSyncExternalStore`-based, with a version-gated shim for React < 19) re-evaluates its selector and re-renders only if the selected slice changed. There is no other path to change dashboard state — components never hold layout/filter/selection state locally.

Concretely, for a drag-and-drop widget move: `useStudioDraggable`/`useStudioDropTarget` (built on `@atlaskit/pragmatic-drag-and-drop`) report the drop to `StudioCanvas`'s `handleDrop`, which recomputes the target page's `widgetRows` (and, for cross-page moves, the source page's) and commits it via a single `controller.updateState({ pages, shell })` call.

### 2. Row resolution (what a widget actually renders)

For a **sync, in-memory** data source, `useWidgetRows` drives the pipeline in order:

1. **L1 Normalize** — `getCachedNormalizedDataSource` (`normalizedRowsCache`, keyed by a `WeakMap` on `dataSource.rows` + the widget's used-field set) canonicalizes date/datetime values and pre-builds distinct-value indexes.
2. **L2 Enrich** — inside L3's `resolveRows`, `getCachedEnrichedRows` (`enrichedRowsCache`) evaluates non-measure expression fields (`utils/expressionEvaluator.ts`), including cross-source `JoinFieldExpression`s.
3. **L3 Filter** — `selectFiltersForWidget` (`filterScoping.ts`) resolves which of `StudioState.filters` apply to this widget by `scope.kind` (`page`/`widget`/`cross-filter`/`interactive`/`dashboard-date-range`); `resolveRows` (`dataSourceGraph.ts`) splits native vs. cross-source filters (semi-joining foreign sources via `findJoinPath`) and calls `applyFilters` (rank filters first, then compiled per-row condition tests). The whole L2+L3 result is memoized in `resolvedRowsCache`, keyed so widgets sharing a source and effective filter set share one computed row array.
4. **L4 Re-anchor** (chart widgets only) — `analyzeChartSupport`/`resolveChartRowsForAggregation` (`chartAggregation.ts`) re-derives the row grain relative to an `anchorSourceId` when chart fields span a related source, so aggregation isn't skewed by a fan-out join.
5. **Aggregate & render** — per-chart-type aggregation functions (also in `chartAggregation.ts`, selected via `chartTypeRegistry`), then temporal label-gap-filling, forecast overlay, anomaly annotation, and number formatting, before handing off to `@mui/x-charts`. Grid widgets substitute `gridGrouping`/`gridSummary` for the equivalent group-by/footer-totals step.

For an **async adapter** data source, `useWidgetRows` instead builds a `StudioQueryDescriptor` (`queryDescriptor.ts`), checks `StudioRequestCache` (30s TTL, in-flight dedup), calls `dataSource.adapter.getRows(descriptor)`, then still re-applies L2 (adapters only return physical columns) and re-applies cross-filters/interactive filters client-side.

The recurring design theme across the whole cache chain (documented repeatedly in the source) is **per-entry dependency tracking instead of blanket cache invalidation** — an entry stays valid unless the specific upstream references it depends on (rows, expression fields, relationships, filter fingerprint) actually changed, so an unrelated edit elsewhere on the dashboard doesn't force recomputation for a given widget.

### 3. Persistence

`serializeState`/`deserializeState` (`store/statePersistence.ts`) convert between `StudioState` and a `SerializedStudioState` that deliberately excludes `dataSources` (host-injected at runtime, never persisted) and `shell` (transient UI state), and drops cross-filter-scoped entries from `filters`. `CURRENT_SCHEMA_VERSION` (currently `1`) gates a `migrations` map keyed by the **old** version number; `migrateState` applies migrations sequentially and reports per-step errors. The documented policy: never add `fooV2`-shaped fields to the types — bump the schema version and write a migration instead, keeping exactly one clean field name in `StudioState`.

## Key design invariants

1. **Single source of truth, no shadow state** — every mutation goes through `StudioController`; UI components read exclusively via `useStudioSelector`/selectors in `context/selectors.ts`. Don't introduce component-local state for anything that belongs in `StudioState`.
2. **Immutable state, structural undo** — `StudioController` never mutates `StudioState` in place; each commit is a new object pushed through `store.setState`, with the prior state captured for undo.
3. **Cache validity is reference-based, not sentinel-based** — every cache in `internals/` keys off object identity (rows array, expression-field array, relationships array, filter fingerprint) rather than a global "dirty" flag, specifically so independent parts of the dashboard don't invalidate each other's caches. New caching code should follow this pattern, not add a coarser invalidation path.
4. **Data sources are never persisted** — `serializeState`/`deserializeState` treat `dataSources` as host-runtime-injected; don't add code that expects rows to survive a serialize/deserialize round trip.
5. **No component-to-component coupling** — widgets, drawers, and canvas chrome only ever depend on the controller/context and their own props; cross-widget effects (e.g. cross-filtering) are expressed as entries in `StudioState.filters`, not direct references between components.
6. **Custom charts stay app-level** (see `AGENTS.md`) — a bespoke chart type belongs in an x-studio custom widget composing `@mui/x-charts*`, never patched into the shipping charts packages.
7. **Schema migrations, not versioned field names** — see persistence section above; this is an explicit, enforced policy in `statePersistence.ts`'s comments.

## Testing & benchmarks

- Nearly every `internals/`, `store/`, and `context/` file has a co-located `*.test.ts`; UI components under `components/` similarly co-locate `.test.tsx` (e.g. `StudioCanvas.gridLines.test.ts`, `StudioCanvas.responsive.test.ts`, `StudioCanvas.regressions.test.ts` target specific layout/regression concerns).
- `benchmarks/` (`pnpm --filter "@mui/x-studio" bench`) measures the row pipeline (`pipeline.bench.ts`) using a deterministic `syntheticData.ts` generator, mirroring the methodology used by `x-studio-data-middleware`'s benchmarks for cross-package comparability.

## Extension points

- **New built-in widget kind**: follow `CLAUDE.md`'s "Adding a new widget type" steps — add to `StudioWidgetKind` (`models/baseTypes.ts`), create `components/widgets/Studio<Kind>Widget/`, add a default-config case in `internals/widgetFactory.ts`, and add the kind to the three hardcoded dispatch points (`StudioWidgetCard.tsx`, `StudioComposeDrawer.tsx`, `StudioWidgetEditDialog.tsx`) — there is no single registry object for built-in kinds.
- **Custom widget kind** (app-level, no fork required): register a `StudioCustomWidgetDef` via `Studio`'s `customWidgets` prop; looked up through `useCustomWidgetMap()` and rendered wherever a built-in kind isn't matched.
- **New data source backend**: implement `StudioDataSourceAdapter` (`getRows`, optional `submitMutation`), or use `createSimpleAdapter`/`createBatchingAdapter` against an existing endpoint (the latter also supports automatic cross-source JOIN generation when given `dataSources`/`relationships`).
- **New expression operator**: add a case to `evaluateFunctionExpression` (`utils/expressionEvaluator.ts`) — the `switch`'s exhaustiveness check (`const exhaustiveCheck: never = operator`) forces every call site to be updated.
- **New locale**: add a language file under `locales/` following the `Localization`/`getStudioLocalization` shape used by `enUS.ts`, matching the ~250-token `StudioLocaleText` interface in `internals/StudioUIConfigContext.ts`.
