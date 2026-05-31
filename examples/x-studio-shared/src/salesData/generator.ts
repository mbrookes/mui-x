import type { StudioDataSource } from '@mui/x-studio';
import { CATEGORY_REVENUE_MULTIPLIERS, roundCurrency } from './categoryRevenueMultipliers';

/* eslint-disable no-bitwise, no-plusplus */
// Intentional: mulberry32 PRNG uses bitwise ops for performance; i++ and shipIdx++
// are standard counter idioms in this data-generation module.

// ─── Seeded PRNG (mulberry32) ──────────────────────────────────────────────────
// A simple, fast, high-quality 32-bit PRNG. No external dependency.
// Returns a function that produces uniformly distributed floats in [0, 1).
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function rng() {
    s += 0x6d2b79f5;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 0x100000000;
  };
}

// ─── PRNG helpers ─────────────────────────────────────────────────────────────

type Rng = () => number;

function randInt(rng: Rng, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

/** Weighted pick: weights must sum to 1. */
function pickWeighted<T>(rng: Rng, options: readonly T[], weights: readonly number[]): T {
  const r = rng();
  let cumulative = 0;
  for (let i = 0; i < options.length; i++) {
    cumulative += weights[i];
    if (r < cumulative) {
      return options[i];
    }
  }
  return options[options.length - 1];
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Returns a bound random-date sampler for a fixed [from, to] range.
 * Pre-parses the boundary strings once so repeated calls inside a generation
 * loop don't incur repeated `new Date(string)` parsing costs.
 */
function makeDateSampler(from: string, to: string): (rng: Rng) => string {
  const a = new Date(from).getTime();
  const span = new Date(to).getTime() - a;
  return (rng) => isoDate(new Date(a + rng() * span));
}

/** Add a number of days to an ISO date string. */
function addDays(dateStr: string, days: number): string {
  // Use Date.UTC to avoid the string-parsing overhead of new Date(string).
  const y = Number(dateStr.slice(0, 4));
  const m = Number(dateStr.slice(5, 7)) - 1; // 0-indexed month
  const d = Number(dateStr.slice(8, 10));
  return isoDate(new Date(Date.UTC(y, m, d + days)));
}

function zeroPad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

// ─── Static vocabulary ────────────────────────────────────────────────────────

const COUNTRIES = [
  'Germany',
  'UK',
  'France',
  'USA',
  'Canada',
  'Spain',
  'Netherlands',
  'Sweden',
  'Poland',
  'Australia',
] as const;

// Relative order-frequency weights per country. Higher values mean more orders
// are assigned to customers in that country, producing natural revenue variance.
const COUNTRY_ORDER_WEIGHTS: Record<string, number> = {
  USA: 3.0,
  UK: 2.0,
  Germany: 1.5,
  France: 1.2,
  Canada: 1.2,
  Netherlands: 1.0,
  Australia: 1.0,
  Sweden: 0.8,
  Spain: 0.8,
  Poland: 0.6,
};

const COUNTRY_CURRENCY: Record<string, string> = {
  Germany: 'EUR',
  France: 'EUR',
  Spain: 'EUR',
  Netherlands: 'EUR',
  Sweden: 'EUR',
  Poland: 'EUR',
  UK: 'GBP',
  USA: 'USD',
  Canada: 'CAD',
  Australia: 'AUD',
};

const SEGMENTS = ['Enterprise', 'Mid-Market', 'SMB'] as const;

const ORDER_STATUSES = [
  'Delivered',
  'Shipped',
  'Processing',
  'Pending',
  'Partially Delivered',
  'Cancelled',
] as const;

const ORDER_STATUS_WEIGHTS = [0.6, 0.15, 0.1, 0.08, 0.05, 0.02] as const;

const CARRIERS = ['DHL', 'FedEx', 'UPS', 'USPS', 'DPD', 'GLS'] as const;

const DISCOUNTS = [0, 5, 8, 10, 12, 15, 18, 20] as const;

// Product definitions: [name, category, basePrice, baseCost, maxStock, reorderLevel]
type ProductSpec = [string, string, number, number, number, number];

const PRODUCT_SPECS: ProductSpec[] = [
  ['Laptop Pro 15"', 'Electronics', 1299, 850, 120, 20],
  ['Wireless Mouse', 'Electronics', 49, 18, 230, 50],
  ['USB-C Hub', 'Electronics', 79, 28, 180, 40],
  ['Mechanical Keyboard', 'Electronics', 129, 55, 150, 30],
  ['Monitor 27" 4K', 'Electronics', 599, 380, 80, 15],
  ['Office Chair Ergonomic', 'Furniture', 399, 180, 60, 10],
  ['Standing Desk', 'Furniture', 599, 320, 40, 8],
  ['Desk Lamp LED', 'Furniture', 69, 25, 100, 20],
  ['Webcam HD', 'Electronics', 89, 35, 140, 25],
  ['Headphones Noise-Cancel', 'Electronics', 249, 120, 110, 20],
  ['Printer Laser', 'Electronics', 349, 190, 70, 12],
  ['Paper A4 (500 sheets)', 'Supplies', 12, 6, 500, 100],
  ['Ink Cartridge Black', 'Supplies', 35, 12, 300, 80],
  ['Ink Cartridge Color', 'Supplies', 45, 16, 280, 70],
  ['Notebook Set (3-pack)', 'Supplies', 18, 7, 400, 90],
  ['Whiteboard 48x36"', 'Furniture', 129, 58, 50, 10],
  ['Filing Cabinet', 'Furniture', 199, 90, 35, 8],
  ['External SSD 1TB', 'Electronics', 119, 60, 160, 30],
  ['Tablet 10"', 'Electronics', 399, 220, 90, 15],
  ['Docking Station', 'Electronics', 179, 80, 130, 25],
  ['Cloud Storage 1TB', 'Software', 99, 15, 999, 0],
  ['Antivirus Suite', 'Software', 49, 8, 999, 0],
  ['Project Management Tool', 'Software', 199, 30, 999, 0],
  ['VPN Service', 'Software', 79, 12, 999, 0],
  ['Office Suite License', 'Software', 299, 45, 999, 0],
  ['IT Support Basic', 'Services', 249, 60, 999, 0],
  ['IT Support Premium', 'Services', 999, 220, 999, 0],
  ['Network Setup', 'Services', 1499, 400, 999, 0],
  ['Data Backup', 'Services', 299, 70, 999, 0],
  ['Cloud Migration Package', 'Services', 2499, 700, 999, 0],
  ['Network Switch 24-Port', 'Networking', 349, 160, 55, 10],
  ['WiFi Router Enterprise', 'Networking', 299, 130, 65, 12],
  ['Ethernet Cable Cat6', 'Networking', 39, 12, 200, 50],
  ['Patch Panel', 'Networking', 129, 55, 80, 15],
  ['Network Rack 12U', 'Networking', 249, 110, 45, 8],
];

// Company name fragments for generating realistic B2B names
const CO_PREFIXES = [
  'Tech',
  'Digital',
  'Global',
  'Prime',
  'Alpha',
  'Nexus',
  'Apex',
  'Vertex',
  'Swift',
  'Core',
  'Smart',
  'Peak',
  'Metro',
  'Euro',
  'Pacific',
  'Nordic',
  'Capital',
  'Premier',
  'Dynamic',
  'Fusion',
];
const CO_SUFFIXES = [
  'Corp',
  'AG',
  'Ltd',
  'Inc',
  'GmbH',
  'BV',
  'AB',
  'SAS',
  'SpA',
  'Pty',
  'Solutions',
  'Systems',
  'Technologies',
  'Services',
  'Group',
];
const FIRST_NAMES = [
  'James',
  'Emma',
  'Liam',
  'Olivia',
  'Noah',
  'Ava',
  'William',
  'Sophia',
  'Benjamin',
  'Isabella',
  'Lucas',
  'Mia',
  'Henry',
  'Charlotte',
  'Alexander',
  'Amelia',
  'Mason',
  'Harper',
  'Ethan',
  'Evelyn',
  'Hans',
  'Petra',
  'Marie',
  'Pierre',
  'Sarah',
  'Michael',
  'Anna',
  'Lars',
  'Ingrid',
  'Piotr',
];
const LAST_NAMES = [
  'Mueller',
  'Schmidt',
  'Schneider',
  'Fischer',
  'Weber',
  'Smith',
  'Johnson',
  'Williams',
  'Brown',
  'Jones',
  'Martin',
  'Bernard',
  'Dubois',
  'Thomas',
  'Laurent',
  'Anderson',
  'Taylor',
  'Wilson',
  'Harris',
  'Jackson',
  'Kowalski',
  'Nowak',
  'Jensen',
  'Nielsen',
  'Larsson',
];

// ─── Source IDs (match static files) ─────────────────────────────────────────

const CUSTOMERS_SOURCE_ID = 'source-customers';
const PRODUCTS_SOURCE_ID = 'source-products';
const ORDERS_SOURCE_ID = 'source-orders';
const ORDER_ITEMS_SOURCE_ID = 'source-order-items';
const SHIPMENTS_SOURCE_ID = 'source-shipments';
const SHIPMENT_ITEMS_SOURCE_ID = 'source-shipment-items';

// ─── Generator options ────────────────────────────────────────────────────────

export interface GeneratorOptions {
  /** Integer seed for the PRNG. Defaults to 42 for reproducible output. */
  seed?: number;
  /** Number of orders to generate. Defaults to 220 (same as static data). */
  orderCount?: number;
}

// ─── Individual table generators ─────────────────────────────────────────────

function generateCustomers(rng: Rng, count: number): StudioDataSource {
  const rows: Record<string, unknown>[] = [];
  const sampleSinceDate = makeDateSampler('2015-01-01', '2022-12-31');
  for (let i = 0; i < count; i++) {
    const id = `CUS-${zeroPad(i + 1, 3)}`;
    const country = pick(rng, COUNTRIES);
    const firstName = pick(rng, FIRST_NAMES);
    const lastName = pick(rng, LAST_NAMES);
    const prefix = pick(rng, CO_PREFIXES);
    const suffix = pick(rng, CO_SUFFIXES);
    rows.push({
      id,
      company: `${prefix} ${suffix}`,
      contact: `${firstName} ${lastName}`,
      email: `${firstName.toLowerCase().charAt(0)}.${lastName.toLowerCase()}@${prefix.toLowerCase()}.com`,
      country,
      segment: pick(rng, SEGMENTS),
      since: sampleSinceDate(rng),
    });
  }

  return {
    id: CUSTOMERS_SOURCE_ID,
    label: 'Customers',
    fields: [
      { id: 'id', label: 'Customer ID', type: 'string', hidden: true },
      { id: 'company', label: 'Company', type: 'string' },
      { id: 'contact', label: 'Contact Name', type: 'string' },
      { id: 'email', label: 'Email', type: 'string' },
      { id: 'country', label: 'Country', type: 'string' },
      { id: 'segment', label: 'Segment', type: 'string' },
      { id: 'since', label: 'Customer Since', type: 'date' },
    ],
    rows,
  };
}

function generateProducts(rng: Rng): StudioDataSource {
  const rows: Record<string, unknown>[] = PRODUCT_SPECS.map(
    ([name, category, basePrice, baseCost, maxStock, reorderLevel], i) => {
      // Add slight random variation to prices (±10%) while preserving category character
      const priceVariation = 0.9 + rng() * 0.2;
      const rawPrice = roundCurrency(basePrice * priceVariation);
      const rawCost = roundCurrency(baseCost * priceVariation);
      const multiplier = CATEGORY_REVENUE_MULTIPLIERS[category] ?? 1;
      return {
        id: `PRD-${zeroPad(i + 1, 3)}`,
        product: name,
        category,
        price: roundCurrency(rawPrice * multiplier),
        cost: roundCurrency(rawCost * multiplier),
        stock: maxStock === 999 ? 999 : randInt(rng, Math.max(0, reorderLevel - 5), maxStock),
        reorderLevel,
      };
    },
  );

  return {
    id: PRODUCTS_SOURCE_ID,
    label: 'Products',
    fields: [
      { id: 'id', label: 'Product ID', type: 'string', hidden: true },
      { id: 'product', label: 'Product', type: 'string' },
      { id: 'category', label: 'Category', type: 'string' },
      { id: 'price', label: 'Unit Price', type: 'number', format: 'currency' },
      { id: 'cost', label: 'Unit Cost', type: 'number', format: 'currency' },
      { id: 'stock', label: 'In Stock', type: 'number', format: 'integer' },
      { id: 'reorderLevel', label: 'Reorder Level', type: 'number', format: 'integer' },
    ],
    rows,
  };
}

interface GeneratedOrder extends Record<string, unknown> {
  id: string;
  date: string;
  customerId: string;
  status: string;
  total: number;
  currency: string;
}

function generateOrders(
  rng: Rng,
  count: number,
  customerRows: Record<string, unknown>[],
): { source: StudioDataSource; rows: GeneratedOrder[] } {
  const rows: GeneratedOrder[] = [];
  // Pre-compute per-customer weights so weighted pick reflects country order frequency.
  const customerWeights = customerRows.map((c) => COUNTRY_ORDER_WEIGHTS[String(c.country)] ?? 1);
  const weightSum = customerWeights.reduce((s, w) => s + w, 0);
  const customerWeightsNorm = customerWeights.map((w) => w / weightSum);

  // Generate dates from 3 years ago through 90 days from now so that relative-date
  // filters (e.g. "last 12 months") always cover a meaningful slice of the data
  // regardless of when the demo is run.
  const today = new Date();
  const threeYearsAgo = new Date(today);
  threeYearsAgo.setFullYear(today.getFullYear() - 3);
  const ninetyDaysAhead = new Date(today);
  ninetyDaysAhead.setDate(today.getDate() + 90);
  const sampleOrderDate = makeDateSampler(isoDate(threeYearsAgo), isoDate(ninetyDaysAhead));
  for (let i = 0; i < count; i++) {
    const customer = pickWeighted(rng, customerRows, customerWeightsNorm);
    const country = customer.country as string;
    rows.push({
      id: `ORD-${zeroPad(i + 1, 7)}`,
      date: sampleOrderDate(rng),
      customerId: customer.id as string,
      status: pickWeighted(rng, ORDER_STATUSES, ORDER_STATUS_WEIGHTS),
      total: 0, // derived later
      currency: COUNTRY_CURRENCY[country] ?? 'USD',
    });
  }

  return {
    source: {
      id: ORDERS_SOURCE_ID,
      label: 'Orders',
      fields: [
        { id: 'id', label: 'Order ID', type: 'string', hidden: true },
        { id: 'date', label: 'Order Date', type: 'date' },
        { id: 'customerId', label: 'Customer ID', type: 'string', hidden: true },
        { id: 'status', label: 'Status', type: 'string' },
        { id: 'total', label: 'Order Total', type: 'number', format: 'currency' },
        { id: 'currency', label: 'Currency', type: 'string' },
      ],
      rows,
    },
    rows,
  };
}

interface GeneratedOrderItem extends Record<string, unknown> {
  id: string;
  orderId: string;
  productId: string;
  product: string;
  category: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  total: number;
}

function generateOrderItems(
  rng: Rng,
  orders: GeneratedOrder[],
  productRows: Record<string, unknown>[],
): {
  source: StudioDataSource;
  rows: GeneratedOrderItem[];
  byOrderId: Map<string, GeneratedOrderItem[]>;
} {
  const rows: GeneratedOrderItem[] = [];
  const byOrderId = new Map<string, GeneratedOrderItem[]>();

  for (const order of orders) {
    // 1–5 items, weighted toward 2–3
    const itemCount = pickWeighted(rng, [1, 2, 3, 4, 5] as const, [0.1, 0.3, 0.35, 0.15, 0.1]);
    // Avoid duplicate products within one order
    const usedProductIds = new Set<string>();
    const orderItems: GeneratedOrderItem[] = [];

    for (let j = 0; j < itemCount; j++) {
      let product = pick(rng, productRows);
      // Try up to 5 times to get a non-duplicate product
      for (let attempt = 0; attempt < 5 && usedProductIds.has(product.id as string); attempt++) {
        product = pick(rng, productRows);
      }
      usedProductIds.add(product.id as string);

      const quantity = randInt(rng, 1, 50);
      const discount = pick(rng, DISCOUNTS);
      const unitPrice = product.price as number;
      const total = roundCurrency(quantity * unitPrice * (1 - discount / 100));

      const item: GeneratedOrderItem = {
        id: `${order.id}-${j + 1}`,
        orderId: order.id,
        productId: product.id as string,
        product: product.product as string,
        category: product.category as string,
        quantity,
        unitPrice,
        discount,
        total,
      };
      orderItems.push(item);
      rows.push(item);
    }
    byOrderId.set(order.id, orderItems);
  }

  return {
    source: {
      id: ORDER_ITEMS_SOURCE_ID,
      label: 'Order Items',
      fields: [
        { id: 'id', label: 'Order Item ID', type: 'string', hidden: true },
        { id: 'orderId', label: 'Order ID', type: 'string', hidden: true },
        { id: 'productId', label: 'Product ID', type: 'string', hidden: true },
        { id: 'product', label: 'Product', type: 'string' },
        { id: 'category', label: 'Category', type: 'string' },
        { id: 'quantity', label: 'Quantity', type: 'number', format: 'integer' },
        { id: 'unitPrice', label: 'Unit Price', type: 'number', format: 'currency' },
        { id: 'discount', label: 'Discount %', type: 'number', format: 'percent' },
        { id: 'total', label: 'Total', type: 'number', format: 'currency' },
      ],
      rows,
    },
    rows,
    byOrderId,
  };
}

function deriveOrderTotals(
  orders: GeneratedOrder[],
  itemsByOrderId: Map<string, GeneratedOrderItem[]>,
): void {
  for (const order of orders) {
    const items = itemsByOrderId.get(order.id) ?? [];
    order.total = roundCurrency(items.reduce((sum, item) => sum + item.total, 0));
  }
}

interface GeneratedShipment extends Record<string, unknown> {
  id: string;
  orderId: string;
  carrier: string;
  trackingNumber: string;
  shipDate: string;
  estimatedDeliveryDate: string;
  actualDeliveryDate: string | null;
  status: string;
  onTime: boolean;
  itemCount: number;
}

function generateShipments(
  rng: Rng,
  orders: GeneratedOrder[],
  itemsByOrderId: Map<string, GeneratedOrderItem[]>,
): { source: StudioDataSource; rows: GeneratedShipment[] } {
  const rows: GeneratedShipment[] = [];
  let shipIdx = 1;

  for (const order of orders) {
    // Cancelled orders don't ship; Processing/Pending may not have shipped yet
    if (order.status === 'Cancelled') {
      continue;
    }
    if ((order.status === 'Pending' || order.status === 'Processing') && rng() < 0.5) {
      continue;
    }

    const isDelivered = order.status === 'Delivered' || order.status === 'Partially Delivered';
    const shipDate = addDays(order.date, randInt(rng, 1, 3));
    const estimatedDelivery = addDays(shipDate, randInt(rng, 3, 7));

    let actualDelivery: string | null = null;
    let onTime = false;
    let status: string;

    if (isDelivered || order.status === 'Shipped') {
      actualDelivery = addDays(shipDate, randInt(rng, 1, 8));
      onTime = actualDelivery <= estimatedDelivery;
      status = actualDelivery ? 'Delivered' : 'In Transit';
    } else {
      status = 'In Transit';
    }

    const items = itemsByOrderId.get(order.id) ?? [];
    const id = `SHP-${zeroPad(shipIdx, 4)}`;
    const shipment: GeneratedShipment = {
      id,
      orderId: order.id,
      carrier: pick(rng, CARRIERS),
      trackingNumber: `TRK${zeroPad(randInt(rng, 1, 999999999), 9)}`,
      shipDate,
      estimatedDeliveryDate: estimatedDelivery,
      actualDeliveryDate: actualDelivery,
      status,
      onTime,
      itemCount: items.length,
    };
    rows.push(shipment);
    shipIdx++;
  }

  return {
    source: {
      id: SHIPMENTS_SOURCE_ID,
      label: 'Shipments',
      fields: [
        { id: 'id', label: 'Shipment ID', type: 'string', hidden: true },
        { id: 'orderId', label: 'Order ID', type: 'string', hidden: true },
        { id: 'carrier', label: 'Carrier', type: 'string' },
        { id: 'trackingNumber', label: 'Tracking Number', type: 'string' },
        { id: 'shipDate', label: 'Ship Date', type: 'date' },
        { id: 'estimatedDeliveryDate', label: 'Est. Delivery', type: 'date' },
        { id: 'actualDeliveryDate', label: 'Actual Delivery', type: 'date' },
        { id: 'status', label: 'Status', type: 'string' },
        { id: 'onTime', label: 'On Time', type: 'boolean' },
        { id: 'itemCount', label: 'Items', type: 'number', format: 'integer' },
      ],
      rows,
    },
    rows,
  };
}

function generateShipmentItems(
  shipments: GeneratedShipment[],
  itemsByOrderId: Map<string, GeneratedOrderItem[]>,
): StudioDataSource {
  const rows: Record<string, unknown>[] = [];
  let idx = 1;

  for (const shipment of shipments) {
    const items = itemsByOrderId.get(shipment.orderId) ?? [];
    for (const item of items) {
      rows.push({
        id: `SI-${zeroPad(idx, 4)}`,
        shipmentId: shipment.id,
        orderItemId: item.id,
      });
      idx++;
    }
  }

  return {
    id: SHIPMENT_ITEMS_SOURCE_ID,
    label: 'Shipment Items',
    hidden: true,
    fields: [
      { id: 'id', label: 'ID', type: 'string', hidden: true },
      { id: 'shipmentId', label: 'Shipment ID', type: 'string', hidden: true },
      { id: 'orderItemId', label: 'Order Item ID', type: 'string', hidden: true },
    ],
    rows,
  };
}

// ─── Main export ──────────────────────────────────────────────────────────────

export interface GeneratedSalesData {
  customersSource: StudioDataSource;
  productsSource: StudioDataSource;
  ordersSource: StudioDataSource;
  orderItemsSource: StudioDataSource;
  shipmentsSource: StudioDataSource;
  shipmentItemsSource: StudioDataSource;
}

/**
 * Generate a coherent set of relational sales data sources.
 *
 * All foreign keys are guaranteed to be valid. Derived fields (order totals,
 * shipment onTime, category price multipliers) are computed after generation.
 *
 * @param opts.seed - Integer seed for the PRNG. Default: 42 (reproducible).
 * @param opts.orderCount - Number of orders to generate. Default: 220.
 */
export function generateSalesData(opts?: GeneratorOptions): GeneratedSalesData {
  const seed = opts?.seed ?? 42;
  const orderCount = opts?.orderCount ?? 220;
  // Scale customers with order count, but keep a sensible minimum and maximum
  const customerCount = Math.min(500, Math.max(50, Math.ceil(orderCount / 4)));

  const rng = mulberry32(seed);

  // 1. Dimension tables (no FKs)
  const customersSource = generateCustomers(rng, customerCount);
  const productsSource = generateProducts(rng);

  // 2. Orders — FK: customerId → customers.id
  const { source: ordersSourceRaw, rows: orderRows } = generateOrders(
    rng,
    orderCount,
    customersSource.rows!,
  );

  // 3. Order items — FKs: orderId → orders.id, productId → products.id
  const { source: orderItemsSource, byOrderId: itemsByOrderId } = generateOrderItems(
    rng,
    orderRows,
    productsSource.rows!,
  );

  // 4. Derive order totals from order items
  deriveOrderTotals(orderRows, itemsByOrderId);
  // ordersSourceRaw.rows is the same array reference as orderRows, so totals are live

  // 5. Shipments — FK: orderId → orders.id
  const { source: shipmentsSource, rows: shipmentRows } = generateShipments(
    rng,
    orderRows,
    itemsByOrderId,
  );

  // 6. Shipment items (junction) — FKs: shipmentId + orderItemId
  const shipmentItemsSource = generateShipmentItems(shipmentRows, itemsByOrderId);

  return {
    customersSource,
    productsSource,
    ordersSource: ordersSourceRaw,
    orderItemsSource,
    shipmentsSource,
    shipmentItemsSource,
  };
}
