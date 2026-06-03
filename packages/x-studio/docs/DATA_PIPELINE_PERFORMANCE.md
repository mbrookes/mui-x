# x-studio Data Pipeline Performance Reference

This document consolidates the full `@mui/x-studio` performance history from the
checkpoint corpus plus the existing UI performance review and benchmark result
notes in this package. It is intended as the single reference for how the
pipeline was profiled, what changed, why each cache exists, and which follow-up
items remained open in checkpoint history.

## Overview

### Scope

The work spanned three overlapping areas:

- **UI performance review** of the example app (`examples/x-studio`) using
  Lighthouse, React DevTools Profiler, `react-scan`,
  `@welldone-software/why-did-you-render`, heap snapshots, and bundle analysis.
- **Synchronous in-memory pipeline optimization** for charts, grids, KPI cards,
  and filter widgets inside `packages/x-studio/src/internals/`.
- **Async adapter / server pipeline design** built around
  `StudioQueryDescriptor`, `StudioRequestCache`, `createBatchingAdapter`, and
  `@mui/x-studio-middleware`.

### Key findings summary

- The dominant cold-path cost moved around over time, but the recurring
  bottleneck was **expression enrichment**:
  `enrichRowsWithExpressions` / `getCachedEnrichedRows`.
- The earliest critical bugs were architectural, not micro-optimizations:
  - React 19 selector instability from inline `useStudioSelector` callbacks.
  - A chart **double-pipeline** path when no cross-filters were active.
  - An O(N×M) join lookup in `evaluateExpression()`.
  - Overly broad module-level cache sentinels that invalidated unrelated work.
- The final pipeline became a layered cache stack:
  - **L1** `getCachedNormalizedDataSource()`
  - **L2** `getCachedEnrichedRows()`
  - **L3** `resolveRowsCached()`
  - **L4** `resolveChartRowsForAggregation()` two-level `WeakMap`
  - **L5** `cachedCompute()` for aggregation memoization
- Warm caches are dramatic. In the final benchmark document, 100k-row warm-path
  timings were effectively sub-millisecond for L1-L4:
  - `getCachedNormalizedDataSource`: `0.000 ms`
  - `getCachedEnrichedRows`: `0.003 ms`
  - `resolveRowsCached`: `0.002 ms`
  - `resolveChartRows (warm)`: `0.006 ms`
- The main remaining open items recorded in checkpoint history were:
  - `toComparable()` filter hot path precomputation
  - CLS / layout-shift fixes in the example app
  - detached chart SVG cleanup investigation
  - finishing `makeSelectExpressionFieldsForSources()` wiring in
    `useWidgetRows.ts`

### Source sessions covered

- `1ca31637` cp1 — UI performance review and initial fixes
- `9e877444` cp13-14 — BL70 render-perf validation work
- `8c70e342` cp1 — data pipeline docs and sidebar fixes
- `6f25fa39` cp12-25 — the main pipeline research, optimization, benchmark,
  abstraction, and async-adapter work

## Performance Research

### UI review research: example app findings

The UI review established the practical symptoms before pipeline work started.

#### Baseline metrics and observed costs

- Lighthouse: **34 desktop / 26 mobile**
- Desktop CLS: **0.282** (poor; target `< 0.1`)
- Bundle chunks:
  - `exceljs.min.js`: `1,031 KB` / `296 KB gzip`
  - `index.js`: `2,654 KB` / `713 KB gzip`
- Interaction traces:
  - 10k load: **846 ms** longest task
  - 100k load: **4,634 ms** longest task
  - 100k load TBT: **5,493 ms**
  - Filter click at 10k: **515 ms**
  - Page switch: **297 ms**
  - Sort at 10k: **255 ms**
  - Sort at 100k: **657 ms**

#### UI hot stacks

- `StudioKpiWidget -> resolveRows -> applyFilters -> matchesFilterState -> toComparable`
- `updateMemo -> resolveRows -> applyFilters`
- `processRootScheduleInMicrotask -> renderRootSync`
- `renderRootSync -> useGridAiAssistant`

#### UI-specific issues identified

- **React 19 selector instability**:
  `useStoreR19` in `packages/x-internals/src/store/useStore.ts` uses
  `React.useCallback` with `selector` in its dependency array. Inline selector
  arrows passed to `useStudioSelector()` recreated `getSelection` every render.
- **Event-listener leak** in `StudioCanvas.tsx`:
  `dragleave` listeners were added without matching cleanup.
- **Detached chart SVG trees** after navigation / dialog cycles:
  - `522` `SVGRectElement`
  - `469` `SVGSVGElement`
  - `421` `SVGPathElement`
  - `379` `SVGGElement`
