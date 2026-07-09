# Architecture / tech-debt review — `@mui/x-studio`

Independent, adversarial review of `packages/x-studio/src/`, covering the current working tree.
Full reads: the state layer (`store/StudioController.ts`, `store/docTransforms.ts`,
`internals/rankFilterScope.ts`, `context/selectors.ts`, `context/StudioContext.tsx`), the data
pipeline (`internals/StudioPipeline.ts`, `enrichedRowsCache.ts`, `resolvedRowsCache.ts`,
`StudioRequestCache.ts`, `filterScoping.ts`, `filterUtils.ts`, `dataSourceGraph.ts`,
`useWidgetRows.ts`, `useAdapterRows.ts`, `queryDescriptor.ts`, `internals/aggregate.ts`,
`internals/aggregators.ts`, `utils/expressionEvaluator.ts`), `server/createBatchingAdapter.ts`
cross-checked against `x-studio-data-middleware`'s predicate builder, and `Studio.tsx` /
`StudioContent.tsx` / `StudioContext.tsx`. The chat panel (`components/StudioChatPanel/**`), the
full chart-widget stack (`components/widgets/StudioChartWidget/**` + `internals/chartAggregation.ts`,
`chartSupport.ts`, `chartTypeRegistry.ts`, `chartShapes/**`), the remaining widgets
(`StudioGridWidget`, `StudioKpiWidget`, `StudioMapWidget`, `StudioPivotWidget`, `StudioTextWidget`,
`StudioFilterWidget`), and the compose/filters/canvas/card UI layer
(`StudioComposeDrawer/**`, `StudioFiltersDrawer/**`, `StudioCanvas/**`, `StudioWidgetCard/**`,
`StudioDataDrawer/**`, `StudioExpressionFieldDialog/**`, `StudioWidgetEditDialog/**`) were each
read end-to-end by a dedicated sub-review; every finding below that originated from a sub-review
was independently spot-checked against the source in this pass (file existence, exact line
numbers, and the specific defect mechanism) before being included. Locale completeness was
checked programmatically (AST diff of every locale file's exported object against
`internals/localeText.ts`'s `DEFAULT_STUDIO_LOCALE_TEXT`).

**Verification:** `tsc -p packages/x-studio/tsconfig.json` is clean (exit 0). The full x-studio
vitest project is green: **130 test files, 2115 tests passing**, 0 failures. Every Tier 1 finding
below was traced to the exact defect mechanism in the current source (not inferred from a comment)
— several were additionally confirmed by direct execution (the `Math.min(...values)` crash was
reproduced with a scratch Node script; the CSV grouping-separator corruption is actually asserted,
unquoted, by the package's own existing unit test).

---

## Tier 1: Correctness & Security

### 1.1 Independent per-series Y-axis is dead on file: `yAxisKey` is not an x-charts prop

- `components/widgets/StudioChartWidget/StudioBarChart.tsx:328`
- `components/widgets/StudioChartWidget/StudioLineAreaChart.tsx:344,367`
- `components/widgets/StudioChartWidget/lineSeries.ts:39`

All four sites set `yAxisKey: useIndependentAxes ? \`y-${i}\` : undefined`on the series object.
The actual`@mui/x-charts`series model only recognizes`yAxisId`
(`packages/x-charts/src/models/seriesType/common.ts:78`; confirmed no occurrence of `yAxisKey`anywhere under`packages/x-charts\*`). `StudioMixedChart.tsx:85,94`uses the correct`yAxisId` and
proves the drift is local to these three files. Every series in the "independent axes" mode
therefore silently binds to the default first axis; the second (`y-1`, `position: 'right'`) axis
renders with no bound series, so dual/independent Y-axis scaling — a documented, user-facing
feature of multi-Y and split-by bar/line charts — never actually activates. Existing unit tests
mock the chart component and assert `yAxisKey` pass-through (`StudioBarChart.test.tsx:44,172`,
`lineSeries.test.ts:32-33`), so they lock the typo in rather than catch it.

**Fix:** rename `yAxisKey` → `yAxisId` at all four sites.

### 1.2 Grid CSV export: unescaped numeric grouping separators corrupt row structure

- `internals/widgetUtils.tsx:519-529` (`buildCsvContent`)
- `internals/numberFormat.ts:95-121` (`formatNumber`, default `Intl.NumberFormat` grouping)
- Own test: `internals/widgetUtils.test.ts:492` — `expect(value).toContain('1,234.50')`, asserted
  against an **unquoted** CSV line.

Numeric cells are deliberately excluded from `escapeCsvCell` (`widgetUtils.tsx:525-527`) so a
literal `-5` isn't corrupted into `'-5`. But `formatFieldValue` (`numberFormat.ts:124-135`) routes
every `number`-typed field through `Intl.NumberFormat`, whose default `useGrouping: true` inserts
thousands separators — `1234.5` becomes `1,234.50` (or `1.234,50` under a European locale). That
comma is emitted **unquoted**, splitting the CSV row into an extra column and shifting every
subsequent field one column to the right for that row. This is the grid export path used by
`runWidgetExport` (`components/StudioWidgetCard/widgetExport.ts:45-57`) — the primary user-facing
CSV download. The package's own test encodes the broken behavior rather than catching it.

**Fix:** quote numeric cells too (quoting, unlike the `'` prefix, does not corrupt a numeric
value), or format numeric CSV cells with `useGrouping: false`.

### 1.3 CSV formula-injection guard trusts declared field type, not the runtime value

- `internals/widgetUtils.tsx:522-527`
- `internals/numberFormat.ts:124-135` (`formatFieldValue`)

The decision to skip `escapeCsvCell` is gated on `field?.type === 'number'` (the column's declared
schema type), not on the actual value being numeric. `formatFieldValue` only applies
`Intl.NumberFormat` when `typeof value === 'number'`; for any other runtime value in a
number-typed column (dirty ingested data, a misbehaving custom adapter returning strings) it falls
through to `String(value)` and `buildCsvContent` emits that string **unescaped**. A row whose
"number" column happens to hold the string `=HYPERLINK("http://evil","x")` is exported as a live,
unneutralized spreadsheet formula — exactly the CSV formula-injection class `csvUtils.ts` was
introduced to close (its own header comment cites "review finding 1.8"). The guard should test
`typeof value === 'number'`, matching `formatFieldValue`'s own runtime check.

### 1.4 Shared aggregation policy is not actually shared: three call sites bypass `coerceAggregateValue`

`internals/aggregate.ts`'s own header comment states the module exists specifically because five
independent reducers used to diverge on "null / boolean / NaN handling," and that all five now
"route through the single null-skip + boolean-coercion policy." In the current tree, three
callers still bypass that policy and hand-roll their own coercion immediately before feeding the
shared accumulator/reducer, silently reproducing the exact bug class the module documents fixing:

- `components/widgets/StudioPivotWidget/pivotUtils.ts:58`: `const v = valueField ? Number(row[valueField] ?? 0) : 1;` — `null`/`undefined` become `0` (inflating `avg` denominators, dragging `min` toward 0, inflating `count`), and any non-numeric string becomes `NaN`, which then poisons the shared accumulator's `sum` (`acc.sum += NaN`) for that cell, its row total, its column total, **and the grand total**.
- `components/widgets/StudioMapWidget/StudioMapWidget.tsx:217`: `parseFloat(String(rawValue ?? 0))` — same null→0 coercion; a boolean value goes through `parseFloat("true")` → `NaN` → silently dropped, whereas the KPI reference path (`coerceAggregateValue`) coerces booleans to `0`/`1`.
- `internals/aggregators.ts:273,333,426` (`aggregateByField`, `aggregateByTwoFields`, `aggregateMultipleSeries` — the in-memory chart aggregation path): `Number(row[yField] ?? 0)`, same null→0 coercion, and rows are still counted even when the value is null.

Net effect: `avg` of `[10, null, 20]` over the same data source renders `10` on a chart or map
widget but `15` on a KPI widget (which does skip nulls via `coerceAggregateValue`) and on a
server-pushed-down `AVG()` aggregation — three different numbers for the same logical measure
depending only on which widget kind renders it.

### 1.5 `aggregateNumbers` min/max crash with `RangeError` on large datasets

`internals/aggregate.ts:74-76`:

```ts
case 'min':
  return Math.min(...values);
case 'max':
  return Math.max(...values);
```

Reproduced directly: `Math.min(...new Array(150_000).fill(1))` throws
`RangeError: Maximum call stack size exceeded` in this Node 22 runtime (the threshold is
environment-dependent but comfortably inside real dataset sizes — `StudioGridWidget.tsx` itself
references sources with hundreds of thousands of rows). `computeAggregate` in
`StudioKpiWidget/kpiUtils.ts` and the map widget's `aggregateValues` both funnel their full
filtered value array through `aggregateNumbers`, so a KPI or map widget configured with `min` or
`max` over a sufficiently large source throws inside a render-phase computation and crashes the
widget (React error boundary permitting, the whole dashboard). Compare
`utils/gridSummary.ts:68-71`, which already correctly reduces with a loop instead of a spread.

**Fix:** replace both branches with a `for`/`reduce` loop.

### 1.6 Adapter/database-backed sources: three independent filter-translation bugs silently change query semantics

`server/createBatchingAdapter.ts` translates a widget's `StudioFilterState` into the wire format
consumed by `@mui/x-studio-data-middleware`. Three distinct defects there mean a filter that
behaves correctly against in-memory data silently behaves differently — or not at all — once the
same data source is backed by an adapter/SQL endpoint:

- **`conjunction: 'or'` is never read, so OR becomes AND.** `queryDescriptor.ts:25` copies `f.conjunction` onto the outgoing `StudioFilterNode` leaf, but `flattenFilterNode` (`createBatchingAdapter.ts:945-978`) never reads `node.conjunction` — it unconditionally pushes both the primary condition and the `op2` condition into the same flat predicate array, which `x-studio-data-middleware`'s query builder ANDs together (per the function's own doc comment: "Group nodes are flattened (AND logic only …)"). A two-condition filter meant as `value < 10 OR value > 100` is silently sent as `value < 10 AND value > 100` — a predicate that matches nothing.
- **`contains` maps to a wildcard-less `LIKE`.** `createBatchingAdapter.ts:924-938` (`OPERATOR_MAP`) maps `contains` → `'like'`, and `x-studio-data-middleware/src/shared/predicates.ts:227-230` executes it as `query.whereLike(column, value)` with the raw value — no `%value%` wrapping is ever applied on either side. A "contains" filter against an adapter-backed source therefore degrades to an exact-match `LIKE`, silently narrowing (or entirely missing) matches that the same filter would correctly find in-memory (`filterUtils.ts`'s `compileSingleCondition` correctly does a substring `.includes()`).
- **Several operators are silently dropped, with no client-side fallback.** `OPERATOR_MAP` has no entry for `not_in`, `does_not_contain`, `starts_with`, `not_starts_with`, `ends_with`, `not_ends_with`, `is_empty`, or `is_not_empty`; `mapOperator` returns `null` for all of them and `flattenFilterNode` drops the predicate entirely (`createBatchingAdapter.ts:949-951`). Critically, `useWidgetRows.computeFilteredRows`'s adapter branch (`internals/useWidgetRows.ts:317-353`) only re-applies **cross-filter and interactive** filters client-side — page/widget filters are explicitly assumed to already be "baked into descriptor.filter by the adapter" (comment at lines 320-326) and are never re-checked. So a page- or widget-scoped filter using any of these eight operators against an adapter-backed source is enforced **nowhere**: not on the server (predicate dropped) and not on the client (page/widget filters aren't re-applied). Rows that should be excluded are shown.

