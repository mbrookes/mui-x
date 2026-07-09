import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StudioRequestCache } from './StudioRequestCache';
import type { StudioQueryResult } from '../models';

const RESULT_A: StudioQueryResult = { rows: [{ id: '1', value: 100 }], totalCount: 1 };
const RESULT_B: StudioQueryResult = { rows: [{ id: '2', value: 200 }], totalCount: 1 };

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('StudioRequestCache', () => {
  let cache: StudioRequestCache;

  beforeEach(() => {
    cache = new StudioRequestCache(1000); // 1s TTL for testing
  });

  // ── get / set ─────────────────────────────────────────────────────────────

  it('returns undefined for a cache miss', () => {
    expect(cache.get('key-1')).toBeUndefined();
  });

  it('returns a stored result for a cache hit', () => {
    cache.set('key-1', RESULT_A);
    expect(cache.get('key-1')).toBe(RESULT_A);
  });

  it('returns the same Row[] reference (no copy)', () => {
    cache.set('key-1', RESULT_A);
    expect(cache.get('key-1')!.rows).toBe(RESULT_A.rows);
  });

  it('returns undefined after TTL expires', async () => {
    const shortCache = new StudioRequestCache(50); // 50ms TTL
    shortCache.set('key-1', RESULT_A);
    expect(shortCache.get('key-1')).toBe(RESULT_A);
    await sleep(60);
    expect(shortCache.get('key-1')).toBeUndefined();
  });

  // ── in-flight deduplication ───────────────────────────────────────────────

  it('isInflight returns false before a request is registered', () => {
    expect(cache.isInflight('key-1')).toBe(false);
  });

  it('isInflight returns true while a request is in-flight', () => {
    const promise = new Promise<StudioQueryResult>((resolve) => {
      setTimeout(() => resolve(RESULT_A), 200);
    });
    cache.addInflight('key-1', promise);
    expect(cache.isInflight('key-1')).toBe(true);
  });

  it('isInflight returns false after the promise resolves', async () => {
    let resolve!: (r: StudioQueryResult) => void;
    const promise = new Promise<StudioQueryResult>((res) => {
      resolve = res;
    });
    cache.addInflight('key-1', promise);
    expect(cache.isInflight('key-1')).toBe(true);
    resolve(RESULT_A);
    await promise;
    expect(cache.isInflight('key-1')).toBe(false);
  });

  it('populates the cache when an in-flight request resolves', async () => {
    let resolve!: (r: StudioQueryResult) => void;
    const promise = new Promise<StudioQueryResult>((res) => {
      resolve = res;
    });
    cache.addInflight('key-1', promise);
    expect(cache.get('key-1')).toBeUndefined(); // not yet in cache
    resolve(RESULT_A);
    await promise;
    expect(cache.get('key-1')).toBe(RESULT_A);
  });

  it('deduplicates: addInflight called once, both callers get the same result', async () => {
    const getRows = vi.fn().mockResolvedValue(RESULT_A);
    const promise = getRows();
    cache.addInflight('key-1', promise);

    // Second caller sees the inflight promise
    const inflightPromise = cache.getInflight('key-1');
    expect(inflightPromise).toBe(promise);

    const [r1, r2] = await Promise.all([promise, inflightPromise!]);
    expect(r1).toBe(RESULT_A);
    expect(r2).toBe(RESULT_A);
    expect(getRows).toHaveBeenCalledTimes(1);
  });

  it('clears the in-flight entry when the promise rejects', async () => {
    const error = new Error('fetch failed');
    let reject!: (err: Error) => void;
    const promise = new Promise<StudioQueryResult>((_, rej) => {
      reject = rej;
    });
    cache.addInflight('key-1', promise);
    reject(error);
    await promise.catch(() => {});
    expect(cache.isInflight('key-1')).toBe(false);
    // Cache should not be populated on rejection
    expect(cache.get('key-1')).toBeUndefined();
  });

  // ── invalidateSource ──────────────────────────────────────────────────────

  it('invalidateSource clears all entries for a sourceId', () => {
    cache.set('source-orders:key-1', RESULT_A);
    cache.set('source-orders:key-2', RESULT_B);
    cache.set('source-customers:key-1', RESULT_A);

    cache.invalidateSource('source-orders');

    expect(cache.get('source-orders:key-1')).toBeUndefined();
    expect(cache.get('source-orders:key-2')).toBeUndefined();
    // Unrelated source should be unaffected
    expect(cache.get('source-customers:key-1')).toBe(RESULT_A);
  });

  it('does NOT re-cache an in-flight result that was invalidated mid-flight', async () => {
    // Regression: a request already in flight when `invalidateSource` runs would, on
    // resolving, still write its (now stale) result into the cache with a fresh TTL — so a
    // later call with the SAME (unchanged) descriptor got a cache HIT on the stale data
    // instead of triggering a genuine re-fetch.
    const cacheKey = 'source-orders:key-1';
    let resolve!: (r: StudioQueryResult) => void;
    const promise = new Promise<StudioQueryResult>((res) => {
      resolve = res;
    });
    cache.addInflight(cacheKey, promise);

    // Source is invalidated (e.g. host pushed fresh data) while the request is still pending.
    cache.invalidateSource('source-orders');

    // The in-flight request now resolves with its pre-invalidation result.
    resolve(RESULT_A);
    await promise;

    // The awaiting caller still received RESULT_A (asserted below), but the cache must NOT
    // have been populated with it — a subsequent lookup must miss so a fresh fetch happens.
    expect(await promise).toBe(RESULT_A);
    expect(cache.get(cacheKey)).toBeUndefined();
  });

  it('re-caches normally for a request that was NOT invalidated mid-flight', async () => {
    // Guards against over-invalidating: a request whose source was never invalidated (or
    // was invalidated for a DIFFERENT source) must still populate the cache on resolve.
    const cacheKey = 'source-orders:key-1';
    let resolve!: (r: StudioQueryResult) => void;
    const promise = new Promise<StudioQueryResult>((res) => {
      resolve = res;
    });
    cache.addInflight(cacheKey, promise);

    cache.invalidateSource('source-customers'); // unrelated source

    resolve(RESULT_A);
    await promise;

    expect(cache.get(cacheKey)).toBe(RESULT_A);
  });

  it('a caller arriving AFTER invalidation does not join the stale in-flight request', async () => {
    // Regression (2.3): invalidateSource used to leave the in-flight promise in place, so a
    // widget whose effect re-ran after invalidation would find the stale promise via
    // getInflight, join it, and render pre-invalidation rows with no follow-up fetch. After
    // invalidation the in-flight request must read as absent so a fresh fetch is started.
    const cacheKey = 'source-orders:key-1';
    let resolveStale!: (r: StudioQueryResult) => void;
    const stalePromise = new Promise<StudioQueryResult>((res) => {
      resolveStale = res;
    });
    cache.addInflight(cacheKey, stalePromise, 'source-orders');
    expect(cache.isInflight(cacheKey)).toBe(true);
    expect(cache.getInflight(cacheKey)).toBe(stalePromise);

    cache.invalidateSource('source-orders');

    // The stale request is still running, but new callers must not join it.
    expect(cache.isInflight(cacheKey)).toBe(false);
    expect(cache.getInflight(cacheKey)).toBeUndefined();

    // A caller arriving now starts a genuinely fresh request.
    let resolveFresh!: (r: StudioQueryResult) => void;
    const freshPromise = new Promise<StudioQueryResult>((res) => {
      resolveFresh = res;
    });
    const joined = cache.getInflight(cacheKey);
    expect(joined).toBeUndefined();
    cache.addInflight(cacheKey, freshPromise, 'source-orders');
    expect(cache.getInflight(cacheKey)).toBe(freshPromise);

    // Both settle: the stale result must NOT be cached; the fresh result must be, and the
    // stale request settling must not evict the fresh in-flight entry.
    resolveStale(RESULT_A);
    await stalePromise;
    expect(cache.getInflight(cacheKey)).toBe(freshPromise);

    resolveFresh(RESULT_B);
    await freshPromise;

    // The rendered value is the fresh result, never the stale one.
    expect(cache.get(cacheKey)).toBe(RESULT_B);
  });

  it('invalidateSource does not affect sources with a similar prefix', () => {
    cache.set('source-order:key-1', RESULT_A);
    cache.set('source-orders:key-1', RESULT_B);

    cache.invalidateSource('source-order');

    expect(cache.get('source-order:key-1')).toBeUndefined();
    // 'source-orders' has a different prefix when separated by ':'
    expect(cache.get('source-orders:key-1')).toBe(RESULT_B);
  });

  // ── explicit sourceId (finding 1.4) ────────────────────────────────────────
  // A sourceId may itself contain a ':' (e.g. `db:public.orders`). The cacheKey format
  // is `${sourceId}:${queryShape}`, so the legacy `split(':')[0]` parse truncates such a
  // sourceId to its first segment. Passing descriptor.sourceId explicitly fixes it while
  // keeping the parse as the fallback for legacy call sites.

  it('invalidateSource works for a sourceId containing a colon', () => {
    const sourceId = 'db:public.orders';
    const cacheKey = `${sourceId}:{"select":[]}`;
    cache.set(cacheKey, RESULT_A, sourceId);
    expect(cache.get(cacheKey)).toBe(RESULT_A);

    cache.invalidateSource(sourceId);
    expect(cache.get(cacheKey)).toBeUndefined();
  });

  it('generation guard works for a sourceId containing a colon', async () => {
    const sourceId = 'db:public.orders';
    const cacheKey = `${sourceId}:{"select":[]}`;
    let resolve!: (r: StudioQueryResult) => void;
    const promise = new Promise<StudioQueryResult>((res) => {
      resolve = res;
    });
    cache.addInflight(cacheKey, promise, sourceId);

    // Invalidate the (colon-containing) source mid-flight.
    cache.invalidateSource(sourceId);
    resolve(RESULT_A);
    await promise;

    // Generation captured under the true sourceId advanced → stale result NOT cached.
    expect(cache.get(cacheKey)).toBeUndefined();
  });

  it('legacy call sites without explicit sourceId keep first-colon behavior', () => {
    // Protects the unowned useChartWidgetData path, which still calls set/addInflight
    // without a sourceId — the first-colon parse remains the fallback.
    cache.set('source-orders:key-1', RESULT_A);
    cache.invalidateSource('source-orders');
    expect(cache.get('source-orders:key-1')).toBeUndefined();
  });

  it('TTL-expired entry is removed from the correct source index when sourceId contains a colon', async () => {
    const short = new StudioRequestCache(50);
    const sourceId = 'db:public.orders';
    const cacheKey = `${sourceId}:{"q":1}`;
    short.set(cacheKey, RESULT_A, sourceId);
    await sleep(60);
    // TTL cleanup (on get) must target the entry's stored sourceId bucket, not the parse.
    expect(short.get(cacheKey)).toBeUndefined();
    // Re-populate + invalidate to confirm the true bucket stayed consistent.
    short.set(cacheKey, RESULT_B, sourceId);
    short.invalidateSource(sourceId);
    expect(short.get(cacheKey)).toBeUndefined();
  });

  // ── bounded growth / eviction (finding 2.18) ───────────────────────────────
  // The cache is a module-level singleton. Every distinct descriptor (each filter/
  // date-range tweak produces a new cacheKey) inserts an entry holding the full row array.
  // Entries used to be removed ONLY when the SAME key was re-requested after TTL, on
  // invalidateSource, or clear() — so keys never re-requested were never evicted and the
  // singleton grew monotonically for the life of the page. set() must now bound growth.

  it('caps the number of entries and evicts the least-recently-used one', () => {
    const bounded = new StudioRequestCache(60_000, 3); // long TTL, cap of 3
    bounded.set('source:key-1', RESULT_A);
    bounded.set('source:key-2', RESULT_A);
    bounded.set('source:key-3', RESULT_A);
    expect(bounded.size).toBe(3);

    // Touch key-1 so key-2 becomes the least-recently-used entry.
    expect(bounded.get('source:key-1')).toBe(RESULT_A);

    // Inserting a 4th entry must evict exactly one entry (the LRU: key-2), not grow to 4.
    bounded.set('source:key-4', RESULT_B);
    expect(bounded.size).toBe(3);
    expect(bounded.get('source:key-2')).toBeUndefined(); // evicted
    expect(bounded.get('source:key-1')).toBe(RESULT_A); // recently used → kept
    expect(bounded.get('source:key-3')).toBe(RESULT_A);
    expect(bounded.get('source:key-4')).toBe(RESULT_B);
  });

  it('does not grow unbounded under interactive descriptor churn', () => {
    const bounded = new StudioRequestCache(60_000, 10);
    // Simulate 1000 distinct filter/date-range descriptors, none ever re-requested.
    for (let i = 0; i < 1000; i += 1) {
      bounded.set(`source:key-${i}`, { rows: [{ id: i }], totalCount: 1 });
    }
    // Without the cap this would hold 1000 row arrays; it must stay bounded.
    expect(bounded.size).toBeLessThanOrEqual(10);
  });

  it('sweeps expired entries on set() even for keys that are never re-requested', async () => {
    const short = new StudioRequestCache(50, 1000); // short TTL, large cap
    // These keys expire and are never get()-requested again, so the old on-get cleanup
    // would never reclaim them.
    short.set('source:cold-1', RESULT_A);
    short.set('source:cold-2', RESULT_A);
    expect(short.size).toBe(2);

    await sleep(60); // both entries are now expired

    // A write for a DIFFERENT key must sweep the expired cold entries as a side effect,
    // so the cache does not accumulate dead entries that are never read again.
    short.set('source:warm', RESULT_B);
    expect(short.size).toBe(1);
    expect(short.get('source:cold-1')).toBeUndefined();
    expect(short.get('source:cold-2')).toBeUndefined();
    expect(short.get('source:warm')).toBe(RESULT_B);
  });

  it('keeps the source index consistent after eviction', () => {
    const bounded = new StudioRequestCache(60_000, 2);
    bounded.set('source-a:key-1', RESULT_A);
    bounded.set('source-a:key-2', RESULT_A);
    // Evicts source-a:key-1 (LRU).
    bounded.set('source-b:key-1', RESULT_B);
    expect(bounded.get('source-a:key-1')).toBeUndefined();

    // Invalidate the source whose entry was evicted — must not resurrect it or throw, and
    // the surviving entries must be untouched by a stale reverse-index reference.
    bounded.invalidateSource('source-a');
    expect(bounded.get('source-a:key-2')).toBeUndefined();
    expect(bounded.get('source-b:key-1')).toBe(RESULT_B);
  });

  // ── clear ─────────────────────────────────────────────────────────────────

  it('clear removes all entries', () => {
    cache.set('key-1', RESULT_A);
    cache.set('key-2', RESULT_B);
    cache.clear();
    expect(cache.get('key-1')).toBeUndefined();
    expect(cache.get('key-2')).toBeUndefined();
  });
});
