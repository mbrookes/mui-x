import { Router, type Request, type Response } from 'express';
import type { Knex } from 'knex';
import { TABLE_NAMES } from '../db/schema.js';

export function makeHealthRouter(salesDb: Knex): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response) => {
    try {
      const rowCounts: Record<string, number> = {};

      // Iterate the schema's own list so a table added to the demo dataset shows up
      // here without a second list to keep in step.
      for (const table of TABLE_NAMES) {
        try {
          const result = await salesDb(table).count('* as count').first();
          rowCounts[table] = Number(result?.count ?? 0);
        } catch {
          rowCounts[table] = -1;
        }
      }

      const seeded = rowCounts.orders > 0;

      res.json({
        status: 'ok',
        db: 'connected',
        seeded,
        rowCounts,
      });
    } catch (err) {
      res.status(503).json({
        status: 'error',
        db: 'disconnected',
        error: String(err),
      });
    }
  });

  return router;
}
