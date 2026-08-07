import { getLruEntry, getOrCreateBucket, setLruEntry } from './rowCacheLru';

/**
 * A two-level cache for computed values derived from Row[] arrays.
 *
 * Outer key: the Row[] reference (WeakMap — entries are GC'd automatically
 * when the row array is no longer referenced anywhere, e.g. after
 * resolvedRowsCache is invalidated by a data or filter change).
 *
 * Inner key: an opaque string encoding the computation parameters (xField,
 * yFields, aggregation, etc.), capped through the shared insertion-order LRU in
 * `rowCacheLru.ts` like the row caches. The outer WeakMap key bounds nothing on its
 * own: the caller-supplied key is derived from widget config, which churns on every
 * chart/KPI config edit while the rows array stays alive, and each entry pins a full
 * computed result (series arrays, sparkline data) for the lifetime of those rows.
 *
 * Usage: instead of computing an aggregation unconditionally on every React component mount, wrap
 * the computation with cachedCompute. If the same Row[] reference comes back from resolvedRowsCache
 * (meaning the data and filters haven't changed), the cached value is returned in O(1) — avoiding
 * O(N) aggregation work on every page switch.
 */

type Row = Record<string, unknown>;

/**
 * A cached result is boxed so that a genuinely-cached `undefined` is distinguishable
 * from a miss (`getLruEntry` signals a miss with `undefined`).
 */
interface CachedResult {
  value: unknown;
}

const cacheStore = new WeakMap<Row[], Map<string, CachedResult>>();

/**
 * Cap on distinct computed values kept per rows array — deliberately looser than the row
 * caches' `MAX_ENTRIES_PER_ROWS`.
 *
 * One rows array is SHARED by every widget with the same source and effective filters (that
 * sharing is what `resolvedRowsCache` exists for), and a single widget contributes several keys
 * (a KPI computes its value, its previous-period value and its sparkline). A page of a dozen
 * widgets on one source therefore lives well above the row caches' bound, and capping at the
 * same number would evict entries that are still on screen — thrash, not bounding. Each entry
 * here holds an aggregated result (labels/values arrays), orders of magnitude smaller than the
 * full row clones the row caches retain, so a larger window is cheap.
 */
export const MAX_COMPUTED_ENTRIES_PER_ROWS = 64;

/**
 * Returns a previously-cached result for `(rows, key)`, or calls `compute()`,
 * caches and returns its result.
 *
 * `rows` must be a Row[] (not null/undefined) — use an early-return guard before
 * calling this when the rows array may be empty or absent.
 *
 * `key` must capture every parameter that affects the computation result (field names, aggregation
 * mode, rank filter, etc.) but MUST NOT include anything that changes on every React render (e.g.
 * inline functions or new object literals). Primitive values joined into a string are ideal.
 */
export function cachedCompute<T>(rows: Row[], key: string, compute: () => T): T {
  const byKey = getOrCreateBucket(cacheStore, rows);
  // `getLruEntry` refreshes recency on read, so the key a mounted widget keeps asking
  // for is never the eviction candidate.
  const existing = getLruEntry(byKey, key);
  if (existing !== undefined) {
    return existing.value as T;
  }
  const result = compute();
  // `setLruEntry` evicts the least-recently-used entries before inserting when at capacity.
  setLruEntry(byKey, key, { value: result }, MAX_COMPUTED_ENTRIES_PER_ROWS);
  return result;
}
