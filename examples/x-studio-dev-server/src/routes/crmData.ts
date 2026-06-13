import { Router, type Request, type Response } from 'express';
import type { Knex } from 'knex';
import { handleBatchQuery } from '@mui/x-studio-data-middleware';
import type { Config } from '../config.js';
import { resolveClaims } from '../middleware/claims.js';

const CRM_SCHEMA_ALLOWLIST = ['contacts', 'deals', 'activities'];

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
      console.error('[crm-data] Query error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
