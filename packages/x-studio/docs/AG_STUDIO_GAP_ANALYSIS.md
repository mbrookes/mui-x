# @mui/x-studio Gap Analysis vs AG Studio Clone Requirements

**Date:** 2026-08-09 (last updated; originally 2026-04-29)
**Reviewer:** Copilot (automated code review), maintained since by hand
**Scope:** `packages/x-studio/src/` vs `AG_STUDIO_CLONE_REQUIREMENTS.md`
**AG Studio reference:** https://www.ag-grid.com/studio/react/reference/

> **A baseline check, not the roadmap.**
> [ADR 0003](./decisions/0003-ai-assistant-product-scope.md) (2026-08-09) chose an **AI-native
> dashboard builder**, so parity with AG Studio is a floor to clear rather than the definition of
> done. This document is still worth keeping and still worth updating — a competitor is a good
> checklist for the unglamorous things a dashboard product must not be missing, and several entries
> below found real gaps.
>
> What it structurally cannot tell you is where this product is going. **A capability AG Studio does
> not have never appears here as an opportunity — it does not appear at all.** The entire AI
> subsystem, the largest thing in the tree, is visible in these pages only as an occasional ⚡. So a
> reader deciding what to build next should not work down the ❌ column; they should read the
> decision log, and treat this as the check that the floor has not fallen through.
>
> The comparison itself is also a first pass, taken from public materials in April 2026 (see §4 of
> the requirements for what was and was not verifiable), and AG Studio has not stood still since.
> Individual verdicts here have gone stale twice on our OWN code — three "gaps" in the a11y section
> and all three in XS-LAYOUT-004 turned out to be already implemented — so a claim in this file is a
> prompt to go and look, not a finding.

---

## Scoring key

| Symbol | Meaning                                                |
| :----- | :----------------------------------------------------- |
| ✅     | Implemented — all acceptance criteria met              |
| ⚡     | Implemented and surpasses AG Studio                    |
| ⚠️     | Partially implemented — some acceptance criteria unmet |
| ❌     | Not implemented                                        |

---

## 7A. Shell and layout

### XS-LAYOUT-001 — Shell chrome and collapsible drawers

**Status: ✅ Implemented**

All three drawers exist (`StudioDataDrawer`, `StudioComposeDrawer`, `StudioFiltersDrawer`). Each collapses to 36 px with `DrawerPanel` (`components/DrawerPanel.tsx`). Keyboard accessible: `tabIndex=0`, `role="button"`, `Enter`/`Space` open/close, `aria-label` set, `aria-expanded` reflected via `expanded` prop.

**Partial gap — AC2 "drawer state persists per session":**
`ShellState` (including `dataDrawerOpen`, `composeDrawerOpen`, `filtersDrawerOpen`) is defined in the model and held in the controller store, but `serializeState()` in `store/statePersistence.ts` explicitly excludes shell state:

```ts
// statePersistence.ts
const { shell: _shell, ...stateWithoutShell } = state;
```

Drawer open/closed positions are therefore lost on page reload.

**Surpasses AG Studio:** The Filters drawer is visible in both edit and view modes. AG Studio documentation only shows the Filters panel in view mode. The Data and Compose drawers are correctly limited to edit mode.

---

### XS-LAYOUT-002 — Configurable canvas layout (resize and reposition)

**Status: ✅ Implemented**

DnD reorder between rows and within rows is fully implemented using native HTML5 APIs in `StudioCanvas.tsx`. Widget resize is also implemented via a drag handle on the right edge of each widget card (`feat: between-widget resize handle`).

**Implemented:**

- Row-based layout model: `widgetRows: string[][]` per page.
- HTML5 drag-and-drop reorder via `StudioCanvas.tsx`.
- **Resize handles:** A drag handle on the right edge of each widget card snaps to a 12-column grid on release. Live column-grid lines are shown during drag. `setWidgetColSpan` / `setWidgetColSpanInRow` on `StudioController`; persisted in `widgetColSpans`.
- Layout persists in state and is serialized.

---

### XS-LAYOUT-003 — Layout presets

**Status: ❌ Not implemented**

No preset selector, no preset definitions anywhere in `packages/x-studio/src/`. The compose drawer's "Page" tab contains only theme controls (`PageConfigPanel`), not layout preset choices.

---

### XS-LAYOUT-004 — Keyboard canvas navigation

**Status: ✅ Implemented**

Re-verified; this entry was stale. All three recorded gaps are closed, two of them by the a11y work in the preceding commit and one by code that predates this analysis.

- Widget cards have `tabIndex={0}`, `role="listitem"`, `aria-selected` (`StudioWidgetCard.tsx`).
- `Enter`/`Space` select a widget and focus the Compose drawer; drawers open on Enter and close on Escape (`DrawerPanel`).
- **Arrow-key move** — `StudioWidgetCard.tsx` maps `ArrowUp`/`Down`/`Left`/`Right` onto a direction and repositions the selected widget through the same mutation the pointer drag uses, so keyboard and pointer placement cannot drift apart.
- **Keyboard resize** — `RowResizeHandle.tsx` handles arrow keys on the focused handle. The handle is the resize affordance for both input methods, which is why the shortcut lives there rather than as a modified arrow key on the card: a card-level `Shift+Arrow` would be a second, invisible resize mechanism.
- **`Delete`/`Backspace`** — handled globally in `useStudioKeyboardShortcuts.ts` for the selected widget, and mirrored on the card so the key works whether focus is on the card or on the canvas.

---

### XS-LAYOUT-005 — Responsive / mobile layout

**Status: ✅ Implemented**

View mode already stacked widget rows below a breakpoint. Edit mode now adapts too: below `narrowLayoutMediaQuery`, `StudioContent` uses the **tabbed** sidebar regardless of the configured `sidebarLayout`.

Reusing the tabbed sidebar rather than adding a mobile layout is the substance of the fix. The stacked sidebar renders all three drawers beside the canvas, so on a phone the canvas was squeezed to nothing; the tabbed sidebar shows one panel at a time behind a tab strip, which is the mobile-appropriate arrangement and already ships. A third layout would be a third thing to keep working.

The compose-panel auto-switch follows the **effective** layout, not the configured one. Without that, a narrow viewport got the tabbed sidebar but not the sibling-closing behaviour that makes one-panel-at-a-time usable.

**The query is a prop, not a theme read** — and this went through one wrong version worth recording. The first implementation used `useMediaQuery((theme) => theme.breakpoints.down('md'))`. That form reads the theme from context and yields `null` when `Studio` is mounted without a `ThemeProvider`, which broke five existing `StudioContent` test files — themselves the evidence that mounting without a provider is a real usage pattern.

