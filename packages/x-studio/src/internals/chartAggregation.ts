import type {
  StudioDataSource,
  StudioExpressionField,
  StudioFilterState,
  StudioRelationship,
} from '../models';
import { getCachedEnrichedRows } from './enrichedRowsCache';
import { enrichRowsWithRelatedFields } from './dataSourceGraph';
import { truncateToGranularity, sortLabels, type XGroupBy } from './temporalUtils';

type Row = Record<string, unknown>;

export interface AggregatedData {
  labels: (string | number)[];
  values: number[];
}

/**
 * Apply a rank filter to already-aggregated chart data.
 * Ranks by the aggregated value (the bar/slice height) and keeps top/bottom N.
 */
export function applyRankToAggregated(
  data: AggregatedData,
  rankFilter: StudioFilterState | null,
): AggregatedData {
  if (!rankFilter) {
    return data;
  }
  const n = Math.round(Number(rankFilter.value));
  if (!Number.isFinite(n) || n <= 0) {
    return data;
  }
  const dir = rankFilter.rankDirection ?? 'top';
  const pairs = data.labels.map((label, i) => ({ label, value: data.values[i] }));
  pairs.sort((a, b) => (dir === 'top' ? b.value - a.value : a.value - b.value));
  const sliced = pairs.slice(0, n);
  return {
    labels: sliced.map((p) => p.label),
    values: sliced.map((p) => p.value),
  };
}

/**
 * Apply a rank filter to multi-series aggregated data.
 * Ranking score per label is computed according to `rankFilter.rankMultiSeriesBy`:
 * - `undefined` / `'__sum'`: sum of all series values (default)
 * - `'__avg'`: average across all series
 * - `'__max'`: maximum value across all series
 * - `'__min'`: minimum value across all series
 * - `<fieldId>`: use only the series with that fieldId
 */
export function applyRankToMultiSeries(
  data: MultiYSeriesData,
  rankFilter: StudioFilterState | null,
): MultiYSeriesData {
  if (!rankFilter) {
    return data;
  }
  const n = Math.round(Number(rankFilter.value));
  if (!Number.isFinite(n) || n <= 0) {
    return data;
  }
  const dir = rankFilter.rankDirection ?? 'top';
  const rankBy = rankFilter.rankMultiSeriesBy ?? '__sum';

  const scores = data.labels.map((_, i) => {
    if (rankBy === '__sum') {
      return data.series.reduce((acc, s) => acc + (s.values[i] ?? 0), 0);
    }
    if (rankBy === '__avg') {
      const count = data.series.length;
      if (count === 0) {
        return 0;
      }
      return data.series.reduce((acc, s) => acc + (s.values[i] ?? 0), 0) / count;
    }
    if (rankBy === '__max') {
      return Math.max(...data.series.map((s) => s.values[i] ?? -Infinity));
    }
    if (rankBy === '__min') {
      return Math.min(...data.series.map((s) => s.values[i] ?? Infinity));
    }
    // rank by a specific series fieldId
    const series = data.series.find((s) => s.fieldId === rankBy);
    return series ? (series.values[i] ?? 0) : 0;
  });

  const indices = data.labels.map((_, i) => i);
  indices.sort((a, b) => (dir === 'top' ? scores[b] - scores[a] : scores[a] - scores[b]));
  const keepIndices = new Set(indices.slice(0, n));
  const keepMask = data.labels.map((_, i) => keepIndices.has(i));
  return {
    labels: data.labels.filter((_, i) => keepMask[i]),
    series: data.series.map((s) => ({
      ...s,
      values: s.values.filter((_, i) => keepMask[i]),
    })),
  };
}

/**
 * Apply a rank filter to seriesField aggregated data (MultiSeriesData).
 * Ranks the series dimension (e.g. countries) by their total value across all x-labels,
 * and keeps the top/bottom N series.
 */
