import type { StudioDataSource } from '@mui/x-studio';
import { loadRawOfficeSuppliesData } from '../loadRawOfficeSuppliesData.js';

export const OS_STORES_SOURCE_ID = 'os-stores';
export const OS_PRODUCTS_SOURCE_ID = 'os-products';
export const OS_CUSTOMERS_SOURCE_ID = 'os-customers';
export const OS_ORDERS_SOURCE_ID = 'os-orders';
export const OS_ORDER_ITEMS_SOURCE_ID = 'os-order-items';
export const OS_SHIPMENTS_SOURCE_ID = 'os-shipments';

export interface OfficeSuppliesData {
  storesSource: StudioDataSource;
  productsSource: StudioDataSource;
  customersSource: StudioDataSource;
  ordersSource: StudioDataSource;
  orderItemsSource: StudioDataSource;
  shipmentsSource: StudioDataSource;
}

type OfficeSuppliesField = StudioDataSource['fields'][number];

function createSource(
  id: string,
  label: string,
  fields: OfficeSuppliesField[],
  rows: Record<string, unknown>[],
): StudioDataSource {
  return { id, label, fields, rows };
}

/**
 * Convert a Unix millisecond timestamp to an ISO date string (YYYY-MM-DD).
 * Returns null for non-finite values (null-masked rows from the vendor generator).
 */
function msToIsoDate(ms: number): string | null {
  if (!Number.isFinite(ms)) {
    return null;
  }
  return new Date(ms).toISOString().slice(0, 10);
}

export async function loadOfficeSuppliesData(): Promise<OfficeSuppliesData> {
  const raw = await loadRawOfficeSuppliesData();

  return {
    storesSource: createSource(
      OS_STORES_SOURCE_ID,
      'Stores',
      [
        { id: 'store_id', label: 'Store ID', type: 'string', hidden: true },
        { id: 'store_name', label: 'Store Name', type: 'string' },
        { id: 'region', label: 'Region', type: 'string' },
        { id: 'city', label: 'City', type: 'string' },
        { id: 'opened_date', label: 'Opened Date', type: 'date' },
        { id: 'store_type', label: 'Store Type', type: 'string' },
      ],
      raw.stores.map((row) => ({
        ...row,
        opened_date: msToIsoDate(row.opened_date),
      })) as unknown as Record<string, unknown>[],
    ),
    productsSource: createSource(
      OS_PRODUCTS_SOURCE_ID,
      'Products',
      [
        { id: 'product_id', label: 'Product ID', type: 'string', hidden: true },
        { id: 'product_name', label: 'Product Name', type: 'string' },
        { id: 'category', label: 'Category', type: 'string' },
        { id: 'subcategory', label: 'Subcategory', type: 'string' },
        { id: 'brand', label: 'Brand', type: 'string' },
        { id: 'launch_date', label: 'Launch Date', type: 'date' },
        { id: 'list_price', label: 'List Price', type: 'number' },
        { id: 'unit_cost', label: 'Unit Cost', type: 'number' },
        { id: 'is_discontinued', label: 'Discontinued', type: 'boolean' },
      ],
      raw.products.map((row) => ({
        ...row,
        launch_date: msToIsoDate(row.launch_date),
      })) as unknown as Record<string, unknown>[],
    ),
    customersSource: createSource(
      OS_CUSTOMERS_SOURCE_ID,
      'Customers',
      [
        { id: 'customer_id', label: 'Customer ID', type: 'string', hidden: true },
        { id: 'customer_name', label: 'Customer Name', type: 'string' },
        { id: 'signup_date', label: 'Signup Date', type: 'date' },
        { id: 'region', label: 'Region', type: 'string' },
        { id: 'segment', label: 'Segment', type: 'string' },
        { id: 'is_active', label: 'Active', type: 'boolean' },
        { id: 'marketing_opt_in', label: 'Marketing Opt In', type: 'boolean' },
      ],
      raw.customers.map((row) => ({
        ...row,
        signup_date: msToIsoDate(row.signup_date),
      })) as unknown as Record<string, unknown>[],
    ),
    ordersSource: createSource(
      OS_ORDERS_SOURCE_ID,
      'Orders',
      [
        { id: 'order_id', label: 'Order ID', type: 'string', hidden: true },
        { id: 'customer_id', label: 'Customer ID', type: 'string', hidden: true },
        { id: 'store_id', label: 'Store ID', type: 'string', hidden: true },
        { id: 'order_datetime', label: 'Order Datetime', type: 'date' },
        { id: 'channel', label: 'Channel', type: 'string' },
        { id: 'status', label: 'Status', type: 'string' },
        { id: 'payment_method', label: 'Payment Method', type: 'string' },
        { id: 'currency', label: 'Currency', type: 'string' },
        { id: 'promo_code', label: 'Promo Code', type: 'string' },
        { id: 'order_month', label: 'Order Month', type: 'string' },
        { id: 'order_year', label: 'Order Year', type: 'string' },
      ],
      raw.orders.map((row) => ({
        ...row,
        order_datetime: msToIsoDate(row.order_datetime),
      })) as unknown as Record<string, unknown>[],
    ),
    orderItemsSource: createSource(
      OS_ORDER_ITEMS_SOURCE_ID,
      'Order Items',
      [
        { id: 'order_item_id', label: 'Order Item ID', type: 'string', hidden: true },
        { id: 'order_id', label: 'Order ID', type: 'string', hidden: true },
        { id: 'product_id', label: 'Product ID', type: 'string', hidden: true },
        { id: 'quantity', label: 'Quantity', type: 'number' },
        { id: 'unit_price', label: 'Unit Price', type: 'number' },
        { id: 'discount_pct', label: 'Discount %', type: 'number' },
        { id: 'tax_rate', label: 'Tax Rate', type: 'number' },
        { id: 'returned', label: 'Returned', type: 'boolean' },
        { id: 'return_reason', label: 'Return Reason', type: 'string' },
      ],
      raw.orderItems as unknown as Record<string, unknown>[],
    ),
    shipmentsSource: createSource(
      OS_SHIPMENTS_SOURCE_ID,
      'Shipments',
      [
        { id: 'shipment_id', label: 'Shipment ID', type: 'string', hidden: true },
        { id: 'order_id', label: 'Order ID', type: 'string', hidden: true },
        { id: 'ship_datetime', label: 'Ship Datetime', type: 'date' },
        { id: 'delivery_datetime', label: 'Delivery Datetime', type: 'date' },
        { id: 'carrier', label: 'Carrier', type: 'string' },
        { id: 'delayed', label: 'Delayed', type: 'boolean' },
      ],
      raw.shipments.map((row) => ({
        ...row,
        ship_datetime: msToIsoDate(row.ship_datetime),
        delivery_datetime:
          row.delivery_datetime != null ? msToIsoDate(row.delivery_datetime) : null,
      })) as unknown as Record<string, unknown>[],
    ),
  };
}
