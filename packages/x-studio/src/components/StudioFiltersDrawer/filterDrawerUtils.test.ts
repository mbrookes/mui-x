import { describe, expect, it } from 'vitest';
import {
  absoluteToRelative,
  buildFieldOptions,
  buildModeReset,
  defaultValueForMode,
  getOperators,
  isRelativeDateValue,
  relativeToAbsolute,
  summarizeFilter,
} from './filterDrawerUtils';
import type { StudioDataSource, StudioFilterState } from '../../models';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFilter(overrides: Partial<StudioFilterState>): StudioFilterState {
  return {
    id: 'f1',
    field: 'value',
    operator: 'equals',
    value: '',
    scope: 'widget',
    ...overrides,
  };
}

// ─── getOperators ─────────────────────────────────────────────────────────────

describe('getOperators', () => {
  it('returns string operators by default', () => {
    const ops = getOperators(undefined);
    expect(ops.some((o) => o.value === 'contains')).toBe(true);
    expect(ops.some((o) => o.value === 'starts_with')).toBe(true);
    expect(ops.some((o) => o.value === 'is_empty')).toBe(true);
  });

  it('returns number operators for number type', () => {
    const ops = getOperators('number');
    expect(ops.some((o) => o.value === 'greater_than')).toBe(true);
    expect(ops.some((o) => o.value === 'less_than_or_equal')).toBe(true);
    expect(ops.every((o) => o.value !== 'contains')).toBe(true);
  });

  it('returns date operators for date type', () => {
    const ops = getOperators('date');
    expect(ops.some((o) => o.value === 'greater_than')).toBe(true);
    expect(ops.some((o) => o.value === 'less_than')).toBe(true);
    expect(ops.every((o) => o.value !== 'contains')).toBe(true);
  });

  it('returns datetime operators for datetime type', () => {
    const ops = getOperators('datetime');
    expect(ops.some((o) => o.value === 'greater_than_or_equal')).toBe(true);
  });

  it('returns boolean operators for boolean type', () => {
    const ops = getOperators('boolean');
    expect(ops.map((o) => o.value)).toEqual(['equals', 'not_equals']);
  });

  it('falls back to string operators for unknown type', () => {
    const ops = getOperators('unknown' as any);
    expect(ops.some((o) => o.value === 'contains')).toBe(true);
  });
});

// ─── summarizeFilter — condition mode ────────────────────────────────────────

describe('summarizeFilter — condition mode', () => {
  it('equals with string value', () => {
    expect(summarizeFilter(makeFilter({ operator: 'equals', value: 'foo' }))).toBe('Equals: foo');
  });

  it('is_empty — no value shown', () => {
    expect(summarizeFilter(makeFilter({ operator: 'is_empty', value: '' }))).toBe('is empty');
  });

  it('is_not_empty — no value shown', () => {
    expect(summarizeFilter(makeFilter({ operator: 'is_not_empty', value: '' }))).toBe('is not empty');
  });

  it('contains operator', () => {
    expect(summarizeFilter(makeFilter({ operator: 'contains', value: 'bar' }))).toBe('Contains: bar');
  });

  it('between with from and to', () => {
    expect(
      summarizeFilter(makeFilter({ operator: 'between', value: { from: '10', to: '20' }, fieldType: 'string' })),
    ).toBe('between: 10 — 20');
  });

  it('between with from only', () => {
    expect(summarizeFilter(makeFilter({ operator: 'between', value: { from: '10' }, fieldType: 'string' }))).toBe(
      'from 10',
    );
  });

  it('between with to only', () => {
    expect(summarizeFilter(makeFilter({ operator: 'between', value: { to: '20' }, fieldType: 'string' }))).toBe(
      'until 20',
    );
  });

  it('between with no range shows operator label only', () => {
    expect(summarizeFilter(makeFilter({ operator: 'between', value: null }))).toMatch(/between/i);
  });

  it('relative date value is formatted as human text', () => {
    const result = summarizeFilter(
      makeFilter({
        operator: 'greater_than',
        fieldType: 'date',
        value: { relative: true, amount: 3, unit: 'month', direction: 'past' },
      }),
    );
    expect(result).toContain('3 months ago');
  });

  it('relative date value — singular unit (1 day)', () => {
    const result = summarizeFilter(
      makeFilter({
        operator: 'less_than',
        fieldType: 'date',
        value: { relative: true, amount: 1, unit: 'day', direction: 'next' },
      }),
    );
    expect(result).toContain('1 day from now');
  });

  it('empty value shows operator label only', () => {
    expect(summarizeFilter(makeFilter({ operator: 'equals', value: '' }))).toBe('Equals');
  });

  it('AND compound condition', () => {
    const result = summarizeFilter(
      makeFilter({
        operator: 'greater_than',
        value: 10,
        fieldType: 'number',
        operator2: 'less_than',
        value2: 50,
        conjunction: 'and',
      }),
    );
    expect(result).toContain('AND');
    expect(result).toContain('>: 10');
    expect(result).toContain('<: 50');
  });

  it('OR compound condition', () => {
    const result = summarizeFilter(
      makeFilter({
        operator: 'less_than',
        value: 5,
        fieldType: 'number',
        operator2: 'greater_than',
        value2: 95,
        conjunction: 'or',
      }),
    );
    expect(result).toContain('OR');
  });

  it('metric ref shows ⚡ metric for primary value', () => {
    const result = summarizeFilter(
      makeFilter({
        operator: 'greater_than',
        fieldType: 'number',
        value: '',
        valueRef: { sourceId: 'metrics', rowId: 'BM-001', field: 'value' },
      }),
    );
    expect(result).toContain('⚡ metric');
  });

  it('metric ref shows ⚡ metric for secondary value', () => {
    const result = summarizeFilter(
      makeFilter({
        operator: 'greater_than',
        value: 0,
        fieldType: 'number',
        operator2: 'less_than',
        value2: '',
        value2Ref: { sourceId: 'metrics', rowId: 'BM-001', field: 'value' },
        conjunction: 'and',
      }),
    );
    expect(result).toContain('⚡ metric');
    expect(result).toContain('AND');
  });
});

