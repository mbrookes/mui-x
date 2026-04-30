import type { StudioState, RelativeDateValue } from '@mui/x-studio';
import {
  BUSINESS_METRICS_SOURCE_ID,
  businessMetricsSource,
  CUSTOMERS_SOURCE_ID,
  customersSource,
  ORDERS_SOURCE_ID,
  ordersSource,
  ORDER_ITEMS_SOURCE_ID,
  orderItemsSource,
  PRODUCTS_SOURCE_ID,
  productsSource,
  SHIPMENT_ITEMS_SOURCE_ID,
  shipmentItemsSource,
  SHIPMENTS_SOURCE_ID,
  shipmentsSource,
} from '../salesData';

export const INITIAL_STATE: Partial<StudioState> = {
  dashboard: {
    id: 'dashboard-sales',
    title: 'Sales Dashboard',
    activePageId: 'page-1',
  },
  pages: {
    'page-1': {
      id: 'page-1',
      title: 'Overview',
      widgetRows: [
        ['widget-kpi-revenue', 'widget-kpi-orders', 'widget-kpi-customers', 'widget-kpi-ontime'],
        ['widget-chart-revenue-by-category'],
        ['widget-chart-category', 'widget-chart-country'],
        ['widget-orders-grid'],
      ],
    },
    'page-2': {
      id: 'page-2',
      title: 'Products & Logistics',
      widgetRows: [
        [
          'widget-kpi2-margin',
          'widget-kpi2-units-sold',
          'widget-kpi2-avg-discount',
          'widget-kpi2-items-shipped',
        ],
        ['widget-chart2-shipments-trend', 'widget-chart2-orders-by-country'],
        ['widget-chart2-price-vs-margin', 'widget-chart2-stock-by-category'],
        ['widget-grid2-products'],
      ],
    },
  },
  dataSources: {
    [PRODUCTS_SOURCE_ID]: productsSource,
    [CUSTOMERS_SOURCE_ID]: customersSource,
    [ORDERS_SOURCE_ID]: ordersSource,
    [ORDER_ITEMS_SOURCE_ID]: orderItemsSource,
    [SHIPMENTS_SOURCE_ID]: shipmentsSource,
    [SHIPMENT_ITEMS_SOURCE_ID]: shipmentItemsSource,
    [BUSINESS_METRICS_SOURCE_ID]: businessMetricsSource,
  },
  relationships: [
    {
      id: 'rel-orders-customers',
      sourceId: ORDERS_SOURCE_ID,
      sourceField: 'customerId',
      targetId: CUSTOMERS_SOURCE_ID,
      targetField: 'id',
      type: 'many-to-one',
    },
    {
      id: 'rel-orderitems-orders',
      sourceId: ORDER_ITEMS_SOURCE_ID,
      sourceField: 'orderId',
      targetId: ORDERS_SOURCE_ID,
      targetField: 'id',
      type: 'many-to-one',
    },
    {
      id: 'rel-shipments-orders',
      sourceId: SHIPMENTS_SOURCE_ID,
      sourceField: 'orderId',
      targetId: ORDERS_SOURCE_ID,
      targetField: 'id',
      type: 'many-to-one',
    },
    {
      id: 'rel-shipmentitems-shipments',
      sourceId: SHIPMENT_ITEMS_SOURCE_ID,
      sourceField: 'shipmentId',
      targetId: SHIPMENTS_SOURCE_ID,
      targetField: 'id',
      type: 'many-to-one',
    },
    {
      id: 'rel-shipmentitems-orderitems',
      sourceId: SHIPMENT_ITEMS_SOURCE_ID,
      sourceField: 'orderItemId',
      targetId: ORDER_ITEMS_SOURCE_ID,
      targetField: 'id',
      type: 'many-to-one',
    },
  ],
  widgets: {
    'widget-kpi-revenue': {
      id: 'widget-kpi-revenue',
      kind: 'kpi',
      title: 'Total Revenue',
      sourceId: ORDER_ITEMS_SOURCE_ID,
      config: {
        kpiValueField: 'total',
        kpiAggregation: 'sum',
        kpiSparkline: true,
        kpiSparklineField: 'date',
        kpiSparklineSourceId: ORDERS_SOURCE_ID,
        kpiSparklineCumulative: true,
      },
    },
    'widget-kpi-orders': {
      id: 'widget-kpi-orders',
      kind: 'kpi',
      title: 'Total Orders',
      sourceId: ORDERS_SOURCE_ID,
      config: {
        kpiValueField: 'status',
        kpiAggregation: 'count',
        kpiSparkline: true,
        kpiSparklineField: 'date',
      },
    },
    'widget-kpi-customers': {
      id: 'widget-kpi-customers',
      kind: 'kpi',
      title: 'Active Customers',
      sourceId: CUSTOMERS_SOURCE_ID,
      config: {
        kpiValueField: 'company',
        kpiAggregation: 'count',
      },
    },
    'widget-kpi-ontime': {
      id: 'widget-kpi-ontime',
      kind: 'kpi',
      title: 'On-Time Shipments',
      sourceId: SHIPMENTS_SOURCE_ID,
      config: {
        kpiValueField: 'onTime',
        kpiAggregation: 'avg',
      },
    },
    'widget-chart-revenue-by-category': {
      id: 'widget-chart-revenue-by-category',
      kind: 'chart',
      title: 'Monthly Revenue by Category',
      sourceId: ORDER_ITEMS_SOURCE_ID,
      config: {
        chartType: 'bar-stacked',
        xField: 'date',
        xGroupBy: 'month',
        yField: 'total',
        seriesField: 'category',
      },
    },
    'widget-chart-category': {
      id: 'widget-chart-category',
      kind: 'chart',
      title: 'Revenue by Category',
      sourceId: ORDER_ITEMS_SOURCE_ID,
      config: { chartType: 'bar', xField: 'category', yField: 'total' },
    },
    'widget-chart-country': {
      id: 'widget-chart-country',
      kind: 'chart',
      title: 'Revenue by Country',
      sourceId: ORDERS_SOURCE_ID,
      config: { chartType: 'pie', xField: 'country', yField: 'total' },
    },
    'widget-orders-grid': {
      id: 'widget-orders-grid',
      kind: 'grid',
      title: 'Recent Orders',
      sourceId: ORDERS_SOURCE_ID,
      config: { columns: ['id', 'date', 'customerId', 'status'] },
    },

    // ── Page 2: Products & Logistics ────────────────────────────────────────

    'widget-kpi2-margin': {
      id: 'widget-kpi2-margin',
      kind: 'kpi',
      title: 'Avg Unit Margin',
      titleMode: 'manual',
      sourceId: PRODUCTS_SOURCE_ID,
      config: {
        kpiValueField: 'expr-product-margin',
        kpiAggregation: 'avg',
        kpiCompact: false,
      },
    },
    'widget-kpi2-units-sold': {
      id: 'widget-kpi2-units-sold',
      kind: 'kpi',
      title: 'Units Sold',
      titleMode: 'manual',
      sourceId: ORDER_ITEMS_SOURCE_ID,
      config: {
        kpiValueField: 'quantity',
        kpiAggregation: 'sum',
        kpiCompact: true,
        kpiSparkline: true,
        kpiSparklineField: 'date',
        kpiSparklineSourceId: ORDERS_SOURCE_ID,
        kpiSparklinePlotType: 'bar',
        kpiSparklineGranularity: 'month',
      },
    },
    'widget-kpi2-avg-discount': {
      id: 'widget-kpi2-avg-discount',
      kind: 'kpi',
      title: 'Avg Discount',
      titleMode: 'manual',
      sourceId: ORDER_ITEMS_SOURCE_ID,
      config: {
        kpiValueField: 'discount',
        kpiAggregation: 'avg',
      },
    },
    'widget-kpi2-items-shipped': {
      id: 'widget-kpi2-items-shipped',
      kind: 'kpi',
      title: 'Items Shipped',
      titleMode: 'manual',
      sourceId: SHIPMENTS_SOURCE_ID,
      config: {
        kpiValueField: 'itemCount',
        kpiAggregation: 'sum',
        kpiCompact: true,
        kpiSparkline: true,
        kpiSparklineField: 'shipDate',
        kpiSparklinePlotType: 'bar',
        kpiSparklineGranularity: 'month',
      },
    },

    'widget-chart2-shipments-trend': {
      id: 'widget-chart2-shipments-trend',
      kind: 'chart',
      title: 'Shipments by Carrier',
      titleMode: 'manual',
      sourceId: SHIPMENTS_SOURCE_ID,
      config: {
        chartType: 'line',
        xField: 'shipDate',
        xGroupBy: 'month',
        yField: 'itemCount',
        seriesField: 'carrier',
      },
    },
    'widget-chart2-orders-by-country': {
      id: 'widget-chart2-orders-by-country',
      kind: 'chart',
      title: 'Revenue by Country Over Time',
      titleMode: 'manual',
      sourceId: ORDERS_SOURCE_ID,
      config: {
        chartType: 'bar-stacked',
        xField: 'date',
        xGroupBy: 'quarter',
        yField: 'total',
        seriesField: 'country',
      },
    },

    'widget-chart2-price-vs-margin': {
      id: 'widget-chart2-price-vs-margin',
      kind: 'chart',
      title: 'Price vs. Unit Margin',
      titleMode: 'manual',
      sourceId: PRODUCTS_SOURCE_ID,
      config: {
        chartType: 'scatter',
        xField: 'price',
        yField: 'expr-product-margin',
      },
    },
    'widget-chart2-stock-by-category': {
      id: 'widget-chart2-stock-by-category',
      kind: 'chart',
      title: 'Stock by Category',
      titleMode: 'manual',
      sourceId: PRODUCTS_SOURCE_ID,
      config: {
        chartType: 'bar',
        xField: 'product',
        yField: 'stock',
      },
    },

    'widget-grid2-products': {
      id: 'widget-grid2-products',
      kind: 'grid',
      title: 'Product Catalogue',
      titleMode: 'manual',
      sourceId: PRODUCTS_SOURCE_ID,
      config: {
        columns: ['product', 'category', 'price', 'cost', 'expr-product-margin', 'expr-product-margin-pct', 'stock', 'reorderLevel'],
        crossFilterField: 'category',
      },
    },
  },
  "filters": [
    {
      "id": "filter-widget-kpi-customers-recent",
      "field": "date",
      "operator": "greater_than",
      "value": {
        "relative": true,
        "amount": 6,
        "unit": "month",
        "direction": "past"
      } satisfies RelativeDateValue,
      "scope": "widget",
      "widgetId": "widget-kpi-customers",
      "fieldType": "date",
      "filterSourceId": "source-orders"
    }
  ],
  expressionFields: [
    {
      id: 'expr-product-margin',
      label: 'Unit Margin',
      description: 'Selling price minus cost per unit',
      sourceId: PRODUCTS_SOURCE_ID,
      isMeasure: false,
      type: 'number',
      format: 'currency',
      expression: {
        operator: 'subtract',
        inputs: [{ id: 'price' }, { id: 'cost' }],
      },
    },
    {
      id: 'expr-product-margin-pct',
      label: 'Margin %',
      description: 'Gross margin as a percentage of selling price',
      sourceId: PRODUCTS_SOURCE_ID,
      isMeasure: false,
      type: 'number',
      format: 'percent',
      expression: {
        operator: 'divide',
        inputs: [
          {
            operator: 'subtract',
            inputs: [{ id: 'price' }, { id: 'cost' }],
          },
          { id: 'price' },
        ],
      },
    },
  ],
  shell: {
    // TODO: make these optional
    openDrawers: { data: false, compose: true, filters: true },
    selectedWidgetId: null,
    selectedFieldId: null,
    selectedSourceId: null,
  },
};
