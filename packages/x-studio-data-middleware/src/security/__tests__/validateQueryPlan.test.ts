/**
 * Unit tests for `validateQueryPlan` — ALIAS-RESOLUTION + VALIDATION PARITY.
 *
 * Centralizing column-reference resolution into one compiled `ValidatedQueryPlan`
 * must NOT change what any reference resolves to, nor which inputs are rejected.
 * Each descriptor shape is compared, field-by-field, against calling the shared
 * `resolveAlias` directly (the pre-refactor resolution path), and each invalid
 * shape is compared against the shared validators (`validateHavingAliases` /
 * `validateAggregationAliases` / `validateDescriptorColumns`) — the exact
 * functions `validateQueryPlan` reuses, so error text can never drift.
 */
import { describe, it, expect } from 'vitest';
import Knex from 'knex';
import {
  AGGREGATE_SQL_FUNCTIONS,
  validateQueryPlan,
  isValidatedQueryPlan,
  toValidatedQueryPlan,
} from '../validateQueryPlan';
import {
  resolveAlias,
  validateAggregationAliases,
  validateDescriptorColumns,
  validateHavingAliases,
} from '../../shared/columnValidation';
import type { BatchWidgetDescriptor } from '../types';

// Representative descriptor matrix — every column-bearing clause, with and
// without `columnAliases`, plus expression-field renames and composite joins.
const DESCRIPTOR_MATRIX: { name: string; descriptor: BatchWidgetDescriptor }[] = [
  {
    name: 'bare table (no columns/filters/joins)',
    descriptor: { id: 'w1', table: 'sales' },
  },
  {
    name: 'columns + filters + orderBy, no aliases',
    descriptor: {
      id: 'w1',
      table: 'sales',
      columns: ['region', 'amount'],
      filters: [
        { column: 'status', operator: 'eq', value: 'active' },
        { column: 'amount', operator: 'gt', value: 0 },
      ],
      orderBy: [{ column: 'region', direction: 'asc' }],
      limit: 50,
    },
  },
  {
    name: 'expression-field aliases across columns/filters/orderBy',
    descriptor: {
      id: 'w1',
      table: 'sales',
      columnAliases: {
        revenue: 'amount',
        country: 'customers.country',
        customerSsn: 'ssn',
      },
      columns: ['revenue', 'country'],
      filters: [{ column: 'customerSsn', operator: 'eq', value: '1' }],
      orderBy: [{ column: 'country', direction: 'desc' }],
    },
  },
  {
    name: 'aggregations with a pure measure + a dimension, ordered by an agg alias',
    descriptor: {
      id: 'w1',
      table: 'sales',
      columns: ['region', 'amount'],
      aggregations: [
        { column: 'amount', func: 'sum', alias: 'amount' }, // pure measure (alias === column)
        { column: 'amount', func: 'avg', alias: 'avg_amount' },
      ],
      orderBy: [{ column: 'avg_amount', direction: 'desc' }],
    },
  },
  {
    name: 'composite-key join with aliases on both sides',
    descriptor: {
      id: 'w1',
      table: 'sales',
      columnAliases: {
        'sales.a_alias': 'sales.a',
        'customers.b_alias': 'customers.b',
      },
      columns: ['region'],
      joins: [
        {
          table: 'customers',
          type: 'left',
          on: [
            ['sales.a_alias', 'customers.a'],
            ['sales.b', 'customers.b_alias'],
          ],
        },
      ],
    },
  },
];

describe('validateQueryPlan — alias-resolution parity', () => {
  for (const { name, descriptor } of DESCRIPTOR_MATRIX) {
    describe(`descriptor: ${name}`, () => {
      const plan = validateQueryPlan(descriptor);

      it('resolves projection columns identically to resolveAlias', () => {
        expect(plan.columns.map((c) => c.physical)).toEqual(
          (descriptor.columns ?? []).map((c) => resolveAlias(descriptor, c)),
        );
        // outputAlias is set for EXACTLY the references resolution renamed, and
        // holds the original (pre-resolution) logical id.
        const renamed = (descriptor.columns ?? []).filter((c) => resolveAlias(descriptor, c) !== c);
        expect(
          plan.columns.filter((c) => c.outputAlias !== undefined).map((c) => c.outputAlias),
        ).toEqual(renamed);
      });

      it('resolves filter columns identically to resolveAlias', () => {
        expect(plan.filters.map((f) => f.column)).toEqual(
          (descriptor.filters ?? []).map((f) => resolveAlias(descriptor, f.column)),
        );
        // Operator + value are carried through untouched.
        expect(plan.filters.map(({ operator, value }) => ({ operator, value }))).toEqual(
          (descriptor.filters ?? []).map(({ operator, value }) => ({ operator, value })),
        );
      });

      it('resolves both sides of every join.on pair identically to resolveAlias', () => {
        expect(plan.joins.map((j) => j.on)).toEqual(
          (descriptor.joins ?? []).map((j) =>
            j.on.map(([l, r]) => [resolveAlias(descriptor, l), resolveAlias(descriptor, r)]),
          ),
        );
        expect(plan.joins.map((j) => ({ table: j.table, type: j.type }))).toEqual(
          (descriptor.joins ?? []).map((j) => ({ table: j.table, type: j.type })),
        );
      });

      it('resolves aggregation columns identically and carries func/alias unchanged', () => {
        expect(plan.aggregations.map((a) => a.physical)).toEqual(
          (descriptor.aggregations ?? []).map((a) => resolveAlias(descriptor, a.column)),
        );
        expect(plan.aggregations.map(({ func, alias }) => ({ func, alias }))).toEqual(
          (descriptor.aggregations ?? []).map(({ func, alias }) => ({ func, alias })),
        );
        // No derived "pure measure" flag any more (F1): whether an aggregated
        // column also belongs in GROUP BY is decided by membership in
        // `aggregations`, not by how the alias happens to be spelled.
        for (const agg of plan.aggregations) {
          expect(agg).not.toHaveProperty('pureMeasure');
        }
      });

      it('splits orderBy into agg-alias vs. resolved physical column identically', () => {
        // Independently reconstruct the split from `resolveAlias` and compare the
        // whole array — an aggregation-alias target stays the alias (never a
        // physical column); any other target is the resolved physical column.
        const aggAliases = new Set((descriptor.aggregations ?? []).map((a) => a.alias));
        const expected = (descriptor.orderBy ?? []).map((ob) =>
          aggAliases.has(ob.column)
            ? { direction: ob.direction, aggAlias: ob.column }
            : { direction: ob.direction, physical: resolveAlias(descriptor, ob.column) },
        );
        expect(plan.orderBy).toEqual(expected);
      });

      it('carries table/having/limit through unchanged', () => {
        expect(plan.table).toBe(descriptor.table);
        expect(plan.having).toEqual(descriptor.having ?? []);
        expect(plan.limit).toBe(descriptor.limit);
      });

      it('carries NO columnAliases field and no raw logical names', () => {
        // The ambiguous client form is structurally unreachable past this boundary.
        expect(plan).not.toHaveProperty('columnAliases');
        for (const c of plan.columns) {
          expect(resolveAlias(descriptor, c.physical)).toBe(c.physical);
        }
      });
    });
  }
});