export function applyRankToSeriesFieldData(
  data: MultiSeriesData,
  rankFilter: StudioFilterState | null,
): MultiSeriesData {
  if (!rankFilter) {
    return data;
  }
  const n = Math.round(Number(rankFilter.value));
  if (!Number.isFinite(n) || n <= 0) {
    return data;
  }
  const dir = rankFilter.rankDirection ?? 'top';
  const scored = data.seriesNames.map((name) => ({
    name,
    score: (data.seriesData[name] ?? []).reduce<number>((acc, v) => acc + (v ?? 0), 0),
  }));
  scored.sort((a, b) => (dir === 'top' ? b.score - a.score : a.score - b.score));
  const keepNames = new Set(scored.slice(0, n).map((s) => s.name));
  return {
    labels: data.labels,
    seriesNames: data.seriesNames.filter((name) => keepNames.has(name)),
    seriesData: Object.fromEntries(
      Object.entries(data.seriesData).filter(([name]) => keepNames.has(name as string | number)),
    ),
  };
}

/**
 * Apply xGroupBy truncation to an x-axis value.
 * Returns the original value when xGroupBy is not set or the value is not date-like.
 */
function applyXGroupBy(value: string | number, xGroupBy: XGroupBy | undefined): string | number {
  if (!xGroupBy) {
    return value;
  }
  return truncateToGranularity(value, xGroupBy) ?? value;
}

/** Safely extracts a row field value as a string or number suitable for chart grouping. */
function toXValue(raw: unknown): string | number {
  if (raw instanceof Date) {
    return raw.toISOString();
  }
  if (typeof raw === 'boolean') {
    return String(raw);
  }
  if (raw === null || raw === undefined) {
    return '(empty)';
  }
  if (typeof raw === 'object') {
    return String(raw);
  }
  return raw as string | number;
}

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

