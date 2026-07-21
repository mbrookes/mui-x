import { describe, it, expect } from 'vitest';

import type {
  StudioExpressionField,
  StudioFunctionExpression,
  StudioValueExpression,
  StudioFieldExpression,
  StudioJoinFieldExpression,
} from '../models';

import {
  evaluateExpression,
  enrichRowsWithExpressions,
  evaluateMeasure,
  inferExpressionType,
  validateExpressionField,
  topoSortExpressionFields,
  isFunctionExpression,
  isValueExpression,
  isFieldExpression,
  isJoinFieldExpression,
  type EvaluationContext,
} from './expressionEvaluator';
import { computeAggregate } from '../components/widgets/StudioKpiWidget/kpiUtils';

// ─── Test helpers ────────────────────────────────────────────────────────────

const fn = (
  operator: StudioFunctionExpression['operator'],
  ...inputs: StudioFunctionExpression['inputs']
): StudioFunctionExpression => ({ operator, inputs });

const val = (
  type: StudioValueExpression['type'],
  value: StudioValueExpression['value'],
): StudioValueExpression => ({ type, value });

const field = (
  id: string,
  aggregation?: StudioFieldExpression['aggregation'],
): StudioFieldExpression => (aggregation ? { id, aggregation } : { id });

const numVal = (n: number): StudioValueExpression => val('number', n);
const strVal = (s: string): StudioValueExpression => val('string', s);
const boolVal = (b: boolean): StudioValueExpression => val('boolean', b);

function ctx(
  row: Record<string, unknown>,
  expressionFields: StudioExpressionField[] = [],
): EvaluationContext {
  return { row, expressionFields, allRows: [row] };
}

const noFields: StudioExpressionField[] = [];

// ─── Type guards ─────────────────────────────────────────────────────────────

describe('type guards', () => {
  it('isFunctionExpression', () => {
    expect(isFunctionExpression(fn('add', numVal(1)))).toBe(true);
    expect(isFunctionExpression(numVal(1))).toBe(false);
    expect(isFunctionExpression(field('x'))).toBe(false);
  });

  it('isValueExpression', () => {
    expect(isValueExpression(numVal(1))).toBe(true);
    expect(isValueExpression(strVal('a'))).toBe(true);
    expect(isValueExpression(fn('add', numVal(1)))).toBe(false);
    expect(isValueExpression(field('x'))).toBe(false);
  });

  it('isFieldExpression', () => {
    expect(isFieldExpression(field('x'))).toBe(true);
    expect(isFieldExpression(numVal(1))).toBe(false);
    expect(isFieldExpression(fn('add', numVal(1)))).toBe(false);
  });

  it('isJoinFieldExpression', () => {
    const joinExpr: StudioJoinFieldExpression = {
      joinSourceId: 'source-customers',
      fieldId: 'country',
    };
    expect(isJoinFieldExpression(joinExpr)).toBe(true);
    expect(isJoinFieldExpression(field('x'))).toBe(false);
    expect(isJoinFieldExpression(numVal(1))).toBe(false);
    expect(isJoinFieldExpression(fn('add', numVal(1)))).toBe(false);
  });
});

// ─── Arithmetic ──────────────────────────────────────────────────────────────

describe('arithmetic operators', () => {
  it('add', () => {
    expect(evaluateExpression(fn('add', numVal(3), numVal(4)), ctx({}))).toBe(7);
  });

  it('add multiple inputs', () => {
    expect(evaluateExpression(fn('add', numVal(1), numVal(2), numVal(3)), ctx({}))).toBe(6);
  });

  it('subtract', () => {
    expect(evaluateExpression(fn('subtract', numVal(10), numVal(3)), ctx({}))).toBe(7);
  });

  it('multiply', () => {
    expect(evaluateExpression(fn('multiply', numVal(4), numVal(5)), ctx({}))).toBe(20);
  });

  it('divide', () => {
    expect(evaluateExpression(fn('divide', numVal(10), numVal(4)), ctx({}))).toBe(2.5);
  });

  it('divide by zero returns null', () => {
    expect(evaluateExpression(fn('divide', numVal(10), numVal(0)), ctx({}))).toBeNull();
  });

  it('modulo', () => {
    expect(evaluateExpression(fn('modulo', numVal(10), numVal(3)), ctx({}))).toBe(1);
  });

  it('negate', () => {
    expect(evaluateExpression(fn('negate', numVal(5)), ctx({}))).toBe(-5);
  });

  it('uses row field values', () => {
    expect(
      evaluateExpression(fn('add', field('price'), field('tax')), ctx({ price: 100, tax: 20 })),
    ).toBe(120);
  });

  it('null field defaults to 0 in arithmetic', () => {
    expect(evaluateExpression(fn('add', field('missing'), numVal(5)), ctx({}))).toBe(5);
  });
});

// ─── Comparison ──────────────────────────────────────────────────────────────

describe('comparison operators', () => {
  it('equals', () => {
    expect(evaluateExpression(fn('equals', numVal(5), numVal(5)), ctx({}))).toBe(true);
    expect(evaluateExpression(fn('equals', numVal(5), numVal(6)), ctx({}))).toBe(false);
  });

  it('notEqual', () => {
    expect(evaluateExpression(fn('notEqual', numVal(5), numVal(6)), ctx({}))).toBe(true);
    expect(evaluateExpression(fn('notEqual', numVal(5), numVal(5)), ctx({}))).toBe(false);
  });

  it('lessThan', () => {
    expect(evaluateExpression(fn('lessThan', numVal(3), numVal(5)), ctx({}))).toBe(true);
    expect(evaluateExpression(fn('lessThan', numVal(5), numVal(3)), ctx({}))).toBe(false);
  });

  it('greaterThan', () => {
    expect(evaluateExpression(fn('greaterThan', numVal(5), numVal(3)), ctx({}))).toBe(true);
  });

  it('lessThanOrEqual', () => {
    expect(evaluateExpression(fn('lessThanOrEqual', numVal(5), numVal(5)), ctx({}))).toBe(true);
    expect(evaluateExpression(fn('lessThanOrEqual', numVal(6), numVal(5)), ctx({}))).toBe(false);
  });

  it('greaterThanOrEqual', () => {
    expect(evaluateExpression(fn('greaterThanOrEqual', numVal(5), numVal(5)), ctx({}))).toBe(true);
  });
});

