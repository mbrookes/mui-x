import { describe, it, expect, vi } from 'vitest';
import { cachedCompute } from './computedCache';

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
    const compute = () => ++callCount;
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
