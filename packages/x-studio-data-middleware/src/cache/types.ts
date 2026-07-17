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
  /**
   * The cached result rows.
   *
   * SERIALIZABILITY CONTRACT (finding T3.6): rows MUST be JSON-serializable
   * (plain objects of JSON scalars/arrays/objects). A remote provider round-trips
   * them through `JSON.stringify`/`JSON.parse`, so non-JSON values do not survive a
   * warm hit the way they do on an in-process provider — a `Date` comes back as an
   * ISO string, a `Map`/`Set`/`undefined`/`BigInt` is dropped or mangled. Do NOT
   * rely on a warm cache hit preserving non-JSON value types; normalize such
   * columns (e.g. to ISO strings) before caching so cold and warm hits are
   * value-identical across every provider.
   */
  rows: Record<string, unknown>[];
  cachedAt: number;
  /**
   * Routing tier that produced these rows. Echoed back on a cache hit so a
   * client-tier result is not misreported as 'server' on subsequent requests.
   * Optional for backward compatibility with entries written before this field.
   */
  tier?: 'client' | 'server' | 'db';
  /**
   * Originating row count from the COUNT(*) preflight. Echoed back on a cache
   * hit so a limit-truncated result reports the same total as the cold miss
   * (where `rowCount` reflects the preflight, not `rows.length`).
   * Optional for backward compatibility with entries written before this field.
   */
  rowCount?: number;
}

export interface CacheProvider {
  /**
   * Retrieve a cached result. Returns undefined on miss.
   * Implementations must be safe to call concurrently.
   *
   * NO-MUTATION CONTRACT (finding T3.6): the caller MUST treat the returned entry
   * (and its `rows`) as read-only. An in-process provider may return the stored
   * object (or a shallow view of it), so mutating it would corrupt the cached entry
   * for every other reader — whereas a remote provider hands back a fresh
   * deserialized copy, so a host that mutates the result would behave differently on
   * a warm vs. cold hit. Callers that need to transform rows must copy first. (The
   * built-in `LRUCacheProvider` additionally structured-clones on read as
   * defense-in-depth, so a warm hit is an independent copy like a cold DB fetch.)
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
  /**
   * Preflight COUNT(*) captured when this tier decision was written. Used as the
   * reported total for a NON-aggregation cache-miss result.
   *
   * BEST-EFFORT after a mutation (finding 3.2): `TierCacheProvider` (below) exposes
   * no tag-based invalidation, so — unlike the DATA cache, which `handleMutation`
   * evicts by table tag — this entry is NOT cleared on an insert/delete. A
   * tier-cache HIT can therefore echo a `rowCount` stale by ≤ the tier TTL after a
   * write. The rows returned to the client are always re-read fresh; only this
   * count may lag within the tier window.
   */
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
 *
 * Deliberately has NO tag-based invalidation (`deleteByTag`), unlike
 * `CacheProvider`: a stored `TierEntry` is a routing hint plus a preflight
 * COUNT(*), self-expiring within the (short, ~30s) tier TTL. `handleMutation`
 * therefore cannot evict tier entries on a write, so a tier-cache hit's
 * `TierEntry.rowCount` is best-effort within that window after a mutation (finding
 * 3.2). This is accepted rather than growing the interface a tag API that only the
 * `rowCount` total would use — the rows a widget returns are always fetched fresh.
 */
export interface TierCacheProvider {
  get(key: string): Promise<TierEntry | undefined>;
  set(key: string, value: TierEntry, ttlMs?: number): Promise<void>;
  invalidatePrefix(prefix: string): Promise<void>;
}
