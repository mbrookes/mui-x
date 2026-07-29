/**
 * Unit tests for the shared Redis wire-shape helpers (`cache/redisCompat.ts`).
 *
 * Focused on the two primitives both Redis providers now build on (finding M1):
 *   - `delKeys` — batched `DEL`, so an unbounded key list is never spread into a
 *     single variadic call (past V8's spread-argument limit that throws
 *     `RangeError: Maximum call stack size exceeded` before Redis is contacted).
 *   - `scanKeyPages` — streamed `SCAN`, yielding one cursor page at a time
 *     instead of accumulating every matching key.
 */
import { describe, it, expect } from 'vitest';
import { DEL_BATCH_SIZE, delKeys, scanKeyPages } from '../redisCompat';
import type { RedisClient } from '../RedisCacheProvider';

/** Records the argument count of every `del` call. */
function makeDelRecorder() {
  const calls: string[][] = [];
  const redis = {
    async get() {
      return null;
    },
    async set() {},
    async del(...keys: string[]) {
      calls.push(keys);
    },
  } as unknown as RedisClient;
  return { redis, calls };
}

describe('delKeys', () => {
  it('issues no command at all for an empty key list (DEL with no args is a syntax error)', async () => {
    const { redis, calls } = makeDelRecorder();
    await delKeys(redis, []);
    expect(calls).toHaveLength(0);
  });

  it('sends a single call when the list fits in one batch', async () => {
    const { redis, calls } = makeDelRecorder();
    const keys = Array.from({ length: DEL_BATCH_SIZE }, (_unused, i) => `k${i}`);
    await delKeys(redis, keys);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(DEL_BATCH_SIZE);
  });

  it('splits at the batch boundary (one key over → two calls)', async () => {
    const { redis, calls } = makeDelRecorder();
    const keys = Array.from({ length: DEL_BATCH_SIZE + 1 }, (_unused, i) => `k${i}`);
    await delKeys(redis, keys);
    expect(calls.map((c) => c.length)).toEqual([DEL_BATCH_SIZE, 1]);
  });

  it('covers every key exactly once, in order, across many batches', async () => {
    const { redis, calls } = makeDelRecorder();
    const keys = Array.from({ length: 2_501 }, (_unused, i) => `k${i}`);
    await delKeys(redis, keys);
    expect(Math.max(...calls.map((c) => c.length))).toBeLessThanOrEqual(DEL_BATCH_SIZE);
    expect(calls.flat()).toEqual(keys);
  });

  it('honors an explicit batch size, and never issues a zero-length batch', async () => {
    const { redis, calls } = makeDelRecorder();
    await delKeys(redis, ['a', 'b', 'c', 'd', 'e'], 2);
    expect(calls.map((c) => c.length)).toEqual([2, 2, 1]);
  });
});

describe('scanKeyPages', () => {
  /** ioredis-shaped mock paging `pageSize` keys at a time over a fixed key set. */
  function makeScanClient(allKeys: string[], pageSize: number) {
    let scanCalls = 0;
    const redis = {
      async get() {
        return null;
      },
      async set() {},
      async del() {},
      async scan(cursor: string) {
        scanCalls += 1;
        const start = Number(cursor);
        const page = allKeys.slice(start, start + pageSize);
        const next = start + pageSize >= allKeys.length ? '0' : String(start + pageSize);
        return [next, page] as [string, string[]];
      },
    } as unknown as RedisClient;
    return { redis, scanCalls: () => scanCalls };
  }

  it('yields one page per SCAN round-trip rather than one array at the end', async () => {
    const allKeys = Array.from({ length: 25 }, (_unused, i) => `k${i}`);
    const { redis } = makeScanClient(allKeys, 10);

    const pages: string[][] = [];
    for await (const page of scanKeyPages(redis, 'ioredis', 'k*', 10)) {
      pages.push(page);
    }

    expect(pages.map((p) => p.length)).toEqual([10, 10, 5]);
    expect(pages.flat()).toEqual(allKeys);
  });

  it('yields nothing (and does not throw) for a client with neither scan nor keys', async () => {
    const bare = {
      async get() {
        return null;
      },
      async set() {},
      async del() {},
    } as unknown as RedisClient;

    const pages: string[][] = [];
    for await (const page of scanKeyPages(bare, 'ioredis', 'k*', 10)) {
      pages.push(page);
    }
    expect(pages).toEqual([]);
  });

  it('falls back to a single KEYS page when the client has no scan', async () => {
    const legacy = {
      async get() {
        return null;
      },
      async set() {},
      async del() {},
      async keys() {
        return ['a', 'b'];
      },
    } as unknown as RedisClient;

    const pages: string[][] = [];
    for await (const page of scanKeyPages(legacy, 'ioredis', 'k*', 10)) {
      pages.push(page);
    }
    expect(pages).toEqual([['a', 'b']]);
  });
});
