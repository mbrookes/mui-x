# x-studio architecture review (iteration 4)

Fresh review of `packages/x-studio` performed against current source (post-iteration-3
fixes). Findings are grouped by tier: Tier 1 (correctness bugs with a clear reproduction
path), Tier 2 (real but lower-severity issues), Tier 3 (architectural/cohesion debt).

## Tier 1

### 1.1 — Grouped-ring pie ignores hard filters (interactive filter widgets and `crossFilterMode: 'filter'`)

`components/widgets/StudioChartWidget/StudioPieChart.tsx:161-195`

```ts
// Always use baseline rows so cross-filters dim rather than remove slices.
const baseRows = allEnrichedRows.length > 0 ? allEnrichedRows : enrichedRows;
```

Ring values are always aggregated from `allEnrichedRows`, and the dimming sets
(`filteredCategories` / `filteredSlicesByCategory`, lines 176-193) are only computed when
`shouldShowGhost`. Per `useWidgetRows.ts` (lines ~30-46 and 256-276): `allEnrichedRows`
derives from `filteredRowsNoCross`, which excludes **both** chart cross-filters **and**
interactive (filter-widget) filters, and `shouldShowGhost` is true only for _chart-click_
cross-filters in `'cross-highlight'` mode.

Triggers and consequences:

- A filter-widget selection (interactive filter) on the page: every other widget
  hard-filters, but a pie with `seriesField` set renders completely unfiltered values with
  no dimming — the filter appears to work everywhere except this widget.
- A widget with `crossFilterMode: 'filter'` receiving a chart cross-filter:
  `shouldShowGhost` is false, so again the rings render the unfiltered baseline, silently
  ignoring the filter that the single-ring pie path (line 366,
  `pieBaseData = isPieHighlightActive ? allChartData! : chartData`) correctly honors.

### 1.2 — Scatter ghost mode shifts every category's color and duplicates the legend

`components/widgets/StudioChartWidget/StudioScatterChart.tsx:84-110`

```ts
return allScatterSeries.map((s) => ({
  id: `${s.id}${GHOST_SERIES_SUFFIX}`,
  label: s.label,          // ghost series carry legend labels
  data: s.data,
  markerSize: 3,
}));
...
const resolvedSeries = ghostSeries ? [...ghostSeries, ...highlightedSeries] : highlightedSeries;
```

No series carries an explicit `color` (`prepareScatterDataGrouped` in
`internals/chartShapes/scatter.ts` returns only `{id,label,data}`), so MUI ScatterChart
assigns `colors[seriesIndex]`. With N ghost series prepended:

