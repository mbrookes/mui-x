# x-studio Demo: Requirements

MUI X demo application (`examples/x-studio`) — a Sales Dashboard built on `@mui/x-studio`.

The purpose of this example is to showcase the Studio component with a realistic,
production-like dataset and a credible multi-page dashboard.

---

## ✅ Completed

### Sales Data Model

- Multi-source relational data: orders, order items (1–5 per order), customers, products,
  shipments, shipment items, business metrics
- Deterministic PRNG-generated data (seeded, reproducible); activates via `?rows=N` URL param
- Partially Delivered order status for split shipments
- Expression fields: calculated columns (margin %, discount %) and measures (total revenue, avg order value)
- Declared relationships between sources (orders ↔ customers, orders ↔ products, shipments ↔ orders)
- Country-weighted order frequency for realistic revenue distribution across regions

### Dashboard Pages

- **Overview** — KPIs (total revenue, order count, avg order value), revenue over time, top products, status breakdown
- **Products & Logistics** — product grid, shipment KPIs, logistics charts
- **Customers** — lifetime value KPI, acquisition over time, revenue by segment, top customers (horizontal bar),
  customer grid; cross-source joins via `expr-order-*` expression fields
- Bookmarkable page tabs (`?page=` URL navigation)

### Demo App Shell

- External toolbar: dashboard title, page tabs, mode toggle (edit/view), undo/redo, save/load JSON, settings button
- Settings dialog: sidebar layout (tabbed/stacked) and sidebar position (left/right) toggles
- Snackbar feedback for save/load operations
- Simulated-server adapter mode (`?adapter=true`) demonstrating `StudioDataSourceAdapter`

---

## 🔄 In Progress

_Nothing actively in flight._

---

## 📋 Planned

- **Data refresh simulation** — "Refresh" button re-runs the PRNG generator with a time-shifted seed to
  simulate new data arriving; KPI trends and sparklines should visibly update
- **Shareable filter links** — encode the active filter state into URL query params; "Copy link" button
  restores the same filter view on reload

---

## 🔭 Future

- **State persistence** — auto-save dashboard config to `localStorage`; restore on reload with migration
- **Additional demo pages** — e.g. Inventory (stock levels, reorder alerts, supplier breakdown)
