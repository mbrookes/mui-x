import type { StudioDataSource, StudioExpressionField, StudioRelationship } from '../models';
import { getCachedEnrichedRows } from './enrichedRowsCache';
import { enrichRowsWithRelatedFields, findDirectRelationship } from './dataSourceGraph';
import { collectKeySet, indexRowsByKey, normalizeJoinKey } from './joinKeys';

type Row = Record<string, unknown>;

function enrichSourceRowsWithExpressions(
  rows: Row[],
  sourceId: string,
  dataSources: Record<string, StudioDataSource>,
  relationships: StudioRelationship[],
  expressionFields: StudioExpressionField[],
  usedFieldIds?: ReadonlySet<string>,
  collectReadSourceIds?: Set<string>,
): Row[] {
  return getCachedEnrichedRows(
    rows,
    sourceId,
    expressionFields,
    dataSources,
    relationships,
    usedFieldIds,
    collectReadSourceIds,
  );
}

/**
 * L4 fan-out grain resolution — the shared core extracted from
 * `chartAggregation.resolveChartRowsForAggregation`.
 *
 * Given widget rows and a chosen `anchorSourceId`, returns a flat row set at the
 * anchor's grain with all `requestedFields` present, so a plain
 * per-row aggregation over the result cannot double-count from a fan-out join.
 * `fieldOwners` maps each requested field id to the source that owns it (as
 * computed by `analyzeChartSupport`); callers that don't have it can pass an
 * empty map — the anchor branches only read owners to route fields.
 *
 * DIRECTION / SCOPE: this resolves rows to a **fan-out** anchor — either the
 * widget source itself (no re-anchor, display-column enrichment only), the
 * "many" side of a many-to-one where the widget is the "one" side, or the
 * junction of a many-to-many. In every supported case each anchor row maps to
 * exactly one group because the grouping dimension lives on the coarser side, so
 * a single global row set is correct.
 *
 * It is deliberately NOT suitable for the opposite ("fan-in") direction where the
 * widget is the many side and the measure lives on a directly-related one side
 * grouped by a many-side field (e.g. grid: sum `orders.total` grouped by
 * `order_items.category`). There the same one-side row belongs to multiple groups,
 * so no single global grain exists and a per-group dedup is required instead — see
 * `utils/gridGrouping.symmetricAggregate`. Feeding that topology here would
 * enrich-and-double-count. `chartAggregation.analyzeChartSupport` never selects
 * such an anchor, so charts never hit it.
 *
 * Join keys everywhere use the shared `normalizeJoinKey` policy
 * (internals/joinKeys.ts).
 */
