import dayjs from 'dayjs';
import type { RelativeDateValue } from './filterTypes';
import type { StudioFilterState } from '../models';
import { normalizeToDate } from './temporalUtils';
import { computeDateRangePreset } from './dateRangeUtils';

type Row = Record<string, unknown>;

/**
 * Returns a new filter array where any date-range preset filters have been resolved
 * to concrete `{ from, to }` values using the current date.
 *
 * Filters carrying a `RelativeDateValue` (e.g. "12 months ago") are left unchanged —
 * they resolve correctly in `flattenFilterNode` and should be persisted as relative so
 * the date-range picker can display and highlight the correct relative option.
 *
 * All other non-custom preset filters (null values from `setDashboardDateRange` /
 * `setWidgetDateRange`, or stale absolute `{ from, to }` objects from legacy persisted
 * state) are always recomputed fresh from the preset key so stale dates self-heal.
 *
 * Custom presets (`dateRangePreset === 'custom'`) are always left unchanged — they
 * carry the user's explicit date selection in `value`.
 */
export function resolveDateRangePresets(filters: StudioFilterState[]): StudioFilterState[] {
  if (
    !filters.some(
      (f) =>
        f.scopeV2.kind === 'dashboard-date-range' &&
        f.dateRangePreset &&
        f.dateRangePreset !== 'custom' &&
        !isRelativeDateValue(f.value),
    )
  ) {
    return filters;
  }
  return filters.map((f) => {
    if (
      f.scopeV2.kind !== 'dashboard-date-range' ||
      !f.dateRangePreset ||
      f.dateRangePreset === 'custom' ||
      isRelativeDateValue(f.value)
    ) {
      return f;
    }
    const { from, to } = computeDateRangePreset(f.dateRangePreset);
    const resolvedTo = f.fieldType === 'datetime' ? `${to}T23:59:59` : to;
    return { ...f, value: { from, to: resolvedTo } };
  });
}

export function isRelativeDateValue(value: unknown): value is RelativeDateValue {
  return (
    typeof value === 'object' && value !== null && (value as RelativeDateValue).relative === true
  );
}

export function resolveRelativeDate(rel: RelativeDateValue): string {
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
        // Use toComparable on row values so numeric timestamps (e.g. from columnar data
        // sources) are normalized to ISO strings before comparison. toComparable has a
        // fast path for already-canonical ISO strings so there is no perf regression
        // when rows have been pre-normalized by normalizeDataSourceRows.
        return (row) => {
          const rv = row[field];
          return rv != null && toComparable(rv, fieldType) > cmpVal;
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
          return rv != null && toComparable(rv, fieldType) < cmpVal;
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
          return rv != null && toComparable(rv, fieldType) >= cmpVal;
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
          return rv != null && toComparable(rv, fieldType) <= cmpVal;
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
          const s = toComparable(rv, fieldType);
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
  const active = filters.filter((f) => !f.disabled && isFilterComplete(f));
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
      const sorted = result.toSorted((a, b) => {
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
