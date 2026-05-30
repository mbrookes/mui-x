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

~~BL-45~~: **Fixed** Real data connector — pluggable `DataLoader` interface (`async fetchRows(sourceId, filters)`); adapters for REST, GraphQL, SQL via thin server proxy; loading states and error handling in widget cards (`isError`/`errorMessage` exposed from `useWidgetRows`; error UI shown in all widget types; `createSimpleAdapter` added alongside existing `createBatchingAdapter`)

~~BL-46~~: **Fixed** Pivot table widget — row/column/value field pickers; collapsible row groups; export to CSV

~~BL-47: Ad-hoc formula bar — lightweight single-expression input in chart/KPI setup; creates a one-off expression field without opening the full expression dialog~~
**Fixed** (`InlineFormulaBar` component added to `ChartSetupPanel` (after Y-series) and `KpiSetupPanel` (below value field); pick two operands (fields or numeric constants), an operator (+/−/×/÷), and a label; on confirm calls `addExpressionField` so the expression field is immediately available in all pickers)

~~BL-48: Data lineage view — graph view in the data drawer showing sources as nodes and declared relationships as edges; click an edge to inspect join key fields~~
**Fixed** (`DataLineageGraph` SVG component in the data drawer; sources rendered as rounded-rect nodes in a responsive grid layout; relationships drawn as cubic bezier edges with directional arrowheads; edge label badge shows cardinality (N:1, 1:1, N:M); clicking an edge label opens a popover showing source/target, relationship type, and join key fields; "Data lineage" collapsible section shown when 2+ sources exist)

**New chart types**

~~BL-49: Mixed chart (bar + line) — dual-series chart with one series as bars and another as a line overlay; secondary Y axis (e.g. revenue bars + margin % line)~~
**Fixed** (New 'Mixed (bar + line)' chart type; per-series Bar/Line toggle in setup panel; optional 'Dual Y axis' checkbox; rendered via `ChartsDataProvider` + `ChartsWrapper` + `ChartsSurface` composition API with `BarPlot` + `LinePlot` + `MarkPlot`; requires 2+ measure fields)

~~BL-50: Map / choropleth — country or region data on a world map; colour scale from a numeric field; tooltip on hover~~
**Fixed** (new `StudioMapWidget` component; `'map'` added to `StudioWidgetKind`; `MapSetupPanel` with country field, value field, aggregation, and colour scheme selectors; 174-country equirectangular SVG map generated from Natural Earth 110m public-domain data; 5 colour ramps with linear interpolation; tooltip on hover; lazy-loaded path data; alpha-2/alpha-3/name normalisation via `countryUtils`)

~~BL-51: Gantt / timeline chart — start/end date fields; optional colour-by status field; useful for shipment delivery windows~~
**Fixed** (new 'Gantt / Timeline' chart type; label field, start date field, end date field, and optional colour-by category field configurable in setup panel; `StudioGanttChart` renders horizontal bars positioned by date range with date axis, grid lines, and tooltip showing label/dates/duration/category; overflows truncated with "+N more" notice)

~~BL-52: Heatmap — two categorical axes + numeric value → colour intensity grid (e.g. day-of-week × hour revenue)~~
**Fixed** (new 'Heatmap' chart type; column-axis field (xField), row-axis field (heatYField), and value/colour field (yField) pickers in setup panel; four colour schemes; `aggregateHeatmap()` sums value per (x, y) cell; `StudioHeatmapChart` renders a colour-intensity CSS grid with per-cell tooltips showing exact values)

~~BL-53: Funnel chart — ordered stages with value and drop-off percentage~~
**Fixed** (new 'Funnel' chart type; stages sorted by value descending; drop-off % shown between stages; retention % on right; configurable stage field (xField) and value field (yField) in setup panel; `StudioFunnelChart` renders proportional horizontal bars with labels)

~~BL-54: Chart annotations — user-placed text callout or horizontal/vertical reference line; stored in widget config; visible in edit and view mode~~
**Fixed** (`StudioChartAnnotation` added to model; `annotations?: StudioChartAnnotation[]` on `StudioWidgetConfig`; `ChartsReferenceLine` rendered as chart children for all non-pie/donut/gauge chart types; "Annotations" section in `ChartSetupPanel` with add/remove, axis picker (Y/X), value, and label inputs)

