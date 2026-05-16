/**
 * CacheProvider interface for x-studio-server.
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
