/**
 * Extract and verify JWT security claims from an Authorization header.
 *
 * IMPORTANT: This is a demonstration implementation. In production, replace
 * the HMAC-SHA256 verification with your IdP's JWT verification library
 * (e.g., `jose`, `jsonwebtoken`, or a managed service SDK).
 *
 * The function is pure (no HTTP/Express dependencies) and works in any
 * Node.js framework or serverless environment.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { JwtSecurityClaims } from './types';

/** JWT payload shape expected by x-studio-server */
interface JwtPayload {
  sub: string;
  tenantId: string;
  roleIds?: string[];
  regionIds?: number[];
  department?: string;
  exp?: number;
}

/**
 * Parse and verify a JWT from an HTTP Authorization header.
 *
 * @param authorizationHeader - The raw `Authorization` header value
 *   (e.g., `"Bearer eyJhbGci..."`)
 * @param jwtSecret - HMAC secret for HS256 verification.
 *   Defaults to `process.env.JWT_SECRET`. **Never hardcode this.**
 * @throws {Error} If the header is missing, malformed, expired, or has an
 *   invalid signature.
 */
export function extractSecurityClaims(
  authorizationHeader: string | undefined,
  jwtSecret: string = process.env.JWT_SECRET ?? '',
): JwtSecurityClaims {
  if (!authorizationHeader) {
    throw new Error('MUI X Studio Server: Missing Authorization header');
  }

  const [scheme, token] = authorizationHeader.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    throw new Error('MUI X Studio Server: Authorization header must be "Bearer <token>"');
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('MUI X Studio Server: Malformed JWT — expected 3 parts');
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  // Verify signature (HS256)
  const signingInput = `${headerB64}.${payloadB64}`;
  const expectedSig = createHmac('sha256', jwtSecret).update(signingInput).digest('base64url');

  if (!timingSafeEqual(Buffer.from(expectedSig), Buffer.from(signatureB64))) {
    throw new Error('MUI X Studio Server: JWT signature verification failed');
  }

  // Decode payload
  let payload: JwtPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as JwtPayload;
  } catch {
    throw new Error('MUI X Studio Server: Failed to decode JWT payload');
  }

  // Check expiry
  if (payload.exp !== undefined && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('MUI X Studio Server: JWT has expired');
  }

  if (!payload.tenantId || !payload.sub) {
    throw new Error('MUI X Studio Server: JWT payload must include "tenantId" and "sub" claims');
  }

  return {
    tenantId: payload.tenantId,
    userId: payload.sub,
    roleIds: payload.roleIds ?? [],
    regionIds: payload.regionIds,
    department: payload.department,
  };
}