### 1.7 Applying the same saved filter preset to two pages creates ID-colliding filters — editing one silently mutates or deletes the other

- `store/docTransforms.ts:196-206` (`saveFilterPreset`): preset filters are stored with a fixed id `\`${presetId}-${originalFilterId}\``.
- `store/docTransforms.ts:214-235` (`applyFilterPreset`): re-materializes the preset's filters onto the active page **using those same fixed ids**, differing only in `scope.pageId`.

Apply preset P to page A, then switch to page B and apply the same preset P: `doc.filters` now
contains two entries with the identical `id` (`P-f1`), one scoped to page A and one to page B.
`StudioController.toggleFilter`/`updateFilter` build their next array with `mapPreservingIdentity`
keyed on `f.id === filterId` (`StudioController.ts:1122-1180`), and `removeFilter` delegates to the
reducer's `filters.filter((f) => f.id !== filterId)` — both operate on **every** matching id, not
just one. So toggling, editing, or removing "the preset filter" while viewing page A silently
toggles/edits/removes page B's supposedly-independent copy of the same preset too.

**Fix:** mint a fresh collision-resistant id per re-materialization in `applyFilterPreset` (mirror
the collision-resistant `createFilterId()` pattern used elsewhere), rather than reusing the
preset-baked id.

### 1.8 AI chat: every streamed token write pushes an undo entry, flooding and evicting the user's real undo history