describe('validateQueryPlan — validation parity (reuses the shared validators)', () => {
  it('throws the same error as validateHavingAliases for an undeclared HAVING alias', () => {
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'sales',
      aggregations: [{ column: 'amount', func: 'sum', alias: 'total' }],
      having: [{ alias: 'nope', operator: 'gt', value: 1 }],
    };
    const direct = captureThrow(() => validateHavingAliases(descriptor));
    const viaPlan = captureThrow(() => validateQueryPlan(descriptor));
    expect(viaPlan).toBe(direct);
    expect(viaPlan).toMatch(/does not match any aggregation alias/);
  });

  it('throws the same error as validateHavingAliases when HAVING has no aggregations', () => {
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'sales',
      having: [{ alias: 'total', operator: 'gt', value: 1 }],
    };
    expect(captureThrow(() => validateQueryPlan(descriptor))).toBe(
      captureThrow(() => validateHavingAliases(descriptor)),
    );
  });

  it('throws the same error as validateAggregationAliases for an unsafe alias', () => {
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'sales',
      aggregations: [{ column: 'amount', func: 'sum', alias: 'total; DROP TABLE sales' }],
    };
    const direct = captureThrow(() => validateAggregationAliases(descriptor));
    const viaPlan = captureThrow(() => validateQueryPlan(descriptor));
    expect(viaPlan).toBe(direct);
    expect(viaPlan).toMatch(/contains characters outside the allowed set/);
  });

  it('rejects a duplicate aggregation alias (finding 3.4)', () => {
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'sales',
      aggregations: [
        { column: 'amount', func: 'sum', alias: 'total' },
        { column: 'amount', func: 'avg', alias: 'total' },
      ],
    };
    expect(() => validateQueryPlan(descriptor)).toThrow(/Duplicate aggregation alias/);
  });

  it('rejects an aggregation alias colliding with a projection output alias (finding 3.4)', () => {
    // `revenue` is a renamed expression-field projection (output alias) AND an
    // aggregation alias — both SELECT-ed under the same result-row key. The
    // aggregation targets a DIFFERENT physical column, so `revenue` really is a
    // GROUP BY dimension and really does collide (F1: were it the same column,
    // the dimension would not be projected at all and there would be no collision
    // — pinned by 'accepts a projected expression field aggregated under its own
    // logical id' below).
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'sales',
      columnAliases: { revenue: 'gross_amount' },
      columns: ['revenue'],
      aggregations: [{ column: 'amount', func: 'sum', alias: 'revenue' }],
    };
    expect(() => validateQueryPlan(descriptor)).toThrow(/collides with a projected column/);
  });

  it('rejects an aggregation alias colliding with a DIRECT projected dimension column (finding 2.1)', () => {
    // `category` is BOTH a direct projected dimension (SELECT-ed as `orders.category`
    // → row key `category`) AND the aggregation's output alias — the two SELECT
    // outputs collapse onto one `category` key, last-wins, silently dropping a field.
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'orders',
      columns: ['category'],
      aggregations: [{ column: 'revenue', func: 'sum', alias: 'category' }],
    };
    expect(() => validateQueryPlan(descriptor)).toThrow(/collides with a projected column/);
  });

  it('rejects the collision even when the projected dimension is table-qualified (finding 2.1)', () => {
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'orders',
      columns: ['orders.category'],
      aggregations: [{ column: 'revenue', func: 'sum', alias: 'category' }],
    };
    expect(() => validateQueryPlan(descriptor)).toThrow(/collides with a projected column/);
  });

  it('does NOT flag a pure measure whose alias equals its own projected column key (finding 2.1)', () => {
    // `SUM(amount) AS amount` projected alongside `amount` is the legitimate
    // pure-measure shape: the `amount` column goes ONLY into the aggregate clause,
    // never a separate SELECT dimension, so there is no real key collision.
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'sales',
      columns: ['region', 'amount'],
      aggregations: [{ column: 'amount', func: 'sum', alias: 'amount' }],
    };
    expect(() => validateQueryPlan(descriptor)).not.toThrow();
  });

  it('rejects two directly-projected columns from different tables whose result key collides (Tier3, iter24 finding)', () => {
    // `orders.category` and `customers.category` both key as `category` on the
    // result row — one silently overwrites the other. Unlike the agg-vs-
    // projection collisions above, this is a projection-vs-projection collision
    // with no aggregation involved at all.
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'orders',
      columns: ['orders.category', 'customers.category'],
      joins: [{ table: 'customers', on: [['orders.customer_id', 'customers.id']] }],
    };
    expect(() => validateQueryPlan(descriptor)).toThrow(
      /Two projected columns collide on the result-row key "category"/,
    );
  });

  it('rejects two renamed (output-alias) projected columns sharing the same logical id (Tier3, iter24 finding)', () => {
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'sales',
      columnAliases: { total: 'gross_amount' },
      columns: ['total', 'total'],
    };
    expect(() => validateQueryPlan(descriptor)).toThrow(
      /Two projected columns collide on the result-row key "total"/,
    );
  });

  it('does NOT flag two distinct projected columns with different result keys (Tier3, iter24 finding)', () => {
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'orders',
      columns: ['orders.category', 'customers.name'],
      joins: [{ table: 'customers', on: [['orders.customer_id', 'customers.id']] }],
    };
    expect(() => validateQueryPlan(descriptor)).not.toThrow();
  });

  it('resolves a table-qualified aggregation column (finding 2.2)', () => {
    // `SUM(orders.amount) AS amount` aggregates a QUALIFIED column; the plan must
    // carry the resolved physical so `execute.ts` can match it against the
    // projection (whose entry may be written unqualified) and keep it out of
    // GROUP BY. The grain behavior itself is pinned in `router/__tests__/execute.test.ts`.
    const plan = validateQueryPlan({
      id: 'w1',
      table: 'orders',
      columns: ['orders.amount', 'customers.region'],
      joins: [{ table: 'customers', type: 'left', on: [['orders.customer_id', 'customers.id']] }],
      aggregations: [{ column: 'orders.amount', func: 'sum', alias: 'amount' }],
    });
    const amountAgg = plan.aggregations.find((a) => a.alias === 'amount');
    expect(amountAgg?.physical).toBe('orders.amount');
  });

  // Regression (F1, mirror half): the alias-NAME heuristic ALSO failed closed.
  // When a projected expression field is aggregated under its OWN logical id, the
  // aggregated column contributes no separate projection key — `execute.ts`
  // projects it inside the aggregate clause only — so there is nothing for the
  // alias to collide with. The pre-fix `resultKeyOf(physical)` test compared the
  // alias against the PHYSICAL column's last segment (`amount`), decided this was
  // not a measure, left `expr-1` in the projection-key list and hard-rejected the
  // widget with "Aggregation alias "expr-1" collides with a projected column."
  it('accepts a projected expression field aggregated under its own logical id (F1)', () => {
    expect(() =>
      validateQueryPlan({
        id: 'w1',
        table: 'orders',
        columns: ['category', 'expr-1'],
        columnAliases: { 'expr-1': 'orders.amount' },
        aggregations: [{ column: 'expr-1', func: 'sum', alias: 'expr-1' }],
      }),
    ).not.toThrow();
  });

  // Regression (F4): `orderColumnOf` qualifies any non-alias ORDER BY target with
  // no check against the GROUP BY dimensions, so an aggregation widget could sort
  // by a column that is neither. SQLite ACCEPTS
  // `… group by "orders"."category" order by "orders"."created_at" desc` and
  // sorts each group by an ARBITRARY member row's value — nondeterministic order
  // presented as sorted data; PostgreSQL raises 42803 and MySQL (default
  // ONLY_FULL_GROUP_BY) raises ER_MIX_OF_GROUP_FUNC_AND_FIELDS, both then masked
  // by `sanitizeBoundaryError` into the generic per-widget error.
  it('rejects an ORDER BY that is neither a dimension nor an aggregation alias (F4)', () => {
    expect(() =>
      validateQueryPlan({
        id: 'w1',
        table: 'orders',
        columns: ['category'],
        aggregations: [{ column: 'amount', func: 'sum', alias: 'total' }],
        orderBy: [{ column: 'created_at', direction: 'desc' }],
      }),
    ).toThrow(
      /ORDER BY column "created_at" is neither a GROUP BY dimension nor an aggregation alias/,
    );
  });

  it('rejects an ORDER BY on the MEASURE column of an aggregation widget (F4)', () => {
    // `amount` is projected, but it is aggregated — so it is a measure, not a
    // GROUP BY dimension (F1), and sorting by it has the same problem.
    expect(() =>
      validateQueryPlan({
        id: 'w1',
        table: 'orders',
        columns: ['category', 'amount'],
        aggregations: [{ column: 'amount', func: 'sum', alias: 'total' }],
        orderBy: [{ column: 'amount', direction: 'desc' }],
      }),
    ).toThrow(/ORDER BY column "amount" is neither a GROUP BY dimension nor an aggregation alias/);
  });

  it.each([
    ['a projected dimension', 'category'],
    ['an aggregation alias', 'total'],
  ])('accepts an ORDER BY on %s (F4)', (_label, column) => {
    expect(() =>
      validateQueryPlan({
        id: 'w1',
        table: 'orders',
        columns: ['category'],
        aggregations: [{ column: 'amount', func: 'sum', alias: 'total' }],
        orderBy: [{ column, direction: 'asc' }],
      }),
    ).not.toThrow();
  });

  it('accepts a qualified/unqualified mismatch between the dimension and the ORDER BY (F4)', () => {
    // The dimension is written qualified and the ORDER BY unqualified (or the
    // reverse): both address the same column, so the check compares
    // primary-table-qualified physicals, exactly as the GROUP BY split does.
    expect(() =>
      validateQueryPlan({
        id: 'w1',
        table: 'orders',
        columns: ['orders.category'],
        aggregations: [{ column: 'amount', func: 'sum', alias: 'total' }],
        orderBy: [{ column: 'category', direction: 'asc' }],
      }),
    ).not.toThrow();
  });

  it('leaves ORDER BY unconstrained for a NON-aggregation descriptor (F4)', () => {
    // Without a GROUP BY there is no grain to violate — every row has its own
    // value for any column, so any orderable column stays legal.
    expect(() =>
      validateQueryPlan({
        id: 'w1',
        table: 'orders',
        columns: ['category'],
        orderBy: [{ column: 'created_at', direction: 'desc' }],
      }),
    ).not.toThrow();
  });

  // Regression (F3): `validateWildcardProjection` runs over `descriptor.columns`
  // ONLY, so a wildcard hidden in `aggregations[].column` reached `execute.ts`'s
  // `qualify()` and emitted `count("orders".*)` — a syntax error on SQLite
  // (`near "*": syntax error`) and MySQL, and on PostgreSQL a valid
  // composite-type argument answering a different question than the one asked.
  // On the rejecting engines `sanitizeBoundaryError` masked it into the generic
  // per-widget error. Only a CONCRETE `columnAllowlist` rejected it; a
  // `schemaAllowlist`-only deployment and `columnAllowlist: { orders: ['*'] }`
  // both accepted it.
  it.each(['*', 'orders.*'])(
    'rejects a wildcard aggregation column %j with no columnAllowlist (F3)',
    (column) => {
      expect(() =>
        validateQueryPlan({
          id: 'w1',
          table: 'orders',
          aggregations: [{ column, func: 'count', alias: 'n' }],
        }),
      ).toThrow(/Aggregation column .* is a wildcard/);
    },
  );

  it('rejects a wildcard aggregation column under the ["*"] allowlist opt-out (F3)', () => {
    expect(() =>
      validateQueryPlan(
        {
          id: 'w1',
          table: 'orders',
          aggregations: [{ column: '*', func: 'count', alias: 'n' }],
        },
        { orders: ['*'] },
      ),
    ).toThrow(/Aggregation column .* is a wildcard/);
  });

  it('rejects a wildcard aggregation column reached through columnAliases (F3)', () => {
    expect(() =>
      validateQueryPlan({
        id: 'w1',
        table: 'orders',
        columnAliases: { everything: 'orders.*' },
        aggregations: [{ column: 'everything', func: 'count', alias: 'n' }],
      }),
    ).toThrow(/Aggregation column .* is a wildcard/);
  });

  it('still accepts an aggregation on a concrete column (F3)', () => {
    expect(() =>
      validateQueryPlan({
        id: 'w1',
        table: 'orders',
        columns: ['category'],
        aggregations: [{ column: 'id', func: 'count', alias: 'n' }],
      }),
    ).not.toThrow();
  });

  // Regression (F1): an aggregated column contributes NO projection key, so an
  // alias naming a DIFFERENT projected column must still be rejected — the
  // exclusion must be scoped to the aggregated column itself.
  it('still rejects an alias colliding with a non-aggregated projected column (F1)', () => {
    expect(() =>
      validateQueryPlan({
        id: 'w1',
        table: 'orders',
        columns: ['category', 'amount'],
        aggregations: [{ column: 'amount', func: 'sum', alias: 'category' }],
      }),
    ).toThrow(/Aggregation alias "category" collides with a projected column/);
  });

  // Regression for finding 3.4: an expression-field OUTPUT alias used to reach
  // `execute.ts`'s `db.raw('?? as ??', [physical, outputAlias])` with no charset
  // check at all — unlike its sibling `agg.alias`, which `validateAggregationAliases`
  // already constrains. Both are `??`-bound (Knex-escaped either way), so this is
  // defense-in-depth, not a live injection, but the output alias was the one
  // client-controlled identifier token that skipped the allowlist pattern.
  it('rejects an unsafe expression-field output alias (finding 3.4)', () => {
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'sales',
      columnAliases: { 'revenue; DROP TABLE sales': 'amount' },
      columns: ['revenue; DROP TABLE sales'],
    };
    expect(() => validateQueryPlan(descriptor)).toThrow(
      /Output alias .* contains characters outside the allowed set/,
    );
  });

  it('accepts a safe expression-field output alias (letters/digits/underscore)', () => {
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'sales',
      columnAliases: { total_revenue_2024: 'amount' },
      columns: ['total_revenue_2024'],
    };
    expect(() => validateQueryPlan(descriptor)).not.toThrow();
  });

  // finding 1.1 — the real x-studio client mints expression-field logical IDs as
  // `expr-<timestamp>-<counter>` (hyphenated) and sends them verbatim in `columns`
  // with a `columnAliases` entry pointing at a DIFFERENT physical column, so the
  // hyphenated id becomes an interpolated `?? as ??` output alias. A hyphen-free
  // charset rejected EVERY join expression-field widget; the hyphen is now allowed.
  it('accepts a hyphenated expression-field output alias (real expr-… logical id)', () => {
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'sales',
      columnAliases: { 'expr-order-country': 'customers.country' },
      columns: ['expr-order-country'],
    };
    expect(() => validateQueryPlan(descriptor)).not.toThrow();
  });

  it('does NOT validate a direct (non-renamed) column reference as an alias', () => {
    // A column with no `columnAliases` entry resolves to itself — `buildPlan`
    // never gives it an `outputAlias`, so it must not be charset-checked even if
    // it contains characters the alias pattern would reject (e.g. it is qualified
    // with a dot, which is a legitimate physical column reference, not an alias).
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'sales',
      columns: ['customers.region'],
    };
    expect(() => validateQueryPlan(descriptor)).not.toThrow();
  });

  it('runs the output-alias check even without a columnAllowlist (unconditional)', () => {
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'sales',
      columnAliases: { 'bad alias': 'amount' },
      columns: ['bad alias'],
    };
    expect(() => validateQueryPlan(descriptor)).toThrow(
      /contains characters outside the allowed set/,
    );
  });

  it('throws the same error as validateDescriptorColumns for an unlisted table (fail-closed)', () => {
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'sales',
      columns: ['region'],
    };
    const allowlist = { orders: ['id'] };
    const direct = captureThrow(() => validateDescriptorColumns(descriptor, allowlist));
    const viaPlan = captureThrow(() => validateQueryPlan(descriptor, allowlist));
    expect(viaPlan).toBe(direct);
    expect(viaPlan).toMatch(/Table "sales" has no entry in the column allowlist/);
  });

  it('throws the same error as validateDescriptorColumns for a columnAliases target outside the allowlist', () => {
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'sales',
      columns: ['revenue'],
      columnAliases: { revenue: 'ssn' },
    };
    const allowlist = { sales: ['revenue', 'region'] };
    const direct = captureThrow(() => validateDescriptorColumns(descriptor, allowlist));
    const viaPlan = captureThrow(() => validateQueryPlan(descriptor, allowlist));
    expect(viaPlan).toBe(direct);
    expect(viaPlan).toMatch(/is not in the column allowlist/);
  });

  it('does NOT run the column allowlist check when no allowlist is supplied', () => {
    // A descriptor referencing an unlisted column resolves fine with no allowlist.
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'sales',
      columns: ['anything'],
    };
    expect(() => validateQueryPlan(descriptor)).not.toThrow();
  });

  it('runs the HAVING/aggregation validators even without a columnAllowlist', () => {
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'sales',
      aggregations: [{ column: 'amount', func: 'sum', alias: 'total' }],
      having: [{ alias: 'nope', operator: 'gt', value: 1 }],
    };
    expect(() => validateQueryPlan(descriptor)).toThrow(/does not match any aggregation alias/);
  });
});

