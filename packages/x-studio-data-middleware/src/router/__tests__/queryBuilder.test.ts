/**
 * Unit tests for `buildSecureQuery`.
 *
 * `handler.test.ts` exercises the query builder end-to-end through an in-memory
 * mock DB, but only covers the `eq`, `in`, `neq` and `gte` operators and never
 * touches joins or the unsupported-operator rejection path. These tests assert
 * the Knex call contract directly so every operator, the SAFE_OPERATORS guard,
 * the join types, and the "security predicates first" invariant are covered.
 */
import { describe, it, expect } from 'vitest';
import { buildSecureQuery } from '../queryBuilder';
import type { JwtSecurityClaims, BatchWidgetDescriptor } from '../../security/types';

interface RecordedCall {
  method: string;
  args: unknown[];
}

/**
 * A Knex stand-in that records every chained call instead of touching a DB.
 * Returns itself from every method so `.where().whereIn()...` chains resolve.
 */
function createRecordingDb() {
  const calls: RecordedCall[] = [];
  const builder: Record<string, (...args: unknown[]) => unknown> = {};
  const chainMethods = [
    'where',
    'whereIn',
    'whereLike',
    'whereBetween',
    'count',
    'select',
    'orderBy',
    'limit',
    'groupBy',
  ];
  for (const method of chainMethods) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  }
  // Join methods use Knex's callback form: `join(table, function () { this.on(...) })`.
  // Record the join once (with only the table), then run the callback against a
  // context whose `.on()` records each condition — so a composite-key join is a
  // single join with multiple `on` calls (not one join per pair).
  const joinCtx = {
    on(...args: unknown[]) {
      calls.push({ method: 'on', args });
      return joinCtx;
    },
  };
  for (const method of ['join', 'leftJoin', 'rightJoin']) {
    builder[method] = (table: unknown, cb: unknown) => {
      calls.push({ method, args: [table] });
      if (typeof cb === 'function') {
        (cb as (this: typeof joinCtx) => void).call(joinCtx);
      }
      return builder;
    };
  }
  const db = (table: string) => {
    calls.push({ method: 'from', args: [table] });
    return builder;
  };
  return { db, calls };
}

const BASE_CLAIMS: JwtSecurityClaims = {
  tenantId: 'acme',
  userId: 'user-1',
  roleIds: ['viewer'],
};

function descriptor(overrides: Partial<BatchWidgetDescriptor> = {}): BatchWidgetDescriptor {
  return { id: 'w1', table: 'sales', ...overrides };
}

// Returns the index of the first call matching `method` and (optionally) args.
function indexOf(calls: RecordedCall[], method: string, predicate?: (c: RecordedCall) => boolean) {
  return calls.findIndex((c) => c.method === method && (predicate ? predicate(c) : true));
}