`components/StudioChatPanel/useChatThreads.ts:96,117,137` call `controller.setState({ ...state, doc: { ...state.doc, ai: { ... } } })`
directly on every `onMessagesChange` callback. `StudioController.setState` (`store/StudioController.ts:452-454`)
delegates to `commitState` with no options, so `undoable` defaults to `true`
(`StudioController.ts:134`); because a fresh `doc` object is constructed on every call,
`nextState.doc !== current.doc` is always true, so `commitState` (`StudioController.ts:145-157`)
unconditionally pushes an undo entry and clears the redo stack. `@mui/x-chat`'s streaming layer
flushes text deltas roughly every 16ms and fires `onMessagesChange` on each store change, so a
single multi-second AI response can push hundreds of undo snapshots — comfortably exceeding
`MAX_UNDO_HISTORY = 100` (`StudioController.ts:62`) and silently evicting every real
document-editing undo entry the user had accumulated. After an AI reply, Ctrl+Z no longer reaches
the user's actual edits; it steps through stale partial-message chat snapshots instead, and the
dashboard edits are unrecoverable via undo.

**Fix:** route chat-thread writes through a non-undoable commit path (mirroring how `runtime`/
`session`-only patches are already committed with `undoable: false` elsewhere in the controller).

### 1.9 Grid `getRowId` fallback is defeated by spread ordering when a row's `id` field is null/undefined