Resolving it through `useTheme()` (which falls back to the default theme) fixed the failure, but was still off-pattern for this repo. No other MUI X component reads the theme for a media query: the pickers and charts declare a query **string** and pass `defaultMatches`, and the pickers expose theirs as a prop (`desktopModeMediaQuery`) whose JSDoc invites the host to supply a theme-derived value. `defaultMatches` is the sanctioned answer to exactly this jsdom failure — `DatePicker.tsx` carries the comment saying so.

So this now matches the pickers:

- `narrowLayoutMediaQuery?: string` on `StudioProps`, defaulting to the exported `DEFAULT_NARROW_LAYOUT_MEDIA_QUERY` (`'@media (max-width: 899.95px)'`, the default `md` breakpoint). A host with moved breakpoints passes `theme.breakpoints.down('lg')` itself.
- `{ defaultMatches: false }`, so where `matchMedia` is unavailable the fallback is whatever the host configured. This branch only ever _overrides_ `sidebarLayout`, and overriding an explicit host choice on the strength of a viewport that could not be measured would be the wrong way to be wrong.
- No `useTheme()` call at all, so the layout is correct with or without a provider rather than merely tolerant of its absence.

Distinct from `stackBreakpoint`, which is a canvas _container_ width governing view-mode row stacking. This one asks whether the sidebar and canvas fit on the screen together — a viewport property, not a canvas one.

Covered by `StudioContent.responsive.test.tsx`: the property the reuse rests on (the tabbed sidebar renders at most one panel body while still exposing every panel as a tab), plus an assertion tying the default literal to `createTheme().breakpoints.down('md')`, since a hardcoded string and the breakpoint it mirrors can now drift silently.

---

## 7B. Canvas and widget placement

### XS-CANVAS-001 — Add widgets from gallery

**Status: ✅ Implemented**

`AddWidgetView` inside `StudioComposeDrawer.tsx` lists seven widget types (Text, KPI, Chart, Grid, Filter, Pivot, Map) with icons and descriptions. Both click-to-add (calls `controller.addWidget(...)`) and drag-from-palette to a canvas insertion point are supported. New widget immediately receives `selectedWidgetId` focus in the compose pane.

---

### XS-CANVAS-002 — Move and resize widgets

**Status: ✅ Implemented**

DnD reorder between rows and within rows is fully implemented using native HTML5 APIs in `StudioCanvas.tsx`. Widget resize via a 12-column drag handle is also implemented (see XS-LAYOUT-002).

---

### XS-CANVAS-003 — Widget focus model

**Status: ✅ Implemented**

`state.shell.selectedWidgetId` is set on click (and on keyboard activate). The selected widget card shows a highlighted border (`outlineColor: 'primary.main'`). The Compose drawer immediately switches to that widget's config panel (`WidgetConfigView`). Clicking the canvas background deselects (`selectedWidgetId: undefined`).

---

### XS-CANVAS-004 — Alignment guides

**Status: ❌ Not implemented**

No visual alignment snapping lines or guides during drag. The row-based model provides implicit row alignment but no column alignment guides across rows.

---

## 7C. Widget library and lifecycle

### XS-WIDGET-001 — Widget gallery

**Status: ✅ Implemented**

Seven widget types: `text`, `kpi`, `chart`, `grid`, `filter`, `pivot`, `map`. Each shown with an icon, label, and description in `AddWidgetView`. Drag target works for canvas insertion. ≤2 interactions from gallery to placed widget.

---

### XS-WIDGET-004 — KPI widget

**Status: ⚡ Implemented and surpasses AG Studio**

Full implementation in `StudioKpiWidget.tsx`:

- Aggregation modes: `sum`, `avg`, `count`, `countDistinct`, `min`, `max`.
- Prefix/suffix, compact number formatting (`kpiCompact`).
- Measure expression fields (`isMeasure: true`) evaluated via `expressionEvaluator.ts`.
- Sparkline via `SparkLineChart` with configurable time field, granularity (auto/day/week/month/quarter/year), plot type (line/bar), fill area, and cumulative (running-total) mode.
- **Cross-source sparkline join:** `kpiSparklineSourceId` can reference a related source, and the sparkline time field is resolved via the relationships graph — not documented in AG Studio.
- **Auto-granularity:** When granularity is unset, the component auto-selects based on date range.
- Participates in cross-filtering: `StudioFilterManager.applyFilters()` applies page/widget/cross-filters before aggregation.

**Gap vs spec:** ~~No delta/trend comparison~~ Trend badge (W-13) and target line (W-14) are both implemented. No remaining gaps vs spec.

---

### XS-WIDGET-002 — Widget actions (duplicate, delete, settings)

**Status: ✅ Implemented**

`StudioWidgetCard.tsx` renders an action bar on hover/select with:

- **Duplicate** — `controller.duplicateWidget(widgetId)`.
- **Delete** — `controller.removeWidget(widgetId)` with confirmation.
- **Settings** — clicking opens the widget in the Compose drawer (same as canvas click).
  Both actions are available in edit mode only; the action bar is hidden in view mode.

---

### XS-WIDGET-003 — Widget export

**Status: ✅ Implemented**

- **CSV** (`StudioGridWidget.tsx`): Exports the current filtered dataset (cross-filters + page/widget filters applied) as a `.csv` file via a blob URL. Available in both edit and view modes.
- **PNG** (`StudioChartWidget.tsx`): Uses `html2canvas` / `SVGElement.toDataURL` approach to export the chart as a PNG. Available in both modes.

---

## 7D. Grid/table widget

### XS-GRID-001 — Data grid with virtualization

**Status: ✅ Implemented**

`StudioGridWidget.tsx` renders a `DataGridPremium` (`@mui/x-data-grid-premium`) inside a fixed-height container (`sx={{ height: widget.config.gridHeight ?? 400 }}`, `StudioGridWidget.tsx:330`). Because the grid has a bounded height rather than `autoHeight`, row virtualization is active — only the visible rows are rendered, so the widget scales to large datasets (validated at ~470k rows). The component also opts into `experimentalFeatures={{ virtualizerLayoutMode: 'controlled' }}` (`StudioGridWidget.tsx:378`) so the pinned summary row positions correctly at very large row counts. Sorting and column display are functional.

---

### XS-GRID-002 — Grouping and aggregation

**Status: ✅ Implemented**

`gridGroupByField` and `gridAggregations` config fields exist on widget state, and group-by controls are exposed in `GridSetupPanel`. These are wired through to `DataGridPremium`: `rowGroupingModel` is derived from `gridGroupByField` and `aggregationModel` (a `GridAggregationModel`) from `gridAggregations` (`StudioGridWidget.tsx:186-215`), both passed to the grid (`rowGroupingModel={rowGroupingModel}`, `aggregationModel={aggregationModel}`, `onAggregationModelChange={...}`). End-users get the Premium-tier row-group UI, so groups can be expanded/collapsed at runtime and aggregation functions are applied per column. Grouped columns are hidden from the data view via the controlled `columnVisibilityModel`.