// ─── Comparison — null-safety and type-aware string/date comparison (finding 2) ───────────────

describe('comparison operators — null-safety (finding 2)', () => {
  // Before the fix, `lessThan`/`greaterThan`/etc. coerced every operand through `toNumber`,
  // where `toNumber(null) === 0` — so `lessThan(price, 10)` with `price: null` silently
  // evaluated `0 < 10 === true`, disagreeing with the filter engine's explicit `rv != null`
  // null-guard policy (`filterUtils.ts`'s `greater_than`/`less_than`).
  it('lessThan returns null (not a phantom true) when the row field is null', () => {
    expect(
      evaluateExpression(fn('lessThan', field('price'), numVal(10)), ctx({ price: null })),
    ).toBe(null);
  });

  it('greaterThan returns null when the row field is missing entirely', () => {
    expect(evaluateExpression(fn('greaterThan', field('missing'), numVal(10)), ctx({}))).toBeNull();
  });

  it('lessThanOrEqual / greaterThanOrEqual return null when either operand is null', () => {
    expect(
      evaluateExpression(fn('lessThanOrEqual', numVal(5), field('missing')), ctx({})),
    ).toBeNull();
    expect(
      evaluateExpression(fn('greaterThanOrEqual', field('missing'), numVal(5)), ctx({})),
    ).toBeNull();
  });

  // `if(cond, then, else)` uses `toBoolean` on the condition; `toBoolean(null) === false`, so a
  // null comparison result falls through to the else-branch rather than the old phantom `true`.
  it('a null comparison inside `if` takes the else-branch, not a phantom true-branch', () => {
    expect(
      evaluateExpression(
        fn('if', fn('lessThan', field('price'), numVal(10)), strVal('cheap'), strVal('unknown')),
        ctx({ price: null }),
      ),
    ).toBe('unknown');
  });
});

describe('comparison operators — type-aware string/date comparison (finding 2)', () => {
  // Before the fix, both sides of a non-numeric string comparison coerced to `NaN` → `0` via
  // `toNumber`, so the comparison silently evaluated to a CONSTANT result for every row (e.g.
  // `>=` always true) instead of comparing the dates/strings meaningfully.
  it('compares ISO date strings chronologically, not as NaN-coerced numbers', () => {
    expect(
      evaluateExpression(
        fn('greaterThanOrEqual', strVal('2024-06-01'), strVal('2024-01-01')),
        ctx({}),
      ),
    ).toBe(true);
    expect(
      evaluateExpression(
        fn('greaterThanOrEqual', strVal('2023-06-01'), strVal('2024-01-01')),
        ctx({}),
      ),
    ).toBe(false);
  });

  it('a datediff-style `if` over ISO date strings picks branches per-row, not a constant result', () => {
    const cond = fn('greaterThanOrEqual', field('order_date'), strVal('2024-01-01'));
    const expr = fn('if', cond, strVal('new'), strVal('old'));
    expect(evaluateExpression(expr, ctx({ order_date: '2024-03-15' }))).toBe('new');
    expect(evaluateExpression(expr, ctx({ order_date: '2023-03-15' }))).toBe('old');
  });

  it('falls back to lexicographic comparison for arbitrary non-numeric strings', () => {
    expect(evaluateExpression(fn('lessThan', strVal('apple'), strVal('banana')), ctx({}))).toBe(
      true,
    );
    expect(evaluateExpression(fn('greaterThan', strVal('banana'), strVal('apple')), ctx({}))).toBe(
      true,
    );
  });

  it('still compares numeric-looking strings numerically, not lexicographically', () => {
    // Lexicographically "9" > "10", but numerically 9 < 10 — must use the numeric reading.
    expect(evaluateExpression(fn('lessThan', strVal('9'), strVal('10')), ctx({}))).toBe(true);
  });
});

// ─── Logical ─────────────────────────────────────────────────────────────────

describe('logical operators', () => {
  it('and', () => {
    expect(evaluateExpression(fn('and', boolVal(true), boolVal(true)), ctx({}))).toBe(true);
    expect(evaluateExpression(fn('and', boolVal(true), boolVal(false)), ctx({}))).toBe(false);
  });

  it('or', () => {
    expect(evaluateExpression(fn('or', boolVal(false), boolVal(true)), ctx({}))).toBe(true);
    expect(evaluateExpression(fn('or', boolVal(false), boolVal(false)), ctx({}))).toBe(false);
  });

  it('not', () => {
    expect(evaluateExpression(fn('not', boolVal(true)), ctx({}))).toBe(false);
    expect(evaluateExpression(fn('not', boolVal(false)), ctx({}))).toBe(true);
  });

  it('isTrue / isFalse', () => {
    expect(evaluateExpression(fn('isTrue', boolVal(true)), ctx({}))).toBe(true);
    expect(evaluateExpression(fn('isTrue', boolVal(false)), ctx({}))).toBe(false);
    expect(evaluateExpression(fn('isFalse', boolVal(false)), ctx({}))).toBe(true);
  });

  it('isNull / isNotNull', () => {
    expect(evaluateExpression(fn('isNull', val('string', null)), ctx({}))).toBe(true);
    expect(evaluateExpression(fn('isNull', strVal('hello')), ctx({}))).toBe(false);
    expect(evaluateExpression(fn('isNotNull', strVal('hello')), ctx({}))).toBe(true);
    expect(evaluateExpression(fn('isNotNull', val('string', null)), ctx({}))).toBe(false);
  });
});

// ─── Conditional ─────────────────────────────────────────────────────────────

describe('if operator', () => {
  it('returns then-value when condition is true', () => {
    expect(evaluateExpression(fn('if', boolVal(true), strVal('yes'), strVal('no')), ctx({}))).toBe(
      'yes',
    );
  });

  it('returns else-value when condition is false', () => {
    expect(evaluateExpression(fn('if', boolVal(false), strVal('yes'), strVal('no')), ctx({}))).toBe(
      'no',
    );
  });
});

