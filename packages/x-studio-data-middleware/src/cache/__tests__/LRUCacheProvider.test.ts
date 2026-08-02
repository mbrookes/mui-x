/**
 * Unit tests for `LRUCacheProvider` paths not covered by `handler.test.ts`.
 *
 * handler.test.ts covers basic store/retrieve and a single invalidatePrefix
 * case. These tests target the prefix-index correctness (tenant isolation), the
 * fallback scan for non-indexed prefixes, value overwrite, and TTL expiry.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LRUCacheProvider } from '../LRUCacheProvider';
import { generateCacheKey } from '../../security/cacheKey';
import type { CacheEntry } from '../types';

function entry(rows: Record<string, unknown>[] = [{ id: 1 }]): CacheEntry {
  return { rows, cachedAt: 0 };
}

describe('LRUCacheProvider', () => {
  it('returns undefined for a key that was never set', async () => {
    const cache = new LRUCacheProvider();
    expect(await cache.get('nonexistent')).toBeUndefined();
  });

  it('overwrites an existing key with a new value', async () => {
    const cache = new LRUCacheProvider();
    await cache.set('k1', entry([{ v: 1 }]));
    await cache.set('k1', entry([{ v: 2 }]));
    expect((await cache.get('k1'))?.rows).toEqual([{ v: 2 }]);
  });

  it('returns an independent copy so mutating a warm hit does not corrupt the cache (finding T3.6)', async () => {
    const cache = new LRUCacheProvider();
    await cache.set('k1', entry([{ v: 1 }]));

    const first = await cache.get('k1');
    // A consumer mutates the rows it got back…
    (first!.rows[0] as { v: number }).v = 999;
    first!.rows.push({ v: 2 });

    // …a later reader must still see the ORIGINAL cached value, unmutated.
    const second = await cache.get('k1');
    expect(second?.rows).toEqual([{ v: 1 }]);
    // And the two reads are not the same object reference.
    expect(second).not.toBe(first);
  });

  describe('TTL expiry under continuous reads (regression for updateAgeOnGet)', () => {
    beforeEach(() => {
      // `lru-cache` uses `performance.now()` (not `Date.now()`) as its clock
      // source, and it captures a module-scoped reference to the *object*
      // `globalThis.performance` at import time. Vitest's fake-timer install
      // (`toFake: ['performance']`) swaps in a brand-new `performance` object
      // rather than patching the existing one in place, so it would not be
      // visible through lru-cache's already-captured reference. Instead, fake
      // only `Date`/`setTimeout` and monkey-patch `performance.now` in place
      // (same object, patched method) to track the fake `Date` clock — this
      // is visible to any code holding a reference to the real `performance`
      // object, including lru-cache.
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    it('expires an entry once its TTL elapses even when read more often than the TTL', async () => {
      // Regression test for finding 1.2: `updateAgeOnGet: true` used to reset the
      // TTL clock on every `get()`, so a key read faster than its TTL never
      // expired. With `updateAgeOnGet: false`, the TTL is a hard staleness bound
      // regardless of how often the entry is read.
      const cache = new LRUCacheProvider({ ttlMs: 30 });
      await cache.set('hot-key', entry([{ v: 1 }]));

      // Read repeatedly at an interval much faster than the TTL — three reads
      // 10ms apart (elapsed 0ms, 10ms, 20ms at each read), all comfortably
      // inside the 30ms TTL window.
      for (let i = 0; i < 3; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        expect(await cache.get('hot-key')).toBeDefined();
        vi.advanceTimersByTime(10);
      }

      // 30ms have elapsed since the write. Advance past the TTL and confirm
      // the entry now expires — despite every prior read landing well inside
      // the TTL window, the reads themselves must not have extended it.
      vi.advanceTimersByTime(15);
      expect(await cache.get('hot-key')).toBeUndefined();
    });
  });

  describe('ttlMs: 0 (finding 2.1 — parity with the Redis providers)', () => {
    // `lru-cache` treats `{ ttl: 0 }` as "no TTL" (immortal) — the OPPOSITE of
    // what `ttlMs: 0` means on `RedisCacheProvider`/`RedisTierCacheProvider`,
    // which floor it to a 1-second expiry (see the "ttlMs: 0 (finding 10)"
    // parity suite in `RedisCacheProvider.test.ts`). This locks in that
    // `LRUCacheProvider` now floors a per-call `ttlMs: 0` to `MIN_TTL_MS`
    // instead of storing the entry forever. See also
    // `ttlZeroCrossProviderParity.test.ts` for the full four-provider check.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    it('floors a per-call ttlMs: 0 to a finite TTL instead of "never expires"', async () => {
      const cache = new LRUCacheProvider();
      await cache.set('k1', entry(), { ttlMs: 0 });

      expect(await cache.get('k1')).toBeDefined();
      vi.advanceTimersByTime(1_100);
      expect(await cache.get('k1')).toBeUndefined();
    });

    it('floors a constructor-level ttlMs: 0 default to a finite TTL', async () => {
      const cache = new LRUCacheProvider({ ttlMs: 0 });
      await cache.set('k1', entry());

      expect(await cache.get('k1')).toBeDefined();
      vi.advanceTimersByTime(1_100);
      expect(await cache.get('k1')).toBeUndefined();
    });
  });

  describe('invalidatePrefix — prefix index (tenant isolation)', () => {
    it('drops every key for the targeted tenant and leaves other tenants intact', async () => {
      const cache = new LRUCacheProvider();
      await cache.set('studio:v1:acme:q1', entry());
      await cache.set('studio:v1:acme:q2', entry());
      await cache.set('studio:v1:globex:q1', entry());

      await cache.invalidatePrefix('studio:v1:acme:');

      expect(await cache.get('studio:v1:acme:q1')).toBeUndefined();
      expect(await cache.get('studio:v1:acme:q2')).toBeUndefined();
      expect(await cache.get('studio:v1:globex:q1')).toBeDefined();
    });

    it('is a no-op when the prefix matches no stored keys', async () => {
      const cache = new LRUCacheProvider();
      await cache.set('studio:v1:acme:q1', entry());
      await cache.invalidatePrefix('studio:v1:nobody:');
      expect(await cache.get('studio:v1:acme:q1')).toBeDefined();
    });

    it('keeps two colon-bearing tenants in separate eviction buckets (finding 3.2)', async () => {
      // Regression: a tenantId containing ':' (e.g. `org:1234`) used to shift the
      // key segment boundaries, so `extractPrefix` derived `studio:v1:org:` for
      // BOTH `org:1234` and `org:5678` — collapsing distinct tenants into one
      // prefix-invalidation bucket. `generateCacheKey` now URL-encodes the tenant
      // segment, so each tenant gets its own bucket keyed on the encoded id.
      const cache = new LRUCacheProvider();
      const secret = 'colon-tenant-secret';
      const descriptor = { id: 'w1', table: 'sales' };
      const keyA = generateCacheKey(
        { tenantId: 'org:1234', userId: 'u', roleIds: [] },
        descriptor,
        secret,
      );
      const keyB = generateCacheKey(
        { tenantId: 'org:5678', userId: 'u', roleIds: [] },
        descriptor,
        secret,
      );
      await cache.set(keyA, entry());
      await cache.set(keyB, entry());

      // Invalidate ONLY tenant `org:1234`, using its encoded tenant prefix.
      await cache.invalidatePrefix(`studio:v1:${encodeURIComponent('org:1234')}:`);

      expect(await cache.get(keyA)).toBeUndefined();
      // The sibling colon-tenant must survive — it is a different bucket.
      expect(await cache.get(keyB)).toBeDefined();
    });
  });

  describe('deleteByTag', () => {
    it('removes entries with the given tag and leaves others intact', async () => {
      const cache = new LRUCacheProvider();
      await cache.set('k1', entry(), { tags: ['sales'] });
      await cache.set('k2', entry(), { tags: ['sales'] });
      await cache.set('k3', entry(), { tags: ['orders'] });

      await cache.deleteByTag('sales');

      expect(await cache.get('k1')).toBeUndefined();
      expect(await cache.get('k2')).toBeUndefined();
      expect(await cache.get('k3')).toBeDefined();
    });

    it('is a no-op when the tag has no associated entries', async () => {
      const cache = new LRUCacheProvider();
      await cache.set('k1', entry(), { tags: ['orders'] });
      await cache.deleteByTag('sales');
      expect(await cache.get('k1')).toBeDefined();
    });

    it('records an invalidation epoch even when the tag matched nothing to evict', async () => {
      // `deleteByTag` can only evict keys that ALREADY exist, so a read in flight
      // across a mutation would otherwise store pre-mutation rows under a key the
      // eviction never saw. The epoch — stamped even for a tag with no members,
      // which is exactly the racing case — is what lets the writer notice.
      const cache = new LRUCacheProvider();
      const readStartedAt = Date.now();
      await cache.deleteByTag('sales');

      expect(await cache.wereTagsInvalidatedSince(['sales'], readStartedAt)).toBe(true);
      // A read that started AFTER the invalidation already saw the write, and a
      // tag never invalidated has no epoch at all.
      expect(await cache.wereTagsInvalidatedSince(['sales'], Date.now() + 1)).toBe(false);
      expect(await cache.wereTagsInvalidatedSince(['orders'], 0)).toBe(false);
      // Any ONE tag of a joined result is enough to disqualify the pending write.
      expect(await cache.wereTagsInvalidatedSince(['orders', 'sales'], 0)).toBe(true);
    });

    it('removes an entry tagged with multiple tags when any tag is deleted', async () => {
      const cache = new LRUCacheProvider();
      await cache.set('k1', entry(), { tags: ['sales', 'q4'] });
      await cache.deleteByTag('q4');
      expect(await cache.get('k1')).toBeUndefined();
    });

    it('cleans up tagIndex entries for all tags on an evicted key', async () => {
      const cache = new LRUCacheProvider();
      await cache.set('k1', entry(), { tags: ['sales', 'q4'] });
      await cache.deleteByTag('sales'); // deletes k1; q4 tag set should also be cleaned up
      expect(await cache.get('k1')).toBeUndefined();
      // Verify no stale k1 entry under q4 — deleteByTag on q4 must be a no-op (no throw)
      await cache.deleteByTag('q4');
      expect(await cache.get('k1')).toBeUndefined();
    });
  });

  describe('invalidatePrefix — fallback scan for non-indexed prefixes', () => {
    it('removes matching keys via the scan fallback when the prefix is broader than the index key', async () => {
      const cache = new LRUCacheProvider();
      // The index key for these is "studio:v1:<tenant>:"; a broader prefix
      // ("studio:v1:") is not in the index and must hit the scan fallback.
      await cache.set('studio:v1:acme:q1', entry());
      await cache.set('studio:v1:globex:q1', entry());

      await cache.invalidatePrefix('studio:v1:');

      expect(await cache.get('studio:v1:acme:q1')).toBeUndefined();
      expect(await cache.get('studio:v1:globex:q1')).toBeUndefined();
    });
  });

  describe('byte-based eviction under real maxSizeBytes pressure', () => {
    // sizeCalculation = value.rows.length * avgBytesPerRow + 64 (see LRUCacheProvider.ts).
    // With avgBytesPerRow=100 and 1 row per entry, each entry costs 164 bytes.
    // maxSizeBytes=500 fits ~3 entries — writing 6 must force real lru-cache
    // eviction (as opposed to the explicit `.delete()`-driven tests above,
    // which never exercise the `maxSize`/`sizeCalculation` byte-pressure path).
    it('evicts least-recently-used entries once total size exceeds maxSizeBytes', async () => {
      const cache = new LRUCacheProvider({ maxSizeBytes: 500, avgBytesPerRow: 100 });
      for (let i = 0; i < 6; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await cache.set(`k${i}`, entry([{ v: i }]));
      }

      let present = 0;
      for (let i = 0; i < 6; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        if (await cache.get(`k${i}`)) {
          present += 1;
        }
      }
      // Not all 6 entries can fit under the byte cap — some must have been evicted.
      expect(present).toBeGreaterThan(0);
      expect(present).toBeLessThan(6);

      // LRU semantics: the most recently written key must survive, and the
      // very first (least-recently-used) key must have been evicted.
      expect(await cache.get('k5')).toBeDefined();
      expect(await cache.get('k0')).toBeUndefined();
    });

    it('evicts a larger (multi-row) entry sooner than several small entries under the same byte cap', async () => {
      const cache = new LRUCacheProvider({ maxSizeBytes: 500, avgBytesPerRow: 100 });
      // A 4-row entry costs 4*100+64=464 bytes — nearly the whole budget on its own.
      await cache.set('big', entry([{ v: 0 }, { v: 1 }, { v: 2 }, { v: 3 }]));
      expect(await cache.get('big')).toBeDefined();

      // Writing several small (164-byte) entries afterward must evict 'big'
      // once the cumulative size exceeds maxSizeBytes.
      for (let i = 0; i < 4; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await cache.set(`small${i}`, entry([{ v: i }]));
      }

      expect(await cache.get('big')).toBeUndefined();
      // The most recently written small entry must still be present.
      expect(await cache.get('small3')).toBeDefined();
    });

    it('keeps every entry when their combined size stays under maxSizeBytes', async () => {
      const cache = new LRUCacheProvider({ maxSizeBytes: 10_000, avgBytesPerRow: 100 });
      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await cache.set(`k${i}`, entry([{ v: i }]));
      }
      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        expect(await cache.get(`k${i}`)).toBeDefined();
      }
    });
  });

  describe('byte-size estimation accounts for real row content (Tier3 finding — byte-accounting gap)', () => {
    // Before the fix, `sizeCalculation` was `rows.length * avgBytesPerRow + 64` —
    // purely a function of ROW COUNT, blind to how big any individual row's
    // fields actually are. A single-row entry carrying a large TEXT/JSON value
    // would be estimated identically to a single-row entry of tiny scalars, so
    // the LRU could believe it was comfortably under `maxSizeBytes` while the
    // process held far more live memory than the cache thought it did.
    it('evicts a small-configured-average entry sooner when its rows actually carry large string payloads', async () => {
      const cache = new LRUCacheProvider({ maxSizeBytes: 2_000, avgBytesPerRow: 50 });
      // A single row whose one field is a large string — the COUNT-only estimate
      // (1 row * 50 avgBytesPerRow + 64 = 114 bytes) would say this entry is
      // tiny; its REAL JSON-serialized size is far larger.
      const largePayload = 'x'.repeat(5_000);
      await cache.set('large', entry([{ blob: largePayload }]));
      // A handful of genuinely small entries that the (correct) estimate should
      // still comfortably admit under the same byte budget.
      for (let i = 0; i < 3; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await cache.set(`small${i}`, entry([{ v: i }]));
      }

      // The oversized entry must have been evicted (its real size — thousands of
      // bytes — blew through the 2,000-byte budget on its own), even though a
      // pure row-count estimate at avgBytesPerRow=50 would never have evicted it.
      expect(await cache.get('large')).toBeUndefined();
      // The small entries, whose real content is tiny, must still fit.
      expect(await cache.get('small2')).toBeDefined();
    });

    it('never estimates BELOW the configured avgBytesPerRow, even for a tiny sampled row', async () => {
      // Floored at the configured average (Math.max(sampled, avgBytesPerRow)) —
      // this keeps every pre-existing small-row test's byte arithmetic exactly
      // as documented above (rows.length * avgBytesPerRow + 64) unchanged, since
      // a tiny row's real serialized size never exceeds a generous configured
      // average.
      const cache = new LRUCacheProvider({ maxSizeBytes: 500, avgBytesPerRow: 100 });
      await cache.set('k1', entry([{ v: 1 }]));
      // Same byte-pressure scenario as the count-only tests above: writing
      // enough small entries must still force eviction under the SAME
      // configured-average arithmetic (164 bytes/entry), proving the floor is
      // still in effect rather than the sampled (much smaller) real size
      // silently shrinking the estimate.
      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await cache.set(`k${i}`, entry([{ v: i }]));
      }
      let present = 0;
      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        if (await cache.get(`k${i}`)) {
          present += 1;
        }
      }
      expect(present).toBeGreaterThan(0);
      expect(present).toBeLessThan(5);
    });

    it('extrapolates a large-row estimate from a bounded sample across a result set bigger than the sample', async () => {
      // A 25-row entry where every row is large — bigger than SIZE_SAMPLE_ROWS
      // (20), so the estimate necessarily EXTRAPOLATES the sampled average
      // across every row rather than measuring each one. A pure count-only
      // estimate (25 rows * avgBytesPerRow(10) + 64 = 314 bytes) would let many
      // such entries fit comfortably under a 30,000-byte budget; the real
      // content (25 rows * ~1KB each ≈ 25KB per entry) means only ONE such
      // entry fits at a time, forcing real eviction on every subsequent write.
      const cache = new LRUCacheProvider({ maxSizeBytes: 30_000, avgBytesPerRow: 10 });
      const bigRow = { blob: 'y'.repeat(1_000) };
      const makeBigEntry = () => entry(Array.from({ length: 25 }, () => ({ ...bigRow })));

      await cache.set('first', makeBigEntry());
      await cache.set('second', makeBigEntry());
      await cache.set('third', makeBigEntry());

      // Only the most-recently-written large entry can fit under the byte
      // budget once real content size is accounted for — the earliest one(s)
      // must have been evicted.
      expect(await cache.get('third')).toBeDefined();
      expect(await cache.get('first')).toBeUndefined();
    });
  });

  describe('the sampled rows are STRIDED, not a client-choosable prefix (finding — sampling bypass)', () => {
    /**
     * Row ORDER is fully client-controlled: `execute.ts` applies every `orderBy`
     * entry of a widget descriptor before the LIMIT, so a caller decides which
     * rows land at the front of a result set. While `sizeCalculation` sampled
     * `rows[0..SIZE_SAMPLE_ROWS-1]` — a contiguous PREFIX — that meant the caller
     * also decided which rows got MEASURED: a result whose leading rows are tiny
     * scalars and whose tail carries a large TEXT/JSON column was estimated at
     * the configured floor while really retaining orders of magnitude more, for
     * the whole TTL.
     *
     * Sampling `rows[floor(i * rows.length / sampleSize)]` instead keeps the
     * callback O(SIZE_SAMPLE_ROWS) but spreads the probes across the whole
     * result, so no contiguous run of rows a caller can push to the front hides
     * the rest.
     */
    const SAMPLE_ROWS = 20;

    /**
     * `total` rows where only the first `SAMPLE_ROWS` are tiny — exactly the
     * window a prefix sample measured — and every later row carries a ~2KB payload.
     */
    function tinyHeadLargeTail(total: number): Record<string, unknown>[] {
      return Array.from({ length: total }, (_, i) =>
        i < SAMPLE_ROWS ? { v: i } : { blob: 'z'.repeat(2_000) },
      );
    }

    it('accounts for large rows hidden behind a tiny leading window', async () => {
      // 100 rows: 20 tiny + 80 x ~2KB, so ~161KB of real content per entry.
      // Prefix sampling measured only the 20 tiny rows, so the estimate fell to
      // the configured floor (100 x 50 + 64 = 5,064 bytes) and BOTH entries were
      // admitted — roughly 322KB retained against a 200,000-byte budget.
      const cache = new LRUCacheProvider({ maxSizeBytes: 200_000, avgBytesPerRow: 50 });
      await cache.set('a', entry(tinyHeadLargeTail(100)));
      await cache.set('b', entry(tinyHeadLargeTail(100)));

      // With strided sampling each entry is estimated at roughly 161KB, so the
      // second write cannot coexist with the first under the byte budget.
      expect(await cache.get('b')).toBeDefined();
      expect(await cache.get('a')).toBeUndefined();
    });

    it('estimates the same result set the same way however the caller orders it', async () => {
      // The bypass, stated as the invariant it broke: two entries holding the
      // SAME rows and differing only in ORDER must be accounted identically,
      // because order is a client input while byte accounting is a server budget.
      const rows = tinyHeadLargeTail(100);
      const reversed = [...rows].reverse();

      const outcome = async (ordered: Record<string, unknown>[]) => {
        const cache = new LRUCacheProvider({ maxSizeBytes: 200_000, avgBytesPerRow: 50 });
        await cache.set('a', entry(ordered));
        await cache.set('b', entry([...ordered]));
        return {
          a: (await cache.get('a')) !== undefined,
          b: (await cache.get('b')) !== undefined,
        };
      };

      expect(await outcome(rows)).toEqual(await outcome(reversed));
    });
  });
});

