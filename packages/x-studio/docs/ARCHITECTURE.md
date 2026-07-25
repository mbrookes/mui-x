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
14. [AI Features](#14-ai-features)

---

## 1. System Overview

`@mui/x-studio` is a self-contained, embeddable analytics dashboard builder.
A host application mounts the `<Studio>` component, provides data sources at runtime, and can read/write state via the imperative `StudioHandle` or the `StudioController` class.

````mermaid
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

All mutable state lives in a single `StudioState` object managed by `StudioController`. The state is partitioned into three top-level fields by **lifetime**, not grouped flatly — this is what lets the undo/redo stack snapshot only the user-authored document while leaving UI state and host-injected data alone.

### 2.1 Top-level shape

```ts
interface StudioState {
  doc: StudioDoc;         // the ONLY partition that is persisted / undoable / reducer-mutated
  session: StudioSession; // ephemeral UI state — never persisted, never undoable
  runtime: StudioRuntime; // host-injected state — never persisted, never undoable
}

interface StudioDoc {
  schemaVersion: 1; // CURRENT_SCHEMA_VERSION, defined in @mui/x-studio-schema
  dashboard: StudioDashboardState;   // id, title, activePageId
  pages: Record<string, StudioPage>; // keyed by page id
  widgets: Record<string, StudioWidget>; // keyed by widget id
  relationships: StudioRelationship[];
  filters: StudioFilterState[];      // page + widget + cross + interactive filters
  expressionFields: StudioExpressionField[]; // user-authored calculated columns/measures
  filterPresets?: StudioFilterPreset[];
  ai?: StudioAIState;                // AI chat thread state
}

interface StudioSession {
  mode: 'edit' | 'view'; // deliberately NOT in `doc` — switching modes isn't a dashboard edit
  shell: StudioShellState; // UI-only: open drawers, selection
}

interface StudioRuntime {
  dataSources: Record<string, StudioDataSource>; // keyed by source id; row data never persisted/undone
}
```text

`StudioState` is defined in the shared, zero-dependency `@mui/x-studio-schema` package (`packages/x-studio-schema/src/stateTypes.ts`); `x-studio/src/models/stateTypes.ts` is a thin re-export shim for existing deep imports.

That package also exports the id-generation factories used to mint every entity id in `doc` — dedicated ones (`createPageId`, `createWidgetId`, `createFilterId`, `createPresetId`, …) plus a generic `createIdFactory(prefix)` escape hatch for ad-hoc entities that don't warrant their own dedicated factory (e.g. chart annotations, manually-created relationships). All are thin wrappers over an internal `makeIdFactory`, so every id is collision-resistant (timestamp + monotonic counter + random suffix) rather than a bare `Math.random()` or `Date.now() + Math.random()` string.

**Record lookups keyed by a doc-authored id are prototype-chain-safe.** `doc.pages`, `doc.widgets`, and `runtime.dataSources` are plain records built by object-spread, so a doc/host/AI-authored id equal to an `Object.prototype` member name (`"toString"`, `"constructor"`, `"valueOf"`, …) makes a bare bracket lookup resolve an **inherited function** instead of `undefined` — a truthy non-source value that slips past the `?.fields`/optional-chaining guards downstream and throws `TypeError` on the next `.find`/`.map` call. Every such lookup keyed by an untrusted id is therefore guarded with `Object.hasOwn(record, key) ? record[key] : undefined`: the `selectActivePage` / `makeSelectWidgetSource` selectors (`context/selectors.ts`), `StudioContent`, `StudioCanvas`, `StudioFiltersDrawer` / `useFieldValues`, and the compose-drawer setup panels (`ChartSetupPanel`, `GridSetupPanel`, `KpiSetupPanel`, `PivotSetupPanel`, `GridConditionalFormatSection`). This matches the convention `StudioMapWidget` established for its `allGeographies` geography lookup (§10.7) and that `StudioChartWidget` now applies to its chart-type registry (§10.3); the widget card's cross-filter chip and slider pill inherit the guard transitively through the now-guarded `makeSelectWidgetSource`.

**Coverage extends to four sibling selectors and six further component-level sites.** `context/selectors.ts`'s `makeSelectWidget`, `makeSelectWidgetRankFilter`, `makeSelectWidgetSliderFilter`, and `makeSelectWidgetActiveCrossFilter` now carry the same `Object.hasOwn` guard as their sibling `makeSelectWidgetSource`/`selectActivePage` — `makeSelectWidget` is the most exploitable of the four, since it's used unguarded in `StudioWidgetCard.tsx`, whose own `if (!widget) return null` check would not catch a truthy inherited-function result. The same guard closed two **Tier1** crash sites reachable **outside any error boundary** — `CrossFilterSection.tsx`'s `dataSources[filterSourceId]` lookup and `KpiSparklineOptions.tsx`'s `dataSources[relatedId]` lookup (a `StudioRelationship`-traced id) — each of which could previously crash the *entire* `<Studio>` tree rather than one widget, because neither `StudioComposeDrawer` nor `StudioFiltersDrawer` had an error boundary of their own until `StudioDrawerErrorBoundary` was added to wrap both (§12.3). It also closed four **Tier2** sites already contained by the per-widget `StudioWidgetErrorBoundary` (§12.4): `StudioGridWidget.tsx`'s `resolveCrossSourceFieldDefs` (cross-source column defs), `StudioMapWidget.tsx`'s cross-source value-field lookup, `StudioKpiWidget.tsx`'s `resolveKpiValueFieldDef` (now exported so the guard can be unit-tested directly), and `StudioMixedChart.tsx` via a shared `getBlendedDataSource` helper used at both its `resolveFieldDef` call sites. `useBlendedSeriesRows.ts`'s four `dataSources[sid]` lookups (feeding blended/foreign chart series) picked up the same guard as part of wiring up request-cache adapter namespacing (§4).

**Coverage further extends to the Data Drawer's relationship renderer and six `labelMap[key]` display lookups.** `EdgeLabel.tsx`'s `sources[rel.sourceId]` / `sources[rel.targetId]` / `sources[rel.junctionSourceId]` and `RelationshipPanel.tsx`'s `dataSources[rel.sourceId]` / `dataSources[rel.targetId]` / `dataSources[rel.junctionSourceId]` lookups, plus both components' `TYPE_LABELS[rel.type]` / `relationshipTypeLabels[rel.type]` lookups, now carry the same `Object.hasOwn` guard — a persisted `StudioRelationship` with one of these fields equal to an `Object.prototype` member name previously resolved the inherited function instead of `undefined`, which either crashed `EdgeLabel`'s `.find(...)` call (the preceding `srcSource?.fields.find(...)` optional chain didn't actually guard the `.find()` call itself; it's now `srcSource?.fields?.find(...)`) or reached an SVG `<text>` node / `<Chip label>` as a function, throwing "Functions are not valid as a React child". Since `statePersistence.ts`'s relationship load-screening only checks that each `doc.relationships` entry is a record — not the values of `type`/`sourceId`/`targetId`/`junctionSourceId` — a hostile payload can carry such values straight in via the public `loadSerializedState` API.

Six further recurring `labelMap[doc-authored-key] ?? key` sites picked up the same guard: `StudioWidgetCard.tsx`'s `widgetKindLabels[widget.kind]` (the widget title header — notably rendered **outside** the per-widget `StudioWidgetErrorBoundary`, §12.4, which wraps only `def.component`, so an unguarded hit here previously crashed the whole dashboard rather than one card), `WidgetInstanceList.tsx`'s same `widgetKindLabels[widget.kind]` lookup in the Compose drawer's widget list (contained by that drawer's boundary, fixed for consistency), `FieldTypeIcon.tsx`'s data-type-label and icon-map lookups (the icon lookup was a real crash, not just a cosmetic one: `type: 'constructor'` resolves `iconMap.constructor` to the `Object` function, and rendering it as `<Icon size={size} />` throws "Objects are not valid as a React child" because calling `Object({ size })` returns the props object itself as the "rendered" output), `FieldDetailView.tsx`'s two `dataTypeLabels[field.type]` lookups (the "Data type" and "Format" detail rows), and `GridSetupPanel.tsx`'s `aggLabels[currentAgg]` lookup (doc-authored via `gridSummaryFields`/`gridAggregations`) plus the sibling `aggLabels[agg]` lookup in the aggregation menu (guarded for consistency even though `agg` there is always a trusted value from the fixed `NUMERIC_AGGREGATIONS`/`STRING_AGGREGATIONS` arrays).

### 2.2 Persisted vs runtime slices