---

### XS-GRID-003 — Table formatting (column visibility, format, alignment)

**Status: ✅ Implemented**

- Column visibility: `columnVisibilityModel` driven by `hiddenColumns` in widget config; toggled via the "Columns" button in the grid toolbar.
- Number formatting: `formatFieldValue` applies locale-based number formatting from the field type.
- **Per-column alignment** — `StudioGridColumn.align` (`'left' | 'center' | 'right'`). `buildGridColumnDefs` sets `align` and `headerAlign` **together**: a right-aligned column under a left-aligned header reads as a rendering bug, not as two controls. Left undefined when unconfigured, so the grid keeps its type-aware default (numbers right-aligned) rather than having it replaced by a fixed one. The case this exists for is a numeric id column, which is a number but reads as a label.
- **Per-column date format** — `StudioGridColumn.dateFormat`, one of `iso | numeric | short | long | monthYear | year | dateTime`, applied by `formatDateWithPreset` in `x-studio-core`.
- Both are exposed in the Compose drawer's Format tab via `GridColumnFormatSection`, with an "Automatic" option that writes `undefined` rather than a sentinel.

**Presets, not format strings** — the deliberate choice here. A preset localizes (a French dashboard gets French month names without its author having picked a French pattern), and it is a closed set, so a doc-authored or AI-authored value cannot smuggle in an arbitrary pattern. `dateFormat` survives a persisted document and an AI tool call, so the formatter also has to be defensive about values the UI cannot produce: an unknown preset falls through to the raw value, a `dateFormat` on a non-date column never reaches the formatter at all, and an unparseable value renders as itself rather than `Invalid Date` — a cell showing its own content is debuggable at the moment a reader most needs it to be.

Date-only values are anchored to UTC, matching the whole-day convention L1 and the filter engine already hold to; without it a bare `YYYY-MM-DD` renders as the previous day for every viewer west of UTC.

Covered by `dateFormatPresets.test.ts` (formatter semantics) and `StudioGridWidget.columnFormat.test.ts` (column-def wiring, asserted against `buildGridColumnDefs` rather than a rendered grid — checking a `GridColDef` property through a rendered `DataGridPremium` tests the grid, not this package).

---

### XS-GRID-004 — Pinned columns and pivot

**Status: ❌ Not implemented (Parity+ scope)**

No pinned columns, column ordering UI, or pivot mode. This is correctly deferred to Parity+ in the requirements.

---

## 7E. Chart widget

### XS-CHART-001 — Core chart types

**Status: ✅ Implemented**

Bar, line, and pie/donut charts are implemented in `StudioChartWidget.tsx` via `@mui/x-charts`. X-axis field, Y-axis field, and color/series field mapping all work. Pie/donut is toggled by `chartPieDonut` config flag.

---

### XS-CHART-002 — Additional chart types

**Status: ⚡ Implemented and surpasses AG Studio**

Ten chart types are implemented:
`bar`, `bar-stacked`, `bar-100`, `line`, `area`, `area-stacked`, `area-100`, `scatter`, `pie`, `donut`.

Beyond the spec, the implementation adds:

- **Date grouping on X-axis** (day/week/month/quarter/year) for time-series charts.
- **Multiple Y-series** support (up to N fields selectable as separate series).
- **Split-by (color/series) field** producing a multi-series chart from a single Y-field grouped by a categorical dimension.
- Type switching preserves compatible field mappings (for example, bar → line keeps x/y fields).

AG Studio's reference docs do not describe multi-series or date-grouping with this level of granularity.

---

### XS-CHART-003 — Chart interactivity and cross-filtering

**Status: ✅ Implemented**

- **Tooltips** via MUI X Charts' built-in tooltip component (shown on hover).
- **Series highlighting** on hover via MUI X Charts default behavior.
- **Cross-filter from click:** `onAxisClick` (bar/line/area) and `onItemClick` (pie) emit `crossFilter` updates to the store, filtering all other bound widgets. A "Clear cross-filter" button appears in the widget action bar when a cross-filter is active.

---

### XS-CHART-004 — Advanced chart families (histogram, treemap, gauge, heatmap)

**Status: ⚡ Substantially implemented and surpasses AG Studio**

Heatmap (`StudioHeatmapWidget`), funnel (`StudioFunnelWidget`), Gantt (`StudioGanttWidget`), and gauge are all implemented — surpassing AG Studio's chart offering. Only histogram and treemap remain unimplemented.

**Remaining gap:** Histogram and Treemap chart types are absent. MUI X Charts does not yet ship these types; correctly deferred.

---

## 7F. Data model and source management

### XS-DATA-001 — Multiple data sources

**Status: ✅ Implemented**

`StudioDataSource` (in `models/studio.ts`) stores `id`, `label`, `fields`, `rows`. Multiple sources are held in `state.dataSources` (keyed by id). `StudioDataDrawer.tsx` lists all sources with collapsible field lists, field types, and expression field badges. Widgets bind to a source via `widgetSourceId`.

---

### XS-DATA-002 — Source relationships

**Status: ✅ Implemented**

`StudioRelationship` model (`from`, `to`, `fromField`, `toField`, `type: 'many-to-one' | 'one-to-one'`) is defined and stored in `state.relationships`. `getReachableSourceIds(sourceId, relationships)` utility resolves the transitive join graph. This powers cross-source field access in chart multi-series and KPI sparkline configs.

**Surpasses AG Studio:** AG Studio's reference page mentions a `sharedDataEngine` concept but does not detail a declarative relationship/join model at this level. The MUI X implementation's explicit relationship graph is more transparent.

---

### XS-DATA-003 — Calculated fields and measures

**Status: ⚡ Implemented and surpasses AG Studio**

Full AST expression evaluator in `utils/expressionEvaluator.ts`:

- **Operators:** `+`, `-`, `*`, `/`, `%`, `==`, `!=`, `<`, `<=`, `>`, `>=`, `&&`, `||`, `!`, `if`, `in`, `isNull`, `isNotNull`, `datediff`.
- **Two evaluation modes:** per-row (dimension fields) and aggregate (measure, evaluates over the filtered dataset).
- Expression field dialog in `StudioDataDrawer.tsx`: live AST preview, operator picker, field selector, validation (`validateExpressionField`).
- `isMeasure: true` flag on `StudioExpressionField` drives aggregate vs. row-level evaluation.

