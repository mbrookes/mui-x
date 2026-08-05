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
  // `unknown` (not `string`) — see `normalizeSub`. The payload is parsed JSON from a
  // client-controlled bearer token, so the TS shape is not a runtime guarantee, mirroring every
  // sibling claim below.
  sub: unknown;
  // `unknown` (not `string`) — the payload is parsed JSON from a
  // client-controlled bearer token, so the TS shape is not a runtime
  // guarantee. `normalizeTenantId` below is the runtime boundary that
  // actually enforces `string`, mirroring `normalizeRegionIds`.
  tenantId: unknown;
  // `unknown` (not `string[]`) — see `normalizeRoleIds`.
  roleIds?: unknown;
  // `unknown` (not `number[]`) — the payload is parsed JSON from a
  // client-controlled bearer token, so the TS shape is not a runtime
  // guarantee. `normalizeRegionIds` below is the runtime boundary that
  // actually enforces `number[]`.
  regionIds?: unknown;
  // `unknown` (not `string`) — see `normalizeDepartment`.
  department?: unknown;
  // `unknown` (not `number`) — the expiry check below is the runtime boundary that enforces
  // `number`: `exp: {}` or `exp: "banana"` used to pass a bare presence check (`payload.exp ===
  // undefined`) and then `payload.exp < now` evaluated to `false` for a non-numeric value (`NaN`
  // comparisons are always `false`), so such a token never expired.
  exp?: unknown;
}

/**
 * Validate + coerce the JWT's `tenantId` claim to a non-empty `string`.
 *
 * `tenantId` is typed `string` on `JwtSecurityClaims`, but the payload is
 * client-supplied JSON — nothing guarantees the token issuer actually emitted a
 * string. The pre-existing `!payload.tenantId` presence check only catches
 * FALSY values (`undefined`, `''`, `0`, `false`) — a non-string TRUTHY value (a
 * number, an object, an array) passed the check and flowed straight through
 * into the returned claims — and from there into cache-key hashing and
 * parameterized WHERE bindings — typed as `string` without ever having been
 * one. This is the same field-shape asymmetry `normalizeRegionIds` already
 * closes for `regionIds`; mirror it here. Not currently exploitable (the value
 * stays parameterized), but an unenforced runtime shape at an already-acknowledged
 * trust boundary.
 */
function normalizeTenantId(tenantId: unknown): string {
  if (typeof tenantId !== 'string') {
    throw new Error(
      `MUI X Studio Server: JWT "tenantId" claim must be a non-empty string, ` +
        `but received ${JSON.stringify(tenantId)}. ` +
        'A non-string tenantId cannot be safely used to scope row-level tenant access. ' +
        'Ensure the token issuer emits "tenantId" as a string.',
    );
  }
  return tenantId;
}

/**
 * Validate + coerce the JWT's `sub` claim to a non-empty `string`.
 *
 * `sub` is typed `string` on `JwtSecurityClaims.userId`, but — like every other
 * claim in this file — nothing previously enforced that at runtime: the
 * pre-existing `!payload.sub` presence check only catches FALSY values, so a
 * non-string TRUTHY value (a number, an object, an array) flowed straight
 * through into `userId: string` unvalidated, and from there into cache-key
 * hashing and anywhere `userId` is used to scope/log the request. Mirrors
 * `normalizeTenantId`'s exact pattern for the sibling claim it left unclosed.
 */
function normalizeSub(sub: unknown): string {
  if (typeof sub !== 'string') {
    throw new Error(
      `MUI X Studio Server: JWT "sub" claim must be a non-empty string, ` +
        `but received ${JSON.stringify(sub)}. ` +
        'A non-string sub cannot be safely used as the request-scoped user identifier. ' +
        'Ensure the token issuer emits "sub" as a string.',
    );
  }
  return sub;
}

