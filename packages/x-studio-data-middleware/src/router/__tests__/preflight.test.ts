/**
 * Unit tests for `runPreflight` (a pure COUNT(*) runner) and `executeForTier`.
 *
 * `runPreflight` no longer maps row counts to tiers — that lives in
 * `tierDecision.ts`. These tests pin the COUNT(*) coercion, and cover the
 * db-tier ORDER BY column-alias mapping (regression: ordering an aggregation
 * query by an expression-aliased column must emit the physical column, while an
 * aggregation alias must be left as-is).
 */
import { describe, it, expect } from 'vitest';
import { runPreflight } from '../preflight';
import { executeForTier } from '../execute';
import type { JwtSecurityClaims, BatchWidgetDescriptor } from '../../security/types';

const CLAIMS: JwtSecurityClaims = { tenantId: 'acme', userId: 'u1', roleIds: [] };
const DESCRIPTOR: BatchWidgetDescriptor = { id: 'w1', table: 'sales' };

// These tests configure no tenant column → the deployment is single-tenant. The
// tenancy decision is now a required argument at every enforcement site.
const SINGLE_TENANT_OPTS = { tenancy: { mode: 'single-tenant' } } as const;

/**
 * Minimal Knex stand-in whose `.first()` resolves to a fixed COUNT(*) result.
 * Every other chained method is a no-op that returns the builder.
 */
function countDb(firstResult: { row_count: number | string } | undefined) {
  const builder: Record<string, unknown> = {};
  const methods = [
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
  for (const method of methods) {
    builder[method] = () => builder;
  }
  builder.first = async () => firstResult;
  return () => builder;
}

describe('runPreflight', () => {
  it('returns the COUNT(*) row count', async () => {
    const result = await runPreflight(
      countDb({ row_count: 4200 }),
      CLAIMS,
      DESCRIPTOR,
      SINGLE_TENANT_OPTS,
    );
    expect(result).toEqual({ rowCount: 4200 });
  });

  it('coerces a string row_count to a number', async () => {
    const result = await runPreflight(
      countDb({ row_count: '42' }),
      CLAIMS,
      DESCRIPTOR,
      SINGLE_TENANT_OPTS,
    );
    expect(result).toEqual({ rowCount: 42 });
  });

  it('treats a missing COUNT result as zero rows', async () => {
    const result = await runPreflight(countDb(undefined), CLAIMS, DESCRIPTOR, SINGLE_TENANT_OPTS);
    expect(result).toEqual({ rowCount: 0 });
  });
});

// ─── executeForTier — db-tier ORDER BY column-alias mapping ───────────────────

interface RecordedCall {
  method: string;
  args: unknown[];
}

/** Records every chained call; thenable so `executeForTier` can await it. */
function createRecordingDb() {
  const calls: RecordedCall[] = [];
  const builder: Record<string, unknown> = {};
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
    'sum',
    'avg',
    'min',
    'max',
  ];
  for (const method of chainMethods) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  }
  builder.then = (resolve: (rows: unknown[]) => void) => resolve([]);
  const db = ((table: string) => {
    calls.push({ method: 'from', args: [table] });
    return builder;
  }) as any;
  db.raw = (sql: string, bindings: unknown[]) => {
    calls.push({ method: 'raw', args: [sql, bindings] });
    return { __raw: sql, bindings };
  };
  return { db, calls };
}

describe('executeForTier — db tier ORDER BY column aliases', () => {
  it('maps an ORDER BY on an expression-aliased dimension to its physical column', async () => {
    const { db, calls } = createRecordingDb();
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'sales',
      columns: ['country'],
      columnAliases: { country: 'customers.country' },
      aggregations: [{ column: 'amount', func: 'sum', alias: 'total' }],
      orderBy: [{ column: 'country', direction: 'asc' }],
    };
    await executeForTier(db, CLAIMS, descriptor, 'db', SINGLE_TENANT_OPTS);
    const orderByCall = calls.find((c) => c.method === 'orderBy');
    // Must use the physical column, not the logical id "country".
    expect(orderByCall).toEqual({ method: 'orderBy', args: ['customers.country', 'asc'] });
  });

  it('leaves an ORDER BY on an aggregation alias untouched', async () => {
    const { db, calls } = createRecordingDb();
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'sales',
      columns: ['region'],
      aggregations: [{ column: 'amount', func: 'sum', alias: 'total' }],
      orderBy: [{ column: 'total', direction: 'desc' }],
    };
    await executeForTier(db, CLAIMS, descriptor, 'db', SINGLE_TENANT_OPTS);
    const orderByCall = calls.find((c) => c.method === 'orderBy');
    expect(orderByCall).toEqual({ method: 'orderBy', args: ['total', 'desc'] });
  });
});

// ─── executeForTier — client/server tier ORDER BY qualification (finding 1.12) ─

describe('executeForTier — client/server tier ORDER BY qualification', () => {
  it('qualifies an unqualified ORDER BY column with the primary table', async () => {
    const { db, calls } = createRecordingDb();
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'sales',
      columns: ['region'],
      orderBy: [{ column: 'region', direction: 'asc' }],
    };
    await executeForTier(db, CLAIMS, descriptor, 'client', SINGLE_TENANT_OPTS);
    const orderByCall = calls.find((c) => c.method === 'orderBy');
    // Must be qualified so it is unambiguous when a JOIN is present.
    expect(orderByCall).toEqual({ method: 'orderBy', args: ['sales.region', 'asc'] });
  });

  it('leaves an already-qualified ORDER BY column untouched', async () => {
    const { db, calls } = createRecordingDb();
    const descriptor: BatchWidgetDescriptor = {
      id: 'w1',
      table: 'sales',
      columns: ['customers.name'],
      orderBy: [{ column: 'customers.name', direction: 'desc' }],
    };
    await executeForTier(db, CLAIMS, descriptor, 'server', SINGLE_TENANT_OPTS);
    const orderByCall = calls.find((c) => c.method === 'orderBy');
    expect(orderByCall).toEqual({ method: 'orderBy', args: ['customers.name', 'desc'] });
  });
});