AG Studio's docs mention `expressionFields` as a config key but provide no detail on the expression language or authoring UI.

---

### XS-DATA-004 — Async data source loading

**Status: ✅ Implemented**

`StudioDataSourceAdapter` provides a `getData()` callback pattern with loading state, error state, and refresh lifecycle (commit BL-45 / D-04). The adapter is used by the host to supply async data without blocking the UI.

---

## 7G. Filtering and cross-filtering

### XS-FILTER-001 — Page and widget filters

**Status: ⚡ Implemented and surpasses AG Studio**

`StudioFiltersDrawer` renders page-scope and widget-scope filter rows. Rich operator set (15+): `equals`, `notEquals`, `contains`, `notContains`, `startsWith`, `endsWith`, `greaterThan`, `lessThan`, `greaterThanOrEqual`, `lessThanOrEqual`, `before`, `after`, `isNull`, `isNotNull`, `isTrue`, `isFalse`.

**Surpasses AG Studio:**

- **Relative date values** (`RelativeDateValue` type): filter values like "5 days ago", "2 weeks from now" using `past`/`next` + unit — not in AG Studio's public filter API.
- **`StudioMetricRef`** — filter values dynamically driven by an aggregated business metric from a named data source row (for example, "filter where value > max(kpiSource, 'revenue')") — not documented in AG Studio.
- **Rank filter mode** (`filterMode: 'rank'`): top-N / bottom-N rows by a measure field with configurable `rankDirection` and count — not in AG Studio docs.
- **Selection filter mode** (`filterMode: 'selection'`): filter by a set of selected values (multi-value checkbox list) — not in AG Studio docs.
- Filter counts shown as badge on the Filters drawer tab.

---

### XS-FILTER-002 — Cross-filtering

**Status: ✅ Implemented**

Grid row selection emits cross-filter updates (`StudioGridWidget.tsx` row click). Chart axis click (`onAxisClick`) and item click (`onItemClick`) emit cross-filters. The `crossFilters` section of the Filters drawer shows active cross-filters with clear buttons. `clearAllCrossFilters()` on the controller wipes all cross-filters at once.

---

### XS-FILTER-003 — Filter panel visibility and inspection

**Status: ✅ Implemented**

The Filters drawer groups filters into three collapsible sections: "Page filters", per-widget "Widget filters", and "Cross-filters". Each section has an Add button and shows the count of active filters. Individual filter rows show the field name, operator, and value; each row has a remove (×) button.

---

## 7H. Edit panel and authoring controls

### XS-EDIT-001 — Contextual edit panel

**Status: ✅ Implemented**

`WidgetConfigView` in `StudioComposeDrawer.tsx` renders Setup and Format tabs (for non-text widgets). Setup tab hosts `GridSetupPanel`, `ChartSetupPanel`, or `KpiSetupPanel` according to widget type. Format tab hosts `FormatPanel` (title/subtitle with auto-infer and reset, KPI compact mode). Text widgets show `TextSetupPanel` only (no tabs). No-widget-selected state shows the widget gallery and page config tabs.

---

### XS-EDIT-002 — Validation UX

**Status: ✅ Implemented**

- `Alert` shown in chart/KPI/grid setup panels when no data source is bound.
- Expression field dialog calls `validateExpressionField` and disables "Save" when invalid.
- Implicit guards: add-series button disabled when all available fields are used.
- **Inline filter validation** — `FilterBody` reuses `isConditionComplete(operator, value)`, the same predicate the engine uses to decide whether a condition participates, and renders a warning `Alert` when a condition filter has no value the operator can use. Reusing the engine's own predicate rather than writing a UI-side one is what keeps the warning honest: it appears exactly when the filter is being ignored, and cannot drift into warning about filters that do apply, or staying silent about ones that don't.

**`role="status"`, not `role="alert"`** — a deliberate departure from what this entry originally called for. The message is a running commentary on a half-finished form, so an assertive live region would interrupt the user mid-keystroke on every partially typed condition. Polite announcement is the APG-correct register for editing feedback; `alert` is for something that has gone wrong, and an incomplete filter has not yet.

Covered by `FilterBody.test.tsx`.

---

### XS-EDIT-003 — Field capability hints and mapping suggestions

**Status: ✅ Implemented**

`utils/fieldCapabilities.ts` defines a typed capability system: each field carries `numeric`, `categorical`, `temporal`, `rankTarget` capabilities, and the Setup-panel pickers filter options by capability. That answers _what is legal here_.

`suggestFieldsForRole(fields, role, limit)` in `x-studio-core` answers the other question — _what did you probably mean_ — which is the one a source with forty columns actually poses. `DataSourceFieldSelect` takes a `suggestFor` role (`dimension | measure | temporal`) and hoists up to three scored fields into a "Suggested" group above the full list; the chart, KPI and pivot setup panels pass the role appropriate to each mapping slot.

Three properties are worth recording, because each is a decision rather than a detail:

- **The demotions carry more value than the promotions.** An id column is numeric, so a capability-only filter offers it as a measure — and summing order ids is the canonical meaningless dashboard. Identifiers are ranked below every other numeric field.
- **Demoted, never excluded.** A source whose only numeric column is `code` should suggest something rather than nothing; the user can see it is an id as well as the heuristic can.
- **Hints match whole name segments, not substrings.** `includes('id')` matches "video", "width" and "identity" — a substring rule would demote three good fields on the strength of two letters.

The heuristic reads field metadata only, never row data, because the pickers render before any query has run. Ties keep source order, the declared field order being the closest thing to an intentional ranking that exists. Covered by `fieldSuggestions.test.ts`.

---

### XS-EDIT-004 — Page theming controls

**Status: ✅ Implemented**

`PageConfigPanel` in `StudioComposeDrawer.tsx` provides:

- Page background color (native `<input type="color">` + hex text field).
- Card background color.
- Card padding (None / Small / Medium / Large).
- Card corner radius (px input).
- Card border toggle, border color, border width.

All values persist in `StudioPageTheme` on `state.pages[id].theme`. Canvas reads theme in `StudioCanvas.tsx`.

**Gap vs spec:** No dashboard-level typography or spacing controls (font family, base font size) — the spec mentions these as stretch goals and AG Studio relies on its own theme system.

---

## 7I. State, persistence, and APIs

### XS-STATE-001 — State serialization and load

**Status: ✅ Implemented**

`StudioController.serializeState()` → `statePersistence.serializeState()` produces a plain JSON object covering: `schemaVersion`, `pages`, `widgetRows`, `widgets`, `dataSources`, `relationships`, `expressionFields`, `filters`, `dashboardTitle`. Shell state and cross-filters are intentionally excluded.