// ─── summarizeFilter — selection mode ────────────────────────────────────────

describe('summarizeFilter — selection mode', () => {
  it('shows "is one of" with selected values', () => {
    const result = summarizeFilter(
      makeFilter({ filterMode: 'selection', value: ['Alpha', 'Beta'] }),
    );
    expect(result).toBe('is one of: Alpha, Beta');
  });

  it('shows up to 3 values then "and N more"', () => {
    const result = summarizeFilter(
      makeFilter({ filterMode: 'selection', value: ['A', 'B', 'C', 'D', 'E'] }),
    );
    expect(result).toContain('and 2 more');
    expect(result).toContain('A, B, C');
  });

  it('truncates long values with ellipsis', () => {
    const longValue = 'A'.repeat(25);
    const result = summarizeFilter(makeFilter({ filterMode: 'selection', value: [longValue] }));
    expect(result).toContain('…');
    expect(result.length).toBeLessThan(50);
  });

  it('empty selection shows "any value"', () => {
    expect(summarizeFilter(makeFilter({ filterMode: 'selection', value: [] }))).toBe('any value');
  });
});

// ─── summarizeFilter — rank mode ─────────────────────────────────────────────

describe('summarizeFilter — rank mode', () => {
  it('shows "Top N · field" for top direction', () => {
    const result = summarizeFilter(
      makeFilter({ filterMode: 'rank', rankDirection: 'top', value: 10 }),
    );
    expect(result).toBe('Top 10 · value');
  });

  it('shows "Bottom N · field" for bottom direction', () => {
    const result = summarizeFilter(
      makeFilter({ filterMode: 'rank', rankDirection: 'bottom', value: 5 }),
    );
    expect(result).toBe('Bottom 5 · value');
  });

  it('shows "?" when value is missing', () => {
    const result = summarizeFilter(
      makeFilter({ filterMode: 'rank', rankDirection: 'top', value: '' }),
    );
    expect(result).toBe('Top ? · value');
  });

  it('defaults to "Top" when rankDirection not set', () => {
    const result = summarizeFilter(makeFilter({ filterMode: 'rank', value: 3 }));
    expect(result).toBe('Top 3 · value');
  });

  it('omits field when filter has no field', () => {
    const result = summarizeFilter(
      makeFilter({ filterMode: 'rank', rankDirection: 'top', value: 7, field: '' }),
    );
    expect(result).toBe('Top 7');
  });
});

// ─── isRelativeDateValue ──────────────────────────────────────────────────────

describe('isRelativeDateValue', () => {
  it('returns true for a valid relative date object', () => {
    expect(isRelativeDateValue({ relative: true, amount: 3, unit: 'day', direction: 'past' })).toBe(true);
  });

  it('returns false for absolute date string', () => {
    expect(isRelativeDateValue('2024-01-01')).toBe(false);
  });

  it('returns false for number', () => {
    expect(isRelativeDateValue(42)).toBe(false);
  });

  it('returns false for null', () => {
    expect(isRelativeDateValue(null)).toBe(false);
  });

  it('returns false for object without relative:true', () => {
    expect(isRelativeDateValue({ amount: 5, unit: 'day', direction: 'past' })).toBe(false);
  });
});

// ─── absoluteToRelative ───────────────────────────────────────────────────────

