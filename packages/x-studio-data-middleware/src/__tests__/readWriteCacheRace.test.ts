/**
 * Regression tests for the read-in-flight-across-a-mutation race.
 *
 * `handleMutation`'s invalidation is documented as precise and unconditional —
 * "a successful mutation _always_ invalidates" — with staleness bounded by the
 * TTL only in the explicit FAILURE case (a throwing `deleteByTag`). One ordering
 * broke that on the success path, entirely through public entry points:
 *
 *   1. `handleBatchQuery` executes its SELECT and gets PRE-mutation rows.
 *   2. `handleMutation` commits, then `deleteByTag(table)` — the read's cache key
 *      does not exist yet, so nothing is evicted.
 *   3. The read finishes and WRITES those now-stale rows under that key, tagged
 *      with that table.
 *   4. Every reader sharing the security profile is served pre-mutation rows for
 *      the whole TTL (LRU 30s, Redis 60s).
 *
 * Not a cross-tenant issue — RLS predicates are applied at query time, so the
 * stale rows are always in scope for whoever reads them. It is staleness.
 *
 * The codebase already recognised this hazard shape in the atomic path
 * ("evicting inside the transaction would let a concurrent read re-cache rows
 * that are about to roll back") and closed the PRE-commit direction; these tests
 * pin the symmetric POST-commit direction, on the per-item path.
 *
 * The fix is a per-tag invalidation epoch: `runWidgetPipeline` timestamps itself
 * before executing and asks the provider, via the optional
 * `CacheProvider.wereTagsInvalidatedSince`, whether any of the entry's tags was
 * invalidated since — skipping the `set()` if so.
 */
import { describe, it, expect } from 'vitest';
import { handleBatchQuery } from '../handler';
import { handleMutation } from '../mutations/handleMutation';
import { LRUCacheProvider } from '../cache/LRUCacheProvider';
import type { CacheEntry, CacheProvider, CacheSetOpts } from '../cache/types';
import type { BatchQueryRequest, BatchMutationRequest, JwtSecurityClaims } from '../security/types';

process.env.JWT_SECRET ??= 'read-write-cache-race-test-secret';

const CLAIMS: JwtSecurityClaims = { tenantId: 'acme', userId: 'u1', roleIds: ['analyst'] };
const SINGLE_TENANT = { mode: 'single-tenant' } as const;
const TABLE = 'race_regression';

