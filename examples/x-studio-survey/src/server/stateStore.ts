/**
 * Durable dashboard-state store for the survey app.
 *
 * The survey *data* lives in an in-memory SQLite DB (re-seeded from Excel on every
 * boot), but the dashboard *state* — the user/AI-authored config plus undo/redo
 * history — must survive restarts, so it gets its own file-backed SQLite database.
 *
 * A single document (`DOC_ID`) holds the serialized session as a JSON blob; the survey
 * app is a single dashboard, so there is no per-user keying.
 */
import knex from 'knex';
import path from 'node:path';

const STATE_DB_PATH = process.env.STATE_DB_PATH ?? path.join(process.cwd(), '.studio-state.db');

/** Fixed id for the single survey dashboard document. */
const DOC_ID = 'survey';

export interface StateStore {
  /** Returns the saved session document, or `null` when nothing has been stored yet. */
  load(): Promise<unknown | null>;
  /** Upserts the session document. */
  save(doc: unknown): Promise<void>;
}

export async function createStateStore(): Promise<StateStore> {
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: STATE_DB_PATH },
    useNullAsDefault: true,
  });

  if (!(await db.schema.hasTable('dashboard_state'))) {
    await db.schema.createTable('dashboard_state', (table) => {
      table.text('id').primary();
      table.text('doc').notNullable();
      table.text('updated_at').notNullable();
    });
  }

  return {
    async load() {
      const row = (await db('dashboard_state').where({ id: DOC_ID }).first()) as
        | { doc?: string }
        | undefined;
      if (!row?.doc) {
        return null;
      }
      try {
        return JSON.parse(row.doc);
      } catch {
        return null;
      }
    },

    async save(doc) {
      await db('dashboard_state')
        .insert({
          id: DOC_ID,
          doc: JSON.stringify(doc),
          updated_at: new Date().toISOString(),
        })
        .onConflict('id')
        .merge();
    },
  };
}

export { STATE_DB_PATH };