// A string-boolean column (e.g. CSV-sourced `"true"`/`"false"` strings) must evaluate the same
// way it does in `filterUtils.ts`'s explicit string-boolean `equals` branch, not via JS's
// `Boolean("false") === true` truthy coercion (finding 12).
describe('if operator — string-boolean condition values (finding 12)', () => {
  it('treats the string "false" as falsy, not truthy', () => {
    expect(
      evaluateExpression(
        fn('if', field('on_time'), numVal(1), numVal(0)),
        ctx({ on_time: 'false' }),
      ),
    ).toBe(0);
  });

  it('treats the string "true" as truthy', () => {
    expect(
      evaluateExpression(
        fn('if', field('on_time'), numVal(1), numVal(0)),
        ctx({ on_time: 'true' }),
      ),
    ).toBe(1);
  });

  it('still treats an actual boolean false as falsy', () => {
    expect(
      evaluateExpression(fn('if', field('on_time'), numVal(1), numVal(0)), ctx({ on_time: false })),
    ).toBe(0);
  });

  it('still treats a non-empty, non-"false" string as truthy (unchanged behavior)', () => {
    expect(
      evaluateExpression(fn('if', field('status'), numVal(1), numVal(0)), ctx({ status: 'yes' })),
    ).toBe(1);
  });
});

describe('in operator', () => {
  it('returns true when value is in list', () => {
    expect(
      evaluateExpression(fn('in', strVal('b'), strVal('a'), strVal('b'), strVal('c')), ctx({})),
    ).toBe(true);
  });

  it('returns false when value is not in list', () => {
    expect(evaluateExpression(fn('in', strVal('z'), strVal('a'), strVal('b')), ctx({}))).toBe(
      false,
    );
  });
});

// ─── Date diff ───────────────────────────────────────────────────────────────

describe('datediff operator', () => {
  it('calculates day difference', () => {
    const result = evaluateExpression(
      fn('datediff', strVal('day'), strVal('2024-01-01'), strVal('2024-01-11')),
      ctx({}),
    );
    expect(result).toBe(10);
  });

  it('returns null for invalid dates', () => {
    const result = evaluateExpression(
      fn('datediff', strVal('day'), strVal('not-a-date'), strVal('2024-01-11')),
      ctx({}),
    );
    expect(result).toBeNull();
  });
});

// ─── Literal values ──────────────────────────────────────────────────────────

describe('value expressions', () => {
  it('returns number literal', () => {
    expect(evaluateExpression(numVal(42), ctx({}))).toBe(42);
  });

  it('returns string literal', () => {
    expect(evaluateExpression(strVal('hello'), ctx({}))).toBe('hello');
  });

  it('returns boolean literal', () => {
    expect(evaluateExpression(boolVal(true), ctx({}))).toBe(true);
  });

  it('returns null literal', () => {
    expect(evaluateExpression(val('string', null), ctx({}))).toBeNull();
  });
});

// ─── Field expressions ───────────────────────────────────────────────────────

describe('field expressions', () => {
  it('reads field from row', () => {
    expect(evaluateExpression(field('revenue'), ctx({ revenue: 500 }))).toBe(500);
  });

  it('returns null for missing field', () => {
    expect(evaluateExpression(field('missing'), ctx({}))).toBeNull();
  });

  it('resolves a referenced expression field (calculated column)', () => {
    const profitField: StudioExpressionField = {
      id: 'profit',
      label: 'Profit',
      sourceId: 'sales',
      isMeasure: false,
      expression: fn('subtract', field('revenue'), field('cost')),
    };
    const result = evaluateExpression(field('profit'), {
      row: { revenue: 1000, cost: 600 },
      expressionFields: [profitField],
      allRows: [],
    });
    expect(result).toBe(400);
  });

  // Regression test for finding 2.8: a field reference not present in the current
  // row recursed into evaluating the referenced expression field with no cycle
  // guard. Two expression fields referencing each other used to blow the call stack
  // (`RangeError: Maximum call stack size exceeded`). `detectCycles`/
  // `validateExpressionField` reject this at the controller boundary when fields
  // are added/updated, but the evaluator itself must also be defensive — e.g. a
  // persisted doc created before that validation existed, or a host integration
  // that bypasses the controller, can still hand the evaluator a cyclic graph.
  it('does not crash on a cyclic pair of expression field references', () => {
    const fieldA: StudioExpressionField = {
      id: 'a',
      label: 'A',
      sourceId: 'sales',
      isMeasure: false,
      expression: field('b'),
    };
    const fieldB: StudioExpressionField = {
      id: 'b',
      label: 'B',
      sourceId: 'sales',
      isMeasure: false,
      expression: field('a'),
    };
    expect(() =>
      evaluateExpression(field('a'), {
        row: {},
        expressionFields: [fieldA, fieldB],
        allRows: [],
      }),
    ).not.toThrow();
    expect(
      evaluateExpression(field('a'), {
        row: {},
        expressionFields: [fieldA, fieldB],
        allRows: [],
      }),
    ).toBeNull();
  });

  it('does not crash on a direct self-referencing expression field', () => {
    const selfField: StudioExpressionField = {
      id: 'self',
      label: 'Self',
      sourceId: 'sales',
      isMeasure: false,
      expression: field('self'),
    };
    expect(() =>
      evaluateExpression(field('self'), {
        row: {},
        expressionFields: [selfField],
        allRows: [],
      }),
    ).not.toThrow();
  });

  it('resolves a non-cyclic chain of expression field references normally', () => {
    // Sanity check that the cycle guard doesn't interfere with legitimate multi-hop
    // references: a -> b -> c, where only `c` is present on the row.
    const fieldA: StudioExpressionField = {
      id: 'a',
      label: 'A',
      sourceId: 'sales',
      isMeasure: false,
      expression: field('b'),
    };
    const fieldB: StudioExpressionField = {
      id: 'b',
      label: 'B',
      sourceId: 'sales',
      isMeasure: false,
      expression: field('c'),
    };
    const result = evaluateExpression(field('a'), {
      row: { c: 42 },
      expressionFields: [fieldA, fieldB],
      allRows: [],
    });
    expect(result).toBe(42);
  });
});

// ─── Row enrichment ──────────────────────────────────────────────────────────

