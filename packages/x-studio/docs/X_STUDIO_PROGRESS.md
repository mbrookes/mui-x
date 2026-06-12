# @mui/x-studio — Requirements Progress Tracker

> Last updated: 2026-05-31

---

## Summary Table

| ID    | Area      | Description                                        | Status       |
| ----- | --------- | -------------------------------------------------- | ------------ |
| D-01  | Data      | Multi-source relational data model                 | ✅ Completed |
| D-02  | Data      | Expression fields                                  | ✅ Completed |
| D-03  | Data      | Cross-source join projection                       | ✅ Completed |
| D-04  | Data      | Async / real data connector                        | ✅ Completed |
| D-05  | Data      | Pivot table widget                                 | ✅ Completed |
| D-06  | Data      | Ad-hoc formula bar                                 | ✅ Completed |
| D-07  | Data      | Data lineage view                                  | ✅ Completed |
| DB-01 | Dashboard | Multi-page dashboard with theming                  | ✅ Completed |
| DB-02 | Dashboard | Page-level and widget-level filters                | ✅ Completed |
| DB-03 | Dashboard | Cross-filter (click-to-filter)                     | ✅ Completed |
| DB-04 | Dashboard | Dashboard-level date range filter                  | ✅ Completed |
| DB-05 | Dashboard | Drill-down / detail panel                          | ✅ Completed |
| DB-06 | Dashboard | Customers page                                     | ✅ Completed |
| DB-07 | Dashboard | Data refresh simulation                            | ✅ Completed |
| DB-08 | Dashboard | State persistence (save/restore JSON)              | ✅ Completed |
| DB-09 | Dashboard | Shareable filter links (URL encoding)              | ✅ Completed |
| W-01  | Widget    | Grid: sort, export, cross-filter                   | ✅ Completed |
| W-02  | Widget    | Grid: conditional formatting                       | ✅ Completed |
| W-03  | Widget    | Grid: totals / summary row                         | ✅ Completed |
| W-04  | Widget    | Chart: all major types + horizontal                | ✅ Completed |
| W-04a | Widget    | Chart: crossFilterMode per widget                  | ✅ Completed |
| W-05  | Widget    | Chart: scatter axis configuration                  | ✅ Completed |
| W-06  | Widget    | Chart: pie/donut label formatting                  | ✅ Completed |
| W-07  | Widget    | Chart: mixed (bar + line on same axes)             | ✅ Completed |
| W-08  | Widget    | Chart: map / choropleth                            | ✅ Completed |
| W-09  | Widget    | Chart: Gantt / timeline                            | ✅ Completed |
| W-10  | Widget    | Chart: heatmap                                     | ✅ Completed |
| W-11  | Widget    | Chart: funnel                                      | ✅ Completed |
| W-12  | Widget    | Chart: annotations / reference lines               | ✅ Completed |
| W-13  | Widget    | KPI: value, trend, sparkline, formatting           | ✅ Completed |
| W-14  | Widget    | KPI: target line from business metrics             | ✅ Completed |
| W-15  | Widget    | KPI: per-widget chart palette override             | 🚫 WONTFIX   |
| W-16  | Widget    | Text: per-section font/colour/alignment            | ✅ Completed |
| C-01  | Compose   | Widget setup and format tabs                       | ✅ Completed |
| C-02  | Compose   | Chart type picker with icons                       | ✅ Completed |
| C-03  | Compose   | Auto-inferred titles + manual override             | ✅ Completed |
| C-04  | Compose   | Page theming (bg, cards, palette)                  | ✅ Completed |
| C-05  | Compose   | Undo / redo                                        | ✅ Completed |
| C-06  | Compose   | Widget resize (column width)                       | ✅ Completed |
| C-07  | Compose   | Row add/remove and layout picker                   | 🚫 WONTFIX   |
| C-08  | Compose   | Widget reorder within / across rows                | ✅ Completed |
| C-09  | Compose   | Saved views / filter presets                       | ✅ Completed |
| C-10  | Compose   | Duplicate / move widgets across pages              | ✅ Completed |
| C-11  | Compose   | Widget template library                            | ✅ Completed |
| C-12  | Compose   | Visual expression builder (node editor)            | ✅ Completed |
| C-13  | Compose   | Natural language widget creation                   | ✅ Completed |
| F-01  | Filters   | Condition, Selection, Rank modes                   | ✅ Completed |
| F-02  | Filters   | Relative dates, compound (AND/OR)                  | ✅ Completed |
| F-03  | Filters   | Metric refs (dynamic thresholds)                   | ✅ Completed |
| F-04  | Filters   | Quick filter bar above canvas                      | ✅ Completed |
| F-05  | Filters   | Global filter search                               | ✅ Completed |
| F-06  | Filters   | Filter dependency (cascading options)              | ✅ Completed |
| A-01  | Arch      | Reactive store + undo/redo                         | ✅ Completed |
| A-02  | Arch      | Deferred render + memoized cards                   | ✅ Completed |
| A-03  | Arch      | Expression field system                            | ✅ Completed |
| A-04  | Arch      | Field capability system                            | ✅ Completed |
| A-05  | Arch      | Embeddable SDK / zero-config consumer API          | ✅ Completed |
| A-06  | Arch      | Multi-user / permissions                           | 🚫 WONTFIX   |
| A-07  | Arch      | AI chat assistant (`StudioChatPanel`)              | ✅ Completed |
| A-08  | Arch      | Slot props chain (canvas → card → widget)          | ✅ Completed |
| A-09  | Arch      | Async data source adapter interface                | ✅ Completed |
| A-10  | Arch      | `@mui/x-studio-data-middleware` middleware package | ✅ Completed |
| A-11  | Arch      | `sidebarLayout` + `sidebarSide` props              | ✅ Completed |
| A-12  | Arch      | I18n / localisation support                        | ✅ Completed |
| A-13  | Arch      | Feature flags                                      | ✅ Completed |
| UX-01 | UX        | Map aggregation disabled without value field       | ✅ Completed |
| UX-02 | UX        | Settings: Compose panel label                      | ✅ Completed |
| UX-03 | UX        | Data panel: right-aligned edit/delete              | ✅ Completed |
| UX-04 | UX        | Consistent calculated field UI + flags             | ✅ Completed |
| UX-05 | UX        | Feature flags: relationships + widgetFilters       | ✅ Completed |
| UX-06 | UX        | localStorage state persistence + Reset             | ✅ Completed |
| UX-07 | UX        | Field picker: alphabetical sort + clear icon       | ✅ Completed |
| UX-08 | UX        | SetupSection shared section component              | ✅ Completed |
| UX-09 | UX        | Canvas DnD drops between/after widgets             | ✅ Completed |
| UX-10 | UX        | 24-column widget resize grid                       | ✅ Completed |
| UX-11 | UX        | Nested feature flags for kpi/chart/grid            | ✅ Completed |
| UX-12 | UX        | DnD cursor, grab offset, transparency              | ✅ Completed |

