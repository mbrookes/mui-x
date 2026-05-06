import { enrichRowsWithExpressions } from '../utils/expressionEvaluator';
import type { StudioDataSource, StudioExpressionField, StudioRelationship } from '../models';

type Row = Record<string, unknown>;

// ─── Module-level cache ───────────────────────────────────────────────────────
//
// The enrichment result depends only on dataSources, expressionFields, and
// relationships — NOT on filters.  This means we can cache enriched rows
// independently of filter state, so a filter change (which clears resolvedRowsCache)
// no longer forces a full L2 re-run on every widget.
//
// Sentinel invalidation: when ANY of the three refs change, the cache is cleared.
// Filter changes do NOT change these refs, so the enrich cache stays warm across
// filter changes.  Only actual data/schema changes cause re-enrichment.
//
// Cache key: sourceId (safe because dataSources[sourceId].rows is covered by the
// dataSources sentinel — if the rows change, dataSources gets a new ref, clearing
// the cache before we reach the key lookup).

let cacheDataSources: Record<string, StudioDataSource> | undefined;
let cacheRelationships: StudioRelationship[] | undefined;
let cacheExpressionFields: StudioExpressionField[] | undefined;

const enrichCache = new Map<string, Row[]>();

function validateCache(
  dataSources: Record<string, StudioDataSource>,
  relationships: StudioRelationship[],
  expressionFields: StudioExpressionField[],
): void {
  if (
    dataSources !== cacheDataSources ||
    relationships !== cacheRelationships ||
    expressionFields !== cacheExpressionFields
  ) {
    enrichCache.clear();
    cacheDataSources = dataSources;
    cacheRelationships = relationships;
    cacheExpressionFields = expressionFields;
  }
}

/**
 * Returns enriched rows for the given source, using a module-level cache.
 *
 * Unlike `resolvedRowsCache`, this cache is NOT invalidated on filter changes —
 * only on `dataSources`, `expressionFields`, or `relationships` ref changes.
 * This means a filter change no longer forces re-enrichment (the expensive L2
 * step, ~242ms at 100k rows), cutting the L3 cold cost from ~316ms to ~74ms.
 *
 * If there are no expression fields for this source, returns `rows` unchanged
 * (same reference — no copy, no cache entry).
 */
export function getCachedEnrichedRows(
  rows: Row[],
  sourceId: string | undefined,
  expressionFields: StudioExpressionField[],
  dataSources: Record<string, StudioDataSource>,
  relationships: StudioRelationship[],
): Row[] {
  if (!sourceId || expressionFields.length === 0) {
    return rows;
  }

  // Check whether any expression fields target this source before touching the cache.
  const hasFieldsForSource = expressionFields.some(
    (ef) => ef.sourceId === sourceId && !ef.isMeasure,
  );
  if (!hasFieldsForSource) {
    return rows;
  }

  validateCache(dataSources, relationships, expressionFields);

  if (enrichCache.has(sourceId)) {
    return enrichCache.get(sourceId)!;
  }

  const result = enrichRowsWithExpressions(rows, expressionFields, sourceId, dataSources, relationships);
  enrichCache.set(sourceId, result);
  return result;
}
