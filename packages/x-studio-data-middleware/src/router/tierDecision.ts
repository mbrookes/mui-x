/**
 * Consolidated tier routing decision for x-studio-data-middleware.
 *
 * All routing logic lives here. Callers (handler.ts) call `decideTierWithCache`
 * and act on the returned `TierDecision`.
 *
 * Decision tree
 * ─────────────
 * 1. Aggregation query → force 'db' tier immediately (no COUNT(*), no cache I/O)
 * 2. Tier-cache hit    → return cached tier (skip COUNT(*))
 * 3. Cache miss        → run COUNT(*), map to tier, write tier cache (if a TTL was
 *                        given), return result
 */
import type { TierCacheProvider } from '../cache/types';

/** Routing tiers */
export type TierDecision =
  | { tier: 'client' | 'server'; rowCount: number; source: 'preflight' | 'tier-cache' }
  | { tier: 'db'; rowCount: number; source: 'aggregation-forced' | 'preflight' | 'tier-cache' };

/** Row-count thresholds that separate the three routing tiers. */
export interface TierThresholds {
  /** Rows at or below this value are served by the client tier. */
  client: number;
  /** Rows at or below this value are served by the server tier (else db). */
  server: number;
}

export const DEFAULT_THRESHOLDS: TierThresholds = { client: 10_000, server: 100_000 };

/**
 * Namespace prefix applied to tier-cache keys (finding 2.1).
 *
 * The data cache and the tier cache are two independent planes, but they derive
 * their key from the SAME `generateCacheKey` output. When a host wires BOTH planes
 * to one shared Redis client (the documented "combining" setup), an identical key
 * string makes the two planes silently overwrite each other: a data-cache `set`
 * clobbers the tier `TierEntry` with a `CacheEntry` (and vice-versa in a race,
 * shipping a `rows: undefined` result to the client). Prefixing the tier plane's
 * key structurally separates the two namespaces regardless of which providers a
 * host pairs, so no provider combination can ever collide. `handler.ts` applies
 * this prefix when it threads the shared cache key into `decideTierWithCache`.
 */
export const TIER_CACHE_KEY_PREFIX = 'tier:';

/**
 * Map a preflight row count to a routing tier.
 *
 * THE single implementation of "what tier do we report", exported (finding M2)
 * so the DATA plane uses it too. `handler.ts` used to echo a data-cache entry's
 * stored `tier` verbatim while this module deliberately re-derived the tier
 * plane's — two implementations of one rule, free to disagree, with neither site
 * referencing the other. Both planes store the originating `rowCount` next to the
 * tier, so both can (and now do) call this.
 */
export function tierFromRowCount(
  rowCount: number,
  thresholds: TierThresholds,
): 'client' | 'server' | 'db' {
  if (rowCount <= thresholds.client) {
    return 'client';
  }
  if (rowCount <= thresholds.server) {
    return 'server';
  }
  return 'db';
}

/**
 * Determine the routing tier for a widget query, optionally persisting the
 * decision to the tier cache.
 *
 * @param hasAggregations     - Whether the descriptor contains aggregation specs.
 * @param cacheKey            - Security-scoped key used for tier cache lookups.
 * @param getPreflightRowCount - Async function that runs COUNT(*); only called on a cache miss.
 * @param tierCacheProvider   - Optional tier cache; skipped for aggregation queries.
 * @param thresholds          - Row-count boundaries for tier selection.
 * @param tierCacheTtlMs      - TTL (ms) used when writing a fresh decision to the tier cache.
 *                              When omitted, the decision is still computed/read from the
 *                              cache but never written back — equivalent to a plain
 *                              decide-without-cache-write.
 */
