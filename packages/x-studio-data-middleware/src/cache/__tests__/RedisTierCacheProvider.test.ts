/**
 * Unit tests for `RedisTierCacheProvider`.
 *
 * Mirrors the coverage added for its sibling `RedisCacheProvider`: get/set
 * roundtrip, TTL handling, keyPrefix namespacing, SCAN-based invalidatePrefix
 * (not the blocking KEYS command), and compatibility with a node-redis
 * v4-shaped client (options-object `set()`, `{cursor, keys}` SCAN replies).
 */
import { describe, it, expect, vi } from 'vitest';
import { RedisTierCacheProvider } from '../RedisTierCacheProvider';
import type { RedisClient } from '../RedisCacheProvider';
import type { TierEntry } from '../types';

/** ioredis-shaped in-memory mock: positional `set(key, value, 'EX', ttl)`, tuple SCAN replies. */
function makeIoredisClient() {
  const store = new Map<string, { value: string; expiresAt: number }>();
  const delCallSizes: number[] = [];
  let scanSnapshot: string[] = [];
  const client: RedisClient & { store: typeof store; delCallSizes: number[] } = {
    delCallSizes,
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
      const prefix = pattern.slice(0, -1);
      return [...store.keys()].filter((k) => k.startsWith(prefix));
    },
    async del(...keys: string[]) {
      delCallSizes.push(keys.length);
      for (const key of keys) {
        store.delete(key);
      }
    },
    async scan(cursor: string, ...args: unknown[]) {
      // ioredis shape: scan(cursor, 'MATCH', pattern, 'COUNT', count) -> [cursor, keys]
      const matchIndex = args.indexOf('MATCH');
      const pattern = (matchIndex >= 0 ? (args[matchIndex + 1] as string) : '*') ?? '*';
      const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
      // Snapshot the match set at cursor '0' and page from there, so deleting
      // keys mid-iteration doesn't shift the remaining pages — real Redis's own
      // SCAN guarantee, and what `invalidatePrefix` relies on now that it
      // deletes each page as it arrives instead of accumulating every key.
      if (cursor === '0') {
        scanSnapshot = [...store.keys()].filter((k) => k.startsWith(prefix));
      }
      const start = Number(cursor);
      const page = scanSnapshot.slice(start, start + 1);
      const nextCursor = start + 1 >= scanSnapshot.length ? '0' : String(start + 1);
      return [nextCursor, page] as [string, string[]];
    },
  };
  return client;
}

/** node-redis v4-shaped mock: `set(key, value, { EX })`, `{cursor, keys}` SCAN replies. */
function makeNodeRedisV4Client() {
  const store = new Map<string, { value: string; expiresAt: number }>();
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
      const ttlSeconds = opts?.EX ?? 300;
      store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    },
    async del(...keys: string[]) {
      for (const key of keys) {
        store.delete(key);
      }
    },
    async sAdd() {
      // Not used by RedisTierCacheProvider — present only for interface shape.
    },
    async scan(cursor: string, ...args: unknown[]) {
      const opts = args[0] as { MATCH?: string; COUNT?: number } | undefined;
      const pattern = opts?.MATCH ?? '*';
      const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
      // Snapshot at cursor '0' — see the ioredis mock above for why.
      if (cursor === '0') {
        scanSnapshot = [...store.keys()].filter((k) => k.startsWith(prefix));
      }
      const start = Number(cursor);
      const page = scanSnapshot.slice(start, start + 1);
      const nextCursor = start + 1 >= scanSnapshot.length ? '0' : String(start + 1);
      return { cursor: nextCursor, keys: page };
    },
  };
  return client;
}

const ENTRY: TierEntry = { tier: 'server', rowCount: 55_000 };

