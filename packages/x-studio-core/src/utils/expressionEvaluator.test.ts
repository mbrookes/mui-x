import { describe, it, expect } from 'vitest';

import type {
  StudioExpression,
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
  MAX_EXPRESSION_DEPTH,
  type EvaluationContext,
} from './expressionEvaluator';
import { computeAggregate } from '../engine/kpiUtils';

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

// ─── Equality — explicit comparison policy, not loose `==` (finding H3) ───────
//
// The filter-side equivalents of these live in `filterUtils.test.ts`; the expression side had
// none, which is how three loose-`==` operators survived behind a rationale-free
// `eslint-disable-next-line eqeqeq` while every filter comparison was hardened around them.

describe('equality operators use the same comparison policy as the filter engine', () => {
  it('does not treat a blank string as equal to 0', () => {
    // The motivating case: a CSV whose blank numeric cells import as `''`. As a FILTER
    // (`discount equals 0`, `fieldType: 'number'`) these rows are correctly excluded, so a
    // measure `sum(if(discount == 0, 1, 0))` counting them made a KPI over the measure and a
    // KPI over the filtered count disagree.
    expect(
      evaluateExpression(fn('equals', field('discount'), numVal(0)), ctx({ discount: '' })),
    ).toBe(false);
    expect(
      evaluateExpression(fn('equals', field('discount'), numVal(0)), ctx({ discount: '   ' })),
    ).toBe(false);
    expect(
      evaluateExpression(fn('notEqual', field('discount'), numVal(0)), ctx({ discount: '' })),
    ).toBe(true);
  });

  it('does not treat booleans as numerically equal to 0 / 1', () => {
    expect(
      evaluateExpression(fn('equals', field('status'), numVal(0)), ctx({ status: false })),
    ).toBe(false);
    expect(evaluateExpression(fn('equals', field('flag'), numVal(1)), ctx({ flag: true }))).toBe(
      false,
    );
    // `false == '0'` was true under loose `==`.
    expect(
      evaluateExpression(fn('equals', field('status'), strVal('0')), ctx({ status: false })),
    ).toBe(false);
  });

  it('compares string representations for booleans and string-boolean columns', () => {
    // Mirrors `filterUtils`' `fieldType: 'boolean'` branch (`String(rv) === String(filterVal)`)
    // and `toBoolean`'s string-boolean handling: a CSV `'true'` and a real `true` are one value.
    expect(evaluateExpression(fn('equals', field('ok'), boolVal(true)), ctx({ ok: true }))).toBe(
      true,
    );
    expect(evaluateExpression(fn('equals', field('ok'), boolVal(true)), ctx({ ok: 'true' }))).toBe(
      true,
    );
    expect(evaluateExpression(fn('equals', field('ok'), boolVal(true)), ctx({ ok: 'false' }))).toBe(
      false,
    );
  });

  it("keeps numeric-string coercion working ('20' equals 20)", () => {
    // The one behaviour a fix must preserve — operands routinely arrive as raw text-input
    // strings, exactly as `filterUtils`' numeric `equals` branch documents.
    expect(evaluateExpression(fn('equals', field('qty'), numVal(20)), ctx({ qty: '20' }))).toBe(
      true,
    );
    expect(evaluateExpression(fn('equals', field('qty'), strVal('20')), ctx({ qty: 20 }))).toBe(
      true,
    );
    expect(evaluateExpression(fn('equals', field('qty'), numVal(20)), ctx({ qty: '20.0' }))).toBe(
      true,
    );
  });

  it('treats nullish as equal only to nullish', () => {
    // Kept verbatim from loose `==` (`null == undefined` was already true, `null == 0` false)
    // and matching the filter engine's `rv != null &&` guard.
    expect(evaluateExpression(fn('equals', field('a'), field('b')), ctx({}))).toBe(true);
    expect(evaluateExpression(fn('equals', field('a'), numVal(0)), ctx({ a: null }))).toBe(false);
    expect(evaluateExpression(fn('equals', field('a'), strVal('')), ctx({ a: null }))).toBe(false);
    expect(evaluateExpression(fn('notEqual', field('a'), numVal(0)), ctx({ a: null }))).toBe(true);
  });

  it('`in` answers "same value?" identically to `equals`', () => {
    // `in(x, a, b)` must be exactly `equals(x, a) || equals(x, b)`.
    expect(evaluateExpression(fn('in', field('d'), numVal(0)), ctx({ d: '' }))).toBe(false);
    expect(evaluateExpression(fn('in', field('d'), numVal(0)), ctx({ d: false }))).toBe(false);
    expect(evaluateExpression(fn('in', field('d'), numVal(0)), ctx({ d: 0 }))).toBe(true);
    expect(evaluateExpression(fn('in', field('d'), numVal(20), numVal(30)), ctx({ d: '20' }))).toBe(
      true,
    );
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

  it('isTrue / isFalse accept the string-boolean form a CSV column carries', () => {
    // Same divergence `toBoolean` was fixed for (finding 12): a boolean column sourced from
    // CSV/API arrives as `'true'`/`'false'`. `if(on_time, 1, 0)` scored 1 for such a row and a
    // `fieldType: 'boolean'` filter matched it, while `isTrue(on_time)` alone said false.
    expect(evaluateExpression(fn('isTrue', field('ok')), ctx({ ok: 'true' }))).toBe(true);
    expect(evaluateExpression(fn('isFalse', field('ok')), ctx({ ok: 'false' }))).toBe(true);
    expect(evaluateExpression(fn('isTrue', field('ok')), ctx({ ok: 'false' }))).toBe(false);
  });

  it('isTrue / isFalse stay strict — they are not a truthiness test', () => {
    // Deliberately NOT `toBoolean`: `and`/`or`/`if` ask "is this truthy", `isTrue` asks "is
    // this the boolean true". Widening to truthiness would make `isTrue(1)` and
    // `isTrue('yes')` true.
    expect(evaluateExpression(fn('isTrue', numVal(1)), ctx({}))).toBe(false);
    expect(evaluateExpression(fn('isTrue', strVal('yes')), ctx({}))).toBe(false);
    expect(evaluateExpression(fn('isFalse', numVal(0)), ctx({}))).toBe(false);
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

  // ─── Reverse-declared relationships (finding M3) ────────────────────────────
  //
  // The same relationship declared from the ONE side. `createBatchingAdapter.resolveField`
  // has always handled both directions (emitting `LEFT JOIN customers ON customers.id =
  // orders.customerId`), while the in-memory evaluator matched only `r.sourceId === sourceId`
  // on BOTH its fast and slow paths — so the identical doc resolved to a real value through
  // an adapter-backed source and to `null` for every row in memory, blanking e.g. a
  // "revenue by customer country" chart.
  const reverseRelationships = [
    {
      id: 'rel-customers-orders',
      sourceId: 'source-customers',
      targetId: 'source-orders',
      sourceField: 'id',
      targetField: 'customerId',
      type: 'many-to-one' as const,
    },
  ];

  it('resolves a join field expression through a REVERSE-declared relationship (slow path)', () => {
    const context: EvaluationContext = {
      expressionFields: [],
      row: { id: 'ORD-001', customerId: 'CUS-001', total: 100 },
      allRows: [],
      sourceId: 'source-orders',
      dataSources,
      relationships: reverseRelationships,
    };
    expect(evaluateExpression(joinExpr, context)).toBe('Germany');
  });

  it('resolves a REVERSE-declared join through the prebuilt index (fast path) too', () => {
    // Both paths must agree — they previously agreed only because both were wrong.
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
      reverseRelationships,
    );
    expect(result[0]['expr-order-country']).toBe('Germany');
    expect(result[1]['expr-order-country']).toBe('UK');
    expect(result[2]['expr-order-country']).toBeNull();
  });

  it('does not resolve a join across a many-to-many relationship', () => {
    // An M:N relationship's sourceField/targetField are two endpoint keys, not an FK/PK pair,
    // so a direct join across one is meaningless. `enrichRowsWithRelatedFields`,
    // `findDirectFieldOwner` and the adapter's join resolution all skip M:N; the evaluator's
    // index used to include it and produce garbage.
    const context: EvaluationContext = {
      expressionFields: [],
      row: { id: 'ORD-001', customerId: 'CUS-001' },
      allRows: [],
      sourceId: 'source-orders',
      dataSources,
      relationships: [
        {
          id: 'rel-mn',
          sourceId: 'source-orders',
          targetId: 'source-customers',
          sourceField: 'customerId',
          targetField: 'id',
          type: 'many-to-many' as const,
          junctionSourceId: 'junction',
          junctionSourceField: 'orderId',
          junctionTargetField: 'customerId',
        },
      ],
    };
    expect(evaluateExpression(joinExpr, context)).toBeNull();
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

  it('counts EVERY row (COUNT(*)), not just the numeric ones', () => {
    // `count` is `COUNT(*)` on every path in the package (finding M8) — the KPI, the grid
    // footer/group-by, the pivot and all three chart aggregators tally ROWS and ignore the
    // measure value entirely. This branch used to answer a different question under the same
    // name ("how many values coerced to a number"), so a KPI over `price` with aggregation
    // `count` read 5 while a KPI over the measure `count(price)` read 2 on the same rows.
    // The value-sensitive counts have their own names: `count_non_null` (`COUNT(col)`) and
    // `count_distinct`.
    const measure: StudioExpressionField = {
      id: 'countPrice',
      label: 'Count Price',
      sourceId: 'sales',
      isMeasure: true,
      expression: field('price', 'count'),
    };
    expect(evaluateMeasure(measure, nullableRows, noFields)).toBe(nullableRows.length);
    expect(evaluateMeasure(measure, nullableRows, noFields)).toBe(
      computeAggregate(nullableRows, 'price', 'count'),
    );
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

  // ─── `count` over a non-numeric field is COUNT(*), not 0 (findings 4 / M8) ────────────────────

  it('count over a non-numeric (string) field counts rows, not 0', () => {
    // Before finding 4, `count` built its value array via the numeric coercion used by
    // sum/avg/min/max — every string value fails that coercion, so `count(status)` over a
    // string column silently returned 0 for every row.
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

  it('count over a non-numeric field INCLUDES null/undefined rows (COUNT(*), not COUNT(col))', () => {
    // This branch used to return the non-null count (1) here, which is a DIFFERENT question
    // from the one every other `count` path in the package answers (finding M8). `COUNT(col)`
    // still exists — under its own name, `count_non_null` — but the bare name `count` means
    // `COUNT(*)` everywhere, so the KPI and the measure agree.
    const statusRows = [{ status: 'paid' }, { status: null }, { status: undefined }, {}];
    const measure: StudioExpressionField = {
      id: 'countStatus',
      label: 'Count Status',
      sourceId: 'sales',
      isMeasure: true,
      expression: field('status', 'count'),
    };
    expect(evaluateMeasure(measure, statusRows, noFields)).toBe(4);
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

// ─── Validation: reachability scope ──────────────────────────────────────────
//
// An expression field owned by an unrelated data source used to be accepted as an operand:
// it resolves by id across ALL expression fields, so validation passed, the field saved, and
// at evaluation time it ran against the referencing source's rows — which don't carry its
// columns — producing `null`/`NaN` for every row with no error anywhere. The operand picker
// already scopes its options to reachable sources; validation now applies the same rule so
// persisted and AI-authored expressions are caught too.
describe('validateExpressionField reachability scope', () => {
  const sourceFields = [{ id: 'revenue', label: 'Revenue', type: 'number' as const }];

  const remote: StudioExpressionField = {
    id: 'ltv',
    label: 'Lifetime value',
    sourceId: 'customers',
    isMeasure: false,
    expression: numVal(1),
  };
  const referencing: StudioExpressionField = {
    id: 'x',
    label: 'X',
    sourceId: 'orders',
    isMeasure: false,
    expression: fn('add', field('ltv'), numVal(1)),
  };

  it('does not run the check when no reachable set is supplied', () => {
    expect(validateExpressionField(referencing, [referencing, remote], sourceFields)).toHaveLength(
      0,
    );
  });

  it('rejects an operand owned by a source outside the reachable set', () => {
    const errors = validateExpressionField(referencing, [referencing, remote], sourceFields, {
      reachableSourceIds: new Set(['orders']),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: 'unreachableField',
      fieldId: 'ltv',
      fieldSourceId: 'customers',
      path: ['inputs', '0'],
    });
  });

  it('accepts the same operand once its owning source is reachable', () => {
    expect(
      validateExpressionField(referencing, [referencing, remote], sourceFields, {
        reachableSourceIds: new Set(['orders', 'customers']),
      }),
    ).toHaveLength(0);
  });

  it('accepts a reference to an expression field owned by the same source', () => {
    const sibling: StudioExpressionField = { ...remote, id: 'margin', sourceId: 'orders' };
    const ef: StudioExpressionField = {
      ...referencing,
      expression: fn('add', field('margin'), numVal(1)),
    };
    expect(
      validateExpressionField(ef, [ef, sibling], sourceFields, {
        reachableSourceIds: new Set(['orders']),
      }),
    ).toHaveLength(0);
  });

  it('never flags a physical source field, even when an unreachable expression field shares its id', () => {
    const shadow: StudioExpressionField = { ...remote, id: 'revenue' };
    const ef: StudioExpressionField = {
      ...referencing,
      expression: fn('add', field('revenue'), numVal(1)),
    };
    expect(
      validateExpressionField(ef, [ef, shadow], sourceFields, {
        reachableSourceIds: new Set(['orders']),
      }),
    ).toHaveLength(0);
  });

  it('still reports a genuinely unknown field rather than an unreachable one', () => {
    const ef: StudioExpressionField = {
      ...referencing,
      expression: fn('add', field('nope'), numVal(1)),
    };
    const errors = validateExpressionField(ef, [ef, remote], sourceFields, {
      reachableSourceIds: new Set(['orders']),
    });
    expect(errors.map((err) => err.code)).toEqual(['unknownField']);
  });
});

// ─── Validation: error codes ─────────────────────────────────────────────────
//
// The dialog renders these errors in a `role="alert"` banner. Rendering `message` verbatim
// was the one user-facing English string in an otherwise fully-localized dialog, so every
// error carries a machine-readable `code` plus its interpolation operands as named fields;
// the dialog maps the code onto a `StudioLocaleText` template. `message` stays as the
// English fallback for non-UI callers.
describe('validation error codes', () => {
  const sourceFields = [{ id: 'revenue', label: 'Revenue', type: 'number' as const }];

  it('tags a missing id / label / sourceId', () => {
    const ef = {
      id: '',
      label: '',
      sourceId: '',
      isMeasure: false,
      expression: numVal(1),
    } as StudioExpressionField;
    expect(validateExpressionField(ef, [ef], sourceFields).map((err) => err.code)).toEqual([
      'missingId',
      'missingLabel',
      'missingSourceId',
    ]);
  });

  it('tags an unknown field reference with the referenced id', () => {
    const ef: StudioExpressionField = {
      id: 'x',
      label: 'X',
      sourceId: 'sales',
      isMeasure: false,
      expression: fn('add', field('revenue'), field('nonexistent')),
    };
    expect(validateExpressionField(ef, [ef], sourceFields)[0]).toMatchObject({
      code: 'unknownField',
      fieldId: 'nonexistent',
    });
  });

  it('tags insufficient arity with the operator and both counts', () => {
    const ef: StudioExpressionField = {
      id: 'x',
      label: 'X',
      sourceId: 'sales',
      isMeasure: false,
      expression: fn('add', numVal(1)),
    };
    expect(validateExpressionField(ef, [ef], sourceFields)[0]).toMatchObject({
      code: 'insufficientArity',
      operator: 'add',
      required: 2,
      actual: 1,
    });
  });

  it('tags a circular dependency with the offending field id', () => {
    const ef: StudioExpressionField = {
      id: 'loop',
      label: 'Loop',
      sourceId: 'sales',
      isMeasure: false,
      expression: fn('add', field('loop'), numVal(1)),
    };
    expect(validateExpressionField(ef, [ef], sourceFields)[0]).toMatchObject({
      code: 'circularDependency',
      fieldId: 'loop',
    });
  });

  it('tags a malformed node', () => {
    const ef = {
      id: 'x',
      label: 'X',
      sourceId: 'sales',
      isMeasure: false,
      expression: '1 + 1',
    } as unknown as StudioExpressionField;
    expect(validateExpressionField(ef, [ef], sourceFields)[0]).toMatchObject({
      code: 'malformedNode',
    });
  });

  it('tags an over-deep tree with the depth bound it exceeded', () => {
    let expr: StudioExpression = numVal(1);
    for (let i = 0; i < MAX_EXPRESSION_DEPTH + 5; i += 1) {
      expr = fn('negate', expr);
    }
    const ef: StudioExpressionField = {
      id: 'deep',
      label: 'Deep',
      sourceId: 'sales',
      isMeasure: false,
      expression: expr,
    };
    const errors = validateExpressionField(ef, [ef], sourceFields);
    expect(errors.some((err) => err.code === 'maxDepth')).toBe(true);
    expect(errors.find((err) => err.code === 'maxDepth')).toMatchObject({
      maxDepth: MAX_EXPRESSION_DEPTH,
    });
  });
});

// ─── Malformed / hostile persisted expressions ───────────────────────────────
//
// H1 — the load boundary (`@mui/x-studio-schema`'s `loadSerializedState`) only screens each
// `expressionFields[i]` for being a record; it never looks at its `expression`. So every
// walker in this module can be handed a string, a number, `null`, `undefined`, an array, or a
// function node with no `inputs` array. Before the fix the `in`-based type guards threw a raw
// `TypeError: Cannot use 'in' operator to search for 'operator' in 1 + 1`, which — from a
// render path — blanks the whole data drawer plus every widget on the source. Every entry
// point must instead degrade to the module's normal "unresolvable node" fallback.

const malformedExpressions: Array<[string, unknown]> = [
  ['a raw expression string (never parsed)', '1 + 1'],
  ['a number', 1],
  ['a boolean', true],
  ['null', null],
  ['undefined', undefined],
  ['an array', [{ operator: 'add' }]],
  ['a function node with no inputs', { operator: 'add' }],
  ['a function node with non-array inputs', { operator: 'add', inputs: 'nope' }],
  ['an empty object', {}],
];

describe('malformed expression nodes (H1)', () => {
  const sourceFields = [{ id: 'a', label: 'A', type: 'number' as const }];

  it.each(malformedExpressions)('type guards do not throw for %s', (_label, bad) => {
    const expr = bad as StudioExpression;
    expect(() => isFunctionExpression(expr)).not.toThrow();
    expect(() => isValueExpression(expr)).not.toThrow();
    expect(() => isFieldExpression(expr)).not.toThrow();
    expect(() => isJoinFieldExpression(expr)).not.toThrow();
    expect(isFunctionExpression(expr)).toBe(false);
    expect(isValueExpression(expr)).toBe(false);
    expect(isFieldExpression(expr)).toBe(false);
    expect(isJoinFieldExpression(expr)).toBe(false);
  });

  it.each(malformedExpressions)('evaluateExpression returns null for %s', (_label, bad) => {
    expect(evaluateExpression(bad as StudioExpression, ctx({ a: 1 }))).toBeNull();
  });

  it.each(malformedExpressions)(
    'evaluateExpression does not throw when %s is nested inside a function node',
    (_label, bad) => {
      const expr = fn('add', numVal(1), bad as StudioExpression);
      expect(() => evaluateExpression(expr, ctx({ a: 1 }))).not.toThrow();
      // The malformed operand resolves to null → `toNumber(null) === 0`.
      expect(evaluateExpression(expr, ctx({ a: 1 }))).toBe(1);
    },
  );

  it.each(malformedExpressions)('inferExpressionType returns a type for %s', (_label, bad) => {
    const expr = bad as StudioExpression;
    expect(() => inferExpressionType(expr, sourceFields, noFields)).not.toThrow();
    expect(inferExpressionType(expr, sourceFields, noFields)).toBe('string');
  });

  it.each(malformedExpressions)(
    'validateExpressionField reports %s instead of throwing',
    (_label, bad) => {
      const ef = {
        id: 'x',
        label: 'X',
        sourceId: 'sales',
        isMeasure: false,
        expression: bad,
      } as unknown as StudioExpressionField;
      expect(() => validateExpressionField(ef, [ef], sourceFields)).not.toThrow();
      expect(validateExpressionField(ef, [ef], sourceFields).length).toBeGreaterThan(0);
    },
  );

  it.each(malformedExpressions)('evaluateMeasure returns a number for %s', (_label, bad) => {
    const measure = {
      id: 'm',
      label: 'M',
      sourceId: 'sales',
      isMeasure: true,
      expression: bad,
    } as unknown as StudioExpressionField;
    expect(() => evaluateMeasure(measure, [{ a: 1 }], noFields)).not.toThrow();
    expect(evaluateMeasure(measure, [{ a: 1 }], noFields)).toBe(0);
  });

  it.each(malformedExpressions)('topoSortExpressionFields tolerates %s', (_label, bad) => {
    const ef = {
      id: 'x',
      label: 'X',
      sourceId: 'sales',
      isMeasure: false,
      expression: bad,
    } as unknown as StudioExpressionField;
    expect(() => topoSortExpressionFields([ef])).not.toThrow();
    expect(topoSortExpressionFields([ef])).toHaveLength(1);
  });

  // The exact reproduction from the report: a persisted expression field whose `expression`
  // is the raw authoring string rather than a parsed AST.
  it('enrichRowsWithExpressions survives a persisted string expression', () => {
    const ef = {
      id: 'ef1',
      sourceId: 's1',
      label: 'EF1',
      isMeasure: false,
      expression: '1 + 1',
    } as unknown as StudioExpressionField;
    expect(() => enrichRowsWithExpressions([{ a: 1 }], [ef], 's1')).not.toThrow();
    expect(enrichRowsWithExpressions([{ a: 1 }], [ef], 's1')).toEqual([{ a: 1, ef1: null }]);
  });
});

// ─── Unbounded recursion guards (M4) ─────────────────────────────────────────

describe('cycle guard in inferExpressionType (M4)', () => {
  const sourceFields = [{ id: 'revenue', label: 'Revenue', type: 'number' as const }];

  // `deserializeState` does NOT run `hasExpressionCycle` (only the controller's add/update
  // path does), so a persisted `a → b → a` pair reaches every walker in this module.
  // `evaluateExpression`/`detectCycles`/`topoSortExpressionFields` all guarded already;
  // `inferExpressionType` did not, and blew the stack from `StudioMapWidget`'s render and
  // from `StudioExpressionFieldDialog`.
  const mutuallyReferencing: StudioExpressionField[] = [
    { id: 'a', label: 'A', sourceId: 'sales', isMeasure: false, expression: field('b') },
    { id: 'b', label: 'B', sourceId: 'sales', isMeasure: false, expression: field('a') },
  ];

  it('does not overflow the stack on a → b → a', () => {
    expect(() => inferExpressionType(field('a'), sourceFields, mutuallyReferencing)).not.toThrow();
    expect(inferExpressionType(field('a'), sourceFields, mutuallyReferencing)).toBe('string');
  });

  it('does not overflow the stack on a direct self-reference', () => {
    const selfRef: StudioExpressionField[] = [
      { id: 'loop', label: 'Loop', sourceId: 'sales', isMeasure: false, expression: field('loop') },
    ];
    expect(() => inferExpressionType(field('loop'), sourceFields, selfRef)).not.toThrow();
  });

  it('still resolves a legitimate (acyclic) chain of expression-field references', () => {
    const chain: StudioExpressionField[] = [
      { id: 'a', label: 'A', sourceId: 'sales', isMeasure: false, expression: field('b') },
      { id: 'b', label: 'B', sourceId: 'sales', isMeasure: false, expression: field('revenue') },
    ];
    expect(inferExpressionType(field('a'), sourceFields, chain)).toBe('number');
  });
});

describe('expression depth bound (M4)', () => {
  // A ~20 000-deep nested `negate` is only a few hundred KB of JSON; V8's parser is iterative,
  // so it survives `JSON.parse` intact and only overflows the stack inside these recursive
  // walkers.
  function nest(depth: number): StudioExpression {
    let expr: StudioExpression = numVal(1);
    for (let i = 0; i < depth; i += 1) {
      expr = fn('negate', expr);
    }
    return expr;
  }

  const deep = nest(20_000);
  const sourceFields = [{ id: 'revenue', label: 'Revenue', type: 'number' as const }];

  it('MAX_EXPRESSION_DEPTH leaves plenty of headroom for real expressions', () => {
    expect(MAX_EXPRESSION_DEPTH).toBeGreaterThanOrEqual(32);
  });

  it('evaluateExpression does not overflow the stack', () => {
    expect(() => evaluateExpression(deep, ctx({}))).not.toThrow();
  });

  it('evaluateMeasure does not overflow the stack', () => {
    const measure: StudioExpressionField = {
      id: 'm',
      label: 'M',
      sourceId: 'sales',
      isMeasure: true,
      expression: deep,
    };
    expect(() => evaluateMeasure(measure, [{ revenue: 1 }], noFields)).not.toThrow();
  });

  it('inferExpressionType does not overflow the stack', () => {
    expect(() => inferExpressionType(deep, sourceFields, noFields)).not.toThrow();
  });

  it('validateExpressionField reports the over-deep tree instead of overflowing', () => {
    const ef: StudioExpressionField = {
      id: 'x',
      label: 'X',
      sourceId: 'sales',
      isMeasure: false,
      expression: deep,
    };
    let errors: ReturnType<typeof validateExpressionField> = [];
    expect(() => {
      errors = validateExpressionField(ef, [ef], sourceFields);
    }).not.toThrow();
    expect(errors.some((err) => err.message.includes('nested more than'))).toBe(true);
  });

  it('topoSortExpressionFields (via collectFieldRefs) does not overflow the stack', () => {
    const ef: StudioExpressionField = {
      id: 'x',
      label: 'X',
      sourceId: 'sales',
      isMeasure: false,
      expression: deep,
    };
    expect(() => topoSortExpressionFields([ef])).not.toThrow();
  });

  it('enrichRowsWithExpressions does not overflow the stack', () => {
    const ef: StudioExpressionField = {
      id: 'ef1',
      label: 'EF1',
      sourceId: 's1',
      isMeasure: false,
      expression: deep,
    };
    expect(() => enrichRowsWithExpressions([{ a: 1 }], [ef], 's1')).not.toThrow();
  });

  it('evaluates an expression nested just under the bound normally', () => {
    // 8 nested negates over 1 → still 1 (even count), and well inside the bound.
    expect(evaluateExpression(nest(8), ctx({}))).toBe(1);
    expect(evaluateExpression(nest(9), ctx({}))).toBe(-1);
  });
});
