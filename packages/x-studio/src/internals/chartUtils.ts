import dayjs from 'dayjs';
import type { RelativeDateValue } from './filterTypes';
import type {
  StudioDataSource,
  StudioExpressionField,
  StudioFilterState,
  StudioMetricRef,
  StudioRelationship,
} from '../models';
import { getCachedEnrichedRows } from './enrichedRowsCache';

type Row = Record<string, unknown>;

// ─── Metric ref resolution ───────────────────────────────────────────────────

/**
 * Resolves a StudioMetricRef to a concrete value by looking up the row in the
 * specified data source. Returns undefined if the source/row/field is missing.
 */
export function resolveMetricRef(
  ref: StudioMetricRef,
  dataSources: Record<string, StudioDataSource>,
): string | number | boolean | null | undefined {
  const source = dataSources[ref.sourceId];
  if (!source?.rows) {
    return undefined;
  }
  const row = source.rows.find((r) => String(r.id ?? '') === ref.rowId);
  const val = row?.[ref.field];
  if (val === null || val === undefined) {
    return val as null | undefined;
  }
  if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
    return val;
  }
  return undefined;
}

/**
 * Returns a new filter array where any valueRef / value2Ref fields have been
 * resolved to their concrete values from dataSources.
 * Call this once before passing filters to applyFilters().
 */
export function resolveMetricRefs(
  filters: StudioFilterState[],
  dataSources: Record<string, StudioDataSource>,
): StudioFilterState[] {
  // Short-circuit when no filter has a reference (the common case).
  if (!filters.some((f) => f.valueRef || f.value2Ref)) {
    return filters;
  }

  // Pre-build a row-by-id index for each referenced source so resolveMetricRef
  // uses an O(1) Map lookup rather than an O(N) .find() scan per filter.
  const rowIndexCache = new Map<string, Map<string, Record<string, unknown>>>();
  const getRowIndex = (sourceId: string) => {
    if (!rowIndexCache.has(sourceId)) {
      const index = new Map<string, Record<string, unknown>>();
      for (const row of dataSources[sourceId]?.rows ?? []) {
        const key = String(row.id ?? '');
        if (!index.has(key)) {
          index.set(key, row as Record<string, unknown>);
        }
      }
      rowIndexCache.set(sourceId, index);
    }
    return rowIndexCache.get(sourceId)!;
  };

  const resolveRef = (ref: StudioMetricRef) => {
    const index = getRowIndex(ref.sourceId);
    const row = index.get(ref.rowId);
    const val = row?.[ref.field];
    if (val === null || val === undefined) {
      return val as null | undefined;
    }
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
      return val;
    }
    return undefined;
  };

  return filters.map((f) => {
    if (!f.valueRef && !f.value2Ref) {
      return f;
    }
    return {
      ...f,
      value: resolveReferencedFilterValueFast(f.value, f.valueRef, resolveRef),
      value2: resolveReferencedFilterValueFast(f.value2, f.value2Ref, resolveRef),
    };
  });
}

function isRelativeDateValue(value: unknown): value is RelativeDateValue {
  return (
    typeof value === 'object' && value !== null && (value as RelativeDateValue).relative === true
  );
}

/**
 * Fast variant that resolves a filter value using a pre-built row index.
 * @param {unknown} originalValue - The original filter value to potentially resolve.
 * @param {StudioMetricRef | undefined} ref - Optional metric reference to resolve against.
 * @param {(ref: StudioMetricRef) => string | number | boolean | null | undefined} resolveRef - Row-index-based resolver.
 * @returns {unknown} The resolved value, or the original value if ref is absent or unresolvable.
 */
function resolveReferencedFilterValueFast(
  originalValue: unknown,
  ref: StudioMetricRef | undefined,
  resolveRef: (ref: StudioMetricRef) => string | number | boolean | null | undefined,
) {
  if (!ref) {
    return originalValue;
  }
  const resolvedValue = resolveRef(ref);
  if (resolvedValue === undefined) {
    return originalValue;
  }
  if (isRelativeDateValue(originalValue) && typeof resolvedValue === 'number') {
    return {
      ...originalValue,
      amount: Math.max(1, Math.trunc(resolvedValue) || 1),
    };
  }
  return resolvedValue;
}