---

## ✅ Completed

### D-01 · Multi-source relational data model

- Orders, order items (1–5 per order, 595 total), customers, products, shipments, shipment items, business metrics
- Deterministic PRNG-generated data (seeded, reproducible); scalable via `?rows=N` URL param
- Partially Delivered status for split shipments
- Declared relationships between sources (many-to-one and many-to-many)

### D-02 · Expression fields

- Calculated columns (per-row scalar values from an expression tree)
- Measures (single aggregate values over the filtered dataset)
- Expression field dialog for authoring
- Expression fields appear in all field pickers (chart, KPI, grid, filters)

### D-03 · Cross-source join projection

- Chart aggregations can use a y-field from a related source
- Join path resolved automatically via declared relationships
- Sparkline time-field can be sourced from a related table

### D-04 · Async / real data connector

- `StudioDataSourceAdapter` interface: `getRows(descriptor): Promise<StudioQueryResult>`
- `ref.setDataSourceAdapter(sourceId, adapter)` attaches/removes an adapter at runtime
- When an adapter is present Studio calls it instead of the in-memory rows pipeline
- `createSimpleAdapter` and `createBatchingAdapter` helper factories
- `isError` / `errorMessage` exposed from `useWidgetRows`; error UI shown in all widget types
- Demo `?adapter=true` mode routes all sources through a simulated server adapter
- See also: **A-09** (same underlying feature)

### D-05 · Pivot table widget

- `StudioPivotWidget` component with row field, column field, and value field pickers
- Collapsible row groups
- Export to CSV

### D-06 · Ad-hoc formula bar

- `InlineFormulaBar` component in `ChartSetupPanel` (after Y-series) and `KpiSetupPanel` (below value field)
- Pick two operands (fields or numeric constants), an operator (+/−/×/÷), and a label
- Calls `addExpressionField` so the expression field is immediately available in all pickers

### D-07 · Data lineage view

- `DataLineageGraph` SVG component in the data drawer
- Sources rendered as rounded-rect nodes in a responsive grid layout
- Relationships drawn as cubic Bézier edges with directional arrowheads
- Edge label badge shows cardinality (N:1, 1:1, N:M)
- Clicking an edge label opens a popover showing source/target, relationship type, and join key fields
- "Data lineage" collapsible section shown when 2+ sources exist

### DB-01 · Multi-page dashboard with theming

- Four pages: Overview, Products & Logistics, third page, Customers
- Per-page theme: background colour, card background/padding/radius/border
- Bookmarkable page tabs via `?page=` URL query param

### DB-02 · Page-level and widget-level filters

- Filters drawer with scope control (page vs. widget)
- Condition mode: all operators, compound AND/OR, relative dates
- Selection mode: multi-select chips with field value enumeration
- Rank mode: Top N / Bottom N with rank-by field

### DB-03 · Cross-filter

- Clicking a chart bar/slice or grid row emits a cross-filter to all other widgets
- Cross-filter scope is separate from user-defined page/widget filters
- Source widget is excluded from its own cross-filter

### DB-04 · Dashboard-level date range filter

- `StudioDateRangeBar` rendered above canvas
- Date/datetime field selector; preset toggle group (All time / YTD / This month / Last 3 months / Last 12 months)
- Creates a page-level `isDashboardDateRange` filter with the `between` operator
- Hidden from the filters drawer and quick-filter bar
- `computeDateRangePreset` exported for custom integrations

### DB-05 · Drill-down / detail panel

- `StudioDrilldownDrawer` slide-in panel
- `drilldownWidgetId` config on grid and chart widgets
- Clicking a chart item or grid row opens the drilldown with the clicked value as a filter
- Drilldown picker added to Interactions section in `ChartSetupPanel` and `GridSetupPanel`
- Context chips show the active filter

**Gaps:**

- Multi-level breadcrumb navigation deferred

### DB-06 · Customers page

- KPIs: Lifetime Value, Customer Count, Avg Order Value, Enterprise Customer Count
- Filter widgets: Segment toggle and Signup Date Range picker
- Charts: Acquisition Over Time, Revenue by Segment (donut), Top Customers (horizontal bar), Quarterly Revenue by Segment (stacked area)
- Grid: Top 20 customers by total revenue with order count

### DB-07 · Data refresh simulation

- **Refresh** toolbar button regenerates the demo dataset with a time-based seed (`Date.now()`)
- Calls `setDataSourceAdapter` (existing public API) for all 6 data sources with freshly generated rows
- KPIs, charts, and grids all re-render with the new data; existing widget config and filters are preserved

### DB-08 · State persistence (save/restore JSON)

- `ref.serializeState()` returns a JSON-safe `SerializedStudioState` snapshot
- `ref.loadSerializedState(data)` restores state and applies schema migrations
- Returns `MigrationResult` with `{ success, fromVersion, toVersion, errors }`
- Demo app provides Save (download JSON) and Load (upload JSON) toolbar buttons

### W-01 · Grid widget

- Sortable columns, compact density
- Export to CSV
- Cross-filter source (row click)
- Column picker in compose drawer

### W-02 · Grid: conditional formatting

- Rule-based cell colour (e.g. negative margin → red background)
- Configurable in compose Format tab: field, operator, value, colour
- Multiple rules per column; first-match wins

### W-03 · Grid: totals / summary row

- Pinned footer row showing sum / avg / count per configured column
- Toggle per column in compose drawer

### W-04 · Chart widget (all standard types + horizontal)

- Bar, bar-stacked, bar-100, line, area, area-stacked, area-100, pie, donut, scatter
- Horizontal bar layout
- Single-series, multi-Y-series, and Split-by (seriesField) data shapes
- Auto-sizing axes; chart type picker with icons (vertical + horizontal variants)

### W-04a · Chart: `crossFilterMode` per widget

- `StudioCrossFilterMode = 'cross-highlight' | 'cross-filter' | 'none'`
- `'cross-highlight'` (default): shows full dataset as a faded ghost behind the filtered subset
- `'cross-filter'`: redraws chart using only the filtered rows (axes rescale)
- `'none'`: widget ignores all incoming cross-filters
- Configurable in the Chart Setup panel compose drawer

### W-05 · Scatter chart configuration

- `scatterColorField` config for categorical colour-by field
- Dedicated single Y-field picker for scatter in compose panel
- Optional colour-by field splits points into colour-coded series with legend
- `prepareScatterDataGrouped` in chartUtils; stable category ordering from unfiltered rows

### W-06 · Pie / donut label formatting

- `pieArcLabel` config: `'value'` / `'percent'` / `'none'`
- `pieArcLabelMinAngle` to suppress tiny-slice labels
- Arc label Select + min-angle input in compose panel
- Per-ring percent totals for multi-ring charts

### W-07 · Mixed chart (bar + line on same axes)

