import type { StudioDataSource, StudioExpressionField, StudioRelationship } from '../models';
import { findDirectRelationship } from './dataSourceGraph';
import { resolveRowsAtGrain } from './grainResolution';

type Row = Record<string, unknown>;

/**
 * Relationship / chart-support analysis for the chart aggregation pipeline.
 *
 * Decides whether a chart configuration (x / y / series / scatter fields) can be
 * safely aggregated given the widget's data source and the relationship graph, and
 * — when it can — resolves the widget rows to the correct fan-out-safe grain via the
 * shared L4 core (`grainResolution.resolveRowsAtGrain`).
 */

function hasRowLevelField(
  sourceId: string,
  fieldId: string,
  dataSources: Record<string, StudioDataSource>,
  expressionFields: StudioExpressionField[],
): boolean {
  const source = dataSources[sourceId];
  return (
    source?.fields.some((field) => field.id === fieldId) === true ||
    expressionFields.some(
      (field) => field.sourceId === sourceId && field.id === fieldId && !field.isMeasure,
    )
  );
}

function isSafeWidgetBridgeOwner(
  widgetSourceId: string,
  ownerSourceId: string,
  relationships: StudioRelationship[],
): boolean {
  if (ownerSourceId === widgetSourceId) {
    return true;
  }

  const relationship = findDirectRelationship(widgetSourceId, ownerSourceId, relationships);
  if (relationship) {
    if (relationship.type === 'one-to-one') {
      return true;
    }
    if (relationship.type === 'many-to-many') {
      return true;
    }
    return relationship.sourceId === widgetSourceId;
  }

  // Also allow the junction source of a M:N relationship involving widgetSourceId
  const viaJunction = relationships.some(
    (rel) =>
      rel.type === 'many-to-many' &&
      rel.junctionSourceId === ownerSourceId &&
      (rel.sourceId === widgetSourceId || rel.targetId === widgetSourceId),
  );
  return viaJunction;
}

function findDirectFieldOwner(
  widgetSourceId: string,
  fieldId: string,
  dataSources: Record<string, StudioDataSource>,
  relationships: StudioRelationship[],
  expressionFields: StudioExpressionField[],
): string | null {
  if (hasRowLevelField(widgetSourceId, fieldId, dataSources, expressionFields)) {
    return widgetSourceId;
  }

  // Check direct (one-hop) relationships first
  for (const relationship of relationships) {
    if (relationship.type === 'many-to-many') {
      continue;
    }
    let relatedSourceId: string | null = null;

    if (relationship.sourceId === widgetSourceId) {
      relatedSourceId = relationship.targetId;
    } else if (relationship.targetId === widgetSourceId) {
      relatedSourceId = relationship.sourceId;
    }

    if (
      relatedSourceId &&
      hasRowLevelField(relatedSourceId, fieldId, dataSources, expressionFields)
    ) {
      return relatedSourceId;
    }
  }

  // Check many-to-many two-hop (field on the remote endpoint source or the junction source itself)
  for (const relationship of relationships) {
    if (relationship.type !== 'many-to-many') {
      continue;
    }
    if (!relationship.junctionSourceId) {
      continue;
    }

    // Check junction source itself
    if (hasRowLevelField(relationship.junctionSourceId, fieldId, dataSources, expressionFields)) {
      if (relationship.sourceId === widgetSourceId || relationship.targetId === widgetSourceId) {
        return relationship.junctionSourceId;
      }
    }

    // Check remote endpoint
    let remoteSourceId: string | null = null;
    if (relationship.sourceId === widgetSourceId) {
      remoteSourceId = relationship.targetId;
    } else if (relationship.targetId === widgetSourceId) {
      remoteSourceId = relationship.sourceId;
    }

    if (
      remoteSourceId &&
      hasRowLevelField(remoteSourceId, fieldId, dataSources, expressionFields)
    ) {
      return remoteSourceId;
    }
  }

  return null;
}

export type ChartSupportReason =
  | 'field_not_found_or_not_direct'
  | 'mixed_cross_source_fields'
  | 'scatter_cross_source_not_supported';

export interface ChartSupportResult {
  supported: boolean;
  reason?: ChartSupportReason;
  /** Precomputed field → owning sourceId mapping (only present when supported=true). */
  fieldOwners?: Map<string, string>;
  /** Precomputed anchor source for aggregation (only present when supported=true). */
  anchorSourceId?: string;
}

export function getChartSupportMessage(reason: ChartSupportReason): string {
  switch (reason) {
    case 'field_not_found_or_not_direct':
      return 'This chart configuration uses fields that are not available on the widget source or a directly related source.';
    case 'mixed_cross_source_fields':
      return 'This chart configuration mixes cross-source fields in a way that does not have a single safe aggregation grain yet.';
    case 'scatter_cross_source_not_supported':
      return 'Scatter charts do not support cross-source field combinations yet.';
    default:
      return 'This chart configuration is not supported yet.';
  }
}

