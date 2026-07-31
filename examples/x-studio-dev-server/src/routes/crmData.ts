import { Router, type Request, type Response } from 'express';
import type { Knex } from 'knex';
import { handleBatchQuery } from '@mui/x-studio-data-middleware';
import type { Config } from '../config.js';
import { resolveClaims } from '../middleware/claims.js';
import { error } from '../logger.js';

const CRM_SCHEMA_ALLOWLIST = ['contacts', 'deals', 'activities', 'deal_stage_transitions'];

/**
 * POST /api/crm-data
 *
 * Handles batch queries against the CRM database (contacts, deals, activities).
 * Mirrors the shape of makeSalesDataRouter but targets a separate Knex instance and
 * a different schema allowlist, demonstrating the multiple-endpoints pattern.
 */
export function makeCrmDataRouter(crmDb: Knex, config: Config): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response): Promise<void> => {
    try {
      const claims = resolveClaims(req, config);
      const result = await handleBatchQuery(req.body, claims, {
        db: crmDb,
        schemaAllowlist: CRM_SCHEMA_ALLOWLIST,
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
      // Relay the middleware's own request-shape errors rather than flattening them to a
      // bare 500 — see the same branch in `salesData.ts` for why.
      if (message.startsWith('MUI X')) {
        error('[crm-data] Invalid batch request:', err);
        res.status(400).json({ error: message });
        return;
      }
      error('[crm-data] Query error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
