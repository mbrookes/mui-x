/**
 * Cross-provider parity test for `ttlMs: 0` (finding 2.1).
 *
 * Extends the existing Redis-only parity coverage — `RedisCacheProvider.test.ts`'s
 * "ttlMs: 0 (finding 10 — parity with RedisTierCacheProvider)" describe block —
 * to ALL FOUR shipped cache providers.
 *
 * Before the fix, `LRUCacheProvider` and `MapTierCacheProvider` passed
 * `{ ttl: opts.ttlMs }` straight through to `lru-cache`, which treats a zero TTL
 * as "never expires" — the OPPOSITE of what `ttlMs: 0` means on the Redis-backed
 * providers (`RedisCacheProvider` / `RedisTierCacheProvider`), which floor it to
 * a 1-second expiry rather than send Redis an invalid `EX 0` or treat it as
 * immortal. A host that swapped a single-node deployment for a multi-node one
 * (or vice versa) would silently change what `ttlMs: 0` means.
 *
 * This test pins that all four now agree: `ttlMs: 0` floors to a short, FINITE
 * TTL (`MIN_TTL_MS`, matching the Redis providers' 1-second floor) — never
 * "never expires".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LRUCacheProvider } from '../LRUCacheProvider';
import { MapTierCacheProvider } from '../MapTierCacheProvider';
import { RedisCacheProvider, type RedisClient } from '../RedisCacheProvider';
import { RedisTierCacheProvider } from '../RedisTierCacheProvider';
import { MIN_TTL_MS } from '../ttl';
import type { CacheEntry, TierEntry } from '../types';

/**
 * Minimal in-memory Redis mock satisfying the `RedisClient` interface (mirrors
 * `RedisCacheProvider.test.ts`'s helper). Uses `Date.now()` for expiry, so it
 * plays nicely with `vi.useFakeTimers` in these tests.
 */
function makeRedisClient(): RedisClient {
  const store = new Map<string, { value: string; expiresAt: number }>();
  return {
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
      for (const key of keys) {
        store.delete(key);
      }
    },
  };
}

const ENTRY: CacheEntry = { rows: [{ id: 1 }], cachedAt: 0 };
const TIER_ENTRY: TierEntry = { tier: 'server', rowCount: 42 };

describe('ttlMs: 0 — cross-provider parity across all four shipped cache providers', () => {
  beforeEach(() => {
    // `lru-cache` uses `performance.now()` as its clock source (see
    // LRUCacheProvider.test.ts for why `performance.now` is monkey-patched
    // rather than faked wholesale).
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('every provider expires a ttlMs: 0 entry once MIN_TTL_MS elapses — none are immortal', async () => {
    const lru = new LRUCacheProvider();
    const mapTier = new MapTierCacheProvider();
    const redisData = new RedisCacheProvider(makeRedisClient());
    const redisTier = new RedisTierCacheProvider(makeRedisClient());

    await lru.set('k1', ENTRY, { ttlMs: 0 });
    await mapTier.set('k1', TIER_ENTRY, 0);
    await redisData.set('k1', ENTRY, { ttlMs: 0 });
    await redisTier.set('k1', TIER_ENTRY, 0);

    // All four are present immediately after the write.
    expect(await lru.get('k1')).toBeDefined();
    expect(await mapTier.get('k1')).toBeDefined();
    expect(await redisData.get('k1')).toBeDefined();
    expect(await redisTier.get('k1')).toBeDefined();

    // Advance just past the 1-second floor — every provider must have expired
    // the entry. Before the fix, `lru`/`mapTier` would still report it here
    // (immortal), diverging from the Redis providers.
    vi.advanceTimersByTime(MIN_TTL_MS + 100);

    expect(await lru.get('k1')).toBeUndefined();
    expect(await mapTier.get('k1')).toBeUndefined();
    expect(await redisData.get('k1')).toBeUndefined();
    expect(await redisTier.get('k1')).toBeUndefined();
  });

  it('LRUCacheProvider and MapTierCacheProvider do not expire a ttlMs: 0 entry BEFORE the floor elapses', async () => {
    const lru = new LRUCacheProvider();
    const mapTier = new MapTierCacheProvider();

    await lru.set('k1', ENTRY, { ttlMs: 0 });
    await mapTier.set('k1', TIER_ENTRY, 0);

    vi.advanceTimersByTime(MIN_TTL_MS - 100);
    expect(await lru.get('k1')).toBeDefined();
    expect(await mapTier.get('k1')).toBeDefined();
  });
});
