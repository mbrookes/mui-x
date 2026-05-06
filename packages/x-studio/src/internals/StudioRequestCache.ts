import type { StudioQueryResult } from '../models/studio';

const TTL_MS = 30_000;

interface CacheEntry {
  result: StudioQueryResult;
  fetchedAt: number;
}

/**
 * Module-singleton cache for async adapter requests.
 *
 * - Deduplicates in-flight requests: if two widgets request the same cacheKey
 *   simultaneously, only one `getRows()` call is made; both receive the same result.
 * - Serves stale data while revalidating (stale-while-revalidate pattern).
 * - TTL-based expiry (30s by default).
 * - `invalidateSource(sourceId)` clears all entries whose cacheKey starts with
 *   `"${sourceId}:"` — called when a source is updated via `upsertDataSource`.
 */
export class StudioRequestCache {
  private readonly cache = new Map<string, CacheEntry>();

  private readonly inflight = new Map<string, Promise<StudioQueryResult>>();

  private readonly ttlMs: number;

  constructor(ttlMs: number = TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /** Returns a cached result if present and not expired, otherwise undefined. */
  get(cacheKey: string): StudioQueryResult | undefined {
    const entry = this.cache.get(cacheKey);
    if (!entry) {
      return undefined;
    }
    if (Date.now() - entry.fetchedAt > this.ttlMs) {
      this.cache.delete(cacheKey);
      return undefined;
    }
    return entry.result;
  }

  /** Stores a result in the cache. */
  set(cacheKey: string, result: StudioQueryResult): void {
    this.cache.set(cacheKey, { result, fetchedAt: Date.now() });
  }

  /** Returns true if there is an in-flight request for this cacheKey. */
  isInflight(cacheKey: string): boolean {
    return this.inflight.has(cacheKey);
  }

  /** Returns the in-flight promise for this cacheKey, or undefined. */
  getInflight(cacheKey: string): Promise<StudioQueryResult> | undefined {
    return this.inflight.get(cacheKey);
  }

  /**
   * Registers an in-flight request. Automatically removes itself (and populates
   * the cache) when the promise settles.
   */
  addInflight(cacheKey: string, promise: Promise<StudioQueryResult>): Promise<StudioQueryResult> {
    this.inflight.set(cacheKey, promise);
    promise.then(
      (result) => {
        this.set(cacheKey, result);
        this.inflight.delete(cacheKey);
      },
      () => {
        this.inflight.delete(cacheKey);
      },
    );
    return promise;
  }

  /**
   * Invalidates all cached entries for a given sourceId.
   * Called when `upsertDataSource` updates a source that has an adapter.
   */
  invalidateSource(sourceId: string): void {
    const prefix = `${sourceId}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
    // In-flight requests for this source will still resolve but their results
    // will be re-fetched on the next descriptor change.
  }

  /** Clears all cached entries and in-flight requests. Primarily for testing. */
  clear(): void {
    this.cache.clear();
    this.inflight.clear();
  }
}

/** Package-wide singleton. */
export const studioRequestCache = new StudioRequestCache();
