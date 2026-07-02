/**
 * Unit tests for `MapTierCacheProvider`.
 *
 * The provider used to be a hand-rolled `Map` with manual per-entry expiry and
 * no size bound — a stream of unique query shapes could grow it indefinitely.
 * It's now backed by `lru-cache` with a `max` entry-count bound. These tests
 * cover the basic get/set/TTL/invalidatePrefix contract plus the new
 * size-bounded eviction behavior.
 */
import { describe, it, expect } from 'vitest';
import { MapTierCacheProvider } from '../MapTierCacheProvider';

describe('MapTierCacheProvider', () => {
  it('stores and retrieves tier entries', async () => {
    const cache = new MapTierCacheProvider();
    await cache.set('key1', { tier: 'server', rowCount: 5000 });
    const entry = await cache.get('key1');
    expect(entry?.tier).toBe('server');
    expect(entry?.rowCount).toBe(5000);
  });

  it('returns undefined for missing keys', async () => {
    const cache = new MapTierCacheProvider();
    expect(await cache.get('missing')).toBeUndefined();
  });

  it('returns undefined after TTL expires', async () => {
    const cache = new MapTierCacheProvider();
    await cache.set('key1', { tier: 'client', rowCount: 100 }, 1); // 1ms TTL
    await new Promise((r) => {
      setTimeout(r, 10);
    });
    expect(await cache.get('key1')).toBeUndefined();
  });

  it('invalidates entries by prefix', async () => {
    const cache = new MapTierCacheProvider();
    const entry = { tier: 'server' as const, rowCount: 50000 };
    await cache.set('studio:v1:acme:abc:123', entry);
    await cache.set('studio:v1:acme:abc:456', entry);
    await cache.set('studio:v1:globex:def:789', entry);

    await cache.invalidatePrefix('studio:v1:acme:');
    expect(await cache.get('studio:v1:acme:abc:123')).toBeUndefined();
    expect(await cache.get('studio:v1:acme:abc:456')).toBeUndefined();
    expect(await cache.get('studio:v1:globex:def:789')).toBeDefined();
  });

  it('size counts only non-expired entries', async () => {
    const cache = new MapTierCacheProvider();
    await cache.set('k1', { tier: 'client', rowCount: 1 }, 50);
    await cache.set('k2', { tier: 'server', rowCount: 2 }, 1); // expires immediately
    await new Promise((r) => {
      setTimeout(r, 10);
    });
    expect(cache.size).toBe(1); // k2 is expired
  });

  describe('bounded size (max entries)', () => {
    it('evicts the least-recently-used entry once past the configured max', async () => {
      const cache = new MapTierCacheProvider({ maxEntries: 3 });

      await cache.set('k1', { tier: 'client', rowCount: 1 });
      await cache.set('k2', { tier: 'client', rowCount: 2 });
      await cache.set('k3', { tier: 'client', rowCount: 3 });
      expect(cache.size).toBe(3);

      // A 4th unique key should evict k1 (least recently used) rather than
      // growing the cache past maxEntries.
      await cache.set('k4', { tier: 'client', rowCount: 4 });

      expect(cache.size).toBe(3);
      expect(await cache.get('k1')).toBeUndefined();
      expect(await cache.get('k2')).toBeDefined();
      expect(await cache.get('k3')).toBeDefined();
      expect(await cache.get('k4')).toBeDefined();
    });

    it('never grows past maxEntries for a stream of unique query shapes', async () => {
      const cache = new MapTierCacheProvider({ maxEntries: 10 });

      for (let i = 0; i < 1000; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await cache.set(`unique-key-${i}`, { tier: 'client', rowCount: i });
      }

      expect(cache.size).toBeLessThanOrEqual(10);
    });

    it('keeps a recently-read entry alive over one that has not been touched', async () => {
      const cache = new MapTierCacheProvider({ maxEntries: 2 });

      await cache.set('k1', { tier: 'client', rowCount: 1 });
      await cache.set('k2', { tier: 'client', rowCount: 2 });
      // Touch k1 so it becomes the most-recently-used entry.
      await cache.get('k1');

      await cache.set('k3', { tier: 'client', rowCount: 3 });

      expect(await cache.get('k1')).toBeDefined();
      expect(await cache.get('k2')).toBeUndefined();
      expect(await cache.get('k3')).toBeDefined();
    });
  });
});
