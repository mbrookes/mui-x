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

    // R4 finding: ISO 8601 also allows the HOUR-ONLY offset form (`±HH`), which is
    // exactly what PostgreSQL emits for a `timestamptz` rendered as text
    // (`2024-06-01 00:00:00+05`). The offset guard used to require FOUR offset digits, so
    // an hour-only offset took the fast path, sliced `YYYY-MM-DD` off the front and threw
    // the offset away — bucketing the value one period off, and making `+05` and `+05:00`
    // spellings of the SAME instant land in different buckets.
    it('converts an hour-only positive offset to UTC (crosses back a day)', () => {
      // +05 → 2024-05-31T19:00:00Z, so the UTC day is May 31.
      expect(truncateToPeriod('2024-06-01 00:00:00+05', 'day')).toBe('2024-05-31');
    });

    it('converts an hour-only negative offset to UTC (crosses forward a day)', () => {
      // -05 → 2024-06-02T04:00:00Z, so the UTC day is June 2.
      expect(truncateToPeriod('2024-06-01 23:00:00-05', 'day')).toBe('2024-06-02');
    });

    it('converts an hour-only negative offset that crosses a year boundary', () => {
      // -05 → 2025-01-01T01:00:00Z.
      expect(truncateToPeriod('2024-12-31 20:00:00-05', 'day')).toBe('2025-01-01');
      expect(truncateToPeriod('2024-12-31 20:00:00-05', 'month')).toBe('2025-01');
      expect(truncateToPeriod('2024-12-31 20:00:00-05', 'year')).toBe('2025');
    });

    it('buckets the `±HH` and `±HH:MM` spellings of one instant identically', () => {
      expect(truncateToPeriod('2024-06-01 00:00:00+05', 'day')).toBe(
        truncateToPeriod('2024-06-01T00:00:00+05:00', 'day'),
      );
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

  // The fast path's three ADMISSION conditions — the 10-char/`-`-position shape test, the
  // end-anchored offset test, and the coarse component range check — decide whether a value
  // is read by SLICING the written characters or handed to `new Date`. The `±HH` offset arm
  // is covered above; the length test and the range check were not tested in either
  // direction, so the fast path could have claimed values it must not.
  describe('fast-path admission (shape, anchor, coarse range)', () => {
    // Out of coarse range → falls through to `new Date`, which rejects all four → `null`.
    // Without the range check these would be sliced verbatim into nonsense keys like
    // `'2024-13-01'` and `'2024-06-00'`.
    it.each(['2024-13-01', '2024-00-01', '2024-06-00', '2024-06-32'])(
      'rejects the out-of-range %s instead of slicing it',
      (value) => {
        expect(truncateToPeriod(value, 'day')).toBeNull();
      },
    );

    // The documented asymmetry: this is a BOUNDS check, not a calendar-validity check. A
    // day that is in range but invalid for its month is kept AS WRITTEN rather than
    // overflowed the way `new Date('2024-06-31')` would (→ 2024-07-01). Pinning this is
    // what makes the four rejections above a boundary rather than "invalid dates are
    // rejected".
    it('keeps an in-range but calendar-invalid day as written, without reconciling it', () => {
      expect(truncateToPeriod('2024-06-31', 'day')).toBe('2024-06-31');
      expect(truncateToPeriod('2024-02-30', 'day')).toBe('2024-02-30');
    });

    // The offset test is anchored to the END of the tail. An RFC 9557 bracketed time-zone
    // annotation puts an offset-SHAPED substring mid-tail; `new Date` cannot parse that
    // string at all, so treating the substring as an offset would turn a perfectly
    // readable date into `null`.
    it('fast-paths an RFC 9557 value whose offset-shaped substring is not at the end', () => {
      expect(truncateToPeriod('2024-06-01T12:00:00-05:00[America/New_York]', 'day')).toBe(
        '2024-06-01',
      );
      // Not merely "any bracketed tail works": a real trailing offset still converts.
      expect(truncateToPeriod('2024-06-01T12:00:00-05:00', 'day')).toBe('2024-06-01');
      expect(truncateToPeriod('2024-06-01T20:00:00-05:00', 'day')).toBe('2024-06-02');
    });

    // Nine characters is not the canonical `YYYY-MM-DD` form, so the slice-based read must
    // not claim it — `value.slice(8, 10)` would silently read a ONE-digit day. The engine's
    // legacy parser reads `'0005-06-1'` as a completely different date, which is the point:
    // the two readings disagree, so admitting a short string changes the answer.
    it('does not fast-path a string shorter than the canonical YYYY-MM-DD', () => {
      const key = truncateToPeriod('0005-06-1', 'day');
      expect(key).not.toBe('0005-06-01');
      expect(key?.startsWith('0005')).toBe(false);
    });
  });
});