- **Filter hot path**:
  `toComparable()` reprocessed constant filter operands for every row.

#### Memory audit

- Event listeners: `2,894 -> 10,461` (`+7,567`)
- Node count delta after interactions: `+5,011`

### Initial synchronous pipeline research (session `6f25fa39` cp12)

The main research phase decomposed the pipeline into hot paths and fix batches.

#### Architecture observed before fixes

- `StudioState.dataSources` stored flat `Record<string, unknown>[]` rows inline.
- The store was a custom `Store<State>` built on `useSyncExternalStore`, not
  Zustand.
- `commitState()` replaced the root object, but preserved nested references when
  slices were unchanged.
- `createSelectorMemoized()` existed in `@mui/x-internals/store` but was not
  used in x-studio.

#### Critical issues discovered

1. **Double chart pipeline** in `useChartWidgetData.ts`
   - `filteredRowsNoCross` ran even when no cross-filters existed.
   - `allEnrichedRows` and `allSeriesNames` depended on that extra work.
   - `hasCrossFilters` was declared too late to guard those memos.
2. **Join expression O(N×M)** in
   `packages/x-studio/src/utils/expressionEvaluator.ts`
   - `relationships.find()` plus `relatedSource.rows.find()` for every row.
   - Fix direction: build `joinIndexes` before `rows.map()`.
3. **Foreign enrichment duplication** in `resolveRows()`
   - Cross-filter foreign rows were re-enriched without caching.
4. **Selector instability across hot files**
   - Inline `useStudioSelector()` arrows across widgets and drawers.
5. **Repeated relationship traversal**
   - `findDirectFieldOwner()` repeated for the same fields.
6. **Metric-ref lookup cost**
   - `resolveMetricRefs()` lacked a prebuilt row index.
7. **Filter widget cost**
   - Expression enrichment ran even for native fields.
8. **Temporal gap filling cost**
   - Gap filling did more validation than needed.

#### Research notes that stayed important later

- `enrichRowsWithRelatedFields()` already used a prebuilt `Map`; it became the
  model for fixing `enrichRowsWithExpressions()`.
- `computeGridSummary()` remained acceptable for current sizes but was called out
  as a future bottleneck around `500k+` rows.
- Comparison points from x-data-grid were noted but not directly ported:
  eval-compiled filters, row hash lookups, `throttleRowsMs`, bottom-up grouped
  aggregation, and incremental row patching.

## Pipeline Architecture

### Layer model

Checkpoint research sometimes called normalization **L0**. The benchmark files
use **L1-L5**. This reference uses the benchmark numbering.

- **L1** — normalize source rows and precompute field metadata via
  `normalizeDataSourceRows()`, `getCachedNormalizedDataSource()`, and
  `normalizedRowsCache.ts`
- **L2** — enrich rows with expression fields via
  `enrichRowsWithExpressions()`, `getCachedEnrichedRows()`, and
  `enrichedRowsCache.ts`
- **L3** — apply filters, semijoins, metric refs, and cross-filter resolution
  via `resolveRows()`, `resolveRowsCached()`, `chartUtils.ts`, and
  `resolvedRowsCache.ts`
- **L4** — re-anchor chart rows to the correct grain / source via
  `resolveChartRowsForAggregation()`
- **L5** — aggregate into chart / grid / KPI-friendly series via
  `aggregateByField()`, `aggregateByTwoFields()`,
  `aggregateMultipleSeries()`, and `cachedCompute()`
- **Async path** — build request descriptors, dedupe requests, and optionally
  skip L3-L5 client work via `buildQueryDescriptor()`, `StudioRequestCache`,
  `StudioDataSourceAdapter`, and `createBatchingAdapter()`

### Cache stack

- **Normalized rows**
  - file: `normalizedRowsCache.ts`
  - shape: `WeakMap<Row[], Map<string, NormCacheEntry>>`
  - key design: outer key = raw `rows`; inner key = widget field set or `*`
  - invalidation: schema ref (`fields`) or raw row ref changes
- **Enriched rows**
  - file: `enrichedRowsCache.ts`
  - shape: `Map<sourceId, Map<fieldSetKey, EnrichCacheEntry>>`
  - key design: source-scoped + widget field set
  - invalidation: own rows ref, relevant field refs, joined source row refs, and
    relevant relationship refs
- **Resolved rows**
  - file: `resolvedRowsCache.ts`
  - shape: `WeakMap<Row[], Map<string, ResolvedCacheEntry>>`
  - key design: outer key = widget source rows; inner key =
    `sourceId::filterKey::fieldSetSegment`
  - invalidation: relationship ref changes or tracked cross-filter foreign row
    refs change
