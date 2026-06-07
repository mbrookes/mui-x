import { Router, type Request, type Response } from 'express';
import jwt from 'jsonwebtoken';
import type { Config } from '../config.js';

/**
 * GET /api/dev-token
 *
 * Returns a signed JWT for development use. This token grants full access
 * to all data tables (no tenant/region restrictions).
 *
 * Only available when STUDIO_TOKEN is NOT set (i.e., open dev mode).
 */
export function makeDevTokenRouter(config: Config): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response): void => {
    if (config.studioToken) {
      res.status(404).json({ error: 'Dev token endpoint is disabled when STUDIO_TOKEN is set' });
      return;
    }

    const token = jwt.sign(
      {
        sub: 'dev-user',
        tenantId: 'dev',
        userId: 'dev-user',
        roleIds: ['admin'],
      },
      config.jwtSecret,
      { expiresIn: '365d' },
    );

    res.json({ token, expiresIn: '365d' });
  });

  return router;
}