const READ_BODY: BatchQueryRequest = { pageId: 'p1', widgets: [{ id: 'w1', table: TABLE }] };
const MUTATION_BODY: BatchMutationRequest = {
  mutations: [{ id: 'm1', operation: 'insert', table: TABLE, values: { id: 2, status: 'new' } }],
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * A mutable in-memory Knex stand-in (same minimal surface as
 * `defaultCacheSharing.test.ts`) whose FIRST plain SELECT is held open.
 *
 * The held query snapshots its rows at ISSUE time and only resolves once
 * `releaseSelect()` is called, which is exactly the real race: the database read
 * observed pre-mutation state, and the process is still holding those rows when
 * the mutation commits and invalidates.
 */
function createGatedDb(initialRows: Record<string, unknown>[]) {
  const tables: Record<string, Record<string, unknown>[]> = {
    [TABLE]: initialRows.map((r) => ({ ...r })),
  };
  const issued = deferred();
  const release = deferred();
  let gateArmed = true;

  function db(table: string) {
    const predicates: Array<(row: Record<string, unknown>) => boolean> = [];
    let pendingInsert: Record<string, unknown> | null = null;
    let countAlias: string | null = null;

    const qb: any = {
      where(column: string, opOrValue: unknown, value?: unknown) {
        const key = column.includes('.') ? column.split('.').pop()! : column;
        predicates.push((row) => row[key] === (value !== undefined ? value : opOrValue));
        return qb;
      },
      whereIn(column: string, values: unknown[]) {
        const key = column.includes('.') ? column.split('.').pop()! : column;
        predicates.push((row) => values.includes(row[key]));
        return qb;
      },
      insert(values: Record<string, unknown>) {
        pendingInsert = values;
        return qb;
      },
      count(expr: string) {
        countAlias = expr.split(' as ')[1]?.trim() ?? 'count';
        return qb;
      },
      limit() {
        return qb;
      },
      // Knex's per-query statement timeout (F2) — accepted and ignored; this mock
      // resolves synchronously, so there is nothing to time out.
      timeout() {
        return qb;
      },
      async first() {
        tables[table] ??= [];
        return {
          [countAlias ?? 'count']: tables[table].filter((r) => predicates.every((p) => p(r)))
            .length,
        };
      },
      then(resolve: (v: unknown) => void, reject?: (err: Error) => void) {
        try {
          tables[table] ??= [];
          if (pendingInsert !== null) {
            tables[table].push({ ...pendingInsert });
            resolve([tables[table].length]);
            return;
          }
          // Snapshot NOW — before the gate opens — so the rows this query
          // resolves with are the ones the database really returned.
          const rows = tables[table].filter((r) => predicates.every((p) => p(r)));
          if (gateArmed) {
            gateArmed = false;
            issued.resolve();
            release.promise.then(() => resolve(rows));
            return;
          }
          resolve(rows);
        } catch (err) {
          reject?.(err as Error);
        }
      },
    };
    return qb;
  }

  return { db, selectIssued: issued.promise, releaseSelect: release.resolve };
}

/**
 * Drive the interleaving: hold a read's SELECT open, commit + invalidate a
 * mutation underneath it, then let the read finish and try to populate the
 * cache. Returns how many rows a FRESH read sees afterwards — 2 means the
 * committed insert is visible, 1 means the stale pre-mutation rows were cached.
 */
async function runRace(cacheProvider: CacheProvider) {
  const { db, selectIssued, releaseSelect } = createGatedDb([{ id: 1, status: 'pending' }]);
  const options = {
    db,
    schemaAllowlist: [TABLE],
    tenancy: SINGLE_TENANT,
    cacheProvider,
    // The tier cache is a process-wide singleton; keep this test's routing
    // decisions out of it.
    tierCacheTtlMs: 0,
  };

  const readPromise = handleBatchQuery(READ_BODY, CLAIMS, options);
  await selectIssued;

  const mutation = await handleMutation(MUTATION_BODY, CLAIMS, {
    db,
    schemaAllowlist: [TABLE],
    tenancy: SINGLE_TENANT,
    cacheProvider,
  });
  expect(mutation.results[0].ok).toBe(true);

  releaseSelect();
  const raced = await readPromise;
  // The racing read legitimately returns what its query saw: the pre-mutation
  // row. That is not the defect — the defect is what it leaves behind.
  expect(raced.results[0].rows).toHaveLength(1);

  const after = await handleBatchQuery(READ_BODY, CLAIMS, options);
  return after.results[0].rows.length;
}

describe('a read in flight across a mutation must not re-cache pre-mutation rows', () => {
  it('does not serve pre-mutation rows after the mutation committed (LRUCacheProvider)', async () => {
    // Without the epoch check the racing read's `set()` landed AFTER
    // `deleteByTag`, so this second read hit a cache entry that predates a
    // committed write and reported 1 row for the full 30s TTL.
    expect(await runRace(new LRUCacheProvider())).toBe(2);
  });

  it('keeps the pre-existing behavior for a provider that does not implement the optional hook', async () => {
    // `CacheProvider` is host-pluggable, so `wereTagsInvalidatedSince` is
    // OPTIONAL: making it required would break every host implementation on a
    // patch upgrade. This pins the documented fallback — a provider without it
    // still races, exactly as before — so the guarantee is not over-read, and so
    // it is visible that the hook is what does the work above.
    const entries = new Map<string, CacheEntry>();
    const legacy: CacheProvider = {
      async get(key) {
        return entries.get(key);
      },
      async set(key, value, _opts?: CacheSetOpts) {
        entries.set(key, value);
      },
      async invalidatePrefix(prefix) {
        for (const key of [...entries.keys()]) {
          if (key.startsWith(prefix)) {
            entries.delete(key);
          }
        }
      },
      async deleteByTag() {
        entries.clear();
      },
    };
    expect(await runRace(legacy)).toBe(1);
  });
});
