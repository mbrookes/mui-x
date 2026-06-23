import { describe, expect, it, vi, afterEach } from 'vitest';
import dayjs from 'dayjs';
import { applyFilters, resolveDateRangePresets } from './filterUtils';
import { computeDateRangePreset } from './dateRangeUtils';
import type { StudioFilterState } from '../models';

function makeFilter(overrides: Partial<StudioFilterState>): StudioFilterState {
  return {
    id: 'f1',
    field: 'value',
    operator: 'equals',
    value: '',
    scopeV2: { kind: 'widget', widgetId: 'w1' },
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

  it('string "20" coerces to number for comparison', () => {
    const result = applyFilters(rows, [
      makeFilter({ field: 'score', operator: 'equals', value: '20', fieldType: 'number' }),
    ]);
    expect(result.map((r) => r.id)).toEqual([2, 4]);
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
    scopeV2: { kind: 'dashboard-date-range', sourceId: 's1', pageId: 'p1' },
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

  it('appends T23:59:59 to the to date for datetime fields', () => {
    const filter = makePresetFilter({ dateRangePreset: 'last_3_months', fieldType: 'datetime' });
    const [resolved] = resolveDateRangePresets([filter]);
    const range = resolved.value as { from: string; to: string };
    expect(range.to).toMatch(/T23:59:59$/);
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
