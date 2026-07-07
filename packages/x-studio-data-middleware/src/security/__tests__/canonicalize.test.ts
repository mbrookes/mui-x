/**
 * Unit tests for `sortedStringify`, the single canonical serializer shared by
 * `cacheKey.ts` (security hash / query hash) and `compileSecurityPolicy.ts`
 * (policy digest). These pin the canonicalization contract directly, decoupled
 * from HMAC/digest plumbing, so a future change to one consumer can't silently
 * diverge from the other.
 */
import { describe, it, expect } from 'vitest';
import { sortedStringify } from '../canonicalize';

describe('sortedStringify', () => {
  it('sorts object keys alphabetically at every depth, regardless of insertion order', () => {
    const a = sortedStringify({ b: 1, a: { d: 2, c: 3 } });
    const b = sortedStringify({ a: { c: 3, d: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('treats array element order as significant (not sorted)', () => {
    const a = sortedStringify([1, 2]);
    const b = sortedStringify([2, 1]);
    expect(a).not.toBe(b);
    expect(a).toBe('[1,2]');
    expect(b).toBe('[2,1]');
  });

  it('produces different output for null vs undefined property values', () => {
    // Both occur in real security profiles: `perTable[t] = null` is an explicit
    // opt-out, while `regionIds: undefined` means "claim absent". Conflating
    // them would merge two distinct security profiles into the same cache key.
    const withNull = sortedStringify({ tenant: null });
    const withUndefined = sortedStringify({ tenant: undefined });
    expect(withNull).not.toBe(withUndefined);
    expect(withNull).toBe('{"tenant":null}');
  });

  it('pins the exact canonical output for a representative security profile', () => {
    // Exact-output snapshot: any future "improvement" to the algorithm that
    // would silently re-key every deployed cache entry / policy digest fails
    // loudly here rather than only showing up as a hard-to-diagnose cache miss
    // storm or a full security-hash rotation in production.
    const profile = sortedStringify({
      tenantId: 'acme',
      regionIds: [1, 2, 3],
      department: 'sales',
      policyDigest: 'abc123',
    });
    expect(profile).toBe(
      '{"department":"sales","policyDigest":"abc123","regionIds":[1,2,3],"tenantId":"acme"}',
    );
  });
});
