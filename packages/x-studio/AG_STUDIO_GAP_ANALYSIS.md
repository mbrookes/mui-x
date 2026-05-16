# @mui/x-studio Gap Analysis vs AG Studio Clone Requirements

**Date:** 2026-04-29  
**Reviewer:** Copilot (automated code review)  
**Scope:** `packages/x-studio/src/` vs `AG_STUDIO_CLONE_REQUIREMENTS.md`  
**AG Studio reference:** https://www.ag-grid.com/studio/react/reference/

---

## Scoring key

| Symbol | Meaning                                                |
| ------ | ------------------------------------------------------ |
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

**Status: ⚠️ Partially implemented**

**Implemented:**

- Row-based layout model: `widgetRows: string[][]` per page.
- HTML5 drag-and-drop reorder via `StudioCanvas.tsx`; horizontal insertion points between rows and vertical insertion points within a row are highlighted on drag-over.
- Widgets auto-fill row width with `flex: 1`.
- Layout persists in state and is serialized.

**Gaps vs acceptance criteria:**

- **No resize handles.** Widgets cannot be resized by dragging. There is no `widgetWidths` or similar model field. `StudioCanvas.tsx` renders widgets as plain `Box` elements with `flex: 1`; no `react-resizable` or equivalent.
- **No minimum dimension enforcement.** The spec requires a 2×1 minimum tile but there is no guard.
- **Fixed equal-width columns only.** A row of N widgets always divides available width equally; non-uniform column widths are unsupported.

AG Studio uses a 12-column grid with pixel-level drag-resize. MUI X Studio uses a simpler "rows of equal tiles" model.

---

### XS-LAYOUT-003 — Layout presets

**Status: ❌ Not implemented**

No preset selector, no preset definitions anywhere in `packages/x-studio/src/`. The compose drawer's "Page" tab contains only theme controls (`PageConfigPanel`), not layout preset choices.

---

### XS-LAYOUT-004 — Keyboard canvas navigation

**Status: ⚠️ Partially implemented**

**Implemented:**

- Widget cards have `tabIndex={0}`, `role="listitem"`, `aria-selected` (set in `StudioWidgetCard.tsx`).
- `Enter`/`Space` select a widget and focus the Compose drawer.
- Drawers are keyboard-accessible (enter to open, Escape to close via `DrawerPanel`).

**Gaps:**

- No arrow-key move. Pressing arrow keys does not reposition the selected widget.
- No keyboard resize. There is no `Shift+Arrow` or similar mechanism.
- No `Delete`/`Backspace` shortcut to delete the selected widget from the canvas (the widget must be deleted from its action bar or via the Compose drawer).

---

### XS-LAYOUT-005 — Responsive / mobile layout

**Status: ❌ Not implemented**

`Studio.tsx` renders all three drawer slots unconditionally. There is no `useMediaQuery`/breakpoint logic that collapses drawers on narrow viewports or converts the layout to single-column.

---

## 7B. Canvas and widget placement

### XS-CANVAS-001 — Add widgets from gallery

**Status: ✅ Implemented**

`AddWidgetView` inside `StudioComposeDrawer.tsx` lists all four widget types (Text, KPI, Chart, Grid) with icons and descriptions. Both click-to-add (calls `controller.addWidget(...)`) and drag-from-palette to a canvas insertion point are supported. New widget immediately receives `selectedWidgetId` focus in the compose pane.

---

### XS-CANVAS-002 — Move and resize widgets

**Status: ⚠️ Partially implemented**

DnD reorder between rows and within rows is fully implemented using native HTML5 APIs in `StudioCanvas.tsx`. Snap-to-grid is effectively inherent in the row/tile model.

**Gap:** Resize is not implemented (see XS-LAYOUT-002).

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

Four widget types: `text`, `kpi`, `chart`, `grid`. Each shown with an icon, label, and description in `AddWidgetView`. Drag target works for canvas insertion. ≤2 interactions from gallery to placed widget.

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

**Gap vs spec:** No delta/trend comparison (current period vs. prior period) — the spec mentions this as a stretch goal. Not in AG Studio public docs either.

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

**Status: ⚠️ Partially implemented**

