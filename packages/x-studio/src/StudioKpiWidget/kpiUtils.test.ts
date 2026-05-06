import { describe, expect, it } from 'vitest';
import dayjs from 'dayjs';
import {
  extractDateRange,
  findDateFilter,
  computePreviousPeriodRange,
  computeAggregate,
} from './kpiUtils';
import type { StudioDataSource, StudioFilterState } from '../models';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFilter(overrides: Partial<StudioFilterState>): StudioFilterState {
  return {
    id: 'f1',
    field: 'date',
    operator: 'greater_than_or_equal',
    value: '',
    scope: 'page',
    ...overrides,
  };
}

function makeSource(fields: StudioDataSource['fields'] = []): StudioDataSource {
  return { id: 'src', label: 'Source', fields, rows: [] };
}

const DATE_FIELD = { id: 'date', label: 'Date', type: 'date' as const };

// ─── extractDateRange ─────────────────────────────────────────────────────────

describe('extractDateRange', () => {
  it('returns null for empty filter value', () => {
    expect(extractDateRange(makeFilter({ value: '' }))).toBeNull();
  });

  it('parses absolute date string single-sided → start = date, end ≈ today', () => {
    const start = '2026-01-01';
    const result = extractDateRange(makeFilter({ value: start }));
    expect(result).not.toBeNull();
    expect(result!.start.toISOString().slice(0, 10)).toBe(start);
    // end should be today (within a few seconds)
    expect(Math.abs(result!.end.getTime() - Date.now())).toBeLessThan(5000);
  });

  it('parses absolute date range (compound AND filter)', () => {
    const result = extractDateRange(
      makeFilter({
        value: '2026-01-01',
        value2: '2026-03-31',
        conjunction: 'and',
        operator: 'greater_than_or_equal',
        operator2: 'less_than_or_equal',
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.start.toISOString().slice(0, 10)).toBe('2026-01-01');
    expect(result!.end.toISOString().slice(0, 10)).toBe('2026-03-31');
  });

  it('resolves a relative date value (1 month ago) to a concrete range', () => {
    const result = extractDateRange(
      makeFilter({
        value: { relative: true, amount: 1, unit: 'month', direction: 'past' },
        fieldType: 'date',
      }),
    );
    expect(result).not.toBeNull();
    const expectedStart = dayjs().subtract(1, 'month');
    // start should be ~1 month ago (within 1 day of tolerance for test timing)
    expect(Math.abs(result!.start.getTime() - expectedStart.toDate().getTime())).toBeLessThan(
      24 * 60 * 60 * 1000,
    );
    // end should be today
    expect(Math.abs(result!.end.getTime() - Date.now())).toBeLessThan(5000);
  });

  it('resolves a relative compound range (between 3 months ago and 1 month ago)', () => {
    const result = extractDateRange(
      makeFilter({
        value: { relative: true, amount: 3, unit: 'month', direction: 'past' },
        value2: { relative: true, amount: 1, unit: 'month', direction: 'past' },
        conjunction: 'and',
        operator: 'greater_than_or_equal',
        operator2: 'less_than_or_equal',
        fieldType: 'date',
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.start.getTime()).toBeLessThan(result!.end.getTime());
  });
});

// ─── findDateFilter ───────────────────────────────────────────────────────────

describe('findDateFilter', () => {
  it('finds a date filter by field type lookup in dataSource.fields', () => {
    const filter = makeFilter({ field: 'date', scope: 'page', fieldType: undefined });
    const source = makeSource([DATE_FIELD]);
    expect(findDateFilter([filter], 'w1', source)).toBe(filter);
  });

  it('finds a date filter using stored fieldType — even when field is not in dataSource', () => {
    // Simulates a filter on a related source's date field (not in this widget's source)
    const filter = makeFilter({ field: 'created_at', scope: 'page', fieldType: 'date' });
    const source = makeSource([]); // KPI source has no fields
    expect(findDateFilter([filter], 'w1', source)).toBe(filter);
  });

  it('finds a relative date filter using stored fieldType', () => {
    const filter = makeFilter({
      field: 'date',
      scope: 'page',
      fieldType: 'date',
      value: { relative: true, amount: 1, unit: 'month', direction: 'past' },
    });
    const source = makeSource([]); // No fields — relies on fieldType
    expect(findDateFilter([filter], 'w1', source)).toBe(filter);
  });

  it('ignores non-date filters', () => {
    const filter = makeFilter({ field: 'name', scope: 'page', fieldType: 'string' });
    const source = makeSource([{ id: 'name', label: 'Name', type: 'string' }]);
    expect(findDateFilter([filter], 'w1', source)).toBeUndefined();
  });

  it('ignores widget-scoped filters from other widgets', () => {
    const filter = makeFilter({
      field: 'date',
      scope: 'widget',
      widgetId: 'other-widget',
      fieldType: 'date',
    });
    const source = makeSource([DATE_FIELD]);
    expect(findDateFilter([filter], 'my-widget', source)).toBeUndefined();
  });

  it('finds a widget-scoped filter for the correct widget', () => {
    const filter = makeFilter({
      field: 'date',
      scope: 'widget',
      widgetId: 'my-widget',
      fieldType: 'date',
    });
    const source = makeSource([DATE_FIELD]);
    expect(findDateFilter([filter], 'my-widget', source)).toBe(filter);
  });

  it('returns undefined when no filters present', () => {
    const source = makeSource([DATE_FIELD]);
    expect(findDateFilter([], 'w1', source)).toBeUndefined();
  });
});

// ─── computePreviousPeriodRange ────────────────────────────────────────────────

describe('computePreviousPeriodRange', () => {
  it('previous-period: shifts back by the window duration', () => {
    const start = new Date('2026-03-01');
    const end = new Date('2026-03-31');
    const duration = end.getTime() - start.getTime();
    const { start: ps, end: pe } = computePreviousPeriodRange(start, end, 'previous-period');
    expect(ps.getTime()).toBe(start.getTime() - duration);
    expect(pe.getTime()).toBe(start.getTime() - 1);
  });

  it('year-over-year: same window one year earlier', () => {
    const start = new Date('2026-03-01');
    const end = new Date('2026-03-31');
    const { start: ps, end: pe } = computePreviousPeriodRange(start, end, 'year-over-year');
    expect(ps.getFullYear()).toBe(2025);
    expect(pe.getFullYear()).toBe(2025);
    expect(ps.getMonth()).toBe(start.getMonth());
    expect(pe.getMonth()).toBe(end.getMonth());
  });

  it('previous-calendar-period (month): previous calendar month', () => {
    // ~6-month range → 'month' granularity (91–730 days)
    const start = new Date('2026-01-01');
    const end = new Date('2026-06-30');
    const { start: ps, end: pe } = computePreviousPeriodRange(
      start,
      end,
      'previous-calendar-period',
    );
    expect(ps.getFullYear()).toBe(2025);
    expect(ps.getMonth()).toBe(11); // December (wraps to prev year)
    expect(pe.getMonth()).toBe(11);
  });

  it('previous-calendar-period (month): wraps to previous year for January', () => {
    const start = new Date('2026-01-01');
    const end = new Date('2026-01-31');
    const { start: ps } = computePreviousPeriodRange(start, end, 'previous-calendar-period');
    expect(ps.getFullYear()).toBe(2025);
    expect(ps.getMonth()).toBe(11); // December
  });
});

// ─── Integration: relative date filter → trend range ─────────────────────────

describe('KPI trend: relative date filter integration', () => {
  it('finds a relative date filter and extracts a valid date range from it', () => {
    const filter = makeFilter({
      field: 'date',
      scope: 'page',
      fieldType: 'date',
      operator: 'greater_than_or_equal',
      value: { relative: true, amount: 1, unit: 'month', direction: 'past' },
    });
    const source = makeSource([]);

    // findDateFilter must return the filter (not undefined)
    const found = findDateFilter([filter], 'kpi-1', source);
    expect(found).toBe(filter);

    // extractDateRange must return a valid range from that filter
    const range = extractDateRange(found!);
    expect(range).not.toBeNull();
    expect(range!.start.getTime()).toBeLessThan(range!.end.getTime());

    // The range should be approximately "last month to now"
    const expectedStart = dayjs().subtract(1, 'month').toDate();
    expect(Math.abs(range!.start.getTime() - expectedStart.getTime())).toBeLessThan(
      24 * 60 * 60 * 1000,
    );
  });
});

// ─── computeAggregate ─────────────────────────────────────────────────────────

describe('computeAggregate', () => {
  const rows = [
    { total: 100, label: 'A', date: '2024-01-01' },
    { total: 200, label: 'B', date: '2024-02-01' },
    { total: 300, label: 'C', date: '2024-03-01' },
  ];

  it('sum returns correct total for a numeric field', () => {
    expect(computeAggregate(rows, 'total', 'sum')).toBe(600);
  });

  it('avg returns correct average for a numeric field', () => {
    expect(computeAggregate(rows, 'total', 'avg')).toBe(200);
  });

  it('min returns minimum numeric value', () => {
    expect(computeAggregate(rows, 'total', 'min')).toBe(100);
  });

  it('max returns maximum numeric value', () => {
    expect(computeAggregate(rows, 'total', 'max')).toBe(300);
  });

  it('count returns row count regardless of field type', () => {
    expect(computeAggregate(rows, 'label', 'count')).toBe(3);
    expect(computeAggregate(rows, 'date', 'count')).toBe(3);
  });

  it('sum of date strings returns 0 (NaN-safe, not a meaningful operation)', () => {
    // Date strings coerce to NaN — values filtered out — returns 0.
    // The caller (KpiSetupPanel) is responsible for not passing 'sum' for date fields.
    expect(computeAggregate(rows, 'date', 'sum')).toBe(0);
  });

  it('returns 0 for empty rows', () => {
    expect(computeAggregate([], 'total', 'sum')).toBe(0);
    expect(computeAggregate([], 'total', 'count')).toBe(0);
  });
});
