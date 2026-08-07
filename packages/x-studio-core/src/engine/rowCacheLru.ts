import type { StudioDataField, StudioDataSource } from '../models';

type Row = Record<string, unknown>;

// ─── Shared insertion-order LRU for the per-rows row caches ───────────────────
//
// The three sibling row caches (`normalizedRowsCache`, `enrichedRowsCache`,
// `resolvedRowsCache`) all use the same 2-level shape:
//
//   WeakMap<Row[], Map<innerKey, entry>>
//
// The outer WeakMap key is a rows array, so an entry is GC'd when the source's rows
// are replaced. That does NOT bound the INNER map: its key is derived from widget
// config (field sets, filter fingerprints), which churns freely while the rows array
// stays alive. Adding grid columns one at a time mints a new `fieldSetKey` per column;
// interactive/cross-filter churn mints a new fingerprint per click. Each retained entry
// pins a full result array (plus, for the normalized cache, per-field distinct-value
// maps), so an unbounded inner map retains one full clone of a 200k-row source per
// HISTORICAL key until the rows array itself is replaced.
//
// A `Map` iterates in insertion order, so `keys().next().value` is the oldest key —
// a free LRU as long as every read re-inserts (`getLruEntry`) and every write deletes
// before inserting (`setLruEntry`).

/**
 * Upper bound on distinct inner-cache entries kept per rows array. Shared by all three
 * row caches so they age out at the same rate.
 */
export const MAX_ENTRIES_PER_ROWS = 20;

/** Returns the inner map for `rows`, creating (and registering) it on first use. */
export function getOrCreateBucket<V>(
  cache: WeakMap<Row[], Map<string, V>>,
  rows: Row[],
): Map<string, V> {
  let bucket = cache.get(rows);
  if (!bucket) {
    bucket = new Map<string, V>();
    cache.set(rows, bucket);
  }
  return bucket;
}

/**
 * Reads `key` and refreshes its LRU recency (delete + re-insert moves it to the newest
 * position). Returns `undefined` on a miss, leaving the map untouched.
 */
export function getLruEntry<V>(entries: Map<string, V>, key: string): V | undefined {
  const entry = entries.get(key);
  if (entry === undefined) {
    return undefined;
  }
  entries.delete(key);
  entries.set(key, entry);
  return entry;
}

/**
 * Inserts `value` at `key`, evicting the least-recently-used entries first so the map
 * never exceeds `maxEntries`. Deleting `key` up front means an overwrite refreshes
 * recency and never counts toward the cap.
 */
export function setLruEntry<V>(
  entries: Map<string, V>,
  key: string,
  value: V,
  maxEntries: number = MAX_ENTRIES_PER_ROWS,
): void {
  entries.delete(key);
  while (entries.size >= maxEntries) {
    const oldest = entries.keys().next();
    if (oldest.done) {
      break;
    }
    entries.delete(oldest.value);
  }
  entries.set(key, value);
}

// ─── Foreign-source dependency tracking ──────────────────────────────────────
//
// A cached result that reads a FOREIGN data source (a cross-filter semi-join, an
// L4 re-anchoring join, a join-field expression) depends on everything that source
// contributes to the joined values. Every such read goes through
// `getCachedNormalizedDataSource`, which is keyed on the source's `rows` AND its
// `fields` — normalization applies the field's declared type, so retyping a field
// (`updateDataSourceField`) changes the normalized values while leaving `rows`
// reference-identical.
//
// Tracking `rows` alone therefore reports "valid" after a retype and serves rows
// computed against the pre-retype values, with no way for the user to recover short
// of replacing the source's rows. `SourceDep` is the shape that tracks both; every
// cache that depends on a foreign source records one per tracked source so a future
// dependency is added here once rather than at each call site.

/** The dependency footprint of one foreign data source at cache time. `null` = absent. */
export interface SourceDep {
  rows: Row[] | null;
  fields: StudioDataField[] | null;
}

/**
 * Snapshots `source`'s dependency footprint. An absent source is recorded as
 * `{ rows: null, fields: null }` rather than skipped, so the entry is invalidated the
 * moment that source loads — a cross-filter whose foreign source loaded late otherwise
 * kept serving unfiltered rows forever.
 */
export function captureSourceDep(source: StudioDataSource | undefined): SourceDep {
  return { rows: source?.rows ?? null, fields: source?.fields ?? null };
}

/** Snapshots one `SourceDep` per id in `sourceIds`. */
export function captureSourceDeps(
  sourceIds: Iterable<string>,
  dataSources: Record<string, StudioDataSource>,
): Map<string, SourceDep> {
  const deps = new Map<string, SourceDep>();
  for (const sourceId of sourceIds) {
    deps.set(sourceId, captureSourceDep(dataSources[sourceId]));
  }
  return deps;
}

/** True when every tracked source still has BOTH the same rows ref and the same fields ref. */
export function sourceDepsUnchanged(
  deps: ReadonlyMap<string, SourceDep>,
  dataSources: Record<string, StudioDataSource>,
): boolean {
  for (const [sourceId, dep] of deps) {
    const source = dataSources[sourceId];
    if ((source?.rows ?? null) !== dep.rows || (source?.fields ?? null) !== dep.fields) {
      return false;
    }
  }
  return true;
}
