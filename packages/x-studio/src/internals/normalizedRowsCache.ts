import { normalizeDataSourceRows } from './temporalUtils';
import { getLruEntry, getOrCreateBucket, setLruEntry } from './rowCacheLru';
import type { StudioDataField, StudioDataSource } from '../models';

type Row = Record<string, unknown>;

// ─── Per-rows, per-field-set cache ────────────────────────────────────────────
//
// Outer key: dataSource.rows (WeakMap — entry is GC'd automatically when the
//   row array is replaced by a new upsertDataSource call, requiring no manual
//   invalidation).
//
// Inner key: fieldSetKey — a sorted, comma-joined string of the field IDs being
//   normalized.  Callers that pass `usedFieldIds` get a widget-scoped cache slot;
//   callers that pass nothing (or undefined) get the '*' (all fields) slot.
//
// Inner check: dataSource.fields ref — determines which fields are treated as
//   dates and which get distinct-values indexing. Stable in normal usage; if
//   the schema changes the fields ref changes and the cache is bypassed.
//
// Result: the normalized StudioDataSource (with canonical date strings and
//   pre-built fieldDistinctValues for the requested field subset).
//
// The inner map is capped by the shared insertion-order LRU (`rowCacheLru.ts`). Each
// entry retains a FULL clone of the row array plus per-field distinct-value maps, and
// `usedFieldIds` churns with widget config (adding grid columns one at a time mints one
// key per column), so an uncapped map pinned one 200k-row clone per historical field set
// for as long as `dataSource.rows` stayed alive — the outer WeakMap key is exactly what
// keeps it alive, so it cannot help here.

interface NormCacheEntry {
  fields: StudioDataField[];
  result: StudioDataSource;
}

const cache = new WeakMap<Row[], Map<string, NormCacheEntry>>();

/**
 * Returns a normalized version of `dataSource`, using a cached result when the
 * same `rows`, `fields`, and `usedFieldIds` are seen again.
 *
 * When `usedFieldIds` is provided, only those fields are normalized (date
 * conversion and `fieldDistinctValues` building) — lazy-by-widget mode.
 * Each unique field set gets its own cache slot so adding an unused field
 * to a different widget does not evict this widget's cached entry.
 *
 * When `usedFieldIds` is omitted, all fields are normalized (backward-compatible
 * source-scoped mode — the '*' cache slot).
 *
 * Cache entries are automatically GC'd when `rows` is replaced.
 */
export function getCachedNormalizedDataSource(
  dataSource: StudioDataSource,
  usedFieldIds?: ReadonlySet<string>,
): StudioDataSource {
  const { rows } = dataSource;

  // No rows — nothing to normalize; fall straight through.
  if (!rows || rows.length === 0) {
    return dataSource;
  }

  const fieldSetKey = usedFieldIds ? [...usedFieldIds].toSorted().join(',') : '*';

  const byFieldSet = getOrCreateBucket(cache, rows);

  // `getLruEntry` refreshes recency on read so a field set a widget keeps asking for is
  // never the eviction candidate.
  const entry = getLruEntry(byFieldSet, fieldSetKey);
  if (entry && entry.fields === dataSource.fields) {
    return entry.result;
  }

  const result = normalizeDataSourceRows(dataSource, usedFieldIds);
  setLruEntry(byFieldSet, fieldSetKey, { fields: dataSource.fields, result });
  return result;
}
