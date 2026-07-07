# Architecture Review — `packages/x-studio`

Independent, unbiased review of the current source, done as two parallel passes (UI/component
layer and internals/state layer) and merged here. Every claim in both passes was verified against
the current source at review time; file:line references reflect the tree as reviewed.

## Top findings across both layers (quick triage)

1. **Grid `crossFilterField` emits the wrong value** (UI 1.1, `StudioGridWidget.tsx:277-291`) —
   clicking any column other than the configured cross-filter field applies a filter using that
   other column's clicked value against the configured field, silently blanking every downstream
   widget. Existing test only exercises the one column where the bug is invisible.
2. **Transient doc writes leak through undo/redo** (Internals 1.1, `StudioController.ts:112-136`
   - related) — `{ undoable: false }` doc commits (interactive-filter selection, cross-filter mode
     toggles) don't clear the redo stack and can be silently reverted/resurrected by unrelated
     undo/redo steps, violating the doc/session/runtime partition's own "never undoable" contract.
3. **`resolvedRowsCache` permanently stale when a cross-filter's foreign source loads late**
   (Internals 1.2, `resolvedRowsCache.ts:216-224`) — the fallback dependency-recording path that
   exists specifically to handle "foreign source has no rows yet" is itself guarded by `if (foreignRows)`,
   so it records nothing in exactly the case it claims to cover.
4. **Bar-chart cross-filter highlight/ghost indices misalign after category grouping** (UI 1.2,
   `StudioBarChart.tsx:736-814`) — selection/ghost arrays are computed before the empty-label
   filter and `barMaxCategories` "Other" grouping shift indices; pie has the equivalent guard
   (`StudioPieChart.tsx:372`), bar doesn't.
5. **Adapter-path cross-filter baseline is unrecoverable** (Internals 1.3, `queryDescriptor.ts:201-205`)
   — server-backed widgets bake cross/interactive filters into the query descriptor itself, so the
   "no-cross" ghost baseline the UI needs is already pre-filtered server-side; cross-highlight mode
   silently degrades to hard-filter mode for every adapter-backed source.

---

# Part A — UI / Component Layer (`src/components/`)

**Security preamble:** no XSS surface was found. The only markdown renderers
(`widgets/StudioTextWidget/renderMarkdown.tsx`, used for both user- and AI-authored text) use
`markdown-to-jsx` with `disableParsingRawHTML: true` plus a URL-protocol allowlist sanitizer, and
there is no `dangerouslySetInnerHTML` / `innerHTML` / `eval` anywhere under `components/`.

## Tier 1: Correctness & Security

### 1.1 Grid `crossFilterField` applies the wrong _value_ when any other column is clicked

- **Files:** `src/components/widgets/StudioGridWidget/StudioGridWidget.tsx:277-291`;
  intended semantics in `src/internals/StudioUIConfigContext.ts:1659-1660`
  ("Field applied to other widgets **when a row is selected**; defaults to the first visible column").
