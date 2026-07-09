import { describe, expect, it } from 'vitest';
import dayjs from 'dayjs';
import {
  extractDateRange,
  findDateFilter,
  computePreviousPeriodRange,
  computeAggregate,
  autoGranularity,
  getBucketKey,
  computeSparklineData,
  formatPeriodShort,
  formatDateRangeLong,
} from './kpiUtils';
import type { StudioDataSource, StudioFilterState } from '../../../models';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFilter(overrides: Partial<StudioFilterState>): StudioFilterState {
  return {
    id: 'f1',
    field: 'date',
    operator: 'greater_than_or_equal',
    value: '',
    scope: { kind: 'page' },
    ...overrides,
  } as StudioFilterState;
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

  it('bounds a single-sided "until X" (<=) filter on the END, not the start (finding 1.11)', () => {
    // `less_than_or_equal` keeps rows up to 2024-06-30, so the derived current
    // period must END at the filter value — the old operator-blind code produced
    // `{ start: 2024-06-30, end: today }`, i.e. exactly the region the filter EXCLUDES.
    const result = extractDateRange(
      makeFilter({ operator: 'less_than_or_equal', value: '2024-06-30' }),
    );
    expect(result).not.toBeNull();
    expect(result!.end.toISOString().slice(0, 10)).toBe('2024-06-30');
    // The lower bound must sit strictly before the filter value (not after it).
    expect(result!.start.getTime()).toBeLessThan(result!.end.getTime());
  });

  it('bounds a single-sided "until X" (<) filter on the END, not the start (finding 1.11)', () => {
    const result = extractDateRange(makeFilter({ operator: 'less_than', value: '2024-06-30' }));
    expect(result).not.toBeNull();
    expect(result!.end.toISOString().slice(0, 10)).toBe('2024-06-30');
    expect(result!.start.getTime()).toBeLessThan(result!.end.getTime());
  });

  it('keeps a single-sided "since X" (>=) filter starting at X and ending ~today', () => {
    const result = extractDateRange(
      makeFilter({ operator: 'greater_than_or_equal', value: '2024-06-30' }),
    );
    expect(result).not.toBeNull();
    expect(result!.start.toISOString().slice(0, 10)).toBe('2024-06-30');
    expect(Math.abs(result!.end.getTime() - Date.now())).toBeLessThan(5000);
  });
});

// ─── findDateFilter ───────────────────────────────────────────────────────────