`StudioGridWidget.tsx` uses `<DataGrid>` (free tier from `@mui/x-data-grid`). Sorting and column display are functional.

**Gap:** The component passes `autoHeight` to the grid, which causes it to render all rows at once and disables row virtualization. For large datasets this will degrade performance and contradict the requirement. The spec calls for virtualized rendering; switching to `DataGridPro` with a fixed height container would satisfy this.

---

### XS-GRID-002 — Grouping and aggregation

**Status: ❌ Not implemented**

The free `DataGrid` does not support row grouping. No `rowGroupingModel`, `aggregationModel`, or similar is passed. The `StudioGridWidget.tsx` file has no grouping logic. This is a significant MVP gap since AG Studio's table widget prominently features grouping.

---

### XS-GRID-003 — Table formatting (column visibility, format, alignment)

**Status: ⚠️ Partially implemented**

**Implemented:**

- Column visibility: `columnVisibilityModel` driven by `hiddenColumns` in widget config; toggled via the "Columns" button in the grid toolbar.
- Number formatting: `formatFieldValue` utility applies locale-based number formatting based on field type.

**Gaps:**

- No per-column date format picker (e.g. `dd/MM/yyyy` vs `MMM yyyy`).
- No per-column text alignment control (left/center/right).
- Changes to formatting are not surfaced as UI controls in the Compose drawer's Format tab (only title/subtitle and compact mode appear in `FormatPanel`).

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
- Type switching preserves compatible field mappings (e.g., bar → line keeps x/y fields).

AG Studio's reference docs do not describe multi-series or date-grouping with this level of granularity.

---

### XS-CHART-003 — Chart interactivity and cross-filtering

**Status: ✅ Implemented**

- **Tooltips** via MUI X Charts' built-in tooltip component (shown on hover).
- **Series highlighting** on hover via MUI X Charts default behavior.
- **Cross-filter from click:** `onAxisClick` (bar/line/area) and `onItemClick` (pie) emit `crossFilter` updates to the store, filtering all other bound widgets. A "Clear cross-filter" button appears in the widget action bar when a cross-filter is active.

---

### XS-CHART-004 — Advanced chart families (histogram, treemap, gauge, heatmap)

**Status: ❌ Not implemented (Parity+ scope)**

None of histogram, treemap, gauge, or heatmap are implemented. MUI X Charts does not yet ship all of these types. Correctly deferred.

---

## 7F. Data model and source management

### XS-DATA-001 — Multiple data sources

**Status: ✅ Implemented**

`StudioDataSource` (in `models/studio.ts`) stores `id`, `label`, `fields`, `rows`. Multiple sources are held in `state.dataSources` (keyed by id). `StudioDataDrawer.tsx` lists all sources with collapsible field lists, field types, and expression field badges. Widgets bind to a source via `widgetSourceId`.

---

### XS-DATA-002 — Source relationships

**Status: ✅ Implemented**

`StudioRelationship` model (`from`, `to`, `fromField`, `toField`, `type: 'many-to-one' | 'one-to-one'`) is defined and stored in `state.relationships`. `getReachableSourceIds(sourceId, relationships)` utility resolves the transitive join graph. This powers cross-source field access in chart multi-series and KPI sparkline configs.

**Surpasses AG Studio:** AG Studio's reference page mentions a `sharedDataEngine` concept but does not detail a declarative relationship/join model at this level. The MUI X implementation's explicit relationship graph is more transparent.

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

**Status: ❌ Not implemented (Parity+ scope)**

All data sources are synchronous (`rows: Record<string, unknown>[]`). There is no `getData()` callback pattern, loading state, error state, or refresh lifecycle. No `AgDataEngine` equivalent. Correctly deferred to Parity+.

---

## 7G. Filtering and cross-filtering

### XS-FILTER-001 — Page and widget filters

**Status: ⚡ Implemented and surpasses AG Studio**

`StudioFiltersDrawer` renders page-scope and widget-scope filter rows. Rich operator set (15+): `equals`, `notEquals`, `contains`, `notContains`, `startsWith`, `endsWith`, `greaterThan`, `lessThan`, `greaterThanOrEqual`, `lessThanOrEqual`, `before`, `after`, `isNull`, `isNotNull`, `isTrue`, `isFalse`.

