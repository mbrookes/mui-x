import dayjs from 'dayjs';
import type { RelativeDateValue } from './filterTypes';
import type {
  StudioDataSource,
  StudioExpressionField,
  StudioFilterState,
  StudioMetricRef,
  StudioRelationship,
} from '../models';
import { enrichRowsWithExpressions } from '../utils/expressionEvaluator';

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
  return filters.map((f) => {
    if (!f.valueRef && !f.value2Ref) {
      return f;
    }
    return {
      ...f,
      value: resolveReferencedFilterValue(f.value, f.valueRef, dataSources),
      value2: resolveReferencedFilterValue(f.value2, f.value2Ref, dataSources),
    };
  });
}

function isRelativeDateValue(value: unknown): value is RelativeDateValue {
  return (
    typeof value === 'object' && value !== null && (value as RelativeDateValue).relative === true
  );
}

function resolveReferencedFilterValue(
  originalValue: unknown,
  ref: StudioMetricRef | undefined,
  dataSources: Record<string, StudioDataSource>,
) {
  if (!ref) {
    return originalValue;
  }

  const resolvedValue = resolveMetricRef(ref, dataSources);
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
): Row[] {
  // Enrich rows with computed (non-measure) expression field values first so they
  // can be referenced in filters and downstream aggregations.
  const enrichedRows =
    widgetSourceId && expressionFields.length > 0
      ? enrichRowsWithExpressions(widgetRows, expressionFields, widgetSourceId)
      : widgetRows;

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
    const matchingForeignRows = applyFilters(foreignSource.rows, [baseFilter]);

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
    return { fieldId, widgetJoinField: foreignFieldNeeds.find((n) => n.fieldId === fieldId)!.widgetJoinField, map };
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
    score: (data.seriesData[name] ?? []).reduce((acc, v) => acc + (v ?? 0), 0),
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

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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

/**
 * Apply xGroupBy truncation to an x-axis value.
 * Returns the original value when xGroupBy is not set or the value is not date-like.
 */
function applyXGroupBy(
  value: string | number,
  xGroupBy: XGroupBy | undefined,
): string | number {
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

export function aggregateByField(
  rows: Row[],
  xField: string,
  yField: string,
  xGroupBy?: XGroupBy,
): AggregatedData {
  const grouped = new Map<string | number, number>();

  for (const row of rows) {
    const raw = toXValue(row[xField]);
    const xVal = applyXGroupBy(raw, xGroupBy);
    const yVal = Number(row[yField] ?? 0);

    grouped.set(xVal, (grouped.get(xVal) ?? 0) + yVal);
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
  seriesData: Record<string | number, number[]>;
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

  // Build series data arrays
  const seriesData: Record<string | number, number[]> = {};
  for (const seriesName of seriesNames) {
    seriesData[seriesName] = labels.map((label) => {
      const seriesMap = dataMap.get(label);
      return seriesMap?.get(seriesName) ?? 0;
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
