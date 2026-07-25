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

      it('resolves aggregation columns and pure-measure flags identically', () => {
        expect(plan.aggregations.map((a) => a.physical)).toEqual(
          (descriptor.aggregations ?? []).map((a) => resolveAlias(descriptor, a.column)),
        );
        // A pure measure is `FUNC(col) AS <col's own result key>` — the alias equals
        // the LAST dot-segment of the resolved physical column (finding 2.2), so a
        // qualified measure like `SUM(orders.amount) AS amount` still counts.
        expect(plan.aggregations.map((a) => a.pureMeasure)).toEqual(
          (descriptor.aggregations ?? []).map(
            (a) => a.alias === (resolveAlias(descriptor, a.column).split('.').pop() ?? ''),
          ),
        );
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
    // aggregation alias — both SELECT-ed under the same result-row key.
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'sales',
      columnAliases: { revenue: 'amount' },
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

  it('recognises a table-qualified pure measure and keeps it out of GROUP BY (finding 2.2)', () => {
    // `SUM(orders.amount) AS amount` is a pure measure even though `agg.column` is
    // qualified — the old raw-string `alias === column` test could never match a
    // dotted column, wrongly leaving it a GROUP BY dimension.
    const plan = validateQueryPlan({
      id: 'w1',
      table: 'orders',
      columns: ['orders.amount', 'customers.region'],
      joins: [{ table: 'customers', type: 'left', on: [['orders.customer_id', 'customers.id']] }],
      aggregations: [{ column: 'orders.amount', func: 'sum', alias: 'amount' }],
    });
    const amountAgg = plan.aggregations.find((a) => a.alias === 'amount');
    expect(amountAgg?.pureMeasure).toBe(true);
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