- Highlighted series get palette indices N..2N-1 — every category's color **changes the
  moment a cross-filter activates**, and the ghost for "Category A" is a _different_ color
  than the highlighted "Category A" (the CSS `nth-of-type` rule at line 156 only lowers
  opacity; it can't fix the hue).
- Because ghost series have `label`, the legend shows **every category twice** with two
  different colors.
- Bonus mismatch: `allScatterSeries` (baseline) can contain categories absent from the
  filtered set, so ghost/highlighted lists aren't even the same length, making the index
  skew data-dependent.

Contrast: the line/area ghost paths pin colors explicitly per series
(`StudioLineAreaChart.tsx:234, 365, 392`); scatter is the one family that forgot.
`StudioScatterChart.test.tsx` only asserts that a ghost series is prepended, not
colors/legend.

### 1.3 — Grouped-ring pie: same split-by category gets different colors in different rings; legend misdescribes inner rings

`components/widgets/StudioChartWidget/StudioPieChart.tsx:169-316`

Each ring aggregates independently (`aggregateByField(catRows, sliceField, …)` line 171),
and slice colors are positional within the ring: PieChart default palette per
`dataIndex`, and the dim color is `resolvedChartColors[i % …]` (line 303). Per
`internals/aggregators.ts:297-303`: labels are the sorted keys of _that ring's_ rows. So
ring 1 with slices `[A,B,C]` colors A=palette[0]; ring 2 containing only `[B,C]` colors
B=palette[0]. The legend is built from the outermost ring only (line 308-312), so
inner-ring slices are colored like a _different_ category than the legend says. Trigger:
any grouped-ring pie where the split-by category sets differ across x-categories — the
normal case for sparse data. Consequence: reading the chart by color gives wrong answers.

Secondary drift in the same path: the dim color uses `resolvedChartColors` while
un-dimmed arcs use the PieChart `colors={chartColors}` default (the single-ring path
deliberately reconciles this via `themeDefaultPieColors`, lines 504-509; the ring path
doesn't), and `valueFormatter`/`pieMaxSlices` are not applied to rings (tooltips show raw
numbers where the single-ring pie shows formatted ones).

### 1.4 — `WidgetFilterRow` commits a stale full-filter snapshot — debounced value commits silently revert concurrent edits

`components/StudioFiltersDrawer/WidgetFilterRow.tsx:81-88`:

```ts
const handleFilterChange = (changes: Partial<StudioFilterState>) => {
  const merged = { ...filter, ...changes };
  ...
  controller.updateFilter(filter.id, merged);
};
```

`controller.updateFilter` (`StudioController.ts:1314-1354`) already merges the patch into
the **current** store filter (`{ ...filter, ...changes }`), so passing the whole
render-time `filter` snapshot overwrites every field with stale values.
`FilterValueInput.tsx:47-56` dispatches value edits through a 150ms debounce whose timeout
captures the `onChange` closure (and therefore the `filter` snapshot) from the keystroke's
render:

```ts
debounceTimer.current = setTimeout(() => {
  onChange(newVal);
}, 150);
```

Trigger: type in the value field, then within ~150ms change the operator / conjunction /
second-condition (or vice versa — edit value2 right after value). The later-firing
debounced commit writes `{...staleFilter, value}` and reverts the other change. Example:
set operator to `>`, the pending value commit restores `equals`, and the engine filters
with the reverted operator. `PageFilterRow.tsx:88-90` is immune (it passes only the delta)
— the widget row should do the same (the rank auto-wire only needs `field` added to the
delta).

### 1.5 — Switching a widget's data source strands widget-scoped filters, which then filter out every row (KPI silently shows 0)

- `components/StudioComposeDrawer/KpiSetupPanel.tsx:253-272` (source Autocomplete) and
  `:292-321` (cross-source value-field pick) fold `sourceId` + `kpiValueField`/
  `kpiAggregation` into one commit, but never touch the widget's managed date-range
  filter (`setWidgetDateRange` filter with `scope.kind === 'widget'`, field from the
  **old** source).
- `internals/filterScoping.ts:48-51` applies widget filters purely by `widgetId` — no
  field/source existence check:

```ts
case 'widget':
  if (sv2.widgetId === widgetId && f.filterMode !== 'rank') { result.push(f); }
```

- `internals/filterUtils.ts` (between/gte date branches): `if (rv == null) return false;`
  — a field absent from the new source's rows fails for **every** row.

Consequence: KPI with an active "Date range" (e.g. last 12 months) → switch source → KPI
silently renders 0/empty with no indication why; the panel's own date-range section shows
an empty field picker (options come from the new source, `activeDateFieldId` is the old
field, `KpiSetupPanel.tsx:227-231`) while the filter stays active. Same mechanism hits
`GridSetupPanel.handleSourceChange` (`GridSetupPanel.tsx:288-293`): it carefully clears
`FIELD_BOUND_GRID_CONFIG_KEYS` ("the old field IDs no longer resolve against the new
source", lines 64-82) but widget filters created in `WidgetFiltersPanel` reference
old-source fields and survive, blanking the grid. The invalidation rationale documented
for config keys applies identically to widget-scoped filters and is not implemented.

### 1.6 — Switching a filter's operator away from `between` leaves the `{from,to}` object value — filter matches nothing and inputs show "[object Object]"

Operator changes write only the operator:

- `components/StudioFiltersDrawer/FilterBody.tsx:86-88`:
  `onChange({ operator: event.target.value as StudioFilterOperator })`
- `components/StudioWidgetEditDialog/FilterRow.tsx:143`: same.

With a configured between value (`{from, to}`) and operator switched to e.g.
`greater_than`:

- Engine: `compileSingleCondition` computes `toComparable({from,to}, 'number')` → `NaN`;
  `Number(row[field]) > NaN` is false for every row, and
  `isConditionComplete('greater_than', {from,to})` is **true**
  (`value !== '' && value != null`, `filterUtils.ts:361-373`) — so the filter is active
  and excludes all rows.
- UI: `FilterValueInput.tsx:30` (`const strVal = String(value ?? '')`) seeds the text
  field with `"[object Object]"`; `FilterRow.tsx:184` renders `String(filter.value)` =
  `"[object Object]"`; `summarizeFilter` shows e.g. "Before: [object Object]".

The reverse direction (scalar → between) was fixed (comment "1.10"; between branch
defensively coerces non-objects at `FilterValueInput.tsx:68-71`, `FilterRow.tsx:58-61`) —
this direction was missed. The operator `onChange` should reset the value when
shape-incompatible.

### 1.7 — `contains` filter is pushed to the server as an unwrapped, case-sensitive `LIKE` — silently diverges from in-memory semantics

`server/createBatchingAdapter.ts:1039-1049` (`OPERATOR_MAP`), `:1099-1123` (`leafToPredicates`);
server side: `packages/x-studio-data-middleware/src/shared/predicates.ts:251-253`. (Independently found by both the top-level review and a sub-review; both traces agree.)

`OPERATOR_MAP` maps `contains: 'like'`, so a `contains` leaf passes
`isLeafServerTranslatable` and is sent to the server rather than routed to the client-side
residual. `leafToPredicates` forwards `leaf.value` completely unmodified — no `%`
wildcards are added — into `{ column, operator: 'like', value }`. On the server,
`predicates.ts:252` executes `query.whereLike(column, value)`, Knex's literal `LIKE` —
without wildcard characters this behaves as an (also case-sensitive) exact match, not a
substring search. Meanwhile the in-memory evaluator's `contains`
(`internals/filterUtils.ts:202-208`) does
`String(row[field] ?? '').toLowerCase().includes(needle)` — a case-insensitive substring
match. The file's own comment two operators below (documenting why `starts_with`/
`ends_with` are deliberately kept client-side) calls out this exact case-sensitivity
hazard for `LIKE`, but the reasoning was never applied to `contains` itself, and no
`%`-wrapping was added either.

Trigger: any `contains` filter (page filter, widget filter, quick-filter chip, AI-added
filter) against an adapter-backed (server/db-tier) data source, whenever the leaf is
otherwise translatable — i.e. the common case.

Consequence: a filter meant to match "contains 'apple'" against a live database source
returns only rows whose column is _exactly_ `"apple"` (case-sensitively) instead of every
row containing that substring — silently under-returning data with no warning (unlike
`count_distinct`/OR-groups, which do warn via `warnAdapterDivergence`). There is zero test
coverage for this path (`createBatchingAdapter.test.ts` has no `contains`/`like`
assertions). Fix is either `%${escapeLike(value)}%` + case-insensitive (`whereILike` or
equivalent) semantics, or moving `contains` into the client-residual set like its
siblings.

### 1.8 — `StudioDashboard` config swap silently destroys registered data adapters

`components/Studio/StudioDashboard.tsx:153-189`; root cause in
`store/StudioController.ts:634-656`.

On a `config` prop change the effect calls `loadSerializedState(config.doc)` and then
`for (const dataSource of Object.values(config.runtime.dataSources)) innerRef.current?.upsertDataSource(dataSource);`.
`upsertDataSource` **replaces the whole source entry**:
`dataSources: { ...state.runtime.dataSources, [dataSource.id]: dataSource }`. A config
produced by `serializeState()`/JSON has no `adapter` field, so every adapter previously
registered through the `dataAdapters` prop is wiped. The adapter-registration effect
(`:182-189`) has deps `[dataAdapters]` only — it does **not** re-run on `config` change, so
nothing re-attaches them.

Trigger: the documented embed flow —
`<StudioDashboard config={...} dataAdapters={{...}} />` — followed by any change to the
`config` prop reference.

Consequence: after the swap all adapter-backed sources silently fall back to static
`rows` from the config (typically absent) — widgets go empty/stale with no error.
Additionally the wipe path skips cache invalidation (`upsertDataSource` only calls
`studioRequestCache.invalidateSource` `if (dataSource.adapter)`). Fix: re-apply
`dataAdapters` after the upsert loop (or make the upsert preserve an existing adapter when
the incoming source has none).

## Tier 2

### 2.1 — Multi-Y line/area: expression-field labels/formats only work while a ghost is active

`components/widgets/StudioChartWidget/StudioLineAreaChart.tsx:375-402` and
`components/widgets/StudioChartWidget/lineSeries.ts:27`

The ghost-active branch resolves each series with
`resolveFieldDef(s.fieldId, dataSource, expressionFields)` (line 385), but the normal
branch delegates to `buildMultiYLineSeries(multiYData, chartType, dataSource?.fields)` —
and inside `lineSeries.ts`, `const fieldDef = fields?.find(...)` never consults
expression fields. For a computed y-field on a multi-Y line/area chart: legend shows the
raw field id and the tooltip is unformatted in the normal state, then flips to the proper
label/format when a cross-filter activates (ghost branch), and flips back when it clears.
The y-axes (lines 332-344) also use `resolveFieldDef`, so axis and series formatting
disagree. Additionally the two branches use different formatter options
(`buildMultiYLineSeries` passes `{compact:false, noFormatFallback:'undefined'}`; the ghost
branch uses the compact/string default) — so even for native fields, tooltip number style
changes when a ghost toggles. The bar multi-Y path uses `resolveFieldDef` everywhere
(`StudioBarChart.tsx:263-264, 307`), so this is line-family-only drift.

### 2.2 — Blended mixed chart: config matched by index against an index-filtered series array

`components/widgets/StudioChartWidget/StudioMixedChart.tsx:66` vs
`components/widgets/StudioChartWidget/useChartWidgetData.ts:245-253`

```ts
const seriesConfig = isBlended ? ySeries[index] : ySeries.find((c) => c.fieldId === s.fieldId);
```

The comment claims "aggregateBlendedSeries preserves ySeries order 1:1", but the inputs
are built with `blendSeries.flatMap((s) => { if (!s.fieldId) { return []; } … })` —
entries without a `fieldId` are dropped. Output series order equals input order
(`aggregators.ts:499-542`). So with
`ySeries = [{fieldId:'a'}, {fieldId: undefined}, {fieldId:'b', sourceId:'foreign'}]`,
`multiYData.series[1]` is field `b` but is matched to the empty config entry: wrong
`seriesType` (falls back to bar), wrong label, and wrong `sourceId` for the field-def
lookup (line 72-76). Trigger: a mixed blended chart with an incomplete series row before a
configured one — exactly the state the setup panel passes through while a user is adding
series. `StudioMixedChart.test.tsx:146` covers only the all-fieldIds case.

### 2.3 — Mixed chart never formats period-grouped x labels or series values

`components/widgets/StudioChartWidget/StudioMixedChart.tsx:153`

```ts
xAxis={[{ id: 'x', data: xAxisData, scaleType: 'band' }]}
```

No `valueFormatter` on the band axis and none on the series. With `xGroupBy` set, the axis
(and axis tooltip header) shows internal period keys (`2024-W07`, `2024-Q1`, `2024-01`)
that every other categorical chart formats via `formatLabel`/`formatPeriodLabel` (e.g.
`StudioBarChart.tsx:383`). Series values likewise ignore the field's `format`/
`currencyCode` that the same field gets in bar/line charts (the y-axes are formatted,
lines 114-147, making the tooltip/axis disagreement visible within one chart).

### 2.4 — Blended foreign rows go permanently stale when a refetch fails

`components/widgets/StudioChartWidget/useBlendedSeriesRows.ts:219-228`

```ts
promise.then(
  (result) => {
    if (live.current) {
      setAsyncForeignRows((prev) => new Map(prev).set(sid, result.rows));
    }
  },
  () => {
    /* errors leave the series empty; the primary chart still renders */
  },
);
```

The rejection comment is wrong for the refetch case: `asyncForeignRows` entries are never
invalidated when the descriptor for a `sid` changes (filters/xField/xGroupBy). On a failed
refetch the map keeps the rows from the _previous_ descriptor, so the blended series
silently renders pre-filter (or pre-regroup) numbers indefinitely while the primary series
reflects the new filters, with no error surfaced.

### 2.5 — KPI sparkline (and filter tooltip) use unscoped filters — the exact bug already fixed for the trend path

`components/widgets/StudioKpiWidget/StudioKpiWidget.tsx:523` and `841-861`

The trend path was fixed (finding 2.17 per in-code comments) to route through
`selectFiltersForWidget` before `findDateFilter`. The sparkline still does
`const dateFilter = findDateFilter(filters, widget.id, dataSource)` with the raw store
filter list, and `findDateFilter` (`kpiUtils.ts:157-177`) matches any
`scope.kind === 'page'` filter with **no pageId check, no `disabled` check, no source
check**. On a multi-page dashboard, another page's (or a disabled) date filter silently
drives the sparkline's time field and auto-granularity. `filterSubtitle` (lines 845-850)
has the same unscoped `f.scope.kind === 'page'` match, so the KPI hover tooltip lists other
pages' filters as if applied.

### 2.6 — KPI sparkline is flat zero for measure expression fields

`components/widgets/StudioKpiWidget/StudioKpiWidget.tsx:578-590`

`computeSparklineData → computeAggregate(bucketRows, config.kpiValueField!, aggregation)`
reads `row[measureId]`, which doesn't exist on rows (measures aggregate via
`evaluateMeasure`; they are never enriched per-row). Headline (line 449-453) and trend
(`computePeriodValue`, line 120) both special-case `measureExprField`; the sparkline
doesn't. Result: a KPI on a measure shows a correct headline and trend but a sparkline of
zeros (sum → `aggregateNumbers([], 'sum')` = 0 per bucket). Related minor drift: the
sparkline formatting `fieldDef` at line 839 checks `dataSource.fields` only, whereas
`useKpiValue` (line 456-457) also checks `expressionFields` — expression-field
format/currency is dropped from the sparkline tooltip.