describe('enrichRowsWithExpressions', () => {
  const expressionFields: StudioExpressionField[] = [
    {
      id: 'profit',
      label: 'Profit',
      sourceId: 'sales',
      isMeasure: false,
      expression: fn('subtract', field('revenue'), field('cost')),
    },
    {
      id: 'margin',
      label: 'Margin %',
      sourceId: 'sales',
      isMeasure: false,
      expression: fn('multiply', fn('divide', field('profit'), field('revenue')), numVal(100)),
    },
  ];

  const rows = [
    { id: 1, revenue: 1000, cost: 600 },
    { id: 2, revenue: 2000, cost: 1400 },
  ];

  it('adds computed columns to rows', () => {
    const result = enrichRowsWithExpressions(rows, expressionFields, 'sales');
    expect(result[0]).toMatchObject({ profit: 400, margin: 40 });
    expect(result[1]).toMatchObject({ profit: 600, margin: 30 });
  });

  it('does not mutate original rows', () => {
    const original = [{ id: 1, revenue: 100, cost: 50 }];
    const result = enrichRowsWithExpressions(original, expressionFields, 'sales');
    expect(result[0]).not.toBe(original[0]);
    expect(original[0]).not.toHaveProperty('profit');
  });

  it('skips fields for a different sourceId', () => {
    const result = enrichRowsWithExpressions(rows, expressionFields, 'other-source');
    expect(result).toBe(rows); // reference equality — no copy needed
  });

  it('skips isMeasure fields', () => {
    const measureField: StudioExpressionField = {
      id: 'totalRevenue',
      label: 'Total Revenue',
      sourceId: 'sales',
      isMeasure: true,
      expression: field('revenue', 'sum'),
    };
    const result = enrichRowsWithExpressions(rows, [measureField], 'sales');
    expect(result).toBe(rows);
  });

  it('does not overwrite existing field values', () => {
    const rowsWithProfit = [{ id: 1, revenue: 1000, cost: 600, profit: 999 }];
    const result = enrichRowsWithExpressions(rowsWithProfit, expressionFields, 'sales');
    expect(result[0].profit).toBe(999);
  });
});

// ─── Join field expressions ──────────────────────────────────────────────────

