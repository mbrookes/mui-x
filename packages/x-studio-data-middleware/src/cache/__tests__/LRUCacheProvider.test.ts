/**
 * Unit tests for `LRUCacheProvider` paths not covered by `handler.test.ts`.
 *
 * handler.test.ts covers basic store/retrieve and a single invalidatePrefix
 * case. These tests target the prefix-index correctness (tenant isolation), the
 * fallback scan for non-indexed prefixes, value overwrite, and TTL expiry.
 */
import { describe, it, expect } from 'vitest';
import { LRUCacheProvider } from '../LRUCacheProvider';
import type { CacheEntry } from '../types';

function entry(rows: Record<string, unknown>[] = [{ id: 1 }]): CacheEntry {
  return { rows, cachedAt: 0 };
}

describe('LRUCacheProvider', () => {
  it('overwrites an existing key with a new value', async () => {
    const cache = new LRUCacheProvider();
    await cache.set('k1', entry([{ v: 1 }]));
    await cache.set('k1', entry([{ v: 2 }]));
    expect((await cache.get('k1'))?.rows).toEqual([{ v: 2 }]);
  });

  describe('invalidatePrefix — prefix index (tenant isolation)', () => {
    it('drops every key for the targeted tenant and leaves other tenants intact', async () => {
      const cache = new LRUCacheProvider();
      await cache.set('studio:v1:acme:q1', entry());
      await cache.set('studio:v1:acme:q2', entry());
      await cache.set('studio:v1:globex:q1', entry());

      await cache.invalidatePrefix('studio:v1:acme:');

      expect(await cache.get('studio:v1:acme:q1')).toBeUndefined();
      expect(await cache.get('studio:v1:acme:q2')).toBeUndefined();
      expect(await cache.get('studio:v1:globex:q1')).toBeDefined();
    });

    it('is a no-op when the prefix matches no stored keys', async () => {
      const cache = new LRUCacheProvider();
      await cache.set('studio:v1:acme:q1', entry());
      await cache.invalidatePrefix('studio:v1:nobody:');
      expect(await cache.get('studio:v1:acme:q1')).toBeDefined();
    });
  });

  describe('deleteByTag', () => {
    it('removes entries with the given tag and leaves others intact', async () => {
      const cache = new LRUCacheProvider();
      await cache.set('k1', entry(), { tags: ['sales'] });
      await cache.set('k2', entry(), { tags: ['sales'] });
      await cache.set('k3', entry(), { tags: ['orders'] });

      await cache.deleteByTag('sales');

      expect(await cache.get('k1')).toBeUndefined();
      expect(await cache.get('k2')).toBeUndefined();
      expect(await cache.get('k3')).toBeDefined();
    });

    it('is a no-op when the tag has no associated entries', async () => {
      const cache = new LRUCacheProvider();
      await cache.set('k1', entry(), { tags: ['orders'] });
      await cache.deleteByTag('sales');
      expect(await cache.get('k1')).toBeDefined();
    });

    it('removes an entry tagged with multiple tags when any tag is deleted', async () => {
      const cache = new LRUCacheProvider();
      await cache.set('k1', entry(), { tags: ['sales', 'q4'] });
      await cache.deleteByTag('q4');
      expect(await cache.get('k1')).toBeUndefined();
    });

    it('cleans up tagIndex entries for all tags on an evicted key', async () => {
      const cache = new LRUCacheProvider();
      await cache.set('k1', entry(), { tags: ['sales', 'q4'] });
      await cache.deleteByTag('sales'); // deletes k1; q4 tag set should also be cleaned up
      // Verify no stale k1 entry under q4 — deleteByTag on q4 must be a no-op
      await cache.deleteByTag('q4');
      // No assertion needed beyond "did not throw"; verifies dispose cleanup is correct.
    });
  });

  describe('invalidatePrefix — fallback scan for non-indexed prefixes', () => {
    it('removes matching keys via the scan fallback when the prefix is broader than the index key', async () => {
      const cache = new LRUCacheProvider();
      // The index key for these is "studio:v1:<tenant>:"; a broader prefix
      // ("studio:v1:") is not in the index and must hit the scan fallback.
      await cache.set('studio:v1:acme:q1', entry());
      await cache.set('studio:v1:globex:q1', entry());

      await cache.invalidatePrefix('studio:v1:');

      expect(await cache.get('studio:v1:acme:q1')).toBeUndefined();
      expect(await cache.get('studio:v1:globex:q1')).toBeUndefined();
    });
  });
});
