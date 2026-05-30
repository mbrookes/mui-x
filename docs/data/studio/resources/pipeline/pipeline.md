---
title: Studio - Data pipeline
productId: x-studio
packageName: '@mui/x-studio'
githubLabel: 'scope: studio'
---

# Studio - Data pipeline

<p class="description">Reference for the Studio data processing pipeline — from raw store state to the row arrays your widgets render.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader", "design": false}}

## Overview

Studio's data pipeline transforms raw source rows into the filtered, enriched row arrays that each widget renders.
It runs in two modes depending on whether the source has an async adapter:

| Mode                 | When                            | What runs                                                                                   |
| :------------------- | :------------------------------ | :------------------------------------------------------------------------------------------ |
| **Sync (in-memory)** | `dataSource.adapter` is not set | L1 normalization → L2 enrichment → L3 filter application → (L4 chart re-anchor for charts)  |
| **Async (adapter)**  | `dataSource.adapter` is set     | `buildQueryDescriptor` → `StudioRequestCache` → `adapter.getRows()` → returns rows directly |

## Store entries

The pipeline reads from four slices of `StudioState`:

| Entry              | Type                               | Description                                                                                                                                                                                            |
| :----------------- | :--------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dataSources`      | `Record<string, StudioDataSource>` | Raw rows, field schema, and optional `adapter` for each source. Row array reference identity is used as a cache key — replacing the array automatically invalidates downstream caches for that source. |
| `expressionFields` | `StudioExpressionField[]`          | Calculated columns and aggregated measures. Dependencies between expression fields are resolved transitively at enrichment time (L2).                                                                  |
| `relationships`    | `StudioRelationship[]`             | Foreign-key links between sources. Used by enrichment (join-field expressions), cross-source filter resolution, and chart re-anchoring (L4).                                                           |
| `filters`          | `StudioFilterState[]`              | All active filter states. Each entry carries a `scope` tag (`'page'`, `'widget'`, `'cross-filter'`, `'interactive'`), plus `widgetId`, `sourceWidgetId`, and `pageId` for scoping.                     |

## Pre-partitioned filter selector

`selectPartitionedFilters` is a store selector that splits the flat `filters` array into `{ page, byWidgetId, cross, interactive }` once, before any widget reads it.
All per-widget filter lookups consume this pre-split structure instead of scanning the full array.

In `useWidgetRows`, the partitioned filters are wrapped in `React.useDeferredValue`:

```tsx
const partitioned = useStudioSelector(selectPartitionedFilters);
const deferredPartitioned = React.useDeferredValue(partitioned);
```

This lets React commit UI updates (e.g. highlighting the clicked bar) immediately while deferring the expensive row re-computation to a lower-priority render pass.
`isRecomputing` is `true` in the gap between the two renders.

## Sync pipeline layers

### L1 · Normalization — `getCachedNormalizedDataSource`

Parses ISO date strings to `Date` objects and builds `fieldDistinctValues` indexes for string fields.
Uses a two-level `WeakMap<rows[], Map<fieldSetKey, entry>>` cache:

- **Outer key** — the rows array reference. Entries are garbage-collected automatically when the rows array is replaced.
- **Inner key** — a sorted comma-joined string of field IDs being normalized (`usedFieldIds`). Each widget gets its own cache slot so adding an unused field to another widget has zero cost here.

### L1 · Metric-ref resolution — `resolveMetricRefs`

Replaces `{ type: 'metric-ref', sourceId, rowId, fieldId }` filter values with their current scalar value from the named row in the `businessMetrics` source.
Called once over the merged filter list before the filter application step.

### L2 · Enrichment — `getCachedEnrichedRows`

Appends expression-field values (calculated columns and join-field expressions) to each row.
The cache is per-source and tracks only the inputs that source actually depends on:
own row ref, expression field object refs for this source, joined-source row refs, and relationship refs.
Changing another source's data or expressions has no cost for unrelated source cache entries.

Transitive expression dependencies are expanded: if field A references field B, B is included in the enrichment set even if the widget did not explicitly request it.

### L3 · Filter application — `resolveRowsCached`

Applies the resolved filter set to enriched rows.
Cache key is a content fingerprint of the effective filter set (not a global sentinel), so changing an unrelated widget's filter is a cache hit for other widgets.
Cross-filter foreign-source row refs are tracked as secondary dependencies for correct invalidation when a chart-click changes the view.

### L4 · Cross-source chart re-anchor — `resolveChartRows`

Called by chart widgets only when a y-field, series field, or x-field references a field from a **related** source.
Re-projects the already-filtered rows onto the correct aggregation grain using the declared relationships.
Skipped entirely when all widget fields live on the primary source.

## Async adapter path

When `dataSource.adapter` is set, the in-memory pipeline (L1–L3) is bypassed for that source.
Instead:

1. `buildQueryDescriptor(widget, filters, activePageId)` assembles a `StudioQueryDescriptor` with `select`, a recursive `filter` tree, `groupBy`, `xGroupBy`, `aggregations`, and a deterministic `cacheKey`.
2. `StudioRequestCache` is checked. On a hit, rows are returned synchronously — no loading state.
3. On a miss, `adapter.getRows(descriptor)` is called. Concurrent requests with the same `cacheKey` are deduplicated — only one `getRows()` call is made.
4. The settled result is stored in `StudioRequestCache` (TTL: 30 s, stale-while-revalidate).

### `buildQueryDescriptor`

Builds the query sent to the adapter from the widget config and active filters.
The `cacheKey` is derived from the query shape only (excluding `widgetId`), so two widgets requesting the same source with identical filters share one cache entry and one in-flight request.

```ts
interface StudioQueryDescriptor {
  sourceId: string;
  widgetId: string;
  select: string[];
  filter?: StudioFilterNode;
  groupBy?: string;
  xGroupBy?: 'day' | 'week' | 'month' | 'quarter' | 'year';
  aggregations?: { field: string; fn: AggFn; alias: string }[];
  cacheKey: string;
}
```

### `StudioRequestCache`

Module-singleton cache for async adapter results.

| Feature                   | Detail                                                                                       |
| :------------------------ | :------------------------------------------------------------------------------------------- |
| TTL                       | 30 s                                                                                         |
| Inflight deduplication    | Multiple `getRows()` calls for the same `cacheKey` resolve from one shared `Promise`         |
| Stale-while-revalidate    | Returns last known result synchronously on the first render after a cache miss               |
| Source-level invalidation | `cache.invalidateSource(sourceId)` clears all entries whose key starts with `"${sourceId}:"` |

## `useWidgetRows` outputs

`useWidgetRows(widget, dataSource)` is the React hook that drives all widget row computation.
It returns:

| Output                | Type      | Description                                                                                                                                                                                 |
| :-------------------- | :-------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `effectiveRows`       | `Row[]`   | Rows the widget should render. Equals `filteredRowsNoCross` when `crossFilterMode: 'none'`; `filteredRows` otherwise.                                                                       |
| `filteredRows`        | `Row[]`   | All filters applied (page + widget + cross-filter + interactive). On the async path, equals `adapterRows`.                                                                                  |
| `filteredRowsNoCross` | `Row[]`   | Page and widget filters only — cross-filter and interactive filters excluded. Same reference as `filteredRows` when no cross-filters are active. On the async path, same as `filteredRows`. |
| `hasCrossFilters`     | `boolean` | `true` if any chart-click or interactive filter from another widget is active on this page. Always `false` on the async path.                                                               |
| `shouldShowGhost`     | `boolean` | `true` only when `crossFilterMode === 'cross-highlight'` and a **chart-click** cross-filter is active. Interactive filter-widget selections never trigger ghost rendering.                  |
| `isLoading`           | `boolean` | `true` while an adapter fetch is in flight with no prior cached result. Always `false` on the sync path.                                                                                    |
| `isRecomputing`       | `boolean` | `true` while React's deferred update of the partitioned filter state has not committed. Always `false` on the async path.                                                                   |

## `createStudioPipeline`

A non-React factory that exposes the same underlying pipeline functions outside of a React render cycle.
Designed for CSV export handlers, benchmarks, and unit tests.

```ts
import { createStudioPipeline } from '@mui/x-studio';