- **Computed aggregates**
  - file: `computedCache.ts`
  - shape: `WeakMap<Row[], Map<string, unknown>>`
  - key design: outer key = row array ref; inner key = config string
  - invalidation: automatic GC when row ref changes
- **Chart grain cache**
  - file: `chartUtils.ts` (`rcfaCache`)
  - shape: `WeakMap<Row[], WeakMap<Row[], Map<string, Row[]>>>`
  - key design: outer key = widget rows; inner key = anchor rows
  - invalidation: automatic GC when either row ref changes
- **Async request cache**
  - file: `StudioRequestCache.ts`
  - shape: TTL cache + in-flight map + source index
  - key design: `sourceId:${sortedStringify(descriptor)}`
  - invalidation: TTL expiry or `invalidateSource(sourceId)`

### QueryDescriptor async pipeline

The async architecture added an optional adapter path without changing the
existing synchronous path.

#### Descriptor model

`StudioQueryDescriptor` carries the widget request as pure data:

- `sourceId`
- `widgetId`
- `select[]`
- `filter?` as recursive `StudioFilterNode`
- `groupBy?`
- `aggregations?`
- `xGroupBy?`
- `cacheKey`

`buildQueryDescriptor(widget, filters, activePageId)` converts widget config and
scoped filters into that descriptor.

#### Adapter model

- `StudioDataSource.adapter?: StudioDataSourceAdapter`
- `StudioDataSourceAdapter.getRows(descriptor): Promise<StudioQueryResult>`
- `useWidgetRows()` checks `Boolean(dataSource?.adapter)` and switches into the
  async path.
- For adapter-backed sources:
  - `filteredRowsNoCross === filteredRows`
  - `hasCrossFilters === false`
  - `StudioRequestCache` seeds stale rows synchronously and revalidates in the
    background

### Filter indexing and partitioning

Three separate filter-oriented optimizations emerged:

1. **`fieldDistinctValues`** on `StudioDataSource`
   - Added in `normalizeDataSourceRows()` for string / boolean fields.
   - Used to make filter widgets fast for native fields.
2. **`selectPartitionedFilters`** in `context/selectors.ts`
   - Memoized partitioning of the full filter list into page, widget, cross, and
     interactive buckets.
   - Replaced repeated `filters.filter()` scans in `useWidgetRows()`.
3. **Metric-ref row index** in `resolveMetricRefs()`
   - Built a `Map<rowId, Row>` to avoid repeated scans.

### Lazy-by-widget enrichment and normalization

The later pipeline no longer assumes every widget needs every field from its
source.

#### Enrichment

- `getCachedEnrichedRows()` gained `usedFieldIds?: Set<string>`.
- Cache moved from one slot per source to one slot per source + field set.
- `expandWithDependencies()` ensures transitive expression dependencies are
  included.
- `collectSelectFields(widget)` from `queryDescriptor.ts` provides the initial
  widget field set.

#### Normalization

- `normalizeDataSourceRows()` gained `usedFieldIds?: Set<string>`.
- The store stopped eagerly normalizing on ingestion.
- Each widget now normalizes only the date and categorical fields it uses.
- `StudioFilterWidget` normalizes with `new Set([fieldId])` for its own field.

## Optimizations Implemented

### 1. UI profiling fixes before the pipeline batches

#### Stable per-widget selectors in `StudioWidgetCard.tsx`

- Added selector factories in `packages/x-studio/src/context/selectors.ts`:
  - `makeSelectWidget`
  - `makeSelectIsWidgetSelected`
  - `makeSelectIsWidgetDimmed`
  - `makeSelectWidgetSource`
  - `makeSelectWidgetRankFilter`
  - `makeSelectWidgetSliderFilter`
  - `makeSelectWidgetActiveCrossFilter`
- Replaced `7` inline selectors in `StudioWidgetCard.tsx` with stable
  memoized factories.

#### Dragleave leak fix in `StudioCanvas.tsx`

- Replaced anonymous `dragleave` listener with named `handleDragLeave`.
- Added `removeEventListener('dragleave', handleDragLeave)` in cleanup.

### 2. Batches 1-5: hot-path structural fixes

- **Batch 1** (`991ea711cc`) — early `hasCrossFilters` guard, join
  indexes, stable selectors in hot files, foreign enrichment cache
- **Batch 2** (`7e44a42576`) — stable selectors across ~60 call sites, KPI
  pre-enrichment + `skipEnrichment`, `findDirectFieldOwner` cache, metric-ref
  row index