| Slice (partition.field)  | Persisted? | Notes                                                                   |
| ------------------------- | ---------- | ----------------------------------------------------------------------- |
| `doc.dashboard`           | Yes        | title, activePageId                                                     |
| `doc.pages`               | Yes        | layout, themes                                                          |
| `doc.widgets`             | Yes        | config, title                                                           |
| `doc.filters`             | Yes        | page/widget-scope filters; cross-filter/interactive entries are stripped at the persistence boundary only (they're deliberately undoable in-memory) |
| `doc.relationships`       | Yes        |                                                                         |
| `doc.expressionFields`    | Yes        |                                                                         |
| `doc.filterPresets`       | Yes        | omitted from the serialized shape when empty                            |
| `doc.ai`                  | Yes        | AI chat thread state; omitted from the serialized shape when there are no threads |
| `runtime.dataSources`     | No         | provided by host at runtime; schemas/rows are never persisted           |
| `session.mode`            | No         | view/edit; not persisted, not undoable                                  |
| `session.shell`           | No         | UI state (open drawers, selection); not persisted, not undoable         |

`runtime.dataSources` is intentionally excluded from serialization — data comes from the host and is injected via `controller.upsertDataSource()` or `<Studio dataSources={...}>`. This keeps the serialized state small and schema-agnostic.

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

Widgets are arranged in a grid of rows. Each row is an array of widget IDs. Column widths are either equal-share (`flex: 1`) or an explicit 3–12 column span. `StudioCanvas` builds the CSS `flex` shorthand from the doc-authored span (`` `${span ?? defaultFlexGrow} 0 0` ``); the schema package's load boundary already clamps `widgetColSpans` values (§11), but `StudioCanvas` now also falls back to `defaultFlexGrow` locally when `span` isn't `Number.isFinite`, validating at the point of consumption rather than relying solely on that distant boundary — consistent with how every other doc-authored value reaching `sx` in this package is guarded (§10.1).

### 2.4 StudioController & Store

`StudioController` wraps a `Store<StudioState>` (MUI internal pub-sub store) and exposes a typed mutation API. All mutations go through `commitState()` which:

1. Pushes the current `doc` (not the whole `StudioState`) onto the undo stack (up to `MAX_UNDO_HISTORY = 100`) — only when `nextState.doc` actually differs by reference from the current `doc`.
2. Clears the redo stack on any new undoable action.
3. Calls `store.setState(nextState)` to notify all subscribers.

A commit that only touches `session`/`runtime` (drawer open/close, selection changes, data refresh) never pushes an undo entry, regardless of the `undoable` option — there is no authored-document change to revert. Session mutations (e.g. `setMode`) additionally pass `{ undoable: false }` as belt-and-braces on top of that structural guarantee.

Three sibling commit paths share a **key-wise reference no-op guard** so a write that changes nothing never rebuilds state or notifies subscribers: `commitDocPatch`, `updateState`, and now `commitShellPatch`. `commitState` already bails when `nextState === current`, but only *after* the patch method has rebuilt the intermediate `session`/`shell` objects (whose references would then differ). `commitShellPatch` now short-circuits first — when every entry in the shell patch is already reference-equal to the current `session.shell` field it returns without committing — so a redundant shell write (e.g. `clearSelection()` when nothing is selected) never rebuilds `session.shell` and re-notifies every subscriber for no actual change.

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
| `effectiveRows`            | `filteredRowsNoChartCross` when `crossFilterMode='none'`; otherwise `filteredRows` |

`crossFilterMode='none'` only opts a widget out of **chart-click** cross-filters (`scope: 'cross-filter'`) — interactive (filter-widget) hard-filters still apply, which is why `effectiveRows` resolves to `filteredRowsNoChartCross` rather than `filteredRowsNoCross` in that mode. See §7.2 for the full mode semantics.

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

**Per-adapter-instance namespacing (cross-`<Studio>` isolation).** The `cacheKey` is built from `sourceId` + query shape with **no** adapter-identity component, and the cache is a module-level singleton shared by every `<Studio>`/`StudioController` on the page. Two separate instances mounted on the same page that use the *same* `sourceId` string but were handed *different* host adapters (different tenant / auth / backend) would therefore collide — serving each other's cached rows for up to the TTL and joining each other's in-flight request promises. Every access method (`get`, `set`, `isInflight`, `getInflight`, `runInflight`) now takes an optional live `adapter` object and stores/looks up under an `effectiveKey = adapterNamespace(adapter) + cacheKey`. `adapterNamespace` mints a monotonic, per-adapter-unique prefix (`@adapterN `) held in a `WeakMap<object, string>` — GC-friendly (an unmounted adapter takes its token with it) and stable (the same adapter always resolves to the same prefix). Callers that omit `adapter` keep the legacy un-namespaced key, so the change is fully backward compatible. The reverse `sourceId → cacheKeys` index is always resolved from the **original** (un-namespaced) `cacheKey`, so `invalidateSource` stays keyed by the true source regardless of namespacing.

**This method-level support was, for a time, dead code.** The optional `adapter` parameter described above existed on every access method, but no production call site actually passed it — `useAdapterRows.ts`, `useBlendedSeriesRows.ts` (§4, cross-source chart blending), and `widgetExport.ts` (CSV export) all called `get`/`getInflight`/`addInflight`/`set` with no adapter argument, so two `<Studio>` instances sharing a `sourceId` string but backed by different host adapters could still serve or join each other's cache entries — a real cross-tenant data-leak risk, not merely a latent one. All three call sites now thread the live adapter object through (`dataSource.adapter` for the first two, `source?.adapter` for the export path), so the isolation this section describes is now actually enforced everywhere the cache is touched.

`useAdapterRows` (the hook encapsulating this state machine) also resets `isLoading`/`isError`/`errorMessage` whenever its early-return branch fires — i.e. the descriptor or adapter becomes unavailable mid-flight (the adapter was removed via `setDataSourceAdapter(id, undefined)`, the source was removed, or it dropped out of the `dataAdapters` prop). Any in-flight promise from a previous descriptor is neutralized by its own cleanup, so without this reset nothing else would ever clear a stale loading spinner or error overlay after falling back to in-memory rows.

The `dataSource.adapter.getRows(descriptor)` call itself is wrapped in `try`/`catch`: a well-behaved adapter returns a promise (rejecting on failure, handled by the branch above), but a host adapter can also throw synchronously rather than reject — that throw would otherwise escape the effect uncaught and, before the per-widget error boundary existed (§12.4), take down the whole render tree. A caught synchronous throw is now routed into the same `isError`/`errorMessage` state as the promise-rejection path.

When `adapter.getRows()` rejects with a non-`Error` value, `errorMessage` falls back to `localeText.widgetLoadError` (read via `useStudioLocaleText()`) rather than a hardcoded English string — consistent with this package's locale-completeness policy for strings that can reach the rendered UI (see §13.7's `widgetExportNoDataMessage` for the same pattern applied to an exported-file string).

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
- **`createBatchingAdapter(endpoint, options)`** — batches concurrent requests for the same source into a single HTTP POST using a short debounce window (default 50 ms).

### 4.1 `createBatchingAdapter` — field and filter resolution

When `options.dataSources`, `options.relationships`, and `options.expressionFields` are provided, `buildBatchWidgetDescriptor` resolves every field reference (SELECT, filter, ORDER BY, aggregation) from its logical ID to the correct physical SQL column before sending the request to the server. The internal `resolveField` function handles five cases:

| Case | Example | Resolution |
|---|---|---|
| Physical field on primary source | `total` on `order_items` | Passed through unqualified |
| Expression field (join) on primary source | `expr-order-country` when widget is on `orders` | Single LEFT JOIN added; `columnAliases['expr-order-country'] = 'customers.country'` |
| Expression field (join) on a **related** source | `expr-order-country` (defined on `orders`) applied as a cross-filter to an `order_items` widget | Two LEFT JOINs added: `order_items → orders` (hop 1), `orders → customers` (hop 2); physical column `customers.country` used in WHERE |
| Expression field (arithmetic/function) | `expr-margin-pct` | Marked `skip` — server returns raw rows, Studio evaluates client-side |
| Physical field on related source | `orders.status` in an `order_items` widget | Single LEFT JOIN added; column qualified as `orders.status` |

**Filter and ORDER BY physical column resolution.** After `resolve(fieldId)` populates `columnAliases`, filter predicates and ORDER BY clauses look up `columnAliases[logicalId] ?? logicalId` to get the physical column name. SQL `WHERE` and `ORDER BY` clauses must reference the physical column (`customers.country`), not the logical alias which is only valid inside `SELECT … AS`.

**Shared-endpoint config in simple mode.** When `options.dataSources` is omitted ("simple mode"), `createBatchingAdapter` looks up a per-endpoint `LoaderRegistryEntry` in a module-level registry so multiple adapter instances pointing at the same URL share one batch loader. `fetchFn` and `batchDelayMs` on that shared entry are last-write-wins (a later instance's values simply replace the earlier ones — appropriate for a rotated auth token). `expressionFields`, however, is **merged** (unioned by field id, newer entry wins on an id collision) rather than overwritten: distinct `StudioDataSource`s can legitimately share one endpoint, each contributing its own calculated columns, and a later instance registering with none of its own (or a different source's list) must not wipe out an earlier instance's entries.



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
- **Per-adapter-instance namespacing** (§4, "Request deduplication"): although the instance is shared, storage/lookup keys are prefixed with a per-adapter `WeakMap` token (`@adapterN `) so two `<Studio>` instances sharing a `sourceId` but backed by different host adapters can't read each other's entries or join each other's in-flight requests. The `sourceId → cacheKey` reverse index is keyed by the original (un-namespaced) `cacheKey`, keeping `invalidateSource` correct. This isolation is only as good as its call sites actually passing `adapter` through — see §4 for the period where none of them did, and the three (`useAdapterRows.ts`, `useBlendedSeriesRows.ts`, `widgetExport.ts`) that now do.

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

Below it, `StudioQuickFilterBar` renders one chip per active filter (page, widget, and cross/interactive). Each chip has two hover affordances — hovering the chip body shows a toggle (enable/disable) tooltip, hovering the trailing close icon shows a remove tooltip — and both also open on keyboard focus/close on blur, not just mouse hover, so a keyboard user tabbing to a chip sees the same affordance a mouse user gets.

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
| `'none'`                      | Widget ignores incoming **chart-click** cross-filters only (`scope: 'cross-filter'`) — its own page/widget filters and any `interactive` (filter-widget) hard-filters from other widgets on the page still apply. Not "always shows the full unfiltered dataset."                              |

### 7.3 Interactive vs chart cross-filters

Two distinct sub-types of cross-filters are tracked:

- **`scope: 'cross-filter'`** — emitted by chart clicks. Triggers ghost overlay rendering when target is in `cross-highlight` mode.
- **`scope: 'interactive'`** — emitted by filter widgets (date-range, multi-select, toggle, slider). Always acts as a hard filter regardless of the target widget's `crossFilterMode`. Never triggers ghost overlay.

`useWidgetRows` returns separate row variants for each combination, allowing chart and grid widgets to correctly compute both the ghost baseline and the highlighted subset in a single pass.

For pie/donut charts, `PieCrossHighlight`'s `CrossHighlightPieArc` clamps the per-slice cross-highlight ratio to `[0, 1]` before computing the overlay arc's end angle. `min`/`avg` aggregations can legitimately produce a filtered/baseline ratio above 1 (e.g. the highlighted category sits above the overall average); without the clamp, the overlay would be pushed past the slice's own `endAngle` and paint over the start of the next slice's dimmed ghost arc.

