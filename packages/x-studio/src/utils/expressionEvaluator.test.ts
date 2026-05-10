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
    const prebuiltIndex = new Map<unknown, Record<string, unknown>>([
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
    const prebuiltIndex = new Map<unknown, Record<string, unknown>>([
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
