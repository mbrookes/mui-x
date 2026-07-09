/**
 * Pure utility functions for KPI widget computations.
 * Extracted here so they can be unit-tested independently of the React component.
 */
import { isoWeek } from '@mui/x-studio-schema';
import type {
  StudioDataSource,
  StudioFilterState,
  StudioKpiAggregation,
  StudioExpressionField,
} from '../../../models';
import { normalizeToDate } from '../../../internals/temporalUtils';
import { resolveDateRangePreset } from '../../../internals/filterUtils';
import {
  aggregateNumbers,
  coerceAggregateValue,
  countDistinct,
} from '../../../internals/aggregate';
import { evaluateMeasure } from '../../../utils/expressionEvaluator';
import {
  isRelativeDateValue,
  relativeToAbsolute,
} from '../../StudioFiltersDrawer/filterDrawerUtils';

// ─── Granularity ──────────────────────────────────────────────────────────────

export type Granularity = 'day' | 'week' | 'month' | 'quarter' | 'year';

export function autoGranularity(start: Date, end: Date): Granularity {
  const days = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
  if (days <= 14) {
    return 'day';
  }
  if (days <= 90) {
    return 'week';
  }
  if (days <= 730) {
    return 'month';
  }
  if (days <= 1460) {
    return 'quarter';
  }
  return 'year';
}

// ─── Fixed-period window ──────────────────────────────────────────────────────

/**
 * Computes the rolling "current period" window ending at the given date for
 * fixed-period trend mode. The window is always a contiguous N-day block:
 * - 'month'   → last 30 days
 * - 'quarter' → last 90 days
 * - 'year'    → last 365 days
 */
export function computeFixedPeriodRange(
  period: 'month' | 'quarter' | 'year',
  today: Date,
): { start: Date; end: Date } {
  const PERIOD_DAYS: Record<typeof period, number> = { month: 30, quarter: 90, year: 365 };
  const days = PERIOD_DAYS[period];
  const end = new Date(today);
  end.setHours(23, 59, 59, 999);
  const start = new Date(today);
  start.setDate(start.getDate() - days);
  start.setHours(0, 0, 0, 0);
  return { start, end };
}

/**
 * Filter rows to those where the given date field falls within [start, end] inclusive.
 */
export function filterRowsByDateRange(
  rows: Record<string, unknown>[],
  dateField: string,
  start: Date,
  end: Date,
): Record<string, unknown>[] {
  return rows.filter((row) => {
    const raw = row[dateField];
    if (raw === null || raw === undefined) {
      return false;
    }
    const d = normalizeToDate(raw);
    if (!d) {
      return false;
    }
    return d >= start && d <= end;
  });
}

// ─── Date range extraction ─────────────────────────────────────────────────────

