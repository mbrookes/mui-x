/**
 * Seed an in-memory node:sqlite database with demo sales data for the
 * x-studio example server. The schema mirrors the StudioDataSource
 * field IDs so Studio's query descriptors map directly to SQL columns.
 *
 * NOTE: In a real app you'd connect to an existing database instead.
 */
import { DatabaseSync } from 'node:sqlite';

// ── Simple PRNG (same seed as the UI generator so data is consistent) ─────────
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

const COUNTRIES = ['US', 'UK', 'DE', 'FR', 'CA', 'AU', 'JP', 'BR'];
const CATEGORIES = ['Electronics', 'Clothing', 'Food', 'Books', 'Toys', 'Sports'];
const STATUSES = ['completed', 'pending', 'shipped', 'cancelled'];

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function isoDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function seedDatabase(db: DatabaseSync, rowCount = 2000): void {
  const rng = mulberry32(42);
  const now = Date.now();
  const TWO_YEARS = 2 * 365 * 24 * 3600 * 1000;

  db.exec('PRAGMA journal_mode = WAL');

  // ── customers ──────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id        INTEGER PRIMARY KEY,
      name      TEXT NOT NULL,
      country   TEXT NOT NULL,
      city      TEXT NOT NULL,
      segment   TEXT NOT NULL
    )
  `);

  const insertCustomer = db.prepare(
    'INSERT INTO customers(id, name, country, city, segment) VALUES (?, ?, ?, ?, ?)',
  );

  const CITIES: Record<string, string[]> = {
    US: ['New York', 'Los Angeles', 'Chicago', 'Houston'],
    UK: ['London', 'Manchester', 'Birmingham'],
    DE: ['Berlin', 'Munich', 'Hamburg'],
    FR: ['Paris', 'Lyon', 'Marseille'],
    CA: ['Toronto', 'Vancouver', 'Montreal'],
    AU: ['Sydney', 'Melbourne', 'Brisbane'],
    JP: ['Tokyo', 'Osaka', 'Kyoto'],
    BR: ['São Paulo', 'Rio de Janeiro', 'Brasilia'],
  };

  const SEGMENTS = ['Consumer', 'Corporate', 'Home Office'];
  const customerCount = Math.min(rowCount, 500);

  // Store customer data for denormalization
  const customerCountries: string[] = [];
  const customerSegments: string[] = [];

  db.exec('BEGIN');
  for (let i = 1; i <= customerCount; i++) {
    const country = pick(rng, COUNTRIES);
    const segment = pick(rng, SEGMENTS);
    customerCountries.push(country);
    customerSegments.push(segment);
    insertCustomer.run(i, `Customer ${i}`, country, pick(rng, CITIES[country]), segment);
  }
  db.exec('COMMIT');

  // ── products ───────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id        INTEGER PRIMARY KEY,
      name      TEXT NOT NULL,
      category  TEXT NOT NULL,
      price     REAL NOT NULL
    )
  `);

  const insertProduct = db.prepare(
    'INSERT INTO products(id, name, category, price) VALUES (?, ?, ?, ?)',
  );

  // Store product categories for denormalization
  const productCategories: string[] = [];

  db.exec('BEGIN');
  for (let i = 1; i <= 100; i++) {
    const category = pick(rng, CATEGORIES);
    productCategories.push(category);
    insertProduct.run(i, `Product ${i}`, category, +(rng() * 500 + 5).toFixed(2));
  }
  db.exec('COMMIT');

  // ── orders ─────────────────────────────────────────────────────────────────
  // Denormalized for demo: country/segment from customers, category from products
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id          INTEGER PRIMARY KEY,
      customer_id INTEGER NOT NULL,
      status      TEXT NOT NULL,
      date        TEXT NOT NULL,
      total       REAL NOT NULL,
      country     TEXT NOT NULL,
      segment     TEXT NOT NULL,
      category    TEXT NOT NULL
    )
  `);

  const insertOrder = db.prepare(
    'INSERT INTO orders(id, customer_id, status, date, total, country, segment, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );

  // ── order_items ────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS order_items (
      id         INTEGER PRIMARY KEY,
      order_id   INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity   INTEGER NOT NULL,
      unit_price REAL NOT NULL,
      discount   REAL NOT NULL,
      total      REAL NOT NULL
    )
  `);

  const insertItem = db.prepare(
    'INSERT INTO order_items(id, order_id, product_id, quantity, unit_price, discount, total) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );

  db.exec('BEGIN');
  let itemId = 1;
  for (let i = 1; i <= rowCount; i++) {
    const customerId = Math.floor(rng() * customerCount) + 1;
    const date = isoDate(now - Math.floor(rng() * TWO_YEARS));
    const qty = Math.floor(rng() * 5) + 1;
    const price = +(rng() * 200 + 10).toFixed(2);
    const discount = +(rng() * 0.3).toFixed(2);
    const total = +(qty * price * (1 - discount)).toFixed(2);
    const productId = Math.floor(rng() * 100) + 1;

    // Denormalize country/segment from customer, category from first product
    const country = customerCountries[customerId - 1];
    const segment = customerSegments[customerId - 1];
    const category = productCategories[productId - 1];

    insertOrder.run(i, customerId, pick(rng, STATUSES), date, total, country, segment, category);

    // 1–3 items per order
    const itemCount = Math.floor(rng() * 3) + 1;
    for (let j = 0; j < itemCount; j++) {
      const iProductId = Math.floor(rng() * 100) + 1;
      const iQty = Math.floor(rng() * 4) + 1;
      const iPrice = +(rng() * 150 + 5).toFixed(2);
      const iDiscount = +(rng() * 0.25).toFixed(2);
      const iTotal = +(iQty * iPrice * (1 - iDiscount)).toFixed(2);
      insertItem.run(itemId++, i, iProductId, iQty, iPrice, iDiscount, iTotal);
    }
  }
  db.exec('COMMIT');

  console.log(
    `  ${customerCount} customers, 100 products, ${rowCount} orders, ${itemId - 1} order items`,
  );
}