export async function decideTierWithCache(
  hasAggregations: boolean,
  cacheKey: string,
  getPreflightRowCount: () => Promise<number>,
  tierCacheProvider: TierCacheProvider | undefined | null,
  thresholds: TierThresholds,
  tierCacheTtlMs?: number,
): Promise<TierDecision> {
  // 1. Aggregation queries always run at 'db' tier.
  //    Skip COUNT(*) and cache entirely — the row count is irrelevant when the
  //    result is a set of aggregated groups, not raw rows.
  if (hasAggregations) {
    return { tier: 'db', rowCount: 0, source: 'aggregation-forced' };
  }

  // 2. Tier-cache hit → reuse the cached tier decision.
  //    The tier cache is a best-effort layer in FRONT of the preflight COUNT(*),
  //    mirroring the data cache's posture (finding 2.6): a read failure (e.g.
  //    Redis down) must degrade to a tier-cache miss (falling through to the
  //    preflight), not fail the widget (finding 2.1).
  if (tierCacheProvider) {
    let cached: Awaited<ReturnType<TierCacheProvider['get']>>;
    try {
      cached = await tierCacheProvider.get(cacheKey);
    } catch (cacheErr) {
      cached = undefined;
      console.warn(
        `MUI X Studio Server: tier-cache read failed for a widget; falling back to the preflight COUNT(*). ` +
          `The result is still served, but the tier-cache backend should be checked. ` +
          `Cause: ${cacheErr instanceof Error ? cacheErr.message : String(cacheErr)}`,
      );
    }
    // SHAPE-CHECK THE HIT (finding L5, sibling of the data-cache guard in
    // `handler.ts`). A `TierCacheProvider` is host-pluggable and its backing store
    // is not exclusively ours — a Redis key collision, a partially-written value,
    // or a buggy custom provider all yield a truthy entry whose `rowCount` is not
    // a number. That would flow into `tierFromRowCount`, whose comparisons against
    // `undefined`/`NaN` are all false, silently routing every such widget to the
    // 'db' tier and reporting a nonsense `rowCount` to the client. Treat a
    // structurally invalid entry as a MISS and fall through to the authoritative
    // preflight COUNT(*), mirroring the read-failure degradation just above.
    if (cached && !Number.isFinite(cached.rowCount)) {
      console.warn(
        `MUI X Studio Server: discarded a malformed tier-cache entry for a widget (its "rowCount" field is not a ` +
          `finite number); falling back to the preflight COUNT(*). The result is still served, but the tier-cache ` +
          `backend should be checked for a key collision or a faulty TierCacheProvider.`,
      );
      cached = undefined;
    }
    if (cached) {
      // Re-map the cached `rowCount` through the CURRENT `thresholds` instead of
      // trusting `cached.tier` verbatim (finding 2.4). `thresholds` is folded into
      // neither the cache key nor the policy digest, so a cached decision may have
      // been computed under different thresholds (mid-rollout config change, or a
      // different node in a cluster during a deploy); re-deriving here makes a
      // cached decision reinterpretable under the reader's own config with no key
      // change and no extra I/O.
      //
      // `handler.ts`'s DATA-cache hit applies the identical rule through the same
      // exported `tierFromRowCount` (finding M2). Keep them together: a change to
      // how a cached tier is reported must land on both planes, or a widget's
      // reported tier starts depending on which cache happened to serve it.
      const tier = tierFromRowCount(cached.rowCount, thresholds);
      return { tier, rowCount: cached.rowCount, source: 'tier-cache' };
    }
  }

  // 3. Cache miss → run COUNT(*), determine tier, populate cache (when a TTL was given).
  const rowCount = await getPreflightRowCount();
  const tier = tierFromRowCount(rowCount, thresholds);

  if (tierCacheProvider && tierCacheTtlMs !== undefined) {
    // The tier decision is already computed — a cache WRITE failure must not
    // discard it. Catch and degrade to "decided, uncached" (finding 2.1,
    // mirroring the data cache's `set` guard for finding 2.6).
    //
    // NOTE (finding 3.2 — best-effort `rowCount`): the `rowCount` persisted here is
    // the preflight COUNT(*) at write time. Unlike the DATA cache, the tier cache
    // is NOT tag-invalidated on a mutation — the `TierCacheProvider` interface has
    // only `get`/`set`/`invalidatePrefix`, no `deleteByTag` — so a subsequent
    // tier-cache HIT can report a `rowCount` that is stale by ≤ the tier TTL after
    // an insert/delete. The rows a widget returns are always re-read fresh; only
    // this count is best-effort within the tier window (see `handler.ts`).
    try {
      await tierCacheProvider.set(cacheKey, { tier, rowCount }, tierCacheTtlMs);
    } catch (cacheErr) {
      console.warn(
        `MUI X Studio Server: tier-cache write failed for a widget; the tier decision is still returned. ` +
          `Subsequent requests will re-run the preflight COUNT(*) until the tier-cache backend recovers. ` +
          `Cause: ${cacheErr instanceof Error ? cacheErr.message : String(cacheErr)}`,
      );
    }
  }

  return { tier, rowCount, source: 'preflight' };
}