### 2.7 — "count" aggregation counts different things in map/pivot vs KPI/chart

- Map: `components/widgets/StudioMapWidget/StudioMapWidget.tsx:225-238` — with
  `mapAggregation: 'count'` **and** a `mapValueField`, rows whose value is null/non-numeric
  are skipped (`coerceAggregateValue → null → continue`) before
  `aggregateNumbers(values,'count')`; a region whose values are all null disappears
  entirely.
- Pivot: `components/widgets/StudioPivotWidget/pivotUtils.ts:73-91` — same:
  `const v = valueField ? coerceAggregateValue(row[valueField]) : 1;` then
  `if (v === null) continue;`, so `count` with a value field excludes null-measure rows
  (the in-code comment "For count … always 1, never coerced" only holds when `valueField`
  is unset).
- KPI `computeAggregate` (`kpiUtils.ts:280-282`) returns `rows.length`; chart
  `aggregateByField` (`aggregators.ts:275`) counts every row per bucket.

The same nominal configuration ("count of X grouped by Y") over a column with nulls gives
different numbers depending on widget kind. Pick one policy (SQL `COUNT(col)` vs
`COUNT(*)`) — currently it's split down the middle.

### 2.8 — `StudioWidgetEditDialog/FilterRow` still commits an undoable doc mutation per keystroke

