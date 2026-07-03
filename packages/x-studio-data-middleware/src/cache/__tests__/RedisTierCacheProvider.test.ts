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
      const prefix = pattern.slice(0, -1);
      return [...store.keys()].filter((k) => k.startsWith(prefix));
    },
    async del(...keys: string[]) {
      for (const key of keys) {
        store.delete(key);
      }
    },
    async scan(cursor: string, ...args: unknown[]) {
      // ioredis shape: scan(cursor, 'MATCH', pattern, 'COUNT', count) -> [cursor, keys]
      const matchIndex = args.indexOf('MATCH');
      const pattern = (matchIndex >= 0 ? (args[matchIndex + 1] as string) : '*') ?? '*';
      const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
      const allKeys = [...store.keys()].filter((k) => k.startsWith(prefix));
      const start = Number(cursor);
      const page = allKeys.slice(start, start + 1);
      const nextCursor = start + 1 >= allKeys.length ? '0' : String(start + 1);
      return [nextCursor, page] as [string, string[]];
    },
  };
  return client;
}

/** node-redis v4-shaped mock: `set(key, value, { EX })`, `{cursor, keys}` SCAN replies. */
function makeNodeRedisV4Client() {
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
      const allKeys = [...store.keys()].filter((k) => k.startsWith(prefix));
      const start = Number(cursor);
      const page = allKeys.slice(start, start + 1);
      const nextCursor = start + 1 >= allKeys.length ? '0' : String(start + 1);
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
  });
});
