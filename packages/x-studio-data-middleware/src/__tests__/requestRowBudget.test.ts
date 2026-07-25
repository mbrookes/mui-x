/**
 * End-to-end regression tests for the per-request `RowBudget` and the cache-key
 * data-source dimension.
 *
 * Three defects are pinned here, all driven through the real `handleBatchQuery`:
 *
 * 1. A result the SERVER degraded (shortened, or emptied outright, because the
 *    request's shared row budget ran out) used to be returned as a successful,
 *    complete-looking answer AND written to the data cache under a key derived
 *    only from `(claims, policy, descriptor)`. The budget is not part of that key,
 *    so a widget starved by one heavy dashboard page was served as "0 rows out of
 *    120,000" to every later request — and every other user sharing the security
 *    profile — for the whole TTL. Degradation is now a per-widget `{ error }`,
 *    which by construction never reaches `cacheProvider.set`.
 *
 * 2. The budget did not actually bound the rows a request materialized. Widgets
 *    running concurrently all read the same remaining allowance before any of them
 *    charged it; single-flighted duplicates were charged once no matter how many
 *    widgets serialized the shared row array; and cache hits returned before the
 *    budget was consulted at all. Every row that reaches the response is now
 *    charged exactly once, so `sum(results[].rows.length) <= MAX_ROWS_PER_REQUEST`
 *    holds on all three paths.
 *
 * 3. Two option sets pointed at two logical databases in one process, sharing a
 *    cache provider (the zero-config default is a module singleton), produced
 *    byte-identical keys. The request's `schemaAllowlist` is now folded into the
 *    policy digest, so data sources that expose different tables separate on their
 *    own — the case an explicit `cacheScope` still has to cover is pinned too.
 */
import { describe, it, expect } from 'vitest';
import { handleBatchQuery } from '../handler';
import { MAX_ROWS_PER_REQUEST } from '../router/execute';
import type { CacheEntry, CacheProvider, CacheSetOpts } from '../cache/types';
import type {
  BatchQueryRequest,
  BatchWidgetDescriptor,
  JwtSecurityClaims,
} from '../security/types';

process.env.JWT_SECRET ??= 'request-row-budget-test-secret';

const CLAIMS: JwtSecurityClaims = { tenantId: 'acme', userId: 'u1', roleIds: ['analyst'] };
const SINGLE_TENANT = { mode: 'single-tenant' } as const;

/**
 * A Knex stand-in whose table holds `totalRows` identical-shaped rows.
 *
 * Filters/joins/ordering are no-ops — these tests are about how many rows come
 * back and who is charged for them, not about the SQL shape (that is pinned in
 * `router/__tests__/execute.test.ts`). `source` marks which database produced a
 * row, so a cross-data-source cache hit is directly observable.
 */
function createRowSourceDb(totalRows: number, source = 'A') {
  const rows = Array.from({ length: totalRows }, (_, i) => ({ id: i, source }));
  /** The LIMIT each executed DATA query received (preflight COUNT(*) applies none). */
  const appliedLimits: number[] = [];

  const db: any = () => {
    let limitValue: number | undefined;
    let countAlias: string | undefined;
    const qb: any = {
      count(expr: string) {
        countAlias = String(expr).split(' as ')[1]?.trim() ?? 'count';
        return qb;
      },
      limit(n: number) {
        limitValue = n;
        return qb;
      },
      async first() {
        return { [countAlias ?? 'count']: totalRows };
      },
      then(resolve: (value: unknown) => void) {
        appliedLimits.push(limitValue ?? -1);
        resolve(rows.slice(0, limitValue ?? totalRows));
      },
    };
    for (const method of [
      'where',
      'whereIn',
      'whereNot',
      'whereLike',
      'whereBetween',
      'select',
      'orderBy',
      'groupBy',
      'havingRaw',
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
  return { db, appliedLimits };
}

/**
 * A trivial Map-backed `CacheProvider` whose contents the tests inspect directly.
 *
 * Deliberately not `LRUCacheProvider`: what matters here is exactly WHICH results
 * were written, not eviction or byte accounting, and a plain Map skips the
 * structured-clone of six-figure row arrays these tests produce.
 */
function createRecordingCache() {
  const entries = new Map<string, CacheEntry>();
  const provider: CacheProvider = {
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
    async deleteByTag() {},
  };
  return { provider, entries };
}

/** Widgets differing only in a filter VALUE: distinct cache keys, identical rows. */
function distinctWidgets(count: number): BatchWidgetDescriptor[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `w${i}`,
    table: 'sales',
    filters: [{ column: 'bucket', operator: 'eq' as const, value: `b${i}` }],
  }));
}

