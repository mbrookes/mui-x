/**
 * Regression test for finding 2.2 — `handleMutation` must invalidate the SAME
 * default cache singleton `handleBatchQuery` populates when no `cacheProvider`
 * is supplied.
 *
 * Before the fix, `handler.ts` held a module-private `getDefaultCache()`
 * singleton unreachable from `handleMutation`, so a zero-config host — the
 * simplest possible integration, passing no `cacheProvider` to either handler —
 * got reads cached but NEVER invalidated after a write: `handleMutation` had no
 * default cache to call `deleteByTag` against. The fix centralizes the
 * singleton in `cache/defaultProviders.ts`, imported by both handlers.
 *
 * This test drives the real end-to-end sequence the finding describes: read
 * (cached) → mutate (insert) → read again, all with NO `cacheProvider` passed
 * to either handler, and asserts the second read observes the mutation instead
 * of returning the stale cached rows.
 */
import { describe, it, expect } from 'vitest';
import { STUDIO_DATA_WIRE_VERSION } from '@mui/x-studio-schema';
import { handleBatchQuery } from '../handler';
import { handleMutation } from '../mutations/handleMutation';
import type { BatchQueryRequest, BatchMutationRequest, JwtSecurityClaims } from '../security/types';
import { assertTimeoutArgs, rowKeyOf, sqlValueEquals, wherePredicate } from './mockDb';

process.env.JWT_SECRET ??= 'default-cache-sharing-test-secret';

const CLAIMS: JwtSecurityClaims = { tenantId: 'acme', userId: 'u1', roleIds: ['analyst'] };
const SINGLE_TENANT = { mode: 'single-tenant' } as const;

// A minimal mutable in-memory Knex stand-in supporting exactly the calls this
// package's read (`buildSecureQuery` + preflight `count`/`first`) and write
// (`insert`) paths issue for a simple, column-less, filter-less, join-less
// widget/mutation — enough to drive the real handlers end-to-end without a
// real DB, while sharing ONE mutable `tables` object between both handlers'
// `db` calls so a mutation is actually observable by a subsequent read.
function createSharedMutableDb(initialRows: Record<string, unknown>[]) {
  const tables: Record<string, Record<string, unknown>[]> = {
    default_cache_regression: initialRows.map((r) => ({ ...r })),
  };

  return function db(table: string) {
    const predicates: Array<(row: Record<string, unknown>) => boolean> = [];
    let pendingInsert: Record<string, unknown> | null = null;
    let countAlias: string | null = null;

    const qb: any = {
      // `wherePredicate` models the OPERATOR (and fails closed on one it does
      // not implement). This double used to DISCARD it, so `!=`, `<`, `>` and
      // `like` all silently became equality.
      where(column: string, opOrValue: unknown, value?: unknown) {
        predicates.push(wherePredicate(column, opOrValue, value));
        return qb;
      },
      whereIn(column: string, values: unknown[]) {
        const key = rowKeyOf(column);
        predicates.push((row) => values.some((v) => sqlValueEquals(row[key], v)));
        return qb;
      },
      insert(values: Record<string, unknown>) {
        pendingInsert = values;
        return qb;
      },
      count(expr: string) {
        const parts = expr.split(' as ');
        countAlias = parts[1]?.trim() ?? 'count';
        return qb;
      },
      // `executeForTier` now applies an effective LIMIT unconditionally (a
      // server-side cap regardless of whether the descriptor specifies one).
      // This mock doesn't exercise limit/pagination behavior, so it's a no-op —
      // just needs to exist so the chained `.limit()` call doesn't throw.
      limit() {
        return qb;
      },
      // Knex exposes its dialect client on the builder; `applyQueryTimeout` reads
      // `client.canCancelQuery` to gate query cancellation.
      client: { canCancelQuery: false },
      // Knex's per-query statement timeout (F2) — this mock resolves
      // synchronously, so there is nothing to time out, but its ARGUMENTS are
      // checked so a dropped timeout cannot pass as an applied one.
      timeout(ms: number, opts?: { cancel?: boolean }) {
        assertTimeoutArgs('createSharedMutableDb', ms, opts);
        return qb;
      },
      async first() {
        tables[table] ??= [];
        const rows = tables[table].filter((r) => predicates.every((p) => p(r)));
        return { [countAlias ?? 'count']: rows.length };
      },
      then(resolve: (v: unknown) => void, reject?: (err: Error) => void) {
        try {
          tables[table] ??= [];
          if (pendingInsert !== null) {
            tables[table].push({ ...pendingInsert });
            resolve([tables[table].length]);
            return;
          }
          const rows = tables[table].filter((r) => predicates.every((p) => p(r)));
          resolve(rows);
        } catch (err) {
          reject?.(err as Error);
        }
      },
    };
    return qb;
  };
}

describe('default-cache sharing between handleBatchQuery and handleMutation (finding 2.2)', () => {
  it('a mutation with no cacheProvider invalidates the read path default cache, so a subsequent read observes the write', async () => {
    const db = createSharedMutableDb([{ id: 1, status: 'pending' }]);
    const readBody: BatchQueryRequest = {
      protocolVersion: STUDIO_DATA_WIRE_VERSION,
      pageId: 'p1',
      widgets: [{ id: 'w1', table: 'default_cache_regression' }],
    };

    // 1. First read — populates the default (zero-config) data cache.
    const first = await handleBatchQuery(readBody, CLAIMS, {
      db,
      schemaAllowlist: ['default_cache_regression'],
      tenancy: SINGLE_TENANT,
      // NO cacheProvider — exercises the module-singleton default.
    });
    expect(first.results[0].rows).toHaveLength(1);

    // 2. Mutate the SAME table — NO cacheProvider passed to handleMutation either.
    const mutationBody: BatchMutationRequest = {
      mutations: [
        {
          id: 'm1',
          operation: 'insert',
          table: 'default_cache_regression',
          values: { id: 2, status: 'new' },
        },
      ],
    };
    const mutationResult = await handleMutation(mutationBody, CLAIMS, {
      db,
      schemaAllowlist: ['default_cache_regression'],
      tenancy: SINGLE_TENANT,
      // NO cacheProvider — this is the exact zero-config shape finding 2.2 flags.
    });
    expect(mutationResult.results[0].ok).toBe(true);

    // 3. Second read, immediately after — WITHOUT the fix this would return the
    // stale 1-row cached result (well within the 30s default TTL) because
    // `handleMutation` had no default cache to invalidate. WITH the fix, both
    // handlers share the same singleton, so the insert's `deleteByTag` evicted
    // the entry and this read re-queries the DB.
    const second = await handleBatchQuery(readBody, CLAIMS, {
      db,
      schemaAllowlist: ['default_cache_regression'],
      tenancy: SINGLE_TENANT,
    });
    expect(second.results[0].rows).toHaveLength(2);
  });
});
