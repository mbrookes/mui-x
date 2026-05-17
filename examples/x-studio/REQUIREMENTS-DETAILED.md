# x-studio Demo: Dashboard Content Specification

Detailed spec of what the `examples/x-studio` demo dashboard actually contains.
For the lightweight tracker see `REQUIREMENTS.md`.
For component-level planned features see the root `BACKLOG.md`.

---

## Summary Table

| ID    | Area      | Description                                       | Status     |
| :---- | :-------- | :------------------------------------------------ | :--------- |
| D-01  | Data      | Multi-source relational sales data model          | ✅ Done    |
| D-02  | Data      | Expression fields (calculated columns & measures) | ✅ Done    |
| D-03  | Data      | Cross-source join projection                      | ✅ Done    |
| DB-01 | Dashboard | Four-page dashboard                               | ✅ Done    |
| DB-02 | Dashboard | Page-level and widget-level filters               | ✅ Done    |
| DB-03 | Dashboard | Cross-filter (click-to-filter)                    | ✅ Done    |
| DB-04 | Dashboard | Customers page                                    | ✅ Done    |
| DB-05 | Dashboard | Data refresh simulation                           | 📋 Planned |
| DB-06 | Dashboard | Shareable filter links                            | 🔭 Future  |
| DB-07 | Dashboard | State persistence (localStorage)                  | 🔭 Future  |
| DB-08 | Dashboard | Additional demo pages (e.g. Inventory)            | 🔭 Future  |

---

## ✅ Completed

### D-01 · Multi-source relational data model

- Orders, order items (1–5 per order), customers, products, shipments, shipment items, business metrics
- Deterministic PRNG-generated data (seeded, reproducible); activates via `?rows=N` URL param
- Partially Delivered order status for split shipments
- Country-weighted order frequency (`COUNTRY_ORDER_WEIGHTS`) for realistic revenue distribution
- Declared relationships between sources (many-to-one)

### D-02 · Expression fields

- Calculated columns: per-row scalar values (e.g. `margin %`, `discount %`, `expr-order-country`)
- Measures: single aggregate values over the filtered dataset (e.g. `total revenue`, `avg order value`)
- Expression field dialog for authoring
- Expression fields appear in all field pickers (chart, KPI, grid, filters)

### D-03 · Cross-source join projection

- Chart aggregations can use a y-field from a related source
- Join path resolved automatically via declared relationships
- Sparkline time-field can be sourced from a related table

### DB-01 · Dashboard pages

**Overview page**

- KPIs: Total Revenue (sum), Order Count (count), Avg Order Value, Enterprise Customer Count
- Charts: Revenue Over Time (line by month), Revenue by Category (bar, split by category),
  Top Products by Revenue (horizontal bar, top 10), Order Status Breakdown (donut)
- Grid: Recent orders with status, country, total
- Interactive filters: Date Range, Status toggle

**Products & Logistics page**

- KPIs: Total Shipped Value, On-Time Delivery %, Average Shipment Days
- Charts: Shipments by Status (donut), Revenue by Product Category (bar-stacked),
  Monthly Shipments (area)
- Grid: Products with revenue, order count, avg margin

**Customers page** (see DB-04)

### DB-02 · Page-level and widget-level filters (as used in the demo)

- Filters drawer scope control: page vs. widget
- Condition mode with all operators, compound AND/OR, relative dates
- Selection mode: multi-select chips with field value enumeration
- Rank mode: Top N / Bottom N with rank-by field
- Metric refs: filter value driven by a business metric row

### DB-03 · Cross-filter (as used in the demo)

- Clicking a chart bar/slice emits a cross-filter to other widgets on the page
- Grid row click also emits a cross-filter
- Source widget excluded from its own cross-filter
- Cross-filter scope separate from user-defined page/widget filters

### DB-04 · Customers page

- KPIs: Lifetime Value (sum of order totals), Customer Count, Avg Order Value, Enterprise Customer Count
- Filter widgets: Segment toggle (chip buttons) and Signup Date Range (date picker pair)
- Charts: Customer Acquisition Over Time (bar by year), Revenue by Segment (donut),
  Top Customers by Revenue (horizontal bar, top 12), Quarterly Revenue by Segment (stacked area)
