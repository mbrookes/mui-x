/**
 * Payload-shape edge-case tests for `extractSecurityClaims` (finding 4.8).
 *
 * These DOCUMENT the current behavior of the demo-grade HS256 verifier at the
 * trust boundary — they intentionally do not change the implementation. The
 * "happy path" and the core failure modes (missing header, wrong scheme, expiry,
 * bad signature, empty secret, truncated signature) are covered in
 * `src/__tests__/handler.test.ts`; this file adds the neglected corners.
 */
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { extractSecurityClaims } from '../extractSecurityClaims';

const SECRET = 'edge-case-secret';

/** Build a signed JWT, allowing a custom header (to exercise the `alg` handling). */
function makeJwt(
  payload: Record<string, unknown>,
  secret: string,
  header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' },
): string {
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const bodyB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(`${headerB64}.${bodyB64}`).digest('base64url');
  return `${headerB64}.${bodyB64}.${sig}`;
}

describe('extractSecurityClaims — payload-shape edge cases', () => {
  it('passes a non-string truthy tenantId through verbatim (no coercion)', () => {
    // A numeric tenantId is truthy, so it passes the presence check and flows
    // straight through into the returned claims (and thus cache keys / WHERE
    // bindings). Documenting the current, un-coerced behavior.
    const token = makeJwt({ sub: 'u1', tenantId: 12345 }, SECRET);
    const claims = extractSecurityClaims(`Bearer ${token}`, SECRET);
    expect(claims.tenantId).toBe(12345);
    expect(typeof claims.tenantId).toBe('number');
  });

  it('ignores a `nbf` (not-before) claim — a future nbf is still accepted', () => {
    // The verifier only checks `exp`, not `nbf`. A token that is not yet valid by
    // its own `nbf` is nonetheless accepted.
    const future = Math.floor(Date.now() / 1000) + 3600;
    const token = makeJwt({ sub: 'u1', tenantId: 'acme', nbf: future }, SECRET);
    expect(() => extractSecurityClaims(`Bearer ${token}`, SECRET)).not.toThrow();
  });

  it('ignores the header `alg` and always verifies with HS256', () => {
    // The header advertises "none", but verification recomputes HS256 over the
    // signing input regardless — so a correctly HMAC-signed token is accepted no
    // matter what the header claims. (It does NOT accept an unsigned "alg:none"
    // token, because the signature must still match the HMAC.)
    const token = makeJwt({ sub: 'u1', tenantId: 'acme' }, SECRET, { alg: 'none', typ: 'JWT' });
    const claims = extractSecurityClaims(`Bearer ${token}`, SECRET);
    expect(claims.tenantId).toBe('acme');
  });

  it('rejects an "alg:none" token whose signature is not a valid HMAC', () => {
    const headerB64 = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
      'base64url',
    );
    const bodyB64 = Buffer.from(JSON.stringify({ sub: 'u1', tenantId: 'acme' })).toString(
      'base64url',
    );
    // Empty signature segment — an attacker forging an unsigned token.
    const forged = `${headerB64}.${bodyB64}.`;
    expect(() => extractSecurityClaims(`Bearer ${forged}`, SECRET)).toThrow();
  });

  describe('regionIds shape validation (finding 3.1)', () => {
    it('passes an omitted regionIds through as undefined', () => {
      const token = makeJwt({ sub: 'u1', tenantId: 'acme' }, SECRET);
      const claims = extractSecurityClaims(`Bearer ${token}`, SECRET);
      expect(claims.regionIds).toBeUndefined();
    });

    it('passes a well-formed number[] regionIds through unchanged', () => {
      const token = makeJwt({ sub: 'u1', tenantId: 'acme', regionIds: [5, 6] }, SECRET);
      const claims = extractSecurityClaims(`Bearer ${token}`, SECRET);
      expect(claims.regionIds).toEqual([5, 6]);
    });

    it('coerces numeric-string regionIds entries to numbers', () => {
      // Coercing (rather than merely tolerating) numeric strings means
      // `computeSecurityHash`'s `(a, b) => a - b` sort — a no-op on strings —
      // now sorts correctly, so two callers with the same regions in a
      // different order share a cache key instead of fragmenting.
      const token = makeJwt({ sub: 'u1', tenantId: 'acme', regionIds: ['5', '6'] }, SECRET);
      const claims = extractSecurityClaims(`Bearer ${token}`, SECRET);
      expect(claims.regionIds).toEqual([5, 6]);
    });

    it('rejects a non-array regionIds claim', () => {
      const token = makeJwt({ sub: 'u1', tenantId: 'acme', regionIds: 'not-an-array' }, SECRET);
      expect(() => extractSecurityClaims(`Bearer ${token}`, SECRET)).toThrow(/must be an array/i);
    });

    it('rejects a regionIds array containing a non-numeric entry', () => {
      const token = makeJwt(
        { sub: 'u1', tenantId: 'acme', regionIds: [5, 'not-a-number'] },
        SECRET,
      );
      expect(() => extractSecurityClaims(`Bearer ${token}`, SECRET)).toThrow(/must be a number/i);
    });

    it('rejects a regionIds array containing an object entry', () => {
      const token = makeJwt({ sub: 'u1', tenantId: 'acme', regionIds: [{ id: 5 }] }, SECRET);
      expect(() => extractSecurityClaims(`Bearer ${token}`, SECRET)).toThrow(/must be a number/i);
    });

    // T3.2: `Number(...)` coerces far too eagerly to lean on `Number.isFinite`
    // alone — `Number(true) === 1`, `Number('') === 0`, `Number('  ') === 0` all
    // pass, so a boolean or an empty/whitespace string would silently become a
    // region id (`1`, `0`, …) and widen or corrupt the caller's region scope.
    it('rejects a boolean regionIds entry (Number(true) === 1 must not become region 1)', () => {
      const token = makeJwt({ sub: 'u1', tenantId: 'acme', regionIds: [true] }, SECRET);
      expect(() => extractSecurityClaims(`Bearer ${token}`, SECRET)).toThrow(/must be a number/i);
    });

    it('rejects a `false` regionIds entry', () => {
      const token = makeJwt({ sub: 'u1', tenantId: 'acme', regionIds: [false] }, SECRET);
      expect(() => extractSecurityClaims(`Bearer ${token}`, SECRET)).toThrow(/must be a number/i);
    });

    it('rejects an empty-string regionIds entry (Number("") === 0 must not become region 0)', () => {
      const token = makeJwt({ sub: 'u1', tenantId: 'acme', regionIds: [''] }, SECRET);
      expect(() => extractSecurityClaims(`Bearer ${token}`, SECRET)).toThrow(/must be a number/i);
    });

    it('rejects a whitespace-only regionIds entry (Number("  ") === 0 must not become region 0)', () => {
      const token = makeJwt({ sub: 'u1', tenantId: 'acme', regionIds: ['  '] }, SECRET);
      expect(() => extractSecurityClaims(`Bearer ${token}`, SECRET)).toThrow(/must be a number/i);
    });

    it('rejects a null regionIds entry', () => {
      const token = makeJwt({ sub: 'u1', tenantId: 'acme', regionIds: [null] }, SECRET);
      expect(() => extractSecurityClaims(`Bearer ${token}`, SECRET)).toThrow(/must be a number/i);
    });
  });
});
