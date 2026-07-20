import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import dayjs from 'dayjs';
import { applyFilters, resolveDateRangePresets, resolveRelativeDate } from './filterUtils';
import { computeDateRangePreset } from './dateRangeUtils';
import type { StudioFilterState } from '../models';

function makeFilter(overrides: Partial<StudioFilterState>): StudioFilterState {
  return {
    id: 'f1',
    field: 'value',
    operator: 'equals',
    value: '',
    scope: { kind: 'widget', widgetId: 'w1' },
    ...overrides,
  } as StudioFilterState;
}

// ─── String operators ─────────────────────────────────────────────────────────

describe('applyFilters — string operators', () => {
  const rows = [
    { id: 1, name: 'Apple' },
    { id: 2, name: 'Banana' },
    { id: 3, name: 'Cherry' },
    { id: 4, name: '' },
    { id: 5, name: null },
  ];

  it('equals', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'name', operator: 'equals', value: 'Banana' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2]);
  });

  it('not_equals', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'name', operator: 'not_equals', value: 'Apple' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2, 3, 4, 5]);
  });

  it('contains — case insensitive', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'name', operator: 'contains', value: 'an' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2]); // Banana
  });

  it('does_not_contain', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'name', operator: 'does_not_contain', value: 'a' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([3, 4, 5]); // Cherry, '', null
  });

  it('starts_with', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'name', operator: 'starts_with', value: 'ba' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2]);
  });

  it('not_starts_with', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'name', operator: 'not_starts_with', value: 'A' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2, 3, 4, 5]);
  });

  it('ends_with', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'name', operator: 'ends_with', value: 'ry' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([3]);
  });

  it('not_ends_with', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'name', operator: 'not_ends_with', value: 'e' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2, 3, 4, 5]);
  });

  it('is_empty — matches empty string and null', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'name', operator: 'is_empty', value: '' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([4, 5]);
  });

  it('is_not_empty', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'name', operator: 'is_not_empty', value: '' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it('in — matches any of the array values', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'name', operator: 'in', value: ['Apple', 'Cherry'] }),
    ]);
    expect(result.map((r) => r.id)).toEqual([1, 3]);
  });
});

// ─── Numeric operators ────────────────────────────────────────────────────────

describe('applyFilters — numeric operators', () => {
  const rows = [
    { id: 1, score: 10 },
    { id: 2, score: 20 },
    { id: 3, score: 30 },
    { id: 4, score: 20 },
  ];

  it('equals', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'score', operator: 'equals', value: 20, fieldType: 'number' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2, 4]);
  });

  it('not_equals', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'score', operator: 'not_equals', value: 20, fieldType: 'number' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([1, 3]);
  });

  it('greater_than', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'score', operator: 'greater_than', value: 20, fieldType: 'number' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([3]);
  });

  it('less_than', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'score', operator: 'less_than', value: 20, fieldType: 'number' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([1]);
  });

  it('greater_than_or_equal', () => {
    const result = applyFilters(rows, [
      makeFilter({
        field: 'score',
        operator: 'greater_than_or_equal',
        value: 20,
        fieldType: 'number',
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2, 3, 4]);
  });

  it('less_than_or_equal', () => {
    const result = applyFilters(rows, [
      makeFilter({
        field: 'score',
        operator: 'less_than_or_equal',
        value: 20,
        fieldType: 'number',
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual([1, 2, 4]);
  });

  it('between — inclusive', () => {
    const result = applyFilters(rows, [
      makeFilter({
        field: 'score',
        operator: 'between',
        value: { from: 15, to: 25 },
        fieldType: 'number',
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2, 4]);
  });

  it('between — from only', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'score', operator: 'between', value: { from: 25 }, fieldType: 'number' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([3]);
  });

  it('between — to only', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'score', operator: 'between', value: { to: 15 }, fieldType: 'number' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([1]);
  });

  it('between — null range passes all', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'score', operator: 'between', value: null, fieldType: 'number' }),
    ]);
    expect(result).toHaveLength(4);
  });

  it('between — a genuine 0 lower bound is honoured, not treated as unset (finding 2.25)', () => {
    const rows0 = [
      { id: 1, score: -5 }, // below 0 → excluded
      { id: 2, score: 0 }, // at the 0 lower bound → included
      { id: 3, score: 10 }, // within → included
      { id: 4, score: 25 }, // above upper bound → excluded
    ];
    const result = applyFilters(rows0, [
      makeFilter({
        field: 'score',
        operator: 'between',
        value: { from: 0, to: 20 },
        fieldType: 'number',
      }),
    ]);
    // A truthiness bound check treated `from: 0` as absent and admitted the -5 row.
    expect(result.map((r) => r.id)).toEqual([2, 3]);
  });

  it('string "20" coerces to number for comparison', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'score', operator: 'equals', value: '20', fieldType: 'number' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2, 4]);
  });

  // A null field value must be EXCLUDED from a numeric comparison, not coerced to 0
  // (`Number(null) === 0`) — consistent with the date-comparison branches in this same file,
  // which already guard with `rv != null`.
  describe('null field values are excluded, not coerced to 0', () => {
    const rowsWithNull = [
      { id: 1, score: -5 },
      { id: 2, score: null },
      { id: 3, score: 5 },
    ];

    it('greater_than: a null score does not satisfy "> -10" (would with Number(null)=0)', () => {
      const result = applyFilters(rowsWithNull, [
        makeFilter({ field: 'score', operator: 'greater_than', value: -10, fieldType: 'number' }),
      ]);
      expect(result.map((r) => r.id)).toEqual([1, 3]);
    });

    it('less_than: a null score does not satisfy "< 10" (would with Number(null)=0)', () => {
      const result = applyFilters(rowsWithNull, [
        makeFilter({ field: 'score', operator: 'less_than', value: 10, fieldType: 'number' }),
      ]);
      expect(result.map((r) => r.id)).toEqual([1, 3]);
    });

    it('greater_than_or_equal: a null score does not satisfy ">= 0"', () => {
      const result = applyFilters(rowsWithNull, [
        makeFilter({
          field: 'score',
          operator: 'greater_than_or_equal',
          value: 0,
          fieldType: 'number',
        }),
      ]);
      expect(result.map((r) => r.id)).toEqual([3]);
    });

    it('less_than_or_equal: a null score does not satisfy "<= 0"', () => {
      const result = applyFilters(rowsWithNull, [
        makeFilter({
          field: 'score',
          operator: 'less_than_or_equal',
          value: 0,
          fieldType: 'number',
        }),
      ]);
      expect(result.map((r) => r.id)).toEqual([1]);
    });

    it('between: a null score does not fall inside a range spanning 0', () => {
      const result = applyFilters(rowsWithNull, [
        makeFilter({
          field: 'score',
          operator: 'between',
          value: { from: -10, to: 10 },
          fieldType: 'number',
        }),
      ]);
      expect(result.map((r) => r.id)).toEqual([1, 3]);
    });
  });
});