describe('StudioJoinFieldExpression', () => {
  const customers = {
    id: 'source-customers',
    label: 'Customers',
    fields: [
      { id: 'id', label: 'Customer ID', type: 'string' as const },
      { id: 'country', label: 'Country', type: 'string' as const },
    ],
    rows: [
      { id: 'CUS-001', country: 'Germany' },
      { id: 'CUS-002', country: 'UK' },
    ],
  };

  const relationships = [
    {
      id: 'rel-orders-customers',
      sourceId: 'source-orders',
      targetId: 'source-customers',
      sourceField: 'customerId',
      targetField: 'id',
      type: 'many-to-one' as const,
    },
  ];

  const dataSources = { 'source-customers': customers };

  const joinExpr: StudioJoinFieldExpression = {
    joinSourceId: 'source-customers',
    fieldId: 'country',
  };

  it('resolves a join field expression to the related field value', () => {
    const context: EvaluationContext = {
      expressionFields: [],
      row: { id: 'ORD-001', customerId: 'CUS-001', total: 100 },
      allRows: [],
      sourceId: 'source-orders',
      dataSources,
      relationships,
    };
    expect(evaluateExpression(joinExpr, context)).toBe('Germany');
  });

  it('returns null when the foreign key does not match any related row', () => {
    const context: EvaluationContext = {
      expressionFields: [],
      row: { id: 'ORD-002', customerId: 'CUS-999', total: 50 },
      allRows: [],
      sourceId: 'source-orders',
      dataSources,
      relationships,
    };
    expect(evaluateExpression(joinExpr, context)).toBeNull();
  });

  it('returns null when the relationship is not declared', () => {
    const context: EvaluationContext = {
      expressionFields: [],
      row: { id: 'ORD-001', customerId: 'CUS-001' },
      allRows: [],
      sourceId: 'source-orders',
      dataSources,
      relationships: [], // no relationships
    };
    expect(evaluateExpression(joinExpr, context)).toBeNull();
  });

  it('returns null when dataSources are not in context', () => {
    const context: EvaluationContext = {
      expressionFields: [],
      row: { id: 'ORD-001', customerId: 'CUS-001' },
      allRows: [],
      sourceId: 'source-orders',
      // dataSources omitted
      relationships,
    };
    expect(evaluateExpression(joinExpr, context)).toBeNull();
  });

  it('enriches rows with join expression fields', () => {
    const joinField: StudioExpressionField = {
      id: 'expr-order-country',
      label: 'Country',
      sourceId: 'source-orders',
      isMeasure: false,
      expression: joinExpr,
    };
    const orderRows = [
      { id: 'ORD-001', customerId: 'CUS-001', total: 100 },
      { id: 'ORD-002', customerId: 'CUS-002', total: 200 },
      { id: 'ORD-003', customerId: 'CUS-999', total: 50 },
    ];
    const result = enrichRowsWithExpressions(
      orderRows,
      [joinField],
      'source-orders',
      dataSources,
      relationships,
    );
    expect(result[0]['expr-order-country']).toBe('Germany');
    expect(result[1]['expr-order-country']).toBe('UK');
    expect(result[2]['expr-order-country']).toBeNull();
  });

  it('join index: enrichRowsWithExpressions produces the same result as unindexed evaluation', () => {
    // Verify that the pre-built join index path yields identical output to the
    // original .find() path (regression guard for the O(N×M) → O(M+N) optimisation).
    const joinField: StudioExpressionField = {
      id: 'expr-order-country',
      label: 'Country',
      sourceId: 'source-orders',
      isMeasure: false,
      expression: joinExpr,
    };
    const orderRows = [
      { id: 'ORD-001', customerId: 'CUS-001', total: 100 },
      { id: 'ORD-002', customerId: 'CUS-002', total: 200 },
      { id: 'ORD-003', customerId: 'CUS-999', total: 50 }, // FK miss
    ];
    const result = enrichRowsWithExpressions(
      orderRows,
      [joinField],
      'source-orders',
      dataSources,
      relationships,
    );
    // Values must match the unindexed expectations
    expect(result[0]['expr-order-country']).toBe('Germany');
    expect(result[1]['expr-order-country']).toBe('UK');
    expect(result[2]['expr-order-country']).toBeNull();
    // Original row fields must be preserved
    expect(result[0].total).toBe(100);
    expect(result[1].total).toBe(200);
  });

  it('join index fast path: evaluateExpression uses precomputed index when provided', () => {
    const prebuiltIndex = new Map<string, Record<string, unknown>>([
      ['CUS-001', { id: 'CUS-001', country: 'Germany' }],
      ['CUS-002', { id: 'CUS-002', country: 'UK' }],
    ]);
    const joinIndexes = new Map([
      ['source-customers', { sourceField: 'customerId', index: prebuiltIndex }],
    ]);
    const contextWithIndex: EvaluationContext = {
      expressionFields: [],
      row: { id: 'ORD-001', customerId: 'CUS-001', total: 100 },
      allRows: [],
      sourceId: 'source-orders',
      // dataSources intentionally omitted — index must be used instead
      joinIndexes,
    };
    // Should resolve via index, not via dataSources.find()
    expect(evaluateExpression(joinExpr, contextWithIndex)).toBe('Germany');
  });

  it('join index fast path: returns null for FK miss even with pre-built index', () => {
    const prebuiltIndex = new Map<string, Record<string, unknown>>([
      ['CUS-001', { id: 'CUS-001', country: 'Germany' }],
    ]);
    const joinIndexes = new Map([
      ['source-customers', { sourceField: 'customerId', index: prebuiltIndex }],
    ]);
    const contextWithIndex: EvaluationContext = {
      expressionFields: [],
      row: { id: 'ORD-999', customerId: 'CUS-UNKNOWN', total: 0 },
      allRows: [],
      sourceId: 'source-orders',
      joinIndexes,
    };
    expect(evaluateExpression(joinExpr, contextWithIndex)).toBeNull();
  });

  // The related source's rows must be read through `getCachedNormalizedDataSource` (L1
  // normalization), same as every other cross-source reader in this codebase
  // (`grainResolution.ts`/`crossSourceEnrichment.ts`/`dataSourceGraph.ts`), not raw off
  // `dataSources[id].rows`. Otherwise a join-field expression copies a raw `Date` object, which
  // the UTC-based chart grouping engine and the local-calendar filter engine can bucket
  // differently, and an equality cross-filter on the column never matches a raw `Date` (finding 10).
  describe('related-source rows are L1-normalized (finding 10)', () => {
    const customersWithRawDate = {
      id: 'source-customers',
      label: 'Customers',
      fields: [
        { id: 'id', label: 'Customer ID', type: 'string' as const },
        { id: 'signupDate', label: 'Signup Date', type: 'date' as const },
      ],
      rows: [{ id: 'CUS-001', signupDate: new Date(2024, 0, 15) }],
    };
    const dataSourcesWithRawDate = { 'source-customers': customersWithRawDate };
    const signupJoinExpr: StudioJoinFieldExpression = {
      joinSourceId: 'source-customers',
      fieldId: 'signupDate',
    };

    it('slow path: normalizes a raw Date on the related source to a canonical YYYY-MM-DD string', () => {
      const context: EvaluationContext = {
        expressionFields: [],
        row: { id: 'ORD-001', customerId: 'CUS-001' },
        allRows: [],
        sourceId: 'source-orders',
        dataSources: dataSourcesWithRawDate,
        relationships,
      };
      expect(evaluateExpression(signupJoinExpr, context)).toBe('2024-01-15');
    });

    it('index build: normalizes a raw Date on the related source before indexing', () => {
      const joinField: StudioExpressionField = {
        id: 'expr-signup-date',
        label: 'Signup date',
        sourceId: 'source-orders',
        isMeasure: false,
        expression: signupJoinExpr,
      };
      const result = enrichRowsWithExpressions(
        [{ id: 'ORD-001', customerId: 'CUS-001' }],
        [joinField],
        'source-orders',
        dataSourcesWithRawDate,
        relationships,
      );
      expect(result[0]['expr-signup-date']).toBe('2024-01-15');
    });
  });

  // A join nested inside a function call (e.g. `if(join(customers.country) == 'US', 1, 0)`) must
  // still trigger the join-index prebuild — checking only the expression's ROOT node (the previous
  // behavior) missed it, silently falling back to the correct-but-slow per-row
  // `relationships.find()` + `rows.find()` scan for every row (finding 11).
  it('nested join field expression is resolved via the pre-built index, not the per-row slow-path scan (finding 11)', () => {
    const relationshipsArr = [
      {
        id: 'rel-orders-customers',
        sourceId: 'source-orders',
        targetId: 'source-customers',
        sourceField: 'customerId',
        targetField: 'id',
        type: 'many-to-one' as const,
      },
    ];
    let relationshipsFindCalls = 0;
    const originalFind = relationshipsArr.find.bind(relationshipsArr);
    (relationshipsArr as any).find = (...args: unknown[]) => {
      relationshipsFindCalls += 1;
      return (originalFind as any)(...args);
    };

    const nestedJoinExpr: StudioFunctionExpression = fn(
      'if',
      fn('equals', joinExpr, strVal('Germany')),
      numVal(1),
      numVal(0),
    );
    const exprField: StudioExpressionField = {
      id: 'expr-is-german',
      label: 'Is German',
      sourceId: 'source-orders',
      isMeasure: false,
      expression: nestedJoinExpr,
    };
    const orderRows = [
      { id: 'ORD-001', customerId: 'CUS-001', total: 100 },
      { id: 'ORD-002', customerId: 'CUS-002', total: 200 },
      { id: 'ORD-003', customerId: 'CUS-001', total: 50 },
    ];

    const result = enrichRowsWithExpressions(
      orderRows,
      [exprField],
      'source-orders',
      dataSources,
      relationshipsArr,
    );

    expect(result[0]['expr-is-german']).toBe(1);
    expect(result[1]['expr-is-german']).toBe(0);
    expect(result[2]['expr-is-german']).toBe(1);
    // The join index must have been seeded for the nested join, so per-row evaluation resolves
    // through the O(1) index fast path and never falls back to the per-row `relationships.find()`
    // slow-path scan.
    expect(relationshipsFindCalls).toBe(0);
  });
});