// R4 finding: `String(-5).padStart(4, '0')` yields `'00-5'`, so a negative (BCE) year
// produced keys like `'00-5-06-15'` / `'00-1-W52'` — the sign ended up buried inside
// the padding, violating the documented `YYYY-…` key shape and destroying sort order.
describe('negative (BCE) year handling', () => {
  it('pads a negative year with the sign kept in front', () => {
    expect(truncateToPeriod('-000005-06-15', 'day')).toBe('-0005-06-15');
    expect(truncateToPeriod('-000005-06-15', 'month')).toBe('-0005-06');
    expect(truncateToPeriod('-000005-06-15', 'quarter')).toBe('-0005-Q2');
    expect(truncateToPeriod('-000005-06-15', 'year')).toBe('-0005');
  });

  it('pads a negative year for week granularity too', () => {
    expect(truncateToPeriod('-000005-06-15', 'week')).toMatch(/^-\d{4}-W\d{2}$/);
  });

  it('never buries the sign inside the padding for a negative timestamp', () => {
    // A millisecond timestamp before 1 CE, as some DB drivers emit.
    const key = truncateToPeriod(-62_170_000_000_000, 'day');
    expect(key).not.toBeNull();
    expect(key).toMatch(/^-\d{4}-\d{2}-\d{2}$/);
  });

  /**
   * `toUtcYMD`'s two fast-path ADMISSION clauses, which were each pinned only by the other.
   *
   * The four RANGE clauses (`m >= 0`, `m <= 11`, `day >= 1`, `day <= 31`) all had tests. The
   * shape check (`value[4] === '-' && value[7] === '-'`) and the year's `!Number.isNaN(y)`
   * did not, because they mask each other: the dash check keeps `value.slice(0, 4)` numeric,
   * so no existing fixture makes `y` NaN, and the NaN check catches most of what the dash
   * check would otherwise admit. Removing EITHER left all 1053 tests of this package green.
   *
   * What escapes is a literal `'0NaN-06-15'` bucket key — `padYear(NaN)` — landing on a
   * chart axis and in an AI period summary. So: both directions of both clauses, on values
   * whose ONLY defect is the one under test.
   */
  describe('fast-path admission — the two clauses that masked each other', () => {
    it.each([
      // A four-character year slice that is not a number. `new Date` cannot parse these
      // either, so the fallback rejects them too and the whole value is null.
      ['a non-numeric year in a datetime', 'xxxx-06-15T00:00:00'],
      ['a partially numeric year', '20x4-06-15'],
    ])('returns null rather than a NaN year key for %s', (_label, value) => {
      // Without `!Number.isNaN(y)` this is `'0NaN-06-15'`.
      expect(truncateToPeriod(value, 'day')).toBeNull();
    });

    it('returns null for a date whose separators are not dashes', () => {
      // Without the `value[4] === '-' && value[7] === '-'` shape check the slices happen to
      // be numeric, so this fast-paths to `'2024-06-15'` — inventing a canonical key from a
      // value neither the fast path nor `new Date` should accept.
      expect(truncateToPeriod('2024_06_15', 'day')).toBeNull();
    });

    it('still fast-paths the canonical shapes (the other direction)', () => {
      // Neither clause may reject a legitimate value: "return null for everything" would
      // otherwise pass all three assertions above.
      expect(truncateToPeriod('2024-06-15', 'day')).toBe('2024-06-15');
      expect(truncateToPeriod('2024-06-15T14:32:00.000Z', 'day')).toBe('2024-06-15');
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
