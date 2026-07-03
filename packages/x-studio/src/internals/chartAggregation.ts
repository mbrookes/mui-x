import type {
  StudioDataSource,
  StudioExpressionField,
  StudioFilterState,
  StudioRelationship,
} from '../models';
import { findDirectRelationship } from './dataSourceGraph';
import { resolveRowsAtGrain } from './grainResolution';
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

function isEmptyXValue(raw: unknown): boolean {
  return raw === null || raw === undefined || raw === '' || raw === '(empty)';
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

/** Per-cell streaming accumulator shared by the multi-series aggregators. */
interface CellAcc {
  sum: number;
  count: number;
  min: number;
  max: number;
}

/** Fold `value` into the accumulator stored at `key`, creating it on first sight. */
function accumulateCell<K>(map: Map<K, CellAcc>, key: K, value: number): void {
  const acc = map.get(key);
  if (!acc) {
    map.set(key, { sum: value, count: 1, min: value, max: value });
    return;
  }
  acc.sum += value;
  acc.count += 1;
  if (value < acc.min) {
    acc.min = value;
  }
  if (value > acc.max) {
    acc.max = value;
  }
}

/**
 * Reduce a per-cell accumulator to a single value according to `aggregation`.
 * Returns `null` for an empty cell so callers can distinguish "no data" from 0.
 */
function finalizeCell(
  acc: CellAcc | undefined,
  aggregation: 'sum' | 'count' | 'avg' | 'min' | 'max',
): number | null {
  if (!acc || acc.count === 0) {
    return null;
  }
  switch (aggregation) {
    case 'count':
      return acc.count;
    case 'avg':
      return acc.sum / acc.count;
    case 'min':
      return acc.min;
    case 'max':
      return acc.max;
    case 'sum':
    default:
      return acc.sum;
  }
}

export function aggregateByField(
  rows: Row[],
  xField: string,
  yField: string,
  xGroupBy?: XGroupBy,
  yAggregation: 'sum' | 'count' | 'avg' | 'min' | 'max' = 'sum',
  sortBy?: 'category' | 'value' | 'natural',
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
    if (isEmptyXValue(row[xField])) {
      continue;
    }
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
  sortBy?: 'category' | 'value' | 'natural',
  sortDirection?: 'asc' | 'desc',
  categoryOrder?: string[],
  yAggregation: 'sum' | 'count' | 'avg' | 'min' | 'max' = 'sum',
): MultiSeriesData {
  // First pass: collect all unique x values and series values
  const xValuesSet = new Set<string | number>();
  const seriesValuesSet = new Set<string | number>();

  // Map: xValue -> seriesValue -> per-cell accumulator (sum/count/min/max).
  const dataMap = new Map<string | number, Map<string | number, CellAcc>>();

  for (const row of rows) {
    if (isEmptyXValue(row[xField])) {
      continue;
    }
    const raw = toXValue(row[xField]);
    const xVal = applyXGroupBy(raw, xGroupBy);
    const seriesVal = toXValue(row[seriesField]);
    const yVal = Number(row[yField] ?? 0);

    xValuesSet.add(xVal);
    seriesValuesSet.add(seriesVal);

    let seriesMap = dataMap.get(xVal);
    if (!seriesMap) {
      seriesMap = new Map();
      dataMap.set(xVal, seriesMap);
    }
    accumulateCell(seriesMap, seriesVal, yVal);
  }

  let labels = sortLabels(Array.from(xValuesSet));
  const seriesNames = sortLabels(Array.from(seriesValuesSet));

  // Resolve a single cell to its aggregated value; `null` when the cell has no
  // data so line/area charts render visible gaps instead of collapsing to zero.
  const cellValue = (label: string | number, seriesName: string | number): number | null =>
    finalizeCell(dataMap.get(label)?.get(seriesName), yAggregation);

  const buildSeriesData = (): Record<string | number, (number | null)[]> => {
    const data: Record<string | number, (number | null)[]> = {};
    for (const seriesName of seriesNames) {
      data[seriesName] = labels.map((label) => cellValue(label, seriesName));
    }
    return data;
  };

  // Apply sort — for multi-series, 'value' sorts by the total across all series
  if (sortBy === 'value') {
    const dir = sortDirection === 'asc' ? 1 : -1;
    const totals = labels.map((label) => {
      let sum = 0;
      for (const seriesName of seriesNames) {
        sum += cellValue(label, seriesName) ?? 0;
      }
      return { label, sum };
    });
    totals.sort((a, b) => (a.sum - b.sum) * dir);
    labels = totals.map((t) => t.label);
  } else if (categoryOrder && categoryOrder.length > 0) {
    applyCategoryOrder(labels, categoryOrder, sortDirection);
  } else if (sortDirection === 'desc') {
    labels = [...labels].reverse();
  }

  return { labels, seriesNames, seriesData: buildSeriesData() };
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
  sortBy?: 'category' | 'value' | 'natural',
  sortDirection?: 'asc' | 'desc',
  categoryOrder?: string[],
  yAggregation: 'sum' | 'count' | 'avg' | 'min' | 'max' = 'sum',
): MultiYSeriesData {
  // Pre-detect non-numeric fields so callers that omit yAggregation don't get NaN.
  // A non-numeric field is always aggregated as a count regardless of yAggregation.
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

  const fieldAggregation = (fieldId: string): 'sum' | 'count' | 'avg' | 'min' | 'max' =>
    useCount.has(fieldId) ? 'count' : yAggregation;

  const labelOrder: (string | number)[] = [];
  const labelSet = new Set<string | number>();
  // Map: label → fieldId → per-cell accumulator (sum/count/min/max).
  const dataMap = new Map<string | number, Map<string, CellAcc>>();

  for (const row of rows) {
    if (isEmptyXValue(row[xField])) {
      continue;
    }
    const raw = toXValue(row[xField]);
    const xVal = applyXGroupBy(raw, xGroupBy);
    if (!labelSet.has(xVal)) {
      labelSet.add(xVal);
      labelOrder.push(xVal);
      dataMap.set(xVal, new Map());
    }
    const fieldMap = dataMap.get(xVal)!;
    for (const fieldId of yFields) {
      // For count fields the value is irrelevant — accumulateCell only counts rows.
      accumulateCell(fieldMap, fieldId, Number(row[fieldId] ?? 0));
    }
  }

  const cellValue = (label: string | number, fieldId: string): number =>
    finalizeCell(dataMap.get(label)?.get(fieldId), fieldAggregation(fieldId)) ?? 0;

  let sortedLabels = sortLabels(labelOrder);

  if (sortBy === 'value') {
    const dir = sortDirection === 'asc' ? 1 : -1;
    sortedLabels = sortedLabels
      .map((label) => ({
        label,
        total: yFields.reduce((sum, fId) => sum + cellValue(label, fId), 0),
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
    values: sortedLabels.map((label) => cellValue(label, fieldId)),
  }));

  return { labels: sortedLabels, series };
}

/**
 * One series for {@link aggregateBlendedSeries}. Each carries its own already-resolved
 * `rows` so the series can originate from a different data source than its siblings.
 */
export interface BlendedSeriesInput {
  /** Field id aggregated for this series (within its own `rows`). */
  fieldId: string;
  /** Rows for this series, already filtered/resolved from its own source. */
  rows: Row[];
  /** Per-series aggregation. @default 'sum' */
  yAggregation?: 'sum' | 'count' | 'avg' | 'min' | 'max';
}

/**
 * Aggregate several series that may originate from DIFFERENT data sources onto a
 * single shared categorical x-axis ("data blending"). Each series is aggregated
 * independently within its own `rows` by `xField`, then all series are aligned on
 * the union of category labels (outer join). Missing category/series combinations
 * are filled with 0, matching {@link aggregateMultipleSeries}.
 *
 * Unlike {@link aggregateMultipleSeries}, the returned `series` preserve the input
 * order and count 1:1 (no de-duplication by `fieldId`), so two series sharing a
 * field id across different sources remain distinct.
 */
export function aggregateBlendedSeries(
  series: BlendedSeriesInput[],
  xField: string,
  xGroupBy?: XGroupBy,
  sortBy?: 'category' | 'value' | 'natural',
  sortDirection?: 'asc' | 'desc',
  categoryOrder?: string[],
): MultiYSeriesData {
  // Aggregate each series within its own rows (independent grain per source).
  const perSeries = series.map((s) =>
    aggregateByField(s.rows, xField, s.fieldId, xGroupBy, s.yAggregation),
  );

  // Per-series label → value maps, plus the union of labels in first-seen order.
  const seen = new Set<string | number>();
  const union: (string | number)[] = [];
  const valueMaps = perSeries.map((agg) => {
    const m = new Map<string | number, number>();
    agg.labels.forEach((label, i) => {
      m.set(label, agg.values[i]);
      if (!seen.has(label)) {
        seen.add(label);
        union.push(label);
      }
    });
    return m;
  });

  // Order labels consistently with the other aggregators.
  let sortedLabels = sortLabels(union);
  if (sortBy === 'value') {
    const dir = sortDirection === 'asc' ? 1 : -1;
    sortedLabels = sortedLabels
      .map((label) => ({
        label,
        total: valueMaps.reduce((sum, m) => sum + (m.get(label) ?? 0), 0),
      }))
      .sort((a, b) => (a.total - b.total) * dir)
      .map((p) => p.label);
  } else if (categoryOrder && categoryOrder.length > 0) {
    applyCategoryOrder(sortedLabels, categoryOrder, sortDirection);
  } else if (sortDirection === 'desc') {
    sortedLabels = [...sortedLabels].reverse();
  }

  return {
    labels: sortedLabels,
    series: series.map((s, i) => ({
      fieldId: s.fieldId,
      values: sortedLabels.map((label) => valueMaps[i].get(label) ?? 0),
    })),
  };
}

export interface ScatterDataPoint {
  x: number;
  y: number;
  id: number;
  sizeValue?: number;
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
    sizeValue: sizeField != null ? Number(row[sizeField] ?? 0) : undefined,
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
      sizeValue: sizeField != null ? Number(row[sizeField] ?? 0) : undefined,
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
/**
 * Orders `labels` by `preferred` (a field's `orderedValues`): known labels first
 * in `preferred` order, then any remaining labels naturally sorted. Used so a
 * heatmap axis follows a domain order (e.g. pipeline stages) rather than A–Z.
 */
function orderLabelsByPreferred(labels: string[], preferred: string[]): string[] {
  const orderMap = new Map(preferred.map((value, index) => [value, index]));
  const known = labels
    .filter((label) => orderMap.has(label))
    .sort((a, b) => (orderMap.get(a) as number) - (orderMap.get(b) as number));
  const unknown = sortLabels(labels.filter((label) => !orderMap.has(label))) as string[];
  return [...known, ...unknown];
}

export function aggregateHeatmap(
  rows: Row[],
  xField: string,
  yField: string,
  valueField: string,
  xGroupBy?: XGroupBy,
  yAggregation: 'sum' | 'count' | 'avg' | 'min' | 'max' = 'sum',
  xOrder?: string[],
  yOrder?: string[],
  sortBy?: 'x-axis' | 'y-axis' | 'natural',
  sortDirection?: 'asc' | 'desc',
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

  // Build x-axis labels: orderedValues > explicit sort > default (alphabetical).
  let xLabels: string[];
  if (xOrder && xOrder.length > 0) {
    xLabels = orderLabelsByPreferred([...xSet], xOrder);
  } else if (sortBy === 'x-axis') {
    const sorted = sortLabels([...xSet]) as string[];
    xLabels = sortDirection === 'desc' ? sorted.toReversed() : sorted;
  } else if (sortBy === 'natural' || sortBy === 'y-axis') {
    xLabels = [...xSet];
  } else {
    xLabels = sortLabels([...xSet]) as string[];
  }

  // Build y-axis labels: orderedValues > explicit sort > default (insertion order).
  let yLabels: string[];
  if (yOrder && yOrder.length > 0) {
    yLabels = orderLabelsByPreferred([...ySet], yOrder);
  } else if (sortBy === 'y-axis') {
    const sorted = sortLabels([...ySet]) as string[];
    yLabels = sortDirection === 'desc' ? sorted.toReversed() : sorted;
  } else {
    yLabels = [...ySet];
  }

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

/** Node + link data shaped for the `@mui/x-charts-pro` Sankey chart. */
export interface SankeyAggregateData {
  /** Unique node ids, in first-seen order. */
  nodes: { id: string }[];
  /** One link per unique (source, target) pair, with summed value. */
  links: { source: string; target: string; value: number }[];
}

/**
 * Aggregates flat rows into Sankey node/link data.
 *
 * Each row contributes a flow from `sourceField` to `targetField` weighted by
 * `valueField`. Rows are grouped by the unique `(source, target)` pair and their
 * values summed. Rows with an empty source/target, a self-referencing link
 * (`source === target`), or a non-positive value are skipped.
 *
 * The Sankey layout requires a directed acyclic graph and throws on circular
 * references, so any link whose target can already reach its source through
 * previously-accepted links is dropped (the back-edge of a cycle, chosen by
 * first-seen order). Only nodes that appear in a kept link are returned.
 *
 * @param rows - The rows to aggregate.
 * @param sourceField - Field providing the source ("from") node id.
 * @param targetField - Field providing the target ("to") node id.
 * @param valueField - Numeric field summed per source→target pair.
 */
export function aggregateSankey(
  rows: Row[],
  sourceField: string,
  targetField: string,
  valueField: string,
): SankeyAggregateData {
  // 1. Sum values per unique (source, target) pair, preserving first-seen order.
  const linkMap = new Map<string, { source: string; target: string; value: number }>();
  for (const row of rows) {
    const source = String(row[sourceField] ?? '');
    const target = String(row[targetField] ?? '');
    if (!source || !target || source === target) {
      continue;
    }
    const value = Number(row[valueField]);
    if (!Number.isFinite(value) || value <= 0) {
      continue;
    }
    const key = `${source}\x00${target}`;
    const existing = linkMap.get(key);
    if (existing) {
      existing.value += value;
    } else {
      linkMap.set(key, { source, target, value });
    }
  }

  // 2. Keep only links that preserve a directed acyclic graph.
  const adjacency = new Map<string, Set<string>>();
  const canReach = (from: string, to: string): boolean => {
    const stack = [from];
    const visited = new Set<string>();
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node === to) {
        return true;
      }
      if (visited.has(node)) {
        continue;
      }
      visited.add(node);
      const next = adjacency.get(node);
      if (next) {
        stack.push(...next);
      }
    }
    return false;
  };

  const nodeOrder: string[] = [];
  const seenNodes = new Set<string>();
  const addNode = (id: string) => {
    if (!seenNodes.has(id)) {
      seenNodes.add(id);
      nodeOrder.push(id);
    }
  };

  const links: { source: string; target: string; value: number }[] = [];
  for (const link of linkMap.values()) {
    // Adding source→target would close a cycle if target already reaches source.
    if (canReach(link.target, link.source)) {
      continue;
    }
    addNode(link.source);
    addNode(link.target);
    let out = adjacency.get(link.source);
    if (!out) {
      out = new Set<string>();
      adjacency.set(link.source, out);
    }
    out.add(link.target);
    links.push(link);
  }

  return {
    nodes: nodeOrder.map((id) => ({ id })),
    links,
  };
}

/** One stage of a cumulative ("reached") funnel. */
interface FunnelReachedStage {
  /** Stage label (e.g. `Prospecting`). */
  label: string;
  /**
   * Cumulative count of deals that *reached at least* this stage. Non-increasing
   * along the sequence by construction (`{reached ≥ i+1} ⊆ {reached ≥ i}`), so
   * the funnel can never exceed 100% of its top stage.
   */
  value: number;
  /**
   * Snapshot count of deals *currently sitting in* this stage (`stage === label`).
   * Used for the "currently in stage: N" tooltip; this is NOT the funnel width.
   */
  snapshotValue: number;
  /**
   * Step-conversion vs. the previous stage as a fraction 0..1
   * (`value / prevValue`). `null` for the first stage.
   */
  stepConversion: number | null;
}

interface FunnelReachedData {
  /** Sequential stages with cumulative + snapshot counts (Closed Lost excluded). */
  stages: FunnelReachedStage[];
  /**
   * Deals whose final outcome is the terminal exit stage (e.g. `Closed Lost`).
   * Rendered as a separate exit stat, not as a funnel step. A lost deal also
   * counts toward the upper stages it passed through — that is the honest
   * passed-through view, not double counting.
   */
  exitLabel: string | null;
  exitValue: number;
}

/**
 * Builds a cumulative "reached stage" funnel from per-deal depth data.
 *
 * For each stage `i` in `sequence`, counts deals whose numeric reached-depth
 * (`reachedField`) is `>= i`. Because `{reached ≥ i+1} ⊆ {reached ≥ i}`, the
 * resulting counts are monotonically non-increasing **by construction** — the
 * funnel is honest and can never produce retention > 100%.
 *
 * The terminal exit stage (`exitStage`, e.g. `Closed Lost`) is excluded from the
 * sequential math and reported separately as `exitValue`. Lost deals keep their
 * reached depth and still count toward the upper stages they passed through.
 *
 * @param rows - Deal rows.
 * @param stageField - Field holding the snapshot stage label (for the tooltip).
 * @param reachedField - Numeric field holding the furthest-reached depth index.
 * @param sequence - Ordered sequential stage labels (Closed Lost excluded).
 * @param exitStage - Terminal exit label reported as a side stat.
 */
export function aggregateFunnelReached(
  rows: Row[],
  stageField: string,
  reachedField: string,
  sequence: readonly string[],
  exitStage?: string,
): FunnelReachedData {
  const reachedCounts = sequence.map(() => 0);
  const snapshotCounts = new Map<string, number>();
  let exitValue = 0;

  for (const row of rows) {
    const stageLabel = String(row[stageField] ?? '');
    snapshotCounts.set(stageLabel, (snapshotCounts.get(stageLabel) ?? 0) + 1);

    if (exitStage && stageLabel === exitStage) {
      exitValue += 1;
    }

    const depth = Number(row[reachedField]);
    if (!Number.isFinite(depth)) {
      continue;
    }
    // A deal that reached depth `d` counts toward every stage 0..d.
    const cap = Math.min(depth, sequence.length - 1);
    for (let i = 0; i <= cap; i += 1) {
      reachedCounts[i] += 1;
    }
  }

  const stages: FunnelReachedStage[] = sequence.map((label, i) => {
    const value = reachedCounts[i];
    const prev = i > 0 ? reachedCounts[i - 1] : null;
    return {
      label,
      value,
      snapshotValue: snapshotCounts.get(label) ?? 0,
      stepConversion: prev && prev > 0 ? value / prev : null,
    };
  });

  return {
    stages,
    exitLabel: exitStage ?? null,
    exitValue,
  };
}

/**
 * Clamps a funnel bar width fraction to the `[0, 1]` range so a bar can never
 * overflow its track regardless of the source data (a presentation guard that
 * also neutralises any non-monotonic snapshot input).
 */
export function clampWidthPct(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value > 1 ? 1 : value;
}