- `mixed` chart type in the chart type picker
- Per-series type toggle (bar / line) in the compose drawer Y-series panel
- Dual Y-axis checkbox (left axis for bars, right for line series)
- Rendered via `ChartsDataProvider` + `BarPlot` + `LinePlot` + `MarkPlot` composition

**Gaps:**

- No secondary-axis label or scale configuration exposed in the compose drawer

### W-08 · Map / choropleth

- `StudioMapWidget` component; `'map'` added to `StudioWidgetKind`
- `MapSetupPanel` with country field, value field, aggregation, and colour scheme selectors
- 174-country equirectangular SVG map from Natural Earth 110m public-domain data
- 5 colour ramps with linear interpolation; tooltip on hover
- Lazy-loaded path data; alpha-2/alpha-3/name normalisation via `countryUtils`

### W-09 · Gantt / timeline chart

- `gantt` chart type rendered by `StudioGanttChart` component
- Compose drawer: label field, start date field, end date field, optional colour-by category field
- Horizontal swimlane layout; bars span start→end date range
- Date axis, grid lines, tooltip showing label/dates/duration/category
- Overflows truncated with "+N more" notice

### W-10 · Heatmap

- `heatmap` chart type rendered by `StudioHeatmapChart` component
- Compose drawer: column-axis field, row-axis field, value/colour field
- Four colour schemes; `aggregateHeatmap()` sums value per (x, y) cell
- Per-cell tooltips showing exact values

**Gaps:**

- No custom colour-scale configuration (fixed sequential palettes only)

### W-11 · Funnel chart

- `funnel` chart type rendered by `StudioFunnelChart` component
- Stages sorted by value descending; drop-off % shown between stages; retention % on right
- Configurable stage field (xField) and value field (yField) in setup panel
- Proportional horizontal bars with labels

### W-12 · Chart annotations / reference lines

- `ChartsReferenceLine` renders annotations on bar, line, area, and mixed charts
- Annotation add/edit UI in the Chart Setup compose panel (axis, value, label)
- Annotations stored in `StudioWidgetConfig.annotations`; serialized with dashboard state

**Gaps:**

- Free-text callout annotations not yet supported (only reference lines)
- Annotations not rendered on pie/donut, gauge, heatmap, funnel, or Gantt charts

### W-13 · KPI widget

- Value + aggregation (sum / avg / count / min / max)
- Compact number formatting, prefix / suffix
- Period-over-period / YoY / custom trend with delta badge
- Sparkline (line or bar, cumulative option)
- Boolean avg rendered as percentage

### W-14 · KPI target line

- Optional reference value from a data source shown on sparkline
- Delta badge compares current value to target
- Configurable in KPI Setup: target source field + row ID

### W-16 · Text widget

- Title, subtitle, body text sections
- Per-section: font family, font size, colour, alignment

### C-01–C-05 · Compose drawer

- Setup and Format tabs per widget type
- Split-by (seriesField) picker; multi-Y series picker
- Auto-inferred titles and subtitles with manual override
- Add / remove / duplicate widgets
- Undo / redo (up to 100 steps)

### C-06 · Widget resize (column width)

- Drag handle on the right edge of each widget card (visible in edit mode)
- Live flex-basis override during drag; snaps to 12-column grid on release
- `setWidgetColSpan` / `setWidgetColSpanInRow` on `StudioController`
- Persisted in `widgetColSpans` on the page state; serialized with dashboard state
- AI `set_widget_width` tool also drives resize programmatically

### C-08 · Widget reorder within / across rows

- Drag-and-drop within a row to swap widget positions
- Moving a widget to a different row supported

### C-09 · Saved views / filter presets

- Name and save the current filter state as a preset
- Recall a preset from a dropdown above the canvas
- Presets persisted in dashboard state (serializable)

### C-10 · Move widgets across pages

- `moveWidgetToPage` action on `StudioController`
- "Move to page" icon button with dropdown menu in edit-mode widget card overlay (shown when multiple pages exist)
- Re-scopes widget filters to the target page

### C-11 · Widget template library

- `WIDGET_TEMPLATES` array with 13 pre-built configs (KPI sum/count/avg, bar/horizontal bar/trend/area/stacked bar/multi-measure bar/donut/scatter/funnel/data table)
- Field placeholders auto-mapped to numeric/category/date fields from primary source
- Templates section in compose panel with collapsible list
- Disabled with reduced opacity when source lacks required field types

### C-12 · Visual expression builder

- Enhanced `StudioExpressionFieldDialog` with recursive nested function expressions
- `'Function'` kind added to input nodes enabling fully recursive expression trees
- Nested `ExpressionBuilder` rendered inline with collapsible sections and nesting-depth left-border indicators
- Dialog widened from `sm` → `md` to accommodate deep expression trees

### C-13 · Natural language widget creation

- `createWidgetFromDescription` function in `StudioChatPanel/`
- "Describe a widget" text field in compose drawer `AddWidgetView` (when `aiConfig` is set and `aiChat` feature flag enabled)
- AI output normalised through `createDefaultWidget` before calling `controller.addWidget`
- `aiConfig` forwarded through `StudioUIConfigContext`

### F-01–F-03 · Filters

- Condition, Selection, Rank modes with mode toggle
- Relative date values (e.g. "3 months ago")
- Compound filters (second operator + AND/OR conjunction)
- Metric refs: filter value driven by a business metric row

### F-04 · Quick filter bar

- `StudioQuickFilterBar` rendered above canvas in view mode when page filters are active
- One chip per filter showing field + summary; individual delete; "Clear all" button
- Clicking a chip opens the filters drawer

### F-05 · Global filter search

- Search TextField at top of filters drawer
- Narrows visible filter cards by field name or summary match
- Clear button; only shown when filters exist
- Shows "No matching filters." when a search query is active

### F-06 · Filter dependency (cascading)

- `dependsOn?: string[]` on `StudioFilterState`
- `useFieldValues` accepts `parentFilters` and pre-filters rows before extracting unique values
- Selection-mode page filters show a "Narrow options based on" multi-select Autocomplete to declare dependencies
- Options limited to other page filters with configured fields

### A-01–A-04 · Architecture

- `StudioController`: reactive `Store`, undo/redo stacks, serialization/migration
- `useSyncExternalStore`-based narrow selectors (per-widget re-render isolation)
- Deferred widget content render (single rAF batch after first paint)
- Memoized `StudioWidgetCard` and canvas rows
- Field capability system (type-derived, per-field overridable)
- `reselect`-based memoised selectors for expensive computed values

### A-05 · Embeddable SDK

- `StudioDashboard` component wrapping `Studio`
- Defaults to view-only mode (`compose: false`, `dataManagement: false`)
- `config` prop loads initial state and reloads when the reference changes
- `dataAdapters` prop auto-registers `StudioDataSourceAdapter` for each source ID on mount/change
- `featureFlags` merges on top of view-only defaults
- Exported from `@mui/x-studio`

### A-07 · AI chat assistant

