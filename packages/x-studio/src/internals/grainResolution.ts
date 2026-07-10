import type {
  StudioDataSource,
  StudioExpressionField,
  StudioFilterState,
  StudioRelationship,
} from '../models';
import { getCachedEnrichedRows } from './enrichedRowsCache';
import { enrichRowsWithRelatedFields, findDirectRelationship } from './dataSourceGraph';
import { collectKeySet, indexRowsByKey, normalizeJoinKey } from './joinKeys';
import { applyFilters } from './filterUtils';

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
  /**
   * The widget's fully resolved/scoped filter set (page + widget + cross-filter + interactive,
   * date-range presets already resolved to concrete bounds — i.e. exactly what L3 used to
   * produce `widgetRows`). Only the subset targeting the ANCHOR source (`filterSourceId ===
   * anchorSourceId`) is applied here, directly to the anchor rows, before the expansion join.
   *
   * L3 enforces an anchor-source-field filter as a semi-join (keep a widget row if it has AT
   * LEAST ONE matching anchor row) — by design, since a widget row can have many anchor rows and
   * only some need to match. Without this parameter, the expansion join below reads ALL of a
   * surviving widget row's anchor rows straight from the (unfiltered) data-source store,
   * resurrecting exactly the anchor rows the filter excluded — e.g. summing every order
   * (paid + unpaid) for a customer with at least one paid order, instead of just the paid ones
   * (finding 1.4).
   */
  widgetFilters: StudioFilterState[] = [],
): Row[] {
  // Determine which requested fields are expression fields on the anchor source.
  const exprFieldIdsOnSource = new Set(
    expressionFields.flatMap((ef) =>
      ef.sourceId === anchorSourceId && !ef.isMeasure ? [ef.id] : [],
    ),
  );
  const needsExpressionEnrichment = requestedFields.some((f) => exprFieldIdsOnSource.has(f));

  // The subset of the widget's resolved filters that target the ANCHOR source's own fields
  // (a cross-filter or page filter whose `filterSourceId === anchorSourceId`). Applied directly
  // to the anchor rows, before the expansion join, in both re-anchor branches below (finding 1.4).
  const anchorScopedFilters = widgetFilters.filter((f) => f.filterSourceId === anchorSourceId);

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

    // A THIRD source reachable many-to-one from widgetSourceId (distinct from the junction and
    // the M:N remote endpoint) can own a requested dimension field — e.g. y lives on the
    // junction while x/series is owned by `customers`, one-hop from `orders`. `analyzeChartSupport`
    // validates and reports this configuration as supported, so it must actually be enriched onto
    // the widget rows here (mirroring the many-to-one branch's own third-source enrichment)
    // instead of silently resolving to `undefined` on every output row (finding 1.3).
    const widgetRowsEnriched = enrichRowsWithRelatedFields(
      widgetRows,
      widgetSourceId,
      requestedFields.filter(
        (fieldId) =>
          fieldOwners.get(fieldId) !== anchorSourceId &&
          fieldOwners.get(fieldId) !== remoteSourceId,
      ),
      dataSources,
      relationships,
      collectReadSourceIds,
    );

    // Build lookup maps for widget and remote source (normalized join keys).
    const allowedWidgetKeys = collectKeySet(widgetRows, widgetJoinField);
    const widgetRowLookup = indexRowsByKey(widgetRowsEnriched, widgetJoinField);

    // Re-apply the filter subset scoped to the M:N REMOTE endpoint (finding 2.3). L3 enforced a
    // remote-endpoint filter (e.g. `tags.category = 'priority'`) only as a semi-join on the widget
    // rows ("keep orders having >=1 matching tag"); the expansion join below then walks EVERY
    // junction row of a surviving widget row — including links to remote rows the filter excluded,
    // resurrecting weights for excluded categories. Filter the remote rows here (enriching first,
    // in case the filter targets a remote-owned expression column) and drop, below, any junction
    // row whose target key is no longer present — the remote-endpoint analogue of the iter6
    // anchor/junction-scoped fix.
    const remoteScopedFilters = widgetFilters.filter((f) => f.filterSourceId === remoteSourceId);
    const rawRemoteRows = dataSources[remoteSourceId]?.rows ?? [];
    const filteredRemoteRows =
      remoteScopedFilters.length > 0
        ? applyFilters(
            enrichSourceRowsWithExpressions(
              rawRemoteRows,
              remoteSourceId,
              dataSources,
              relationships,
              expressionFields,
              undefined,
              collectReadSourceIds,
            ),
            remoteScopedFilters,
          )
        : rawRemoteRows;
    const remoteRowLookup = indexRowsByKey(filteredRemoteRows, remoteJoinField);

    // Junction-owned expression fields (e.g. a calculated column on the M:N junction table)
    // need L2 enrichment too — the junction rows were previously read raw, unlike every other
    // anchor branch, which routes through `enrichSourceRowsWithExpressions` (finding 1.3).
    const junctionRowsRaw = dataSources[anchorSourceId]?.rows ?? [];
    const junctionRowsEnriched = needsExpressionEnrichment
      ? enrichSourceRowsWithExpressions(
          junctionRowsRaw,
          anchorSourceId,
          dataSources,
          relationships,
          expressionFields,
          exprFieldIdsOnSource,
          collectReadSourceIds,
        )
      : junctionRowsRaw;

    // Apply the anchor(junction)-source-scoped filter subset directly to the junction rows
    // BEFORE the expansion join, so a filter on the junction's own fields (already enforced at
    // L3 as a semi-join keeping widget rows with >=1 matching junction row) doesn't get silently
    // re-widened back to every junction row for each surviving widget row (finding 1.4).
    const junctionRows = applyFilters(junctionRowsEnriched, anchorScopedFilters);

    return junctionRows.flatMap((jRow) => {
      const widgetKey = normalizeJoinKey(jRow[junctionWidgetField]);
      if (widgetKey === null || !allowedWidgetKeys.has(widgetKey)) {
        return [];
      }
      const widgetRow = widgetRowLookup.get(widgetKey) ?? {};
      const targetKey = normalizeJoinKey(jRow[junctionTargetField]);
      const remoteRow = targetKey === null ? undefined : remoteRowLookup.get(targetKey);
      // With a remote-endpoint filter active, a junction row whose target is absent from the
      // filtered remote key set links to an excluded remote row — drop it entirely rather than
      // emitting a row with the excluded value stripped (finding 2.3). Without such a filter,
      // keep the row even if the remote lookup misses (unchanged display-enrichment behavior).
      if (remoteScopedFilters.length > 0 && remoteRow === undefined) {
        return [];
      }
      return [{ ...widgetRow, ...(remoteRow ?? {}), ...jRow }];
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
  // Apply the anchor-source-scoped filter subset directly to the anchor ("many"-side) rows
  // BEFORE the join-membership filter below. L3 already enforced this filter as a semi-join
  // (kept a widget row if it has >=1 matching anchor row); without re-applying it here, EVERY
  // anchor row for a surviving widget row is read straight from the (unfiltered) store,
  // resurrecting exactly the rows the filter excluded — e.g. summing all orders (paid + unpaid)
  // for a customer with >=1 paid order instead of just the paid ones (finding 1.4).
  const enrichedAnchorRows = applyFilters(
    enrichSourceRowsWithExpressions(
      dataSources[anchorSourceId]?.rows ?? [],
      anchorSourceId,
      dataSources,
      relationships,
      expressionFields,
      anchorFieldIds.size > 0 ? anchorFieldIds : new Set(requestedFields),
      collectReadSourceIds,
    ),
    anchorScopedFilters,
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
