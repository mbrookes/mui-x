/**
 * Unit tests for `RedisCacheProvider`.
 *
 * The data CacheProvider Redis implementation was untested (only its tier-cache
 * sibling, `RedisTierCacheProvider`, had coverage). These tests verify the
 * get/set roundtrip, TTL handling, key-prefix namespacing, prefix invalidation,
 * and graceful handling of corrupt cache entries — all against an in-memory
 * Redis mock so no Redis server is required.
 */
import { describe, it, expect } from 'vitest';
import { RedisCacheProvider, type RedisClient } from '../RedisCacheProvider';
import type { CacheEntry } from '../types';

/** Minimal in-memory Redis mock satisfying the RedisClient interface. */
function makeRedisClient() {
  const store = new Map<string, { value: string; expiresAt: number }>();
  const client: RedisClient & { store: typeof store } = {
    store,
    async get(key: string) {
      const entry = store.get(key);
      if (!entry || Date.now() > entry.expiresAt) {
        return null;
      }
      return entry.value;
    },
    async set(key: string, value: string, _exMode: 'EX', ttlSeconds: number) {
      store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    },
    async keys(pattern: string) {
      const prefix = pattern.slice(0, -1); // strip trailing '*'
      return [...store.keys()].filter((k) => k.startsWith(prefix));
    },
    async del(...keys: string[]) {
      for (const key of keys) {
        store.delete(key);
      }
    },
  };
  return client;
}

const ENTRY: CacheEntry = { rows: [{ id: 1, amount: 10 }], cachedAt: 1_000 };

describe('RedisCacheProvider', () => {
  it('returns undefined for a missing key', async () => {
    const provider = new RedisCacheProvider(makeRedisClient());
    expect(await provider.get('missing')).toBeUndefined();
  });

  it('stores and retrieves a cache entry (JSON roundtrip)', async () => {
    const provider = new RedisCacheProvider(makeRedisClient());
    await provider.set('k1', ENTRY);
    expect(await provider.get('k1')).toEqual(ENTRY);
  });

  it('returns undefined for a corrupt (non-JSON) entry instead of throwing', async () => {
    const redis = makeRedisClient();
    await redis.set('k1', 'not-json{', 'EX', 60);
    const provider = new RedisCacheProvider(redis);
    expect(await provider.get('k1')).toBeUndefined();
  });

  describe('TTL', () => {
    it('uses the 60s default TTL when none is provided', async () => {
      const redis = makeRedisClient();
      const provider = new RedisCacheProvider(redis);
      await provider.set('k1', ENTRY);
      expect(redis.store.get('k1')?.expiresAt).toBeGreaterThanOrEqual(Date.now() + 59_000);
    });

    it('honors a constructor defaultTtlSeconds', async () => {
      const redis = makeRedisClient();
      const provider = new RedisCacheProvider(redis, { defaultTtlSeconds: 10 });
      await provider.set('k1', ENTRY);
      const expiresAt = redis.store.get('k1')?.expiresAt ?? 0;
      expect(expiresAt).toBeGreaterThanOrEqual(Date.now() + 9_000);
      expect(expiresAt).toBeLessThan(Date.now() + 30_000);
    });

    it('honors a per-call ttlSeconds override', async () => {
      const redis = makeRedisClient();
      const provider = new RedisCacheProvider(redis, { defaultTtlSeconds: 60 });
      await provider.set('k1', ENTRY, 5);
      expect(redis.store.get('k1')?.expiresAt).toBeLessThan(Date.now() + 10_000);
    });
  });

  describe('keyPrefix namespacing', () => {
    it('applies the prefix to the underlying store but not to the logical key', async () => {
      const redis = makeRedisClient();
      const provider = new RedisCacheProvider(redis, { keyPrefix: 'studio:prod:' });
      await provider.set('k1', ENTRY);
      expect(redis.store.has('studio:prod:k1')).toBe(true);
      expect(redis.store.has('k1')).toBe(false);
      expect(await provider.get('k1')).toEqual(ENTRY);
    });
  });

  describe('invalidatePrefix', () => {
    it('removes only entries matching the prefix', async () => {
      const provider = new RedisCacheProvider(makeRedisClient());
      await provider.set('studio:v1:acme:a', ENTRY);
      await provider.set('studio:v1:acme:b', ENTRY);
      await provider.set('studio:v1:globex:a', ENTRY);

      await provider.invalidatePrefix('studio:v1:acme:');

      expect(await provider.get('studio:v1:acme:a')).toBeUndefined();
      expect(await provider.get('studio:v1:acme:b')).toBeUndefined();
      expect(await provider.get('studio:v1:globex:a')).toEqual(ENTRY);
    });

    it('is a no-op when no keys match (does not call del with empty args)', async () => {
      const redis = makeRedisClient();
      let delCalls = 0;
      const originalDel = redis.del.bind(redis);
      redis.del = async (...keys: string[]) => {
        delCalls += 1;
        return originalDel(...keys);
      };
      const provider = new RedisCacheProvider(redis);
      await provider.set('k1', ENTRY);
      await provider.invalidatePrefix('no-match:');
      expect(delCalls).toBe(0);
      expect(await provider.get('k1')).toEqual(ENTRY);
    });

    it('combines keyPrefix with the invalidation prefix', async () => {
      const redis = makeRedisClient();
      const provider = new RedisCacheProvider(redis, { keyPrefix: 'p:' });
      await provider.set('acme:a', ENTRY);
      await provider.set('globex:a', ENTRY);
      await provider.invalidatePrefix('acme:');
      expect(await provider.get('acme:a')).toBeUndefined();
      expect(await provider.get('globex:a')).toEqual(ENTRY);
    });
  });
});
