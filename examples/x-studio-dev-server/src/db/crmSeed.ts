import type { Knex } from 'knex';
import { generateCrmData } from 'x-studio-shared';
import { CRM_TABLE_NAMES } from './crmSchema.js';

export interface CrmSeedOptions {
  orderCount?: number;
  /** If true, drop all CRM tables and re-seed even if data exists. */
  force?: boolean;
}

/**
 * Check whether the CRM database already has seeded data.
 * Uses the contacts table as a proxy.
 */
async function isCrmSeeded(db: Knex): Promise<boolean> {
  try {
    const result = await db('contacts').count('id as count').first();
    return Number(result?.count ?? 0) > 0;
  } catch {
    return false;
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

  if (opts.force) {
    console.log('[crm-seed] Dropping existing CRM data…');
    for (const table of CRM_TABLE_NAMES) {
      await db.schema.dropTableIfExists(table);
    }
  }

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
