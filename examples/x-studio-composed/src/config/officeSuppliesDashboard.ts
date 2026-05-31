import type { StudioState } from '@mui/x-studio';
import { createXStudioOfficeSuppliesState } from 'x-studio-shared';
import {
  OS_STORES_SOURCE_ID,
  OS_PRODUCTS_SOURCE_ID,
  OS_CUSTOMERS_SOURCE_ID,
  OS_ORDERS_SOURCE_ID,
  OS_ORDER_ITEMS_SOURCE_ID,
  OS_SHIPMENTS_SOURCE_ID,
} from '../officeSuppliesData';

export const OS_INITIAL_STATE: Partial<StudioState> = createXStudioOfficeSuppliesState({
  stores: OS_STORES_SOURCE_ID,
  products: OS_PRODUCTS_SOURCE_ID,
  customers: OS_CUSTOMERS_SOURCE_ID,
  orders: OS_ORDERS_SOURCE_ID,
  orderItems: OS_ORDER_ITEMS_SOURCE_ID,
  shipments: OS_SHIPMENTS_SOURCE_ID,
}) as Partial<StudioState>;