/** Extract a concrete date range [start, end] from a filter value, resolving relative values. */
export function extractDateRange(filter: StudioFilterState): { start: Date; end: Date } | null {
  const toDate = (v: unknown): Date | null => {
    if (!v) {
      return null;
    }
    // Resolve relative date values (e.g. "1 month ago") to concrete date strings first
    const str = isRelativeDateValue(v) ? relativeToAbsolute(v) : (v as string);
    const d = new Date(str);
    return Number.isNaN(d.getTime()) ? null : d;
  };

  // Resolve any non-custom date-range preset to a concrete `{ from, to }` value
  // first — regardless of scope, so a widget-scoped KPI preset is honored the same
  // as a dashboard-date-range one. Shares the single resolver with the pipeline.
  const resolved = resolveDateRangePreset(filter);

  // Handle `operator: 'between'` with a concrete `{ from, to }` value.
  if (resolved.operator === 'between') {
    if (
      resolved.value !== null &&
      typeof resolved.value === 'object' &&
      'from' in (resolved.value as object)
    ) {
      const obj = resolved.value as { from?: string; to?: string };
      const start = toDate(obj.from);
      const end = toDate(obj.to);
      if (start && end) {
        return start <= end ? { start, end } : { start: end, end: start };
      }
    }
    return null;
  }

  const v1 = toDate(resolved.value);
  const v2 = toDate(resolved.value2);

  if (v1 && v2 && resolved.conjunction === 'and') {
    const start = v1 < v2 ? v1 : v2;
    const end = v1 < v2 ? v2 : v1;
    return { start, end };
  }
  if (v1) {
    // Single-sided — the operator decides WHICH side the filter value bounds.
    // Mirrors the display-side interpretation in `internals/widgetUtils.tsx`
    // ("since X" for `greater_than*`, "until X" for `less_than*`).
    const op = resolved.operator;
    if (op === 'less_than' || op === 'less_than_or_equal') {
      // "until X": the filter keeps rows up to (and maybe including) X, so X is
      // the END of the current period — NOT the start. Deriving `{ start: X,
      // end: today }` here (the old, operator-blind behavior) inverted the window
      // to exactly the region the filter excludes (finding 1.11). Mirror the
      // open-ended "since X" window backwards so the derived window has an
      // equivalent length but ends at the filter value. `Math.abs` keeps `start`
      // on or before `end` whether X is in the past (the common case) or future.
      const span = Math.abs(new Date().getTime() - v1.getTime());
      return { start: new Date(v1.getTime() - span), end: v1 };
    }
    // "since X" (`greater_than`/`greater_than_or_equal`, or a legacy filter with
    // no range operator): X is the start, today is the open end.
    return { start: v1, end: new Date() };
  }
  return null;
}

// ─── Date filter lookup ────────────────────────────────────────────────────────

/**
 * Find the first date/datetime filter that applies to this widget (page or widget scope).
 *
 * Uses `filter.fieldType` when available (preferred — works across all data sources).
 * Falls back to looking up the field type in `dataSource.fields` for legacy filters
 * that were stored without a `fieldType`.
 */
export function findDateFilter(
  filters: StudioFilterState[],
  widgetId: string,
  dataSource: StudioDataSource,
): StudioFilterState | undefined {
  const relevant = filters.filter(
    (f) =>
      f.scope.kind === 'page' ||
      f.scope.kind === 'dashboard-date-range' ||
      (f.scope.kind === 'widget' && f.scope.widgetId === widgetId),
  );
  return relevant.find((f) => {
    // Prefer the stored fieldType — reliable even for cross-source filters
    if (f.fieldType === 'date' || f.fieldType === 'datetime') {
      return true;
    }
    // Fallback: look up in the widget's primary data source fields
    const fieldDef = dataSource.fields.find((fd) => fd.id === f.field);
    return fieldDef?.type === 'date' || fieldDef?.type === 'datetime';
  });
}

// ─── Previous period range ─────────────────────────────────────────────────────

/**
 * Format a Date as `YYYY-MM-DD` from its LOCAL calendar components.
 *
 * Mirrors `internals/temporalUtils`'s `toLocalYmd`, and exists for the same reason:
 * the previous-period window boundaries are computed in LOCAL time (see
 * `computePreviousPeriodRange`), so serializing them with `date.toISOString().slice(0, 10)`
 * round-trips through UTC and day-shifts the boundary for any non-UTC viewer
 * (backward for UTC+, forward for UTC-). Formatting the local Y/M/D components keeps
 * the serialized bound on the same calendar day the boundary math produced
 * (finding 1.12 / the package's documented anti-day-shift policy).
 */
