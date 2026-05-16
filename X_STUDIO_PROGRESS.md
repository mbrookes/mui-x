# @mui/x-studio — Requirements Progress Tracker

> Source of truth: [`examples/x-studio/REQUIREMENTS-DETAILED.md`](examples/x-studio/REQUIREMENTS-DETAILED.md)
> Last updated: 2026-05-16

---

## Summary Table

| ID    | Area      | Description                               | Status       |
| ----- | --------- | ----------------------------------------- | ------------ |
| D-01  | Data      | Multi-source relational data model        | ✅ Completed |
| D-02  | Data      | Expression fields                         | ✅ Completed |
| D-03  | Data      | Cross-source join projection              | ✅ Completed |
| D-04  | Data      | Async / real data connector               | 🔭 Future    |
| D-05  | Data      | Pivot table widget                        | 🔭 Future    |
| D-06  | Data      | Ad-hoc formula bar                        | 🔭 Future    |
| D-07  | Data      | Data lineage view                         | 🔭 Future    |
| DB-01 | Dashboard | Multi-page dashboard with theming         | ✅ Completed |
| DB-02 | Dashboard | Page-level and widget-level filters       | ✅ Completed |
| DB-03 | Dashboard | Cross-filter (click-to-filter)            | ✅ Completed |
| DB-04 | Dashboard | Dashboard-level date range filter         | 📋 Planned   |
| DB-05 | Dashboard | Drill-down / detail panel                 | 📋 Planned   |
| DB-06 | Dashboard | Customers page                            | ✅ Completed |
| DB-07 | Dashboard | Data refresh simulation                   | 📋 Planned   |
| DB-08 | Dashboard | State persistence (save/restore JSON)     | ✅ Completed |
| DB-09 | Dashboard | Shareable filter links (URL encoding)     | 🔭 Future    |
| W-01  | Widget    | Grid: sort, export, cross-filter          | ✅ Completed |
| W-02  | Widget    | Grid: conditional formatting              | 📋 Planned   |
| W-03  | Widget    | Grid: totals / summary row                | 📋 Planned   |
| W-04  | Widget    | Chart: all major types + horizontal       | ✅ Completed |
| W-04a | Widget    | Chart: crossFilterMode per widget         | ✅ Completed |
| W-05  | Widget    | Chart: scatter axis configuration         | 📋 Planned   |
| W-06  | Widget    | Chart: pie/donut label formatting         | 📋 Planned   |
| W-07  | Widget    | Chart: mixed (bar + line on same axes)    | 🔭 Future    |
| W-08  | Widget    | Chart: map / choropleth                   | 🔭 Future    |
| W-09  | Widget    | Chart: Gantt / timeline                   | 🔭 Future    |
| W-10  | Widget    | Chart: heatmap                            | 🔭 Future    |
| W-11  | Widget    | Chart: funnel                             | 🔭 Future    |
| W-12  | Widget    | Chart: annotations / reference lines      | 🔭 Future    |
| W-13  | Widget    | KPI: value, trend, sparkline, formatting  | ✅ Completed |
| W-14  | Widget    | KPI: target line from business metrics    | 📋 Planned   |
| W-15  | Widget    | KPI: per-widget chart palette override    | 📋 Planned   |
| W-16  | Widget    | Text: per-section font/colour/alignment   | ✅ Completed |
| C-01  | Compose   | Widget setup and format tabs              | ✅ Completed |
| C-02  | Compose   | Chart type picker with icons              | ✅ Completed |
| C-03  | Compose   | Auto-inferred titles + manual override    | ✅ Completed |
| C-04  | Compose   | Page theming (bg, cards, palette)         | ✅ Completed |
| C-05  | Compose   | Undo / redo                               | ✅ Completed |
| C-06  | Compose   | Widget resize (column width)              | ✅ Completed |
| C-07  | Compose   | Row add/remove and layout picker          | 📋 Planned   |
| C-08  | Compose   | Widget reorder within / across rows       | 📋 Planned   |
| C-09  | Compose   | Saved views / filter presets              | 📋 Planned   |
| C-10  | Compose   | Duplicate / move widgets across pages     | 🔭 Future    |
| C-11  | Compose   | Widget template library                   | 🔭 Future    |
| C-12  | Compose   | Visual expression builder (node editor)   | 🔭 Future    |
| C-13  | Compose   | Natural language widget creation          | 🔭 Future    |
| F-01  | Filters   | Condition, Selection, Rank modes          | ✅ Completed |
| F-02  | Filters   | Relative dates, compound (AND/OR)         | ✅ Completed |
| F-03  | Filters   | Metric refs (dynamic thresholds)          | ✅ Completed |
| F-04  | Filters   | Quick filter bar above canvas             | 📋 Planned   |
| F-05  | Filters   | Global filter search                      | 📋 Planned   |
| F-06  | Filters   | Filter dependency (cascading options)     | 📋 Planned   |
| A-01  | Arch      | Reactive store + undo/redo                | ✅ Completed |
| A-02  | Arch      | Deferred render + memoized cards          | ✅ Completed |
| A-03  | Arch      | Expression field system                   | ✅ Completed |
| A-04  | Arch      | Field capability system                   | ✅ Completed |
| A-05  | Arch      | Embeddable SDK / zero-config consumer API | 🔭 Future    |
| A-06  | Arch      | Multi-user / permissions                  | 🔭 Future    |
| A-07  | Arch      | AI chat assistant (`StudioChatPanel`)     | ✅ Completed |
| A-08  | Arch      | Slot props chain (canvas → card → widget) | ✅ Completed |
| A-09  | Arch      | Async data source adapter interface       | ✅ Completed |
| A-10  | Arch      | `@mui/x-studio-server` middleware package | ✅ Completed |
| A-11  | Arch      | `sidebarLayout` + `sidebarSide` props     | ✅ Completed |

