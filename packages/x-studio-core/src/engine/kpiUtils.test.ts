import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import dayjs from 'dayjs';
import { truncateToPeriod } from '@mui/x-studio-schema';
import { setActiveStudioLocale } from './studioLocale';
import type { StudioDataSource, StudioExpressionField, StudioFilterState } from '../models';
import {
  extractDateRange,
  filterRowsByDateRange,
  findDateFilter,
  computeFixedPeriodRange,
  computePreviousPeriodRange,
  computeAggregate,
  autoGranularity,
  getBucketKey,
  computeSparklineData,
  formatPeriodShort,
  formatDateRangeLong,
  resolveKpiDateField,
  toLocalYmd,
} from './kpiUtils';

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

  it('bounds an "equals" ("On X") date filter to that single calendar day, not [X..today] (T1.5)', () => {
    // `equals` keeps ONLY rows on 2024-03-15 (L3 enforces it), so the derived current period
    // must be that single day. The old operator-blind fall-through produced
    // `{ start: 2024-03-15, end: today }` (~open-ended), making the trend compare a one-day
    // headline against a huge previous aggregate → always a bogus delta.
    const result = extractDateRange(makeFilter({ operator: 'equals', value: '2024-03-15' }));
    expect(result).not.toBeNull();
    expect(toLocalYmd(result!.start)).toBe('2024-03-15');
    expect(toLocalYmd(result!.end)).toBe('2024-03-15');
    // A single calendar day, not an ~open-ended window ending today.
    expect(result!.end.getTime() - result!.start.getTime()).toBeLessThan(24 * 60 * 60 * 1000);
  });

  it('returns null for "not_equals" so no trend badge is derived from it (T1.5)', () => {
    // `not_equals` ("not on X") hit the same operator-blind branch as `equals` and produced a
    // fabricated open-ended window. It defines no contiguous date range → no trend.
    expect(
      extractDateRange(makeFilter({ operator: 'not_equals', value: '2024-03-15' })),
    ).toBeNull();
  });

  it('returns null for emptiness operators (is_empty / is_not_empty) (T1.5)', () => {
    expect(
      extractDateRange(makeFilter({ operator: 'is_not_empty', value: '2024-03-15' })),
    ).toBeNull();
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

  // ─── T3-1: multiple in-scope date filters — most-specific scope wins ──────────
  describe('precedence when multiple in-scope date filters exist (T3-1)', () => {
    const source = makeSource([DATE_FIELD]);

    it('prefers a widget-scoped date filter over a page-scoped one, regardless of array order', () => {
      const pageFilter = makeFilter({
        id: 'page-date',
        field: 'date',
        fieldType: 'date',
        scope: { kind: 'page' },
      });
      const widgetFilter = makeFilter({
        id: 'widget-date',
        field: 'date',
        fieldType: 'date',
        scope: { kind: 'widget', widgetId: 'my-widget' },
      });
      // Page filter listed FIRST — the old "first match" behavior would have picked it.
      expect(findDateFilter([pageFilter, widgetFilter], 'my-widget', source)).toBe(widgetFilter);
      // Order-independent: same result with the widget filter listed first.
      expect(findDateFilter([widgetFilter, pageFilter], 'my-widget', source)).toBe(widgetFilter);
    });

    it('prefers a page-scoped date filter over a dashboard-date-range one', () => {
      const dashboardFilter = makeFilter({
        id: 'dash-date',
        field: 'date',
        fieldType: 'date',
        scope: { kind: 'dashboard-date-range', sourceId: 'src', pageId: 'page-1' },
      });
      const pageFilter = makeFilter({
        id: 'page-date',
        field: 'date',
        fieldType: 'date',
        scope: { kind: 'page' },
      });
      expect(findDateFilter([dashboardFilter, pageFilter], 'my-widget', source)).toBe(pageFilter);
      expect(findDateFilter([pageFilter, dashboardFilter], 'my-widget', source)).toBe(pageFilter);
    });

    it('falls back to array order among filters sharing the same scope kind', () => {
      const firstPageFilter = makeFilter({
        id: 'page-date-1',
        field: 'date',
        fieldType: 'date',
        scope: { kind: 'page' },
      });
      const secondPageFilter = makeFilter({
        id: 'page-date-2',
        field: 'date',
        fieldType: 'date',
        scope: { kind: 'page' },
      });
      expect(findDateFilter([firstPageFilter, secondPageFilter], 'w1', source)).toBe(
        firstPageFilter,
      );
    });
  });
});

// ─── computePreviousPeriodRange ────────────────────────────────────────────────