export function toLocalYmd(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

type TrendComparison = 'previous-period' | 'previous-calendar-period' | 'year-over-year';

type CalendarPeriod = 'week' | 'month' | 'quarter' | 'year';

/**
 * Classify a date range by the calendar period whose typical length best matches
 * the range, for the `previous-calendar-period` comparison mode.
 *
 * This is deliberately NOT `autoGranularity`: that function's thresholds are tuned
 * for sparkline BUCKETING (how many buckets to draw), which maps any 15–90-day
 * range to `'week'`. Feeding that into the previous-period math shifts a ~monthly
 * range back by a single week, so the "previous" window overlaps the current one
 * and the trend delta degenerates toward a self-comparison (finding 2.18). Here the
 * thresholds are centered on the actual lengths of calendar periods so the previous
 * window never overlaps the current one:
 * - ≤ 10 days  → week    (~7-day range)
 * - ≤ 45 days  → month   (~28–31-day range)
 * - ≤ 135 days → quarter (~90-day range)
 * - otherwise  → year
 */
function comparisonGranularity(start: Date, end: Date): CalendarPeriod {
  const days = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
  if (days <= 10) {
    return 'week';
  }
  if (days <= 45) {
    return 'month';
  }
  if (days <= 135) {
    return 'quarter';
  }
  return 'year';
}

/**
 * Given a current [start, end] date range and a comparison mode, computes the
 * [start, end] of the previous comparison period.
 */
export function computePreviousPeriodRange(
  start: Date,
  end: Date,
  mode: TrendComparison,
): { start: Date; end: Date } {
  if (mode === 'year-over-year') {
    const prevStart = new Date(start);
    prevStart.setFullYear(start.getFullYear() - 1);
    const prevEnd = new Date(end);
    prevEnd.setFullYear(end.getFullYear() - 1);
    return { start: prevStart, end: prevEnd };
  }

  if (mode === 'previous-calendar-period') {
    const granularity = comparisonGranularity(start, end);
    if (granularity === 'year') {
      return {
        start: new Date(start.getFullYear() - 1, 0, 1),
        end: new Date(start.getFullYear() - 1, 11, 31, 23, 59, 59, 999),
      };
    }
    if (granularity === 'quarter') {
      const q = Math.floor(start.getMonth() / 3);
      const prevQ = q === 0 ? 3 : q - 1;
      const prevYear = q === 0 ? start.getFullYear() - 1 : start.getFullYear();
      return {
        start: new Date(prevYear, prevQ * 3, 1),
        end: new Date(prevYear, prevQ * 3 + 3, 0, 23, 59, 59, 999),
      };
    }
    if (granularity === 'week') {
      const ms = 7 * 24 * 60 * 60 * 1000;
      return {
        start: new Date(start.getTime() - ms),
        end: new Date(end.getTime() - ms),
      };
    }
    // month (default)
    const prevMonth = start.getMonth() === 0 ? 11 : start.getMonth() - 1;
    const prevYear = start.getMonth() === 0 ? start.getFullYear() - 1 : start.getFullYear();
    return {
      start: new Date(prevYear, prevMonth, 1),
      end: new Date(prevYear, prevMonth + 1, 0, 23, 59, 59, 999),
    };
  }

  // Default: 'previous-period' — shift by the current window duration
  const duration = end.getTime() - start.getTime();
  return {
    start: new Date(start.getTime() - duration),
    end: new Date(start.getTime() - 1),
  };
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

export function computeAggregate(
  rows: Record<string, unknown>[],
  field: string,
  aggregation: StudioKpiAggregation,
): number {
  if (aggregation === 'count') {
    return rows.length;
  }

  if (aggregation === 'count_distinct') {
    // Distinctness is over the raw cell values (strings, dates, …), so it must not
    // route through the numeric coercion below. `countDistinct` excludes null/undefined
    // (SQL COUNT(DISTINCT) semantic) so the KPI, grid, and measure-expression paths all
    // return the same number for the same field (finding 2.23).
    return countDistinct(rows.map((row) => row[field]));
  }

  // Exclude null/non-numeric values so they don't inflate the denominator for
  // avg/min/max. Boolean fields (e.g. onTime) are coerced to 0/1 so avg produces a
  // ratio. This is the reference null-skip policy shared via `internals/aggregate`.
  const values = rows
    .map((row) => coerceAggregateValue(row[field]))
    .filter((v): v is number => v !== null);

  return aggregateNumbers(values, aggregation);
}

// ─── Sparkline bucketing ──────────────────────────────────────────────────────

export function getBucketKey(date: Date, granularity: Granularity): string {
  const y = date.getFullYear();
  const m = date.getMonth();
  const d = date.getDate();
  switch (granularity) {
    case 'day':
      return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    case 'week': {
      // Use the shared ISO-week helper (also used by `internals/temporalUtils.ts`'s
      // `truncateToGranularity` for the same purpose) so the key is
      // `{year}-W{weekNumber}` and sorts chronologically regardless of month
      // boundaries — a hand-rolled `{year}-W{dayOfMonth}-{month}` key (the previous
      // approach) sorts lexicographically, not chronologically, whenever a week
      // falls in a month whose day-of-month digits compare out of order across a
      // month boundary (see finding 1.11).
      const { year, week } = isoWeek(new Date(Date.UTC(y, m, d)));
      return `${year}-W${String(week).padStart(2, '0')}`;
    }
    case 'month':
      return `${y}-${String(m + 1).padStart(2, '0')}`;
    case 'quarter':
      return `${y}-Q${Math.floor(m / 3) + 1}`;
    case 'year':
      return `${y}`;
    default:
      return `${y}-${String(m + 1).padStart(2, '0')}`;
  }
}

export function computeSparklineData(
  rows: Record<string, unknown>[],
  timeField: string,
  valueField: string,
  aggregation: StudioKpiAggregation,
  granularity: Granularity,
  cumulative: boolean,
  // When the KPI's value field is a measure expression field, measures aggregate
  // themselves via `evaluateMeasure` (their values do not exist per-row — they are
  // never enriched onto rows, unlike calculated columns). Passing the measure field
  // here routes each bucket through the same computation the headline/trend use,
  // instead of `computeAggregate` reading a nonexistent `row[measureId]` and silently
  // producing a flat zero series (finding 2.6).
  measureExprField?: StudioExpressionField,
  expressionFields?: StudioExpressionField[],
): number[] {
  const buckets = new Map<string, Record<string, unknown>[]>();

  for (const row of rows) {
    const raw = row[timeField];
    if (raw === null || raw === undefined) {
      continue;
    }
    const date = normalizeToDate(raw);
    if (!date) {
      continue;
    }
    const key = getBucketKey(date, granularity);
    if (!buckets.has(key)) {
      buckets.set(key, []);
    }
    buckets.get(key)!.push(row);
  }

  const sortedKeys = Array.from(buckets.keys()).sort();
  const periodValues = sortedKeys.map((key) => {
    const bucketRows = buckets.get(key)!;
    // `evaluateMeasure` returns `null` for a bucket it can't compute (e.g. no rows);
    // the sparkline renders plain numbers, so a null bucket collapses to 0 rather
    // than propagating `null` through the cumulative running sum below.
    const value = measureExprField
      ? evaluateMeasure(measureExprField, bucketRows, expressionFields ?? [])
      : computeAggregate(bucketRows, valueField, aggregation);
    return value ?? 0;
  });

  if (!cumulative) {
    return periodValues;
  }

  let running = 0;
  return periodValues.map((v) => {
    running += v;
    return running;
  });
}

// ─── Period formatting ────────────────────────────────────────────────────────

/**
 * Locale-aware short month abbreviation, e.g. "Mar" (en) / "mars" (fr) / "März" (de).
 * Mirrors the `toLocaleDateString` approach already used by the sibling
 * `formatDateRangeLong` below, rather than a hardcoded English month-name array.
 */
function monthAbbr(date: Date): string {
  return date.toLocaleDateString(undefined, { month: 'short' });
}

/** Format a date as a short human-readable label, e.g. "Mar 2026" or "Mar–Apr 2026". */
export function formatPeriodShort(start: Date, end: Date): string {
  if (start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth()) {
    return `${monthAbbr(start)} ${start.getFullYear()}`;
  }
  if (start.getFullYear() === end.getFullYear()) {
    return `${monthAbbr(start)}–${monthAbbr(end)} ${start.getFullYear()}`;
  }
  return `${monthAbbr(start)} ${start.getFullYear()}–${monthAbbr(end)} ${end.getFullYear()}`;
}

/** Format a full date range for a tooltip, e.g. "Mar 1 – Mar 31, 2026". */
export function formatDateRangeLong(start: Date, end: Date): string {
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  const startStr = start.toLocaleDateString(undefined, opts);
  const endStr = end.toLocaleDateString(undefined, { ...opts, year: 'numeric' });
  return `${startStr} – ${endStr}`;
}