`components/widgets/StudioGridWidget/StudioGridWidget.tsx:264-268`:

```ts
return baseRows.map((row, index) => ({
  id: row.id ?? `${widget.id}-${index}`,
  ...row,
  ...
```

The synthetic-id fallback is placed _before_ `...row` is spread. For any row that has an `id`
**property** whose value is `null`/`undefined` (a nullable database id column is a realistic,
common case — precisely the scenario the `??` fallback was written to handle), `...row`
overwrites the computed `id` back to `null`/`undefined`. Every such row then resolves to the same
DataGrid row id, and DataGridPremium throws/misbehaves on duplicate ids.

**Fix:** spread `row` first, then set `id` last so the fallback always wins when `row.id` is
nullish.

### 1.10 `between` operator is exposed on every applicable field but no value editor can produce or preserve its value

- `components/StudioFiltersDrawer/filterOperatorMetadata.ts:47,59,71` lists `between` for
  number/date/datetime fields on both the filters-drawer and widget-edit-dialog operator pickers.
- `components/StudioWidgetEditDialog/FilterRow.tsx:144-152` renders a plain `TextField` bound to
  `String(filter.value)` for every operator including `between`. A `between` filter's `value` is
  always a `{ from, to }` object (produced by chart-click cross-filters, AI mutations, or
  `docTransforms.buildDateRangeFilter`) — `String({from,to})` renders literally as
  `[object Object]`, and the first keystroke in that field replaces the object with a plain
  string, silently turning the filter into a value that matches nothing (or, depending on the
  operator's implementation, everything).
- `components/StudioFiltersDrawer/FilterValueInput.tsx:22,99-108` has the same
  `String(value ?? '')` fallback for the numeric case; the date case routes to a single-date
  picker, which likewise cannot express or preserve a range.

The operator is offered dashboard-wide, but the moment a user (or an upstream automated process)
produces a `between` filter and it is displayed in either surface, opening/touching that filter
corrupts it.

### 1.11 KPI weekly sparkline buckets sort out of chronological order

`components/widgets/StudioKpiWidget/kpiUtils.ts:260-264` builds the weekly bucket key as
`` `${year}-W${day}-${month}` `` — day-of-month embedded **before** month — and
`computeSparklineData` (`kpiUtils.ts:303`) sorts buckets with a plain lexicographic `.sort()`.
Example: the week of Monday 2026-01-26 keys as `2026-W26-01`; the week of Monday 2026-02-02 keys
as `2026-W02-02`. Lexicographically, `"2026-W02-02"` sorts **before** `"2026-W26-01"`, so the
February week renders before the January week. Weekly sparklines therefore render points and
`kpiSparklineCumulative` running totals in the wrong order whenever a month boundary falls near
the middle of the calendar (days 10-31). Week granularity is the auto-selected default for
14-90 day date-filter ranges (`autoGranularity`, `kpiUtils.ts:23-25`), so this affects a common,
default configuration, not an edge case. The existing test (`kpiUtils.test.ts:303-317`) only
asserts same-week key equality and never exercises cross-month ordering.

### 1.12 Per-series `yAggregation` is threaded on two of four chart render paths, not all four

`components/widgets/StudioChartWidget/useChartWidgetData.ts:329-368` (`chartData`, the
single-series path) and `:237-275` (`seriesFieldData`, the split-by path) both aggregate using
only `config.yAggregation`, ignoring `ySeries[0].yAggregation`. The server/adapter push-down side
deliberately gives the per-series aggregation function precedence over the widget-level default
(`internals/chartTypeRegistry.ts:93-116`, whose own comment names this exact scenario: "ySeries
with avg while yField still says sum"), and the multi-Y client path was already fixed to honor it
per-field (`aggregateMultipleSeries`'s `yAggregation` map, `internals/aggregators.ts:380-405`, its
own comment citing "finding 1.4"). The single-series and split-by paths were missed, so the same
widget aggregates with the per-series function against an adapter/SQL source but with the
widget-level default against an in-memory source — a live regression of the exact class of bug
the multi-Y fix was written to close.

### 1.13 Rank filter on a numeric split-by field crashes the chart

`internals/aggregators.ts:126-151` (`applyRankToSeriesFieldData`): `keepNames` is built from
`data.seriesNames`, whose values may be genuine `number`s (`toXValue`, `internals/chartValues.ts:38`
preserves numeric split-by values as numbers). But the subsequent filter reads keys off
`Object.entries(data.seriesData)`, whose keys are always **strings** (JS object key coercion), and
tests membership with `keepNames.has(name as string | number)` — a strict-equality `Set` lookup
that misses a numeric `2024` against a string `"2024"`. The series id survives in the returned
`seriesNames` array but its corresponding `seriesData` entry is silently dropped; the consuming
renderers (`StudioBarChart.tsx:460-461`, `StudioLineAreaChart.tsx:224-226`) then throw a
`TypeError` reading properties of `undefined`. Repro: any chart with a numeric split-by field
(e.g. a year column) and a series-level rank filter applied.

### 1.14 Numeric-input keystroke-loss pattern is still present in five setup-panel inputs

A previous round of fixes closed this exact bug class for the grid-height input (buffer local
state, commit/clamp on blur). The same defect — parsing and validating on every keystroke against
a committed doc value, so any intermediate typing state ("`0.`", "`-`", a value that transiently
violates a bound, or an empty field) is silently rejected and the input snaps back — remains live
in at least:

- `components/StudioComposeDrawer/ChartSetupPanel/GaugeConfigSection.tsx:63-95` — min is rejected whenever `parsed >= gaugeMax`; with a small committed max, a larger min literally cannot be typed one keystroke at a time, and neither field can be cleared.
- `components/StudioComposeDrawer/GridConditionalFormatSection.tsx:130-145` — `Number(raw)` per keystroke; "`0.`" collapses to "`0`" (decimal point eaten), "`-`" commits `undefined`.
- `components/StudioExpressionFieldDialog/ExpressionNodeEditor.tsx:356-366` — numeric literal input; browser `badInput` collapses an in-progress `""`/`"-"` to a committed `0`.
- `components/StudioComposeDrawer/KpiSparklineOptions.tsx:190-204` — gauge max rejects anything not `> 0`, so the field can never be cleared and retyped.
- `components/StudioComposeDrawer/ChartSetupPanel/AnnotationsEditorSection.tsx:87-101` — "`10.`" parses to `10` and re-renders "`10`", eating the decimal mid-typing.

The already-fixed pattern (local buffer + commit-on-blur, as in `FormatPanel.tsx:104-192`, or
debounced local state as in `StudioFiltersDrawer/FilterValueInput.tsx:24-48`) was never migrated
to these five inputs.

---

## Tier 2: Design smells

### 2.1 Map setup panel offers non-numeric expression fields as numeric "Value field" options, and its aggregation-lock UI diverges from its renderer

`components/StudioComposeDrawer/MapSetupPanel.tsx:116-132` builds its numeric-field list by
including **every** non-hidden expression field with a hard-coded `type: 'number'`, with no check
against the field's actual declared type — unlike the sibling `allStringFields` memo two dozen
lines above it (lines 72-88), which does check `ef.type !== 'string'`. Picking a string-typed
expression field as the map's value field routes into `StudioMapWidget.tsx:217`'s `parseFloat`,
which returns `NaN` for every row and silently renders a blank map with no error surfaced.
Separately, `MapSetupPanel.tsx:207-231` shows a locked "Count" label whenever `mapValueField` is
empty, but clearing the value field doesn't reset `mapAggregation` — so `StudioMapWidget.tsx:113,
216,230` keeps applying the stale `avg`/`min`/`max` aggregation to synthetic per-row `1`s, showing
a constant `1` for every region while the panel claims "Count." The KPI setup panel handles this
exact transition correctly (`KpiSetupPanel.tsx:151-155,256-260`); the map panel was never brought
in line with it.

### 2.2 Source-switch gestures split "pick field" + "adopt its source" into two separate undo steps

`KpiSetupPanel.tsx:256-260,294-302`, `ChartSetupPanel.tsx:429-435`,
`ChartSetupPanel/GaugeConfigSection.tsx:32-36`, and `StudioFiltersDrawer`'s widget filter panel
(`FilterSetupPanel.tsx:100-107`) each call `updateWidget`/`updateWidgetConfig` twice for what is a
single user gesture (choosing a field from a different data source). `StudioController` already
provides `commitMutations` (`store/StudioController.ts:428-450`) specifically to fold a
multi-mutation gesture into one undo step, and `MapSetupPanel.tsx:151-157` demonstrates the
correct single-commit pattern for the identical adopt-source flow. Because these five sites don't
use it, a single Ctrl+Z after switching source-and-field lands on a torn intermediate state (old
field/config, but the already-adopted new `sourceId`) that the UI never actually produced.

### 2.3 The widget-edit-dialog filter editor is a parallel, already-diverged reimplementation of the filters drawer's

`StudioWidgetEditDialog/FilterRow.tsx` duplicates `StudioFiltersDrawer/FilterBody.tsx` +
`FilterValueInput.tsx` at a much lower fidelity: no debounce (every keystroke drives a full
pipeline recompute via `controller.updateFilter`), no date picker, no relative-date support, no
selection/rank modes, no second condition — and, per finding 1.10, no working `between` value
editor. Only the operator metadata list (`filterOperatorMetadata.ts`) is genuinely shared; every
other piece of filter-editing behavior can (and, per 1.10, already has) drifted between the two
surfaces.

### 2.4 Chart renderer duplication: the exact shape of finding 1.1/1.12's drift

`totals100` (100%-stacked) normalization is hand-rolled independently at
`StudioBarChart.tsx:256-263,431-438`, `StudioLineAreaChart.tsx:193-200`, and `lineSeries.ts:13-20`;
the associated percent-tooltip formatters are reimplemented roughly six times; `isStacked`
derivation appears three times. `StudioLineAreaChart.tsx:547-551` re-implements
`makeAxisClickHandler` inline and `:553-561` re-declares `CHART_LEGEND_SLOT_PROPS` verbatim, both
already imported at the top of the same file. This duplication is precisely the mechanism by which
findings 1.1 (`yAxisKey` fixed on none of three near-identical sites uniformly) and 1.12
(`yAggregation` threaded on two of four near-identical paths) happen and will keep happening.

### 2.5 `chartTypeDefs`'s "support guard" doesn't actually cover the non-xy chart families it's applied to

`chartTypeDefs.tsx:740-763` marks heatmap/funnel/sankey/gantt as running through the shared
support guard, but `analyzeChartSupport` (`internals/chartSupport.ts:155-199`) only inspects
`xField`/`yFields`/`seriesField` (plus scatter-specific fields) — it never looks at
`heatYField`, `sankeyTargetField`, `funnelReachedField`, or any `gantt*` field, so those renderers'
real inputs are never grain-resolved or validated by the guard they're nominally wired through. The
guard is misleading rather than protective for exactly the chart types it was extended to cover.

### 2.6 Tool-call arguments never render in the chat panel — a chunk-type mismatch with `@mui/x-chat`

`components/StudioChatPanel/studioBackendAdapter.ts:361-372` emits a `tool-input-start` followed by
one `tool-input-delta` carrying `JSON.stringify(toolInput)`, but never emits a
`tool-input-available` chunk. `@mui/x-chat`'s stream processor discards `tool-input-delta` text
entirely (it only advances the invocation to `input-streaming` state), so `toolInvocation.input`
stays `undefined` and the tool card's input section never renders — every non-approval tool call
shows a name and status but never its arguments. Approval-request tool calls are unaffected (they
forward `input` through a different, correctly-handled field).

### 2.7 `generateInsight.ts` no longer generates insights

The 688-line file exports only `buildWidgetDataSummary` and `numericStats`; there is no remaining
insight-generation logic in it, and nothing in the client currently calls the `/insight`/`/title`
endpoints its neighbor `studioBackendAdapter.ts:33-36` still documents in `StudioAIConfig`. The
file name and the config's stale endpoint list should be reconciled with what the code actually
does.

### 2.8 Hand-rolled field-catalog assembly keeps reappearing despite a sanctioned shared helper

`internals/fieldCatalog.ts` (`buildFieldCatalog`/`buildSourceFieldEntries`) is already used by the
Chart/KPI/Grid/Pivot setup panels, but `MapSetupPanel.tsx:52-134` (two ~40-line near-duplicate
blocks — the exact code that produced finding 2.1), `KpiSparklineOptions.tsx:54-101`, and
`StudioFiltersDrawer/WidgetFiltersPanel.tsx:38-73` each independently re-derive
source/related-source field lists by hand, with slightly different hidden/type/direction rules
each time.

---

## Tier 3: Minor/cosmetic

### 3.1 All four shipped translations are missing the same 97 of 851 locale keys

Every non-English locale file (`locales/fr.ts`, `locales/es.ts`, `locales/de.ts`,
`locales/ptBR.ts`) is missing exactly the same 97 keys relative to
`internals/localeText.ts`'s `DEFAULT_STUDIO_LOCALE_TEXT` (verified via AST diff, not a
substring grep). The missing set spans a coherent, feature-shaped set of recent additions: funnel
and Sankey chart setup labels (`chartSetupFunnelLabelFormatLabel`, `chartSetupSankeySourceLabel`,
etc.), calendar-year/quarter date-range presets, cross-filter-bar mode labels, several
accessibility strings (`canvasResizeColumnsAriaLabel`, `sidebarPanelOpenedAnnouncement`,
`ganttChartAriaLabel`, `mapChartAriaLabel`, and a dozen more `*AriaLabel`/`*Announcement` keys),
and KPI trend labels (`kpiTrendFavorableLabel` et al.). Any consumer using a non-default
`localeText` sees English fallback text for all of these — including every screen-reader-only
string, which is an accessibility regression on top of an i18n gap.

### 3.2 Missing i18n despite an established `localeText` system, spread across many files

Representative, non-exhaustive sample (all confirmed hardcoded English in files that otherwise use
`localeText`/`useStudioLocaleText` for adjacent strings): `pivotUtils.ts:119,135` ("Total" in CSV
export, while `PivotTable.tsx:89` uses `localeText.pivotTotalLabel`); tool-card titles in
`chatToolRenderers.tsx:56-84` (`STUDIO_TOOL_LABELS`); "Thinking…"/"Reasoning"
(`StudioReasoningPart.tsx:27,61`); "Stop generating"/"Send message"
(`StudioSendButton.tsx:81`); `WIDGET_TYPES` labels/descriptions (`internals/widgetUtils.tsx:45-93`);
built-in geography labels/hints (`StudioMapWidget/geographyLoaders.ts:147-169`); `MONTH_ABBR`
(`kpiUtils.ts:321-345`, English-only immediately next to a locale-aware sibling function);
`"is empty"`/`"is not empty"` inside an otherwise-localized summarizer
(`filterDrawerUtils.ts:243-247`); and the `"(filtered out)"` / `"Other"` bucket / `"(blank)"` /
`"(empty)"` chart-tooltip literals scattered across `chartWidgetHelpers.ts:227,247`,
`StudioBarChart.tsx:625,634`, `StudioPieChart.tsx:356-366`, `useChartWidgetData.ts:569`, and
`internals/chartValues.ts:33`.

### 3.3 Duplicated CSV-download plumbing

`pivotUtils.ts:141-151` (`downloadCsv`) and `internals/widgetUtils.tsx:546-557`
(`exportGridToCsv`'s blob/anchor block) are near-line-for-line the same
Blob/`createObjectURL`/anchor-click dance, with inconsistent filename sanitization (the grid path
strips non-alphanumeric characters from the filename; the pivot path does not sanitize
`widget.title` at all).

### 3.4 Pivot axis categories sort lexicographically

`pivotUtils.ts:90-91` sorts row/column category strings with the default string comparator, so
numeric-looking categories order as `"10" < "2"`.

### 3.5 Conditional-format numeric rules match empty cells

`components/widgets/StudioGridWidget/StudioGridWidget.tsx:97-104`: `Number(null)` coerces to `0`,
so a `less_than 5` conditional-format rule highlights genuinely empty cells as if they held `0`,
rather than excluding them the way an `is_empty` rule would.

### 3.6 `useTextWidgetAI` cache: dead field, unbounded growth

`useTextWidgetAI.ts:16-19,47`: `CacheEntry.hash` is written on every entry but never read back (the
hash value is already embedded in the cache key itself), and per-hash `localStorage` entries
accumulate indefinitely with no eviction policy.

### 3.7 Dead code and stale comments (grab-bag, each independently confirmed in-file)

- `SliderControl.tsx:30,50-55`: `isActive` is computed and then `void`-discarded; the adjacent comment claims it conditionally attaches `data-no-drag`, but that attribute is set unconditionally two lines later.
- `widgetInsightPrompts.ts:3,20-24`: the `'correlation'` insight type (and its `default:` switch arm) is unreachable — only `summary`/`analysis`/`forecast` are ever offered by `StudioWidgetCardActionsOverlay.tsx:319-321`; only tests exercise the dead branch.
- `ChartSetupPanel.tsx:282-291`: an initializer and its trailing `else` branch assign the identical value.
- `StudioExpressionFieldDialog.tsx:92`: `fieldId = existingField?.id ?? \`expr-${Date.now()}\`` is recomputed on every render even though it's a save-time value, needlessly invalidating memoized derived state each render (perf-only, no correctness impact).
- `studioBackendAdapter.ts:140-141`: a comment claims a skill's `execute` function is "stripped by the caller," but the very next line performs the stripping itself.
- `internals/aggregate.ts`'s own header comment ("all five now route through the single … policy") is contradicted by finding 1.4 — the three remaining bypasses should either be fixed or the comment scoped down to what it actually covers.
- `server/createBatchingAdapter.ts:943-944`: the "OR groups are skipped server-side … which is safe/conservative" comment describes the group-node case; per finding 1.6 the more consequential bug (leaf-level `conjunction: 'or'` silently becoming AND) isn't mentioned or handled at all, so the comment overstates how conservative the actual behavior is.

---

## Summary

**Tier 1 (Correctness & Security): 14 findings.**
**Tier 2 (Design smells): 8 findings.**
**Tier 3 (Minor/cosmetic): 7 findings.**