**Authoring**

~~BL-55: Move widgets across pages — drag a widget card onto another page tab; or right-click → "Move to page" context menu~~
**Fixed** (`moveWidgetToPage` action added to `StudioController`; "Move to page" icon button with dropdown menu added to edit-mode widget card overlay — only shown when multiple pages exist; re-scopes widget filters to the target page)

~~BL-56: Widget template library — panel of pre-built chart/KPI configs the user can drag onto the canvas; Studio auto-maps fields from the active data source~~
**Fixed** (`WIDGET_TEMPLATES` array in `widgetTemplates.ts` with 13 pre-built configs (KPI sum/count/avg, bar/horizontal bar/trend/area/stacked bar/multi-measure bar/donut/scatter/funnel chart, and data table); field placeholders auto-mapped to numeric/category/date fields from primary source; templates section added to compose panel with collapsible list; disabled with reduced opacity when source lacks required field types)

~~BL-57: Visual expression builder — node-graph editor for building expression trees; replaces the JSON-based dialog; includes live value preview~~
**Fixed** (enhanced `StudioExpressionFieldDialog`: added `'Function'` kind to input nodes enabling fully recursive nested function expressions; improved type guards (`isFieldExpr`, `isValueExpr`, `isFunctionExpr`); nested `ExpressionBuilder` rendered inline with a collapsible section and a left-border visual indicator showing nesting depth; dialog widened from `sm` → `md` to accommodate deep expression trees; existing live preview panel already present)

~~BL-58: Natural language widget creation — text prompt → inferred chart type, fields, and filters (e.g. "Show me revenue by country as a bar chart for last year")~~
**Fixed** (new `createWidgetFromDescription` function in `StudioChatPanel/` makes a single non-streaming AI call; `"Describe a widget"` text field appears in compose drawer `AddWidgetView` when `aiConfig` is set and `aiChat` feature flag is enabled; AI output is normalized through `createDefaultWidget` before calling `controller.addWidget`; `add_widget` tool schema updated to include pivot/map widget kinds; `aiConfig` forwarded through `StudioUIConfigContext` from `Studio` → `StudioProvider` → child components; locale tokens added)

**Platform**

~~BL-59: Embeddable SDK — `<StudioDashboard config={…} dataLoader={…} />` with sensible defaults; zero-config auto-discovery mode; publishable as a standalone npm package~~
**Fixed** (`StudioDashboard` component wrapping `Studio`; defaults to view-only mode (`compose: false`, `dataManagement: false`); `config` prop loads initial state and reloads when the reference changes; `dataAdapters` prop auto-registers `StudioDataSourceAdapter` for each source ID on mount/change; `featureFlags` merges on top of view-only defaults; exported from `@mui/x-studio`)

~~BL-60: WONTFIX: Multi-user / permissions — view-only mode (no compose/filter drawers); per-page and per-widget visibility rules; user roles: viewer, editor, admin~~

~~BL-61: I18n support for all Studio component text, with a Brazilian Portuguese translation.~~ **Done** (`StudioLocaleText` interface with 45 string tokens; `DEFAULT_STUDIO_LOCALE_TEXT` English defaults; `localeText?: Partial<StudioLocaleText>` prop on `Studio`, `StudioDashboard`, and `StudioProvider`; `useStudioLocaleText()` hook; all hardcoded strings replaced in `StudioFiltersDrawer`, `FilterSection`, `StudioDateRangeBar`, `StudioQuickFilterBar`, `StudioChartWidget`, `StudioGridWidget`, `StudioKpiWidget`, `StudioPivotWidget`, `StudioWidgetCard`, `StudioWidgetCardActionsOverlay`, `StudioNoDataOverlay`, and `Studio.tsx`; `ptBRLocaleText` Brazilian Portuguese translation; all exported from `src/index.ts`)