export function resolveRowsAtGrain(
  widgetRows: Row[],
  widgetSourceId: string,
  anchorSourceId: string,
  requestedFields: string[],
  fieldOwners: Map<string, string>,
  dataSources: Record<string, StudioDataSource>,
  relationships: StudioRelationship[],
  expressionFields: StudioExpressionField[] = [],
  /**
   * Out-param: every foreign source id whose rows this call actually reads — a related source
   * enriched for a display/dimension field, a many-to-many remote endpoint, or a
   * join-field-expression target — is added to it (the widget source and the anchor source are
   * NOT added; the caller already tracks those directly). `resolveChartRowsForAggregation` folds
   * these row refs into its L4 (`rcfaCache`) validity check so a non-anchor related source's rows
   * changing invalidates the entry instead of serving stale rows (finding 1.5).
   */
  collectReadSourceIds?: Set<string>,
): Row[] {
  // Determine which requested fields are expression fields on the anchor source.
  const exprFieldIdsOnSource = new Set(
    expressionFields.flatMap((ef) =>
      ef.sourceId === anchorSourceId && !ef.isMeasure ? [ef.id] : [],
    ),
  );
  const needsExpressionEnrichment = requestedFields.some((f) => exprFieldIdsOnSource.has(f));

  if (anchorSourceId === widgetSourceId) {
    const related = enrichRowsWithRelatedFields(
      widgetRows,
      widgetSourceId,
      requestedFields,
      dataSources,
      relationships,
      collectReadSourceIds,
    );
    return needsExpressionEnrichment
      ? enrichSourceRowsWithExpressions(
          related,
          widgetSourceId,
          dataSources,
          relationships,
          expressionFields,
          new Set(requestedFields),
          collectReadSourceIds,
        )
      : related;
  }

  const anchorRelationship = findDirectRelationship(widgetSourceId, anchorSourceId, relationships);

  // ── Many-to-many anchor: anchorSourceId is the junction source ──────────────
  const manyToManyRel = relationships.find(
    (rel) =>
      rel.type === 'many-to-many' &&
      rel.junctionSourceId === anchorSourceId &&
      (rel.sourceId === widgetSourceId || rel.targetId === widgetSourceId),
  );

  if (manyToManyRel && manyToManyRel.junctionSourceField && manyToManyRel.junctionTargetField) {
    // Determine which junction field links back to widgetSource
    const junctionWidgetField =
      manyToManyRel.sourceId === widgetSourceId
        ? manyToManyRel.junctionSourceField
        : manyToManyRel.junctionTargetField;
    const junctionTargetField =
      manyToManyRel.sourceId === widgetSourceId
        ? manyToManyRel.junctionTargetField
        : manyToManyRel.junctionSourceField;
    const widgetJoinField =
      manyToManyRel.sourceId === widgetSourceId
        ? manyToManyRel.sourceField
        : manyToManyRel.targetField;
    const remoteSourceId =
      manyToManyRel.sourceId === widgetSourceId ? manyToManyRel.targetId : manyToManyRel.sourceId;
    const remoteJoinField =
      manyToManyRel.sourceId === widgetSourceId
        ? manyToManyRel.targetField
        : manyToManyRel.sourceField;

    // The junction (anchor) rows are tracked by the caller as `anchorRows`; the remote endpoint
    // is a distinct foreign source whose rows this branch reads and must be reported (finding 1.5).
    collectReadSourceIds?.add(remoteSourceId);

    // Build lookup maps for widget and remote source (normalized join keys).
    const allowedWidgetKeys = collectKeySet(widgetRows, widgetJoinField);
    const widgetRowLookup = indexRowsByKey(widgetRows, widgetJoinField);
    const remoteRowLookup = indexRowsByKey(
      dataSources[remoteSourceId]?.rows ?? [],
      remoteJoinField,
    );

    const junctionRows = dataSources[anchorSourceId]?.rows ?? [];
    return junctionRows.flatMap((jRow) => {
      const widgetKey = normalizeJoinKey(jRow[junctionWidgetField]);
      if (widgetKey === null || !allowedWidgetKeys.has(widgetKey)) {
        return [];
      }
      const widgetRow = widgetRowLookup.get(widgetKey) ?? {};
      const targetKey = normalizeJoinKey(jRow[junctionTargetField]);
      const remoteRow = (targetKey === null ? undefined : remoteRowLookup.get(targetKey)) ?? {};
      return [{ ...widgetRow, ...remoteRow, ...jRow }];
    });
  }

  if (
    !anchorRelationship ||
    anchorRelationship.type === 'many-to-many' ||
    anchorRelationship.sourceId !== anchorSourceId ||
    anchorRelationship.targetId !== widgetSourceId
  ) {
    return enrichRowsWithRelatedFields(
      widgetRows,
      widgetSourceId,
      requestedFields,
      dataSources,
      relationships,
      collectReadSourceIds,
    );
  }

  // ── Many-to-one anchor switch: widget is the "one" side, anchor is the "many" ──
  const widgetJoinField = anchorRelationship.targetField;
  const anchorJoinField = anchorRelationship.sourceField;
  const allowedWidgetKeys = collectKeySet(widgetRows, widgetJoinField);
  // Pass only the fields owned by anchorSourceId so getCachedEnrichedRows
  // builds a tighter field-set key and skips unrelated widget-source fields.
  const anchorFieldIds = new Set(
    requestedFields.filter((f) => fieldOwners.get(f) === anchorSourceId),
  );
  const enrichedAnchorRows = enrichSourceRowsWithExpressions(
    dataSources[anchorSourceId]?.rows ?? [],
    anchorSourceId,
    dataSources,
    relationships,
    expressionFields,
    anchorFieldIds.size > 0 ? anchorFieldIds : new Set(requestedFields),
    collectReadSourceIds,
  ).filter((row) => {
    const key = normalizeJoinKey(row[anchorJoinField]);
    return key !== null && allowedWidgetKeys.has(key);
  });

  const widgetRowsForLookup = enrichRowsWithRelatedFields(
    widgetRows,
    widgetSourceId,
    requestedFields.filter((fieldId) => fieldOwners.get(fieldId) !== anchorSourceId),
    dataSources,
    relationships,
    collectReadSourceIds,
  );

  const widgetRowLookup = indexRowsByKey(widgetRowsForLookup, widgetJoinField);

  return enrichedAnchorRows.map((anchorRow) => {
    const key = normalizeJoinKey(anchorRow[anchorJoinField]);
    const widgetRow = key === null ? undefined : widgetRowLookup.get(key);
    if (!widgetRow) {
      return anchorRow;
    }

    const extras: Row = {};
    for (const fieldId of requestedFields) {
      if (fieldOwners.get(fieldId) === anchorSourceId || fieldId in anchorRow) {
        continue;
      }
      extras[fieldId] = widgetRow[fieldId];
    }

    return Object.keys(extras).length > 0 ? { ...anchorRow, ...extras } : anchorRow;
  });
}
