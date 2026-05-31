// @ts-nocheck
import { mainDemoState } from './vendor/mainDemoState';

export const MAIN_DEMO_PAGES = [
  { id: 'executive', label: 'Executive Overview' },
  { id: 'sales-margin', label: 'Sales & Margin Performance' },
  { id: 'fulfilment', label: 'Fulfilment & Delivery Health' },
  { id: 'returns', label: 'Returns & Quality Signals' },
] as const;

const ORDER_ITEMS_ORDER_DATETIME_FIELD = 'oi-orders-order-datetime';
const ORDER_ITEMS_CUSTOMER_REGION_FIELD = 'oi-customers-region';
const ORDER_ITEMS_CUSTOMER_NAME_FIELD = 'oi-customers-customer-name';
const ORDER_ITEMS_PRODUCT_SUBCATEGORY_FIELD = 'oi-products-subcategory';
const ORDER_ITEMS_PRODUCT_BRAND_FIELD = 'oi-products-brand';
const ORDER_ITEMS_PRODUCT_NAME_FIELD = 'oi-products-product-name';
const SHIPMENTS_CUSTOMER_REGION_FIELD = 'sh-customers-region';

const PAGE_WIDGET_SOURCE = {
  executive: 'orderItems',
  'sales-margin': 'orderItems',
  fulfilment: 'shipments',
  returns: 'orderItems',
} as const;

function titleFromWidget(widget) {
  return widget.format?.title?.text ?? widget.format?.caption?.text ?? widget.id;
}

function mapAggregation(aggregation) {
  if (!aggregation) {
    return undefined;
  }
  return aggregation === 'countd' ? 'count_distinct' : aggregation;
}

function toWidgetRows(page) {
  const rows = new Map();
  for (const [widgetId, layout] of Object.entries(page.widgetLayout)) {
    const row = rows.get(layout.yTrack) ?? [];
    row.push({ widgetId, xTrack: layout.xTrack, xSpan: layout.xSpan });
    rows.set(layout.yTrack, row);
  }

  const widgetRows = [];
  const widgetColSpans = {};

  for (const yTrack of [...rows.keys()].sort((a, b) => a - b)) {
    const row = rows.get(yTrack).sort((a, b) => a.xTrack - b.xTrack);
    widgetRows.push(row.map((item) => item.widgetId));
    for (const item of row) {
      if (item.xSpan !== 24) {
        widgetColSpans[item.widgetId] = item.xSpan;
      }
    }
  }

  return {
    widgetRows,
    widgetColSpans: Object.keys(widgetColSpans).length > 0 ? widgetColSpans : undefined,
  };
}

function mapFieldId(fieldId, sourceId) {
  if (!fieldId || sourceId === undefined) {
    return fieldId;
  }

  if (sourceId === 'orderItems') {
    switch (fieldId) {
      case 'orders.order_datetime':
      case 'orders.order_month':
      case 'orders.order_year':
        return ORDER_ITEMS_ORDER_DATETIME_FIELD;
      case 'customers.region':
        return ORDER_ITEMS_CUSTOMER_REGION_FIELD;
      case 'customers.customer_name':
        return ORDER_ITEMS_CUSTOMER_NAME_FIELD;
      case 'products.subcategory':
        return ORDER_ITEMS_PRODUCT_SUBCATEGORY_FIELD;
      case 'products.brand':
        return ORDER_ITEMS_PRODUCT_BRAND_FIELD;
      case 'products.product_name':
        return ORDER_ITEMS_PRODUCT_NAME_FIELD;
      case 'orders.order_id':
        return 'order_id';
      case 'order_items.quantity':
        return 'quantity';
      case 'order_items.discount_pct':
        return 'discount_pct';
      case 'order_items.return_reason':
        return 'return_reason';
      case 'order_items.returned':
        return 'returned';
      case 'order_items.order_item_id':
        return 'order_item_id';
      default:
        return fieldId;
    }
  }

  if (sourceId === 'shipments') {
    switch (fieldId) {
      case 'customers.region':
        return SHIPMENTS_CUSTOMER_REGION_FIELD;
      case 'shipments.carrier':
        return 'carrier';
      case 'shipments.delayed':
        return 'delayed';
      case 'shipments.shipment_id':
        return 'shipment_id';
      default:
        return fieldId;
    }
  }

  return fieldId;
}

