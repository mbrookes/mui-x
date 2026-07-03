/**
 * Unit tests for `RedisCacheProvider`.
 *
 * The data CacheProvider Redis implementation was untested (only its tier-cache
 * sibling, `RedisTierCacheProvider`, had coverage). These tests verify the
 * get/set roundtrip, TTL handling, key-prefix namespacing, prefix invalidation,
 * and graceful handling of corrupt cache entries — all against an in-memory
 * Redis mock so no Redis server is required.
 */
import { describe, it, expect, vi } from 'vitest';
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

/** Redis mock with optional SET commands for tag-based invalidation. */
function makeRedisClientWithTags() {
  const base = makeRedisClient();
  const sets = new Map<string, Set<string>>();
  return {
    ...base,
    sets,
    async sadd(key: string, ...members: string[]) {
      let set = sets.get(key);
      if (!set) {
        set = new Set<string>();
        sets.set(key, set);
      }
      for (const m of members) {
        set.add(m);
      }
    },
    async smembers(key: string) {
      return [...(sets.get(key) ?? [])];
    },
    async srem(key: string, ...members: string[]) {
      const set = sets.get(key);
      if (set) {
        for (const m of members) {
          set.delete(m);
        }
        if (set.size === 0) {
          sets.delete(key);
        }
      }
    },
    async del(...keys: string[]) {
      for (const key of keys) {
        base.store.delete(key);
        sets.delete(key);
      }
    },
  };
}

/**
 * Minimal in-memory mock shaped like a real **node-redis v4** client:
 *   - `set(key, value, { EX: seconds })` — options-object TTL, not positional.
 *   - camelCase `sAdd`/`sMembers`/`sRem` (single-array-arg for sAdd/sRem),
 *     not the ioredis lowercase/rest-args shape.
 *   - `expire(key, seconds)` — same name as ioredis.
 *   - `scan(cursor, { MATCH, COUNT })` → `{ cursor, keys }`, not a `[cursor, keys]` tuple.
 * Used to prove `RedisCacheProvider` actually works against this wire shape,
 * not just the ioredis-shaped mock used elsewhere in this file.
 */