describe('toValidatedQueryPlan / isValidatedQueryPlan — dual acceptance', () => {
  const descriptor: BatchWidgetDescriptor = {
    id: 'w1',
    table: 'sales',
    columnAliases: { revenue: 'amount' },
    columns: ['revenue'],
  };

  it('returns an already-compiled plan as-is (no re-resolution)', () => {
    const plan = validateQueryPlan(descriptor);
    expect(isValidatedQueryPlan(plan)).toBe(true);
    expect(toValidatedQueryPlan(plan)).toBe(plan);
  });

  it('resolves a raw descriptor into a plan on the spot', () => {
    const coerced = toValidatedQueryPlan(descriptor);
    expect(isValidatedQueryPlan(coerced)).toBe(true);
    expect(coerced.columns).toEqual([{ physical: 'amount', outputAlias: 'revenue' }]);
  });

  it('the descriptor branch does NOT run the validators (behavior-preserving for direct callers)', () => {
    // An unsafe aggregation alias would throw through validateQueryPlan, but the
    // coercion path used by direct buildSecureQuery/executeForTier callers only
    // resolves — it must not add a throw those callers never had.
    const unsafe: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'sales',
      aggregations: [{ column: 'amount', func: 'sum', alias: 'total; DROP TABLE sales' }],
    };
    expect(() => toValidatedQueryPlan(unsafe)).not.toThrow();
  });

  it('isValidatedQueryPlan rejects a plain descriptor and non-objects', () => {
    expect(isValidatedQueryPlan(descriptor)).toBe(false);
    expect(isValidatedQueryPlan(null)).toBe(false);
    expect(isValidatedQueryPlan(undefined)).toBe(false);
    expect(isValidatedQueryPlan('sales')).toBe(false);
  });
});

