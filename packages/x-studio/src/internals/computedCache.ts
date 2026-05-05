/**
 * A two-level cache for computed values derived from Row[] arrays.
 *
 * Outer key: the Row[] reference (WeakMap — entries are GC'd automatically
 * when the row array is no longer referenced anywhere, e.g. after
 * resolvedRowsCache is invalidated by a data or filter change).
 *
 * Inner key: an opaque string encoding the computation parameters (xField,
 * yFields, aggregation, etc.).
 *
 * Usage: instead of computing an aggregation unconditionally on every React
 * component mount, wrap the computation with cachedCompute.  If the same Row[]
 * reference comes back from resolvedRowsCache (meaning the data and filters
 * haven't changed), the cached value is returned in O(1) — avoiding O(N)
 * aggregation work on every page switch.
 */

type Row = Record<string, unknown>;

const cacheStore = new WeakMap<Row[], Map<string, unknown>>();

/**
 * Returns a previously-cached result for `(rows, key)`, or calls `compute()`,
 * caches and returns its result.
 *
 * `rows` must be a Row[] (not null/undefined) — use an early-return guard before
 * calling this when the rows array may be empty or absent.
 *
 * `key` must capture every parameter that affects the computation result
 * (field names, aggregation mode, rank filter, etc.) but MUST NOT include
 * anything that changes on every React render (e.g. inline functions or new
 * object literals).  Primitive values joined into a string are ideal.
 */
export function cachedCompute<T>(rows: Row[], key: string, compute: () => T): T {
  let byKey = cacheStore.get(rows);
  if (!byKey) {
    byKey = new Map();
    cacheStore.set(rows, byKey);
  }
  if (byKey.has(key)) {
    return byKey.get(key) as T;
  }
  const result = compute();
  byKey.set(key, result);
  return result;
}
