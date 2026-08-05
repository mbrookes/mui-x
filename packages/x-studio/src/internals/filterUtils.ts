import dayjs from 'dayjs';
import type { RelativeDateUnit, RelativeDateValue } from './filterTypes';
import type { StudioFilterState } from '../models';
import { normalizeToDate, normalizeToDateOnlyString } from './temporalUtils';
import { computeDateRangePreset } from './dateRangeUtils';
import {
  accumulateValue,
  coerceAggregateValue,
  compareRankScores,
  createAggregateAccumulator,
  finalizeAccumulator,
  type AggregateAccumulator,
} from './aggregate';
import { normalizeJoinKey } from './joinKeys';

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
  // `…T23:59:59` parsed as LOCAL time, mixing zones across the one preset window.
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

/** Units finer than a calendar day — their resolved boundary must keep a time-of-day component. */
const SUB_DAY_RELATIVE_UNITS: ReadonlySet<RelativeDateUnit> = new Set(['hour', 'minute', 'second']);

/** True when `unit` is sub-day (second/minute/hour), i.e. NOT safe to truncate to `YYYY-MM-DD`. */
export function isSubDayRelativeUnit(unit: RelativeDateUnit): boolean {
  return SUB_DAY_RELATIVE_UNITS.has(unit);
}

/**
 * The REFRESH CADENCE of a relative date, in milliseconds — NOT the filter's own unit.
 *
 * `resolveRelativeDateNowMs` floors the current instant to a multiple of this value, and
 * `resolveRelativeDate` offsets the filter's amount/unit from that floored instant. Everything
 * downstream of a `RelativeDateValue` — the comparison bound compiled by `compileRowTest`, the
 * wire value serialized by `createSimpleAdapter`/`createBatchingAdapter`, and the L3 row-cache
 * fingerprint built by `resolvedRowsCache.filterFingerprint` — is derived from that one value,
 * so predicate and cache key are identical BY CONSTRUCTION rather than by convention.
 *
 * Why a fixed cadence rather than the filter's own unit:
 * - Quantizing to the filter's unit would make "last 1 hour" mean "since the top of the hour an
 *   hour ago" — a window that grows to 1h59m just before the hour rolls over.
 * - Not quantizing at all (raw `Date.now()`) moves the bound every millisecond, so the L3 cache
 *   key changes on every call: a 100% miss rate, a fresh `Row[]` identity that also misses every
 *   `computedCache` entry, and a bounded LRU churning through full retained result arrays.
 *
 * With a fixed cadence, "last 1 hour" is a TRUE rolling hour that is re-resolved once per tick,
 * so the window is exact to within one cadence period, and the cache key changes exactly once per
 * tick. One minute is the default: it bounds staleness to a minute (below the granularity at
 * which a dashboard viewer perceives a rolling window as wrong) while leaving the cache warm
 * across the burst of renders a single interaction produces. Lowering it trades cache hit rate
 * for freshness; the second-unit filters reachable from `RelativeDateInput` are refreshed at this
 * same cadence, not per second.
 */
export const RELATIVE_DATE_REFRESH_CADENCE_MS = 60_000;

/**
 * "Now", floored to `RELATIVE_DATE_REFRESH_CADENCE_MS`, as epoch milliseconds.
 *
 * Every consumer of a `RelativeDateValue` resolves through this single instant, so a filter's
 * predicate bound and its cache key can never disagree within one cadence tick. Epoch-flooring is
 * timezone-independent for a whole-minute cadence: every real UTC offset is a whole number of
 * minutes, so an epoch-minute boundary is a wall-clock minute boundary everywhere.
 */
export function resolveRelativeDateNowMs(): number {
  return (
    Math.floor(Date.now() / RELATIVE_DATE_REFRESH_CADENCE_MS) * RELATIVE_DATE_REFRESH_CADENCE_MS
  );
}