- `StudioChatPanel` component with streaming message rendering
- `aiConfig` prop on `Studio`: `{ endpoint, apiKey?, model?, headers? }`
- Floating action button (bottom-right) opens/closes the panel; also available as a full-height slideout side panel
- Built-in tool suite: add/update/remove widget, set layout, navigate pages, manage filters
- `extraTools` prop on `StudioChatPanel` for custom tool extensions
- Empty-page prompt embeds the chat panel when a new page has no widgets yet
- `@mui/x-studio-data-middleware` middleware validates and routes LLM requests server-side

### A-08 · Slot props chain

- `Studio.slotProps.canvas` → forwarded to `StudioCanvas`
- `StudioCanvas.slotProps.widgetCard` → forwarded to every `StudioWidgetCard`
- `StudioWidgetCard.slotProps.{ paper, chart, grid, kpi, text, filter }` → forwarded to widget renderers

### A-09 · Async data source adapter interface

- `StudioDataSourceAdapter` interface: `getRows(descriptor): Promise<StudioQueryResult>`
- `ref.setDataSourceAdapter(sourceId, adapter)` attaches/removes an adapter at runtime
- See also: **D-04**

### A-10 · `@mui/x-studio-data-middleware` middleware package

- Framework-agnostic server handler: `handleBatchQuery(request, options)`
- `runPreflight` + `executeForTier` routing (`'client' | 'server' | 'db'`)
- `buildSecureQuery` prevents injection and enforces schema allowlist
- `LRUCacheProvider` for response caching; pluggable `CacheProvider` interface
- `extractSecurityClaims` for JWT/session-based row-level security

### A-11 · `sidebarLayout` + `sidebarSide` props

- `sidebarLayout?: 'stacked' | 'tabbed'` — stacked vs. single tab rail
- `sidebarSide?: 'left' | 'right'` — which side of the canvas the sidebar is anchored to
- `DrawerPanel` and `TabbedSidebar` receive `side` and flip borders + chevron direction accordingly

### A-12 · I18n / localisation support

- `StudioLocaleText` interface with 45 string tokens
- `DEFAULT_STUDIO_LOCALE_TEXT` English defaults
- `localeText?: Partial<StudioLocaleText>` prop on `Studio`, `StudioDashboard`, and `StudioProvider`
- `useStudioLocaleText()` hook; all hardcoded strings replaced in all Studio components
- `ptBRLocaleText` Brazilian Portuguese translation included
- All locale exports from `src/index.ts`

### A-13 · Feature flags

- `featureFlags` JSON object prop configures available features per deployment
- Controls visibility of compose/filter drawers, AI chat, and other capabilities
- Available for both `Studio` and `StudioDashboard` (composed apps)

### DB-09 · Shareable filter links

- Active page-filter values (operator, value, operator2, value2) encoded as `?fv=<base64-JSON>` in the URL
- Filter state syncs to the URL automatically (300 ms debounce) as filters change
- On page load, `?fv=` is decoded and patched into `INITIAL_STATE.filters` before the controller is constructed — no visual flash
- **Copy link** toolbar button copies `window.location.href` to clipboard; shows "Copied!" tooltip for 2 seconds
- Cross-filter and widget-scoped filters are excluded from the URL encoding

### UX-01 · Map aggregation disabled without value field

- Aggregation `Select` in `MapSetupPanel` is now `disabled` and forced to `'count'` when no value field is configured
- Becomes enabled as soon as a value field is picked

### UX-02 · Settings: Compose panel label

- Renamed "Compose / edit mode" → "Compose panel" in both `x-studio` and `x-studio-composed` `SettingsDialog.tsx`
- Does not affect the edit-mode toggle, which is a separate feature

### UX-03 · Data panel: right-aligned edit/delete

- Added `flexGrow: 1; minWidth: 0` to `ExpressionFieldRow` primary-content Stack so edit/delete icon buttons are always pushed to the right
- Added `flexShrink: 0` to relationship edit/delete `IconButton`s to prevent them overlapping long relationship names

### UX-04 · Consistent calculated field UI + feature flags (BL-78, BL-79)

- Replaced `InlineFormulaBar` in `ChartSetupPanel` and `KpiSetupPanel` with a "Calculated field…" button that opens the full `StudioExpressionFieldDialog`
- Added `onSaved?: (fieldId: string) => void` callback to `StudioExpressionFieldDialog` — called after a new field is created (not on edits); used by chart/KPI panels to auto-add the new field to the widget config
- All three widget types (chart, KPI, table) now use the identical full-featured expression dialog flow, consistent with the table benchmark
- New `StudioFeatureFlags` keys: `calculatedFields` (global master), `kpiCalculatedFields`, `chartCalculatedFields`, `gridCalculatedFields`; all default to `true`; each panel gates its "Calculated field…" control on `calculatedFields !== false && <widget>CalculatedFields !== false`
- Settings dialogs in both example apps expose the four new toggles; per-widget toggles have `parentKey: 'calculatedFields'` so they disable when the global master is off
- Fixed `Studio.tsx` variable ordering: `showCompose` declaration moved before the `useEffect` that references it

### UX-05 · Feature flags: relationships + widgetFilters (BL-86)

- Added `relationships` flag to `StudioFeatureFlags` — when `false`, hides the `RelationshipPanel` in `StudioDataDrawer`; `useStudioFeatures()` defaults it to `true`
- Added `widgetFilters` flag to `StudioFeatureFlags` — when `false`, hides the "Filters" tab in `StudioWidgetEditDialog` and re-indexes the "Format" tab accordingly; `useStudioFeatures()` defaults it to `true`
- Both settings dialogs (x-studio and x-studio-composed) expose the new toggles; `relationships` uses `parentKey: 'dataManagement'` so it disables when the data drawer is hidden

### INFRA-01 · fileUtils consolidated; stateToJson/jsonToState removed from public API (BL-91)

- Duplicate `downloadJson`/`uploadJson` helpers from both example apps moved to `examples/x-studio-shared/src/fileUtils.ts` and re-exported from the shared index
- Both example apps now import file helpers from `x-studio-shared` instead of maintaining local copies
- Removed `stateToJson` and `jsonToState` from `packages/x-studio` public API (`src/index.ts` + `src/store/statePersistence.ts`) — they were convenience wrappers (`serializeState + JSON.stringify` and inverse) that were unused; consumers use `serializeState`/`deserializeState` + `loadSerializedState` through the controller directly

### INFRA-02 · Pipeline benchmark results (BL-89)

- Ran `pnpm --filter "@mui/x-studio" bench` (50 iterations, 5 warmup, Apple M2)
- Results saved in `packages/x-studio/PERF_RESULTS.md`
- All cached layers (L1–L3 warm) are 1,000–100,000× faster than cold paths
- L2 `enrichRowsWithExpressions` is the bottleneck at 100k rows (381 ms cold / 0.003 ms warm)
- L5 aggregation under 20 ms at 100k rows; A1 `buildQueryDescriptor` under 2 ms with 50 filters

