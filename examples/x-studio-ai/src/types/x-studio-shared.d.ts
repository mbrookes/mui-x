declare module 'x-studio-shared' {
  export const INITIAL_STATE: {
    dataSources: Record<
      string,
      { id: string; rows?: Record<string, unknown>[]; [key: string]: unknown }
    >;
    [key: string]: unknown;
  };

  export interface GeneratedSalesData {
    customersSource: { id: string; rows?: Record<string, unknown>[]; [key: string]: unknown };
    productsSource: { id: string; rows?: Record<string, unknown>[]; [key: string]: unknown };
    ordersSource: { id: string; rows?: Record<string, unknown>[]; [key: string]: unknown };
    orderItemsSource: { id: string; rows?: Record<string, unknown>[]; [key: string]: unknown };
    shipmentsSource: { id: string; rows?: Record<string, unknown>[]; [key: string]: unknown };
    shipmentItemsSource: { id: string; rows?: Record<string, unknown>[]; [key: string]: unknown };
  }

  export function generateSalesData(options: { seed: number }): GeneratedSalesData;
  export function downloadJson(data: unknown, fileName: string): void;
  export function uploadJson(): Promise<unknown>;
}