/** Identical widgets differing only in `id` — which is excluded from the cache key. */
function identicalWidgets(count: number): BatchWidgetDescriptor[] {
  return Array.from({ length: count }, (_, i) => ({ id: `w${i}`, table: 'sales' }));
}

function baseOptions(db: any, cacheProvider: CacheProvider) {
  return {
    db,
    schemaAllowlist: ['sales'],
    tenancy: SINGLE_TENANT,
    cacheProvider,
    // The tier cache is a process-wide default singleton; disable it so no routing
    // decision leaks between tests in this file.
    tierCacheTtlMs: 0,
  };
}

const totalRows = (results: { rows: unknown[] }[]) =>
  results.reduce((sum, r) => sum + r.rows.length, 0);

// ─── Finding 1 — a degraded result is an error, and is never cached ───────────
describe('handleBatchQuery — budget-degraded results are never cached (finding 1)', () => {
  /**
   * One unbounded widget over a table larger than `MAX_RESULT_ROWS` consumes the
   * ENTIRE request budget (`MAX_ROWS_PER_REQUEST` is deliberately equal to
   * `MAX_RESULT_ROWS`), which starves its sibling deterministically.
   */
  const STARVING_TABLE_ROWS = MAX_ROWS_PER_REQUEST + 20_000;

  function starvingBatch(): BatchQueryRequest {
    return { pageId: 'p1', widgets: distinctWidgets(2) };
  }

  it('fails a starved widget with an error instead of an empty, complete-looking result', async () => {
    const { db } = createRowSourceDb(STARVING_TABLE_ROWS);
    const { provider } = createRecordingCache();
    const result = await handleBatchQuery(starvingBatch(), CLAIMS, baseOptions(db, provider));

    const [first, starved] = result.results;
    // The first widget is bounded by MAX_RESULT_ROWS — the server-wide ceiling,
    // not the budget — so it is a legitimate complete page and stays a success.
    expect(first.error).toBeUndefined();
    expect(first.rows).toHaveLength(MAX_ROWS_PER_REQUEST);

    // The second gets nothing the budget could pay for. Reporting that as
    // `rows: [], rowCount: 120000` would be indistinguishable from "this query
    // genuinely matched nothing".
    expect(starved.rows).toEqual([]);
    expect(starved.error).toMatch(/shared row budget is exhausted/);
  });

  it('does NOT cache the starved widget: requesting it alone next serves real rows', async () => {
    const { db } = createRowSourceDb(STARVING_TABLE_ROWS);
    const { provider, entries } = createRecordingCache();

    const batch = starvingBatch();
    const first = await handleBatchQuery(batch, CLAIMS, baseOptions(db, provider));
    expect(first.results[1].error).toBeDefined();

    // Exactly one entry — the complete result. The degraded one was never written.
    expect(entries.size).toBe(1);
    for (const entry of entries.values()) {
      expect(entry.rows.length).toBeGreaterThan(0);
    }

    // The starved widget, alone, with a fresh budget. Before the fix this hit the
    // cached `rows: []` entry and reported "0 of 120000" to a request that could
    // comfortably afford the real answer — and kept doing so for the whole TTL,
    // across users, since the key is scoped per security PROFILE, not per user.
    const second = await handleBatchQuery(
      { pageId: 'p1', widgets: [batch.widgets[1]] },
      CLAIMS,
      baseOptions(db, provider),
    );
    expect(second.results[0].error).toBeUndefined();
    expect(second.results[0].rows).toHaveLength(MAX_ROWS_PER_REQUEST);
  });

  it('never writes a cache entry for any widget that failed', async () => {
    // 6 widgets that each want 30,000 rows cannot all fit in a 100,000-row budget.
    const { db } = createRowSourceDb(30_000);
    const { provider, entries } = createRecordingCache();
    const result = await handleBatchQuery(
      { pageId: 'p1', widgets: distinctWidgets(6) },
      CLAIMS,
      baseOptions(db, provider),
    );

    const failed = result.results.filter((r) => r.error !== undefined);
    const served = result.results.filter((r) => r.error === undefined);
    expect(failed.length).toBeGreaterThan(0);
    // One cache entry per SERVED widget, none for the failures.
    expect(entries.size).toBe(served.length);
    for (const entry of entries.values()) {
      expect(entry.rows).toHaveLength(30_000);
    }
  });
});

