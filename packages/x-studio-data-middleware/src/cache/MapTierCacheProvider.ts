/**
 * Lightweight in-process tier routing cache.
 *
 * Stores routing tier + preflight row count in a plain `Map` with per-entry
 * expiry. Suitable for single-node deployments. For multi-node use, provide a
 * Redis-backed `TierCacheProvider` implementation to `HandleBatchQueryOptions`.
 *
 * Design rationale
 * ────────────────
 * The data cache TTL is typically 30 s. After it expires, every widget causes a
 * fresh COUNT(*) preflight. If the underlying dataset hasn't changed tier (e.g.,
 * a 50k-row table stays in the server tier), that preflight is wasted work.
 *
 * By caching the tier result for a longer window (default 5 min), we skip the
 * COUNT(*) on repeated cold misses and jump straight to `executeForTier`. The
 * tier TTL resets each time a fresh preflight is run.
 */
import type { TierEntry, TierCacheProvider } from './types';

interface StoredTierEntry extends TierEntry {
  expiresAt: number;
}

export class MapTierCacheProvider implements TierCacheProvider {
  private map = new Map<string, StoredTierEntry>();

  async get(key: string): Promise<TierEntry | undefined> {
    const entry = this.map.get(key);
    if (!entry) {
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    return { tier: entry.tier, rowCount: entry.rowCount };
  }

  async set(key: string, value: TierEntry, ttlMs = 300_000): Promise<void> {
    this.map.set(key, { ...value, expiresAt: Date.now() + ttlMs });
  }

  async invalidatePrefix(prefix: string): Promise<void> {
    for (const key of this.map.keys()) {
      if (key.startsWith(prefix)) {
        this.map.delete(key);
      }
    }
  }

  /** Exposed for testing — returns the current number of live (non-expired) entries. */
  get size(): number {
    const now = Date.now();
    let count = 0;
    for (const entry of this.map.values()) {
      if (now <= entry.expiresAt) {
        count += 1;
      }
    }
    return count;
  }
}
