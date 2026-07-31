/**
 * Pins the JWT signature comparison to a CONSTANT-TIME primitive.
 *
 * `extractSecurityClaims` compares the signature it recomputes against the one
 * the caller supplied with `crypto.timingSafeEqual`. That choice is a SECURITY
 * property, not a functional one: replacing it with an ordinary string/`Buffer`
 * comparison is functionally indistinguishable — every token that verified still
 * verifies, every forgery is still rejected, and the whole suite stays green —
 * while reintroducing the byte-by-byte early exit that lets an attacker who can
 * measure response latency recover a valid signature one byte at a time.
 *
 * A mutation-testing audit confirmed exactly that: swapping `timingSafeEqual` for
 * `expectedSig === signatureB64` survived all 1085 tests. So the property needs a
 * regression barrier that does not depend on observable behaviour — this file
 * asserts on the primitive actually being reached.
 *
 * `vi.mock` here wraps the REAL `node:crypto` (the spy delegates to
 * `actual.timingSafeEqual`), so verification behaviour is unchanged; only the
 * call is observable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const timingSafeEqualSpy = vi.hoisted(() => vi.fn());

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  timingSafeEqualSpy.mockImplementation(actual.timingSafeEqual as never);
  return { ...actual, default: actual, timingSafeEqual: timingSafeEqualSpy };
});

// eslint-disable-next-line import/first -- must follow the vi.mock factory above
import { createHmac } from 'node:crypto';
// eslint-disable-next-line import/first
import { extractSecurityClaims } from '../extractSecurityClaims';

const SECRET = 'constant-time-compare-secret';

function makeJwt(secret: string): { token: string; signingInput: string } {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({ sub: 'u1', tenantId: 'acme', exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString('base64url');
  const signingInput = `${header}.${body}`;
  const sig = createHmac('sha256', secret).update(signingInput).digest('base64url');
  return { token: `${signingInput}.${sig}`, signingInput };
}

describe('extractSecurityClaims — JWT signatures are compared in constant time', () => {
  beforeEach(() => {
    timingSafeEqualSpy.mockClear();
  });

  it('verifies a valid signature THROUGH crypto.timingSafeEqual', () => {
    const { token } = makeJwt(SECRET);
    const claims = extractSecurityClaims(`Bearer ${token}`, SECRET);
    expect(claims.tenantId).toBe('acme');

    // The assertion that a plain `===` cannot satisfy.
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);
    const [expectedBuf, actualBuf] = timingSafeEqualSpy.mock.calls[0];
    expect(Buffer.isBuffer(expectedBuf)).toBe(true);
    expect(Buffer.isBuffer(actualBuf)).toBe(true);
    expect(expectedBuf.length).toBe(actualBuf.length);
  });

  it('rejects a forged signature THROUGH the same constant-time comparison', () => {
    // Same LENGTH as the genuine signature, so the length pre-check cannot be
    // what rejects it — the rejection has to come from `timingSafeEqual` itself.
    const { signingInput } = makeJwt(SECRET);
    const forged = createHmac('sha256', 'wrong-secret').update(signingInput).digest('base64url');
    expect(() => extractSecurityClaims(`Bearer ${signingInput}.${forged}`, SECRET)).toThrow(
      'JWT signature verification failed',
    );
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);
  });

  it('short-circuits on a length mismatch WITHOUT calling timingSafeEqual', () => {
    // `timingSafeEqual` throws a RangeError on unequal buffer lengths, so the
    // length pre-check is what keeps a truncated signature a clean auth failure
    // rather than an uncaught RangeError. Pinned here because it is the one case
    // where NOT reaching the constant-time primitive is correct.
    const { signingInput } = makeJwt(SECRET);
    expect(() => extractSecurityClaims(`Bearer ${signingInput}.deadbeef`, SECRET)).toThrow(
      'JWT signature verification failed',
    );
    expect(timingSafeEqualSpy).not.toHaveBeenCalled();
  });
});
