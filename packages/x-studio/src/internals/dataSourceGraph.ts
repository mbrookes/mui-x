import type {
  StudioDataSource,
  StudioExpressionField,
  StudioFilterState,
  StudioRelationship,
} from '../models';
import { getCachedEnrichedRows } from './enrichedRowsCache';
import { applyFilters } from './filterUtils';
import { collectKeySet, normalizeJoinKey } from './joinKeys';

type Row = Record<string, unknown>;

/**
 * Finds the relationship that directly connects `sourceA` and `sourceB` as its two
 * endpoints (in either direction), or `null` if none is declared. Note this also
 * matches a `many-to-many` relationship whose two endpoints are `sourceA`/`sourceB`
 * (callers branch on `relationship.type`); it does NOT match on a junction source.
 */
export function findDirectRelationship(
  sourceA: string,
  sourceB: string,
  relationships: StudioRelationship[],
): StudioRelationship | null {
  return (
    relationships.find(
      (relationship) =>
        (relationship.sourceId === sourceA && relationship.targetId === sourceB) ||
        (relationship.sourceId === sourceB && relationship.targetId === sourceA),
    ) ?? null
  );
}

/**
 * Builds a `targetId → relationship` index of the direct many-to-one relationships
 * FROM `widgetSourceId`, i.e. `{ targetId, sourceField (FK on widget rows), targetField (PK
 * on the related source) }`. This is the single traversal step every "cross-source
 * display column" enrichment needs (grid columns, cross-source aggregation) and was
 * previously re-derived identically in `gridGrouping.ts` and `crossSourceEnrichment.ts`.
 *
 * Scope is intentionally narrow (many-to-one, one hop, from widgetSourceId only) to match
 * the exact behavior those two call sites already had — this does not add many-to-many or
 * two-hop support to grid/cross-source-column enrichment (see `findJoinPath` and
 * `enrichRowsWithRelatedFields` for the broader multi-hop traversal used by filters and charts).
 */
export function buildManyToOneRelationshipIndex(
  widgetSourceId: string,
  relationships: StudioRelationship[],
): Map<string, StudioRelationship> {
  const relIndex = new Map<string, StudioRelationship>();
  for (const r of relationships) {
    if (r.type === 'many-to-one' && r.sourceId === widgetSourceId) {
      relIndex.set(r.targetId, r);
    }
  }
  return relIndex;
}

/**
 * Returns the set of source IDs reachable from `sourceId` in one hop via declared relationships.
 * For many-to-many relationships, also includes the junction source and the remote endpoint.
 * Always includes `sourceId` itself.
 */
export function getReachableSourceIds(
  sourceId: string,
  relationships: StudioRelationship[],
): Set<string> {
  const reachable = new Set<string>([sourceId]);
  for (const rel of relationships) {
    if (rel.sourceId === sourceId) {
      reachable.add(rel.targetId);
      if (rel.type === 'many-to-many' && rel.junctionSourceId) {
        reachable.add(rel.junctionSourceId);
      }
    }
    if (rel.targetId === sourceId) {
      reachable.add(rel.sourceId);
      if (rel.type === 'many-to-many' && rel.junctionSourceId) {
        reachable.add(rel.junctionSourceId);
      }
    }
  }
  return reachable;
}

/**
 * Describes how to join widgetSource to filterSource:
 * - hops:1 — direct relationship (many-to-one or one-to-one)
 * - hops:2 — many-to-many via a junction source
 */
type JoinPath =
  | { hops: 1; widgetJoinField: string; filterJoinField: string }
  | {
      hops: 2;
      /** Field on widget rows to match into the junction. */
      widgetJoinField: string;
      junctionSourceId: string;
      /** Field in the junction source that references widgetSource. */
      junctionWidgetField: string;
      /** Field in the junction source that references filterSource. */
      junctionFilterField: string;
      /** Field on filter source rows that the junction references. */
      filterJoinField: string;
    };

/**
 * Returns a JoinPath describing how to link widgetSource to filterSource,
 * or null if no relationship path exists.
 * Checks direct relationships first, then many-to-many two-hop paths.
 */