- **Batch 3** (`6b95434439`) — temporal gap optimizations, filter enrichment
  guard, `fieldDistinctValues`
- **Batch 4** (`5620d7374d`) — shared cross-widget `resolvedRowsCache`
- **Batch 5** (`3cf482f319`) — reuse `fieldOwners` / `anchorSourceId` from
  `analyzeChartSupport()`

#### Batch 1 details

- Moved `hasCrossFilters` ahead of `filteredRowsNoCross` in
  `useChartWidgetData.ts`.
- Guarded `filteredRowsNoCross` so no-cross-filter paths return the exact
  `filteredRows` reference.
- Added `joinIndexes?: Map<string, { sourceField: string; index: Map<unknown, Row> }>`
  to `EvaluationContext`.
- Built the join index before `rows.map()` in `enrichRowsWithExpressions()`.
- Added a foreign-source enrichment cache in `resolveRows()`.
- Converted hot-path files to stable module-level selectors.

#### Batch 2 details

- Finished the stable-selector migration across remaining files.
- Added `selectActivePage`.
- Added `resolveRows(..., options?: { skipEnrichment?: boolean })`.
- KPI widgets now enrich once, then reuse `skipEnrichment: true` for current and
  previous-period passes.
- `resolveMetricRefs()` gained:
  - early exit when no ref-based filters exist
  - lazy `Map<rowId, Row>` creation
  - `resolveReferencedFilterValueFast()`
- `findDirectFieldOwner()` got a `Map<fieldId, sourceId | null>` cache.

#### Batch 3 details

- `fillTemporalLabelGaps()` switched to in-place date stepping.
- Validation was reduced to first / last label checks because labels from the
  same bucket already share granularity.
- `normalizeDataSourceRows()` always computes `fieldDistinctValues` even when no
  date fields are present.
- `StudioFilterWidget` stopped enriching all rows when the displayed field is a
  native field.

#### Batches 4-5 details

- `resolvedRowsCache.ts` introduced a shared cache for widgets on the same page.
- Cache key:
  `"${sourceId}::${sortedFilterFingerprint}"`, where the fingerprint is a
  sorted `filter.id:JSON.stringify(filter.value)` list.
- Later, `ChartSupportResult` was extended to include `fieldOwners` and
  `anchorSourceId`, so `resolveChartRowsForAggregation()` could stop recomputing
  relationship ownership.

### 3. Batch 6: page-switch fix and benchmark harness

Commit: `9f81e17f44`

#### `computedCache.ts`

- Added `cachedCompute<T>(rows, key, compute)`.
- Design:
  - outer `WeakMap` key = `Row[]`
  - inner `Map<string, unknown>` key = config string
- This made return visits to previously-opened pages effectively O(1) because
  `resolvedRowsCache()` reused the same `Row[]` references.

#### Aggregation memoization in `useChartWidgetData.ts`

Wrapped all major L5 aggregation memos with `cachedCompute()`:

- `chartData`
- `seriesFieldData`
- `multiYData`
- `allSeriesNames`
- `allChartData`
- `allSeriesFieldData`
- `allMultiYData`
- `scatterData`

#### Benchmark harness

Added:

- `src/benchmarks/syntheticData.ts`
- `src/benchmarks/pipeline.bench.ts`
- `src/benchmarks/run.ts`
- `vitest.config.bench.mts`
- `package.json` `bench` script

### 4. Batch 7-8: fine-grained cache sentinels

#### Batch 7 (`5b3f663f6c`, `f750dec0f0`)

- Added `enrichedRowsCache.ts` as a per-source L2 cache.
- `resolveRows()` and `StudioKpiWidget` switched to `getCachedEnrichedRows()`.
- `FilterValueInput.tsx` got a `150 ms` debounce to reduce rapid store churn.
- Identified that module-wide sentinels were too coarse.

#### Batch 8 (`f4cd680d44`, `507d4d6409`)

- Rewrote `resolvedRowsCache.ts` from broad module sentinels to:
  `WeakMap<Row[], Map<string, ResolvedCacheEntry>>`
- Removed the old `globalFilters` sentinel parameter entirely.
- Each entry now tracks:
  - `relationships` ref
  - `crossFilterSourceRows: Map<string, Row[]>`
- Fixed the resulting stale-anchor bug in
  `resolveChartRowsForAggregation()` by introducing:
  `WeakMap<Row[], WeakMap<Row[], Map<string, Row[]>>>`
- `StudioFilterWidget` switched from direct enrichment to
  `getCachedEnrichedRows()`.

### 5. Pipeline abstraction

Commits: `ca3204c93f`, `28cc192251`

