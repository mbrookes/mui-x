import dayjs from 'dayjs';
import type { RelativeDateValue } from './filterTypes';
import type { StudioDataSource, StudioFilterState, StudioMetricRef } from '../models';
import { normalizeToDate } from './temporalUtils';

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

/**
 * Compiles a filter into a fast row-test function.
 *
 * Per-row work in matchesFilter was calling toComparable(filterVal, fieldType) on
 * every row even though the filter value never changes during a dataset scan.
 * compileRowTest pre-computes all filter-side constants (comparable values,
 * lower-cased strings, range bounds, candidate Sets) once and returns a closure
 * that only touches the row value per call. At 100k rows this reduces repeated
 * normalizeToDate / Number() / regex work by ~100 000×.
 */
function compileRowTest(filter: StudioFilterState): (row: Row) => boolean {
  const { field, operator, value: filterVal, fieldType, value2, operator2, conjunction } = filter;
  const mode = filter.filterMode ?? 'condition';

  if (mode === 'selection') {
    const selected = Array.isArray(filterVal) ? (filterVal as string[]) : [];
    if (selected.length === 0) {
      return () => true;
    }
    const selectedSet = new Set(selected.map((v) => String(v)));
    return (row) => selectedSet.has(String(row[field] ?? ''));
  }

  if (mode === 'rank') {
    return () => true;
  }

  const primary = compileSingleCondition(field, operator, filterVal, fieldType);
  if (!operator2 || !isConditionComplete(operator2, value2)) {
    return primary;
  }
  const secondary = compileSingleCondition(field, operator2, value2, fieldType);
  if (conjunction === 'or') {
    return (row) => primary(row) || secondary(row);
  }
  return (row) => primary(row) && secondary(row);
}