**Surpasses AG Studio:**

- **Relative date values** (`RelativeDateValue` type): filter values like "5 days ago", "2 weeks from now" using `past`/`next` + unit — not in AG Studio's public filter API.
- **`StudioMetricRef`** — filter values dynamically driven by an aggregated business metric from a named data source row (e.g. "filter where value > max(kpiSource, 'revenue')") — not documented in AG Studio.
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

**Status: ⚠️ Partially implemented**

**Implemented:**

- `Alert` shown in chart/KPI/grid setup panels when no data source is bound.
- Expression field dialog calls `validateExpressionField` and disables "Save" when invalid.
- Some implicit guards: add-series button disabled when all available fields are used.

**Gaps:**

- No inline validation on filter field/operator/value inputs (e.g., no error shown for a blank value on an `equals` filter).
- No comprehensive form validation on the Compose drawer inputs.
- No accessible `role="alert"` live region for validation messages.

---

### XS-EDIT-003 — Field capability hints and mapping suggestions

**Status: ⚠️ Partially implemented**

`utils/fieldCapabilities.ts` defines a typed capability system: each field carries `numeric`, `categorical`, `temporal`, `rankTarget` capabilities. The field pickers in Setup panels filter options by capability (e.g., only temporal fields appear in the date-group selector).

**Gap:** No proactive "suggested mapping" UI. When a new widget is created and a source is selected, the app doesn't auto-suggest which field to map where. The spec calls for a short list of recommended fields shown at the top of each picker.

---

### XS-EDIT-004 — Page theming controls

**Status: ✅ Implemented**

`PageConfigPanel` in `StudioComposeDrawer.tsx` provides:

- Page background colour (native `<input type="color">` + hex text field).
- Card background colour.
- Card padding (None / Small / Medium / Large).
- Card corner radius (px input).
- Card border toggle, border colour, border width.

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

**Status: ⚠️ Partially implemented**

`controller.subscribe(listener)` fires on every state change, enabling a consuming app to implement autosave. No throttled autosave hook is built into the package itself. There is no `isDirty` flag or "Unsaved changes" UI element in `Studio.tsx`. The top bar (mode switcher, save/load buttons) is not part of the component; consuming apps are expected to compose these via slots.

**Gap:** The spec's AC3 ("Unsaved changes indicator visible") is unmet. Consuming apps can build this via `subscribe`, but the out-of-box Studio chrome does not include it.

---

### XS-STATE-004 — Code / config generation

**Status: ❌ Not implemented (Parity+ scope)**

No "Export as code" or "Copy config" feature. Correctly deferred.

---

## 7J. Accessibility and keyboard support

### XS-A11Y-001 — Full keyboard authoring flow

**Status: ⚠️ Partially implemented**

**Implemented:**

- Tab-order through drawers and widget cards works correctly.
- `Enter`/`Space` activate drawers and select widgets.
- Undo (`Cmd+Z` / `Ctrl+Z`) and redo (`Cmd+Shift+Z` / `Ctrl+Y`) are keyboard-accessible via `StudioController.ts` event listeners.
- Filter remove buttons and drawer toggle buttons are keyboard-accessible.

**Gaps:**

- No keyboard shortcut to delete the selected widget.
- No arrow-key canvas navigation (move widget up/down/left/right in the row grid).
- No focus trap or managed focus for the compose drawer after widget selection (focus does not auto-move to the drawer).

---

### XS-A11Y-002 — ARIA live regions and semantic structure

**Status: ⚠️ Partially implemented**

**Implemented:**

- `aria-label` on all three drawer panels.
- `aria-selected` on selected widget card.
- `role="button"` on drawer toggle targets.
- `role="list"` / `role="listitem"` on widget rows and cards.

**Gaps:**

- No `aria-live="polite"` region for mode changes (edit → view).
- No live announcement when a widget is added, moved, or deleted.
- No skip-to-canvas landmark (`role="main"` or `<main>`).
- No `aria-describedby` linking filter rows to their section headers.

---

### XS-A11Y-003 — Reduced-motion support

**Status: ❌ Not implemented (Parity+ scope)**