function findJoinPath(
  widgetSourceId: string,
  filterSourceId: string,
  relationships: StudioRelationship[],
): JoinPath | null {
  // Direct (one-hop) relationship
  for (const rel of relationships) {
    if (rel.type === 'many-to-many') {
      continue; // handled below
    }
    if (rel.sourceId === widgetSourceId && rel.targetId === filterSourceId) {
      return { hops: 1, widgetJoinField: rel.sourceField, filterJoinField: rel.targetField };
    }
    if (rel.targetId === widgetSourceId && rel.sourceId === filterSourceId) {
      return { hops: 1, widgetJoinField: rel.targetField, filterJoinField: rel.sourceField };
    }
  }

  // Two-hop (many-to-many) relationship
  for (const rel of relationships) {
    if (rel.type !== 'many-to-many') {
      continue;
    }
    if (!rel.junctionSourceId || !rel.junctionSourceField || !rel.junctionTargetField) {
      continue; // incomplete M:N config — skip
    }

    if (rel.sourceId === widgetSourceId && rel.targetId === filterSourceId) {
      return {
        hops: 2,
        widgetJoinField: rel.sourceField,
        junctionSourceId: rel.junctionSourceId,
        junctionWidgetField: rel.junctionSourceField,
        junctionFilterField: rel.junctionTargetField,
        filterJoinField: rel.targetField,
      };
    }
    if (rel.targetId === widgetSourceId && rel.sourceId === filterSourceId) {
      return {
        hops: 2,
        widgetJoinField: rel.targetField,
        junctionSourceId: rel.junctionSourceId,
        junctionWidgetField: rel.junctionTargetField,
        junctionFilterField: rel.junctionSourceField,
        filterJoinField: rel.sourceField,
      };
    }
  }

  return null;
}

/**
 * Apply filters to widget rows, resolving cross-source filters via the declared
 * relationships. Cross-source filters (filterSourceId != widgetSourceId) are
 * applied to the foreign source first; the result semi-joins back to the widget's
 * rows using the join fields discovered from the relationship graph.
 *
 * Expression fields are evaluated and merged into rows before filtering, so that
 * filters can target computed columns.
 */