describe('validateQueryPlan — SELECT * allowlist-bypass synthesis (finding 1.1)', () => {
  it('synthesizes an explicit projection from the allowlist when a no-columns widget has an entry', () => {
    const descriptor: BatchWidgetDescriptor = { id: 'w1', table: 'sales' };
    const plan = validateQueryPlan(descriptor, { sales: ['region', 'amount'] });
    // Exactly the allowlisted columns, in allowlist order, as direct physical
    // columns (no outputAlias) — so Knex projects them instead of SELECT *.
    expect(plan.columns).toEqual([{ physical: 'region' }, { physical: 'amount' }]);
  });

  it('also synthesizes when columns is an explicit empty array', () => {
    const descriptor: BatchWidgetDescriptor = { id: 'w1', table: 'sales', columns: [] };
    const plan = validateQueryPlan(descriptor, { sales: ['region'] });
    expect(plan.columns).toEqual([{ physical: 'region' }]);
  });

  it('synthesizes a PRIMARY-TABLE-qualified wildcard for a ["*"] entry (opt-out, not a bare SELECT *)', () => {
    // `['*']` means "all columns of THIS table" → `sales.*`, NOT a bare `*`. A
    // bare `*` (empty projection) would leak every column of every JOINed table,
    // bypassing that table's own allowlist (the Tier 1 finding). Qualifying the
    // wildcard keeps the single-table SELECT * opt-out intact.
    const descriptor: BatchWidgetDescriptor = { id: 'w1', table: 'sales' };
    const plan = validateQueryPlan(descriptor, { sales: ['*'] });
    expect(plan.columns).toEqual([{ physical: 'sales.*' }]);
  });

  it('scopes the ["*"] wildcard to the primary table when the widget JOINs another table (finding 1.1)', () => {
    // The exact bypass shape from the review: primary `orders: ['*']`, joined
    // `customers: ['id']`, no explicit columns. Before the fix the projection was
    // empty → bare SELECT * → every `customers` column leaked. Now the projection
    // is `orders.*`, so joined columns are NOT projected implicitly.
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'orders',
      joins: [
        {
          table: 'customers',
          type: 'left',
          on: [['orders.customer_id', 'customers.id']],
        },
      ],
    };
    const plan = validateQueryPlan(descriptor, { orders: ['*'], customers: ['id'] });
    expect(plan.columns).toEqual([{ physical: 'orders.*' }]);
    // Crucially: no `customers.*` and no unlisted `customers` column is synthesized.
    expect(plan.columns.some((c) => c.physical.startsWith('customers'))).toBe(false);
  });

  it('rejects fail-closed when a no-columns widget has no allowlist entry for its table', () => {
    const descriptor: BatchWidgetDescriptor = { id: 'w1', table: 'sales' };
    expect(() => validateQueryPlan(descriptor, { orders: ['id'] })).toThrow(
      /Table "sales" has no entry in the column allowlist/,
    );
  });

  it('does NOT synthesize when aggregations are present (db tier emits no SELECT *)', () => {
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'sales',
      aggregations: [{ column: 'amount', func: 'sum', alias: 'total' }],
    };
    const plan = validateQueryPlan(descriptor, { sales: ['region', 'amount'] });
    // Global aggregation keeps its single-summary-row shape — no dimension columns.
    expect(plan.columns).toEqual([]);
  });

  it('does NOT synthesize when no allowlist is supplied (SELECT * preserved)', () => {
    const descriptor: BatchWidgetDescriptor = { id: 'w1', table: 'sales' };
    const plan = validateQueryPlan(descriptor);
    expect(plan.columns).toEqual([]);
  });

  // Regression for finding 2.4: `columnAllowlist[table]` used to be a bare
  // bracket lookup on a plain object, inheriting from `Object.prototype`. A
  // widget whose table happens to name an inherited member would read a truthy
  // inherited value and SKIP the fail-closed "has no entry" throw below, then
  // crash on `.includes(...)`. The own-property gate must still fail closed.
  it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__'])(
    'still fails closed for a primary table named "%s" with no OWN allowlist entry',
    (table) => {
      const descriptor: BatchWidgetDescriptor = { id: 'w1', table };
      expect(() => validateQueryPlan(descriptor, { sales: ['id'] })).toThrow(
        /has no entry in the column allowlist/,
      );
    },
  );
});