No `@media (prefers-reduced-motion: reduce)` CSS in the components. Collapse transitions in `DrawerPanel.tsx` use MUI `Collapse` which internally honours `prefers-reduced-motion` in MUI v6+, but this is not explicitly tested or documented.

---

## 7K. Performance and reliability

### XS-PERF-001 — 60 fps drag

**Status: ⚠️ Partially implemented**

HTML5 drag-and-drop in `StudioCanvas.tsx` uses the native browser DnD API, which is generally 60 fps. Insertion-point highlights are updated via React state (`dragOverTarget`), which may cause re-renders but should be fast for typical dashboard sizes (≤20 widgets).

**Gap:** No performance measurement or test exists. The spec requires "no frame drop measured with React DevTools Profiler" — this has not been verified in the implementation.

---

### XS-PERF-002 — Large dataset grid performance

**Status: ⚠️ Partially implemented**

`StudioGridWidget.tsx` passes `pagination` and `pageSizeOptions={[5, 10, 25]}` to the grid, which limits rendered rows. However, `autoHeight` is also passed, which renders all rows of the current page at their natural height — there is no row virtualization within a page. For page size 25 this is acceptable; for larger page sizes it degrades.

**Gap:** The `DataGrid` free tier (used here) does not support row grouping or full column virtualization for wide datasets. Upgrading to `DataGridPro` would unlock these.

---

### XS-PERF-003 — Code splitting

**Status: ❌ Not assessed (Parity+ scope)**

No dynamic imports or `React.lazy` boundaries within the package. Correctly deferred.

---

### XS-PERF-004 — Memory leak prevention

**Status: ⚠️ Partially assessed**

`StudioController.subscribe()` returns an unsubscribe function. `Studio.tsx` passes the controller via React context; no obvious event listener leaks. Undo/redo history is capped at 100 steps (`MAX_HISTORY = 100` in `StudioController.ts`). No memory profiling tests exist.

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

**Status: ❌ Not implemented (Parity+ scope)**

No AI panel, natural language chart creation, or field suggestion. AG Studio's `ai` prop and `AgStudioAiModule` have no counterpart. Correctly deferred.

---

## Summary table

