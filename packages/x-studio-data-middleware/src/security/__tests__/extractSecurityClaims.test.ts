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
import { expectClauseIsolated } from 'test/utils/clauseIsolation';
import { extractSecurityClaims } from '../extractSecurityClaims';

const SECRET = 'edge-case-secret';

/**
 * Refuse a payload whose values do not survive `JSON.stringify` unchanged.
 *
 * This is the guard on the FIXTURES, and it exists because of a measured hole in them: the
 * `exp` block below had four tests written for the `!Number.isFinite(payload.exp)` clause,
 * one of them literally named `rejects a NaN "exp" claim` — and `JSON.stringify({exp: NaN})`
 * is `{"exp":null}`, so what actually crossed the wire was `null`, which the PRECEDING
 * `typeof payload.exp !== 'number'` clause rejects on its own. Delete the `Number.isFinite`
 * clause and all four stayed green, while a signed token carrying `{"exp":1e999}` — valid
 * JSON, parses to `Infinity` — would be accepted forever, because `Infinity < now` is
 * `false` for all time.
 *
 * Nothing in the tests' source showed it: the encoding that swallowed the value was two
 * frames away in this helper. So the helper now refuses rather than silently rewriting, and
 * a payload that genuinely needs a non-JSON-representable value has to go through
 * {@link makeJwtFromPayloadJson} and say so.
 *
 * Type-change is the right test: every value JSON quietly discards or rewrites (`NaN` and
 * `Infinity` -> `null`, a function -> absent, a `Date` -> a string) changes `typeof` on the
 * way through, while every value that round-trips faithfully keeps it.
 */
function assertPayloadSurvivesJsonEncoding(payload: Record<string, unknown>): void {
  const decoded = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
  for (const [claim, value] of Object.entries(payload)) {
    // `undefined` is dropped by design — that is how a caller omits a claim.
    if (value !== undefined && typeof decoded[claim] !== typeof value) {
      throw new Error(
        `makeJwt: the "${claim}" claim does not survive JSON encoding — ` +
          `${String(value)} (${typeof value}) is transmitted as ` +
          `${JSON.stringify(decoded[claim])} (${typeof decoded[claim]}). ` +
          'A test built on this token would exercise the transmitted value, not the one ' +
          'written here. Use makeJwtFromPayloadJson() to put the exact bytes on the wire.',
      );
    }
  }
}

function signPayloadJson(
  payloadJson: string,
  secret: string,
  header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' },
): string {
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const bodyB64 = Buffer.from(payloadJson).toString('base64url');
  const sig = createHmac('sha256', secret).update(`${headerB64}.${bodyB64}`).digest('base64url');
  return `${headerB64}.${bodyB64}.${sig}`;
}

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
  assertPayloadSurvivesJsonEncoding(withExp);
  return signPayloadJson(JSON.stringify(withExp), secret, header);
}

/**
 * Sign an EXACT payload JSON string, with no object in between.
 *
 * The only way to put a value on the wire that no JS object literal can express through
 * `JSON.stringify` — `1e999`, which is legal JSON and which `JSON.parse` yields as
 * `Infinity`. `{ exp: Infinity }` cannot get there: it stringifies to `null`.
 */
function makeJwtFromPayloadJson(payloadJson: string, secret: string): string {
  return signPayloadJson(payloadJson, secret);
}