describe('validateQueryPlan — ORDER BY direction allowlist (finding 1.3)', () => {
  it('accepts asc/desc case-insensitively and normalizes to lowercase', () => {
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'sales',
      columns: ['region', 'amount'],
      orderBy: [
        { column: 'region', direction: 'ASC' as any },
        { column: 'amount', direction: 'DESC' as any },
      ],
    };
    const plan = validateQueryPlan(descriptor);
    expect(plan.orderBy.map((ob) => ob.direction)).toEqual(['asc', 'desc']);
  });

  it('throws for a non-asc/desc direction string', () => {
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'sales',
      orderBy: [{ column: 'region', direction: 'asc; drop table sales' as any }],
    };
    expect(() => validateQueryPlan(descriptor)).toThrow(/ORDER BY direction/);
  });

  it('throws for a non-string direction (type is not a runtime guarantee)', () => {
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'sales',
      orderBy: [{ column: 'region', direction: 1 as any }],
    };
    expect(() => validateQueryPlan(descriptor)).toThrow(/ORDER BY direction/);
  });

  it('toValidatedQueryPlan on a raw descriptor with a bad direction does NOT throw', () => {
    // The direct-caller coercion path deliberately skips the validators, matching
    // the pinned unsafe-alias behavior — it only resolves + normalizes.
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'sales',
      orderBy: [{ column: 'region', direction: 'sideways' as any }],
    };
    expect(() => toValidatedQueryPlan(descriptor)).not.toThrow();
  });
});

describe('validateQueryPlan — JOIN type allowlist (finding 2.3)', () => {
  const joinDescriptor = (type: unknown): BatchWidgetDescriptor => ({
    id: 'w1',
    table: 'sales',
    joins: [{ table: 'customers', type: type as any, on: [['sales.customer_id', 'customers.id']] }],
  });

  it('accepts an omitted join type (defaults to inner)', () => {
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'sales',
      joins: [{ table: 'customers', on: [['sales.customer_id', 'customers.id']] }],
    };
    const plan = validateQueryPlan(descriptor);
    expect(plan.joins[0].type).toBeUndefined();
  });

  it('accepts inner/left/right case-insensitively and normalizes to lowercase', () => {
    expect(validateQueryPlan(joinDescriptor('INNER')).joins[0].type).toBe('inner');
    expect(validateQueryPlan(joinDescriptor('Left')).joins[0].type).toBe('left');
    expect(validateQueryPlan(joinDescriptor('RIGHT')).joins[0].type).toBe('right');
  });

  it('does NOT mutate the caller descriptor, but canonicalizes the type on the plan (finding T3.4)', () => {
    // `buildSecureQuery` matches `join.type === 'left'` / `=== 'right'` exactly, so the
    // canonical lowercase type must reach it — but via the PLAN, not by mutating the
    // host-owned descriptor. The descriptor keeps its original casing; the plan is
    // lowercased.
    const descriptor = joinDescriptor('LEFT');
    const plan = validateQueryPlan(descriptor);
    expect(descriptor.joins![0].type).toBe('LEFT');
    expect(plan.joins[0].type).toBe('left');
  });

  it('throws for an unrecognized join type (full/cross/typo)', () => {
    for (const bad of ['full', 'cross', 'outer', 'joinx']) {
      expect(() => validateQueryPlan(joinDescriptor(bad))).toThrow(/JOIN type/);
    }
  });

  it('throws for a non-string join type (type is not a runtime guarantee)', () => {
    expect(() => validateQueryPlan(joinDescriptor(1))).toThrow(/JOIN type/);
    expect(() => validateQueryPlan(joinDescriptor({}))).toThrow(/JOIN type/);
  });

  it('toValidatedQueryPlan on a raw descriptor with a bad join type does NOT throw', () => {
    // The direct-caller coercion path skips the validators; it only resolves +
    // normalizes (case-folds), matching the ORDER BY-direction behavior.
    expect(() => toValidatedQueryPlan(joinDescriptor('full'))).not.toThrow();
    // A case-varying-but-valid type still normalizes on the coercion path.
    expect(toValidatedQueryPlan(joinDescriptor('LEFT')).joins[0].type).toBe('left');
  });
});

