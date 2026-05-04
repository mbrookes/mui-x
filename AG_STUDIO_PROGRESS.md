# x-studio Requirements Tracker

MUI X demo app (`examples/x-studio`) showcasing a Sales Dashboard built on `@mui/x-studio`.

---

## ✅ Completed

### Data Model
- Realistic multi-source data: orders, order items (1–5 per order, 595 total), customers, products, shipments, shipment items, business metrics
- Deterministic PRNG-generated data (seeded, fully reproducible)
- Partially Delivered order status for split shipments
- Expression fields: calculated columns and measures (e.g. margin %, discount %)
- Relationships between sources (orders↔customers, orders↔products, shipments↔orders)
- Cross-source join projection for chart aggregations

### Dashboard
- Two pages: Overview and Products & Logistics
- Page-level and widget-level filters
- Cross-filters (clicking a chart filters other widgets)
- Rank filters (Top N / Bottom N) with multi-series rank support
- Date filters with relative date values
- Metric refs: filter values driven by business metrics (dynamic thresholds)

### Widget Types
- **Grid**: sortable, exportable to CSV, cross-filter source, compact density
- **Chart**: bar, bar-stacked, bar-100, line, area, area-stacked, area-100, pie, donut, scatter
  - Single-series, multi-Y-series, and seriesField (split-by) data shapes
  - Horizontal bar layout
  - Auto-sizing axes (no label truncation)
  - Rank filter chips shown on card
  - Sparkline-style chart fill to widget height
- **KPI**: value, aggregation (sum/avg/count/min/max), compact formatting, trend (period-over-period, YoY, custom), sparkline, prefix/suffix, boolean avg as percent; filter tooltip on hover
- **Text**: title, subtitle, body sections with per-section font family / size / colour / alignment

### Compose Drawer (Edit UI)
- Widget type switcher
- Per-widget Setup and Format tabs
- Chart type picker with icons (including horizontal variants)
- Split by (seriesField) picker
- Multi-Y series picker
- Auto-inferred widget titles and subtitles (with manual override)
- Page config: background, card background/padding/radius/border, chart palette
- Chart palette picker: 4 named palettes + custom colour list
- Color swatches with crayon icon and contrast-aware icon colour
- Text widget: full per-section formatting (title, subtitle, body)
- KPI setup: value field, aggregation, sparkline, trend, compact toggle, prefix/suffix
- Add/remove widgets, duplicate widget
- Undo/redo

### Filters Drawer
- Condition, Selection, and Rank filter modes
- Relative date values
- Compound filters (AND/OR second condition)
- Selection filter with multi-select chips and field value enumeration
- Rank filter with direction, count, rank-by field

### Architecture
- `StudioController` class with undo/redo, state serialization/migration
- `useSyncExternalStore`-based reactive selectors
- Deferred widget content render (single rAF batched)
- Memoized widget cards to prevent render cascades
- Collapsible drawer sections with consistent style
- Modular icon system (per-file, field type icons with generated badge)
- `DrawerSubheaderContext` for sticky tabs outside scroll area
- Expression field dialog (calculated columns and measures)
- Field capability system (type-derived, overridable)

---

## 🔄 In Progress

_Nothing actively in flight right now._

---

## 📋 Planned

Higher priority items the app needs for a credible demo:

### Dashboard Content
- **Scheduled data refresh simulation** — show that widget data updates when the underlying source changes (e.g. a "refresh" button or polling interval in the demo)
- **Dashboard-level date range filter** — single date picker that drives all KPIs and charts at once
- **Drill-down / detail panel** — click a chart bar or grid row to open a slide-in detail panel (e.g. order → line items)
- **More demo pages** — e.g. "Customers" page: lifetime value, acquisition over time, top customers table

### Widget Features
- **Scatter chart configuration** — expose X/Y/size/colour fields in compose drawer (currently hardcoded)
- **Pie/donut label formatting** — show value or percent inside/outside slices
- **Table totals row** in grid widget (sum/avg footer)
- **Conditional formatting** for grid cells (e.g. red for negative margin)
- **Multiple chart palette overrides** per widget (override page palette on individual chart)
- **KPI target line** — show a target value from businessMetrics alongside the KPI value and sparkline

### Compose / Config UX
- **Widget resize** — drag to change column width within a row
- **Add/remove rows** from the canvas
- **Row layout picker** — choose from preset column splits (1-col, 2-equal, 3-equal, 2:1, etc.)
- **Widget reorder** within a row via drag-and-drop
- **Saved views / filter presets** — name and recall a set of filters

### Filters
- **Global search** across all filter fields
- **Filter dependency** — child filter options narrow based on parent filter (e.g. state → city)
- **Quick filter bar** above the canvas — surfaced shortcuts for the most common filters

---

## 🔭 Future

Lower priority or larger scope ideas:

### Platform
- **Real data connector** — replace static TypeScript arrays with a pluggable async data loader (REST/GraphQL/SQL)
- **State persistence** — save/restore dashboard config to localStorage or a backend
- **Shareable links** — encode filter state in the URL
- **Multi-user / permissions** — view-only mode, widget-level visibility controls
- **Embeddable SDK** — `<StudioDashboard config={...} />` with zero-config defaults for external consumers

### Authoring
- **Natural language widget creation** — describe a chart in plain text; Studio infers fields and config
- **Duplicate / move widgets across pages**
- **Widget template library** — pre-built chart/KPI configs the user can drop onto the canvas
- **Custom expression builder UI** — visual node editor for expression fields (replaces JSON editing)

### Visualisation
- **Map / choropleth chart type** — country/region data on a world map
- **Gantt / timeline chart** — useful for shipment delivery windows
- **Heatmap chart type** — correlation matrix
- **Funnel chart type**
- **Mixed chart type** — bar + line on the same axes (e.g. revenue bars + margin % line)
- **Annotations** — add a text callout or reference line to a chart

### Data
- **Calculated fields on the fly** — ad-hoc formula bar in chart setup (without the full expression dialog)
- **Pivot table widget**
- **Data lineage view** — visualise join paths between sources in the data drawer