### UX-06 · localStorage persistence with Reset button (BL-90)

- Both `x-studio` and `x-studio-composed` now auto-save studio config to `localStorage` on every state change (1 s debounce), so layout and widget configuration survives page reloads
- On mount, saved state is restored via `deserializeState(saved, liveDataSources)` — data rows are never persisted; only pages, widgets, filters, relationships, and expression fields
- A **Reset to demo** toolbar button (`RestoreIcon`) clears localStorage and reloads the page, restoring the built-in demo configuration
- x-studio key: `'x-studio-state'`; x-studio-composed key: `'x-studio-composed-state'`

### UX-07 · Field picker: alphabetical sort + clear icon (BL-92, BL-93)

- `DataSourceFieldSelect` now sorts options by `(sourceLabel, label)` using locale-aware comparison so grouped options appear in a consistent alphabetical order regardless of insertion order
- When a value is selected, the Autocomplete's popup chevron is replaced by a visible × clear icon (`CloseIcon`), making it immediately obvious that the selection can be cleared
- Both the `fieldsProp` (static fields list) and `dataSources` (multi-source) code paths receive the same sort

### UX-08 · SetupSection shared section component (BL-94)

- New `SetupSection` component (`packages/x-studio/src/StudioComposeDrawer/SetupSection.tsx`) wraps a section with a `<Divider>`, a caption-weight heading, and an optional description paragraph
- Replaces ad-hoc `<Divider>` + `<Typography variant="caption">` patterns in `ChartSetupPanel`, `KpiSetupPanel`, and `GridSetupPanel`
- Props: `title`, `description?`, `dividerMb?`, `children?`

### UX-09 · Canvas DnD drops between and after widgets (BL-95)

- Root cause: `RowResizeHandle` (`position:absolute; z-index:20`) was a sibling of `InsertionPoint` inside the gap box, so drag events fired on the handle but never reached the `InsertionPoint` listener
- Fix: new `WidgetGap` component owns the gap box and registers `onDragOver`/`onDragLeave`/`onDrop` at the container level where events bubble from all descendants including the resize handle
- Drop indicator is rendered inside the container at `z-index:30`, above the resize handle
- `contains(relatedTarget)` guard in `onDragLeave` prevents indicator flicker when the cursor moves between child elements

### UX-10 · 24-column widget resize grid (BL-96)

- `GRID_COLS = 24` constant replaces the previous hardcoded `12` in `StudioCanvas.tsx`; `MIN_SPAN = GRID_COLS / 4 = 6` sets the minimum widget column span
- Matching `GRID_COLS` / `MIN_SPAN_COLS` constants added to `StudioController.ts`
- All flex/width calculations, grid-line positions, overflow checks, and default span calculations updated to use `GRID_COLS`
- `setAdjacentWidgetColSpans` clamp updated from `[3, 9]` to `[MIN_SPAN_COLS, GRID_COLS − MIN_SPAN_COLS]` = `[6, 18]`
- Finer 24-col grid gives more layout precision (smallest snap unit = 4.17% of row width)

### UX-11 · Nested feature flags for kpi/chart/grid (BL-100)

- **Breaking change**: flat per-widget feature flags (`kpiSparkline`, `kpiTrend`, `kpiTarget`, `kpiCalculatedFields`, `chartAnnotations`, `chartCalculatedFields`, `gridGroupBy`, `gridSummary`, `gridConditionalFormats`, `gridCalculatedFields`) removed from `StudioFeatureFlags`
- `kpi`, `chart`, and `grid` now accept `boolean | KpiFeatureFlags | ChartFeatureFlags | GridFeatureFlags`:
  - `kpi: false` — disables KPI widget kind entirely (unchanged behaviour)
  - `kpi: { sparkline: false, trend: false }` — KPI enabled, sparkline and trend disabled
- New sub-flag interfaces `KpiFeatureFlags`, `ChartFeatureFlags`, `GridFeatureFlags` exported from the package
- `useStudioFeatures()` now returns `ResolvedStudioFeatures` (flat booleans); internal consumers (`GridSetupPanel`, `KpiSetupPanel`, etc.) unchanged
- `resolveSubFlag<T>()` helper handles the `boolean | object | undefined` union cleanly
- `FeatureFlagSettings` component in `x-studio-shared` updated to read/write the new nested structure with helper functions `isKindEnabled`, `getSubFlag`, `setSubFlag`

### UX-12 · DnD cursor, grab offset, and transparency (BL-101)

- **Grabbing cursor**: added global CSS rule `body.x-studio-dragging-widget * { cursor: grabbing !important }` (via MUI `GlobalStyles` in `StudioCanvas`); class is toggled on `document.body` in `dragstart`/`dragend` handlers — eliminates the cursor flickering to `+` or `default` as the pointer crosses insertion points or resize handles
- **Correct grab offset**: `handleMouseDown` records the click position relative to the element in `dragOffsetRef`; `handleDragStart` passes this as the `setDragImage(node, offsetX, offsetY)` offset so the ghost card appears grabbed from where the user clicked rather than from the top-left corner; also eliminates the "white bar above widget" artefact
- **Card transparency**: `requestAnimationFrame`-deferred `opacity: 0.4` is applied to the original card element _after_ the browser captures the ghost image — the ghost stays fully opaque (visible drag feedback) while the in-place card fades, making nearby insertion points visible
- **Move semantics**: `effectAllowed = 'move'` on drag source; `dropEffect = 'move'` set in all `dragover` handlers (`InsertionPoint`, `WidgetGap`)

### UX-13 · Custom widget support (BL-99)

- **New types**: `StudioCustomWidgetDef`, `StudioCustomWidgetProps`, `StudioCustomWidgetSetupPanelProps` added to `models/customWidgetTypes.ts` and exported from `@mui/x-studio`
- **Registration API**: `<Studio customWidgets={[...]} />` accepts an array of `StudioCustomWidgetDef`; each entry registers a `kind` string (namespaced custom identifier), a `component` to render on the canvas, an optional `setupPanel` for the compose drawer, plus metadata: `label`, `description`, `icon`, `requiresDataSource`, `defaultConfig`
- **`StudioCustomWidgetDef.kind`** must not collide with built-in kinds; `BuiltinStudioWidgetKind` literal union is exported for exhaustive checks
- **Widget picker** (`AddWidgetView`): custom widget types appear below built-in types; `requiresDataSource` controls whether the "no source" warning blocks creation
- **Canvas rendering** (`StudioWidgetCard`): custom widget `component` renders inside the card with the same deferred-content skeleton as built-ins; also shown in the expand dialog
- **Compose drawer** (`StudioComposeDrawer`): if the widget's kind has a registered `setupPanel`, it is mounted in the Setup tab alongside built-in panels; consumers call `useStudioController()` and `controller.updateWidgetConfig(widgetId, { customConfig: { ...changes } })` to persist config
- **`useCustomWidgetMap()`** hook exported — returns a stable `ReadonlyMap<string, StudioCustomWidgetDef>` for O(1) lookup; rebuilds only when registered kinds change
- **`createDefaultWidget`** updated to accept an `overrides` object instead of a `StudioDataSource` second argument; custom kinds receive `config.customConfig` seeded with `defaultConfig`
- **Example** (`examples/x-studio`): `AlertBannerWidget` + `AlertBannerSetupPanel` demonstrate the API — an MUI `Alert` whose title, message, and severity are configured via the compose drawer