#### New abstractions

- `useWidgetRows.ts` — shared L1+L3 hook
- `useChartRows.ts` — shared L4 hook
- `StudioPipeline.ts` — pure factory for non-React consumers

#### Adoption

- `useChartWidgetData.ts` replaced ~80 lines of manual filter wiring.
- `StudioGridWidget.tsx` replaced five selector subscriptions plus a large rows
  memo with `useWidgetRows()`.
- `StudioWidgetCard.tsx` export logic switched to
  `createStudioPipeline(state).resolveWidgetRows()`.
- `StudioKpiWidget.tsx` partially adopted `useWidgetRows()` for the current
  period while keeping custom trend logic.

### 6. Async adapter path and request cache

Commit: `97ab003ff5`

#### Added files

- `queryDescriptor.ts`
- `StudioRequestCache.ts`
- `queryDescriptor.test.ts`
- `StudioRequestCache.test.ts`
- `examples/x-studio/src/simulatedServer.ts`

#### Main behavior

- `useWidgetRows()` gained async adapter support and `isLoading`.
- `StudioController` gained `setDataSourceAdapter(sourceId, adapter)`.
- `StudioHandle` exposed the same imperative API.
- The example app added `?adapter` mode and an Adapter Mode chip.
- The request cache uses stale-while-revalidate plus in-flight deduplication.
- Default TTL recorded in checkpoints: **30 s**.

### 7. Lazy-by-widget pipeline

Commits:

- `20e01a8f4b` — lazy-by-widget enrichment
- `007959b3de` — lazy-by-widget normalization

#### Enrichment changes

- `enrichedRowsCache.ts` became a two-level `Map<sourceId, Map<fieldSetKey, entry>>`.
- `resolveRows()` gained `options.usedFieldIds`.
- `resolvedRowsCache()` incorporated `fieldSetSegment` into its cache key.
- `queryDescriptor.ts` exported `collectSelectFields()`.
- `useWidgetRows.ts` computed `usedFieldIds` from widget config plus active
  filter fields.

#### Normalization changes

- `normalizedRowsCache.ts` became a two-level WeakMap keyed by raw rows and
  field-set key.
- `StudioController` stopped eagerly storing normalized data.
- `useWidgetRows()` started using `normalizedDataSource.rows`.
- `StudioFilterWidget` added a per-field normalization path.

### 8. P0-P2 follow-up fixes

Recorded in cp24; implementation was nearly complete.

#### P0 correctness

- Added `expressionFields` to the `useChartRows()` dependency array.
- Fixed KPI trend enrichment to reuse widget-scoped `usedFieldIds`.
- Fixed `StudioController.removeWidget()` so it removes orphaned widget and
  interactive filters while preserving the original array reference when nothing
  changes.

#### P1 performance

- Wrapped KPI computations with `cachedCompute()`.
- Scoped chart grain rebase enrichment with `usedFieldIds`.
- Added `makeSelectExpressionFieldsForSource()` with element-level memoization.
- Added a secondary source index to `StudioRequestCache.invalidateSource()`.

#### P2 structural cleanup

- Added `selectPartitionedFilters` and `PartitionedFilters`.
- Replaced inline interactive-filter lookup with
  `makeSelectActiveInteractiveFilter()`.
- Wrapped repeated `.find()` calls in `useMemo()`.
- Prebuilt field maps in `widgetUtils.tsx`.
- Added `usedFieldIds?` to the public `StudioPipeline.getEnrichedRows()` API.

### 9. Render-perf validation and later interaction bugs

#### BL70 render-perf tests

- `renderPerf.test.tsx` was created, then committed in `23539e0d5a`.
- The tests focused on selector memoization and widget smoke behavior.

#### Slider drag and layout-shift fixes

Session `6f25fa39` cp25 fixed three interaction bugs:

- HTML5 drag interception of slider input:
  - `mousedown` capture temporarily removes `draggable="true"` when the event
    originates inside `[data-no-drag]`.
- Clear-button layout shift in `StudioFilterWidget`:
  - always render the clear-button container and toggle `visibility`
- Cross-filter blank-chart regression:
  - discovered that source-scoped expression-field subscription was too narrow
    for cross-filter foreign-source enrichment

## Benchmark Results

### Final benchmark document (`2026-05-30`)

#### Pipeline layers — 10k rows

- `normalizeDataSourceRows` — `82 ops/s`, mean `12.147 ms`, p75 `11.941 ms`,
  p99 `60.609 ms`
- `getCachedNormalizedDataSource (warm)` — `501,902 ops/s`, mean `0.002 ms`,
  p75 `0.001 ms`, p99 `0.014 ms`
