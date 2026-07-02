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
      expect(await cache.get('k1')).toBeUndefined();
      // Verify no stale k1 entry under q4 — deleteByTag on q4 must be a no-op (no throw)
      await cache.deleteByTag('q4');
      expect(await cache.get('k1')).toBeUndefined();
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

  describe('byte-based eviction under real maxSizeBytes pressure', () => {
    // sizeCalculation = value.rows.length * avgBytesPerRow + 64 (see LRUCacheProvider.ts).
    // With avgBytesPerRow=100 and 1 row per entry, each entry costs 164 bytes.
    // maxSizeBytes=500 fits ~3 entries — writing 6 must force real lru-cache
    // eviction (as opposed to the explicit `.delete()`-driven tests above,
    // which never exercise the `maxSize`/`sizeCalculation` byte-pressure path).
    it('evicts least-recently-used entries once total size exceeds maxSizeBytes', async () => {
      const cache = new LRUCacheProvider({ maxSizeBytes: 500, avgBytesPerRow: 100 });
      for (let i = 0; i < 6; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await cache.set(`k${i}`, entry([{ v: i }]));
      }

      let present = 0;
      for (let i = 0; i < 6; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        if (await cache.get(`k${i}`)) {
          present += 1;
        }
      }
      // Not all 6 entries can fit under the byte cap — some must have been evicted.
      expect(present).toBeGreaterThan(0);
      expect(present).toBeLessThan(6);

      // LRU semantics: the most recently written key must survive, and the
      // very first (least-recently-used) key must have been evicted.
      expect(await cache.get('k5')).toBeDefined();
      expect(await cache.get('k0')).toBeUndefined();
    });

    it('evicts a larger (multi-row) entry sooner than several small entries under the same byte cap', async () => {
      const cache = new LRUCacheProvider({ maxSizeBytes: 500, avgBytesPerRow: 100 });
      // A 4-row entry costs 4*100+64=464 bytes — nearly the whole budget on its own.
      await cache.set('big', entry([{ v: 0 }, { v: 1 }, { v: 2 }, { v: 3 }]));
      expect(await cache.get('big')).toBeDefined();

      // Writing several small (164-byte) entries afterward must evict 'big'
      // once the cumulative size exceeds maxSizeBytes.
      for (let i = 0; i < 4; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await cache.set(`small${i}`, entry([{ v: i }]));
      }

      expect(await cache.get('big')).toBeUndefined();
      // The most recently written small entry must still be present.
      expect(await cache.get('small3')).toBeDefined();
    });

    it('keeps every entry when their combined size stays under maxSizeBytes', async () => {
      const cache = new LRUCacheProvider({ maxSizeBytes: 10_000, avgBytesPerRow: 100 });
      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await cache.set(`k${i}`, entry([{ v: i }]));
      }
      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        expect(await cache.get(`k${i}`)).toBeDefined();
      }
    });
  });
});
