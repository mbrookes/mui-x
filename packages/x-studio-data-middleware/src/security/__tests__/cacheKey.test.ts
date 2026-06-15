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
      const a = generateCacheKey({ ...CLAIMS, userId: 'user-1', roleIds: ['admin'] }, DESCRIPTOR, SECRET);
      const b = generateCacheKey({ ...CLAIMS, userId: 'user-2', roleIds: ['viewer'] }, DESCRIPTOR, SECRET);
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
      const a = generateCacheKey(CLAIMS, { id: 'w1', table: 'sales', limit: 10, columns: ['x'] }, SECRET);
      const b = generateCacheKey(CLAIMS, { columns: ['x'], limit: 10, table: 'sales', id: 'w1' }, SECRET);
      expect(a).toBe(b);
    });

    it('is independent of filter-predicate property order', () => {
      const a = generateCacheKey(CLAIMS, {
        id: 'w1',
        table: 'sales',
        filters: [{ column: 'status', operator: 'eq', value: 'active' }],
      }, SECRET);
      const b = generateCacheKey(CLAIMS, {
        id: 'w1',
        table: 'sales',
        filters: [{ value: 'active', operator: 'eq', column: 'status' } as any],
      }, SECRET);
      expect(a).toBe(b);
    });
  });

  describe('query-shape scoping', () => {
    it('produces different keys for different filter values', () => {
      const a = generateCacheKey(CLAIMS, {
        id: 'w1',
        table: 'sales',
        filters: [{ column: 'status', operator: 'eq', value: 'active' }],
      }, SECRET);
      const b = generateCacheKey(CLAIMS, {
        id: 'w1',
        table: 'sales',
        filters: [{ column: 'status', operator: 'eq', value: 'archived' }],
      }, SECRET);
      expect(a).not.toBe(b);
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
});
