import type { Knex } from 'knex';
import { generateCrmData } from 'x-studio-shared';
import { CRM_TABLE_NAMES, createCrmTables } from './crmSchema.js';

export interface CrmSeedOptions {
  orderCount?: number;
  /** If true, drop all CRM tables and re-seed even if data exists. */
  force?: boolean;
}

/**
 * Check whether the CRM database already has complete seeded data.
 * Returns false when:
 * - The contacts table is empty (never seeded), OR
 * - The deals table has daysInStage column but no values (schema updated after initial
 *   seed — server must reseed to populate the new column).
 */
async function isCrmSeeded(db: Knex): Promise<boolean> {
  try {
    const contactCount = await db('contacts').count('id as count').first();
    if (Number(contactCount?.count ?? 0) === 0) {
      return false;
    }
    // If daysInStage column exists but has no data, the deals were seeded before the
    // column was added — return false so seedCrmIfEmpty triggers a full reseed.
    const hasColumn = await db.schema.hasColumn('deals', 'daysInStage');
    if (hasColumn) {
      const dealWithData = await db('deals').whereNotNull('daysInStage').first();
      if (!dealWithData) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Drop all CRM tables so they can be recreated and reseeded from scratch.
 */
async function dropCrmTables(db: Knex): Promise<void> {
  for (const table of CRM_TABLE_NAMES) {
    await db.schema.dropTableIfExists(table);
  }
}

/**
 * Seed the CRM database with generated data.
 *
 * If `force` is false (default), this is a no-op when data already exists.
 * Pass `force: true` (or use the --reseed CLI flag) to drop and re-seed.
 */
export async function seedCrmIfEmpty(db: Knex, opts: CrmSeedOptions = {}): Promise<void> {
  if (!opts.force && (await isCrmSeeded(db))) {
    return;
  }

  // Drop existing tables before reseeding (either forced or stale-data auto-reseed).
  // Dropping is safe here: either force=true requested it, or isCrmSeeded detected
  // that the data is incomplete (e.g. daysInStage column was empty after a schema
  // migration), so we need a clean slate. Recreate tables immediately after dropping
  // so the INSERT in seedCrm finds the updated schema.
  console.log('[crm-seed] Dropping existing CRM data…');
  await dropCrmTables(db);
  await createCrmTables(db);

  await seedCrm(db, opts);
}

async function seedCrm(db: Knex, opts: CrmSeedOptions): Promise<void> {
  console.log('[crm-seed] Generating CRM data…');
  const data = generateCrmData({ seed: 42, orderCount: opts.orderCount ?? 500 });

  const { contactsSource, dealsSource, activitiesSource } = data;

  console.log(
    `[crm-seed] Inserting ${contactsSource.rows?.length ?? 0} contacts, ` +
      `${dealsSource.rows?.length ?? 0} deals, ` +
      `${activitiesSource.rows?.length ?? 0} activities…`,
  );

  await batchInsert(db, 'contacts', contactsSource.rows ?? []);
  await batchInsert(db, 'deals', dealsSource.rows ?? []);
  await batchInsert(db, 'activities', activitiesSource.rows ?? []);

  console.log('[crm-seed] Done.');
}

async function batchInsert(
  db: Knex,
  table: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  await db.batchInsert(table, rows, 200);
}
