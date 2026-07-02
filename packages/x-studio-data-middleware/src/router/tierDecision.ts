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
  if (tierCacheProvider) {
    const cached = await tierCacheProvider.get(cacheKey);
    if (cached) {
      return { tier: cached.tier, rowCount: cached.rowCount, source: 'tier-cache' };
    }
  }

  // 3. Cache miss → run COUNT(*), determine tier, populate cache (when a TTL was given).
  const rowCount = await getPreflightRowCount();
  const tier = tierFromRowCount(rowCount, thresholds);

  if (tierCacheProvider && tierCacheTtlMs !== undefined) {
    await tierCacheProvider.set(cacheKey, { tier, rowCount }, tierCacheTtlMs);
  }

  return { tier, rowCount, source: 'preflight' };
}