For scatter charts, `StudioScatterChart` dims ghost-series points with a CSS selector rather than per-point props: `& g[data-series$="-ghost"] circle` — matching `@mui/x-charts`' actual DOM shape (`<g data-series={series.id} className="MuiScatterChart-series">` per series, one group per series, not per-marker) and this file's own `-ghost` id-suffix convention for ghost series. `StudioScatterChart` also merges (rather than overwrites) any consumer-supplied `slotProps`: it spreads `...slotProps?.slotProps` before applying its own `legend` override, and merges `legend.sx` at the sub-key level, so a consumer-supplied `tooltip` slot prop or other `legend.sx` entries survive alongside the component's own auto-scroll/wrap legend styling.

> **Drilldown is not currently implemented.** There is no `StudioDrilldownDrawer` component, no `activeDrilldown`/drilldown state anywhere in `StudioShellState`, and no `drilldownWidgetId` widget config field in the current codebase — clicking a row or chart item never opens a detail panel. (A drill-down/detail-panel feature was implemented at one point per the project backlog, but no trace of it remains in `src/`; treat any reference to it elsewhere as aspirational/planned, not current behavior.)

---

## 8. Expression Fields

Expression fields extend a data source with user-authored computed columns. They are stored in `StudioState.doc.expressionFields` and evaluated at query time.

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

Logical operators (`and`, `or`, `not`, and the `if` condition) coerce their operands to boolean via a shared `toBoolean` helper that explicitly maps the strings `"true"`/`"false"` to their boolean values before falling back to JS truthiness — matching `filterUtils.ts`'s boolean-as-string handling for the `equals` operator. Without this, a CSV/API-sourced boolean column serialized as the string `"false"` would evaluate truthy (`Boolean("false") === true` in JS), silently taking the wrong branch of `if(on_time, 1, 0)`-style expressions.

### 8.3 Transitive dependency expansion

`getCachedEnrichedRows` automatically resolves transitive dependencies. If expression `margin_pct` references expression `gross_profit`, and a widget uses `margin_pct`, both expressions are included in the enrichment pass — even if the widget config only lists `margin_pct`.

### 8.4 Join-field expressions

A `StudioJoinFieldExpression` reads a field from a **related source** at row evaluation time:

```ts
// Calculated column on orders: pull customer.country for each order row
{ joinSourceId: 'customers', fieldId: 'country' }
```text

This is distinct from a `StudioRelationship` — it is an expression-level join, evaluated per-row during enrichment using FK lookup from the relationship graph.

Join-field reads go through `getCachedNormalizedDataSource` (the L1 normalization cache, §5.1) rather than a related source's raw `.rows`, so a raw `Date`/non-canonical date string on the joined row can't bucket differently downstream than the widget's own L1-normalized dates. `enrichRowsWithExpressions` pre-builds an O(1) lookup index per `joinSourceId` before the row loop; the index is seeded by walking the **full** expression tree (`collectJoinSourceIds`), not just the root node, so a join nested inside a function call (e.g. `if(join(customers.country) == 'US', 1, 0)`) is indexed too instead of silently falling back to an unindexed per-row linear scan.

---

## 9. Relationships

Relationships allow widgets to span multiple data sources. They are declared in `StudioState.doc.relationships` and are resolved at pipeline time, not at data-ingestion time.

### 9.1 Relationship types

```ts
type RelationshipType = 'many-to-one' | 'one-to-one' | 'many-to-many';
```text

**many-to-one** (most common): the widget's primary source is the "many" side (e.g. `orders`), and the related source is the "one" side (e.g. `customers`). FK field on orders → PK field on customers.

**one-to-one**: identical resolution to `many-to-one`.

**many-to-many**: requires a junction (bridge) source (e.g. `order_items` bridging `products` ↔ `orders`). Three additional fields are required: `junctionSourceId`, `junctionSourceField` (FK → sourceId), `junctionTargetField` (FK → targetId).

All three re-anchor branches in `grainResolution.ts` (`resolveRowsAtGrain`) — many-to-one, one-to-one, and many-to-many — merge the widget/remote/junction rows the same way: a foreign column is only allowed to override an already-present value on the merged row when `fieldOwners` (from `analyzeChartSupport`) actually attributes that field id to the foreign source. A same-named column that merely happens to collide (e.g. a junction `amount` allocation weight vs. the widget's own `orders.amount`) never silently wins over the correctly-owned value.

### 9.2 Cross-source grid columns

Grid widgets can display columns from a related source via `StudioGridColumn.sourceId`. At render time, `enrichWithCrossSourceColumns` performs an FK lookup to join the related field values onto the primary rows:

1. For each column with `sourceId !== widget.sourceId`, find the `many-to-one` relationship.
2. Build a `Map<PK, relatedRow>` from the related source.
3. For each primary row, look up its FK value in the map and copy the requested field.

Columns whose related source has no in-memory rows (async-only sources) are silently skipped.

### 9.3 Chart re-anchoring (L4)

When a chart widget's `xField` or `yField` belongs to a related source, the filtered rows (at the primary source's grain) may be at the wrong aggregation level. `resolveChartRowsForAggregation` (L4) re-joins and re-aggregates rows at the correct grain for the chart's x-axis grouping. See §9.1's closing note for the ownership-guarded merge policy this re-anchoring uses when combining widget/related/junction rows.

---

## 10. Widget Types

### 10.1 Summary

| Kind     | Component            | Primary hook                           | Key config fields                                                                                      |
| -------- | -------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `grid`   | `StudioGridWidget`   | `useWidgetRows`                        | `columns`, `gridGroupByField`, `gridSummaryFields`, `gridConditionalFormats`      |
| `chart`  | `StudioChartWidget`  | `useWidgetRows` + `useChartWidgetData` | `chartType`, `xField`, `yField`/`ySeries`, `seriesField`, `xGroupBy`, `crossFilterMode`, `annotations` |
| `kpi`    | `StudioKpiWidget`    | `useWidgetRows`                        | `kpiValueField`, `kpiAggregation`, `kpiSparkline`, `kpiSparklinePlotType`, `kpiSparklineGaugeMax`, `kpiTrend` |
| `text`   | `StudioTextWidget`   | —                                      | `textBody`, `textSubtitle`, font/colour/alignment fields                                               |
| `filter` | `StudioFilterWidget` | `getCachedNormalizedDataSource` + `getCachedEnrichedRows` — **not** `useWidgetRows` (see §10.5) | `filterWidgetType`, `filterWidgetField`, `filterWidgetSourceId`                                        |
| `pivot`  | `StudioPivotWidget`  | `useWidgetRows`                        | `pivotRowField`, `pivotColField`, `pivotValueField`, `pivotAggregation`, `pivotShowTotals`             |
| `map`    | `StudioMapWidget`    | `useWidgetRows`                        | `mapCountryField`, `mapValueField`, `mapAggregation`, `mapColorScheme`                                 |

> **Doc-authored style values are sanitized before reaching `sx`.** The `text` widget's font/colour/alignment fields (`textBodyColor`, `textSubtitleColor`, `text*FontFamily`, `text*FontSize`, `text*Align`), the analogous title-text color/font-size/font-weight/alignment fields on `StudioWidgetCard`, and `StudioPageTheme`'s full field set (`pageBackground`, plus card border color, background, radius, padding, border width) are all reachable from an untrusted `loadSerializedState(data: unknown)` payload or an AI `update_widget`/`apply_bulk_update` tool call. Because Emotion's `sx` prop does not escape interpolated property values, these fields are validated at the render-time call site — via the shared `internals/cssValueValidation.ts` helpers (`sanitizeCssColor`/`isSafeCssColor`, `isSafeFontFamily`, `sanitizeFiniteNumber`/`sanitizeFontSize`, `sanitizeFontWeight`, `isSafeTextAlign`, `isSafeFontWeightKeyword`) and the `resolveTextFontFamily` helper in `textFontFamily.ts` that wraps `isSafeFontFamily` — before being interpolated. An invalid value (e.g. one crafted to break out of the CSS declaration and inject new rules) falls back to the default/unset style instead of propagating into rendered CSS. `pageBackground` was, for a time, the one `StudioPageTheme` field missed by this pass — `StudioCanvas` now runs it through `sanitizeCssColor` before setting the canvas root's `sx.backgroundColor`, matching every sibling theme field. `StudioGridWidget`'s `gridHeight` (a numeric field, same untrusted-input surface) was a further sibling gap: it reached the grid's `sx.height` directly, so it's now routed through `sanitizeFiniteNumber` first; `builtinWidgetDefs.ts`'s `skeletonHeight` gets the same treatment for defense-in-depth, even though it currently reaches a `Skeleton` via inline `style` rather than `sx`. See §10.2 for the equivalent guard on grid conditional-format cell colors, font weight, and the format rule's CSS selector key (a distinct injection vector from the value-sanitization described here).

**Markdown text-widget images do not leak to remote hosts.** `StudioTextWidget`'s markdown renderer (`renderMarkdown.tsx`) already blocked `javascript:`/protocol-relative link URLs and disabled raw HTML, but markdown image syntax (`![alt](url)`) still rendered an `<img>` that would load ANY `http`/`https` URL with zero user interaction — a tracking-pixel/viewer-IP exfiltration channel from a shared or AI-authored `textBody`. The `sanitizeUrl` callback now receives `(value, tag, attribute)` and specifically blocks `http`/`https` URLs when `tag === 'img' && attribute === 'src'`, while still allowing them for `<a href>` links.

### 10.2 Grid

Renders a `DataGrid` (MUI X) with:

- Optional `gridGroupByField` for server-side-style groupBy aggregation (client-side, applied after filtering).
- Pinned summary footer row driven by `gridSummaryFields` — per-column aggregations (sum/avg/count/min/max/count_distinct).
- `gridConditionalFormats` — cell-level style rules evaluated per row at render time.
- Cross-source columns (join via FK lookup, see §9.2).
- Cross-filter emission: clicking a row emits a `cross-filter` scoped to `pageId`.

**Row-id de-duplication.** `StudioGridWidget` assigns each DataGrid row an `id` of `row.id` or a synthetic per-index `${widget.id}-${index}` fallback (spreading `row` first so the synthetic-id fallback wins over a null/undefined `id` column). Previously only a *nullish* `id` got a synthetic fallback; two rows sharing the same **non-null** `id` — plausible with real host data — produced duplicate `getRowId` results, which is undefined behavior for `DataGridPremium`. The assignment pass now tracks handed-out ids in a `Set<string>` and re-routes any collision (a duplicate non-null id, or a synthetic id that happens to match a real one) to a distinct `${widget.id}-dup-${index}` id.

