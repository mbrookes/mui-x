import { resolveRows } from './dataSourceGraph';
import { isRelativeDateValue, resolveRelativeDate } from './filterUtils';
import { stableStringify } from './stableStringify';
import type {
  StudioDataSource,
  StudioFilterState,
  StudioRelationship,
  StudioExpressionField,
} from '../models';

type Row = Record<string, unknown>;

// ─── Per-widgetRows cache ─────────────────────────────────────────────────────
//
// Outer key: widgetRows (= dataSources[widgetSourceId].rows)
//   WeakMap — entries are GC'd automatically when widgetRows is no longer
//   referenced (i.e., after dataSources[widgetSourceId].rows changes).
//   An unrelated source's rows changing does NOT affect this entry.
//
// Inner key: content-based fingerprint of the effective filter set.
//   The fingerprint encodes the FULL behavioral content of each filter — not just
//   its id/value — so changing a filter's operator, second condition, mode, rank
//   direction, field type, or target source produces a different key → cache miss.
//   Two widgets sharing the same effective filters get the same key → cache hit.
//
// Per-entry deps (checked on every hit):
//   crossFilterSourceRows  rows refs of EVERY foreign source this entry joined
//                          against — declared cross-filter sources, derived
//                          cross-filter sources (a page filter on an expression
//                          field owned by another source), and many-to-many
//                          junction sources. `resolveRows` reports these via the
//                          `collectJoinedSourceIds` out-param; if any of their
//                          rows refs change the entry is invalidated.
//   relationships          full array ref (rarely changes; OK to be broad here)
//   relevantExprFields     object refs of the non-measure expression fields owned
//                          by any source this result depends on (the widget source
//                          plus every joined source). Editing a formula produces a
//                          new object ref → invalidation. Without this, a HIT here
//                          returns rows baked with the OLD formula even though
//                          enrichedRowsCache would have recomputed on a MISS.

interface ResolvedCacheEntry {
  /**
   * Rows ref of every foreign source this entry depends on. A `null` value records a
   * source that had NO rows at compute time (absent / not yet loaded) — so when it
   * later gains rows, `(rows ?? null) !== null` fails the equality check and the entry
   * is invalidated. Recording absence explicitly is what fixes the stale-result bug
   * where a cross-filter whose foreign source loaded late kept serving unfiltered rows.
   */
  crossFilterSourceRows: Map<string, Row[] | null>;
  relationships: StudioRelationship[];
  /** Source IDs whose non-measure expression fields this result depends on. */
  relevantExprSourceIds: Set<string>;
  /** The relevant expression-field objects at cache time (reference identity). */
  relevantExprFields: StudioExpressionField[];
  result: Row[];
}

const rowCache = new WeakMap<Row[], Map<string, ResolvedCacheEntry>>();

/**
 * Upper bound on distinct filter fingerprints kept per widgetRows array. Interactive /
 * cross-filter churn produces a stream of value-distinct fingerprints; without a cap the
 * inner Map would grow unbounded for the lifetime of that rows array. Map insertion order
 * gives a free LRU — the oldest key is `keys().next().value`.
 */
const MAX_ENTRIES_PER_ROWS = 20;

/**
 * Fingerprints every field that affects how a filter selects rows. `compileRowTest`
 * (filterUtils) reads operator/field/fieldType/conjunction/operator2/value2/
 * filterMode/rank*, so all of them must be part of the cache key — omitting them
 * lets an operator edit (same id, same value) silently serve stale rows.
 *
 * `f.id` is deliberately NOT included: it does not affect which rows a filter selects,
 * so two filters identical in every behavioral field should share one cache entry.
 * Including it would guarantee a miss every time an interactive/cross-filter is
 * re-applied, since those ids carry a `Date.now()` suffix.
 */
function filterFingerprint(f: StudioFilterState): string {
  return stableStringify([
    f.field,
    f.fieldType ?? null,
    f.filterMode ?? null,
    f.operator,
    f.value ?? null,
    // A relative-date value (e.g. "7 days ago") is a stable object, so `f.value` alone never
    // changes across a midnight crossing — the entry would serve a stale window forever while
    // preset filters self-heal (their resolved `{from,to}` changes daily). Fold the resolved
    // day into the fingerprint so a relative-valued filter re-computes when the day rolls over
    // (finding 2.21). Preset (`dateRangePreset`) filters are already resolved to concrete bounds
    // in `f.value` before reaching here, so they need no equivalent treatment.
    isRelativeDateValue(f.value) ? resolveRelativeDate(f.value) : null,
    f.conjunction ?? null,
    f.operator2 ?? null,
    f.value2 ?? null,
    isRelativeDateValue(f.value2) ? resolveRelativeDate(f.value2) : null,
    f.rankDirection ?? null,
    f.rankByField ?? null,
    f.rankMultiSeriesBy ?? null,
    f.filterSourceId ?? null,
    f.disabled ?? null,
  ]);
}

/** Non-measure expression fields owned by any of `sourceIds`, in declaration order. */
function collectRelevantExprFields(
  expressionFields: StudioExpressionField[],
  sourceIds: ReadonlySet<string>,
): StudioExpressionField[] {
  return expressionFields.filter((ef) => !ef.isMeasure && sourceIds.has(ef.sourceId));
}

