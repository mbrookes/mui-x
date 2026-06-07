import 'dotenv/config';
import { buildConfig } from './config.js';
import { createKnex } from './db/knex.js';
import { createTables } from './db/schema.js';
import { seedIfEmpty } from './db/seed.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const reseed = process.argv.includes('--reseed');
  const config = buildConfig();
  const db = createKnex(config.db);

  console.log(`[startup] Database: ${config.db.client} (${config.db.filename ?? config.db.host})`);

  await createTables(db);

  if (reseed) {
    console.log('[startup] --reseed flag detected, dropping and re-seeding data…');
    await seedIfEmpty(db, { force: true, orderCount: config.seedOrderCount });
  } else {
    await seedIfEmpty(db, { orderCount: config.seedOrderCount });
  }

  const app = buildApp(db, config);

  app.listen(config.port, () => {
    console.log(`[startup] x-studio-dev-server listening on http://localhost:${config.port}`);
    console.log(`[startup]   Health:    http://localhost:${config.port}/health`);
    console.log(`[startup]   Data API:  http://localhost:${config.port}/api/studio-data`);
    console.log(`[startup]   AI API:    http://localhost:${config.port}/api/ai/chat`);
    if (!config.studioToken) {
      console.log(`[startup]   Dev token: http://localhost:${config.port}/api/dev-token`);
      console.log('[startup]   ⚠ Running in open dev mode (no STUDIO_TOKEN set)');
    }
  });
}

main().catch((err) => {
  console.error('[startup] Fatal error:', err);
  process.exit(1);
});