- `enrichRowsWithExpressions` — `34 ops/s`, mean `29.848 ms`, p75 `33.904 ms`,
  p99 `87.080 ms`
- `getCachedEnrichedRows (warm)` — `118,320 ops/s`, mean `0.008 ms`,
  p75 `0.005 ms`, p99 `0.072 ms`
- `resolveRows (cold)` — `989 ops/s`, mean `1.011 ms`, p75 `1.116 ms`,
  p99 `7.086 ms`
- `resolveRowsCached (warm)` — `221,358 ops/s`, mean `0.005 ms`,
  p75 `0.003 ms`, p99 `0.022 ms`
- `resolveChartRows (cold)` — `76,263 ops/s`, mean `0.013 ms`,
  p75 `0.011 ms`, p99 `0.061 ms`
- `resolveChartRows (warm)` — `25,503 ops/s`, mean `0.039 ms`,
  p75 `0.011 ms`, p99 `1.214 ms`
- `aggregateByField` — `643 ops/s`, mean `1.554 ms`, p75 `1.381 ms`,
  p99 `6.063 ms`
- `aggregateByTwoFields` — `309 ops/s`, mean `3.241 ms`, p75 `3.324 ms`,
  p99 `21.083 ms`
- `aggregateMultipleSeries` — `321 ops/s`, mean `3.116 ms`, p75 `3.548 ms`,
  p99 `14.589 ms`

#### Pipeline layers — 100k rows

- `normalizeDataSourceRows` — `6 ops/s`, mean `161.903 ms`, p75 `185.915 ms`,
  p99 `509.340 ms`
- `getCachedNormalizedDataSource (warm)` — `2,146,844 ops/s`, mean `0.000 ms`,
  p75 `0.000 ms`, p99 `0.002 ms`
- `enrichRowsWithExpressions` — `3 ops/s`, mean `381.110 ms`, p75 `401.069 ms`,
  p99 `1293.253 ms`
- `getCachedEnrichedRows (warm)` — `394,086 ops/s`, mean `0.003 ms`,
  p75 `0.003 ms`, p99 `0.004 ms`
- `resolveRows (cold)` — `149 ops/s`, mean `6.710 ms`, p75 `8.099 ms`,
  p99 `23.739 ms`
- `resolveRowsCached (warm)` — `474,874 ops/s`, mean `0.002 ms`,
  p75 `0.002 ms`, p99 `0.003 ms`
- `resolveChartRows (cold)` — `128,151 ops/s`, mean `0.008 ms`,
  p75 `0.007 ms`, p99 `0.060 ms`
- `resolveChartRows (warm)` — `155,582 ops/s`, mean `0.006 ms`,
  p75 `0.006 ms`, p99 `0.008 ms`
- `aggregateByField` — `53 ops/s`, mean `18.981 ms`, p75 `17.237 ms`,
  p99 `112.776 ms`
- `aggregateByTwoFields` — `43 ops/s`, mean `22.997 ms`, p75 `25.680 ms`,
  p99 `89.385 ms`
- `aggregateMultipleSeries` — `38 ops/s`, mean `26.442 ms`, p75 `30.559 ms`,
  p99 `49.764 ms`

#### Async adapter path

- `buildQueryDescriptor` with `1` filter — `6,424 ops/s`, mean `0.156 ms`,
  p75 `0.029 ms`, p99 `6.105 ms`
- `buildQueryDescriptor` with `10` filters — `1,219 ops/s`, mean `0.820 ms`,
  p75 `0.126 ms`, p99 `34.499 ms`
- `buildQueryDescriptor` with `50` filters — `559 ops/s`, mean `1.789 ms`,
  p75 `0.851 ms`, p99 `20.165 ms`
- `cache.get (warm hit)` — `789,465 ops/s`, mean `0.001 ms`, p75 `0.001 ms`,
  p99 `0.014 ms`
- `cache.get (miss)` — `1,834,862 ops/s`, mean `0.001 ms`, p75 `0.000 ms`,
  p99 `0.003 ms`
- `cache set+get (100 rotating keys)` — `118,122 ops/s`, mean `0.008 ms`,
  p75 `0.008 ms`, p99 `0.032 ms`
- `invalidateSource` with `10` entries — `969 ops/s`, mean `1.032 ms`,
  p75 `0.292 ms`, p99 `18.245 ms`
- `invalidateSource` with `100` entries — `120 ops/s`, mean `8.305 ms`,
  p75 `7.637 ms`, p99 `98.174 ms`
- `invalidateSource` with `1,000` entries — `28 ops/s`, mean `35.820 ms`,
  p75 `35.647 ms`, p99 `167.773 ms`

