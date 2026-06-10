const e = {
    id: 'executive',
    widgets: {
      'page-title-executive': {
        type: 'text',
        format: { style: { text: 'Executive Overview', typography: { fontWeight: 'normal' } } },
      },
      'kpi-net-sales': {
        type: 'value',
        dataMapping: { value: [{ id: 'net_sales' }] },
        format: {
          caption: {
            enabled: !0,
            text: 'Net Sales',
            typography: {
              fontFamily: '"Source Sans 3", sans-serif',
              fontSize: 20,
              fontWeight: 'normal',
              fontStyle: 'normal',
            },
          },
          value: { typography: { fontWeight: 'normal' } },
        },
      },
      'kpi-order-count': {
        type: 'value',
        dataMapping: { value: [{ id: 'order_count' }] },
        format: {
          caption: {
            enabled: !0,
            text: 'Order Count',
            typography: {
              fontFamily: '"Source Sans 3", sans-serif',
              fontSize: 20,
              fontWeight: 'normal',
              fontStyle: 'normal',
            },
          },
          value: { typography: { fontWeight: 'normal' } },
        },
      },
      'kpi-aov': {
        type: 'value',
        dataMapping: { value: [{ id: 'average_order_value' }] },
        format: {
          caption: {
            enabled: !0,
            text: 'AOV',
            typography: {
              fontFamily: '"Source Sans 3", sans-serif',
              fontSize: 20,
              fontWeight: 'normal',
              fontStyle: 'normal',
            },
          },
          value: { typography: { fontWeight: 'normal' } },
        },
      },
      'kpi-gm-percent': {
        type: 'value',
        dataMapping: { value: [{ id: 'gross_margin_percentage' }] },
        format: {
          caption: {
            enabled: !0,
            text: 'Gross Margin %',
            typography: {
              fontFamily: '"Source Sans 3", sans-serif',
              fontSize: 20,
              fontWeight: 'normal',
              fontStyle: 'normal',
            },
          },
          value: { typography: { fontWeight: 'normal' } },
        },
      },
      'kpi-on-time-rate': {
        type: 'value',
        dataMapping: { value: [{ id: 'on_time_rate' }] },
        format: {
          caption: {
            enabled: !0,
            text: 'On-time Rate',
            typography: {
              fontFamily: '"Source Sans 3", sans-serif',
              fontSize: 20,
              fontWeight: 'normal',
              fontStyle: 'normal',
            },
          },
          value: { typography: { fontWeight: 'normal' } },
        },
      },
      'kpi-return-rate': {
        type: 'value',
        dataMapping: { value: [{ id: 'return_rate' }] },
        format: {
          caption: {
            enabled: !0,
            text: 'Return Rate',
            typography: {
              fontFamily: '"Source Sans 3", sans-serif',
              fontSize: 20,
              fontWeight: 'normal',
              fontStyle: 'normal',
            },
          },
          value: { typography: { fontWeight: 'normal' } },
        },
      },
      'net-sales-by-month': {
        type: 'line-chart',
        dataMapping: {
          categoryKey: [{ id: 'orders.order_month' }],
          valueKey: [{ id: 'line_net', aggregation: 'sum' }],
        },
        format: { title: { enabled: !0, text: 'Net Sales by Month' } },
        sort: [{ field: { id: 'orders.order_month' }, direction: 'asc' }],
      },
      'net-sales-by-region': {
        type: 'bar-chart-stacked',
        dataMapping: {
          categoryKey: [{ id: 'customers.region' }],
          valueKey: [
            { id: 'line_cogs', aggregation: 'sum' },
            { id: 'line_margin', aggregation: 'sum' },
          ],
          tooltipKey: [{ id: 'line_net', aggregation: 'sum' }],
        },
        sort: [{ field: { id: 'line_cogs', aggregation: 'sum' }, direction: 'desc' }],
        format: {
          title: { enabled: !0, text: 'Net Sales by Region' },
          style: { theme: { common: { legend: { enabled: !0, position: 'right' } } } },
        },
      },
      'net-sales-by-subcategory': {
        type: 'bar-chart-stacked',
        dataMapping: {
          categoryKey: [{ id: 'products.subcategory' }],
          valueKey: [
            { id: 'line_cogs', aggregation: 'sum' },
            { id: 'line_margin', aggregation: 'sum' },
          ],
          tooltipKey: [{ id: 'line_net', aggregation: 'sum' }],
        },
        sort: [{ field: { id: 'line_cogs', aggregation: 'sum' }, direction: 'desc' }],
        format: {
          title: { enabled: !0, text: 'Net Sales by Subcategory' },
          style: { theme: { common: { legend: { enabled: !0, position: 'right' } } } },
        },
      },
      'top-customers': {
        type: 'grid',
        dataMapping: {
          cols: [
            { id: 'customers.customer_name' },
            { id: 'orders.order_id' },
            { id: 'line_net', aggregation: 'sum' },
            { id: 'average_order_value' },
            { id: 'gross_margin_percentage' },
          ],
        },
        sort: [{ field: { id: 'line_net', aggregation: 'sum' }, direction: 'desc' }],
        format: { title: { enabled: !0, text: 'Top Customers' } },
      },
    },
    widgetLayout: {
      'page-title-executive': { xTrack: 0, yTrack: 0, xSpan: 24, ySpan: 4 },
      'kpi-net-sales': { xTrack: 0, yTrack: 4, xSpan: 8, ySpan: 6 },
      'kpi-order-count': { xTrack: 8, yTrack: 4, xSpan: 8, ySpan: 6 },
      'kpi-aov': { xTrack: 16, yTrack: 4, xSpan: 8, ySpan: 6 },
      'kpi-gm-percent': { xTrack: 0, yTrack: 10, xSpan: 8, ySpan: 6 },
      'kpi-on-time-rate': { xTrack: 8, yTrack: 10, xSpan: 8, ySpan: 6 },
      'kpi-return-rate': { xTrack: 16, yTrack: 10, xSpan: 8, ySpan: 6 },
      'net-sales-by-month': { xTrack: 0, yTrack: 16, xSpan: 24, ySpan: 16 },
      'net-sales-by-region': { xTrack: 0, yTrack: 32, xSpan: 12, ySpan: 16 },
      'net-sales-by-subcategory': { xTrack: 12, yTrack: 32, xSpan: 12, ySpan: 16 },
      'top-customers': { xTrack: 0, yTrack: 48, xSpan: 24, ySpan: 16 },
    },
    filter: {
      page: [
        {
          field: { id: 'orders.order_datetime' },
          view: { expanded: !1 },
          model: { operator: 'after', value: '2024-12-01' },
        },
      ],
    },
  },
  t = {
    id: 'sales-margin',
    widgets: {
      'page-title-sales-margin': {
        type: 'text',
        format: {
          style: { text: 'Sales & Margin Performance', typography: { fontWeight: 'normal' } },
        },
      },
      'sales-and-margin-over-time': {
        type: 'area-chart',
        dataMapping: {
          categoryKey: [{ id: 'orders.order_month' }],
          valueKey: [{ id: 'line_net', aggregation: 'sum' }],
          tooltipKey: [{ id: 'gross_margin_pct' }],
        },
        format: { title: { enabled: !0, text: 'Net Sales and Gross Margin % by Month' } },
        sort: [{ field: { id: 'orders.order_month' }, direction: 'asc' }],
      },
      'sales-by-brand-within-subcategory': {
        type: 'bar-chart-stacked',
        dataMapping: {
          categoryKey: [{ id: 'products.subcategory' }],
          valueKey: [{ id: 'line_net', aggregation: 'sum' }],
          tooltipKey: [{ id: 'line_margin', aggregation: 'sum' }],
        },
        sort: [{ field: { id: 'line_net', aggregation: 'sum' }, direction: 'desc' }],
        format: { title: { enabled: !0, text: 'Net Sales by Brand within Subcategory' } },
      },
      'qty-vs-discount': {
        type: 'bubble-chart',
        dataMapping: {
          groupByKey: [{ id: 'products.brand' }],
          categoryKey: [{ id: 'order_items.quantity', aggregation: 'avg' }],
          valueKey: [{ id: 'order_items.discount_pct', aggregation: 'avg' }],
          sizeKey: [{ id: 'line_net', aggregation: 'sum' }],
          tooltipKey: [{ id: 'line_net', aggregation: 'sum' }],
        },
        format: { title: { enabled: !0, text: 'Quantity vs Discount (size by Net Sales)' } },
      },
      'top-products': {
        type: 'grid',
        dataMapping: {
          cols: [
            { id: 'products.product_name' },
            { id: 'line_net', aggregation: 'sum' },
            { id: 'order_items.quantity', aggregation: 'sum' },
            { id: 'gross_margin_percentage' },
            { id: 'return_rate' },
          ],
        },
        sort: [{ field: { id: 'line_net', aggregation: 'sum' }, direction: 'desc' }],
        format: { title: { enabled: !0, text: 'Top Products' } },
      },
      'region-filter': {
        type: 'button-filter',
        dataMapping: { value: [{ id: 'customers.region' }] },
      },
    },
    widgetLayout: {
      'page-title-sales-margin': { xTrack: 0, yTrack: 0, xSpan: 24, ySpan: 4 },
      'region-filter': { xTrack: 0, yTrack: 4, xSpan: 24, ySpan: 7 },
      'sales-and-margin-over-time': { xTrack: 0, yTrack: 11, xSpan: 24, ySpan: 16 },
      'sales-by-brand-within-subcategory': { xTrack: 0, yTrack: 27, xSpan: 12, ySpan: 18 },
      'qty-vs-discount': { xTrack: 12, yTrack: 27, xSpan: 12, ySpan: 18 },
      'top-products': { xTrack: 0, yTrack: 45, xSpan: 24, ySpan: 19 },
    },
    filter: {
      page: [
        {
          field: { id: 'orders.order_datetime' },
          view: { expanded: !1 },
          model: { operator: 'after', value: '2024-12-01' },
        },
      ],
    },
  },
  a = {
    id: 'fulfilment',
    widgets: {
      'page-title-fulfilment': {
        type: 'text',
        format: {
          style: { text: 'Fulfilment & Delivery Health', typography: { fontWeight: 'normal' } },
        },
      },
      'kpi-orders-shipped': {
        type: 'value',
        dataMapping: { value: [{ id: 'shipped_orders' }] },
        format: {
          caption: {
            enabled: !0,
            text: 'Orders Shipped',
            typography: {
              fontFamily: '"Source Sans 3", sans-serif',
              fontSize: 20,
              fontWeight: 'normal',
              fontStyle: 'normal',
            },
          },
          value: { typography: { fontWeight: 'normal' } },
        },
      },
      'kpi-orders-delivered': {
        type: 'value',
        dataMapping: { value: [{ id: 'delivered_orders' }] },
        format: {
          caption: {
            enabled: !0,
            text: 'Orders Delivered',
            typography: {
              fontFamily: '"Source Sans 3", sans-serif',
              fontSize: 20,
              fontWeight: 'normal',
              fontStyle: 'normal',
            },
          },
          value: { typography: { fontWeight: 'normal' } },
        },
      },
      'kpi-on-time-rate': {
        type: 'value',
        dataMapping: { value: [{ id: 'on_time_rate' }] },
        format: {
          caption: {
            enabled: !0,
            text: 'On-time Rate',
            typography: {
              fontFamily: '"Source Sans 3", sans-serif',
              fontSize: 20,
              fontWeight: 'normal',
              fontStyle: 'normal',
            },
          },
          value: { typography: { fontWeight: 'normal' } },
        },
      },
      'kpi-avg-transit-days': {
        type: 'value',
        dataMapping: { value: [{ id: 'avg_ship_to_delivery_days' }] },
        format: {
          caption: {
            enabled: !0,
            text: 'Avg Ship to Delivery Days',
            typography: {
              fontFamily: '"Source Sans 3", sans-serif',
              fontSize: 20,
              fontWeight: 'normal',
              fontStyle: 'normal',
            },
          },
          value: { typography: { fontWeight: 'normal' } },
        },
      },
      'delivery-status-by-month': {
        type: 'pie-chart',
        dataMapping: {
          categoryKey: [{ id: 'shipments.delayed' }],
          valueKey: [{ id: 'shipments.shipment_id', aggregation: 'count' }],
          tooltipKey: [],
        },
        format: {
          title: { enabled: !0, text: 'Delay Breakdown' },
          style: {
            theme: {
              common: { legend: { enabled: !0, position: 'right' } },
              pie: { series: { sectorLabel: { enabled: !0 } } },
            },
          },
        },
      },
      'delay-rate-by-carrier': {
        type: 'bar-chart-grouped',
        dataMapping: {
          categoryKey: [{ id: 'shipments.carrier' }],
          valueKey: [{ id: 'delay_rate' }],
        },
        sort: [{ field: { id: 'delay_rate' }, direction: 'desc' }],
        format: { title: { enabled: !0, text: 'Delay Rate by Carrier' } },
      },
      'avg-transit-by-region': {
        type: 'bar-chart-grouped',
        dataMapping: {
          categoryKey: [{ id: 'customers.region' }],
          valueKey: [{ id: 'avg_ship_to_delivery_days' }],
        },
        sort: [{ field: { id: 'avg_ship_to_delivery_days' }, direction: 'desc' }],
        format: { title: { enabled: !0, text: 'Avg Ship to Delivery Days by Region' } },
      },
      'avg-transit-by-carrier': {
        type: 'bar-chart-grouped',
        dataMapping: {
          categoryKey: [{ id: 'shipments.carrier' }],
          valueKey: [{ id: 'avg_ship_to_delivery_days' }],
        },
        sort: [{ field: { id: 'avg_ship_to_delivery_days' }, direction: 'desc' }],
        format: { title: { enabled: !0, text: 'Avg Ship to Delivery Days by Carrier' } },
      },
      'worst-lanes': {
        type: 'grid',
        dataMapping: {
          cols: [
            { id: 'customers.region' },
            { id: 'shipments.carrier' },
            { id: 'shipments.shipment_id', aggregation: 'count' },
            { id: 'on_time_rate' },
            { id: 'avg_ship_to_delivery_days' },
          ],
        },
        sort: [{ field: { id: 'on_time_rate' }, direction: 'asc' }],
        format: { title: { enabled: !0, text: 'Worst Lanes' } },
      },
    },
    widgetLayout: {
      'page-title-fulfilment': { xTrack: 0, yTrack: 0, xSpan: 24, ySpan: 4 },
      'kpi-orders-shipped': { xTrack: 0, yTrack: 4, xSpan: 6, ySpan: 6 },
      'kpi-orders-delivered': { xTrack: 6, yTrack: 4, xSpan: 6, ySpan: 6 },
      'kpi-on-time-rate': { xTrack: 12, yTrack: 4, xSpan: 6, ySpan: 6 },
      'kpi-avg-transit-days': { xTrack: 18, yTrack: 4, xSpan: 6, ySpan: 6 },
      'delivery-status-by-month': { xTrack: 0, yTrack: 10, xSpan: 12, ySpan: 16 },
      'delay-rate-by-carrier': { xTrack: 12, yTrack: 10, xSpan: 12, ySpan: 16 },
      'avg-transit-by-region': { xTrack: 0, yTrack: 26, xSpan: 12, ySpan: 16 },
      'avg-transit-by-carrier': { xTrack: 12, yTrack: 26, xSpan: 12, ySpan: 16 },
      'worst-lanes': { xTrack: 0, yTrack: 42, xSpan: 24, ySpan: 22 },
    },
    filter: {
      page: [
        {
          field: { id: 'orders.order_datetime' },
          view: { expanded: !1 },
          model: { operator: 'after', value: '2024-12-01' },
        },
      ],
    },
  },
  r = {
    id: 'returns',
    widgets: {
      'page-title-returns': {
        type: 'text',
        format: {
          style: { text: 'Returns & Quality Signals', typography: { fontWeight: 'normal' } },
        },
      },
      'kpi-return-rate': {
        type: 'value',
        dataMapping: { value: [{ id: 'return_rate' }] },
        format: {
          caption: {
            enabled: !0,
            text: 'Return Rate (Lines)',
            typography: {
              fontFamily: '"Source Sans 3", sans-serif',
              fontSize: 20,
              fontWeight: 'normal',
              fontStyle: 'normal',
            },
          },
          value: { typography: { fontWeight: 'normal' } },
        },
      },
      'kpi-return-value': {
        type: 'value',
        dataMapping: { value: [{ id: 'return_value' }] },
        format: {
          caption: {
            enabled: !0,
            text: 'Return Value',
            typography: {
              fontFamily: '"Source Sans 3", sans-serif',
              fontSize: 20,
              fontWeight: 'normal',
              fontStyle: 'normal',
            },
          },
          value: { typography: { fontWeight: 'normal' } },
        },
      },
      'kpi-return-margin-impact': {
        type: 'value',
        dataMapping: { value: [{ id: 'return_margin_impact' }] },
        format: {
          caption: {
            enabled: !0,
            text: 'Return Margin Impact',
            typography: {
              fontFamily: '"Source Sans 3", sans-serif',
              fontSize: 20,
              fontWeight: 'normal',
              fontStyle: 'normal',
            },
          },
          value: { typography: { fontWeight: 'normal' } },
        },
      },
      'cumulative-return-value-by-month': {
        type: 'column-chart-grouped',
        dataMapping: {
          categoryKey: [{ id: 'orders.order_year' }],
          valueKey: [
            { id: 'return_refunds', aggregation: 'sum' },
            { id: 'return_shipping', aggregation: 'sum' },
            { id: 'return_write_offs', aggregation: 'sum' },
          ],
        },
        format: {
          title: { enabled: !0, text: 'Return Costs by Year', typography: { color: '#538750' } },
          style: { theme: { common: { legend: { enabled: !0, position: 'right' } } } },
        },
        sort: [{ field: { id: 'orders.order_year' }, direction: 'asc' }],
      },
      'return-rate-by-subcategory': {
        type: 'bar-chart-stacked',
        dataMapping: {
          categoryKey: [{ id: 'products.subcategory' }],
          valueKey: [
            { id: 'return_refunds', aggregation: 'sum' },
            { id: 'return_shipping', aggregation: 'sum' },
            { id: 'return_write_offs', aggregation: 'sum' },
          ],
        },
        format: {
          title: { enabled: !0, text: 'Returns by Subcategory', typography: { color: '#538750' } },
        },
      },
      'return-reasons': {
        type: 'donut-chart',
        dataMapping: {
          categoryKey: [{ id: 'order_items.return_reason' }],
          valueKey: [{ id: 'order_items.order_item_id', aggregation: 'count' }],
        },
        format: {
          title: { enabled: !0, text: 'Return Reasons', typography: { color: '#538750' } },
          style: {
            theme: {
              common: { legend: { enabled: !0, position: 'right' } },
              donut: { series: { sectorLabel: { enabled: !0 } } },
            },
          },
        },
      },
      'problem-products': {
        type: 'grid',
        dataMapping: {
          cols: [
            { id: 'products.product_name' },
            { id: 'returned_lines' },
            { id: 'return_rate' },
            { id: 'line_net', aggregation: 'sum' },
            { id: 'gross_margin_percentage' },
          ],
        },
        sort: [{ field: { id: 'returned_lines' }, direction: 'desc' }],
        format: {
          title: { enabled: !0, text: 'Problem Products', typography: { color: '#538750' } },
        },
      },
    },
    widgetLayout: {
      'page-title-returns': { xTrack: 0, yTrack: 0, xSpan: 24, ySpan: 4 },
      'kpi-return-rate': { xTrack: 0, yTrack: 4, xSpan: 8, ySpan: 6 },
      'kpi-return-value': { xTrack: 8, yTrack: 4, xSpan: 8, ySpan: 6 },
      'kpi-return-margin-impact': { xTrack: 16, yTrack: 4, xSpan: 8, ySpan: 6 },
      'cumulative-return-value-by-month': { xTrack: 0, yTrack: 10, xSpan: 24, ySpan: 16 },
      'return-rate-by-subcategory': { xTrack: 0, yTrack: 26, xSpan: 12, ySpan: 16 },
      'return-reasons': { xTrack: 12, yTrack: 26, xSpan: 12, ySpan: 16 },
      'problem-products': { xTrack: 0, yTrack: 42, xSpan: 24, ySpan: 22 },
    },
    filter: {
      page: [
        {
          field: { id: 'orders.order_datetime' },
          view: { expanded: !1 },
          model: { operator: 'after', value: '2024-12-01' },
        },
      ],
      widget: {
        'return-reasons': [
          {
            field: { id: 'order_items.returned' },
            view: { expanded: !0 },
            model: { operator: 'isTrue' },
          },
        ],
        'problem-products': [],
      },
    },
  },
  n = {
    pages: [e, t, a, r, { id: 'new-page', widgets: {}, widgetLayout: {}, filter: {} }],
    selectedPageId: (typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('tab') : null) ?? 'executive',
  };
export {
  e as executivePage,
  a as fulfilmentPage,
  n as mainDemoState,
  r as returnsPage,
  t as salesPerformancePage,
};