/**
 * Resolves a `RelativeDateValue` to a concrete wire/comparison value, offset from the
 * cadence-floored "now" (`resolveRelativeDateNowMs`).
 *
 * `day`/`week`/`month`/`year` units resolve to a bare `YYYY-MM-DD` string — these follow the L1
 * canonical whole-day convention (`normalizeToDateOnlyString`) because "N days/weeks/months/years
 * ago" is inherently a calendar-day-granular concept.
 *
 * `second`/`minute`/`hour` units resolve to a full ISO-8601 UTC instant
 * (`YYYY-MM-DDTHH:mm:ss.sssZ`) instead, so a filter authored as "after 1 hour ago" compares at
 * hour-level precision rather than resolving to "after start of today" (which truncating every
 * unit to `YYYY-MM-DD` used to do, silently widening the window to the whole current day).
 * Callers comparing at full timestamp precision are `isDateOnlyFilterValue`/`compileDateBound` in
 * this file plus the wire-serialization paths in `createBatchingAdapter.ts`/
 * `createSimpleAdapter.ts`.
 *
 * The returned sub-day instant therefore lands on a cadence boundary — at 10:59:30 a "1 hour ago"
 * bound is `09:59:00`, not `09:00:00` and not `09:59:30`. The offset from "now" is always exactly
 * the requested amount of the requested unit; only the anchor is quantized, and only to the
 * cadence. See `RELATIVE_DATE_REFRESH_CADENCE_MS` for why.
 *
 * dayjs's `toISOString()` always renders in UTC regardless of the runtime's local timezone, so the
 * resolved instant is unambiguous — unlike the bare `YYYY-MM-DD` form (parsed as UTC midnight by
 * convention elsewhere in this file), a sub-day value carries its own explicit `Z` offset.
 */
export function resolveRelativeDate(rel: RelativeDateValue): string {
  const now = dayjs(resolveRelativeDateNowMs());
  const result =
    rel.direction === 'past' ? now.subtract(rel.amount, rel.unit) : now.add(rel.amount, rel.unit);
  // Day/week/month/year truncate to a calendar boundary because that IS their intended
  // semantics ("last 3 days" means 3 whole days). Sub-day units keep the time-of-day
  // component so "last 1 hour" means one hour, not the whole current day.
  return isSubDayRelativeUnit(rel.unit) ? result.toISOString() : result.format('YYYY-MM-DD');
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
    // Normalize Date objects, ms timestamps, and any string format so comparisons are
    // correct regardless of how the data source stores dates.
    if (fieldType === 'date') {
      // Rows that went through L1 ingestion (`normalizeDataSourceRows` in temporalUtils.ts,
      // via `normalizedRowsCache`) already carry a canonical zoned `YYYY-MM-DD` string, so
      // reading the UTC calendar date straight off `new Date(...).toISOString()` is safe.
      // But some rows reaching filter comparisons never went through L1 — a foreign row
      // pulled in during a cross-filter semi-join, or an L4 re-filtered anchor/remote/
      // junction row — and can still carry a raw local-time `Date`/non-ISO string. Reading
      // its UTC calendar date directly would day-shift by one day for UTC+ viewers, so reuse
      // the SAME timezone-safe day-string helper L1 itself uses rather than reimplementing it.
      return normalizeToDateOnlyString(val) ?? String(val ?? '');
    }
    const d = normalizeToDate(val);
    if (d) {
      return d.toISOString();
    }
    return String(val ?? '');
  }
  if (fieldType === 'number') {
    return toNumericValue(val);
  }
  if (fieldType === 'string') {
    // Explicit `string` fields compare LEXICOGRAPHICALLY. Without this branch a string field
    // fell through to `Number(val)` → `NaN`, and every relational comparison against `NaN` is
    // `false` — so a host- or AI-authored `{ field: 'name', fieldType: 'string',
    // operator: 'greater_than', value: 'M' }` passed `isFilterComplete`, compiled cleanly, and
    // returned ZERO rows with no error or warning. Of the three possible resolutions (support
    // it, throw, or keep silently returning nothing) the first is chosen because: the operator
    // is reachable from the filter drawer and from the AI mutation surface, JS relational
    // operators on strings are well-defined (UTF-16 code-unit order), and "0 rows, no
    // diagnostic" is the one outcome a user can neither see nor debug.
    //
    // Both sides of every comparison route through here, so the filter constant and the row
    // value always share the same representation. `?? ''` normalizes a nullish value to the
    // empty string; the ordering operators additionally reject nullish ROW values outright (see
    // the `rv != null` guards in `compileSingleCondition`) so a null never sorts below every
    // bound.
    return String(val ?? '');
  }
  // Fallback: detect ISO date strings by shape
  if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}/.test(val)) {
    return val;
  }
  return Number(val);
}

