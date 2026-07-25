/**
 * Regression tests for the `securityHashMemo` eviction policy (finding L4).
 *
 * The memo evicted `securityHashMemo.keys().next().value` — the oldest-INSERTED
 * key — and never re-issued `set` on a hit, so insertion order never refreshed
 * and eviction was FIFO, not LRU. With more than `SECURITY_HASH_MEMO_MAX_SIZE`
 * distinct `(tenantId, regionIds, department, policyDigest)` profiles, a stream
 * of cold one-off profiles evicted the HOTTEST tenant's entry on every miss (its
 * insertion is by definition the oldest), so the HMAC was recomputed on
 * essentially every request while the memo stayed full of cold entries.
 *
 * The observable difference between FIFO and LRU is *whether the HMAC is
 * recomputed*, not the value it produces — the hash is identical either way.
 * These tests therefore count `createHmac` invocations, which is why this lives
 * in its own file: the `node:crypto` module mock must not affect the rest of the
 * `cacheKey` suite. `generateCacheKey` also calls `createHash` (for the query
 * hash), which is deliberately left unmocked so the counter isolates the memo.
 */
import { describe, it, expect, vi } from 'vitest';
import { generateCacheKey, SECURITY_HASH_MEMO_MAX_SIZE } from '../cacheKey';
import type { JwtSecurityClaims, BatchWidgetDescriptor } from '../types';

// `vi.hoisted` + `vi.mock` are both lifted above the imports by Vitest's
// transform, so the spy exists by the time `../cacheKey` binds `createHmac`.
const cryptoSpies = vi.hoisted(() => ({ createHmac: vi.fn() }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  cryptoSpies.createHmac.mockImplementation(actual.createHmac);
  return { ...actual, createHmac: cryptoSpies.createHmac };
});

const SECRET = 'memo-lru-test-secret';
const DESCRIPTOR: BatchWidgetDescriptor = { id: 'w1', table: 'sales' };

function claimsFor(tenantId: string): JwtSecurityClaims {
  return { tenantId, userId: 'u1', roleIds: ['viewer'] };
}

/** Number of HMAC computations caused by running `fn`. */
function hmacCallsDuring(fn: () => void): number {
  const before = cryptoSpies.createHmac.mock.calls.length;
  fn();
  return cryptoSpies.createHmac.mock.calls.length - before;
}

describe('securityHashMemo — evicts least-recently-USED, not least-recently-inserted (finding L4)', () => {
  it('keeps a repeatedly-used profile memoized while cold one-off profiles stream through', () => {
    const hot = claimsFor('hot-tenant');

    // 1. Warm the hot profile — one HMAC, then memoized.
    expect(hmacCallsDuring(() => generateCacheKey(hot, DESCRIPTOR, SECRET))).toBe(1);
    expect(hmacCallsDuring(() => generateCacheKey(hot, DESCRIPTOR, SECRET))).toBe(0);

    // 2. Fill the memo to exactly its ceiling with cold, never-reused profiles.
    //    The hot entry is now the OLDEST-INSERTED entry of a full memo.
    for (let i = 0; i < SECURITY_HASH_MEMO_MAX_SIZE - 1; i += 1) {
      generateCacheKey(claimsFor(`cold-${i}`), DESCRIPTOR, SECRET);
    }

    // 3. USE the hot profile again. Still a hit (the memo is exactly at, not over,
    //    its ceiling) — and this is the touch that must refresh its position.
    expect(hmacCallsDuring(() => generateCacheKey(hot, DESCRIPTOR, SECRET))).toBe(0);

    // 4. One more cold profile forces an eviction. Under the old FIFO policy the
    //    victim is the hot entry (oldest INSERTED); under LRU it is `cold-0`.
    generateCacheKey(claimsFor('cold-overflow'), DESCRIPTOR, SECRET);

    // 5. The discriminator: the hot profile must still be memoized.
    expect(hmacCallsDuring(() => generateCacheKey(hot, DESCRIPTOR, SECRET))).toBe(0);

    // …and the actual eviction victim — the least recently USED entry — is gone.
    expect(hmacCallsDuring(() => generateCacheKey(claimsFor('cold-0'), DESCRIPTOR, SECRET))).toBe(
      1,
    );
  });

  it('produces the same hash whether the entry was memoized or recomputed', () => {
    // The eviction policy is a performance concern only — it must never change
    // the key a given security profile maps to.
    const claims = claimsFor('stability-tenant');
    const first = generateCacheKey(claims, DESCRIPTOR, SECRET);
    // Evict everything by streaming more cold profiles than the memo can hold.
    for (let i = 0; i < SECURITY_HASH_MEMO_MAX_SIZE + 1; i += 1) {
      generateCacheKey(claimsFor(`evictor-${i}`), DESCRIPTOR, SECRET);
    }
    expect(generateCacheKey(claims, DESCRIPTOR, SECRET)).toBe(first);
  });
});