function mapChartCategory(fieldId, sourceId) {
  if (fieldId === 'orders.order_month') {
    return { fieldId: mapFieldId(fieldId, sourceId), xGroupBy: 'month' };
  }
  if (fieldId === 'orders.order_year') {
    return { fieldId: mapFieldId(fieldId, sourceId), xGroupBy: 'year' };
  }
  return { fieldId: mapFieldId(fieldId, sourceId) };
}

function mapGridColumn(column, sourceId, sourceIds) {
  const mapped = {};
  const aggregationFn = mapAggregation(column.aggregation);

  if (column.id.includes('.')) {
    const [sourceAlias, fieldId] = column.id.split('.');
    mapped.fieldId = fieldId;
    mapped.sourceId = sourceIds[sourceAlias];
  } else {
    mapped.fieldId = mapFieldId(column.id, sourceId);
  }

  if (aggregationFn) {
    mapped.aggregationFn = aggregationFn;
  }

  if (mapped.sourceId === sourceIds[sourceId]) {
    delete mapped.sourceId;
  }

  return mapped;
}

function convertWidget(widgetId, widget, pageId, sourceIds) {
  const widgetSourceKey = PAGE_WIDGET_SOURCE[pageId];
  const widgetSourceId = widgetSourceKey ? sourceIds[widgetSourceKey] : undefined;

  if (widget.type === 'text') {
    return {
      id: widgetId,
      kind: 'text',
      title: widget.format?.style?.text ?? '',
      titleMode: 'manual',
      config: {
        textTitleAlign: widget.format?.style?.textAlign ?? 'left',
        textTitleFontSize: widget.format?.style?.typography?.fontSize,
        textTitleColor: widget.format?.style?.typography?.color,
      },
    };
  }

  if (widget.type === 'value') {
    const valueField = widget.dataMapping?.value?.[0];
    return {
      id: widgetId,
      kind: 'kpi',
      title: titleFromWidget(widget),
      titleMode: 'manual',
      sourceId: widgetSourceId,
      config: {
        kpiValueField: mapFieldId(valueField?.id, widgetSourceKey),
        kpiAggregation: mapAggregation(valueField?.aggregation) ?? 'sum',
      },
    };
  }

  if (widget.type === 'button-filter') {
    const valueField = widget.dataMapping?.value?.[0];
    return {
      id: widgetId,
      kind: 'filter',
      title: titleFromWidget(widget),
      titleMode: 'manual',
      sourceId: widgetSourceId,
      config: {
        filterWidgetType: 'multi-select',
        filterWidgetField: mapFieldId(valueField?.id, widgetSourceKey),
      },
    };
  }

  if (widget.type === 'grid') {
    const summaryFields = {};
    for (const column of widget.dataMapping?.cols ?? []) {
      const aggregationFn = mapAggregation(column.aggregation);
      if (aggregationFn) {
        summaryFields[mapFieldId(column.id, widgetSourceKey)] = aggregationFn;
      }
    }

    return {
      id: widgetId,
      kind: 'grid',
      title: titleFromWidget(widget),
      titleMode: 'manual',
      sourceId: widgetSourceId,
      config: {
        columns: (widget.dataMapping?.cols ?? []).map((column) =>
          mapGridColumn(column, widgetSourceKey, sourceIds),
        ),
        gridSortField: mapFieldId(widget.sort?.[0]?.field?.id, widgetSourceKey),
        gridSortDirection: widget.sort?.[0]?.direction ?? 'asc',
        gridSummaryFields: Object.keys(summaryFields).length > 0 ? summaryFields : undefined,
      },
    };
  }

  const categoryField = widget.dataMapping?.categoryKey?.[0]?.id;
  const valueFields = widget.dataMapping?.valueKey ?? [];
  const sizeField = widget.dataMapping?.sizeKey?.[0]?.id;
  const groupByField = widget.dataMapping?.groupByKey?.[0]?.id;
  const seriesField = widget.dataMapping?.seriesKey?.[0]?.id;
  const chartCategory = categoryField
    ? mapChartCategory(categoryField, widgetSourceKey)
    : undefined;
  const config = {
    chartType: 'bar',
    xField: chartCategory?.fieldId,
    xGroupBy: chartCategory?.xGroupBy,
    yAggregation: mapAggregation(valueFields[0]?.aggregation) ?? 'sum',
  };

  if (valueFields.length > 1) {
    config.ySeries = valueFields.map((field) => ({
      fieldId: mapFieldId(field.id, widgetSourceKey),
    }));
  } else if (valueFields[0]) {
    config.yField = mapFieldId(valueFields[0].id, widgetSourceKey);
  }

  if (seriesField) {
    config.seriesField = mapFieldId(seriesField, widgetSourceKey);
  }

  if (widget.type === 'bubble-chart' && groupByField) {
    config.scatterColorField = mapFieldId(groupByField, widgetSourceKey);
  }

  if (widget.type === 'bubble-chart' && sizeField) {
    config.scatterSizeField = mapFieldId(sizeField, widgetSourceKey);
    config.scatterMinRadius = 4;
    config.scatterMaxRadius = 28;
  }

  const chartTypeMap = {
    'line-chart': 'line',
    'bar-chart-stacked': 'bar-stacked',
    'bar-chart-grouped': 'bar',
    'area-chart': 'area',
    'bubble-chart': 'scatter',
    'pie-chart': 'pie',
    'donut-chart': 'donut',
    'column-chart-grouped': 'bar',
  };

  config.chartType = chartTypeMap[widget.type] ?? 'bar';

  return {
    id: widgetId,
    kind: 'chart',
    title: titleFromWidget(widget),
    titleMode: 'manual',
    sourceId: widgetSourceId,
    config,
  };
}