describe('computePreviousPeriodRange', () => {
  const inclusiveDayCount = (a: Date, b: Date) =>
    Math.round(
      (Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) -
        Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) /
        86400000,
    ) + 1;

  it('previous-period: previous window is the same whole-day length, ending the day before the current window starts (finding F1)', () => {
    // Mar 1–31 is an INCLUSIVE 31-day window (L3 `between` is inclusive-day). The previous
    // window must therefore also be 31 whole days and end on Feb 28 — the day immediately
    // before Mar 1. The old instant math measured the window as `end − start` = 30 days
    // (one short) and ended the previous window 1ms into the boundary day.
    const start = new Date(2026, 2, 1); // Mar 1 (local)
    const end = new Date(2026, 2, 31); // Mar 31 (local)
    const { start: ps, end: pe } = computePreviousPeriodRange(start, end, 'previous-period');

    // Equal inclusive length — the parity the old duration-based math broke.
    expect(inclusiveDayCount(ps, pe)).toBe(inclusiveDayCount(start, end));
    expect(inclusiveDayCount(ps, pe)).toBe(31);
    // Adjacent and non-overlapping: previous window ends the day before the current start.
    expect(toLocalYmd(pe)).toBe('2026-02-28');
    expect(pe.getTime()).toBeLessThan(start.getTime());
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

  it('previous-calendar-period (week): a ~7-day range maps to exactly 7 calendar days back', () => {
    // A ≤10-day range is week-sized. The previous window must be shifted back by
    // exactly 7 whole calendar days via calendar arithmetic (not raw ms subtraction),
    // matching the month/quarter/year sibling branches.
    const start = new Date(2026, 5, 8); // Jun 8 2026 local midnight
    const end = new Date(2026, 5, 14); // Jun 14 2026 local midnight
    const { start: ps, end: pe } = computePreviousPeriodRange(
      start,
      end,
      'previous-calendar-period',
    );
    // Jun 8 − 7 days = Jun 1; Jun 14 − 7 days = Jun 7.
    expect(ps.getFullYear()).toBe(2026);
    expect(ps.getMonth()).toBe(5); // June
    expect(ps.getDate()).toBe(1);
    expect(pe.getMonth()).toBe(5); // June
    expect(pe.getDate()).toBe(7);
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const daysBack = (a: Date, b: Date) =>
      Math.round(
        (new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime() -
          new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime()) /
          MS_PER_DAY,
      );
    expect(daysBack(start, ps)).toBe(7);
    expect(daysBack(end, pe)).toBe(7);
  });
});

// ─── computeFixedPeriodRange window width + parity (T3-1) ──────────────────────

describe('computeFixedPeriodRange', () => {
  const inclusiveDayCount = (a: Date, b: Date) =>
    Math.round(
      (Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) -
        Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) /
        86400000,
    ) + 1;

  it.each([
    ['month', 30],
    ['quarter', 90],
    ['year', 365],
  ] as const)(
    "%s spans exactly %i inclusive calendar days ending on 'today' (T3-1)",
    (period, days) => {
      const today = new Date(2026, 6, 15); // Jul 15, 2026 (local)
      const { start, end } = computeFixedPeriodRange(period, today);
      // Documented width — the old `- days` math produced `days + 1` (31/91/366).
      expect(inclusiveDayCount(start, end)).toBe(days);
      // End is 'today', start is `days - 1` days earlier (inclusive of both ends).
      expect(toLocalYmd(end)).toBe('2026-07-15');
    },
  );

  it('current and previous windows are equal length (window-length parity)', () => {
    // The delta compares equal-length windows: whatever width the current fixed window
    // has, the previous-period window must match it. (Replaces a same-space tautology with
    // a real cross-function parity check.)
    const today = new Date(2026, 6, 15);
    const current = computeFixedPeriodRange('quarter', today);
    const previous = computePreviousPeriodRange(current.start, current.end, 'previous-period');
    expect(inclusiveDayCount(current.start, current.end)).toBe(90);
    expect(inclusiveDayCount(previous.start, previous.end)).toBe(
      inclusiveDayCount(current.start, current.end),
    );
    // Adjacent, non-overlapping: previous window ends before the current window starts.
    expect(previous.end.getTime()).toBeLessThan(current.start.getTime());
  });
});

// ─── Timezone safety: local-midnight parse + whole-day windows (F1/F2/F3) ──────

