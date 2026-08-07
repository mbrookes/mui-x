import { describe, expect, it } from 'vitest';
import { getOperatorLabel, getOperatorsForFieldType } from './filterOperatorMetadata';
import { getOperators } from './filterDrawerUtils';

// Regression coverage for finding #6: `StudioWidgetEditDialog/FilterRow.tsx` and
// `StudioFiltersDrawer/filterDrawerUtils.ts` used to each hardcode their own
// operator list, and disagreed — `FilterRow` had `between`/`is_empty`/`is_not_empty`
// for numbers/dates that the drawer's table lacked, and the drawer had
// `not_starts_with`/`not_ends_with` for strings that `FilterRow` lacked. A filter
// using one of the missing operators fell back to the first operator in the list
// when edited on the surface that didn't recognize it, corrupting the filter.
//
// Both surfaces now import `getOperatorsForFieldType` from this module (`FilterRow`
// directly; `filterDrawerUtils.getOperators` delegates to it) — these tests prove
// the previously-missing operators are present via both entry points.

describe('filterOperatorMetadata — cross-surface operator round-trip', () => {
  it('a `between` filter on a number field is recognized both directly and via the drawer', () => {
    // "FilterRow.tsx" surface
    const fromFilterRow = getOperatorsForFieldType('number');
    // "filterDrawerUtils.ts" (StudioFiltersDrawer) surface
    const fromDrawer = getOperators('number');

    expect(fromFilterRow.some((o) => o.value === 'between')).toBe(true);
    expect(fromDrawer.some((o) => o.value === 'between')).toBe(true);
  });

  it('a `between` filter on a date field is recognized both directly and via the drawer', () => {
    expect(getOperatorsForFieldType('date').some((o) => o.value === 'between')).toBe(true);
    expect(getOperators('date').some((o) => o.value === 'between')).toBe(true);
  });

  it('is_empty / is_not_empty on a number field are recognized both directly and via the drawer', () => {
    for (const op of ['is_empty', 'is_not_empty'] as const) {
      expect(getOperatorsForFieldType('number').some((o) => o.value === op)).toBe(true);
      expect(getOperators('number').some((o) => o.value === op)).toBe(true);
    }
  });

  it('not_starts_with / not_ends_with on a string field are recognized both directly and via the drawer', () => {
    for (const op of ['not_starts_with', 'not_ends_with'] as const) {
      expect(getOperatorsForFieldType('string').some((o) => o.value === op)).toBe(true);
      expect(getOperators('string').some((o) => o.value === op)).toBe(true);
    }
  });

  it('filterDrawerUtils.getOperators and getOperatorsForFieldType return the same set for every field type', () => {
    const types = ['string', 'number', 'date', 'datetime', 'boolean'] as const;
    for (const type of types) {
      expect(getOperators(type)).toEqual(getOperatorsForFieldType(type));
    }
  });
});

describe('getOperatorsForFieldType', () => {
  it('defaults to string operators when field type is undefined', () => {
    const ops = getOperatorsForFieldType(undefined);
    expect(ops.some((o) => o.value === 'contains')).toBe(true);
  });

  it('boolean operators are exactly equals/not_equals', () => {
    expect(getOperatorsForFieldType('boolean').map((o) => o.value)).toEqual([
      'equals',
      'not_equals',
    ]);
  });

  // Regression coverage: `fieldType` flows from doc/AI-authored data with no runtime enum
  // validation on this path. A bare `OPERATORS_BY_TYPE[fieldType]` lookup would resolve an
  // inherited `Object.prototype` member (truthy) for a value like "constructor"/"toString",
  // so the `?? OPERATORS_BY_TYPE.string` fallback would never fire — and callers that then
  // call `.some(...)`/`.map(...)` on the "result" would throw `TypeError: ... is not a
  // function`. `getOperatorsForFieldType` must fall back to the string operator list instead.
  it('falls back to string operators for a fieldType colliding with an inherited Object.prototype member', () => {
    for (const badType of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      const ops = getOperatorsForFieldType(badType as any);
      expect(Array.isArray(ops)).toBe(true);
      expect(ops).toEqual(getOperatorsForFieldType('string'));
      expect(() => ops.some((o) => o.value === 'equals')).not.toThrow();
    }
  });
});

describe('getOperatorLabel', () => {
  it('falls back to the built-in English label when no locale override matches', () => {
    expect(getOperatorLabel('equals', undefined, 'number')).toBe('=');
    expect(getOperatorLabel('equals', undefined, 'date')).toBe('On');
    expect(getOperatorLabel('is_empty', undefined, 'string')).toBe('Is empty');
  });

  it('returns the operator value itself if somehow not found in the type table', () => {
    // 'in'/'not_in' are valid StudioFilterOperator values but aren't offered as a
    // condition-mode operator for any field type — exercise the ultimate fallback.
    expect(getOperatorLabel('in', undefined, 'string')).toBe('in');
  });

  // An operator can be stored on a field type whose table does not offer it: a host/AI-authored
  // filter, or a field that changed type under it. The label must stay a human word — the raw
  // enum identifier used to reach card summaries and operator pickers verbatim ("between: 10 —
  // 20" for a string field).
  it('borrows a label from another type table when the field type does not offer the operator', () => {
    expect(getOperatorLabel('between', undefined, 'string')).toBe('Between');
    expect(getOperatorLabel('greater_than', undefined, 'string')).toBe('>');
    expect(getOperatorLabel('contains', undefined, 'number')).toBe('Contains');
  });

  it('borrows the borrowed table locale key too, so the fallback is translated', () => {
    const localeText = { filterOperator_number_between: 'Entre' };
    expect(getOperatorLabel('between', localeText as any, 'string')).toBe('Entre');
  });

  it('never lets a borrowed label override the field type own label', () => {
    // `equals` exists in every table; the requested type must always win.
    expect(getOperatorLabel('equals', undefined, 'date')).toBe('On');
    expect(getOperatorLabel('equals', undefined, 'number')).toBe('=');
    expect(getOperatorLabel('equals', undefined, 'string')).toBe('Equals');
  });

  it('prefers a locale override when StudioLocaleText defines a matching key', () => {
    const localeText = { filterOperator_number_equals: 'Egal à' };
    expect(getOperatorLabel('equals', localeText as any, 'number')).toBe('Egal à');
  });
});