function createRelationships(sourceIds) {
  return [
    {
      id: 'os-rel-orders-customers',
      sourceId: sourceIds.orders,
      sourceField: 'customer_id',
      targetId: sourceIds.customers,
      targetField: 'customer_id',
      type: 'many-to-one',
    },
    {
      id: 'os-rel-orders-stores',
      sourceId: sourceIds.orders,
      sourceField: 'store_id',
      targetId: sourceIds.stores,
      targetField: 'store_id',
      type: 'many-to-one',
    },
    {
      id: 'os-rel-orderitems-orders',
      sourceId: sourceIds.orderItems,
      sourceField: 'order_id',
      targetId: sourceIds.orders,
      targetField: 'order_id',
      type: 'many-to-one',
    },
    {
      id: 'os-rel-orderitems-products',
      sourceId: sourceIds.orderItems,
      sourceField: 'product_id',
      targetId: sourceIds.products,
      targetField: 'product_id',
      type: 'many-to-one',
    },
    {
      id: 'os-rel-shipments-orders',
      sourceId: sourceIds.shipments,
      sourceField: 'order_id',
      targetId: sourceIds.orders,
      targetField: 'order_id',
      type: 'many-to-one',
    },
  ];
}

function createExpressionFields(sourceIds) {
  return [
    {
      id: ORDER_ITEMS_ORDER_DATETIME_FIELD,
      label: 'Order Date',
      sourceId: sourceIds.orderItems,
      isMeasure: false,
      type: 'date',
      expression: { joinSourceId: sourceIds.orders, fieldId: 'order_datetime' },
    },
    {
      id: ORDER_ITEMS_CUSTOMER_REGION_FIELD,
      label: 'Customer Region',
      sourceId: sourceIds.orderItems,
      isMeasure: false,
      type: 'string',
      expression: { joinSourceId: sourceIds.customers, fieldId: 'region' },
    },
    {
      id: ORDER_ITEMS_CUSTOMER_NAME_FIELD,
      label: 'Customer Name',
      sourceId: sourceIds.orderItems,
      isMeasure: false,
      type: 'string',
      expression: { joinSourceId: sourceIds.customers, fieldId: 'customer_name' },
    },
    {
      id: ORDER_ITEMS_PRODUCT_SUBCATEGORY_FIELD,
      label: 'Product Subcategory',
      sourceId: sourceIds.orderItems,
      isMeasure: false,
      type: 'string',
      expression: { joinSourceId: sourceIds.products, fieldId: 'subcategory' },
    },
    {
      id: ORDER_ITEMS_PRODUCT_BRAND_FIELD,
      label: 'Product Brand',
      sourceId: sourceIds.orderItems,
      isMeasure: false,
      type: 'string',
      expression: { joinSourceId: sourceIds.products, fieldId: 'brand' },
    },
    {
      id: ORDER_ITEMS_PRODUCT_NAME_FIELD,
      label: 'Product Name',
      sourceId: sourceIds.orderItems,
      isMeasure: false,
      type: 'string',
      expression: { joinSourceId: sourceIds.products, fieldId: 'product_name' },
    },
    {
      id: SHIPMENTS_CUSTOMER_REGION_FIELD,
      label: 'Customer Region',
      sourceId: sourceIds.shipments,
      isMeasure: false,
      type: 'string',
      expression: { joinSourceId: sourceIds.customers, fieldId: 'region' },
    },
    {
      id: 'line_net',
      label: 'Line Net',
      sourceId: sourceIds.orderItems,
      isMeasure: false,
      type: 'number',
      format: 'currency',
      expression: {
        operator: 'subtract',
        inputs: [
          { operator: 'multiply', inputs: [{ id: 'quantity' }, { id: 'unit_price' }] },
          {
            operator: 'multiply',
            inputs: [
              { operator: 'multiply', inputs: [{ id: 'quantity' }, { id: 'unit_price' }] },
              { id: 'discount_pct' },
            ],
          },
        ],
      },
    },
    {
      id: 'net_sales',
      label: 'Net Sales',
      sourceId: sourceIds.orderItems,
      isMeasure: true,
      type: 'number',
      format: 'currency',
      expression: { id: 'line_net', aggregation: 'sum' },
    },
    {
      id: 'line_cogs',
      label: 'Line COGS',
      sourceId: sourceIds.orderItems,
      isMeasure: false,
      type: 'number',
      format: 'currency',
      expression: {
        operator: 'multiply',
        inputs: [{ id: 'quantity' }, { joinSourceId: sourceIds.products, fieldId: 'unit_cost' }],
      },
    },
    {
      id: 'line_margin',
      label: 'Line Margin',
      sourceId: sourceIds.orderItems,
      isMeasure: false,
      type: 'number',
      format: 'currency',
      expression: { operator: 'subtract', inputs: [{ id: 'line_net' }, { id: 'line_cogs' }] },
    },
    {
      id: 'gross_margin',
      label: 'Gross Margin',
      sourceId: sourceIds.orderItems,
      isMeasure: true,
      type: 'number',
      format: 'currency',
      expression: { id: 'line_margin', aggregation: 'sum' },
    },
    {
      id: 'gross_margin_pct',
      label: 'Gross Margin %',
      sourceId: sourceIds.orderItems,
      isMeasure: true,
      type: 'number',
      format: 'percent',
      expression: {
        operator: 'divide',
        inputs: [
          {
            operator: 'subtract',
            inputs: [
              { id: 'line_net', aggregation: 'sum' },
              { id: 'line_cogs', aggregation: 'sum' },
            ],
          },
          { id: 'line_net', aggregation: 'sum' },
        ],
      },
    },
    {
      id: 'gross_margin_percentage',
      label: 'Gross Margin %',
      sourceId: sourceIds.orderItems,
      isMeasure: true,
      type: 'number',
      format: 'percent',
      expression: { id: 'gross_margin_pct' },
    },
    {
      id: 'order_count',
      label: 'Order Count',
      sourceId: sourceIds.orderItems,
      isMeasure: true,
      type: 'number',
      format: 'integer',
      expression: { id: 'order_id', aggregation: 'count_distinct' },
    },
    {
      id: 'average_order_value',
      label: 'Average Order Value',
      sourceId: sourceIds.orderItems,
      isMeasure: true,
      type: 'number',
      format: 'currency',
      expression: { operator: 'divide', inputs: [{ id: 'net_sales' }, { id: 'order_count' }] },
    },
    {
      id: 'return_flag',
      label: 'Return Flag',
      sourceId: sourceIds.orderItems,
      isMeasure: false,
      type: 'boolean',
      expression: { operator: 'isTrue', inputs: [{ id: 'returned' }] },
    },
    {
      id: 'returned_line_flag',
      label: 'Returned Line Flag',
      sourceId: sourceIds.orderItems,
      isMeasure: false,
      type: 'number',
      format: 'integer',
      expression: {
        operator: 'if',
        inputs: [{ id: 'return_flag' }, { type: 'number', value: 1 }, { type: 'number', value: 0 }],
      },
    },
    {
      id: 'returned_lines',
      label: 'Returned Lines',
      sourceId: sourceIds.orderItems,
      isMeasure: true,
      type: 'number',
      format: 'integer',
      expression: { id: 'returned_line_flag', aggregation: 'sum' },
    },
    {
      id: 'return_rate',
      label: 'Return Rate',
      sourceId: sourceIds.orderItems,
      isMeasure: true,
      type: 'number',
      format: 'percent',
      expression: {
        operator: 'divide',
        inputs: [{ id: 'returned_lines' }, { id: 'order_item_id', aggregation: 'count' }],
      },
    },
    {
      id: 'returned_line_net',
      label: 'Returned Line Net',
      sourceId: sourceIds.orderItems,
      isMeasure: false,
      type: 'number',
      format: 'currency',
      expression: {
        operator: 'if',
        inputs: [{ id: 'return_flag' }, { id: 'line_net' }, { type: 'number', value: 0 }],
      },
    },
    {
      id: 'return_value',
      label: 'Return Value',
      sourceId: sourceIds.orderItems,
      isMeasure: true,
      type: 'number',
      format: 'currency',
      expression: { id: 'returned_line_net', aggregation: 'sum' },
    },
    {
      id: 'returned_line_margin',
      label: 'Returned Line Margin',
      sourceId: sourceIds.orderItems,
      isMeasure: false,
      type: 'number',
      format: 'currency',
      expression: {
        operator: 'if',
        inputs: [{ id: 'return_flag' }, { id: 'line_margin' }, { type: 'number', value: 0 }],
      },
    },
    {
      id: 'return_margin_impact',
      label: 'Return Margin Impact',
      sourceId: sourceIds.orderItems,
      isMeasure: true,
      type: 'number',
      format: 'currency',
      expression: {
        operator: 'subtract',
        inputs: [
          { type: 'number', value: 0 },
          { id: 'returned_line_margin', aggregation: 'sum' },
        ],
      },
    },
    {
      id: 'returned_line_cogs',
      label: 'Returned Line COGS',
      sourceId: sourceIds.orderItems,
      isMeasure: false,
      type: 'number',
      format: 'currency',
      expression: {
        operator: 'if',
        inputs: [{ id: 'return_flag' }, { id: 'line_cogs' }, { type: 'number', value: 0 }],
      },
    },
    {
      id: 'return_refunds',
      label: 'Refunds',
      sourceId: sourceIds.orderItems,
      isMeasure: false,
      type: 'number',
      format: 'currency',
      expression: {
        operator: 'multiply',
        inputs: [{ id: 'returned_line_net' }, { type: 'number', value: 0.45 }],
      },
    },
    {
      id: 'return_shipping',
      label: 'Shipping',
      sourceId: sourceIds.orderItems,
      isMeasure: false,
      type: 'number',
      format: 'currency',
      expression: {
        operator: 'multiply',
        inputs: [{ id: 'returned_line_margin' }, { type: 'number', value: 0.65 }],
      },
    },
    {
      id: 'return_write_offs',
      label: 'Write-offs',
      sourceId: sourceIds.orderItems,
      isMeasure: false,
      type: 'number',
      format: 'currency',
      expression: {
        operator: 'multiply',
        inputs: [{ id: 'returned_line_cogs' }, { type: 'number', value: 0.35 }],
      },
    },
    {
      id: 'is_shipped',
      label: 'Is Shipped',
      sourceId: sourceIds.shipments,
      isMeasure: false,
      type: 'boolean',
      expression: { operator: 'isNotNull', inputs: [{ id: 'ship_datetime' }] },
    },
    {
      id: 'shipped_order_id',
      label: 'Shipped Order ID',
      sourceId: sourceIds.shipments,
      isMeasure: false,
      type: 'string',
      expression: {
        operator: 'if',
        inputs: [{ id: 'is_shipped' }, { id: 'order_id' }, { type: 'string', value: null }],
      },
    },
    {
      id: 'shipped_orders',
      label: 'Shipped Orders',
      sourceId: sourceIds.shipments,
      isMeasure: true,
      type: 'number',
      format: 'integer',
      expression: { id: 'shipped_order_id', aggregation: 'count_distinct' },
    },
    {
      id: 'is_delivered',
      label: 'Is Delivered',
      sourceId: sourceIds.shipments,
      isMeasure: false,
      type: 'boolean',
      expression: { operator: 'isNotNull', inputs: [{ id: 'delivery_datetime' }] },
    },
    {
      id: 'delivered_order_id',
      label: 'Delivered Order ID',
      sourceId: sourceIds.shipments,
      isMeasure: false,
      type: 'string',
      expression: {
        operator: 'if',
        inputs: [{ id: 'is_delivered' }, { id: 'order_id' }, { type: 'string', value: null }],
      },
    },
    {
      id: 'delivered_orders',
      label: 'Delivered Orders',
      sourceId: sourceIds.shipments,
      isMeasure: true,
      type: 'number',
      format: 'integer',
      expression: { id: 'delivered_order_id', aggregation: 'count_distinct' },
    },
    {
      id: 'delivered_shipments',
      label: 'Delivered Shipments',
      sourceId: sourceIds.shipments,
      isMeasure: false,
      type: 'number',
      format: 'integer',
      expression: {
        operator: 'if',
        inputs: [
          { id: 'is_delivered' },
          { type: 'number', value: 1 },
          { type: 'number', value: 0 },
        ],
      },
    },
    {
      id: 'is_delayed',
      label: 'Is Delayed',
      sourceId: sourceIds.shipments,
      isMeasure: false,
      type: 'boolean',
      expression: {
        operator: 'if',
        inputs: [
          { id: 'is_delivered' },
          { operator: 'equals', inputs: [{ id: 'delayed' }, { type: 'boolean', value: true }] },
          { type: 'boolean', value: false },
        ],
      },
    },
    {
      id: 'delayed_shipments',
      label: 'Delayed Shipments',
      sourceId: sourceIds.shipments,
      isMeasure: false,
      type: 'number',
      format: 'integer',
      expression: {
        operator: 'if',
        inputs: [{ id: 'is_delayed' }, { type: 'number', value: 1 }, { type: 'number', value: 0 }],
      },
    },
    {
      id: 'is_on_time',
      label: 'Is On Time',
      sourceId: sourceIds.shipments,
      isMeasure: false,
      type: 'boolean',
      expression: {
        operator: 'if',
        inputs: [
          { id: 'is_delivered' },
          { operator: 'equals', inputs: [{ id: 'delayed' }, { type: 'boolean', value: false }] },
          { type: 'boolean', value: false },
        ],
      },
    },
    {
      id: 'on_time_order_id',
      label: 'On-time Order ID',
      sourceId: sourceIds.shipments,
      isMeasure: false,
      type: 'string',
      expression: {
        operator: 'if',
        inputs: [{ id: 'is_on_time' }, { id: 'order_id' }, { type: 'string', value: null }],
      },
    },
    {
      id: 'on_time_deliveries',
      label: 'On-time Deliveries',
      sourceId: sourceIds.shipments,
      isMeasure: true,
      type: 'number',
      format: 'integer',
      expression: { id: 'on_time_order_id', aggregation: 'count_distinct' },
    },
    {
      id: 'on_time_rate',
      label: 'On-time Rate',
      sourceId: sourceIds.shipments,
      isMeasure: true,
      type: 'number',
      format: 'percent',
      expression: {
        operator: 'divide',
        inputs: [{ id: 'on_time_deliveries' }, { id: 'delivered_orders' }],
      },
    },
    {
      id: 'ship_to_delivery_days',
      label: 'Ship to Delivery Days',
      sourceId: sourceIds.shipments,
      isMeasure: false,
      type: 'number',
      expression: {
        operator: 'datediff',
        inputs: [
          { type: 'string', value: 'day' },
          { id: 'ship_datetime' },
          { id: 'delivery_datetime' },
        ],
      },
    },
    {
      id: 'avg_ship_to_delivery_days',
      label: 'Avg Ship to Delivery Days',
      sourceId: sourceIds.shipments,
      isMeasure: true,
      type: 'number',
      expression: { id: 'ship_to_delivery_days', aggregation: 'avg' },
    },
    {
      id: 'delay_rate',
      label: 'Delay Rate',
      sourceId: sourceIds.shipments,
      isMeasure: true,
      type: 'number',
      format: 'percent',
      expression: {
        operator: 'divide',
        inputs: [
          { id: 'delayed_shipments', aggregation: 'sum' },
          { id: 'delivered_shipments', aggregation: 'sum' },
        ],
      },
    },
  ];
}