**Cross-filter value on an Invalid Date cell.** `normalizeCrossFilterValue` (used by the grid's `getRowClassName` cross-filter row-class computation) called `.toISOString()` on a `Date` value, which throws `RangeError` for an Invalid Date (`new Date('garbage')`). A single host-injected invalid Date cell combined with an active cross-filter therefore crashed the whole card, per row. It now returns `null` (a sentinel that never equals a real filter value) for an Invalid Date instead of throwing.

Cross-source field resolution (`resolveCrossSourceFkFields`, `summaryFieldDefs`, `fieldTypeById`) applies an own-field-wins guard: a cross-source column that happens to share a bare field id with one of the widget's own (primary-source or own-expression-field) fields can never silently steal that field's aggregation/type resolution — mirroring the same primary-wins pattern `buildGridColumnDefs` already uses for column definitions.

Boolean `gridConditionalFormats` rules using the `equals`/`not_equals` operator coerce both the cell value and the rule value to string before comparing, since the rule value is authored as the string `"true"`/`"false"` while a boolean cell holds a real JS boolean — loose equality (`true == "true"`) is `false` under JS coercion, so without the coercion an `equals` rule on a boolean column never matched (and `not_equals` matched every row).

A `gridConditionalFormats` rule's cell color is passed through `sanitizeCssColor` (§10.1) before being applied to the cell's `sx` — a rule whose color value is not a valid CSS color (whether corrupted on load or written by the AI's `update_widget` tool) falls back to no color override rather than being interpolated unchecked. The rule's `fontWeight` gets the same treatment via the `isSafeFontWeightKeyword` allowlist (`'bold' | 'normal'`) — any other value falls back to unset rather than being written into `sx` as authored.

The conditional-format `sx` selector's **key** is guarded separately from its values. Each rule's cell class name is built as `` `.StudioGrid-cf-${id}-${i}` ``, where `id` used to be the raw `widget.id` interpolated directly into the selector string. `widget.id` is normally minted by `createWidgetId` (§2.1) and always identifier-safe, but the persisted-doc load boundary only screens ids for prototype-pollution-unsafe *keys*, not CSS-selector-safety — so a hostile serialized widget id containing selector metacharacters (e.g. `` w{}html{display:none}.x ``) could inject arbitrary rules into the stylesheet the moment the grid has any conditional format at all. `id` is now `sanitizeCssIdentifierToken(widget.id)` (strips to `[A-Za-z0-9_-]`) — a local token used only for this class name; `widget.id` itself is left untouched everywhere else it's used as a data key. This closes a selector-key injection vector distinct from the value-injection class the rest of this section (and §10.1) guards against.

### 10.3 Chart

Supports 16 chart types: `bar`, `bar-stacked`, `bar-100`, `line`, `area`, `area-stacked`, `area-100`, `mixed`, `heatmap`, `funnel`, `gantt`, `sankey`, `pie`, `donut`, `scatter`, `gauge`.

`StudioChartWidget` dispatches on `config.chartType` through a `CHART_TYPE_DEFS` registry. That lookup is `Object.hasOwn(CHART_TYPE_DEFS, chartType) ? CHART_TYPE_DEFS[chartType] : CHART_TYPE_DEFS.bar` rather than a bare `CHART_TYPE_DEFS[chartType] ?? CHART_TYPE_DEFS.bar`: a persisted-doc/AI-authored `chartType` matching an inherited `Object.prototype` key (`"constructor"`, `"toString"`, `"valueOf"`, …) would otherwise resolve to an inherited truthy function whose downstream guard flags read `undefined` and whose `.render(renderContext)` then throws `TypeError: chartTypeDef.render is not a function`. This is the chart-widget instance of the package-wide prototype-chain-safe-lookup convention (§2.1), mirroring `StudioMapWidget`'s `allGeographies` guard; an unrecognized/legacy `chartType` still falls back to the `bar` definition.

**`chartTypeRegistry.ts`'s `getDescriptor()` and write-time validation in `StudioController.addWidget`.** `getDescriptor()` is a second, sibling `kind === 'chart'` dispatch (distinct from `StudioChartWidget`'s `CHART_TYPE_DEFS` lookup above) and now applies the identical guard: `Object.hasOwn(chartTypeRegistry, chartType) ? chartTypeRegistry[chartType] : xyDescriptor`. `StudioController.addWidget` adds a companion guard at the write side, mirroring `updateWidget`'s existing `validateChartConfigKeysForType` check: a widget created with an **own, explicit** `chartType` that fails `isStudioChartType` (from `@mui/x-studio-schema`) is repaired to `'bar'` right at CREATE time — with a dev-mode `console.warn` and any config key invalid for `'bar'` stripped from the widget's config — rather than only being caught later at render time. A widget created with an absent `chartType` (or an explicit `undefined`) is left untouched, since that's the sanctioned default both `resolveChartType` and the AI middleware's widget-builder already apply.

`useChartWidgetData` wraps `useWidgetRows` and adds:

- Aggregation (groupBy + sum/count/avg) using `resolveChartRowsForAggregation` for cross-source fields.
- Sparkline-style sub-series for KPI widgets.
- Ghost dataset (`filteredRowsNoChartCross`) for cross-highlight overlay.

**Aggregation safety** — `aggregateByField` pre-scans the first non-null value of the y-field before aggregating. If the value is non-numeric (e.g. a string ID field used as a count proxy), the effective aggregation is automatically promoted to `'count'`, preventing `NaN` from propagating into the chart. The same auto-detection applies to the funnel chart renderer, which also respects an explicit `config.yAggregation === 'count'`.

**Funnel presentation-config sanitization** — the funnel's `funnelCurve` / `funnelVariant` / `funnelLabelPlacement` are typed as literal unions and `funnelGap` as a number, but none of that is enforced at the load/AI-tool boundary. An unknown `curve`/`variant` string resolves to an undefined curve/shape factory deep inside `@mui/x-charts-pro`'s `FunnelChart`, and a non-number `gap` yields NaN section geometry. `renderFunnel` now allowlist-checks each enum via a shared `sanitizeEnum` helper against `SAFE_FUNNEL_CURVES` / `SAFE_FUNNEL_VARIANTS` / `SAFE_FUNNEL_LABEL_PLACEMENTS` (falling back to the renderer's own default via `undefined`) and runs `funnelGap` through `sanitizeFiniteNumber` — closing the same "unvalidated enum/number reaches a chart prop" class already guarded for `heatColorScheme` (below).

**Gauge range validation** — `StudioGaugeChart`'s `gaugeMin`/`gaugeMax` config values (`valueMin`/`valueMax` props) are typed as `number` but unenforced at the load/AI-tool boundary. A `gaugeMin === gaugeMax` pair divides by zero in the Gauge's angle interpolation → a NaN SVG arc (blank/broken), and `gaugeMin > gaugeMax` renders a visually inverted arc. The component now requires the pair be finite with `max > min`, falling back to `0`/`100` (and `console.warn` in dev) otherwise, then clamps the value into the sanitized range — mirroring the "guard-and-continue, warn in dev, never throw" style `KpiSparkline`'s gauge already uses (§10.4).

**Bar/Scatter numeric config sanitization** — extends the same "guard-and-continue, warn in dev, never throw" precedent to `StudioBarChart`/`StudioScatterChart`. `barMinBandSize` and `barCategoryGapRatio` have no setup-panel UI at all (no `BarConfigSection.tsx` exists), so they're reachable only via `loadSerializedState` or an AI `update_widget`/`apply_bulk_update` tool call, never validated by any UI. `barMinBandSize` feeds `xAxisData.length * barMinBandSize + 40` into a container `<div style={{ height }}>`: a non-finite value collapsed the container to a NaN height (silently blanking the chart), and an unbounded value inflated the layout with no cap. `barCategoryGapRatio` feeds the x-charts axis `categoryGapRatio` prop directly, whose valid range is `[0, 1)`. Both are now validated at every render call site — `barMinBandSize` finite and in `[1, 500]`, `barCategoryGapRatio` finite and in `[0, 1)` — falling back to no override (chart defaults) with a dev-mode warning otherwise. `scatterMinRadius`/`scatterMaxRadius` were previously validated only by `ScatterConfigSection`'s editor-level `RadiusInput` (enforced on a keystroke typed through that specific control), which a `loadSerializedState`/AI tool call bypasses entirely, reaching the bubble `sizeMap.size` scale unchecked. They're now also self-validated at the render call site (finite, positive, `min < max`), falling back to the `4`/`40` defaults with a dev-mode warning.

**Category ordering** — when `xField`'s `StudioDataField` definition carries an `orderedValues` array, `useChartWidgetData` passes it as `categoryOrder` to all aggregation functions. `applyCategoryOrder()` sorts labels by their position in the array; labels absent from the list are appended alphabetically. This takes effect only when `chartSortBy` is not `'value'`; `sortDirection: 'desc'` reverses the sequence.

Chart annotations (`config.annotations`) render horizontal or vertical reference lines on the chart (not supported for pie/donut/gauge). New annotations are assigned ids via `createIdFactory('ann')` (`@mui/x-studio-schema`, §2.1).

Cross-filter emission: clicking a data point emits a `cross-filter` for `xField` value.

**Ghost/baseline gating for split-by and multi-series charts.** `StudioBarChart`'s `effectiveSFData`, `StudioLineAreaChart`'s split-by branch, and `StudioPieChart`'s `twoRingData` all gate entry into their split-by/grouped-series rendering on the **unfiltered baseline** data (the same data used for the cross-highlight ghost), not on the filtered-to-current data alone. An unrelated cross-filter that happens to empty a widget's own filtered rows would otherwise collapse a multi-series chart down to a single unsplit aggregate line/ring, even though the split-by field still has categories in the baseline.

**Scatter now shares the same gate.** Until recently, `StudioScatterChart`'s ghost-baseline rendering (`hasGhostBaseline` and `ghostSeries`) ignored this gate entirely, rendering a dimmed baseline from data the rest of the dashboard's convention treats as unreliable. `chartTypeDefs.tsx`'s `renderScatter()` now threads `ctx.preserveXFieldBaseline`/`ctx.preserveSplitByBaseline` through as two new `StudioScatterChart` props: `preserveXFieldBaseline` gates the single-series baseline (no `colorField`), and `preserveSplitByBaseline` gates the colour-by (`colorField`, scatter's equivalent of a split-by/series field) grouped baseline — bringing scatter in line with bar/line/pie.

Gantt chart items get a stable per-row `id` via `ensureRowIdentity` (`internals/rowIdentity.ts`), used as the React key when rendering bars, rather than a `label`+`startMs` composite key — two tasks with the same label starting on the same day are a legitimate case that a label/start key would collide on, causing the reconciler to pair the wrong row's bar/tooltip state to the wrong DOM node across a cross-filter-driven list change.

**Gantt/Sankey `aria-label` capping.** Both `StudioGanttChart` and `StudioSankeyChart` describe only a bounded number of entries in their text-alternative `aria-label` — Gantt caps to the first `ARIA_LABEL_MAX_ITEMS = 15` of `visibleItems` (the height-capped rows actually rendered, not every filtered row), Sankey caps to the first `ARIA_LABEL_MAX_LINKS = 15` links — and append a `localeText.filterSummaryAndMore(n)` summary for the remainder. Enumerating every row/link of a large filtered dataset would rebuild a multi-hundred-KB string every render and hand screen readers an unusable wall of text.

**Heatmap color ramp and no-data cells.** `StudioHeatmapChart`'s continuous `colorMap` anchors its low end to `theme.palette.background.paper` (tracks light/dark mode) rather than a hardcoded white, so low-value cells blend with the canvas instead of glowing in dark mode. Separately, `aggregateHeatmap` (`internals/chartShapes/heatmap.ts`) only records a `cells` map entry for an `(xLabel, yLabel)` combo that had at least one contributing row; `StudioHeatmapChart` propagates that distinction by omitting a cell's `(xIndex, yIndex)` entry from the series `data` array entirely when `cells.has(key)` is false, rather than defaulting it to `0`. `HeatmapValueType` (`@mui/x-charts-pro`) has no null slot, so "no data" is signaled structurally by the index pair's absence — `HeatmapData.getValue` then resolves it to `null`, which renders with no fill and keeps a genuinely-empty cell visually distinct from a real computed `0`.

**Heatmap color-scheme allowlist.** `heatColorScheme` (`config.heatColorScheme ?? 'primary'`) used to index `theme.palette[colorScheme]` directly. The field's `'primary' | 'success' | 'warning' | 'error'` union isn't enforced at the load/AI-tool boundary, so an unrecognized value made `theme.palette[x]` resolve to `undefined`, and the subsequent `.main` access threw — with no error boundary anywhere in the package at the time, this took down the whole Studio dashboard, not just the one heatmap widget (see §12.4 for the error boundary that now also contains this class of failure). `colorScheme` is now checked against a `SAFE_HEAT_SCHEMES` allowlist before indexing, falling back to `'primary'` on a miss — mirroring `StudioMapWidget`'s existing `COLOR_RAMPS[colorScheme] ?? COLOR_RAMPS.blues` fallback. The heatmap's `legendAlign` (`'start' | 'center' | 'end'`) gets the same treatment via a sibling `SAFE_HEAT_LEGEND_ALIGNS` allowlist: an unenforced value (e.g. `"middle"`) would index the internal `vertAlignMap` as `undefined` or pass raw into the legend position and render a garbage placement — it now falls back to `'center'`.

### 10.4 KPI

Shows a headline aggregate value (sum/avg/count/min/max of `kpiValueField`) plus optional:

- **Sparkline** — a small line/bar chart showing the metric over time (`kpiSparklineField`).
- **Trend badge** — percentage change vs previous period, previous calendar period, or year-over-year.
- **Target line** — a reference line on the sparkline from a `StudioMetricRef`.

Every `selectFiltersForWidget` call in `StudioKpiWidget.tsx` — the fixed-period trend, the filter-based trend, the sparkline's time-field/granularity resolution, and the filter-summary tooltip — passes `includeWidgetRank: true`, matching the headline's own row baseline (`useWidgetRows`). `selectFiltersForWidget` excludes a widget-scoped `filterMode: 'rank'` filter by default (it assumes the chart's post-aggregation re-rank path), so a KPI — which has no such path — must opt back in everywhere it derives filters, or a Top-N/Bottom-N rank filter would scope the headline correctly while the trend/sparkline/tooltip silently computed against the full, unranked row set.

**Loading state.** `StudioKpiWidget` destructures `isLoading` from `useWidgetRows` and treats the widget as still-loading whenever `isLoading` is true and no rows have arrived yet (`currentRows.length === 0`). While that holds, the headline renders a `Skeleton` in place of the value and the sparkline is suppressed, rather than computing and showing a confident `"0"`/`"$0"` from an empty row set — `computeAggregate([], …)` legitimately returns `0` for an empty array, which is otherwise indistinguishable from a real zero total during a cold async-adapter fetch. This gives the KPI widget the same kind of loading affordance other widget kinds already get from `StudioWidgetCard`'s generic `isLoading`/`isError` overlays (§12.4), scoped to the headline/sparkline specifically rather than the whole card.

### 10.5 Filter Widget

Interactive filter controls that emit `scope: 'interactive'` filter states. Four sub-types:

| `filterWidgetType` | Control                  | Value type                    |
| ------------------ | ------------------------ | ----------------------------- |
| `date-range`       | Date range picker        | `[start, end]` ISO strings    |
| `multi-select`     | Searchable checkbox list | `string[]` of selected values |
| `toggle`           | Toggle button group      | single value                  |
| `slider`           | Range slider             | `[min, max]` numbers          |

**Slider config sanitization.** The `slider` sub-type's `filterWidgetMin` / `filterWidgetMax` / `filterWidgetStep` are typed as `number` but unenforced at the load/AI-tool boundary, and a bad pair reaches the MUI `Slider` (via `SliderControl`) directly: `min >= max` yields an inverted, unusable range and `step <= 0`/`NaN` makes the slider's internal rounding produce NaN thumb positions and `aria-valuenow`. `StudioFilterWidget` now coerces the bounds to finite numbers (a local `finiteOr` that, unlike `sanitizeFiniteNumber`, permits negatives), swaps an inverted pair, falls back a zero-width pair to `0`/`100`, and requires `step` to be finite and `> 0` (else the auto default). The exported `SliderControl` component repeats the same sanitization as a defensive backstop, since it can be rendered directly with raw config by custom-slot callers.

**Data access — deliberately bypasses `useWidgetRows`.** Unlike every other widget kind, `StudioFilterWidget` does not call `useWidgetRows`. It reads `getCachedNormalizedDataSource` (§5.1) directly, normalizing lazily and scoped to just the one field being filtered on (`fieldId`), to get a pre-computed `fieldDistinctValues[fieldId]` entry for its option list; it only escalates to `getCachedEnrichedRows` (§5.2, likewise scoped to that single field) when the filtered field is itself a computed, non-measure expression field. This is intentional, not an oversight: `useWidgetRows` returns rows *after* page/widget/cross/interactive filters have already been applied (§3, Layer L3), so a filter widget sourcing its option list from that output would have its own value list shrink as filters were applied through it — e.g. selecting `region = 'Europe'` would filter out every non-Europe row, and the dropdown would then only offer the region values still present in that already-filtered subset on the next render, rather than the source's full set of options. Reading directly off the normalized (pre-filter) rows keeps the option list stable regardless of which filters are currently active.

The `fieldDistinctValues[fieldId]` fast-path lookup is prototype-chain-safe (§2.1): `fieldId` comes from `config.filterWidgetField`, a doc/AI-authored string with no closed-enum validation, so it's now guarded with `Object.hasOwn` rather than a bare bracket index. A hostile value equal to an `Object.prototype` member name (`"constructor"`, `"toString"`, …) previously resolved the inherited function instead of `undefined`, crashing the downstream `.filter`/`.map` calls in `MultiSelectControl`/`ToggleControl`.

### 10.6 Pivot Table

Client-side pivot: groups `effectiveRows` by `pivotRowField` (vertical) × `pivotColField` (horizontal), aggregating `pivotValueField` into each cell. Optional totals row/column (`pivotShowTotals`).

### 10.7 Map (Choropleth)

Renders via the official `@mui/x-charts-premium` Map (`GeoDataPlot` + `MapShapePlot`, behind `Unstable_ChartsGeoDataProviderPremium`) — the custom SVG `ChoroplethChart` was removed in favour of the upstream component (BL-182). Geographies are pluggable through `useStudioGeographies` / `geographyLoaders.ts`: built-in `world` (Natural Earth 110m via `world-atlas`), US states, and a Europe subset, plus consumer-supplied custom TopoJSON definitions; the topology is loaded lazily via dynamic `import`. Region identifier normalisation (ISO alpha-2, alpha-3, or full English names) is handled by `countryUtils`. A continuous colour ramp (5 schemes: blues/reds/greens/oranges/purples) encodes the aggregate value and is rendered with `ContinuousColorLegend`; hover tooltip via `StudioMapTooltip`. Cross-filter-on-click is currently unwired — the unstable `MapShapePlot` does not forward a per-shape item click (tracked as BL-184).

`allGeographies[mapGeography]` (the doc-authored geography-id lookup) is guarded with `Object.hasOwn` rather than a bare bracket index — a widget config carrying a prototype-chain key like `"constructor"` now cleanly resolves to "not found" instead of returning the inherited `Object` constructor. Downstream consumers were already optional-chained, so this was a silent-blank-map correctness gap rather than a crash, but the guard makes the "unknown geography" path explicit.

`countryUtils.ts`'s name-lookup dictionaries carry the same guard. `normalizeToAlpha2`'s `NAME_TO_ALPHA2[lower]` and `normalizeToStateAbbr`'s `STATE_NAME_TO_ABBR[lower]` lookups are keyed by untrusted, lower-cased row data rather than a fixed enum, so a hostile value that lower-cases to an `Object.prototype` member name (`"constructor"`, `"toString"`, …) previously returned the inherited function where both functions' documented `string | null` return contract is relied on by callers. Both are now `Object.hasOwn`-guarded before indexing, matching this section's `allGeographies` guard.

**Documented exception to "official premium components only."** `StudioMapShapePlot.tsx` imports `useSeriesOfType` and `ChartSeriesDefaultized` from `@mui/x-charts/internals`. This was investigated (not fixed) as part of the iteration-26 review pass: a same-shaped public wrapper (`useMapShapeSeries`) exists in `x-charts-premium/src/hooks/useMapShapeSeries.ts` but is not re-exported from that package's public hooks entry point, so there is currently no public equivalent to switch to without changing `x-charts-premium`'s public API — out of scope for an x-studio-only change. Until a public equivalent ships, this one file is a knowing exception to this section's "built only on official premium Map components" framing.

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
  filters: StudioFilterState[];        // page/widget-scope filters only
  relationships?: StudioRelationship[];
  expressionFields?: StudioExpressionField[];
  filterPresets?: StudioFilterPreset[];
  ai?: StudioAIState;                  // conversation threads; omitted when there are none
}
```text

This is exactly `StudioDoc` (§2.1) minus its ephemeral cross-filter/interactive filter entries — `serializeDoc` spreads every `doc` field so a newly-added field is carried automatically, then strips those two filter scopes and omits `relationships`/`expressionFields`/`filterPresets`/`ai` from the payload when empty.

**Excluded from serialisation:** `runtime.dataSources` (host-provided), `session` (`mode` + `shell`, both UI-only).

**Current schema version: 1** (`CURRENT_SCHEMA_VERSION` in `packages/x-studio-schema/src/stateTypes.ts`). The only registered migration is the identity `0 → 1` bump (no structural change) — see §11.3 for the registry's shape and how to add the next one.

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

1. Increment `CURRENT_SCHEMA_VERSION` in `packages/x-studio-schema/src/stateTypes.ts` (the single source of truth; `packages/x-studio-schema/src/statePersistence.ts` re-exports it).
2. Add an entry to the `migrations` registry (in `statePersistence.ts`) keyed by the **old** version number. Every version in `0 … CURRENT_SCHEMA_VERSION − 1` needs an explicit entry — a gap fails migration hard rather than silently stamping the new version.
3. The migration function receives a `Record<string, unknown>` (a deep copy of the persisted state) and must return a new object with `schemaVersion` incremented.
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
```text

> No drilldown/detail panel exists in the current shell — see the note at the end of §7.3.

**Canvas background click.** `StudioCanvas`'s root `onMouseDown` treats any press that does not land inside a `[data-widget-card]` element as a "background click" — clearing the widget selection (`controller.setSelectedWidget(null)`) and firing `onBackgroundClick` (which closes the AI chat overlay). The `StudioDateRangeBar` renders inside that same canvas root but is **not** a widget card, so pressing its own controls (e.g. its preset `Select`) was mis-read as a background click, clearing selection and closing the chat mid-interaction. The bar is now wrapped in a stable `[data-studio-date-range-bar]` region and the handler excludes that region alongside `[data-widget-card]`.

### 12.2 Sidebar tabs

| Tab icon                 | Drawer                | Feature flag                                    |
| ------------------------ | --------------------- | ----------------------------------------------- |
| StorageIcon (Data)       | `StudioDataDrawer`    | `featureFlags.dataManagement`                   |
| TuneIcon (Compose)       | `StudioComposeDrawer` | `featureFlags.compose`                          |
| FilterListIcon (Filters) | `StudioFiltersDrawer` | `featureFlags.filters`                          |
| AutoAwesomeIcon (AI)     | `StudioChatPanel`     | `featureFlags.aiChat` + `aiConfig.endpoint` set |

### 12.3 Drawers

**Drawer-level error boundary (`StudioDrawerErrorBoundary`).** Until recently, neither `StudioComposeDrawer` nor `StudioFiltersDrawer` had any error boundary of their own — the package's only one was the per-widget `StudioWidgetErrorBoundary` (§12.4), scoped to a single on-canvas widget card. A render throw anywhere inside either drawer (a setup panel, a filter row, etc. — e.g. one reached through a hostile/malformed doc-authored id, see §2.1's Tier1 sites) therefore had no boundary to stop at and unmounted the **entire** `<Studio>` tree, not just the panel. `internals/StudioDrawerErrorBoundary.tsx` is a small sibling of `StudioWidgetErrorBoundary` (catch-and-display only, no retry logic) now wrapping both drawers' content; like the widget boundary, it takes a `resetKey` (the current selection — selected widget/field for the compose drawer, selected widget for the filters drawer) and clears its latched error in `componentDidUpdate` when that key changes, so switching the selection after a transient error recovers the drawer instead of leaving it stuck on the fallback until reload. Its fallback message reads a new `drawerPanelError` locale key (translated in all five built-in bundles, §13.7).

