import dayjs from 'dayjs';
import type { RelativeDateValue } from './filterTypes';
import type { StudioFilterState } from '../models';
import { normalizeToDate } from './temporalUtils';
import { computeDateRangePreset } from './dateRangeUtils';

type Row = Record<string, unknown>;

/**
 * Resolves a single filter's non-custom date-range preset to a concrete
 * `{ from, to }` value using the current date. Returns the filter unchanged when
 * it carries no preset, a `'custom'` preset, or a `RelativeDateValue`.
 *
 * The preset is resolved regardless of `scope.kind`: dashboard-date-range filters
 * AND widget-scoped presets (e.g. a per-KPI date range from `setWidgetDateRange`)
 * both need fresh dates at query time. Resolving only `dashboard-date-range`
 * scopes is what silently dropped widget-scoped presets as "incomplete" (their
 * `value` stayed `null`).
 *
 * The single source of truth for preset resolution, shared by
 * `resolveDateRangePresets` (pipeline) and `kpiUtils.extractDateRange` (KPI trend).
 */
export function resolveDateRangePreset(filter: StudioFilterState): StudioFilterState {
  if (
    !filter.dateRangePreset ||
    filter.dateRangePreset === 'custom' ||
    isRelativeDateValue(filter.value)
  ) {
    return filter;
  }
  const { from, to } = computeDateRangePreset(filter.dateRangePreset);
  // For a datetime column the end bound must cover the whole last day. Anchor it to the end of
  // the day in UTC (`…T23:59:59.999Z`) so BOTH bounds share one timezone interpretation: the
  // bare-date `from` parses as UTC midnight, and rows are normalized to UTC ISO on ingestion, so
  // a UTC end-of-day keeps the two ends of the window in the same zone. A zone-less
  // `…T23:59:59` parsed as LOCAL time, mixing zones across the one preset window (finding 1.3).
  const resolvedTo = filter.fieldType === 'datetime' ? `${to}T23:59:59.999Z` : to;
  return { ...filter, value: { from, to: resolvedTo } };
}

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
 * state) are always recomputed fresh from the preset key so stale dates self-heal —
 * regardless of scope (dashboard-date-range or widget).
 *
 * Custom presets (`dateRangePreset === 'custom'`) are always left unchanged — they
 * carry the user's explicit date selection in `value`.
 */
export function resolveDateRangePresets(filters: StudioFilterState[]): StudioFilterState[] {
  if (
    !filters.some(
      (f) => f.dateRangePreset && f.dateRangePreset !== 'custom' && !isRelativeDateValue(f.value),
    )
  ) {
    return filters;
  }
  return filters.map(resolveDateRangePreset);
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
 * Day-granularity comparable for `equals`/`not_equals` on `date`/`datetime` fields.
 *
 * A `datetime` column stores a full timestamp, but an equality/inequality against a
 * date-only picker value must match the WHOLE day — not only the exact-midnight rows that
 * `toComparable`'s full-ISO form would (which contradicted ARCHITECTURE.md's "in-memory
 * equality matches the whole day against a DATETIME column"). Truncating both sides to
 * `YYYY-MM-DD` matches the day for both `date` (already day-granular) and `datetime`.
 */
function toDayComparable(
  val: unknown,
  fieldType?: 'string' | 'number' | 'boolean' | 'date' | 'datetime',
): number | string {
  const c = toComparable(val, fieldType);
  return typeof c === 'string' ? c.slice(0, 10) : c;
}

/** True when a `between` bound is actually set — a genuine `0` (or `false`) bound counts as present. */
export function hasBetweenBound(v: unknown): boolean {
  return v != null && v !== '';
}

/**
 * True when a date/datetime filter-side value carries NO time-of-day — a bare `YYYY-MM-DD`
 * string, or a `RelativeDateValue` (which resolves to a bare `YYYY-MM-DD` via
 * `resolveRelativeDate`).
 *
 * Such a bound must be compared at DAY granularity against a `datetime` column so it covers
 * the whole calendar day rather than only the exact-midnight instant its full-ISO form
 * (`…T00:00:00.000Z`) would (finding 1.3): `>=`/`<=`/`between` bounds become inclusive of the
 * entire day and `>`/`<` exclusive of it. A value carrying an explicit time (e.g. a preset's
 * resolved end-of-day instant) keeps full-timestamp precision.
 */
function isDateOnlyFilterValue(val: unknown): boolean {
  if (isRelativeDateValue(val)) {
    return true;
  }
  return typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val);
}

/**
 * Builds the comparable filter constant and a matching row-value comparator for a single
 * date/datetime ordering bound, choosing day granularity when the filter value is date-only
 * (see `isDateOnlyFilterValue`). Both sides always use the SAME granularity so the comparison
 * is well-defined. Row values still route through `toComparable`/`toDayComparable` so numeric
 * timestamps (e.g. from columnar sources) are normalized to ISO before comparison.
 */