- Grid: Top 20 customers by total revenue, order count + revenue sum
- Cross-source joins: order-based charts use `expr-order-company`, `expr-order-segment`,
  `expr-order-country` expression fields
- Filter widgets pass `filterSourceId` for cross-source application
- Bookmarkable via `?page=customers`

---

## 📋 Planned

### DB-05 · Data refresh simulation

- "Refresh" button in the demo toolbar
- Re-runs the PRNG generator with a time-shifted seed to simulate new data arriving
- KPI trend deltas and sparklines should visibly update after refresh

---

## 🔭 Future

### DB-06 · Shareable filter links

- Encode the active filter state into URL query params
- "Copy link" button restores the same view on reload

### DB-07 · State persistence

- Auto-save dashboard config to `localStorage` on every change
- Restore on page reload with schema migration

### DB-08 · Additional demo pages

- **Inventory** page: stock levels, reorder alerts, supplier breakdown chart
| D-02  | Data      | Expression fields (calculated columns & measures) | ✅ Done    |
| D-03  | Data      | Cross-source join projection                      | ✅ Done    |
| D-04  | Data      | Async / real data connector                       | 🔭 Future  |
| D-05  | Data      | Pivot table widget                                | 🔭 Future  |
| D-06  | Data      | Ad-hoc formula bar in chart setup                 | 🔭 Future  |
| D-07  | Data      | Data lineage view                                 | 🔭 Future  |
| DB-01 | Dashboard | Multi-page dashboard with theming                 | ✅ Done    |
| DB-02 | Dashboard | Page-level and widget-level filters               | ✅ Done    |
| DB-03 | Dashboard | Cross-filter (click-to-filter)                    | ✅ Done    |
| DB-04 | Dashboard | Dashboard-level date range filter                 | 📋 Planned |
| DB-05 | Dashboard | Drill-down / detail panel                         | 📋 Planned |
| DB-06 | Dashboard | Additional demo pages (Customers etc.)            | ✅ Done    |
| DB-07 | Dashboard | Data refresh simulation                           | 📋 Planned |
| DB-08 | Dashboard | State persistence (save/restore)                  | 🔭 Future  |
| DB-09 | Dashboard | Shareable filter links (URL encoding)             | 🔭 Future  |
| W-01  | Widget    | Grid: sort, export, cross-filter                  | ✅ Done    |
| W-02  | Widget    | Grid: conditional formatting                      | 📋 Planned |
| W-03  | Widget    | Grid: totals / summary row                        | 📋 Planned |
| W-04  | Widget    | Chart: all major types + horizontal               | ✅ Done    |
| W-05  | Widget    | Chart: scatter axis configuration                 | 📋 Planned |
| W-06  | Widget    | Chart: pie/donut label formatting                 | 📋 Planned |
| W-07  | Widget    | Chart: mixed (bar + line on same axes)            | 🔭 Future  |
| W-08  | Widget    | Chart: map / choropleth                           | 🔭 Future  |
| W-09  | Widget    | Chart: Gantt / timeline                           | 🔭 Future  |
| W-10  | Widget    | Chart: heatmap                                    | 🔭 Future  |
| W-11  | Widget    | Chart: funnel                                     | 🔭 Future  |
| W-12  | Widget    | Chart: annotations / reference lines              | 🔭 Future  |
| W-13  | Widget    | KPI: value, trend, sparkline, formatting          | ✅ Done    |
| W-14  | Widget    | KPI: target line from business metrics            | 📋 Planned |
| W-15  | Widget    | KPI: per-widget chart palette override            | 📋 Planned |
| W-16  | Widget    | Text: per-section font/colour/alignment           | ✅ Done    |
| C-01  | Compose   | Widget setup and format tabs                      | ✅ Done    |
| C-02  | Compose   | Chart type picker with icons                      | ✅ Done    |
| C-03  | Compose   | Auto-inferred titles + manual override            | ✅ Done    |
| C-04  | Compose   | Page theming (bg, cards, palette)                 | ✅ Done    |
| C-05  | Compose   | Undo / redo                                       | ✅ Done    |
| C-06  | Compose   | Widget resize (column width)                      | 📋 Planned |
| C-07  | Compose   | Row add/remove and layout picker                  | 📋 Planned |
| C-08  | Compose   | Widget reorder within a row                       | 📋 Planned |
| C-09  | Compose   | Saved views / filter presets                      | 📋 Planned |
| C-10  | Compose   | Duplicate / move widgets across pages             | 🔭 Future  |
| C-11  | Compose   | Widget template library                           | 🔭 Future  |
| C-12  | Compose   | Visual expression builder (node editor)           | 🔭 Future  |
| C-13  | Compose   | Natural language widget creation                  | 🔭 Future  |
| F-01  | Filters   | Condition, Selection, Rank modes                  | ✅ Done    |
| F-02  | Filters   | Relative dates, compound (AND/OR)                 | ✅ Done    |
| F-03  | Filters   | Metric refs (dynamic thresholds)                  | ✅ Done    |
| F-04  | Filters   | Quick filter bar above canvas                     | 📋 Planned |
| F-05  | Filters   | Global filter search                              | 📋 Planned |
| F-06  | Filters   | Filter dependency (cascading options)             | 📋 Planned |
| A-01  | Arch      | Reactive store + undo/redo                        | ✅ Done    |
| A-02  | Arch      | Deferred render + memoized cards                  | ✅ Done    |
| A-03  | Arch      | Expression field system                           | ✅ Done    |
| A-04  | Arch      | Field capability system                           | ✅ Done    |
| A-05  | Arch      | Embeddable SDK / zero-config consumer API         | 🔭 Future  |
| A-06  | Arch      | Multi-user / permissions                          | 🔭 Future  |

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