describe('buildSecureQuery', () => {
  describe('security predicates', () => {
    it('applies a qualified tenant predicate when tenantColumn is set', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(db, BASE_CLAIMS, descriptor(), { tenantColumn: 'tenant_id' });
      expect(calls).toContainEqual({ method: 'where', args: ['sales.tenant_id', '=', 'acme'] });
    });

    it('does not apply a tenant predicate when tenantColumn is omitted', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(db, BASE_CLAIMS, descriptor());
      expect(calls.some((c) => c.method === 'where')).toBe(false);
    });

    it('applies a region whereIn predicate when regionIds are present', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(db, { ...BASE_CLAIMS, regionIds: [1, 2] }, descriptor());
      expect(calls).toContainEqual({ method: 'whereIn', args: ['sales.region_id', [1, 2]] });
    });

    it('does not apply a region predicate when regionIds is an empty array', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(db, { ...BASE_CLAIMS, regionIds: [] }, descriptor());
      expect(calls.some((c) => c.method === 'whereIn')).toBe(false);
    });

    it('applies a department predicate when department is present', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(db, { ...BASE_CLAIMS, department: 'sales' }, descriptor());
      expect(calls).toContainEqual({ method: 'where', args: ['sales.department', '=', 'sales'] });
    });

    it('applies security predicates BEFORE user filters (cannot be overridden)', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        { ...BASE_CLAIMS, department: 'sales' },
        descriptor({
          filters: [{ column: 'status', operator: 'eq', value: 'active' }],
        }),
        { tenantColumn: 'tenant_id' },
      );

      const securityIdx = indexOf(calls, 'where', (c) => c.args[0] === 'sales.tenant_id');
      const userFilterIdx = indexOf(calls, 'where', (c) => c.args[0] === 'status');
      expect(securityIdx).toBeGreaterThanOrEqual(0);
      expect(userFilterIdx).toBeGreaterThanOrEqual(0);
      expect(securityIdx).toBeLessThan(userFilterIdx);
    });
  });

  describe('filter operators', () => {
    it.each([
      ['eq', '=', 'active'],
      ['neq', '!=', 'archived'],
      ['lt', '<', 100],
      ['lte', '<=', 100],
      ['gt', '>', 0],
      ['gte', '>=', 0],
    ] as const)('maps "%s" to where(col, "%s", value)', (operator, sqlOp, value) => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({ filters: [{ column: 'amount', operator, value }] }),
      );
      expect(calls).toContainEqual({ method: 'where', args: ['amount', sqlOp, value] });
    });

    it('maps "in" to whereIn', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          filters: [{ column: 'product', operator: 'in', value: ['a', 'b'] }],
        }),
      );
      expect(calls).toContainEqual({ method: 'whereIn', args: ['product', ['a', 'b']] });
    });

    it('skips an empty "in" list (autoRemove) rather than emitting WHERE x IN ()', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          filters: [{ column: 'product', operator: 'in', value: [] }],
        }),
      );
      expect(calls.some((c) => c.method === 'whereIn')).toBe(false);
    });

    it('maps "like" to whereLike', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          filters: [{ column: 'name', operator: 'like', value: 'Ac%' }],
        }),
      );
      expect(calls).toContainEqual({ method: 'whereLike', args: ['name', 'Ac%'] });
    });

    it('maps "between" to whereBetween with a [lo, hi] tuple', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          filters: [{ column: 'amount', operator: 'between', value: [10, 20] }],
        }),
      );
      expect(calls).toContainEqual({ method: 'whereBetween', args: ['amount', [10, 20]] });
    });

    it('throws on an unsupported operator (allowlist guard)', () => {
      const { db } = createRecordingDb();
      expect(() =>
        buildSecureQuery(
          db,
          BASE_CLAIMS,
          descriptor({
            // Cast: deliberately exercise the runtime guard with a forbidden operator.
            filters: [{ column: 'amount', operator: 'sql' as any, value: '1; DROP TABLE sales' }],
          }),
        ),
      ).toThrow(/Unsupported filter operator/);
    });

    it('applies multiple filter predicates in order', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          filters: [
            { column: 'status', operator: 'eq', value: 'active' },
            { column: 'amount', operator: 'gt', value: 0 },
          ],
        }),
      );
      const whereCalls = calls.filter((c) => c.method === 'where');
      expect(whereCalls).toEqual([
        { method: 'where', args: ['status', '=', 'active'] },
        { method: 'where', args: ['amount', '>', 0] },
      ]);
    });
  });

  describe('joins', () => {
    it('uses leftJoin for type "left" with a single join call + on() condition', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          joins: [
            { table: 'customers', type: 'left', on: [['sales.customer_id', 'customers.id']] },
          ],
        }),
      );
      expect(calls).toContainEqual({ method: 'leftJoin', args: ['customers'] });
      expect(calls).toContainEqual({
        method: 'on',
        args: ['sales.customer_id', '=', 'customers.id'],
      });
    });

    it('uses rightJoin for type "right"', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          joins: [
            { table: 'customers', type: 'right', on: [['sales.customer_id', 'customers.id']] },
          ],
        }),
      );
      expect(calls).toContainEqual({ method: 'rightJoin', args: ['customers'] });
      expect(calls).toContainEqual({
        method: 'on',
        args: ['sales.customer_id', '=', 'customers.id'],
      });
    });

    it('uses inner join for type "inner" and when type is omitted', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          joins: [
            { table: 'customers', type: 'inner', on: [['sales.customer_id', 'customers.id']] },
            { table: 'regions', on: [['sales.region_id', 'regions.id']] },
          ],
        }),
      );
      const joinCalls = calls.filter((c) => c.method === 'join');
      expect(joinCalls).toEqual([
        { method: 'join', args: ['customers'] },
        { method: 'join', args: ['regions'] },
      ]);
    });

    it('joins a composite-key table exactly once, with one on() per pair', () => {
      // Regression: the previous per-pair loop called join() once per pair,
      // joining the same table twice → "table name not unique" on real DBs.
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          joins: [
            {
              table: 'customers',
              on: [
                ['sales.a', 'customers.a'],
                ['sales.b', 'customers.b'],
              ],
            },
          ],
        }),
      );
      // Exactly one join call for the table…
      expect(calls.filter((c) => c.method === 'join')).toEqual([
        { method: 'join', args: ['customers'] },
      ]);
      // …and one on() condition per pair.
      expect(calls.filter((c) => c.method === 'on')).toEqual([
        { method: 'on', args: ['sales.a', '=', 'customers.a'] },
        { method: 'on', args: ['sales.b', '=', 'customers.b'] },
      ]);
    });

    it('applies joins BEFORE security predicates', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          joins: [
            { table: 'customers', type: 'left', on: [['sales.customer_id', 'customers.id']] },
          ],
        }),
        { tenantColumn: 'tenant_id' },
      );
      const joinIdx = indexOf(calls, 'leftJoin');
      const securityIdx = indexOf(calls, 'where', (c) => c.args[0] === 'sales.tenant_id');
      expect(joinIdx).toBeLessThan(securityIdx);
    });
  });

  describe('configurable security columns', () => {
    it('uses a custom region column name from securityColumns', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(db, { ...BASE_CLAIMS, regionIds: [7] }, descriptor(), {
        securityColumns: { region: 'sales_region' },
      });
      expect(calls).toContainEqual({ method: 'whereIn', args: ['sales.sales_region', [7]] });
    });

    it('uses a custom department column name from securityColumns', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(db, { ...BASE_CLAIMS, department: 'ops' }, descriptor(), {
        securityColumns: { department: 'dept_code' },
      });
      expect(calls).toContainEqual({ method: 'where', args: ['sales.dept_code', '=', 'ops'] });
    });

    it('defaults to region_id / department when securityColumns is omitted', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(db, { ...BASE_CLAIMS, regionIds: [1], department: 'ops' }, descriptor());
      expect(calls).toContainEqual({ method: 'whereIn', args: ['sales.region_id', [1]] });
      expect(calls).toContainEqual({ method: 'where', args: ['sales.department', '=', 'ops'] });
    });

    it('scopes a joined table that has a configured tenant column', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          joins: [{ table: 'customers', on: [['sales.customer_id', 'customers.id']] }],
        }),
        {
          tenantColumn: 'tenant_id',
          securityColumns: { perTable: { customers: { tenant: 'tenant_id' } } },
        },
      );
      // Both the primary table and the joined table get a tenant predicate.
      expect(calls).toContainEqual({ method: 'where', args: ['sales.tenant_id', '=', 'acme'] });
      expect(calls).toContainEqual({ method: 'where', args: ['customers.tenant_id', '=', 'acme'] });
    });

    it('does NOT scope a joined table without a configured tenant column (shared table)', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          joins: [{ table: 'regions', on: [['sales.region_id', 'regions.id']] }],
        }),
        { tenantColumn: 'tenant_id' },
      );
      expect(calls).toContainEqual({ method: 'where', args: ['sales.tenant_id', '=', 'acme'] });
      expect(calls.some((c) => c.args[0] === 'regions.tenant_id')).toBe(false);
    });
  });

  it('queries the descriptor table and returns the builder', () => {
    const { db, calls } = createRecordingDb();
    const result = buildSecureQuery(db, BASE_CLAIMS, descriptor());
    expect(calls[0]).toEqual({ method: 'from', args: ['sales'] });
    expect(typeof result.where).toBe('function');
  });
});