---

## ✅ Completed

### D-01 · Multi-source relational data model

- Orders, order items (1–5 per order, 595 total), customers, products, shipments, shipment items, business metrics
- Deterministic PRNG-generated data (seeded, reproducible)
- Partially Delivered status for split shipments
- Declared relationships between sources (many-to-one)

### D-02 · Expression fields

- Calculated columns (per-row scalar values from an expression tree)
- Measures (single aggregate values over the filtered dataset)
- Expression field dialog for authoring
- Expression fields appear in all field pickers (chart, KPI, grid, filters)

### D-03 · Cross-source join projection

- Chart aggregations can use a y-field from a related source
- Join path resolved automatically via declared relationships
- Sparkline time-field can be sourced from a related table

### DB-01 · Multi-page dashboard with theming

- Four pages: Overview, Products & Logistics, (third page), Customers
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

### W-01 · Grid widget

- Sortable columns, compact density
- Export to CSV
- Cross-filter source (row click)
- Column picker in compose drawer

### W-04 · Chart widget (all types + horizontal)

- Bar, bar-stacked, bar-100, line, area, area-stacked, area-100, pie, donut, scatter
- Horizontal bar layout
- Single-series, multi-Y-series, and Split-by (seriesField) data shapes
- Auto-sizing axes; chart type picker with icons (vertical + horizontal variants)

### W-13 · KPI widget

- Value + aggregation (sum / avg / count / min / max)
- Compact number formatting, prefix / suffix
- Period-over-period / YoY / custom trend with delta badge
- Sparkline (line or bar, cumulative option)
- Boolean avg rendered as percentage

### W-16 · Text widget

- Title, subtitle, body text sections
- Per-section: font family, font size, colour, alignment

### C-01–C-05 · Compose drawer

- Setup and Format tabs per widget type
- Split-by (seriesField) picker; multi-Y series picker
- Auto-inferred titles and subtitles with manual override
- Add / remove / duplicate widgets
- Undo / redo (up to 100 steps)

### F-01–F-03 · Filters

- Condition, Selection, Rank modes with mode toggle
- Relative date values (e.g. "3 months ago")
- Compound filters (second operator + AND/OR conjunction)
- Metric refs: filter value driven by a business metric row

### A-01–A-04 · Architecture

- `StudioController`: reactive `Store`, undo/redo stacks, serialization/migration
- `useSyncExternalStore`-based narrow selectors (per-widget re-render isolation)
- Deferred widget content render (single rAF batch after first paint)
- Memoized `StudioWidgetCard` and canvas rows
- Field capability system (type-derived, per-field overridable)

### DB-06 · Customers page

- KPIs: Lifetime Value, Customer Count, Avg Order Value, Enterprise Customer Count
- Filter widgets: Segment toggle and Signup Date Range picker
- Charts: Acquisition Over Time (bar/year), Revenue by Segment (donut),
  Top Customers by Revenue (horizontal bar, top 12), Quarterly Revenue by Segment (stacked area)
