import express from 'express';
import cors from 'cors';
import type { Knex } from 'knex';
import type { Config } from './config.js';
import { makeAuthMiddleware } from './middleware/auth.js';
import { makeHealthRouter } from './routes/health.js';
import { makeDataRouter } from './routes/data.js';
import { makeCrmDataRouter } from './routes/crmData.js';
import { makeAIRouter } from './routes/ai.js';
import { makeDevTokenRouter } from './routes/devToken.js';
import { makeMcpRouter } from './routes/mcp.js';

export function buildApp(db: Knex, crmDb: Knex, config: Config): express.Application {
  const app = express();

  app.use(
    cors({
      origin: config.allowedOrigins,
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Studio-Token', 'Mcp-Session-Id'],
    }),
  );

  app.use(express.json({ limit: '2mb' }));

  // Optional static token guard — applied before all API routes
  app.use('/api', makeAuthMiddleware(config));

  // Routes
  app.use('/health', makeHealthRouter(db));
  app.use('/api/studio-data', makeDataRouter(db, config));
  app.use('/api/crm-data', makeCrmDataRouter(crmDb, config));
  app.use('/api/ai', makeAIRouter(config));
  app.use('/api/dev-token', makeDevTokenRouter(config));
  app.use('/api/mcp', makeMcpRouter());

  // Global error handler
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ): void => {
      console.error('[app] Unhandled error:', err);
      const message = err instanceof Error ? err.message : 'Internal server error';
      res.status(500).json({ error: message });
    },
  );

  return app;
}
