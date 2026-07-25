import { describe, expect, it } from 'vitest';
import { isoWeek, truncateToPeriod } from './temporalUtils';

describe('truncateToPeriod', () => {
  it('day: returns YYYY-MM-DD', () => {
    expect(truncateToPeriod(new Date('2024-03-15'), 'day')).toBe('2024-03-15');
  });

  it('month: returns YYYY-MM', () => {
    expect(truncateToPeriod(new Date('2024-03-15'), 'month')).toBe('2024-03');
  });

  it('accepts a canonical ISO date string via the fast path', () => {
    expect(truncateToPeriod('2024-06-20', 'month')).toBe('2024-06');
  });

  it('accepts a canonical ISO datetime string', () => {
    expect(truncateToPeriod('2024-06-20T14:32:00.000Z', 'day')).toBe('2024-06-20');
  });

  it('returns null for an unparseable string', () => {
    expect(truncateToPeriod('not-a-date', 'month')).toBeNull();
  });

  it('returns null for an unrecognized granularity', () => {
    expect(truncateToPeriod(new Date('2024-03-15'), 'decade')).toBeNull();
  });

  describe('quarter', () => {
    it('buckets Q1-Q4 correctly', () => {
      expect(truncateToPeriod(new Date('2024-01-05'), 'quarter')).toBe('2024-Q1');
      expect(truncateToPeriod(new Date('2024-04-01'), 'quarter')).toBe('2024-Q2');
      expect(truncateToPeriod(new Date('2024-07-20'), 'quarter')).toBe('2024-Q3');
      expect(truncateToPeriod(new Date('2024-12-31'), 'quarter')).toBe('2024-Q4');
    });
  });

  describe('year', () => {
    it('returns the 4-digit year', () => {
      expect(truncateToPeriod(new Date('2024-03-15'), 'year')).toBe('2024');
    });
  });

  describe('week (ISO edge years)', () => {
    it('buckets an early-January date into the prior ISO year (2023-01-01 -> 2022-W52)', () => {
      // Jan 1, 2023 is a Sunday, which belongs to ISO week 52 of 2022.
      expect(truncateToPeriod(new Date('2023-01-01'), 'week')).toBe('2022-W52');
    });

    it('buckets a late-December date into the next ISO year (2024-12-31 -> 2025-W01)', () => {
      // Dec 31, 2024 is a Tuesday, which falls in ISO week 1 of 2025.
      expect(truncateToPeriod(new Date('2024-12-31'), 'week')).toBe('2025-W01');
    });

    it('returns a well-formed ISO week key for an ordinary date', () => {
      const key = truncateToPeriod(new Date('2024-01-08'), 'week');
      expect(key).toMatch(/^\d{4}-W\d{2}$/);
      expect(key).toBe('2024-W02');
    });
  });

  describe('numeric timestamp fallback', () => {
    it('accepts a millisecond epoch timestamp', () => {
      const ms = Date.UTC(2024, 2, 15); // March 15, 2024 UTC
      expect(truncateToPeriod(ms, 'day')).toBe('2024-03-15');
    });

    it('returns null for NaN-producing numeric input', () => {
      expect(truncateToPeriod(Number.NaN, 'day')).toBeNull();
    });
  });

  describe('invalid input rejection', () => {
    it('returns null for null/undefined', () => {
      expect(truncateToPeriod(null, 'day')).toBeNull();
      expect(truncateToPeriod(undefined, 'day')).toBeNull();
    });

    it('returns null for a non-date object', () => {
      expect(truncateToPeriod({ foo: 'bar' }, 'day')).toBeNull();
    });

    it('returns null for an invalid Date instance', () => {
      expect(truncateToPeriod(new Date('invalid'), 'day')).toBeNull();
    });
  });

  // 1.6: an ISO string with an explicit UTC offset must NOT be fast-pathed by slicing
  // the written components — it falls through to `new Date(...)`, which converts to UTC.
  describe('explicit UTC offset handling', () => {
    it('converts a positive offset to UTC (crosses back a day)', () => {
      // +05:00 local → 2024-05-31T20:00:00Z, so the UTC day is May 31.
      expect(truncateToPeriod('2024-06-01T01:00:00+05:00', 'day')).toBe('2024-05-31');
      expect(truncateToPeriod('2024-06-01T01:00:00+05:00', 'month')).toBe('2024-05');
    });

    it('converts a negative offset to UTC (crosses a year boundary)', () => {
      // -05:00 local → 2025-01-01T04:00:00Z, so the UTC day is Jan 1 of the next year.
      expect(truncateToPeriod('2024-12-31T23:00:00-05:00', 'day')).toBe('2025-01-01');
    });

    it('still fast-paths an offset-free datetime with a trailing Z', () => {
      expect(truncateToPeriod('2024-06-20T14:32:00Z', 'day')).toBe('2024-06-20');
    });

    it('returns null for out-of-range month/day (falls through to Invalid Date)', () => {
      expect(truncateToPeriod('2024-13-40', 'day')).toBeNull();
      expect(truncateToPeriod('2024-99-01', 'day')).toBeNull();
    });

    // Tier3 finding: a non-offset garbage tail must be ignored (only the leading
    // `YYYY-MM-DD` is read), even when that garbage happens to contain a literal `-`
    // that is not a timezone offset. The offset guard now anchors to the END of the
    // tail (`/[+-]\d{2}:?\d{2}$/`) instead of a bare `.includes('-')`, which previously
    // mistook a `-` anywhere in the garbage for an offset and fell through to
    // `new Date(...)` — returning `null` instead of the documented best-effort date.
    it('ignores a non-offset garbage tail containing a literal hyphen (Tier3)', () => {
      expect(truncateToPeriod('2024-06-01Tgarbage-more', 'day')).toBe('2024-06-01');
      expect(truncateToPeriod('2024-06-01Tgarbage-more', 'month')).toBe('2024-06');
    });

    it('still converts a REAL offset even when preceded by unrelated hyphenated text', () => {
      // The offset itself is a real `-05:00` at the end of the tail — must still
      // trigger the slow (`new Date`) path and convert to UTC, not be short-circuited
      // by the presence of other hyphens.
      expect(truncateToPeriod('2024-12-31T23:00:00-05:00', 'day')).toBe('2025-01-01');
    });
  });

  // Iteration-20 finding: a year in [0, 99] hit the `Date.UTC`/multi-arg-`Date`
  // two-digit-year quirk (`Date.UTC(5, ...)` is interpreted as 1905, not year 5) and
  // was emitted unpadded (`'5'` instead of `'0005'`).
  describe('two-digit-year handling (Date.UTC quirk + zero-padding)', () => {
    it('zero-pads a year below 1000 for day/month/quarter/year granularities', () => {
      expect(truncateToPeriod('0005-06-15', 'day')).toBe('0005-06-15');
      expect(truncateToPeriod('0005-06-15', 'month')).toBe('0005-06');
      expect(truncateToPeriod('0005-06-15', 'quarter')).toBe('0005-Q2');
      expect(truncateToPeriod('0005-06-15', 'year')).toBe('0005');
    });

    it('does not misinterpret a two-digit year as 1900+year for week granularity', () => {
      const key = truncateToPeriod('0005-06-15', 'week');
      expect(key).not.toBeNull();
      expect(key).not.toMatch(/^19/);
      expect(key).toMatch(/^0005-W\d{2}$/);
    });
  });
});

describe('isoWeek', () => {
  it('computes the correct ISO year/week for a mid-year date', () => {
    expect(isoWeek(new Date('2024-06-15'))).toEqual({ year: 2024, week: 24 });
  });

  it('rolls a late-December date forward into next year week 1', () => {
    expect(isoWeek(new Date(Date.UTC(2024, 11, 31)))).toEqual({ year: 2025, week: 1 });
  });

  it('rolls an early-January date back into the previous year week 52', () => {
    expect(isoWeek(new Date(Date.UTC(2023, 0, 1)))).toEqual({ year: 2022, week: 52 });
  });

  // Iteration-20 finding: `isoWeek` internally rebuilt a `Date` via
  // `Date.UTC(d.getUTCFullYear(), ...)`, which reintroduces the two-digit-year quirk
  // even for an already-correct input `Date` whose year happens to be 0-99.
  it('does not misinterpret an input Date with a two-digit year as 1900+year', () => {
    const d = new Date(0);
    d.setUTCFullYear(5, 5, 15); // June 15, year 5 — set directly, no Date.UTC quirk.
    expect(d.getUTCFullYear()).toBe(5);
    const { year } = isoWeek(d);
    expect(year).toBeLessThan(100);
  });
});