export function analyzeChartSupport(
  widgetSourceId: string | undefined,
  xField: string | undefined,
  yFields: string[],
  seriesField: string | undefined,
  chartType: string | undefined,
  dataSources: Record<string, StudioDataSource>,
  relationships: StudioRelationship[],
  expressionFields: StudioExpressionField[] = [],
  scatterColorField?: string,
  scatterSizeField?: string,
): ChartSupportResult {
  const requestedFields = [
    xField,
    ...yFields,
    seriesField,
    scatterColorField,
    scatterSizeField,
  ].filter((field): field is string => Boolean(field));

  if (!widgetSourceId || requestedFields.length === 0) {
    return { supported: true };
  }

  const fieldOwners = new Map<string, string>();
  for (const fieldId of requestedFields) {
    const owner = findDirectFieldOwner(
      widgetSourceId,
      fieldId,
      dataSources,
      relationships,
      expressionFields,
    );
    if (!owner) {
      return { supported: false, reason: 'field_not_found_or_not_direct' };
    }
    fieldOwners.set(fieldId, owner);
  }

  if (
    chartType === 'scatter' &&
    Array.from(fieldOwners.values()).some((owner) => owner !== widgetSourceId)
  ) {
    return { supported: false, reason: 'scatter_cross_source_not_supported' };
  }

  const ySourceIds = [
    ...new Set(
      yFields
        .map((fieldId) => fieldOwners.get(fieldId))
        .filter((sourceId): sourceId is string => Boolean(sourceId)),
    ),
  ];

  let anchorSourceId = widgetSourceId;
  if (ySourceIds.length === 1 && ySourceIds[0] !== widgetSourceId) {
    const ySourceId = ySourceIds[0];
    const anchorRelationship = findDirectRelationship(widgetSourceId, ySourceId, relationships);
    if (anchorRelationship) {
      if (
        anchorRelationship.type !== 'many-to-many' &&
        anchorRelationship.sourceId === ySourceId &&
        anchorRelationship.targetId === widgetSourceId
      ) {
        // many-to-one: widget is the "one" side → anchor on the "many" (ySource)
        anchorSourceId = ySourceId;
      } else if (
        anchorRelationship.type === 'many-to-many' &&
        anchorRelationship.junctionSourceId
      ) {
        // many-to-many: anchor on the junction table — one row per (widget, target) pair
        anchorSourceId = anchorRelationship.junctionSourceId;
      }
    } else {
      // No direct relationship — check if ySourceId IS the junction source of a M:N rel
      const viaJunctionRel = relationships.find(
        (rel) =>
          rel.type === 'many-to-many' &&
          rel.junctionSourceId === ySourceId &&
          (rel.sourceId === widgetSourceId || rel.targetId === widgetSourceId),
      );
      if (viaJunctionRel) {
        // y-field lives directly in the junction table; anchor on the junction itself
        anchorSourceId = ySourceId;
      }
    }
  }

  if (
    anchorSourceId === widgetSourceId &&
    ySourceIds.filter((sourceId) => sourceId !== widgetSourceId).length > 1
  ) {
    return { supported: false, reason: 'mixed_cross_source_fields' };
  }

  const yFieldSet = new Set(yFields);
  for (const [fieldId, owner] of fieldOwners.entries()) {
    if (yFieldSet.has(fieldId)) {
      if (owner !== anchorSourceId) {
        return { supported: false, reason: 'mixed_cross_source_fields' };
      }
      continue;
    }

    if (owner === anchorSourceId) {
      continue;
    }

    if (!isSafeWidgetBridgeOwner(widgetSourceId, owner, relationships)) {
      return { supported: false, reason: 'mixed_cross_source_fields' };
    }
  }

  return { supported: true, fieldOwners, anchorSourceId };
}