/**
 * Validate the JWT's optional `department` claim is a `string` when present.
 *
 * Mirrors `normalizeTenantId` / `normalizeRegionIds`: `department` is typed
 * `string | undefined` on `JwtSecurityClaims`, but nothing previously enforced
 * that at runtime — a non-string, non-undefined value (a number, an array, an
 * object) flowed straight through typed as a `string`.
 */
function normalizeDepartment(department: unknown): string | undefined {
  if (department === undefined) {
    return undefined;
  }
  if (typeof department !== 'string') {
    throw new Error(
      `MUI X Studio Server: JWT "department" claim must be a string, but received ${typeof department}. ` +
        'A non-string department cannot be safely used to scope row-level department access. ' +
        'Ensure the token issuer emits "department" as a string, or omits the claim entirely.',
    );
  }
  return department;
}

/**
 * Validate + coerce the JWT's optional `roleIds` claim to `string[]`.
 *
 * Mirrors `normalizeRegionIds`: `roleIds` is typed `string[]` on
 * `JwtSecurityClaims`, but nothing previously enforced that at runtime — a
 * non-array value (or an array containing non-string entries) flowed straight
 * through typed as `string[]`.
 */
function normalizeRoleIds(roleIds: unknown): string[] {
  if (roleIds === undefined) {
    return [];
  }
  if (!Array.isArray(roleIds)) {
    throw new Error(
      `MUI X Studio Server: JWT "roleIds" claim must be an array of strings, ` +
        `but received ${typeof roleIds}. ` +
        'A non-array roleIds cannot be safely used for role-based access checks. ' +
        'Ensure the token issuer emits "roleIds" as a string array (e.g. ["admin", "viewer"]), or omits the claim entirely.',
    );
  }
  return roleIds.map((id, index) => {
    if (typeof id !== 'string') {
      throw new Error(
        `MUI X Studio Server: JWT "roleIds[${index}]" must be a string, but received ${JSON.stringify(id)}. ` +
          'A non-string role id cannot be safely used for role-based access checks. ' +
          'Ensure the token issuer emits "roleIds" as a string array (e.g. ["admin", "viewer"]).',
      );
    }
    return id;
  });
}

/**
 * Validate + coerce the JWT's `regionIds` claim to `number[]`.
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
    // Accept ONLY a real number or a NON-EMPTY numeric string. `Number(...)` coerces far too
    // eagerly to lean on `Number.isFinite` alone: `Number(true) === 1`, `Number('') === 0`,
    // `Number(' ') === 0` all pass, so a boolean or an empty/whitespace string would silently
    // become a region id (`1`, `0`, …) and widen or corrupt the caller's region scope. Gate on the
    // INPUT type first — a number, or a string that is non-empty after trimming — before coercing.
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
  // `exp` must be a FINITE NUMBER, not merely present. `payload.exp` is client JSON — a signed
  // token with `exp: {}` or `exp: "banana"` previously passed the presence check above, and the
  // comparison below (`payload.exp < now`) silently evaluated to `false` for a non-numeric value
  // (any comparison involving `NaN`, or a `<` between an object and a number, is `false`), so such
  // a token NEVER expired. Treat a non-finite/non-numeric `exp` as already-expired/invalid — fail
  // closed rather than granting a permanent token.
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
    throw new Error(
      `MUI X Studio Server: JWT "exp" claim must be a finite number (a Unix timestamp in seconds), ` +
        `but received ${JSON.stringify(payload.exp)}. ` +
        'A non-numeric expiry cannot be safely compared against the current time and is treated as already expired. ' +
        'Ensure the token issuer sets "exp" to a numeric Unix timestamp.',
    );
  }
  if (payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('MUI X Studio Server: JWT has expired');
  }

  if (!payload.tenantId || !payload.sub) {
    throw new Error('MUI X Studio Server: JWT payload must include "tenantId" and "sub" claims');
  }

  return {
    tenantId: normalizeTenantId(payload.tenantId),
    userId: normalizeSub(payload.sub),
    roleIds: normalizeRoleIds(payload.roleIds),
    regionIds: normalizeRegionIds(payload.regionIds),
    department: normalizeDepartment(payload.department),
  };
}
