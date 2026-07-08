import type { StudioQueryResult } from '../models';

const TTL_MS = 30_000;

interface CacheEntry {
  result: StudioQueryResult;
  fetchedAt: number;
  /** The sourceId this entry belongs to (its `sourceIndex` bucket). */
  sourceId: string;
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
interface InflightEntry {
  promise: Promise<StudioQueryResult>;
  /** The sourceId this request belongs to. */
  sourceId: string;
  /** The source's generation captured when the request went in-flight. */
  generation: number;
}

export class StudioRequestCache {
  private readonly cache = new Map<string, CacheEntry>();

  private readonly inflight = new Map<string, InflightEntry>();

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

  /**
   * The sourceId a cacheKey belongs to. Callers that know it (they build the descriptor)
   * should pass `descriptor.sourceId` explicitly; otherwise we fall back to the legacy
   * first-colon parse of the cacheKey. The explicit form is correct even when a sourceId
   * itself contains a `':'` (which the parse would truncate).
   */
  private resolveSourceId(cacheKey: string, sourceId?: string): string {
    return sourceId ?? cacheKey.split(':')[0];
  }

  /** Returns a cached result if present and not expired, otherwise undefined. */
  get(cacheKey: string): StudioQueryResult | undefined {
    const entry = this.cache.get(cacheKey);
    if (!entry) {
      return undefined;
    }
    if (Date.now() - entry.fetchedAt > this.ttlMs) {
      this.cache.delete(cacheKey);
      // Use the sourceId stored at set-time so the correct bucket is cleaned even when
      // the sourceId contains a ':' (the parse-based fallback would target a wrong bucket).
      this.sourceIndex.get(entry.sourceId)?.delete(cacheKey);
      return undefined;
    }
    return entry.result;
  }

  /**
   * Stores a result in the cache. Pass `sourceId` (from `descriptor.sourceId`) so the
   * reverse index and TTL cleanup use the true source; when omitted it falls back to the
   * legacy first-colon parse of the cacheKey.
   */
  set(cacheKey: string, result: StudioQueryResult, sourceId?: string): void {
    const resolvedSourceId = this.resolveSourceId(cacheKey, sourceId);
    this.cache.set(cacheKey, { result, fetchedAt: Date.now(), sourceId: resolvedSourceId });
    let keys = this.sourceIndex.get(resolvedSourceId);
    if (!keys) {
      keys = new Set();
      this.sourceIndex.set(resolvedSourceId, keys);
    }
    keys.add(cacheKey);
  }

  /**
   * Returns true if there is a still-valid in-flight request for this cacheKey.
   * An in-flight request whose source was invalidated after it started (its captured
   * generation no longer matches the source's current generation) is treated as absent,
   * so callers arriving after invalidation start a fresh request instead of joining it.
   */
  isInflight(cacheKey: string): boolean {
    return this.getInflight(cacheKey) !== undefined;
  }

  /**
   * Returns the in-flight promise for this cacheKey, or undefined. Returns undefined for a
   * request that was invalidated mid-flight (its source's generation has advanced since the
   * request started) so post-invalidation callers do not join a now-stale request; the
   * request itself keeps running and any caller already awaiting its promise is unaffected.
   */
  getInflight(cacheKey: string): Promise<StudioQueryResult> | undefined {
    const entry = this.inflight.get(cacheKey);
    if (!entry) {
      return undefined;
    }
    if (this.getGeneration(entry.sourceId) !== entry.generation) {
      return undefined;
    }
    return entry.promise;
  }

  /**
   * Registers an in-flight request. Automatically removes itself (and populates
   * the cache) when the promise settles.
   */
  addInflight(
    cacheKey: string,
    promise: Promise<StudioQueryResult>,
    sourceId?: string,
  ): Promise<StudioQueryResult> {
    // Capture the source's generation at request-start time. If `invalidateSource`
    // runs before this resolves, the generation will have advanced and we must NOT
    // cache the (now stale) result — otherwise an unchanged descriptor would get a
    // cache HIT on it. The generation is also stored on the in-flight entry so that a
    // post-invalidation caller sees this request as absent (via `getInflight`) and starts
    // a fresh fetch rather than joining it. The awaiting caller still receives this result.
    const resolvedSourceId = this.resolveSourceId(cacheKey, sourceId);
    const generationAtStart = this.getGeneration(resolvedSourceId);
    this.inflight.set(cacheKey, {
      promise,
      sourceId: resolvedSourceId,
      generation: generationAtStart,
    });
    // Only clear the in-flight slot if it still holds THIS promise. After an
    // invalidation a fresh request can register under the same cacheKey while this
    // (now-stale) one is still running; that newer entry must not be deleted when the
    // stale promise settles.
    const clearIfCurrent = () => {
      if (this.inflight.get(cacheKey)?.promise === promise) {
        this.inflight.delete(cacheKey);
      }
    };
    promise.then(
      (result) => {
        if (this.getGeneration(resolvedSourceId) === generationAtStart) {
          this.set(cacheKey, result, resolvedSourceId);
        }
        clearIfCurrent();
      },
      () => {
        clearIfCurrent();
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
    // (a) detects on resolve that it was invalidated mid-flight and skips writing its
    // now-stale result back into the cache, and (b) is treated as absent by `getInflight`
    // for any caller arriving AFTER invalidation, so that caller starts a fresh request
    // rather than joining the stale in-flight one. Callers already awaiting the in-flight
    // promise before invalidation hold the reference directly and are unaffected. The next
    // descriptor evaluation then misses the cache and triggers a genuine re-fetch.
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