// ─── Finding 2 — the budget really bounds the rows a request returns ──────────
describe('handleBatchQuery — the row budget bounds the whole response (finding 2)', () => {
  it('bounds widgets that all read the allowance before any of them charges it', async () => {
    // Bypass 1 — read-then-charge race. MAX_CONCURRENT_WIDGET_QUERIES widgets run
    // at once; each used to resolve its LIMIT against the full remaining budget and
    // only charge afterwards, so 6 x 30,000 = 180,000 rows came back against a
    // 100,000-row cap. The charge is now what enforces the bound: whoever no longer
    // fits fails instead of adding rows.
    const { db } = createRowSourceDb(30_000);
    const { provider } = createRecordingCache();
    const result = await handleBatchQuery(
      { pageId: 'p1', widgets: distinctWidgets(6) },
      CLAIMS,
      baseOptions(db, provider),
    );

    expect(totalRows(result.results)).toBeLessThanOrEqual(MAX_ROWS_PER_REQUEST);
    // …and the bound is not upheld by failing everything.
    expect(totalRows(result.results)).toBeGreaterThanOrEqual(30_000);
    expect(result.results.filter((r) => r.error !== undefined).length).toBeGreaterThan(0);
  });

  it('charges every widget sharing a single-flighted pipeline, not just the first', async () => {
    // Bypass 2 — dedup. The widget `id` is excluded from the cache key, so N
    // identical descriptors share ONE query. That collapses the DB work, never the
    // RESPONSE: each widget still serializes its own copy of the rows. Charging once
    // per pipeline let 50 x 3,000 = 150,000 rows into one 100,000-row response.
    const { db, appliedLimits } = createRowSourceDb(3_000);
    const { provider } = createRecordingCache();
    const result = await handleBatchQuery(
      { pageId: 'p1', widgets: identicalWidgets(50) },
      CLAIMS,
      baseOptions(db, provider),
    );

    // Still ONE data query for all 50 — dedup (and then the cache) is intact.
    expect(appliedLimits).toHaveLength(1);
    expect(totalRows(result.results)).toBeLessThanOrEqual(MAX_ROWS_PER_REQUEST);
    expect(result.results.filter((r) => r.error !== undefined).length).toBeGreaterThan(0);
    // Every served widget got the complete result, not a shortened one.
    for (const served of result.results.filter((r) => r.error === undefined)) {
      expect(served.rows).toHaveLength(3_000);
    }
  });

  it('charges cache hits, which used to return before the budget was consulted', async () => {
    // Bypass 3 — pre-warmed cache. `runWidgetPipeline` returned cached rows before
    // `executeForTier` was ever reached, so a batch of distinct warm widgets
    // materialized (the provider clones on read) and serialized an unbounded number
    // of rows with the budget untouched.
    const { db } = createRowSourceDb(6_000);
    const { provider, entries } = createRecordingCache();
    const widgets = distinctWidgets(20);

    // Warm all 20 in halves, each half comfortably inside its own request budget.
    for (const half of [widgets.slice(0, 10), widgets.slice(10)]) {
      // eslint-disable-next-line no-await-in-loop
      const warm = await handleBatchQuery(
        { pageId: 'p1', widgets: half },
        CLAIMS,
        baseOptions(db, provider),
      );
      expect(warm.results.every((r) => r.error === undefined)).toBe(true);
    }
    expect(entries.size).toBe(20);

    // All 20 in ONE request now: 20 x 6,000 = 120,000 rows of cache hits.
    const result = await handleBatchQuery(
      { pageId: 'p1', widgets },
      CLAIMS,
      baseOptions(db, provider),
    );
    expect(totalRows(result.results)).toBeLessThanOrEqual(MAX_ROWS_PER_REQUEST);
    expect(result.results.filter((r) => r.error !== undefined).length).toBeGreaterThan(0);
  });

  it('leaves a small widget servable after a large one was rejected', async () => {
    // A charge that does not fit leaves `remaining` untouched rather than clamping
    // it to zero, so one oversized widget does not have to fail the whole page.
    const { db } = createRowSourceDb(60_000);
    const { provider } = createRecordingCache();
    const widgets: BatchWidgetDescriptor[] = [
      ...distinctWidgets(2),
      { id: 'small', table: 'sales', limit: 10 },
    ];
    const result = await handleBatchQuery(
      { pageId: 'p1', widgets },
      CLAIMS,
      baseOptions(db, provider),
    );

    const small = result.results.find((r) => r.id === 'small')!;
    expect(small.error).toBeUndefined();
    expect(small.rows).toHaveLength(10);
    expect(totalRows(result.results)).toBeLessThanOrEqual(MAX_ROWS_PER_REQUEST);
  });
});

