import express from 'express';
import cors from 'cors';
import type { Knex } from 'knex';
import type { Config } from './config.js';
import { makeAuthMiddleware } from './middleware/auth.js';
import { makeHealthRouter } from './routes/health.js';
import { makeSalesDataRouter } from './routes/salesData.js';
import { makeCrmDataRouter } from './routes/crmData.js';
import { makeAIRouter } from './routes/ai.js';
import { makeDevTokenRouter } from './routes/devToken.js';
import { makeMcpRouter } from './routes/mcp.js';
import { error } from './logger.js';

export function buildApp(salesDb: Knex, crmDb: Knex, config: Config): express.Application {
  const app = express();

  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (server-to-server, curl)
        if (!origin) {
          callback(null, true);
          return;
        }
        // Allow any localhost port — dev tools (MCP Inspector, Cursor, Claude Desktop)
        // use a variety of ports and it is not practical to enumerate them all.
        if (/^http:\/\/localhost(:\d+)?$/.test(origin) || /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) {
          callback(null, true);
          return;
        }
        callback(null, config.allowedOrigins.includes(origin));
      },
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Studio-Token', 'Mcp-Session-Id'],
    }),
  );

  app.use(express.json({ limit: '2mb' }));

  // Optional static token guard — applied before all API routes
  app.use('/api', makeAuthMiddleware(config));

  // Routes
  app.use('/health', makeHealthRouter(salesDb));
  app.use('/api/sales-data', makeSalesDataRouter(salesDb, config));
  app.use('/api/crm-data', makeCrmDataRouter(crmDb, config));
  app.use('/api/ai', makeAIRouter(salesDb, crmDb, config));
  app.use('/api/dev-token', makeDevTokenRouter(config));
  app.use('/api/mcp', makeMcpRouter(salesDb, crmDb, config));

  // Global error handler
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ): void => {
      error('[app] Unhandled error:', err);
      const message = err instanceof Error ? err.message : 'Internal server error';
      res.status(500).json({ error: message });
    },
  );

  return app;
}