function resolveRelativeDate(rel: RelativeDateValue): string {
  const now = dayjs();
  const result =
    rel.direction === 'past' ? now.subtract(rel.amount, rel.unit) : now.add(rel.amount, rel.unit);
  return result.format('YYYY-MM-DD');
}

function toComparable(
  val: unknown,
  fieldType?: 'string' | 'number' | 'boolean' | 'date' | 'datetime',
): number | string {
  if (isRelativeDateValue(val)) {
    return resolveRelativeDate(val);
  }
  // Explicit type hint takes precedence
  if (fieldType === 'date' || fieldType === 'datetime') {
    // Normalize Date objects, ms timestamps, and any string format to YYYY-MM-DD
    // so comparisons are correct regardless of how the data source stores dates.
    const d = normalizeToDate(val);
    if (d) {
      return fieldType === 'datetime' ? d.toISOString() : d.toISOString().slice(0, 10);
    }
    return String(val ?? '');
  }
  if (fieldType === 'number') {
    return Number(val);
  }
  // Fallback: detect ISO date strings by shape
  if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}/.test(val)) {
    return val;
  }
  return Number(val);
}

function matchesFilter(row: Row, filter: StudioFilterState): boolean {
  const rowVal = row[filter.field];
  const filterVal = filter.value;
  const { fieldType } = filter;

  switch (filter.operator) {
    case 'equals':
      if (fieldType === 'boolean') {
        return String(rowVal) === String(filterVal);
      }
      // eslint-disable-next-line eqeqeq
      return rowVal == filterVal;
    case 'in':
      return Array.isArray(filterVal)
        ? filterVal.some(
            (candidate) =>
              // eslint-disable-next-line eqeqeq
              rowVal == candidate,
          )
        : true;
    case 'not_equals':
      if (fieldType === 'boolean') {
        return String(rowVal) !== String(filterVal);
      }
      // eslint-disable-next-line eqeqeq
      return rowVal != filterVal;
    case 'contains':
      return String(rowVal ?? '')
        .toLowerCase()
        .includes(String(filterVal ?? '').toLowerCase());
    case 'does_not_contain':
      return !String(rowVal ?? '')
        .toLowerCase()
        .includes(String(filterVal ?? '').toLowerCase());
    case 'starts_with':
      return String(rowVal ?? '')
        .toLowerCase()
        .startsWith(String(filterVal ?? '').toLowerCase());
    case 'not_starts_with':
      return !String(rowVal ?? '')
        .toLowerCase()
        .startsWith(String(filterVal ?? '').toLowerCase());
    case 'ends_with':
      return String(rowVal ?? '')
        .toLowerCase()
        .endsWith(String(filterVal ?? '').toLowerCase());
    case 'not_ends_with':
      return !String(rowVal ?? '')
        .toLowerCase()
        .endsWith(String(filterVal ?? '').toLowerCase());
    case 'is_empty':
      return rowVal == null || String(rowVal) === '';
    case 'is_not_empty':
      return rowVal != null && String(rowVal) !== '';
    case 'greater_than':
      return toComparable(rowVal, fieldType) > toComparable(filterVal, fieldType);
    case 'less_than':
      return toComparable(rowVal, fieldType) < toComparable(filterVal, fieldType);
    case 'greater_than_or_equal':
      return toComparable(rowVal, fieldType) >= toComparable(filterVal, fieldType);
    case 'less_than_or_equal':
      return toComparable(rowVal, fieldType) <= toComparable(filterVal, fieldType);
    case 'between': {
      const range = filterVal as { from?: string; to?: string } | null;
      if (!range || typeof range !== 'object') {
        return true;
      }
      const cmp = toComparable(rowVal, fieldType);
      const from = range.from ? toComparable(range.from, fieldType) : null;
      const to = range.to ? toComparable(range.to, fieldType) : null;
      if (from !== null && cmp < from) {
        return false;
      }
      if (to !== null && cmp > to) {
        return false;
      }
      return true;
    }
    default:
      return true;
  }
}

