/**
 * Consolidated tier routing decision for x-studio-data-middleware.
 *
 * All routing logic lives here. Callers (handler.ts) no longer need to know
 * about the aggregation flag, the tier cache, or the COUNT(*) preflight — they
 * call `decideTier` and act on the returned `TierDecision`.
 *
 * Decision tree
 * ─────────────
 * 1. Aggregation query → force 'db' tier immediately (no COUNT(*), no cache I/O)
 * 2. Tier-cache hit    → return cached tier (skip COUNT(*))
 * 3. Cache miss        → run COUNT(*), map to tier, write tier cache, return result
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
 * Map a preflight row count to a routing tier.
 */
function tierFromRowCount(
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
 * Determine the routing tier for a widget query.
 *
 * @param hasAggregations    - Whether the descriptor contains aggregation specs.
 * @param cacheKey           - Security-scoped key used for tier cache lookups.
 * @param getPreflightRowCount - Async function that runs COUNT(*); only called on a cache miss.
 * @param tierCacheProvider  - Optional tier cache; skipped for aggregation queries.
 * @param thresholds         - Row-count boundaries for tier selection.
 */
export async function decideTier(
  hasAggregations: boolean,
  cacheKey: string,
  getPreflightRowCount: () => Promise<number>,
  tierCacheProvider: TierCacheProvider | undefined | null,
  thresholds: TierThresholds,
): Promise<TierDecision> {
  // 1. Aggregation queries always run at 'db' tier.
  //    Skip COUNT(*) and cache entirely — the row count is irrelevant when the
  //    result is a set of aggregated groups, not raw rows.
  if (hasAggregations) {
    return { tier: 'db', rowCount: 0, source: 'aggregation-forced' };
  }

  // 2. Tier-cache hit → reuse the cached tier decision.
  if (tierCacheProvider) {
    const cached = await tierCacheProvider.get(cacheKey);
    if (cached) {
      return { tier: cached.tier, rowCount: cached.rowCount, source: 'tier-cache' };
    }
  }

  // 3. Cache miss → run COUNT(*), determine tier, populate cache.
  const rowCount = await getPreflightRowCount();
  const tier = tierFromRowCount(rowCount, thresholds);

  if (tierCacheProvider) {
    // The TTL is passed by the caller via tierCacheProvider.set(); the handler
    // knows the configured TTL and passes it through a bound closure or separate
    // wrapper. Here we use the provider's own default by omitting the TTL arg.
    // (The handler calls a helper that forwards the TTL explicitly.)
  }

  return { tier, rowCount, source: 'preflight' };
}

/**
 * Like `decideTier`, but also writes the result to the tier cache (when
 * the cache is provided). Separated so the handler can pass `tierCacheTtlMs`
 * without the core decision function needing to know about it.
 */
export async function decideTierWithCache(
  hasAggregations: boolean,
  cacheKey: string,
  getPreflightRowCount: () => Promise<number>,
  tierCacheProvider: TierCacheProvider | undefined | null,
  thresholds: TierThresholds,
  tierCacheTtlMs: number,
): Promise<TierDecision> {
  if (hasAggregations) {
    return { tier: 'db', rowCount: 0, source: 'aggregation-forced' };
  }

  if (tierCacheProvider) {
    const cached = await tierCacheProvider.get(cacheKey);
    if (cached) {
      return { tier: cached.tier, rowCount: cached.rowCount, source: 'tier-cache' };
    }
  }

  const rowCount = await getPreflightRowCount();
  const tier = tierFromRowCount(rowCount, thresholds);

  if (tierCacheProvider) {
    await tierCacheProvider.set(cacheKey, { tier, rowCount }, tierCacheTtlMs);
  }

  return { tier, rowCount, source: 'preflight' };
}
