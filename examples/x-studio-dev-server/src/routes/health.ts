import { Router, type Request, type Response } from 'express';
import type { Knex } from 'knex';
import type { TABLE_NAMES } from '../db/schema.js';

export function makeHealthRouter(db: Knex): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response) => {
    try {
      const rowCounts: Record<string, number> = {};

      for (const table of ['customers', 'products', 'orders', 'order_items', 'shipments', 'shipment_items'] as unknown as Array<(typeof TABLE_NAMES)[number]>) {
        try {
          const result = await db(table).count('* as count').first();
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