function isConditionComplete(operator: StudioFilterState['operator'], value: unknown): boolean {
  if (operator === 'is_empty' || operator === 'is_not_empty') {
    return true;
  }
  if (operator === 'between') {
    const range = value as { from?: unknown; to?: unknown } | null;
    return !!(range?.from || range?.to);
  }
  if (isRelativeDateValue(value)) {
    return true;
  }
  return value !== '' && value != null;
}

function isFilterComplete(filter: StudioFilterState): boolean {
  if (!filter.field) {
    return false;
  }
  const mode = filter.filterMode ?? 'condition';
  if (mode === 'selection') {
    return Array.isArray(filter.value) && filter.value.length > 0;
  }
  if (mode === 'rank') {
    const n = Number(filter.value);
    return Number.isFinite(n) && n > 0;
  }
  return isConditionComplete(filter.operator, filter.value);
}

function matchesFilterState(row: Row, filter: StudioFilterState): boolean {
  const mode = filter.filterMode ?? 'condition';

  if (mode === 'selection') {
    const selected = Array.isArray(filter.value) ? (filter.value as string[]) : [];
    if (selected.length === 0) {
      return true;
    }
    const rowVal = String(row[filter.field] ?? '');
    return selected.some((v) => String(v) === rowVal);
  }

  // rank is handled at the dataset level in applyFilters — rows here have already been sliced
  if (mode === 'rank') {
    return true;
  }

  const primary = matchesFilter(row, filter);
  if (!filter.operator2 || !isConditionComplete(filter.operator2, filter.value2)) {
    return primary;
  }
  const secondary = matchesFilter(row, {
    ...filter,
    operator: filter.operator2,
    value: filter.value2,
  });
  return filter.conjunction === 'or' ? primary || secondary : primary && secondary;
}

export function applyFilters(rows: Row[], filters: StudioFilterState[]): Row[] {
  const active = filters.filter(isFilterComplete);
  if (active.length === 0) {
    return rows;
  }

  // Apply rank filters first (dataset-level reduction)
  const rankFilters = active.filter((f) => (f.filterMode ?? 'condition') === 'rank');
  let result = rows;
  for (const f of rankFilters) {
    const n = Math.round(Number(f.value));
    const dir = f.rankDirection ?? 'top';
    const fieldId = f.field;

    if (f.rankByField) {
      // Aggregate rank: group rows by fieldId, sum rankByField, keep top/bottom N groups
      const totals = new Map<unknown, number>();
      for (const row of result) {
        const key = row[fieldId];
        totals.set(key, (totals.get(key) ?? 0) + Number(row[f.rankByField] ?? 0));
      }
      const sorted = Array.from(totals.entries()).sort((a, b) =>
        dir === 'top' ? b[1] - a[1] : a[1] - b[1],
      );
      const topKeys = new Set(sorted.slice(0, n).map(([k]) => k));
      result = result.filter((row) => topKeys.has(row[fieldId]));
    } else {
      // Numeric rank: sort rows by the field value directly
      const sorted = [...result].sort((a, b) => {
        const av = Number(a[fieldId] ?? 0);
        const bv = Number(b[fieldId] ?? 0);
        return dir === 'top' ? bv - av : av - bv;
      });
      result = sorted.slice(0, n);
    }
  }

  // Apply condition and selection filters row-by-row
  const rowFilters = active.filter((f) => (f.filterMode ?? 'condition') !== 'rank');
  if (rowFilters.length === 0) {
    return result;
  }
  return result.filter((row) => rowFilters.every((f) => matchesFilterState(row, f)));
}

/**
 * Returns the set of source IDs reachable from `sourceId` in one hop via declared relationships.
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
    }
    if (rel.targetId === sourceId) {
      reachable.add(rel.sourceId);
    }
  }
  return reachable;
}

/**
 * Returns { widgetJoinField, filterJoinField } or null if no path exists.
 */
