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

  it('invalidateSource does not affect sources with a similar prefix', () => {
    cache.set('source-order:key-1', RESULT_A);
    cache.set('source-orders:key-1', RESULT_B);

    cache.invalidateSource('source-order');

    expect(cache.get('source-order:key-1')).toBeUndefined();
    // 'source-orders' has a different prefix when separated by ':'
    expect(cache.get('source-orders:key-1')).toBe(RESULT_B);
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