`loadSerializedState(json)` → `statePersistence.deserializeState()` validates the schema version and runs the migration pipeline before calling `controller.setState()`.

`downloadState()` and `uploadState()` utilities (in `statePersistence.ts`) wrap save/load with browser file-download / file-picker APIs — a convenience not present in AG Studio's public API.

---

### XS-STATE-002 — Schema versioning and migration

**Status: ✅ Implemented**

`CURRENT_SCHEMA_VERSION = 1` is defined. `migrateState()` runs a sequential pipeline: the state is validated against its `schemaVersion` field and each registered migration function runs in order. Currently only v1 is defined (no migration function needed yet), but the pipeline is already wired so adding `v1 → v2` is a one-line addition.

**Surpasses AG Studio:** AG Studio's public state docs do not describe versioning or migration. The schema-version + migration pipeline from day 1 is a forward-compatibility advantage.

---

### XS-STATE-003 — Autosave / dirty-state indicator

**Status: ✅ Implemented**

`StudioController.isDirty()` reports whether the document has changed since the host last called `markSaved()`, and `useStudioIsDirty()` exposes it to React. `loadSerializedState` re-baselines, because loading is not editing — without that, a host renders "unsaved changes" on a dashboard the user has not opened yet.

**Where the boundary sits.** The package persists nothing, so "saved" can only mean "since the host last said so": the host owns _when_ to save, the controller answers _whether there is anything to save_. That split is what makes this implementable at all — only the controller knows whether the document actually changed, as opposed to whether something merely happened. The top bar remains the host's to compose; what was missing was the fact to render, not the chrome.

**Reference identity, not an edit counter.** `isDirty()` is `state.doc !== savedDoc`. Three consequences, and the third is the one that makes it the right mechanism rather than merely the cheap one:

- Session and runtime changes never register. Switching to view mode or changing the selection is not an unsaved change, and an indicator that said so would train users to ignore it.
- `markSaved()` on an unchanged document is free — a host autosave tick costs nothing.
- **Undoing an edit back to the saved document reads clean again.** Undo restores the `StudioDoc` snapshot from the history stack — the same object that was current before the edit — so the saved reference comes back and the dashboard is genuinely unmodified. An "edits since save" counter reports this as dirty forever, which is wrong in the most annoying possible way: the user undid their change and the app still refuses to let them leave.

`markSaved()` changes no state, only the baseline, so it publishes a fresh state _wrapper_ with all three partitions reference-identical. Without the notification a saved indicator would keep reading "unsaved" until some unrelated commit re-rendered it; because the partitions are unchanged, every slice-based `useStudioSelector` bails out on `Object.is` and only the consumers actually reading `isDirty()` re-render.

Covered by `StudioController.dirty.test.ts`.

---

### XS-STATE-004 — Code / config generation

**Status: ❌ Not implemented (Parity+ scope)**

No "Export as code" or "Copy config" feature. Correctly deferred.

---

## 7J. Accessibility and keyboard support

### XS-A11Y-001 — Full keyboard authoring flow

**Status: ✅ Implemented**

**Implemented:**

- Tab-order through drawers and widget cards works correctly.
- `Enter`/`Space` activate drawers and select widgets.
- Undo (`Cmd+Z` / `Ctrl+Z`) and redo (`Cmd+Shift+Z` / `Ctrl+Y`) are keyboard-accessible via `StudioController.ts` event listeners.
- Filter remove buttons and drawer toggle buttons are keyboard-accessible.

**Closed (2026-08-08):**

- **Delete/Backspace removes the selected widget** (`useStudioKeyboardShortcuts`). Deliberately
  unmodified — the convention every canvas editor uses — and guarded four ways, because an
  unmodified destructive key is easy to fire by accident: not while focus is in an editable target,
  edit mode only, a widget actually selected, and the selection must still exist in the doc (a
  stale id survives an undo that removed the widget).
- **Arrow keys move the focused widget** (`StudioWidgetCard`). The capability existed but only
  behind the card's action menu, so a keyboard author could reorder the canvas, just never
  directly. Routed through the same `handleMoveWidget` the menu uses, and gated on the event's
  target being the card itself — arrow keys inside a descendant (a grid's cell navigation, a
  Select, a text caret) belong to that descendant.
- **Delete/Backspace also acts on the FOCUSED card**, which is not always the selected one: Tab
  moves focus without selecting.
- **`aria-describedby` announces the available keys** on a focused card, in edit mode only.
- **Focus is restored after a keyboard delete.** Deleting the focused card otherwise strands focus
  on `<body>`; it now moves to the canvas landmark.

**Deliberately NOT implemented — a focus trap on the compose drawer.** The original gap asked for
one, and it is the wrong fix twice over. A focus trap belongs in a modal dialog and nowhere else
(ARIA APG is explicit); the compose drawer is a non-modal side panel, and trapping focus in one
strands a keyboard user who wants to get back to the canvas. And auto-moving focus to the drawer on
selection would directly break the arrow-key move added above: selecting a card with Enter and then
pressing an arrow is the primary keyboard authoring gesture, and it stops working the instant
selection yanks focus into a panel. The drawer already announces itself when it opens
(`DrawerPanel`), which is what the underlying need actually was.

---

### XS-A11Y-002 — ARIA live regions and semantic structure

**Status: ✅ Implemented**

**Implemented:**

- `aria-label` on all three drawer panels.
- `aria-selected` on selected widget card.
- `role="button"` on drawer toggle targets.
- `role="list"` / `role="listitem"` on widget rows and cards.
- Some `aria-live` regions already exist for widget-level state: `aria-live="polite"` on the pivot widget (`StudioPivotWidget.tsx:73`) and the no-data overlay (`StudioNoDataOverlay.tsx:23`), and `role="alert"` / `aria-live="assertive"` on the widget error overlay (`StudioWidgetErrorOverlay.tsx:27`).

**Closed (2026-08-08):**

- **Mode changes are announced**, naming the mode rather than just saying it changed. This is the
  largest state change in the product and it moves no focus: edit-only chrome appears or vanishes
  around a user given no signal.
- **Widget deletion is announced.** Add and move already were; delete was the omission. Announced
  BEFORE the removal on the menu path, since a card cannot post to a live region while unmounting.
- **Filter rows are grouped under their section name** — `role="group"` + `aria-labelledby` on
  `CollapsibleSection`, rather than the `aria-describedby` the gap suggested. A description is read
  AFTER the row's own name, so "Region, page filters" arrives backwards, and it would repeat the
  section name on every row. The group announces it once, on entry, and generalises to the data and
  compose drawers rather than only the filters.

**Was already implemented when this was written:** the skip-to-canvas landmark exists
(`component="main"` in `StudioContent`, with `aria-label`). It has since gained `tabIndex={-1}` so
it can also receive focus after a keyboard delete.