const pipeline = createStudioPipeline(controller.getState());
```

### `pipeline.resolveWidgetRows(widgetId, sourceId, rows, pageId?)`

Equivalent to the sync path of `useWidgetRows` (L1–L3).
Applies metric-ref resolution, enrichment, and all scoped filters for a given widget.
Rank-mode widget filters are excluded — apply them after aggregation if needed.

```ts
const filtered = pipeline.resolveWidgetRows(
  'w1',
  'orders',
  source.rows,
  activePageId,
);
```

### `pipeline.resolveChartRows(filteredRows, sourceId, xField, yFields, seriesField)`

L4 cross-source chart re-anchor.
Call after `resolveWidgetRows` when generating chart data outside React (e.g. for a CSV export of a chart's aggregated data).

```ts
const chartRows = pipeline.resolveChartRows(
  filtered,
  'orders',
  'date',
  ['revenue'],
  'category',
);
```

### `pipeline.getEnrichedRows(rows, sourceId, usedFieldIds?)`

L2 enrichment only.
Returns rows with expression-field values appended.
Useful when you need enriched rows before applying custom filter logic outside the standard pipeline.

```ts
const enriched = pipeline.getEnrichedRows(
  source.rows,
  'orders',
  new Set(['expr-margin']),
);
```

## See also

- [Inline data sources](/x/react-studio/data/data-sources/) — the `dataSources`, `expressionFields`, and `relationships` entries the pipeline reads
- [Async adapters](/x/react-studio/data/async-adapters/) — replacing the in-memory pipeline with a server-side handler
- [Cross-filters](/x/react-studio/features/cross-filters/) — `crossFilterMode`, `shouldShowGhost`, and `filteredRowsNoCross`
- [Relationships](/x/react-studio/data/relationships/) — L4 cross-source aggregation and join-field expressions
- [Selectors](/x/react-studio/resources/selectors/) — `selectPartitionedFilters` and other store selectors