describe('validateQueryPlan — JOIN "on" must be non-empty (finding 2.1)', () => {
  it('accepts a join with at least one "on" pair', () => {
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'sales',
      joins: [{ table: 'customers', on: [['sales.customer_id', 'customers.id']] }],
    };
    expect(() => validateQueryPlan(descriptor)).not.toThrow();
  });

  it('throws for a join with an empty "on" array', () => {
    // An empty `on` emits NO `.on()` conditions in `buildSecureQuery`'s join
    // callback — Postgres rejects the resulting condition-less join as a syntax
    // error, but MySQL silently accepts it as a valid CROSS JOIN, returning a
    // tenant-bounded cartesian product instead of failing.
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'sales',
      joins: [{ table: 'customers', on: [] }],
    };
    expect(() => validateQueryPlan(descriptor)).toThrow(/no "on" conditions/i);
  });

  it('throws for a join with a missing "on" (not a runtime guarantee)', () => {
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'sales',
      joins: [{ table: 'customers' } as any],
    };
    expect(() => validateQueryPlan(descriptor)).toThrow(/no "on" conditions/i);
  });

  it('throws for a join whose "on" is not an array', () => {
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'sales',
      joins: [{ table: 'customers', on: 'not-an-array' as any }],
    };
    expect(() => validateQueryPlan(descriptor)).toThrow(/no "on" conditions/i);
  });

  it('rejects the empty-on join even when other joins on the same widget are well-formed', () => {
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'sales',
      joins: [
        { table: 'customers', on: [['sales.customer_id', 'customers.id']] },
        { table: 'regions', on: [] },
      ],
    };
    expect(() => validateQueryPlan(descriptor)).toThrow(/no "on" conditions/i);
  });

  it('a real-Knex render of the pre-fix shape (bypassing validation) demonstrates the CROSS JOIN risk this closes', () => {
    // Documents WHY the guard exists: rendering the query builder's join
    // callback directly (as `buildSecureQuery` would, absent this validator)
    // with zero `.on()` calls produces a condition-less join. This test never
    // calls `buildSecureQuery`/reaches query construction for a real widget —
    // `validateQueryPlan` above proves that path is unreachable — it only pins
    // what the raw Knex shape looks like when no `.on()` is ever added.
    const realDb = Knex({ client: 'pg' });
    const query = realDb('sales').join('customers', function joinOn(this: any) {
      // Deliberately no `this.on(...)` calls — the shape an empty `on: []`
      // would have produced pre-fix.
      void this;
    });
    expect(query.toString()).toBe('select * from "sales" inner join "customers"');
  });
});

describe('validateQueryPlan — tautological/self-referential JOIN "on" pairs (Tier3 iter26 finding 2)', () => {
  it('accepts a normal join whose "on" pair references the primary table and the joined table', () => {
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'orders',
      joins: [{ table: 'customers', on: [['orders.customer_id', 'customers.id']] }],
    };
    expect(() => validateQueryPlan(descriptor)).not.toThrow();
  });

  it('rejects an "on" pair where BOTH sides are qualified with the SAME (joined) table', () => {
    // The literal finding example: `customers.id = customers.id` passes the
    // schema allowlist (both are real columns on a real, allowlisted table) and
    // would pass a column allowlist too (both are legitimate columns), but is a
    // tautological condition that some engines execute as an unconditional
    // match — a cartesian product within the tenant-scoped rows.
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'orders',
      joins: [{ table: 'customers', on: [['customers.id', 'customers.id']] }],
    };
    expect(() => validateQueryPlan(descriptor)).toThrow(/tautological/i);
  });

  it('rejects an "on" pair whose left side is qualified with the joined table (not the primary or an earlier join)', () => {
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'orders',
      joins: [{ table: 'customers', on: [['customers.region_id', 'customers.id']] }],
    };
    expect(() => validateQueryPlan(descriptor)).toThrow(/neither the primary table/i);
  });

  it('rejects an "on" pair whose right side is qualified with a table other than the one being joined', () => {
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'orders',
      joins: [{ table: 'customers', on: [['orders.customer_id', 'orders.id']] }],
    };
    expect(() => validateQueryPlan(descriptor)).toThrow(/right-hand column/i);
  });

  it('accepts a left side qualified with a table joined EARLIER in a multi-join descriptor', () => {
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'orders',
      joins: [
        { table: 'customers', on: [['orders.customer_id', 'customers.id']] },
        { table: 'regions', on: [['customers.region_id', 'regions.id']] },
      ],
    };
    expect(() => validateQueryPlan(descriptor)).not.toThrow();
  });

  it('rejects a left side qualified with a table joined LATER (not yet available) in a multi-join descriptor', () => {
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'orders',
      joins: [
        { table: 'customers', on: [['regions.id', 'customers.region_id']] },
        { table: 'regions', on: [['customers.region_id', 'regions.id']] },
      ],
    };
    expect(() => validateQueryPlan(descriptor)).toThrow(/neither the primary table/i);
  });

  it('resolves a logical/expression-field alias before checking the table-qualification convention', () => {
    // A left side that is an unresolved logical id passing through `columnAliases`
    // to a qualified physical column on `join.table` itself must still be caught.
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'orders',
      columnAliases: { 'expr-self-ref': 'customers.id' },
      joins: [{ table: 'customers', on: [['expr-self-ref', 'customers.id']] }],
    };
    expect(() => validateQueryPlan(descriptor)).toThrow(/neither the primary table/i);
  });

  it('leaves an unqualified "on" pair unconstrained (Knex auto-qualifies left/right at build time)', () => {
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'orders',
      joins: [{ table: 'customers', on: [['customer_id', 'id']] }],
    };
    expect(() => validateQueryPlan(descriptor)).not.toThrow();
  });
});

