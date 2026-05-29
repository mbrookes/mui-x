# x-studio Architecture

> **Audience:** engineers working on or integrating `@mui/x-studio`.
> **Scope:** end-to-end data pipeline, state management, UI structure, and public API surface.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [State Model](#2-state-model)
3. [Data Pipeline — Sync (In-Memory) Path](#3-data-pipeline--sync-in-memory-path)
4. [Data Pipeline — Async (Adapter) Path](#4-data-pipeline--async-adapter-path)
5. [Cache Layer](#5-cache-layer)
6. [Filter System](#6-filter-system)
7. [Cross-Filter & Cross-Highlight](#7-cross-filter--cross-highlight)
8. [Expression Fields](#8-expression-fields)
9. [Relationships](#9-relationships)
10. [Widget Types](#10-widget-types)
11. [State Persistence & Migration](#11-state-persistence--migration)
12. [UI Layout & Component Tree](#12-ui-layout--component-tree)
13. [Public API Surface](#13-public-api-surface)

---

## 1. System Overview

`@mui/x-studio` is a self-contained, embeddable analytics dashboard builder.
A host application mounts the `<Studio>` component, provides data sources at runtime, and can read/write state via the imperative `StudioHandle` or the `StudioController` class.

```mermaid
graph TD
    Host["Host Application"]
    Studio["&lt;Studio&gt; component"]
    Controller["StudioController\n(owns StudioState)"]
    Pipeline["Data Pipeline\n(sync or async)"]
    Widgets["Widget layer\n(Grid / Chart / KPI / Text / Filter / Pivot / Map)"]
    UI["UI Shell\n(Canvas + Drawers + Chat)"]

    Host -->|"props: state, dataSources, aiConfig"| Studio
    Studio -->|"wraps"| Controller
    Controller -->|"Store&lt;StudioState&gt;"| UI
    UI -->|"useWidgetRows(widget, source)"| Pipeline
    Pipeline -->|"effectiveRows"| Widgets
    Host -->|"StudioHandle ref"| Controller
```text

**Key design principles:**

- **Unidirectional data flow.** All mutations go through `StudioController` → `Store` → React subscriptions.
- **Pure pipeline.** The data pipeline functions are plain TypeScript — no React hooks required — enabling use in export handlers, benchmarks, and unit tests via `createStudioPipeline()`.
- **Lazy, widget-scoped computation.** Each widget independently normalises, enriches, and filters only the fields it actually uses, so adding an unused expression field costs nothing for existing widgets.
- **Two data paths.** In-memory sources run the full pipeline client-side. Sources with an async `adapter` skip the client pipeline entirely and delegate to the host's backend.

---

## 2. State Model

All mutable state lives in a single `StudioState` object managed by `StudioController`.

### 2.1 Top-level shape

```ts
interface StudioState {
  schemaVersion: 1;
  mode: 'edit' | 'view';
  dashboard: StudioDashboardState;   // id, title, activePageId
  pages: Record<string, StudioPage>; // keyed by page id
  widgets: Record<string, StudioWidget>; // keyed by widget id
  dataSources: Record<string, StudioDataSource>; // keyed by source id
  relationships: StudioRelationship[];
  filters: StudioFilterState[];      // page + widget + cross + interactive filters
  expressionFields: StudioExpressionField[]; // user-authored calculated columns/measures
  filterPresets?: StudioFilterPreset[];
  shell: StudioShellState;           // UI-only: open drawers, selection, drilldown
}
```text

### 2.2 Persisted vs runtime slices

| Slice              | Persisted? | Notes                                                                   |
| ------------------ | ---------- | ----------------------------------------------------------------------- |
| `dashboard`        | Yes        | title, activePageId                                                     |
| `pages`            | Yes        | layout, themes                                                          |
| `widgets`          | Yes        | config, title                                                           |
| `filters`          | Yes        | page-scope filters only; interactive/cross-filter filters are transient |
| `relationships`    | Yes        |                                                                         |
| `expressionFields` | Yes        |                                                                         |
| `dataSources`      | No         | provided by host at runtime; schemas/rows are never persisted           |
| `shell`            | No         | UI state; not persisted                                                 |

`dataSources` is intentionally excluded from serialization — data comes from the host and is injected via `controller.upsertDataSource()` or `<Studio dataSources={...}>`. This keeps the serialized state small and schema-agnostic.

### 2.3 StudioPage layout

```ts
interface StudioPage {
  id: string;
  title: string;
  widgetRows: string[][];          // 2D array: rows of widget IDs
  widgetColSpans?: Record<string, number>; // explicit 3–12 column span per widget
  theme?: StudioPageTheme;         // per-page colours and card styling
  stackBreakpoint?: number;        // px below which widgets stack full-width
}
```text

Widgets are arranged in a grid of rows. Each row is an array of widget IDs. Column widths are either equal-share (`flex: 1`) or an explicit 3–12 column span.

### 2.4 StudioController & Store

`StudioController` wraps a `Store<StudioState>` (MUI internal pub-sub store) and exposes a typed mutation API. All mutations go through `commitState()` which:

1. Pushes the current state to the undo stack (up to `MAX_UNDO_HISTORY = 100`).
2. Clears the redo stack on any new undoable action.
3. Calls `store.setState(nextState)` to notify all subscribers.

Shell mutations (drawer open/close, selection changes, drilldown) are committed with `{ undoable: false }` so they don't pollute the undo stack.

```mermaid
sequenceDiagram
    participant User
    participant Controller as StudioController
    participant Store
    participant React as React (useSyncExternalStore)

    User->>Controller: controller.updateWidget(id, changes)
    Controller->>Controller: undoStack.push(currentState)
    Controller->>Store: store.setState(nextState)
    Store-->>React: notify subscribers
    React->>React: re-render affected widgets
```text

---

## 3. Data Pipeline — Sync (In-Memory) Path

When a data source has no `adapter`, all data transformation happens in the browser.
The pipeline has four layers, each building on the previous one.

```mermaid
flowchart TD
    A["Raw rows\n(dataSources[id].rows)"]
    L1["L1: Normalisation\nnormalizedRowsCache\n• Date string → Date object\n• Build fieldDistinctValues index"]
    L2["L2: Expression enrichment\nenrichedRowsCache\n• Evaluate calculated columns\n• Resolve join-field expressions\n• Skip isMeasure fields"]
    L3["L3: Filter resolution\nresolvedRowsCache\n• Apply page filters\n• Apply widget filters\n• Apply cross-filters (scoped to pageId)\n• Apply interactive (filter widget) filters\n• Resolve metric refs first"]
    L4["L4: Chart re-anchoring\nchartUtils.resolveChartRowsForAggregation\n• Only for cross-source chart fields\n• Re-joins + aggregates at the correct grain"]
    OUT["effectiveRows → Widget render"]

    A --> L1 --> L2 --> L3
    L3 --> L4
    L3 -->|"Grid / KPI / Pivot / Map / Filter"| OUT
    L4 -->|"Chart only (cross-source fields)"| OUT
```text

### Layer L1 — Normalization (`normalizedRowsCache`)

- Converts date/datetime string values to ISO-8601 canonical strings for consistent comparisons.
- Builds `fieldDistinctValues` — a pre-sorted distinct-value index for each string/boolean field — so filter value dropdowns avoid O(N) scans per render.
- **Scope:** per-widget, per-field-set. Each widget normalises only its `usedFieldIds`, so different widgets sharing the same source get independent cache slots.

### Layer L2 — Expression Enrichment (`enrichedRowsCache`)

- Evaluates `StudioExpressionField` objects with `isMeasure: false` (calculated columns) row by row.
- Supports four expression node types:
  - `StudioFieldExpression` — reference to a native or expression field on the same source.
  - `StudioValueExpression` — a literal constant (`number | string | boolean | null`).
  - `StudioFunctionExpression` — an operator (arithmetic, comparison, logic, `if`, `datediff`) with sub-expression inputs. Fully recursive.
  - `StudioJoinFieldExpression` — reads a field from a related source row via FK lookup.
- `isMeasure: true` fields are **excluded** from row-level enrichment. They are single aggregate values computed on demand (not stored on rows).
- Transitive dependencies: if expression A references expression B, both are included in the enrichment pass for any widget that uses A.

### Layer L3 — Filter Resolution (`resolvedRowsCache`)

Filters are partitioned by scope before application:

| Scope          | Description                                                                                                                         |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `page`         | Applied to all widgets on the active page. Set by the filters drawer or date-range bar.                                             |
| `widget`       | Applied only to the widget they belong to (`widgetId` matches). Set in the compose drawer or widget edit dialog.                    |
| `cross-filter` | Emitted when a user clicks a data point on a chart. Scoped to `pageId`. Excluded for the source widget.                             |
| `interactive`  | Emitted by filter-widget selections (date-range, multi-select, toggle, slider). Scoped to `pageId`. Excluded for the source widget. |

Filter evaluation order: `page → widget → cross-filter → interactive`.

**Rank filters** (`filterMode: 'rank'`) are deliberately **excluded** from this layer. They must be applied after aggregation by each widget renderer.

**Metric ref resolution** runs before filter evaluation. A `StudioMetricRef` in a filter's `valueRef` field is resolved to a concrete value by looking up `dataSources[ref.sourceId].rows` for the named row and field. This allows filter thresholds to be driven by live business metrics.

### Layer L4 — Chart Re-Anchoring

Only required when a chart widget's x-axis, y-axis, or series field belongs to a **related source** (cross-source chart fields). In this case, the already-filtered rows may be at the wrong grain for aggregation. `resolveChartRowsForAggregation` re-joins the related sources and returns rows anchored to the correct aggregation grain.

### Row variants returned by `useWidgetRows`

`useWidgetRows(widget, dataSource)` returns multiple row variants to support ghost overlays:

| Property                   | Filters applied                                                               |
| -------------------------- | ----------------------------------------------------------------------------- |
| `filteredRows`             | All active filters (page + widget + cross + interactive)                      |
| `filteredRowsNoCross`      | Page + widget only (no cross-filter, no interactive)                          |
| `filteredRowsNoChartCross` | Page + widget + interactive (no chart-click cross-filter)                     |
| `effectiveRows`            | `filteredRowsNoCross` when `crossFilterMode='none'`; otherwise `filteredRows` |

`isRecomputing` is set via `React.useDeferredValue` on page/widget filter changes to show a loading overlay while React processes a heavy re-render without blocking the main thread.

---

## 4. Data Pipeline — Async (Adapter) Path

When `dataSource.adapter` is set, the client-side pipeline (L1–L4) is bypassed entirely. Instead, Studio builds a `StudioQueryDescriptor` and calls `adapter.getRows(descriptor)`.

```mermaid
flowchart TD
    A["Filter / widget config changes"]
    B["buildQueryDescriptor(widget, filters, pageId)"]
    C{"studioRequestCache\n.get(cacheKey)"}
    D["adapter.getRows(descriptor)"]
    E["studioRequestCache\n.set(cacheKey, result)"]
    F["adapterRows state\n(setAdapterRows)"]
    G["Widget render\n(effectiveRows = adapterRows)"]

    A --> B --> C
    C -->|"hit (TTL < 30s)"| F
    C -->|"miss or in-flight dedupe"| D --> E --> F
    F --> G
```text

### StudioQueryDescriptor

The descriptor is the complete, normalized description of what the adapter should return:

```ts
interface StudioQueryDescriptor {
  sourceId: string;
  widgetId: string;
  select: string[];           // field IDs the widget needs
  filter?: StudioFilterNode;  // recursive AND/OR tree of all active filters
  groupBy?: string;           // x-axis field for chart/KPI aggregation
  aggregations?: { field, fn, alias }[];
  xGroupBy?: 'day' | 'week' | 'month' | 'quarter' | 'year';
  cacheKey: string;           // stable hash of all other fields
}
```text

`cacheKey` is a deterministic sorted JSON hash of all other fields — two equivalent queries always produce the same key, enabling deduplication.

### Request deduplication

`StudioRequestCache` (module singleton) prevents duplicate concurrent requests:

1. On descriptor change, `useWidgetRows` checks the cache for a non-expired entry (TTL: 30 s).
2. If no cache hit, it checks `studioRequestCache.getInflight(cacheKey)` — if another widget is already fetching the same query, the same `Promise` is reused.
3. When the source is updated via `controller.upsertDataSource()`, `invalidateSource(sourceId)` clears all cache entries for that source via a secondary `sourceId → cacheKeys` index.

### Adapter implementation contract

```ts
interface StudioDataSourceAdapter {
  getRows(descriptor: StudioQueryDescriptor): Promise<StudioQueryResult>;
}

interface StudioQueryResult {
  rows: Record<string, unknown>[];
  totalCount?: number;
  isTruncated?: boolean;
}
```text

When `descriptor.aggregations` is populated, the adapter is expected to return pre-aggregated rows (one row per group). When it is absent, the adapter should return raw filtered rows for the widget to aggregate client-side.

Two ready-made adapters are provided:

- **`createSimpleAdapter(fetchFn)`** — wraps a plain `async (descriptor) => rows` function.
- **`createBatchingAdapter(fetchFn, options)`** — batches concurrent requests for the same source into a single fetch call using a short debounce window.

---

## 5. Cache Layer

Three module-level WeakMap/Map caches sit between the raw data and the filter resolution step. All three are **transparent** to callers — they are implementation details of the pipeline functions.

### 5.1 `normalizedRowsCache`

```text
WeakMap<rows[], Map<fieldSetKey, { fields, result }>>
```text

- Outer key: `dataSource.rows` (the raw array reference). Entry is GC'd automatically when rows are replaced.
- Inner key: sorted, comma-joined list of the field IDs being normalized (or `'*'` for all fields).
- Invalidated by: passing a new `rows` array (the common case — `upsertDataSource` replaces the reference).

### 5.2 `enrichedRowsCache`

```text
Map<sourceId, Map<fieldSetKey, EnrichCacheEntry>>
```text

- Two-level: source ID → field set key → entry.
- Entry validity checked by reference equality on: `rows`, `fieldRefs[]`, `joinedSourceRows` Map, `relRefs[]`.
- **Widget-scoped:** when `usedFieldIds` is provided, each widget gets its own `fieldSetKey` slot — unrelated widgets cannot evict each other's entries.
- Invalidated by: any of the tracked dependencies changing reference.

### 5.3 `resolvedRowsCache`

```text
WeakMap<rows[], Map<filterFingerprint, ResolvedCacheEntry>>
```text

- Outer key: the normalized `rows` array reference.
- Inner key: a fingerprint derived from `sourceId` + sorted `filterId:value` pairs for all active filters.
- Additional validity check: `crossFilterSourceRows` (rows refs of related sources used in cross-filter evaluation) and `relationships` array reference.
- Changing one widget's filter while another widget's effective filters are unchanged → cache hit for the second widget (previously a global sentinel caused full invalidation).

### 5.4 `StudioRequestCache`

```text
Map<cacheKey, { result, fetchedAt }>
```text

- Module singleton (one instance for the whole app).
- TTL: 30 seconds.
- In-flight deduplication: `Map<cacheKey, Promise<StudioQueryResult>>`.
- Source-level invalidation: `Map<sourceId, Set<cacheKey>>` reverse index for O(M) clearing.

---

## 6. Filter System

### 6.1 Filter scopes

```mermaid
flowchart LR
    subgraph "Filter scopes"
        P["page\nApplied to all widgets\non the active page"]
        W["widget\nApplied only to\nthe owning widget"]
        C["cross-filter\nEmitted by chart click\nApplied to other widgets\non same page"]
        I["interactive\nEmitted by filter widgets\n(date-range, multi-select, toggle, slider)\nApplied to other widgets\non same page"]
    end

    P & W & C & I -->|combined| resolveRowsCached
```text

**Page-scope filters** are stored with `scope: 'page'` and no `widgetId`. They are applied to every widget on the active page.

**Widget-scope filters** are stored with `scope: 'widget'` and a `widgetId`. They are applied only to that widget.

**Cross-filter** and **interactive** filters are stored with `scope: 'cross-filter'` / `'interactive'`, a `sourceWidgetId` (the widget that emitted them), and a `pageId` (the page they were emitted on). They are applied to all other widgets on the same page.

### 6.2 Filter modes

| `filterMode`            | Description                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| `'condition'` (default) | Comparison operator + value. Supports 16 operators including `between`, `contains`, `is_empty`.  |
| `'selection'`           | `value` is a `string[]` of selected values. Equivalent to `operator: 'in'`.                      |
| `'rank'`                | Top/bottom N. Applied **after** aggregation by each widget renderer, not in the shared pipeline. |

### 6.3 Compound filters

A single `StudioFilterState` can encode two conditions joined by `conjunction: 'and' | 'or'`:

```ts
// "date >= 2024-01-01 AND date <= 2024-12-31"
{
  field: 'date',
  operator: 'greater_than_or_equal', value: '2024-01-01',
  conjunction: 'and',
  operator2: 'less_than_or_equal', value2: '2024-12-31',
}
```text

### 6.4 Date-range bar

The `StudioDateRangeBar` above the canvas emits **page-scope** filters for any field marked as `type: 'date'` or `type: 'datetime'`. The bar shows preset buttons (`this_month`, `last_3_months`, `last_12_months`, `ytd`) and a custom date picker. It stores as a `StudioFilterState` with `scope: 'page'`.

### 6.5 Metric refs

A filter's `value` can be replaced with a dynamic reference to a business metric:

```ts
// Filter where field > BM-012.value (live metric lookup)
{
  field: 'revenue',
  operator: 'greater_than',
  valueRef: { sourceId: 'benchmarks', rowId: 'BM-012', field: 'value' }
}
```text

`resolveMetricRefs()` runs before filter evaluation and replaces `valueRef` with the live value from `dataSources['benchmarks'].rows`. This avoids hardcoding filter thresholds.

### 6.6 Filter operators

Supported operators: `equals`, `not_equals`, `in`, `not_in`, `contains`, `does_not_contain`, `starts_with`, `not_starts_with`, `ends_with`, `not_ends_with`, `is_empty`, `is_not_empty`, `greater_than`, `less_than`, `greater_than_or_equal`, `less_than_or_equal`, `between`.

Operator availability is type-aware: string operators are hidden for numeric fields, and numeric operators are hidden for string fields.

### 6.7 Filter presets (Saved Views)

`StudioFilterPreset` is a named snapshot of the current page-scope filters:

```ts
interface StudioFilterPreset {
  id: string;
  name: string;
  filters: StudioFilterState[]; // snapshot of page-scope filters
}
```text

Users can save the current filter state as a named view and restore it later. Presets are persisted as part of `SerializedStudioState`.

---

## 7. Cross-Filter & Cross-Highlight

Widgets on the same page can interact via cross-filtering. When a user clicks a data point on a chart (or selects a row in a grid), a cross-filter is emitted and propagates to all other widgets on the same page.

### 7.1 Interaction flow

```mermaid
sequenceDiagram
    participant User
    participant ChartA as Chart Widget A
    participant Store
    participant ChartB as Chart Widget B
    participant GridC as Grid Widget C

    User->>ChartA: click bar "Europe"
    ChartA->>Store: controller.setCrossFilter({field:'region', value:'Europe', ...})
    Store-->>ChartB: re-render (cross-filter applied)
    Store-->>GridC: re-render (cross-filter applied)
    Note over ChartB: crossFilterMode='cross-highlight'<br/>Shows ghost overlay of full data<br/>highlights filtered subset
    Note over GridC: crossFilterMode='cross-filter'<br/>Hard-filtered to Europe rows only
```text

### 7.2 Cross-filter modes

Each widget has a `config.crossFilterMode` setting:

| Mode                          | Behaviour                                                                                                                                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'cross-highlight'` (default) | Widget renders its **full dataset** as a faded "ghost" behind the filtered subset. Communicates proportion ("what share is Europe?"). The `CrossFilterGhostBar` component handles this for charts. |
| `'cross-filter'`              | Widget hard-filters to show only the matching rows. Axes rescale.                                                                                                                                  |
| `'none'`                      | Widget ignores all incoming cross-filters. Always shows the full unfiltered dataset.                                                                                                               |

### 7.3 Interactive vs chart cross-filters

Two distinct sub-types of cross-filters are tracked:

- **`scope: 'cross-filter'`** — emitted by chart clicks. Triggers ghost overlay rendering when target is in `cross-highlight` mode.
- **`scope: 'interactive'`** — emitted by filter widgets (date-range, multi-select, toggle, slider). Always acts as a hard filter regardless of the target widget's `crossFilterMode`. Never triggers ghost overlay.

`useWidgetRows` returns separate row variants for each combination, allowing chart and grid widgets to correctly compute both the ghost baseline and the highlighted subset in a single pass.

### 7.4 Drilldown

Clicking a row (grid) or chart item can open a drilldown panel when `config.drilldownWidgetId` is set. The drilldown panel renders the target widget filtered to the clicked context via `activeDrilldown` in `StudioShellState`.

---

## 8. Expression Fields

Expression fields extend a data source with user-authored computed columns. They are stored in `StudioState.expressionFields` and evaluated at query time.

### 8.1 Calculated columns vs measures

| Type              | `isMeasure` | When evaluated                                                                                                            |
| ----------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| Calculated column | `false`     | Per-row during L2 enrichment. Produces a new column on every row.                                                         |
| Measure           | `true`      | On-demand by the widget (KPI, chart aggregation). Returns a single scalar over the filtered dataset. Never added to rows. |

### 8.2 Expression tree

Expressions are a recursive discriminated union:

```ts
type StudioExpression =
| StudioFieldExpression       // { id: 'fieldId' }                                 |
| StudioValueExpression       // { type: 'number', value: 42 }                     |
| StudioFunctionExpression    // { operator: 'multiply', inputs: [A, B] }          |
| StudioJoinFieldExpression   // { joinSourceId: 'customers', fieldId: 'country' } |
```text

**Supported operators:** arithmetic (`add`, `subtract`, `multiply`, `divide`, `modulo`), comparison (`equals`, `notEqual`, `lessThan`, etc.), logical (`and`, `or`, `not`), unary (`negate`, `isTrue`, `isFalse`, `isNull`, `isNotNull`), conditional (`if`), date arithmetic (`datediff`), membership (`in`).

### 8.3 Transitive dependency expansion

`getCachedEnrichedRows` automatically resolves transitive dependencies. If expression `margin_pct` references expression `gross_profit`, and a widget uses `margin_pct`, both expressions are included in the enrichment pass — even if the widget config only lists `margin_pct`.

### 8.4 Join-field expressions

A `StudioJoinFieldExpression` reads a field from a **related source** at row evaluation time:

```ts
// Calculated column on orders: pull customer.country for each order row
{ joinSourceId: 'customers', fieldId: 'country' }
```text

This is distinct from a `StudioRelationship` — it is an expression-level join, evaluated per-row during enrichment using FK lookup from the relationship graph.

---

## 9. Relationships

Relationships allow widgets to span multiple data sources. They are declared in `StudioState.relationships` and are resolved at pipeline time, not at data-ingestion time.

### 9.1 Relationship types

```ts
type RelationshipType = 'many-to-one' | 'one-to-one' | 'many-to-many';
```text

**many-to-one** (most common): the widget's primary source is the "many" side (e.g. `orders`), and the related source is the "one" side (e.g. `customers`). FK field on orders → PK field on customers.

**one-to-one**: identical resolution to `many-to-one`.

**many-to-many**: requires a junction (bridge) source (e.g. `order_items` bridging `products` ↔ `orders`). Three additional fields are required: `junctionSourceId`, `junctionSourceField` (FK → sourceId), `junctionTargetField` (FK → targetId).

### 9.2 Cross-source grid columns

Grid widgets can display columns from a related source via `StudioGridColumn.sourceId`. At render time, `enrichWithCrossSourceColumns` performs an FK lookup to join the related field values onto the primary rows:

1. For each column with `sourceId !== widget.sourceId`, find the `many-to-one` relationship.
2. Build a `Map<PK, relatedRow>` from the related source.
3. For each primary row, look up its FK value in the map and copy the requested field.

Columns whose related source has no in-memory rows (async-only sources) are silently skipped.

### 9.3 Chart re-anchoring (L4)

When a chart widget's `xField` or `yField` belongs to a related source, the filtered rows (at the primary source's grain) may be at the wrong aggregation level. `resolveChartRowsForAggregation` (L4) re-joins and re-aggregates rows at the correct grain for the chart's x-axis grouping.

---

## 10. Widget Types

### 10.1 Summary

| Kind     | Component            | Primary hook                           | Key config fields                                                                                      |
| -------- | -------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `grid`   | `StudioGridWidget`   | `useWidgetRows`                        | `columns`, `gridGroupByField`, `gridSummaryFields`, `gridConditionalFormats`, `drilldownWidgetId`      |
| `chart`  | `StudioChartWidget`  | `useWidgetRows` + `useChartWidgetData` | `chartType`, `xField`, `yField`/`ySeries`, `seriesField`, `xGroupBy`, `crossFilterMode`, `annotations` |
| `kpi`    | `StudioKpiWidget`    | `useWidgetRows`                        | `kpiValueField`, `kpiAggregation`, `kpiSparkline`, `kpiTrend`, `kpiTarget`, `kpiTargetRef`             |
| `text`   | `StudioTextWidget`   | —                                      | `textBody`, `textSubtitle`, font/colour/alignment fields                                               |
| `filter` | `StudioFilterWidget` | `useWidgetRows` (for value list)       | `filterWidgetType`, `filterWidgetField`, `filterWidgetSourceId`                                        |
| `pivot`  | `StudioPivotWidget`  | `useWidgetRows`                        | `pivotRowField`, `pivotColField`, `pivotValueField`, `pivotAggregation`, `pivotShowTotals`             |
| `map`    | `StudioMapWidget`    | `useWidgetRows`                        | `mapCountryField`, `mapValueField`, `mapAggregation`, `mapColorScheme`                                 |

### 10.2 Grid

Renders a `DataGrid` (MUI X) with:

- Optional `gridGroupByField` for server-side-style groupBy aggregation (client-side, applied after filtering).
- Pinned summary footer row driven by `gridSummaryFields` — per-column aggregations (sum/avg/count/min/max/count_distinct).
- `gridConditionalFormats` — cell-level style rules evaluated per row at render time.
- Cross-source columns (join via FK lookup, see §9.2).
- Cross-filter emission: clicking a row emits a `cross-filter` scoped to `pageId`.

### 10.3 Chart

Supports 15 chart types: `bar`, `bar-stacked`, `bar-100`, `line`, `area`, `area-stacked`, `area-100`, `mixed`, `heatmap`, `funnel`, `gantt`, `pie`, `donut`, `scatter`, `gauge`.

`useChartWidgetData` wraps `useWidgetRows` and adds:

- Aggregation (groupBy + sum/count/avg) using `resolveChartRowsForAggregation` for cross-source fields.
- Sparkline-style sub-series for KPI widgets.
- Ghost dataset (`filteredRowsNoChartCross`) for cross-highlight overlay.

Chart annotations (`config.annotations`) render horizontal or vertical reference lines on the chart (not supported for pie/donut/gauge).

Cross-filter emission: clicking a data point emits a `cross-filter` for `xField` value.

### 10.4 KPI

Shows a headline aggregate value (sum/avg/count/min/max of `kpiValueField`) plus optional:

- **Sparkline** — a small line/bar chart showing the metric over time (`kpiSparklineField`).
- **Trend badge** — percentage change vs previous period, previous calendar period, or year-over-year.
- **Target line** — a reference line on the sparkline from a `StudioMetricRef`.

### 10.5 Filter Widget

Interactive filter controls that emit `scope: 'interactive'` filter states. Four sub-types:

| `filterWidgetType` | Control                  | Value type                    |
| ------------------ | ------------------------ | ----------------------------- |
| `date-range`       | Date range picker        | `[start, end]` ISO strings    |
| `multi-select`     | Searchable checkbox list | `string[]` of selected values |
| `toggle`           | Toggle button group      | single value                  |
| `slider`           | Range slider             | `[min, max]` numbers          |

### 10.6 Pivot Table

Client-side pivot: groups `effectiveRows` by `pivotRowField` (vertical) × `pivotColField` (horizontal), aggregating `pivotValueField` into each cell. Optional totals row/column (`pivotShowTotals`).

### 10.7 Map (Choropleth)

SVG choropleth of 174 countries (Natural Earth 110m, public domain). Country identifier normalisation accepts ISO alpha-2, alpha-3, or full English names. A sequential colour ramp (blues/reds/greens/oranges/purples) encodes the aggregate value. Country SVG paths are **lazy-loaded** (dynamic `import('./countryPaths')`) to avoid bundling ~120 KB eagerly.

---

## 11. State Persistence & Migration

### 11.1 Serialisation

`controller.serializeState()` returns a `SerializedStudioState`:

```ts
interface SerializedStudioState {
  schemaVersion: number;
  dashboard: StudioDashboardState;
  pages: Record<string, StudioPage>;
  widgets: Record<string, StudioWidget>;
  filters: StudioFilterState[];        // page-scope filters only
  relationships?: StudioRelationship[];
  expressionFields?: StudioExpressionField[];
}
```text

**Excluded from serialisation:** `dataSources` (runtime, host-provided), `shell` (UI state).

### 11.2 Loading state

`controller.loadSerializedState(data: unknown)` runs the migration chain and returns a `MigrationResult`:

```ts
interface MigrationResult {
  success: boolean;
  state: SerializedStudioState | null;
  fromVersion: number;
  toVersion: number;
  errors: string[];
}
```text

Migration is applied incrementally: version N state is passed to the `N → N+1` migration function, then to `N+1 → N+2`, and so on, until the current schema version is reached.

### 11.3 Adding a migration

1. Increment `CURRENT_SCHEMA_VERSION` in `src/store/statePersistence.ts`.
2. Add an entry to the `migrations` registry keyed by the **old** version number.
3. The migration function receives a `Record<string, unknown>` (spread copy of the persisted state) and must return a new object with `schemaVersion` incremented.
4. Write a test in `statePersistence.test.ts` with a v(N) fixture, asserting the v(N+1) shape.

---

## 12. UI Layout & Component Tree

### 12.1 Shell structure

```mermaid
graph TD
    Studio["&lt;Studio&gt;"]
    Provider["&lt;StudioProvider&gt;\n(StudioContext + StudioUIConfigContext)"]
    Shell["Dashboard shell\n(two-panel layout)"]

    Sidebar["&lt;TabbedSidebar&gt;\n(Data / Compose / Filters / AI tabs)"]
    DrawerPanel["&lt;DrawerPanel&gt;\n(animated slide-in)"]
    CanvasArea["Canvas area\n(flex-grow)"]

    DataDrawer["&lt;StudioDataDrawer&gt;"]
    ComposeDrawer["&lt;StudioComposeDrawer&gt;"]
    FiltersDrawer["&lt;StudioFiltersDrawer&gt;"]
    ChatPanel["&lt;StudioChatPanel&gt;\n(lazy-loaded)"]

    Canvas["&lt;StudioCanvas&gt;"]
    DateBar["&lt;StudioDateRangeBar&gt;"]
    QuickFilterBar["&lt;StudioQuickFilterBar&gt;"]
    PageRows["Widget rows\n(StudioWidgetCard ×N)"]
    DrilldownPanel["&lt;StudioDrilldownDrawer&gt;\n(right-side overlay)"]

    Studio --> Provider
    Provider --> Shell
    Shell --> Sidebar
    Shell --> DrawerPanel
    Shell --> CanvasArea

    Sidebar -->|"Data tab"| DataDrawer
    Sidebar -->|"Compose tab"| ComposeDrawer
    Sidebar -->|"Filters tab"| FiltersDrawer
    Sidebar -->|"AI tab"| ChatPanel

    DrawerPanel --> DataDrawer & ComposeDrawer & FiltersDrawer & ChatPanel
    CanvasArea --> Canvas
    Canvas --> DateBar
    Canvas --> QuickFilterBar
    Canvas --> PageRows
    Canvas --> DrilldownPanel
```text

### 12.2 Sidebar tabs

| Tab icon                 | Drawer                | Feature flag                                    |
| ------------------------ | --------------------- | ----------------------------------------------- |
| StorageIcon (Data)       | `StudioDataDrawer`    | `featureFlags.dataManagement`                   |
| TuneIcon (Compose)       | `StudioComposeDrawer` | `featureFlags.compose`                          |
| FilterListIcon (Filters) | `StudioFiltersDrawer` | `featureFlags.filters`                          |
| AutoAwesomeIcon (AI)     | `StudioChatPanel`     | `featureFlags.aiChat` + `aiConfig.endpoint` set |

### 12.3 Drawers

**StudioDataDrawer** — manages data sources, fields, expression fields, and relationships. Shows field types, cardinality, and a lineage graph.

**StudioComposeDrawer** — the widget authoring panel. Contains:

- `AddWidgetView` — widget type picker + optional "Describe a widget" NL creation field.
- Setup panels (`ChartSetupPanel`, `GridSetupPanel`, `KpiSetupPanel`, `MapSetupPanel`, `PivotSetupPanel`, `FilterSetupPanel`, `TextSetupPanel`) — shown when a widget is selected.
- `PageConfigPanel` — page-level theme settings.

**StudioFiltersDrawer** — filter management. Grouped into page-scope and per-widget sections. Supports filter presets (Saved Views), filter search, and filter cards with inline editing.

**StudioChatPanel** — AI chat assistant. Lazy-loaded on first open. Uses `@mui/x-chat` for the message thread. The `studioAdapter.ts` translates AI tool calls (`add_widget`, `update_widget`, `delete_widget`, `get_dashboard_state`) into `StudioController` mutations.

### 12.4 StudioWidgetCard

Each widget in the canvas is wrapped in `StudioWidgetCard`, which provides:

- Title / subtitle bar with edit (pencil) button.
- Loading / error overlays driven by `isLoading` and `isError` from `useWidgetRows`.
- Skeleton placeholder while `showContent === false` (prevents CLS).
- Click-to-select for edit mode.
- `StudioWidgetEditDialog` (full config dialog on double-click).

### 12.5 Keyboard shortcuts

`useStudioKeyboardShortcuts` binds:

- `Ctrl/Cmd + Z` → `controller.undo()`
- `Ctrl/Cmd + Shift + Z` / `Ctrl/Cmd + Y` → `controller.redo()`
- `Escape` → deselect / close drilldown

### 12.6 Responsive stacking

Below `stackBreakpoint` (default `768 px`, configurable per page), all widget rows collapse to single-column full-width stacks. This applies in view mode only — edit mode always shows the grid layout.

---

## 13. Public API Surface

### 13.1 `<Studio>` component

```ts
interface StudioProps {
  // Required
  dataSources: StudioDataSource[];

  // Persistence
  initialState?: SerializedStudioState;
  onStateChange?: (state: SerializedStudioState) => void;

  // Behaviour
  defaultMode?: 'edit' | 'view';
  featureFlags?: StudioFeatureFlags;
  localeText?: Partial<StudioLocaleText>;
  aiConfig?: StudioAIConfig | null;
  stackBreakpoint?: number;

  // Imperative ref
  ref?: React.Ref<StudioHandle>;
}
```text

### 13.2 `StudioHandle` (imperative ref)

```ts
interface StudioHandle {
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  setMode(mode: 'edit' | 'view'): void;
  setActivePage(pageId: string): void;
  getState(): StudioState;
  serializeState(): SerializedStudioState;
  loadSerializedState(data: unknown): MigrationResult;
  setDataSourceAdapter(sourceId: string, adapter?: StudioDataSourceAdapter): void;
}
```text

### 13.3 `StudioController`

The lower-level class used when embedding Studio without the `<Studio>` wrapper (e.g. custom layouts using `<StudioProvider>`).

Key mutation methods: `upsertDataSource`, `setDataSourceAdapter`, `updateDataSourceField`, `addWidget`, `updateWidget`, `removeWidget`, `addPage`, `removePage`, `setActivePage`, `addFilter`, `updateFilter`, `removeFilter`, `applyFilterPreset`, `setMode`, `undo`, `redo`.

### 13.4 `createStudioPipeline`

A pure-TypeScript factory for running the pipeline outside of React:

```ts
const pipeline = createStudioPipeline(controller.getState());

// Run full pipeline for a widget
const rows = pipeline.resolveWidgetRows(
  widget.id,
  widget.sourceId,
  dataSources[widget.sourceId].rows,
  activePageId,
);

// Optional: re-anchor for cross-source chart fields
const chartRows = pipeline.resolveChartRows(
  rows,
  widget.sourceId,
  widget.config.xField,
  [widget.config.yField],
  widget.config.seriesField,
);

// Optional: enrichment only (no filters)
const enriched = pipeline.getEnrichedRows(rows, widget.sourceId, usedFieldIds);
```text

Use cases: CSV export handlers, benchmarks, unit tests, server-side pre-rendering.

### 13.5 `StudioDataSourceAdapter`

```ts
interface StudioDataSourceAdapter {
  getRows(descriptor: StudioQueryDescriptor): Promise<StudioQueryResult>;
}
```text

Implement this interface to delegate data fetching to a backend. The adapter receives a fully-resolved `StudioQueryDescriptor` (with filter tree, field selection, groupBy, and aggregations) and is expected to return either raw rows or pre-aggregated rows depending on whether `descriptor.aggregations` is set.

Two helpers: `createSimpleAdapter(fn)` and `createBatchingAdapter(fn, options)`.

### 13.6 Feature flags

```ts
interface StudioFeatureFlags {
  compose?: boolean;       // Edit mode and compose drawer (default: true)
  filters?: boolean;       // Filter drawer and quick filter bar (default: true)
  savedFilterViews?: boolean; // Filter presets (default: true)
  dataManagement?: boolean;   // Data drawer (default: true)
  aiChat?: boolean;        // AI chat panel (default: true; requires aiConfig)
}
```text

All flags default to `true` (opt-out model). Setting any flag to `false` hides the corresponding UI entirely.

### 13.7 Locale / i18n

All user-visible strings are defined in `StudioLocaleText` and passed via `localeText` prop on `<Studio>`. A complete `ptBRLocaleText` translation is provided. Partial override objects are merged over the English defaults.