// ─── resolveChartRowsForAggregation cache ──────────────────────────────────────
//
// Two-level WeakMap: widgetRows × anchorRows → configKey → Row[]
//
// Why two levels are needed (context):
//   The old single-level cachedCompute(widgetRows, configKey) relied on
//   resolvedRowsCache always producing a NEW widgetRows ref whenever ANY
//   dataSources changed (via module-wide sentinels).  After we fixed
//   resolvedRowsCache to be per-source, unrelated source changes no longer
//   affect widgetRows — which is correct for the filter layer but breaks the
//   assumption here for cross-source charts.
//
// Example failure with single-level cache:
//   - Chart on order_items, Y = orders.amount  (orders is the grain-anchor)
//   - orders.rows is refreshed → order_items.filteredRows unchanged
//   - cachedCompute(filteredRows, configKey) → hit → stale orders data shown 🐛
//
// Fix: add anchorRows as a second WeakMap level.
//   - widgetRows changes   → outer miss → recompute ✓
//   - anchorRows changes   → inner miss → recompute ✓
//   - same config, same data → both hit  → O(1) ✓
//   - unrelated source changes → neither key changes → still hits ✓
//
// Row references alone are not enough: editing a relationship's join fields or an
// anchor/widget-source expression formula changes the joined/re-anchored result
// while every row array ref stays the same. The entry therefore also tracks the
// `relationships` array ref and the object refs of the expression fields relevant
// to this call (those owned by the widget/anchor/field-owner sources), and is
// invalidated when either changes.
interface RcfaEntry {
  relationships: StudioRelationship[];
  exprFields: StudioExpressionField[];
  result: Row[];
}
const rcfaCache = new WeakMap<Row[], WeakMap<Row[], Map<string, RcfaEntry>>>();

/** Non-measure expression fields owned by any of `sourceIds`, in declaration order. */
function collectRelevantExprFields(
  expressionFields: StudioExpressionField[],
  sourceIds: ReadonlySet<string>,
): StudioExpressionField[] {
  return expressionFields.filter((ef) => !ef.isMeasure && sourceIds.has(ef.sourceId));
}

/** Reference-equality comparison of two expression-field lists (same objects, order, length). */
function exprFieldsRefEqual(a: StudioExpressionField[], b: StudioExpressionField[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

export function resolveChartRowsForAggregation(
  widgetRows: Row[],
  widgetSourceId: string | undefined,
  xField: string | undefined,
  yFields: string[],
  seriesField: string | undefined,
  dataSources: Record<string, StudioDataSource>,
  relationships: StudioRelationship[],
  expressionFields: StudioExpressionField[] = [],
): Row[] {
  const requestedFields = [xField, ...yFields, seriesField].filter((field): field is string =>
    Boolean(field),
  );

  if (!widgetSourceId || widgetRows.length === 0 || requestedFields.length === 0) {
    return widgetRows;
  }

  // Determine anchor source first (cheap — O(fields × relationships)).
  // This must happen before the cache lookup so we know the second WeakMap key.
  const support = analyzeChartSupport(
    widgetSourceId,
    xField,
    yFields,
    seriesField,
    undefined,
    dataSources,
    relationships,
    expressionFields,
  );

  if (!support.supported) {
    return [];
  }

  const anchorSourceId = support.anchorSourceId ?? widgetSourceId;
  // For cross-source grain anchor: outer key = widgetRows, inner key = anchorRows.
  // For same-source: inner key = widgetRows itself (collapses to single-level semantics).
  const anchorRows =
    anchorSourceId !== widgetSourceId
      ? (dataSources[anchorSourceId]?.rows ?? widgetRows)
      : widgetRows;

  // Two-level WeakMap lookup
  let byAnchor = rcfaCache.get(widgetRows);
  if (!byAnchor) {
    byAnchor = new WeakMap();
    rcfaCache.set(widgetRows, byAnchor);
  }
  let byKey = byAnchor.get(anchorRows);
  if (!byKey) {
    byKey = new Map();
    byAnchor.set(anchorRows, byKey);
  }

  // Reuse fieldOwners precomputed by analyzeChartSupport — no need to traverse
  // the relationship graph again (O(fields × relationships) saved per call).
  const fieldOwners = support.fieldOwners ?? new Map<string, string>();

  // Expression fields whose formula changes must invalidate this joined result:
  // those owned by the widget source, the anchor source, or any field owner.
  const relevantExprSourceIds = new Set<string>([widgetSourceId, anchorSourceId]);
  for (const owner of fieldOwners.values()) {
    relevantExprSourceIds.add(owner);
  }
  const relevantExprFields = collectRelevantExprFields(expressionFields, relevantExprSourceIds);

  const configKey = `rcfa:${widgetSourceId}|${xField ?? ''}|${yFields.join(',')}|${seriesField ?? ''}`;
  const cached = byKey.get(configKey);
  if (
    cached &&
    cached.relationships === relationships &&
    exprFieldsRefEqual(cached.exprFields, relevantExprFields)
  ) {
    return cached.result;
  }

  // Re-anchor the row set to the fan-out anchor's grain (shared L4 core, see
  // internals/grainResolution.ts) so a plain per-row aggregation cannot
  // double-count from a fan-out join.
  const result = resolveRowsAtGrain(
    widgetRows,
    widgetSourceId,
    anchorSourceId,
    requestedFields,
    fieldOwners,
    dataSources,
    relationships,
    expressionFields,
  );

  byKey.set(configKey, { relationships, exprFields: relevantExprFields, result });
  return result;
}