describe('RedisTierCacheProvider', () => {
  it('returns undefined for a missing key', async () => {
    const provider = new RedisTierCacheProvider(makeIoredisClient());
    expect(await provider.get('missing')).toBeUndefined();
  });

  it('stores and retrieves a tier entry (JSON roundtrip)', async () => {
    const provider = new RedisTierCacheProvider(makeIoredisClient());
    await provider.set('k1', ENTRY);
    expect(await provider.get('k1')).toEqual(ENTRY);
  });

  describe('TTL', () => {
    it('uses the 300s default when none is provided', async () => {
      const redis = makeIoredisClient();
      const provider = new RedisTierCacheProvider(redis);
      await provider.set('k1', ENTRY);
      expect(redis.store.get('k1')?.expiresAt).toBeGreaterThanOrEqual(Date.now() + 299_000);
    });

    it('honors a per-call ttlMs override, rounding up to whole seconds and at least 1s', async () => {
      const redis = makeIoredisClient();
      const provider = new RedisTierCacheProvider(redis);
      await provider.set('k1', ENTRY, 0); // must not send "EX 0" (a Redis error)
      const expiresAt = redis.store.get('k1')?.expiresAt ?? 0;
      expect(expiresAt).toBeGreaterThanOrEqual(Date.now() + 900);
      expect(expiresAt).toBeLessThan(Date.now() + 2_000);
    });

    it('honors a constructor defaultTtlSeconds override', async () => {
      const redis = makeIoredisClient();
      const provider = new RedisTierCacheProvider(redis, { defaultTtlSeconds: 10 });
      await provider.set('k1', ENTRY);
      expect(redis.store.get('k1')?.expiresAt).toBeGreaterThanOrEqual(Date.now() + 9_000);
      expect(redis.store.get('k1')?.expiresAt).toBeLessThan(Date.now() + 30_000);
    });
  });

  describe('keyPrefix namespacing', () => {
    it('applies the prefix to the underlying store but not to the logical key', async () => {
      const redis = makeIoredisClient();
      const provider = new RedisTierCacheProvider(redis, { keyPrefix: 'studio:' });
      await provider.set('k1', ENTRY);
      expect(redis.store.has('studio:k1')).toBe(true);
      expect(redis.store.has('k1')).toBe(false);
      expect(await provider.get('k1')).toEqual(ENTRY);
    });
  });

  describe('node-redis v4 client compatibility', () => {
    it('writes via the { EX } options-object set() form', async () => {
      const redis = makeNodeRedisV4Client();
      const provider = new RedisTierCacheProvider(redis);

      await provider.set('k1', ENTRY, 5_000);

      const stored = redis.store.get('k1');
      expect(stored).toBeDefined();
      expect(await provider.get('k1')).toEqual(ENTRY);
    });
  });

  describe('invalidatePrefix', () => {
    it('removes only entries matching the prefix', async () => {
      const provider = new RedisTierCacheProvider(makeIoredisClient());
      await provider.set('studio:v1:acme:a', ENTRY);
      await provider.set('studio:v1:acme:b', ENTRY);
      await provider.set('studio:v1:globex:a', ENTRY);

      await provider.invalidatePrefix('studio:v1:acme:');

      expect(await provider.get('studio:v1:acme:a')).toBeUndefined();
      expect(await provider.get('studio:v1:acme:b')).toBeUndefined();
      expect(await provider.get('studio:v1:globex:a')).toEqual(ENTRY);
    });

    it('uses SCAN (cursor iteration), not KEYS, against an ioredis-shaped client', async () => {
      const redis = makeIoredisClient();
      const scanSpy = vi.spyOn(redis, 'scan');
      const provider = new RedisTierCacheProvider(redis);

      await provider.set('studio:v1:acme:a', ENTRY);
      await provider.set('studio:v1:acme:b', ENTRY);
      await provider.set('studio:v1:acme:c', ENTRY);

      await provider.invalidatePrefix('studio:v1:acme:');

      expect(scanSpy.mock.calls.length).toBeGreaterThan(1);
      expect(await provider.get('studio:v1:acme:a')).toBeUndefined();
      expect(await provider.get('studio:v1:acme:c')).toBeUndefined();
    });

    it('uses SCAN against a node-redis-v4-shaped client', async () => {
      const redis = makeNodeRedisV4Client();
      const scanSpy = vi.spyOn(redis, 'scan');
      const provider = new RedisTierCacheProvider(redis);

      await provider.set('studio:v1:acme:a', ENTRY);
      await provider.set('studio:v1:acme:b', ENTRY);

      await provider.invalidatePrefix('studio:v1:acme:');

      expect(scanSpy).toHaveBeenCalled();
      expect(await provider.get('studio:v1:acme:a')).toBeUndefined();
      expect(await provider.get('studio:v1:acme:b')).toBeUndefined();
    });

    it('is a no-op when no keys match', async () => {
      const redis = makeIoredisClient();
      const provider = new RedisTierCacheProvider(redis);
      await provider.set('k1', ENTRY);
      await provider.invalidatePrefix('no-match:');
      expect(await provider.get('k1')).toEqual(ENTRY);
    });

    // Regression (finding M1, sibling site of `RedisCacheProvider`): the matched
    // key list was accumulated whole and spread into ONE variadic `del(...keys)`,
    // which throws `RangeError: Maximum call stack size exceeded` past V8's
    // argument limit — before Redis is contacted, so nothing is evicted.
    it('deletes a large matching keyspace in bounded batches, never one huge DEL', async () => {
      const redis = makeIoredisClient();
      const provider = new RedisTierCacheProvider(redis);
      for (let i = 0; i < 1_200; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await provider.set(`studio:v1:acme:${i}`, ENTRY);
      }
      await provider.set('studio:v1:globex:1', ENTRY);

      await provider.invalidatePrefix('studio:v1:acme:');

      expect(Math.max(...redis.delCallSizes)).toBeLessThanOrEqual(500);
      expect(await provider.get('studio:v1:acme:0')).toBeUndefined();
      expect(await provider.get('studio:v1:acme:1199')).toBeUndefined();
      expect(await provider.get('studio:v1:globex:1')).toEqual(ENTRY);
    });
  });

  // ── Tier-entry shape validation (finding L5, sibling site) ──────────────────
  //
  // `JSON.parse(raw) as TierEntry` is an assertion, not a validation: a foreign
  // value sharing the keyspace (including a `CacheEntry` written by a
  // `RedisCacheProvider` on the same client) parsed cleanly and was used to ROUTE
  // the query, skipping the COUNT(*) preflight on a bogus tier.
  describe('entry shape validation (finding L5)', () => {
    const foreignValues: Array<[string, string]> = [
      ['a data-cache CacheEntry', '{"rows":[{"id":1}],"cachedAt":1}'],
      ['an unknown tier', '{"tier":"quantum","rowCount":5}'],
      ['a non-numeric rowCount', '{"tier":"server","rowCount":"lots"}'],
      ['a JSON array', '[1,2,3]'],
      ['a bare number', '42'],
    ];

    for (const [label, raw] of foreignValues) {
      it(`treats ${label} as a MISS instead of a hit`, async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const redis = makeIoredisClient();
        await redis.set('k1', raw, 'EX', 300);
        const provider = new RedisTierCacheProvider(redis);

        expect(await provider.get('k1')).toBeUndefined();
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toContain('MUI X Studio Server');
        expect(warnSpy.mock.calls[0][0]).toContain('not a TierEntry');
        warnSpy.mockRestore();
      });
    }

    it('still returns every valid tier', async () => {
      const provider = new RedisTierCacheProvider(makeIoredisClient());
      for (const tier of ['client', 'server', 'db'] as const) {
        const entry: TierEntry = { tier, rowCount: 0 };
        // eslint-disable-next-line no-await-in-loop
        await provider.set(tier, entry);
        // eslint-disable-next-line no-await-in-loop
        expect(await provider.get(tier)).toEqual(entry);
      }
    });
  });
});