### UX-14 · Non-editable field text selection disabled (BL-102)

- Added `userSelect: 'none'` to `Typography` elements for physical field rows, expression field rows, and section headers in `StudioDataDrawer/DataSourceSection.tsx`
- Prevents accidental text selection when clicking or dragging labels in the data drawer

### UX-15 · DataDialog scrollable (BL-104)

- Changed `overflow: 'hidden'` → `overflow: 'auto'` in the `DialogContent` of `examples/x-studio-composed/src/components/DataDialog.tsx`
- Data source dialog now scrolls when the content exceeds the dialog height

### UX-16 · Drag ghost without action overlay (BL-105)

- Widget drag ghost is now a `cloneNode(true)` of the card, positioned off-screen (`position:fixed; left:-9999px`)
- Action overlay (`[data-widget-overlay]`) hidden in the clone via `querySelector` before `setDragImage` call
- Clone gets `opacity: 0.4`; original card stays fully opaque so nearby insertion points are visible
- Clone is removed via `requestAnimationFrame` after the browser captures the drag image
- `data-widget-overlay` attribute added to both overlay Stacks in `StudioWidgetCardActionsOverlay.tsx` (edit mode and view mode)

### UX-17 · Drag type isolation; tab reorder off-by-one fix (BL-106)

- Canvas `InsertionPoint` (native DOM listeners) and `WidgetGap` (React synthetic events) now guard both `handleDragOver` and `handleDrop` with `Array.from(dataTransfer.types).includes('application/json')` — tab reorder drags can no longer activate canvas drop zones
- AppToolbar (both `x-studio` and `x-studio-composed`) sets `'text/x-studio-tab'` MIME type on tab `dragStart`; `onDragOver` and `onDrop` only respond when that type is present — widget drags cannot trigger tab reorder highlighting
- Fixed off-by-one in `handleTabDrop`: after `splice(tabDragIndex, 1)` removes the source tab, the remaining array is one element shorter, so `adjustedIndex = tabDragIndex < dropIndex ? dropIndex - 1 : dropIndex` corrects the insertion position
- `Array.from()` used throughout for cross-browser safety (`DOMStringList` in older Safari lacks `Array.prototype.includes`)

### UX-18 · Drag widget over tab to navigate pages (BL-107)

- Added `onPageDragNavigate?: (pageId: string) => void` prop to `AppToolbar` in both example apps
- Hovering a widget drag over a page tab for 600ms fires `onPageDragNavigate(pageId)`, switching to that page so the widget can be dropped on an insertion point there
- Uses tab-scoped counter + timer refs: counter increments on `dragEnter`, decrements on `dragLeave`; timer cancels only when counter reaches 0 (handles child-element enter/leave churn correctly)
- Entering a new tab while a timer is in-flight cancels the old timer and starts a fresh one for the new page — prevents navigation to the wrong tab on fast moves
- Global `document.addEventListener('dragend', cancelDragNavTimer)` ensures cleanup when drag ends or cancels outside the tabs area; unmount effect removes the listener
- Wired via `handlePageDragNavigate` callback in both `App.tsx` files

---

### UX-19 · Disable non-editable field rows in DataDialog (BL-114)

- `PhysicalFieldRow` in `DataSourceSection.tsx` now accepts `isEditMode` prop
- When `!isEditMode`: `disableRipple`, `onClick` cleared, `cursor: 'default'`, hover background transparent, `selected` cleared — fields cannot be clicked or highlighted in view mode (DataDialog)
- `ExpressionFieldRow` receives the same cursor/hover suppression alongside the existing `disableRipple` guard

### UX-20 · Nested feature flag visual hierarchy (BL-113)

- `FeatureFlagSettings` (x-studio-shared) restructured to render proper parent→child hierarchy
- Widget sub-flags (sparkline, trend, target, annotations, groupBy, summary, conditionalFormats, calculatedFields variants) now appear indented under their parent widget kind toggle
- Top-level child flags (savedFilterViews under filters, relationships under dataManagement) are indented under their parent
- Disabled items render at 0.5 opacity in addition to the Switch being disabled — visually clear which children are blocked by their parent
- Shared `FlagRow` helper component keeps rendering consistent across all toggles
- Used by all three example apps (x-studio, x-studio-composed, ag-studio) via x-studio-shared

### UX-21 · Remove inapplicable sidebar layout setting from ag-studio (BL-116)

- Removed `SidebarLayout` type, `sidebarLayout` state, `onSidebarLayoutChange` prop, and the Sidebar layout radio group from `ag-studio/src/components/SettingsDialog.tsx` and `App.tsx`
- ag-studio uses AG Grid's own sidebar; x-studio's compose/data/filter drawer layout is not applicable

### UX-22 · ag-studio example dashboard config cloned from AG Grid website (BL-117)

- Scraped the live state from `https://www.ag-grid.com/studio/example/` and reproduced the exact 4-page layout in `examples/x-studio-shared/src/vendor/mainDemoState.js`
- Pages: **Executive Overview**, **Sales Performance**, **Fulfilment**, **Returns** — each with the same widget positions (xTrack/yTrack/xSpan/ySpan on the 24-column grid), widget types, and field configs as the AG Grid reference
- Source IDs match the mainDemoData.js generators: `orders`, `products`, `customers`, `order_items`, `shipments`, `stores`
- Used by the `ag-studio` example and (when `?dataset=ag-studio`) by `x-studio` and `x-studio-composed`

### AI-03 · Chat agent tools updated for all widget types + custom widgets (BL-118)

- Updated `buildAISystemPrompt` and the chat adapter tools to describe all widget types: chart, kpi, text, grid, map, pivot, filter, and custom
- Custom widget tool (`insert_custom_widget`) added; agent prompt lists registered custom widget kinds and their `defaultConfig` shapes
- Tool descriptions reference the correct field names and config properties for new chart types (funnel, gantt/timeline, mixed, heatmap, gauge)

### UX-23 · Composition page "Building blocks" table sorted (BL-119)

- Reorganised the building blocks reference table in the composition docs: components in one group, hooks in another; each group sorted alphabetically

### UX-24 · Click unconfigured widget → widget config panel (BL-120)

- In `x-studio-composed`, clicking an unconfigured widget now opens the `StudioWidgetEditDialog` for that widget instead of the compose panel
- `onUnconfiguredClick` callback in `StudioCanvas.slotProps.widgetCard` wired to `handleEditRequest` for widgets that have no `sourceId`

