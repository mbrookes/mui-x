/**
 * Pure utility functions for KPI widget computations.
 * Extracted here so they can be unit-tested independently of the React component.
 */
import type { StudioDataSource, StudioFilterState, StudioKpiAggregation } from '../../../models';
import { normalizeToDate } from '../../../internals/chartUtils';
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

  // Handle `operator: 'between'` with `value: { from, to }` (used by the dashboard date range bar)
  if (
    filter.operator === 'between' &&
    filter.value !== null &&
    typeof filter.value === 'object' &&
    'from' in (filter.value as object)
  ) {
    const obj = filter.value as { from?: string; to?: string };
    const start = toDate(obj.from);
    const end = toDate(obj.to);
    if (start && end) {
      return start <= end ? { start, end } : { start: end, end: start };
    }
    return null;
  }

  const v1 = toDate(filter.value);
  const v2 = toDate(filter.value2);

  if (v1 && v2 && filter.conjunction === 'and') {
    const start = v1 < v2 ? v1 : v2;
    const end = v1 < v2 ? v2 : v1;
    return { start, end };
  }
  if (v1) {
    // Single-sided — treat today as the end, v1 as the start
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
    (f) => f.scope === 'page' || (f.scope === 'widget' && f.widgetId === widgetId),
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

type TrendComparison = 'previous-period' | 'previous-calendar-period' | 'year-over-year';

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
    const granularity = autoGranularity(start, end);
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
    return new Set(rows.map((row) => row[field])).size;
  }

  // Exclude null/undefined values so they don't inflate the denominator for avg/min/max.
  // This aligns with gridSummary.ts which filters to typeof v === 'number'.
  const values = rows
    .map((row) => row[field])
    .filter((v): v is number => typeof v === 'number' && !Number.isNaN(v));

  if (values.length === 0) {
    return 0;
  }

  switch (aggregation) {
    case 'sum':
      return values.reduce((acc, v) => acc + v, 0);
    case 'avg':
      return values.reduce((acc, v) => acc + v, 0) / values.length;
    case 'min':
      return Math.min(...values);
    case 'max':
      return Math.max(...values);
    default:
      return values.reduce((acc, v) => acc + v, 0);
  }
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
      const day = date.getDay() || 7;
      const monday = new Date(date);
      monday.setDate(d - day + 1);
      return `${monday.getFullYear()}-W${String(monday.getDate()).padStart(2, '0')}-${String(monday.getMonth() + 1).padStart(2, '0')}`;
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
  const periodValues = sortedKeys.map((key) =>
    computeAggregate(buckets.get(key)!, valueField, aggregation),
  );

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

const MONTH_ABBR = [
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

/** Format a date as a short human-readable label, e.g. "Mar 2026" or "Mar–Apr 2026". */
export function formatPeriodShort(start: Date, end: Date): string {
  if (start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth()) {
    return `${MONTH_ABBR[start.getMonth()]} ${start.getFullYear()}`;
  }
  if (start.getFullYear() === end.getFullYear()) {
    return `${MONTH_ABBR[start.getMonth()]}–${MONTH_ABBR[end.getMonth()]} ${start.getFullYear()}`;
  }
  return `${MONTH_ABBR[start.getMonth()]} ${start.getFullYear()}–${MONTH_ABBR[end.getMonth()]} ${end.getFullYear()}`;
}

/** Format a full date range for a tooltip, e.g. "Mar 1 – Mar 31, 2026". */
export function formatDateRangeLong(start: Date, end: Date): string {
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  const startStr = start.toLocaleDateString(undefined, opts);
  const endStr = end.toLocaleDateString(undefined, { ...opts, year: 'numeric' });
  return `${startStr} – ${endStr}`;
}