A third side panel, `StudioDataDrawer`, was left with no error boundary at all even after the above — a render throw in any of its sections (the data-source list, relationship panel, or lineage graph) still unmounted the entire `<Studio>` tree. It now self-wraps its whole content in `StudioDrawerErrorBoundary` too, mirroring `StudioComposeDrawer`/`StudioFiltersDrawer`'s self-wrap pattern; its `resetKey` is the joined list of currently visible data-source ids rather than a selection, since there is no single "selected" entity in this drawer.

**StudioDataDrawer** — manages data sources, fields, expression fields, and relationships. Shows field types, cardinality, and a lineage graph. Relationships created from `RelationshipPanel` get ids via `createIdFactory('rel')` (§2.1). `EdgeLabel`/`RelationshipPanel` guard every `sources`/`dataSources`/`TYPE_LABELS`/`relationshipTypeLabels` lookup keyed by a relationship's `sourceId`/`targetId`/`junctionSourceId`/`type` fields against inherited `Object.prototype` keys — see §2.1 for the full rationale and the accompanying `.find()` optional-chain fix.

**StudioComposeDrawer** — the widget authoring panel. Contains:

- `AddWidgetView` — widget type picker + optional "Describe a widget" NL creation field.
- Setup panels (`ChartSetupPanel`, `GridSetupPanel`, `KpiSetupPanel`, `MapSetupPanel`, `PivotSetupPanel`, `FilterSetupPanel`, `TextSetupPanel`) — shown when a widget is selected.