function createFilters(sourceIds) {
  return MAIN_DEMO_PAGES.map((page) => ({
    id: `os-date-${page.id}`,
    scope: 'page',
    pageId: page.id,
    filterSourceId: sourceIds.orders,
    field: 'order_datetime',
    fieldType: 'date',
    operator: 'greater_than_or_equal',
    value: '2024-12-01',
  })).concat({
    id: 'os-return-reasons-returned',
    scope: 'widget',
    widgetId: 'return-reasons',
    filterSourceId: sourceIds.orderItems,
    field: 'returned',
    fieldType: 'boolean',
    operator: 'equals',
    value: true,
  });
}

export function createXStudioOfficeSuppliesState(sourceIds) {
  const pages = mainDemoState.pages.filter((page) =>
    MAIN_DEMO_PAGES.some((item) => item.id === page.id),
  );
  const pageMap = {};
  const widgets = {};

  for (const page of pages) {
    const layout = toWidgetRows(page);
    pageMap[page.id] = {
      id: page.id,
      title: MAIN_DEMO_PAGES.find((item) => item.id === page.id)?.label ?? page.id,
      widgetRows: layout.widgetRows,
      ...(layout.widgetColSpans ? { widgetColSpans: layout.widgetColSpans } : {}),
    };

    for (const [widgetId, widget] of Object.entries(page.widgets)) {
      widgets[widgetId] = convertWidget(widgetId, widget, page.id, sourceIds);
    }
  }

  const activePageId = MAIN_DEMO_PAGES.some((page) => page.id === mainDemoState.selectedPageId)
    ? mainDemoState.selectedPageId
    : MAIN_DEMO_PAGES[0].id;

  return {
    dashboard: {
      id: 'dashboard-os',
      title: 'Office Supplies Dashboard',
      activePageId,
    },
    pages: pageMap,
    relationships: createRelationships(sourceIds),
    widgets,
    expressionFields: createExpressionFields(sourceIds),
    filters: createFilters(sourceIds),
  };
}