- Two pages: Overview and Products & Logistics
- Per-page theme: background colour, card background/padding/radius/border
- Chart palette per page (4 named palettes + custom colour list)
- Crayon color swatches with contrast-aware icon colour

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
- Auto-sizing axes (no label truncation)
- Rank filter chip displayed on card header
- Chart fills full widget card height
- Chart type picker with icons (vertical + horizontal variants)

### W-13 · KPI widget

- Value + aggregation (sum / avg / count / min / max)
- Compact number formatting, prefix / suffix
- Period-over-period / YoY / custom trend with delta badge
- Sparkline (line or bar, cumulative option)
- Boolean avg rendered as percentage
- Active filter summary shown as tooltip on the value

### W-16 · Text widget

- Title, subtitle, body text sections
- Per-section: font family (serif / monospace / default), font size, colour, alignment

### C-01–C-05 · Compose drawer

- Setup and Format tabs per widget type
- Chart type picker with icons
- Split-by (seriesField) picker; multi-Y series picker
- Auto-inferred titles and subtitles with manual override via bolt icon
- Add / remove / duplicate widgets
- Undo / redo (up to 100 steps)

### F-01–F-03 · Filters

- Condition, Selection, Rank modes with mode toggle
- Relative date values (e.g. "3 months ago")
- Compound filters (second operator + AND/OR conjunction)
- Metric refs: filter value driven by a business metric row

### A-01–A-04 · Architecture

- `StudioController` class: reactive `Store`, undo/redo stacks, serialization/migration
- `useSyncExternalStore`-based narrow selectors (per-widget re-render isolation)
- Deferred widget content render (single rAF batch after first paint)
- Memoized `StudioWidgetCard` and canvas rows
- Field capability system (type-derived, per-field overridable)
- Modular icon system; `DrawerSubheaderContext` for sticky tabs

### DB-06 · Customers page

- KPIs: Lifetime Value (sum of order totals), Customer Count, Avg Order Value, Enterprise Customer Count
- Filter widgets: Segment toggle (chip buttons) and Signup Date Range (date picker pair)
- Charts: Customer Acquisition Over Time (bar by year), Revenue by Segment (donut), Top Customers by Revenue (horizontal bar, top 12), Quarterly Revenue by Segment (stacked area)
- Grid: Top 20 customers by total revenue, grouped by company with order count + revenue sum
- Cross-source join: order-based charts use `expr-order-company`, `expr-order-segment`, `expr-order-country` expression fields
- Filter widgets pass `filterSourceId` so interactive filters apply cross-source (e.g. segment filter on customers → orders join)
- Bookmarkable tabs: page is navigable via URL hash (`#page-4`)
- Page theme: `mangoFusion` chart palette

---

## 🔄 In Progress

_Nothing actively in flight._

---

## 📋 Planned

### DB-04 · Dashboard-level date range filter

