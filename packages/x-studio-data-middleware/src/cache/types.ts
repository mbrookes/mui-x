/**
 * CacheProvider interface for x-studio-data-middleware.
 *
 * The host app can provide its own implementation to use Redis, Memcached,
 * or any other backing store. The default (LRUCacheProvider) uses an
 * in-process LRU cache — suitable for single-node deployments.
 *
 * ## Write options
 *
 * `set()` accepts an optional `opts` bag. The two knobs are:
 *   - `ttlMs` — per-entry TTL in milliseconds (overrides the provider default)
 *   - `tags`  — logical labels associated with this entry (e.g. the source table
 *               name). Tags enable bulk invalidation via `deleteByTag()` without
 *               iterating every key.
 *
 * ## Invalidation
 *
 * Two mechanisms are provided:
 *   - `invalidatePrefix(prefix)` — removes all keys starting with `prefix`.
 *     Useful for tenant-scoped invalidation (the Studio key format embeds the
 *     tenantId in position 3: `studio:v1:<tenantId>:...`).
 *   - `deleteByTag(tag)` — removes all entries written with a matching tag.
 *     Useful for table-level invalidation after a mutation: tag entries with
 *     the source table name and call `deleteByTag('sales')` on any write.
 *
 * Both mechanisms are O(matched entries) — they do not scan the entire cache.
 */

export interface CacheSetOpts {
  /**
   * Per-entry TTL in milliseconds.
   * When omitted, the provider's configured default TTL is used.
   */
  ttlMs?: number;
  /**
   * Logical labels for this entry. Associated at write time and used for bulk
   * invalidation. Common values: the primary table name (`descriptor.table`).
   */
  tags?: string[];
}

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
   *
   * @param opts.ttlMs  - Per-entry TTL in ms (overrides the provider default).
   * @param opts.tags   - Labels for bulk invalidation via `deleteByTag`.
   */
  set(key: string, value: CacheEntry, opts?: CacheSetOpts): Promise<void>;

  /**
   * Invalidate all entries whose keys start with the given prefix.
   * Used for tenant-scoped eviction.
   */
  invalidatePrefix(prefix: string): Promise<void>;

  /**
   * Invalidate all entries that were written with the given tag.
   *
   * The handler tags every data-cache entry with the primary table name, so
   * after a write to `sales` the host app can call `deleteByTag('sales')` to
   * evict every cached query that reads from that table — across all tenants
   * and query shapes — in a single call.
   */
  deleteByTag(tag: string): Promise<void>;
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