---

### XS-A11Y-003 — Reduced-motion support

**Status: ❌ Not implemented (Parity+ scope)**

No `@media (prefers-reduced-motion: reduce)` CSS in the components. Collapse transitions in `DrawerPanel.tsx` use MUI `Collapse` which internally honours `prefers-reduced-motion` in MUI v6+, but this is not explicitly tested or documented.

---

## 7K. Performance and reliability

### XS-PERF-001 — 60 fps drag

**Status: ✅ Implemented** (measured as a render-cost invariant, not as a frame count)

This entry described the HTML5 drag-and-drop API; the canvas has since moved to
`@atlaskit/pragmatic-drag-and-drop` (`useStudioDraggable` / `useStudioDropTarget`).

`src/components/StudioCanvas/dragRenderCost.test.tsx` (2026-08-08) pins the property that
determines the frame rate. A frame measurement in CI would be flaky, machine-dependent, and would
report that a regression happened without saying what caused it. There is exactly one way for this
design to drop frames during a drag: if the hover highlight lived in shared state — canvas state,
the controller store, a context — every pointer move would re-render every widget and the cost
would scale with dashboard size.

It does not. `useStudioDropTarget` holds `isOver` in LOCAL state, and the suite asserts the
consequences: only the target whose hover state changed re-renders; widget bodies do not re-render
while the pointer crosses targets; and the per-hover cost is identical with 4 targets and with 20.

**What this does not prove:** that the drag is fast for reasons unrelated to renders. The test
module says so explicitly rather than implying a profiler was run.

---

### XS-PERF-002 — Large dataset grid performance

**Status: ✅ Implemented**

`StudioGridWidget.tsx` renders `DataGridPremium` in a fixed-height container (`sx={{ height: widget.config.gridHeight ?? 400 }}`) rather than `autoHeight`, so row virtualization is active and only the visible rows are rendered regardless of dataset size. This has been exercised at ~470k rows (the reason for the `virtualizerLayoutMode: 'controlled'` opt-in, which keeps the pinned summary row positioned correctly past browser CSS height limits). The Premium tier also provides row grouping and column virtualization for wide datasets.

---

### XS-PERF-003 — Code splitting

**Status: ❌ Not assessed (Parity+ scope)**

No dynamic imports or `React.lazy` boundaries within the package. Correctly deferred.

---

### XS-PERF-004 — Memory leak prevention

**Status: ✅ Implemented**

The previous assessment was a reading, not a test: it observed that `subscribe()` returns an
unsubscribe function and that undo history is capped, and concluded there were "no obvious leaks".
That claim stops being true silently — a leak has no symptom until a host has mounted and unmounted
a dashboard a few hundred times, which is what a route change in a SPA does.

`src/internals/lifecycleLeaks.test.tsx` (2026-08-08) asserts every retention vector this package
actually has, each against something observable rather than a profiler:

- **Store subscriptions** — the store's `listeners` Set is counted directly before and after
  unmount, and across five mount/unmount cycles. A retained listener also re-renders a detached
  tree on every commit, so it costs CPU as well as memory.
- **The window keydown listener** — every `keydown` registration is matched by a removal.
- **`lastFocusedRoot`** — a module-level strong reference to a DOM node, which would pin the whole
  detached subtree for the lifetime of the page. It is the one vector that survives the controller
  being collected.
- **The live region's pending timeout** — a 50 ms timer that would otherwise fire into an unmounted
  component.
- **`studioRequestCache`** — the module-level singleton shared by every instance, so its growth is
  bounded by nothing else. Asserted to evict rather than grow with every distinct query.

---

## 7L. Collaboration, sharing, and export

### XS-COLLAB-001 — Real-time collaboration

**Status: ❌ Not implemented (Parity+ scope)**

Single-user only. No presence indicators, conflict resolution, or operational-transform mechanism.

---

### XS-EXPORT-001 — CSV export

**Status: ✅ Implemented**

Grid CSV export applies all active filters (page, widget, cross-filter) before download. File is named `{widgetTitle}.csv`. Implemented in `StudioGridWidget.tsx`.

---

### XS-EXPORT-002 — PNG export

**Status: ✅ Implemented (ahead of Parity+ schedule)**

Chart PNG export is implemented in `StudioChartWidget.tsx`. The chart SVG is serialised and offered as a `.png` download. This was a Parity+ item in the roadmap but is already shipped.

---

### XS-AI-001 — AI assistant

**Status: ⚡ Fully implemented and surpasses AG Studio**

`StudioChatPanel` provides a full AI chat assistant with streaming responses, a tool suite for NL widget creation/configuration, and context-aware suggestions. NL-driven widget creation (`DescribeWidgetSection` in `AddWidgetView`) is also integrated into the compose flow (commits A-07, C-13).

---

## Summary table