describe('previous-period date math is timezone-safe', () => {
  const originalTz = process.env.TZ;

  beforeEach(() => {
    // Node re-reads `TZ` per `Date` call (no restart needed), so this reliably reproduces a
    // west-of-UTC viewer regardless of the host machine's own timezone. Under the pre-fix
    // UTC-midnight parse (`new Date('YYYY-MM-DD')`), a bare date filter value anchored to UTC
    // midnight lands on the PREVIOUS local calendar day for a negative-offset viewer,
    // day-shifting every window and calendar period derived from it (findings F1/F2).
    process.env.TZ = 'America/New_York';
  });

  afterEach(() => {
    process.env.TZ = originalTz;
  });

  const betweenFilter = (from: string, to: string) =>
    makeFilter({
      operator: 'greater_than_or_equal',
      value: from,
      operator2: 'less_than_or_equal',
      value2: to,
      conjunction: 'and',
      fieldType: 'date',
    });

  it('parses a bare YYYY-MM-DD filter value to LOCAL midnight, not UTC midnight (finding F1/F2)', () => {
    const range = extractDateRange(betweenFilter('2026-07-08', '2026-07-14'));
    expect(range).not.toBeNull();
    // The local calendar components must echo the input string. The old UTC-midnight parse
    // read 2026-07-07 for this negative-offset viewer.
    expect(range!.start.getFullYear()).toBe(2026);
    expect(range!.start.getMonth()).toBe(6); // July
    expect(range!.start.getDate()).toBe(8);
    expect(range!.end.getMonth()).toBe(6);
    expect(range!.end.getDate()).toBe(14);
  });

  it('previous-period window is a non-overlapping 7 whole days ending the day before the current window (finding F1)', () => {
    const range = extractDateRange(betweenFilter('2026-07-08', '2026-07-14'))!;
    const prev = computePreviousPeriodRange(range.start, range.end, 'previous-period');
    // Serialized as the widget does (via toLocalYmd): Jul 1 .. Jul 7 — seven inclusive days,
    // ending the day before the current window's Jul 8 start.
    expect(toLocalYmd(prev.start)).toBe('2026-07-01');
    expect(toLocalYmd(prev.end)).toBe('2026-07-07');
  });

  it('previous-calendar-period resolves the correct calendar month west of UTC (finding F2)', () => {
    // A whole-July window compared to the previous calendar month must resolve to JUNE.
    // The old UTC-midnight parse shifted Jul 1 → Jun 30 local, so `getMonth()` read June and
    // the "previous calendar month" came out as MAY (label "vs. May 2026").
    const range = extractDateRange(betweenFilter('2026-07-01', '2026-07-31'))!;
    const prev = computePreviousPeriodRange(range.start, range.end, 'previous-calendar-period');
    expect(prev.start.getFullYear()).toBe(2026);
    expect(prev.start.getMonth()).toBe(5); // June
    expect(prev.end.getMonth()).toBe(5); // June
  });

  it('previous-calendar-period (week) does not day-shift across the spring-forward DST transition (Fix 2.1)', () => {
    // US spring-forward is 2024-03-10. A week-sized window straddling it spans only
    // 167 wall-clock hours, so the old raw `− 168h` subtraction landed prevEnd at
    // 23:00 the previous calendar day; toLocalYmd then serialized it one day too
    // early. Calendar arithmetic shifts the date component, so the bounds stay
    // exactly 7 whole calendar days back with no 23:00 drift.
    const start = new Date(2024, 2, 7); // Mar 7 2024 local midnight
    const end = new Date(2024, 2, 13); // Mar 13 2024 local midnight (straddles Mar 10 DST)
    const prev = computePreviousPeriodRange(start, end, 'previous-calendar-period');
    // Feb 29 2024 (leap year) .. Mar 6 2024 — the old code serialized Mar 5 for the end.
    expect(toLocalYmd(prev.start)).toBe('2024-02-29');
    expect(toLocalYmd(prev.end)).toBe('2024-03-06');
  });

  it('windows fixed-period rows by calendar day, classifying boundary-day date-only rows consistently (finding F3)', () => {
    // A date-only row on the first day of the window must be included; one the day before
    // must be excluded — regardless of the viewer's timezone. The old instant comparison
    // (`normalizeToDate(raw)` = UTC midnight vs a locally-constructed bound) misclassified
    // these boundary rows west of UTC.
    const rows = [
      { d: '2026-07-01', v: 1 }, // first day of window — included
      { d: '2026-07-15', v: 1 }, // last day of window — included
      { d: '2026-06-30', v: 1 }, // day before window — excluded
      { d: '2026-07-16', v: 1 }, // day after window — excluded
    ];
    const windowed = filterRowsByDateRange(
      rows,
      'd',
      new Date(2026, 6, 1), // Jul 1 local midnight
      new Date(2026, 6, 15, 23, 59, 59, 999), // Jul 15 local end-of-day
    );
    expect(windowed.map((r) => r.d)).toEqual(['2026-07-01', '2026-07-15']);
  });
});

// ─── Datetime row/bound calendar-space unification (T2-1) ──────────────────────

