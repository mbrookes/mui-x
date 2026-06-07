import type { Knex } from 'knex';
import { generateSalesData } from 'x-studio-shared';
import { TABLE_NAMES } from './schema.js';

export interface SeedOptions {
  orderCount?: number;
  /** If true, drop all tables and re-seed even if data exists. */
  force?: boolean;
}

/**
 * Check whether the database already has seeded data.
 * Uses the orders table as a proxy — if it has rows, we consider the DB seeded.
 */
export async function isSeeded(db: Knex): Promise<boolean> {
  try {
    const result = await db('orders').count('id as count').first();
    return Number(result?.count ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Seed the database with generated sales data.
 *
 * If `force` is false (default), this is a no-op when data already exists.
 * Pass `force: true` (or use the --reseed CLI flag) to drop and re-seed.
 */
export async function seedIfEmpty(db: Knex, opts: SeedOptions = {}): Promise<void> {
  if (!opts.force && (await isSeeded(db))) {
    return;
  }

  if (opts.force) {
    console.log('[seed] Dropping existing data…');
    // Drop tables in reverse dependency order
    for (const table of TABLE_NAMES) {
      await db.schema.dropTableIfExists(table);
    }
  }

  await seed(db, opts);
}

async function seed(db: Knex, opts: SeedOptions): Promise<void> {
  console.log('[seed] Generating sales data…');
  const data = generateSalesData({ seed: 42, orderCount: opts.orderCount ?? 500 });

  const {
    customersSource,
    productsSource,
    ordersSource,
    orderItemsSource,
    shipmentsSource,
    shipmentItemsSource,
  } = data;

  console.log(
    `[seed] Inserting ${customersSource.rows?.length ?? 0} customers, ` +
    `${productsSource.rows?.length ?? 0} products, ` +
    `${ordersSource.rows?.length ?? 0} orders, ` +
    `${orderItemsSource.rows?.length ?? 0} order_items, ` +
    `${shipmentsSource.rows?.length ?? 0} shipments, ` +
    `${shipmentItemsSource.rows?.length ?? 0} shipment_items…`,
  );

  // Insert in dependency order (FK integrity for databases that enforce it)
  await batchInsert(db, 'customers', customersSource.rows ?? []);
  await batchInsert(db, 'products', productsSource.rows ?? []);
  await batchInsert(db, 'orders', ordersSource.rows ?? []);
  await batchInsert(db, 'order_items', orderItemsSource.rows ?? []);
  await batchInsert(db, 'shipments', shipmentsSource.rows ?? []);
  await batchInsert(db, 'shipment_items', shipmentItemsSource.rows ?? []);

  console.log('[seed] Done.');
}

async function batchInsert(
  db: Knex,
  table: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  // SQLite has a max of ~999 bound parameters per statement.
  // Use chunk size of 200 rows to stay well within that limit for any row width.
  await db.batchInsert(table, rows, 200);
}