// ── Wildcard / implicit projections are always single-table ───────────────────
//
// `resultKeyOf` maps `orders.*` to the literal `"*"`, a key no row carries, so
// the projection-collision guard was blind to a wildcard sharing the projection
// with anything else. And a widget with NO `columns` at all made `execute.ts`
// skip `.select()` entirely — a bare `SELECT *` that, under a join, folds every
// column of every joined table into one row object (same-named columns collapse
// last-wins). Both are now resolved into an explicit, single-table projection.
describe('validateQueryPlan — wildcard and implicit projections', () => {
  it('rejects a wildcard projected alongside a named column', () => {
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'orders',
      columns: ['orders.*', 'customers.name'],
    };
    expect(() => validateQueryPlan(descriptor)).toThrow(/cannot be combined/);
  });

  it('rejects a wildcard projected alongside an aggregation', () => {
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'orders',
      columns: ['orders.*'],
      aggregations: [{ column: 'amount', func: 'sum', alias: 'total' }],
    };
    expect(() => validateQueryPlan(descriptor)).toThrow(/cannot be combined/);
  });

  it('keeps a sole wildcard as the whole projection', () => {
    const plan = validateQueryPlan({ id: 'w1', table: 'orders', columns: ['orders.*'] });
    expect(plan.columns).toEqual([{ physical: 'orders.*' }]);
  });

  it('anchors an implicit projection to the primary table when the widget joins', () => {
    const plan = validateQueryPlan({
      id: 'w1',
      table: 'orders',
      joins: [{ table: 'customers', on: [['orders.customer_id', 'customers.id']] }],
    });
    expect(plan.columns).toEqual([{ physical: 'orders.*' }]);
  });

  it('leaves an implicit projection empty for a single-table widget', () => {
    const plan = validateQueryPlan({ id: 'w1', table: 'orders' });
    expect(plan.columns).toEqual([]);
  });

  it('leaves an implicit projection empty for an AGGREGATION widget (a `<table>.*` would land in GROUP BY)', () => {
    const plan = validateQueryPlan({
      id: 'w1',
      table: 'orders',
      aggregations: [{ column: 'amount', func: 'sum', alias: 'total' }],
      joins: [{ table: 'customers', on: [['orders.customer_id', 'customers.id']] }],
    });
    expect(plan.columns).toEqual([]);
  });

  it('still prefers the allowlist-synthesized projection when a columnAllowlist is configured', () => {
    const plan = validateQueryPlan(
      {
        id: 'w1',
        table: 'orders',
        joins: [{ table: 'customers', on: [['orders.customer_id', 'customers.id']] }],
      },
      // `customer_id` has to be allowlisted too: the join predicate references it, and
      // `validateDescriptorColumns` checks join.on against the allowlist before the
      // projection is synthesized. It is deliberately NOT in the expected projection —
      // synthesis takes the allowlist in order, and this asserts the allowlist path wins
      // over the `<table>.*` anchor, not that every allowed column is projected.
      { orders: ['id', 'amount', 'customer_id'], customers: ['id'] },
    );
    expect(plan.columns).toEqual([
      { physical: 'id' },
      { physical: 'amount' },
      { physical: 'customer_id' },
    ]);
  });
});

