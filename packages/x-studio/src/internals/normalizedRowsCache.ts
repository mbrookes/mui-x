import { normalizeDataSourceRows } from './chartUtils';
import type { StudioDataField, StudioDataSource } from '../models';

type Row = Record<string, unknown>;

// ─── Per-rows cache ───────────────────────────────────────────────────────────
//
// Outer key: dataSource.rows (WeakMap — entry is GC'd automatically when the
//   row array is replaced by a new upsertDataSource call, requiring no manual
//   invalidation).
//
// Inner check: dataSource.fields ref — determines which fields are treated as
//   dates and which get distinct-values indexing. Stable in normal usage; if
//   the schema changes the fields ref changes and the cache is bypassed.
//
// Result: the normalized StudioDataSource (with canonical date strings and
//   pre-built fieldDistinctValues).

interface NormCacheEntry {
  fields: StudioDataField[];
  result: StudioDataSource;
}

const cache = new WeakMap<Row[], NormCacheEntry>();

/**
 * Returns a normalized version of `dataSource`, using a cached result when the
 * same `rows` and `fields` references are passed again.
 *
 * Cache misses delegate to `normalizeDataSourceRows` and store the result.
 * The cache entry is automatically GC'd when `rows` is replaced.
 */
export function getCachedNormalizedDataSource(dataSource: StudioDataSource): StudioDataSource {
  const { rows } = dataSource;

  // No rows — nothing to normalize; fall straight through.
  if (!rows || rows.length === 0) {
    return dataSource;
  }

  const entry = cache.get(rows);

  if (entry && entry.fields === dataSource.fields) {
    return entry.result;
  }

  const result = normalizeDataSourceRows(dataSource);
  cache.set(rows, { fields: dataSource.fields, result });
  return result;
}