- Grid: Top 20 customers by total revenue with order count
- Cross-source joins via `expr-order-company`, `expr-order-segment`, `expr-order-country` expression fields

### DB-08 · State persistence (save/restore JSON)

- `ref.serializeState()` returns a JSON-safe `SerializedStudioState` snapshot
- `ref.loadSerializedState(data)` restores state and applies schema migrations
- Returns `MigrationResult` with `{ success, fromVersion, toVersion, errors }`
- Demo app provides Save (download JSON) and Load (upload JSON) toolbar buttons

### W-04a · Chart: `crossFilterMode` per widget

- `StudioCrossFilterMode = 'cross-highlight' | 'cross-filter' | 'none'`
- Set via `crossFilterMode` field in `StudioWidgetConfig`
- `'cross-highlight'` (default): shows full dataset as a faded ghost behind the filtered subset
- `'cross-filter'`: redraws chart using only the filtered rows (axes rescale)
- `'none'`: widget ignores all incoming cross-filters
- Configurable in the Chart Setup panel compose drawer

### C-06 · Widget resize (column width)

- Drag handle on the right edge of each widget card (visible in edit mode)
- Live flex-basis override during drag; snaps to 12-column grid on release
- `setWidgetColSpan` / `setWidgetColSpanInRow` on `StudioController`
- Persisted in `widgetColSpans` on the page state; serialized with dashboard state
- AI `set_widget_width` tool also drives resize programmatically

### A-07 · AI chat assistant

- `StudioChatPanel` component with slide-in overlay and streaming message rendering
- `aiConfig` prop on `Studio`: `{ endpoint, apiKey?, model?, headers? }`
- Floating action button (bottom-right) opens/closes the panel
- Built-in tool suite: add/update/remove widget, set layout, navigate pages, manage filters
- `extraTools` prop on `StudioChatPanel` for custom tool extensions
- `@mui/x-studio-server` middleware validates and routes LLM requests server-side

### A-08 · Slot props chain

- `Studio.slotProps.canvas` → forwarded to `StudioCanvas`
- `StudioCanvas.slotProps.widgetCard` → forwarded to every `StudioWidgetCard`
- `StudioWidgetCard.slotProps.{ paper, chart, grid, kpi, text, filter }` → forwarded to widget renderers
- Allows deep customisation without replacing entire components

### A-09 · Async data source adapter interface

- `StudioDataSourceAdapter` interface: `getRows(descriptor): Promise<unknown[]>`
- `ref.setDataSourceAdapter(sourceId, adapter)` attaches/removes an adapter at runtime
- When an adapter is present Studio calls it instead of the in-memory rows pipeline
- Demo `?adapter=true` mode routes all sources through a simulated server adapter

### A-10 · `@mui/x-studio-server` middleware package

- Framework-agnostic server handler: `handleBatchQuery(request, options)`
- `runPreflight` + `executeForTier` routing (`'client' | 'server' | 'db'`)
- `buildSecureQuery` prevents injection and enforces schema allowlist
- `LRUCacheProvider` for response caching; pluggable `CacheProvider` interface
- `extractSecurityClaims` for JWT/session-based row-level security

### A-11 · `sidebarLayout` + `sidebarSide` props

- `sidebarLayout?: 'stacked' | 'tabbed'` — stacked (independent collapse strips) vs. single tab rail
- `sidebarSide?: 'left' | 'right'` — which side of the canvas the sidebar is anchored to
- Right-side stacked layout renders panels Data → Compose → Filters reading right-to-left
- `DrawerPanel` and `TabbedSidebar` receive `side` and flip borders + chevron direction accordingly

---

## 🔄 In Progress

_Nothing actively in flight._

---

## 📋 Planned

### DB-04 · Dashboard-level date range filter

- **Gap:** No global date range control exists today
- Single date range picker (MUI X Date Pickers) pinned above the canvas or in a toolbar
- Drives all KPI, chart, and grid widgets simultaneously as a page-level filter
- Pre-sets: This month, Last 3 months, Last 12 months, Year to date, All time

### DB-05 · Drill-down / detail panel

- **Gap:** No way to inspect child records from a summary widget
- Click a chart segment or grid row → slide-in right panel
- Shows related child rows (e.g. order → its line items)
- Resolves relationships automatically from the declared data model
- Breadcrumb trail for multi-level drill