// ─── Arithmetic with join-source operand ─────────────────────────────────────

describe('arithmetic with join-source operand', () => {
  const rates = {
    id: 'source-rates',
    label: 'Exchange Rates',
    fields: [
      { id: 'id', label: 'Rate Key', type: 'string' as const },
      { id: 'toUsd', label: 'Rate (to USD)', type: 'number' as const },
    ],
    rows: [
      { id: 'EUR-2024-01', toUsd: 1.09 },
      { id: 'GBP-2024-01', toUsd: 1.27 },
    ],
  };

  const relationships = [
    {
      id: 'rel-orders-rates',
      sourceId: 'source-orders',
      sourceField: 'rateKey',
      targetId: 'source-rates',
      targetField: 'id',
      type: 'many-to-one' as const,
    },
  ];

  const dataSources = { 'source-rates': rates };

  const totalUsdExpr = fn('multiply', field('total'), {
    joinSourceId: 'source-rates',
    fieldId: 'toUsd',
  });

  it('multiplies a local field by a join-resolved numeric field', () => {
    const context: EvaluationContext = {
      expressionFields: [],
      row: { id: 'ORD-001', total: 100, rateKey: 'EUR-2024-01' },
      allRows: [],
      sourceId: 'source-orders',
      dataSources,
      relationships,
    };
    expect(evaluateExpression(totalUsdExpr, context)).toBeCloseTo(109, 5);
  });

  it('picks the correct row for a different rate key', () => {
    const context: EvaluationContext = {
      expressionFields: [],
      row: { id: 'ORD-002', total: 200, rateKey: 'GBP-2024-01' },
      allRows: [],
      sourceId: 'source-orders',
      dataSources,
      relationships,
    };
    expect(evaluateExpression(totalUsdExpr, context)).toBeCloseTo(254, 5);
  });

  it('returns 0 when the rate key does not match any row (null join coerces to 0)', () => {
    const context: EvaluationContext = {
      expressionFields: [],
      row: { id: 'ORD-003', total: 50, rateKey: 'USD-2024-01' },
      allRows: [],
      sourceId: 'source-orders',
      dataSources,
      relationships,
    };
    expect(evaluateExpression(totalUsdExpr, context)).toBe(0);
  });

  it('enriches all rows with the USD-normalised total', () => {
    const totalUsdField: StudioExpressionField = {
      id: 'expr-order-total-usd',
      label: 'Order Total (USD)',
      sourceId: 'source-orders',
      isMeasure: false,
      expression: totalUsdExpr,
    };
    const orderRows = [
      { id: 'ORD-001', total: 100, rateKey: 'EUR-2024-01' },
      { id: 'ORD-002', total: 200, rateKey: 'GBP-2024-01' },
    ];
    const result = enrichRowsWithExpressions(
      orderRows,
      [totalUsdField],
      'source-orders',
      dataSources,
      relationships,
    );
    expect(result[0]['expr-order-total-usd']).toBeCloseTo(109, 5);
    expect(result[1]['expr-order-total-usd']).toBeCloseTo(254, 5);
  });
});

// ─── Topological sort ────────────────────────────────────────────────────────

describe('topoSortExpressionFields', () => {
  it('returns independent fields in input order', () => {
    const a: StudioExpressionField = {
      id: 'a',
      label: 'A',
      sourceId: 's',
      isMeasure: false,
      expression: numVal(1),
    };
    const b: StudioExpressionField = {
      id: 'b',
      label: 'B',
      sourceId: 's',
      isMeasure: false,
      expression: numVal(2),
    };
    const sorted = topoSortExpressionFields([a, b]);
    expect(sorted.map((f) => f.id)).toEqual(['a', 'b']);
  });

  it('places dependency before dependent', () => {
    const profit: StudioExpressionField = {
      id: 'profit',
      label: 'Profit',
      sourceId: 's',
      isMeasure: false,
      expression: fn('subtract', field('revenue'), field('cost')),
    };
    const margin: StudioExpressionField = {
      id: 'margin',
      label: 'Margin',
      sourceId: 's',
      isMeasure: false,
      // margin references profit (another expression field)
      expression: fn('divide', field('profit'), field('revenue')),
    };
    // even if margin is listed first, profit should come first
    const sorted = topoSortExpressionFields([margin, profit]);
    const ids = sorted.map((f) => f.id);
    expect(ids.indexOf('profit')).toBeLessThan(ids.indexOf('margin'));
  });
});

// ─── Measure evaluation ──────────────────────────────────────────────────────