### UX-25 · Pivot widget infers data source from row/column fields (BL-121)

- `StudioPivotWidget` now infers `sourceId` from the configured `rowField` or `columnField` when `sourceId` is not explicitly set
- Users can set up a pivot by choosing row and column fields; the data source is determined automatically

### UX-26 · New widget examples for all new widget types (BL-122)

- Added representative examples across all three example apps (x-studio, x-studio-composed, ag-studio) and in `salesDashboard.ts`
- New widgets: **Mixed chart** (Revenue + Units), **Heatmap** (Revenue by Category × Month), **Funnel** (Sales funnel stages), **Gantt/Timeline** (order lifecycle), **Gauge** (on-time delivery rate)
- Expression fields enriched in `salesDataGenerator.ts` to provide suitable data for map, pivot, heatmap, and funnel

### UX-27 · Gauge as sparkline option on KPI widget (BL-123)

- Added `gauge` to the KPI sparkline type enum (`StudioKpiSparklineType`)
- `KpiSparkline` renders an inline `<Gauge>` (from `@mui/x-charts`) when `sparklineType === 'gauge'`
- Config panel: sparkline type selector now includes "Gauge"; shows min/max fields when Gauge is active

### UX-28 · AG Studio dataset option in x-studio and x-studio-composed (BL-124)

- Added `?dataset=ag-studio` URL parameter support to `x-studio` and `x-studio-composed`
- When set, initialises the Studio with the AG Grid reference dataset and the exact same dashboard layout as the `ag-studio` example
- Settings dialog in both apps exposes the dataset selector; choosing "AG Studio data" reloads the page with the parameter

### UX-29 · x-studio-composed config panel fully scrollable (BL-126)

- Fixed the `SettingsDialog` in `x-studio-composed` to properly scroll; the `DialogContent` was clipping content below the viewport fold
- All settings sections (feature flags, layout, reset) now reachable by scrolling

### UX-30 · Feature flag switches replaced with checkboxes (BL-127)

- `FeatureFlagSettings` (x-studio-shared) now uses `Checkbox` components instead of `Switch` for all flags
- Indented children retain their checked/unchecked state while disabled by their parent; enabling the parent re-exposes children at their last state

### UX-31 · Remove copy-link and refresh-data from x-studio-composed (BL-128)

- Removed the "Copy link" and "Refresh data" toolbar buttons from `x-studio-composed/src/components/AppToolbar.tsx`
- These actions are x-studio–example-specific; the composed example focuses on pure composition

### UX-32 · "Edit widget" moved to x-studio-composed only (BL-129)

- Extracted `StudioWidgetEditDialog` into `examples/x-studio-composed/src/components/`
- The dialog composes `StudioComposeDrawer` inside a `Dialog`; it no longer exists in the `x-studio` package
- Each widget card's edit button in x-studio-composed opens the dialog; the bare config drawer in `x-studio` is unchanged

### UX-33 · Date range bar feature flag (BL-130)

- Added `dateRangeBar?: boolean` to `StudioFeatureFlags` (default `true`)
- `StudioCanvas` gates `<StudioDateRangeBar />` on the flag
- When `dateRangeBar` is `false` and a dashboard date-range filter is active, `StudioQuickFilterBar` surfaces those filters as chips so they remain visible and removable
- `FeatureFlagSettings` exposes the flag in the top-level list

### AI-04 · Per-widget AI assistant in x-studio-composed (BL-131)

- Added `onAiRequest?: (widgetId: string) => void` to `StudioWidgetCard`; triggers from a sparkle (AutoAwesome) button in the edit-mode overlay
- `StudioChatPanel` accepts `focusedWidgetId?: string`; the value is threaded through `createStudioChatAdapter` → `buildAISystemPrompt` where a "per-widget focus" section directs the AI toward the selected widget
- New `WidgetAiDialog` component in `x-studio-composed`: a 440 px wide dialog containing the chat panel, with `key={widgetId}` for clean per-widget conversation isolation; auto-closes if the focused widget is deleted

### UX-34 · KPI trend styled as a pill chip (BL-133)

- `KpiTrend` wraps the trend icon + percentage in an inline chip: semi-transparent background at 8% alpha of the trend colour, plus a 1 px solid border in the same colour
- "vs. period" comparison text remains outside the chip for visual hierarchy
- `getColor(theme)` helper resolves MUI palette token strings (e.g., `'success.main'`) to hex values for use with `alpha()`

### UX-35 · Tighter edit/delete buttons in data panel (BL-144)

- Reduced `IconButton` padding to `2px` for edit/delete buttons in `DataSourceSection` field rows and `RelationshipPanel` relationship rows
- Added `gap: '2px'` between the two buttons; buttons are visually tighter without overlapping hit targets

### UX-36 · Immediate grabbing cursor on mousedown (BL-145)

- Applied `x-studio-dragging-widget` class to `document.body` on `mousedown` in `StudioWidgetCard` (edit mode) and `AddWidgetView`
- The CSS rule `body.x-studio-dragging-widget * { cursor: grabbing !important; }` takes effect instantly on press, not after the browser fires `dragstart`
- Class is removed on `mouseup` and `dragend`

### UX-37 · Ghost widget transparency (BL-146)

- Reduced drag ghost opacity from `0.4` to `0.2` so insertion points and tabs remain visible underneath
- Applied in both `StudioWidgetCard` (canvas drag) and `AddWidgetView` (new-widget drag)

### UX-38 · Chrome-style tab drag (BL-147)

- Replaced HTML5 `draggable` tab reordering with pointer-event capture for smooth, native-feel tab dragging
- 5 px drag threshold separates clicks from drags; dragged tab becomes invisible while a `position: fixed` ghost follows the cursor (rendered via React portal)
- Peer tabs slide horizontally with a `translateX` CSS transition when the ghost crosses their midpoint — identical to Chrome's tab drag behaviour
- Nearest-midpoint algorithm determines the target slot using original tab rects captured at drag start (unaffected by sibling animations)
- `onClickCapture` with `stopPropagation` prevents click events from firing after a completed drag
- Implemented in both `examples/x-studio` and `examples/x-studio-composed` `AppToolbar`

### UX-39 · Read-only selected field with clear icon (BL-148)

- `DataSourceFieldSelect` now displays the selected field as a read-only `TextField` with the field's type icon as a start adornment and a `CloseIcon` button as end adornment
- Clicking the clear button calls `onChange('', '')`, reverting to the empty `Autocomplete` picker
- Prevents accidental re-selection and gives a cleaner "locked in" state for configured fields

### UX-40 · Chart sort by category or value (BL-149)

