/**
 * Statement-timeout coverage (F2).
 *
 * Every database round-trip this package issues went out UNTIMED. The two choke
 * points are `runBounded` (`router/execute.ts`) for the data query and
 * `runPreflight` (`router/preflight.ts`) for the COUNT(*), plus the three
 * mutation builders on the write path. None of them called Knex's `.timeout(ms)`,
 * and neither `HandleBatchQueryOptions` nor `HandleMutationOptions` exposed a
 * knob for one.
 *
 * `MAX_CONCURRENT_WIDGET_QUERIES` (6) bounds ONE request, not one caller: ten
 * concurrent batches of six distinct widgets each put 60 queries in flight
 * against a host Knex pool whose default is `max: 10` /
 * `acquireConnectionTimeout: 60_000`. The preflight in particular is deliberately
 * LIMIT-less, so a slow COUNT(*) pins a pooled connection for as long as the
 * database takes — and the host's own non-Studio traffic starts failing with
 * `KnexTimeoutError` on connection acquisition. A per-query timeout turns that
 * into a bounded, per-widget `{ error }` instead.
 *
 * These tests assert the timeout is actually applied at every exit path, that the
 * host can configure or disable it, and that a bad value is rejected at the option
 * boundary rather than per widget.
 */
import { describe, it, expect } from 'vitest';
import Knex from 'knex';
import { handleBatchQuery } from '../handler';
import { handleMutation } from '../mutations/handleMutation';
import { DEFAULT_QUERY_TIMEOUT_MS, applyQueryTimeout } from '../shared/queryTimeout';
import type { JwtSecurityClaims } from '../security/types';

process.env.JWT_SECRET ??= 'query-timeout-test-secret';

const CLAIMS: JwtSecurityClaims = { tenantId: 'acme', userId: 'u1', roleIds: ['analyst'] };
const SINGLE_TENANT = { mode: 'single-tenant' } as const;

/** Every `.timeout(...)` call any builder in this fake DB received. */
interface TimeoutCall {
  ms: number;
  opts: unknown;
  /** `'preflight'` for the COUNT(*) round-trip, `'data'` for everything else. */
  kind: 'preflight' | 'data';
}

/**
 * A Knex stand-in that records `.timeout()` per round-trip.
 *
 * `insert`/`update`/`delete` resolve to plausible driver return shapes so the
 * write path can be driven end-to-end too.
 */
function createTimeoutRecordingDb(rows: Record<string, unknown>[] = [{ id: 1 }]) {
  const timeouts: TimeoutCall[] = [];
  const db: any = () => {
    let isCount = false;
    let countAlias = 'count';
    let pendingWrite: 'insert' | 'update' | 'delete' | null = null;
    const recorded: { ms: number; opts: unknown }[] = [];
    const flush = (kind: 'preflight' | 'data'): void => {
      for (const call of recorded) {
        timeouts.push({ ...call, kind });
      }
      recorded.length = 0;
    };
    const qb: any = {
      timeout(ms: number, opts?: unknown) {
        recorded.push({ ms, opts });
        return qb;
      },
      count(expr: string) {
        isCount = true;
        countAlias = String(expr).split(' as ')[1]?.trim() ?? 'count';
        return qb;
      },
      insert() {
        pendingWrite = 'insert';
        return qb;
      },
      update() {
        pendingWrite = 'update';
        return qb;
      },
      delete() {
        pendingWrite = 'delete';
        return qb;
      },
      async first() {
        flush(isCount ? 'preflight' : 'data');
        return { [countAlias]: rows.length };
      },
      then(resolve: (value: unknown) => void) {
        flush('data');
        // Driver-shaped results: INSERT resolves to `[lastInsertId]`,
        // UPDATE/DELETE to a row count, a plain SELECT to the rows.
        if (pendingWrite === 'insert') {
          resolve([1]);
        } else if (pendingWrite === null) {
          resolve(rows);
        } else {
          resolve(1);
        }
      },
    };
    for (const method of [
      'where',
      'whereIn',
      'whereNot',
      'whereLike',
      'whereBetween',
      'whereNull',
      'whereNotNull',
      'select',
      'orderBy',
      'groupBy',
      'havingRaw',
      'limit',
      'sum',
      'avg',
      'min',
      'max',
      'join',
      'leftJoin',
      'rightJoin',
    ]) {
      qb[method] = () => qb;
    }
    return qb;
  };
  db.raw = () => ({});
  return { db, timeouts };
}

const WIDGET = { id: 'w1', table: 'orders', columns: ['id'] };

/**
 * Per-test cache isolation.
 *
 * `handleBatchQuery`/`handleMutation` fall back to PROCESS-WIDE singleton cache
 * providers when none is passed, so two tests issuing the same descriptor would
 * share entries: the second would be served from cache, issue no query at all,
 * and record zero timeouts — passing or failing for reasons unrelated to what is
 * being asserted. Each test gets its own empty Map-backed provider, and the tier
 * cache is switched off so the COUNT(*) preflight always runs.
 */
function isolatedCaches() {
  const entries = new Map<string, any>();
  return {
    tierCacheTtlMs: 0,
    cacheProvider: {
      async get(key: string) {
        return entries.get(key);
      },
      async set(key: string, value: unknown) {
        entries.set(key, value);
      },
      async invalidatePrefix() {},
      async deleteByTag() {},
    } as any,
  };
}

