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
import {
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
        expect(plan.aggregations.map((a) => a.pureMeasure)).toEqual(
          (descriptor.aggregations ?? []).map((a) => a.alias === a.column),
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

/** Run `fn`, returning the thrown Error's message (or a sentinel if it did not throw). */
function captureThrow(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return '<did not throw>';
}
