/**
 * Lightweight in-process tier routing cache.
 *
 * Stores routing tier + preflight row count in an `lru-cache` (the same
 * package `LRUCacheProvider` uses for the data cache), bounded by both entry
 * count and per-entry TTL. Suitable for single-node deployments. For
 * multi-node use, provide a Redis-backed `TierCacheProvider` implementation
 * to `HandleBatchQueryOptions`.
 *
 * Design rationale
 * ────────────────
 * The data cache TTL is typically 30 s. After it expires, every widget causes a
 * fresh COUNT(*) preflight. If the underlying dataset hasn't changed tier (e.g.,
 * a 50k-row table stays in the server tier), that preflight is wasted work.
 *
 * By caching the tier result for a longer window, we skip the COUNT(*) on
 * repeated cold misses and jump straight to `executeForTier`. The tier TTL
 * resets each time a fresh preflight is run.
 *
 * An earlier version of this provider hand-rolled a plain `Map` with manual
 * per-entry expiry and no size bound: expired entries were only removed when
 * that exact key was `get()` again, so a stream of unique query shapes (e.g.
 * one-off ad-hoc filter combinations) grew the map indefinitely — unlike the
 * byte-bounded `LRUCacheProvider` next to it. Backing this with `lru-cache`'s
 * `max` option fixes that: once `maxEntries` is reached, the least-recently-used
 * decision is evicted to make room for a new one.
 *
 * TTL defaults — reconciling the three numbers involved
 * ──────────────────────────────────────────────────────
 * There used to be three different "the default is 5 minutes" claims that
 * didn't actually agree in practice:
 *   - This provider's own default (`ttlMs` below), used only when `set()` is
 *     called without an explicit TTL — i.e. standalone usage outside `handler.ts`.
 *   - `handler.ts`'s `DEFAULT_TIER_CACHE_TTL_MS`, currently 30 seconds (aligned
 *     with the data cache default), which `handler.ts` always passes explicitly
 *     to `set()` — so in production this provider's own 300s default is never
 *     actually used.
 *   - `RedisTierCacheProvider`'s constructor default, also 300s, which has the
 *     same "standalone only" caveat.
 * All three are now documented accurately in their respective files instead of
 * implying a single universal 5-minute default.
 */
import { LRUCache } from 'lru-cache';
import type { TierEntry, TierCacheProvider } from './types';

interface MapTierCacheProviderOptions {
  /**
   * Maximum number of tier decisions to retain at once.
   * Default: 10,000 — bounds memory for a stream of unique query shapes;
   * the least-recently-used entry is evicted once this limit is reached.
   */
  maxEntries?: number;
  /**
   * Default TTL in milliseconds for `set()` calls that don't specify one.
   * Default: 300,000ms (5 min). Only used when `set()` is called without an
   * explicit `ttlMs` — see the module docblock for how this relates to
   * `handler.ts`'s own (30s) default, which is passed explicitly and does not
   * rely on this value.
   */
  ttlMs?: number;
}

export class MapTierCacheProvider implements TierCacheProvider {
  private cache: LRUCache<string, TierEntry>;

  constructor(options: MapTierCacheProviderOptions = {}) {
    const { maxEntries = 10_000, ttlMs = 300_000 } = options;
    this.cache = new LRUCache<string, TierEntry>({
      max: maxEntries,
      ttl: ttlMs,
      allowStale: false,
    });
  }

  async get(key: string): Promise<TierEntry | undefined> {
    return this.cache.get(key);
  }

  async set(key: string, value: TierEntry, ttlMs?: number): Promise<void> {
    this.cache.set(key, value, ttlMs !== undefined ? { ttl: ttlMs } : undefined);
  }

  async invalidatePrefix(prefix: string): Promise<void> {
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  /** Exposed for testing — returns the current number of live (non-expired) entries. */
  get size(): number {
    this.cache.purgeStale();
    return this.cache.size;
  }
}
