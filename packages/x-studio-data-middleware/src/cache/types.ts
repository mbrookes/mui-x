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

/**
 * The three routing tiers, as a RUNTIME list — the executable mirror of the
 * `'client' | 'server' | 'db'` union carried by `CacheEntry.tier` and
 * `TierEntry.tier`.
 *
 * Lifted here (out of `RedisTierCacheProvider`, which owned the only copy) so
 * every reader that shape-checks a stored tier validates against the SAME set.
 * Two providers each keeping their own literal set is the drift this exists to
 * prevent: adding a fourth tier to the union while updating only one of them
 * would leave the other silently rejecting valid entries — or, worse, the data
 * plane trusting a tier the tier plane rejects.
 */
export const CACHE_TIERS = ['client', 'server', 'db'] as const;

/** A routing tier a stored cache entry may name. */
export type CacheTier = (typeof CACHE_TIERS)[number];

const CACHE_TIER_SET: ReadonlySet<string> = new Set(CACHE_TIERS);

/** Is `value` one of the three routing tiers? */
export function isCacheTier(value: unknown): value is CacheTier {
  return typeof value === 'string' && CACHE_TIER_SET.has(value);
}

/**
 * Structural check for a value read back as a `CacheEntry` (finding L5, extended
 * to `tier`/`rowCount`).
 *
 * A stored entry is UNTRUSTED INPUT, not a type guarantee: the backing store is
 * host-pluggable and not exclusively ours. A Redis deployment with no `keyPrefix`
 * can collide with the host's own keys, a partially-written value can be read
 * back, an older-schema entry can survive a deploy, and a custom `CacheProvider`
 * can simply be buggy. `JSON.parse(raw) as CacheEntry` — or a truthiness check on
 * whatever a provider hands back — is an assertion, not a validation.
 *
 * ALL THREE consumed fields are checked, not just `rows`. Validating only `rows`
 * left `tier` and `rowCount` trusted verbatim, so `{ rows: [], tier: 'banana',
 * rowCount: NaN }` flowed straight into a `WidgetQueryResult` whose types declare
 * `tier: 'client'|'server'|'db'` and `rowCount: number` — and the Studio client
 * switches on `tier` to decide whether to filter/aggregate in-browser and renders
 * `rowCount` as the total.
 *
 * `tier` and `rowCount` are checked only when PRESENT: both are optional on
 * `CacheEntry` for backward compatibility with entries written before they
 * existed, and an absent field is a documented legacy shape rather than a
 * corrupt one (the readers fall back). A field that is present but invalid is
 * evidence the whole entry is foreign, so the entry — not just that field —
 * fails, and the reader degrades to a MISS.
 *
 * Shared by `RedisCacheProvider.get` (deserialization boundary) and `handler.ts`
 * (any provider's return value), so those two cannot drift on what "a usable
 * entry" means.
 */
export function isCacheEntryShape(value: unknown): value is CacheEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const { rows, tier, rowCount } = value as {
    rows?: unknown;
    tier?: unknown;
    rowCount?: unknown;
  };
  if (!Array.isArray(rows)) {
    return false;
  }
  if (tier !== undefined && !isCacheTier(tier)) {
    return false;
  }
  // `Number.isFinite` (not `typeof === 'number'`): it rejects `NaN`/`Infinity`
  // as well as a numeric STRING, and it does not coerce. Matches the second-line
  // guard the tier plane applies in `router/tierDecision.ts`.
  if (rowCount !== undefined && !Number.isFinite(rowCount)) {
    return false;
  }
  return true;
}

/**
 * Structural check for a value read back as a `TierEntry` — the tier plane's
 * sibling of `isCacheEntryShape` above.
 *
 * Both fields are REQUIRED here (unlike `CacheEntry`'s optional `tier`/
 * `rowCount`) because `TierEntry` declares them required: an entry missing
 * either is not a `TierEntry` at all. Beyond that the field-level rules are
 * identical to `isCacheEntryShape`'s, deliberately — one entry shape must not be
 * held to a looser standard than the other just because it is read on a
 * different plane.
 */
export function isTierEntryShape(value: unknown): value is TierEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const { tier, rowCount } = value as { tier?: unknown; rowCount?: unknown };
  return isCacheTier(tier) && Number.isFinite(rowCount);
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
   * Routing tier that produced these rows.
   *
   * Persisted for diagnostics and for a future reader; it is NOT what
   * `handler.ts` reports on a cache hit. The reported tier is re-derived from
   * `rowCount` through `tierFromRowCount` under the READER's current thresholds,
   * exactly as `router/tierDecision.ts` does on the tier plane — `thresholds` is
   * folded into neither the cache key nor the policy digest, so a stored tier may
   * have been decided under different config. See the tier-derivation note in
   * `handler.ts`.
   *
   * Optional for backward compatibility with entries written before this field.
   * A PRESENT value must be one of `CACHE_TIERS` (see `isCacheEntryShape`).
   */
  tier?: CacheTier;
  /**
   * Originating row count from the COUNT(*) preflight. Echoed back on a cache
   * hit so a limit-truncated result reports the same total as the cold miss
   * (where `rowCount` reflects the preflight, not `rows.length`), and re-mapped
   * to the reported `tier`.
   *
   * Optional for backward compatibility with entries written before this field.
   * A PRESENT value must be a finite number (see `isCacheEntryShape`).
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
   * NO-MUTATION CONTRACT — the WRITE side (finding L3, and the write-then-return
   * path `get`'s contract above does not cover). An in-process provider may store
   * `value` BY REFERENCE (the built-in `LRUCacheProvider` does), so the caller
   * must treat `value` — and every row object inside `value.rows` — as read-only
   * from the moment it is handed over. `handleBatchQuery` both stores the entry
   * here and returns the result to the host, so a host that post-processed
   * `results[i].rows` in place (masking a column, decrypting one) wrote straight
   * into the process-wide server cache, and every subsequent hit for the whole TTL
   * served the mutated rows to every user sharing the security profile.
   *
   * `handleBatchQuery` now hands over its own `rows` ARRAY (`{ rows: [...rows] }`),
   * so array-level mutation (`push`/`splice`/`sort`/`length = 0`) can no longer
   * reach the cache. The row OBJECTS are still shared — cloning them would defeat
   * the whole memory rationale for the single-flight dedup — so the contract on
   * `WidgetQueryResult.rows` stands: copy before transforming.
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
  tier: CacheTier;
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
