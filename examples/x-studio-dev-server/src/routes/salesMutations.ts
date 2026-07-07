import { Router, type Request, type Response } from 'express';
import type { Knex } from 'knex';
import { handleMutation } from '@mui/x-studio-data-middleware';
import type { Config } from '../config.js';
import { resolveClaims } from '../middleware/claims.js';
import { error } from '../logger.js';

const SALES_SCHEMA_ALLOWLIST = [
  'customers',
  'products',
  'orders',
  'order_items',
  'shipments',
  'shipment_items',
];

/**
 * POST /api/sales-mutations
 *
 * Accepts a batch of write-back mutations (INSERT/UPDATE/DELETE) from a Studio
 * client and applies them to the sales database via `handleMutation`.
 *
 * Grid widgets call this automatically from `processRowUpdate` when the widget's
 * `config.gridPkField` is set and the adapter was created with a
 * `mutationEndpoint` pointing here.
 *
 * Like the read path, this route is permissive-by-default: no `writableColumns`
 * restriction is applied, so every column in the allowlisted tables is writable.
 * This is a demo server — production deployments should scope `writableColumns`.
 *
 * In dev mode (no STUDIO_TOKEN set) we fall back to permissive dev claims
 * when no Authorization header is present. In production, the client must
 * supply a signed JWT.
 */
export function makeSalesMutationsRouter(salesDb: Knex, config: Config): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response): Promise<void> => {
    try {
      const claims = resolveClaims(req, config);
      const result = await handleMutation(req.body, claims, {
        db: salesDb,
        schemaAllowlist: SALES_SCHEMA_ALLOWLIST,
        // Dev server is single-tenant — no tenant discriminator column.
        tenancy: { mode: 'single-tenant' },
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
      error('[sales-mutations] Mutation error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