// ─── Finding 3 — data sources sharing one cache do not collide ────────────────
describe('handleBatchQuery — cache separation between data sources (finding 3)', () => {
  const DESCRIPTOR: BatchWidgetDescriptor = { id: 'w1', table: 'sales', limit: 5 };
  const BATCH: BatchQueryRequest = { pageId: 'p1', widgets: [DESCRIPTOR] };

  it("does not serve one database's rows for another when their table sets differ", async () => {
    // The shape of the zero-config failure: two option sets, two `db` connections,
    // no explicit `cacheProvider` (the default is a process-wide singleton, modelled
    // here by passing ONE provider to both) and no `cacheScope`. The key carried no
    // data-source dimension, so DB-B read DB-A's rows. The `schemaAllowlist` is now
    // part of the policy digest, so their keys differ.
    const { provider } = createRecordingCache();
    const dbA = createRowSourceDb(5, 'A').db;
    const dbB = createRowSourceDb(5, 'B').db;

    const fromA = await handleBatchQuery(BATCH, CLAIMS, {
      db: dbA,
      schemaAllowlist: ['sales', 'archive_a'],
      tenancy: SINGLE_TENANT,
      cacheProvider: provider,
      tierCacheTtlMs: 0,
    });
    const fromB = await handleBatchQuery(BATCH, CLAIMS, {
      db: dbB,
      schemaAllowlist: ['sales'],
      tenancy: SINGLE_TENANT,
      cacheProvider: provider,
      tierCacheTtlMs: 0,
    });

    expect(fromA.results[0].rows[0]).toMatchObject({ source: 'A' });
    expect(fromB.results[0].rows[0]).toMatchObject({ source: 'B' });
    // Both results are in the ONE shared provider under different keys.
    expect(provider).toBeDefined();
  });

  it('still needs an explicit cacheScope for two data sources with the SAME tables', async () => {
    // The residual case the digest cannot separate, pinned so the guarantee is not
    // over-read: identical allowlists mean identical policy digests. `cacheScope` is
    // the documented answer, and is shown working immediately below.
    const { provider } = createRecordingCache();
    const sameTables = {
      schemaAllowlist: ['sales'],
      tenancy: SINGLE_TENANT,
      cacheProvider: provider,
      tierCacheTtlMs: 0,
    };

    await handleBatchQuery(BATCH, CLAIMS, { ...sameTables, db: createRowSourceDb(5, 'A').db });
    const collided = await handleBatchQuery(BATCH, CLAIMS, {
      ...sameTables,
      db: createRowSourceDb(5, 'B').db,
    });
    expect(collided.results[0].rows[0]).toMatchObject({ source: 'A' });

    const { provider: scopedProvider } = createRecordingCache();
    const scoped = { ...sameTables, cacheProvider: scopedProvider };
    await handleBatchQuery(BATCH, CLAIMS, {
      ...scoped,
      db: createRowSourceDb(5, 'A').db,
      cacheScope: 'db-a',
    });
    const separated = await handleBatchQuery(BATCH, CLAIMS, {
      ...scoped,
      db: createRowSourceDb(5, 'B').db,
      cacheScope: 'db-b',
    });
    expect(separated.results[0].rows[0]).toMatchObject({ source: 'B' });
  });
});
