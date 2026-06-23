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
    'join',
    'leftJoin',
    'rightJoin',
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
    it('uses leftJoin for type "left"', () => {
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
      expect(calls).toContainEqual({
        method: 'leftJoin',
        args: ['customers', 'sales.customer_id', '=', 'customers.id'],
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
      expect(calls).toContainEqual({
        method: 'rightJoin',
        args: ['customers', 'sales.customer_id', '=', 'customers.id'],
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
      expect(joinCalls).toHaveLength(2);
      expect(joinCalls[1]).toEqual({
        method: 'join',
        args: ['regions', 'sales.region_id', '=', 'regions.id'],
      });
    });

    it('emits one join call per "on" pair (composite keys)', () => {
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
      expect(calls.filter((c) => c.method === 'join')).toHaveLength(2);
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

  it('queries the descriptor table and returns the builder', () => {
    const { db, calls } = createRecordingDb();
    const result = buildSecureQuery(db, BASE_CLAIMS, descriptor());
    expect(calls[0]).toEqual({ method: 'from', args: ['sales'] });
    expect(typeof result.where).toBe('function');
  });
});
