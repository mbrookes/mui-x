/**
 * Unit tests for `generateCacheKey` security invariants.
 *
 * `handler.test.ts` already covers tenant isolation, the key format and
 * widget-id exclusion. These tests cover the invariants that are otherwise
 * untested: row-level claim scoping, the determinism guarantees (region order
 * and object property order must not change the key), and HMAC-secret scoping.
 */
import { describe, it, expect } from 'vitest';
import { generateCacheKey } from '../cacheKey';
import type { JwtSecurityClaims, BatchWidgetDescriptor } from '../types';

const SECRET = 'test-secret';

const CLAIMS: JwtSecurityClaims = {
  tenantId: 'acme',
  userId: 'user-1',
  roleIds: ['viewer'],
};

const DESCRIPTOR: BatchWidgetDescriptor = { id: 'w1', table: 'sales' };

describe('generateCacheKey', () => {
  it('is deterministic for identical inputs', () => {
    expect(generateCacheKey(CLAIMS, DESCRIPTOR, SECRET)).toBe(
      generateCacheKey(CLAIMS, DESCRIPTOR, SECRET),
    );
  });

  describe('row-level claim scoping', () => {
    it('produces different keys for different departments', () => {
      const a = generateCacheKey({ ...CLAIMS, department: 'sales' }, DESCRIPTOR, SECRET);
      const b = generateCacheKey({ ...CLAIMS, department: 'finance' }, DESCRIPTOR, SECRET);
      expect(a).not.toBe(b);
    });

    it('produces different keys for different region sets', () => {
      const a = generateCacheKey({ ...CLAIMS, regionIds: [1] }, DESCRIPTOR, SECRET);
      const b = generateCacheKey({ ...CLAIMS, regionIds: [1, 2] }, DESCRIPTOR, SECRET);
      expect(a).not.toBe(b);
    });

    it('ignores roleIds and userId (not part of the row-level security profile)', () => {
      const a = generateCacheKey(
        { ...CLAIMS, userId: 'user-1', roleIds: ['admin'] },
        DESCRIPTOR,
        SECRET,
      );
      const b = generateCacheKey(
        { ...CLAIMS, userId: 'user-2', roleIds: ['viewer'] },
        DESCRIPTOR,
        SECRET,
      );
      expect(a).toBe(b);
    });
  });

  describe('determinism guarantees', () => {
    it('is independent of regionIds order (same permissions share a cache entry)', () => {
      const a = generateCacheKey({ ...CLAIMS, regionIds: [3, 1, 2] }, DESCRIPTOR, SECRET);
      const b = generateCacheKey({ ...CLAIMS, regionIds: [1, 2, 3] }, DESCRIPTOR, SECRET);
      expect(a).toBe(b);
    });

    it('is independent of descriptor property insertion order', () => {
      const a = generateCacheKey(
        CLAIMS,
        { id: 'w1', table: 'sales', limit: 10, columns: ['x'] },
        SECRET,
      );
      const b = generateCacheKey(
        CLAIMS,
        { columns: ['x'], limit: 10, table: 'sales', id: 'w1' },
        SECRET,
      );
      expect(a).toBe(b);
    });

    it('is independent of filter-predicate property order', () => {
      const a = generateCacheKey(
        CLAIMS,
        {
          id: 'w1',
          table: 'sales',
          filters: [{ column: 'status', operator: 'eq', value: 'active' }],
        },
        SECRET,
      );
      const b = generateCacheKey(
        CLAIMS,
        {
          id: 'w1',
          table: 'sales',
          filters: [{ value: 'active', operator: 'eq', column: 'status' } as any],
        },
        SECRET,
      );
      expect(a).toBe(b);
    });
  });

  describe('query-shape scoping', () => {
    it('produces different keys for different filter values', () => {
      const a = generateCacheKey(
        CLAIMS,
        {
          id: 'w1',
          table: 'sales',
          filters: [{ column: 'status', operator: 'eq', value: 'active' }],
        },
        SECRET,
      );
      const b = generateCacheKey(
        CLAIMS,
        {
          id: 'w1',
          table: 'sales',
          filters: [{ column: 'status', operator: 'eq', value: 'archived' }],
        },
        SECRET,
      );
      expect(a).not.toBe(b);
    });

    it('produces different keys for descriptors differing only in a Date filter bound (T2.1)', () => {
      // Regression: a `Date` filter value used to serialize to `{}` in the query
      // hash (zero own enumerable keys), so two widgets differing only in a Date
      // bound hashed identically and one was served the other's cached rows.
      const a = generateCacheKey(
        CLAIMS,
        {
          id: 'w1',
          table: 'sales',
          filters: [{ column: 'sale_date', operator: 'gte', value: new Date('2024-01-01') } as any],
        },
        SECRET,
      );
      const b = generateCacheKey(
        CLAIMS,
        {
          id: 'w1',
          table: 'sales',
          filters: [{ column: 'sale_date', operator: 'gte', value: new Date('2024-06-15') } as any],
        },
        SECRET,
      );
      expect(a).not.toBe(b);
      // Same tenant + security segment; only the query-hash segment differs.
      expect(a.split(':')[3]).toBe(b.split(':')[3]);
      expect(a.split(':')[4]).not.toBe(b.split(':')[4]);
    });
  });

  describe('HMAC-secret scoping', () => {
    it('produces a different security hash for a different secret', () => {
      const a = generateCacheKey(CLAIMS, DESCRIPTOR, 'secret-a');
      const b = generateCacheKey(CLAIMS, DESCRIPTOR, 'secret-b');
      // The query-hash segment is unaffected by the secret; the security-hash
      // segment must differ so a leaked client guess cannot forge another key.
      expect(a).not.toBe(b);
      expect(a.split(':')[4]).toBe(b.split(':')[4]); // queryHash segment identical
      expect(a.split(':')[3]).not.toBe(b.split(':')[3]); // securityHash segment differs
    });
  });

  it('emits the documented key format studio:v1:<tenant>:<securityHash>:<queryHash>', () => {
    const key = generateCacheKey(CLAIMS, DESCRIPTOR, SECRET);
    expect(key).toMatch(/^studio:v1:acme:[0-9a-f]{16}:[0-9a-f]{16}$/);
  });

  describe('colon-bearing tenantId (finding 3.2)', () => {
    it('URL-encodes the tenant segment so a colon stays inside one segment', () => {
      const key = generateCacheKey({ ...CLAIMS, tenantId: 'org:1234' }, DESCRIPTOR, SECRET);
      // The colon becomes %3A, so splitting on ':' still yields exactly 5 segments
      // (studio, v1, org%3A1234, securityHash, queryHash) — the tenant boundary is
      // not shifted and prefix invalidation stays tenant-granular.
      expect(key).toMatch(/^studio:v1:org%3A1234:[0-9a-f]{16}:[0-9a-f]{16}$/);
      expect(key.split(':')).toHaveLength(5);
      expect(key.split(':')[2]).toBe('org%3A1234');
    });

    it('gives two tenants that differ only after a colon distinct tenant segments', () => {
      const a = generateCacheKey({ ...CLAIMS, tenantId: 'org:1' }, DESCRIPTOR, SECRET);
      const b = generateCacheKey({ ...CLAIMS, tenantId: 'org:2' }, DESCRIPTOR, SECRET);
      expect(a).not.toBe(b);
      // Distinct encoded tenant segments — they do NOT collapse to a shared `org`.
      expect(a.split(':')[2]).toBe('org%3A1');
      expect(b.split(':')[2]).toBe('org%3A2');
    });

    it('leaves a colon-free tenantId byte-identical (backward compatible)', () => {
      // `acme` has no reserved characters, so encoding is a no-op and existing keys
      // are unchanged.
      expect(generateCacheKey(CLAIMS, DESCRIPTOR, SECRET)).toMatch(/^studio:v1:acme:/);
    });
  });

  describe('fail-closed HMAC secret', () => {
    it('throws when the effective secret is empty (would be forgeable)', () => {
      expect(() => generateCacheKey(CLAIMS, DESCRIPTOR, '')).toThrow(
        /No cache HMAC secret is configured/,
      );
    });
  });
});
