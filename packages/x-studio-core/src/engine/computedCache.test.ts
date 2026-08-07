import { describe, it, expect, vi } from 'vitest';
import { cachedCompute, MAX_COMPUTED_ENTRIES_PER_ROWS } from './computedCache';

type Row = Record<string, unknown>;

describe('cachedCompute', () => {
  it('calls compute on first call and caches the result', () => {
    const rows: Row[] = [{ id: 1 }];
    const compute = vi.fn(() => 42);
    const result = cachedCompute(rows, 'key', compute);
    expect(result).toBe(42);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('returns the cached result and does not re-run compute on subsequent calls', () => {
    const rows: Row[] = [{ id: 1 }];
    const compute = vi.fn(() => ({ value: 'cached' }));
    const first = cachedCompute(rows, 'k', compute);
    const second = cachedCompute(rows, 'k', compute);
    expect(second).toBe(first);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('uses separate cache entries for different keys on the same rows', () => {
    const rows: Row[] = [{ id: 1 }];
    const computeA = vi.fn(() => 'A');
    const computeB = vi.fn(() => 'B');
    expect(cachedCompute(rows, 'a', computeA)).toBe('A');
    expect(cachedCompute(rows, 'b', computeB)).toBe('B');
    expect(computeA).toHaveBeenCalledTimes(1);
    expect(computeB).toHaveBeenCalledTimes(1);
  });

  it('uses separate cache entries for different rows arrays with the same key', () => {
    const rows1: Row[] = [{ id: 1 }];
    const rows2: Row[] = [{ id: 1 }]; // same content, different reference
    let callCount = 0;
    const compute = () => {
      callCount += 1;
      return callCount;
    };
    cachedCompute(rows1, 'key', compute);
    cachedCompute(rows2, 'key', compute);
    expect(callCount).toBe(2);
  });

  it('returns the same reference for rows with the same key (cache hit)', () => {
    const rows: Row[] = [{ id: 1 }];
    const obj = { labels: ['a'], values: [1] };
    const result1 = cachedCompute(rows, 'agg', () => obj);
    const result2 = cachedCompute(rows, 'agg', () => ({ labels: ['b'], values: [2] }));
    expect(result1).toBe(result2); // second compute fn never runs
    expect(result1).toBe(obj);
  });

  it('caches an `undefined` result without re-computing', () => {
    // The inner map stores boxed results, so a genuinely-cached `undefined` is still a HIT
    // (the LRU signals a miss with `undefined` itself).
    const rows: Row[] = [{ id: 1 }];
    const compute = vi.fn(() => undefined);
    expect(cachedCompute(rows, 'nothing', compute)).toBeUndefined();
    expect(cachedCompute(rows, 'nothing', compute)).toBeUndefined();
    expect(compute).toHaveBeenCalledTimes(1);
  });

  // The outer WeakMap key bounds nothing on its own: the inner key is caller-supplied widget
  // config, which churns on every chart/KPI edit while the rows array stays alive, and each
  // entry pins a full computed result. The shared insertion-order LRU caps that growth.
  it('evicts the least-recently-used entry past MAX_COMPUTED_ENTRIES_PER_ROWS', () => {
    const rows: Row[] = [{ id: 1 }];
    const first = cachedCompute(rows, 'cfg-0', () => ({ v: 0 }));
    // Fill the bucket with distinct keys, pushing 'cfg-0' out of the window.
    for (let i = 1; i <= MAX_COMPUTED_ENTRIES_PER_ROWS; i += 1) {
      cachedCompute(rows, `cfg-${i}`, () => ({ v: i }));
    }
    const recomputed = cachedCompute(rows, 'cfg-0', () => ({ v: 0 }));
    expect(recomputed).not.toBe(first);
  });

  it('keeps a repeatedly-read key alive across eviction pressure (recency refresh)', () => {
    const rows: Row[] = [{ id: 1 }];
    const hot = cachedCompute(rows, 'hot', () => ({ v: 'hot' }));
    for (let i = 1; i <= MAX_COMPUTED_ENTRIES_PER_ROWS * 2; i += 1) {
      cachedCompute(rows, `cold-${i}`, () => ({ v: i }));
      // Re-reading 'hot' moves it back to the newest position, so it is never the
      // eviction candidate.
      expect(cachedCompute(rows, 'hot', () => ({ v: 'recomputed' }))).toBe(hot);
    }
  });

  it('handles null-compatible values (e.g. 0, false) without re-computing', () => {
    const rows: Row[] = [{ id: 1 }];
    let calls = 0;
    const result1 = cachedCompute(rows, 'zero', () => {
      calls += 1;
      return 0;
    });
    const result2 = cachedCompute(rows, 'zero', () => {
      calls += 1;
      return 99;
    });
    expect(result1).toBe(0);
    expect(result2).toBe(0);
    expect(calls).toBe(1);
  });
});