describe('findDateFilter', () => {
  it('finds a date filter by field type lookup in dataSource.fields', () => {
    const filter = makeFilter({ field: 'date', scope: { kind: 'page' }, fieldType: undefined });
    const source = makeSource([DATE_FIELD]);
    expect(findDateFilter([filter], 'w1', source)).toBe(filter);
  });

  it('finds a date filter using stored fieldType — even when field is not in dataSource', () => {
    // Simulates a filter on a related source's date field (not in this widget's source)
    const filter = makeFilter({ field: 'created_at', scope: { kind: 'page' }, fieldType: 'date' });
    const source = makeSource([]); // KPI source has no fields
    expect(findDateFilter([filter], 'w1', source)).toBe(filter);
  });

  it('finds a relative date filter using stored fieldType', () => {
    const filter = makeFilter({
      field: 'date',
      scope: { kind: 'page' },
      fieldType: 'date',
      value: { relative: true, amount: 1, unit: 'month', direction: 'past' },
    });
    const source = makeSource([]); // No fields — relies on fieldType
    expect(findDateFilter([filter], 'w1', source)).toBe(filter);
  });

  it('ignores non-date filters', () => {
    const filter = makeFilter({ field: 'name', scope: { kind: 'page' }, fieldType: 'string' });
    const source = makeSource([{ id: 'name', label: 'Name', type: 'string' }]);
    expect(findDateFilter([filter], 'w1', source)).toBeUndefined();
  });

  it('ignores widget-scoped filters from other widgets', () => {
    const filter = makeFilter({
      field: 'date',
      scope: { kind: 'widget', widgetId: 'other-widget' },
      fieldType: 'date',
    });
    const source = makeSource([DATE_FIELD]);
    expect(findDateFilter([filter], 'my-widget', source)).toBeUndefined();
  });

  it('finds a widget-scoped filter for the correct widget', () => {
    const filter = makeFilter({
      field: 'date',
      scope: { kind: 'widget', widgetId: 'my-widget' },
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

  it('previous-calendar-period (month): a ~1-month range maps to the previous calendar month', () => {
    // A ~30-day range is month-sized — it must NOT be treated as a week (finding 2.18).
    const start = new Date('2026-03-01');
    const end = new Date('2026-03-31');
    const { start: ps, end: pe } = computePreviousPeriodRange(
      start,
      end,
      'previous-calendar-period',
    );
    expect(ps.getFullYear()).toBe(2026);
    expect(ps.getMonth()).toBe(1); // February
    expect(pe.getMonth()).toBe(1); // February
  });

  it('previous-calendar-period (month): wraps to previous year for January', () => {
    const start = new Date('2026-01-01');
    const end = new Date('2026-01-31');
    const { start: ps } = computePreviousPeriodRange(start, end, 'previous-calendar-period');
    expect(ps.getFullYear()).toBe(2025);
    expect(ps.getMonth()).toBe(11); // December
  });

  it('previous-calendar-period: a 30-day current range yields a NON-overlapping previous window (finding 2.18)', () => {
    // Verified in the review: Mar 1–31 2026 (30 days) was mis-classified by
    // autoGranularity as 'week', so the previous window shifted back only 7 days to
    // Feb 22 – Mar 24, overlapping the current window by 24 days and degenerating the
    // trend toward a self-comparison. The previous window must end strictly before the
    // current window begins.
    const start = new Date('2026-03-01T00:00:00.000Z');
    const end = new Date('2026-03-31T23:59:59.999Z');
    const { start: ps, end: pe } = computePreviousPeriodRange(
      start,
      end,
      'previous-calendar-period',
    );
    expect(pe.getTime()).toBeLessThan(start.getTime());
    expect(ps.getTime()).toBeLessThan(pe.getTime());
  });

  it('previous-calendar-period (quarter): a ~90-day range maps to the previous calendar quarter', () => {
    // Q2 2026 (Apr 1 – Jun 30, ~91 days) → previous calendar quarter Q1 2026.
    const start = new Date('2026-04-01');
    const end = new Date('2026-06-30');
    const { start: ps, end: pe } = computePreviousPeriodRange(
      start,
      end,
      'previous-calendar-period',
    );
    expect(ps.getMonth()).toBe(0); // January (Q1 start)
    expect(pe.getMonth()).toBe(2); // March (Q1 end)
    expect(pe.getTime()).toBeLessThan(start.getTime()); // non-overlapping
  });

  it('previous-calendar-period (year): a multi-month range maps to the previous calendar year', () => {
    // A ~6-month range is larger than a quarter → previous full calendar year,
    // which is unambiguously non-overlapping (no longer the old December-only slice).
    const start = new Date('2026-01-01');
    const end = new Date('2026-06-30');
    const { start: ps, end: pe } = computePreviousPeriodRange(
      start,
      end,
      'previous-calendar-period',
    );
    expect(ps.getFullYear()).toBe(2025);
    expect(ps.getMonth()).toBe(0); // January
    expect(pe.getFullYear()).toBe(2025);
    expect(pe.getMonth()).toBe(11); // December
  });
});

// ─── Integration: relative date filter → trend range ─────────────────────────

describe('KPI trend: relative date filter integration', () => {
  it('finds a relative date filter and extracts a valid date range from it', () => {
    const filter = makeFilter({
      field: 'date',
      scope: { kind: 'page' },
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

  it('avg of boolean field returns correct ratio (true=1, false=0)', () => {
    const boolRows = [{ onTime: true }, { onTime: true }, { onTime: true }, { onTime: false }];
    expect(computeAggregate(boolRows, 'onTime', 'avg')).toBe(0.75);
  });

  it('sum of boolean field counts trues as 1', () => {
    const boolRows = [{ onTime: true }, { onTime: false }, { onTime: true }];
    expect(computeAggregate(boolRows, 'onTime', 'sum')).toBe(2);
  });
});

describe('autoGranularity', () => {
  const span = (days: number) => autoGranularity(new Date(2026, 0, 1), new Date(2026, 0, 1 + days));

  it.each([
    [7, 'day'],
    [14, 'day'],
    [30, 'week'],
    [90, 'week'],
    [200, 'month'],
    [730, 'month'],
    [1000, 'quarter'],
    [1460, 'quarter'],
    [2000, 'year'],
  ] as const)('maps a %i-day span to "%s"', (days, expected) => {
    expect(span(days)).toBe(expected);
  });
});

describe('getBucketKey', () => {
  const date = new Date(2026, 2, 5); // 5 Mar 2026 (local = UTC in tests)

  it('formats day / month / quarter / year buckets', () => {
    expect(getBucketKey(date, 'day')).toBe('2026-03-05');
    expect(getBucketKey(date, 'month')).toBe('2026-03');
    expect(getBucketKey(date, 'quarter')).toBe('2026-Q1');
    expect(getBucketKey(date, 'year')).toBe('2026');
  });

  it('groups dates within the same Mon–Sun week under one key', () => {
    // 2 Mar 2026 is a Monday; 5 Mar is the same week.
    const monday = new Date(2026, 2, 2);
    const thursday = new Date(2026, 2, 5);
    expect(getBucketKey(monday, 'week')).toBe(getBucketKey(thursday, 'week'));
  });

  it('formats week buckets as an ISO year-week key (finding 1.11)', () => {
    // 5 Mar 2026 falls in ISO week 10 of 2026 — the key must be `{year}-W{week}`,
    // NOT the old `{year}-W{dayOfMonth}-{month}` shape, so it sorts chronologically.
    expect(getBucketKey(date, 'week')).toBe('2026-W10');
  });

  it('sorts week buckets chronologically across a month boundary', () => {
    // Monday 2026-01-26 (ISO week 5) and Monday 2026-02-02 (ISO week 6). The old
    // `{year}-W{dayOfMonth}-{month}` key produced "2026-W26-01" and "2026-W02-02" —
    // lexicographically the February week sorted first. The new key must sort
    // the January week first.
    const janMonday = new Date(2026, 0, 26);
    const febMonday = new Date(2026, 1, 2);
    const janKey = getBucketKey(janMonday, 'week');
    const febKey = getBucketKey(febMonday, 'week');
    expect(janKey).toBe('2026-W05');
    expect(febKey).toBe('2026-W06');
    expect([febKey, janKey].sort()).toEqual([janKey, febKey]);
  });
});

describe('computeSparklineData', () => {
  const rows = [
    { t: '2026-01-15', v: 10 },
    { t: '2026-01-20', v: 5 },
    { t: '2026-02-10', v: 20 },
    { t: null, v: 99 }, // skipped — no date
  ];

  it('aggregates each period bucket in chronological order', () => {
    expect(computeSparklineData(rows, 't', 'v', 'sum', 'month', false)).toEqual([15, 20]);
  });

  it('returns a running total when cumulative', () => {
    expect(computeSparklineData(rows, 't', 'v', 'sum', 'month', true)).toEqual([15, 35]);
  });

  it('sorts weekly buckets in true chronological order across a month boundary (finding 1.11)', () => {
    // Week granularity is the auto-selected default for 14–90 day ranges. A row in
    // the week of Mon 2026-01-26 and a row in the week of Mon 2026-02-02 must
    // aggregate with January's value first, even though the old
    // `{year}-W{dayOfMonth}-{month}` key would have sorted February first.
    const weekRows = [
      { t: '2026-01-27', v: 100 }, // week of 2026-01-26 (ISO week 5)
      { t: '2026-02-03', v: 200 }, // week of 2026-02-02 (ISO week 6)
    ];
    expect(computeSparklineData(weekRows, 't', 'v', 'sum', 'week', false)).toEqual([100, 200]);
  });
});

describe('formatPeriodShort', () => {
  it('shows a single month when start and end share a month', () => {
    expect(formatPeriodShort(new Date(2026, 2, 1), new Date(2026, 2, 31))).toBe('Mar 2026');
  });

  it('shows a month range within the same year', () => {
    expect(formatPeriodShort(new Date(2026, 2, 1), new Date(2026, 3, 30))).toBe('Mar–Apr 2026');
  });

  it('shows a cross-year range', () => {
    expect(formatPeriodShort(new Date(2025, 11, 1), new Date(2026, 0, 31))).toBe(
      'Dec 2025–Jan 2026',
    );
  });
});

describe('formatDateRangeLong', () => {
  it('formats a range with the year on the end date', () => {
    const result = formatDateRangeLong(new Date(2026, 2, 1), new Date(2026, 2, 31));
    expect(result).toContain('–');
    expect(result).toContain('Mar');
    expect(result).toContain('2026');
  });
});
