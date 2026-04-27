import type { StudioDataSource } from '@mui/x-studio';

export const BUSINESS_METRICS_SOURCE_ID = 'source-business-metrics';

export const businessMetricsSource: StudioDataSource = {
  id: BUSINESS_METRICS_SOURCE_ID,
  label: 'Business Metrics',
  fields: [
    { id: 'id', label: 'Metric ID', type: 'string', hidden: true },
    { id: 'category', label: 'Category', type: 'string' },
    { id: 'name', label: 'Metric', type: 'string' },
    { id: 'value', label: 'Value', type: 'number' },
    { id: 'unit', label: 'Unit', type: 'string' },
    { id: 'description', label: 'Description', type: 'string' },
  ],
  rows: [
    // Shipping
    {
      id: 'BM-001',
      category: 'Shipping',
      name: 'On-Time Window',
      value: 7,
      unit: 'days',
      description: 'Maximum days from ship date to delivery to be considered on time',
    },
    {
      id: 'BM-002',
      category: 'Shipping',
      name: 'On-Time Delivery Target',
      value: 95,
      unit: '%',
      description: 'Target percentage of shipments delivered within the on-time window',
    },
    {
      id: 'BM-003',
      category: 'Shipping',
      name: 'Order-to-Ship Target',
      value: 2,
      unit: 'days',
      description: 'Target number of business days from order placement to shipment dispatch',
    },
    {
      id: 'BM-004',
      category: 'Shipping',
      name: 'Split Shipment Rate Max',
      value: 5,
      unit: '%',
      description: 'Maximum acceptable rate of orders requiring split shipments',
    },
    {
      id: 'BM-005',
      category: 'Shipping',
      name: 'Return Rate Max',
      value: 3,
      unit: '%',
      description: 'Maximum acceptable shipment return / rejection rate',
    },
    // Revenue
    {
      id: 'BM-006',
      category: 'Revenue',
      name: 'Monthly Revenue Target',
      value: 150000,
      unit: 'USD',
      description: 'Monthly gross revenue target across all markets',
    },
    {
      id: 'BM-007',
      category: 'Revenue',
      name: 'Average Order Value Target',
      value: 8000,
      unit: 'USD',
      description: 'Target average order value',
    },
    {
      id: 'BM-008',
      category: 'Revenue',
      name: 'Gross Margin Target',
      value: 40,
      unit: '%',
      description: 'Target gross margin across all product lines',
    },
    {
      id: 'BM-009',
      category: 'Revenue',
      name: 'Annual Growth Target',
      value: 15,
      unit: '%',
      description: 'Year-over-year revenue growth target',
    },
    // Customer
    {
      id: 'BM-010',
      category: 'Customer',
      name: 'CSAT Target',
      value: 4.5,
      unit: '/5',
      description: 'Target average customer satisfaction score',
    },
    {
      id: 'BM-011',
      category: 'Customer',
      name: 'Repeat Order Rate Target',
      value: 60,
      unit: '%',
      description: 'Target percentage of customers placing more than one order per year',
    },
    {
      id: 'BM-012',
      category: 'Customer',
      name: 'Orders per Active Customer Target',
      value: 3,
      unit: 'orders/year',
      description: 'Target average number of orders per active customer annually',
    },
    // Inventory
    {
      id: 'BM-013',
      category: 'Inventory',
      name: 'Minimum Stock Level',
      value: 20,
      unit: 'units',
      description: 'Units on hand below which a reorder is triggered',
    },
    {
      id: 'BM-014',
      category: 'Inventory',
      name: 'Supplier Lead Time',
      value: 14,
      unit: 'days',
      description: 'Average supplier lead time used for reorder planning',
    },
    {
      id: 'BM-015',
      category: 'Inventory',
      name: 'Stock Cover Target',
      value: 30,
      unit: 'days',
      description: 'Target number of days of stock cover to maintain at all times',
    },
  ],
};

export const businessMetricsBindings = businessMetricsSource.fields.map((f) => ({
  field: f.id,
  label: f.label,
}));