`components/StudioWidgetEditDialog/FilterRow.tsx:167, 175, 185`, e.g.:

```ts
onChange={(evt) => onUpdate({ value: evt.target.value })}
```

routes through `WidgetFiltersPanel.handleUpdate` → `controller.updateFilter` →
`commitDocPatch` with default `undoable: true` and a `updateFilter:${id}` log line. Typing
a 6-character value = 6 undo entries + 6 full pipeline recomputes; Ctrl+Z un-types one
character at a time. This is exactly the bug class fixed everywhere else with
buffer-then-commit-on-blur (`ConditionalFormatStringValueInput`, `SliderBoundInput`,
`AnnotationLabelInput` — each documents "finding 2.3"); this surface was missed. (The
drawer's `FilterValueInput` 150ms debounce also still lands one undo entry per typing
pause — better, but inconsistent with the fixed pattern.)

### 2.9 — `ColorInput`/`ColorSwatch` commit an undoable step per keystroke and per color-picker drag frame

`ColorInput.tsx:27-28` (`onChange={(event) => onChange(event.target.value)}`) and
`ColorSwatch.tsx:47` (native `<input type="color">`, whose React `onChange` fires
continuously while dragging the OS picker) are wired straight into
`controller.updateWidgetConfig` via `TextSectionFormat.tsx:94-99` /
`TextFormatPanel.tsx:23-24`. Typing `#ff8800` = 7 undoable commits; dragging around the
color wheel = dozens. Same missed instance of the fixed keystroke-commit class.

### 2.10 — Quick-filter bar "Clear all" is N undoable commits for one gesture

`components/StudioCanvas/StudioQuickFilterBar.tsx:152-164`:

```ts
for (const f of pageFilters) { controller.removeFilter(f.id); }
...
controller.clearCrossFilter(f.scope.sourceWidgetId);
```

`removeFilter` (`StudioController.ts:1356-1361`) and `clearCrossFilter` (`:1555-1565`)
each push an undo entry. One click on "Clear all" with 4 filters → 4+ undo steps; a single
Ctrl+Z restores only the last-removed filter. The controller has batching
(`commitMutations`) and even `clearPageFilters` for the page subset, but this path doesn't
use them.

### 2.11 — An empty page has no drop target, though the empty-state copy invites dropping

`components/StudioCanvas/StudioCanvas.tsx:549-580` returns the empty-state `Paper` early
with no `useStudioDropTarget` registration, and `StudioPageRows` (:244-246) returns `null`
for `widgetRows.length === 0` — so neither an `InsertionPoint` nor a `WidgetGap` exists.
Yet the edit-mode hint (`canvasEmptyEditModeHint`, asserted verbatim in
`StudioCanvas.emptyState.test.tsx`) says "Use the Compose panel to add widgets **or drag
them here**", and `WidgetTypeCard` registers a `DRAG_TYPE_COMPOSE_WIDGET` draggable.
Dragging a widget type onto an empty page is a dead drop. Also reproducible after deleting
the last widget of a page.

### 2.12 — `FilterRow` field switch keeps a now-invalid operator/value; drawer rows display a fallback the doc doesn't hold

- `components/StudioWidgetEditDialog/FilterRow.tsx:86-98`: the field `onChange` writes
  `{ field, filterSourceId, fieldType }` only. Switching a string-field `contains` filter
  to a number field leaves `operator: 'contains'` (not in `NUMBER_OPERATORS`) — the
  operator `Select` at :141-150 gets an out-of-range value (renders blank + MUI dev
  warning) while the engine keeps applying string-`contains` against numbers. The
  drawer's phase-1 pickers reset `operator: 'equals'` (`PageFilterRow.tsx:131-137`,
  `WidgetFilterRow.tsx:109-115`); this dialog doesn't.