### DB-07 · Data refresh simulation

- **Gap:** Data is static; no live-update story
- "Refresh" button or auto-polling interval
- Re-runs PRNG with a time-shifted seed to simulate new data
- KPI trend and sparkline visibly update

### W-02 · Grid: conditional formatting

- **Gap:** No rule-based cell styling in the grid widget
- Rule-based cell colour (e.g. negative margin → red background)
- Configurable in compose Format tab: field, operator, value, colour
- Multiple rules per column; first-match wins

### W-03 · Grid: totals / summary row

- **Gap:** No aggregate footer row in grid widgets
- Pinned footer row showing sum / avg / count per configured column
- Toggle per column in compose drawer

### W-05 · Scatter chart configuration

- **Gap:** X, Y, size, and colour-by fields are hardcoded in demo config
- Expose all four axis fields in the compose drawer
- Removes hardcoded field references from the dashboard config

### W-06 · Pie / donut label formatting

- **Gap:** No label placement or content control
- Toggle: show label inside slice, outside, or legend-only
- Label content: value, percentage, or both
- Minimum slice threshold to suppress tiny-slice labels

### W-14 · KPI target line

- **Gap:** `businessMetrics` source rows are fetched but not surfaced in KPI UI
- Optional reference value (from businessMetrics) shown on sparkline
- Delta badge compares current value to target, not just prior period
- Configurable in KPI Setup: target source field + row ID

### W-15 · Per-widget chart palette override

- **Gap:** Palette is page-level only; widgets cannot deviate
- Override the page-level palette on individual chart widgets
- Same colour picker UI as the page palette panel

### C-07 · Row management + layout picker

- **Gap:** Canvas rows are hardcoded; no UI to add/remove rows
- "Add row" button at the bottom of the canvas
- "Remove row" when row is empty
- Layout picker: preset column splits (1-col, 2-equal, 3-equal, sidebar-left, sidebar-right)

### C-08 · Widget reorder within a row

- **Gap:** Widget position within a row is fixed after creation
- Drag-and-drop within a row to swap positions
- Also allow moving a widget to a different row

### C-09 · Saved views / filter presets

- **Gap:** No way to save and recall a named filter state
- Name and save the current filter state as a preset
- Recall a preset from a dropdown above the canvas
- Presets persisted in dashboard state (serializable)

### F-04 · Quick filter bar

- **Gap:** Active filters are only visible inside the filters drawer
- Compact row of active-filter chips pinned above the canvas
- Each chip shows field + summary; click jumps to that filter in the drawer
- "Clear all" shortcut

### F-05 · Global filter search

- **Gap:** No way to search the list of filter cards
- Search box at the top of the filters drawer
- Filters the list of filter cards by field name or current value

### F-06 · Filter dependency (cascading)

- **Gap:** Filter options do not narrow based on sibling filter values
- When a parent filter is set (e.g. Country = US), child options (e.g. State) narrow automatically
- Configured by declaring a dependency in the filter setup

---

## 🔭 Future

### D-04 · Real data connector

- **Gap:** All data is static in-memory arrays; no async loading
- Pluggable `DataLoader` interface: async `fetchRows(sourceId, filters)`
- Adapters for REST, GraphQL, SQL (via thin server proxy)
- Loading states and error handling in widget cards

### D-05 · Pivot table widget

- **Gap:** No pivot/crosstab widget type exists
- Row / column / value field pickers
- Collapsible row groups; export to CSV

### D-06 · Ad-hoc formula bar

- **Gap:** Expression fields require opening a full dialog
- Lightweight single-expression input in chart/KPI setup (e.g. `[revenue] / [units]`)
- Creates a one-off expression field without the full dialog

### D-07 · Data lineage view

- **Gap:** No visual representation of source relationships
- Graph view in the data drawer: sources as nodes, relationships as edges
- Click an edge to inspect join key fields

### DB-09 · Shareable links

- **Gap:** No way to share a dashboard view with filters applied
- Encode active filter state into URL query params
- Restore on page load; "Copy link" button

### W-07 · Mixed chart (bar + line)

- **Gap:** All series in a chart must be the same type
- Dual-series chart with bars + line overlay
- Secondary Y axis for the line series

### W-08 · Map / choropleth