#### Final observations from the benchmark doc

- Cached L1-L3 paths are **1,000× to 100,000× faster** than cold paths.
- L2 remained the dominant cold-path bottleneck at 100k rows.
- Single-field L5 aggregation at 100k rows was ~`19 ms`, inside a 50 ms frame
  budget for many dashboard scenarios.
- `buildQueryDescriptor()` stayed under `2 ms` even with `50` filters.

### Historical benchmark snapshots from checkpoints

#### cp17 snapshot (100k rows)

- L1 `normalizeDataSourceRows`: `47 ms`
- L2 `enrichRowsWithExpressions`: `242 ms`
- L3 `resolveRows` cold: `316 ms`
- L3 `resolveRowsCached` warm: `0.002 ms` (~`200,000×` faster)
- L4 `resolveChartRowsForAggregation` cold: `0.004 ms`
- L5a: `24 ms`
- L5b: `19 ms`
- L5c: `29 ms`

#### cp18 snapshot after fine-grained cache fixes (100k rows)

- L2: `242 ms -> 163 ms` (`1.5×`)
- L3 cold: `316 ms -> 4.2 ms` (`75×`)
- L3 warm: `0.002 ms -> 0.001 ms`
- L5a: `24 ms -> 5.4 ms` (`4.4×`)
- L5b: `19 ms -> 6.7 ms` (`2.8×`)
- L5c: `29 ms -> 9.9 ms` (`2.9×`)

### Server middleware benchmark notes

The async/server docs also recorded benchmark numbers for the middleware stack:

- `COUNT(*)` preflight — `0.07 ms` at 10k, `0.73 ms` at 100k, `7 ms` at 1M
- full scan — `12 ms` at 10k, `127 ms` at 100k, `2200 ms` at 1M
- `GROUP BY SUM` — `1.65 ms` at 10k, `18 ms` at 100k, `207 ms` at 1M

## UI Performance Review

### Review method

The UI review doc framed x-studio performance work around five dimensions:

1. lab metrics / Core Web Vitals traces
2. real-user measurement via `web-vitals`
3. React-specific profiling
4. bundle analysis
5. MUI / MUI X-specific tuning

### Tooling wired into the example app

- `chrome-devtools-mcp`
- `@danielsogl/lighthouse-mcp`
- `@playwright/mcp`
- `cdp-extended-mcp`
- `react-scan`
- `@welldone-software/why-did-you-render`
- React DevTools Profiler
- `rollup-plugin-visualizer`
- `web-vitals` with attribution

### What the UI review proved

- The slowest user-visible paths were dominated by data generation and row
  resolution, not by bundle splitting opportunities.
- React 19 selector identity was a concrete regression source in x-studio's
  `useSyncExternalStore` architecture.
- At 100k rows, the synchronous filter / resolve pipeline was enough to destroy
  INP / TBT budgets without aggressive caching.
- The example app needed both **UI-level fixes** (stable selectors, leak
  cleanup, layout stability) and **data-pipeline fixes**.

### MUI-specific guidance that informed the fixes

The review called out several rules that later matched the checkpoint fixes:

- prefer stable module-level selectors over inline closures
- avoid `sx` on hot render paths
- treat DataGrid virtualization and memoized props as mandatory
- use chart `skipAnimation` for rapid data churn
- reserve layout space to avoid CLS

## Known Remaining Issues

These are the follow-up items still open in checkpoint history. Some may have
changed later in the branch, but they remained unresolved in the recorded
checkpoint material used for this document.

### Pipeline follow-ups

- **`toComparable()` precomputation**
  - Numeric filter operands were still recomputed per row.
  - Proposed fix: precompute comparable filter operands in `applyFilters()` and
    pass them into row evaluation.
- **`makeSelectExpressionFieldsForSources()` wiring**
  - cp25 introduced the multi-source selector needed to avoid blank charts while
    still narrowing subscriptions, but the final `useWidgetRows.ts` wiring was
    still pending in the checkpoint.
- **`enrichSourceRowsWithExpressions()` field scoping**
  - Research identified a remaining opportunity to pass precise `usedFieldIds`
    for cross-source chart grain rebase.
- **KPI-specific cache parity**
  - Research repeatedly noted that KPI trend enrichment needed to use the same
    `usedFieldIds` slot as `useWidgetRows()`.

### UI / UX follow-ups

- **CLS 0.282** in the example app
  - suspected cause: charts / KPI widgets changing size while data loads
  - proposed fix: min-height reservation or skeleton states
- **Detached SVG node cleanup**
  - chart cleanup / observer cleanup still needed deeper investigation
