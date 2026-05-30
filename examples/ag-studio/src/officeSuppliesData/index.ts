import { loadRawOfficeSuppliesData } from 'x-studio-shared';

export const OS_STORES_SOURCE_ID = 'os-stores';
export const OS_PRODUCTS_SOURCE_ID = 'os-products';
export const OS_CUSTOMERS_SOURCE_ID = 'os-customers';
export const OS_ORDERS_SOURCE_ID = 'os-orders';
export const OS_ORDER_ITEMS_SOURCE_ID = 'os-order-items';
export const OS_SHIPMENTS_SOURCE_ID = 'os-shipments';

export interface AgStudioData {
  sources: Array<{ id: string; data: Record<string, unknown>[] }>;
  relationships: Array<{
    id: string;
    source: { tableId: string; fieldId: string };
    target: { tableId: string; fieldId: string };
    type: 'many-to-one';
  }>;
}

export async function loadOfficeSuppliesData(): Promise<AgStudioData> {
  const raw = await loadRawOfficeSuppliesData();
  return {
    sources: [
      { id: OS_STORES_SOURCE_ID, data: raw.stores as unknown as Record<string, unknown>[] },
      { id: OS_PRODUCTS_SOURCE_ID, data: raw.products as unknown as Record<string, unknown>[] },
      { id: OS_CUSTOMERS_SOURCE_ID, data: raw.customers as unknown as Record<string, unknown>[] },
      { id: OS_ORDERS_SOURCE_ID, data: raw.orders as unknown as Record<string, unknown>[] },
      {
        id: OS_ORDER_ITEMS_SOURCE_ID,
        data: raw.orderItems as unknown as Record<string, unknown>[],
      },
      { id: OS_SHIPMENTS_SOURCE_ID, data: raw.shipments as unknown as Record<string, unknown>[] },
    ],
    relationships: [
      {
        id: 'os-rel-orders-customers',
        source: { tableId: OS_ORDERS_SOURCE_ID, fieldId: 'customer_id' },
        target: { tableId: OS_CUSTOMERS_SOURCE_ID, fieldId: 'customer_id' },
        type: 'many-to-one',
      },
      {
        id: 'os-rel-orders-stores',
        source: { tableId: OS_ORDERS_SOURCE_ID, fieldId: 'store_id' },
        target: { tableId: OS_STORES_SOURCE_ID, fieldId: 'store_id' },
        type: 'many-to-one',
      },
      {
        id: 'os-rel-orderitems-orders',
        source: { tableId: OS_ORDER_ITEMS_SOURCE_ID, fieldId: 'order_id' },
        target: { tableId: OS_ORDERS_SOURCE_ID, fieldId: 'order_id' },
        type: 'many-to-one',
      },
      {
        id: 'os-rel-orderitems-products',
        source: { tableId: OS_ORDER_ITEMS_SOURCE_ID, fieldId: 'product_id' },
        target: { tableId: OS_PRODUCTS_SOURCE_ID, fieldId: 'product_id' },
        type: 'many-to-one',
      },
      {
        id: 'os-rel-shipments-orders',
        source: { tableId: OS_SHIPMENTS_SOURCE_ID, fieldId: 'order_id' },
        target: { tableId: OS_ORDERS_SOURCE_ID, fieldId: 'order_id' },
        type: 'many-to-one',
      },
    ],
  };
}