function makeNodeRedisV4Client() {
  const store = new Map<string, { value: string; expiresAt: number }>();
  const sets = new Map<string, Set<string>>();
  const expiries = new Map<string, number>();

  const client: RedisClient & { store: typeof store } = {
    store,
    async get(key: string) {
      const entry = store.get(key);
      if (!entry || Date.now() > entry.expiresAt) {
        return null;
      }
      return entry.value;
    },
    async set(key: string, value: string, opts?: { EX?: number }) {
      const ttlSeconds = opts?.EX ?? 60;
      store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    },
    async del(...keys: string[]) {
      for (const key of keys) {
        store.delete(key);
        sets.delete(key);
        expiries.delete(key);
      }
    },
    async expire(key: string, seconds: number) {
      expiries.set(key, Date.now() + seconds * 1000);
    },
    async ttl(key: string) {
      // Redis TTL semantics: -2 if the key doesn't exist, -1 if it exists
      // with no expiry, else remaining seconds.
      const expiresAt = expiries.get(key);
      if (expiresAt === undefined) {
        return sets.has(key) || store.has(key) ? -1 : -2;
      }
      return Math.ceil((expiresAt - Date.now()) / 1000);
    },
    async sAdd(key: string, members: string | string[]) {
      let set = sets.get(key);
      if (!set) {
        set = new Set<string>();
        sets.set(key, set);
      }
      for (const m of Array.isArray(members) ? members : [members]) {
        set.add(m);
      }
    },
    async sMembers(key: string) {
      return [...(sets.get(key) ?? [])];
    },
    async sRem(key: string, members: string | string[]) {
      const set = sets.get(key);
      if (!set) {
        return;
      }
      for (const m of Array.isArray(members) ? members : [members]) {
        set.delete(m);
      }
      if (set.size === 0) {
        sets.delete(key);
      }
    },
    async scan(cursor: string, ...args: unknown[]) {
      // node-redis v4 shape: scan(cursor, { MATCH, COUNT }) → { cursor, keys }
      const opts = args[0] as { MATCH?: string; COUNT?: number } | undefined;
      const pattern = opts?.MATCH ?? '*';
      const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
      const allKeys = [...store.keys()].filter((k) => k.startsWith(prefix));
      // Simulate cursor pagination: one key per "page" to exercise the loop.
      const pageSize = 1;
      const start = Number(cursor);
      const page = allKeys.slice(start, start + pageSize);
      const nextCursor = start + pageSize >= allKeys.length ? '0' : String(start + pageSize);
      return { cursor: nextCursor, keys: page };
    },
  };
  return { client, sets, expiries };
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

    it('honors a per-call ttlMs override', async () => {
      const redis = makeRedisClient();
      const provider = new RedisCacheProvider(redis, { defaultTtlSeconds: 60 });
      await provider.set('k1', ENTRY, { ttlMs: 5_000 });
      expect(redis.store.get('k1')?.expiresAt).toBeLessThan(Date.now() + 10_000);
    });

    describe('ttlMs: 0 (finding 10 — parity with RedisTierCacheProvider)', () => {
      // `ttlMs: 0` naively rounds to `Math.ceil(0 / 1000)` = 0 seconds. Sending
      // that straight through as `SET key value EX 0` is a real Redis error
      // ("invalid expire time"). RedisCacheProvider.set (RedisCacheProvider.ts)
      // guards this with `Math.max(1, ttlSeconds)`, exactly like its sibling
      // RedisTierCacheProvider.set — this test locks in that both providers
      // treat `ttlMs: 0` identically (floor to 1 second), not "never expires"
      // (the lru-cache convention) and not a thrown error.
      it('floors to a minimum 1-second TTL instead of sending "EX 0"', async () => {
        const redis = makeRedisClient();
        let capturedTtlSeconds: number | undefined;
        const originalSet = redis.set.bind(redis);
        redis.set = async (key: string, value: string, _exMode: 'EX', ttlSeconds: number) => {
          capturedTtlSeconds = ttlSeconds;
          return originalSet(key, value, _exMode, ttlSeconds);
        };
        const provider = new RedisCacheProvider(redis);

        await provider.set('k1', ENTRY, { ttlMs: 0 });

        expect(capturedTtlSeconds).toBe(1); // never 0 — that's an invalid Redis EX value
        const expiresAt = redis.store.get('k1')?.expiresAt ?? 0;
        expect(expiresAt).toBeGreaterThanOrEqual(Date.now() + 900);
        expect(expiresAt).toBeLessThan(Date.now() + 2_000);
      });

      it('also floors to 1 second against a node-redis-v4-shaped client', async () => {
        const { client: redis } = makeNodeRedisV4Client();
        const provider = new RedisCacheProvider(redis);

        await provider.set('k1', ENTRY, { ttlMs: 0 });

        const stored = redis.store.get('k1');
        expect(stored).toBeDefined();
        expect(stored?.expiresAt).toBeGreaterThanOrEqual(Date.now() + 900);
        expect(stored?.expiresAt).toBeLessThan(Date.now() + 2_000);
      });
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

  describe('deleteByTag', () => {
    it('removes all entries associated with the tag and leaves others intact', async () => {
      const redis = makeRedisClientWithTags();
      const provider = new RedisCacheProvider(redis);
      await provider.set('k1', ENTRY, { tags: ['sales'] });
      await provider.set('k2', ENTRY, { tags: ['sales'] });
      await provider.set('k3', ENTRY, { tags: ['orders'] });

      await provider.deleteByTag('sales');

      expect(await provider.get('k1')).toBeUndefined();
      expect(await provider.get('k2')).toBeUndefined();
      expect(await provider.get('k3')).toEqual(ENTRY);
    });

    it('does not throw, and warns once, when the Redis client supports neither naming convention', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const redis = makeRedisClient(); // no sadd/sAdd, no smembers/sMembers
      const provider = new RedisCacheProvider(redis);
      await provider.set('k1', ENTRY);

      await provider.deleteByTag('sales'); // must not throw
      await provider.deleteByTag('orders'); // still must not throw

      expect(await provider.get('k1')).toEqual(ENTRY);
      // Warn once, not once per call — repeated no-ops shouldn't spam logs.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('MUI X Studio Server');
      warnSpy.mockRestore();
    });

    it('is a no-op when no keys are registered for the tag', async () => {
      const redis = makeRedisClientWithTags();
      const provider = new RedisCacheProvider(redis);
      await provider.set('k1', ENTRY, { tags: ['orders'] });
      await provider.deleteByTag('sales'); // unused tag
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

    it('cleans up the tag forward index when a tagged key is removed by prefix', async () => {
      const redis = makeRedisClientWithTags();
      const provider = new RedisCacheProvider(redis);
      await provider.set('studio:v1:acme:q1', ENTRY, { tags: ['sales'] });
      await provider.set('studio:v1:acme:q2', ENTRY, { tags: ['sales'] });
      await provider.set('studio:v1:globex:q1', ENTRY, { tags: ['sales'] });

      await provider.invalidatePrefix('studio:v1:acme:');

      // Acme keys gone; globex key still present
      expect(await provider.get('studio:v1:acme:q1')).toBeUndefined();
      expect(await provider.get('studio:v1:globex:q1')).toEqual(ENTRY);

      // After deleteByTag, only the globex key should have been in the forward index
      await provider.deleteByTag('sales');
      expect(await provider.get('studio:v1:globex:q1')).toBeUndefined();
    });

    it('uses SCAN (cursor iteration), not KEYS, when the client supports it', async () => {
      const { client: redis } = makeNodeRedisV4Client();
      const scanSpy = vi.spyOn(redis, 'scan');
      const provider = new RedisCacheProvider(redis);

      await provider.set('studio:v1:acme:a', ENTRY);
      await provider.set('studio:v1:acme:b', ENTRY);
      await provider.set('studio:v1:acme:c', ENTRY);
      await provider.set('studio:v1:globex:a', ENTRY);

      await provider.invalidatePrefix('studio:v1:acme:');

      // The fake node-redis client paginates one key per SCAN call, so
      // invalidating 3 matching keys must issue more than one SCAN round-trip.
      expect(scanSpy.mock.calls.length).toBeGreaterThan(1);
      expect(await provider.get('studio:v1:acme:a')).toBeUndefined();
      expect(await provider.get('studio:v1:acme:b')).toBeUndefined();
      expect(await provider.get('studio:v1:acme:c')).toBeUndefined();
      expect(await provider.get('studio:v1:globex:a')).toEqual(ENTRY);
    });
  });

  describe('node-redis v4 client compatibility', () => {
    it('writes via the { EX } options-object set() form, not the ioredis positional form', async () => {
      const { client: redis } = makeNodeRedisV4Client();
      const provider = new RedisCacheProvider(redis);

      await provider.set('k1', ENTRY, { ttlMs: 5_000 });

      const stored = redis.store.get('k1');
      expect(stored).toBeDefined();
      expect(stored?.expiresAt).toBeGreaterThan(Date.now());
      expect(await provider.get('k1')).toEqual(ENTRY);
    });

    it('deleteByTag actually deletes matching entries against a node-redis-v4-shaped client', async () => {
      const { client: redis } = makeNodeRedisV4Client();
      const provider = new RedisCacheProvider(redis);

      await provider.set('k1', ENTRY, { tags: ['sales'] });
      await provider.set('k2', ENTRY, { tags: ['sales'] });
      await provider.set('k3', ENTRY, { tags: ['orders'] });

      await provider.deleteByTag('sales');

      expect(await provider.get('k1')).toBeUndefined();
      expect(await provider.get('k2')).toBeUndefined();
      expect(await provider.get('k3')).toEqual(ENTRY);
    });

    it('does not warn about missing tag support against a node-redis v4 client', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { client: redis } = makeNodeRedisV4Client();
      const provider = new RedisCacheProvider(redis);

      await provider.set('k1', ENTRY, { tags: ['sales'] });
      await provider.deleteByTag('sales');

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe('tag/reverse-index expiry (finding 7 — unbounded Redis growth)', () => {
    it('applies an expiry to both the forward tag index and the reverse key->tags index', async () => {
      const { client: redis, expiries } = makeNodeRedisV4Client();
      const provider = new RedisCacheProvider(redis);

      await provider.set('k1', ENTRY, { tags: ['sales'], ttlMs: 10_000 });

      expect(expiries.has('__tag__:sales')).toBe(true);
      expect(expiries.has('__ktag__:k1')).toBe(true);
    });

    it('deleteByTag removes the reverse-index (__ktag__) key outright, not just the tag membership', async () => {
      const { client: redis, sets } = makeNodeRedisV4Client();
      const provider = new RedisCacheProvider(redis);

      await provider.set('k1', ENTRY, { tags: ['sales'] });
      expect(sets.has('__ktag__:k1')).toBe(true);

      await provider.deleteByTag('sales');

      // The whole reverse-index set for k1 must be gone, not merely missing 'sales'.
      expect(sets.has('__ktag__:k1')).toBe(false);
    });

    it('does not shorten the forward tag index TTL on a later short-TTL write for the same tag (finding 1.9)', async () => {
      const { client: redis, expiries } = makeNodeRedisV4Client();
      const provider = new RedisCacheProvider(redis);

      // Entry A: long TTL, tagged 'sales'.
      await provider.set('long-lived', ENTRY, { tags: ['sales'], ttlMs: 300_000 });
      const expiryAfterLongWrite = expiries.get('__tag__:sales');
      expect(expiryAfterLongWrite).toBeDefined();

      // Entry B: same tag, much shorter TTL, written afterward. Before the fix,
      // this unconditionally reset the shared forward index's expiry down to
      // B's 1s TTL — stranding A, which is still supposed to be tracked.
      await provider.set('short-lived', ENTRY, { tags: ['sales'], ttlMs: 1_000 });
      const expiryAfterShortWrite = expiries.get('__tag__:sales');

      // The index's expiry must never move backward — only extend, never shorten.
      expect(expiryAfterShortWrite).toBeGreaterThanOrEqual(expiryAfterLongWrite!);

      // And functionally: deleteByTag still finds and evicts the long-TTL
      // entry via the (still-alive) forward index, well after the short TTL
      // would have elapsed on its own.
      await provider.deleteByTag('sales');
      expect(await provider.get('long-lived')).toBeUndefined();
      expect(await provider.get('short-lived')).toBeUndefined();
    });
  });
});
