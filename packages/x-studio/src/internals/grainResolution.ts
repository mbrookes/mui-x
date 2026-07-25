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
import { getCachedNormalizedDataSource } from './normalizedRowsCache';

type Row = Record<string, unknown>;

/**
 * The effective source a filter targets, mirroring L3's derivation in `dataSourceGraph.resolveRows`.
 *
 * A filter authored in the filters drawer on an expression field owned by ANOTHER source carries
 * **no** explicit `filterSourceId` — L3 derives the owner on the fly (`resolveRows` routes it as a
 * cross-filter using `expressionField.sourceId`). L4's anchor/remote-scoped-filter classification
 * (and its result-cache key in `resolveChartRowsForAggregation`) must derive the same owner, or
 * such a filter is invisible here and the anchor-row "resurrection" fix (finding 1.4) silently does
 * not apply to this exact filter shape (finding 1.3a).
 *
 * Returns the explicit `filterSourceId` when present; otherwise the source of a non-measure
 * expression field matching the filter's `field` that is NOT owned by the widget source; otherwise
 * `undefined` (a native/same-source filter, already enforced by L3).
 */
export function effectiveFilterSourceId(
  filter: StudioFilterState,
  widgetSourceId: string,
  expressionFields: StudioExpressionField[],
): string | undefined {
  if (filter.filterSourceId != null) {
    return filter.filterSourceId;
  }
  if (!filter.field) {
    return undefined;
  }
  const exprOwner = expressionFields.find(
    (ef) => ef.id === filter.field && !ef.isMeasure && ef.sourceId !== widgetSourceId,
  );
  return exprOwner?.sourceId;
}

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
 * Enriches `rows` with requested fields that are CALCULATED COLUMNS (non-measure expression
 * fields) owned by a directly related source, one hop from `widgetSourceId` (one-to-one or
 * many-to-one — mirrors `enrichRowsWithRelatedFields`'s own direct-relationship traversal).
 *
 * `enrichRowsWithRelatedFields` (the native-field display-column enrichment used by the
 * same-source anchor branch below) filters candidate fields by `relatedSource.fields.some(...)`,
 * so it silently skips any field id that is a calculated column rather than a physical one — the
 * related source's raw rows carry no value for it. This mirrors the fix already applied to the
 * many-to-one/M:N re-anchor branches (which always run their related/anchor/junction rows through
 * `enrichSourceRowsWithExpressions` before joining): a related-source expression column used as a
 * chart dimension must resolve to a real value, not `undefined`, whether or not a filter happens
 * to also target that field (finding 2.x).
 */
function enrichForeignExpressionFields(
  rows: Row[],
  widgetSourceId: string,
  requestedFields: string[],
  fieldOwners: Map<string, string>,
  dataSources: Record<string, StudioDataSource>,
  relationships: StudioRelationship[],
  expressionFields: StudioExpressionField[],
  collectReadSourceIds?: Set<string>,
): Row[] {
  const fieldIdsByOwner = new Map<string, Set<string>>();
  for (const fieldId of requestedFields) {
    const owner = fieldOwners.get(fieldId);
    if (
      !owner ||
      owner === widgetSourceId ||
      !expressionFields.some((ef) => ef.id === fieldId && ef.sourceId === owner && !ef.isMeasure)
    ) {
      continue;
    }
    let set = fieldIdsByOwner.get(owner);
    if (!set) {
      set = new Set<string>();
      fieldIdsByOwner.set(owner, set);
    }
    set.add(fieldId);
  }

  if (fieldIdsByOwner.size === 0) {
    return rows;
  }

  let result = rows;
  for (const [ownerSourceId, fieldIds] of fieldIdsByOwner) {
    const relationship = findDirectRelationship(widgetSourceId, ownerSourceId, relationships);
    if (!relationship || relationship.type === 'many-to-many') {
      continue;
    }
    const widgetJoinField =
      relationship.sourceId === widgetSourceId
        ? relationship.sourceField
        : relationship.targetField;
    const ownerJoinField =
      relationship.sourceId === widgetSourceId
        ? relationship.targetField
        : relationship.sourceField;

    collectReadSourceIds?.add(ownerSourceId);
    // Route through the same L1 date normalization applied to every other foreign source this
    // module reads (anchor/junction/remote rows) rather than the raw store — an expression
    // referencing a raw date/datetime field on the owner source would otherwise bucket
    // differently than the widget's own L1-normalized dates for a non-UTC viewer (finding 4).
    const ownerDataSource = dataSources[ownerSourceId];
    const enrichedOwnerRows = enrichSourceRowsWithExpressions(
      ownerDataSource ? (getCachedNormalizedDataSource(ownerDataSource).rows ?? []) : [],
      ownerSourceId,
      dataSources,
      relationships,
      expressionFields,
      fieldIds,
      collectReadSourceIds,
    );
    const ownerIndex = indexRowsByKey(enrichedOwnerRows, ownerJoinField);

    result = result.map((row) => {
      const key = normalizeJoinKey(row[widgetJoinField]);
      const ownerRow = key === null ? undefined : ownerIndex.get(key);
      if (!ownerRow) {
        return row;
      }
      const extras: Row = {};
      let changed = false;
      for (const fieldId of fieldIds) {
        if (!(fieldId in row) && ownerRow[fieldId] !== undefined) {
          extras[fieldId] = ownerRow[fieldId];
          changed = true;
        }
      }
      return changed ? { ...row, ...extras } : row;
    });
  }

  return result;
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
 * empty map. The anchor branches only read owners to route fields, and a field
 * with no entry falls back to the anchor source's own schema (see
 * `isAnchorOwnedField`), so an empty map still routes anchor-owned fields to the
 * anchor row's real value rather than overwriting it from the widget row. The
 * only thing lost is the tie-break for a field id that exists on BOTH sources —
 * that resolves to the anchor instead of to the owner `analyzeChartSupport`
 * computed.
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
  // (a cross-filter or page filter whose effective source is the anchor). Applied directly to the
  // anchor rows, before the expansion join, in both re-anchor branches below (finding 1.4). The
  // effective source is derived (not just read off `filterSourceId`) so a drawer filter on an
  // anchor-owned EXPRESSION field — which carries no explicit `filterSourceId`, exactly as L3
  // handles it — is recognized as anchor-scoped too (finding 1.3a).
  const anchorScopedFilters = widgetFilters.filter(
    (f) => effectiveFilterSourceId(f, widgetSourceId, expressionFields) === anchorSourceId,
  );

  if (anchorSourceId === widgetSourceId) {
    const related = enrichRowsWithRelatedFields(
      widgetRows,
      widgetSourceId,
      requestedFields,
      dataSources,
      relationships,
      collectReadSourceIds,
    );
    const relatedWithForeignExpressions = enrichForeignExpressionFields(
      related,
      widgetSourceId,
      requestedFields,
      fieldOwners,
      dataSources,
      relationships,
      expressionFields,
      collectReadSourceIds,
    );
    return needsExpressionEnrichment
      ? enrichSourceRowsWithExpressions(
          relatedWithForeignExpressions,
          widgetSourceId,
          dataSources,
          relationships,
          expressionFields,
          new Set(requestedFields),
          collectReadSourceIds,
        )
      : relatedWithForeignExpressions;
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
    const thirdSourceFieldIds = requestedFields.filter(
      (fieldId) =>
        fieldOwners.get(fieldId) !== anchorSourceId && fieldOwners.get(fieldId) !== remoteSourceId,
    );
    const widgetRowsEnriched = enrichRowsWithRelatedFields(
      widgetRows,
      widgetSourceId,
      thirdSourceFieldIds,
      dataSources,
      relationships,
      collectReadSourceIds,
    );
    // `enrichRowsWithRelatedFields` only resolves PHYSICAL columns on the related source (it
    // filters candidates against `relatedSource.fields`) — a third-source CALCULATED (non-measure
    // expression) dimension has no counterpart there and would silently resolve to `undefined` on
    // every output row despite `analyzeChartSupport` reporting the configuration as supported. Run
    // the same `enrichForeignExpressionFields` pass the no-re-anchor branch already applies, so a
    // third-source expression-field dimension resolves consistently whether or not the chart
    // re-anchors (finding 1).
    const widgetRowsEnrichedWithExpr = enrichForeignExpressionFields(
      widgetRowsEnriched,
      widgetSourceId,
      thirdSourceFieldIds,
      fieldOwners,
      dataSources,
      relationships,
      expressionFields,
      collectReadSourceIds,
    );

    // Build lookup maps for widget and remote source (normalized join keys).
    const allowedWidgetKeys = collectKeySet(widgetRows, widgetJoinField);
    const widgetRowLookup = indexRowsByKey(widgetRowsEnrichedWithExpr, widgetJoinField);

    // Re-apply the filter subset scoped to the M:N REMOTE endpoint (finding 2.3). L3 enforced a
    // remote-endpoint filter (e.g. `tags.category = 'priority'`) only as a semi-join on the widget
    // rows ("keep orders having >=1 matching tag"); the expansion join below then walks EVERY
    // junction row of a surviving widget row — including links to remote rows the filter excluded,
    // resurrecting weights for excluded categories. Filter the remote rows here (enriching first,
    // in case the filter targets a remote-owned expression column) and drop, below, any junction
    // row whose target key is no longer present — the remote-endpoint analogue of the iter6
    // anchor/junction-scoped fix.
    const remoteScopedFilters = widgetFilters.filter(
      (f) => effectiveFilterSourceId(f, widgetSourceId, expressionFields) === remoteSourceId,
    );
    // Route through the same L1 date normalization the widget's own source rows already get
    // (`useWidgetRows`'s `getCachedNormalizedDataSource`) before this branch reads them raw.
    // Without it, a date/datetime field on the remote source stays a raw `Date`/number/non-
    // canonical string here, and the filter engine (`filterUtils.ts`'s LOCAL-calendar-day
    // policy) and the chart grouping engine (`@mui/x-studio-schema`'s `truncateToPeriod`, a
    // UTC-component policy) can bucket the SAME raw value into different days for a non-UTC
    // viewer (finding 7). Normalizing to the canonical `YYYY-MM-DD` string here closes that gap
    // — both policies treat a canonical string identically (no `Date` construction involved).
    const remoteDataSource = dataSources[remoteSourceId];
    const rawRemoteRows = remoteDataSource
      ? (getCachedNormalizedDataSource(remoteDataSource).rows ?? [])
      : [];
    // Enrich the remote rows with their own calculated columns UNCONDITIONALLY — not only when a
    // remote-scoped filter happens to be active. A remote-owned expression column requested as a
    // chart dimension (x/series) is read straight off `remoteRowLookup` below with no other L2
    // pass over it, so gating this enrichment on filter presence left it `undefined` on every row
    // whenever no filter happened to target that same field (finding 2.x).
    const enrichedRemoteRows = enrichSourceRowsWithExpressions(
      rawRemoteRows,
      remoteSourceId,
      dataSources,
      relationships,
      expressionFields,
      undefined,
      collectReadSourceIds,
    );
    const filteredRemoteRows =
      remoteScopedFilters.length > 0
        ? applyFilters(enrichedRemoteRows, remoteScopedFilters)
        : enrichedRemoteRows;
    const remoteRowLookup = indexRowsByKey(filteredRemoteRows, remoteJoinField);

    // Junction-owned expression fields (e.g. a calculated column on the M:N junction table)
    // need L2 enrichment too — the junction rows were previously read raw, unlike every other
    // anchor branch, which routes through `enrichSourceRowsWithExpressions` (finding 1.3).
    // Enrichment must also fire when an anchor(junction)-scoped FILTER references a junction-owned
    // expression column that is NOT among the requested chart fields; otherwise `applyFilters`
    // below evaluates that column as `undefined` on every junction row and empties the chart
    // (finding 1.3b). `exprFieldIdsOnSource` already covers every non-measure junction expression
    // field, so no extra field ids need threading — only the enrichment gate widens.
    // Same L1 date normalization as `rawRemoteRows` above, applied to the junction rows
    // (finding 7).
    const junctionDataSource = dataSources[anchorSourceId];
    const junctionRowsRaw = junctionDataSource
      ? (getCachedNormalizedDataSource(junctionDataSource).rows ?? [])
      : [];
    const needsJunctionExpressionEnrichment =
      needsExpressionEnrichment ||
      anchorScopedFilters.some((f) => f.field != null && exprFieldIdsOnSource.has(f.field));
    const junctionRowsEnriched = needsJunctionExpressionEnrichment
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
    // BEFORE the expansion join, so a filter on the junction's own fields — now ALSO enforced at
    // L3 as a one-hop semi-join against the junction's own rows (`dataSourceGraph.findJoinPath`'s
    // dedicated junction-source case, finding 3) keeping widget rows with >=1 matching junction
    // row — doesn't get silently re-widened back to every junction row for each surviving widget
    // row (finding 1.4). (This comment previously claimed L3 already did this semi-join, but
    // `findJoinPath` had no case for a `filterSourceId` naming the junction directly, so the
    // filter was actually being silently DROPPED at L3 for every non-junction-anchored widget —
    // finding 3 closes that gap so every widget on a page now agrees on the filtered row set.)
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
      // Merge widget → remote → junction, but a remote/junction column may only override an
      // already-present widget/remote value when the target field is ACTUALLY owned by that
      // source (remoteSourceId / anchorSourceId) per `fieldOwners` — mirrors the own-field-
      // ownership guard in `crossSourceEnrichment.ts`/`dataSourceGraph.ts`'s
      // `enrichRowsWithRelatedFields`. Spreading `remoteRow` unconditionally over `widgetRow` let a
      // remote column that coincidentally shares a field id with a widget-owned field (e.g. a
      // remote `amount` vs. the widget's own `orders.amount`) silently win, since it was applied
      // after `widgetRow` with no ownership check (finding 1).
      const merged: Row = { ...widgetRow };
      for (const [key, value] of Object.entries(remoteRow ?? {})) {
        if (key in merged && fieldOwners.get(key) !== remoteSourceId) {
          continue;
        }
        merged[key] = value;
      }
      // Merge widget → remote → junction, but a junction column may only override an
      // already-present widget/remote value when the target field is ACTUALLY owned by the
      // junction (anchorSourceId) per `fieldOwners` — mirrors the own-field-ownership guard in
      // `crossSourceEnrichment.ts`/`dataSourceGraph.ts`'s `enrichRowsWithRelatedFields`. Spreading
      // `jRow` last unconditionally let a junction column that coincidentally shares a field id
      // with a widget- or remote-owned field (e.g. a junction `amount` allocation weight vs. the
      // widget's own `orders.amount`) silently win, since it was applied last (finding 3).
      for (const [key, value] of Object.entries(jRow)) {
        if (key in merged && fieldOwners.get(key) !== anchorSourceId) {
          continue;
        }
        merged[key] = value;
      }
      return [merged];
    });
  }

  if (
    !anchorRelationship ||
    anchorRelationship.type === 'many-to-many' ||
    anchorRelationship.sourceId !== anchorSourceId ||
    anchorRelationship.targetId !== widgetSourceId
  ) {
    // Reached for a one-to-one anchor declared in the REVERSE direction (`sourceId ===
    // widgetSourceId`, `targetId === anchorSourceId`) — direction-independence for a 1:1 anchor
    // is now supported by `analyzeChartSupport` (finding 6), and each widget row still maps to at
    // most one related row (no fan-out either way for a genuine 1:1), so a plain FK-based
    // enrichment of the widget rows is the correct result here, same as the many-to-one anchor
    // switch below produces for the forward direction. `enrichRowsWithRelatedFields` only
    // resolves PHYSICAL columns, so a requested field that is a CALCULATED column owned by the
    // anchor (or another directly-related) source must also go through `enrichForeignExpressionFields`
    // or it silently resolves to `undefined` (finding 1).
    const related = enrichRowsWithRelatedFields(
      widgetRows,
      widgetSourceId,
      requestedFields,
      dataSources,
      relationships,
      collectReadSourceIds,
    );
    return enrichForeignExpressionFields(
      related,
      widgetSourceId,
      requestedFields,
      fieldOwners,
      dataSources,
      relationships,
      expressionFields,
      collectReadSourceIds,
    );
  }

  // ── Many-to-one anchor switch: widget is the "one" side, anchor is the "many" ──
  const widgetJoinField = anchorRelationship.targetField;
  const anchorJoinField = anchorRelationship.sourceField;
  const allowedWidgetKeys = collectKeySet(widgetRows, widgetJoinField);
  /**
   * "Is this field owned by the anchor source?" — the only question this branch asks of
   * `fieldOwners`.
   *
   * `fieldOwners` is documented as passable EMPTY by callers that haven't run
   * `analyzeChartSupport`, but a bare `fieldOwners.get(f) === anchorSourceId` answers "no" for
   * every field under an empty map, which routes anchor-OWNED fields through the widget-row
   * lookup below and overwrites each anchor row's real value with the widget row's (at best a
   * single fanned-out value repeated across every anchor row, at worst `undefined`). Falling
   * back to the anchor source's own schema when the map has no entry makes the empty-map case
   * behave like the populated one. With a populated map this is never reached, so the routing
   * `analyzeChartSupport` computed always wins.
   */
  const isAnchorOwnedField = (fieldId: string): boolean => {
    const declaredOwner = fieldOwners.get(fieldId);
    if (declaredOwner !== undefined) {
      return declaredOwner === anchorSourceId;
    }
    return (
      (dataSources[anchorSourceId]?.fields.some((f) => f.id === fieldId) ?? false) ||
      expressionFields.some((ef) => ef.id === fieldId && ef.sourceId === anchorSourceId)
    );
  };
  // Pass only the fields owned by anchorSourceId so getCachedEnrichedRows
  // builds a tighter field-set key and skips unrelated widget-source fields.
  const anchorFieldIds = new Set(requestedFields.filter(isAnchorOwnedField));
  // Widen the enrichment set to also include any field referenced by an anchor-scoped filter.
  // Enrichment is otherwise scoped to the REQUESTED anchor fields, so a filter on an anchor-owned
  // EXPRESSION column outside that set would be `undefined` when `applyFilters` evaluates it below —
  // dropping every anchor row and emptying an otherwise-correct chart (finding 1.3b). A native
  // filter field is harmless here (it is not an expression column, so enrichment ignores it).
  for (const f of anchorScopedFilters) {
    if (f.field) {
      anchorFieldIds.add(f.field);
    }
  }
  // Apply the anchor-source-scoped filter subset directly to the anchor ("many"-side) rows
  // BEFORE the join-membership filter below. L3 already enforced this filter as a semi-join
  // (kept a widget row if it has >=1 matching anchor row); without re-applying it here, EVERY
  // anchor row for a surviving widget row is read straight from the (unfiltered) store,
  // resurrecting exactly the rows the filter excluded — e.g. summing all orders (paid + unpaid)
  // for a customer with >=1 paid order instead of just the paid ones (finding 1.4).
  // Same L1 date normalization as the M:N branch's `rawRemoteRows`/`junctionRowsRaw` above,
  // applied to the many-to-one anchor ("many"-side) rows before they're read here (finding 7).
  const manyToOneAnchorDataSource = dataSources[anchorSourceId];
  const enrichedAnchorRows = applyFilters(
    enrichSourceRowsWithExpressions(
      manyToOneAnchorDataSource
        ? (getCachedNormalizedDataSource(manyToOneAnchorDataSource).rows ?? [])
        : [],
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

  const thirdSourceFieldIds = requestedFields.filter((fieldId) => !isAnchorOwnedField(fieldId));
  const widgetRowsForLookup = enrichRowsWithRelatedFields(
    widgetRows,
    widgetSourceId,
    thirdSourceFieldIds,
    dataSources,
    relationships,
    collectReadSourceIds,
  );
  // `enrichRowsWithRelatedFields` only resolves PHYSICAL columns on the related source — a
  // third-source CALCULATED (non-measure expression) field used as a dimension has no
  // counterpart there and would silently resolve to `undefined` on every output row despite
  // `analyzeChartSupport` reporting the configuration as supported. Run the same
  // `enrichForeignExpressionFields` pass the no-re-anchor branch already applies, so a
  // third-source expression-field dimension resolves consistently whether or not the chart
  // re-anchors (finding 1).
  const widgetRowsForLookupWithExpr = enrichForeignExpressionFields(
    widgetRowsForLookup,
    widgetSourceId,
    thirdSourceFieldIds,
    fieldOwners,
    dataSources,
    relationships,
    expressionFields,
    collectReadSourceIds,
  );

  const widgetRowLookup = indexRowsByKey(widgetRowsForLookupWithExpr, widgetJoinField);

  return enrichedAnchorRows.map((anchorRow) => {
    const key = normalizeJoinKey(anchorRow[anchorJoinField]);
    const widgetRow = key === null ? undefined : widgetRowLookup.get(key);
    if (!widgetRow) {
      return anchorRow;
    }

    const extras: Row = {};
    for (const fieldId of requestedFields) {
      // Skip only when the anchor source is the field's ACTUAL owner (per `fieldOwners`) — not
      // merely because the raw anchor row happens to already carry a same-named column. A
      // same-named anchor-source column that is NOT the field's real owner (e.g. a coincidental
      // physical column on the anchor source sharing an id with a widget-owned field) must not
      // silently win over the correctly-owned widget value (finding 3).
      if (isAnchorOwnedField(fieldId)) {
        continue;
      }
      const value = widgetRow[fieldId];
      // Belt-and-braces: never blank out a value the anchor row already carries. A field that
      // reaches here is not anchor-owned, so the raw anchor row normally has nothing for it —
      // but if a caller's `fieldOwners` disagrees with the anchor's schema, "keep what's
      // there" beats writing `undefined` over a real value.
      if (value === undefined && anchorRow[fieldId] !== undefined) {
        continue;
      }
      extras[fieldId] = value;
    }

    return Object.keys(extras).length > 0 ? { ...anchorRow, ...extras } : anchorRow;
  });
}
