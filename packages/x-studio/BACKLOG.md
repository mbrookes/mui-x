# Backlog

BL-01: ~~Clicking on a widget in the compose panel should display a list of configured widgets of that type (if any), rather than adding a new one. Clicking on one from the list should show it's configuration panel and highlight it on the canvas. There should be a button to add a widget of that type below the list of existing widgets.~~ **Fixed** (type card click shows existing widget list with back button; "Add" button at bottom; new widgets scroll smoothly into view)

BL-02: ~~Auto-generated titles should never be empty. At a minimum, if the widget isn't configured, it should show the widget type as the name, e.g. chart, Text. This can be replaced by something more informative when daasource etc are configured.~~ **Fixed** (non-text widgets now always show auto titles, with fallback display names when still unconfigured)

BL-03: ~~Drag and drop horizontal insertion line shouldn't extend into the padding.~~ **Fixed** (inset line by 8px on each side to align with widget area)

~~BL-04: Need a data generator to test performance at scale.~~ **Fixed** (added `generateSalesData({ seed?, orderCount? })` in `examples/x-studio/src/salesData/generator.ts`; activates via `?rows=N` URL param; mulberry32 seeded PRNG, 6-table relational output with all FK guarantees; 23 unit tests)

BL-05: ~~The widget card content shrinks when a widget is selected and has a blue border.~~ **Fixed** (use outline instead of border for selection indicator)

BL-06: ~~The field select should show both data source name and field name for the selected field, eith a separator (. or : or |, whatever is best practice or data analytics tools).~~ **Fixed** (selected field now displays as "Source · Field" when multiple data sources are present; single-source keeps field name only)

BL-07: ~~Horizontal bar charts are displayed as veritcal (identical to non-horizonatal).~~ **Fixed** (horizontal layout now applies to single-series, split-series, and multi-measure bar charts; config panel axis labels also flip to match)

BL-08: ~~Move the undo-redo before upload-download, and add separators between them and the view-edit control.~~ **Fixed** (undo/redo now appears before load/save; vertical dividers separate undo/redo from load/save and load/save from view/edit switch)

BL-09: ~~Tooltip for the data panel fields with preview of first n records.~~ **Fixed** (hovering a field in the data drawer shows a tooltip with the field name and first 5 row values; shows "+N more" when there are additional rows)

