/**
 * Pure utility functions for KPI widget computations.
 * Extracted here so they can be unit-tested independently of the React component.
 */
import type { StudioDataSource, StudioFilterState } from '../models';
import { isRelativeDateValue, relativeToAbsolute } from '../StudioFiltersDrawer/filterDrawerUtils';

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

export type TrendComparison = 'previous-period' | 'previous-calendar-period' | 'year-over-year';

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
