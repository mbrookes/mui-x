import {
  OS_PRODUCTS_SOURCE_ID,
  OS_CUSTOMERS_SOURCE_ID,
  OS_ORDERS_SOURCE_ID,
  OS_ORDER_ITEMS_SOURCE_ID,
  OS_SHIPMENTS_SOURCE_ID,
} from '../officeSuppliesData';

export const OS_PAGES = [
  { id: 'os-page-1', label: 'Executive Overview' },
  { id: 'os-page-2', label: 'Sales & Margin' },
  { id: 'os-page-3', label: 'Fulfilment & Delivery' },
  { id: 'os-page-4', label: 'Returns & Quality' },
] as const;

export const AG_OS_DASHBOARD_STATE = {
  selectedPageId: 'os-page-1',
  pages: [
    {
      id: 'os-page-1',
      widgets: {
        'os-text-hero': {
          type: 'text',
          dataMapping: {},
          format: {
            style: {
              text: 'Office Supplies Dashboard',
              textAlign: 'center',
              verticalAlign: 'center',
              typography: { fontSize: 32, fontWeight: 'bold' },
            },
          },
        },
        'os-kpi-revenue': {
          type: 'value',
          dataMapping: { value: [{ id: 'expr-os-line-net', aggregation: 'sum' }] },
          format: { title: { enabled: true, text: 'Total Revenue' } },
        },
        'os-kpi-orders': {
          type: 'value',
          dataMapping: { value: [{ id: 'expr-os-order-count', aggregation: 'sum' }] },
          format: { title: { enabled: true, text: 'Total Orders' } },
        },
        'os-kpi-customers': {
          type: 'value',
          dataMapping: {
            value: [{ id: `${OS_CUSTOMERS_SOURCE_ID}.customer_id`, aggregation: 'count' }],
          },
          format: { title: { enabled: true, text: 'Customers' } },
        },
        'os-kpi-gm-pct': {
          type: 'value',
          dataMapping: { value: [{ id: 'expr-os-gm-pct', aggregation: 'sum' }] },
          format: { title: { enabled: true, text: 'Gross Margin %' } },
        },
        'os-chart-revenue-trend': {
          type: 'line-chart',
          dataMapping: {
            categoryKey: [{ id: `${OS_ORDERS_SOURCE_ID}.order_datetime` }],
            valueKey: [{ id: 'expr-os-line-net', aggregation: 'sum' }],
          },
          format: { title: { enabled: true, text: 'Monthly Revenue' } },
        },
        'os-chart-revenue-by-category': {
          type: 'bar-chart-stacked',
          dataMapping: {
            categoryKey: [{ id: `${OS_ORDERS_SOURCE_ID}.order_datetime` }],
            valueKey: [{ id: 'expr-os-line-net', aggregation: 'sum' }],
            seriesKey: [{ id: `${OS_PRODUCTS_SOURCE_ID}.category` }],
          },
          format: { title: { enabled: true, text: 'Revenue by Category' } },
        },
        'os-chart-revenue-by-region': {
          type: 'pie-chart',
          dataMapping: {
            categoryKey: [{ id: `${OS_CUSTOMERS_SOURCE_ID}.region` }],
            valueKey: [{ id: 'expr-os-line-net', aggregation: 'sum' }],
          },
          format: { title: { enabled: true, text: 'Revenue by Region' } },
        },
        'os-grid-orders': {
          type: 'grid',
          dataMapping: {
            cols: [
              { id: `${OS_ORDERS_SOURCE_ID}.order_id` },
              { id: `${OS_ORDERS_SOURCE_ID}.order_datetime` },
              { id: `${OS_ORDERS_SOURCE_ID}.customer_id` },
              { id: `${OS_ORDERS_SOURCE_ID}.status` },
              { id: `${OS_ORDERS_SOURCE_ID}.channel` },
            ],
          },
          format: { title: { enabled: true, text: 'Orders' } },
        },
      },
      widgetLayout: {
        'os-text-hero': { xTrack: 0, yTrack: 0, xSpan: 24, ySpan: 3 },
        'os-kpi-revenue': { xTrack: 0, yTrack: 3, xSpan: 6, ySpan: 4 },
        'os-kpi-orders': { xTrack: 6, yTrack: 3, xSpan: 6, ySpan: 4 },
        'os-kpi-customers': { xTrack: 12, yTrack: 3, xSpan: 6, ySpan: 4 },
        'os-kpi-gm-pct': { xTrack: 18, yTrack: 3, xSpan: 6, ySpan: 4 },
        'os-chart-revenue-trend': { xTrack: 0, yTrack: 7, xSpan: 24, ySpan: 8 },
        'os-chart-revenue-by-category': { xTrack: 0, yTrack: 15, xSpan: 12, ySpan: 8 },
        'os-chart-revenue-by-region': { xTrack: 12, yTrack: 15, xSpan: 12, ySpan: 8 },
        'os-grid-orders': { xTrack: 0, yTrack: 23, xSpan: 24, ySpan: 8 },
      },
    },
    {
      id: 'os-page-2',
      widgets: {
        'os-text-sales': {
          type: 'text',
          dataMapping: {},
          format: {
            style: {
              text: 'Sales & Margin Analysis',
              textAlign: 'center',
              verticalAlign: 'center',
              typography: { fontSize: 32, fontWeight: 'bold' },
            },
          },
        },
        'os-filter-category': {
          type: 'list-filter',
          dataMapping: { value: [{ id: `${OS_PRODUCTS_SOURCE_ID}.category` }] },
          format: { title: { enabled: true, text: 'Category' } },
        },
        'os-chart-revenue-by-brand': {
          type: 'bar-chart-grouped',
          dataMapping: {
            categoryKey: [{ id: `${OS_PRODUCTS_SOURCE_ID}.brand` }],
            valueKey: [{ id: 'expr-os-line-net', aggregation: 'sum' }],
          },
          format: { title: { enabled: true, text: 'Top Brands by Revenue' } },
        },
        'os-chart-gm-by-subcategory': {
          type: 'bar-chart-grouped',
          dataMapping: {
            categoryKey: [{ id: `${OS_PRODUCTS_SOURCE_ID}.subcategory` }],
            valueKey: [{ id: 'expr-os-gm-pct', aggregation: 'sum' }],
          },
          format: { title: { enabled: true, text: 'Margin % by Subcategory' } },
        },
        'os-chart-qty-vs-discount': {
          type: 'scatter-chart',
          dataMapping: {
            categoryKey: [{ id: `${OS_ORDER_ITEMS_SOURCE_ID}.discount_pct` }],
            valueKey: [{ id: `${OS_ORDER_ITEMS_SOURCE_ID}.quantity` }],
            seriesKey: [{ id: `${OS_PRODUCTS_SOURCE_ID}.brand` }],
          },
          format: { title: { enabled: true, text: 'Qty vs Discount by Brand' } },
        },
        'os-grid-items': {
          type: 'grid',
          dataMapping: {
            cols: [
              { id: `${OS_ORDER_ITEMS_SOURCE_ID}.order_item_id` },
              { id: `${OS_ORDER_ITEMS_SOURCE_ID}.product_id` },
              { id: `${OS_ORDER_ITEMS_SOURCE_ID}.quantity` },
              { id: `${OS_ORDER_ITEMS_SOURCE_ID}.unit_price` },
              { id: `${OS_ORDER_ITEMS_SOURCE_ID}.discount_pct` },
              { id: 'expr-os-line-net' },
              { id: 'expr-os-line-margin' },
            ],
          },
          format: { title: { enabled: true, text: 'Order Items' } },
        },
      },
      widgetLayout: {
        'os-text-sales': { xTrack: 0, yTrack: 0, xSpan: 24, ySpan: 3 },
        'os-filter-category': { xTrack: 0, yTrack: 3, xSpan: 24, ySpan: 4 },
        'os-chart-revenue-by-brand': { xTrack: 0, yTrack: 7, xSpan: 12, ySpan: 8 },
        'os-chart-gm-by-subcategory': { xTrack: 12, yTrack: 7, xSpan: 12, ySpan: 8 },
        'os-chart-qty-vs-discount': { xTrack: 0, yTrack: 15, xSpan: 24, ySpan: 8 },
        'os-grid-items': { xTrack: 0, yTrack: 23, xSpan: 24, ySpan: 8 },
      },
    },
    {
      id: 'os-page-3',
      widgets: {
        'os-text-fulfilment': {
          type: 'text',
          dataMapping: {},
          format: {
            style: {
              text: 'Fulfilment & Delivery',
              textAlign: 'center',
              verticalAlign: 'center',
              typography: { fontSize: 32, fontWeight: 'bold' },
            },
          },
        },
        'os-kpi-shipments': {
          type: 'value',
          dataMapping: {
            value: [{ id: `${OS_SHIPMENTS_SOURCE_ID}.shipment_id`, aggregation: 'count' }],
          },
          format: { title: { enabled: true, text: 'Shipments' } },
        },
        'os-kpi-ontime': {
          type: 'value',
          dataMapping: { value: [{ id: 'expr-os-ontime-rate', aggregation: 'sum' }] },
          format: { title: { enabled: true, text: 'On-Time Rate' } },
        },
        'os-kpi-avg-transit': {
          type: 'value',
          dataMapping: { value: [{ id: 'expr-os-transit-days', aggregation: 'avg' }] },
          format: { title: { enabled: true, text: 'Avg Transit Days' } },
        },
        'os-chart-carrier-split': {
          type: 'pie-chart',
          dataMapping: {
            categoryKey: [{ id: `${OS_SHIPMENTS_SOURCE_ID}.carrier` }],
            valueKey: [{ id: `${OS_SHIPMENTS_SOURCE_ID}.shipment_id`, aggregation: 'count' }],
          },
          format: { title: { enabled: true, text: 'Shipments by Carrier' } },
        },
        'os-chart-ontime-by-carrier': {
          type: 'bar-chart-grouped',
          dataMapping: {
            categoryKey: [{ id: `${OS_SHIPMENTS_SOURCE_ID}.carrier` }],
            valueKey: [{ id: 'expr-os-ontime-rate', aggregation: 'sum' }],
          },
          format: { title: { enabled: true, text: 'On-Time Rate by Carrier' } },
        },
        'os-grid-shipments': {
          type: 'grid',
          dataMapping: {
            cols: [
              { id: `${OS_SHIPMENTS_SOURCE_ID}.shipment_id` },
              { id: `${OS_SHIPMENTS_SOURCE_ID}.order_id` },
              { id: `${OS_SHIPMENTS_SOURCE_ID}.carrier` },
              { id: `${OS_SHIPMENTS_SOURCE_ID}.ship_datetime` },
              { id: `${OS_SHIPMENTS_SOURCE_ID}.delivery_datetime` },
              { id: `${OS_SHIPMENTS_SOURCE_ID}.delayed` },
              { id: 'expr-os-transit-days' },
            ],
          },
          format: { title: { enabled: true, text: 'Shipments' } },
        },
      },
      widgetLayout: {
        'os-text-fulfilment': { xTrack: 0, yTrack: 0, xSpan: 24, ySpan: 3 },
        'os-kpi-shipments': { xTrack: 0, yTrack: 3, xSpan: 8, ySpan: 4 },
        'os-kpi-ontime': { xTrack: 8, yTrack: 3, xSpan: 8, ySpan: 4 },
        'os-kpi-avg-transit': { xTrack: 16, yTrack: 3, xSpan: 8, ySpan: 4 },
        'os-chart-carrier-split': { xTrack: 0, yTrack: 7, xSpan: 12, ySpan: 8 },
        'os-chart-ontime-by-carrier': { xTrack: 12, yTrack: 7, xSpan: 12, ySpan: 8 },
        'os-grid-shipments': { xTrack: 0, yTrack: 15, xSpan: 24, ySpan: 8 },
      },
    },
    {
      id: 'os-page-4',
      widgets: {
        'os-text-returns': {
          type: 'text',
          dataMapping: {},
          format: {
            style: {
              text: 'Returns & Quality',
              textAlign: 'center',
              verticalAlign: 'center',
              typography: { fontSize: 32, fontWeight: 'bold' },
            },
          },
        },
        'os-kpi-return-rate': {
          type: 'value',
          dataMapping: { value: [{ id: 'expr-os-return-rate', aggregation: 'sum' }] },
          format: { title: { enabled: true, text: 'Return Rate' } },
        },
        'os-kpi-returned-items': {
          type: 'value',
          dataMapping: {
            value: [{ id: `${OS_ORDER_ITEMS_SOURCE_ID}.returned`, aggregation: 'count' }],
          },
          format: { title: { enabled: true, text: 'Returned Items' } },
        },
        'os-kpi-return-reasons': {
          type: 'value',
          dataMapping: {
            value: [{ id: `${OS_ORDER_ITEMS_SOURCE_ID}.return_reason`, aggregation: 'count' }],
          },
          format: { title: { enabled: true, text: 'Return Reasons' } },
        },
        'os-chart-returns-by-category': {
          type: 'bar-chart-grouped',
          dataMapping: {
            categoryKey: [{ id: `${OS_PRODUCTS_SOURCE_ID}.category` }],
            valueKey: [{ id: 'expr-os-return-rate', aggregation: 'sum' }],
          },
          format: { title: { enabled: true, text: 'Return Rate by Category' } },
        },
        'os-chart-return-reasons': {
          type: 'donut-chart',
          dataMapping: {
            categoryKey: [{ id: `${OS_ORDER_ITEMS_SOURCE_ID}.return_reason` }],
            valueKey: [{ id: `${OS_ORDER_ITEMS_SOURCE_ID}.order_item_id`, aggregation: 'count' }],
          },
          format: { title: { enabled: true, text: 'Return Reasons' } },
        },
        'os-grid-returns': {
          type: 'grid',
          dataMapping: {
            cols: [
              { id: `${OS_ORDER_ITEMS_SOURCE_ID}.order_item_id` },
              { id: `${OS_ORDER_ITEMS_SOURCE_ID}.product_id` },
              { id: `${OS_ORDER_ITEMS_SOURCE_ID}.return_reason` },
              { id: `${OS_ORDER_ITEMS_SOURCE_ID}.unit_price` },
              { id: `${OS_ORDER_ITEMS_SOURCE_ID}.discount_pct` },
            ],
          },
          format: { title: { enabled: true, text: 'Returned Items' } },
        },
      },
      widgetLayout: {
        'os-text-returns': { xTrack: 0, yTrack: 0, xSpan: 24, ySpan: 3 },
        'os-kpi-return-rate': { xTrack: 0, yTrack: 3, xSpan: 8, ySpan: 4 },
        'os-kpi-returned-items': { xTrack: 8, yTrack: 3, xSpan: 8, ySpan: 4 },
        'os-kpi-return-reasons': { xTrack: 16, yTrack: 3, xSpan: 8, ySpan: 4 },
        'os-chart-returns-by-category': { xTrack: 0, yTrack: 7, xSpan: 12, ySpan: 8 },
        'os-chart-return-reasons': { xTrack: 12, yTrack: 7, xSpan: 12, ySpan: 8 },
        'os-grid-returns': { xTrack: 0, yTrack: 15, xSpan: 24, ySpan: 8 },
      },
    },
  ],
};