- **Gap:** No geographic chart type
- Country / region data on a world or country map
- Colour scale from a numeric field; tooltip on hover

### W-09 · Gantt / timeline chart

- **Gap:** No time-range chart type
- Start/end date fields; optional colour-by status field
- Useful for shipment delivery window visualisation

### W-10 · Heatmap

- **Gap:** No intensity-grid chart type
- Two categorical axes + numeric value → colour intensity grid

### W-11 · Funnel chart

- **Gap:** No conversion/funnel chart type
- Ordered stages with value and drop-off %

### W-12 · Chart annotations

- **Gap:** No user-placed callouts or reference lines on charts
- Text callout or horizontal/vertical reference line
- Stored in widget config; visible in edit and view modes

### C-10 · Move widgets across pages

- **Gap:** Widgets are tied to the page they were created on
- Drag widget card from one page tab and drop onto another
- Or: right-click → "Move to page" context menu

### C-11 · Widget template library

- **Gap:** Every widget starts from scratch
- Panel of pre-built chart/KPI configs (e.g. "Revenue over time")
- Studio auto-maps fields from the active source on drop

### C-12 · Visual expression builder

- **Gap:** Expression field authoring is JSON-based / low-level
- Node-graph editor for building expression trees
- Live preview of the computed value

### C-13 · Natural language widget creation

- **Gap:** No AI-assisted widget authoring
- Text prompt → Studio infers chart type, fields, and filters

### A-05 · Embeddable SDK

- **Gap:** `@mui/x-studio` is not yet consumable as a standalone embeddable
- `<StudioDashboard config={…} dataLoader={…} />` with sensible defaults
- Zero-config mode: auto-discover sources and render a grid of KPIs
- Published as a standalone npm package

### A-06 · Multi-user / permissions

- **Gap:** No access control model
- View-only mode (no compose/filter drawers)
- Per-page and per-widget visibility rules
- User roles: viewer, editor, admin

---

## Priority Order for Planned Work

Ordered by impact on demo credibility and implementation feasibility:

| Priority | ID    | Description                       | Rationale                                                              |
| -------- | ----- | --------------------------------- | ---------------------------------------------------------------------- |
| 1        | DB-04 | Dashboard-level date range filter | Most-expected BI feature; high visual impact, straightforward to build |
| 2        | C-07  | Row management + layout picker    | Needed to build additional pages without hardcoding rows               |
| 3        | C-08  | Widget reorder                    | Completes the basic canvas authoring loop                              |
| 4        | W-05  | Scatter chart config              | Removes a "broken" feel — scatter fields are hardcoded today           |
| 5        | DB-05 | Drill-down / detail panel         | Strong demo story: from summary → detail in one click                  |
| 6        | W-14  | KPI target line                   | Closes the loop on the businessMetrics source (currently unused in UI) |
| 7        | W-02  | Grid conditional formatting       | High visual impact; commonly expected in data grids                    |
| 8        | F-04  | Quick filter bar                  | Reduces friction when applying/clearing common filters                 |
| 9        | W-03  | Grid totals row                   | Small, high-utility addition to the grid widget                        |
| 10       | C-09  | Saved filter presets              | Nice-to-have for the repeatability demo story                          |
| 11       | W-06  | Pie/donut label formatting        | Polish; current labels are acceptable                                  |
| 12       | W-15  | Per-widget palette override       | Polish; page-level palette already works well                          |
| 13       | DB-07 | Data refresh simulation           | Interesting demo moment but not critical                               |
| 14       | F-05  | Global filter search              | Only useful when filter list is long                                   |
| 15       | F-06  | Filter dependency                 | Complex to implement; limited demo benefit                             |

### Future work: priority groupings

**High value, lower complexity**

- D-06 · Ad-hoc formula bar
- W-07 · Mixed chart (bar + line)
- W-12 · Chart annotations
- DB-08 · State persistence (localStorage)

**High value, higher complexity**

- D-04 · Real data connector
- W-08 · Map / choropleth
- A-05 · Embeddable SDK
- DB-09 · Shareable links

**Exploratory / longer term**

- C-13 · Natural language widget creation
- W-09 · Gantt / timeline
- W-10 · Heatmap
- W-11 · Funnel
- A-06 · Multi-user / permissions
- D-05 · Pivot table
- D-07 · Data lineage view
- C-10 · Move widgets across pages
- C-11 · Widget template library
- C-12 · Visual expression builder
