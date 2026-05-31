import { expressions, loadRawOfficeSuppliesData, relationships } from 'x-studio-shared';

export const OS_STORES_SOURCE_ID = 'stores';
export const OS_PRODUCTS_SOURCE_ID = 'products';
export const OS_CUSTOMERS_SOURCE_ID = 'customers';
export const OS_ORDERS_SOURCE_ID = 'orders';
export const OS_ORDER_ITEMS_SOURCE_ID = 'order_items';
export const OS_SHIPMENTS_SOURCE_ID = 'shipments';

export interface AgStudioData {
  sources: Array<{ id: string; data: Record<string, unknown>[] }>;
  relationships: Array<{
    id: string;
    source: { tableId: string; fieldId: string };
    target: { tableId: string; fieldId: string };
    type: 'many-to-one';
  }>;
  expressions: typeof expressions;
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
    relationships: relationships as AgStudioData['relationships'],
    expressions,
  };
}