// ─── Boolean operators ────────────────────────────────────────────────────────

describe('applyFilters — boolean operators', () => {
  const rows = [
    { id: 1, active: true },
    { id: 2, active: false },
    { id: 3, active: true },
  ];

  it('equals true', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'active', operator: 'equals', value: 'true', fieldType: 'boolean' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([1, 3]);
  });

  it('equals false', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'active', operator: 'equals', value: 'false', fieldType: 'boolean' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2]);
  });

  it('not_equals', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'active', operator: 'not_equals', value: 'true', fieldType: 'boolean' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2]);
  });
});

// ─── Date operators ───────────────────────────────────────────────────────────

describe('applyFilters — date operators', () => {
  const rows = [
    { id: 1, date: '2024-01-01' },
    { id: 2, date: '2024-06-15' },
    { id: 3, date: '2024-12-31' },
  ];

  it('equals', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'date', operator: 'equals', value: '2024-06-15', fieldType: 'date' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2]);
  });

  it('greater_than', () => {
    const result = applyFilters(rows, [
      makeFilter({
        field: 'date',
        operator: 'greater_than',
        value: '2024-06-15',
        fieldType: 'date',
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual([3]);
  });

  it('less_than', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'date', operator: 'less_than', value: '2024-06-15', fieldType: 'date' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([1]);
  });

  it('greater_than_or_equal', () => {
    const result = applyFilters(rows, [
      makeFilter({
        field: 'date',
        operator: 'greater_than_or_equal',
        value: '2024-06-15',
        fieldType: 'date',
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2, 3]);
  });

  it('less_than_or_equal', () => {
    const result = applyFilters(rows, [
      makeFilter({
        field: 'date',
        operator: 'less_than_or_equal',
        value: '2024-06-15',
        fieldType: 'date',
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual([1, 2]);
  });

  it('between dates', () => {
    const result = applyFilters(rows, [
      makeFilter({
        field: 'date',
        operator: 'between',
        value: { from: '2024-01-02', to: '2024-12-30' },
        fieldType: 'date',
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2]);
  });

  // Regression (finding 2.9): equals/not_equals used to compile to a raw `row[field] ==
  // filterVal`, bypassing the date normalization gt/lt/between apply via toComparable.
  // That made date `equals` unable to match Date objects, ms timestamps, or datetime
  // strings, and `equals` against a RelativeDateValue never matched anything.

  it('equals normalizes Date-object row values', () => {
    const mixedRows = [
      { id: 1, date: new Date('2024-01-01T00:00:00Z') },
      { id: 2, date: new Date('2024-06-15T09:30:00Z') },
      { id: 3, date: new Date('2024-12-31T00:00:00Z') },
    ];
    const result = applyFilters(mixedRows, [
      makeFilter({ field: 'date', operator: 'equals', value: '2024-06-15', fieldType: 'date' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2]);
  });

  it('equals normalizes millisecond-timestamp row values', () => {
    const tsRows = [
      { id: 1, date: Date.parse('2024-01-01T00:00:00Z') },
      { id: 2, date: Date.parse('2024-06-15T12:00:00Z') },
    ];
    const result = applyFilters(tsRows, [
      makeFilter({ field: 'date', operator: 'equals', value: '2024-06-15', fieldType: 'date' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2]);
  });

  it('equals resolves a RelativeDateValue instead of never matching', () => {
    const relRows = [
      { id: 'old', date: '1990-01-01' },
      { id: 'today', date: dayjs().format('YYYY-MM-DD') },
    ];
    const result = applyFilters(relRows, [
      makeFilter({
        field: 'date',
        operator: 'equals',
        value: { relative: true, amount: 0, unit: 'day', direction: 'past' },
        fieldType: 'date',
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual(['today']);
  });

  it('not_equals normalizes date row values and keeps nulls', () => {
    const mixedRows = [
      { id: 1, date: new Date('2024-06-15T09:30:00Z') },
      { id: 2, date: '2024-01-01' },
      { id: 3, date: null },
    ];
    const result = applyFilters(mixedRows, [
      makeFilter({ field: 'date', operator: 'not_equals', value: '2024-06-15', fieldType: 'date' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2, 3]);
  });

  // Regression coverage: a row that never went through L1 ingestion normalization
  // (`normalizeDataSourceRows`) — e.g. a foreign row pulled in during a cross-filter
  // semi-join, or an L4 re-filtered anchor/remote/junction row — can still carry a raw,
  // local-time-ambiguous `Date` object rather than the canonical UTC-midnight-anchored
  // `YYYY-MM-DD` string L1 would have produced. `toComparable`'s old
  // `d.toISOString().slice(0, 10)` read the UTC calendar date off such a value, which
  // day-shifts by one day for any UTC-positive-offset viewer. The fix reuses the same
  // timezone-safe day-string helper L1 itself uses (`normalizeToDateOnlyString`).
  describe('date comparisons on rows that never went through L1 normalization', () => {
    const originalTz = process.env.TZ;

    beforeEach(() => {
      // A positive-UTC-offset zone: local midnight Jan 15 is 18:30 UTC on Jan 14. Node
      // re-reads `TZ` per `Date` call (no restart needed), so this reliably reproduces
      // the day-shift for a UTC+ viewer regardless of the host machine's own timezone.
      process.env.TZ = 'Asia/Kolkata';
    });

    afterEach(() => {
      process.env.TZ = originalTz;
    });

    it('equals matches a raw local-midnight Date row value by its LOCAL calendar day', () => {
      const rows = [{ id: 1, date: new Date(2024, 0, 15) }]; // local Jan 15, 00:00
      const result = applyFilters(rows, [
        makeFilter({ field: 'date', operator: 'equals', value: '2024-01-15', fieldType: 'date' }),
      ]);
      // The old `toISOString().slice(0, 10)` reads the UTC calendar date — '2024-01-14' in
      // this positive-offset zone — silently excluding the row.
      expect(result.map((r) => r.id)).toEqual([1]);
    });

    it('greater_than_or_equal does not exclude a raw local-midnight Date row on the boundary day', () => {
      const rows = [{ id: 1, date: new Date(2024, 0, 15) }];
      const result = applyFilters(rows, [
        makeFilter({
          field: 'date',
          operator: 'greater_than_or_equal',
          value: '2024-01-15',
          fieldType: 'date',
        }),
      ]);
      expect(result.map((r) => r.id)).toEqual([1]);
    });
  });

  it('datetime equals matches the WHOLE day, not only exact midnight (finding 2.22)', () => {
    // The datetime picker commits a 'YYYY-MM-DD' string. Equality must match every row on that
    // calendar day (both sides truncated to day granularity), not only the midnight-stored row —
    // matching ARCHITECTURE.md's "in-memory equality matches the whole day against a DATETIME
    // column". A row on a different day is excluded.
    const dtRows = [
      { id: 1, ts: '2024-06-15T00:00:00.000Z' },
      { id: 2, ts: '2024-06-15T14:30:00.000Z' },
      { id: 3, ts: '2024-06-16T09:00:00.000Z' },
    ];
    const result = applyFilters(dtRows, [
      makeFilter({ field: 'ts', operator: 'equals', value: '2024-06-15', fieldType: 'datetime' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([1, 2]);
  });

  it('datetime not_equals excludes the whole matching day (finding 2.22)', () => {
    const dtRows = [
      { id: 1, ts: '2024-06-15T00:00:00.000Z' },
      { id: 2, ts: '2024-06-15T14:30:00.000Z' },
      { id: 3, ts: '2024-06-16T09:00:00.000Z' },
    ];
    const result = applyFilters(dtRows, [
      makeFilter({
        field: 'ts',
        operator: 'not_equals',
        value: '2024-06-15',
        fieldType: 'datetime',
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual([3]);
  });
});

// ─── Bare-date bounds vs datetime columns (finding 1.3) ───────────────────────
// A user-authored date-only bound ('2026-07-10') against a datetime column must compare at
// DAY granularity: `>=`/`<=`/`between`-bounds inclusive of the WHOLE day, `>`/`<` exclusive of
// it. Previously `toComparable('2026-07-10', 'datetime')` became midnight, so `<= Jul 10`
// dropped every non-midnight row of Jul 10 while `equals Jul 10` matched the whole day.
describe('applyFilters — bare-date bounds on datetime columns (finding 1.3)', () => {
  const dtRows = [
    { id: 1, ts: '2026-07-09T23:00:00.000Z' },
    { id: 2, ts: '2026-07-10T00:00:00.000Z' },
    { id: 3, ts: '2026-07-10T15:30:00.000Z' },
    { id: 4, ts: '2026-07-10T23:59:00.000Z' },
    { id: 5, ts: '2026-07-11T00:30:00.000Z' },
  ];

  it('less_than_or_equal includes the whole last day (the core bug)', () => {
    const result = applyFilters(dtRows, [
      makeFilter({
        field: 'ts',
        operator: 'less_than_or_equal',
        value: '2026-07-10',
        fieldType: 'datetime',
      }),
    ]);
    // All of Jul 10 kept (2,3,4) plus the earlier day (1); the Jul 11 row (5) excluded.
    expect(result.map((r) => r.id)).toEqual([1, 2, 3, 4]);
  });

  it('less_than excludes the whole named day', () => {
    const result = applyFilters(dtRows, [
      makeFilter({
        field: 'ts',
        operator: 'less_than',
        value: '2026-07-10',
        fieldType: 'datetime',
      }),
    ]);
    // Only rows strictly before Jul 10 survive — no Jul 10 row is kept.
    expect(result.map((r) => r.id)).toEqual([1]);
  });

  it('greater_than_or_equal includes the whole named day', () => {
    const result = applyFilters(dtRows, [
      makeFilter({
        field: 'ts',
        operator: 'greater_than_or_equal',
        value: '2026-07-10',
        fieldType: 'datetime',
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2, 3, 4, 5]);
  });

  it('greater_than excludes the whole named day', () => {
    const result = applyFilters(dtRows, [
      makeFilter({
        field: 'ts',
        operator: 'greater_than',
        value: '2026-07-10',
        fieldType: 'datetime',
      }),
    ]);
    // Every Jul 10 row excluded; only the Jul 11 row survives.
    expect(result.map((r) => r.id)).toEqual([5]);
  });

  it('between with bare-date bounds is inclusive of both whole days', () => {
    const result = applyFilters(dtRows, [
      makeFilter({
        field: 'ts',
        operator: 'between',
        value: { from: '2026-07-10', to: '2026-07-10' },
        fieldType: 'datetime',
      }),
    ]);
    // The single-day window covers all of Jul 10, not just its midnight instant.
    expect(result.map((r) => r.id)).toEqual([2, 3, 4]);
  });

  it('between mixes a bare-date lower bound with an explicit end-of-day upper bound', () => {
    // Mirrors the resolved-preset shape: `from` bare date, `to` an explicit UTC end-of-day.
    const result = applyFilters(dtRows, [
      makeFilter({
        field: 'ts',
        operator: 'between',
        value: { from: '2026-07-10', to: '2026-07-10T23:59:59.999Z' },
        fieldType: 'datetime',
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2, 3, 4]);
  });

  it('a bound carrying an explicit time keeps full-timestamp precision', () => {
    const result = applyFilters(dtRows, [
      makeFilter({
        field: 'ts',
        operator: 'less_than_or_equal',
        value: '2026-07-10T12:00:00.000Z',
        fieldType: 'datetime',
      }),
    ]);
    // Only rows at or before noon on Jul 10 — the whole-day inclusivity does NOT apply.
    // id 3 (15:30) is in the afternoon, so `<= 12:00` correctly excludes it.
    expect(result.map((r) => r.id)).toEqual([1, 2]);
  });
});

// ─── Relative date values ─────────────────────────────────────────────────────

describe('applyFilters — relative date values', () => {
  it('greater_than relative past: old rows are excluded', () => {
    // "date must be after 10 years ago" — 1990 row should be excluded, this year should pass
    const rows = [
      { id: 'old', date: '1990-01-01' },
      { id: 'recent', date: dayjs().subtract(1, 'month').format('YYYY-MM-DD') },
    ];
    const result = applyFilters(rows, [
      makeFilter({
        field: 'date',
        operator: 'greater_than',
        value: { relative: true, amount: 10, unit: 'year', direction: 'past' },
        fieldType: 'date',
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual(['recent']);
  });

  it('less_than relative future: far-future row excluded, nearby row passes', () => {
    const rows = [
      { id: 'near', date: dayjs().add(1, 'month').format('YYYY-MM-DD') },
      { id: 'far', date: '2099-12-31' },
    ];
    const result = applyFilters(rows, [
      makeFilter({
        field: 'date',
        operator: 'less_than',
        value: { relative: true, amount: 1, unit: 'year', direction: 'next' },
        fieldType: 'date',
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual(['near']);
  });
});

// ─── Selection mode ───────────────────────────────────────────────────────────

describe('applyFilters — selection mode', () => {
  const rows = [
    { id: 1, status: 'active' },
    { id: 2, status: 'inactive' },
    { id: 3, status: 'pending' },
    { id: 4, status: 'active' },
  ];

  it('matches rows in the selected set', () => {
    const result = applyFilters(rows, [
      makeFilter({
        field: 'status',
        filterMode: 'selection',
        operator: 'equals',
        value: ['active', 'pending'],
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual([1, 3, 4]);
  });

  it('empty selection passes all rows (filter considered incomplete)', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'status', filterMode: 'selection', operator: 'equals', value: [] }),
    ]);
    expect(result).toHaveLength(4);
  });

  // Regression: the multi-select "Exclude" toggle flips the operator to `not_in`. The
  // selection-mode compile path must honour it and EXCLUDE the selected values. It used
  // to ignore `operator` entirely, so Exclude was byte-identical to Include and filtered
  // TO exactly the values the user asked to exclude (silent, dashboard-wide wrong data).
  it('not_in (Exclude mode) keeps everything except the selected values', () => {
    const result = applyFilters(rows, [
      makeFilter({
        field: 'status',
        filterMode: 'selection',
        operator: 'not_in',
        value: ['active'],
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2, 3]); // inactive, pending
  });

  it('not_in (Exclude mode) excludes multiple selected values', () => {
    const result = applyFilters(rows, [
      makeFilter({
        field: 'status',
        filterMode: 'selection',
        operator: 'not_in',
        value: ['active', 'pending'],
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2]); // inactive
  });

  it('exact review repro: not_in ["Books"] over [Books, Games, Toys] returns Games, Toys', () => {
    const catRows = [
      { id: 1, category: 'Books' },
      { id: 2, category: 'Games' },
      { id: 3, category: 'Toys' },
    ];
    const result = applyFilters(catRows, [
      makeFilter({
        field: 'category',
        filterMode: 'selection',
        operator: 'not_in',
        value: ['Books'],
      }),
    ]);
    expect(result.map((r) => r.category)).toEqual(['Games', 'Toys']);
  });

  it('not_in and in are complementary partitions of the same selection', () => {
    const included = applyFilters(rows, [
      makeFilter({ field: 'status', filterMode: 'selection', operator: 'in', value: ['active'] }),
    ]);
    const excluded = applyFilters(rows, [
      makeFilter({
        field: 'status',
        filterMode: 'selection',
        operator: 'not_in',
        value: ['active'],
      }),
    ]);
    expect(included.map((r) => r.id)).toEqual([1, 4]);
    expect(excluded.map((r) => r.id)).toEqual([2, 3]);
  });
});

// ─── Rank mode ────────────────────────────────────────────────────────────────

describe('applyFilters — rank mode', () => {
  const rows = [
    { id: 'a', revenue: 100, category: 'X' },
    { id: 'b', revenue: 300, category: 'Y' },
    { id: 'c', revenue: 200, category: 'X' },
    { id: 'd', revenue: 50, category: 'Z' },
    { id: 'e', revenue: 400, category: 'Y' },
  ];

  it('top N by numeric field (direct)', () => {
    const result = applyFilters(rows, [
      makeFilter({
        field: 'revenue',
        filterMode: 'rank',
        operator: 'equals',
        value: 3,
        rankDirection: 'top',
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual(['e', 'b', 'c']);
  });

  it('bottom N by numeric field (direct)', () => {
    const result = applyFilters(rows, [
      makeFilter({
        field: 'revenue',
        filterMode: 'rank',
        operator: 'equals',
        value: 2,
        rankDirection: 'bottom',
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual(['d', 'a']);
  });

  it('coerces a non-numeric sentinel in a direct numeric rank instead of NaN-poisoning the sort (finding T3.1)', () => {
    // Row 'x' carries a non-numeric sentinel ("N/A") in the ranked field. Before the fix,
    // `Number('N/A' ?? 0)` was NaN — every comparison against it returned false, leaving
    // `toSorted` in an arbitrary engine-dependent order so the "top 3" was a meaningless subset.
    // With `coerceAggregateValue` the sentinel falls back to 0 (sorts to the bottom for `top`),
    // so the three real numeric winners are selected deterministically.
    const rowsWithSentinel = [
      { id: 'a', revenue: 100 },
      { id: 'b', revenue: 300 },
      { id: 'c', revenue: 200 },
      { id: 'x', revenue: 'N/A' },
      { id: 'e', revenue: 400 },
    ];
    const result = applyFilters(rowsWithSentinel, [
      makeFilter({
        field: 'revenue',
        filterMode: 'rank',
        operator: 'equals',
        value: 3,
        rankDirection: 'top',
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual(['e', 'b', 'c']);
  });

  it('top N by aggregate rankByField — keeps all rows belonging to top groups', () => {
    // Top 1 category by total revenue: Y = 700, X = 300, Z = 50 → only Y rows kept
    const result = applyFilters(rows, [
      makeFilter({
        field: 'category',
        filterMode: 'rank',
        operator: 'equals',
        value: 1,
        rankDirection: 'top',
        rankByField: 'revenue',
      }),
    ]);
    expect(result.map((r) => r.id).sort()).toEqual(['b', 'e']);
  });

  it('bottom N by aggregate rankByField', () => {
    const result = applyFilters(rows, [
      makeFilter({
        field: 'category',
        filterMode: 'rank',
        operator: 'equals',
        value: 2,
        rankDirection: 'bottom',
        rankByField: 'revenue',
      }),
    ]);
    // Bottom 2 categories: Z (50) and X (300)
    expect(result.map((r) => r.id).sort()).toEqual(['a', 'c', 'd']);
  });

  it('coerces a non-numeric rankByField sentinel instead of poisoning the group total (finding 3.5)', () => {
    // The 'Y' group carries a non-numeric sentinel ("N/A") in `revenue`. With the shared
    // `coerceAggregateValue` policy the sentinel contributes 0, so Y totals 300 and is the
    // clear top-1 group — both its rows survive. Before the fix, `Number('N/A' ?? 0)` was NaN,
    // which poisoned Y's running total to NaN and corrupted the top-N ordering (NaN comparisons
    // are always false), dropping the group that should have won.
    const rowsWithSentinel = [
      { id: 'a', revenue: 100, category: 'X' },
      { id: 'b', revenue: 'N/A', category: 'Y' },
      { id: 'c', revenue: 300, category: 'Y' },
      { id: 'd', revenue: 50, category: 'Z' },
    ];
    const result = applyFilters(rowsWithSentinel, [
      makeFilter({
        field: 'category',
        filterMode: 'rank',
        operator: 'equals',
        value: 1,
        rankDirection: 'top',
        rankByField: 'revenue',
      }),
    ]);
    expect(result.map((r) => r.id).sort()).toEqual(['b', 'c']);
  });

  it('rank N=0 is treated as incomplete and skipped', () => {
    const result = applyFilters(rows, [
      makeFilter({
        field: 'revenue',
        filterMode: 'rank',
        operator: 'equals',
        value: 0,
        rankDirection: 'top',
      }),
    ]);
    expect(result).toHaveLength(5);
  });

  // ─── Finding 2.4 ────────────────────────────────────────────────────────────
  it('applies condition filters BEFORE the rank filter, matching the adapter push-down order (finding 2.4)', () => {
    // Condition: category != 'Y' (excludes rows b and e, the two highest-revenue rows).
    // Rank: top 2 by revenue.
    //
    // "rank then filter" (the old, buggy order) ranks the FULL dataset first — e(400) and
    // b(300) win the top-2 slots — and only THEN applies the condition, which excludes both
    // (they're category 'Y'), leaving an empty result.
    //
    // "filter then rank" (the adapter's order, and the fix here) applies the condition first —
    // removing b and e — then ranks the survivors (a=100, c=200, d=50), correctly keeping the
    // top 2 among what's left: c and a.
    const result = applyFilters(rows, [
      makeFilter({
        field: 'category',
        operator: 'not_equals',
        value: 'Y',
      }),
      makeFilter({
        field: 'revenue',
        filterMode: 'rank',
        operator: 'equals',
        value: 2,
        rankDirection: 'top',
      }),
    ]);
    expect(result.map((r) => r.id).sort()).toEqual(['a', 'c']);
  });
});

// ─── Compound conditions (AND / OR) ───────────────────────────────────────────

describe('applyFilters — compound conditions', () => {
  const rows = [
    { id: 1, score: 10, tag: 'alpha' },
    { id: 2, score: 25, tag: 'beta' },
    { id: 3, score: 50, tag: 'alpha' },
    { id: 4, score: 75, tag: 'beta' },
  ];

  it('AND: both conditions must match', () => {
    const result = applyFilters(rows, [
      makeFilter({
        field: 'score',
        operator: 'greater_than',
        value: 20,
        fieldType: 'number',
        operator2: 'less_than',
        value2: 60,
        conjunction: 'and',
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2, 3]);
  });

  it('OR: either condition matches', () => {
    const result = applyFilters(rows, [
      makeFilter({
        field: 'score',
        operator: 'less_than',
        value: 15,
        fieldType: 'number',
        operator2: 'greater_than',
        value2: 60,
        conjunction: 'or',
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual([1, 4]);
  });

  it('incomplete second condition is ignored', () => {
    const result = applyFilters(rows, [
      makeFilter({
        field: 'score',
        operator: 'greater_than',
        value: 40,
        fieldType: 'number',
        operator2: 'less_than',
        value2: '', // incomplete
        conjunction: 'and',
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual([3, 4]);
  });
});

// ─── Multiple filters (all must pass) ─────────────────────────────────────────

describe('applyFilters — multiple simultaneous filters', () => {
  const rows = [
    { id: 1, score: 50, tag: 'alpha' },
    { id: 2, score: 50, tag: 'beta' },
    { id: 3, score: 10, tag: 'alpha' },
  ];

  it('all filters must pass (implicit AND across filters)', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'score', operator: 'equals', value: 50, fieldType: 'number' }),
      makeFilter({ id: 'f2', field: 'tag', operator: 'equals', value: 'alpha' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([1]);
  });
});

// ─── Incomplete filter handling ───────────────────────────────────────────────

describe('applyFilters — incomplete filters are skipped', () => {
  const rows = [
    { id: 1, name: 'test' },
    { id: 2, name: 'other' },
  ];

  it('filter with empty value is skipped', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'name', operator: 'equals', value: '' }),
    ]);
    expect(result).toHaveLength(2);
  });

  it('filter with null value is skipped', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'name', operator: 'equals', value: null }),
    ]);
    expect(result).toHaveLength(2);
  });

  it('filter with no field is skipped', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: '', operator: 'equals', value: 'test' }),
    ]);
    expect(result).toHaveLength(2);
  });

  it('is_empty and is_not_empty are always complete (no value needed)', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'name', operator: 'is_empty', value: '' }),
    ]);
    expect(result).toHaveLength(0);
  });

  it('empty filter array returns all rows', () => {
    const result = applyFilters(rows, []);
    expect(result).toHaveLength(2);
  });
});

// ─── resolveDateRangePresets ──────────────────────────────────────────────────

function makePresetFilter(overrides: Partial<StudioFilterState>): StudioFilterState {
  return {
    id: 'dr-1',
    field: 'orderDate',
    operator: 'between',
    value: null,
    scope: { kind: 'dashboard-date-range', sourceId: 's1', pageId: 'p1' },
    fieldType: 'date',
    ...overrides,
  } as StudioFilterState;
}

describe('resolveDateRangePresets', () => {
  it('short-circuits when no preset filters are present', () => {
    const filters = [makeFilter({ value: 'hello' })];
    expect(resolveDateRangePresets(filters)).toBe(filters);
  });

  it('leaves custom preset unchanged — its stored {from,to} is the user selection', () => {
    const filter = makePresetFilter({
      dateRangePreset: 'custom',
      value: { from: '2020-01-01', to: '2020-12-31' },
    });
    const result = resolveDateRangePresets([filter]);
    expect(result[0].value).toEqual({ from: '2020-01-01', to: '2020-12-31' });
    expect(result[0]).toBe(filter);
  });

  it('resolves last_12_months to a {from,to} range anchored on today', () => {
    const filter = makePresetFilter({ dateRangePreset: 'last_12_months', value: null });
    const [resolved] = resolveDateRangePresets([filter]);
    const range = resolved.value as { from: string; to: string };
    const today = new Date();
    const expectedFrom = new Date(today);
    expectedFrom.setFullYear(today.getFullYear() - 1);
    expect(range.to).toBe(today.toISOString().slice(0, 10));
    expect(range.from).toBe(expectedFrom.toISOString().slice(0, 10));
  });

  it('ignores stored absolute value — always recomputes from preset (heals stale persisted state)', () => {
    const staleFrom = '2000-01-01';
    const staleTo = '2000-12-31';
    const filter = makePresetFilter({
      dateRangePreset: 'ytd',
      value: { from: staleFrom, to: staleTo },
    });
    const [resolved] = resolveDateRangePresets([filter]);
    const range = resolved.value as { from: string; to: string };
    // Must NOT return the stale stored dates
    expect(range.from).not.toBe(staleFrom);
    expect(range.to).not.toBe(staleTo);
    // Must return current year's Jan 1 → today
    expect(range.from).toBe(`${new Date().getFullYear()}-01-01`);
    expect(range.to).toBe(new Date().toISOString().slice(0, 10));
  });

  it('resolves the to date to a UTC end-of-day for datetime fields (finding 1.3)', () => {
    const filter = makePresetFilter({ dateRangePreset: 'last_3_months', fieldType: 'datetime' });
    const [resolved] = resolveDateRangePresets([filter]);
    const range = resolved.value as { from: string; to: string };
    // End-of-day anchored in UTC (`…T23:59:59.999Z`) so both bounds share one timezone: the
    // bare-date `from` also parses as UTC midnight. A zone-less `…T23:59:59` parsed as local.
    expect(range.to).toMatch(/T23:59:59\.999Z$/);
    expect(range.from).not.toContain('T');
  });

  it('leaves non-preset filters untouched', () => {
    const plain = makeFilter({ field: 'name', value: 'Alice' });
    const preset = makePresetFilter({ dateRangePreset: 'last_12_months' });
    const result = resolveDateRangePresets([plain, preset]);
    expect(result[0]).toBe(plain);
    const range = result[1].value as { from: string; to: string };
    expect(typeof range.from).toBe('string');
    expect(typeof range.to).toBe('string');
  });

  it('preset filter with null value is applied to rows correctly', () => {
    const rows = [
      { id: 1, orderDate: '2020-06-01' },
      { id: 2, orderDate: new Date().toISOString().slice(0, 10) },
    ];
    const filter = makePresetFilter({ dateRangePreset: 'last_12_months' });
    const resolved = resolveDateRangePresets([filter]);
    const result = applyFilters(rows, resolved);
    // Today's date should be within the last 12 months; 2020 date should not
    expect(result.map((r) => r.id)).toContain(2);
    expect(result.map((r) => r.id)).not.toContain(1);
  });
});

// ── computeDateRangePreset edge cases ─────────────────────────────────────────

describe('computeDateRangePreset — edge cases', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('this_month on the last day of a 31-day month returns the full month', () => {
    // March 31 — to must be '2024-03-31', not roll into April
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-03-31T12:00:00Z'));
    const { from, to } = computeDateRangePreset('this_month');
    expect(from).toBe('2024-03-01');
    expect(to).toBe('2024-03-31');
  });

  it('this_month on the last day of February (leap year) returns the full month', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-02-29T12:00:00Z'));
    const { from, to } = computeDateRangePreset('this_month');
    expect(from).toBe('2024-02-01');
    expect(to).toBe('2024-02-29');
  });

  it('last_calendar_year on Jan 1 returns the previous full year', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
    const { from, to } = computeDateRangePreset('last_calendar_year');
    expect(from).toBe('2023-01-01');
    expect(to).toBe('2023-12-31');
  });

  it('this_calendar_year on Dec 31 returns the entire current year', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-12-31T23:59:59Z'));
    const { from, to } = computeDateRangePreset('this_calendar_year');
    expect(from).toBe('2024-01-01');
    expect(to).toBe('2024-12-31');
  });

  it('presets use local date not UTC (no off-by-one at midnight UTC)', () => {
    // The implementation uses `new Date()` and local getFullYear/getMonth/getDate.
    // In a UTC+2 timezone at 2024-03-31T23:30 local = 2024-03-31T21:30Z.
    // This test freezes at an unambiguous local noon to verify the ISO result.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T12:00:00'));
    const { from, to } = computeDateRangePreset('this_month');
    // June 15 — last day of June is 30
    expect(from).toBe('2024-06-01');
    expect(to).toBe('2024-06-30');
  });
});

// ── resolveRelativeDate — sub-day units ───────────────────────────────────────
//
// Regression coverage: `resolveRelativeDate` used to ALWAYS truncate to `YYYY-MM-DD`
// (`.format('YYYY-MM-DD')`) regardless of `unit`, so a filter authored as "after 1 hour ago"
// resolved to "after start of today" — silently widening the window to include the whole
// current day instead of the real hour-level cutoff.

describe('resolveRelativeDate — sub-day units', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves an hour-unit value to a full ISO instant, not a truncated day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T10:30:00.000Z'));
    const resolved = resolveRelativeDate({
      relative: true,
      amount: 1,
      unit: 'hour',
      direction: 'past',
    });
    expect(resolved).toBe('2024-06-15T09:30:00.000Z');
  });

  it('resolves a minute-unit value to a full ISO instant', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T10:30:00.000Z'));
    const resolved = resolveRelativeDate({
      relative: true,
      amount: 45,
      unit: 'minute',
      direction: 'past',
    });
    expect(resolved).toBe('2024-06-15T09:45:00.000Z');
  });

  it('resolves a second-unit value to a full ISO instant', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T10:30:30.000Z'));
    const resolved = resolveRelativeDate({
      relative: true,
      amount: 30,
      unit: 'second',
      direction: 'past',
    });
    expect(resolved).toBe('2024-06-15T10:30:00.000Z');
  });

  it('resolves a sub-day "next" direction forward from now', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T10:30:00.000Z'));
    const resolved = resolveRelativeDate({
      relative: true,
      amount: 2,
      unit: 'hour',
      direction: 'next',
    });
    expect(resolved).toBe('2024-06-15T12:30:00.000Z');
  });

  it('still resolves day/week/month/year units to a bare YYYY-MM-DD (no regression)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T10:30:00.000Z'));
    expect(resolveRelativeDate({ relative: true, amount: 1, unit: 'day', direction: 'past' })).toBe(
      '2024-06-14',
    );
    expect(
      resolveRelativeDate({ relative: true, amount: 1, unit: 'week', direction: 'past' }),
    ).toBe('2024-06-08');
    expect(
      resolveRelativeDate({ relative: true, amount: 1, unit: 'month', direction: 'past' }),
    ).toBe('2024-05-15');
    expect(
      resolveRelativeDate({ relative: true, amount: 1, unit: 'year', direction: 'past' }),
    ).toBe('2023-06-15');
  });
});

// ── applyFilters — sub-day relative date filters (client-side in-memory eval) ────

describe('applyFilters — sub-day relative date filters', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('an "after 1 hour ago" filter excludes rows older than an hour instead of including the whole day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T12:00:00.000Z'));
    const rows = [
      // Two hours old — earlier today, but older than the 1-hour cutoff: must be EXCLUDED.
      // The pre-fix behavior truncated the bound to "start of today", which would have
      // wrongly INCLUDED this row.
      { id: 'twoHoursAgo', ts: '2024-06-15T10:00:00.000Z' },
      { id: 'thirtyMinAgo', ts: '2024-06-15T11:30:00.000Z' },
      { id: 'now', ts: '2024-06-15T12:00:00.000Z' },
    ];
    const result = applyFilters(rows, [
      makeFilter({
        field: 'ts',
        operator: 'greater_than',
        value: { relative: true, amount: 1, unit: 'hour', direction: 'past' },
        fieldType: 'datetime',
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual(['thirtyMinAgo', 'now']);
  });

  it('a "greater_than_or_equal" minute-granularity filter matches at minute precision', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T12:00:00.000Z'));
    const rows = [
      { id: 'outsideWindow', ts: '2024-06-15T11:29:00.000Z' },
      { id: 'atBoundary', ts: '2024-06-15T11:30:00.000Z' },
      { id: 'insideWindow', ts: '2024-06-15T11:45:00.000Z' },
    ];
    const result = applyFilters(rows, [
      makeFilter({
        field: 'ts',
        operator: 'greater_than_or_equal',
        value: { relative: true, amount: 30, unit: 'minute', direction: 'past' },
        fieldType: 'datetime',
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual(['atBoundary', 'insideWindow']);
  });

  it('a between filter with a relative "from" bound at minute granularity only includes rows in the sub-day window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T12:00:00.000Z'));
    const rows = [
      { id: 'tooOld', ts: '2024-06-15T11:00:00.000Z' },
      { id: 'inWindow', ts: '2024-06-15T11:50:00.000Z' },
    ];
    const result = applyFilters(rows, [
      makeFilter({
        field: 'ts',
        operator: 'between',
        value: { from: { relative: true, amount: 30, unit: 'minute', direction: 'past' } },
        fieldType: 'datetime',
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual(['inWindow']);
  });

  it('a between filter with relative bounds on BOTH sides at different granularities resolves each independently', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T12:00:00.000Z'));
    const rows = [
      { id: 'tooOld', ts: '2024-06-15T09:00:00.000Z' }, // before the 2-hour-ago lower bound
      { id: 'inWindow', ts: '2024-06-15T11:00:00.000Z' },
      { id: 'tooNew', ts: '2024-06-15T12:30:00.000Z' }, // after the 15-min-from-now upper bound
    ];
    const result = applyFilters(rows, [
      makeFilter({
        field: 'ts',
        operator: 'between',
        value: {
          from: { relative: true, amount: 2, unit: 'hour', direction: 'past' },
          to: { relative: true, amount: 15, unit: 'minute', direction: 'next' },
        },
        fieldType: 'datetime',
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual(['inWindow']);
  });

  it('day-granularity relative filters are unaffected (no regression) — "3 days ago" still compares by whole day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T12:00:00.000Z'));
    const rows = [
      { id: 'fourDaysAgo', date: '2024-06-11' },
      { id: 'threeDaysAgo', date: '2024-06-12' },
      { id: 'twoDaysAgo', date: '2024-06-13' },
    ];
    const result = applyFilters(rows, [
      makeFilter({
        field: 'date',
        operator: 'greater_than_or_equal',
        value: { relative: true, amount: 3, unit: 'day', direction: 'past' },
        fieldType: 'date',
      }),
    ]);
    expect(result.map((r) => r.id)).toEqual(['threeDaysAgo', 'twoDaysAgo']);
  });
});
