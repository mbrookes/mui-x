import './env.js';
import { buildConfig } from './config.js';
import { createKnex } from './db/knex.js';
import { createTables } from './db/schema.js';
import { seedIfEmpty } from './db/seed.js';
import { createCrmTables } from './db/crmSchema.js';
import { seedCrmIfEmpty } from './db/crmSeed.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const reseed = process.argv.includes('--reseed');
  const config = buildConfig();
  const db = createKnex(config.db);
  const crmDb = createKnex(config.crmDb);

  console.log(`[startup] Sales DB: ${config.db.client} (${config.db.filename ?? config.db.host})`);
  console.log(
    `[startup] CRM DB:   ${config.crmDb.client} (${config.crmDb.filename ?? config.crmDb.host})`,
  );

  await createTables(db);
  await createCrmTables(crmDb);

  if (reseed) {
    console.log('[startup] --reseed flag detected, dropping and re-seeding data…');
    await seedIfEmpty(db, { force: true, orderCount: config.seedOrderCount });
    await seedCrmIfEmpty(crmDb, { force: true, orderCount: config.seedOrderCount });
  } else {
    await seedIfEmpty(db, { orderCount: config.seedOrderCount });
    await seedCrmIfEmpty(crmDb, { orderCount: config.seedOrderCount });
  }

  const app = buildApp(db, crmDb, config);

  app.listen(config.port, () => {
    console.log(`[startup] x-studio-dev-server listening on http://localhost:${config.port}`);
    console.log(`[startup]   Health:    http://localhost:${config.port}/health`);
    console.log(`[startup]   Sales API: http://localhost:${config.port}/api/studio-data`);
    console.log(`[startup]   CRM API:   http://localhost:${config.port}/api/crm-data`);
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
