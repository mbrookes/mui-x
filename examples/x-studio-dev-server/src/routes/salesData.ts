import { Router, type Request, type Response } from 'express';
import type { Knex } from 'knex';
import { handleBatchQuery } from '@mui/x-studio-data-middleware';
import type { Config } from '../config.js';
import { resolveClaims } from '../middleware/claims.js';

const SALES_SCHEMA_ALLOWLIST = [
  'customers',
  'products',
  'orders',
  'order_items',
  'shipments',
  'shipment_items',
];

/**
 * POST /api/sales-data
 *
 * Accepts a batch query request from a Studio client and returns the results.
 *
 * In dev mode (no STUDIO_TOKEN set) we fall back to permissive dev claims
 * when no Authorization header is present. In production, the client must
 * supply a signed JWT.
 */
export function makeSalesDataRouter(salesDb: Knex, config: Config): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response): Promise<void> => {
    try {
      const claims = resolveClaims(req, config);
      const result = await handleBatchQuery(req.body, claims, {
        db: salesDb,
        schemaAllowlist: SALES_SCHEMA_ALLOWLIST,
      });
      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('Missing Authorization') || message.includes('Invalid token')) {
        res.status(401).json({ error: message });
        return;
      }
      if (message.includes('not allowed') || message.includes('allowlist')) {
        res.status(403).json({ error: message });
        return;
      }
      console.error('[sales-data] Query error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
