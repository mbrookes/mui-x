import { resolveRows } from './chartUtils';
import type {
  StudioDataSource,
  StudioFilterState,
  StudioRelationship,
  StudioExpressionField,
} from '../models';

type Row = Record<string, unknown>;

// ─── Module-level cache ───────────────────────────────────────────────────────

// The cache maps a filter fingerprint → resolved rows, and is valid only for
// the current combination of store-level inputs.  When ANY of these four refs
// change (on every store dispatch that modifies filters/data) the cache is
// cleared so stale entries can never be observed.
//
// This makes resolveRows effectively O(1) for the N-1 widgets that share a
// source and the same effective filter set after the first widget computes.

let cacheFilters: StudioFilterState[] | undefined;
let cacheDataSources: Record<string, StudioDataSource> | undefined;
let cacheRelationships: StudioRelationship[] | undefined;
let cacheExpressionFields: StudioExpressionField[] | undefined;

const rowCache = new Map<string, Row[]>();

function validateCache(
  filters: StudioFilterState[],
  dataSources: Record<string, StudioDataSource>,
  relationships: StudioRelationship[],
  expressionFields: StudioExpressionField[],
): void {
  if (
    filters !== cacheFilters ||
    dataSources !== cacheDataSources ||
    relationships !== cacheRelationships ||
    expressionFields !== cacheExpressionFields
  ) {
    rowCache.clear();
    cacheFilters = filters;
    cacheDataSources = dataSources;
    cacheRelationships = relationships;
    cacheExpressionFields = expressionFields;
  }
}

/**
 * Wraps `resolveRows` with a module-level cache keyed on
 * `(sourceId, resolvedFiltersFingerprint)`.
 *
 * Widgets sharing the same data source **and** the same effective filter set
 * (page filters + cross-filters + interactive filters, identical across peers
 * that have no widget-specific filters) receive the **same Row[] reference**
 * after the first widget computes it — saving N-1 full pipeline passes per
 * shared source per render cycle.
 *
 * The cache is automatically invalidated whenever any of the four store-level
 * inputs change reference (`filters`, `dataSources`, `relationships`,
 * `expressionFields`).  Pass the raw store arrays as `globalFilters` etc., not
 * the filtered/sliced subsets.
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
  globalFilters: StudioFilterState[],
): Row[] {
  validateCache(globalFilters, dataSources, relationships, expressionFields);

  if (!widgetSourceId) {
    return resolveRows(
      widgetRows,
      widgetSourceId,
      resolvedFilters,
      dataSources,
      relationships,
      expressionFields,
    );
  }

  // Cache key: sourceId + fingerprint of the effective filter set.
  // Filter IDs are stable UUIDs; values change only when the store dispatches
  // a filter change, at which point globalFilters gets a new reference and the
  // cache is cleared before we reach this point.
  const filterKey =
    resolvedFilters.length === 0
      ? ''
      : resolvedFilters
          .map((f) => `${f.id}:${JSON.stringify(f.value ?? '')}`)
          .sort()
          .join('|');
  const cacheKey = `${widgetSourceId}::${filterKey}`;

  if (rowCache.has(cacheKey)) {
    return rowCache.get(cacheKey)!;
  }

  const result = resolveRows(
    widgetRows,
    widgetSourceId,
    resolvedFilters,
    dataSources,
    relationships,
    expressionFields,
  );
  rowCache.set(cacheKey, result);
  return result;
}