- Single date range picker (MUI X Date Pickers) pinned above the canvas or in a toolbar
- Drives all KPI, chart, and grid widgets simultaneously as a page-level filter
- Pre-sets: This month, Last 3 months, Last 12 months, Year to date, All time

### DB-05 · Drill-down / detail panel

- Click a chart segment or grid row → slide-in right panel
- Shows related child rows (e.g. order → its line items)
- Resolves relationships automatically from the declared data model
- Breadcrumb trail for multi-level drill

### DB-06 · Additional demo pages

- "Customers" page: lifetime value KPI, acquisition over time chart, top-customers grid
- Possible "Inventory" page: stock levels, reorder alerts, supplier breakdown

### DB-07 · Data refresh simulation

- "Refresh" button or auto-polling interval in the demo app
- Re-runs the PRNG generator with a time-shifted seed to simulate new data arriving
- KPI trend and sparkline should visibly update

### W-02 · Grid: conditional formatting

- Rule-based cell colour (e.g. negative margin → red background)
- Configurable in compose Format tab: field, operator, value, colour
- Multiple rules per column; first-match wins

### W-03 · Grid: totals / summary row

- Pinned footer row showing sum / avg / count per configured column
- Toggle per column in compose drawer

### W-05 · Scatter chart configuration

- Expose X field, Y field, size field, and colour-by field in compose drawer
- Currently these are hardcoded in the demo dashboard config

### W-06 · Pie / donut label formatting

- Toggle: show label inside slice, outside, or as legend-only
- Label content: value, percentage, or both
- Minimum slice threshold to suppress tiny-slice labels

### W-14 · KPI target line

- Optional reference value (from businessMetrics source) shown on sparkline
- Delta badge compares current value to target, not just prior period
- Configurable in KPI Setup: target source field + row ID

### W-15 · Per-widget chart palette override

- Override the page-level palette on individual chart widgets
- Uses the same colour picker UI as the page palette panel

### C-06 · Widget resize

- Drag handle on widget card edge to change column width within a row
- Snaps to MUI Grid breakpoints (1–12 columns)
- Persisted in `widgetRows` layout config

### C-07 · Row management + layout picker

- "Add row" button at the bottom of the canvas
- "Remove row" when the row is empty
- Layout picker: preset column splits (1-col, 2-equal, 3-equal, sidebar-left, sidebar-right)

### C-08 · Widget reorder within a row

- Drag-and-drop within a row to swap widget positions
- Also allow moving a widget to a different row

### C-09 · Saved views / filter presets

- Name and save the current filter state as a preset
- Recall a preset from a dropdown above the canvas
- Presets persisted in dashboard state (serializable)

### F-04 · Quick filter bar

- Compact row of active-filter chips pinned above the canvas
- Each chip shows field + summary; click to jump to that filter in the drawer
- "Clear all" shortcut

### F-05 · Global filter search

- Search box at the top of the filters drawer
- Filters the list of filter cards by field name or current value

### F-06 · Filter dependency (cascading)

- When a parent filter is set (e.g. Country = US), child filter options (e.g. State) narrow automatically
- Configured by declaring a dependency in the filter setup

---

## 🔭 Future

### D-04 · Real data connector

- Pluggable `DataLoader` interface: async `fetchRows(sourceId, filters)` instead of static arrays
- Adapters for REST, GraphQL, SQL (via a thin server proxy)
- Loading states and error handling in widget cards

### D-05 · Pivot table widget

- Row / column / value field pickers
- Collapsible row groups
- Export to CSV

### D-06 · Ad-hoc formula bar

- Lightweight single-expression input in chart/KPI setup (e.g. `[revenue] / [units]`)
- Creates a one-off expression field without opening the full dialog

### D-07 · Data lineage view

- Graph view in the data drawer showing sources as nodes and relationships as edges
- Click an edge to inspect the join key fields

### DB-08 · State persistence

- Save dashboard config to `localStorage` (auto-save on change)
- Optional server backend: POST/GET via a configurable endpoint
- Migration on load to handle schema version upgrades

### DB-09 · Shareable links

- Encode active filter state into URL query params
- Restore filter state on page load from URL
- "Copy link" button with current filters applied

### W-07 · Mixed chart (bar + line)

- Dual-series chart with one series as bars and another as a line overlay
- Secondary Y axis for the line series (e.g. revenue bars + margin % line)

