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

/**
 * Build a signed JWT, allowing a custom header (to exercise the `alg` handling).
 *
 * Injects a default, far-future `exp` when the caller's payload does not
 * already declare one — `exp` is now a required claim (a token without one is
 * rejected as invalid rather than treated as never-expiring), and these tests
 * exist to exercise OTHER payload-shape edge cases, not expiry itself. Pass an
 * explicit `exp` (or `undefined`) in `payload` to override this default.
 */
function makeJwt(
  payload: Record<string, unknown>,
  secret: string,
  header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' },
): string {
  const withExp = { exp: Math.floor(Date.now() / 1000) + 3600, ...payload };
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const bodyB64 = Buffer.from(JSON.stringify(withExp)).toString('base64url');
  const sig = createHmac('sha256', secret).update(`${headerB64}.${bodyB64}`).digest('base64url');
  return `${headerB64}.${bodyB64}.${sig}`;
}

describe('extractSecurityClaims — payload-shape edge cases', () => {
  it('rejects a non-string truthy tenantId (finding 3.3)', () => {
    // A numeric tenantId is truthy, so it passes the old bare `!payload.tenantId`
    // presence check — `normalizeTenantId` now enforces the runtime shape
    // (mirroring `normalizeRegionIds`) instead of letting it flow straight
    // through into cache keys / WHERE bindings typed as a string without ever
    // having been one.
    const token = makeJwt({ sub: 'u1', tenantId: 12345 }, SECRET);
    expect(() => extractSecurityClaims(`Bearer ${token}`, SECRET)).toThrow(
      /"tenantId".*must be a non-empty string/i,
    );
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

  it('rejects a token whose payload omits the "exp" claim entirely (fail closed)', () => {
    // Build the token WITHOUT going through the `makeJwt` helper's default-`exp`
    // injection, so the payload genuinely has no "exp" key at all — this used to
    // be silently accepted forever (the expiry check only ran when `exp` was
    // present). A token that never expires must be rejected instead.
    const headerB64 = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
      'base64url',
    );
    const bodyB64 = Buffer.from(JSON.stringify({ sub: 'u1', tenantId: 'acme' })).toString(
      'base64url',
    );
    const sig = createHmac('sha256', SECRET).update(`${headerB64}.${bodyB64}`).digest('base64url');
    const token = `${headerB64}.${bodyB64}.${sig}`;
    expect(() => extractSecurityClaims(`Bearer ${token}`, SECRET)).toThrow(/"exp"/);
  });

  // Tier3 iter26 finding 4: `exp` was presence-checked but not type-checked —
  // `payload.exp < now` silently evaluates to `false` for a non-numeric value
  // (any comparison involving a non-numeric operand is `false`), so a token
  // with e.g. `exp: {}` or `exp: "banana"` never expired.
  describe('exp type validation (Tier3 iter26 finding 4)', () => {
    it('rejects a non-numeric object "exp" claim as invalid/expired rather than never-expiring', () => {
      const token = makeJwt({ sub: 'u1', tenantId: 'acme', exp: {} }, SECRET);
      expect(() => extractSecurityClaims(`Bearer ${token}`, SECRET)).toThrow(
        /"exp".*must be a finite number/i,
      );
    });

    it('rejects a non-numeric string "exp" claim ("banana")', () => {
      const token = makeJwt({ sub: 'u1', tenantId: 'acme', exp: 'banana' }, SECRET);
      expect(() => extractSecurityClaims(`Bearer ${token}`, SECRET)).toThrow(
        /"exp".*must be a finite number/i,
      );
    });

    it('rejects a NaN "exp" claim', () => {
      const token = makeJwt({ sub: 'u1', tenantId: 'acme', exp: NaN }, SECRET);
      expect(() => extractSecurityClaims(`Bearer ${token}`, SECRET)).toThrow(
        /"exp".*must be a finite number/i,
      );
    });

    it('still accepts a well-formed future numeric "exp"', () => {
      const token = makeJwt(
        { sub: 'u1', tenantId: 'acme', exp: Math.floor(Date.now() / 1000) + 3600 },
        SECRET,
      );
      expect(() => extractSecurityClaims(`Bearer ${token}`, SECRET)).not.toThrow();
    });
  });

  // Tier3 iter26 finding 4: `sub` was presence-checked (`!payload.sub`, catching
  // only falsy values) but never type/shape-checked, unlike every sibling claim
  // (`tenantId`, `roleIds`, `regionIds`, `department`).
  describe('sub normalization (Tier3 iter26 finding 4)', () => {
    it('rejects a non-string truthy sub (a number)', () => {
      const token = makeJwt({ sub: 12345, tenantId: 'acme' }, SECRET);
      expect(() => extractSecurityClaims(`Bearer ${token}`, SECRET)).toThrow(
        /"sub".*must be a non-empty string/i,
      );
    });

    it('rejects a non-string truthy sub (an object)', () => {
      const token = makeJwt({ sub: { id: 'u1' }, tenantId: 'acme' }, SECRET);
      expect(() => extractSecurityClaims(`Bearer ${token}`, SECRET)).toThrow(
        /"sub".*must be a non-empty string/i,
      );
    });

    it('still accepts a well-formed string sub', () => {
      const token = makeJwt({ sub: 'u1', tenantId: 'acme' }, SECRET);
      const claims = extractSecurityClaims(`Bearer ${token}`, SECRET);
      expect(claims.userId).toBe('u1');
    });
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

/**
 * The `department` claim's runtime shape guard (F16).
 *
 * `tenantId` and `regionIds` both have their non-string / non-array guards
 * covered above; `department` — typed `string | undefined` on
 * `JwtSecurityClaims` — did not. Without the guard a non-string value flows
 * straight through TYPED as a string into the department security predicate and
 * into `validateMutation`'s department-scope comparison, i.e. into row-level
 * access decisions, having never been one.
 */
describe('extractSecurityClaims — department claim shape (F16)', () => {
  it('accepts a string department, and an omitted one', () => {
    expect(
      extractSecurityClaims(
        `Bearer ${makeJwt({ sub: 'u1', tenantId: 'acme', department: 'Sales' }, SECRET)}`,
        SECRET,
      ).department,
    ).toBe('Sales');
    expect(
      extractSecurityClaims(`Bearer ${makeJwt({ sub: 'u1', tenantId: 'acme' }, SECRET)}`, SECRET)
        .department,
    ).toBeUndefined();
  });

  it.each([
    ['number', 42],
    ['boolean', true],
    ['array', ['Sales']],
    ['object', { name: 'Sales' }],
    ['null', null],
  ])('rejects a %s department claim', (_label, department) => {
    const token = makeJwt({ sub: 'u1', tenantId: 'acme', department }, SECRET);
    expect(() => extractSecurityClaims(`Bearer ${token}`, SECRET)).toThrow(
      /JWT "department" claim must be a string/,
    );
  });
});

/**
 * The JWT part-count guard (F18).
 *
 * A token that is not `header.payload.signature` cannot be verified at all. The
 * guard exists and works, but its MESSAGE was never asserted, so it was
 * indistinguishable from the generic signature failure below it — and a
 * two-part token would otherwise reach `Buffer.from(undefined, 'base64url')`.
 */
describe('extractSecurityClaims — malformed JWT part count (F18)', () => {
  it.each([
    ['one part', 'notajwt'],
    ['two parts', 'header.payload'],
    ['four parts', 'a.b.c.d'],
    ['five parts', 'a.b.c.d.e'],
  ])('rejects a token with %s, naming the part count as the reason', (_label, token) => {
    expect(() => extractSecurityClaims(`Bearer ${token}`, SECRET)).toThrow(
      /Malformed JWT — expected 3 parts/,
    );
  });

  it('does NOT use the part-count message for a well-formed token with a bad signature', () => {
    // The distinction the message exists to draw: three parts is a SIGNATURE
    // failure, not a shape failure.
    const [header, payload] = makeJwt({ sub: 'u1', tenantId: 'acme' }, SECRET).split('.');
    expect(() => extractSecurityClaims(`Bearer ${header}.${payload}.tampered`, SECRET)).toThrow(
      /signature verification failed/,
    );
  });
});
