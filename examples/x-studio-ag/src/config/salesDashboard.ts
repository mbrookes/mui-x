// AG Studio initial state for the Sales Dashboard.
// Widget types: 'text', 'value' (KPI), 'bar-chart-grouped', 'line-chart', 'pie-chart', 'grid', 'list-filter'
// Field refs use 'sourceId.fieldName' format; aggregation is optional per-field.
// Layout: 24-column grid; yTrack/ySpan are row units.

// Page labels used for the navigation tabs in App.tsx
export const PAGES = [
  { id: 'page-1', label: 'Overview' },
  { id: 'page-2', label: 'Products' },
  { id: 'page-3', label: 'Logistics' },
  { id: 'page-4', label: 'Customers' },
] as const;

export const AG_SALES_DASHBOARD_STATE = {
  selectedPageId: 'page-1',
  pages: [
    // ── Page 1: Overview ─────────────────────────────────────────────────────
    {
      id: 'page-1',
      widgets: {
        'text-hero': {
          type: 'text',
          dataMapping: {},
          format: {
            style: {
              text: 'Sales Performance Overview',
              textAlign: 'center',
              verticalAlign: 'center',
              typography: { fontSize: 32, fontWeight: 'bold' },
            },
          },
        },
        'filter-country': {
          type: 'list-filter',
          dataMapping: { value: [{ id: 'source-customers.country' }] },
          format: { title: { enabled: true, text: 'Country' } },
        },
        'filter-status': {
          type: 'list-filter',
          dataMapping: { value: [{ id: 'source-orders.status' }] },
          format: { title: { enabled: true, text: 'Order Status' } },
        },
        'kpi-orders': {
          type: 'value',
          dataMapping: { value: [{ id: 'source-orders.id', aggregation: 'count' }] },
          format: { title: { enabled: true, text: 'Total Orders' } },
        },
        'kpi-revenue': {
          type: 'value',
          dataMapping: { value: [{ id: 'source-order-items.total', aggregation: 'sum' }] },
          format: { title: { enabled: true, text: 'Total Revenue' } },
        },
        'kpi-customers': {
          type: 'value',
          dataMapping: { value: [{ id: 'source-customers.id', aggregation: 'count' }] },
          format: { title: { enabled: true, text: 'Active Customers' } },
        },
        'kpi-avg-discount': {
          type: 'value',
          dataMapping: { value: [{ id: 'source-order-items.discount', aggregation: 'avg' }] },
          format: { title: { enabled: true, text: 'Avg Discount' } },
        },
        'chart-revenue-by-category': {
          type: 'bar-chart-grouped',
          dataMapping: {
            categoryKey: [{ id: 'source-order-items.category' }],
            valueKey: [{ id: 'source-order-items.total', aggregation: 'sum' }],
          },
          format: { title: { enabled: true, text: 'Revenue by Category' } },
        },
        'chart-category': {
          type: 'pie-chart',
          dataMapping: {
            categoryKey: [{ id: 'source-order-items.category' }],
            valueKey: [{ id: 'source-order-items.total', aggregation: 'sum' }],
          },
          format: { title: { enabled: true, text: 'Revenue Split by Category' } },
        },
        'chart-country': {
          type: 'pie-chart',
          dataMapping: {
            categoryKey: [{ id: 'source-customers.country' }],
            valueKey: [{ id: 'source-orders.total', aggregation: 'sum' }],
          },
          format: { title: { enabled: true, text: 'Revenue by Country' } },
        },
        'orders-grid': {
          type: 'grid',
          dataMapping: {
            cols: [
              { id: 'source-orders.id' },
              { id: 'source-orders.date' },
              { id: 'source-orders.status' },
              { id: 'source-orders.total' },
            ],
          },
          format: { title: { enabled: true, text: 'Recent Orders' } },
        },
      },
      widgetLayout: {
        'text-hero': { xTrack: 0, yTrack: 0, xSpan: 24, ySpan: 8 },
        'filter-country': { xTrack: 0, yTrack: 8, xSpan: 12, ySpan: 10 },
        'filter-status': { xTrack: 12, yTrack: 8, xSpan: 12, ySpan: 10 },
        'kpi-orders': { xTrack: 0, yTrack: 18, xSpan: 6, ySpan: 16 },
        'kpi-revenue': { xTrack: 6, yTrack: 18, xSpan: 6, ySpan: 16 },
        'kpi-customers': { xTrack: 12, yTrack: 18, xSpan: 6, ySpan: 16 },
        'kpi-avg-discount': { xTrack: 18, yTrack: 18, xSpan: 6, ySpan: 16 },
        'chart-revenue-by-category': { xTrack: 0, yTrack: 34, xSpan: 24, ySpan: 20 },
        'chart-category': { xTrack: 0, yTrack: 54, xSpan: 12, ySpan: 20 },
        'chart-country': { xTrack: 12, yTrack: 54, xSpan: 12, ySpan: 20 },
        'orders-grid': { xTrack: 0, yTrack: 74, xSpan: 24, ySpan: 24 },
      },
    },

    // ── Page 2: Products ─────────────────────────────────────────────────────
    {
      id: 'page-2',
      widgets: {
        'text-products': {
          type: 'text',
          dataMapping: {},
          format: {
            style: {
              text: 'Product Portfolio',
              textAlign: 'center',
              verticalAlign: 'center',
              typography: { fontSize: 32, fontWeight: 'bold' },
            },
          },
        },
        'filter2-category': {
          type: 'list-filter',
          dataMapping: { value: [{ id: 'source-products.category' }] },
          format: { title: { enabled: true, text: 'Category' } },
        },
        'kpi2-units-sold': {
          type: 'value',
          dataMapping: { value: [{ id: 'source-order-items.quantity', aggregation: 'sum' }] },
          format: { title: { enabled: true, text: 'Units Sold' } },
        },
        'kpi2-avg-price': {
          type: 'value',
          dataMapping: { value: [{ id: 'source-products.price', aggregation: 'avg' }] },
          format: { title: { enabled: true, text: 'Avg Unit Price' } },
        },
        'kpi2-total-stock': {
          type: 'value',
          dataMapping: { value: [{ id: 'source-products.stock', aggregation: 'sum' }] },
          format: { title: { enabled: true, text: 'Total Stock' } },
        },
        'chart2-price-by-category': {
          type: 'bar-chart-grouped',
          dataMapping: {
            categoryKey: [{ id: 'source-products.category' }],
            valueKey: [{ id: 'source-products.price', aggregation: 'avg' }],
          },
          format: { title: { enabled: true, text: 'Avg Price by Category' } },
        },
        'chart2-stock-by-category': {
          type: 'bar-chart-grouped',
          dataMapping: {
            categoryKey: [{ id: 'source-products.category' }],
            valueKey: [{ id: 'source-products.stock', aggregation: 'sum' }],
          },
          format: { title: { enabled: true, text: 'Stock by Category' } },
        },
        'chart2-cost-by-category': {
          type: 'bar-chart-grouped',
          dataMapping: {
            categoryKey: [{ id: 'source-products.category' }],
            valueKey: [{ id: 'source-products.cost', aggregation: 'avg' }],
          },
          format: { title: { enabled: true, text: 'Avg Cost by Category' } },
        },
        'chart2-units-by-category': {
          type: 'bar-chart-grouped',
          dataMapping: {
            categoryKey: [{ id: 'source-order-items.category' }],
            valueKey: [{ id: 'source-order-items.quantity', aggregation: 'sum' }],
          },
          format: { title: { enabled: true, text: 'Units Sold by Category' } },
        },
        'grid2-products': {
          type: 'grid',
          dataMapping: {
            cols: [
              { id: 'source-products.id' },
              { id: 'source-products.product' },
              { id: 'source-products.category' },
              { id: 'source-products.price' },
              { id: 'source-products.cost' },
              { id: 'source-products.stock' },
              { id: 'source-products.reorderLevel' },
            ],
          },
          format: { title: { enabled: true, text: 'Product Catalogue' } },
        },
      },
      widgetLayout: {
        'text-products': { xTrack: 0, yTrack: 0, xSpan: 24, ySpan: 8 },
        'filter2-category': { xTrack: 0, yTrack: 8, xSpan: 24, ySpan: 10 },
        'kpi2-units-sold': { xTrack: 0, yTrack: 18, xSpan: 8, ySpan: 16 },
        'kpi2-avg-price': { xTrack: 8, yTrack: 18, xSpan: 8, ySpan: 16 },
        'kpi2-total-stock': { xTrack: 16, yTrack: 18, xSpan: 8, ySpan: 16 },
        'chart2-price-by-category': { xTrack: 0, yTrack: 34, xSpan: 12, ySpan: 20 },
        'chart2-stock-by-category': { xTrack: 12, yTrack: 34, xSpan: 12, ySpan: 20 },
        'chart2-cost-by-category': { xTrack: 0, yTrack: 54, xSpan: 12, ySpan: 20 },
        'chart2-units-by-category': { xTrack: 12, yTrack: 54, xSpan: 12, ySpan: 20 },
        'grid2-products': { xTrack: 0, yTrack: 74, xSpan: 24, ySpan: 24 },
      },
    },

    // ── Page 3: Logistics ─────────────────────────────────────────────────────
    {
      id: 'page-3',
      widgets: {
        'text-logistics': {
          type: 'text',
          dataMapping: {},
          format: {
            style: {
              text: 'Logistics Operations',
              textAlign: 'center',
              verticalAlign: 'center',
              typography: { fontSize: 32, fontWeight: 'bold' },
            },
          },
        },
        'kpi3-items-shipped': {
          type: 'value',
          dataMapping: { value: [{ id: 'source-shipments.itemCount', aggregation: 'sum' }] },
          format: { title: { enabled: true, text: 'Items Shipped' } },
        },
        'kpi3-ontime': {
          type: 'value',
          dataMapping: { value: [{ id: 'source-shipments.onTime', aggregation: 'avg' }] },
          format: { title: { enabled: true, text: 'On-Time Rate' } },
        },
        'chart3-by-carrier': {
          type: 'bar-chart-grouped',
          dataMapping: {
            categoryKey: [{ id: 'source-shipments.carrier' }],
            valueKey: [{ id: 'source-shipments.itemCount', aggregation: 'sum' }],
          },
          format: { title: { enabled: true, text: 'Shipments by Carrier' } },
        },
        'chart3-revenue-trend': {
          type: 'line-chart',
          dataMapping: {
            categoryKey: [{ id: 'source-orders.date' }],
            valueKey: [{ id: 'source-orders.total', aggregation: 'sum' }],
          },
          format: { title: { enabled: true, text: 'Revenue Over Time' } },
        },
        'chart3-by-status': {
          type: 'pie-chart',
          dataMapping: {
            categoryKey: [{ id: 'source-shipments.status' }],
            valueKey: [{ id: 'source-shipments.itemCount', aggregation: 'sum' }],
          },
          format: { title: { enabled: true, text: 'Shipments by Status' } },
        },
        'grid3-shipments': {
          type: 'grid',
          dataMapping: {
            cols: [
              { id: 'source-shipments.id' },
              { id: 'source-shipments.carrier' },
              { id: 'source-shipments.shipDate' },
              { id: 'source-shipments.status' },
              { id: 'source-shipments.onTime' },
              { id: 'source-shipments.itemCount' },
            ],
          },
          format: { title: { enabled: true, text: 'Shipment Log' } },
        },
      },
      widgetLayout: {
        'text-logistics': { xTrack: 0, yTrack: 0, xSpan: 24, ySpan: 8 },
        'kpi3-items-shipped': { xTrack: 0, yTrack: 8, xSpan: 12, ySpan: 16 },
        'kpi3-ontime': { xTrack: 12, yTrack: 8, xSpan: 12, ySpan: 16 },
        'chart3-by-carrier': { xTrack: 0, yTrack: 24, xSpan: 12, ySpan: 20 },
        'chart3-revenue-trend': { xTrack: 12, yTrack: 24, xSpan: 12, ySpan: 20 },
        'chart3-by-status': { xTrack: 0, yTrack: 44, xSpan: 24, ySpan: 20 },
        'grid3-shipments': { xTrack: 0, yTrack: 64, xSpan: 24, ySpan: 24 },
      },
    },

    // ── Page 4: Customers ─────────────────────────────────────────────────────
    {
      id: 'page-4',
      widgets: {
        'text-customers': {
          type: 'text',
          dataMapping: {},
          format: {
            style: {
              text: 'Customer Intelligence',
              textAlign: 'center',
              verticalAlign: 'center',
              typography: { fontSize: 32, fontWeight: 'bold' },
            },
          },
        },
        'filter4-segment': {
          type: 'list-filter',
          dataMapping: { value: [{ id: 'source-customers.segment' }] },
          format: { title: { enabled: true, text: 'Customer Segment' } },
        },
        'kpi4-ltv': {
          type: 'value',
          dataMapping: { value: [{ id: 'source-orders.total', aggregation: 'sum' }] },
          format: { title: { enabled: true, text: 'Lifetime Value' } },
        },
        'kpi4-customers': {
          type: 'value',
          dataMapping: { value: [{ id: 'source-customers.id', aggregation: 'count' }] },
          format: { title: { enabled: true, text: 'Customer Count' } },
        },
        'kpi4-avg-order': {
          type: 'value',
          dataMapping: { value: [{ id: 'source-orders.total', aggregation: 'avg' }] },
          format: { title: { enabled: true, text: 'Avg Order Value' } },
        },
        'kpi4-companies': {
          type: 'value',
          dataMapping: { value: [{ id: 'source-customers.company', aggregation: 'countd' }] },
          format: { title: { enabled: true, text: 'Unique Companies' } },
        },
        'chart4-acquisition': {
          type: 'bar-chart-grouped',
          dataMapping: {
            categoryKey: [{ id: 'source-customers.since' }],
            valueKey: [{ id: 'source-customers.id', aggregation: 'count' }],
          },
          format: { title: { enabled: true, text: 'Customer Acquisition Over Time' } },
        },
        'chart4-by-segment': {
          type: 'pie-chart',
          dataMapping: {
            categoryKey: [{ id: 'source-customers.segment' }],
            valueKey: [{ id: 'source-orders.total', aggregation: 'sum' }],
          },
          format: { title: { enabled: true, text: 'Revenue by Segment' } },
        },
        'chart4-top-customers': {
          type: 'bar-chart-grouped',
          dataMapping: {
            categoryKey: [{ id: 'source-customers.company' }],
            valueKey: [{ id: 'source-orders.total', aggregation: 'sum' }],
          },
          format: { title: { enabled: true, text: 'Top Customers by Revenue' } },
        },
        'chart4-revenue-trend': {
          type: 'line-chart',
          dataMapping: {
            categoryKey: [{ id: 'source-orders.date' }],
            valueKey: [{ id: 'source-orders.total', aggregation: 'sum' }],
          },
          format: { title: { enabled: true, text: 'Revenue Trend' } },
        },
        'grid4-customers': {
          type: 'grid',
          dataMapping: {
            cols: [
              { id: 'source-customers.id' },
              { id: 'source-customers.company' },
              { id: 'source-customers.country' },
              { id: 'source-customers.segment' },
              { id: 'source-customers.since' },
            ],
          },
          format: { title: { enabled: true, text: 'Customer Directory' } },
        },
      },
      widgetLayout: {
        'text-customers': { xTrack: 0, yTrack: 0, xSpan: 24, ySpan: 8 },
        'filter4-segment': { xTrack: 0, yTrack: 8, xSpan: 24, ySpan: 10 },
        'kpi4-ltv': { xTrack: 0, yTrack: 18, xSpan: 6, ySpan: 16 },
        'kpi4-customers': { xTrack: 6, yTrack: 18, xSpan: 6, ySpan: 16 },
        'kpi4-avg-order': { xTrack: 12, yTrack: 18, xSpan: 6, ySpan: 16 },
        'kpi4-companies': { xTrack: 18, yTrack: 18, xSpan: 6, ySpan: 16 },
        'chart4-acquisition': { xTrack: 0, yTrack: 34, xSpan: 12, ySpan: 20 },
        'chart4-by-segment': { xTrack: 12, yTrack: 34, xSpan: 12, ySpan: 20 },
        'chart4-top-customers': { xTrack: 0, yTrack: 54, xSpan: 12, ySpan: 20 },
        'chart4-revenue-trend': { xTrack: 12, yTrack: 54, xSpan: 12, ySpan: 20 },
        'grid4-customers': { xTrack: 0, yTrack: 74, xSpan: 24, ySpan: 24 },
      },
    },
  ],
};