describe('filterRowsByDateRange datetime rows are windowed in LOCAL calendar space (T2-1)', () => {
  const originalTz = process.env.TZ;

  beforeEach(() => {
    // West-of-UTC viewer: a datetime instant a few hours into the UTC day falls on the
    // PREVIOUS local calendar day. The window bounds are reduced to their LOCAL day
    // (`toLocalYmd`), so a datetime row must be reduced to its LOCAL day too — the old
    // leading-10-chars fast path returned the row's UTC day, mismatching the bound space.
    process.env.TZ = 'America/New_York';
  });

  afterEach(() => {
    process.env.TZ = originalTz;
  });

  it('classifies a near-UTC-midnight datetime row by its LOCAL day, not its UTC day (T2-1)', () => {
    const rows = [
      // 2026-07-15T02:00Z = 2026-07-14 22:00 in New York → LOCAL day Jul 14 → OUTSIDE a
      // Jul-15-local window. The old UTC-day reduction ('2026-07-15') wrongly INCLUDED it.
      { d: '2026-07-15T02:00:00.000Z', v: 1 },
      // 2026-07-15T18:00Z = 2026-07-15 14:00 in New York → LOCAL day Jul 15 → INSIDE.
      { d: '2026-07-15T18:00:00.000Z', v: 2 },
    ];
    const windowed = filterRowsByDateRange(
      rows,
      'd',
      new Date(2026, 6, 15, 0, 0, 0, 0), // Jul 15 local midnight
      new Date(2026, 6, 15, 23, 59, 59, 999), // Jul 15 local end-of-day
    );
    // Only the row whose LOCAL day is Jul 15 survives. Under the pre-fix UTC-day reduction
    // BOTH rows shared the key '2026-07-15' and both were included — this assertion failed.
    expect(windowed.map((r) => r.v)).toEqual([2]);
  });

  it('still classifies bare date-only rows by their literal calendar day', () => {
    // Bare `YYYY-MM-DD` values have no time-of-day and must be unaffected by the datetime
    // LOCAL-reduction: their calendar day is the literal string.
    const rows = [
      { d: '2026-07-14', v: 1 }, // excluded
      { d: '2026-07-15', v: 2 }, // included
    ];
    const windowed = filterRowsByDateRange(
      rows,
      'd',
      new Date(2026, 6, 15, 0, 0, 0, 0),
      new Date(2026, 6, 15, 23, 59, 59, 999),
    );
    expect(windowed.map((r) => r.v)).toEqual([2]);
  });
});

// ─── Datetime preset previous-period day-count (T2-2) ──────────────────────────

