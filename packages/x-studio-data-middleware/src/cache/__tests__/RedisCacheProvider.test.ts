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
  let scanSnapshot: string[] = [];

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
      // The match set is snapshotted at cursor '0' and paged from there, so
      // DELETING keys mid-iteration doesn't shift the remaining pages — the
      // guarantee real Redis gives ("every key present for the whole iteration
      // is returned at least once") and the one `invalidatePrefix` relies on now
      // that it deletes each page as it arrives instead of accumulating.
      if (cursor === '0') {
        scanSnapshot = [...store.keys()].filter((k) => k.startsWith(prefix));
      }
      // Simulate cursor pagination: one key per "page" to exercise the loop.
      const pageSize = 1;
      const start = Number(cursor);
      const page = scanSnapshot.slice(start, start + pageSize);
      const nextCursor = start + pageSize >= scanSnapshot.length ? '0' : String(start + pageSize);
      return { cursor: nextCursor, keys: page };
    },
  };
  return { client, sets, expiries };
}

/**
 * Redis mock that records the ARGUMENT COUNT of every `del` call and refuses —
 * the way V8's spread/`apply` argument limit refuses — any call carrying more
 * than `delArgLimit` keys, throwing the same `RangeError` a real client would.
 *
 * It also paginates `SCAN` over a snapshot taken at cursor `'0'` (matching
 * Redis's "every key present for the whole iteration is returned at least once"
 * guarantee even as the caller deletes each page), so a test can observe that
 * deletion is interleaved with scanning rather than deferred to one final call.
 */