- **Failure scenario:** configure `crossFilterField: 'country'` on a grid, then click a cell in the
  `revenue` column. `handleCellClick` does
  `const fieldId = widget.config.crossFilterField ?? params.field; const value = params.value;` —
  so it emits a cross-filter of `country = 1834.50` (the revenue cell's value). Every other widget
  on the page filters to zero rows. The toggle-off branch also can't match, so a second click
  re-applies another nonsense filter instead of clearing.
- **Why untested:** `StudioGridWidget.crossFilter.test.tsx` only ever clicks cells **in** the
  configured `crossFilterField` column (`label`), where cell value and remapped field coincide.
- **Fix sketch:** when `crossFilterField` is set, read the value from the clicked **row**:
  `const value = cfField ? params.row[cfField] : params.value;` (and add the cross-column test).

### 1.2 Single-series bar chart: cross-filter highlight/ghost indices misalign with the rendered bars

- **File:** `src/components/widgets/StudioChartWidget/StudioBarChart.tsx:736-814` (single-series branch).
- **Failure scenario:** `selectedDataIndices`, the multi-select `SourceSelectionContext` set
  (`:736-739`), and the ghost-bar context arrays (`:741-757`, aligned to
  `allBarChartData.labels`) are all computed **before** the display transform at `:786-814`,
  which (a) drops empty-string/null category labels and (b) applies `barMaxCategories`
  "Other" grouping. The rendered `BarChart` gets `displayXAxisData`/`displayBarValues`, but
  `highlightedItem` / `SourceSelectionBar` / `CrossFilterGhostBar` consume the **pre-transform**
  indices. With one empty category or `barMaxCategories` set, clicking bar _k_ highlights bar
  _k±n_, and ghost "filtered / total" tooltips read values from the wrong category.
- **Contrast:** the pie renderer explicitly guards this — `StudioPieChart.tsx:372`
  (`const selectedDataIndices = pieMaxSlices ? [] : getSelectedDataIndices(displayLabels);`) and
  rebuilds its ratio map against the rendered order (`:495-515`). The bar chart has no equivalent.
- **Fix sketch:** compute selection indices and ghost-context arrays from `displayXAxisData` after
  the empty-filter/Other transform (or suppress highlight/ghost when the transform changed indices,
  mirroring the pie).

### 1.3 `barMaxCategories` groups by axis position, not by value ("top-N" is not top-N)

- **Files:** `StudioBarChart.tsx:797-814`; label ordering in
  `src/internals/aggregators.ts:158-198` (`orderLabels` returns insertion/category order unless
  `chartSortBy === 'value'`).
- **Failure scenario:** the prop is documented as "Group all but the **top-N** categories into an
  'Other' bar" (`StudioBarChart.tsx:65`), but the code slices the first `N-1` labels **in axis
  order** with no value sort. With default sort (`category`) and data `A:1, B:900, C:2, D:800`,
  `barMaxCategories: 3` keeps A and B and folds C+D (including the #2 value) into "Other". The pie
  implementation sorts pairs by value descending first (`StudioPieChart.tsx:334-338`) — the two
  copies of "Other" grouping have drifted semantically.
- **Test mask:** `StudioBarChart.test.tsx:340-350` passes only because its fixture values are
  already sorted descending (`[5,4,3,2,1]`).
- **Fix sketch:** sort pairs by value desc before slicing (matching the pie and the prop doc), or
  change the doc + test to pin "first N in axis order" as intended behavior.

### 1.4 Quick-filter bar renders `[object Object]` for date-range cross-filters

- **File:** `src/components/StudioCanvas/StudioQuickFilterBar.tsx:231`
  (`const summary = String(filter.value ?? '');`).
- **Failure scenario:** clicking a period-grouped bar emits a `between` cross-filter whose value is
  `{ from, to }` (see `StudioChartWidget.tsx:370-399`). The widget-card chip formats this correctly
  (`StudioWidgetCard.tsx:660-668` via dayjs), but the quick-filter bar chip shows
  `Order Date: [object Object]`. Shift-click multi-select (`in`) values render as a raw comma join.
- **Fix sketch:** extract the widget card's cross-filter value-label logic into a shared helper and
  use it in both chips.

### 1.5 Multi-Y line/area chart: cross-filter selection highlight is a knowing no-op

- **File:** `src/components/widgets/StudioChartWidget/StudioLineAreaChart.tsx:398-409`.
- **Failure scenario:** with two Y-series on a line chart and an active own cross-filter,
  `highlightedItem.seriesId` is set to the bare `fieldId` while rendered series ids are
  `${fieldId}-${i}` — it never matches, so the selected point is never highlighted. The code
  comment says "Preserved as-is on purpose" from the extraction, i.e. a known shipped bug rather
  than a regression — but it is still user-visible (clicking a point on a multi-Y line chart gives
  no selection feedback while sibling widgets visibly filter).
- **Fix sketch:** use `${multiYData.series[0].fieldId}-0` (one-line change) and delete the comment.

### 1.6 Clicking a synthetic "Other" bar/slice emits a filter that matches nothing

- **Files:** `StudioBarChart.tsx:902-906` (`onAxisClick` passes `params.axisValue`, which is the
  synthetic `'Other'` label after grouping); `StudioPieChart.tsx:536-541, 616-621`
  (`onItemClick(displayLabels[params.dataIndex], …)`).
- **Failure scenario:** with `barMaxCategories`/`pieMaxSlices` active, clicking the "Other"
  bar/slice applies a cross-filter `xField = 'Other'`. Unless a real category literally named
  "Other" exists, every downstream widget shows the no-data overlay; on the bar chart the
  selection can't even render (1.2), so there's no visual cue why the dashboard emptied.
- **Fix sketch:** ignore clicks on the synthetic bucket, or emit `not_in(keptLabels)`.

### 1.7 `StudioCanvas.onBackgroundClick` fires on _every_ mousedown (doc contract violated) and is un-overridable by consumers

- **Files:** `src/components/StudioCanvas/StudioCanvas.tsx:100` (doc: "Called when the user clicks
  the canvas background **(not on a widget)**") vs `:576-583` (`onBackgroundClick?.()` runs
  unconditionally; only the deselect is gated by `closest('[data-widget-card]')`);
  `src/components/Studio/StudioContent.tsx:324-327` spreads `{...slotProps?.canvas}` **before**
  `onBackgroundClick={() => setChatOpen(false)}`, silently clobbering any consumer-provided
  callback.
- **Failure scenario:** an embedder wiring `onBackgroundClick` to close a side panel finds it also
  fires when users click widgets (contradicting the docs); inside `StudioContent`, a consumer's
  `slotProps.canvas.onBackgroundClick` is discarded.
- **Fix sketch:** move `onBackgroundClick?.()` inside the `!closest('[data-widget-card]')` branch;
  in `StudioContent`, compose rather than overwrite the consumer callback.

### 1.8 Grid write-back: `processRowUpdate` rejects with no `onProcessRowUpdateError`

- **File:** `src/components/widgets/StudioGridWidget/StudioGridWidget.tsx:242-268, 443`
  (`processRowUpdate={isEditable ? processRowUpdate : undefined}`; `onProcessRowUpdateError`
  appears nowhere in the package).
- **Failure scenario:** an adapter mutation fails (`result.ok === false` → `throw new Error(...)`).
  Per DataGridPremium's contract, a rejected `processRowUpdate` without `onProcessRowUpdateError`
  logs a console error and leaves the cell stuck in edit mode; the user gets zero UI feedback that
  their edit was not persisted.
- **Fix sketch:** pass an `onProcessRowUpdateError` that surfaces a snackbar/error overlay and
  reverts the cell.

### 1.9 Column resize drag has no `pointercancel` handling — stuck live-drag state

- **Files:** `src/components/StudioCanvas/RowResizeHandle.tsx:147-168` (handles `pointerup` only);
  live state consumed in `StudioCanvas.tsx:163-168, 347-431`.
- **Failure scenario:** a captured pointer drag interrupted by `pointercancel` (touch interruption,
  window losing the pointer, browser gesture takeover) never runs `handlePointerUp`; `dragRef`
  stays set, the handle stays `active`, and `StudioPageRows.liveDrag` keeps the row frozen at the
  live spans with the resize outline and grid-line overlay stuck on screen. No commit or rollback
  happens until a subsequent unrelated pointerup.
- **Fix sketch:** add `onPointerCancel` (and `onLostPointerCapture`) that clears `dragRef`/`active`
  and calls a cancel callback so `StudioPageRows` can `setLiveDrag(null)`.

### 1.10 Locale system bypassed by hardcoded English UI strings

- **Files:** `widgets/StudioChartWidget/chartTypeDefs.tsx:396, 444-445, 520-521, 560-561`
  (heatmap/funnel/sankey/gantt "requires …" hints); `StudioCanvas/StudioCanvas.tsx:550-557`
  ("Canvas is empty", "Use the Compose panel…"); `StudioChatPanel/StudioChatPanel.tsx:350-353,
407-409, 494` ("No conversations yet", "How can I help?", "Ask me anything…", "AI Assistant");
  `StudioWidgetCard/StudioWidgetCardActionsOverlay.tsx:263, 271` ("Refresh AI content");
  `StudioMapWidget.tsx:559` (`'Value'` fallback in a legend aria-label).
- **Failure scenario:** the package ships `fr`/`de`/`es`/`ptBR` locales
  (`src/locales/`), and every sibling string in these same files goes through `localeText`. A
  German dashboard renders a mixed-language UI in precisely these spots — a real defect for a
  localized commercial product, not a style nit.
- **Fix sketch:** add the missing keys to `StudioLocaleText` and the four locale files.

### 1.11 Accessibility: keyboard traps around chips and widget-card activation

- **Files:** `StudioCanvas/StudioQuickFilterBar.tsx:85-104` — the chip's remove affordance is a
  `role="button"` span with **no `tabIndex` and no key handler**; keyboard users cannot remove a
  quick filter from the bar (Chip `onDelete` would give this for free).
  `StudioWidgetCard/StudioWidgetCard.tsx:521-531` — the card handles `' '` (Space) in `onKeyDown`
  without `event.preventDefault()`, so activating a card with Space also scrolls the canvas.
- **Fix sketch:** use `Chip.onDelete` (renders a focusable delete icon) in the quick-filter chip;
  `preventDefault()` on Space in the card's key handler.

## Tier 2: Structural Duplication

### 2.1 `StudioBarChart` triplicates its own scaffolding; highlight gating copy-pasted across bar/line/pie

- **Files:** `StudioBarChart.tsx` — five near-identical densify memos (`:152-279`), three
  ghost-context builders (`:387-411`, `:558-581`, `:741-757`), two `totals100` percent
  normalizations (`:350-357`, `:549-556`), the legend `slotProps` literal repeated 3× (`:514-522`,
  `:704-712`, `:909-917`), the `onAxisClick` lambda repeated 3×.
  Across renderers, the `highlightableSeriesIds` + `controlledHighlightedItem/Axis` block is
  **verbatim-duplicated three times**: `StudioBarChart.tsx:317-334`,
  `StudioLineAreaChart.tsx:143-164`, `StudioPieChart.tsx:199-210`.
- **Risk realized:** the copies have already drifted — the multi-Y line highlight bug (1.5) exists
  only in one copy; the bar copy lacks the pie's grouped-index guard (1.2); "Other" grouping
  semantics differ between bar and pie (1.3).
- **Fix sketch:** shared helpers in `chartWidgetHelpers.ts` — `useDensified(data)`,
  `buildGhostContext(all, filtered)`, `useControlledHighlight(...)`, one `CHART_LEGEND_SLOT_PROPS`
  constant — then per-branch code shrinks to the genuinely type-specific parts.

### 2.2 Cross-filter value equality re-drifted in the map widget

- **File:** `widgets/StudioMapWidget/StudioMapWidget.tsx:417-419` uses
  `String(activeCrossFilter?.value) === String(rawValue)`.
- **Context:** the header comment of `StudioGridWidget.crossFilter.test.tsx:14-22` records that
  grid and chart were deliberately consolidated onto `crossFilterValueEquals`
  (`StudioChartWidget/chartWidgetHelpers.ts:213-215`) because `String(a) === String(b)` disagrees
  on `null`/`undefined`/date inputs. The map widget either predates or escaped that consolidation
  and reintroduces the exact pattern the test warns about.
- **Fix sketch:** import and use `crossFilterValueEquals` (also compare against
  `activeCrossFilter.field === countryField` as the chart does).

### 2.3 "Interactions" cross-filter-mode toggle triplicated across setup panels

- **Files:** `StudioComposeDrawer/ChartSetupPanel/ChartSetupPanel.tsx:813-838`,
  `StudioComposeDrawer/GridSetupPanel.tsx:752-779`, `StudioComposeDrawer/KpiSetupPanel.tsx:475-499`.
- **Drift:** near-identical `SetupSection` + `ToggleButtonGroup` blocks, but each hand-rolls its
  default (`'cross-highlight'` for chart/grid, `'none'` for KPI) and the KPI copy additionally
  remaps `cross-highlight → cross-filter` inline. The per-kind default/valid-mode policy lives in
  three JSX blobs instead of one component.
- **Fix sketch:** a `CrossFilterModeSection({ widgetId, defaultMode, modes })` shared component.

### 2.4 Five independent re-implementations of the "all sources → field catalog / label map" fold

- **Files:** `ChartSetupPanel.tsx:74-106` (`allFields` with sourceLabel + expression fields),
  `GridSetupPanel.tsx:110-205` (`allSelectableFields`, same fold plus reachability),
  `StudioFiltersDrawer.tsx:100-110` (`allFields`), `StudioQuickFilterBar.tsx:154-161` and
  `StudioKpiWidget.tsx:530-542` (flat `fieldId → label` maps).
- **Correctness edge shared by all copies:** every copy is first-writer-wins on `field.id`. Two
  sources both exposing a `country` field will show one source's label for the other's filter, and
  the filters drawer conflates them into a single option. Centralizing would make that policy
  explicit (and fixable) in one place.
- **Fix sketch:** one memoized selector/util (e.g. `selectFieldCatalog` /
  `buildFieldLabelMap(dataSources, expressionFields)`) in `context`/`internals`.

### 2.5 Cross-filter chip label formatting duplicated between widget card and quick-filter bar

- **Files:** `StudioWidgetCard.tsx:651-677` (handles `between` ranges via dayjs) vs
  `StudioQuickFilterBar.tsx:229-235` (naive `String(value)` — see 1.4). Same data, two formatters,
  one already broken.

## Tier 3: God-Files / Cohesion

Line counts verified at review time (non-test files):

| File                                                      | Lines | Verdict                   |
| --------------------------------------------------------- | ----- | ------------------------- |
| `widgets/StudioChartWidget/StudioBarChart.tsx`            | 925   | regrown god-file          |
| `widgets/StudioChartWidget/useChartWidgetData.ts`         | 843   | two concerns fused        |
| `StudioComposeDrawer/ChartSetupPanel/ChartSetupPanel.tsx` | 841   | acceptable orchestrator   |
| `StudioWidgetCard/StudioWidgetCard.tsx`                   | 804   | responsibility creep      |
| `StudioComposeDrawer/GridSetupPanel.tsx`                  | 797   | borderline                |
| `widgets/StudioChartWidget/chartTypeDefs.tsx`             | 715   | OK structure, perf hazard |
| `widgets/StudioChartWidget/StudioChartWidget.tsx`         | 712   | decomposition held        |
| `widgets/StudioKpiWidget/StudioKpiWidget.tsx`             | 630   | one 330-line memo         |

### 3.1 `StudioBarChart.tsx` (925 lines) — the decomposition's mass migrated here

The earlier pass successfully thinned the orchestrator (`StudioChartWidget.tsx` now genuinely just
wires state + guards + registry dispatch; `chartTypeDefs.tsx` is a clean, exhaustiveness-checked
registry). But the bar renderer absorbed three full sub-charts (multi-Y `:337-529`, split-by
`:532-719`, single-series `:721-925`), each a page of axis/series/ghost config with the
duplication catalogued in 2.1. It is the largest non-test file in `components/` and the file where
three of the Tier-1 bugs live. Split into three sibling components sharing extracted helpers.

### 3.2 `useChartWidgetData.ts` (843 lines) — data hook doubles as a cross-source query engine

Lines 194-360 implement foreign-source row acquisition for blended mixed charts (spec building,
sync in-memory resolution, adapter-descriptor construction, an async fetch effect with in-flight
caching, merge). That is a self-contained subsystem with its own lifecycle, glued into a hook whose
other ~500 lines are memoized aggregations. Extract `useBlendedSeriesRows(widget, config, …)`;
the remaining aggregation memos are repetitive but mechanical.

### 3.3 `StudioWidgetCard.tsx` (804 lines) — card chrome plus five stowaways

Beyond chrome (paper, title, chips, overlay), the card owns: DnD registration, keyboard layout
moves, export dispatch for three widget kinds (including building a pipeline inline at
`:434-457`), anomaly-detection UI state, **AI insight prompt authoring** (`:254-306` — English
prompt copy embedded in a chrome component), the expand `Dialog` (`:729-790`), and the fallback
edit dialog. The insight-prompt builder and the expand dialog are the cleanest extractions.
Minor bug found here in passing: the expanded-dialog PNG export (`:782`) omits the
`theme.palette.background.default` argument that the normal export path passes (`:451`), so
full-screen exports get a transparent/undefined background.

### 3.4 `StudioKpiWidget.tsx` (630 lines) — one `useMemo` computes value + sparkline + trend

`:176-513` is a single ~330-line memo closure with three unrelated outputs and two trend sub-modes.
Consequences are already visible: the fixed-period trend branch (`:320-371`) uses raw child-grain
`rows` and bare `computeAggregate` — it ignores both the grain-anchoring the headline value gets
(`:122-166`) and measure expression fields (handled only by the filter-based branch at `:444-470`).
A KPI whose value field is cross-source or a measure shows a correct headline with a silently wrong
(or zero) fixed-period delta. Split into `useKpiValue` / `useKpiSparkline` / `useKpiTrend` and the
inconsistency becomes impossible to miss.

### 3.5 `chartTypeDefs.tsx` — unmemoized aggregation on every render for 4 chart types

`renderHeatmap` (`:405`), `renderFunnel` (`:457/:479`), `renderSankey` (`:527`), `renderGantt`
(`:566`) call `aggregateHeatmap`/`aggregateFunnelReached`/`buildFunnelStages`/`aggregateSankey`/
`buildGanttItems` synchronously inside plain render functions — no hooks allowed, so no
memoization, unlike every other chart type (which aggregates inside `useChartWidgetData` memos +
`cachedCompute`). Any re-render of `StudioChartWidget` (hover state, any subscribed selector tick)
re-aggregates the full `filteredRows`. Fine at demo scale; a real cost at 100k+ rows. Fix: make
these thin components (so they can `useMemo`) or route their aggregation through
`useChartWidgetData`/`cachedCompute` like the rest.

### 3.6 Clean bills of health (explicitly checked)

- `StudioWidgetCardActionsOverlay.tsx` (648): genuinely decomposed — shared per-action components
  parameterized by `tabIndex`/gating; the header comment's claim about preventing edit/view drift
  is accurate.
- `ChartSetupPanel/` sections and the other setup panels: the per-chart-type section split
  (Gauge/Scatter/Funnel/Heatmap/Sankey/Gantt/PieArcs) is real — sections are 64-158 lines each and
  contain only type-specific fields; no copy-paste drift found between them.
- `StudioCanvas/` and `StudioChatPanel/`: well factored into small files; `StudioCanvas.tsx`'s
  size is mostly one cohesive layout algorithm.

## Tier 4: Testing Gaps

### 4.1 Canvas drag-and-drop drop path has zero tests

`StudioPageRows.handleDrop` (`StudioCanvas.tsx:173-224`) implements the entire drop geometry:
horizontal (new row) vs vertical (into row) splices, removing the widget's prior occurrence,
cross-page moves (`sourcePageId ?? pageId`), compose-drops rejected when a data source is required
but absent. None of it is exercised: `InsertionPoint`, `WidgetGap`, `useStudioDropTarget`,
`useStudioDraggable` have no test files, and the five `StudioCanvas.*.test.*` files cover pure
functions (grid lines, spans, responsive math) and remount behavior only. A regression here (e.g.
an off-by-one in `colIndex` splicing, or dropping a widget onto its own page duplicating it) ships
undetected. These are jsdom-testable by invoking `handleDrop` through the drop-target callback with
synthetic drag items.

### 4.2 `RowResizeHandle` untested (keyboard splitter + pointer snapping + the cancel hole)

`RowResizeHandle.tsx` implements an APG-splitter keyboard protocol (Arrow/Home/End with clamping to
per-widget min spans) and midpoint pointer snapping — all pure logic behind DOM events, none
covered. The `pointercancel` bug (1.9) would have been surfaced by the first "interrupt a drag"
test.

### 4.3 Grid cross-filter remap tested only on the trivial column

`StudioGridWidget.crossFilter.test.tsx` sets `crossFilterField: 'label'` and clicks only `label`
cells — the one case where the bug (1.1) is invisible. Add: click a **different** column with
`crossFilterField` configured; assert the emitted filter's value comes from the configured column
of the clicked row.

### 4.4 Bar chart "Other"/empty-category × cross-filter interaction untested (donut has the exact analogue)

`StudioChartWidget.donutHighlight.test.tsx:170` explicitly asserts that with `pieMaxSlices` the MUI
`highlightedItem` stays null under cross-highlight — the regression test for the pie's index-shift
guard. The bar chart has no counterpart: no test combines `barMaxCategories` (or an empty-string
category) with `getSelectedDataIndices`/ghost mode, which is precisely bug 1.2. Additionally, the
existing grouping test (`StudioBarChart.test.tsx:340-350`) uses pre-sorted-descending values,
masking 1.3 — an unsorted fixture would pin the intended "top-N" semantics either way.

### 4.5 Grid write-back editing path untested

`processRowUpdate` (`StudioGridWidget.tsx:242-268`) — changed-value diffing, PK `where` clause
construction, and the failure path (`result.ok === false` → throw) have no test. Combined with the
missing `onProcessRowUpdateError` (1.8), the entire editing failure UX is unverified.

### 4.6 Quick-filter bar: cross-filter chips and keyboard removal uncovered

`StudioQuickFilterBar.test.tsx` doesn't render a `between` or `in` cross-filter chip (the
`[object Object]` case, 1.4), and no test attempts keyboard removal of a chip (1.11). Both are
cheap jsdom tests.

### 4.7 Browser-mode-only gaps

The repo has browser-mode infra (`pnpm test:browser`), but none of these visually-dependent
behaviors are covered there: real SVG hit-testing for chart `onAxisClick`/`onItemClick` (jsdom
tests invoke the props directly), the custom DnD ghost preview (`createClonePreview` +
`setCustomNativeDragPreview`), the `clip-path: inset(100%)` keep-alive of inactive pages
(`StudioCanvas.tsx:594-640` — the code comments describe SVG bleed-through bugs that only a
browser can regress), and the horizontal-bar explicit y-axis width computation
(`StudioBarChart.tsx:831-838`, a text-measurement heuristic).

---

# Part B — Internals/State Layer (`src/store/`, `src/internals/`, `src/context/`, `src/models/`)

## Tier 1: Correctness & Security

### 1.1 Transient doc writes leak through undo/redo — the `{ undoable: false }` doc-mutation family violates its own contract

**Files:** `src/store/StudioController.ts:112-136` (`commitState`), `:1223-1268` (`applyInteractiveFilter`/`clearInteractiveFilter`), `:321-341` (`setGlobalCrossFilterMode`, `setCrossFilterAllPages`), `:1621-1657` (`undo`/`redo`).

The doc/session/runtime partition promises "never undoable" for transient state, but four methods write **transient state into the `doc` partition** with `{ undoable: false }`: interactive-filter selection, interactive-filter clearing, `globalCrossFilterMode`, and `crossFilterAllPages`. Because undo snapshots are whole `StudioDoc` objects, `undoable: false` only suppresses _creating_ an undo entry — it cannot exempt those fields from being reverted by _other_ entries. Two concrete failure scenarios:

- **Silent revert:** user selects a value in a filter widget (`applyInteractiveFilter`, non-undoable by design: "same convention as interactive filter selection"), then adds a widget (undoable, pushes the post-selection doc), then presses Ctrl+Z twice. The second undo pops a doc snapshotted _before_ the selection — the filter widget's selection silently resets, exactly the class of behavior the non-undoable convention exists to prevent (compare the `runtime` rationale at `:58-61`).
- **Stale redo replay:** `commitState` clears `redoStack` only inside the `undoable && doc changed` branch (`:116-124`). A non-undoable doc commit therefore leaves a stale redo stack alive. Sequence: add widget → undo → select in a filter widget (`applyInteractiveFilter`, doc changes, redo stack survives) → press redo. Redo swaps in the pre-selection doc: the widget reappears **and the user's just-made selection is silently destroyed**; pressing undo then _resurrects_ the "non-undoable" selection. `setGlobalCrossFilterMode`/`setCrossFilterAllPages` time-travel the same way. Standard undo semantics (any new state-changing action invalidates redo) are violated for this whole method family.

**Fix sketch:** either (a) clear `redoStack` on _every_ doc-reference change regardless of `undoable`, and carry transient filter entries (`scope.kind === 'interactive'`) and the two dashboard toggles forward across `undo()`/`redo()` doc swaps (the same way `normalizeSessionAfterDocSwap` already patches selection), or (b) move genuinely transient state out of `doc` into `session` and accept the reducer/persistence plumbing cost. Note `ARCHITECTURE.md:74` claims `undoable: false` is used for "interactive/**cross-filter** selection" while `:68` says "`applyCrossFilter` is undoable" — the code makes `applyCrossFilter` undoable (`:1299-1303`), so line 74 is also self-contradictory documentation.

### 1.2 `resolvedRowsCache` never invalidates when a cross-filter's foreign source gains rows _after_ the entry was computed

**Files:** `src/internals/resolvedRowsCache.ts:102-133` (`isEntryValid`), `:216-224` (dependency recording); `src/internals/dataSourceGraph.ts:264-267`.

`isEntryValid` only iterates dependencies that were _recorded at compute time_ (`entry.crossFilterSourceRows`). Both recording paths skip a foreign source whose rows are absent:

- `resolveRows` bails with `continue` before reporting the source when `!foreignSource?.rows` (`dataSourceGraph.ts:264-267`), so it never lands in `collectJoinedSourceIds`;
- the fallback loop that exists _specifically_ to "record any declared filterSourceId even if the join was skipped (e.g. the foreign source had no rows yet) so a later data load invalidates the entry" (`resolvedRowsCache.ts:216-224`) is guarded by `if (foreignRows)` — it records nothing in exactly the case its comment says it handles.

**Failure scenario:** widget on `orders` has a cross-filter with `filterSourceId: 'customers'` while `customers` rows haven't been injected yet (staggered `upsertDataSource`, or async host loading). The entry is cached with the semi-join skipped (unfiltered rows) and an empty dependency map. When `customers` rows arrive, `orders`' own rows ref is unchanged and the filter fingerprint is unchanged → cache HIT → the widget permanently shows **unfiltered** rows despite the cross-filter now being resolvable. Only editing the filter or replacing the widget's own rows unsticks it.

**Fix sketch:** record absent foreign sources with a sentinel (e.g. `crossFilterSourceRows.set(id, null)`) and treat `entry.get(id) !== (dataSources[id]?.rows ?? null)` as invalidation; the existing test at `resolvedRowsCache.test.ts:215` covers rows _changing_, not rows _appearing_ (see Tier 4).

### 1.3 Adapter path bakes cross/interactive filters into the server query — breaks the cross-highlight ghost baseline and forces a server round-trip per cross-filter click

**Files:** `src/internals/queryDescriptor.ts:201-205` (`buildQueryDescriptor` calls `selectFiltersForWidget` with default `include: 'all'` and no `crossFilterAllPages`), `src/internals/useWidgetRows.ts:393-429` (`computeFilteredRows`, adapter branch), `:476-497` (baselines).

`buildQueryDescriptor` includes same-page cross-filters and interactive filters in `descriptor.filter` (asserted intentional by `queryDescriptor.test.ts:257`). Two consequences on the adapter path:

1. **Ghost baseline is unrecoverable.** For adapter widgets, `computeFilteredRows('no-cross')` scopes only `[cross, interactive]` buckets, gets `scoped.length === 0`, and returns `enrichedAdapterRows` — but those rows came back from a fetch whose descriptor _already excluded_ the cross-filtered rows server-side. So `filteredRowsNoCross === filteredRows` whenever a cross-filter is active, `shouldShowGhost` is true, and the ghost overlay has nothing to ghost: cross-highlight mode silently degrades to hard-filter mode for every server-backed source. The `useWidgetRows.ts:397-401` comment ("rows were already excluded, making this idempotent") acknowledges the row-set is pre-filtered but the baseline computation ignores it. `ARCHITECTURE.md:153` claims the adapter path is "scoped to `include: 'no-cross' | 'no-chart-cross'`" — the descriptor is not.
2. **Refetch per click.** Every cross-filter application changes `descriptor.cacheKey` → cache miss → fresh `adapter.getRows()` round-trip, even though the client re-applies the same cross-filters locally anyway. This defeats the "cross-filters are cheap, client-side, cached" design that `isRecomputing`/`selectPartitionedBaseFilters` are built around.

**Fix sketch:** build the descriptor with `include: 'no-cross'` (page + widget only), and let the client-side `computeFilteredRows` remain the single place cross/interactive filters are enforced — which is already what it does correctly for the in-memory path.

### 1.4 `StudioRequestCache` derives sourceId by `cacheKey.split(':')[0]` — invalidation silently misses any sourceId containing `:`

**Files:** `src/internals/StudioRequestCache.ts:57, 67, 96-97, 117-130`; `src/internals/queryDescriptor.ts:230`.

The cacheKey is `` `${widget.sourceId}:${sortedStringify(...)}` `` and the cache recovers the sourceId by splitting on the **first** colon. For a sourceId like `pg:orders` (host-defined, unconstrained strings):

- `set()` indexes the entry under `"pg"`, but `invalidateSource('pg:orders')` (called by `upsertDataSource`/`setDataSourceAdapter`) looks up `sourceIndex.get('pg:orders')` → finds nothing → **cached entries survive invalidation** and are served for up to 30s after the host replaced the source.
- The generation guard is keyed inconsistently: `addInflight` captures `getGeneration('pg')` while `invalidateSource` bumps `'pg:orders'` — so a request invalidated mid-flight **does** write its stale result back into the cache with a fresh TTL, the exact bug the generation mechanism exists to prevent (`:29-36`).

**Fix sketch:** stop parsing the sourceId out of the key — pass it explicitly to `get`/`set`/`addInflight` (the descriptor already carries `sourceId` separately), or delimit with a character the descriptor guarantees can't appear (the JSON body starts with `{`, so splitting on `':{'` would also work but is fragile).

### 1.5 `createStudioPipeline` drops dashboard cross-filter settings — non-React consumers (CSV export, AI insights) diverge from what the widget renders

**Files:** `src/internals/StudioPipeline.ts:98-124`; `src/internals/filterScoping.ts:30` (defaults `include: 'all'`, `crossFilterAllPages: false`). Consumers: `src/components/StudioWidgetCard/StudioWidgetCard.tsx:236,443` (export path), `StudioChatPanel/generateInsight.ts`, `StudioChatPanel/richContext.ts`.

`StudioPipelineState` carries only `{ dataSources, relationships, expressionFields, filters }` — `dashboard.crossFilterAllPages`, `dashboard.globalCrossFilterMode`, and per-widget `config.crossFilterMode` never reach `selectFiltersForWidget`. Divergences from the rendered widget:

- With `crossFilterAllPages: true`, a cross-filter from another page filters the on-screen widget (`useWidgetRows` passes the flag) but is **excluded** from the exported CSV / AI-insight rows (pipeline hard-defaults `false`).
- With `crossFilterMode: 'none'` (globally or per widget), the widget renders `effectiveRows = filteredRowsNoCross` (cross-filters ignored), but the pipeline always applies `include: 'all'` — the export **includes** cross-filtering the user's widget visibly ignores.

**Fix sketch:** extend `StudioPipelineState` with the two dashboard toggles (extract them in the `'doc' in state` branch), add `include`/`crossFilterMode` awareness to `resolveWidgetRows`, and thread the widget's mode from the export call site.

### 1.6 Hand-rolled doc-writers commit content-identical states as undoable steps — dead Ctrl+Z presses and phantom mutation-log lines

**Files:** `src/store/StudioController.ts:1005-1041` (`updateFilter`), `:1050-1057` (`toggleFilter`), `:989-1003` (`updateRelationship`/`removeRelationship`), `:1388-1407` (`deleteFilterPreset`/`renameFilterPreset`), `:1496-1511` (`reorderPages`), `:598-609` (`removeExpressionField`).

Reducer-delegated methods get no-op detection for free (`commitMutation` skips when the reducer returns the same reference — deliberately tested as "D4" for `removeFilter`). The remaining hand-rolled methods always build a fresh array/object via `.map`/`.filter`, so `nextState.doc !== current.doc` even when nothing changed, and `commitState:116` pushes an undo entry. Concrete cases:

- `updateFilter(unknownId, …)` or a **rejected** rank-filter change (`:1022-1034` returns the original filter object) still commits: a new-but-identical doc is pushed, the redo stack is cleared, and `updateFilter:<id>` is written to the AI-visible mutation log — the model is told a mutation happened that was actually rejected.
- `toggleFilter`, `updateRelationship`, `renameFilterPreset`, `removeExpressionField`, `deleteFilterPreset` with unknown ids, and `reorderPages` with the current order, all do the same. The user's next Ctrl+Z visibly does nothing (pops an identical doc).

**Fix sketch:** give `commitDocPatch` (or the individual writers) cheap short-circuits — e.g. return early when the mapped array is element-wise reference-identical, or route these through reducer mutations where equivalents exist.

### 1.7 `updateFilter` rank-uniqueness guard doesn't match its own error message (dashboard-wide, not per-page)

**File:** `src/store/StudioController.ts:1006-1034`.

`hasExistingRankFilter` scans **all** filters except cross-filters — including widget-scoped rank filters belonging to widgets on other pages and page filters of other pages — while the warning says "Only one rank filter is allowed per page at a time." A user with a top-N rank filter on Page A's chart cannot switch any filter to rank mode on Page B; the change is silently rejected (dev-only console.warn) and, per 1.6, still pollutes the undo stack/log. **Fix sketch:** scope the scan to the same page (page filters with matching `pageId`, widget filters whose widget lives on that page), or fix the message and make the rejection an observable no-op.

### 1.8 `duplicateWidget`: unguarded active page + `Date.now()` id collisions

**File:** `src/store/StudioController.ts:892-967`.

- `state.doc.pages[state.doc.dashboard.activePageId]` is used without a null guard (`:904-905` reads `activePage.widgetRows`) — every sibling method (`setWidgetLayout:680`, `setPageStackBreakpoint:730`, `setAdjacentWidgetColSpans:759`) guards this exact lookup. A dangling `activePageId` (host-supplied initial state, or a future reducer regression) throws a raw TypeError here instead of no-opping.
- `newId = ${widgetId}-copy-${Date.now()}` (`:903`): two duplications of the same widget within the same millisecond (double-click, or scripted/AI-driven calls) produce the same id — the second silently overwrites the first in `doc.widgets` while `widgetRows` gains the id twice, corrupting the layout. Cloned filter ids share the same scheme (`:938`).

**Fix sketch:** guard the page like the sibling methods; use a monotonic counter or crypto-random suffix for generated ids (`addPage`, `applyInteractiveFilter`, `applyCrossFilter`, `saveFilterPreset` share the `Date.now()` scheme but are lower-risk since replaces/removals are keyed differently).

### 1.9 Unbounded growth of `resolvedRowsCache` inner maps under interactive/cross-filter churn

**Files:** `src/internals/resolvedRowsCache.ts:50, 75-92, 179-182`; `src/store/StudioController.ts:1241, 1290`.

The outer key is the rows array (WeakMap — fine), but the inner `Map<string, ResolvedCacheEntry>` grows monotonically for the lifetime of that rows array, and `filterFingerprint` includes `f.id`. Interactive and cross-filter ids embed `Date.now()` and are regenerated on **every** application (`interactive-${w}-${Date.now()}`), so each slider tick / chart click produces a never-again-hit cache key whose entry retains a full filtered `Row[]`. On a long-lived dashboard with a large static source, dragging a slider filter accumulates one retained row-array copy per drag step until the source rows are replaced. **Fix sketch:** drop `f.id` from the fingerprint (two filters with identical behavioral content produce identical rows — the id adds no correctness, only misses), and/or cap the inner map (small LRU).

## Tier 2: Structural Duplication

### 2.1 `duplicateWidget` hand-rolls what `commitMutations` composition already solved

**File:** `src/store/StudioController.ts:892-967`; compare `insertWidgetAt:649-668` and `commitWidgetMove:1530-1560`.

`insertWidgetAt` established the pattern: compose existing reducer mutations (`addWidget` + `setWidgetLayout` + `addFilter`) into one `commitMutations` commit with a `transform` for shell selection. `duplicateWidget` predates it and still hand-assembles the full state: its own row-splice geometry, its own `MAX_PER_ROW = 4` constant re-deriving the grid invariant ("GRID_COLS=24, MIN_SPAN=6") that the reducer's `enforceLayoutColSpans` already owns, a hand-spread `{...state, doc: {...}, session: {...}}`, and — unlike the reducer paths — no column-span handling at all for the duplicate. It is also listed in `ARCHITECTURE.md:90` as "permanently controller-owned by design", which the `insertWidgetAt` precedent contradicts: it is expressible today as `addWidget` + `setWidgetLayout` + N×`addFilter` in one fold.

### 2.2 `sortedStringify` and the expression-ref walker are each duplicated verbatim

- `sortedStringify`: `src/internals/resolvedRowsCache.ts:56-67` and `src/internals/queryDescriptor.ts:18-29` — byte-identical except the cache copy's `?? 'null'` guard (meaning the two can fingerprint `undefined` differently, a latent divergence for two functions doing the same job).
- Expression field-ref walkers: `collectExpressionFieldRefs` (`src/internals/enrichedRowsCache.ts:99-113`) and `collectExpressionRefs` (`src/internals/queryDescriptor.ts:85-97`) are the same recursive walk with the same skip-join-field comment.

Both belong in a shared internals module; drift in either pair produces cache-vs-descriptor disagreements that are hard to trace.

### 2.3 Session/shell writers spread four levels of nesting five times; dashboard-toggle writers bypass `commitDocPatch`

**File:** `src/store/StudioController.ts:343-448` (`toggleDrawer`, `setDrawerOpen`, `setSelectedWidget`, `selectField`, `clearSelection`), `:321-341` (`setGlobalCrossFilterMode`, `setCrossFilterAllPages`), `:728-786` (`setPageStackBreakpoint`, `setAdjacentWidgetColSpans`).

`commitDocPatch` exists precisely so doc-writers don't hand-spread `{...state, doc: {...state.doc, ...}}` — yet the two dashboard toggles and the two page-layout writers still do (and `duplicateWidget`, `addExpressionField`, `updateExpressionField`, `removeExpressionField`, `updateDataSourceField` likewise hand-assemble). There is no `commitShellPatch`/`commitSessionPatch` mirror at all, so five shell methods each repeat the same four-level spread. One helper each removes ~80 lines and one class of copy-paste partition mistakes.

### 2.4 Three near-identical "stable filtered array" selector closures

**File:** `src/context/selectors.ts:79-105, 116-139, 424-453`.

`makeSelectExpressionFieldsForSource`, `makeSelectExpressionFieldsForSources`, and `makeSelectIncomingCrossFilters` are the same memo pattern (input-ref check → filter → element-wise ref comparison → reuse previous array) with only the predicate differing. A single `makeStableFilteredSelector(predicate)` factory collapses them; the partitioning selectors already went through exactly this consolidation (`:165-175` documents that history), so this is the leftover half.

### 2.5 Cache-entry validity loops duplicated across the two row caches

**Files:** `src/internals/enrichedRowsCache.ts:50-91`, `src/internals/resolvedRowsCache.ts:102-133`.

Both `isEntryValid` implementations are the same three checks (ref-array element-wise compare, joined-source rows map compare, relationship compare) with different field names. Not urgent, but the fix for finding 1.2 (absent-source sentinel) has to be made in the right one — a shared `depsUnchanged` helper would make the two caches' invalidation semantics converge instead of drifting.

## Tier 3: God-Files / Cohesion

### 3.1 `StudioUIConfigContext.ts` — 2,385 lines, four unrelated concerns, misfiled

**File:** `src/internals/StudioUIConfigContext.ts`.

~2,050 of its lines are the `StudioLocaleText` interface (`:28-1095`) and `DEFAULT_STUDIO_LOCALE_TEXT` (`:1097-2070`). The remainder is (a) the UI-config React context, (b) the unified built-in/custom widget-kind registry (`StudioWidgetDef`, `StudioWidgetRenderProps`, `StudioWidgetCapabilities`, `:2164-2261`), (c) geography resolution, and (d) feature-flag resolution (`ResolvedStudioFeatures`, `resolveSubFlag`, `:2290-2385`). Locale tokens are public API surface (the `localeText` prop type) living in `internals/`; the widget registry is a registry, not a context. Splitting into `localeText.ts` (or a `locales/` module), `widgetRegistry.ts`, and a slim config-context file would drop the largest file in the reviewed tree to ~350 lines. Every locale-token addition currently churns the same file that defines the widget-capability contract.

### 3.2 `StudioController.ts` — 1,781 lines; the facade is fine, but two method families are business logic that re-crept in

**File:** `src/store/StudioController.ts`.

The reducer-delegation refactor thinned the widget/page/layout methods well. What remains oversized is not method count but two families of controller-resident domain logic:

- **Date-range filters** (`buildDateRangeFilter` + `setDashboardDateRange` + `setDashboardDateRangeAll` + `setWidgetDateRange`, `:1068-1221`, ~150 lines): filter-construction policy (id schemes, scope stamping, custom-vs-preset value rules) that neither the reducer nor `filterUtils` can see — the AI path cannot express any of it.
- **Filter presets** (`saveFilterPreset`/`clearPageFilters`/`applyFilterPreset`/`deleteFilterPreset`/`renameFilterPreset`, `:1325-1407`): page-scoping and id-prefixing policy, same situation.

Both are pure `StudioDoc → StudioDoc` transforms; extracting them to a `docTransforms`-style module (controller keeps the one-line `commitDocPatch` call) would restore the "controller = orchestration, transforms = pure functions" split, and is the precondition for ever exposing them as reducer mutations.

### 3.3 `useWidgetRows.ts` — one 582-line hook owning two data paths and an async state machine

**File:** `src/internals/useWidgetRows.ts`.

The hook interleaves: the adapter fetch state machine (descriptor build + cache seed + effect + 4 useState, `:165-255`), deferred-value scheduling policy (`:119-132`), the sync pipeline, three row baselines, ghost-flag derivation, and cross-source column enrichment (`:499-567`). The adapter block is a self-contained `useAdapterRows(descriptor, adapter)` hook by inspection (its only outputs are `adapterRows`/`isLoading`/`isError`/`errorMessage`); extracting it would make the subtle cancellation/stuck-`isLoading` logic (`:205-221`) independently testable and cut the main hook to ~350 lines. The cross-source enrichment tail is similarly separable.

### 3.4 Layer-numbering drift in `StudioPipeline` documentation

**File:** `src/internals/StudioPipeline.ts:27-69`.

`resolveWidgetRows` is documented as "Layers L1 + L3" while `getEnrichedRows` is "Layer L2" and `useWidgetRows.ts:90` says "L1 (metric-ref resolution) and L3 (enrich + filter)" — but `CLAUDE.md`/`ARCHITECTURE.md` define the pipeline as L2 (enrichment) / L3 (filters) / L4 (grain). `resolveWidgetRows` in fact performs L2+L3 (it calls `resolveRowsCached` → enrichment + filtering); no "metric-ref resolution" step exists in the current code. Cosmetic, but this is the exact kind of stale map the ARCHITECTURE.md patch was supposed to eliminate — and note ARCHITECTURE.md's own contradictions flagged in 1.1 (line 74 vs 68) and 1.3 (line 153).

`src/context/` and `src/models/` are otherwise healthy: models is a genuine thin re-export shim over `@mui/x-studio-schema` exactly as documented, and `selectors.ts` is large but single-purpose.

## Tier 4: Testing Gaps

Ordered by the severity of the untested behavior (each maps to a Tier 1 finding).

### 4.1 No test covers transient doc state × undo/redo (finding 1.1)

`StudioController.test.ts:1333` ("undo never reverts runtime or session") tests the _session/runtime_ partitions but nothing tests the transient-**doc** family. Missing cases: (a) `applyInteractiveFilter` between two undoable edits, then `undo()` × 2 → assert the interactive filter survives (currently fails); (b) undo → `applyInteractiveFilter` → `canRedo()` should be false, or redo must not destroy the selection (currently redo replays over it); (c) `setGlobalCrossFilterMode` followed by undo of a prior edit → mode survives. There are **zero** tests referencing `setGlobalCrossFilterMode`/`setCrossFilterAllPages` anywhere in the package.

### 4.2 No test for "foreign source rows appear after the cache entry was computed" (finding 1.2)

`resolvedRowsCache.test.ts:215` covers foreign rows _changing_ ref; no test covers the foreign source having **no rows** at compute time and rows arriving later — the scenario the recording code's own comment (`resolvedRowsCache.ts:217-218`) claims to handle. A test that caches with `dataSources.customers.rows === undefined`, then injects rows and asserts a recompute, currently fails and pins the fix.

### 4.3 No test for the adapter-path ghost baseline (finding 1.3)

`useWidgetRows.test.ts:480` covers `crossFilterAllPages` on the adapter path, but no test asserts that `filteredRowsNoCross` for an adapter-backed widget still contains the rows a cross-filter excluded (i.e. that the ghost baseline is a genuine superset). Any such test would expose that the descriptor pre-filters them away. Similarly nothing asserts that applying a cross-filter does _not_ change `descriptor.cacheKey` (`queryDescriptor.test.ts:257` asserts the opposite behavior as intended, so the design decision and the ghost feature have never been tested against each other).

### 4.4 No test for sourceIds containing `:` in `StudioRequestCache` (finding 1.4)

`StudioRequestCache.test.ts:170` ("does not affect sources with a similar prefix") tests prefix confusion between distinct sourceIds but never a sourceId that itself contains the delimiter. Missing: `set('a:b:{…}', r)` → `invalidateSource('a:b')` → `get` must miss; and the mid-flight generation test (`:127`) repeated with a colon-bearing sourceId (currently the stale result _would_ be re-cached).

### 4.5 `filterScoping.test.ts` never exercises `crossFilterAllPages`

The option is a branch in the single scoping authority (`filterScoping.ts:57`) but the unit suite (`filterScoping.test.ts`) has no test for it — coverage exists only indirectly via one adapter-path integration test in `useWidgetRows.test.ts`. Missing combinations: `crossFilterAllPages: true` × other-page cross-filter (include), × self-emitted other-page cross-filter (exclude), and the asymmetry that `interactive` filters ignore the flag entirely (other-page interactive filters are always excluded — line 66 — which is either intended and should be pinned, or a bug the flag was meant to cover).

### 4.6 No-op commit behavior is tested only for the reducer-delegated side (finding 1.6)

`StudioController.test.ts:1909` pins "removeFilter unknown id → no undo entry, no log line" (D4), but the hand-rolled writers have no equivalent tests: `updateFilter` with unknown id, the _rejected_ rank-mode change (`:22` asserts the filter value is unchanged but not that no undo entry/log line was created — it currently is), `toggleFilter` unknown id, `reorderPages` with the identical order. Adding these as the D4-style contract would immediately surface the asymmetry.