describe('extractDateRange collapses a datetime preset end to its local calendar day (T2-2)', () => {
  const originalTz = process.env.TZ;

  beforeEach(() => {
    // East-of-UTC viewer: a `…T23:59:59.999Z` end bound parses to the NEXT local day.
    process.env.TZ = 'Asia/Tokyo'; // UTC+9
  });

  afterEach(() => {
    process.env.TZ = originalTz;
  });

  // Mirrors the shape `resolveDateRangePreset` produces for a `datetime` field: a bare-date
  // `from` and a UTC-end-of-day `to`. Passed straight through by `extractDateRange` (no
  // preset key ⇒ resolver is a no-op) so the assertion is deterministic (no dependency on
  // the current date).
  const datetimePresetFilter = makeFilter({
    operator: 'between',
    value: { from: '2026-07-01', to: '2026-07-31T23:59:59.999Z' },
    fieldType: 'datetime',
  });

  it('extractDateRange resolves the datetime end to July 31 local, not August 1 (T2-2)', () => {
    const range = extractDateRange(datetimePresetFilter)!;
    expect(range).not.toBeNull();
    // The old `new Date('2026-07-31T23:59:59.999Z')` read Aug 1 local for this UTC+9 viewer.
    expect(range.end.getFullYear()).toBe(2026);
    expect(range.end.getMonth()).toBe(6); // July
    expect(range.end.getDate()).toBe(31);
  });

  it('previous-period window is a non-overlapping 31 whole days ending June 30 (T2-2)', () => {
    const range = extractDateRange(datetimePresetFilter)!;
    const prev = computePreviousPeriodRange(range.start, range.end, 'previous-period');
    // July 1–31 is an inclusive 31-day window, so the previous window is 31 days ending the
    // day before Jul 1 → May 31 .. Jun 30. The pre-fix Aug-1 end inflated the inclusive-day
    // count to 32, shifting the previous window back a day to May 30 .. Jun 30.
    expect(toLocalYmd(prev.end)).toBe('2026-06-30');
    expect(toLocalYmd(prev.start)).toBe('2026-05-31');
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

  // ─── count_distinct: raw-value distinctness, null-excluding (finding 2.23) ─────

  it('count_distinct counts distinct raw string values', () => {
    const strRows = [{ region: 'US' }, { region: 'US' }, { region: 'EU' }, { region: 'APAC' }];
    expect(computeAggregate(strRows, 'region', 'count_distinct')).toBe(3);
  });

  it('count_distinct excludes null/undefined/missing (SQL COUNT(DISTINCT) semantic)', () => {
    // Regression: the KPI path previously counted the null group as a distinct value,
    // returning 3 here and disagreeing with the grid and measure paths (which return 2).
    const rows = [
      { region: 'US' },
      { region: 'US' },
      { region: 'EU' },
      { region: null },
      { region: undefined },
      {}, // missing key
    ];
    expect(computeAggregate(rows, 'region', 'count_distinct')).toBe(2);
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

  // R4-F5: `getBucketKey` hand-rolled what `@mui/x-studio-schema`'s `truncateToPeriod`
  // already does, and in doing so reintroduced the exact `Date.UTC` two-digit-year quirk
  // that schema's file-private `utcDateFromYMD` exists to prevent (a year in [0, 99] is
  // silently read as 1900 + year), and it skipped `padYear` entirely. It must agree with
  // the shared implementation for every granularity.
  it('agrees with the shared truncateToPeriod for every granularity', () => {
    for (const iso of ['2026-03-05', '2026-01-26', '1999-12-31', '2024-02-29']) {
      const value = new Date(iso);
      for (const granularity of ['day', 'week', 'month', 'quarter', 'year'] as const) {
        expect(getBucketKey(value, granularity), `${iso} ${granularity}`).toBe(
          truncateToPeriod(value, granularity),
        );
      }
    }
  });

  it('does not read a year below 100 as 1900 + year, and zero-pads it', () => {
    const y99 = new Date('0099-12-31');
    expect(y99.getUTCFullYear()).toBe(99);
    // Was '1999-W52' — the `Date.UTC(99, ...)` quirk — while the DAY key for that very same
    // date said year 99 ('99-12-31'). One function, two different years.
    expect(getBucketKey(y99, 'week')).toBe('0099-W53');
    expect(getBucketKey(y99, 'day')).toBe('0099-12-31');
    expect(getBucketKey(y99, 'year')).toBe('0099');

    const y5 = new Date('0005-06-15');
    expect(getBucketKey(y5, 'week')).toBe('0005-W24');
    expect(getBucketKey(y5, 'month')).toBe('0005-06');
  });
});

// ─── Sparkline bucketing is timezone-safe for canonical bare dates (T2-3) ──────

describe('getBucketKey / computeSparklineData are timezone-safe for canonical dates (T2-3)', () => {
  const originalTz = process.env.TZ;

  beforeEach(() => {
    // West-of-UTC viewer: a bare 'YYYY-MM-DD' row value is parsed (via `normalizeToDate`)
    // to UTC midnight of that calendar day. Reading LOCAL date components off that instant
    // rolls it back to the PREVIOUS calendar day for a negative-offset viewer — the exact
    // trap `toDayKey` already avoids for its own bare-date case. Mirrors the TZ-mocking
    // pattern used elsewhere in this file (e.g. the F1/F2/T2-1 describe blocks above).
    process.env.TZ = 'America/New_York';
  });

  afterEach(() => {
    process.env.TZ = originalTz;
  });

  it('buckets a bare canonical date onto its own calendar day, not the previous one', () => {
    // UTC midnight of 2026-03-05 is 2026-03-04 19:00 in New York. The pre-fix LOCAL-getter
    // implementation would have produced '2026-03-04'.
    const date = new Date('2026-03-05');
    expect(getBucketKey(date, 'day')).toBe('2026-03-05');
    expect(getBucketKey(date, 'month')).toBe('2026-03');
    expect(getBucketKey(date, 'quarter')).toBe('2026-Q1');
    expect(getBucketKey(date, 'year')).toBe('2026');
  });

  it('groups a bare canonical row date into the correct day bucket via computeSparklineData', () => {
    const rows = [
      { t: '2026-01-15', v: 10 },
      { t: '2026-01-20', v: 5 },
    ];
    // Pre-fix, both rows would have rolled back one calendar day under America/New_York —
    // still distinct buckets here, but on the wrong days. Assert the bucket keys directly
    // via a single-row-per-bucket case so a day-shift would change which values line up.
    // The four empty days between the 15th and the 20th are `null` gaps: the series spans
    // the whole 6-day range, so a day-shift bug would move the values within it.
    expect(computeSparklineData(rows, 't', 'v', 'sum', 'day', false)).toEqual([
      10,
      null,
      null,
      null,
      null,
      5,
    ]);
  });

  it('does not merge two rows on adjacent days into one bucket (would happen if both shifted the same direction)', () => {
    const rows = [
      { t: '2026-03-05', v: 1 },
      { t: '2026-03-06', v: 2 },
    ];
    // Each day must remain its own bucket — a day-shift bug that rolled both dates back by
    // one day would still keep them distinct, so additionally pin down the exact keys.
    expect(getBucketKey(new Date('2026-03-05'), 'day')).toBe('2026-03-05');
    expect(getBucketKey(new Date('2026-03-06'), 'day')).toBe('2026-03-06');
    expect(computeSparklineData(rows, 't', 'v', 'sum', 'day', false)).toEqual([1, 2]);
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

  // ─── Empty periods are gaps, not deletions ─────────────────────────────────
  // `KpiSparkline` renders the series with no `xAxis`, so points are spaced uniformly.
  // Dropping a period with no rows would silently compress the time axis: a two-month
  // Feb -> Apr drop would draw identically to a one-month drop, and the aria label would
  // announce the wrong number of periods.

  const gappedRows = [
    { t: '2026-01-10', v: 100 },
    { t: '2026-02-10', v: 120 },
    // March has no rows at all.
    { t: '2026-04-10', v: 90 },
  ];

  it('emits null for a period with no rows instead of dropping it', () => {
    expect(computeSparklineData(gappedRows, 't', 'v', 'sum', 'month', false)).toEqual([
      100,
      120,
      null,
      90,
    ]);
  });

  it('keeps the running total across a gap when cumulative, leaving the gap itself null', () => {
    expect(computeSparklineData(gappedRows, 't', 'v', 'sum', 'month', true)).toEqual([
      100,
      220,
      null,
      310,
    ]);
  });

  it('spans multi-period gaps (Q1 -> Q4 covers all four quarters)', () => {
    const quarterRows = [
      { t: '2026-01-10', v: 5 },
      { t: '2026-10-10', v: 8 },
    ];
    expect(computeSparklineData(quarterRows, 't', 'v', 'sum', 'quarter', false)).toEqual([
      5,
      null,
      null,
      8,
    ]);
  });

  it('emits 0 (not a gap) for a period whose rows aggregate to zero', () => {
    // A real, populated period must stay distinguishable from an absent one: `0` is a
    // measurement, `null` is the absence of one.
    const zeroRows = [
      { t: '2026-01-10', v: 0 },
      { t: '2026-02-10', v: 7 },
    ];
    expect(computeSparklineData(zeroRows, 't', 'v', 'sum', 'month', false)).toEqual([0, 7]);
  });

  it('emits a gap (not 0) for an avg period whose rows have no usable values', () => {
    // Same "null means not measured, not zero" policy as the trend's `computePeriodValue`
    // (M3): the January bucket HAS rows, but every value is null, so `computeAggregate`
    // returns `null` for `avg`. Coercing that to `0` drew a real point at zero — reading as
    // "the average was 0 in January" — instead of the gap the sparkline already renders for
    // unmeasured periods. Contrast with the `sum`-to-zero case above, which still plots 0.
    const blankRows = [
      { t: '2026-01-10', v: null },
      { t: '2026-01-20', v: null },
      { t: '2026-02-10', v: 7 },
    ];
    expect(computeSparklineData(blankRows, 't', 'v', 'avg', 'month', false)).toEqual([null, 7]);
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

  // ─── finding 2.6: measure expression fields must not read a nonexistent row column ──
  const revenueMeasure: StudioExpressionField = {
    id: 'revenueMeasure',
    label: 'Revenue',
    sourceId: 'sales',
    isMeasure: true,
    type: 'number',
    expression: { id: 'amount', aggregation: 'sum' },
  } as unknown as StudioExpressionField;

  it('is flat zero for a measure field when no measure is passed (documents the pre-fix bug)', () => {
    // Measure values are never enriched onto rows — `row['revenueMeasure']` doesn't
    // exist — so aggregating the (bogus) field name directly always yields 0.
    const measureRows = [
      { t: '2026-01-15', amount: 10 },
      { t: '2026-01-20', amount: 5 },
      { t: '2026-02-10', amount: 20 },
    ];
    expect(computeSparklineData(measureRows, 't', 'revenueMeasure', 'sum', 'month', false)).toEqual(
      [0, 0],
    );
  });

  it('routes a measure expression field through evaluateMeasure per bucket instead of returning zeros (finding 2.6)', () => {
    const measureRows = [
      { t: '2026-01-15', amount: 10 },
      { t: '2026-01-20', amount: 5 },
      { t: '2026-02-10', amount: 20 },
    ];
    expect(
      computeSparklineData(
        measureRows,
        't',
        'revenueMeasure',
        'sum',
        'month',
        false,
        revenueMeasure,
        [revenueMeasure],
      ),
    ).toEqual([15, 20]);
  });

  it('supports cumulative bucketing for a measure expression field', () => {
    const measureRows = [
      { t: '2026-01-15', amount: 10 },
      { t: '2026-01-20', amount: 5 },
      { t: '2026-02-10', amount: 20 },
    ];
    expect(
      computeSparklineData(
        measureRows,
        't',
        'revenueMeasure',
        'sum',
        'month',
        true,
        revenueMeasure,
        [revenueMeasure],
      ),
    ).toEqual([15, 35]);
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

// ─── `<Studio locale={…} />` ─────────────────────────────────────────────────
//
// `monthAbbr` and `formatDateRangeLong` feed the KPI trend badge's "vs. {period}" caption and
// tooltip (`KpiTrend.tsx`), rendered right beside the KPI's own value — which IS correctly
// localized via `formatNumber`/`getStudioLocale()`. Both helpers called `toLocaleDateString`
// with a bare `undefined` locale argument, so they always resolved to the runtime/browser
// locale regardless of the active Studio locale.

describe('formatPeriodShort — honours the active Studio locale', () => {
  afterEach(() => {
    setActiveStudioLocale(undefined);
  });

  it('formats the month abbreviation against the active locale', () => {
    setActiveStudioLocale('de-DE');
    expect(formatPeriodShort(new Date(2026, 2, 1), new Date(2026, 2, 31))).toBe('Mär 2026');

    setActiveStudioLocale('en-US');
    expect(formatPeriodShort(new Date(2026, 2, 1), new Date(2026, 2, 31))).toBe('Mar 2026');
  });
});

describe('formatDateRangeLong — honours the active Studio locale', () => {
  afterEach(() => {
    setActiveStudioLocale(undefined);
  });

  it('formats both bounds against the active locale', () => {
    setActiveStudioLocale('de-DE');
    const de = formatDateRangeLong(new Date(2026, 2, 1), new Date(2026, 2, 31));
    setActiveStudioLocale('en-US');
    const en = formatDateRangeLong(new Date(2026, 2, 1), new Date(2026, 2, 31));

    // Same range, different locales must not produce the same string — German abbreviates
    // March as "Mär", English as "Mar".
    expect(de).not.toBe(en);
    expect(de).toContain('Mär');
    expect(en).toContain('Mar');
  });
});

describe('toLocalYmd', () => {
  it('formats a Date from its LOCAL calendar components', () => {
    // `new Date(y, m, d)` is a LOCAL-time construction, so toLocalYmd must echo the same
    // Y/M/D regardless of the machine timezone — this is the whole point of the helper.
    expect(toLocalYmd(new Date(2024, 0, 15))).toBe('2024-01-15');
    expect(toLocalYmd(new Date(2026, 11, 1))).toBe('2026-12-01');
  });

  it('keeps a local-midnight boundary on its local calendar day, unlike toISOString (finding 1.12)', () => {
    // A local-midnight Date's LOCAL calendar day is 2024-06-10. `toISOString().slice(0,10)`
    // round-trips through UTC and, for a UTC+ viewer, day-shifts to 2024-06-09 — exactly
    // the bug the previous-period window serialization had. `toLocalYmd` must always report
    // the local day.
    const localMidnight = new Date(2024, 5, 10, 0, 0, 0, 0);
    expect(toLocalYmd(localMidnight)).toBe('2024-06-10');
    // Cross-check against the derived local Y/M/D directly (no timezone assumption about
    // the host): toLocalYmd echoes the components new Date(y, m, d) was built from.
    const expected = `${localMidnight.getFullYear()}-${String(localMidnight.getMonth() + 1).padStart(2, '0')}-${String(localMidnight.getDate()).padStart(2, '0')}`;
    expect(toLocalYmd(localMidnight)).toBe(expected);
  });
});

// ─── Prototype-chain-safe record lookups ──────────────────────────────────────

/**
 * `period` and the field ids below come from a doc/AI-authored widget config with no runtime
 * enum validation. A bare `PERIOD_DAYS[period]` on a `"constructor"` period resolves the
 * inherited `Object` constructor, so `days` is a function, `start.setDate(NaN)` yields an
 * Invalid Date, and the trend badge silently disappears instead of falling back.
 */
describe('prototype-chain keys in KPI record lookups', () => {
  it('computeFixedPeriodRange falls back to a valid window for an Object.prototype period', () => {
    const today = new Date(2026, 6, 15);
    const { start, end } = computeFixedPeriodRange('constructor' as unknown as 'month', today);
    expect(Number.isNaN(start.getTime())).toBe(false);
    expect(Number.isNaN(end.getTime())).toBe(false);
    expect(toLocalYmd(end)).toBe('2026-07-15');
    // Falls back to the documented 30-day (month) window.
    expect(toLocalYmd(start)).toBe('2026-06-16');
  });

  it('filterRowsByDateRange ignores rows for a date field named after a prototype member', () => {
    const rows = [{ date: '2026-07-10' }];
    const out = filterRowsByDateRange(
      rows,
      'constructor',
      new Date(2026, 0, 1),
      new Date(2026, 11, 31),
    );
    expect(out).toEqual([]);
  });

  it('computeAggregate treats a prototype-named field as having no values', () => {
    const rows = [{ revenue: 10 }, { revenue: 20 }];
    expect(computeAggregate(rows, 'toString', 'sum')).toBe(0);
    expect(computeAggregate(rows, 'constructor', 'count_distinct')).toBe(0);
  });
});

// ─── resolveKpiDateField — the ONE date-field rule (M5) ───────────────────────
describe('resolveKpiDateField', () => {
  const source: StudioDataSource = {
    id: 'sales',
    label: 'Sales',
    fields: [
      { id: 'createdAt', label: 'Created', type: 'date' },
      { id: 'shippedAt', label: 'Shipped', type: 'date' },
      { id: 'amount', label: 'Amount', type: 'number' },
    ],
    rows: [],
  } as unknown as StudioDataSource;

  const base = { widgetId: 'kpi-1', widgetSourceId: 'sales', dataSource: source } as const;

  it('tier 1: an in-scope date filter outranks the stored config field', () => {
    // The panel replaces the time-field picker with "Using the date filter on X" as soon as a
    // filter is in scope, so a rule where the stored config won would contradict the only
    // affordance the user has.
    const filter = makeFilter({ field: 'shippedAt', fieldType: 'date' });
    const resolved = resolveKpiDateField({
      ...base,
      config: { kpiSparklineField: 'createdAt' },
      scopedFilters: [filter],
    });
    expect(resolved).toMatchObject({
      field: 'shippedAt',
      sourceId: 'sales',
      isNative: true,
      origin: 'filter',
    });
  });

  it('tier 1: reports a CROSS-SOURCE date filter with its owning source rather than discarding it', () => {
    // Pre-M5 the sparkline threw this away (it only accepted a native filter field), so a page
    // filter on a related source rendered no sparkline while the panel claimed it was in use.
    const filter = makeFilter({
      field: 'orderDate',
      fieldType: 'date',
      filterSourceId: 'orders',
    });
    const resolved = resolveKpiDateField({ ...base, config: {}, scopedFilters: [filter] });
    expect(resolved).toMatchObject({
      field: 'orderDate',
      sourceId: 'orders',
      isNative: false,
      origin: 'filter',
    });
  });

  it('tier 2: falls back to the configured field, carrying kpiSparklineSourceId', () => {
    const resolved = resolveKpiDateField({
      ...base,
      config: { kpiSparklineField: 'orderDate', kpiSparklineSourceId: 'orders' },
      scopedFilters: [],
    });
    expect(resolved).toMatchObject({
      field: 'orderDate',
      sourceId: 'orders',
      isNative: false,
      origin: 'config',
    });
  });

  it('tier 3: falls back to the first own-source date field, and never reports it as cross-source', () => {
    // The hedged M5 sub-finding: the fixed-period trend used to read `kpiSparklineSourceId`
    // independently of the field it had resolved, so a config with a stale source id but no
    // field fell back to an OWN-source column while still claiming to be cross-source.
    const resolved = resolveKpiDateField({
      ...base,
      config: { kpiSparklineSourceId: 'orders' },
      scopedFilters: [],
    });
    expect(resolved).toMatchObject({
      field: 'createdAt',
      sourceId: 'sales',
      isNative: true,
      origin: 'source-default',
    });
  });

  it('reports no field when nothing resolves, and always surfaces the in-scope date filter', () => {
    const dateless: StudioDataSource = {
      id: 'lookup',
      label: 'Lookup',
      fields: [{ id: 'name', label: 'Name', type: 'string' }],
      rows: [],
    } as unknown as StudioDataSource;
    const resolved = resolveKpiDateField({
      widgetId: 'kpi-1',
      widgetSourceId: 'lookup',
      dataSource: dateless,
      config: {},
      scopedFilters: [],
    });
    expect(resolved).toMatchObject({ field: null, isNative: false, origin: 'none' });
    expect(resolved.dateFilter).toBeUndefined();

    // The filter is reported even when it did not win the field choice, because callers use
    // it for auto-granularity.
    const filter = makeFilter({ field: 'createdAt', fieldType: 'date' });
    expect(resolveKpiDateField({ ...base, config: {}, scopedFilters: [filter] }).dateFilter).toBe(
      filter,
    );
  });
});