/** The `exp` claim as the guard receives it — decoded back off the signed token. */
function expAsTransmitted(token: string): unknown {
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  return (payload as { exp?: unknown }).exp;
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
    // ── The `typeof payload.exp !== 'number'` half ──
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

    it('rejects a null "exp" claim (what `exp: NaN` actually puts on the wire)', () => {
      // This test used to be called `rejects a NaN "exp" claim` and was written for the
      // `Number.isFinite` half below. It never got there: `JSON.stringify({exp: NaN})` is
      // `{"exp":null}`, so `typeof payload.exp !== 'number'` is what answers. Kept, renamed
      // to what it actually covers — `null` is a real thing an issuer can emit.
      const token = makeJwt({ sub: 'u1', tenantId: 'acme', exp: null }, SECRET);
      expect(expAsTransmitted(token)).toBe(null);
      expect(() => extractSecurityClaims(`Bearer ${token}`, SECRET)).toThrow(
        /"exp".*must be a finite number/i,
      );
    });

    it('refuses to build a token whose payload does not survive JSON encoding', () => {
      // The fixture-level guard, so this hole cannot be reopened by writing the obvious
      // thing. `exp: NaN` and `exp: Infinity` both look like they test non-finiteness and
      // both transmit `null`.
      for (const exp of [NaN, Infinity, -Infinity]) {
        expect(() => makeJwt({ sub: 'u1', tenantId: 'acme', exp }, SECRET)).toThrow(
          /does not survive JSON encoding/,
        );
      }
    });

    // ── The `!Number.isFinite(payload.exp)` half ──
    //
    // Nothing reached this clause until now, and its consequence is the worst in the file:
    // `Infinity < Math.floor(Date.now() / 1000)` is `false` for all time, so a signed token
    // carrying it is a permanent grant that no expiry can ever revoke. Measured with the
    // clause relaxed: `{"exp":1e999,"tenantId":"t1","sub":"u1"}` ACCEPTED.
    it('rejects an Infinity "exp" claim, spelled 1e999 — the only non-finite value JSON carries', () => {
      const token = makeJwtFromPayloadJson('{"exp":1e999,"tenantId":"acme","sub":"u1"}', SECRET);
      // The fixture reaches the clause: this is `Infinity`, a NUMBER, so the `typeof` half
      // above lets it through and only `Number.isFinite` can stop it.
      expect(expAsTransmitted(token)).toBe(Infinity);
      expect(typeof expAsTransmitted(token)).toBe('number');
      expect(() => extractSecurityClaims(`Bearer ${token}`, SECRET)).toThrow(
        /"exp".*must be a finite number/i,
      );
    });

    it('reaches the `Number.isFinite` clause, and not the `typeof` clause beside it', () => {
      // Stated as a claim a machine checks rather than as the paragraph above. Both clauses
      // are transcribed from the source; the value is read back off the SIGNED TOKEN, which
      // is the only place the encoding's effect is visible.
      expect(() =>
        expectClauseIsolated({
          kind: 'shape',
          whyNotMinimal:
            'finiteness is not a measurable dimension: there is no value one unit short of ' +
            'Infinity that this clause admits, so there is no minimal violation to supply. ' +
            '`1e999` is the only non-finite number JSON can carry at all.',
          guard: 'extractSecurityClaims.ts:extractSecurityClaims (exp)',
          clauses: {
            "typeof payload.exp !== 'number'": (exp: unknown) => typeof exp !== 'number',
            '!Number.isFinite(payload.exp)': (exp: unknown) =>
              typeof exp === 'number' && !Number.isFinite(exp),
          },
          target: '!Number.isFinite(payload.exp)',
          control: expAsTransmitted(makeJwt({ sub: 'u1', tenantId: 'acme' }, SECRET)),
          observed: expAsTransmitted(
            makeJwtFromPayloadJson('{"exp":1e999,"tenantId":"acme","sub":"u1"}', SECRET),
          ),
        }),
      ).not.toThrow();
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

  /**
   * `normalizeRoleIds` — the one claim normalizer with NO test, in either of its clauses.
   *
   * `normalizeTenantId`, `normalizeSub`, `normalizeDepartment` and all four clauses of
   * `normalizeRegionIds` are each pinned; `roleIds` was mentioned exactly once in this file,
   * inside a comment. Deleting either of its clauses left all 1181 tests green, and each
   * produces a distinct regression (measured):
   *
   *   roleIds: "admin"             -> TypeError: roleIds.map is not a function
   *   roleIds: [{"role":"admin"}]  -> ACCEPTED, delivered to the host as `string[]`
   *
   * The first is a raw TypeError escaping this package's auth boundary unsanitized — the
   * exact thing the sibling normalizers' docblocks say they exist to prevent. The second
   * hands the host non-strings in a field typed `string[]` and documented as "Role IDs the
   * user holds", which is what the host's own role checks then compare against.
   */
  describe('roleIds shape validation (finding 3.3)', () => {
    it('passes an omitted roleIds through as an empty array', () => {
      const token = makeJwt({ sub: 'u1', tenantId: 'acme' }, SECRET);
      expect(extractSecurityClaims(`Bearer ${token}`, SECRET).roleIds).toEqual([]);
    });

    it('passes a well-formed string[] roleIds through unchanged', () => {
      const token = makeJwt({ sub: 'u1', tenantId: 'acme', roleIds: ['admin', 'viewer'] }, SECRET);
      expect(extractSecurityClaims(`Bearer ${token}`, SECRET).roleIds).toEqual(['admin', 'viewer']);
    });

    it.each([
      ['a string', 'admin'],
      ['a number', 5],
      ['an object', { a: 1 }],
      ['a boolean', true],
    ])(
      'rejects a non-array roleIds claim (%s) with a MUI X error, not a TypeError',
      (_label, roleIds) => {
        const token = makeJwt({ sub: 'u1', tenantId: 'acme', roleIds }, SECRET);
        // Asserting the MESSAGE, not merely that it throws: without the `Array.isArray` clause
        // the very next line is `roleIds.map(...)`, which throws too — as a raw TypeError.
        expect(() => extractSecurityClaims(`Bearer ${token}`, SECRET)).toThrow(
          /JWT "roleIds" claim must be an array of strings/,
        );
      },
    );

    it.each([
      ['an object entry', [{ role: 'admin' }]],
      ['a null entry', [null]],
      ['a numeric entry', [7]],
      ['a nested array entry', [['admin']]],
    ])('rejects a roleIds array containing %s, naming the index', (_label, roleIds) => {
      const token = makeJwt({ sub: 'u1', tenantId: 'acme', roleIds }, SECRET);
      expect(() => extractSecurityClaims(`Bearer ${token}`, SECRET)).toThrow(
        /JWT "roleIds\[0\]" must be a string/,
      );
    });

    it('names the offending INDEX, not just the field', () => {
      const token = makeJwt(
        { sub: 'u1', tenantId: 'acme', roleIds: ['admin', 'viewer', 9] },
        SECRET,
      );
      expect(() => extractSecurityClaims(`Bearer ${token}`, SECRET)).toThrow(
        /JWT "roleIds\[2\]" must be a string/,
      );
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
