/**
 * Shared JWT claims resolver for data routes and the MCP route.
 *
 * In dev mode (no `STUDIO_TOKEN` guard active) and when no `Authorization`
 * header is present, `resolveClaims` falls back to permissive `DEV_CLAIMS`.
 * This mirrors the behaviour of the HTTP data endpoints.
 */

import type { Request } from 'express';
import jwt from 'jsonwebtoken';
import type { JwtSecurityClaims } from '@mui/x-studio-data-middleware';
import type { Config } from '../config.js';

export { type JwtSecurityClaims };

/** Permissive claims used in dev mode (no JWT required). */
export const DEV_CLAIMS: JwtSecurityClaims = {
  tenantId: 'dev',
  userId: 'dev-user',
  roleIds: ['admin'],
};

/**
 * Resolve security claims from an Express request.
 *
 * - `Authorization: Bearer <jwt>` → verify against `config.jwtSecret`
 * - No header + `config.studioToken` unset → return `DEV_CLAIMS`
 * - No header + `config.studioToken` set → throw (caller should return 401)
 */
export function resolveClaims(req: Request, config: Config): JwtSecurityClaims {
  const authHeader = req.headers.authorization;

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice('Bearer '.length);
    try {
      return jwt.verify(token, config.jwtSecret) as JwtSecurityClaims;
    } catch (err) {
      throw new Error(`Invalid token: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!config.studioToken) {
    return DEV_CLAIMS;
  }

  throw new Error('Missing Authorization header');
}