- Added `chartSortBy: 'category' | 'value'` and `chartSortDirection: 'asc' | 'desc'` to `StudioWidgetConfig`
- `'category'` sorts x-axis labels alphabetically/numerically; `'value'` sorts bars/lines by their aggregated y-value
- Both sort directions are supported for each sort key
- Implemented in `aggregateByField`, `aggregateByTwoFields`, and `aggregateMultipleSeries` — covers single-series, split-series, and multi-measure charts
- `ChartSetupPanel` renders a "Sort by" dropdown and an Asc/Desc toggle button group whenever an x-field is configured on a non-scatter chart
- All aggregation cache keys include the sort parameters to prevent stale data

### UX-41 · Data panel "View source data →" link (tooltip)

- `DataSourcePreviewTooltip` in `StudioDataDrawer/DataSourceSection.tsx` now accepts an `onOpenPreview` callback
- Tooltip content combines overflow counts ("n more rows · n more columns") on a single line and appends a **"View source data →"** link at the bottom
- Clicking the link calls `onOpenPreview(source.id)` — opening the same `DataSourcePreview` dialog as clicking a node in the lineage map
- `StudioDataDrawer.tsx` manages `previewSourceId` state and renders the preview `Dialog`

### UX-42 · AI Insight button widget-kind filter (BL-162)

- The **AI Insight** button (overflow menu) is no longer shown for `filter`, `text`, or `kpi` widgets — these do not contain data suitable for the insight types available
- For **custom widgets**, opt in by setting `aiInsight: true` in `StudioCustomWidgetDef`; the button is hidden by default
- `StudioWidgetCard.tsx` derives a `supportsInsight` boolean; `onInsightRequest` is gated by both `aiConfig?.endpoint` and `supportsInsight`

### UX-43 · "Summarise page" chat chip + `summarise_page` tool (BL-163)

- Removed the **Summarise dashboard** floating action button and bottom Drawer from `Studio.tsx`
- Added `summarise_page` as the 16th AI tool in `studioAITools.ts`; no parameters — operates on the active page
- `studioAdapter.ts` implements `case 'summarise_page'`: iterates active-page widgets, calls `buildWidgetDataSummary` with kind-appropriate sampling (`'aggregate'` for charts, `'stride'` for others), runs `detectWidgetAnomalies` for chart widgets, and returns `{ pageTitle, widgets: [{ id, title, kind, dataSummary, anomalies? }] }`
- `buildWidgetDataSummary` in `generateInsight.ts` is now exported so the adapter can call it directly
- `StudioChatPanel.tsx` adds a **Summarise page** suggestion chip in the `hasWidgets` branch
- `generateDashboardSummary` remains a public export for consumers who call it programmatically

---

### UX-44 · Bulk state patch tool — `apply_bulk_update` (BL-164)

- Added `apply_bulk_update` as the 17th AI tool in `studioAITools.ts`; accepts `widgetUpdates`, `widgetRemovals`, `widgetAdditions`, `layout`, and `colSpans`
- `studioAdapter.ts` implements `case 'apply_bulk_update'`: applies all sub-operations in order (removals → additions → config patches → layout → column spans) then commits atomically with `controller.setState()` — a single undo step
- Title references in `layout` are resolved to newly-added widget IDs so the LLM can provide a layout that includes freshly created widgets
- Failed sub-operations (e.g., unknown widget ID) are skipped and reported in `skipped[]`; successful operations proceed
- `buildAISystemPrompt.ts` updated with a guideline: prefer `apply_bulk_update` over multiple individual tool calls when a prompt requires 3 or more related changes

### BUG-01 · NaN values in charts with non-numeric y-fields (BL-171)

- `aggregateByField` now pre-scans the first non-null y-field value before entering the aggregation loop; if it is non-numeric (e.g. a string ID), the effective aggregation is promoted to `'count'` — preventing `NaN` from propagating into the rendered chart regardless of what `yAggregation` the caller passes
- Funnel chart renderer (`StudioChartWidget`) now respects `config.yAggregation === 'count'` and performs the same non-numeric auto-detection, counting rows instead of summing `Number(row[valueField])` when appropriate
- `salesDashboard.ts` config hardened with explicit aggregation settings: `yAggregation: 'count'` on Contacts by Department, Contacts by Role, and Deals by Stage; `yAggregation: 'avg'` on Margin % by Category (averaging per-product margin percentages per category is the correct metric)
- Contacts by Department changed to a horizontal bar chart; Deals by Stage layout retained horizontal
- Total Revenue gauge removed from Overview page widgetRows

### BUG-02 · Cross-filter SQL errors for expression fields on related sources (BL-172)

- `resolveField()` in `createBatchingAdapter.ts` previously only searched expression fields where `f.sourceId === primarySourceId`. A cross-filter emitted by the "Revenue by Country" pie chart used `expr-order-country` (defined on the ORDERS source), which was invisible when resolving filters on ORDER_ITEMS widgets — the raw logical ID was passed to SQL, producing "no such column: expr-order-country" errors.
- Fixed by adding **case 1b** (multi-hop JOIN resolution): when the filter field is an expression on a related source, two LEFT JOINs are emitted — `primaryTable → exprField.sourceId` (hop 1) and `exprField.sourceId → joinSourceId` (hop 2).
- `ResolvedField.join` changed to `joins?: JoinDescriptorInternal[]` to support multi-hop; all single-hop callers return a one-element array.
- Filter predicates and ORDER BY clauses now resolve the physical column via `columnAliases[r.column] ?? r.column` so `WHERE customers.country` (not `WHERE expr-order-country`) is generated.

### BUG-03 · Deals by Stage pipeline chart sorted alphabetically instead of funnel order (BL-173)

- Bars were sorted alphabetically ("Closed Lost", "Closed Won", "Negotiation", …) instead of matching the natural sales funnel sequence.
- Added `orderedValues?: string[]` to `StudioDataField` — a field-level canonical label sequence applied to any chart using that field as its x-axis. Values absent from the list are appended alphabetically at the end. `chartSortBy: 'value'` still overrides it.
- `applyCategoryOrder()` helper added to `chartAggregation.ts`; `categoryOrder?` param added to `aggregateByField`, `aggregateByTwoFields`, and `aggregateMultipleSeries`.
- `useChartWidgetData.ts` derives `xFieldOrderedValues` from the field definition and passes it to all seven aggregation call sites; cache keys updated.
- CRM `stage` field assigned `orderedValues: ['Prospecting', 'Qualification', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost']` — Closed Lost placed last (after Closed Won) to show conversion loss alongside the active funnel.

## 📋 Planned

_Nothing remaining — all tracked requirements are complete or WONTFIX._

---

## 🚫 WONTFIX

### W-15 · Per-widget chart palette override

- App theme sets chart colours globally; per-widget override adds complexity for minimal benefit

### C-07 · Row management + layout picker

- Canvas row management via drag-and-drop and reorder (C-08) covers the primary use case; a separate layout-preset picker adds limited additional value

### A-06 · Multi-user / permissions

- Out of scope for a component library; consumer applications implement their own access control