function findDirectRelationship(
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

function enrichSourceRowsWithExpressions(
  rows: Row[],
  sourceId: string,
  dataSources: Record<string, StudioDataSource>,
  relationships: StudioRelationship[],
  expressionFields: StudioExpressionField[],
  usedFieldIds?: ReadonlySet<string>,
): Row[] {
  return getCachedEnrichedRows(
    rows,
    sourceId,
    expressionFields,
    dataSources,
    relationships,
    usedFieldIds,
  );
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
const rcfaCache = new WeakMap<Row[], WeakMap<Row[], Map<string, Row[]>>>();

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

  const configKey = `rcfa:${widgetSourceId}|${xField ?? ''}|${yFields.join(',')}|${seriesField ?? ''}`;
  if (byKey.has(configKey)) {
    return byKey.get(configKey)!;
  }

  // Reuse fieldOwners precomputed by analyzeChartSupport — no need to traverse
  // the relationship graph again (O(fields × relationships) saved per call).
  const fieldOwners = support.fieldOwners ?? new Map<string, string>();

  // Determine which requested fields are expression fields on the widget source.
  const exprFieldIdsOnSource = new Set(
    expressionFields.flatMap((ef) =>
      ef.sourceId === anchorSourceId && !ef.isMeasure ? [ef.id] : [],
    ),
  );
  const needsExpressionEnrichment = requestedFields.some((f) => exprFieldIdsOnSource.has(f));

  let result: Row[];

  if (anchorSourceId === widgetSourceId) {
    const related = enrichRowsWithRelatedFields(
      widgetRows,
      widgetSourceId,
      requestedFields,
      dataSources,
      relationships,
    );
    result = needsExpressionEnrichment
      ? enrichSourceRowsWithExpressions(
          related,
          widgetSourceId,
          dataSources,
          relationships,
          expressionFields,
          new Set(requestedFields),
        )
      : related;
  } else {
    const anchorRelationship = findDirectRelationship(
      widgetSourceId,
      anchorSourceId,
      relationships,
    );

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

      // Build lookup maps for widget and remote source
      const allowedWidgetKeys = new Set(widgetRows.map((row) => row[widgetJoinField]));
      const widgetRowLookup = new Map<unknown, Row>();
      for (const row of widgetRows) {
        widgetRowLookup.set(row[widgetJoinField], row);
      }
      const remoteRowLookup = new Map<unknown, Row>();
      for (const row of dataSources[remoteSourceId]?.rows ?? []) {
        remoteRowLookup.set(row[remoteJoinField], row);
      }

      const junctionRows = dataSources[anchorSourceId]?.rows ?? [];
      result = junctionRows.flatMap((jRow) => {
        if (!allowedWidgetKeys.has(jRow[junctionWidgetField])) {
          return [];
        }
        const widgetRow = widgetRowLookup.get(jRow[junctionWidgetField]) ?? {};
        const remoteRow = remoteRowLookup.get(jRow[junctionTargetField]) ?? {};
        return [{ ...widgetRow, ...remoteRow, ...jRow }];
      });
    } else if (
      !anchorRelationship ||
      anchorRelationship.type === 'many-to-many' ||
      anchorRelationship.sourceId !== anchorSourceId ||
      anchorRelationship.targetId !== widgetSourceId
    ) {
      result = enrichRowsWithRelatedFields(
        widgetRows,
        widgetSourceId,
        requestedFields,
        dataSources,
        relationships,
      );
    } else {
      const widgetJoinField = anchorRelationship.targetField;
      const anchorJoinField = anchorRelationship.sourceField;
      const allowedWidgetKeys = new Set(widgetRows.map((row) => row[widgetJoinField]));
      const enrichedAnchorRows = enrichSourceRowsWithExpressions(
        dataSources[anchorSourceId]?.rows ?? [],
        anchorSourceId,
        dataSources,
        relationships,
        expressionFields,
        new Set(requestedFields),
      ).filter((row) => allowedWidgetKeys.has(row[anchorJoinField]));

      const widgetRowsForLookup = enrichRowsWithRelatedFields(
        widgetRows,
        widgetSourceId,
        requestedFields.filter((fieldId) => fieldOwners.get(fieldId) !== anchorSourceId),
        dataSources,
        relationships,
      );

      const widgetRowLookup = new Map<unknown, Row>();
      for (const row of widgetRowsForLookup) {
        widgetRowLookup.set(row[widgetJoinField], row);
      }

      result = enrichedAnchorRows.map((anchorRow) => {
        const widgetRow = widgetRowLookup.get(anchorRow[anchorJoinField]);
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
  }

  byKey.set(configKey, result);
  return result;
}

/**
 * Sort `labels` in-place according to `categoryOrder`.
 *
 * Labels present in `categoryOrder` appear first, in the defined sequence.
 * Labels absent from `categoryOrder` are appended at the end, sorted
 * alphabetically among themselves.
 * When `sortDirection` is `'desc'` the whole resulting list is reversed.
 */
function applyCategoryOrder(
  labels: (string | number)[],
  categoryOrder: string[],
  sortDirection?: 'asc' | 'desc',
): void {
  const orderMap = new Map(categoryOrder.map((v, i) => [v, i]));
  labels.sort((a, b) => {
    const ai = orderMap.get(String(a)) ?? Infinity;
    const bi = orderMap.get(String(b)) ?? Infinity;
    if (ai !== bi) {
      return ai - bi;
    }
    // Both absent from orderMap — sort alphabetically
    return String(a).localeCompare(String(b));
  });
  if (sortDirection === 'desc') {
    labels.reverse();
  }
}

export function aggregateByField(
  rows: Row[],
  xField: string,
  yField: string,
  xGroupBy?: XGroupBy,
  yAggregation: 'sum' | 'count' | 'avg' | 'min' | 'max' = 'sum',
  sortBy?: 'category' | 'value',
  sortDirection?: 'asc' | 'desc',
  categoryOrder?: string[],
): AggregatedData {
  const grouped = new Map<string | number, number>();
  const counts = new Map<string | number, number>();

  // Pre-detect: if the yField is non-numeric (e.g. a string ID), fall back to
  // count so callers that omit yAggregation don't get NaN in the chart.
  let effectiveAggregation = yAggregation;
  if (effectiveAggregation !== 'count') {
    for (const row of rows) {
      const v = row[yField];
      if (v !== null && v !== undefined) {
        if (Number.isNaN(Number(v))) {
          effectiveAggregation = 'count';
        }
        break;
      }
    }
  }

  for (const row of rows) {
    const raw = toXValue(row[xField]);
    const xVal = applyXGroupBy(raw, xGroupBy);
    const count = (counts.get(xVal) ?? 0) + 1;
    counts.set(xVal, count);

    if (effectiveAggregation === 'count') {
      grouped.set(xVal, count);
    } else {
      const yVal = Number(row[yField] ?? 0);
      const prev = grouped.get(xVal) ?? 0;
      if (effectiveAggregation === 'sum') {
        grouped.set(xVal, prev + yVal);
      } else if (effectiveAggregation === 'avg') {
        // Store running sum; divide by count at the end
        grouped.set(xVal, prev + yVal);
      } else if (effectiveAggregation === 'min') {
        grouped.set(xVal, count === 1 ? yVal : Math.min(prev, yVal));
      } else if (effectiveAggregation === 'max') {
        grouped.set(xVal, count === 1 ? yVal : Math.max(prev, yVal));
      }
    }
  }

  if (effectiveAggregation === 'avg') {
    for (const [key, sum] of grouped) {
      grouped.set(key, sum / (counts.get(key) ?? 1));
    }
  }

  const labels = sortLabels(Array.from(grouped.keys()));
  let values = labels.map((label) => grouped.get(label) ?? 0);

  if (sortBy === 'value') {
    const dir = sortDirection === 'asc' ? 1 : -1;
    const pairs = labels.map((label, i) => ({ label, value: values[i] }));
    pairs.sort((a, b) => (a.value - b.value) * dir);
    return {
      labels: pairs.map((p) => p.label),
      values: pairs.map((p) => p.value),
    };
  }
  if (categoryOrder && categoryOrder.length > 0) {
    applyCategoryOrder(labels, categoryOrder, sortDirection);
    values = labels.map((label) => grouped.get(label) ?? 0);
    return { labels, values };
  }
  if (sortDirection === 'desc') {
    labels.reverse();
    values = labels.map((label) => grouped.get(label) ?? 0);
  }

  return { labels, values };
}

/**
 * Multi-series aggregated data for grouped/stacked charts
 */
export interface MultiSeriesData {
  labels: (string | number)[];
  seriesNames: (string | number)[];
  seriesData: Record<string | number, (number | null)[]>;
}

/**
 * Aggregate data by two fields: one for x-axis labels, one for series grouping
 */
export function aggregateByTwoFields(
  rows: Row[],
  xField: string,
  seriesField: string,
  yField: string,
  xGroupBy?: XGroupBy,
  sortBy?: 'category' | 'value',
  sortDirection?: 'asc' | 'desc',
  categoryOrder?: string[],
): MultiSeriesData {
  // First pass: collect all unique x values and series values
  const xValuesSet = new Set<string | number>();
  const seriesValuesSet = new Set<string | number>();

  // Map: xValue -> seriesValue -> sum
  const dataMap = new Map<string | number, Map<string | number, number>>();

  for (const row of rows) {
    const raw = toXValue(row[xField]);
    const xVal = applyXGroupBy(raw, xGroupBy);
    const seriesVal = toXValue(row[seriesField]);
    const yVal = Number(row[yField] ?? 0);

    xValuesSet.add(xVal);
    seriesValuesSet.add(seriesVal);

    if (!dataMap.has(xVal)) {
      dataMap.set(xVal, new Map());
    }
    const seriesMap = dataMap.get(xVal)!;
    seriesMap.set(seriesVal, (seriesMap.get(seriesVal) ?? 0) + yVal);
  }

  let labels = sortLabels(Array.from(xValuesSet));
  const seriesNames = sortLabels(Array.from(seriesValuesSet));

  // Build series data arrays — use null (not 0) for missing points so that
  // line/area charts render visible gaps instead of collapsing to zero.
  const seriesData: Record<string | number, (number | null)[]> = {};
  for (const seriesName of seriesNames) {
    seriesData[seriesName] = labels.map((label) => {
      const seriesMap = dataMap.get(label);
      const val = seriesMap?.get(seriesName);
      return val !== undefined ? val : null;
    });
  }

  // Apply sort — for multi-series, 'value' sorts by the total across all series
  if (sortBy === 'value') {
    const dir = sortDirection === 'asc' ? 1 : -1;
    const totals = labels.map((label, labelIdx) => {
      let sum = 0;
      for (const seriesName of seriesNames) {
        sum += seriesData[seriesName][labelIdx] ?? 0;
      }
      return { label, sum };
    });
    totals.sort((a, b) => (a.sum - b.sum) * dir);
    labels = totals.map((t) => t.label);
    for (const seriesName of seriesNames) {
      seriesData[seriesName] = labels.map((label) => {
        const seriesMap = dataMap.get(label);
        const val = seriesMap?.get(seriesName);
        return val !== undefined ? val : null;
      });
    }
  } else if (categoryOrder && categoryOrder.length > 0) {
    applyCategoryOrder(labels, categoryOrder, sortDirection);
    for (const seriesName of seriesNames) {
      seriesData[seriesName] = labels.map((label) => {
        const seriesMap = dataMap.get(label);
        const val = seriesMap?.get(seriesName);
        return val !== undefined ? val : null;
      });
    }
  } else if (sortDirection === 'desc') {
    labels = [...labels].reverse();
    for (const seriesName of seriesNames) {
      seriesData[seriesName] = labels.map((label) => {
        const seriesMap = dataMap.get(label);
        const val = seriesMap?.get(seriesName);
        return val !== undefined ? val : null;
      });
    }
  }

  return { labels, seriesNames, seriesData };
}

/**
 * Aggregate multiple Y fields against the same X axis (for multi-series charts)
 */
export interface MultiYSeriesData {
  labels: (string | number)[];
  series: Array<{ fieldId: string; values: number[] }>;
}

export function aggregateMultipleSeries(
  rows: Row[],
  xField: string,
  yFields: string[],
  xGroupBy?: XGroupBy,
  sortBy?: 'category' | 'value',
  sortDirection?: 'asc' | 'desc',
  categoryOrder?: string[],
): MultiYSeriesData {
  // Pre-detect non-numeric fields so callers that omit yAggregation don't get NaN.
  const useCount = new Set<string>();
  for (const fieldId of yFields) {
    for (const row of rows) {
      const v = row[fieldId];
      if (v !== null && v !== undefined) {
        if (Number.isNaN(Number(v))) {
          useCount.add(fieldId);
        }
        break;
      }
    }
  }

  const labelOrder: (string | number)[] = [];
  const labelSet = new Set<string | number>();
  // Map: label → fieldId → sum (or count when useCount)
  const dataMap = new Map<string | number, Map<string, number>>();

  for (const row of rows) {
    const raw = toXValue(row[xField]);
    const xVal = applyXGroupBy(raw, xGroupBy);
    if (!labelSet.has(xVal)) {
      labelSet.add(xVal);
      labelOrder.push(xVal);
      dataMap.set(xVal, new Map());
    }
    const fieldMap = dataMap.get(xVal)!;
    for (const fieldId of yFields) {
      if (useCount.has(fieldId)) {
        fieldMap.set(fieldId, (fieldMap.get(fieldId) ?? 0) + 1);
      } else {
        const yVal = Number(row[fieldId] ?? 0);
        fieldMap.set(fieldId, (fieldMap.get(fieldId) ?? 0) + yVal);
      }
    }
  }

  let sortedLabels = sortLabels(labelOrder);

  if (sortBy === 'value') {
    const dir = sortDirection === 'asc' ? 1 : -1;
    sortedLabels = sortedLabels
      .map((label) => ({
        label,
        total: yFields.reduce((sum, fId) => sum + (dataMap.get(label)?.get(fId) ?? 0), 0),
      }))
      .sort((a, b) => (a.total - b.total) * dir)
      .map((p) => p.label);
  } else if (categoryOrder && categoryOrder.length > 0) {
    applyCategoryOrder(sortedLabels, categoryOrder, sortDirection);
  } else if (sortDirection === 'desc') {
    sortedLabels = [...sortedLabels].reverse();
  }

  const series = yFields.map((fieldId) => ({
    fieldId,
    values: sortedLabels.map((label) => dataMap.get(label)?.get(fieldId) ?? 0),
  }));

  return { labels: sortedLabels, series };
}

export interface ScatterDataPoint {
  x: number;
  y: number;
  id: number;
  size?: number;
}

/**
 * Prepare data for scatter charts
 */
export function prepareScatterData(
  rows: Row[],
  xField: string,
  yField: string,
  sizeField?: string,
): ScatterDataPoint[] {
  return rows.map((row, index) => ({
    x: Number(row[xField] ?? 0),
    y: Number(row[yField] ?? 0),
    id: index,
    size: sizeField != null ? Number(row[sizeField] ?? 0) : undefined,
  }));
}

export interface ScatterSeriesData {
  id: string;
  label: string;
  data: ScatterDataPoint[];
}

/**
 * Prepare data for scatter charts with a color-by categorical field.
 * Returns one series per unique category value for color-coded rendering.
 * Uses `stableCategories` (from all/unfiltered rows) to ensure consistent
 * color assignment even when some categories disappear after filtering.
 */
export function prepareScatterDataGrouped(
  rows: Row[],
  xField: string,
  yField: string,
  colorField: string,
  stableCategories: string[],
  sizeField?: string,
): ScatterSeriesData[] {
  // Build a map from category → points for the current (filtered) rows
  const grouped = new Map<string, ScatterDataPoint[]>(stableCategories.map((cat) => [cat, []]));
  rows.forEach((row, index) => {
    const raw = row[colorField];
    const cat = raw == null || raw === '' ? '(blank)' : String(raw);
    if (!grouped.has(cat)) {
      grouped.set(cat, []);
    }
    grouped.get(cat)!.push({
      x: Number(row[xField] ?? 0),
      y: Number(row[yField] ?? 0),
      id: index,
      size: sizeField != null ? Number(row[sizeField] ?? 0) : undefined,
    });
  });
  // Only include categories that have data (skip empty series)
  return stableCategories.flatMap((cat) => {
    const data = grouped.get(cat) ?? [];
    return data.length > 0 ? [{ id: cat, label: cat, data }] : [];
  });
}

// ─── Heatmap aggregation ──────────────────────────────────────────────────────

export interface HeatmapData {
  /** Unique values for the column (X) axis, ordered. */
  xLabels: string[];
  /** Unique values for the row (Y) axis, ordered. */
  yLabels: string[];
  /** Aggregated value for each (xLabel, yLabel) cell. Missing cells default to 0. */
  cells: Map<string, number>;
  minValue: number;
  maxValue: number;
}

/**
 * Aggregates rows into a heatmap grid.
 *
 * @param rows - The rows to aggregate.
 * @param xField - Column (X) axis field (categorical or date).
 * @param yField - Row (Y) axis field (categorical).
 * @param valueField - Numeric field to aggregate per cell.
 * @param xGroupBy - Optional date granularity to truncate the X axis values.
 * @param yAggregation - Aggregation function to apply per cell (default: 'sum').
 */
export function aggregateHeatmap(
  rows: Row[],
  xField: string,
  yField: string,
  valueField: string,
  xGroupBy?: XGroupBy,
  yAggregation: 'sum' | 'count' | 'avg' | 'min' | 'max' = 'sum',
): HeatmapData {
  const xSet = new Set<string>();
  const ySet = new Set<string>();
  const cellSum = new Map<string, number>();
  const cellCount = new Map<string, number>();

  for (const row of rows) {
    const raw = toXValue(row[xField]);
    const xVal = String(applyXGroupBy(raw, xGroupBy));
    const yVal = String(row[yField] ?? '');
    if (!xVal || !yVal) {
      continue;
    }
    const numVal = Number(row[valueField]);
    // Skip rows where the value field is null/undefined/NaN (e.g. in-transit
    // shipments with no actual delivery date produce a null datediff)
    if (Number.isNaN(numVal) || row[valueField] == null) {
      continue;
    }
    xSet.add(xVal);
    ySet.add(yVal);
    const key = `${xVal}\x00${yVal}`;
    const prev = cellSum.get(key) ?? 0;
    const count = (cellCount.get(key) ?? 0) + 1;
    cellCount.set(key, count);

    if (yAggregation === 'count') {
      cellSum.set(key, count);
    } else if (yAggregation === 'sum' || yAggregation === 'avg') {
      cellSum.set(key, prev + numVal);
    } else if (yAggregation === 'min') {
      cellSum.set(key, count === 1 ? numVal : Math.min(prev, numVal));
    } else if (yAggregation === 'max') {
      cellSum.set(key, count === 1 ? numVal : Math.max(prev, numVal));
    }
  }

  // Finalise averages
  const cellMap = new Map<string, number>();
  for (const [key, sum] of cellSum) {
    if (yAggregation === 'avg') {
      cellMap.set(key, sum / (cellCount.get(key) ?? 1));
    } else {
      cellMap.set(key, sum);
    }
  }

  const xLabels = sortLabels([...xSet]) as string[];
  const yLabels = [...ySet];

  let minValue = Infinity;
  let maxValue = -Infinity;
  for (const v of cellMap.values()) {
    if (v < minValue) {
      minValue = v;
    }
    if (v > maxValue) {
      maxValue = v;
    }
  }
  if (minValue === Infinity) {
    minValue = 0;
    maxValue = 0;
  }

  return { xLabels, yLabels, cells: cellMap, minValue, maxValue };
}