// ── One aggregate-function table, two enforcement sites ───────────────────────
describe('validateQueryPlan — semi-joins', () => {
  const base = (semiJoins: unknown): BatchWidgetDescriptor =>
    ({ id: 'w1', table: 'customers', semiJoins }) as BatchWidgetDescriptor;

  describe('plan resolution', () => {
    it('qualifies the outer column with the PRIMARY table and the foreign column with its own table', () => {
      const plan = validateQueryPlan(
        base([
          {
            table: 'orders',
            column: 'id',
            foreignColumn: 'customer_id',
            filters: [{ column: 'status', operator: 'eq', value: 'shipped' }],
          },
        ]),
      );
      expect(plan.semiJoins).toEqual([
        {
          table: 'orders',
          column: 'customers.id',
          // The subquery's FROM is `orders`, so its own references qualify
          // against `orders` — NOT against the widget's primary table.
          foreignColumn: 'orders.customer_id',
          filters: [{ column: 'orders.status', operator: 'eq', value: 'shipped' }],
          semiJoins: [],
        },
      ]);
    });

    it('qualifies a NESTED semi-join against its PARENT table, not the primary table', () => {
      // The distinguishing case for qualifying on the plan rather than at
      // emission time: `qualifyAgainst(plan.table, …)` — the rule every other
      // emission site uses — would produce `customers.tag_id` here, silently
      // testing a column of the wrong table.
      const plan = validateQueryPlan(
        base([
          {
            table: 'customer_tags',
            column: 'id',
            foreignColumn: 'customer_id',
            semiJoins: [{ table: 'tags', column: 'tag_id', foreignColumn: 'id' }],
          },
        ]),
      );
      expect(plan.semiJoins[0].semiJoins[0]).toEqual({
        table: 'tags',
        column: 'customer_tags.tag_id',
        foreignColumn: 'tags.id',
        filters: [],
        semiJoins: [],
      });
    });

    it('resolves a semi-join column through columnAliases, like every other reference', () => {
      const plan = validateQueryPlan({
        id: 'w1',
        table: 'customers',
        columnAliases: { 'expr-status': 'orders.status' },
        semiJoins: [
          {
            table: 'orders',
            column: 'id',
            foreignColumn: 'customer_id',
            filters: [{ column: 'expr-status', operator: 'eq', value: 'shipped' }],
          },
        ],
      });
      expect(plan.semiJoins[0].filters[0].column).toBe('orders.status');
    });

    it('leaves the plan\'s "semiJoins" an empty array when the descriptor declares none', () => {
      expect(validateQueryPlan({ id: 'w1', table: 'customers' }).semiJoins).toEqual([]);
    });
  });

  describe('unconditional shape validation (no columnAllowlist)', () => {
    it('rejects a non-array "semiJoins"', () => {
      expect(() => validateQueryPlan(base({} as never))).toThrow(/"semiJoins".*must be an array/s);
    });

    it('rejects a null entry', () => {
      expect(() => validateQueryPlan(base([null]))).toThrow(/Malformed entry in "semiJoins"/);
    });

    it.each([undefined, 42, ''])('rejects a %p "table"', (table) => {
      expect(() =>
        validateQueryPlan(base([{ table, column: 'id', foreignColumn: 'customer_id' }])),
      ).toThrow(/Semi-join "table" must be a non-empty string/);
    });

    it.each(['column', 'foreignColumn'] as const)('rejects a missing "%s"', (field) => {
      const entry: Record<string, unknown> = {
        table: 'orders',
        column: 'id',
        foreignColumn: 'customer_id',
      };
      delete entry[field];
      expect(() => validateQueryPlan(base([entry]))).toThrow(
        new RegExp(`Semi-join "${field}" for table "orders" must be a non-empty string`),
      );
    });

    it('rejects a non-array "filters"', () => {
      expect(() =>
        validateQueryPlan(
          base([{ table: 'orders', column: 'id', foreignColumn: 'customer_id', filters: {} }]),
        ),
      ).toThrow(/Semi-join "filters" for table "orders" must be an array/);
    });
  });

  describe('table-qualification convention (fail-closed, BOTH directions)', () => {
    it('rejects an outer column qualified with a table that is not the enclosing one', () => {
      expect(() =>
        validateQueryPlan(
          base([{ table: 'orders', column: 'orders.id', foreignColumn: 'customer_id' }]),
        ),
      ).toThrow(/outer column "orders\.id" qualified with table "orders" instead of "customers"/);
    });

    it('rejects a foreign column qualified with a table other than the semi-join table', () => {
      // The dangerous direction: projecting some other table's column from the
      // subquery compares an unrelated key space, admitting outer rows whose key
      // merely collides with a value that was never a join key.
      expect(() =>
        validateQueryPlan(base([{ table: 'orders', column: 'id', foreignColumn: 'customers.id' }])),
      ).toThrow(
        /projects a foreign column "customers\.id" qualified with table "customers" instead of "orders"/,
      );
    });

    it('rejects a NESTED outer column qualified with the PRIMARY table instead of the parent', () => {
      expect(() =>
        validateQueryPlan(
          base([
            {
              table: 'customer_tags',
              column: 'id',
              foreignColumn: 'customer_id',
              semiJoins: [{ table: 'tags', column: 'customers.tag_id', foreignColumn: 'id' }],
            },
          ]),
        ),
      ).toThrow(/qualified with table "customers" instead of "customer_tags"/);
    });

    it('accepts correctly-qualified references on both sides', () => {
      expect(() =>
        validateQueryPlan(
          base([{ table: 'orders', column: 'customers.id', foreignColumn: 'orders.customer_id' }]),
        ),
      ).not.toThrow();
    });
  });

  describe('nesting depth cap', () => {
    it('accepts two levels (the two-hop many-to-many shape)', () => {
      expect(() =>
        validateQueryPlan(
          base([
            {
              table: 'customer_tags',
              column: 'id',
              foreignColumn: 'customer_id',
              semiJoins: [{ table: 'tags', column: 'tag_id', foreignColumn: 'id' }],
            },
          ]),
        ),
      ).not.toThrow();
    });

    it('rejects a third level', () => {
      expect(() =>
        validateQueryPlan(
          base([
            {
              table: 'customer_tags',
              column: 'id',
              foreignColumn: 'customer_id',
              semiJoins: [
                {
                  table: 'tags',
                  column: 'tag_id',
                  foreignColumn: 'id',
                  semiJoins: [{ table: 'tag_groups', column: 'group_id', foreignColumn: 'id' }],
                },
              ],
            },
          ]),
        ),
      ).toThrow(/"semiJoins" nest more than 2 levels deep/);
    });

    it('does NOT reject an empty nested array at the depth boundary', () => {
      // Depth is about how far the recursion actually goes, so an EMPTY
      // `semiJoins: []` at the limit is not a third level.
      expect(() =>
        validateQueryPlan(
          base([
            {
              table: 'customer_tags',
              column: 'id',
              foreignColumn: 'customer_id',
              semiJoins: [{ table: 'tags', column: 'tag_id', foreignColumn: 'id', semiJoins: [] }],
            },
          ]),
        ),
      ).not.toThrow();
    });
  });

  describe('column allowlist (fail-closed, recursive)', () => {
    const ALLOWLIST = {
      customers: ['id', 'lifetime_value'],
      orders: ['customer_id', 'status'],
    };

    it('accepts references that are all allowlisted on their OWN table', () => {
      expect(() =>
        validateQueryPlan(
          base([
            {
              table: 'orders',
              column: 'id',
              foreignColumn: 'customer_id',
              filters: [{ column: 'status', operator: 'eq', value: 'shipped' }],
            },
          ]),
          ALLOWLIST,
        ),
      ).not.toThrow();
    });

    it('rejects a projected foreign column that is not allowlisted on the FOREIGN table', () => {
      // `lifetime_value` IS allowlisted — but on `customers`, not `orders`. If the
      // inner references were checked against the primary table (the shape a naive
      // implementation falls into), this would wrongly pass and then execute
      // against `orders`.
      expect(() =>
        validateQueryPlan(
          base([{ table: 'orders', column: 'id', foreignColumn: 'lifetime_value' }]),
          ALLOWLIST,
        ),
      ).toThrow(
        /Column "lifetime_value" on table "orders" is not in the column allowlist \(semiJoins\.foreignColumn\)/,
      );
    });

    it('rejects a subquery filter column that is not allowlisted on the foreign table', () => {
      expect(() =>
        validateQueryPlan(
          base([
            {
              table: 'orders',
              column: 'id',
              foreignColumn: 'customer_id',
              filters: [{ column: 'internal_note', operator: 'eq', value: 'x' }],
            },
          ]),
          ALLOWLIST,
        ),
      ).toThrow(
        /Column "internal_note" on table "orders" is not in the column allowlist \(semiJoins\.filters\)/,
      );
    });

    it('rejects an outer column that is not allowlisted on the ENCLOSING table', () => {
      expect(() =>
        validateQueryPlan(
          base([{ table: 'orders', column: 'secret', foreignColumn: 'customer_id' }]),
          ALLOWLIST,
        ),
      ).toThrow(
        /Column "secret" on table "customers" is not in the column allowlist \(semiJoins\.column\)/,
      );
    });

    it('rejects a semi-join table with NO allowlist entry at all (fail-closed)', () => {
      expect(() =>
        validateQueryPlan(
          base([{ table: 'payroll', column: 'id', foreignColumn: 'customer_id' }]),
          ALLOWLIST,
        ),
      ).toThrow(/Table "payroll" has no entry in the column allowlist/);
    });

    it('checks a NESTED semi-join too', () => {
      expect(() =>
        validateQueryPlan(
          base([
            {
              table: 'orders',
              column: 'id',
              foreignColumn: 'customer_id',
              semiJoins: [{ table: 'payroll', column: 'status', foreignColumn: 'id' }],
            },
          ]),
          ALLOWLIST,
        ),
      ).toThrow(/Table "payroll" has no entry in the column allowlist/);
    });
  });

  describe('direct-caller (no-validator) branch stays non-throwing', () => {
    it("resolves a malformed semi-join without throwing, per toValidatedQueryPlan's contract", () => {
      // `toValidatedQueryPlan`'s descriptor branch deliberately runs NO
      // validators, so `buildPlan` must coerce rather than crash — the same
      // tolerance it already applies to `join.type` / `orderBy[].direction`.
      expect(() => toValidatedQueryPlan(base([{ table: 'orders' }] as never))).not.toThrow();
    });
  });
});

describe('AGGREGATE_SQL_FUNCTIONS', () => {
  it('declares exactly the five supported functions, mapped to their SQL name', () => {
    expect(AGGREGATE_SQL_FUNCTIONS).toEqual({
      sum: 'SUM',
      avg: 'AVG',
      count: 'COUNT',
      min: 'MIN',
      max: 'MAX',
    });
  });

  it('keys match the Knex builder method names `execute.ts` dispatches on', () => {
    const knexBuilderMethods = ['sum', 'avg', 'count', 'min', 'max'];
    expect(Object.keys(AGGREGATE_SQL_FUNCTIONS).sort()).toEqual(knexBuilderMethods.sort());
  });
});

/** Run `fn`, returning the thrown Error's message (or a sentinel if it did not throw). */
function captureThrow(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return '<did not throw>';
}
