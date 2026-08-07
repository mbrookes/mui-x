import { describe, expect, it } from 'vitest';
import type { StudioDataSource, StudioFilterState } from '../models';
import { frLocaleText } from '../locales/fr';
import {
  absoluteToRelative,
  buildFieldOptions,
  buildFieldRepointReset,
  buildModeReset,
  defaultValueForMode,
  getOperators,
  isFilterEffective,
  isStrictRelativeDateValue,
  needsOperatorValueReset,
  relativeToAbsolute,
  resolveFilterField,
  summarizeFilter,
} from './filterDrawerUtils';

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── isFilterEffective ────────────────────────────────────────────────────────
// Regression coverage for architecture-review finding: a `disabled: true` filter still had a
// "meaningful" stored value, so `isFilterEffective` returned `true` for it — a cascading CHILD
// filter's option list (`PageFilterRow`'s `parentFilters`) kept being narrowed by a DISABLED
// parent's value as if it were still active. Disabling a filter must make it a no-op everywhere,
// including as a cascading dependency.

describe('isFilterEffective', () => {
  it('a condition filter with a value is effective', () => {
    expect(isFilterEffective(makeFilter({ operator: 'equals', value: 'foo' }))).toBe(true);
  });

  it('a selection filter with selected values is effective', () => {
    expect(isFilterEffective(makeFilter({ filterMode: 'selection', value: ['A'] }))).toBe(true);
  });

  it('a rank filter with a positive value is effective', () => {
    expect(isFilterEffective(makeFilter({ filterMode: 'rank', value: 10 }))).toBe(true);
  });

  it('a disabled condition filter with a value is NOT effective', () => {
    expect(
      isFilterEffective(makeFilter({ operator: 'equals', value: 'foo', disabled: true })),
    ).toBe(false);
  });

  it('a disabled selection filter with selected values is NOT effective', () => {
    expect(
      isFilterEffective(makeFilter({ filterMode: 'selection', value: ['A', 'B'], disabled: true })),
    ).toBe(false);
  });

  it('a disabled rank filter with a positive value is NOT effective', () => {
    expect(isFilterEffective(makeFilter({ filterMode: 'rank', value: 10, disabled: true }))).toBe(
      false,
    );
  });
});

// ─── summarizeFilter — condition mode ────────────────────────────────────────