export function resolveRows(
  widgetRows: Row[],
  widgetSourceId: string | undefined,
  filters: StudioFilterState[],
  dataSources: Record<string, StudioDataSource>,
  relationships: StudioRelationship[] = [],
  expressionFields: StudioExpressionField[] = [],
  options?: {
    skipEnrichment?: boolean;
    usedFieldIds?: ReadonlySet<string>;
    /**
     * Out-param: when provided, every foreign source ID whose `rows` this call
     * actually read for a semi-join is added to this set. Callers (e.g.
     * `resolvedRowsCache`) use it to record the full set of foreign-row
     * dependencies — including derived cross-filter sources (a page filter on an
     * expression field owned by another source) and many-to-many junction
     * sources — which the incoming filter objects do not themselves declare.
     */
    collectJoinedSourceIds?: Set<string>;
  },
): Row[] {
  // Enrich rows with computed (non-measure) expression field values first so they
  // can be referenced in filters and downstream aggregations.
  // Uses enrichedRowsCache so filter changes don't force re-enrichment (L2 is
  // independent of filters — only dataSources/expressionFields/relationships matter).
  // Pass skipEnrichment: true when the caller has already enriched the rows (e.g.
  // KPI widget pre-enriches once and calls resolveRows twice for current/prev period).
  // Pass usedFieldIds to restrict enrichment to only the fields this widget uses
  // (lazy-by-widget mode — avoids recomputing on unused-expression additions).
  const enrichedRows = options?.skipEnrichment
    ? widgetRows
    : getCachedEnrichedRows(
        widgetRows,
        widgetSourceId,
        expressionFields,
        dataSources,
        relationships,
        options?.usedFieldIds,
        // Thread L2's join-source dependencies into the L3 caller's tracking. A widget-source
        // expression column that JOINs a foreign source (e.g. `customer_name =
        // join(customers.name)`) makes that foreign source's rows a real dependency of this
        // resolved result even with NO cross-filter present. Without recording it,
        // `resolvedRowsCache` keeps serving stale joined values — and filters ON that expression
        // column keep matching stale values — after the foreign source's rows refresh (finding 1.2).
        options?.collectJoinedSourceIds,
      );

  const nativeFilters: StudioFilterState[] = [];
  const crossFilters: (StudioFilterState & { filterSourceId: string })[] = [];

  // Pre-build index for O(1) expression field lookups (avoid repeated .find() in loop)
  const exprFieldIndex = new Map<string, (typeof expressionFields)[number]>();
  for (const ef of expressionFields) {
    if (ef.sourceId !== widgetSourceId && !ef.isMeasure) {
      exprFieldIndex.set(ef.id, ef);
    }
  }

  for (const f of filters) {
    // Dashboard date-range filters are scoped to their own source. A filter created
    // for source A must not be treated as a cross-filter against source B — it would
    // trigger a semi-join that returns zero rows when no relationship is declared.
    // selectFiltersForWidget (filterScoping.ts) applies this guard before callers reach
    // here; this check is a defensive invariant that should never fire in practice.
    if (
      f.scope.kind === 'dashboard-date-range' &&
      f.filterSourceId &&
      f.filterSourceId !== widgetSourceId
    ) {
      continue;
    }
    if (f.filterSourceId && f.filterSourceId !== widgetSourceId) {
      crossFilters.push(f as StudioFilterState & { filterSourceId: string });
    } else if (!f.filterSourceId && f.field) {
      // No filterSourceId set (e.g. page filters added via the Filters Drawer).
      // If the field is an expression owned by a different source, route it as a
      // cross-filter so the semi-join path enriches the foreign source correctly.
      // Without this, the field is undefined on the widget's own rows and every
      // row is silently filtered out.
      const exprOwner = f.field ? exprFieldIndex.get(f.field) : undefined;
      if (exprOwner) {
        crossFilters.push({ ...f, filterSourceId: exprOwner.sourceId } as StudioFilterState & {
          filterSourceId: string;
        });
      } else {
        nativeFilters.push(f);
      }
    } else {
      nativeFilters.push(f);
    }
  }

  let rows = enrichedRows;

  // Pre-enrich each distinct foreign source once, regardless of how many cross-filters
  // target it. Without this cache, each cross-filter re-runs enrichRowsWithExpressions
  // over the same foreign rows — O(crossFilters × foreignRows) instead of O(foreignRows).
  const foreignEnrichedCache = new Map<string, Row[]>();

  for (const f of crossFilters) {
    const foreignSource = dataSources[f.filterSourceId];
    // Record the foreign source this cross-filter depends on BEFORE any early-out
    // (covers derived filterSourceId from expression-owned page filters — f may not
    // be the same object the caller passed in). Recording here — even when the source
    // has no rows yet or no join path exists — lets `resolvedRowsCache` invalidate its
    // entry once that source later gains rows, instead of serving a stale unfiltered
    // result forever.
    options?.collectJoinedSourceIds?.add(f.filterSourceId);
    if (!foreignSource?.rows) {
      continue;
    }

    const joinPath = findJoinPath(widgetSourceId ?? '', f.filterSourceId, relationships);
    if (!joinPath) {
      continue; // no declared relationship — skip rather than produce incorrect results
    }

    // Destructure filterSourceId out so baseFilter is a plain StudioFilterState for applyFilters
    const { filterSourceId: removedField, ...baseFilter } = f;
    void removedField;
    // Enrich the foreign source rows via enrichedRowsCache so filter changes don't
    // force re-enrichment of foreign sources (the enrich result is filter-independent).
    // The local foreignEnrichedCache is kept as a guard against duplicate lookups
    // within a single resolveRows call (multiple cross-filters on the same source).
    if (!foreignEnrichedCache.has(f.filterSourceId)) {
      foreignEnrichedCache.set(
        f.filterSourceId,
        getCachedEnrichedRows(
          foreignSource.rows,
          f.filterSourceId,
          expressionFields,
          dataSources,
          relationships,
          undefined,
          // The foreign source's own expression columns may JOIN yet another source; record
          // those targets so a later refresh of that transitive source also invalidates the L3
          // entry (finding 1.2).
          options?.collectJoinedSourceIds,
        ),
      );
    }

    const enrichedForeignRows = foreignEnrichedCache.get(f.filterSourceId)!;
    const matchingForeignRows = applyFilters(enrichedForeignRows, [baseFilter]);

    if (joinPath.hops === 1) {
      // One-hop (direct) semi-join: keep widget rows whose join field is in the allowed set.
      // Keys are normalized (normalizeJoinKey) so a numeric FK matches a string PK etc.
      const allowedValues = collectKeySet(matchingForeignRows, joinPath.filterJoinField);
      rows = rows.filter((r) => {
        const key = normalizeJoinKey(r[joinPath.widgetJoinField]);
        return key !== null && allowedValues.has(key);
      });
    } else {
      // Two-hop (M:N) semi-join via junction source:
      // 1. Collect the filter-side join values from matching foreign rows
      // 2. Walk the junction to find widget-side join values that link to those
      // 3. Keep widget rows in the resulting allowed set
      const matchingFilterValues = collectKeySet(matchingForeignRows, joinPath.filterJoinField);
      // Record the junction source whose rows we read for the two-hop semi-join.
      options?.collectJoinedSourceIds?.add(joinPath.junctionSourceId);
      const junctionRows = dataSources[joinPath.junctionSourceId]?.rows ?? [];
      const allowedWidgetValues = new Set<string>();
      for (const r of junctionRows) {
        const filterKey = normalizeJoinKey(r[joinPath.junctionFilterField]);
        if (filterKey !== null && matchingFilterValues.has(filterKey)) {
          const widgetKey = normalizeJoinKey(r[joinPath.junctionWidgetField]);
          if (widgetKey !== null) {
            allowedWidgetValues.add(widgetKey);
          }
        }
      }
      rows = rows.filter((r) => {
        const key = normalizeJoinKey(r[joinPath.widgetJoinField]);
        return key !== null && allowedWidgetValues.has(key);
      });
    }
  }

  return applyFilters(rows, nativeFilters);
}

