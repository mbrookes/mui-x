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

/** JWT payload shape expected by x-studio-data-middleware */
interface JwtPayload {
  sub: string;
  tenantId: string;
  roleIds?: string[];
  // `unknown` (not `number[]`) — the payload is parsed JSON from a
  // client-controlled bearer token, so the TS shape is not a runtime
  // guarantee. `normalizeRegionIds` below is the runtime boundary that
  // actually enforces `number[]` (finding 3.1).
  regionIds?: unknown;
  department?: string;
  exp?: number;
}

/**
 * Validate + coerce the JWT's `regionIds` claim to `number[]` (finding 3.1).
 *
 * `regionIds` is typed `number[]` on `JwtSecurityClaims`, but the payload is
 * client-supplied JSON — nothing guarantees the token issuer actually emitted
 * numbers. Left unvalidated, a malformed claim (a non-array, or an array of
 * strings/objects) would flow into `generateCacheKey`'s `computeSecurityHash`,
 * which sorts region ids with `(a, b) => a - b` — a no-op (or `NaN`-producing)
 * comparator on strings, so two callers with the SAME regions in a different
 * order would get DIFFERENT cache keys (harmless fragmentation, not a scope
 * leak — the row-level-security predicate and mutation value-validator already
 * string-normalize region comparisons). Fail closed here instead of letting a
 * malformed claim silently degrade cache efficiency deeper in the pipeline.
 */
function normalizeRegionIds(regionIds: unknown): number[] | undefined {
  if (regionIds === undefined) {
    return undefined;
  }
  if (!Array.isArray(regionIds)) {
    throw new Error(
      'MUI X Studio Server: JWT "regionIds" claim must be an array of numbers, ' +
        `but received ${typeof regionIds}. ` +
        'A non-array regionIds cannot be safely compared against row-level region scope. ' +
        'Ensure the token issuer emits "regionIds" as a number array (e.g. [5, 6]), or omits the claim entirely.',
    );
  }
  return regionIds.map((id, index) => {
    // Accept ONLY a real number or a NON-EMPTY numeric string (finding 3.2).
    // `Number(...)` coerces far too eagerly to lean on `Number.isFinite` alone:
    // `Number(true) === 1`, `Number('') === 0`, `Number('  ') === 0` all pass, so a
    // boolean or an empty/whitespace string would silently become a region id (`1`,
    // `0`, …) and widen or corrupt the caller's region scope. Gate on the INPUT type
    // first — a number, or a string that is non-empty after trimming — before
    // coercing.
    const isNumericString = typeof id === 'string' && id.trim() !== '';
    if (typeof id !== 'number' && !isNumericString) {
      throw new Error(
        `MUI X Studio Server: JWT "regionIds[${index}]" must be a number (or a numeric string), ` +
          `but received ${JSON.stringify(id)}. ` +
          'A non-numeric region id cannot be safely compared against row-level region scope. ' +
          'Ensure the token issuer emits "regionIds" as a number array (e.g. [5, 6]).',
      );
    }
    const numeric = typeof id === 'number' ? id : Number(id);
    if (!Number.isFinite(numeric)) {
      throw new Error(
        `MUI X Studio Server: JWT "regionIds[${index}]" must be a number (or a numeric string), ` +
          `but received ${JSON.stringify(id)}. ` +
          'A non-numeric region id cannot be safely compared against row-level region scope. ' +
          'Ensure the token issuer emits "regionIds" as a number array (e.g. [5, 6]).',
      );
    }
    return numeric;
  });
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
  if (!jwtSecret) {
    throw new Error(
      'MUI X Studio Server: JWT_SECRET is not configured. ' +
        'Without a secret the HMAC verification runs with an empty key, so forged tokens would be accepted as valid (no authentication). ' +
        'Set the JWT_SECRET environment variable or pass an explicit secret to extractSecurityClaims().',
    );
  }

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

  // Length pre-check: timingSafeEqual throws a RangeError on unequal buffer
  // lengths, so a truncated/garbage signature would surface as an uncaught
  // RangeError instead of a clean auth failure. Compare lengths first, then run
  // the constant-time comparison only when they match.
  const expectedBuf = Buffer.from(expectedSig);
  const actualBuf = Buffer.from(signatureB64);
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    throw new Error('MUI X Studio Server: JWT signature verification failed');
  }

  // Decode payload
  let payload: JwtPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as JwtPayload;
  } catch {
    throw new Error('MUI X Studio Server: Failed to decode JWT payload');
  }

  // Check expiry. `exp` must be PRESENT, not merely valid when present: a
  // token that omits `exp` entirely previously skipped this check altogether
  // and was accepted forever. Fail closed — require every token to declare an
  // expiry rather than treating a missing claim as "never expires".
  if (payload.exp === undefined) {
    throw new Error(
      'MUI X Studio Server: JWT payload is missing the required "exp" (expiry) claim. ' +
        'A token without an expiry never expires, which this server treats as invalid rather than as a permanent grant. ' +
        'Ensure the token issuer sets "exp" to a Unix timestamp (in seconds) for every issued token.',
    );
  }
  if (payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('MUI X Studio Server: JWT has expired');
  }

  if (!payload.tenantId || !payload.sub) {
    throw new Error('MUI X Studio Server: JWT payload must include "tenantId" and "sub" claims');
  }

  return {
    tenantId: payload.tenantId,
    userId: payload.sub,
    roleIds: payload.roleIds ?? [],
    regionIds: normalizeRegionIds(payload.regionIds),
    department: payload.department,
  };
}
