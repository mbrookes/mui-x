import type { Knex } from 'knex';

/**
 * Create all CRM tables for the Studio CRM demo dataset.
 *
 * Column names match the camelCase field names produced by generateCrmData()
 * so rows can be inserted directly without any name transformation.
 *
 * Uses hasTable + createTable — safe to call on every startup.
 */
export async function createCrmTables(db: Knex): Promise<void> {
  if (!(await db.schema.hasTable('contacts'))) {
    await db.schema.createTable('contacts', (t) => {
      t.string('id').primary();
      t.string('customerId').notNullable();
      t.string('firstName').notNullable();
      t.string('lastName').notNullable();
      t.string('email').notNullable();
      t.string('phone').notNullable();
      t.string('role').notNullable();
      t.string('department').notNullable();
    });
  }

  if (!(await db.schema.hasTable('deals'))) {
    await db.schema.createTable('deals', (t) => {
      t.string('id').primary();
      t.string('customerId').notNullable();
      t.string('primaryContactId').nullable();
      t.string('title').notNullable();
      t.string('stage').notNullable();
      t.float('value').notNullable();
      t.integer('probability').notNullable();
      t.string('openedDate').notNullable();
      t.string('closeDate').notNullable();
    });
  }

  if (!(await db.schema.hasTable('activities'))) {
    await db.schema.createTable('activities', (t) => {
      t.string('id').primary();
      t.string('contactId').notNullable();
      t.string('dealId').nullable();
      t.string('type').notNullable();
      t.string('date').notNullable();
      t.string('outcome').notNullable();
      t.integer('durationMin').notNullable();
    });
  }

  // Indexes for common query patterns
  const indexes: [string, string][] = [
    [
      'contacts_customerid_idx',
      'CREATE INDEX IF NOT EXISTS contacts_customerid_idx ON contacts (customerId)',
    ],
    ['contacts_dept_idx', 'CREATE INDEX IF NOT EXISTS contacts_dept_idx ON contacts (department)'],
    [
      'deals_customerid_idx',
      'CREATE INDEX IF NOT EXISTS deals_customerid_idx ON deals (customerId)',
    ],
    ['deals_stage_idx', 'CREATE INDEX IF NOT EXISTS deals_stage_idx ON deals (stage)'],
    [
      'activities_contactid_idx',
      'CREATE INDEX IF NOT EXISTS activities_contactid_idx ON activities (contactId)',
    ],
    [
      'activities_dealid_idx',
      'CREATE INDEX IF NOT EXISTS activities_dealid_idx ON activities (dealId)',
    ],
  ];

  for (const [, sql] of indexes) {
    await db.raw(sql);
  }
}

/** Table names in dependency order (used for drops during reseed). */
export const CRM_TABLE_NAMES = ['activities', 'deals', 'contacts'] as const;

export type CrmTableName = (typeof CRM_TABLE_NAMES)[number];