/**
 * Enriches widget rows with fields from directly related sources (one-hop) or
 * many-to-many related sources (two-hop via junction).
 *
 * For one-hop joins: builds a lookup map (relatedJoinValue → fieldValue) and
 * copies the value onto each widget row.
 *
 * For many-to-many two-hop joins: builds a lookup
 * (widgetJoinValue → firstMatchingTargetFieldValue) via the junction table.
 * Uses the **first** matching junction row per widget row — suitable for display
 * columns; aggregate queries should use `resolveChartRowsForAggregation`.
 */
export function enrichRowsWithRelatedFields(
  rows: Row[],
  widgetSourceId: string | undefined,
  fieldIds: string[],
  dataSources: Record<string, StudioDataSource>,
  relationships: StudioRelationship[],
  /**
   * Out-param: every foreign source id whose rows this enrichment actually reads (a related
   * source for a one-hop display column, or the remote endpoint + junction source for a
   * two-hop many-to-many column) is added to it. Lets a caller building its own dependency
   * cache (the L4 `rcfaCache`) invalidate when those foreign rows change (finding 1.5).
   */
  collectReadSourceIds?: Set<string>,
): Row[] {
  if (!widgetSourceId || rows.length === 0 || fieldIds.length === 0) {
    return rows;
  }

  const widgetSource = dataSources[widgetSourceId];
  const nativeFieldIds = new Set(widgetSource?.fields.map((f) => f.id) ?? []);

  type DirectNeed = {
    kind: 'direct';
    fieldId: string;
    widgetJoinField: string;
    relatedJoinField: string;
    relatedRows: Row[];
  };
  type ManyToManyNeed = {
    kind: 'many-to-many';
    fieldId: string;
    widgetJoinField: string;
    junctionSourceId: string;
    junctionWidgetField: string;
    junctionTargetField: string;
    targetJoinField: string;
    targetRows: Row[];
  };

  const foreignFieldNeeds: Array<DirectNeed | ManyToManyNeed> = [];

  for (const fieldId of fieldIds) {
    if (nativeFieldIds.has(fieldId)) {
      continue;
    }

    let resolved = false;

    // Try direct (one-hop) relationships first
    for (const rel of relationships) {
      if (rel.type === 'many-to-many') {
        continue;
      }
      let relatedSourceId: string | null = null;
      let widgetJoinField: string | null = null;
      let relatedJoinField: string | null = null;

      if (rel.sourceId === widgetSourceId) {
        relatedSourceId = rel.targetId;
        widgetJoinField = rel.sourceField;
        relatedJoinField = rel.targetField;
      } else if (rel.targetId === widgetSourceId) {
        relatedSourceId = rel.sourceId;
        widgetJoinField = rel.targetField;
        relatedJoinField = rel.sourceField;
      } else {
        continue;
      }

      const relatedSource = dataSources[relatedSourceId];
      if (!relatedSource?.fields.some((f) => f.id === fieldId)) {
        continue;
      }

      collectReadSourceIds?.add(relatedSourceId);
      foreignFieldNeeds.push({
        kind: 'direct',
        fieldId,
        widgetJoinField,
        relatedJoinField,
        relatedRows: relatedSource.rows ?? [],
      });
      resolved = true;
      break;
    }

    if (resolved) {
      continue;
    }

    // Try many-to-many two-hop relationships
    for (const rel of relationships) {
      if (rel.type !== 'many-to-many') {
        continue;
      }
      if (!rel.junctionSourceId || !rel.junctionSourceField || !rel.junctionTargetField) {
        continue;
      }

      let targetSourceId: string | null = null;
      let widgetJoinField: string | null = null;
      let junctionWidgetField: string | null = null;
      let junctionTargetField: string | null = null;
      let targetJoinField: string | null = null;

      if (rel.sourceId === widgetSourceId) {
        targetSourceId = rel.targetId;
        widgetJoinField = rel.sourceField;
        junctionWidgetField = rel.junctionSourceField;
        junctionTargetField = rel.junctionTargetField;
        targetJoinField = rel.targetField;
      } else if (rel.targetId === widgetSourceId) {
        targetSourceId = rel.sourceId;
        widgetJoinField = rel.targetField;
        junctionWidgetField = rel.junctionTargetField;
        junctionTargetField = rel.junctionSourceField;
        targetJoinField = rel.sourceField;
      } else {
        continue;
      }

      const targetSource = dataSources[targetSourceId];
      if (!targetSource?.fields.some((f) => f.id === fieldId)) {
        continue;
      }

      collectReadSourceIds?.add(targetSourceId);
      collectReadSourceIds?.add(rel.junctionSourceId);
      foreignFieldNeeds.push({
        kind: 'many-to-many',
        fieldId,
        widgetJoinField,
        junctionSourceId: rel.junctionSourceId,
        junctionWidgetField,
        junctionTargetField,
        targetJoinField,
        targetRows: targetSource.rows ?? [],
      });
      break;
    }
  }

  if (foreignFieldNeeds.length === 0) {
    return rows;
  }

  // Build lookup maps. Keys are normalized (normalizeJoinKey) so a numeric FK
  // matches a string PK etc. — the single join-key policy shared with the chart,
  // filter and grid paths.
  const lookups: Array<{
    fieldId: string;
    widgetJoinField: string;
    map: Map<string, unknown>;
  }> = [];

  for (const need of foreignFieldNeeds) {
    if (need.kind === 'direct') {
      const map = new Map<string, unknown>();
      for (const row of need.relatedRows) {
        const key = normalizeJoinKey(row[need.relatedJoinField]);
        if (key !== null && !map.has(key)) {
          map.set(key, row[need.fieldId]);
        }
      }
      lookups.push({ fieldId: need.fieldId, widgetJoinField: need.widgetJoinField, map });
    } else {
      // Build: widgetJoinValue → first matching target field value via junction
      const junctionRows = dataSources[need.junctionSourceId]?.rows ?? [];
      // targetJoinValue → fieldValue
      const targetLookup = new Map<string, unknown>();
      for (const row of need.targetRows) {
        const key = normalizeJoinKey(row[need.targetJoinField]);
        if (key !== null && !targetLookup.has(key)) {
          targetLookup.set(key, row[need.fieldId]);
        }
      }
      // widgetJoinValue → first target field value
      const map = new Map<string, unknown>();
      for (const jRow of junctionRows) {
        const widgetKey = normalizeJoinKey(jRow[need.junctionWidgetField]);
        if (widgetKey === null || map.has(widgetKey)) {
          continue;
        }
        const targetKey = normalizeJoinKey(jRow[need.junctionTargetField]);
        map.set(widgetKey, targetKey === null ? undefined : targetLookup.get(targetKey));
      }
      lookups.push({ fieldId: need.fieldId, widgetJoinField: need.widgetJoinField, map });
    }
  }

  // Enrich rows (non-mutating)
  return rows.map((row) => {
    const extras: Row = {};
    for (const { fieldId, widgetJoinField, map } of lookups) {
      if (!(fieldId in row)) {
        const key = normalizeJoinKey(row[widgetJoinField]);
        extras[fieldId] = key === null ? undefined : map.get(key);
      }
    }
    return Object.keys(extras).length > 0 ? { ...row, ...extras } : row;
  });
}
