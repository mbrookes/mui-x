import type { Knex } from 'knex';
import { generateExchangeRatesSource, generateSalesData } from 'x-studio-shared/server';
import { TABLE_NAMES, createTables } from './schema.js';
import { log } from '../logger.js';

export interface SeedOptions {
  orderCount?: number;
  /** If true, drop all tables and re-seed even if data exists. */
  force?: boolean;
}

/**
 * Check whether the database already has seeded data.
 * Uses the orders table as a proxy — if it has rows, we consider the DB seeded.
 */
async function isSeeded(db: Knex): Promise<boolean> {
  try {
    const result = await db('orders').count('id as count').first();
    return Number(result?.count ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Check whether the tables match what `generateSalesData()` produces today.
 *
 * A database seeded before the generator grew a field keeps the old columns —
 * `createTables` only creates tables it does not find, so it never adds one —
 * and every insert then fails with `no column named …`. Treat that as unseeded
 * so the tables are rebuilt instead.
 */
async function isSchemaCurrent(db: Knex): Promise<boolean> {
  return (
    (await db.schema.hasColumn('orders', 'rateKey')) &&
    (await db.schema.hasColumn('order_items', 'date')) &&
    (await db.schema.hasTable('exchange_rates'))
  );
}

/**
 * Seed the database with generated sales data.
 *
 * If `force` is false (default), this is a no-op when data already exists and the
 * tables still match the generator. Pass `force: true` (or use the --reseed CLI
 * flag) to drop and re-seed unconditionally.
 */
export async function seedIfEmpty(db: Knex, opts: SeedOptions = {}): Promise<void> {
  const stale = !(await isSchemaCurrent(db));
  const rebuild = opts.force || stale;

  if (!rebuild && (await isSeeded(db))) {
    return;
  }

  if (rebuild) {
    log(stale && !opts.force ? '[seed] Tables are out of date…' : '[seed] Dropping existing data…');
    // Drop tables in reverse dependency order, then recreate them — dropping
    // alone would leave `seed()` inserting into tables that no longer exist.
    for (const table of TABLE_NAMES) {
      await db.schema.dropTableIfExists(table);
    }
    await createTables(db);
  }

  await seed(db, opts);
}

async function seed(db: Knex, opts: SeedOptions): Promise<void> {
  log('[seed] Generating sales data…');
  const data = generateSalesData({ seed: 42, orderCount: opts.orderCount ?? 500 });

  const {
    customersSource,
    productsSource,
    ordersSource,
    orderItemsSource,
    shipmentsSource,
    shipmentItemsSource,
  } = data;

  log(
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
  // Rates are generated, not part of `generateSalesData` — orders join them on `rateKey`.
  await batchInsert(db, 'exchange_rates', generateExchangeRatesSource().rows ?? []);

  log('[seed] Done.');
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