| Requirement                       | Status | Key gap                                                 |
| --------------------------------- | ------ | ------------------------------------------------------- |
| XS-LAYOUT-001 Shell/drawers       | ✅     | Drawer open state not serialized (resets on reload)     |
| XS-LAYOUT-002 Canvas layout       | ⚠️     | No widget resize handles                                |
| XS-LAYOUT-003 Layout presets      | ❌     | Not implemented                                         |
| XS-LAYOUT-004 Keyboard canvas     | ⚠️     | No arrow-key move/resize                                |
| XS-LAYOUT-005 Mobile/responsive   | ❌     | Not implemented                                         |
| XS-CANVAS-001 Add widgets         | ✅     | —                                                       |
| XS-CANVAS-002 Move/resize         | ⚠️     | No resize; DnD reorder works                            |
| XS-CANVAS-003 Focus model         | ✅     | —                                                       |
| XS-CANVAS-004 Alignment guides    | ❌     | Not implemented                                         |
| XS-WIDGET-001 Widget gallery      | ✅     | —                                                       |
| XS-WIDGET-004 KPI widget          | ⚡     | Exceeds spec (sparkline, cross-source join, cumulative) |
| XS-WIDGET-002 Widget actions      | ✅     | —                                                       |
| XS-WIDGET-003 Widget export       | ✅     | —                                                       |
| XS-GRID-001 Grid virtualization   | ⚠️     | `autoHeight` disables row virtualization; free DataGrid |
| XS-GRID-002 Grouping/aggregation  | ❌     | Not implemented                                         |
| XS-GRID-003 Table formatting      | ⚠️     | No date format per-column, no alignment control         |
| XS-GRID-004 Pinned/pivot          | ❌     | Parity+ — deferred                                      |
| XS-CHART-001 Core chart types     | ✅     | —                                                       |
| XS-CHART-002 Additional types     | ⚡     | 10 types; date grouping; multi-series; split-by field   |
| XS-CHART-003 Interactivity        | ✅     | —                                                       |
| XS-CHART-004 Advanced families    | ❌     | Parity+ — deferred                                      |
| XS-DATA-001 Multiple sources      | ✅     | —                                                       |
| XS-DATA-002 Relationships         | ✅     | —                                                       |
| XS-DATA-003 Expression fields     | ⚡     | Full AST evaluator; GUI editor; measures                |
| XS-DATA-004 Async sources         | ❌     | Parity+ — deferred                                      |
| XS-FILTER-001 Page/widget filters | ⚡     | Relative dates, MetricRef, rank mode, selection mode    |
| XS-FILTER-002 Cross-filtering     | ✅     | —                                                       |
| XS-FILTER-003 Filter visibility   | ✅     | —                                                       |
| XS-EDIT-001 Edit panel            | ✅     | —                                                       |
| XS-EDIT-002 Validation UX         | ⚠️     | No inline validation on filter inputs                   |
| XS-EDIT-003 Field hints           | ⚠️     | Capability system exists; no proactive suggestions      |
| XS-EDIT-004 Theming controls      | ✅     | —                                                       |
| XS-STATE-001 Serialization        | ✅     | —                                                       |
| XS-STATE-002 Schema migration     | ✅     | —                                                       |
| XS-STATE-003 Autosave/dirty       | ⚠️     | No built-in dirty indicator or autosave hook            |
| XS-STATE-004 Code generation      | ❌     | Parity+ — deferred                                      |
| XS-A11Y-001 Keyboard authoring    | ⚠️     | No widget delete shortcut; no arrow-key move            |
| XS-A11Y-002 ARIA/semantics        | ⚠️     | No live regions for dynamic updates                     |
| XS-A11Y-003 Reduced motion        | ❌     | Parity+ — deferred                                      |
| XS-PERF-001 60 fps drag           | ⚠️     | Not benchmarked                                         |
| XS-PERF-002 Large dataset grid    | ⚠️     | autoHeight + free DataGrid limits scale                 |
| XS-PERF-003 Code splitting        | ❌     | Parity+ — deferred                                      |
| XS-PERF-004 Memory leaks          | ⚠️     | Not profiled; history cap in place                      |
| XS-COLLAB-001 Collaboration       | ❌     | Parity+ — deferred                                      |
| XS-EXPORT-001 CSV                 | ✅     | —                                                       |
| XS-EXPORT-002 PNG                 | ✅     | Shipped ahead of Parity+ schedule                       |
| XS-AI-001 AI assistant            | ❌     | Parity+ — deferred                                      |

---

## AG Studio features confirmed absent from MUI X Studio

These items appear in the AG Studio reference docs but have no counterpart in the current implementation:

| AG Studio feature                                             | AG Studio API                             | Status                                            |
| ------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------- |
| `panels` prop (configure which panels show and on which side) | `AgStudioPanelConfig`                     | Not implemented; drawers are hardcoded left/right |
| `overrides` prop (restrict widget types, customise panel)     | `AgStudioOverrides`                       | Not implemented                                   |
| `mode` prop on component                                      | `mode: 'edit' \| 'view'`                  | `setMode()` exists on controller; no prop         |
| `initialState` prop                                           | `initialState`                            | Pattern is `new StudioController(state)` instead  |
| `onStateUpdated` event                                        | callback prop                             | Use `controller.subscribe()` instead              |
| `onApiReady` lifecycle                                        | callback prop                             | Not implemented                                   |
| `onErrorRaised` lifecycle                                     | callback prop                             | Not implemented                                   |
| Localisation / `localeText`                                   | `AgStudioLocale`                          | Not implemented                                   |
| RTL support                                                   | `enableRtl`                               | Not implemented                                   |
| AI panel                                                      | `ai`, `AgStudioAiModule`                  | Not implemented                                   |
| Async data sources                                            | `getData` callback                        | Not implemented                                   |
| Shared data engine                                            | `AgDataEngine`                            | Not implemented                                   |
| AG Grid theme system                                          | `theme`, `studioTheme`, `withParams`      | Uses MUI theming instead                          |
| Page dimensions                                               | `minWidth`, `maxWidth`, auto/fixed height | Not in layout model                               |
| Multiple-page UI                                              | page tabs / navigation                    | Model supports pages; no tab bar rendered         |