function makeArgCountingRedisClient(options: { delArgLimit: number; scanPageSize: number }) {
  const store = new Map<string, { value: string; expiresAt: number }>();
  const sets = new Map<string, Set<string>>();
  const delCallSizes: number[] = [];
  const ops: string[] = [];
  let snapshot: string[] = [];

  const client: RedisClient & {
    store: typeof store;
    sets: typeof sets;
    delCallSizes: number[];
    ops: string[];
  } = {
    store,
    sets,
    delCallSizes,
    ops,
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
    async del(...keys: string[]) {
      delCallSizes.push(keys.length);
      ops.push('del');
      if (keys.length > options.delArgLimit) {
        // Exactly how the pre-fix `del(...keys)` failed: thrown by the ENGINE,
        // before Redis is ever contacted, so nothing at all is invalidated.
        throw new RangeError('Maximum call stack size exceeded');
      }
      for (const key of keys) {
        store.delete(key);
        sets.delete(key);
      }
    },
    async expire() {},
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
      }
    },
    async scan(cursor: string, ...args: unknown[]) {
      ops.push('scan');
      const pattern = String(args[1] ?? '*');
      const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
      if (cursor === '0') {
        snapshot = [...store.keys()].filter((k) => k.startsWith(prefix));
      }
      const start = Number(cursor);
      const page = snapshot.slice(start, start + options.scanPageSize);
      const next =
        start + options.scanPageSize >= snapshot.length
          ? '0'
          : String(start + options.scanPageSize);
      return [next, page] as [string, string[]];
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

    // Regression (finding 3.4): the reverse key→tags index (`__ktag__:`) must be
    // namespaced by `keyPrefix`, exactly like the forward tag→keys index
    // (`__tag__:`). Two deployments sharing one Redis with different keyPrefixes
    // otherwise collide their `__ktag__:` keys in a shared, un-prefixed namespace.
    it('namespaces BOTH the forward (__tag__) and reverse (__ktag__) tag indexes with keyPrefix', async () => {
      const redis = makeRedisClientWithTags();
      const provider = new RedisCacheProvider(redis, { keyPrefix: 'studio:prod:' });
      await provider.set('k1', ENTRY, { tags: ['sales'] });

      const indexKeys = [...redis.sets.keys()];
      // Forward index carries the prefix (already did before the fix)…
      expect(indexKeys).toContain('studio:prod:__tag__:sales');
      // …and now the reverse index does too — no bare `__ktag__:` key exists.
      expect(indexKeys.some((k) => k.startsWith('studio:prod:__ktag__:'))).toBe(true);
      expect(indexKeys.some((k) => k.startsWith('__ktag__:'))).toBe(false);
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

  describe('invalidatePrefix escapes Redis glob metacharacters (finding 3.1)', () => {
    // A Redis-glob-aware mock: unlike `makeRedisClient` (naive `startsWith` after
    // stripping a trailing `*`), this interprets `*`/`?` as wildcards and honors
    // backslash escaping — so it can actually distinguish an ESCAPED literal `\*`
    // from an unescaped wildcard `*`, which is exactly what this fix turns on.
    function globToRegExp(pattern: string): RegExp {
      const escapeLiteral = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      let re = '^';
      for (let i = 0; i < pattern.length; i += 1) {
        const c = pattern[i];
        if (c === '\\') {
          i += 1;
          const next = pattern[i];
          re += next === undefined ? '\\\\' : escapeLiteral(next);
        } else if (c === '*') {
          re += '.*';
        } else if (c === '?') {
          re += '.';
        } else {
          re += escapeLiteral(c);
        }
      }
      return new RegExp(`${re}$`);
    }

    function makeGlobAwareRedisClient() {
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
          const re = globToRegExp(pattern);
          return [...store.keys()].filter((k) => re.test(k));
        },
        async del(...keys: string[]) {
          for (const key of keys) {
            store.delete(key);
          }
        },
      };
      return client;
    }

    it('does not over-evict a sibling tenant when the tenant id contains "*"', async () => {
      const provider = new RedisCacheProvider(makeGlobAwareRedisClient());
      // Tenant `ac*e` literally has a Redis glob wildcard in its id. An unescaped
      // MATCH glob `studio:v1:ac*e:*` would ALSO match tenant `acme` (and `acXe`,
      // `ace`, …), evicting unrelated tenants' entries (over-eviction).
      await provider.set('studio:v1:ac*e:q1', ENTRY);
      await provider.set('studio:v1:acme:q1', ENTRY);
      await provider.set('studio:v1:ace:q1', ENTRY);

      await provider.invalidatePrefix('studio:v1:ac*e:');

      // Only the `ac*e` tenant's own key is evicted…
      expect(await provider.get('studio:v1:ac*e:q1')).toBeUndefined();
      // …the sibling tenants a naive glob would have swept up are untouched.
      expect(await provider.get('studio:v1:acme:q1')).toEqual(ENTRY);
      expect(await provider.get('studio:v1:ace:q1')).toEqual(ENTRY);
    });

    it('still evicts the intended keys when the tenant id contains a "?"', async () => {
      const provider = new RedisCacheProvider(makeGlobAwareRedisClient());
      await provider.set('studio:v1:a?c:q1', ENTRY);
      await provider.set('studio:v1:abc:q1', ENTRY); // `?` glob would match this

      await provider.invalidatePrefix('studio:v1:a?c:');

      expect(await provider.get('studio:v1:a?c:q1')).toBeUndefined();
      expect(await provider.get('studio:v1:abc:q1')).toEqual(ENTRY);
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

  // ── Batched DEL / streamed SCAN (finding M1) ────────────────────────────────
  //
  // Regression: both invalidation paths spread an UNBOUNDED key list into a
  // single variadic `del(...keys)`. Past V8's spread-argument limit that throws
  // `RangeError: Maximum call stack size exceeded` before Redis is contacted, so
  // nothing is invalidated at all — and `handleMutation` swallows it as a
  // best-effort warning while still reporting the write as `ok: true`, leaving
  // every subsequent read stale for the full TTL. The failure grows with the
  // deployment: the forward tag index accumulates one member per
  // (tenant × security profile × query shape) inside a single TTL window.
  describe('large-scale invalidation (finding M1)', () => {
    const KEY_COUNT = 1_200;

    it('deleteByTag drains a tag set far larger than one variadic DEL can carry', async () => {
      const redis = makeArgCountingRedisClient({ delArgLimit: 600, scanPageSize: 100 });
      const provider = new RedisCacheProvider(redis);
      for (let i = 0; i < KEY_COUNT; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await provider.set(`k${i}`, ENTRY, { tags: ['orders'] });
      }

      // Pre-fix this rejected with RangeError (2 * 1200 + 1 arguments in one call).
      await provider.deleteByTag('orders');

      expect(Math.max(...redis.delCallSizes)).toBeLessThanOrEqual(500);
      expect(await provider.get('k0')).toBeUndefined();
      expect(await provider.get(`k${KEY_COUNT - 1}`)).toBeUndefined();
      // Every data key AND its reverse index is gone.
      expect(redis.store.size).toBe(0);
      expect(redis.sets.has('__tag__:orders')).toBe(false);
    });

    it('invalidatePrefix deletes a huge matching keyspace in batches', async () => {
      const redis = makeArgCountingRedisClient({ delArgLimit: 600, scanPageSize: 100 });
      const provider = new RedisCacheProvider(redis);
      for (let i = 0; i < KEY_COUNT; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await provider.set(`studio:v1:acme:${i}`, ENTRY, { tags: ['orders'] });
      }
      await provider.set('studio:v1:globex:1', ENTRY);

      await provider.invalidatePrefix('studio:v1:acme:');

      expect(Math.max(...redis.delCallSizes)).toBeLessThanOrEqual(500);
      expect(await provider.get('studio:v1:acme:0')).toBeUndefined();
      expect(await provider.get(`studio:v1:acme:${KEY_COUNT - 1}`)).toBeUndefined();
      // The sibling tenant is untouched.
      expect(await provider.get('studio:v1:globex:1')).toEqual(ENTRY);
    });

    it('invalidatePrefix STREAMS — it deletes each SCAN page instead of accumulating every key', async () => {
      const redis = makeArgCountingRedisClient({ delArgLimit: 600, scanPageSize: 100 });
      const provider = new RedisCacheProvider(redis);
      for (let i = 0; i < 350; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await provider.set(`studio:v1:acme:${i}`, ENTRY);
      }
      redis.ops.length = 0;

      await provider.invalidatePrefix('studio:v1:acme:');

      // A `del` must appear BEFORE the final `scan`: the accumulating
      // implementation issued every `scan` first and only then a single `del`.
      const lastScan = redis.ops.lastIndexOf('scan');
      const firstDel = redis.ops.indexOf('del');
      expect(firstDel).toBeGreaterThanOrEqual(0);
      expect(firstDel).toBeLessThan(lastScan);
    });
  });

  // ── Cache-entry shape validation (finding L5) ───────────────────────────────
  //
  // Regression: `JSON.parse(raw) as CacheEntry` is an assertion, not a
  // validation. Any value that merely PARSES — a host key colliding with ours
  // when no `keyPrefix` is set, or a partially-written value — was served as a
  // cache HIT and handed to the read path as a result set.
  describe('entry shape validation (finding L5)', () => {
    const foreignValues: Array<[string, string]> = [
      ['a foreign object with no rows', '{"session":"abc","user":42}'],
      ['a JSON array', '[1,2,3]'],
      ['a bare number', '42'],
      ['a bare string', '"hello"'],
      ['null', 'null'],
      ['an entry whose rows is not an array', '{"rows":{"0":{"id":1}},"cachedAt":1}'],
    ];

    for (const [label, raw] of foreignValues) {
      it(`treats ${label} as a MISS instead of a hit`, async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const redis = makeRedisClient();
        await redis.set('k1', raw, 'EX', 60);
        const provider = new RedisCacheProvider(redis);

        expect(await provider.get('k1')).toBeUndefined();
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toContain('MUI X Studio Server');
        expect(warnSpy.mock.calls[0][0]).toContain('not a CacheEntry');
        warnSpy.mockRestore();
      });
    }

    it('warns at most once per provider, however many foreign values it reads', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const redis = makeRedisClient();
      await redis.set('k1', '{"session":"abc"}', 'EX', 60);
      await redis.set('k2', '{"session":"def"}', 'EX', 60);
      const provider = new RedisCacheProvider(redis);

      await provider.get('k1');
      await provider.get('k2');
      await provider.get('k1');

      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it('still returns a well-formed entry (including an empty rows array)', async () => {
      const provider = new RedisCacheProvider(makeRedisClient());
      const empty: CacheEntry = { rows: [], cachedAt: 5 };
      await provider.set('k1', empty);
      expect(await provider.get('k1')).toEqual(empty);
    });
  });
});
