import { Router, type Request, type Response } from 'express';
import type { Knex } from 'knex';
import { handleBatchQuery } from '@mui/x-studio-data-middleware';
import type { JwtSecurityClaims } from '@mui/x-studio-data-middleware';
import jwt from 'jsonwebtoken';
import type { Config } from '../config.js';

const SCHEMA_ALLOWLIST = [
  'customers',
  'products',
  'orders',
  'order_items',
  'shipments',
  'shipment_items',
];

/** Dev claims used when no JWT is provided and no STUDIO_TOKEN guard is active. */
const DEV_CLAIMS: JwtSecurityClaims = {
  tenantId: 'dev',
  userId: 'dev-user',
  roleIds: ['admin'],
};

/**
 * POST /api/studio-data
 *
 * Accepts a batch query request from a Studio client and returns the results.
 *
 * In dev mode (no STUDIO_TOKEN set) we fall back to permissive dev claims
 * when no Authorization header is present. In production, the client must
 * supply a signed JWT.
 */
export function makeDataRouter(db: Knex, config: Config): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response): Promise<void> => {
    try {
      const claims = resolveClaims(req, config);
      const result = await handleBatchQuery(req.body, claims, {
        db,
        schemaAllowlist: SCHEMA_ALLOWLIST,
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
      console.error('[data] Query error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

function resolveClaims(req: Request, config: Config): JwtSecurityClaims {
  const authHeader = req.headers.authorization;

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice('Bearer '.length);
    try {
      const decoded = jwt.verify(token, config.jwtSecret) as JwtSecurityClaims;
      return decoded;
    } catch (err) {
      throw new Error(`Invalid token: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // In dev mode (no static token guard), fall back to permissive dev claims
  if (!config.studioToken) {
    return DEV_CLAIMS;
  }

  throw new Error('Missing Authorization header');
}
