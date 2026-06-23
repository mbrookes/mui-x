import type {
  StudioDataSource,
  StudioExpressionField,
  StudioFilterState,
  StudioRelationship,
} from '../models';
import { getCachedEnrichedRows } from './enrichedRowsCache';
import { applyFilters } from './filterUtils';

type Row = Record<string, unknown>;

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
  options?: { skipEnrichment?: boolean; usedFieldIds?: ReadonlySet<string> },
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
    if (f.scope.kind === 'dashboard-date-range' && f.filterSourceId && f.filterSourceId !== widgetSourceId) {
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
        ),
      );
    }
    const enrichedForeignRows = foreignEnrichedCache.get(f.filterSourceId)!;
    const matchingForeignRows = applyFilters(enrichedForeignRows, [baseFilter]);

    if (joinPath.hops === 1) {
      // One-hop (direct) semi-join: keep widget rows whose join field is in the allowed set
      const allowedValues = new Set(matchingForeignRows.map((r) => r[joinPath.filterJoinField]));
      rows = rows.filter((r) => allowedValues.has(r[joinPath.widgetJoinField]));
    } else {
      // Two-hop (M:N) semi-join via junction source:
      // 1. Collect the filter-side join values from matching foreign rows
      // 2. Walk the junction to find widget-side join values that link to those
      // 3. Keep widget rows in the resulting allowed set
      const matchingFilterValues = new Set(
        matchingForeignRows.map((r) => r[joinPath.filterJoinField]),
      );
      const junctionRows = dataSources[joinPath.junctionSourceId]?.rows ?? [];
      const allowedWidgetValues = new Set<unknown>(
        junctionRows.reduce<unknown[]>((acc, r) => {
          if (matchingFilterValues.has(r[joinPath.junctionFilterField])) {
            acc.push(r[joinPath.junctionWidgetField]);
          }
          return acc;
        }, []),
      );
      rows = rows.filter((r) => allowedWidgetValues.has(r[joinPath.widgetJoinField]));
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

  // Build lookup maps
  const lookups: Array<{
    fieldId: string;
    widgetJoinField: string;
    map: Map<unknown, unknown>;
  }> = [];

  for (const need of foreignFieldNeeds) {
    if (need.kind === 'direct') {
      const map = new Map<unknown, unknown>();
      for (const row of need.relatedRows) {
        map.set(row[need.relatedJoinField], row[need.fieldId]);
      }
      lookups.push({ fieldId: need.fieldId, widgetJoinField: need.widgetJoinField, map });
    } else {
      // Build: widgetJoinValue → first matching target field value via junction
      const junctionRows = dataSources[need.junctionSourceId]?.rows ?? [];
      // targetJoinValue → fieldValue
      const targetLookup = new Map<unknown, unknown>();
      for (const row of need.targetRows) {
        targetLookup.set(row[need.targetJoinField], row[need.fieldId]);
      }
      // widgetJoinValue → first target field value
      const map = new Map<unknown, unknown>();
      for (const jRow of junctionRows) {
        const widgetKey = jRow[need.junctionWidgetField];
        if (!map.has(widgetKey)) {
          map.set(widgetKey, targetLookup.get(jRow[need.junctionTargetField]));
        }
      }
      lookups.push({ fieldId: need.fieldId, widgetJoinField: need.widgetJoinField, map });
    }
  }

  // Enrich rows (non-mutating)
  return rows.map((row) => {
    const extras: Row = {};
    for (const { fieldId, widgetJoinField, map } of lookups) {
      if (!(fieldId in row)) {
        extras[fieldId] = map.get(row[widgetJoinField]);
      }
    }
    return Object.keys(extras).length > 0 ? { ...row, ...extras } : row;
  });
}
