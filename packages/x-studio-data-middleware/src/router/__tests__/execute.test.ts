/**
 * Unit tests for `executeForTier`'s query-shape contract per routing tier.
 *
 * These assert the Knex call sequence directly (via a recording stand-in) rather
 * than through the in-memory mock DB — the mock ignores `groupBy` when there are
 * no aggregate specs, so it cannot distinguish "grouped" from "raw" rows for a
 * non-aggregation descriptor. The recording contract is what actually diverges
 * against a real Knex/SQL backend, so that is what is pinned here.
 */
import { describe, it, expect } from 'vitest';
import { executeForTier } from '../execute';
import type { JwtSecurityClaims, BatchWidgetDescriptor } from '../../security/types';

interface RecordedCall {
  method: string;
  args: unknown[];
}

/** A Knex stand-in that records every chained call. Not thenable, so awaiting the
 *  returned builder resolves to the builder itself (no query executes). */
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
    'sum',
    'avg',
    'min',
    'max',
    'havingRaw',
  ];
  for (const method of chainMethods) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  }
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
  (db as any).raw = (_sql: string, bindings: unknown[]) => ({ kind: 'raw', bindings });
  return { db, calls };
}

const BASE_CLAIMS: JwtSecurityClaims = {
  tenantId: 'acme',
  userId: 'user-1',
  roleIds: ['viewer'],
};

const SINGLE_TENANT = { mode: 'single-tenant' } as const;

function descriptor(overrides: Partial<BatchWidgetDescriptor> = {}): BatchWidgetDescriptor {
  return { id: 'w1', table: 'sales', ...overrides };
}

describe('executeForTier — "db" tier', () => {
  // Regression (finding 2.1): a NON-aggregation descriptor can be routed to the
  // 'db' tier when its preflight COUNT(*) exceeds the server threshold. The db
  // branch used to GROUP BY every projected column (silently de-duplicating rows)
  // — or emit `SELECT *` with no columns — changing the row shape vs. the
  // client/server tiers. With no aggregations it must now fall back to a plain
  // select/orderBy/limit, matching those tiers.
  it('returns raw (non-grouped) rows for a non-aggregation descriptor', async () => {
    const { db, calls } = createRecordingDb();
    await executeForTier(
      db,
      BASE_CLAIMS,
      descriptor({ columns: ['category', 'amount'], limit: 500 }),
      'db',
      { tenancy: SINGLE_TENANT },
    );
    // Columns are projected…
    expect(calls.some((c) => c.method === 'select')).toBe(true);
    // …the limit is applied…
    expect(calls).toContainEqual({ method: 'limit', args: [500] });
    // …and crucially NO GROUP BY (would de-duplicate) and NO aggregate clauses.
    expect(calls.some((c) => c.method === 'groupBy')).toBe(false);
    expect(calls.some((c) => ['sum', 'avg', 'count', 'min', 'max'].includes(c.method))).toBe(false);
  });

  it('applies ORDER BY (not GROUP BY) for a non-aggregation descriptor', async () => {
    const { db, calls } = createRecordingDb();
    await executeForTier(
      db,
      BASE_CLAIMS,
      descriptor({ columns: ['category'], orderBy: [{ column: 'category', direction: 'asc' }] }),
      'db',
      { tenancy: SINGLE_TENANT },
    );
    expect(calls).toContainEqual({ method: 'orderBy', args: ['sales.category', 'asc'] });
    expect(calls.some((c) => c.method === 'groupBy')).toBe(false);
  });

  // Contrast: an aggregation descriptor still uses the GROUP BY / aggregate
  // push-down path — the fix must not disturb the intended db-tier behavior.
  it('still GROUP-BYs dimension columns for an aggregation descriptor', async () => {
    const { db, calls } = createRecordingDb();
    await executeForTier(
      db,
      BASE_CLAIMS,
      descriptor({
        columns: ['category'],
        aggregations: [{ column: 'amount', func: 'sum', alias: 'total' }],
      }),
      'db',
      { tenancy: SINGLE_TENANT },
    );
    expect(calls).toContainEqual({ method: 'groupBy', args: [['sales.category']] });
    expect(calls.some((c) => c.method === 'sum')).toBe(true);
  });

  // Regression (finding 3.1): all three tier branches used to gate `.limit()` on
  // truthiness (`if (queryPlan.limit) {...}`), so `limit: 0` — a legitimate
  // "return zero rows" request — was silently treated as "no limit" and never
  // reached `query.limit()` at all. Fixed to `!== undefined` in every branch.
  it('applies .limit(0) for a non-aggregation descriptor routed to the db tier (no false-y skip)', async () => {
    const { db, calls } = createRecordingDb();
    await executeForTier(db, BASE_CLAIMS, descriptor({ columns: ['category'], limit: 0 }), 'db', {
      tenancy: SINGLE_TENANT,
    });
    expect(calls).toContainEqual({ method: 'limit', args: [0] });
  });

  it('applies .limit(0) for an aggregation descriptor on the db tier (no false-y skip)', async () => {
    const { db, calls } = createRecordingDb();
    await executeForTier(
      db,
      BASE_CLAIMS,
      descriptor({
        columns: ['category'],
        aggregations: [{ column: 'amount', func: 'sum', alias: 'total' }],
        limit: 0,
      }),
      'db',
      { tenancy: SINGLE_TENANT },
    );
    expect(calls).toContainEqual({ method: 'limit', args: [0] });
  });
});

describe('executeForTier — "client"/"server" tiers', () => {
  it('applies .limit(0) instead of treating it as "no limit" (finding 3.1)', async () => {
    const { db, calls } = createRecordingDb();
    await executeForTier(
      db,
      BASE_CLAIMS,
      descriptor({ columns: ['category'], limit: 0 }),
      'server',
      { tenancy: SINGLE_TENANT },
    );
    expect(calls).toContainEqual({ method: 'limit', args: [0] });
  });
});