- **Page-switch regressions**
  - largely improved by `computedCache`, but page-switch behavior remained a
    recurring investigation area during the batch work

### Validation / monitoring follow-ups

- keep the benchmark harness in sync across `pipeline.bench.ts` and `run.ts`
- continue watching `invalidateSource()` costs if cache cardinality grows
- use BL70 render-perf tests as a regression safety net

## Key Files

### Core synchronous pipeline

- `packages/x-studio/src/internals/chartUtils.ts` — main pipeline
  implementation: `resolveRows`, `resolveChartRowsForAggregation`, aggregation
  helpers, normalization, and temporal utilities
- `packages/x-studio/src/utils/expressionEvaluator.ts` — expression enrichment
  engine; originally contained the O(N×M) join lookup
- `packages/x-studio/src/internals/useWidgetRows.ts` — shared L1+L3 hook for
  widget row resolution
- `packages/x-studio/src/internals/useChartRows.ts` — shared L4 hook for chart
  grain rebase
- `packages/x-studio/src/internals/StudioPipeline.ts` — pure pipeline factory
  for non-React callers

### Cache layers

- `packages/x-studio/src/internals/normalizedRowsCache.ts` — L1 widget-scoped
  normalization cache
- `packages/x-studio/src/internals/enrichedRowsCache.ts` — L2 per-source /
  per-field-set enrichment cache
- `packages/x-studio/src/internals/resolvedRowsCache.ts` — L3 resolved-row
  cache keyed by widget rows + filter fingerprint
- `packages/x-studio/src/internals/computedCache.ts` — L5 generic computed-data
  cache

### Selectors and filter partitioning

- `packages/x-studio/src/context/selectors.ts` — stable selectors,
  parameterized selector factories, and the partitioned-filter selector
- `packages/x-studio/src/StudioChartWidget/useChartWidgetData.ts` — main chart
  consumer of the pipeline; contains L5 memoization and cross-filter
  orchestration
- `packages/x-studio/src/StudioKpiWidget/StudioKpiWidget.tsx` — KPI-specific
  pipeline consumer with current / previous period logic
- `packages/x-studio/src/StudioFilterWidget/StudioFilterWidget.tsx` — filter
  widget use of `fieldDistinctValues`, normalization, and scoped enrichment

### Async adapter path

- `packages/x-studio/src/internals/queryDescriptor.ts` — builds
  `StudioQueryDescriptor`, filter trees, stable hashes, and select-field
  collection
- `packages/x-studio/src/internals/StudioRequestCache.ts` — TTL cache,
  stale-while-revalidate, in-flight dedup, and source invalidation
- `packages/x-studio/src/server/createBatchingAdapter.ts` — client batching
  adapter with shared cache-key semantics
- `examples/x-studio/src/simulatedServer.ts` — in-memory async adapter used by
  the demo app
- `packages/x-studio-middleware/src/handler.ts` — framework-agnostic server entry
  point: `handleBatchQuery()`

### Benchmarking and validation

- `packages/x-studio/src/benchmarks/pipeline.bench.ts` — Vitest benchmark suite
  for L1-L5 and the async path
- `packages/x-studio/src/benchmarks/run.ts` — console-table benchmark runner
- `packages/x-studio/src/internals/renderPerf.test.tsx` — selector memoization
  and render-perf regression tests
- `packages/x-studio/src/internals/useWidgetRows.test.ts` — sync vs async path
  integration tests

### Example-app UI review artifacts

- `examples/x-studio/src/main.tsx` — dev-only profiling hooks: WDYR,
  `react-scan`, and `reportWebVitals()`
- `examples/x-studio/src/wdyr.ts` — why-did-you-render configuration
- `examples/x-studio/src/reportWebVitals.ts` — Core Web Vitals + attribution
  collection
- `examples/x-studio/vite.config.ts` — bundle visualizer and profiling aliases
- `packages/x-studio/src/StudioCanvas/StudioCanvas.tsx` — contained the
  dragleave leak fix
- `packages/x-studio/src/StudioWidgetCard/StudioWidgetCard.tsx` — contained the
  initial stable-selector fix and later export-path pipeline adoption

## Closing summary

The x-studio performance work evolved from a UI profiling exercise into a
full-stack pipeline redesign. The main outcome was not a single optimization;
it was the introduction of a layered, reference-stable cache architecture with
widget-scoped normalization and enrichment, plus an opt-in async path based on
`StudioQueryDescriptor`. The cold-path bottleneck that still matters is L2
expression enrichment. Everything else was progressively pushed toward cache hits
and stable references.
