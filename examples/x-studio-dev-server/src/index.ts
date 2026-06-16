import './env.js';
import { buildConfig } from './config.js';
import { createKnex } from './db/knex.js';
import { createTables } from './db/schema.js';
import { seedIfEmpty } from './db/seed.js';
import { createCrmTables } from './db/crmSchema.js';
import { seedCrmIfEmpty } from './db/crmSeed.js';
import { buildApp } from './app.js';
import { log, error } from './logger.js';

async function main(): Promise<void> {
  const reseed = process.argv.includes('--reseed');
  const config = buildConfig();
  const salesDb = createKnex(config.salesDb);
  const crmDb = createKnex(config.crmDb);

  log(
    `[startup] Sales DB: ${config.salesDb.client} (${config.salesDb.filename ?? config.salesDb.host})`,
  );
  log(
    `[startup] CRM DB:   ${config.crmDb.client} (${config.crmDb.filename ?? config.crmDb.host})`,
  );

  await createTables(salesDb);
  await createCrmTables(crmDb);

  if (reseed) {
    log('[startup] --reseed flag detected, dropping and re-seeding data…');
    await seedIfEmpty(salesDb, { force: true, orderCount: config.seedOrderCount });
    await seedCrmIfEmpty(crmDb, { force: true, orderCount: config.seedOrderCount });
  } else {
    await seedIfEmpty(salesDb, { orderCount: config.seedOrderCount });
    await seedCrmIfEmpty(crmDb, { orderCount: config.seedOrderCount });
  }

  const app = buildApp(salesDb, crmDb, config);

  app.listen(config.port, () => {
    log(`[startup] x-studio-dev-server listening on http://localhost:${config.port}`);
    log(`[startup]   Health:    http://localhost:${config.port}/health`);
    log(`[startup]   Sales API: http://localhost:${config.port}/api/sales-data`);
    log(`[startup]   CRM API:   http://localhost:${config.port}/api/crm-data`);
    log(`[startup]   AI API:    http://localhost:${config.port}/api/ai/chat`);
    log(`[startup]   MCP API:   http://localhost:${config.port}/api/mcp`);
    if (!config.studioToken) {
      log(`[startup]   Dev token: http://localhost:${config.port}/api/dev-token`);
      log('[startup]   ⚠ Running in open dev mode (no STUDIO_TOKEN set)');
    }
  });
}

main().catch((err) => {
  error('[startup] Fatal error:', err);
  process.exit(1);
});