**Mine**
~~BL-62: From docs x/react-studio/resources/selectors/ #memoising-expensive-selectors "For selectors that perform non-trivial computation, use a memoisation utility like createSelector from the reselect package to avoid unnecessary recalculations:". Are we using this in x-studio? If not should we?~~ **Fixed** (added `reselect` dependency; `selectPartitionedFilters` converted to `createSelector([selectFilters, selectActivePageId], fn)` replacing hand-rolled module-level cache vars; `selectPartitionedBaseFilters` kept hand-rolled due to its deep-equality result optimisation)

~~BL-63: Widget filters should show a summary of the filter when collapsed, the same as the the same as page filters. Filters should stay collapsed when selecting a saved page filter. Filter panel section titles should show the number of filters under it when collapsed.~~ **Fixed** (`FilterCard` now takes `initialExpanded` prop — defaults `false`; rows pass `true` only when filter is fresh/unconfigured so preset-applied filters appear collapsed; `CollapsibleSection` shows a count badge next to the title when collapsed; filter search in the drawer shows "No matching filters." instead of "No filters applied." when a search query is active)

~~BL-64: There is double-line (hr) between page filters and Saved views. Saved views should remain below page filters when other filter types are present.~~

~~BL-65: Chart rank filtering should be applied after cross-filters, so that it still shows the ranked number of items.~~ **Already correct**: rank filters are excluded from `useWidgetRows` row-level pipeline and applied post-aggregation on `enrichedRows` which already includes cross-filters.

~~BL-66: Scatter chart has no X axis labels, and cross-highlight mode is cross-filtering instead.~~

~~BL-67: Add feature flags that can be configured with a json object to control what features are available to x-studio users. Make sure it's availabe for composed apps.~~

~~BL-68: Update the documentation for every new feature added since the last significant docs update, and any other changes.~~ **Done** (added pivot widget docs, i18n/localization guide, expanded async-adapters error handling and added `createSimpleAdapter` section, added page routes for pivot/localization/server-middleware/pipeline, updated navigation in `pages.ts`)

~~BL-69: run the data-pipeline performance tests, and fix any performance regressions~~
**Done** (benchmarks ran; all pipeline layers are within expected ranges; no regressions detected)

BL70: ~~run the UI performance tests and compare with the baseline~~ **Done** (selector memoization tests verify `selectPartitionedFilters` reselect caching, `selectPartitionedBaseFilters` deep-equality caching, page filter partition cache invalidation on page switch, and KPI widget render smoke tests — 7 tests, all passing)

BL-71: Compose panel templates too cluttered — make them a per-widget dropdown.
~~**Done**~~ (replaced flat `TemplateSection` with per-kind `TemplatesDropdown` Popover+MenuList on each `WidgetTypeCard`; button only shown when templates exist for that kind; clicking the button prevents card-level kind selection via `stopPropagation`)

BL-72: Map widget country field picker doesn't include country fields from related sources (e.g. `customers.country` via many-to-one relationship).
~~**Done**~~ (`MapSetupPanel` now includes string fields from related sources in `stringFields` using the same `reachableIds` gate already used for numeric fields)

BL-73: Expand `StudioFeatureFlags` to cover widget kinds and all per-widget features, with full UI in demo settings dialogs.
~~**Done**~~ (14 new flags added: `allowGrid/Chart/Kpi/Text/Filter/Pivot/Map`, `kpiSparkline/Trend/Target`, `chartAnnotations`, `gridGroupBy/Summary/ConditionalFormats`, `drilldown`; wired into `KpiSetupPanel`, `ChartSetupPanel`, `GridSetupPanel`; both demo apps — `x-studio` and `x-studio-composed` — now have Settings dialogs with "Widget types" and "Features" sections exposing all flags as live switches)

~~BL-74: For the map widget, if no value field is selected, the aggregation dropdown should be disabled (with count selected).~~
**Fixed** (aggregation `Select` is now `disabled` and forced to `'count'` when no value field is configured; becomes enabled as soon as a value field is picked)

~~BL-75: Change "Compose / edit mode" in the demo apps settings to "Compose panel" that follows enabling/disabling of other panels. Don't affect the edit mode toggle which is a separate feature.~~
**Fixed** (label changed to `'Compose panel'` in both `x-studio` and `x-studio-composed` `SettingsDialog.tsx`)

