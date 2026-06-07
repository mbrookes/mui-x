import type { Request, Response, NextFunction } from 'express';
import type { Config } from '../config.js';

/**
 * Optional bearer-token auth middleware.
 *
 * When `config.studioToken` is set, every request must include an
 * `Authorization: Bearer <token>` header matching that value.
 *
 * This is a lightweight development guard — not a production auth system.
 */
export function makeAuthMiddleware(config: Config) {
  return function authMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (!config.studioToken) {
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing Authorization header' });
      return;
    }

    const token = authHeader.slice('Bearer '.length);
    if (token !== config.studioToken) {
      res.status(403).json({ error: 'Invalid token' });
      return;
    }

    next();
  };
}