function findJoinPath(
  widgetSourceId: string,
  filterSourceId: string,
  relationships: StudioRelationship[],
): { widgetJoinField: string; filterJoinField: string } | null {
  for (const rel of relationships) {
    if (rel.sourceId === widgetSourceId && rel.targetId === filterSourceId) {
      // widget is the "many" side; filter source is the "one" side
      return { widgetJoinField: rel.sourceField, filterJoinField: rel.targetField };
    }
    if (rel.targetId === widgetSourceId && rel.sourceId === filterSourceId) {
      // widget is the "one" side; filter source is the "many" side
      return { widgetJoinField: rel.targetField, filterJoinField: rel.sourceField };
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

  for (const f of filters) {
    if (f.filterSourceId && f.filterSourceId !== widgetSourceId) {
      crossFilters.push(f as StudioFilterState & { filterSourceId: string });
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

    // Build the allowed set from the join field in the foreign source
    const allowedValues = new Set(matchingForeignRows.map((r) => r[joinPath.filterJoinField]));

    // Semi-join: keep widget rows whose join field is in the allowed set
    rows = rows.filter((r) => allowedValues.has(r[joinPath.widgetJoinField]));
  }

  return applyFilters(rows, nativeFilters);
}

/**
 * Enriches widget rows with fields that exist on directly related sources but
 * not on the widget's own source. For each requested field not found on the
 * widget source, the function walks the relationship graph one hop, finds the
 * related source that has the field, builds a lookup map (relatedId → fieldValue),
 * and copies the value onto each widget row.
 *
 * This eliminates the need to denormalize fields (e.g. date from orders onto
 * orderItems) just to make them available in chart aggregations.
 *
 * Only direct (single-hop) relationships are resolved. Multi-hop joins are
 * not supported.
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

  // Determine which fields need to be resolved from a related source
  const foreignFieldNeeds: Array<{
    fieldId: string;
    widgetJoinField: string;
    relatedJoinField: string;
    relatedRows: Row[];
  }> = [];

  for (const fieldId of fieldIds) {
    if (nativeFieldIds.has(fieldId)) {
      continue; // already on the widget source
    }

    // Find a directly related source that has this field
    for (const rel of relationships) {
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
        continue; // this related source doesn't have the field
      }

      foreignFieldNeeds.push({
        fieldId,
        widgetJoinField,
        relatedJoinField,
        relatedRows: relatedSource.rows ?? [],
      });
      break; // first matching relationship wins
    }
  }

  if (foreignFieldNeeds.length === 0) {
    return rows; // nothing to enrich
  }

  // Build lookup maps: relatedJoinValue → fieldValue  (one per foreign field)
  const lookups = foreignFieldNeeds.map(({ fieldId, relatedJoinField, relatedRows }) => {
    const map = new Map<unknown, unknown>();
    for (const row of relatedRows) {
      map.set(row[relatedJoinField], row[fieldId]);
    }
    return {
      fieldId,
      widgetJoinField: foreignFieldNeeds.find((n) => n.fieldId === fieldId)!.widgetJoinField,
      map,
    };
  });

  // Enrich rows (non-mutating — spread each row)
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
  rankFilter: import('../models').StudioFilterState | null,
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
  rankFilter: import('../models').StudioFilterState | null,
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
  rankFilter: import('../models').StudioFilterState | null,
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

export type XGroupBy = 'day' | 'week' | 'month' | 'quarter' | 'year';

/** Normalise any date-like value (Date, ms number, or string) to a Date. */
export function normalizeToDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === 'string') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Normalise all date/datetime field values in a data source's rows to canonical
 * ISO strings on ingestion, so the rest of the system can assume a single format.
 *
 * - `date`     fields → `"YYYY-MM-DD"`
 * - `datetime` fields → `"YYYY-MM-DDTHH:mm:ss.sssZ"` (full ISO-8601 UTC)
 *
 * Accepts JS `Date` objects, millisecond timestamps (numbers), and any string
 * that `new Date()` can parse. The format is inferred once from the first
 * non-null value of each field; if it's already canonical every row is skipped
 * without per-cell regex checks.
 */
/**
 * Returns a normalized copy of `dataSource`.
 *
 * When `usedFieldIds` is provided, only the fields in that set are processed:
 * - Date/datetime normalization: only for date-type fields in the set
 * - `fieldDistinctValues`: only for categorical (string/boolean) fields in the set
 *
 * Omitting `usedFieldIds` processes all fields (backward-compatible, source-scoped).
 */
export function normalizeDataSourceRows(
  dataSource: StudioDataSource,
  usedFieldIds?: ReadonlySet<string>,
): StudioDataSource {
  if (!dataSource.rows || dataSource.rows.length === 0) {
    return dataSource;
  }

  const allDateFieldIds = dataSource.fields.filter((f) => f.type === 'date').map((f) => f.id);
  const allDatetimeFieldIds = dataSource.fields
    .filter((f) => f.type === 'datetime')
    .map((f) => f.id);

  // When usedFieldIds is provided, scope to only the requested date fields.
  const dateFieldIds = usedFieldIds
    ? allDateFieldIds.filter((id) => usedFieldIds.has(id))
    : allDateFieldIds;
  const datetimeFieldIds = usedFieldIds
    ? allDatetimeFieldIds.filter((id) => usedFieldIds.has(id))
    : allDatetimeFieldIds;

  // ── Date normalization ────────────────────────────────────────────────────

  let rows = dataSource.rows;

  if (dateFieldIds.length > 0 || datetimeFieldIds.length > 0) {
    const { rows: originalRows } = dataSource;

    // Infer once per field: find the first non-null value and decide whether
    // normalization is needed at all. Fields already in canonical form are excluded.
    const dateIdsToNormalize = dateFieldIds.filter((id) => {
      const sample = originalRows.find((r) => r[id] != null)?.[id];
      return (
        sample !== undefined && !(typeof sample === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(sample))
      );
    });
    const datetimeIdsToNormalize = datetimeFieldIds.filter((id) => {
      const sample = originalRows.find((r) => r[id] != null)?.[id];
      return (
        sample !== undefined && !(typeof sample === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(sample))
      );
    });

    if (dateIdsToNormalize.length > 0 || datetimeIdsToNormalize.length > 0) {
      rows = originalRows.map((row) => {
        let changed = false;
        const next: Record<string, unknown> = { ...row };

        for (const id of dateIdsToNormalize) {
          const raw = row[id];
          if (raw == null) {
            continue;
          }
          const d = normalizeToDate(raw);
          if (d) {
            next[id] = d.toISOString().slice(0, 10);
            changed = true;
          }
        }

        for (const id of datetimeIdsToNormalize) {
          const raw = row[id];
          if (raw == null) {
            continue;
          }
          const d = normalizeToDate(raw);
          if (d) {
            next[id] = d.toISOString();
            changed = true;
          }
        }

        return changed ? next : row;
      });
    }
  }

  // ── Pre-compute distinct values for string/boolean fields ─────────────────
  // Used by filter widgets to avoid an O(N) per-render scan for distinct values.
  // Only covers native fields (expression fields are computed from other sources
  // and cannot be pre-indexed at ingestion time).
  // When usedFieldIds is provided, only compute distinct values for those fields.
  const categoricalFields = dataSource.fields.filter(
    (f) =>
      (f.type === 'string' || f.type === 'boolean') && (!usedFieldIds || usedFieldIds.has(f.id)),
  );

  let fieldDistinctValues: Record<string, string[]> | undefined;

  if (categoricalFields.length > 0) {
    fieldDistinctValues = {};
    for (const f of categoricalFields) {
      const seen = new Set<string>();
      for (const row of rows) {
        const v = row[f.id];
        if (v != null && String(v) !== '') {
          seen.add(String(v));
        }
      }
      if (seen.size > 0) {
        fieldDistinctValues[f.id] = Array.from(seen).sort();
      }
    }
  }


  if (rows === dataSource.rows && !fieldDistinctValues) {
    return dataSource;
  }

  return { ...dataSource, rows, ...(fieldDistinctValues ? { fieldDistinctValues } : {}) };
}

/** ISO week number (1–53) for a given date. */
function isoWeek(d: Date): { year: number; week: number } {
  // Shift to Thursday of the same week (ISO weeks start on Monday)
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  tmp.setUTCDate(tmp.getUTCDate() + 4 - (tmp.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: tmp.getUTCFullYear(), week };
}

/**
 * Truncate a date-like value to a granularity and return a sort-stable ISO key.
 * Returns null if the value cannot be parsed as a date.
 *
 * Examples (UTC):
 *   'day'     → '2024-01-15'
 *   'week'    → '2024-W03'
 *   'month'   → '2024-01'
 *   'quarter' → '2024-Q1'
 *   'year'    → '2024'
 */
export function truncateToGranularity(value: unknown, granularity: XGroupBy): string | null {
  const d = normalizeToDate(value);
  if (!d) {
    return null;
  }
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth(); // 0-indexed
  switch (granularity) {
    case 'day': {
      const mm = String(m + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      return `${y}-${mm}-${dd}`;
    }
    case 'week': {
      const { year, week } = isoWeek(d);
      return `${year}-W${String(week).padStart(2, '0')}`;
    }
    case 'month': {
      return `${y}-${String(m + 1).padStart(2, '0')}`;
    }
    case 'quarter': {
      const q = Math.floor(m / 3) + 1;
      return `${y}-Q${q}`;
    }
    case 'year': {
      return `${y}`;
    }
    default:
      return null;
  }
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * Convert a sort-stable period key into a human-readable axis label.
 *
 * Examples:
 *   '2024-01-15' → 'Jan 15, 2024'
 *   '2024-W03'   → 'W03 2024'
 *   '2024-01'    → 'Jan 2024'
 *   '2024-Q1'    → 'Q1 2024'
 *   '2024'       → '2024'
 */
export function formatPeriodLabel(key: string): string {
  // Year only: '2024'
  if (/^\d{4}$/.test(key)) {
    return key;
  }
  // Quarter: '2024-Q1'
  const qMatch = key.match(/^(\d{4})-Q(\d)$/);
  if (qMatch) {
    return `Q${qMatch[2]} ${qMatch[1]}`;
  }
  // Week: '2024-W03'
  const wMatch = key.match(/^(\d{4})-W(\d{2})$/);
  if (wMatch) {
    return `Week ${parseInt(wMatch[2], 10)} ${wMatch[1]}`;
  }
  // Month: '2024-01'
  const mMatch = key.match(/^(\d{4})-(\d{2})$/);
  if (mMatch) {
    const monthIndex = parseInt(mMatch[2], 10) - 1;
    return `${MONTH_NAMES[monthIndex] ?? mMatch[2]} ${mMatch[1]}`;
  }
  // Day: '2024-01-15'
  const dMatch = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dMatch) {
    const monthIndex = parseInt(dMatch[2], 10) - 1;
    return `${MONTH_NAMES[monthIndex] ?? dMatch[2]} ${parseInt(dMatch[3], 10)}, ${dMatch[1]}`;
  }
  return key;
}

type TemporalLabelKind = 'day' | 'week' | 'month' | 'quarter' | 'year';

function parseTemporalLabelKind(label: string): TemporalLabelKind | null {
  if (/^\d{4}$/.test(label)) {
    return 'year';
  }
  if (/^\d{4}-Q[1-4]$/.test(label)) {
    return 'quarter';
  }
  if (/^\d{4}-W\d{2}$/.test(label)) {
    return 'week';
  }
  if (/^\d{4}-\d{2}$/.test(label)) {
    return 'month';
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(label) || /^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z$/.test(label)) {
    return 'day';
  }
  return null;
}

function parseIsoWeekLabel(label: string): Date | null {
  const match = label.match(/^(\d{4})-W(\d{2})$/);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const week = Number(match[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1 + (week - 1) * 7);
  return monday;
}

function parseTemporalLabelValue(label: string, kind: TemporalLabelKind): Date | null {
  switch (kind) {
    case 'day':
      return normalizeToDate(label);
    case 'week':
      return parseIsoWeekLabel(label);
    case 'month': {
      const match = label.match(/^(\d{4})-(\d{2})$/);
      return match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)) : null;
    }
    case 'quarter': {
      const match = label.match(/^(\d{4})-Q([1-4])$/);
      return match ? new Date(Date.UTC(Number(match[1]), (Number(match[2]) - 1) * 3, 1)) : null;
    }
    case 'year': {
      const match = label.match(/^(\d{4})$/);
      return match ? new Date(Date.UTC(Number(match[1]), 0, 1)) : null;
    }
    default:
      return null;
  }
}

// Mutates `date` in place rather than allocating a new Date per step.
// Callers must not reuse `date` after calling this.
function stepTemporalDateInPlace(date: Date, kind: TemporalLabelKind): void {
  switch (kind) {
    case 'day':
      date.setUTCDate(date.getUTCDate() + 1);
      break;
    case 'week':
      date.setUTCDate(date.getUTCDate() + 7);
      break;
    case 'month':
      date.setUTCMonth(date.getUTCMonth() + 1, 1);
      break;
    case 'quarter':
      date.setUTCMonth(date.getUTCMonth() + 3, 1);
      break;
    case 'year':
      date.setUTCFullYear(date.getUTCFullYear() + 1, 0, 1);
      break;
    default:
      break;
  }
}

function serializeTemporalLabel(date: Date, kind: TemporalLabelKind, sampleLabel: string): string {
  if (kind === 'day' && sampleLabel.includes('T')) {
    return date.toISOString();
  }
  return truncateToGranularity(date.toISOString(), kind) ?? sampleLabel;
}

export function fillTemporalLabelGaps(labels: (string | number)[]): (string | number)[] {
  if (labels.length < 2 || !labels.every((label) => typeof label === 'string')) {
    return labels;
  }

  const stringLabels = sortLabels(labels) as string[];
  const kind = parseTemporalLabelKind(stringLabels[0]);
  // Check only the last label for kind consistency — all labels in the same aggregation
  // bucket share the same format, so validating first + last is sufficient and avoids
  // running N regex executions across the full label set.
  if (!kind || parseTemporalLabelKind(stringLabels[stringLabels.length - 1]) !== kind) {
    return labels;
  }

  const start = parseTemporalLabelValue(stringLabels[0], kind);
  const end = parseTemporalLabelValue(stringLabels[stringLabels.length - 1], kind);
  if (!start || !end) {
    return labels;
  }

  const filled: string[] = [];
  // Use a single Date object mutated in place to avoid one allocation per step.
  const cursor = new Date(start);
  while (cursor <= end) {
    filled.push(serializeTemporalLabel(cursor, kind, stringLabels[0]));
    stepTemporalDateInPlace(cursor, kind);
  }

  return filled.length > stringLabels.length ? filled : labels;
}

export function getTemporalAxisData(labels: (string | number)[]): Date[] | null {
  if (labels.length === 0 || !labels.every((label) => typeof label === 'string')) {
    return null;
  }

  const stringLabels = sortLabels(labels) as string[];
  const kind = parseTemporalLabelKind(stringLabels[0]);

  // Check only first + last label for kind consistency — avoids N regex matches.
  if (kind && parseTemporalLabelKind(stringLabels[stringLabels.length - 1]) === kind) {
    const axisData = stringLabels.map((label) => parseTemporalLabelValue(label, kind));
    return axisData.every((value) => value != null) ? (axisData as Date[]) : null;
  }

  const axisData = stringLabels.map((label) => normalizeToDate(label));
  return axisData.every((value) => value != null) ? (axisData as Date[]) : null;
}

export function formatTemporalAxisLabel(value: Date, xGroupBy?: XGroupBy): string {
  if (xGroupBy) {
    const grouped = truncateToGranularity(value, xGroupBy);
    return grouped ? formatPeriodLabel(grouped) : value.toISOString();
  }

  return value.toLocaleDateString(undefined, {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
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

/**
 * Sort x-axis labels: numeric labels sort numerically, date-like strings sort
 * chronologically, everything else sorts lexicographically.
 */
function sortLabels(labels: (string | number)[]): (string | number)[] {
  if (labels.length === 0) {
    return labels;
  }
  // If all labels are numbers, sort numerically
  if (labels.every((l) => typeof l === 'number')) {
    return [...labels].sort((a, b) => (a as number) - (b as number));
  }
  // Try parsing all string labels as dates
  const allDates = labels.every((l) => {
    const s = String(l);
    return s.length >= 4 && !Number.isNaN(Date.parse(s));
  });
  if (allDates) {
    return [...labels].sort((a, b) => Date.parse(String(a)) - Date.parse(String(b)));
  }
  // Fall back to locale-aware string sort
  return [...labels].sort((a, b) => String(a).localeCompare(String(b)));
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
  if (!relationship) {
    return false;
  }

  if (relationship.type === 'one-to-one') {
    return true;
  }

  return relationship.sourceId === widgetSourceId;
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

  for (const relationship of relationships) {
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
  return getCachedEnrichedRows(rows, sourceId, expressionFields, dataSources, relationships, usedFieldIds);
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
): ChartSupportResult {
  const requestedFields = [xField, ...yFields, seriesField].filter((field): field is string =>
    Boolean(field),
  );

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
    const anchorRelationship = findDirectRelationship(widgetSourceId, ySourceIds[0], relationships);
    if (
      anchorRelationship &&
      anchorRelationship.sourceId === ySourceIds[0] &&
      anchorRelationship.targetId === widgetSourceId
    ) {
      anchorSourceId = ySourceIds[0];
    }
  }

  if (
    anchorSourceId === widgetSourceId &&
    ySourceIds.filter((sourceId) => sourceId !== widgetSourceId).length > 1
  ) {
    return { supported: false, reason: 'mixed_cross_source_fields' };
  }

  for (const [fieldId, owner] of fieldOwners.entries()) {
    if (yFields.includes(fieldId)) {
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

  let result: Row[];

  if (anchorSourceId === widgetSourceId) {
    result = enrichRowsWithRelatedFields(
      widgetRows,
      widgetSourceId,
      requestedFields,
      dataSources,
      relationships,
    );
  } else {
    const anchorRelationship = findDirectRelationship(
      widgetSourceId,
      anchorSourceId,
      relationships,
    );
    if (
      !anchorRelationship ||
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

export function aggregateByField(
  rows: Row[],
  xField: string,
  yField: string,
  xGroupBy?: XGroupBy,
  yAggregation: 'sum' | 'count' | 'avg' | 'min' | 'max' = 'sum',
): AggregatedData {
  const grouped = new Map<string | number, number>();
  const counts = new Map<string | number, number>();

  for (const row of rows) {
    const raw = toXValue(row[xField]);
    const xVal = applyXGroupBy(raw, xGroupBy);
    const count = (counts.get(xVal) ?? 0) + 1;
    counts.set(xVal, count);

    if (yAggregation === 'count') {
      grouped.set(xVal, count);
    } else {
      const yVal = Number(row[yField] ?? 0);
      const prev = grouped.get(xVal) ?? 0;
      if (yAggregation === 'sum') {
        grouped.set(xVal, prev + yVal);
      } else if (yAggregation === 'avg') {
        // Store running sum; divide by count at the end
        grouped.set(xVal, prev + yVal);
      } else if (yAggregation === 'min') {
        grouped.set(xVal, count === 1 ? yVal : Math.min(prev, yVal));
      } else if (yAggregation === 'max') {
        grouped.set(xVal, count === 1 ? yVal : Math.max(prev, yVal));
      }
    }
  }

  if (yAggregation === 'avg') {
    for (const [key, sum] of grouped) {
      grouped.set(key, sum / (counts.get(key) ?? 1));
    }
  }

  const labels = sortLabels(Array.from(grouped.keys()));
  const values = labels.map((label) => grouped.get(label) ?? 0);

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

  const labels = sortLabels(Array.from(xValuesSet));
  const seriesNames = Array.from(seriesValuesSet);

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
): MultiYSeriesData {
  const labelOrder: (string | number)[] = [];
  const labelSet = new Set<string | number>();
  // Map: label → fieldId → sum
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
      const yVal = Number(row[fieldId] ?? 0);
      fieldMap.set(fieldId, (fieldMap.get(fieldId) ?? 0) + yVal);
    }
  }

  const sortedLabels = sortLabels(labelOrder);
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
}

/**
 * Prepare data for scatter charts
 */
export function prepareScatterData(
  rows: Row[],
  xField: string,
  yField: string,
): ScatterDataPoint[] {
  return rows.map((row, index) => ({
    x: Number(row[xField] ?? 0),
    y: Number(row[yField] ?? 0),
    id: index,
  }));
}