describe('absoluteToRelative', () => {
  it('converts a ~5-day-past date to days', () => {
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 5);
    const result = absoluteToRelative(pastDate.toISOString().slice(0, 10));
    expect(result.direction).toBe('past');
    expect(result.relative).toBe(true);
    expect(result.unit).toBe('day');
    expect(result.amount).toBeGreaterThanOrEqual(4);
    expect(result.amount).toBeLessThanOrEqual(6);
  });

  it('converts a ~14-day-future date to weeks', () => {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 14);
    const result = absoluteToRelative(futureDate.toISOString().slice(0, 10));
    expect(result.direction).toBe('next');
    expect(result.unit).toBe('week');
    expect(result.amount).toBe(2);
  });

  it('converts a ~30-day-past date to months', () => {
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 30);
    const result = absoluteToRelative(pastDate.toISOString().slice(0, 10));
    expect(result.direction).toBe('past');
    expect(result.unit).toBe('month');
    expect(result.amount).toBe(1);
  });

  it('converts a ~2-year-past date to years', () => {
    const pastDate = new Date();
    pastDate.setFullYear(pastDate.getFullYear() - 2);
    const result = absoluteToRelative(pastDate.toISOString().slice(0, 10));
    expect(result.direction).toBe('past');
    expect(result.unit).toBe('year');
    expect(result.amount).toBe(2);
  });

  it('returns a fallback for invalid date', () => {
    const result = absoluteToRelative('not-a-date');
    expect(result.relative).toBe(true);
    expect(result.amount).toBe(1);
    expect(result.unit).toBe('day');
  });
});

// ─── relativeToAbsolute ───────────────────────────────────────────────────────

describe('relativeToAbsolute', () => {
  it('returns approximate past date string', () => {
    const result = relativeToAbsolute({ relative: true, amount: 30, unit: 'day', direction: 'past' });
    const expected = new Date();
    expected.setDate(expected.getDate() - 30);
    // Allow ±1 day tolerance
    const diff = Math.abs(new Date(result).getTime() - expected.getTime());
    expect(diff).toBeLessThan(2 * 24 * 60 * 60 * 1000);
  });

  it('returns approximate future date string in YYYY-MM-DD format', () => {
    const result = relativeToAbsolute({ relative: true, amount: 7, unit: 'day', direction: 'next' });
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const diff = new Date(result).getTime() - Date.now();
    expect(diff).toBeGreaterThan(0);
  });
});

// ─── defaultValueForMode ──────────────────────────────────────────────────────

describe('defaultValueForMode', () => {
  it('condition mode returns empty string', () => {
    expect(defaultValueForMode('condition')).toBe('');
  });

  it('selection mode returns empty array', () => {
    expect(defaultValueForMode('selection')).toEqual([]);
  });

  it('rank mode returns 10', () => {
    expect(defaultValueForMode('rank')).toBe(10);
  });
});

// ─── buildFieldOptions ────────────────────────────────────────────────────────

describe('buildFieldOptions', () => {
  const dataSources: Record<string, StudioDataSource> = {
    orders: {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'total', label: 'Total', type: 'number' },
        { id: 'status', label: 'Status', type: 'string' },
        { id: 'internalId', label: 'Internal ID', type: 'string', hidden: true },
      ],
      rows: [],
    },
    customers: {
      id: 'customers',
      label: 'Customers',
      fields: [{ id: 'country', label: 'Country', type: 'string' }],
      rows: [],
    },
  };

  it('returns one option per non-hidden field across all sources', () => {
    const options = buildFieldOptions(dataSources);
    expect(options).toHaveLength(3); // total, status, country (internalId hidden)
  });

  it('hidden fields are excluded', () => {
    const options = buildFieldOptions(dataSources);
    expect(options.every((o) => o.id !== 'internalId')).toBe(true);
  });

  it('each option carries sourceId and sourceLabel', () => {
    const options = buildFieldOptions(dataSources);
    const totalOpt = options.find((o) => o.id === 'total');
    expect(totalOpt?.sourceId).toBe('orders');
    expect(totalOpt?.sourceLabel).toBe('Orders');
  });

  it('fieldType is correctly propagated', () => {
    const options = buildFieldOptions(dataSources);
    expect(options.find((o) => o.id === 'total')?.fieldType).toBe('number');
    expect(options.find((o) => o.id === 'status')?.fieldType).toBe('string');
  });

  it('returns empty array for empty dataSources', () => {
    expect(buildFieldOptions({})).toEqual([]);
  });
});

// ─── buildModeReset ───────────────────────────────────────────────────────────

describe('buildModeReset', () => {
  it('returns filterMode and clears value/operator fields', () => {
    const reset = buildModeReset('condition');
    expect(reset.filterMode).toBe('condition');
    expect(reset.value).toBe('');
    expect(reset.operator2).toBeUndefined();
    expect(reset.value2).toBeUndefined();
    expect(reset.conjunction).toBeUndefined();
    expect(reset.rankDirection).toBeUndefined();
    expect(reset.rankMultiSeriesBy).toBeUndefined();
    expect(reset.valueRef).toBeUndefined();
  });

  it('sets rankDirection to "top" when switching to rank mode', () => {
    const reset = buildModeReset('rank');
    expect(reset.filterMode).toBe('rank');
    expect(reset.rankDirection).toBe('top');
    expect(reset.value).toBe(10);
  });

  it('clears rankDirection when switching away from rank mode', () => {
    const reset = buildModeReset('selection');
    expect(reset.rankDirection).toBeUndefined();
    expect(reset.rankMultiSeriesBy).toBeUndefined();
  });

  it('sets value to empty array for selection mode', () => {
    const reset = buildModeReset('selection');
    expect(reset.value).toEqual([]);
  });
});
