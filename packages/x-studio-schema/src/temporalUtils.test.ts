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
});
