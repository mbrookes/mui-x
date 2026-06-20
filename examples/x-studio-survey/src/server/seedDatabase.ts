/**
 * Seed an in-memory better-sqlite3 database (via Knex) with demo sales data for the
 * x-studio example server. The schema mirrors the StudioDataSource
 * field IDs so Studio's query descriptors map directly to SQL columns.
 *
 * NOTE: In a real app you'd connect to an existing database instead.
 */
import type { Knex } from 'knex';

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

export async function seedDatabase(db: Knex, rowCount = 2000): Promise<void> {
  const rng = mulberry32(42);
  const now = Date.now();
  const TWO_YEARS = 2 * 365 * 24 * 3600 * 1000;

  // ── customers ──────────────────────────────────────────────────────────────
  // Column names match Studio source field IDs so descriptors map directly to SQL
  if (!(await db.schema.hasTable('customers'))) {
    await db.schema.createTable('customers', (t) => {
      t.integer('id').primary();
      t.string('company').notNullable();
      t.string('contact').notNullable();
      t.string('email').notNullable();
      t.string('country').notNullable();
      t.string('segment').notNullable();
      t.string('since').notNullable();
    });
  }

  const SEGMENTS = ['Consumer', 'Corporate', 'Home Office'];
  const customerCount = Math.min(rowCount, 500);
  const FIRST_NAMES = ['Alex', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Drew', 'Avery'];
  const LAST_NAMES = ['Smith', 'Jones', 'Brown', 'Davis', 'Miller', 'Wilson', 'Moore', 'Taylor'];

  // Store customer data for denormalization
  const customerCountries: string[] = [];
  const customerSegments: string[] = [];

  const customerRows = [];
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
    customerRows.push({ id: i, company, contact, email, country, segment, since: `${year}-${month}-${day}` });
  }
  await db.batchInsert('customers', customerRows, 100);

  // ── products ───────────────────────────────────────────────────────────────
  // Column names match Studio source field IDs
  if (!(await db.schema.hasTable('products'))) {
    await db.schema.createTable('products', (t) => {
      t.integer('id').primary();
      t.string('product').notNullable();
      t.string('category').notNullable();
      t.float('price').notNullable();
      t.float('cost').notNullable();
      t.integer('stock').notNullable();
      t.integer('reorderLevel').notNullable();
    });
  }

  const productCategories: string[] = [];
  const productRows = [];
  for (let i = 1; i <= 100; i++) {
    const category = pick(rng, CATEGORIES);
    productCategories.push(category);
    const price = +(rng() * 500 + 5).toFixed(2);
    const cost = +(price * (0.4 + rng() * 0.3)).toFixed(2);
    const stock = Math.floor(rng() * 500);
    const reorderLevel = Math.floor(rng() * 50) + 10;
    productRows.push({ id: i, product: `Product ${i}`, category, price, cost, stock, reorderLevel });
  }
  await db.batchInsert('products', productRows, 100);

  // ── orders ─────────────────────────────────────────────────────────────────
  // Column names match Studio source field IDs; country/segment/category are
  // denormalized for demo-friendly filtering without JOINs
  if (!(await db.schema.hasTable('orders'))) {
    await db.schema.createTable('orders', (t) => {
      t.integer('id').primary();
      t.integer('customerId').notNullable();
      t.string('status').notNullable();
      t.string('date').notNullable();
      t.float('total').notNullable();
      t.string('currency').notNullable();
      t.string('country').notNullable();
      t.string('segment').notNullable();
      t.string('category').notNullable();
    });
  }

  // ── order_items ────────────────────────────────────────────────────────────
  // Column names match Studio source field IDs
  if (!(await db.schema.hasTable('order_items'))) {
    await db.schema.createTable('order_items', (t) => {
      t.integer('id').primary();
      t.integer('orderId').notNullable();
      t.integer('productId').notNullable();
      t.string('product').notNullable();
      t.string('category').notNullable();
      t.integer('quantity').notNullable();
      t.float('unitPrice').notNullable();
      t.float('discount').notNullable();
      t.float('total').notNullable();
    });
  }

  const orderRows = [];
  const itemRows = [];
  let itemId = 1;
  for (let i = 1; i <= rowCount; i++) {
    const customerId = Math.floor(rng() * customerCount) + 1;
    const date = isoDate(now - Math.floor(rng() * TWO_YEARS));
    const qty = Math.floor(rng() * 5) + 1;
    const price = +(rng() * 200 + 10).toFixed(2);
    const discount = +(rng() * 0.3).toFixed(2);
    const total = +(qty * price * (1 - discount)).toFixed(2);
    const productId = Math.floor(rng() * 100) + 1;
    const country = customerCountries[customerId - 1];
    const segment = customerSegments[customerId - 1];
    const category = productCategories[productId - 1];
    const currency = pick(rng, ['USD', 'EUR', 'GBP', 'CAD', 'AUD']);

    orderRows.push({ id: i, customerId, status: pick(rng, STATUSES), date, total, currency, country, segment, category });

    const itemCount = Math.floor(rng() * 3) + 1;
    for (let j = 0; j < itemCount; j++) {
      const iProductId = Math.floor(rng() * 100) + 1;
      const iQty = Math.floor(rng() * 4) + 1;
      const iPrice = +(rng() * 150 + 5).toFixed(2);
      const iDiscount = +(rng() * 0.25).toFixed(2);
      const iTotal = +(iQty * iPrice * (1 - iDiscount)).toFixed(2);
      const iCategory = productCategories[iProductId - 1];
      itemRows.push({ id: itemId++, orderId: i, productId: iProductId, product: `Product ${iProductId}`, category: iCategory, quantity: iQty, unitPrice: iPrice, discount: iDiscount, total: iTotal });
    }
  }
  await db.batchInsert('orders', orderRows, 200);
  await db.batchInsert('order_items', itemRows, 200);

  console.log(
    `  ${customerCount} customers, 100 products, ${rowCount} orders, ${itemId - 1} order items`,
  );
}