describe('evaluateMeasure', () => {
  const rows = [
    { revenue: 100, cost: 60 },
    { revenue: 200, cost: 120 },
    { revenue: 300, cost: 200 },
  ];

  it('sums a field', () => {
    const measure: StudioExpressionField = {
      id: 'totalRevenue',
      label: 'Total Revenue',
      sourceId: 'sales',
      isMeasure: true,
      expression: field('revenue', 'sum'),
    };
    expect(evaluateMeasure(measure, rows, noFields)).toBe(600);
  });

  it('averages a field', () => {
    const measure: StudioExpressionField = {
      id: 'avgRevenue',
      label: 'Avg Revenue',
      sourceId: 'sales',
      isMeasure: true,
      expression: field('revenue', 'avg'),
    };
    expect(evaluateMeasure(measure, rows, noFields)).toBe(200);
  });

  it('computes sum(revenue) / sum(cost)', () => {
    const measure: StudioExpressionField = {
      id: 'ratio',
      label: 'Revenue/Cost',
      sourceId: 'sales',
      isMeasure: true,
      expression: fn('divide', field('revenue', 'sum'), field('cost', 'sum')),
    };
    const result = evaluateMeasure(measure, rows, noFields);
    expect(result).toBeCloseTo(600 / 380);
  });

  it('returns 0 for non-measure field', () => {
    const colField: StudioExpressionField = {
      id: 'col',
      label: 'Col',
      sourceId: 'sales',
      isMeasure: false,
      expression: numVal(1),
    };
    expect(evaluateMeasure(colField, rows, noFields)).toBe(0);
  });

  // ─── null / non-numeric rows are skipped, not counted as 0 (finding 1.6) ──────

  const nullableRows = [
    { price: 100 },
    { price: null },
    { price: undefined },
    { price: 'n/a' },
    { price: 300 },
  ];

  it('averages only the numeric rows (nulls do not inflate the denominator)', () => {
    const measure: StudioExpressionField = {
      id: 'avgPrice',
      label: 'Avg Price',
      sourceId: 'sales',
      isMeasure: true,
      expression: field('price', 'avg'),
    };
    // avg over [100, 300] = 200 — NOT (100 + 300) / 5 = 80
    expect(evaluateMeasure(measure, nullableRows, noFields)).toBe(200);
  });

  it('takes the min of numeric rows only (null does not become a spurious 0)', () => {
    const measure: StudioExpressionField = {
      id: 'minPrice',
      label: 'Min Price',
      sourceId: 'sales',
      isMeasure: true,
      expression: field('price', 'min'),
    };
    // min over [100, 300] = 100 — NOT 0 (which a null-as-0 coercion would produce)
    expect(evaluateMeasure(measure, nullableRows, noFields)).toBe(100);
  });

  it('counts only the numeric rows', () => {
    const measure: StudioExpressionField = {
      id: 'countPrice',
      label: 'Count Price',
      sourceId: 'sales',
      isMeasure: true,
      expression: field('price', 'count'),
    };
    expect(evaluateMeasure(measure, nullableRows, noFields)).toBe(2);
  });

  it('matches computeAggregate semantics: measure avg == KPI avg on the same nullable data', () => {
    const measure: StudioExpressionField = {
      id: 'avgPrice',
      label: 'Avg Price',
      sourceId: 'sales',
      isMeasure: true,
      expression: field('price', 'avg'),
    };
    expect(evaluateMeasure(measure, nullableRows, noFields)).toBe(
      computeAggregate(nullableRows, 'price', 'avg'),
    );
  });

  // ─── count_distinct over RAW values, not numeric coercion (finding 2.23) ───────

  it('count_distinct over a string field counts distinct strings (not 0)', () => {
    // Regression: routing count_distinct through the numeric coercion collapsed every
    // non-numeric string to null, so the measure returned 0 while the KPI/grid paths
    // returned the true distinct count. It must now operate on the raw cell values.
    const stringRows = [{ region: 'US' }, { region: 'US' }, { region: 'EU' }, { region: 'APAC' }];
    const measure: StudioExpressionField = {
      id: 'distinctRegions',
      label: 'Distinct Regions',
      sourceId: 'sales',
      isMeasure: true,
      expression: field('region', 'count_distinct'),
    };
    expect(evaluateMeasure(measure, stringRows, noFields)).toBe(3);
  });

  it('count_distinct excludes null/undefined and matches the KPI path exactly', () => {
    const rows = [
      { region: 'US' },
      { region: 'US' },
      { region: 'EU' },
      { region: null },
      { region: undefined },
      {},
    ];
    const measure: StudioExpressionField = {
      id: 'distinctRegions',
      label: 'Distinct Regions',
      sourceId: 'sales',
      isMeasure: true,
      expression: field('region', 'count_distinct'),
    };
    expect(evaluateMeasure(measure, rows, noFields)).toBe(2);
    expect(evaluateMeasure(measure, rows, noFields)).toBe(
      computeAggregate(rows, 'region', 'count_distinct'),
    );
  });

  // ─── `count` over a non-numeric field counts non-null values, not 0 (finding 4) ───────────────

  it('count over a non-numeric (string) field counts non-null values, not 0', () => {
    // Before the fix, `count` built its value array via the numeric coercion used by
    // sum/avg/min/max — every string value fails that coercion, so `count(status)` over a
    // string column silently returned 0 for every row instead of the non-null row count.
    const statusRows = [{ status: 'paid' }, { status: 'unpaid' }, { status: 'paid' }];
    const measure: StudioExpressionField = {
      id: 'countStatus',
      label: 'Count Status',
      sourceId: 'sales',
      isMeasure: true,
      expression: field('status', 'count'),
    };
    expect(evaluateMeasure(measure, statusRows, noFields)).toBe(3);
  });

  it('count over a non-numeric field excludes null/undefined rows (SQL COUNT(col) semantics)', () => {
    const statusRows = [{ status: 'paid' }, { status: null }, { status: undefined }, {}];
    const measure: StudioExpressionField = {
      id: 'countStatus',
      label: 'Count Status',
      sourceId: 'sales',
      isMeasure: true,
      expression: field('status', 'count'),
    };
    expect(evaluateMeasure(measure, statusRows, noFields)).toBe(1);
  });

  it('count over a raw field matches the KPI row-count invariant for a fully-populated field', () => {
    // The documented "KPI over a raw field and an equivalent measure expression return the
    // same number" invariant, already enforced for avg/count_distinct — extended to `count`
    // for the case where every row has a real (non-null) value, so KPI's `rows.length` and
    // the measure's non-null count agree.
    const statusRows = [{ status: 'paid' }, { status: 'unpaid' }, { status: 'paid' }];
    const measure: StudioExpressionField = {
      id: 'countStatus',
      label: 'Count Status',
      sourceId: 'sales',
      isMeasure: true,
      expression: field('status', 'count'),
    };
    expect(evaluateMeasure(measure, statusRows, noFields)).toBe(
      computeAggregate(statusRows, 'status', 'count'),
    );
  });

  // ─── measure with a `datediff` root (finding 6) ────────────────────────────────────────────

  it('a measure whose root is `datediff` averages the per-row day difference, not 0', () => {
    const shipRows = [
      { order_date: '2024-01-01', ship_date: '2024-01-05' }, // 4 days
      { order_date: '2024-02-01', ship_date: '2024-02-03' }, // 2 days
    ];
    const measure: StudioExpressionField = {
      id: 'avgDaysToShip',
      label: 'Avg Days To Ship',
      sourceId: 'sales',
      isMeasure: true,
      expression: fn('datediff', strVal('day'), field('order_date'), field('ship_date')),
    };
    // Before the fix, an unrecognized measure root fell through to `default: return 0`.
    expect(evaluateMeasure(measure, shipRows, noFields)).toBe((4 + 2) / 2);
  });

  it('a `datediff` measure skips rows with invalid/missing dates rather than counting them as 0', () => {
    const shipRows = [
      { order_date: '2024-01-01', ship_date: '2024-01-05' }, // 4 days
      { order_date: null, ship_date: '2024-02-03' }, // invalid — skipped, not counted as 0 days
    ];
    const measure: StudioExpressionField = {
      id: 'avgDaysToShip',
      label: 'Avg Days To Ship',
      sourceId: 'sales',
      isMeasure: true,
      expression: fn('datediff', strVal('day'), field('order_date'), field('ship_date')),
    };
    // avg over [4] = 4 — NOT (4 + 0) / 2 = 2, which counting the invalid row as 0 would give.
    expect(evaluateMeasure(measure, shipRows, noFields)).toBe(4);
  });
});