describe('summarizeFilter — condition mode', () => {
  it('equals with string value', () => {
    expect(summarizeFilter(makeFilter({ operator: 'equals', value: 'foo' }))).toBe('Equals: foo');
  });

  it('is_empty — no value shown, routed through the localized operator label', () => {
    // Was hardcoded lowercase 'is empty'; now reuses the same
    // `filterOperator_string_is_empty` locale key as the operator picker (finding 3.2).
    expect(summarizeFilter(makeFilter({ operator: 'is_empty', value: '' }))).toBe('Is empty');
  });

  it('is_not_empty — no value shown, routed through the localized operator label', () => {
    expect(summarizeFilter(makeFilter({ operator: 'is_not_empty', value: '' }))).toBe(
      'Is not empty',
    );
  });

  it('is_empty / is_not_empty summaries translate via localeText', () => {
    expect(summarizeFilter(makeFilter({ operator: 'is_empty', value: '' }), frLocaleText)).toBe(
      'Est vide',
    );
    expect(summarizeFilter(makeFilter({ operator: 'is_not_empty', value: '' }), frLocaleText)).toBe(
      "N'est pas vide",
    );
  });

  it('contains operator', () => {
    expect(summarizeFilter(makeFilter({ operator: 'contains', value: 'bar' }))).toBe(
      'Contains: bar',
    );
  });

  it('between with from and to', () => {
    // `STRING_OPERATORS` has no `between`, so this pairing can only arrive from a host/AI
    // author or a field that changed type under the filter. The label must still be a
    // translated word — `getOperatorLabel` borrows it from the first table that defines the
    // operator — never the raw `between` enum identifier leaking into the UI.
    expect(
      summarizeFilter(
        makeFilter({ operator: 'between', value: { from: '10', to: '20' }, fieldType: 'string' }),
      ),
    ).toBe('Between: 10 — 20');
  });

  it('between with from only', () => {
    expect(
      summarizeFilter(
        makeFilter({ operator: 'between', value: { from: '10' }, fieldType: 'string' }),
      ),
    ).toBe('from 10');
  });

  it('between with to only', () => {
    expect(
      summarizeFilter(
        makeFilter({ operator: 'between', value: { to: '20' }, fieldType: 'string' }),
      ),
    ).toBe('until 20');
  });

  it('between with no range shows operator label only', () => {
    expect(summarizeFilter(makeFilter({ operator: 'between', value: null }))).toMatch(/between/i);
  });

  // Regression coverage for architecture-review finding 3.12: `summarizeFilter` used a
  // truthiness check on `range.from`/`range.to`, so a genuine `0` bound (falsy but present)
  // was treated as absent — "between 0 and 100" summarized as "until 100". Fixed by routing
  // through the same `hasBetweenBound` null/empty-string check the evaluator uses.
  it('between with a genuine 0 lower bound shows both bounds, not just "until"', () => {
    expect(
      summarizeFilter(
        makeFilter({ operator: 'between', value: { from: 0, to: 100 }, fieldType: 'number' }),
      ),
    ).toBe('Between: 0 — 100');
  });

  it('between with only a genuine 0 lower bound (no upper) shows "from 0"', () => {
    expect(
      summarizeFilter(makeFilter({ operator: 'between', value: { from: 0 }, fieldType: 'number' })),
    ).toBe('from 0');
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

  // `compileRowTest` gates the second condition on `isConditionComplete(operator2, value2)`.
  // The summary did not, so clicking "Add condition" — which seeds `{ operator2: 'equals',
  // value2: '' }` — immediately made every collapsed card, quick-filter chip and KPI tooltip
  // announce "Equals: north AND Equals" for a filter still doing only the first half.
  it('omits an INCOMPLETE second condition, matching what the engine applies', () => {
    const result = summarizeFilter(
      makeFilter({
        operator: 'contains',
        value: 'north',
        fieldType: 'string',
        operator2: 'equals',
        value2: '',
        conjunction: 'and',
      }),
    );
    expect(result).toBe('Contains: north');
  });

  it('keeps a value-less second condition, which the engine does apply', () => {
    const result = summarizeFilter(
      makeFilter({
        operator: 'contains',
        value: 'north',
        fieldType: 'string',
        operator2: 'is_empty',
        value2: '',
        conjunction: 'or',
      }),
    );
    expect(result).toContain('OR');
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

  // The last truthiness-on-a-filter-value site: `filter.value ? … : '?'` rendered "Top ?" for a
  // genuine `0`, the same class of bug `hasBetweenBound` and `SliderControl`'s `?? min` fixed.
  it('shows a genuine 0 rather than "?"', () => {
    expect(summarizeFilter(makeFilter({ filterMode: 'rank', value: 0 }))).toBe('Top 0 · value');
  });
});

// ─── summarizeFilter — localization ──────────────────────────────────────────
// Regression coverage for Tier-2 finding #7 in the architecture review:
// `summarizeFilter` used to hardcode English strings and call `getOperatorLabel`
// without locale text, so it was untranslatable across every surface that renders
// filter summaries (quick-filter-bar chips, drawer row summaries, KPI tooltip).

describe('summarizeFilter — localization', () => {
  it('defaults to English when localeText is omitted (backward compatible)', () => {
    expect(summarizeFilter(makeFilter({ operator: 'equals', value: 'foo' }))).toBe('Equals: foo');
  });

  it('localizes the operator label in condition mode', () => {
    const result = summarizeFilter(
      makeFilter({ operator: 'equals', value: 'foo', fieldType: 'string' }),
      frLocaleText,
    );
    expect(result).toBe('Est égal à: foo');
  });

  it('localizes "any value" for an empty selection filter', () => {
    const result = summarizeFilter(
      makeFilter({ filterMode: 'selection', value: [] }),
      frLocaleText,
    );
    expect(result).toBe(frLocaleText.filterSummaryAnyValue);
  });

  it('localizes "is one of:" and "and N more" for a selection filter', () => {
    const result = summarizeFilter(
      makeFilter({ filterMode: 'selection', value: ['A', 'B', 'C', 'D', 'E'] }),
      frLocaleText,
    );
    expect(result).toContain(frLocaleText.filterSummaryIsOneOf);
    expect(result).toContain(frLocaleText.filterSummaryAndMore!(2));
    expect(result).not.toContain('and 2 more');
  });

  it('localizes "is not:" for an exclusive selection filter', () => {
    const result = summarizeFilter(
      makeFilter({ filterMode: 'selection', value: ['A'], operator: 'not_in' }),
      frLocaleText,
    );
    expect(result).toContain(frLocaleText.filterSummaryIsNot);
  });

  it('localizes the rank direction label', () => {
    const result = summarizeFilter(
      makeFilter({ filterMode: 'rank', rankDirection: 'bottom', value: 5 }),
      frLocaleText,
    );
    expect(result).toBe(`${frLocaleText.filterRankBottom} 5 · value`);
  });

  it('localizes the AND/OR conjunction', () => {
    const result = summarizeFilter(
      makeFilter({
        operator: 'greater_than',
        value: 10,
        fieldType: 'number',
        operator2: 'less_than',
        value2: 50,
        conjunction: 'or',
      }),
      frLocaleText,
    );
    expect(result).toContain(frLocaleText.filterConditionOr);
    expect(result).not.toContain(' OR ');
  });

  it('localizes "from"/"until" for a one-sided between condition', () => {
    const from = summarizeFilter(
      makeFilter({ operator: 'between', value: { from: '10' }, fieldType: 'string' }),
      frLocaleText,
    );
    expect(from).toBe(frLocaleText.filterSummaryFrom!('10'));
    const until = summarizeFilter(
      makeFilter({ operator: 'between', value: { to: '20' }, fieldType: 'string' }),
      frLocaleText,
    );
    expect(until).toBe(frLocaleText.filterSummaryUntil!('20'));
  });

  it('localizes the relative-date "ago" suffix and unit', () => {
    const result = summarizeFilter(
      makeFilter({
        operator: 'greater_than',
        fieldType: 'date',
        value: { relative: true, amount: 3, unit: 'month', direction: 'past' },
      }),
      frLocaleText,
    );
    expect(result).toContain(frLocaleText.filterRelativeDateAgo);
    expect(result).toContain(frLocaleText.filterRelativeUnitMonths);
    expect(result).not.toContain('ago');
  });
});

describe('getOperators — localization', () => {
  it('defaults to English labels when localeText is omitted', () => {
    const ops = getOperators('string');
    expect(ops.find((o) => o.value === 'equals')?.label).toBe('Equals');
  });

  it('resolves operator labels through the active locale, matching FilterRow.tsx', () => {
    const ops = getOperators('string', frLocaleText);
    expect(ops.find((o) => o.value === 'equals')?.label).toBe('Est égal à');
  });
});

// ─── isStrictRelativeDateValue ──────────────────────────────────────────────────────

describe('isRelativeDateValue', () => {
  it('returns true for a valid relative date object', () => {
    expect(
      isStrictRelativeDateValue({ relative: true, amount: 3, unit: 'day', direction: 'past' }),
    ).toBe(true);
  });

  it('returns false for absolute date string', () => {
    expect(isStrictRelativeDateValue('2024-01-01')).toBe(false);
  });

  it('returns false for number', () => {
    expect(isStrictRelativeDateValue(42)).toBe(false);
  });

  it('returns false for null', () => {
    expect(isStrictRelativeDateValue(null)).toBe(false);
  });

  it('returns false for object without relative:true', () => {
    expect(isStrictRelativeDateValue({ amount: 5, unit: 'day', direction: 'past' })).toBe(false);
  });

  // M9: the predicate used to check `.relative === true` and nothing else, so a `between`
  // value built on top of a relative date answered `true` — and every `between` ↔ scalar
  // reset guard (all written `… && !isStrictRelativeDateValue(value)`) was permanently disarmed.
  it('returns false for a `between` value carrying relative-date fields (M9)', () => {
    expect(
      isStrictRelativeDateValue({
        relative: true,
        amount: 3,
        unit: 'month',
        direction: 'past',
        from: '2024-01-01',
      }),
    ).toBe(false);
    expect(
      isStrictRelativeDateValue({
        relative: true,
        amount: 3,
        unit: 'month',
        direction: 'past',
        to: '2024-03-01',
      }),
    ).toBe(false);
  });

  it('returns false for an incomplete or malformed relative date (M9)', () => {
    expect(isStrictRelativeDateValue({ relative: true })).toBe(false);
    expect(
      isStrictRelativeDateValue({ relative: true, amount: '3', unit: 'day', direction: 'past' }),
    ).toBe(false);
    expect(isStrictRelativeDateValue({ relative: true, amount: 3, unit: 'fortnight' })).toBe(false);
    expect(
      isStrictRelativeDateValue({ relative: true, amount: 3, unit: 'day', direction: 'sideways' }),
    ).toBe(false);
  });

  it('returns false for an array', () => {
    expect(isStrictRelativeDateValue([])).toBe(false);
  });
});

// ─── needsOperatorValueReset ──────────────────────────────────────────────────
// M8: the `between` ↔ scalar value reset used to run in ONE direction only, while
// ARCHITECTURE.md claimed "in both directions".

describe('needsOperatorValueReset', () => {
  const relative = { relative: true, amount: 3, unit: 'month', direction: 'past' };

  it('resets when LEAVING between with a range object still stored', () => {
    expect(needsOperatorValueReset('between', 'greater_than', { from: 1, to: 2 })).toBe(true);
  });

  it('resets when ENTERING between with a scalar still stored (M8)', () => {
    expect(needsOperatorValueReset('equals', 'between', 500)).toBe(true);
    expect(needsOperatorValueReset('equals', 'between', 'north')).toBe(true);
    expect(needsOperatorValueReset('equals', 'between', relative)).toBe(true);
  });

  it('does not reset when entering between with nothing stored', () => {
    expect(needsOperatorValueReset('equals', 'between', '')).toBe(false);
    expect(needsOperatorValueReset('equals', 'between', null)).toBe(false);
    expect(needsOperatorValueReset('equals', 'between', undefined)).toBe(false);
  });

  it('does not reset when entering between with a range already stored', () => {
    expect(needsOperatorValueReset('equals', 'between', { from: 1, to: 2 })).toBe(false);
  });

  it('does not reset between two scalar operators, relative dates included', () => {
    expect(needsOperatorValueReset('equals', 'greater_than', '5')).toBe(false);
    expect(needsOperatorValueReset('equals', 'less_than', relative)).toBe(false);
  });

  it('does not reset when the operator did not change', () => {
    expect(needsOperatorValueReset('between', 'between', { from: 1 })).toBe(false);
    expect(needsOperatorValueReset('equals', 'equals', 5)).toBe(false);
  });

  // M9 compounding: a hybrid relative/`between` value is `between`-shaped, so leaving
  // `between` clears it instead of preserving it as a "scalar relative date".
  it('resets a hybrid relative/between value when leaving between (M9)', () => {
    expect(needsOperatorValueReset('between', 'equals', { ...relative, from: '2024-01-01' })).toBe(
      true,
    );
  });
});

// ─── buildFieldRepointReset ───────────────────────────────────────────────────
// M7: a field switch must clear all five condition keys together, matching
// `StudioWidgetEditDialog/FilterRow`'s own reset.

describe('buildFieldRepointReset', () => {
  it('clears all five condition keys', () => {
    expect(buildFieldRepointReset()).toEqual({
      operator: 'equals',
      value: '',
      operator2: undefined,
      value2: undefined,
      conjunction: undefined,
    });
  });

  it('seeds the mode-appropriate default value', () => {
    expect(buildFieldRepointReset('selection').value).toEqual([]);
    expect(buildFieldRepointReset('rank').value).toBe(10);
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
    const result = relativeToAbsolute({
      relative: true,
      amount: 30,
      unit: 'day',
      direction: 'past',
    });
    const expected = new Date();
    expected.setDate(expected.getDate() - 30);
    // Allow ±1 day tolerance
    const diff = Math.abs(new Date(result).getTime() - expected.getTime());
    expect(diff).toBeLessThan(2 * 24 * 60 * 60 * 1000);
  });

  it('returns approximate future date string in YYYY-MM-DD format', () => {
    const result = relativeToAbsolute({
      relative: true,
      amount: 7,
      unit: 'day',
      direction: 'next',
    });
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

  // Regression for finding 2.19: switching an existing condition filter to rank mode used to
  // leave `field` untouched, so a filter already configured on a STRING field could flip to
  // rank mode and keep it — the numeric-rank sort then computes `NaN` comparators (a silent
  // no-op "Top N" with no feedback).
  describe('clears a non-numeric field when switching to rank mode (2.19)', () => {
    it('clears field/fieldType/filterSourceId when the current field is a string', () => {
      const reset = buildModeReset('rank', 'string');
      expect(reset.field).toBeUndefined();
      expect(reset.fieldType).toBeUndefined();
      expect(reset.filterSourceId).toBeUndefined();
      // These keys must actually be PRESENT (set to `undefined`) in the patch so a merge
      // clears them — not merely absent from the object.
      expect(reset).toHaveProperty('field');
      expect(reset).toHaveProperty('fieldType');
      expect(reset).toHaveProperty('filterSourceId');
    });

    it('clears field when no current field type is known (treated as non-numeric)', () => {
      const reset = buildModeReset('rank');
      expect(reset).toHaveProperty('field');
      expect(reset.field).toBeUndefined();
    });

    it('preserves field/fieldType when the current field is already numeric', () => {
      const reset = buildModeReset('rank', 'number');
      // No `field`/`fieldType`/`filterSourceId` key at all — the caller's existing values
      // survive the merge unchanged.
      expect(reset).not.toHaveProperty('field');
      expect(reset).not.toHaveProperty('fieldType');
      expect(reset).not.toHaveProperty('filterSourceId');
    });

    it('does not clear a non-numeric field when switching to a non-rank mode', () => {
      const conditionReset = buildModeReset('condition', 'string');
      const selectionReset = buildModeReset('selection', 'string');
      expect(conditionReset).not.toHaveProperty('field');
      expect(selectionReset).not.toHaveProperty('field');
    });
  });
});

// ─── resolveFilterField ───────────────────────────────────────────────────────

// A filter whose field no longer names a column is not inert: `compileSingleCondition` reads
// `undefined` on every row, so the widget renders EMPTY while the drawer card still looks
// perfectly normal. `resolveFilterField` is what lets the rows say so — and, just as
// importantly, what stops them from crying wolf during a data-load race.
describe('resolveFilterField', () => {
  const ORDERS: StudioDataSource = {
    id: 'orders',
    label: 'Orders',
    fields: [
      { id: 'total', label: 'Total', type: 'number' },
      { id: 'secret', label: 'Secret', type: 'string', hidden: true },
    ],
    rows: [],
  };
  const CUSTOMERS: StudioDataSource = {
    id: 'customers',
    label: 'Customers',
    fields: [{ id: 'name', label: 'Name', type: 'string' }],
    rows: [],
  };
  const sources = { orders: ORDERS, customers: CUSTOMERS };

  it('resolves a field that exists on the filter own source', () => {
    expect(resolveFilterField({ field: 'total', filterSourceId: 'orders' }, sources)).toBe(
      'resolved',
    );
  });

  it('resolves a HIDDEN field — a filter may legitimately target one', () => {
    expect(resolveFilterField({ field: 'secret', filterSourceId: 'orders' }, sources)).toBe(
      'resolved',
    );
  });

  it('resolves an expression field, which lives outside every source field list', () => {
    expect(
      resolveFilterField({ field: 'margin' }, sources, [
        { id: 'margin', label: 'Margin', sourceId: 'orders', expression: 'a - b' },
      ] as never),
    ).toBe('resolved');
  });

  it('reports unresolved when the widget source no longer has the column', () => {
    // The concrete failure: a chart on Orders filtered by `total > 100`, then re-pointed at
    // Customers. Nothing prunes the widget-scoped filter, so the chart silently goes blank.
    expect(resolveFilterField({ field: 'total' }, sources, [], 'customers')).toBe('unresolved');
  });

  it('reports unresolved when no source anywhere has the column', () => {
    expect(resolveFilterField({ field: 'ghost' }, sources)).toBe('unresolved');
  });

  it('reports unknown before any data source has been injected', () => {
    expect(resolveFilterField({ field: 'total', filterSourceId: 'orders' }, {})).toBe('unknown');
  });

  it('reports unknown while the source the filter names is still loading', () => {
    expect(resolveFilterField({ field: 'total', filterSourceId: 'shipments' }, sources)).toBe(
      'unknown',
    );
  });

  it('reports unknown for a filter that has no field yet', () => {
    expect(resolveFilterField({ field: '' }, sources)).toBe('unknown');
  });

  it('does not resolve a source id off the prototype chain', () => {
    expect(resolveFilterField({ field: 'total', filterSourceId: 'constructor' }, sources)).toBe(
      'unknown',
    );
  });
});
