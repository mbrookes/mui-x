/**
 * Deterministic synthetic data generator for pipeline benchmarks.
 *
 * All values are derived from the row index — no Math.random() — so results
 * are reproducible across benchmark runs.
 *
 * Schema
 * ──────
 *  orders      (n rows)       id, date, total, status, category, customerId
 *  customers   (n/10 rows)    id, country, segment
 *  orderItems  (n*3 rows)     id, orderId, product, quantity, price
 *
 * Relationships
 *  orders.customerId → customers.id   (many-to-one)
 *  orderItems.orderId → orders.id     (many-to-one)
 *
 * Expression fields (on orders)
 *  expr-revenue-adj   total * 1.1             (arithmetic column)
 *  expr-country       join customers.country  (join column)
 */

import type {
  StudioDataSource,
  StudioExpressionField,
  StudioRelationship,
} from '../models';

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUSES = ['pending', 'completed', 'shipped', 'cancelled', 'refunded'];
const CATEGORIES = ['Electronics', 'Clothing', 'Food', 'Books', 'Furniture'];
const COUNTRIES = ['Germany', 'France', 'UK', 'Spain', 'Italy'];
const SEGMENTS = ['Consumer', 'Corporate', 'SMB'];
const PRODUCTS = [
  'Laptop', 'T-Shirt', 'Coffee', 'Novel', 'Chair',
  'Phone', 'Jacket', 'Tea', 'Textbook', 'Desk',
];

/** ISO date string for day offset from 2023-01-01 */
function isoDate(dayOffset: number): string {
  const base = new Date(2023, 0, 1);
  base.setDate(base.getDate() + (dayOffset % 730)); // 2 years
  return base.toISOString().slice(0, 10);
}

// ─── Row generators ───────────────────────────────────────────────────────────

export function makeCustomerRows(n: number): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      id: `CUS-${i}`,
      country: COUNTRIES[i % COUNTRIES.length],
      segment: SEGMENTS[i % SEGMENTS.length],
    });
  }
  return rows;
}

export function makeOrderRows(n: number): Record<string, unknown>[] {
  const customerCount = Math.max(1, Math.floor(n / 10));
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      id: `ORD-${i}`,
      date: isoDate(i),
      total: 10 + (i % 991), // 10–1000, prime modulus for spread
      status: STATUSES[i % STATUSES.length],
      category: CATEGORIES[i % CATEGORIES.length],
      customerId: `CUS-${i % customerCount}`,
    });
  }
  return rows;
}

export function makeOrderItemRows(orderCount: number): Record<string, unknown>[] {
  const itemsPerOrder = 3;
  const total = orderCount * itemsPerOrder;
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < total; i++) {
    rows.push({
      id: `ITEM-${i}`,
      orderId: `ORD-${Math.floor(i / itemsPerOrder)}`,
      product: PRODUCTS[i % PRODUCTS.length],
      quantity: 1 + (i % 5),
      price: 10 + (i % 91), // 10–100
    });
  }
  return rows;
}

// ─── DataSource builders ──────────────────────────────────────────────────────

export function makeCustomersSource(n: number): StudioDataSource {
  return {
    id: 'customers',
    label: 'Customers',
    fields: [
      { id: 'id', label: 'Customer ID', type: 'string' },
      { id: 'country', label: 'Country', type: 'string' },
      { id: 'segment', label: 'Segment', type: 'string' },
    ],
    rows: makeCustomerRows(n),
  };
}

export function makeOrdersSource(n: number): StudioDataSource {
  return {
    id: 'orders',
    label: 'Orders',
    fields: [
      { id: 'id', label: 'Order ID', type: 'string' },
      { id: 'date', label: 'Date', type: 'date' },
      { id: 'total', label: 'Total', type: 'number' },
      { id: 'status', label: 'Status', type: 'string' },
      { id: 'category', label: 'Category', type: 'string' },
      { id: 'customerId', label: 'Customer ID', type: 'string' },
    ],
    rows: makeOrderRows(n),
  };
}

export function makeOrderItemsSource(orderCount: number): StudioDataSource {
  return {
    id: 'orderItems',
    label: 'Order Items',
    fields: [
      { id: 'id', label: 'Item ID', type: 'string' },
      { id: 'orderId', label: 'Order ID', type: 'string' },
      { id: 'product', label: 'Product', type: 'string' },
      { id: 'quantity', label: 'Quantity', type: 'number' },
      { id: 'price', label: 'Price', type: 'number' },
    ],
    rows: makeOrderItemRows(orderCount),
  };
}

// ─── Relationships ────────────────────────────────────────────────────────────

export const relationships: StudioRelationship[] = [
  {
    id: 'rel-orders-customers',
    sourceId: 'orders',
    sourceField: 'customerId',
    targetId: 'customers',
    targetField: 'id',
    type: 'many-to-one',
  },
  {
    id: 'rel-items-orders',
    sourceId: 'orderItems',
    sourceField: 'orderId',
    targetId: 'orders',
    targetField: 'id',
    type: 'many-to-one',
  },
];

// ─── Expression fields ────────────────────────────────────────────────────────

/**
 * Arithmetic column: orders.total * 1.1  →  expr-revenue-adj (per-row scalar)
 */
export const exprRevenueAdj: StudioExpressionField = {
  id: 'expr-revenue-adj',
  label: 'Adjusted Revenue',
  sourceId: 'orders',
  isMeasure: false,
  expression: {
    operator: 'multiply',
    inputs: [{ id: 'total' }, { type: 'number', value: 1.1 }],
  },
};

/**
 * Join column: pull customers.country onto each order row  →  expr-country
 */
export const exprCountry: StudioExpressionField = {
  id: 'expr-country',
  label: 'Customer Country',
  sourceId: 'orders',
  isMeasure: false,
  expression: { joinSourceId: 'customers', fieldId: 'country' },
};

// ─── Full scenario builders ───────────────────────────────────────────────────

/**
 * Build a complete bench scenario at the given order count.
 * customers = orderCount / 10, orderItems = orderCount * 3.
 */
export function buildScenario(orderCount: number): {
  dataSources: Record<string, StudioDataSource>;
  relationships: StudioRelationship[];
  expressionFields: StudioExpressionField[];
} {
  const customerCount = Math.max(1, Math.floor(orderCount / 10));
  return {
    dataSources: {
      customers: makeCustomersSource(customerCount),
      orders: makeOrdersSource(orderCount),
      orderItems: makeOrderItemsSource(orderCount),
    },
    relationships,
    expressionFields: [exprRevenueAdj, exprCountry],
  };
}
