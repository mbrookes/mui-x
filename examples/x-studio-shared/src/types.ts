export type StoreRow = {
  store_id: string;
  store_name: string;
  region: string;
  city: string;
  opened_date: number;
  store_type: string;
};

export type ProductRow = {
  product_id: string;
  product_name: string;
  category: string;
  subcategory: string;
  brand: string;
  launch_date: number;
  list_price: number;
  unit_cost: number;
  is_discontinued: boolean | null;
};

export type CustomerRow = {
  customer_id: string;
  customer_name: string;
  signup_date: number;
  region: string;
  segment: string;
  is_active: boolean | null;
  marketing_opt_in: boolean | null;
};

export type OrderRow = {
  order_id: string;
  customer_id: string;
  store_id: string;
  order_datetime: number;
  channel: string;
  status: string;
  payment_method: string;
  currency: string;
  promo_code: string | null;
  notes: string | null;
  order_month: string;
  order_year: string;
};

export type OrderItemRow = {
  order_item_id: string;
  order_id: string;
  product_id: string;
  quantity: number;
  unit_price: number;
  discount_pct: number;
  tax_rate: number;
  returned: boolean | null;
  return_reason: string | null;
};

export type ShipmentRow = {
  shipment_id: string;
  order_id: string;
  ship_datetime: number;
  delivery_datetime: number | null;
  carrier: string;
  delayed: boolean | null;
};

export type RawOfficeSuppliesData = {
  stores: StoreRow[];
  products: ProductRow[];
  customers: CustomerRow[];
  orders: OrderRow[];
  orderItems: OrderItemRow[];
  shipments: ShipmentRow[];
};
