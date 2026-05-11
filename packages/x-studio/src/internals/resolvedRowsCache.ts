import { resolveRows } from './chartUtils';
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
// Inner key: content-based fingerprint of the effective filter set
//   (sourceId + sorted "filterId:value" pairs). Changing a filter value
//   produces a different key → cache miss. Changing an unrelated widget's
//   filter while this widget's effective filters stay the same → same key
//   → cache hit (previously the globalFilters sentinel caused a full clear).
//
// Per-entry deps:
//   crossFilterSourceRows  rows refs of cross-filter foreign sources
//   relationships          full array ref (rarely changes; OK to be broad here)
//
// Expression fields are intentionally NOT tracked here — enrichedRowsCache
// handles per-source enrichment invalidation with fine-grained dep tracking.

interface ResolvedCacheEntry {
  crossFilterSourceRows: Map<string, Row[]>;
  relationships: StudioRelationship[];
  result: Row[];
}

const rowCache = new WeakMap<Row[], Map<string, ResolvedCacheEntry>>();

function isEntryValid(
  entry: ResolvedCacheEntry,
  resolvedFilters: StudioFilterState[],
  dataSources: Record<string, StudioDataSource>,
  relationships: StudioRelationship[],
): boolean {
  if (entry.relationships !== relationships) {
    return false;
  }
  for (const f of resolvedFilters) {
    if (f.filterSourceId) {
      if (
        entry.crossFilterSourceRows.get(f.filterSourceId) !== dataSources[f.filterSourceId]?.rows
      ) {
        return false;
      }
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
 * Unlike the old sentinel-based approach:
 * - An unrelated source's data changing does NOT invalidate this widget's entry.
 * - Changing another widget's filter (that doesn't affect this widget's effective
 *   filters) does NOT invalidate this entry.
 * - Only own-rows changes (outer WeakMap key), cross-filter foreign source changes,
 *   filter value changes (inner key), or relationships changes trigger re-computation.
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
    resolvedFilters.length === 0
      ? ''
      : resolvedFilters
          .map((f) => `${f.id}:${JSON.stringify(f.value ?? '')}`)
          .sort()
          .join('|');
  const fieldSetSegment = usedFieldIds ? [...usedFieldIds].sort().join(',') : '';
  const cacheKey = `${widgetSourceId}::${filterKey}::${fieldSetSegment}`;

  let byKey = rowCache.get(widgetRows);
  if (!byKey) {
    byKey = new Map();
    rowCache.set(widgetRows, byKey);
  }

  const existing = byKey.get(cacheKey);
  if (existing && isEntryValid(existing, resolvedFilters, dataSources, relationships)) {
    return existing.result;
  }

  const result = resolveRows(
    widgetRows,
    widgetSourceId,
    resolvedFilters,
    dataSources,
    relationships,
    expressionFields,
    { usedFieldIds },
  );

  const crossFilterSourceRows = new Map<string, Row[]>();
  for (const f of resolvedFilters) {
    if (f.filterSourceId) {
      const foreignRows = dataSources[f.filterSourceId]?.rows;
      if (foreignRows) {
        crossFilterSourceRows.set(f.filterSourceId, foreignRows);
      }
    }
  }

  byKey.set(cacheKey, { crossFilterSourceRows, relationships, result });
  return result;
}
