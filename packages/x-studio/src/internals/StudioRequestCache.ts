import type { StudioQueryResult } from '../models';

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

  /** Reverse index: sourceId → set of cacheKeys with that sourceId prefix. */
  private readonly sourceIndex = new Map<string, Set<string>>();

  /**
   * Monotonic generation token per sourceId, bumped by `invalidateSource`. Captured
   * when a request goes in-flight; a resolved result is only written to the cache if
   * the source's generation is still the one captured at request-start time. This
   * prevents an in-flight request that was invalidated mid-flight from re-inserting
   * its now-stale result with a fresh TTL (which would otherwise serve as a cache HIT
   * for later callers using the unchanged descriptor).
   */
  private readonly sourceGeneration = new Map<string, number>();

  private readonly ttlMs: number;

  constructor(ttlMs: number = TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /** Current generation for a sourceId (0 if never invalidated). */
  private getGeneration(sourceId: string): number {
    return this.sourceGeneration.get(sourceId) ?? 0;
  }

  /** Returns a cached result if present and not expired, otherwise undefined. */
  get(cacheKey: string): StudioQueryResult | undefined {
    const entry = this.cache.get(cacheKey);
    if (!entry) {
      return undefined;
    }
    if (Date.now() - entry.fetchedAt > this.ttlMs) {
      this.cache.delete(cacheKey);
      const sourceId = cacheKey.split(':')[0];
      this.sourceIndex.get(sourceId)?.delete(cacheKey);
      return undefined;
    }
    return entry.result;
  }

  /** Stores a result in the cache. */
  set(cacheKey: string, result: StudioQueryResult): void {
    this.cache.set(cacheKey, { result, fetchedAt: Date.now() });
    const sourceId = cacheKey.split(':')[0];
    let keys = this.sourceIndex.get(sourceId);
    if (!keys) {
      keys = new Set();
      this.sourceIndex.set(sourceId, keys);
    }
    keys.add(cacheKey);
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
    // Capture the source's generation at request-start time. If `invalidateSource`
    // runs before this resolves, the generation will have advanced and we must NOT
    // cache the (now stale) result — otherwise an unchanged descriptor would get a
    // cache HIT on it. The awaiting caller still receives this one result.
    const sourceId = cacheKey.split(':')[0];
    const generationAtStart = this.getGeneration(sourceId);
    promise.then(
      (result) => {
        if (this.getGeneration(sourceId) === generationAtStart) {
          this.set(cacheKey, result);
        }
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
   * Uses a secondary source index for O(M) lookup instead of O(K) linear scan.
   * Called when `upsertDataSource` updates a source that has an adapter.
   */
  invalidateSource(sourceId: string): void {
    const keys = this.sourceIndex.get(sourceId);
    if (keys) {
      for (const key of keys) {
        this.cache.delete(key);
      }
      this.sourceIndex.delete(sourceId);
    }
    // Bump the generation so any request that is currently in-flight for this source
    // will detect (on resolve) that it was invalidated mid-flight and skip writing its
    // now-stale result back into the cache. The next descriptor evaluation then misses
    // the cache and triggers a genuine re-fetch.
    this.sourceGeneration.set(sourceId, this.getGeneration(sourceId) + 1);
  }

  /** Clears all cached entries and in-flight requests. Primarily for testing. */
  clear(): void {
    this.cache.clear();
    this.inflight.clear();
    this.sourceIndex.clear();
    this.sourceGeneration.clear();
  }
}

/** Package-wide singleton. */
export const studioRequestCache = new StudioRequestCache();