- Related display/doc drift in the drawer rows: `PageFilterRow.tsx:50-56` /
  `WidgetFilterRow.tsx:64-70` compute
  `activeOperator = … ? filter.operator : operators[0].value` and render/edit
  `activeOperator`, but the doc keeps the invalid stored operator until the user touches
  the select — panel shows "Equals" while the engine applies the stored operator. This is
  the same UI-vs-doc-disagreement class that `KpiSetupPanel`'s non-undoable write-back
  repairs for `kpiAggregation` (`KpiSetupPanel.tsx:159-163`); no equivalent repair or reset
  exists here.

### 2.13 — Grid widget's own aggregation bypasses the shared `coerceAggregateValue` policy every sibling widget kind uses

`utils/gridGrouping.ts:10-42` (`aggregateGridValue`), `:55-79` (`symmetricAggregate`);
`utils/gridSummary.ts:42-44` (`computeGridSummary`). (Independently found by both the
top-level review and a sub-review.)

Both files filter values with a raw inline predicate —
`rows.map(row => row[fieldId]).filter((v): v is number => typeof v === 'number' && !Number.isNaN(v))`
— instead of routing each cell through `internals/aggregate.ts`'s `coerceAggregateValue`,
which every other numeric aggregator in the package uses (chart accumulators in
`aggregators.ts`, `pivotUtils.ts`'s `buildPivotMatrix`, and the KPI/map reducers).
`coerceAggregateValue` parses non-empty numeric strings (`"12"` → `12`) and coerces
booleans to `0`/`1`; the grid's raw `typeof v === 'number'` check does neither — it
silently excludes numeric-string and boolean cells from the aggregate entirely (not
coerces them).

Trigger: a grid widget with `gridGroupByField` set and a column aggregation (sum/avg/
min/max), or any grid's footer total (`computeGridSummary`, used regardless of grouping),
over a field whose runtime values are numeric strings — the architecture doc explicitly
documents this as the common case for CSV/JSON sources. Nothing upstream coerces these
values first: `normalizeDataSourceRows` (`temporalUtils.ts`) only normalizes date-typed
fields and builds `fieldDistinctValues` for categorical fields.

Consequence: a Grid's group-by aggregate or footer total over a numeric-string field
silently excludes those rows from `sum`/`avg`/`min`/`max` (undercounting a sum, skewing an
average's denominator), while a KPI, Chart, or Pivot widget aggregating the exact same
field on the same data source correctly parses and includes every value.

### 2.14 — `between` filter on a non-date/non-number field type can silently pass every row (reachable outside the UI)

`internals/filterUtils.ts:76-101` (`toComparable`), `:308-354` (`'between'` branch of
`compileSingleCondition`).

`toComparable`'s fallback (no `fieldType` match, and the value isn't ISO-date-shaped) is
`return Number(val)`. For a `between` filter on a `string`-typed field with non-numeric
bounds, `toComparable(range.from/to, 'string')` and `toComparable(row[field], 'string')`
all evaluate to `NaN`; every `NaN < NaN` / `NaN > NaN` comparison is `false`, so the
row-test's early-return guards never fire and the row is kept — the filter becomes a
silent no-op that matches everything.

Trigger: `filterOperatorMetadata.ts` (the UI's per-field-type operator allowlist) is
UI-only — it is not enforced by the reducer or `StudioController.addFilter`/
`updateFilter`, so a `between` operator on a `string` field is reachable via a
host-constructed `StudioFilterState`, a persisted/legacy doc, or an AI
`add_page_filter`/`update_widget` tool call that isn't validated against
`filterOperatorMetadata`.

Consequence: a malformed or AI-authored `between` filter on a non-numeric, non-date field
silently filters nothing instead of erroring or being rejected — low severity because the
normal UI path never constructs this combination, but a real latent gap in
defense-in-depth at the mutation boundary (contrast with the rank-filter and
expression-cycle guards `StudioController` does enforce for other filter/field
invariants).

### 2.15 — Open-ended `between` filters are pushed to the server as `whereBetween(col, [value, undefined])`

`server/createBatchingAdapter.ts:1104-1113`.

`leafToPredicates` converts `{ from, to }` to a tuple unconditionally:
`value = [range.from, range.to]`. The in-memory evaluator treats a missing bound as
unbounded (`filterUtils.ts:313-314`: `const from = range.from ? toComparable(...) : null`),
and `isConditionComplete` (`:365-368`) deliberately accepts a single bound
(`!!(range?.from || range?.to)`). Producers create exactly this shape:
`docTransforms.ts:56-62` builds `value = { from: args.customFrom ?? '', to: args.customTo ?? '' }`
for a custom dashboard date range with one end filled.

Trigger: a dashboard/page/widget `between` filter with only `from` or only `to` set, on an
adapter-backed source.

Consequence: the server executes `whereBetween(col, ['', '2026-01-01'])` or
`[..., undefined]` — on Postgres a type/binding error (whole widget batch entry errors),
on SQLite/MySQL a silent wrong result (`BETWEEN '' AND x` / `BETWEEN x AND NULL` ≠
open-ended). In-memory sources behave correctly, so the drift is silent.
`isLeafServerTranslatable` should treat a single-bound `between` as client-side (or emit
`gte`/`lte` instead).

### 2.16 — Null-handling / normalization drift on other pushed-down operators (`not_equals`, date `equals`, `in: []`, `count`)

`server/createBatchingAdapter.ts:1039-1049` vs `internals/filterUtils.ts`; server
`packages/x-studio-data-middleware/src/shared/predicates.ts:222-237`.

Verified divergences, each silent on adapter sources only:

1. **`not_equals`:** in-memory keeps NULL rows (`row[field] != filterVal` is true for
   null, `filterUtils.ts:200-201`). Server emits `query.where(column, '!=', value)` — SQL
   three-valued logic drops NULL rows. Same filter, different row sets.
2. **`equals`/inequalities on `date`/`datetime` fields:** in-memory normalizes both sides
   through `toComparable`/`normalizeToDate` (`filterUtils.ts:159-168`), so
   `equals '2026-07-09'` matches a timestamped value on that day. The server compares the
   raw column to the `'YYYY-MM-DD'` string — a DATETIME column never equals it (zero
   rows), and `lte '2026-07-09'` excludes that day's timestamped rows.
3. **`in` with an empty array:** in-memory condition-mode compiles to
   `filterVal.some(...)` → matches **nothing** (`filterUtils.ts:172-178`; `[]` passes
   `isConditionComplete`). The wire path pushes `{operator:'in', value: []}` and the
   middleware **drops** it on reads (`predicates.ts:226-235`) → matches **everything**.
   Exact inversion.
4. **`count` aggregation:** client chart `count` tallies rows including null measures
   (`aggregators.ts:269-292`, `aggregateByTwoFields:345-348`), while the pushed-down
   `count` becomes SQL `COUNT(column)`, which skips NULLs.

### 2.17 — `gridGrouping` min/max still uses argument-spread — `RangeError` crash on large groups

`utils/gridGrouping.ts:35-38`: `return numericValues.length > 0 ? Math.min(...numericValues) : null;`
(and `Math.max(...)`). Three sibling implementations were already converted to `reduce`
loops specifically for this (`internals/aggregate.ts:86-92`, `utils/gridSummary.ts:68-71`,
`generateInsight.ts:186-193` — each documenting the `RangeError: Maximum call stack size
exceeded` past ~125k array elements). This one was missed.

Trigger: a grouped grid where one group holds ~125k+ numeric values, with a min/max
aggregation.

Consequence: synchronous `RangeError` during render of the grid widget.

### 2.18 — `StudioRequestCache` singleton grows without bound — expired entries are never swept

`internals/StudioRequestCache.ts:69-99, 205-206`.

An entry is removed only (a) inside `get()` when _that same cacheKey_ is requested again
after TTL, (b) on `invalidateSource`, or (c) `clear()` (tests only). Every descriptor
change (each filter keystroke/tweak produces a new `cacheKey` via `buildQueryDescriptor`)
inserts a new entry holding the full `result.rows` array into the **module-level
singleton** (`export const studioRequestCache = new StudioRequestCache()`), and keys never
re-requested are never evicted.

Trigger: normal interactive filter/date-range churn against adapter sources in a
long-lived session.

Consequence: monotonic memory growth (row arrays retained), surviving even Studio unmount
because the cache is module-scoped. Needs a size cap or a sweep during `set()`.

### 2.19 — ORDER BY can reference a column that was dropped as `unresolved` — whole-batch-entry SQL error

`server/createBatchingAdapter.ts:999-1021`.

`resolveField` returns `{ column: fieldId, unresolved: true }` for fields resolvable
nowhere, and its contract says callers MUST drop this field from both SELECT and WHERE
(`:475-479`). SELECT does (`:913-916`) and filters do (`:962-971`), but the ORDER BY
emission checks only `skip`:
`orderBy: orderByColumn && !orderByColumn.skip ? [{ column: columnAliases[...] ?? orderByColumn.column, ... }] : undefined`.

Trigger: a widget whose `groupBy` (xField / gridGroupByField) is a field 2+ hops away in
the relationship graph (the same shape the `unresolved` mechanism was added for on the
filter path).

Consequence: the server query orders by a nonexistent column → "no such column" error for
that widget's result; the widget renders its error overlay even though dropping the ORDER
BY would have produced usable rows.

## Tier 3

### 3.1 — Bar "Other" bucket isn't localized (pie's is), and the click guard keys on the English literal

`components/widgets/StudioChartWidget/StudioBarChart.tsx:649, 658, 689, 830` hardcode
`'Other'`; the pie uses `localeText.chartOtherBucketLabel`
(`StudioPieChart.tsx:137`, localized in de/es/fr/ptBR). In a non-English locale the bar's
synthetic bucket renders "Other" among localized UI, the merge-with-real-"Other" logic
(line 649) won't merge with a category named e.g. "Autres", and the pie/bar pair on one
dashboard label the same bucket differently. `StudioPieChart.test.tsx:200` even pins the
localized behavior for pie.

### 3.2 — Pivot CSV rounds to 3 decimals, the table to 2

`pivotUtils.ts:159` (`Math.round(v * 1000) / 1000`) vs `PivotTable.tsx:23`
(`Math.round(v * 100) / 100`). An exported cell can differ from the on-screen cell in the
third decimal (classic for `avg`). Also null renders `—` on screen but `''` in CSV (that
part is fine); the rounding divergence is the drift.

### 3.3 — CrossFilterGhostBar mishandles negative values

`components/widgets/StudioChartWidget/CrossFilterGhostBar.tsx:62, 81`

```ts
const hasFilteredValue = filteredValue != null && filteredValue > 0;
...
const fgY = y + height - fgHeight;  // anchors at segment bottom
```

A legitimately negative filtered value (`sum` of a signed measure) is treated as
filtered-out (`> 0`), hiding the foreground bar while the tooltip says "X / Y". And for a
negative baseline bar (which grows downward from the axis), the foreground anchors at the
bar's far tip instead of the axis end, so partial fills render at the wrong end. Trigger:
cross-filter on any bar chart of a measure that can be negative.

### 3.4 — DateRangeControl can wipe in-progress typing; date slider snaps after commit

- `components/widgets/StudioFilterWidget/controls/DateRangeControl.tsx:30-35, 39-51`:
  while typing a From date, intermediate invalid states debounce-apply
  `{ from: undefined, to }`; the store round-trips, the sync effect (deps
  `[currentValue?.from, currentValue?.to]`) fires and `setFrom(null)` clears the field the
  user is mid-editing (300ms after the last keystroke).
- `components/widgets/StudioFilterWidget/StudioFilterWidget.tsx:315-327` +
  `SliderControl.tsx:25-28`: date sliders commit ms timestamps but store `'YYYY-MM-DD'`;
  the stored value re-parses to local midnight, and the sync effect snaps the handles to
  positions different from where the user released them (min/max come from raw row
  timestamps, not midnight-aligned).

### 3.5 — Horizontal bar + value annotations target the wrong axis (uncertain, not executed)

`components/widgets/StudioChartWidget/StudioChartWidget.tsx:533-541`: `ann.axis === 'y'`
always renders `<ChartsReferenceLine y={value}>`. With `barLayout: 'horizontal'` the
measure lives on the x-axis and the y-axis is a band scale, so a numeric threshold
annotation lands on (or is rejected by) the band axis instead of drawing a vertical value
line. Same for anomaly markers (`ann.axis === 'x'` category lines) in horizontal layout.
Code path confirmed to ignore `barLayout`; exact failure rendering not executed.

### 3.6 — Fieldless-count chart silently sums an empty field if a stale `ySeries[0].yAggregation` exists (uncertain / edge)

`components/widgets/StudioChartWidget/useChartWidgetData.ts:157, 236, 396`:
`isFieldlessCount` checks `config.yAggregation === 'count'`, but the aggregation actually
passed is `singleSeriesYAggregation = config.ySeries?.[0]?.yAggregation ?? config.yAggregation`.
A `ySeries` entry with `yAggregation: 'sum'` but no `fieldId` (a half-configured series
row) makes the guard pass while `aggregateByField(rows, x, '', …, 'sum')` produces
all-zero bars instead of counts. Whether the setup panel can actually persist that state
was not confirmed.

### 3.7 — Grid/KPI ignore the dashboard-level `globalCrossFilterMode` override (possibly by design)

`StudioGridWidget.tsx:239-240` and `StudioKpiWidget.tsx:769-771` derive `crossFilterMode`
from `widget.config` only, while `useWidgetRows.ts:268-271` applies
`globalCrossFilterMode ?? config…` for the row sets. The schema doc
(`stateTypes.ts:122-126`) says the override applies "for all charts", so grids/KPIs
skipping it may be intentional — but the grid's own comment says the key is "honored by
grids too", and a dashboard-wide `'none'`/`'filter'` override will change chart behavior
while grids keep dimming per their local default. Flagging as drift to confirm intent.

### 3.8 — `StudioWidgetEditDialog`: X-button skips the tab reset; stale tab index can point past the tab list

`components/StudioWidgetEditDialog/StudioWidgetEditDialog.tsx:64-67` defines
`handleClose` (resets `tab` to 0) and wires it to the Dialog `onClose` (backdrop/Esc), but
the close `IconButton` (:173-180) calls the raw `onClose`. Closing via X on the Format tab
(`tab === 2` when the Filters tab was present) and reopening for a kind with
`showFiltersTab === false` leaves `Tabs value={2}` with only indices 0-1 rendered → blank
panel + out-of-range warning.

### 3.9 — Interactive-filter undo asymmetry

`applyInteractiveFilter` / `clearInteractiveFilter` are deliberately non-undoable
(`StudioController.ts:1499, 1511-1514`, `{ undoable: false }`), but
`InteractiveFilterSection.tsx:66` removes the same filters via plain
`controller.removeFilter` — an undoable commit. Undo after clearing from the drawer
resurrects an "ephemeral" interactive filter that the widget-pill path
(`SliderFilterPill → clearInteractiveFilter`) clears without any undo entry.

### 3.10 — Saved-views `activePresetId` is component-local session state that desyncs from the doc

`StudioFiltersDrawer.tsx:82, 447-455`: applying a preset commits an undoable filter
replacement, then sets local `activePresetId`. Ctrl+Z restores the filters but the preset
chip stays "active" and `disabled` (:444-446), so it can't be re-applied; drawer
unmount/remount also forgets the active preset while the filters remain.

### 3.11 — Remaining `Date.now()`-only IDs contradict the codebase's collision-resistant-ID policy

The controller deliberately replaced ms-resolution IDs (`createWidgetId`/
`createFilterId`/`createPresetId`, see the "(2.1)" comments): still remaining are
`WidgetFiltersPanel.tsx:89` (`wf-${widgetId}-${Date.now()}` — a double-click add silently
no-ops the second filter via the reducer's duplicate-id idempotency),
`InlineFormulaBar.tsx:132` (`expr_formula_${Date.now()}`), and
`StudioExpressionFieldDialog.tsx:92` (`expr-${Date.now()}`, additionally re-evaluated on
every render, churning the `draftField`/validation memos until save).

### 3.12 — `StudioDateRangeBar` can't represent a persisted `'custom'` preset

`StudioDateRangeBar.tsx:89-95` types `activePreset` as possibly `'custom'` (a value
`setDashboardDateRange` supports and hosts/AI can set), but the `Select` (:161-177) has no
`custom` item → out-of-range value renders empty with a dev warning; `handlePresetChange`
(:136-138) treats it as a no-op.

### 3.13 — Expand capability gated on `isChart`, not `capabilities.expand`

`StudioWidgetCard.tsx:383` computes `canExpand = def?.capabilities?.expand === true` (and
gates the dialog on it), but `StudioWidgetCardActionsOverlay.tsx:372-378` and :627-633
render `ExpandAction` behind `isChart` only. Latent today (only the chart def sets
`expand: true` in `builtinWidgetDefs.ts:188`), but a custom widget declaring
`expand: true` gets a dialog implementation and no button to open it.

### 3.14 — Simple-mode `loaderRegistry` pins the first adapter's `fetchFn`/`batchDelayMs` per endpoint forever

`server/createBatchingAdapter.ts:110, 396-405`. `loaderRegistry` is module-level and keyed
by endpoint; only the first `createBatchingAdapter(endpoint)` call's `createBatchFn()`
closure (capturing its `fetchFn`, hence its auth headers) is ever stored. Recreating the
adapter with a rotated-token `fetchFn` silently keeps using the original one; entries are
never evicted. Relationship-aware mode is unaffected (dedicated loader).

### 3.15 — `useTextWidgetAI` snapshot memo misses runtime-row updates; auto-approves tool approvals

`components/widgets/StudioTextWidget/useTextWidgetAI.ts:147-154, 212-218`. The memo's
disable-comment claims "`activePage` is the reactive dependency that covers widget/data
changes", but rows live in `state.runtime.dataSources` and widget configs in
`doc.widgets` — neither changes `activePage`/`dashboard` identity, so
`setDataSourceRows`/`upsertDataSource`/sibling-widget config edits don't recompute
`snapshot`/`hash`, and the widget keeps serving the stale cached markdown until manual
`refresh()`. Separately, it blindly POSTs `approved: true` for any
`tool-approval-request` — safe only as long as the server honours the request's
`allowedTools` restriction; a server that ignores it would get mutations auto-approved
with no user in the loop.

### 3.16 — Expression evaluator internal semantics drift (mostly documented)

`utils/expressionEvaluator.ts:196-199` vs `428-431`; `316-331`. `divide`/`modulo` by zero
yields `null` in row context but `0` in measure context — a calculated column shows blank
while the same expression as a measure shows 0. Join-field enrichment indexes with raw
keys (`index.set(r[rel.targetField], r)`, `index.get(fkValue)`) while
`gridGrouping.symmetricAggregate` uses the shared `normalizeJoinKey` policy — so a
numeric-FK/string-PK pair joins in grid cross-source aggregates but yields `null` in
expression join fields. The raw-key indexing is a known documented limitation; the
_inconsistency_ with `joinKeys.ts` policy is the part worth noting.

### 3.17 — `'anomaly'` insight sampling does not actually guarantee anomaly rows

`components/StudioChatPanel/generateInsight.ts:79-97`.
`[...new Set([...strideIndices, ...anomalyIndices])].toSorted(...).slice(0, maxRows)` —
stride indices alone already number ≈`maxRows`, so anomalies located late in the dataset
are cut off by the final `slice`, despite the docstring's "guarantees anomaly rows are
included". A correct version would reserve slots for anomaly indices first.

### 3.18 — Minor `generateInsight` coercion inconsistency

`generateInsight.ts:139-144` (`aggregateRows`: `isNumeric = field?.type === 'number'`
only) vs `:209-212` (`buildNumericStats` accepts `'number' | 'integer'`). `'integer'`
isn't a member of `StudioDataField['type']`, so the second check is dead code; harmless
but drift-prone.

## Verified clean (checked, not flagged)

- The `barLayout: undefined` stale-key concern on chart-type switches is handled: the
  chart-type key validators skip `undefined`-valued keys (`configKeyValidation.ts:452-456`),
  so the delete reaches the reducer even for non-bar targets.
- Canvas drop math: the same-row rightward `adjustedColIndex` fix, horizontal
  insert-then-filter ordering, cross-page moves, and `enforceLayoutColSpans` ownership are
  all consistent; resize clamping (`RowResizeHandle`) clamps both live and committed spans
  to `leftMinSpan`/`totalSpan - rightMinSpan` symmetrically, and cancel paths never commit.
- The previously-fixed classes (buffer-on-blur numeric inputs, non-undoable self-repairs,
  single-commit source-switch folding, CSV cross-source enrichment, `updateWidget`
  wholesale-vs-patch config semantics) are correctly implemented at every site checked
  except the surfaces named in 2.8/2.9.
- Documented "preserve, don't harmonize" asymmetries (multi-Y bar ghost without
  `preserveXFieldBaseline`, multi-Y line/area `highlightedItem` no-op, single-series area
  lacking the cross-highlight tooltip formatter) are intentional and not flagged.
- The `${color}40` alpha-suffix pattern in line/pie dimming is currently unreachable (the
  `resolvedChartColors` are always hex — `blueberryTwilightPalette` returns hex literals
  and `usePageChartColors` returns `undefined`).
- Gantt category colors shifting under filter changes is cosmetic and consistent with the
  chart's own legendless design — not flagged.
- Chat/streaming correctness: SSE stream settling (`streamSettled` + `closeStream`/
  `errorStream` + finally-close, `studioBackendAdapter.ts:186-268, 476-487`),
  `StreamThreadPin` write-target pinning + mid-stream abort on thread switch
  (`useChatThreads.ts:68-89, 241-264`), per-request `activeReaders` set
  (`studioBackendAdapter.ts:165-180, 492-502`), batch id-matching via
  `widgetId::cacheKey` with the ambiguous-fallback guard
  (`createBatchingAdapter.ts:139-161`), and generation-tagged cache invalidation
  (`StudioRequestCache.ts:132-194`) are all correct.
- `applyStateMutation` validates wire mutations via `parseStateMutation` before touching
  the controller; `createWidgetFromDescription` sanitizes server configs through the
  schema key allow-lists with fail-closed chart-type handling; CSV export
  formula-injection handling in `widgetUtils.tsx:506-557` is correct including the
  numeric-cell exemption.
- Relative-date resolution is consistent client/server for top-level values
  (`leafToPredicates` and `toComparable` both route through `resolveRelativeDate` at query
  time), and relative values never appear inside `between` bounds in current producers.

## Test-coverage gaps (load-bearing, concrete failure modes)

- No test for blended mixed charts with a fieldless `ySeries` entry (2.2) — the existing
  index-matching test (`StudioMixedChart.test.tsx:146`) passes precisely because all
  entries have `fieldId`.
- No test asserting ghost/highlighted color pairing or legend de-duplication in
  color-by scatter ghost mode (1.2).
- No test that a grouped-ring pie responds to interactive filters or `'filter'`-mode
  cross-filters (1.1) — existing ring tests only cover rendering and ghost dimming.