// ── `maxEntryBytes` ──────────────────────────────────────────────────────────
//
// A documented public constructor option (a 20-line docblock, and `ARCHITECTURE.md` names it
// as the supported way for a host to stop "one very large result occupying most of
// `maxSizeBytes` and evicting everything else on the way in"). It is forwarded to
// `lru-cache`'s `maxEntrySize`, and making it a silent no-op (`maxEntrySize: undefined`) was
// green across the whole package — the identifier appeared in no test file at all. A refactor,
// or an `lru-cache` major renaming `maxEntrySize`, would drop the eviction-storm protection a
// host explicitly opted into without a single failing test.
describe('LRUCacheProvider maxEntryBytes', () => {
  /** ~200 rows carrying a large-ish payload each, comfortably over a 1 KiB per-entry cap. */
  function bigEntry(): CacheEntry {
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: i, blob: 'x'.repeat(64) }));
    return { rows, cachedAt: 0 };
  }

  it('refuses to store an entry larger than maxEntryBytes', async () => {
    const cache = new LRUCacheProvider({ maxSizeBytes: 8 * 1024 * 1024, maxEntryBytes: 1024 });

    await cache.set('big', bigEntry());

    // Not stored at all — `lru-cache` rejects the insert rather than admitting and
    // immediately evicting it.
    expect(await cache.get('big')).toBeUndefined();
  });

  it('stores that SAME entry when maxEntryBytes is not configured', async () => {
    // The control that makes the case above a statement about the option rather than about
    // the entry: identical payload, identical `maxSizeBytes`, option absent.
    const cache = new LRUCacheProvider({ maxSizeBytes: 8 * 1024 * 1024 });

    await cache.set('big', bigEntry());

    expect((await cache.get('big'))?.rows).toHaveLength(200);
  });

  it('still stores an entry comfortably under the cap', async () => {
    const cache = new LRUCacheProvider({ maxSizeBytes: 8 * 1024 * 1024, maxEntryBytes: 64 * 1024 });

    await cache.set('small', entry([{ v: 1 }]));

    expect((await cache.get('small'))?.rows).toEqual([{ v: 1 }]);
  });

  it('does not evict entries already resident when an over-cap entry is rejected', async () => {
    // The point of the option: one huge result must not push everything else out on its way in.
    const cache = new LRUCacheProvider({ maxSizeBytes: 8 * 1024 * 1024, maxEntryBytes: 1024 });
    await cache.set('keep-me', entry([{ v: 1 }]));

    await cache.set('big', bigEntry());

    expect((await cache.get('keep-me'))?.rows).toEqual([{ v: 1 }]);
    expect(await cache.get('big')).toBeUndefined();
  });
});