// ─── Type inference ──────────────────────────────────────────────────────────

describe('inferExpressionType', () => {
  const sourceFields = [
    { id: 'revenue', label: 'Revenue', type: 'number' as const },
    { id: 'name', label: 'Name', type: 'string' as const },
    { id: 'date', label: 'Date', type: 'date' as const },
  ];

  it('infers number from arithmetic', () => {
    expect(inferExpressionType(fn('add', numVal(1), numVal(2)), sourceFields, noFields)).toBe(
      'number',
    );
    expect(inferExpressionType(fn('multiply', numVal(1), numVal(2)), sourceFields, noFields)).toBe(
      'number',
    );
    expect(
      inferExpressionType(
        fn('datediff', strVal('day'), strVal('2024-01-01'), strVal('2024-01-10')),
        sourceFields,
        noFields,
      ),
    ).toBe('number');
  });

  it('infers boolean from comparison', () => {
    expect(inferExpressionType(fn('equals', numVal(1), numVal(1)), sourceFields, noFields)).toBe(
      'boolean',
    );
    expect(inferExpressionType(fn('lessThan', numVal(1), numVal(2)), sourceFields, noFields)).toBe(
      'boolean',
    );
    expect(inferExpressionType(fn('isNull', field('name')), sourceFields, noFields)).toBe(
      'boolean',
    );
  });

  it('infers type from source field reference', () => {
    expect(inferExpressionType(field('revenue'), sourceFields, noFields)).toBe('number');
    expect(inferExpressionType(field('name'), sourceFields, noFields)).toBe('string');
    expect(inferExpressionType(field('date'), sourceFields, noFields)).toBe('date');
  });

  it('infers from value expression type', () => {
    expect(inferExpressionType(numVal(1), sourceFields, noFields)).toBe('number');
    expect(inferExpressionType(strVal('x'), sourceFields, noFields)).toBe('string');
    expect(inferExpressionType(boolVal(true), sourceFields, noFields)).toBe('boolean');
  });

  it('falls back to string for unknown field', () => {
    expect(inferExpressionType(field('unknown'), sourceFields, noFields)).toBe('string');
  });

  it("infers if-expression type from the 'then' branch", () => {
    expect(
      inferExpressionType(fn('if', boolVal(true), numVal(1), strVal('no')), sourceFields, noFields),
    ).toBe('number');
  });
});

// ─── Validation ──────────────────────────────────────────────────────────────

describe('validateExpressionField', () => {
  const sourceFields = [
    { id: 'revenue', label: 'Revenue', type: 'number' as const },
    { id: 'cost', label: 'Cost', type: 'number' as const },
  ];

  it('returns no errors for a valid expression', () => {
    const ef: StudioExpressionField = {
      id: 'profit',
      label: 'Profit',
      sourceId: 'sales',
      isMeasure: false,
      expression: fn('subtract', field('revenue'), field('cost')),
    };
    expect(validateExpressionField(ef, [ef], sourceFields)).toHaveLength(0);
  });

  it('reports missing id', () => {
    const ef = {
      id: '',
      label: 'Profit',
      sourceId: 'sales',
      isMeasure: false,
      expression: numVal(1),
    } as StudioExpressionField;
    const errors = validateExpressionField(ef, [ef], sourceFields);
    expect(errors.some((err) => err.message.includes('id'))).toBe(true);
  });

  it('reports missing label', () => {
    const ef = {
      id: 'profit',
      label: '',
      sourceId: 'sales',
      isMeasure: false,
      expression: numVal(1),
    } as StudioExpressionField;
    const errors = validateExpressionField(ef, [ef], sourceFields);
    expect(errors.some((err) => err.message.includes('label'))).toBe(true);
  });

  it('reports unknown field reference', () => {
    const ef: StudioExpressionField = {
      id: 'x',
      label: 'X',
      sourceId: 'sales',
      isMeasure: false,
      expression: fn('add', field('revenue'), field('nonexistent')),
    };
    const errors = validateExpressionField(ef, [ef], sourceFields);
    expect(errors.some((err) => err.message.includes('nonexistent'))).toBe(true);
  });

  it('detects direct self-reference cycle', () => {
    const ef: StudioExpressionField = {
      id: 'loop',
      label: 'Loop',
      sourceId: 'sales',
      isMeasure: false,
      expression: fn('add', field('loop'), numVal(1)),
    };
    const errors = validateExpressionField(ef, [ef], sourceFields);
    expect(errors.some((err) => err.message.includes('circular'))).toBe(true);
  });

  it('detects indirect cycle (a → b → a)', () => {
    const a: StudioExpressionField = {
      id: 'a',
      label: 'A',
      sourceId: 'sales',
      isMeasure: false,
      expression: fn('add', field('b'), numVal(1)),
    };
    const b: StudioExpressionField = {
      id: 'b',
      label: 'B',
      sourceId: 'sales',
      isMeasure: false,
      expression: fn('add', field('a'), numVal(1)),
    };
    const errors = validateExpressionField(a, [a, b], sourceFields);
    expect(errors.some((err) => err.message.includes('circular'))).toBe(true);
  });

  it('reports insufficient arity', () => {
    const ef: StudioExpressionField = {
      id: 'x',
      label: 'X',
      sourceId: 'sales',
      isMeasure: false,
      expression: fn('add', numVal(1)), // add needs ≥ 2
    };
    const errors = validateExpressionField(ef, [ef], sourceFields);
    expect(errors.some((err) => err.message.includes('"add"'))).toBe(true);
  });
});
