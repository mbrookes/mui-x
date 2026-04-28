import type { StudioState } from '@mui/x-studio';
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
} from '../data';

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
        ['widget-chart-revenue-trend'],
        ['widget-chart-category', 'widget-chart-country'],
        ['widget-orders-grid'],
      ],
    },
    'page-2': {
      id: 'page-2',
      title: 'Details',
      widgetRows: [],
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
    'widget-chart-revenue-trend': {
      id: 'widget-chart-revenue-trend',
      kind: 'chart',
      title: 'Monthly Revenue by Category',
      sourceId: ORDER_ITEMS_SOURCE_ID,
      bindings: orderItemsBindings,
      config: {
        chartType: 'line',
        xField: 'date',
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
      },
      "scope": "widget",
      "widgetId": "widget-kpi-customers",
      "fieldType": "date",
      "filterSourceId": "source-orders"
    }
  ],
  shell: {
    // TODO: make these optional
    openDrawers: { data: false, compose: true, filters: true },
    selectedWidgetId: null,
    selectedFieldId: null,
    selectedSourceId: null,
  },
};
