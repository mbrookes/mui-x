/**
 * Regression tests for finding 2.4 — prototype-chain lookups on client-supplied
 * keys in `resolveAlias` and `checkColumnAgainstAllowlist`.
 *
 * Both `descriptor.columnAliases?.[column]` and `allowlist[table]` used to be
 * plain bracket lookups on plain object literals, which inherit from
 * `Object.prototype`. A client-supplied `column`/`table` naming an inherited
 * member (`"constructor"`, `"toString"`, `"__proto__"`, `"hasOwnProperty"`, …)
 * would resolve to the INHERITED value (a truthy function/object) instead of
 * `undefined` — exactly the bug class `applyHaving`'s `opMap` lookup was already
 * fixed for (see `queryBuilder.test.ts`'s "HAVING operator allowlist" suite).
 * These tests pin the same own-property gate on the two sibling lookups named
 * by the finding.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveAlias,
  checkColumnAgainstAllowlist,
  validateAggregationAliases,
  validateHavingAliases,
  validateProjectionKeyCollisions,
} from '../columnValidation';
import type { BatchWidgetDescriptor } from '../../security/types';

const PROTO_KEYS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'];

describe('resolveAlias — own-property gate on columnAliases (finding 2.4)', () => {
  function descriptor(
    columnAliases: BatchWidgetDescriptor['columnAliases'],
  ): BatchWidgetDescriptor {
    return { id: 'w1', table: 'sales', columnAliases };
  }

  it.each(PROTO_KEYS)(
    'resolves the prototype-inherited key "%s" to the literal column name (not the inherited value)',
    (key) => {
      // An EMPTY columnAliases object still inherits from Object.prototype.
      const result = resolveAlias(descriptor({}), key);
      expect(result).toBe(key);
      expect(typeof result).toBe('string');
    },
  );

  it('still resolves a real, own alias entry normally', () => {
    expect(resolveAlias(descriptor({ ssn: 'amount' }), 'ssn')).toBe('amount');
  });

  it('returns the column unchanged when columnAliases is undefined', () => {
    expect(resolveAlias(descriptor(undefined), 'amount')).toBe('amount');
  });

  it('does not resolve to a non-string own value (defense in depth)', () => {
    // Not reachable through normal JSON (values are always strings on the wire),
    // but guards the case where an alias map entry is not a string.
    const withNonStringValue = { weird: 123 } as unknown as BatchWidgetDescriptor['columnAliases'];
    expect(resolveAlias(descriptor(withNonStringValue), 'weird')).toBe('weird');
  });
});

describe('checkColumnAgainstAllowlist — own-property gate on allowlist[table] (finding 2.4)', () => {
  it.each(PROTO_KEYS)(
    'rejects a table name matching a prototype-inherited member "%s" as "no entry" (fail-closed)',
    (table) => {
      expect(() =>
        checkColumnAgainstAllowlist(`${table}.id`, 'sales', { sales: ['id'] }, 'columns'),
      ).toThrow(/has no entry in the column allowlist/);
    },
  );

  it('still validates a real, own allowlist entry normally', () => {
    expect(() =>
      checkColumnAgainstAllowlist('sales.amount', 'sales', { sales: ['amount'] }, 'columns'),
    ).not.toThrow();
  });

  it('still fails closed for a genuinely-unlisted table (no regression from the gate itself)', () => {
    expect(() =>
      checkColumnAgainstAllowlist('unknown_table.id', 'sales', { sales: ['id'] }, 'columns'),
    ).toThrow(/has no entry in the column allowlist/);
  });

  it('rejects an unqualified column whose defaultTable name is prototype-inherited', () => {
    expect(() =>
      checkColumnAgainstAllowlist('id', 'constructor', { sales: ['id'] }, 'columns'),
    ).toThrow(/has no entry in the column allowlist/);
  });
});

describe('validateAggregationAliases — alias charset (finding 1.1)', () => {
  function descriptor(alias: string): BatchWidgetDescriptor {
    return {
      id: 'w1',
      table: 'sales',
      aggregations: [{ column: 'amount', func: 'sum', alias }],
    };
  }

  it('accepts a hyphenated alias (real expr-… / revenue-2024 logical id)', () => {
    expect(() => validateAggregationAliases(descriptor('revenue-2024'))).not.toThrow();
    expect(() => validateAggregationAliases(descriptor('expr-order-total'))).not.toThrow();
  });

  it('still accepts a plain underscore identifier', () => {
    expect(() => validateAggregationAliases(descriptor('total_revenue_2024'))).not.toThrow();
  });

  it('still rejects a dangerous alias carrying SQL syntax / whitespace', () => {
    expect(() => validateAggregationAliases(descriptor('revenue; DROP TABLE sales'))).toThrow(
      /contains characters outside the allowed set/,
    );
    expect(() => validateAggregationAliases(descriptor('bad alias'))).toThrow(
      /contains characters outside the allowed set/,
    );
  });
});

describe('validateAggregationAliases — duplicate/collision rejection (finding 3.4)', () => {
  it('rejects two aggregations sharing one alias', () => {
    // Both pass the charset check, but `execute.ts` SELECTs both aggregates AS the
    // same key (they collide onto ONE result-row key, silently dropping one) and
    // `applyHaving` binds a HAVING on that alias to whichever `find` returns first.
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'sales',
      aggregations: [
        { column: 'amount', func: 'sum', alias: 'total' },
        { column: 'amount', func: 'avg', alias: 'total' },
      ],
    };
    expect(() => validateAggregationAliases(descriptor)).toThrow(/Duplicate aggregation alias/);
  });

  it('accepts distinct aliases', () => {
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'sales',
      aggregations: [
        { column: 'amount', func: 'sum', alias: 'total' },
        { column: 'amount', func: 'avg', alias: 'average' },
      ],
    };
    expect(() => validateAggregationAliases(descriptor)).not.toThrow();
  });

  it('rejects an aggregation alias that collides with a projection output alias', () => {
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'sales',
      aggregations: [{ column: 'amount', func: 'sum', alias: 'revenue' }],
    };
    // `revenue` is also a projected column key — the aggregate and the projected
    // column would be SELECT-ed under the same key.
    expect(() => validateAggregationAliases(descriptor, ['revenue'])).toThrow(
      /collides with a projected column/,
    );
  });

  it('does not flag an alias/outputAlias collision when no output aliases are threaded', () => {
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'sales',
      aggregations: [{ column: 'amount', func: 'sum', alias: 'revenue' }],
    };
    // Aggregation-only callers (e.g. direct unit tests) omit the output-alias set.
    expect(() => validateAggregationAliases(descriptor)).not.toThrow();
  });
});

describe('validateProjectionKeyCollisions — projection-vs-projection collision (Tier3, iter24 finding)', () => {
  it('rejects two direct columns from different tables whose result key collides', () => {
    // `orders.category` and `customers.category` both key as `category` — one
    // silently overwrites the other on the result row.
    expect(() => validateProjectionKeyCollisions(['category', 'category'])).toThrow(
      /Two projected columns collide on the result-row key "category"/,
    );
  });

  it('rejects two renamed (output-alias) columns sharing the same alias', () => {
    expect(() => validateProjectionKeyCollisions(['expr-total', 'expr-total'])).toThrow(
      /collide on the result-row key "expr-total"/,
    );
  });

  it('accepts distinct keys', () => {
    expect(() => validateProjectionKeyCollisions(['category', 'region', 'amount'])).not.toThrow();
  });

  it('accepts an empty or single-element list', () => {
    expect(() => validateProjectionKeyCollisions([])).not.toThrow();
    expect(() => validateProjectionKeyCollisions(['category'])).not.toThrow();
  });
});

describe('validateHavingAliases — numeric value-shape guard (finding 2.1)', () => {
  function descriptor(value: unknown): BatchWidgetDescriptor {
    return {
      id: 'w1',
      table: 'sales',
      aggregations: [{ column: 'amount', func: 'sum', alias: 'total' }],
      having: [{ alias: 'total', operator: 'gt', value: value as number }],
    };
  }

  it('accepts a finite numeric HAVING value', () => {
    expect(() => validateHavingAliases(descriptor(10000))).not.toThrow();
    expect(() => validateHavingAliases(descriptor(0))).not.toThrow();
    expect(() => validateHavingAliases(descriptor(-5))).not.toThrow();
  });

  it.each([
    ['an array', [1, 2]],
    ['an object', { toString: () => '1' }],
    ['a string', '10000'],
    ['null', null],
    ['undefined', undefined],
    ['NaN', NaN],
    ['Infinity', Infinity],
  ])('rejects a non-numeric HAVING value (%s) with a descriptive error', (_label, value) => {
    expect(() => validateHavingAliases(descriptor(value))).toThrow(
      /HAVING value for alias "total" must be a finite number/,
    );
  });
});