### W-08 · Map / choropleth

- Country or region data plotted on a world/country map
- Colour scale from a numeric field; tooltip with value on hover

### W-09 · Gantt / timeline chart

- Useful for shipment delivery windows (estimated vs. actual)
- Start/end date fields; optional colour-by status field

### W-10 · Heatmap

- Two categorical axes + a numeric value → colour intensity grid
- Useful for: day-of-week × hour revenue, product × region sales

### W-11 · Funnel chart

- Ordered stages with value and drop-off %
- Useful for: order → shipped → delivered → returned conversion

### W-12 · Chart annotations

- User-placed text callout or horizontal/vertical reference line on a chart
- Stored in widget config; visible in both edit and view modes

### C-10 · Move widgets across pages

- Drag a widget card from one page tab and drop it onto another
- Or: right-click → "Move to page" context menu

### C-11 · Widget template library

- Panel of pre-built chart/KPI configs (e.g. "Revenue over time", "Top products bar")
- Drag a template onto the canvas; Studio auto-maps fields from the active source

### C-12 · Visual expression builder

- Node-graph editor for building expression trees
- Replaces the JSON-based expression field dialog
- Live preview of the computed value

### C-13 · Natural language widget creation

- Text input: "Show me revenue by country as a bar chart for last year"
- Studio infers chart type, fields, and filters from the prompt

### A-05 · Embeddable SDK

- `<StudioDashboard config={…} dataLoader={…} />` with sensible defaults
- Zero-config mode: auto-discover sources and render a grid of KPIs
- Published as a standalone npm package separate from the MUI X monorepo

### A-06 · Multi-user / permissions

- View-only mode (no compose/filter drawers)
- Per-page and per-widget visibility rules
- User roles: viewer, editor, admin

---

## Priority Order for Planned Work

Ordered by impact on demo credibility and implementation feasibility:

| Priority | ID    | Description                       | Rationale                                                              |
| -------- | ----- | --------------------------------- | ---------------------------------------------------------------------- |
| 1        | DB-04 | Dashboard-level date range filter | Most-expected BI feature; high visual impact, straightforward to build |
| 2        | C-06  | Widget resize                     | Immediately noticeable gap in the edit experience                      |
| 3        | C-07  | Row management + layout picker    | Needed to build a third page without hardcoding                        |
| 4        | C-08  | Widget reorder                    | Completes the basic canvas authoring loop                              |
| 5        | W-05  | Scatter chart config              | Removes a "broken" feel — scatter fields are hardcoded today           |
| 6        | DB-05 | Drill-down / detail panel         | Strong demo story: from summary → detail in one click                  |
| 7        | W-14  | KPI target line                   | Closes the loop on the businessMetrics source (currently unused in UI) |
| 8        | W-02  | Grid conditional formatting       | High visual impact, commonly expected in data grids                    |
| 9        | F-04  | Quick filter bar                  | Reduces friction when applying/clearing common filters                 |
| 10       | W-03  | Grid totals row                   | Small, high-utility addition to the grid widget                        |
| 11       | DB-06 | More demo pages (Customers)       | More content = more compelling demo                                    |
| 12       | C-09  | Saved filter presets              | Nice-to-have for the demo story around repeatability                   |
| 13       | W-06  | Pie/donut label formatting        | Polish; current labels are acceptable                                  |
| 14       | W-15  | Per-widget palette override       | Polish; page-level palette already works well                          |
| 15       | DB-07 | Data refresh simulation           | Interesting demo moment but not critical                               |
| 16       | F-05  | Global filter search              | Only useful when filter list is long                                   |
| 17       | F-06  | Filter dependency                 | Complex to implement; limited demo benefit                             |

### Future work: priority groupings

**High value, lower complexity**

- D-06 Ad-hoc formula bar
- W-07 Mixed chart (bar + line)
- W-12 Chart annotations
- DB-08 State persistence (localStorage)

**High value, higher complexity**

- D-04 Real data connector
- W-08 Map / choropleth
- A-05 Embeddable SDK
- DB-09 Shareable links

**Exploratory / longer term**

- C-13 Natural language widget creation
- W-09 Gantt / timeline
- W-10 Heatmap
- W-11 Funnel
- A-06 Multi-user / permissions
- D-05 Pivot table