---

## Capabilities that surpass AG Studio

These are present in the MUI X Studio implementation but are absent from or not described in AG Studio's public documentation:

| Feature                                  | Implementation location                                                           | Notes                                                                              |
| ---------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **100-step undo/redo**                   | `StudioController.ts` (`MAX_HISTORY = 100`) + `Cmd+Z`/`Ctrl+Y` keyboard shortcuts | AG Studio has no public undo API                                                   |
| **Text/narrative widget**                | `StudioTextWidget.tsx`                                                            | AG Studio documents grid, KPI, chart only                                          |
| **`StudioMetricRef`**                    | `models/studio.ts` + filter UI                                                    | Dynamic filter values from business metric aggregation; not in AG Studio           |
| **Relative date filter values**          | `filterTypes.ts` (`RelativeDateValue`)                                            | `past`/`next` + unit (day/week/month/etc.)                                         |
| **Rank filter mode**                     | `StudioFiltersDrawer/RankFilterInput.tsx`                                         | Top-N / bottom-N by measure; not in AG Studio                                      |
| **Selection filter mode**                | `StudioFiltersDrawer`                                                             | Checkbox multi-value filter mode                                                   |
| **Cross-source KPI sparkline**           | `StudioKpiWidget.tsx`, `kpiSparklineSourceId`                                     | Join time field from related source                                                |
| **Auto-granularity sparkline**           | `StudioKpiWidget.tsx`                                                             | Auto-selects day/week/month based on date range                                    |
| **Cumulative (running total) mode**      | `StudioKpiWidget.tsx`, `kpiSparklineCumulative`                                   | Not in AG Studio KPI docs                                                          |
| **Full AST expression evaluator**        | `utils/expressionEvaluator.ts`                                                    | AG Studio mentions expressionFields as config but documents no expression language |
| **Expression field authoring UI**        | `StudioDataDrawer.tsx`                                                            | GUI tree editor for expression fields; AG Studio has no documented authoring UI    |
| **Field capability system**              | `utils/fieldCapabilities.ts`                                                      | Overridable per-field `numeric`/`categorical`/`temporal` capabilities              |
| **`downloadState` / `uploadState`**      | `store/statePersistence.ts`                                                       | Built-in file I/O helpers; AG Studio exposes `getState`/`setState` only            |
| **`schemaVersion` + migration pipeline** | `store/statePersistence.ts`                                                       | AG Studio public docs do not describe state versioning                             |
| **Auto-inferred widget titles**          | `StudioComposeDrawer.tsx` (`inferWidgetTitles`)                                   | Titles auto-generated from field names; reset-to-auto button                       |
| **Per-page theming**                     | `PageConfigPanel` + `StudioPageTheme` model                                       | Background, card, padding, radius, border all configurable per page                |
| **10-type chart gallery**                | `StudioChartWidget.tsx`                                                           | bar-stacked, bar-100, area-stacked, area-100, scatter; date grouping; multi-series |
| **Filters visible in both modes**        | `Studio.tsx`                                                                      | AG Studio defaults filters to view-mode only                                       |

---

## Priority gaps for MVP completion

Based on the MVP definition in section 9 of the requirements, these gaps should be addressed before the MVP can be considered complete:

1. **XS-LAYOUT-002 / XS-CANVAS-002: Widget resize handles** — Row/tile layout with no resize is the most visible divergence from AG Studio.
2. **XS-GRID-002: Grid grouping** — AG Studio's grid widget prominently features row grouping; the MVP spec calls it out.
3. **XS-GRID-001: Virtualization** — `autoHeight` + pagination is adequate for demos but degrades at scale. Consider removing `autoHeight` and using a fixed-height grid with proper row virtualization.
4. **XS-LAYOUT-001 (partial): Drawer state persistence** — Shell state should be included in serialization or stored separately in `localStorage`.
5. **XS-A11Y-001 / XS-A11Y-002: ARIA live regions and keyboard delete** — Needed for WCAG 2.1 AA compliance stated in the requirements.

---

_All file references are under `packages/x-studio/src/` unless otherwise stated._