/**
 * Numeric coercion for `number`-typed field comparisons.
 *
 * `Number(val)` alone is too permissive at the boundaries that matter for filtering:
 * `Number('') === 0`, `Number(false) === 0`, `Number(null) === 0`, `Number([]) === 0`. A CSV whose
 * blank numeric cells import as `''` therefore made every blank row compare EQUAL to zero — a
 * "count of orders with zero discount" KPI counted every blank row as a zero-discount order — and
 * `false` matched `'0'`. Only genuine numbers and numeric strings are coerced here; everything
 * else (nullish, boolean, object, blank/whitespace-only string, non-numeric string) becomes `NaN`,
 * which every comparison operator rejects. That matches the existing convention in this file that
 * an ABSENT value is excluded from a numeric comparison rather than silently treated as `0`.
 */
function toNumericValue(val: unknown): number {
  if (typeof val === 'number') {
    return val;
  }
  if (typeof val === 'string') {
    // `Number(' ')` is `0`; a whitespace-only cell is as absent as an empty one.
    return val.trim() === '' ? NaN : Number(val);
  }
  return NaN;
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
 * string, or a `RelativeDateValue` whose unit is day-or-coarser (which resolves to a bare
 * `YYYY-MM-DD` via `resolveRelativeDate`).
 *
 * A `RelativeDateValue` with a SUB-DAY unit (second/minute/hour) resolves to a full ISO instant
 * instead, so it must NOT be treated as date-only here — doing so used to compare it at day
 * granularity regardless of unit, which made an "after 1 hour ago" filter behave like "after the
 * start of today" (silently including the whole current day).
 *
 * Such a day-only bound must be compared at DAY granularity against a `datetime` column so it
 * covers the whole calendar day rather than only the exact-midnight instant its full-ISO form
 * (`…T00:00:00.000Z`) would: `>=`/`<=`/`between` bounds become inclusive of the
 * entire day and `>`/`<` exclusive of it. A value carrying an explicit time (e.g. a preset's
 * resolved end-of-day instant, or a sub-day `RelativeDateValue`) keeps full-timestamp precision.
 */
function isDateOnlyFilterValue(val: unknown): boolean {
  if (isRelativeDateValue(val)) {
    return !isSubDayRelativeUnit(val.unit);
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
 * Filter-side candidate index for condition-mode `in` / `not_in` AND for selection mode, built
 * ONCE per compiled filter.
 *
 * Both modes route through this one function, so they cannot drift apart on how a candidate is
 * keyed. `String(v ?? '')` is the same policy the ROW side uses (`String(row[field] ?? '')`), so a
 * nullish candidate matches the empty/nullish rows rather than the literal rows spelling
 * `"null"`/`"undefined"` — a selection built with `String(v)` instead encoded `null` as `"null"`
 * and matched nothing, while the same value as a condition-mode `in` matched every empty row.
 */
function buildCandidateSet(candidates: readonly unknown[]): Set<string> {
  const set = new Set<string>();
  for (const candidate of candidates) {
    set.add(String(candidate ?? ''));
  }
  return set;
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
    // Same candidate-keying policy as condition-mode `in`/`not_in` (see `buildCandidateSet`):
    // a nullish selected value keys as `''` and therefore matches the empty/nullish rows,
    // which key as `''` too.
    const selectedSet = buildCandidateSet(selected);
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
      if (fieldType === 'number') {
        // Numeric equality compares NUMBERS, not loose-`==` operands. The old
        // `row[field] == filterVal` made `'' == 0` and `false == '0'` both true, so a CSV whose
        // blank numeric cells import as `''` counted every blank row as a genuine zero (see
        // `toNumericValue`). A numeric STRING row/filter value still coerces (`'20'` matches
        // `20`) — that behaviour is relied on by callers that pass the raw text-input value.
        const n = toNumericValue(filterVal);
        return (row) => {
          const rv = row[field];
          return rv != null && toNumericValue(rv) === n;
        };
      }
      // String / untyped fields: compare STRING representations rather than with loose `==`,
      // mirroring the `boolean` branch above. Loose `==` cross-coerces (`'' == 0`, `0 == false`,
      // `1 == true`) so unrelated falsy values matched each other; `String(...)` compares what the
      // user actually sees. A nullish row value never equals a (necessarily non-nullish, per
      // `isConditionComplete`) filter value.
      {
        const fStr = String(filterVal);
        return (row) => {
          const rv = row[field];
          return rv != null && String(rv) === fStr;
        };
      }
    case 'in': {
      if (!Array.isArray(filterVal)) {
        return () => true;
      }
      // Build the candidate `Set` ONCE per filter rather than re-scanning the array per row.
      // The per-row `filterVal.some(...)` scan was O(rows × candidates): a 2 000-value residual
      // `not_in` over 200k rows meant 400M loose comparisons on every pipeline pass. This mirrors
      // what selection mode already does at the top of `compileRowTest`, and uses the same
      // `String(v ?? '')` key policy so the two modes agree on what "the same value" means
      // (loose `==` also cross-coerced here: `0` matched `''` and `false`).
      const candidates = buildCandidateSet(filterVal);
      return (row) => candidates.has(String(row[field] ?? ''));
    }
    case 'not_in': {
      if (!Array.isArray(filterVal)) {
        return () => true;
      }
      // Set-based mirror of `in` — see above for the O(rows × candidates) rationale.
      const candidates = buildCandidateSet(filterVal);
      return (row) => !candidates.has(String(row[field] ?? ''));
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
      if (fieldType === 'number') {
        // Numeric mirror of `equals` (see there): a blank/whitespace cell or a boolean is NOT
        // numerically equal to `0`, so it stays in a "not equal to 0" result instead of being
        // silently dropped by loose `==`. A nullish row value is kept, matching every other
        // `not_equals` branch and the historical raw `!=`.
        const n = toNumericValue(filterVal);
        return (row) => {
          const rv = row[field];
          return rv == null || toNumericValue(rv) !== n;
        };
      }
      // String / untyped mirror of `equals` — see there for why loose `==` is not used.
      {
        const fStr = String(filterVal);
        return (row) => {
          const rv = row[field];
          return rv == null || String(rv) !== fStr;
        };
      }
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
        // WHOLE of that day on a datetime column; a value with an explicit time
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
        // `toNumericValue` (not `Number`) so a blank/whitespace cell or a boolean is NOT coerced
        // to `0` and compared as a real zero — the same policy `equals` uses. Non-numeric row
        // values become `NaN`, and every `NaN` comparison is `false`, so they are excluded from
        // the ordering exactly like the explicitly-guarded nullish ones.
        return (row) => {
          const rv = row[field];
          return rv != null && toNumericValue(rv) > n;
        };
      }
      // Generic branch — `string` fields (lexicographic, see `toComparable`) and untyped fields.
      // The `rv != null` guard matches the date and number branches above: a missing value has no
      // position in an ordering, so it is excluded rather than compared as `''`/`0`.
      return (row) => {
        const rv = row[field];
        return rv != null && toComparable(rv, fieldType) > cmpVal;
      };
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
        // `toNumericValue` + `rv != null` guard — see `greater_than` above.
        return (row) => {
          const rv = row[field];
          return rv != null && toNumericValue(rv) < n;
        };
      }
      // Generic (string/untyped) branch — see `greater_than` above.
      return (row) => {
        const rv = row[field];
        return rv != null && toComparable(rv, fieldType) < cmpVal;
      };
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
        // `toNumericValue` + `rv != null` guard — see `greater_than` above.
        return (row) => {
          const rv = row[field];
          return rv != null && toNumericValue(rv) >= n;
        };
      }
      // Generic (string/untyped) branch — see `greater_than` above.
      return (row) => {
        const rv = row[field];
        return rv != null && toComparable(rv, fieldType) >= cmpVal;
      };
    }
    case 'less_than_or_equal': {
      if (fieldType === 'date' || fieldType === 'datetime') {
        // Day granularity for a bare-date value so `<=` a date includes the WHOLE of that day
        // on a datetime column, instead of excluding everything after its midnight — the
        // "at or before Jul 10 drops all of Jul 10" bug.
        const { cmpVal, rowComparable } = compileDateBound(filterVal, fieldType);
        return (row) => {
          const rv = row[field];
          return rv != null && rowComparable(rv) <= cmpVal;
        };
      }
      const cmpVal = toComparable(filterVal, fieldType);
      if (fieldType === 'number') {
        const n = cmpVal as number;
        // `toNumericValue` + `rv != null` guard — see `greater_than` above.
        return (row) => {
          const rv = row[field];
          return rv != null && toNumericValue(rv) <= n;
        };
      }
      // Generic (string/untyped) branch — see `greater_than` above.
      return (row) => {
        const rv = row[field];
        return rv != null && toComparable(rv, fieldType) <= cmpVal;
      };
    }
    case 'between': {
      const range = filterVal as { from?: string; to?: string } | null;
      if (!range || typeof range !== 'object') {
        return () => true;
      }
      // `!= null && !== ''` rather than a truthiness check so a genuine `0` bound (e.g.
      // "between 0 and 100") is treated as present rather than absent.
      if (fieldType === 'date' || fieldType === 'datetime') {
        // Each bound is compiled independently: a date-only bound compares at day granularity
        // so a bare-date `to` covers the WHOLE last day of a datetime column (inclusive) rather
        // than excluding everything after its midnight. The two bounds can differ
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
          const rv = row[field];
          // `rv != null` guard: without it `Number(null) === 0` silently treats a null field
          // value as zero instead of excluding the row, inconsistent with the date branch above.
          if (rv == null) {
            return false;
          }
          // `toNumericValue` (not `Number`) for the same reason as the ordering operators: a
          // blank/whitespace cell or a boolean must not be coerced to a real `0`. It yields NaN
          // for those, and NaN fails BOTH range checks below — which would silently KEEP the row
          // (a `NaN < from` / `NaN > to` pair is `false, false`), so reject it explicitly. This
          // is the same fail-closed policy the generic branch below applies.
          const cmp = toNumericValue(rv);
          if (Number.isNaN(cmp)) {
            return false;
          }
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
      // is only meaningful for orderable comparables. `toComparable` coerces an UNTYPED non-ISO
      // string to `Number(...)` → NaN, and every NaN comparison is `false`, so without these
      // guards the range checks below would never fire and the filter would silently keep EVERY
      // row — a no-op that matches everything. Fail closed instead: an
      // un-orderable bound (NaN) or row value cannot be "within" a range, so exclude it.
      //
      // An EXPLICITLY `string`-typed field is no longer un-orderable: `toComparable` now returns
      // the string itself for `fieldType: 'string'`, so `between` on a string field compares
      // lexicographically (matching `greater_than`/`less_than`/… on the same field) and never
      // reaches the NaN fail-close. The guards below still cover the genuinely un-orderable
      // cases — an untyped non-numeric bound, a boolean, an object.
      const fromInvalid = typeof from === 'number' && Number.isNaN(from);
      const toInvalid = typeof to === 'number' && Number.isNaN(to);
      if (fromInvalid || toInvalid) {
        return () => false;
      }
      return (row) => {
        const rv = row[field];
        // Nullish row values are excluded, matching the date and number branches above (and now
        // the ordering operators): a missing value has no position in a range. Without this a
        // `string`-typed row value of `null` would normalize to `''` and fall inside any range
        // whose lower bound is `''`.
        if (rv == null) {
          return false;
        }
        const cmp = toComparable(rv, fieldType);
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
 * `is_not_empty`) is complete/present with no value at all.
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
    // marking an otherwise-complete "between 0 and N" condition incomplete.
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
 * them here.
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
  // numbers for the same dashboard. It is also the standard BI convention: a
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
      // Aggregate rank: group rows by fieldId, sum rankByField, keep top/bottom N groups.
      //
      // The group key routes through `normalizeJoinKey`, the single key-coercion policy every
      // other grouping/joining path in the package uses (`joinKeys` for semi-joins and
      // fan-out dedup, `chartValues.toXValue` for chart buckets). Keying on the RAW row value
      // made grouping depend on JS reference/type identity: two equal-but-distinct `Date`
      // objects became two one-row groups, and a numeric `2024` never grouped with the string
      // `'2024'`. Widget-source rows are L1-normalized so this was usually masked, but
      // L4-re-anchored and foreign rows reaching `applyFilters` carry no such guarantee.
      // Nullish (and non-scalar) dimension values normalize to `null` and form a single
      // "missing" group, which then ranks like any other.
      const totals = new Map<string | null, AggregateAccumulator>();
      for (const row of result) {
        const key = normalizeJoinKey(row[fieldId]);
        // The group key is registered unconditionally — group MEMBERSHIP is not the same
        // question as whether this row carried a usable measurement — but only usable values
        // are folded in. The accumulator's `count` therefore distinguishes "this group summed
        // to 0" from "this group was never measured at all".
        let acc = totals.get(key);
        if (!acc) {
          acc = createAggregateAccumulator();
          totals.set(key, acc);
        }
        // Route the rank-by measure through the SHARED numeric-coercion policy
        // (`coerceAggregateValue`) that every other aggregation path uses, rather than
        // `Number(... ?? 0)`. A non-numeric sentinel ("N/A") would otherwise coerce to NaN,
        // poison the whole group's running total, and corrupt the top-N ordering (NaN
        // comparisons are always false).
        const coerced = coerceAggregateValue(row[f.rankByField]);
        if (coerced !== null) {
          accumulateValue(acc, coerced);
        }
      }
      // `finalizeAccumulator` yields `null` for a group with NO usable measurement, and
      // `compareRankScores` sorts `null` to the losing end in EITHER direction — the same
      // policy the post-aggregation chart rankers apply via `reduceRankScore`.
      // Seeding each group at a concrete `0` (the previous behaviour, whose comment claimed
      // it matched the chart aggregators — it did not) let a no-data group win a "Top 1 by
      // profit" over two genuinely negative groups on every row-level widget, while the bar
      // chart over the same filter picked the real winner.
      const sorted = Array.from(totals.entries())
        .map(([key, acc]) => [key, finalizeAccumulator(acc, 'sum')] as const)
        .sort((a, b) => compareRankScores(a[1], b[1], dir));
      const topKeys = new Set(sorted.slice(0, n).map(([k]) => k));
      // Membership is tested through the SAME normalization the grouping used, so a row can
      // never fall outside every surviving group it contributed a total to.
      result = result.filter((row) => topKeys.has(normalizeJoinKey(row[fieldId])));
    } else {
      // Numeric rank: sort rows by the field value directly. Route through the SHARED
      // numeric-coercion policy (`coerceAggregateValue`) — the same one the `rankByField`
      // branch above uses — rather than `Number(... ?? 0)`. A non-numeric sentinel ("N/A")
      // would otherwise coerce to NaN, making every comparison false so `toSorted` leaves the
      // rows in an arbitrary engine-dependent order and top-N picks a meaningless subset.
      // A row with no usable value scores `null` — "not measured", not 0 —
      // and `compareRankScores` sorts it to the losing end in EITHER direction, so it can
      // never displace a real negative measurement from a Top-N or a real positive one from a
      // Bottom-N. Falling back to 0 here did exactly that, and disagreed with the
      // post-aggregation chart rankers.
      const sorted = result.toSorted((a, b) =>
        compareRankScores(coerceAggregateValue(a[fieldId]), coerceAggregateValue(b[fieldId]), dir),
      );
      result = sorted.slice(0, n);
    }
  }

  return result;
}