| Requirement                       | Status | Key gap                                                |
| :-------------------------------- | :----- | :----------------------------------------------------- |
| XS-LAYOUT-001 Shell/drawers       | ✅     | Drawer open state not serialized (resets on reload)    |
| XS-LAYOUT-002 Canvas layout       | ✅     | Resize via 12-col drag handle implemented              |
| XS-LAYOUT-003 Layout presets      | ❌     | Not implemented                                        |
| XS-LAYOUT-004 Keyboard canvas     | ✅     | Arrow move, handle resize, Delete/Backspace            |
| XS-LAYOUT-005 Mobile/responsive   | ✅     | Tabbed sidebar below `md` in edit mode                 |
| XS-CANVAS-001 Add widgets         | ✅     | —                                                      |
| XS-CANVAS-002 Move/resize         | ✅     | DnD reorder + 12-col resize both work                  |
| XS-CANVAS-003 Focus model         | ✅     | —                                                      |
| XS-CANVAS-004 Alignment guides    | ❌     | Not implemented                                        |
| XS-WIDGET-001 Widget gallery      | ✅     | 7 types (text, kpi, chart, grid, filter, pivot, map)   |
| XS-WIDGET-004 KPI widget          | ⚡     | Exceeds spec (sparkline, trend, target, cross-source)  |
| XS-WIDGET-002 Widget actions      | ✅     | —                                                      |
| XS-WIDGET-003 Widget export       | ✅     | —                                                      |
| XS-GRID-001 Grid virtualization   | ✅     | DataGridPremium, fixed height, virtualized             |
| XS-GRID-002 Grouping/aggregation  | ✅     | `rowGroupingModel` + `aggregationModel` wired          |
| XS-GRID-003 Table formatting      | ✅     | Per-column align + localized date presets              |
| XS-GRID-004 Pinned/pivot          | ❌     | Parity+ — deferred                                     |
| XS-CHART-001 Core chart types     | ✅     | —                                                      |
| XS-CHART-002 Additional types     | ⚡     | 10 types; date grouping; multi-series; split-by field  |
| XS-CHART-003 Interactivity        | ✅     | —                                                      |
| XS-CHART-004 Advanced families    | ⚡     | Heatmap/funnel/Gantt/gauge done; histogram/treemap TBD |
| XS-DATA-001 Multiple sources      | ✅     | —                                                      |
| XS-DATA-002 Relationships         | ✅     | —                                                      |
| XS-DATA-003 Expression fields     | ⚡     | Full AST evaluator; GUI editor; measures               |
| XS-DATA-004 Async sources         | ✅     | `StudioDataSourceAdapter` implemented                  |
| XS-FILTER-001 Page/widget filters | ⚡     | Relative dates, MetricRef, rank mode, selection mode   |
| XS-FILTER-002 Cross-filtering     | ✅     | —                                                      |
| XS-FILTER-003 Filter visibility   | ✅     | —                                                      |
| XS-EDIT-001 Edit panel            | ✅     | —                                                      |
| XS-EDIT-002 Validation UX         | ✅     | Inline incomplete-filter warning via engine predicate  |
| XS-EDIT-003 Field hints           | ✅     | Capability filter + scored "Suggested" group           |
| XS-EDIT-004 Theming controls      | ✅     | —                                                      |
| XS-STATE-001 Serialization        | ✅     | —                                                      |
| XS-STATE-002 Schema migration     | ✅     | —                                                      |
| XS-STATE-003 Autosave/dirty       | ✅     | `isDirty()`/`markSaved()` by doc reference identity    |
| XS-STATE-004 Code generation      | ❌     | Parity+ — deferred                                     |
| XS-A11Y-001 Keyboard authoring    | ✅     | Full authoring flow reachable by keyboard              |
| XS-A11Y-002 ARIA/semantics        | ✅     | Live regions + labelled groups over per-row descs      |
| XS-A11Y-003 Reduced motion        | ❌     | Parity+ — deferred                                     |
| XS-PERF-001 60 fps drag           | ✅     | Pinned as a render-cost invariant, not a frame count   |
| XS-PERF-002 Large dataset grid    | ✅     | Fixed-height DataGridPremium; virtualized 470k+ rows   |
| XS-PERF-003 Code splitting        | ❌     | Parity+ — deferred                                     |
| XS-PERF-004 Memory leaks          | ✅     | Five retention vectors asserted observably             |
| XS-COLLAB-001 Collaboration       | ❌     | Parity+ — deferred                                     |
| XS-EXPORT-001 CSV                 | ✅     | —                                                      |
| XS-EXPORT-002 PNG                 | ✅     | Shipped ahead of Parity+ schedule                      |
| XS-AI-001 AI assistant            | ⚡     | Full chat + streaming + NL widget creation             |

---

## AG Studio features confirmed absent from MUI X Studio

These items appear in the AG Studio reference docs but have no counterpart in the current implementation:

| AG Studio feature                                             | AG Studio API                             | Status                                                                 |
| :------------------------------------------------------------ | :---------------------------------------- | :--------------------------------------------------------------------- |
| `panels` prop (configure which panels show and on which side) | `AgStudioPanelConfig`                     | Not implemented; drawers are hardcoded left/right                      |
| `overrides` prop (restrict widget types, customise panel)     | `AgStudioOverrides`                       | Not implemented                                                        |
| `mode` prop on component                                      | `mode: 'edit' \| 'view'`                  | `setMode()` exists on controller; no prop                              |
| `initialState` prop                                           | `initialState`                            | Pattern is `new StudioController(state)` instead                       |
| `onStateUpdated` event                                        | callback prop                             | Use `controller.subscribe()` instead                                   |
| `onApiReady` lifecycle                                        | callback prop                             | Not implemented                                                        |
| `onErrorRaised` lifecycle                                     | callback prop                             | Not implemented                                                        |
| Localisation / `localeText`                                   | `AgStudioLocale`                          | ✅ Implemented via `localeText` prop (A-12)                            |
| RTL support                                                   | `enableRtl`                               | Not implemented                                                        |
| AI panel                                                      | `ai`, `AgStudioAiModule`                  | ✅ Implemented — `StudioChatPanel` with streaming + NL widget creation |
| Async data sources                                            | `getData` callback                        | ✅ Implemented — `StudioDataSourceAdapter` (D-04)                      |
| Shared data engine                                            | `AgDataEngine`                            | ✅ Implemented — `StudioDataSourceAdapter` serves the same role        |
| AG Grid theme system                                          | `theme`, `studioTheme`, `withParams`      | Uses MUI theming instead                                               |
| Page dimensions                                               | `minWidth`, `maxWidth`, auto/fixed height | Not in layout model                                                    |
| Multiple-page UI                                              | page tabs / navigation                    | ✅ Implemented — page tabs rendered, pages model fully supported       |

---

## Capabilities that surpass AG Studio

These are present in the MUI X Studio implementation but are absent from or not described in AG Studio's public documentation:

| Feature                                               | Implementation location                                                           | Notes                                                                              |
| :---------------------------------------------------- | :-------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------- |
| **100-step undo/redo**                                | `StudioController.ts` (`MAX_HISTORY = 100`) + `Cmd+Z`/`Ctrl+Y` keyboard shortcuts | AG Studio has no public undo API                                                   |
| **Text/narrative widget**                             | `StudioTextWidget.tsx`                                                            | AG Studio documents grid, KPI, chart only                                          |
| **Pivot table widget**                                | `StudioPivotWidget.tsx`                                                           | AG Studio has no pivot table widget                                                |
| **Heatmap, funnel, Gantt chart widgets**              | `StudioHeatmapWidget`, `StudioFunnelWidget`, `StudioGanttWidget`                  | Surpasses AG Studio chart gallery                                                  |
| **Chart annotations / reference lines**               | Chart widget config (W-12)                                                        | Threshold and reference line overlays on charts                                    |
| **Mixed bar + line chart**                            | `StudioChartWidget.tsx` (W-07)                                                    | Dual-axis or overlaid bar+line; not in AG Studio                                   |
| **`StudioMetricRef`**                                 | `models/studio.ts` + filter UI                                                    | Dynamic filter values from business metric aggregation; not in AG Studio           |
| **Relative date filter values**                       | `filterTypes.ts` (`RelativeDateValue`)                                            | `past`/`next` + unit (day/week/month/etc.)                                         |
| **Rank filter mode**                                  | `StudioFiltersDrawer/RankFilterInput.tsx`                                         | Top-N / bottom-N by measure; not in AG Studio                                      |
| **Selection filter mode**                             | `StudioFiltersDrawer`                                                             | Checkbox multi-value filter mode                                                   |
| **Filter dependency / cascading**                     | F-06                                                                              | Cascading filter options driven by upstream selections                             |
| **Quick filter bar**                                  | F-04                                                                              | Inline filter bar widget for end-user self-service filtering                       |
| **Global filter search**                              | F-05                                                                              | Cross-widget global search filter                                                  |
| **Saved filter presets**                              | `filterPresets` in `StudioState` (C-09)                                           | Named saved filter configurations; not in AG Studio                                |
| **Shareable filter links / URL encoding**             | DB-09                                                                             | Filter state encoded into URL for sharing; not in AG Studio                        |
| **Dashboard date range filter bar**                   | DB-04                                                                             | Dedicated date range bar applying to all widgets on a page                         |
| **Drill-down / detail panel**                         | DB-05                                                                             | Row/item click opens a detail panel; not in AG Studio                              |
| **Data refresh simulation**                           | DB-07                                                                             | Simulated live data refresh via adapter; not in AG Studio                          |
| **Data lineage graph**                                | D-07, BL-48                                                                       | Visual graph showing source-to-widget data flow; not in AG Studio                  |
| **Visual expression builder**                         | C-12                                                                              | Drag-and-drop expression builder UI; AG Studio has no documented equivalent        |
| **Move widgets across pages**                         | C-10                                                                              | Cut/paste a widget to a different dashboard page; not in AG Studio                 |
| **Cross-source KPI sparkline**                        | `StudioKpiWidget.tsx`, `kpiSparklineSourceId`                                     | Join time field from related source                                                |
| **Auto-granularity sparkline**                        | `StudioKpiWidget.tsx`                                                             | Auto-selects day/week/month based on date range                                    |
| **Cumulative (running total) mode**                   | `StudioKpiWidget.tsx`, `kpiSparklineCumulative`                                   | Not in AG Studio KPI docs                                                          |
| **KPI trend badge + target line**                     | W-13, W-14                                                                        | Period-over-period trend badge and configurable target reference line              |
| **`crossFilterMode` per widget**                      | W-04a                                                                             | Per-widget opt-out or mode override for cross-filtering                            |
| **Full AST expression evaluator**                     | `utils/expressionEvaluator.ts`                                                    | AG Studio mentions expressionFields as config but documents no expression language |
| **Expression field authoring UI**                     | `StudioDataDrawer.tsx`                                                            | GUI tree editor for expression fields; AG Studio has no documented authoring UI    |
| **Field capability system**                           | `utils/fieldCapabilities.ts`                                                      | Overridable per-field `numeric`/`categorical`/`temporal` capabilities              |
| **`downloadState` / `uploadState`**                   | `store/statePersistence.ts`                                                       | Built-in file I/O helpers; AG Studio exposes `getState`/`setState` only            |
| **`schemaVersion` + migration pipeline**              | `store/statePersistence.ts`                                                       | AG Studio public docs do not describe state versioning                             |
| **Auto-inferred widget titles**                       | `StudioComposeDrawer.tsx` (`inferWidgetTitles`)                                   | Titles auto-generated from field names; reset-to-auto button                       |
| **Per-page theming**                                  | `PageConfigPanel` + `StudioPageTheme` model                                       | Background, card, padding, radius, border all configurable per page                |
| **10-type chart gallery**                             | `StudioChartWidget.tsx`                                                           | bar-stacked, bar-100, area-stacked, area-100, scatter; date grouping; multi-series |
| **Filters visible in both modes**                     | `Studio.tsx`                                                                      | AG Studio defaults filters to view-mode only                                       |
| **Embeddable SDK `StudioDashboard`**                  | A-05                                                                              | Consumer-facing read-only embed component; not in AG Studio                        |
| **Slot props chain**                                  | A-08                                                                              | Host can override inner component slots; AG Studio has no equivalent API           |
| **Server middleware `@mui/x-studio-data-middleware`** | A-10                                                                              | Companion server package for data adapters; not in AG Studio                       |
| **`sidebarLayout` / `sidebarSide` props**             | A-11                                                                              | Configurable sidebar position; AG Studio hardcodes panel positions                 |
| **Localisation / `localeText` prop**                  | A-12                                                                              | Full i18n string table; AG Studio's `localeText` is limited                        |
| **Feature flags**                                     | A-13                                                                              | Runtime feature toggles for gradual rollout; not in AG Studio                      |
| **AI chat assistant with streaming**                  | `StudioChatPanel` (A-07)                                                          | Full AI assistant; AG Studio's `AgStudioAiModule` is more limited                  |
| **Multi-source table columns**                        | `StudioGridWidget.tsx`                                                            | Grid columns from multiple joined sources in one table                             |
| **Custom widget API**                                 | `customWidgets` prop + `StudioCustomWidgetDef` (BL-99)                            | Host apps register arbitrary React widget components; AG Studio has no equivalent  |

---

## Parity floor — remaining items

These were written as "gaps to close before MVP", against §9 of the requirements. Since
[ADR 0003](./decisions/0003-ai-assistant-product-scope.md) that framing no longer holds: §9's MVP
boundary is a historical baseline, not the release criteria, and clearing this list is not the same
as being ready to ship.

What the list still is: the parity floor. Every item is something a dashboard product is expected to
have, so an entry left open here is a thing a prospective user will notice by its absence. Worth
tracking on those terms — just not worth mistaking for a plan.

1. ~~**XS-LAYOUT-002 / XS-CANVAS-002: Widget resize handles**~~ ✅ Done — 12-column resize handle implemented.
2. ~~**XS-GRID-002: Grid grouping**~~ ✅ Done — `rowGroupingModel` and `aggregationModel` are wired through `DataGridPremium`, giving runtime group expand/collapse.
3. ~~**XS-GRID-001: Virtualization**~~ ✅ Done — the grid uses a fixed-height `DataGridPremium`, so row virtualization is active (no `autoHeight`).
4. ~~**XS-A11Y-001 / XS-A11Y-002: ARIA live regions and keyboard delete**~~ ✅ Done — live regions, a labelled canvas group, `Delete`/`Backspace`, and arrow-key move/resize.
5. **XS-LAYOUT-001 (partial): Drawer state persistence** — the one remaining MVP item, and the only one that is a _decision_ rather than missing work. Drawer open state lives in the `session` partition, which is deliberately never serialized; persisting it means either widening `doc` (making a drawer toggle an undoable dashboard edit) or giving the host a separate shell-state channel. The second is the right shape, but it is a public-API addition, not a fix.

---

_All file references are under `packages/x-studio/src/` unless otherwise stated._