function isEntryValid(
  entry: ResolvedCacheEntry,
  dataSources: Record<string, StudioDataSource>,
  relationships: StudioRelationship[],
  expressionFields: StudioExpressionField[],
): boolean {
  if (entry.relationships !== relationships) {
    return false;
  }
  // Every foreign source this result depends on must still have the same rows ref.
  // `?? null` so a source that was ABSENT at compute time (recorded as null) triggers
  // invalidation the moment it gains rows.
  for (const [sourceId, rowsRef] of entry.crossFilterSourceRows) {
    if ((dataSources[sourceId]?.rows ?? null) !== rowsRef) {
      return false;
    }
  }
  // Expression fields relevant to this result must be the same objects (formula edits
  // replace the object). Recompute the relevant set from the stored source IDs so an
  // added/removed field on a relevant source is caught too.
  const currentExprFields = collectRelevantExprFields(
    expressionFields,
    entry.relevantExprSourceIds,
  );
  if (currentExprFields.length !== entry.relevantExprFields.length) {
    return false;
  }
  for (let i = 0; i < currentExprFields.length; i += 1) {
    if (currentExprFields[i] !== entry.relevantExprFields[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Wraps `resolveRows` with a per-widgetRows WeakMap cache keyed on
 * `(sourceId, resolvedFiltersFingerprint)`.
 *
 * Widgets sharing the same data source **and** the same effective filter set
 * receive the **same Row[] reference** after the first widget computes it —
 * saving N-1 full pipeline passes per shared source per render cycle.
 *
 * Invalidation triggers:
 * - own-rows changes (outer WeakMap key),
 * - any joined foreign source's rows changing (declared/derived cross-filter or
 *   many-to-many junction — tracked via resolveRows' collectJoinedSourceIds),
 * - any behavioral filter-field change (inner key fingerprint),
 * - relationships changes (array ref),
 * - a relevant expression-field formula change (object ref).
 *
 * Unrelated sources, unrelated filters, and unrelated expression fields do NOT
 * invalidate this entry.
 *
 * KPI widgets that use `skipEnrichment: true` should continue to call
 * `resolveRows` directly — they pre-enrich once and call twice with different
 * period filters, which are rarely shared across widgets.
 */
export function resolveRowsCached(
  widgetRows: Row[],
  widgetSourceId: string | undefined,
  resolvedFilters: StudioFilterState[],
  dataSources: Record<string, StudioDataSource>,
  relationships: StudioRelationship[],
  expressionFields: StudioExpressionField[],
  usedFieldIds?: ReadonlySet<string>,
): Row[] {
  if (!widgetSourceId) {
    return resolveRows(
      widgetRows,
      widgetSourceId,
      resolvedFilters,
      dataSources,
      relationships,
      expressionFields,
      { usedFieldIds },
    );
  }

  const filterKey =
    resolvedFilters.length === 0 ? '' : resolvedFilters.map(filterFingerprint).sort().join('|');
  const fieldSetSegment = usedFieldIds ? [...usedFieldIds].toSorted().join(',') : '';
  const cacheKey = `${widgetSourceId}::${filterKey}::${fieldSetSegment}`;

  let byKey = rowCache.get(widgetRows);
  if (!byKey) {
    byKey = new Map();
    rowCache.set(widgetRows, byKey);
  }

  const existing = byKey.get(cacheKey);
  if (existing && isEntryValid(existing, dataSources, relationships, expressionFields)) {
    // Refresh LRU recency: delete + re-insert moves this key to the newest position.
    byKey.delete(cacheKey);
    byKey.set(cacheKey, existing);
    return existing.result;
  }

  // Capture the full set of foreign sources actually joined against (declared +
  // derived cross-filter sources + M:N junction sources).
  const joinedSourceIds = new Set<string>();
  const result = resolveRows(
    widgetRows,
    widgetSourceId,
    resolvedFilters,
    dataSources,
    relationships,
    expressionFields,
    { usedFieldIds, collectJoinedSourceIds: joinedSourceIds },
  );

  const crossFilterSourceRows = new Map<string, Row[] | null>();
  for (const sourceId of joinedSourceIds) {
    // Record absence as null (not skip) so a later data load invalidates the entry.
    crossFilterSourceRows.set(sourceId, dataSources[sourceId]?.rows ?? null);
  }
  // Also record any declared filterSourceId even if the join was skipped (e.g. the
  // foreign source had no rows yet) so a later data load invalidates the entry.
  for (const f of resolvedFilters) {
    if (f.filterSourceId && !crossFilterSourceRows.has(f.filterSourceId)) {
      crossFilterSourceRows.set(f.filterSourceId, dataSources[f.filterSourceId]?.rows ?? null);
    }
  }

  // Expression fields whose formulas this result depends on: the widget source's
  // own, plus every joined source (foreign enrichment is baked into the semi-join).
  const relevantExprSourceIds = new Set<string>([widgetSourceId]);
  for (const sourceId of joinedSourceIds) {
    relevantExprSourceIds.add(sourceId);
  }
  for (const f of resolvedFilters) {
    if (f.filterSourceId) {
      relevantExprSourceIds.add(f.filterSourceId);
    }
  }
  const relevantExprFields = collectRelevantExprFields(expressionFields, relevantExprSourceIds);

  // Evict the least-recently-used entry before inserting when at capacity. A stale key
  // (already re-mapped above, so absent) won't count toward the cap.
  if (!byKey.has(cacheKey) && byKey.size >= MAX_ENTRIES_PER_ROWS) {
    const oldest = byKey.keys().next().value;
    if (oldest !== undefined) {
      byKey.delete(oldest);
    }
  }

  byKey.set(cacheKey, {
    crossFilterSourceRows,
    relationships,
    relevantExprSourceIds,
    relevantExprFields,
    result,
  });
  return result;
}