There is currently no in-package authoring UI for page-level theme settings — no `PageConfigPanel` (or equivalent) exists in the codebase, and nothing in-package writes `StudioPage.theme`. `StudioCanvas` and `StudioWidgetCard` only *read* `theme` (sanitizing every field they read — including `pageBackground`, see §10.1/§10.2 — before it reaches `sx`); `pageBackground` and the rest of `StudioPageTheme` are currently settable only via a `loadSerializedState` payload or the AI's `apply_bulk_update` tool call, never through in-package UI.

**StudioFiltersDrawer** — filter management. Grouped into page-scope and per-widget sections. Supports filter presets (Saved Views), filter search, and filter cards with inline editing. New page/widget filters created from the drawer are assigned ids via the shared `createFilterId` factory (§2.1) rather than a drawer-local generator.

**StudioChatPanel** — AI chat assistant. Lazy-loaded on first open (single `React.lazy` in the package). Uses `@mui/x-chat` for the message thread. The client `studioBackendAdapter.ts` streams the conversation from a backend AI endpoint via SSE; the agentic tool loop (build system prompt → call the LLM → execute tool calls → recurse until a text response) runs server-side in `@mui/x-studio-ai-middleware` (`agenticLoop.ts`, with tool execution in `executeToolOnState.ts`). Supports 20 built-in tools: `get_dashboard_state`, `add_page`, `rename_page`, `remove_page`, `set_active_page`, `set_dashboard_title`, `add_widget`, `update_widget`, `remove_widget`, `set_widget_layout`, `set_widget_width`, `add_page_filter`, `remove_page_filter`, `add_widget_filter`, `remove_widget_filter`, `summarise_page`, `apply_bulk_update`, `rename_thread`, `query_data_source`, `set_widget_forecast`. Destructive operations (`remove_widget`, `remove_page`) are gated by a `Promise<boolean>` confirmation rendered as a `ChatConfirmation` component inline in the chat thread. Can be used as a FAB overlay (`overlay={true}`, default in `<Studio>`) or as a persistent sidebar panel (`overlay={false}`, composable usage).

`StudioContent` exposes a consumer `slotProps.chatPanel` spread onto `StudioChatPanel`, but the internally-managed props must always win over it. `aiConfig`/`open`/`onClose`/`overlay` were already placed after the spread and excluded from the `slotProps.chatPanel` type via `Omit`; `focusedWidgetId` (the widget-insight focus) and `pendingMessage` (the queued insight prompt) are now given the same treatment. Previously `focusedWidgetId` sat *before* the spread — letting a consumer silently override "Explain this widget" — while `pendingMessage` sat after but was still spreadable in the type; both are now consistently after the spread and added to the `Omit`.

### 12.4 StudioWidgetCard

Each widget in the canvas is wrapped in `StudioWidgetCard`, which provides:

- Title / subtitle bar with edit (pencil) button.
- Loading / error overlays driven by `isLoading` and `isError` from `useWidgetRows`.
- Skeleton placeholder while `showContent === false` (prevents CLS).
- Click-to-select for edit mode.
- `StudioWidgetEditDialog` (full config dialog on double-click).
- **`onAiRequest` prop** — optional consumer-provided callback. When set, an `AutoAwesome` icon button appears in the card's action overlay (edit mode only). Calling it passes `widgetId` to the host app, enabling the host to open a custom AI panel focused on that widget. Propagated from `StudioCanvas` via `slotProps.widgetCard`.
- **Built-in insight panel** — when `aiConfig?.endpoint` is set, an `AutoAwesome` dropdown appears in the action overlay (both edit and view modes) with options: Summary, Analysis, Forecast. Selecting one calls `generateWidgetInsight()`, which sends up to 100 aggregated rows to the LLM and renders the result in `StudioInsightPanel` — an absolutely-positioned overlay inside the card (`bottom: 8, left: 8, right: 8, maxHeight: 60%`).
- **Anomaly detection** — a `TroubleshootIcon` toggle button (chart widgets only, both modes) enables statistical anomaly detection. Detected anomalies show a count badge. When anomalies are present, an "Explain Anomaly" button appears; clicking it dynamically imports `generateAnomalyExplanation` (code-split) and displays the result in the same `StudioInsightPanel`.
- **Per-widget error boundary.** The rendered widget component (`def.component`) is wrapped in `StudioWidgetErrorBoundary` — a minimal class component (`getDerivedStateFromError`, catch-and-display). Before this existed, any widget's render throw (e.g. the heatmap color-scheme crash in §10.3) unmounted the entire `<Studio>` tree, since the package had no other error boundary; now it renders the same `StudioWidgetErrorOverlay` a single widget would show for a data-fetch error, containing the blast radius to that one card. The boundary takes a `resetKey={JSON.stringify(widget.config)}` and clears its latched error in `componentDidUpdate` when that key changes: because `getDerivedStateFromError` latches `hasError` permanently and the card is keyed by `widgetId` (config edits don't remount it), a transient render error from a bad config (e.g. one written by an AI tool call) that the user then corrects would otherwise leave the widget stuck on the error overlay until a full page reload — the reset recovers it in place once the config plausibly changed. This class originally lived privately inside `StudioWidgetCard.tsx`; it now lives in shared `internals/StudioWidgetErrorBoundary.tsx` (mirroring the existing `internals/StudioDrawerErrorBoundary.tsx`) so it can wrap `def.component` anywhere it's rendered for a single widget, not just on the canvas card (see below) — `StudioWidgetCard.tsx`'s own copy was then deduped down to an import of the shared one. `StudioDrawerErrorBoundary` (§12.3) is the sibling boundary for the side-panel drawers, which this per-widget boundary does not cover.
- **Coverage extends to the widget Edit/Expand dialogs.** Until recently, `BuiltinWidgetPreview` (the widget Edit Dialog's live preview) and `StudioWidgetExpandDialog` (the fullscreen chart "expand" view) rendered the same `def.component` as the canvas card with no error boundary of their own — a render throw in either previously propagated all the way up and unmounted the whole `<Studio>` tree, the exact failure mode the boundary above exists to prevent on the canvas. Both now wrap `def.component` in the shared `StudioWidgetErrorBoundary`, keyed by `JSON.stringify(widget.config)` to match the canvas card's own reset behavior. `StudioWidgetEditDialog` additionally wraps each of its tab panels — Setup (`def.setupPanel`), Filters (`WidgetFiltersPanel`), and Format (`FormatPanel`/`TextFormatPanel`) — in `StudioDrawerErrorBoundary` (§12.3), keyed by `widgetId`, since those panels are the same class of content the Compose drawer already wraps for the same reason.
- **Loading-spinner accessible name.** The default loading overlay's `CircularProgress` (and the analogous AI-generation spinner in `StudioTextWidget`) now carry `aria-label={localeText.widgetLoadingLabel}` — a new locale key (translated de/es/fr/ptBR) — where previously the spinner had no accessible name at all.

### 12.4.1 Drag-and-Drop (`@atlaskit/pragmatic-drag-and-drop`)

Canvas widget reposition and compose-panel-to-canvas drop use **`@atlaskit/pragmatic-drag-and-drop`** (element adapter), not native HTML5 DnD or react-dnd.

**Why not native HTML5 DnD:**
Chrome locks the OS pointer cursor before `dragstart` fires (~3 px movement threshold), so native DnD `cursor` CSS set in `dragstart` is ignored — the only reliable fix is suppressing native DnD's own drag image/cursor handling entirely and driving the cursor via a CSS class toggled from JS instead (see "Cursor rules" below). An earlier iteration used react-dnd for this; the DnD layer was later migrated to `@atlaskit/pragmatic-drag-and-drop`, which the codebase now uses exclusively (no `react-dnd` dependency remains).

**Architecture:**

| Component | Role |
|---|---|
| `useStudioDraggable` (StudioCanvas) | Wraps `draggable()` from `@atlaskit/pragmatic-drag-and-drop/element/adapter`. Suppresses the native drag preview via `disableNativeDragPreview`, or mounts a custom preview via `setCustomNativeDragPreview` + a caller-supplied `renderPreview`. Guarantees the drop handler fires even if the element unmounts or `canDrag` flips off mid-drag. |
| `useStudioDropTarget` (StudioCanvas) | Wraps `dropTargetForElements()`; returns `isOver` (over AND droppable), mirroring react-dnd's `monitor.isOver() && monitor.canDrop()` semantics. |
| `studioWidgetDndTypes.ts` | Shared constants (`DRAG_TYPE_CANVAS_WIDGET`, `DRAG_TYPE_COMPOSE_WIDGET`), typed item interfaces, and the `isStudioDragItem` type guard used by drop targets to ignore unrelated drags |
| `StudioDragLayer.tsx` | A single `monitorForElements()` monitor toggles the `x-studio-dnd-active` class on `<html>` on drag start/drop; `GlobalStyles` sets `cursor: move !important` while that class is present and `cursor: copy !important` over `[data-studio-drop-active]` |
| `useStudioWidgetCardDrag` (StudioWidgetCard) | Calls `useStudioDraggable`; sets `document.body.dataset.studioDraggingWidgetId` and dims the source card's opacity to `0.1` for the ghost preview (via `createClonePreview`, which clones the card DOM node into the preview container) |
| `AddWidgetView.WidgetTypeCard` | Drag source (via `useStudioDraggable`) for compose-panel widget type cards |
| `InsertionPoint` (StudioCanvas) | Drop target (via `useStudioDropTarget`) for horizontal row insertion |
| `WidgetGap` (StudioCanvas) | Drop target for vertical in-row insertion; also houses `RowResizeHandle` |
| `StudioCanvas.tsx` | Registers `autoScrollForElements` (from `@atlaskit/pragmatic-drag-and-drop-auto-scroll/element`) on the canvas's scroll parent so dragging near the viewport edge auto-scrolls |

**Cursor rules:**
- Default arrow cursor (`default`) everywhere — no `cursor: pointer` on canvas elements
- `cursor: move` while any drag is in progress (set via the `html.x-studio-dnd-active` class)
- `cursor: copy` when hovering an active drop zone (`[data-studio-drop-active]` attribute)
- `cursor: col-resize` on `RowResizeHandle` — intentional, not overridden

**Adjacent gap exclusion (BL-112):**
`useStudioWidgetCardDrag`'s drag-start handler sets `document.body.dataset.studioDraggingWidgetId`; `InsertionPoint`/`WidgetGap`'s `canDrop` callback calls `isAdjacentToDraggingWidget()` to disable the two gaps immediately flanking the dragged widget.

### 12.5 Keyboard shortcuts

`useStudioKeyboardShortcuts` binds only:

- `Ctrl/Cmd + Z` → `controller.undo()`
- `Ctrl/Cmd + Shift + Z` / `Ctrl/Cmd + Y` → `controller.redo()`

There is no `Escape` binding (no deselect, no drilldown to close). The listener is scoped to a single `<Studio>`/`<StudioDashboard>` instance via a root-ref focus check (falling back to whichever instance's root was most recently focused when nothing is currently focused), and it ignores keystrokes while an editable element (input/textarea/select/`contenteditable`) has focus.

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

All user-visible strings are defined in `StudioLocaleText` (≈ 300 tokens) and passed via `localeText` prop on `<Studio>`. Tokens not provided fall back to the English defaults. This includes strings written to exported files, not just on-screen UI: `runWidgetExport`'s CSV placeholder for a not-yet-loaded adapter-backed grid (`widgetExportNoDataMessage`) is a `StudioLocaleText` token, translated in all five built-in bundles, rather than a hardcoded English sentence.

#### Built-in locale bundles

| Export      | Locale  | Language             |
| ----------- | ------- | -------------------- |
| `enUS`      | `en-US` | English (default)    |
| `ptBR`      | `pt-BR` | Brazilian Portuguese |
| `frFR`      | `fr-FR` | French               |
| `deDE`      | `de-DE` | German               |
| `esES`      | `es-ES` | Spanish              |

Import the locale text object and pass it to `<Studio>`:

```tsx
import { Studio, ptBR } from '@mui/x-studio';
import { createTheme, ThemeProvider } from '@mui/material/styles';

// Approach 1: direct prop
<Studio localeText={ptBR.components.MuiStudio.defaultProps.localeText} />

// Approach 2: theme-level (integrates with other MUI X locales)
const theme = createTheme(ptBR);
<ThemeProvider theme={theme}><Studio /></ThemeProvider>
```

#### Helper functions that accept `localeText`

Several utility functions used by the Studio internals accept an optional `localeText` argument so they can be called outside of the React tree with any locale:

- `inferWidgetTitles(widget, sources, localeText?)` — auto-generates widget title + subtitle
- `formatDateFilterLabel(filter, localeText?)` — formats a relative or absolute date filter as a string
- `inferKpiDateSubtitle(widget, sources, localeText?)` — generates the KPI date-range subtitle
- `aggregationLabel(aggFn, localeText?)` — returns the display label for an aggregation function
- `computeGridSummary(rows, columns, localeText?)` — returns summary row labels for a grid

#### Token categories

The `StudioLocaleText` interface is grouped into the following categories (see `StudioUIConfigContext.ts` for full details):

- Drawer titles, date range presets, quick filter bar
- Filters panel (add/save/delete views, search)
- Widget states and card actions
- Widget edit dialog, compose drawer, format panel
- Data drawer, relationship management, lineage graph
- Filter conditions, relative date filters, filter widget controls
- Expression field dialog (calculated fields)
- Aggregation functions, time granularity, sort direction
- Chart/KPI/Grid/Map/Pivot/Filter/Text/Page setup panels
- AI chat suggestions and AI insight type labels
- Auto-generated widget titles and date filter labels (grammar tokens)
- Grid summary row labels

---

## 14. AI Features

> For the complete AI pipeline reference including entry points, SSE streaming, tool dispatch, data summarization, and per-example display paths, see `AI_ASSISTANT_OVERVIEW.md`.

### 14.1 AI Configuration

```ts
interface StudioAIConfig {
  endpoint: string;              // OpenAI-compatible completions URL
  apiKey?: string;               // Omit for server-side proxy
  model?: string;                // Default: 'gpt-4o'
  headers?: Record<string, string>; // Extra auth headers for proxy
  privateMode?: boolean;         // When true, dashboard state omitted from system prompt
}
```

Set on `<Studio aiConfig={...}>` or `<StudioProvider aiConfig={...}>`. Pass `null` to fully disable AI features.

### 14.2 Multi-Turn Chat — `StudioChatPanel`

`StudioChatPanel` uses `@mui/x-chat`'s `ChatBox` component and a custom `ChatAdapter` (`createBackendChatAdapter`) that implements an agentic SSE streaming loop:

1. **System prompt** — `buildAISystemPrompt(controller.getState())` is called fresh on every request. Contains schema-only context (dashboard meta, pages, active-page widgets with config, data source fields + `aiDescription`, filter presets, expression fields). **No row data is included.** Skipped when `privateMode: true`.
2. **Streaming** — `fetch` with `stream: true`; SSE events are dispatched as text deltas, state mutations, or finish events.
3. **Tool execution** — Handled server-side by `executeToolOnState`. Mutations are streamed back as SSE `state-mutation` events and applied client-side via `applyStateMutation`.
4. **Agentic follow-up** — After all tool results are appended to message history, the loop recurses until the model returns a response with no tool calls.

**Conversation state:** Thread messages are stored in `controller.state.doc.ai.threads[activeThreadId].messages` and persisted as part of `doc` (see §2.1). A thread selector UI in the `StudioChatPanel` header allows switching threads; the `rename_thread` tool auto-names threads after the first message. `useChatThreads`'s "New conversation" action (`handleNewThread`) is a no-op when the currently active thread has never had a message sent (absent from `doc.ai.threads`, or present with an empty `messages` array) — it reuses that already-empty thread instead of appending another one, so repeated "New conversation" clicks with nothing typed in between don't accumulate empty threads in the persisted doc.

**Total thread-sort comparator.** `useChatThreads`'s thread-list sort compares `updatedAt ?? createdAt` via `.localeCompare`. Those timestamps are strings by type, but a hostile/hand-edited persisted doc can carry a non-string or entirely missing value; since the comparator runs inside a `useMemo` on mount (only with 2+ threads), a `TypeError` there crashed the **whole** chat panel. The fix is at both ends: the schema package's load boundary (`repairThreadLeafShapes` in `@mui/x-studio-schema`'s `statePersistence.ts` — documented in that package's own `ARCHITECTURE.md`) coerces a bad `createdAt` to a safe default and drops a non-string `updatedAt`, and the comparator itself now `String(...)`-coerces both sides (`String(a.updatedAt ?? a.createdAt ?? '')`) so it stays total regardless of what data reaches it.

**Auto-submit dedup.** `StudioChatPanel` queues auto-submit-eligible events (an `initialPrompt` mount-submit, a widget-insight click, etc.) in a `pendingAutoSubmit` React state array rather than a local ref, and prunes an entry only after `AutoSubmitTrigger` actually consumes it (via `onConsumed`). This matters because in overlay mode (`overlay={true}`) `<Grow mountOnEnter unmountOnExit>` unmounts `StudioChatPanel` whenever the overlay closes — a ref-based dedup set would reset to empty on that unmount, so reopening the overlay could re-find and re-submit an event it had already handled. Every id/sequence number generated for this queue (and for thread/message ids) comes from a monotonic counter in `chatIds.ts` (`createThreadId`, `createMessageId`, `nextAutoSubmitSeq`) rather than `Date.now()`, since two auto-submit-eligible events landing in the same millisecond would otherwise share a value and the queue's dedup would silently drop the second one.

**SSE stream hardening (`sseUtils.ts`).** `parseSSEStream` accumulates decoded bytes in a `buffer` that a well-behaved server keeps to a single partial line between reads. Two guards protect against a misbehaving/hostile stream: (1) when a terminal event (`finish`/`error`) stops iteration, the reader is now `reader.cancel()`-ed immediately so the underlying socket is released rather than left open until the caller separately calls `.stop()` or the page unloads; (2) the un-newlined buffer is capped at 8 MB — a stream that never emits a newline would otherwise grow it without bound (eventual OOM in a long-lived tab), so exceeding the cap cancels the reader and throws a descriptive `MUI X:` error instead of accumulating.

**Message-metadata coercion (`studioBackendAdapter.ts`).** The `message-metadata` SSE branch previously forwarded the event's `metadata` object straight through to the assistant message. The renderer (`StudioMessageRoot`) draws `{metadata.model}` directly as a React child and reads numeric token/iteration counts, so a non-string `model` or non-numeric count from a malformed/persisted-bad event crashed the message renderer in dev builds (and caused a reload loop). The branch now emits only a sanitized record — `model` kept only when a string, each count kept only when a finite number, and the whole `metadata` dropped when it isn't a plain record — matching the coercion the sibling `tool-activity`/`usage` branches already apply.

**20 built-in tools** (see `studioAITools.ts`): page management, widget CRUD, filter management, layout, `summarise_page`, `apply_bulk_update`, `rename_thread`, `query_data_source`, `set_widget_forecast`.

### 14.3 Widget-Level AI Insights

Five functions in `generateInsight.ts` make **single non-streaming** LLM calls and return `Promise<{ text: string }>`. They are the **only** paths that send row data to the LLM.

| Function | Trigger | Data sent | Display |
|---|---|---|---|
| `generateWidgetInsight` | Widget card AutoAwesome dropdown (Summary / Analysis / Forecast / Correlation) | Up to 100 aggregated rows + field schema | `StudioInsightPanel` inside widget card |
| `generateDashboardSummary` | AutoAwesome FAB at `bottom: 76, right: 20` in `<Studio>` | Schema only (`buildAISystemPrompt`) | Bottom `<Drawer>` (`maxHeight: 40vh`) |
| `generateAnomalyExplanation` | "Explain Anomaly" button (code-split, chart widgets) | Oversampled anomaly rows + schema | `StudioInsightPanel` inside widget card |
| `generateCorrelationInsight` | `generateWidgetInsight` delegate when `type === 'correlation'` | Pearson r matrix + data sample | `StudioInsightPanel` inside widget card |
| `generateFieldDescriptions` *(server-side)* | Developer-triggered at source registration | Field metadata + sample values | Returns `{ id, aiDescription }[]` for developer use |

`StudioInsightPanel` (`src/StudioInsightPanel/`) renders absolutely inside the widget card with type-switcher chips, Refresh, Copy, and Close buttons.

`generateInsight.ts`'s y-axis label resolution routes calculated (expression) fields through the same `sourceFieldsWithExpressions` helper its sibling label-resolution call sites already use, rather than looking the field up against the source's raw physical fields alone — otherwise a y-field that is a calculated column would resolve to no label at every one of these call sites except the ones that already special-cased it.

`buildWidgetDataSummary`'s `'aggregate'` sampling path likewise now passes `sourceFieldsWithExpressions(source, state.doc.expressionFields)` to `aggregateRows` instead of the bare `source.fields` — matching every other field lookup in the file. With just `source.fields`, a numeric expression/calculated column wasn't found, failed `aggregateRows`' `field?.type === 'number'` check, and got bucket/first-value sampling instead of numeric aggregation, silently misrepresenting a computed measure in the AI-generated insight.

`generateInsight.ts`'s internal `formatDate` calls `d.toLocaleDateString(undefined, {...})` — locale-aware, matching every sibling date-formatting call site in the codebase — rather than hardcoding `'en-US'`.

`generateInsight.ts`'s `aggregateRows` computes each bucket's `min`/`max` with a `reduce` loop (`nums.reduce((acc, v) => (v < acc ? v : acc))` / the `>` counterpart) rather than `Math.min(...nums)`/`Math.max(...nums)`. Spreading an array as call arguments throws `RangeError: Maximum call stack size exceeded` once it exceeds roughly 65k–125k elements (engine-dependent), and a single aggregation bucket here can hold up to `ceil(totalRows / maxRows)` values — large enough to hit that ceiling for a big source. This mirrors the reduce-loop idiom `numericStats` already uses a few lines below (and `internals/aggregate.ts` / `utils/gridGrouping.ts` elsewhere in the package).

All client-side functions are re-exported from `src/index.ts`. `generateFieldDescriptions` is exported from `@mui/x-studio-ai-middleware`.

### 14.4 Forecast / Trend Overlay

Chart widgets with `chartType: 'line' | 'area'` support a `forecast?: StudioWidgetForecast` config:

```ts
interface StudioWidgetForecast {
  enabled: boolean;
  periods?: number;            // default 3
  method?: 'linear';           // OLS linear regression
  showConfidenceBands?: boolean; // ±1 std error shaded band
}
```

The AI sets this via the `set_widget_forecast` tool. Client-side computation lives in `forecastUtils.ts` (no external dependencies). The forecast series appears as a dashed line extending beyond the last data point, with optional confidence bands.

### 14.5 `onAiRequest` Prop

`StudioWidgetCard` accepts an optional `onAiRequest?: (widgetId: string) => void` prop (propagated via `StudioCanvas slotProps.widgetCard`). When provided:
- An `AutoAwesome` icon button appears in the card overlay (edit mode only, separate from the built-in insight menu)
- The host app receives `widgetId` and can open its own AI panel focused on that widget

This is the integration point for `examples/x-studio-ai` — the host app can open the `ActiveChatPanel` scrolled to a widget-specific prompt.

### 14.6 NL Widget Creation (`createWidgetFromDescription`)

A single-turn, non-streaming path used only by the Compose Drawer's "Describe a widget" text field. Forces an `add_widget` tool call, merges with `createDefaultWidget(kind)` defaults, and calls `controller.addWidget()` directly. Independent of `StudioChatPanel` and `studioBackendAdapter.ts`.

### 14.7 Data Isolation

The main chat pipeline **never** sends row data to the LLM — only schema metadata. Row data reaches the LLM exclusively through the insight functions in `generateInsight.ts` (up to 100 rows, aggregated or sampled). This is an important security boundary for sensitive datasets.

With `privateMode: true`, even the schema is omitted — the LLM operates on static instructions only.
````
