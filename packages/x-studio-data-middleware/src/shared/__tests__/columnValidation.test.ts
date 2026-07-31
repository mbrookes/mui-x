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
  assertNoImplicitAlias,
  assertSingleDotReference,
  isWildcardReference,
  qualifiedTableOf,
  qualifyAgainst,
  resolveAlias,
  checkColumnAgainstAllowlist,
  validateAggregationAliases,
  validateHavingAliases,
  validateProjectionKeyCollisions,
  validateWildcardProjection,
} from '../columnValidation';
import { assertQualifiedColumnsAllowed, assertTablesAllowed } from '../assertTablesAllowed';
import { MAX_STRING_LENGTH } from '../limits';
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

describe('checkColumnAgainstAllowlist — multi-dot references rejected (Tier3 iter26 finding 6)', () => {
  // Splitting a qualified reference at the FIRST dot reads "a.b.c" as table "a",
  // column "b.c" — but Knex/SQL would read the same string as
  // "schema.table.column". Reject the ambiguity outright rather than silently
  // parsing it one way here and letting the driver parse it another way.
  it('rejects a reference with two dots ("schema.table.column")', () => {
    expect(() =>
      checkColumnAgainstAllowlist('public.sales.amount', 'sales', { sales: ['amount'] }, 'columns'),
    ).toThrow(/contains more than one "\."/);
  });

  it('rejects a reference with three or more dots', () => {
    expect(() =>
      checkColumnAgainstAllowlist('a.b.c.d', 'sales', { sales: ['id'] }, 'columns'),
    ).toThrow(/contains more than one "\."/);
  });

  it('still accepts a normal single-dot "table.column" reference', () => {
    expect(() =>
      checkColumnAgainstAllowlist('sales.amount', 'sales', { sales: ['amount'] }, 'columns'),
    ).not.toThrow();
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

  it('rejects an alias longer than MAX_STRING_LENGTH, built entirely from allowed characters (F12)', () => {
    // The CHARSET cap and the LENGTH cap are separate guards, and only the
    // charset one was covered — a client can send an arbitrarily long string of
    // letters/digits/underscores that `SAFE_ALIAS_PATTERN` happily accepts. The
    // alias is folded into the query cache key and re-validated across a batch,
    // so an unbounded one is unbounded work driven by client input.
    const tooLong = 'a'.repeat(MAX_STRING_LENGTH + 1);
    expect(() => validateAggregationAliases(descriptor(tooLong))).toThrow(
      new RegExp(`is ${MAX_STRING_LENGTH + 1} characters long, which exceeds the maximum`),
    );
    // The message must not echo the whole alias back.
    expect(() => validateAggregationAliases(descriptor(tooLong))).not.toThrow(new RegExp(tooLong));
    // Exactly at the cap is still accepted — the boundary is `>`, not `>=`.
    expect(() =>
      validateAggregationAliases(descriptor('a'.repeat(MAX_STRING_LENGTH))),
    ).not.toThrow();
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

// ─── Implicit `" as "` alias references are rejected (finding L2) ─────────────
//
// Knex's `wrapString` splits ANY identifier containing `" as "` (case-insensitively)
// into `<expr> as <alias>` before quoting; this package's own parsers do not —
// `resultKeyOf` splits only on `.`. That divergence let two projected columns land
// on the SAME Knex row key while `validateProjectionKeyCollisions` saw two distinct
// keys, so one silently overwrote the other in every row.
describe('assertNoImplicitAlias / checkColumnAgainstAllowlist — " as " is rejected (finding L2)', () => {
  const ALLOWLIST = { orders: ['*'], customers: ['*'] };

  it.each([
    ['lowercase', 'orders.total as amount'],
    ['uppercase', 'orders.total AS amount'],
    ['mixed case', 'orders.total As amount'],
    ['unqualified', 'total as amount'],
  ])('rejects a %s " as " reference', (_label, reference) => {
    expect(() => assertNoImplicitAlias(reference, 'columns')).toThrow(/contains " as "/);
    expect(() => checkColumnAgainstAllowlist(reference, 'orders', ALLOWLIST, 'columns')).toThrow(
      /contains " as "/,
    );
  });

  it.each(['total', 'orders.total', 'as_of_date', 'last_assigned', 'aspect', 'orders.gas'])(
    'accepts "%s" — the guard matches the delimited " as " token, not any substring',
    (reference) => {
      expect(() => assertNoImplicitAlias(reference, 'columns')).not.toThrow();
    },
  );

  it('names the reference and the context so the caller can locate it', () => {
    expect(() => assertNoImplicitAlias('orders.total as amount', 'orderBy')).toThrow(
      /Column reference "orders\.total as amount" \(in orderBy\) contains " as "/,
    );
  });
});

// ── Table qualification is minted in ONE place ────────────────────────────────
//
// `qualifyAgainst` replaces seven independent copies of
// `x.includes('.') ? x : `${table}.${x}`` that were spread across the validation
// stage (`validateQueryPlan`) and three enforcement sites (`queryBuilder`'s join
// `on` / filter / HAVING / null-indicator paths, and `execute.ts`'s `qualify()`).
// A validator and an executor disagreeing about which table an unqualified
// column belongs to is the same failure mode `resolveAlias` exists to prevent
// for the sibling concern, alias resolution.
describe('qualifyAgainst', () => {
  it('qualifies an unqualified reference with the supplied table', () => {
    expect(qualifyAgainst('orders', 'amount')).toBe('orders.amount');
  });

  it('leaves an already-qualified reference untouched, whatever table it names', () => {
    expect(qualifyAgainst('orders', 'customers.amount')).toBe('customers.amount');
    expect(qualifyAgainst('orders', 'orders.amount')).toBe('orders.amount');
  });

  it('is idempotent, so a second qualification pass can never double-qualify', () => {
    expect(qualifyAgainst('orders', qualifyAgainst('orders', 'amount'))).toBe('orders.amount');
  });

  it('anchors a bare wildcard to the table (never leaves a cross-table `*`)', () => {
    expect(qualifyAgainst('orders', '*')).toBe('orders.*');
  });
});

describe('qualifiedTableOf', () => {
  it('returns the qualifying table of a dotted reference', () => {
    expect(qualifiedTableOf('customers.name')).toBe('customers');
  });

  it('returns undefined for an unqualified reference', () => {
    expect(qualifiedTableOf('name')).toBeUndefined();
  });

  it('tolerates a non-string reference instead of throwing (one tolerant definition)', () => {
    // Previously defined twice with DIFFERENT runtime guards — the
    // `validateQueryPlan` copy tolerated a non-string, the `assertTablesAllowed`
    // copy threw a raw `TypeError` on it.
    expect(qualifiedTableOf(5 as unknown as string)).toBeUndefined();
    expect(qualifiedTableOf(undefined as unknown as string)).toBeUndefined();
  });
});

describe('assertSingleDotReference — one rule, one error text', () => {
  it('accepts an unqualified and a table-qualified reference', () => {
    expect(() => assertSingleDotReference('amount', 'columns')).not.toThrow();
    expect(() => assertSingleDotReference('orders.amount', 'columns')).not.toThrow();
  });

  it('rejects a deeper-qualified reference', () => {
    expect(() => assertSingleDotReference('public.orders.amount', 'columns')).toThrow(
      /contains more than one "\."/,
    );
  });

  it('reports the SAME message from the column-allowlist and schema-allowlist paths', () => {
    // The identical rule used to throw `MUI X Studio Server:` from
    // `checkColumnAgainstAllowlist` and `MUI X:` from `checkQualifiedColumn`.
    const fromColumnAllowlist = captureMessage(() =>
      checkColumnAgainstAllowlist('a.b.c', 'orders', { orders: ['*'] }, 'columns'),
    );
    const fromSchemaAllowlist = captureMessage(() =>
      assertQualifiedColumnsAllowed({ id: 'w1', table: 'orders', columns: ['a.b.c'] }, ['orders']),
    );
    expect(fromColumnAllowlist).toMatch(/^MUI X Studio Server: /);
    expect(fromSchemaAllowlist).toBe(fromColumnAllowlist);
  });
});

// ── Wildcard projections are un-key-able ──────────────────────────────────────
//
// `resultKeyOf` maps `orders.*` to the literal `"*"`, which is not a key any row
// actually carries — so `validateProjectionKeyCollisions` could not see that
// `SELECT orders.*, customers.name` returns a row object in which
// `customers.name` overwrites `orders.name` (pg and mysql2 both key rows by
// field name, last-wins). A wildcard is therefore admitted only as the WHOLE
// projection, where nothing can collide with it.
describe('isWildcardReference', () => {
  it.each(['*', 'orders.*', 'customers.*'])('recognizes "%s"', (reference) => {
    expect(isWildcardReference(reference)).toBe(true);
  });

  it.each(['amount', 'orders.amount', 'orders.star'])('does not match "%s"', (reference) => {
    expect(isWildcardReference(reference)).toBe(false);
  });
});

describe('validateWildcardProjection', () => {
  const plain = (physical: string) => ({ physical, renamed: false });

  it('accepts a wildcard that is the entire projection', () => {
    expect(() => validateWildcardProjection([plain('orders.*')], 0)).not.toThrow();
  });

  it('accepts a projection with no wildcard at all', () => {
    expect(() =>
      validateWildcardProjection([plain('orders.id'), plain('customers.name')], 2),
    ).not.toThrow();
  });

  it('rejects a wildcard beside a named column (the silent last-wins overwrite)', () => {
    expect(() =>
      validateWildcardProjection([plain('orders.*'), plain('customers.name')], 0),
    ).toThrow(/Wildcard column reference "orders\.\*" cannot be combined/);
  });

  it('rejects two wildcards from different tables', () => {
    expect(() => validateWildcardProjection([plain('orders.*'), plain('customers.*')], 0)).toThrow(
      /cannot be combined with another projected column or an aggregation/,
    );
  });

  it('rejects a wildcard beside an aggregation (the expansion may contain its alias)', () => {
    expect(() => validateWildcardProjection([plain('orders.*')], 1)).toThrow(/cannot be combined/);
  });

  it('rejects a RENAMED wildcard ("orders.* AS x" is a syntax error on every dialect)', () => {
    expect(() => validateWildcardProjection([{ physical: 'orders.*', renamed: true }], 0)).toThrow(
      /Wildcard column reference "orders\.\*" cannot be renamed/,
    );
  });
});

/** Run `fn` and return the thrown Error's message (or a sentinel if it did not throw). */
function captureMessage(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return '<did not throw>';
}

/**
 * The mis-shaped-allowlist re-asserts on the two EXPORTED functions that check
 * membership with `Array.prototype.includes` (F10).
 *
 * `compileSecurityPolicy` validates the host's allowlists once, up front, on the
 * request path — and that call site is covered. But both functions below are
 * exported and reachable WITHOUT compiling a policy, which is the stated reason
 * the re-asserts exist, and deleting either one survived the whole suite.
 *
 * Handed a STRING instead of an array (the shape a host gets from
 * `schemaAllowlist: process.env.STUDIO_TABLES`), `.includes` becomes
 * `String.prototype.includes` — SUBSTRING matching. `'orders_public'.includes('orders')`
 * is `true`, so the allowlist fails OPEN and admits a table that was never listed.
 */
describe('exported allowlist checks fail closed on a mis-shaped allowlist (F10)', () => {
  it('assertTablesAllowed rejects a string schemaAllowlist instead of substring-matching it', () => {
    // Without the re-assert this call SUCCEEDS: `'orders_public'.includes('orders')`.
    expect(() => assertTablesAllowed(['orders'], 'orders_public' as never)).toThrow(
      /schemaAllowlist must be an array of strings/,
    );
    // A well-formed allowlist still rejects the same table on membership.
    expect(() => assertTablesAllowed(['orders'], ['orders_public'])).toThrow(
      /not in schema allowlist/,
    );
    expect(() => assertTablesAllowed(['orders'], ['orders'])).not.toThrow();
  });

  it('assertTablesAllowed rejects a non-string entry in the allowlist array', () => {
    expect(() => assertTablesAllowed(['orders'], ['orders', 42] as never)).toThrow(
      /every entry must be a string/,
    );
  });

  it('checkColumnAgainstAllowlist rejects a string columnAllowlist entry', () => {
    // Without the re-assert, `'id,status'.includes('id')` admits the column —
    // and `'orders.'` yields `column === ''`, which every string contains, so
    // the empty column name is admitted too.
    expect(() =>
      checkColumnAgainstAllowlist('id', 'orders', { orders: 'id,status' } as never, 'columns'),
    ).toThrow(/column allowlist entry for table "orders" must be an array of strings/);
    expect(() =>
      checkColumnAgainstAllowlist('orders.', 'orders', { orders: 'id,status' } as never, 'columns'),
    ).toThrow(/must be an array of strings/);
    // Correctly shaped: membership is what decides.
    expect(() =>
      checkColumnAgainstAllowlist('id', 'orders', { orders: ['id', 'status'] }, 'columns'),
    ).not.toThrow();
    expect(() =>
      checkColumnAgainstAllowlist('secret', 'orders', { orders: ['id', 'status'] }, 'columns'),
    ).toThrow(/not in the column allowlist/);
  });
});