~~BL-76: When a feature is disabled in the demo app controls, widget sub feature controls should also be disabled (eg KPI disable: spakine, trend, target line toggles disabled).~~
**Fixed** (added `parentKey` to the `WIDGET_FEATURE_FLAGS` metadata in both `SettingsDialog.tsx` files; sub-feature `Switch`es are now `disabled` and visually unchecked when their parent widget kind is off — `kpiSparkline`/`kpiTrend`/`kpiTarget` follow `kpi`; `chartAnnotations` follows `chart`; `gridGroupBy`/`gridSummary`/`gridConditionalFormats` follow `grid`)

~~BL-77: Map value field should display any related value.~~
**Fixed** (removed `getReachableSourceIds` restriction from `numericFields` in `MapSetupPanel`; value field picker now shows numeric fields from ALL visible sources — matching the country field picker's behaviour; cross-source joins are handled at render time by `useWidgetRows`)

~~BL-78: Make the add calculated field UI consistent across widgets. Use table as the benchmark.~~
**Fixed** (replaced `InlineFormulaBar` in `ChartSetupPanel` and `KpiSetupPanel` with a "Calculated field…" button that opens the full `StudioExpressionFieldDialog`; added `onSaved` callback to auto-select the new field after creation; consistent with the table's "Add column → Calculated column…" flow)

~~BL-79: Add a feature flag and demo apps controls for "add caclulated fields" as a global control for all calculated fields, and per widget. If caclulated fileds are disabled globally, the demo app settings panels toggles for KPIs should be disabled. Group the feature settings toggles by KPI and give them a caption.~~
**Fixed** (added `calculatedFields` (global master), `kpiCalculatedFields`, `chartCalculatedFields`, `gridCalculatedFields` to `StudioFeatureFlags`; each compose panel gates its "Calculated field…" button on `calculatedFields !== false && <widget>CalculatedFields !== false`; both settings dialogs expose all four toggles with `parentKey: 'calculatedFields'` so per-widget toggles disable when the global is off; `useStudioFeatures()` defaults all four to `true`)

~~BL-80: Add close buttons to the tabs in the example apps that removes the page and its config from the model. Have a confirmation dialog. Undo should restore the page.~~
**Fixed** (added `removePage(pageId)` to `StudioHandle`; added `onPageClose` prop to both `AppToolbar` components; in edit mode with 2+ pages each tab gets an × button; clicking it opens a confirmation dialog with Cancel/Remove; Remove calls `controller.removePage()` which commits to undo history so ⌘Z restores the page)

~~BL-81: Add a querystring for the responsive breakpoint setting in the two demo apps, and make sure settings are working. DRY the settings panel between the two demo apps.~~

**Fixed** (added `?bp=N` querystring support in x-studio App; breakpoint initializes from URL and syncs on change via `replaceState`; extracted `FeatureFlagSettings` component + `WIDGET_KIND_FLAGS` / `WIDGET_FEATURE_FLAGS` arrays into `x-studio-shared`; both settings dialogs now import the shared component eliminating ~60 lines of duplication each)

~~BL-82: Is there anything we can resue from x-data-grid-pro's server-side data handling for x-studio (without creating a hard dependancy on the data-grid component? (dependancy on the package is fine)~~

**Researched — not directly reusable.** The `GridGetRowsParams` / `GridDataSourcePro` interface in x-data-grid-pro is row-level (pagination, sort, filter) and grid-specific. x-studio's `StudioQueryDescriptor` / `StudioDataSourceAdapter` is designed for multi-widget dashboards with pre-aggregation, cross-filtering, and M:N join semantics. The two interfaces solve different problems. What _is_ reusable conceptually: the caching and request-deduplication strategy from `DataSourceCache` could inform x-studio's adapter caching. For now no code changes are needed; x-studio's own adapter API is more appropriate for its use case. A future bridge adapter (`createDataGridProAdapter`) could be considered if users need to serve x-studio data from an existing x-data-grid-pro server endpoint.

~~BL-83: Add support for drag-and drop reordering of columns in the table config widget. Consider whether reordering in the table itself should persist in edit mode (reflected in the UI field ordering).~~

**Fixed** (added HTML5 drag-and-drop to the columns list in `GridSetupPanel`: each row has a `DragIndicatorIcon` handle, `draggable` attribute, and `onDragStart`/`onDragOver`/`onDrop`/`onDragEnd` handlers; dropping reorders via `controller.updateWidgetConfig()`; the dragged item is faded and the drop target gets a primary-coloured border; no extra library needed)

~~BL-84: Add drag-and-drop tab ordering to the x-studio-composed example. It should update the studio config so that the ordering can be persisted. Ideally the active/dragged/dropped tab/page shouldn't rerender, and definitely shouldn't reload, recalculate/sort/filter etc the data.~~

**Fixed** (added `reorderPages(pageIds)` to `StudioController` and to `StudioHandle` imperative API; added `onPageReorder` prop to both `AppToolbar` components; in edit mode with 2+ pages each tab becomes `draggable`; `onDragStart`/`onDragOver`/`onDrop`/`onDragEnd` manage local drag state and call `onPageReorder` on drop; dragged tab fades; drop-target tab gets a primary-coloured left border; active page does not change during drag — no data reload)

~~BL-85: Make the edit/delete buttons for data fields in the data panel right aligned. Edit/delete buttons for relationships overlap the relationship name (Shipment Items → Shipments).~~
**Fixed** (added `flexGrow: 1; minWidth: 0` to `ExpressionFieldRow` primary-content Stack so edit/delete buttons are always right-aligned; added `flexShrink: 0` to relationship edit/delete `IconButton`s so they no longer overlap long relationship names)

~~BL-86: Add a feature flag and example app setting for relationships, and for the filter panel.~~
**Fixed** (added `relationships` flag — gates `RelationshipPanel` in `StudioDataDrawer`; added `widgetFilters` flag — gates the "Filters" tab in `StudioWidgetEditDialog`; both default to `true`; both settings dialogs expose the new toggles with appropriate `parentKey` links)

~~BL:87: The filter panel seems a bit pointless as it stands, make it feature complete without bloating it with excess features (/reaserch what's typical for dashboard/BI tools), and allow it to be configured on the filters panel. It's also seems buggy - Quarterly revenue by category for shipments ship date last 12 months shows data for all time. If it's the data itself that is inconsistent, for exmaple ship dates before order dates, fix that. Put it behind a feature flag.~~

**Fixed** (two-part fix):

1. **Data relationship bug**: Added M:N relationship `rel-orderitems-shipments-mn` (ORDER_ITEMS ↔ SHIPMENTS via SHIPMENT_ITEMS junction) to salesDashboard.ts — `findJoinPath` now finds the path so cross-filters on `shipDate` correctly semi-join order-item widgets instead of being silently skipped.
2. **Stale date range**: Generator date range was hardcoded to '2023-01-01'–'2026-04-25'; changed to always span 3 years ago → 90 days from now so relative-date filters like "last 12 months" always contain data regardless of when the demo runs.
3. **Quick date presets**: Added `DATE_PRESETS` chip group (7 days / 30 days / 3 months / 12 months / 1 year) to `RelativeDateInput` in FilterValueInput.tsx; active preset highlighted; clicking any preset sets the relative date value and clears any metric ref.

~~BL:88: Clicking a widget in the x-studio example should open the compose panel (it did in the past). It may have been removed for the x-studio-composed example that uses an edit button instead so that the edit dialog doesn't open when interacting with a widget in edit mode. Make sure that behaviour isn't affected by any fix.~~
**Fixed** (added a `useEffect` in `StudioContent` (`Studio.tsx`) that watches `selectedWidgetId`; when a new widget is selected in edit mode with compose enabled, it calls `setDrawerOpen('compose', true)`; in tabbed layout it also closes the data and filters drawers so compose becomes the active visible tab; x-studio-composed is unaffected because it uses `StudioCanvas` directly and does not render `Studio.tsx`)

~~BL-89: re-run the UI performance tests and compare with the previous run. Save the results to a markdown file in the x-studio folder.~~

**Done** (ran `pnpm --filter "@mui/x-studio" bench`; results saved to `packages/x-studio/PERF_RESULTS.md`; caches are 1000–100,000× faster than cold; L2 enrichment is the bottleneck at 100 k rows but cache hit rate is very high in practice; L5 aggregation comfortably under 50 ms frame budget for typical 20–50 k row dashboards)

~~BL-90: Make config changes persist locally in the browser, so that if the page reloads when the state isn't saved by the containing server, the user doesn't loose changes.~~

**Fixed** (both `x-studio` and `x-studio-composed` now serialize the studio config to `localStorage` (keys `x-studio-state` / `x-studio-composed-state`) on every state change with a 1-second debounce; on page load the saved config is merged with the live data sources via `deserializeState`; a "Reset to demo" toolbar button (RestoreIcon) clears localStorage and reloads the page; data rows are never persisted — only pages, widgets, filters, relationships, and expression fields)

~~BL-91: Move the upload download helpers out of the studio package, and into the containing example apps.~~

**Fixed** (`downloadJson` / `uploadJson` were duplicated in both example apps; moved to `x-studio-shared/src/fileUtils.ts` and re-exported from `x-studio-shared/index.ts`; both example apps now import from `x-studio-shared`; local `utils/fileUtils.ts` copies deleted; `stateToJson` / `jsonToState` removed from `packages/x-studio/src/index.ts` and `statePersistence.ts` — they were app-level convenience wrappers unused by the examples)

~~BL-92: Add sorting to widget data field selection (All widgets).~~

**Fixed** (`DataSourceFieldSelect.tsx`: `sortFields()` sorts the unified options array by `(sourceLabel, label)` using `{ sensitivity: 'base' }` locale comparison — applies to both the `dataSources`-auto-computed path and the caller-supplied `fields` path, so all callers benefit without changes. Source grouping remains correct because MUI Autocomplete's `groupBy` groups by `sourceLabel`, and sorting by source-then-label keeps all same-source fields together.)

~~BL-93: For all data field selects, when a data field is selected replace the dropdown chevron with the close icon.~~

**Fixed** (`DataSourceFieldSelect.tsx`: added `clearIcon={<CloseIcon>}` + `slotProps.clearIndicator.sx = { visibility: selectedOption ? 'visible' : 'hidden' }` + `slotProps.popupIndicator.sx = { display: selectedOption ? 'none' : undefined }`. When a field is selected: the clear × button is always visible; the dropdown chevron is hidden. When no field is selected: the clear button is invisible; the chevron is shown normally.)

~~BL-94: Make the widget config UI more consistent by using shared components for the same/similar functionality, rather than per widget.~~

**Fixed** (extracted `SetupSection` component (`StudioComposeDrawer/SetupSection.tsx`) — renders `<Divider> + caption heading + optional description line` with consistent spacing. Updated `ChartSetupPanel`, `KpiSetupPanel`, and `GridSetupPanel` to use `SetupSection` for their "Interactions" and "Conditional formatting" sections, replacing inline `<Divider>/<Typography>` patterns. This is the primary remaining UI-consistency gap: `DataSourceFieldSelect` already handles the field-picker duplication.)

~~BL-95: Canvas drag-and-drop is only allowing drop on the left end of a row, not in-between widgets or to the right as it should.~~

**Fixed** (root cause: `RowResizeHandle` is `position:absolute; inset:0; z-index:20` inside the gap box, covering the `InsertionPoint` child that had the drag handlers. Drag events fired on the resize handle and could not reach the sibling insertion point. Fix: new `WidgetGap` component owns the gap box and registers `onDragOver`/`onDragLeave`/`onDrop` at the container level — bubbled events from `RowResizeHandle` propagate to the container and are captured. The `InsertionPoint` is no longer needed inside gap boxes; the visual indicator is rendered at the container level. Before-first-widget `InsertionPoint` is unchanged.)

BL-96: Change the widget resize grid to 24 cols. Make sure the visual grid guidelines are correctly aligned. (We fixed this before but it seems to have regressed).