describe('read path — every round-trip is timed (F2)', () => {
  it('applies the default timeout to BOTH the preflight COUNT(*) and the data query', async () => {
    const { db, timeouts } = createTimeoutRecordingDb();
    const res = await handleBatchQuery({ widgets: [WIDGET] } as any, CLAIMS, {
      db,
      schemaAllowlist: ['orders'],
      tenancy: SINGLE_TENANT,
      ...isolatedCaches(),
    });
    expect(res.results[0].error).toBeUndefined();
    expect(timeouts.map((t) => t.kind).sort()).toEqual(['data', 'preflight']);
    for (const call of timeouts) {
      expect(call.ms).toBe(DEFAULT_QUERY_TIMEOUT_MS);
    }
  });

  it('honors a host-configured queryTimeoutMs on both round-trips', async () => {
    const { db, timeouts } = createTimeoutRecordingDb();
    await handleBatchQuery({ widgets: [WIDGET] } as any, CLAIMS, {
      db,
      schemaAllowlist: ['orders'],
      tenancy: SINGLE_TENANT,
      queryTimeoutMs: 1234,
      ...isolatedCaches(),
    });
    expect(timeouts).toHaveLength(2);
    expect(timeouts.every((t) => t.ms === 1234)).toBe(true);
  });

  it('applies the timeout to the aggregation ("db" tier) exit path too', async () => {
    const { db, timeouts } = createTimeoutRecordingDb();
    await handleBatchQuery(
      {
        widgets: [
          {
            id: 'w1',
            table: 'orders',
            columns: ['id'],
            aggregations: [{ column: 'id', func: 'sum', alias: 'total' }],
          },
        ],
      } as any,
      CLAIMS,
      {
        db,
        schemaAllowlist: ['orders'],
        tenancy: SINGLE_TENANT,
        queryTimeoutMs: 7000,
        ...isolatedCaches(),
      },
    );
    // Aggregation widgets skip the preflight, so only the data query runs — and it
    // is a DIFFERENT exit path through `executeForTier` than the plain projection.
    expect(timeouts).toEqual([{ ms: 7000, opts: expect.anything(), kind: 'data' }]);
  });

  it('lets a host disable the timeout with queryTimeoutMs: 0', async () => {
    const { db, timeouts } = createTimeoutRecordingDb();
    await handleBatchQuery({ widgets: [WIDGET] } as any, CLAIMS, {
      db,
      schemaAllowlist: ['orders'],
      tenancy: SINGLE_TENANT,
      queryTimeoutMs: 0,
      ...isolatedCaches(),
    });
    expect(timeouts).toHaveLength(0);
  });

  it('rejects the WHOLE request for an invalid queryTimeoutMs (host misconfiguration)', async () => {
    const { db } = createTimeoutRecordingDb();
    await expect(
      handleBatchQuery({ widgets: [WIDGET] } as any, CLAIMS, {
        db,
        schemaAllowlist: ['orders'],
        tenancy: SINGLE_TENANT,
        queryTimeoutMs: -5,
      }),
    ).rejects.toThrow(/^MUI X Studio Server: "queryTimeoutMs" must be/);
    await expect(
      handleBatchQuery({ widgets: [WIDGET] } as any, CLAIMS, {
        db,
        schemaAllowlist: ['orders'],
        tenancy: SINGLE_TENANT,
        queryTimeoutMs: '30s' as any,
      }),
    ).rejects.toThrow(/^MUI X Studio Server: "queryTimeoutMs" must be/);
  });
});

describe('write path — every mutation round-trip is timed (F2)', () => {
  it.each(['insert', 'update', 'delete'] as const)('times the %s builder', async (operation) => {
    const { db, timeouts } = createTimeoutRecordingDb();
    const descriptor: any = { id: 'm1', operation, table: 'orders' };
    if (operation !== 'delete') {
      descriptor.values = { status: 'shipped' };
    }
    if (operation !== 'insert') {
      descriptor.where = [{ column: 'id', operator: 'eq', value: 1 }];
    }
    const res = await handleMutation({ mutations: [descriptor] } as any, CLAIMS, {
      db,
      schemaAllowlist: ['orders'],
      tenancy: SINGLE_TENANT,
      queryTimeoutMs: 4321,
      ...isolatedCaches(),
    });
    expect(res.results[0].ok).toBe(true);
    expect(timeouts).toEqual([{ ms: 4321, opts: expect.anything(), kind: 'data' }]);
  });
});

// Knex's `.timeout(ms, { cancel: true })` calls `client.assertCanCancelQuery()`
// SYNCHRONOUSLY at builder time and THROWS for any dialect whose client reports
// `canCancelQuery === false` — which includes sqlite3 / better-sqlite3. Applying
// `{ cancel: true }` unconditionally would therefore break every SQLite
// deployment outright, the same class of dialect-specific defect as F1. The
// helper must feature-detect and fall back to a plain `.timeout(ms)`.
describe('cancel-on-timeout is dialect-gated (F2)', () => {
  it('does not throw when building against a dialect that cannot cancel', () => {
    const sqlite = Knex({ client: 'better-sqlite3', connection: { filename: ':memory:' } });
    expect(sqlite.client.canCancelQuery).toBe(false);
    expect(() => applyQueryTimeout(sqlite('orders'), 1000)).not.toThrow();
  });

  it('requests cancellation on a dialect that supports it', () => {
    const pg = Knex({ client: 'pg' });
    // `_timeout` / `_cancelOnTimeout` are Knex's own internal builder fields (set
    // by `QueryBuilder#timeout`), not part of its public typings — read through
    // `any`, which is the only way to observe that cancellation was requested.
    const query = applyQueryTimeout(pg('orders'), 1000) as unknown as Record<string, unknown>;
    /* eslint-disable no-underscore-dangle */
    expect(query._timeout).toBe(1000);
    expect(query._cancelOnTimeout).toBe(true);
    /* eslint-enable no-underscore-dangle */
  });
});