function compileSingleCondition(
  field: string,
  operator: StudioFilterState['operator'],
  filterVal: unknown,
  fieldType: StudioFilterState['fieldType'],
): (row: Row) => boolean {
  switch (operator) {
    case 'equals':
      if (fieldType === 'boolean') {
        const fStr = String(filterVal);
        return (row) => String(row[field]) === fStr;
      }
      // eslint-disable-next-line eqeqeq
      return (row) => row[field] == filterVal;
    case 'in': {
      if (!Array.isArray(filterVal)) {
        return () => true;
      }
      // eslint-disable-next-line eqeqeq
      return (row) => filterVal.some((candidate) => row[field] == candidate);
    }
    case 'not_in': {
      if (!Array.isArray(filterVal)) {
        return () => true;
      }
      // eslint-disable-next-line eqeqeq
      return (row) => !filterVal.some((candidate) => row[field] == candidate);
    }
    case 'not_equals':
      if (fieldType === 'boolean') {
        const fStr = String(filterVal);
        return (row) => String(row[field]) !== fStr;
      }
      // eslint-disable-next-line eqeqeq
      return (row) => row[field] != filterVal;
    case 'contains': {
      const needle = String(filterVal ?? '').toLowerCase();
      return (row) =>
        String(row[field] ?? '')
          .toLowerCase()
          .includes(needle);
    }
    case 'does_not_contain': {
      const needle = String(filterVal ?? '').toLowerCase();
      return (row) =>
        !String(row[field] ?? '')
          .toLowerCase()
          .includes(needle);
    }
    case 'starts_with': {
      const needle = String(filterVal ?? '').toLowerCase();
      return (row) =>
        String(row[field] ?? '')
          .toLowerCase()
          .startsWith(needle);
    }
    case 'not_starts_with': {
      const needle = String(filterVal ?? '').toLowerCase();
      return (row) =>
        !String(row[field] ?? '')
          .toLowerCase()
          .startsWith(needle);
    }
    case 'ends_with': {
      const needle = String(filterVal ?? '').toLowerCase();
      return (row) =>
        String(row[field] ?? '')
          .toLowerCase()
          .endsWith(needle);
    }
    case 'not_ends_with': {
      const needle = String(filterVal ?? '').toLowerCase();
      return (row) =>
        !String(row[field] ?? '')
          .toLowerCase()
          .endsWith(needle);
    }
    case 'is_empty':
      return (row) => row[field] == null || String(row[field]) === '';
    case 'is_not_empty':
      return (row) => row[field] != null && String(row[field]) !== '';
    case 'greater_than': {
      const cmpVal = toComparable(filterVal, fieldType);
      if (fieldType === 'date' || fieldType === 'datetime') {
        // Row values are already normalized ISO strings from normalizeDataSourceRows.
        // Direct string comparison is correct (ISO sorts lexicographically) and avoids
        // new Date() per row.
        return (row) => {
          const rv = row[field];
          return rv != null && String(rv) > cmpVal;
        };
      }
      if (fieldType === 'number') {
        const n = cmpVal as number;
        return (row) => Number(row[field]) > n;
      }
      return (row) => toComparable(row[field], fieldType) > cmpVal;
    }
    case 'less_than': {
      const cmpVal = toComparable(filterVal, fieldType);
      if (fieldType === 'date' || fieldType === 'datetime') {
        return (row) => {
          const rv = row[field];
          return rv != null && String(rv) < cmpVal;
        };
      }
      if (fieldType === 'number') {
        const n = cmpVal as number;
        return (row) => Number(row[field]) < n;
      }
      return (row) => toComparable(row[field], fieldType) < cmpVal;
    }
    case 'greater_than_or_equal': {
      const cmpVal = toComparable(filterVal, fieldType);
      if (fieldType === 'date' || fieldType === 'datetime') {
        return (row) => {
          const rv = row[field];
          return rv != null && String(rv) >= cmpVal;
        };
      }
      if (fieldType === 'number') {
        const n = cmpVal as number;
        return (row) => Number(row[field]) >= n;
      }
      return (row) => toComparable(row[field], fieldType) >= cmpVal;
    }
    case 'less_than_or_equal': {
      const cmpVal = toComparable(filterVal, fieldType);
      if (fieldType === 'date' || fieldType === 'datetime') {
        return (row) => {
          const rv = row[field];
          return rv != null && String(rv) <= cmpVal;
        };
      }
      if (fieldType === 'number') {
        const n = cmpVal as number;
        return (row) => Number(row[field]) <= n;
      }
      return (row) => toComparable(row[field], fieldType) <= cmpVal;
    }
    case 'between': {
      const range = filterVal as { from?: string; to?: string } | null;
      if (!range || typeof range !== 'object') {
        return () => true;
      }
      const from = range.from ? toComparable(range.from, fieldType) : null;
      const to = range.to ? toComparable(range.to, fieldType) : null;
      if (fieldType === 'date' || fieldType === 'datetime') {
        return (row) => {
          const rv = row[field];
          if (rv == null) {
            return false;
          }
          const s = String(rv);
          if (from !== null && s < from) {
            return false;
          }
          if (to !== null && s > to) {
            return false;
          }
          return true;
        };
      }
      if (fieldType === 'number') {
        const numFrom = from as number | null;
        const numTo = to as number | null;
        return (row) => {
          const cmp = Number(row[field]);
          if (numFrom !== null && cmp < numFrom) {
            return false;
          }
          if (numTo !== null && cmp > numTo) {
            return false;
          }
          return true;
        };
      }
      return (row) => {
        const cmp = toComparable(row[field], fieldType);
        if (from !== null && cmp < from) {
          return false;
        }
        if (to !== null && cmp > to) {
          return false;
        }
        return true;
      };
    }
    default:
      return () => true;
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

  // Apply condition and selection filters row-by-row using pre-compiled test functions.
  // Compiling once per filter (not per row) avoids redundant toComparable() /
  // normalizeToDate() / toLowerCase() work on filter-side constants.
  const rowFilters = active.filter((f) => (f.filterMode ?? 'condition') !== 'rank');
  if (rowFilters.length === 0) {
    return result;
  }
  const tests = rowFilters.map(compileRowTest);
  if (tests.length === 1) {
    return result.filter(tests[0]);
  }
  return result.filter((row) => tests.every((test) => test(row)));
}
