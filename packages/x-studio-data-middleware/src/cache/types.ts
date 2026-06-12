/**
 * CacheProvider interface for x-studio-data-middleware.
 *
 * The host app can provide its own implementation to use Redis, Memcached,
 * or any other backing store. The default (LRUCacheProvider) uses an
 * in-process LRU cache — suitable for single-node deployments.
 */

export interface CacheEntry {
  rows: Record<string, unknown>[];
  cachedAt: number;
}

export interface CacheProvider {
  /**
   * Retrieve a cached result. Returns undefined on miss.
   * Implementations must be safe to call concurrently.
   */
  get(key: string): Promise<CacheEntry | undefined>;

  /**
   * Store a result under the given key.
   * The TTL parameter (seconds) is a hint; implementations may ignore it
   * if they manage expiry differently (e.g., LRU eviction by size).
   */
  set(key: string, value: CacheEntry, ttlSeconds?: number): Promise<void>;

  /**
   * Invalidate all entries whose keys start with the given prefix.
   * Used when a data source is updated to evict stale rows.
   */
  invalidatePrefix(prefix: string): Promise<void>;
}

/**
 * Routing tier result stored in the tier cache.
 * Avoids re-running a COUNT(*) preflight on repeated cold misses
 * (after the data cache TTL has expired) within the tier cache window.
 */
export interface TierEntry {
  tier: 'client' | 'server' | 'db';
  rowCount: number;
}

/**
 * Tier routing cache provider.
 *
 * Stores the routing tier (client/server/db) and preflight row count for a
 * given query key. The tier cache TTL should be longer than the data cache TTL
 * so that repeated cold misses within the tier window skip the COUNT(*) preflight.
 *
 * The host app can provide a Redis-backed implementation for multi-node deployments.
 */
export interface TierCacheProvider {
  get(key: string): Promise<TierEntry | undefined>;
  set(key: string, value: TierEntry, ttlMs?: number): Promise<void>;
  invalidatePrefix(prefix: string): Promise<void>;
}