function compileDateBound(
  filterVal: unknown,
  fieldType: StudioFilterState['fieldType'],
): { cmpVal: number | string; rowComparable: (rv: unknown) => number | string } {
  if (isDateOnlyFilterValue(filterVal)) {
    return {
      cmpVal: toDayComparable(filterVal, fieldType),
      rowComparable: (rv) => toDayComparable(rv, fieldType),
    };
  }
  return {
    cmpVal: toComparable(filterVal, fieldType),
    rowComparable: (rv) => toComparable(rv, fieldType),
  };
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
    // The multi-select "Exclude" toggle flips the operator to `not_in`; the compiled
    // test must EXCLUDE the selected values. Without this branch an Exclude selection is
    // byte-identical to Include and silently filters TO exactly the excluded values.
    if (operator === 'not_in') {
      return (row) => !selectedSet.has(String(row[field] ?? ''));
    }
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
      if (fieldType === 'date' || fieldType === 'datetime') {
        // Route both sides through toDayComparable (day granularity) so a RelativeDateValue is
        // resolved and Date/ISO/timestamp forms are normalized, AND a `datetime` column matches
        // the whole day rather than only exact midnight. Raw `==` here made "On" + relative mode
        // never match (hiding all rows); a full-ISO compare made a `datetime` "On" filter match
        // only midnight rows (contradicting ARCHITECTURE.md).
        const cmpVal = toDayComparable(filterVal, fieldType);
        return (row) => {
          const rv = row[field];
          return rv != null && toDayComparable(rv, fieldType) === cmpVal;
        };
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
      if (fieldType === 'date' || fieldType === 'datetime') {
        // Mirror of `equals`: normalize both sides via toDayComparable (day granularity, so a
        // `datetime` "not On" excludes the whole day, not only midnight). A null/absent row value
        // is treated as "not equal" to the target date (kept, matching raw `!=`).
        const cmpVal = toDayComparable(filterVal, fieldType);
        return (row) => {
          const rv = row[field];
          return rv == null || toDayComparable(rv, fieldType) !== cmpVal;
        };
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
      if (fieldType === 'date' || fieldType === 'datetime') {
        // A bare-date filter value compares at day granularity so `>` a date excludes the
        // WHOLE of that day on a datetime column (finding 1.3); a value with an explicit time
        // keeps full precision. Row values route through the same comparator so numeric
        // timestamps (e.g. from columnar sources) are normalized to ISO before comparison —
        // with a fast path for already-canonical ISO strings, so no perf regression.
        const { cmpVal, rowComparable } = compileDateBound(filterVal, fieldType);
        return (row) => {
          const rv = row[field];
          return rv != null && rowComparable(rv) > cmpVal;
        };
      }
      const cmpVal = toComparable(filterVal, fieldType);
      if (fieldType === 'number') {
        const n = cmpVal as number;
        return (row) => Number(row[field]) > n;
      }
      return (row) => toComparable(row[field], fieldType) > cmpVal;
    }
    case 'less_than': {
      if (fieldType === 'date' || fieldType === 'datetime') {
        // Day granularity for a bare-date value so `<` a date excludes the whole of that day.
        const { cmpVal, rowComparable } = compileDateBound(filterVal, fieldType);
        return (row) => {
          const rv = row[field];
          return rv != null && rowComparable(rv) < cmpVal;
        };
      }
      const cmpVal = toComparable(filterVal, fieldType);
      if (fieldType === 'number') {
        const n = cmpVal as number;
        return (row) => Number(row[field]) < n;
      }
      return (row) => toComparable(row[field], fieldType) < cmpVal;
    }
    case 'greater_than_or_equal': {
      if (fieldType === 'date' || fieldType === 'datetime') {
        // Day granularity for a bare-date value so `>=` a date includes the whole of that day.
        const { cmpVal, rowComparable } = compileDateBound(filterVal, fieldType);
        return (row) => {
          const rv = row[field];
          return rv != null && rowComparable(rv) >= cmpVal;
        };
      }
      const cmpVal = toComparable(filterVal, fieldType);
      if (fieldType === 'number') {
        const n = cmpVal as number;
        return (row) => Number(row[field]) >= n;
      }
      return (row) => toComparable(row[field], fieldType) >= cmpVal;
    }
    case 'less_than_or_equal': {
      if (fieldType === 'date' || fieldType === 'datetime') {
        // Day granularity for a bare-date value so `<=` a date includes the WHOLE of that day
        // on a datetime column, instead of excluding everything after its midnight — the
        // "at or before Jul 10 drops all of Jul 10" bug (finding 1.3).
        const { cmpVal, rowComparable } = compileDateBound(filterVal, fieldType);
        return (row) => {
          const rv = row[field];
          return rv != null && rowComparable(rv) <= cmpVal;
        };
      }
      const cmpVal = toComparable(filterVal, fieldType);
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
      // `!= null && !== ''` rather than a truthiness check so a genuine `0` bound (e.g.
      // "between 0 and 100") is treated as present rather than absent (finding 2.14/2.25).
      if (fieldType === 'date' || fieldType === 'datetime') {
        // Each bound is compiled independently: a date-only bound compares at day granularity
        // so a bare-date `to` covers the WHOLE last day of a datetime column (inclusive) rather
        // than excluding everything after its midnight (finding 1.3). The two bounds can differ
        // in granularity — e.g. a resolved preset leaves `from` a bare date but `to` an explicit
        // end-of-day instant — and each side compares row values at its own granularity.
        const lower = hasBetweenBound(range.from) ? compileDateBound(range.from, fieldType) : null;
        const upper = hasBetweenBound(range.to) ? compileDateBound(range.to, fieldType) : null;
        return (row) => {
          const rv = row[field];
          if (rv == null) {
            return false;
          }
          if (lower !== null && lower.rowComparable(rv) < lower.cmpVal) {
            return false;
          }
          if (upper !== null && upper.rowComparable(rv) > upper.cmpVal) {
            return false;
          }
          return true;
        };
      }
      const from = hasBetweenBound(range.from) ? toComparable(range.from, fieldType) : null;
      const to = hasBetweenBound(range.to) ? toComparable(range.to, fieldType) : null;
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
      // Generic / non-date, non-number field types (e.g. a `between` filter authored on a
      // `string` field via a host-constructed StudioFilterState or an AI tool call — the UI's
      // per-field-type operator allowlist is not enforced at the mutation boundary). `between`
      // is only meaningful for orderable comparables. `toComparable` coerces a non-ISO string
      // to `Number(...)` → NaN, and every NaN comparison is `false`, so without these guards
      // the range checks below would never fire and the filter would silently keep EVERY row —
      // a no-op that matches everything (finding 2.14). Fail closed instead: an un-orderable
      // bound (NaN) or row value cannot be "within" a range, so exclude rather than include it.
      const fromInvalid = typeof from === 'number' && Number.isNaN(from);
      const toInvalid = typeof to === 'number' && Number.isNaN(to);
      if (fromInvalid || toInvalid) {
        return () => false;
      }
      return (row) => {
        const cmp = toComparable(row[field], fieldType);
        if (typeof cmp === 'number' && Number.isNaN(cmp)) {
          return false;
        }
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

/**
 * True when a (operator, value) pair is a fully-specified condition. Exported for reuse by
 * `createBatchingAdapter.ts`, which must decide whether a leaf's SECOND condition is "present"
 * using the exact same rule the in-memory evaluator uses — a valueless operator (`is_empty`/
 * `is_not_empty`) is complete/present with no value at all (finding 2.8).
 */
export function isConditionComplete(
  operator: StudioFilterState['operator'],
  value: unknown,
): boolean {
  if (operator === 'is_empty' || operator === 'is_not_empty') {
    return true;
  }
  if (operator === 'between') {
    const range = value as { from?: unknown; to?: unknown } | null;
    // A genuine `0` bound must count as "set" — a truthiness check treated it as absent,
    // marking an otherwise-complete "between 0 and N" condition incomplete (finding 2.14/2.25).
    return hasBetweenBound(range?.from) || hasBetweenBound(range?.to);
  }
  if (isRelativeDateValue(value)) {
    return true;
  }
  return value !== '' && value != null;
}

/**
 * True when a filter is fully authored and should actually constrain rows. Exported so the query
 * descriptor builder can prune incomplete filters (an empty-value condition or an empty selection)
 * before they reach the server filter tree — otherwise the drawer's add-filter default
 * (`{ operator: 'equals', value: '' }`) would ship as a real `col = ''` predicate and an empty
 * selection would invert to match-nothing, both diverging from the in-memory evaluator which drops
 * them here (findings T1.1 / T2.3).
 */
export function isFilterComplete(filter: StudioFilterState): boolean {
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

  // Apply condition and selection filters FIRST, then rank (dataset-level reduction) AFTER.
  // This "filter then rank" order matches the adapter push-down path — which evaluates
  // translatable condition predicates server-side and only re-applies the rank reduction on the
  // returned rows client-side — so an adapter-backed and an in-memory source produce identical
  // numbers for the same dashboard (finding 2.4). It is also the standard BI convention: a
  // "top 5 regions" rank should rank the regions that survive the other filters, not rank the
  // whole dataset and then filter the survivors.
  //
  // Condition/selection filters are compiled once per filter (not per row) so the filter-side
  // constants (toComparable() / normalizeToDate() / toLowerCase()) are computed a single time.
  const rowFilters = active.filter((f) => (f.filterMode ?? 'condition') !== 'rank');
  let result = rows;
  if (rowFilters.length > 0) {
    const tests = rowFilters.map(compileRowTest);
    result =
      tests.length === 1
        ? result.filter(tests[0])
        : result.filter((row) => tests.every((test) => test(row)));
  }

  const rankFilters = active.filter((f) => (f.filterMode ?? 'condition') === 'rank');
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

  return result;
}
