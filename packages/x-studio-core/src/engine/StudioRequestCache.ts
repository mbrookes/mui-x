import type { StudioQueryResult } from '../models';

const TTL_MS = 30_000;

/**
 * Hard cap on the number of cached result entries. Every distinct descriptor (each filter /
 * date-range tweak produces a new `cacheKey`) inserts an entry holding the full `result.rows`
 * array; without a cap the module-level singleton grows monotonically across a long-lived
 * session (surviving even a Studio unmount). When the cap is exceeded the least-recently-used
 * entry is evicted.
 */
const MAX_ENTRIES = 500;

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

  private readonly maxEntries: number;

  /**
   * Per-adapter-instance namespace tokens. `studioRequestCache` is a module-level singleton
   * shared by every `<Studio>`/`StudioController` on the page, and the cacheKey is deliberately
   * built from `sourceId` + query shape with NO adapter-identity component. Two separate `<Studio>`
   * instances mounted on the same page that use the SAME `sourceId` string but were handed
   * DIFFERENT host adapters (e.g. different tenant / auth / backend) would therefore collide:
   * they'd serve each other's cached rows for up to the TTL and join each other's in-flight
   * request promises. Callers pass the live `adapter` object so its entries are keyed in a private
   * per-adapter-instance namespace; a `WeakMap` keeps the mapping GC-friendly (an adapter that is
   * unmounted/dropped takes its token with it). Callers that omit `adapter` keep the legacy
   * un-namespaced key, so the change is fully backward compatible.
   */
  private readonly adapterTokens = new WeakMap<object, string>();

  private adapterTokenCounter = 0;

  constructor(ttlMs: number = TTL_MS, maxEntries: number = MAX_ENTRIES) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  /**
   * Stable namespace prefix for an adapter instance (empty string when no adapter is supplied,
   * preserving the legacy un-namespaced key). The token is a monotonic, per-adapter-unique prefix
   * (`@adapterN `), so two distinct adapters can never map to the same effective key even when
   * their cacheKeys are identical, and the same adapter always resolves to the same prefix.
   */
  private adapterNamespace(adapter?: object): string {
    if (!adapter) {
      return '';
    }
    let token = this.adapterTokens.get(adapter);
    if (token === undefined) {
      this.adapterTokenCounter += 1;
      token = `@adapter${this.adapterTokenCounter} `;
      this.adapterTokens.set(adapter, token);
    }
    return token;
  }

  /** The effective (per-adapter-namespaced) key used for all internal storage/lookup. */
  private effectiveKey(cacheKey: string, adapter?: object): string {
    return this.adapterNamespace(adapter) + cacheKey;
  }

  /**
   * Removes a single cache entry and keeps its source's reverse index in sync. Uses the
   * `sourceId` stored on the entry (not a parse of the key) so a sourceId containing ':'
   * cleans the correct bucket.
   */
  private deleteEntry(cacheKey: string, entry?: CacheEntry): void {
    const target = entry ?? this.cache.get(cacheKey);
    this.cache.delete(cacheKey);
    if (target) {
      const keys = this.sourceIndex.get(target.sourceId);
      if (keys) {
        keys.delete(cacheKey);
        if (keys.size === 0) {
          this.sourceIndex.delete(target.sourceId);
        }
      }
    }
  }

  /**
   * Bounds cache size. Sweeps expired entries first (cheap, and the common reason the cache
   * grew), then, if still over the cap, evicts least-recently-used entries. Map iteration
   * order is insertion order and `get()`/`set()` re-insert on access, so the first entries
   * are the least recently used. Runs on every `set()` so growth is bounded eagerly rather
   * than only when a stale key happens to be re-requested via `get()`.
   */
  private evictIfNeeded(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.fetchedAt > this.ttlMs) {
        this.deleteEntry(key, entry);
      }
    }
    if (this.cache.size <= this.maxEntries) {
      return;
    }
    for (const [key, entry] of this.cache) {
      if (this.cache.size <= this.maxEntries) {
        break;
      }
      this.deleteEntry(key, entry);
    }
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

  /**
   * Returns a cached result if present and not expired, otherwise undefined.
   *
   * Pass the live `adapter` object so a `<Studio>` instance only ever reads entries written by its
   * OWN adapter — two instances sharing a `sourceId` but backed by different adapters must not
   * serve each other's rows. Omitting `adapter` keeps the legacy shared (un-namespaced) key.
   */
  get(cacheKey: string, adapter?: object): StudioQueryResult | undefined {
    const key = this.effectiveKey(cacheKey, adapter);
    const entry = this.cache.get(key);
    if (!entry) {
      return undefined;
    }
    if (Date.now() - entry.fetchedAt > this.ttlMs) {
      // Use the sourceId stored at set-time so the correct bucket is cleaned even when
      // the sourceId contains a ':' (the parse-based fallback would target a wrong bucket).
      this.deleteEntry(key, entry);
      return undefined;
    }
    // Mark as most-recently-used: delete + re-insert moves the key to the end of the Map's
    // iteration order so LRU eviction in `evictIfNeeded` targets genuinely cold entries.
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.result;
  }

  /**
   * Stores a result in the cache. Pass `sourceId` (from `descriptor.sourceId`) so the
   * reverse index and TTL cleanup use the true source; when omitted it falls back to the
   * legacy first-colon parse of the cacheKey. Pass `adapter` to namespace the entry to a single
   * adapter instance (see `get`); `sourceId` is always resolved from the ORIGINAL cacheKey (never
   * the namespaced form) so the `invalidateSource` reverse index stays keyed by the true source.
   */
  set(cacheKey: string, result: StudioQueryResult, sourceId?: string, adapter?: object): void {
    const key = this.effectiveKey(cacheKey, adapter);
    const resolvedSourceId = this.resolveSourceId(cacheKey, sourceId);
    // Delete first so a re-set moves the key to the most-recently-used end of the Map's
    // insertion order (Map.set on an existing key keeps its original position).
    this.cache.delete(key);
    this.cache.set(key, { result, fetchedAt: Date.now(), sourceId: resolvedSourceId });
    let keys = this.sourceIndex.get(resolvedSourceId);
    if (!keys) {
      keys = new Set();
      this.sourceIndex.set(resolvedSourceId, keys);
    }
    keys.add(key);
    // Bound growth eagerly on every write: sweep expired entries and, if still over the cap,
    // evict least-recently-used ones. Without this the singleton grows monotonically since
    // entries are otherwise only removed when the SAME key is re-requested after TTL.
    this.evictIfNeeded();
  }

  /**
   * Returns true if there is a still-valid in-flight request for this cacheKey.
   * An in-flight request whose source was invalidated after it started (its captured
   * generation no longer matches the source's current generation) is treated as absent,
   * so callers arriving after invalidation start a fresh request instead of joining it.
   */
  isInflight(cacheKey: string, adapter?: object): boolean {
    return this.getInflight(cacheKey, adapter) !== undefined;
  }

  /**
   * Returns the in-flight promise for this cacheKey, or undefined. Returns undefined for a
   * request that was invalidated mid-flight (its source's generation has advanced since the
   * request started) so post-invalidation callers do not join a now-stale request; the
   * request itself keeps running and any caller already awaiting its promise is unaffected.
   *
   * Pass the live `adapter` so an instance never JOINS an in-flight request started by a different
   * instance's adapter for the same `sourceId`.
   */
  getInflight(cacheKey: string, adapter?: object): Promise<StudioQueryResult> | undefined {
    const key = this.effectiveKey(cacheKey, adapter);
    const entry = this.inflight.get(key);
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
    adapter?: object,
  ): Promise<StudioQueryResult> {
    // Capture the source's generation at request-start time. If `invalidateSource`
    // runs before this resolves, the generation will have advanced and we must NOT
    // cache the (now stale) result — otherwise an unchanged descriptor would get a
    // cache HIT on it. The generation is also stored on the in-flight entry so that a
    // post-invalidation caller sees this request as absent (via `getInflight`) and starts
    // a fresh fetch rather than joining it. The awaiting caller still receives this result.
    const key = this.effectiveKey(cacheKey, adapter);
    const resolvedSourceId = this.resolveSourceId(cacheKey, sourceId);
    const generationAtStart = this.getGeneration(resolvedSourceId);
    this.inflight.set(key, {
      promise,
      sourceId: resolvedSourceId,
      generation: generationAtStart,
    });
    // Only clear the in-flight slot if it still holds THIS promise. After an
    // invalidation a fresh request can register under the same cacheKey while this
    // (now-stale) one is still running; that newer entry must not be deleted when the
    // stale promise settles.
    const clearIfCurrent = () => {
      if (this.inflight.get(key)?.promise === promise) {
        this.inflight.delete(key);
      }
    };
    promise.then(
      (result) => {
        if (this.getGeneration(resolvedSourceId) === generationAtStart) {
          // Pass `adapter` through so the settled result is stored under the SAME per-adapter
          // namespace the in-flight entry used (and that `get` will look it up under).
          this.set(cacheKey, result, resolvedSourceId, adapter);
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

  /** Number of live cached result entries. Primarily for observability/testing. */
  get size(): number {
    return this.cache.size;
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