BL-10: ~~Make the auto titles smarter, based on the defined fields (changing it as they're defined), for example "Monthly Total by Category" for a chart grouped by month on the x axis, Total as the y axis, and split by category~~ **Fixed** (auto titles/subtitles now infer from configured fields across non-text widgets, including grouped chart titles like "Monthly Revenue by Category")

BL-11: ~~Drag and drop performance. Really slow after dropping a card before the line dissapears and the card appears.~~ **Fixed** (module-level `hydratedWidgets` Set tracks already-rendered widget IDs; remounts from DnD skip the rAF+transition defer and render content immediately)

BL-12: ~~smooth scroll to widget added to chart by click.~~ **Fixed** (ease-out-cubic animation, target re-evaluated each frame to track widget content loading)

BL-13: ~~The Filter by Country filter widget doesn't show any chips. Changing the field and changing it back populates it.~~ **Fixed** (filter widgets now resolve expression-backed fields from enriched rows on first render; the example Country filter now points at `expr-order-country`)

BL-14: ~~Category field in the charts panel doesn't have section a title.~~ **Fixed** (the split-by/category picker now has a visible "Category field" section heading in the chart setup panel)

BL-15: ~~When more than one measure field is added, the split-by select dissapears.~~ **Fixed** (the split-by/category field now stays visible and is disabled with explanatory helper text when multiple measure fields are configured)

BL-16: ~~the delete button for fields doesn't line up vertically with the textfield, it's centered on the entire including the helper-text~~ **Fixed** (multi-series rows now top-align the field and remove button, and the delete button is offset to sit against the input instead of the helper text)

~~BL-17: KPI sparkline controls are grouped with a vertical bar. USe a background color with border radius, make it collapsable and collapsed by default. Put the label (e.g. Sparkline) on the left, and the control (switch) on the right. When switch toggled to on, open the panel, when toggled to off close it. Chevron on the far left of the title should also open and close it.~~ ✅ Fixed

~~BL-18: Changing the filter widget type looses the field config, at least for date filters.~~ **Fixed** (type change now preserves the selected field unless it's incompatible with the new type; only clears when switching to date-range/slider with an incompatible field type)

~~BL-19: Add a "full-screen" icon to charts controls that displays them in a near page-width overlay.~~ **Fixed** (added `OpenInFullIcon` expand button to chart widget action overlay in both edit/view modes; opens a `min(1400px, 90vw)` Dialog with chart at 500px height, title, close button, and PNG export)

~~BL-20: Dragging the slider filter thumb tries to drag the panel as if repositioning~~ **Fixed** (stop pointer events from bubbling out of the slider box so the widget card's native drag handler isn't triggered)

~~BL-21: customer aquisition over time chart is blank~~ **Fixed** (added `yAggregation` config option; set to `'count'` for the acquisition chart so string fields are counted per x-bucket rather than summed as NaN)

~~BL-21: Products page still isn't using the theme default, but mango fusion instead.~~ **Fixed** (removed hardcoded `mangoFusion` palette from the Products page config so it inherits the dashboard default)

~~BL-22: Remove chart colors selection controls from page settings, and all related logic and data. The App theme sets the colors.~~ **Fixed** (removed `chartPalette`/`chartCustomColors` from state entirely; `usePageChartColors` always returns `undefined` so charts use MUI theme colours directly)

~~BL-23: Remove the table icon from the data sources panel list.~~ **Fixed** (removed `TableChartIcon` from the data source list item in `StudioDataDrawer`)

~~BL-24: In the widgets "On this page" section, give each page widget an icon acording to its sub-type (where applicable), for example chart tyle.~~ **Fixed** (added `getWidgetSubtypeIcon` helper to `widgetUtils`; renders a 16px chart-type/filter-type icon next to each widget in the instance list)

~~BL-25: Widget filters make no sense for the filter widget.~~ **Fixed** (hide `WidgetFilterSection` in the filters drawer when the selected widget is a filter widget)

~~BL-26: Remove the page tab from compose, and all associated state and logic. Page appearance comes from the theme. No need for the widget tab.~~ **Fixed** (removed "Widgets"/"Page" tab bar from compose drawer; widgets content now renders directly; removed `PageConfigPanel` import and `mainTab` state)

~~BL-27: When hovering a datasource name in the data panel, show a tooltip with a simple grid of the first five rows.~~ **Fixed** (added `DataSourcePreviewTooltip` showing a mini table of first 5 rows × 4 columns with column headers and overflow counts)

~~BL-28: When dragging a widget past the top or bottom of the page, make sure the page scrolls.~~ **Fixed** (added `dragover` edge-scroll in `StudioCanvas`: finds nearest scrollable ancestor, starts a rAF loop when pointer is within 80px of viewport top/bottom, stops on drop/dragleave)

~~BL-29: Adding a cross-filter: (Company = Tech Systems From: Top Customers by Revenue) revenue charts still show multiple segments even thoug company.segment can only be one~~ **Fixed** (chart click cross-filters now use the owning source of `xField` from `chartSupport.fieldOwners`, so related-source dimensions like customer company filter through the correct join path)

---

## Component Feature Backlog

Items migrated from `examples/x-studio/REQUIREMENTS.md` — these are features of
`@mui/x-studio` itself, not the demo app.

### 📋 Planned

**Dashboard**

~~BL-30: Dashboard-level date range filter — single date range picker driving all KPI/chart/grid widgets as a page-level filter; pre-sets: This month, Last 3 months, Last 12 months, Year-to-date, All time~~
**Fixed** (`StudioDateRangeBar` rendered above canvas; date/datetime field selector; preset toggle group (All time / YTD / This month / Last 3 months / Last 12 months); creates a page-level `isDashboardDateRange` filter with the `between` operator; hidden from the filters drawer and quick-filter bar; field selection is preserved in local state when "All time" is chosen; `computeDateRangePreset` exported for custom integrations)

~~BL-31: Drill-down / detail panel — click a chart segment or grid row → slide-in panel showing related child rows; resolves relationship paths from the data model automatically; breadcrumb trail for multi-level drill~~
**Fixed** (`StudioDrilldownDrawer` slide-in panel; `drilldownWidgetId` config on grid and chart widgets; clicking a chart item or grid row opens the drilldown with the clicked value added as a filter to the drilldown widget; drilldown picker added to Interactions section in both `ChartSetupPanel` and `GridSetupPanel`; context chips show the active filter; multi-level breadcrumb deferred)

**Grid widget**

~~BL-32: Grid conditional formatting — rule-based cell colour (e.g. negative margin → red); configurable in the Format tab; multiple rules per column, first-match wins~~

~~BL-33: Grid totals / summary row — pinned footer showing sum/avg/count per configured column; toggle per column in the compose drawer~~

**Chart widget**

~~BL-34: Scatter chart configuration — expose X field, Y field, size field, and colour-by field in the compose drawer (currently hardcoded in the demo config)~~ **Fixed** (added `scatterColorField` config; dedicated single Y-field picker for scatter in compose panel; optional categorical color-by field splits points into colour-coded series with legend; `prepareScatterDataGrouped` in `chartUtils`; stable category ordering from unfiltered rows)

~~BL-35: Pie/donut label formatting — label position (inside/outside/legend-only), label content (value/percent/both), minimum-slice threshold to suppress tiny-slice labels~~ **Fixed** (added `pieArcLabel` ('value'/'percent'/'none') and `pieArcLabelMinAngle` config fields; arc label Select + min-angle input in compose panel; per-ring percent totals for multi-ring charts; zero-total guard)

**KPI widget**

~~BL-36: KPI target line — optional reference value (from a businessMetrics data source) shown on the sparkline; delta badge compares to target rather than prior period; configurable source field + row ID~~

~~BL-37: WONTFIX: Per-widget chart palette override — override the page-level chart palette on individual chart widgets using the same colour-picker UI~~

**Canvas authoring**

~~BL-38: Widget resize — drag handle on the card edge to change column span within a row; snaps to MUI Grid breakpoints (1–12); persisted in `widgetRows` layout config~~

~~BL-39: WONTFIX: Row management + layout picker — "Add row" / "Remove row" buttons; preset layout picker (1-col, 2-equal, 3-equal, sidebar-left, sidebar-right)~~

~~BL-40: Widget reorder within a row — drag-and-drop to swap positions within a row; also allow moving a widget to a different row~~

**Filters**

~~BL-41: Saved views / filter presets — name and save the current filter state; recall from a dropdown above the canvas; presets serialized with the dashboard state~~

~~BL-42: Quick filter bar — compact row of active-filter chips pinned above the canvas; click to jump to the filter in the drawer; "Clear all" shortcut~~
**Fixed** (`StudioQuickFilterBar` rendered above canvas in view mode when page filters are active; one chip per filter showing field + summary; individual delete; "Clear all" button; clicking opens the filters drawer)

~~BL-43: Global filter search — search box at the top of the filters drawer; narrows the filter card list by field name or current value~~
**Fixed** (search TextField at top of filters drawer; narrows visible filter cards by field name or summary match; clear button; only shown when filters exist)

~~BL-44: Filter dependency (cascading) — when a parent filter is set (e.g. Country), child filter options (e.g. State) narrow automatically; dependency declared in filter setup~~
**Fixed** (`dependsOn?: string[]` added to `StudioFilterState`; `useFieldValues` accepts `parentFilters` and pre-filters rows before extracting unique values; selection-mode page filters show a "Narrow options based on" multi-select Autocomplete to declare dependencies; options are limited to other page filters with configured fields)

### 🔭 Future

**Data**

BL-45: Real data connector — pluggable `DataLoader` interface (`async fetchRows(sourceId, filters)`); adapters for REST, GraphQL, SQL via thin server proxy; loading states and error handling in widget cards

BL-46: Pivot table widget — row/column/value field pickers; collapsible row groups; export to CSV

~~BL-47: Ad-hoc formula bar — lightweight single-expression input in chart/KPI setup; creates a one-off expression field without opening the full expression dialog~~
**Fixed** (`InlineFormulaBar` component added to `ChartSetupPanel` (after Y-series) and `KpiSetupPanel` (below value field); pick two operands (fields or numeric constants), an operator (+/−/×/÷), and a label; on confirm calls `addExpressionField` so the expression field is immediately available in all pickers)

BL-48: Data lineage view — graph view in the data drawer showing sources as nodes and declared relationships as edges; click an edge to inspect join key fields

**New chart types**

~~BL-49: Mixed chart (bar + line) — dual-series chart with one series as bars and another as a line overlay; secondary Y axis (e.g. revenue bars + margin % line)~~
**Fixed** (New 'Mixed (bar + line)' chart type; per-series Bar/Line toggle in setup panel; optional 'Dual Y axis' checkbox; rendered via `ChartsDataProvider` + `ChartsWrapper` + `ChartsSurface` composition API with `BarPlot` + `LinePlot` + `MarkPlot`; requires 2+ measure fields)

BL-50: Map / choropleth — country or region data on a world map; colour scale from a numeric field; tooltip on hover

BL-51: Gantt / timeline chart — start/end date fields; optional colour-by status field; useful for shipment delivery windows

~~BL-52: Heatmap — two categorical axes + numeric value → colour intensity grid (e.g. day-of-week × hour revenue)~~
**Fixed** (new 'Heatmap' chart type; column-axis field (xField), row-axis field (heatYField), and value/colour field (yField) pickers in setup panel; four colour schemes; `aggregateHeatmap()` sums value per (x, y) cell; `StudioHeatmapChart` renders a colour-intensity CSS grid with per-cell tooltips showing exact values)

BL-53: Funnel chart — ordered stages with value and drop-off percentage

~~BL-54: Chart annotations — user-placed text callout or horizontal/vertical reference line; stored in widget config; visible in edit and view mode~~
**Fixed** (`StudioChartAnnotation` added to model; `annotations?: StudioChartAnnotation[]` on `StudioWidgetConfig`; `ChartsReferenceLine` rendered as chart children for all non-pie/donut/gauge chart types; "Annotations" section in `ChartSetupPanel` with add/remove, axis picker (Y/X), value, and label inputs)

**Authoring**

~~BL-55: Move widgets across pages — drag a widget card onto another page tab; or right-click → "Move to page" context menu~~
**Fixed** (`moveWidgetToPage` action added to `StudioController`; "Move to page" icon button with dropdown menu added to edit-mode widget card overlay — only shown when multiple pages exist; re-scopes widget filters to the target page)

BL-56: Widget template library — panel of pre-built chart/KPI configs the user can drag onto the canvas; Studio auto-maps fields from the active data source

BL-57: Visual expression builder — node-graph editor for building expression trees; replaces the JSON-based dialog; includes live value preview

BL-58: Natural language widget creation — text prompt → inferred chart type, fields, and filters (e.g. "Show me revenue by country as a bar chart for last year")

**Platform**

BL-59: Embeddable SDK — `<StudioDashboard config={…} dataLoader={…} />` with sensible defaults; zero-config auto-discovery mode; publishable as a standalone npm package

~~BL-60: WONTFIX: Multi-user / permissions — view-only mode (no compose/filter drawers); per-page and per-widget visibility rules; user roles: viewer, editor, admin~~

BL-61: I18n support for all Studio component text, with a Brazilian Portuguese translation.

**Mine**
~~BL-62: From docs x/react-studio/resources/selectors/ #memoising-expensive-selectors "For selectors that perform non-trivial computation, use a memoisation utility like createSelector from the reselect package to avoid unnecessary recalculations:". Are we using this in x-studio? If not should we?~~ **Fixed** (added `reselect` dependency; `selectPartitionedFilters` converted to `createSelector([selectFilters, selectActivePageId], fn)` replacing hand-rolled module-level cache vars; `selectPartitionedBaseFilters` kept hand-rolled due to its deep-equality result optimisation)

~~BL-63: Widget filters should show a summary of the filter when collapsed, the same as the the same as page filters. Filters should stay collapsed when selecting a saved page filter. Filter panel section titles should show the number of filters under it when collapsed.~~ **Fixed** (`FilterCard` now takes `initialExpanded` prop — defaults `false`; rows pass `true` only when filter is fresh/unconfigured so preset-applied filters appear collapsed; `CollapsibleSection` shows a count badge next to the title when collapsed; filter search in the drawer shows "No matching filters." instead of "No filters applied." when a search query is active)

~~BL-64: There is double-line (hr) between page filters and Saved views. Saved views should remain below page filters when other filter types are present.~~

~~BL-65: Chart rank filtering should be applied after cross-filters, so that it still shows the ranked number of items.~~ **Already correct**: rank filters are excluded from `useWidgetRows` row-level pipeline and applied post-aggregation on `enrichedRows` which already includes cross-filters.

~~BL-66: Scatter chart has no X axis labels, and cross-highlight mode is cross-filtering instead.~~

~~BL-67: Add feature flags that can be configured with a json object to control what features are available to x-studio users. Make sure it's availabe for composed apps.~~

BL-68: Update the documentation for every new feature added since the last significant docs update, and any other changes.

~~BL-69: run the data-pipeline performance tests, and fix any performance regressions~~
**Done** (benchmarks ran; all pipeline layers are within expected ranges; no regressions detected)

BL70: run the UI performance tests and compare with the baseline
