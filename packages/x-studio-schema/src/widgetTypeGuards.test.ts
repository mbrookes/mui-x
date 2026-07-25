import { describe, expect, it } from 'vitest';
import {
  STUDIO_CHART_TYPES,
  STUDIO_EXPRESSION_OPERATORS,
  STUDIO_FILTER_OPERATORS,
  isStudioChartType,
  isStudioExpressionOperator,
  isStudioFilterOperator,
} from './widgetTypeGuards';

// The three closed unions this file publishes runtime lists for are each gated at a trust
// boundary, so "the list agrees with the union" is a compile-time lock (the
// `AssertAll…Listed` error tuples) and "the predicate agrees with the list" is what these
// tests pin. Completeness itself cannot be asserted at runtime — a TypeScript union has no
// runtime representation — which is exactly why the compile-time locks exist.

describe('isStudioExpressionOperator', () => {
  it.each(STUDIO_EXPRESSION_OPERATORS)('accepts the listed operator "%s"', (operator) => {
    expect(isStudioExpressionOperator(operator)).toBe(true);
  });

  it.each([
    // Plausible near-misses a hand-edited or foreign persisted doc carries.
    'pow',
    'concat',
    'notEquals',
    'greaterThanOrEquals',
    'ADD',
    '',
  ])('rejects the unknown operator "%s"', (operator) => {
    expect(isStudioExpressionOperator(operator)).toBe(false);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['an object', { operator: 'add' }],
    ['an array', ['add']],
  ])('rejects %s', (_label, value) => {
    expect(isStudioExpressionOperator(value)).toBe(false);
  });

  it('resolves nothing up the prototype chain', () => {
    // `Array.prototype.includes` walks indices, never the prototype — pinned because the
    // input is untrusted persisted data and an inherited `Object.prototype` member name
    // resolving to `true` would fail this closed union OPEN.
    expect(isStudioExpressionOperator('toString')).toBe(false);
    expect(isStudioExpressionOperator('constructor')).toBe(false);
    expect(isStudioExpressionOperator('__proto__')).toBe(false);
  });

  it('lists each operator exactly once', () => {
    expect(new Set(STUDIO_EXPRESSION_OPERATORS).size).toBe(STUDIO_EXPRESSION_OPERATORS.length);
  });
});

// The two pre-existing lists get the same duplicate/prototype pins, so all three closed
// unions are held to one standard rather than only the newest one.
describe('the sibling closed-union lists', () => {
  it.each([
    ['STUDIO_CHART_TYPES', STUDIO_CHART_TYPES as readonly string[]],
    ['STUDIO_FILTER_OPERATORS', STUDIO_FILTER_OPERATORS as readonly string[]],
  ])('%s lists each member exactly once', (_name, list) => {
    expect(new Set(list).size).toBe(list.length);
  });

  it('neither membership test resolves a prototype member', () => {
    expect(isStudioChartType('constructor')).toBe(false);
    expect(isStudioFilterOperator('constructor')).toBe(false);
  });
});
