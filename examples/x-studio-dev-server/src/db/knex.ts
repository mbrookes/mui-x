import knexLib, { type Knex } from 'knex';
import { createRequire } from 'module';
import type { DbConfig } from '../config.js';

const require = createRequire(import.meta.url);

export function createKnex(config: DbConfig): Knex {
  const { client } = config;

  if (client === 'better-sqlite3') {
    // Verify the native module is available before Knex tries to load it.
    // better-sqlite3 requires a compiled .node binary — on some systems (e.g.
    // macOS without Xcode Command Line Tools) it may fail to build.
    try {
      require('better-sqlite3');
    } catch {
      throw new Error(
        'MUI X Dev Server: better-sqlite3 native module is not available.\n' +
        'To fix this, install Xcode Command Line Tools and reinstall:\n' +
        '  xcode-select --install\n' +
        '  pnpm install\n\n' +
        'Alternatively, use PostgreSQL or MySQL by setting DB_CLIENT in .env.local.',
      );
    }

    return knexLib({
      client: 'better-sqlite3',
      connection: {
        filename: config.filename ?? './studio.db',
      },
      useNullAsDefault: true,
    });
  }

  return knexLib({
    client,
    connection: {
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
    },
    pool: { min: 2, max: 10 },
  });
}
