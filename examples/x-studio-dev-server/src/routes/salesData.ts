import { Router, type Request, type Response } from 'express';
import type { Knex } from 'knex';
import { handleBatchQuery } from '@mui/x-studio-data-middleware';
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
      // Relay the middleware's OWN request-shape errors instead of flattening them to a
      // bare 500. `handleBatchQuery` isolates per-widget failures as `{ error }` results,
      // so anything that THROWS is a whole-request problem (too many widgets, an
      // over-long identifier, an oversized `in`-list) whose message names the exact limit
      // and how to stay under it. The package deems its own `MUI X`-prefixed messages
      // safe to disclose — `sanitizeBoundaryError` already returns them verbatim to any
      // authenticated caller — and discarding them here leaves the operator with only
      // `Studio batch request failed: 500 Internal Server Error` on every widget of the
      // page. 400, because the request itself is what has to change.
      if (message.startsWith('MUI X')) {
        error('[sales-data] Invalid batch request:', err);
        res.status(400).json({ error: message });
        return;
      }
      error('[sales-data] Query error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
