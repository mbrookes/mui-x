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
  // Column names match Studio source field IDs so descriptors map directly to SQL
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id        INTEGER PRIMARY KEY,
      company   TEXT NOT NULL,
      contact   TEXT NOT NULL,
      email     TEXT NOT NULL,
      country   TEXT NOT NULL,
      segment   TEXT NOT NULL,
      since     TEXT NOT NULL
    )
  `);

  const insertCustomer = db.prepare(
    'INSERT INTO customers(id, company, contact, email, country, segment, since) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );

  const SEGMENTS = ['Consumer', 'Corporate', 'Home Office'];
  const customerCount = Math.min(rowCount, 500);
  const FIRST_NAMES = ['Alex', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Drew', 'Avery'];
  const LAST_NAMES = ['Smith', 'Jones', 'Brown', 'Davis', 'Miller', 'Wilson', 'Moore', 'Taylor'];

  // Store customer data for denormalization
  const customerCountries: string[] = [];
  const customerSegments: string[] = [];

  db.exec('BEGIN');
  for (let i = 1; i <= customerCount; i++) {
    const country = pick(rng, COUNTRIES);
    const segment = pick(rng, SEGMENTS);
    customerCountries.push(country);
    customerSegments.push(segment);
    const first = pick(rng, FIRST_NAMES);
    const last = pick(rng, LAST_NAMES);
    const company = `${last} ${pick(rng, ['GmbH', 'AG', 'Inc', 'Ltd', 'SAS', 'Corp'])}`;
    const contact = `${first} ${last}`;
    const email = `${first.toLowerCase()}.${last.toLowerCase()}${i}@example.com`;
    const year = 2018 + Math.floor(rng() * 7);
    const month = String(Math.floor(rng() * 12) + 1).padStart(2, '0');
    const day = String(Math.floor(rng() * 28) + 1).padStart(2, '0');
    const since = `${year}-${month}-${day}`;
    insertCustomer.run(i, company, contact, email, country, segment, since);
  }
  db.exec('COMMIT');

  // ── products ───────────────────────────────────────────────────────────────
  // Column names match Studio source field IDs
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id           INTEGER PRIMARY KEY,
      product      TEXT NOT NULL,
      category     TEXT NOT NULL,
      price        REAL NOT NULL,
      cost         REAL NOT NULL,
      stock        INTEGER NOT NULL,
      reorderLevel INTEGER NOT NULL
    )
  `);

  const insertProduct = db.prepare(
    'INSERT INTO products(id, product, category, price, cost, stock, reorderLevel) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );

  // Store product categories for denormalization
  const productCategories: string[] = [];

  db.exec('BEGIN');
  for (let i = 1; i <= 100; i++) {
    const category = pick(rng, CATEGORIES);
    productCategories.push(category);
    const price = +(rng() * 500 + 5).toFixed(2);
    const cost = +(price * (0.4 + rng() * 0.3)).toFixed(2);
    const stock = Math.floor(rng() * 500);
    const reorderLevel = Math.floor(rng() * 50) + 10;
    insertProduct.run(i, `Product ${i}`, category, price, cost, stock, reorderLevel);
  }
  db.exec('COMMIT');

  // ── orders ─────────────────────────────────────────────────────────────────
  // Column names match Studio source field IDs; country/segment/category are
  // denormalized for demo-friendly filtering without JOINs
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id         INTEGER PRIMARY KEY,
      customerId INTEGER NOT NULL,
      status     TEXT NOT NULL,
      date       TEXT NOT NULL,
      total      REAL NOT NULL,
      currency   TEXT NOT NULL,
      country    TEXT NOT NULL,
      segment    TEXT NOT NULL,
      category   TEXT NOT NULL
    )
  `);

  const insertOrder = db.prepare(
    'INSERT INTO orders(id, customerId, status, date, total, currency, country, segment, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );

  // ── order_items ────────────────────────────────────────────────────────────
  // Column names match Studio source field IDs
  db.exec(`
    CREATE TABLE IF NOT EXISTS order_items (
      id        INTEGER PRIMARY KEY,
      orderId   INTEGER NOT NULL,
      productId INTEGER NOT NULL,
      product   TEXT NOT NULL,
      category  TEXT NOT NULL,
      quantity  INTEGER NOT NULL,
      unitPrice REAL NOT NULL,
      discount  REAL NOT NULL,
      total     REAL NOT NULL
    )
  `);

  const insertItem = db.prepare(
    'INSERT INTO order_items(id, orderId, productId, product, category, quantity, unitPrice, discount, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
    const currency = pick(rng, ['USD', 'EUR', 'GBP', 'CAD', 'AUD']);

    insertOrder.run(i, customerId, pick(rng, STATUSES), date, total, currency, country, segment, category);

    // 1–3 items per order
    const itemCount = Math.floor(rng() * 3) + 1;
    for (let j = 0; j < itemCount; j++) {
      const iProductId = Math.floor(rng() * 100) + 1;
      const iQty = Math.floor(rng() * 4) + 1;
      const iPrice = +(rng() * 150 + 5).toFixed(2);
      const iDiscount = +(rng() * 0.25).toFixed(2);
      const iTotal = +(iQty * iPrice * (1 - iDiscount)).toFixed(2);
      const iCategory = productCategories[iProductId - 1];
      insertItem.run(itemId++, i, iProductId, `Product ${iProductId}`, iCategory, iQty, iPrice, iDiscount, iTotal);
    }
  }
  db.exec('COMMIT');

  console.log(
    `  ${customerCount} customers, 100 products, ${rowCount} orders, ${itemId - 1} order items`,
  );
}
