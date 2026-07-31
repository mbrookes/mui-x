/**
 * Integration tests for @mui/x-studio-data-middleware
 *
 * Tests the full pipeline: security extraction → cache key → query building
 * → tier selection → handler output. Uses a lightweight in-memory mock Knex
 * builder (no native module dependencies).
 */
import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { handleBatchQuery, MAX_CONCURRENT_WIDGET_QUERIES, MAX_WIDGETS_PER_BATCH } from '../handler';
import { MAX_ROWS_PER_REQUEST } from '../router/execute';
import {
  MAX_ARRAY_ITEMS_PER_DESCRIPTOR,
  MAX_PREDICATE_VALUES_PER_DESCRIPTOR,
  MAX_STRING_LENGTH,
  MAX_STRING_VALUE_LENGTH,
} from '../shared/limits';
import { generateCacheKey } from '../security/cacheKey';
import { compileSecurityPolicy } from '../security/compileSecurityPolicy';
import { extractSecurityClaims } from '../security/extractSecurityClaims';
import { LRUCacheProvider } from '../cache/LRUCacheProvider';
import { MapTierCacheProvider } from '../cache/MapTierCacheProvider';
import { TIER_CACHE_KEY_PREFIX } from '../router/tierDecision';
import type { JwtSecurityClaims, BatchQueryRequest } from '../security/types';
import { createMockDb } from './mockDb';

// The handler computes cache keys via generateCacheKey(), which now fails closed
// when no HMAC secret is configured. Provide one for the whole test file.
process.env.JWT_SECRET ??= 'handler-test-hmac-secret';

// ─── Test data ────────────────────────────────────────────────────────────────

const SALES_ROWS = [
  {
    id: 1,
    tenant_id: 'acme',
    region: 'west',
    product: 'widget',
    amount: 100,
    sale_date: '2024-01-15',
  },
  {
    id: 2,
    tenant_id: 'acme',
    region: 'east',
    product: 'gadget',
    amount: 200,
    sale_date: '2024-01-16',
  },
  {
    id: 3,
    tenant_id: 'acme',
    region: 'west',
    product: 'widget',
    amount: 150,
    sale_date: '2024-02-01',
  },
  {
    id: 4,
    tenant_id: 'globex',
    region: 'north',
    product: 'thingamajig',
    amount: 500,
    sale_date: '2024-01-20',
  },
  {
    id: 5,
    tenant_id: 'acme',
    region: 'north',
    product: 'gadget',
    amount: 75,
    sale_date: '2024-02-15',
  },
];

const ACME_CLAIMS: JwtSecurityClaims = {
  tenantId: 'acme',
  userId: 'user-123',
  roleIds: ['analyst'],
};

const GLOBEX_CLAIMS: JwtSecurityClaims = {
  tenantId: 'globex',
  userId: 'user-456',
  roleIds: ['analyst'],
};

// Tenancy is now a required, explicit decision on every options object. Tests that
// configure a tenant column use MULTI_TENANT; tests that configure none declare
// SINGLE_TENANT explicitly (the same unscoped behavior, now stated rather than
// silently implied by omission).
const MULTI_TENANT = { mode: 'multi-tenant', tenantColumn: 'tenant_id' } as const;
const SINGLE_TENANT = { mode: 'single-tenant' } as const;

/**
 * The policy digest the handler compiles for the single-tenant, `['sales']`-only
 * options used throughout this file.
 *
 * `handleBatchQuery` folds its `schemaAllowlist` into the compiled policy digest
 * and the digest into the cache key (finding 3 — it is what separates two data
 * sources sharing one cache provider), so a test that recomputes a key by hand
 * must compile the same policy the handler did rather than relying on
 * `generateCacheKey`'s single-tenant default digest.
 */
const SALES_POLICY_DIGEST = compileSecurityPolicy({
  tenancy: SINGLE_TENANT,
  schemaAllowlist: ['sales'],
}).digest;

function makeDb() {
  return createMockDb({ sales: SALES_ROWS });
}

/** One recorded call on a join's ON-clause builder. */
interface RecordedOnCall {
  method: 'on' | 'andOnVal' | 'andOnIn';
  args: unknown[];
}

/**
 * Install Knex-shaped join support on a mock query builder that ACTUALLY INVOKES
 * the join callback (finding: the join stubs in this file were `qb.join = () =>
 * qb`, which silently discarded it).
 *
 * `buildSecureQuery` passes every join as `join(table, function () { this.on(...) })`,
 * and that callback is where `applySecurityPredicatesToJoinOn` places the
 * outer-join security predicates — the whole point of the ON-vs-WHERE placement
 * fix. A stub that drops the callback means NONE of that code runs, so a test
 * claiming to "verify the full code path runs" verified nothing about it.
 * `router/__tests__/queryBuilder.test.ts` covers the branch against real Knex;
 * what was missing here is the handler-level composition (compiled policy → query
 * plan → builder) reaching a real ON clause.
 *
 * The recorded calls are appended to `calls` so a test can assert what the ON
 * clause actually contained. Mirrors `createRecordingDb`'s `joinCtx` in
 * `router/__tests__/queryBuilder.test.ts`.
 */
function installRecordingJoins(qb: any, calls: RecordedOnCall[]): void {
  const onCtx = {
    on(...args: unknown[]) {
      calls.push({ method: 'on', args });
      return onCtx;
    },
    andOnVal(...args: unknown[]) {
      calls.push({ method: 'andOnVal', args });
      return onCtx;
    },
    andOnIn(...args: unknown[]) {
      calls.push({ method: 'andOnIn', args });
      return onCtx;
    },
  };
  for (const method of ['join', 'leftJoin', 'rightJoin'] as const) {
    qb[method] = (_table: unknown, cb: unknown) => {
      if (typeof cb === 'function') {
        (cb as (this: typeof onCtx) => void).call(onCtx);
      }
      return qb;
    };
  }
}

/**
 * Wrap a `CacheProvider` so every `set()` KEY is recorded, while the underlying
 * provider still behaves normally.
 *
 * Asserting "this result was not cached" by recomputing the key with
 * `generateCacheKey` and expecting `get()` to miss is unreliable: the handler
 * folds a compiled POLICY DIGEST into the key, so a recomputed key that omits it
 * misses whether or not the handler wrote anything. Watching the write itself
 * cannot be fooled by a key mismatch.
 */
function watchCacheWrites(inner: LRUCacheProvider) {
  const setKeys: string[] = [];
  const provider = {
    get: (key: string) => inner.get(key),
    set: (key: string, ...rest: unknown[]) => {
      setKeys.push(key);
      return (inner.set as any)(key, ...rest);
    },
    invalidatePrefix: (prefix: string) => inner.invalidatePrefix(prefix),
    deleteByTag: (tag: string) => inner.deleteByTag(tag),
  } as never as LRUCacheProvider;
  return { provider, setKeys, inner };
}

/**
 * Assert that a batch produced a per-widget `{ error }` result at `index` (rows
 * empty, error matching `pattern`) rather than rejecting the whole batch.
 *
 * Client-input validation — table allowlist + query-plan validation (HAVING /
 * aggregation & output aliases / ORDER BY direction / column allowlist) — runs
 * per widget INSIDE `processWidget`'s try/catch (finding 2.1), so a single bad
 * widget yields its own error result and `handleBatchQuery` still RESOLVES. These
 * used to be `.rejects.toThrow(...)` assertions on a whole-batch rejection.
 */
async function expectWidgetError(
  pending: ReturnType<typeof handleBatchQuery>,
  pattern: RegExp | string,
  index = 0,
): Promise<void> {
  const result = await pending;
  expect(result.results[index].rows).toEqual([]);
  expect(result.results[index].error).toMatch(pattern);
}

// ─── generateCacheKey ─────────────────────────────────────────────────────────

describe('generateCacheKey', () => {
  const SECRET = 'test-hmac-secret';

  it('produces different keys for different tenants', () => {
    const descriptor = { id: 'w1', table: 'sales' };
    const key1 = generateCacheKey(ACME_CLAIMS, descriptor, SECRET);
    const key2 = generateCacheKey(GLOBEX_CLAIMS, descriptor, SECRET);
    expect(key1).not.toBe(key2);
  });

  it('produces the same key for identical claims and descriptor', () => {
    const descriptor = { id: 'w1', table: 'sales', columns: ['amount', 'region'] };
    const key1 = generateCacheKey(ACME_CLAIMS, descriptor, SECRET);
    const key2 = generateCacheKey(ACME_CLAIMS, descriptor, SECRET);
    expect(key1).toBe(key2);
  });

  it('produces the SAME key for different widget ids with identical query shape', () => {
    // Two widgets querying the same table/columns/filters share one cache entry
    const key1 = generateCacheKey(ACME_CLAIMS, { id: 'w1', table: 'sales' }, SECRET);
    const key2 = generateCacheKey(ACME_CLAIMS, { id: 'w2', table: 'sales' }, SECRET);
    expect(key1).toBe(key2);
  });

  it('key format is studio:v1:<tenant>:<securityHash>:<queryHash>', () => {
    const key = generateCacheKey(ACME_CLAIMS, { id: 'w1', table: 'sales' }, SECRET);
    expect(key).toMatch(/^studio:v1:acme:[a-f0-9]{16}:[a-f0-9]{16}$/);
  });

  it('different tables produce different keys', () => {
    const key1 = generateCacheKey(ACME_CLAIMS, { id: 'w1', table: 'sales' }, SECRET);
    const key2 = generateCacheKey(ACME_CLAIMS, { id: 'w1', table: 'orders' }, SECRET);
    expect(key1).not.toBe(key2);
  });
});

// ─── extractSecurityClaims ────────────────────────────────────────────────────

describe('extractSecurityClaims', () => {
  const SECRET = 'test-secret-key';

  // Injects a default, far-future `exp` when the caller's payload does not
  // already declare one — `exp` is a required claim (a token without one is
  // rejected rather than treated as never-expiring), and most tests below
  // exist to exercise other claim behavior, not expiry itself. Pass an
  // explicit `exp` in `payload` to override this default.
  function makeJwt(payload: Record<string, unknown>, secret: string): string {
    const withExp = { exp: Math.floor(Date.now() / 1000) + 3600, ...payload };
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(withExp)).toString('base64url');
    const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
    return `${header}.${body}.${sig}`;
  }

  it('extracts claims from a valid Bearer JWT', () => {
    const token = makeJwt({ sub: 'u1', tenantId: 'acme', roleIds: ['admin'] }, SECRET);
    const claims = extractSecurityClaims(`Bearer ${token}`, SECRET);
    expect(claims.tenantId).toBe('acme');
    expect(claims.userId).toBe('u1');
    expect(claims.roleIds).toEqual(['admin']);
  });

  it('throws on missing Authorization header', () => {
    expect(() => extractSecurityClaims(undefined, SECRET)).toThrow('Missing Authorization header');
  });

  it('throws on wrong scheme', () => {
    expect(() => extractSecurityClaims('Basic dXNlcjpwYXNz', SECRET)).toThrow(
      'must be "Bearer <token>"',
    );
  });

  it('throws on expired JWT', () => {
    const token = makeJwt(
      { sub: 'u1', tenantId: 'acme', exp: Math.floor(Date.now() / 1000) - 10 },
      SECRET,
    );
    expect(() => extractSecurityClaims(`Bearer ${token}`, SECRET)).toThrow('expired');
  });

  it('throws on invalid signature', () => {
    const token = makeJwt({ sub: 'u1', tenantId: 'acme' }, 'wrong-secret');
    expect(() => extractSecurityClaims(`Bearer ${token}`, SECRET)).toThrow(
      'signature verification failed',
    );
  });

  it('throws (fail closed) when the "exp" claim is missing entirely', () => {
    // Built by hand (not via `makeJwt`) so the payload has no "exp" key at all —
    // this used to be silently accepted forever, since the expiry check only ran
    // when `exp` was present. A token without an expiry must now be rejected.
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ sub: 'u1', tenantId: 'acme' })).toString('base64url');
    const sig = createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url');
    const token = `${header}.${body}.${sig}`;
    expect(() => extractSecurityClaims(`Bearer ${token}`, SECRET)).toThrow(/"exp"/);
  });

  it('throws on missing required claims', () => {
    const token = makeJwt({ sub: 'u1' /* no tenantId */ }, SECRET);
    expect(() => extractSecurityClaims(`Bearer ${token}`, SECRET)).toThrow('"tenantId" and "sub"');
  });

  it('includes optional claims when present', () => {
    const token = makeJwt(
      { sub: 'u1', tenantId: 'acme', regionIds: [1, 2], department: 'Sales' },
      SECRET,
    );
    const claims = extractSecurityClaims(`Bearer ${token}`, SECRET);
    expect(claims.regionIds).toEqual([1, 2]);
    expect(claims.department).toBe('Sales');
  });

  it('throws (fail-closed) when the effective secret is empty', () => {
    const token = makeJwt({ sub: 'u1', tenantId: 'acme' }, SECRET);
    expect(() => extractSecurityClaims(`Bearer ${token}`, '')).toThrow(
      /JWT_SECRET is not configured/,
    );
  });

  it('returns a clean auth error (not a RangeError) for a truncated signature', () => {
    // A signature of the wrong length would make timingSafeEqual throw RangeError
    // without the length pre-check. It must surface as a signature failure.
    expect(() => extractSecurityClaims('Bearer aaaa.bbbb.cc', SECRET)).toThrow(
      /signature verification failed/,
    );
  });
});

// ─── handleBatchQuery — fail-closed column allowlist ──────────────────────────

describe('handleBatchQuery — column allowlist is fail-closed', () => {
  // eslint-disable-next-line vitest/expect-expect -- assertions live in the expectWidgetError helper
  it('returns a per-widget error for a referenced table with no entry in the column allowlist', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [{ id: 'w1', table: 'sales', columns: ['region'] }],
    };
    await expectWidgetError(
      handleBatchQuery(body, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: SINGLE_TENANT,
        columnAllowlist: { orders: ['id'] }, // no 'sales' entry
      }),
      /Table "sales" has no entry in the column allowlist/,
    );
  });

  it('supports an explicit "*" wildcard to opt a table out of column checks', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [{ id: 'w1', table: 'sales', columns: ['region', 'amount'] }],
    };
    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: SINGLE_TENANT,
      columnAllowlist: { sales: ['*'] },
    });
    expect(result.results[0].error).toBeUndefined();
  });

  // finding 1.1 — a widget that declares NO columns must not slip past the
  // allowlist as SELECT *. The projection is synthesized from the allowlist, so
  // only the allowlisted columns come back — never the whole row.
  it.each<['omitted' | 'empty', BatchQueryRequest['widgets'][number]]>([
    ['omitted', { id: 'w1', table: 'sales' }],
    ['empty', { id: 'w1', table: 'sales', columns: [] }],
  ])(
    'a NO-columns widget (%s) does not bypass the allowlist (finding 1.1)',
    async (_shape, widget) => {
      const result = await handleBatchQuery({ pageId: 'p1', widgets: [widget] }, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: SINGLE_TENANT,
        columnAllowlist: { sales: ['region', 'amount'] },
        // Use a fresh cache provider (rather than the shared default-cache
        // singleton) so this test is hermetic. This is NOT working around a
        // `columnAllowlist` cache-key gap — `compileSecurityPolicy` folds
        // `columnAllowlist` into `policy.digest`, which threads into
        // `generateCacheKey` (`handler.ts:152`) — it just keeps this test's
        // entries from lingering across runs / sibling tests.
        cacheProvider: new LRUCacheProvider({ ttlMs: 5000 }),
      });
      const rows = result.results[0].rows;
      expect(result.results[0].error).toBeUndefined();
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual(['amount', 'region']);
        // Non-allowlisted columns must NOT leak through the SELECT * hole.
        expect(row).not.toHaveProperty('tenant_id');
        expect(row).not.toHaveProperty('id');
        expect(row).not.toHaveProperty('product');
        expect(row).not.toHaveProperty('sale_date');
      }
    },
  );

  // eslint-disable-next-line vitest/expect-expect -- assertions live in the expectWidgetError helper
  it('rejects a NO-columns widget whose table has no allowlist entry (finding 1.1)', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [{ id: 'w1', table: 'sales' }],
    };
    await expectWidgetError(
      handleBatchQuery(body, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: SINGLE_TENANT,
        columnAllowlist: { orders: ['id'] }, // no 'sales' entry
      }),
      /Table "sales" has no entry in the column allowlist/,
    );
  });

  it('a ["*"] wildcard still opts a NO-columns widget into SELECT *', async () => {
    const result = await handleBatchQuery(
      { pageId: 'p1', widgets: [{ id: 'w1', table: 'sales' }] },
      ACME_CLAIMS,
      {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: SINGLE_TENANT,
        columnAllowlist: { sales: ['*'] },
        cacheProvider: new LRUCacheProvider({ ttlMs: 5000 }),
      },
    );
    const rows = result.results[0].rows;
    expect(rows.length).toBeGreaterThan(0);
    // Explicit opt-out: the full row (incl. non-listed columns) comes back.
    expect(rows[0]).toHaveProperty('tenant_id');
  });

  it('no allowlist + no columns is unchanged (SELECT *)', async () => {
    const result = await handleBatchQuery(
      { pageId: 'p1', widgets: [{ id: 'w1', table: 'sales' }] },
      ACME_CLAIMS,
      {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: SINGLE_TENANT,
        // No columnAllowlist — synthesis is gated on it, so SELECT * is preserved.
        cacheProvider: new LRUCacheProvider({ ttlMs: 5000 }),
      },
    );
    const rows = result.results[0].rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty('tenant_id');
  });

  // eslint-disable-next-line vitest/expect-expect -- assertions live in the expectWidgetError helper
  it('rejects a non-asc/desc ORDER BY direction (finding 1.3)', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          columns: ['region'],
          orderBy: [{ column: 'region', direction: 'asc; drop table sales' as any }],
        },
      ],
    };
    // No columnAllowlist needed — the direction check is unconditional. It runs
    // per widget, so the offending widget gets its own `{ error }` result.
    await expectWidgetError(
      handleBatchQuery(body, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: SINGLE_TENANT,
      }),
      /ORDER BY direction/,
    );
  });

  // eslint-disable-next-line vitest/expect-expect -- assertions live in the expectWidgetError helper
  it('validates both sides of every join.on pair against the allowlist', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          columns: ['region'],
          joins: [{ table: 'customers', on: [['sales.customer_id', 'customers.id']] }],
        },
      ],
    };
    await expectWidgetError(
      handleBatchQuery(body, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales', 'customers'],
        tenancy: SINGLE_TENANT,
        // 'sales' present, but no 'customers' entry → join.on right side is rejected.
        columnAllowlist: { sales: ['region', 'customer_id'] },
      }),
      /Table "customers" has no entry in the column allowlist \(join.on\)/,
    );
  });

  // eslint-disable-next-line vitest/expect-expect -- assertions live in the expectWidgetError helper
  it('validates an UNQUALIFIED join.on right-side column against the JOINED table, not the primary', async () => {
    // Regression: the right side of a join `on` pair conventionally belongs to
    // the JOINED table. An unqualified column allowlisted only on the primary
    // table, but sensitive on the joined table, used to pass validation (checked
    // against the primary allowlist) while Knex resolves it against the joined
    // table at execution time. It must now be validated against `join.table`.
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          columns: ['region'],
          // `id` is allowlisted on `sales` (primary) but NOT on `customers`; as
          // the unqualified RIGHT side it belongs to `customers` and is rejected.
          joins: [{ table: 'customers', on: [['sales.customer_id', 'id']] }],
        },
      ],
    };
    await expectWidgetError(
      handleBatchQuery(body, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales', 'customers'],
        tenancy: SINGLE_TENANT,
        columnAllowlist: { sales: ['region', 'customer_id', 'id'], customers: ['name'] },
      }),
      /Column "id" on table "customers" is not in the column allowlist/,
    );
  });

  // Pins the invariant every alias-resolution call site relies on `resolveAlias`
  // (shared/columnValidation.ts) for: a `columnAliases` entry can only ever
  // RELABEL a column the caller could already reach — it can never make a query
  // touch a column outside the allowlist. Exercised end-to-end through
  // `handleBatchQuery` (not just `buildSecureQuery` in isolation) so the
  // assertion covers validation and execution agreeing, not just one side.
  // 'ssn'/'customers.ssn' is never allowlisted on either table in the shared
  // options below — an alias resolving to it must be rejected regardless of
  // which clause (columns/filters/join.on) used it.
  // eslint-disable-next-line vitest/expect-expect -- assertions live in the expectWidgetError helper
  it.each<[string, BatchQueryRequest['widgets'][number]]>([
    [
      'columns',
      { id: 'w1', table: 'sales', columns: ['revenue'], columnAliases: { revenue: 'ssn' } },
    ],
    [
      'filters',
      {
        id: 'w1',
        table: 'sales',
        columns: ['region'],
        columnAliases: { customerSsn: 'ssn' },
        filters: [{ column: 'customerSsn', operator: 'eq', value: '123-45-6789' }],
      },
    ],
    [
      'join.on',
      {
        id: 'w1',
        table: 'sales',
        columns: ['region'],
        columnAliases: { customerSsn: 'customers.ssn' },
        joins: [{ table: 'customers', on: [['sales.customer_id', 'customerSsn']] }],
      },
    ],
  ])(
    'rejects a columnAliases target that is not in the column allowlist (%s)',
    async (_context, widget) => {
      await expectWidgetError(
        handleBatchQuery({ pageId: 'p1', widgets: [widget] }, ACME_CLAIMS, {
          db: makeDb(),
          schemaAllowlist: ['sales', 'customers'],
          tenancy: SINGLE_TENANT,
          columnAllowlist: { sales: ['region', 'revenue', 'customer_id'], customers: [] },
        }),
        /is not in the column allowlist/,
      );
    },
  );
});

// ─── handleBatchQuery — empty-region scope (regionIds: []) is fail-closed ──────

describe('handleBatchQuery — empty-region scope (regionIds: []) is fail-closed on reads', () => {
  const REGION_ROWS = [
    { id: 1, tenant_id: 'acme', region_id: 1, product: 'a' },
    { id: 2, tenant_id: 'acme', region_id: 2, product: 'b' },
  ];
  const body: BatchQueryRequest = {
    pageId: 'p1',
    widgets: [{ id: 'w1', table: 'orders', columns: ['id'] }],
  };

  it('returns ZERO rows when the caller is authorized for zero regions (regionIds: [])', async () => {
    const res = await handleBatchQuery(
      body,
      { ...ACME_CLAIMS, regionIds: [] },
      {
        db: createMockDb({ orders: REGION_ROWS }),
        schemaAllowlist: ['orders'],
        tenancy: MULTI_TENANT,
      },
    );
    // `regionIds: []` must NOT widen to the whole tenant table — zero rows.
    expect(res.results[0].rows).toHaveLength(0);
  });

  it('returns all tenant rows when regionIds is undefined (deployment not region-scoped)', async () => {
    const res = await handleBatchQuery(
      body,
      { ...ACME_CLAIMS },
      {
        db: createMockDb({ orders: REGION_ROWS }),
        schemaAllowlist: ['orders'],
        tenancy: MULTI_TENANT,
      },
    );
    // undefined ≠ [] — no region restriction, so both tenant rows are returned.
    expect(res.results[0].rows).toHaveLength(2);
  });
});

// ─── handleBatchQuery — TEXT-typed region column (finding 2.1) ────────────────
//
// `validateSecurityColumnValues` (mutations/mutationBuilder.ts) has always
// tolerated a TEXT-typed region column by comparing a client-supplied region
// value against `claims.regionIds` (`number[]`) as strings (see
// mutationBuilder.test.ts's "allows an insert whose string region_id matches a
// numeric caller region", finding 3.3). But the row-level-security WHERE
// predicate shared by reads and writes (`applySecurityPredicates` in
// `shared/predicates.ts`) used to `whereIn` the raw numeric claim only, so the
// exact TEXT-region deployment the value-validator accommodates would have its
// scoped READS silently under-match (fail closed, but inconsistently with the
// write path). This regression pins that a row whose region column is stored
// as a STRING is now returned for a caller with a NUMERIC `regionIds` claim,
// bringing the read predicate in line with the write-side tolerance.
describe('handleBatchQuery — TEXT-typed region column matches a numeric regionIds claim (finding 2.1)', () => {
  const TEXT_REGION_ROWS = [
    { id: 1, tenant_id: 'acme', region_id: '5', product: 'a' },
    { id: 2, tenant_id: 'acme', region_id: '6', product: 'b' },
  ];
  const body: BatchQueryRequest = {
    pageId: 'p1',
    widgets: [{ id: 'w1', table: 'orders', columns: ['id', 'product'] }],
  };

  it('returns the row whose STRING region_id matches a caller scoped to the equivalent NUMBER', async () => {
    const res = await handleBatchQuery(
      body,
      { ...ACME_CLAIMS, regionIds: [5] },
      {
        db: createMockDb({ orders: TEXT_REGION_ROWS }),
        schemaAllowlist: ['orders'],
        tenancy: MULTI_TENANT,
      },
    );
    expect(res.results[0].rows).toEqual([{ id: 1, product: 'a' }]);
  });

  it('still excludes a STRING region_id outside the caller regions', async () => {
    const res = await handleBatchQuery(
      body,
      { ...ACME_CLAIMS, regionIds: [5] },
      {
        db: createMockDb({ orders: TEXT_REGION_ROWS }),
        schemaAllowlist: ['orders'],
        tenancy: MULTI_TENANT,
      },
    );
    expect(res.results[0].rows.map((r: any) => r.id)).not.toContain(2);
  });
});

// ─── handleBatchQuery — allowlist ─────────────────────────────────────────────

// Regression: a malformed body used to reach `body.widgets.map(...)` directly
// and throw a raw, unsanitized `TypeError` (e.g. "Cannot read properties of
// undefined (reading 'map')") instead of one of this package's own
// `MUI X`-prefixed, actionable errors. These are whole-request rejections
// (not a per-widget `{ error }` result) — a malformed body has no widgets to
// isolate the failure into.
describe('handleBatchQuery — malformed request body guard', () => {
  it('rejects an empty object body with a sanitized MUI X error instead of a raw TypeError', async () => {
    await expect(
      handleBatchQuery({} as any, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: SINGLE_TENANT,
      }),
    ).rejects.toThrow(/^MUI X Studio Server: Malformed batch query request/);
  });

  it('rejects a null body', async () => {
    await expect(
      handleBatchQuery(null as any, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: SINGLE_TENANT,
      }),
    ).rejects.toThrow(/^MUI X Studio Server: Malformed batch query request/);
  });

  it('rejects a body whose "widgets" is not an array', async () => {
    await expect(
      handleBatchQuery({ pageId: 'p1', widgets: 42 } as any, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: SINGLE_TENANT,
      }),
    ).rejects.toThrow(/^MUI X Studio Server: Malformed batch query request/);
  });

  // Regression: a `null` (or otherwise malformed) element in `widgets` used to
  // crash the WHOLE batch instead of producing a per-widget `{ error }` result.
  // `processWidget`'s try block dereferences `descriptor.table` and throws a
  // `TypeError` on a `null` descriptor — but the CATCH block then dereferences
  // `descriptor.id` for its `{ error }` payload, throwing a SECOND `TypeError`
  // from inside the catch, so the whole `Promise.all` rejected instead of
  // resolving with per-widget isolation. There is no `id` to isolate the error
  // onto, so the whole request is rejected up front instead.
  it('rejects a null element in "widgets" with a sanitized MUI X error instead of a raw TypeError', async () => {
    await expect(
      handleBatchQuery({ pageId: 'p1', widgets: [null] } as any, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: SINGLE_TENANT,
      }),
    ).rejects.toThrow(/^MUI X Studio Server: Malformed widget descriptor at widgets\[0\]/);
  });

  it('rejects a non-object element (e.g. a string) in "widgets"', async () => {
    await expect(
      handleBatchQuery({ pageId: 'p1', widgets: ['oops'] } as any, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: SINGLE_TENANT,
      }),
    ).rejects.toThrow(/^MUI X Studio Server: Malformed widget descriptor at widgets\[0\]/);
  });

  it('rejects a widget descriptor missing "table"', async () => {
    await expect(
      handleBatchQuery({ pageId: 'p1', widgets: [{ id: 'w1' }] } as any, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: SINGLE_TENANT,
      }),
    ).rejects.toThrow(/^MUI X Studio Server: Malformed widget descriptor at widgets\[0\]/);
  });

  it('reports the correct index for a malformed element among otherwise-valid widgets', async () => {
    await expect(
      handleBatchQuery(
        { pageId: 'p1', widgets: [{ id: 'w1', table: 'sales' }, null] } as any,
        ACME_CLAIMS,
        { db: makeDb(), schemaAllowlist: ['sales'], tenancy: SINGLE_TENANT },
      ),
    ).rejects.toThrow(/^MUI X Studio Server: Malformed widget descriptor at widgets\[1\]/);
  });

  // Regression: a non-array collection field (e.g. `filters: {}`) used to reach a
  // `for...of` over a non-iterable deeper in and throw a raw TypeError, degraded to
  // the generic per-widget error. The up-front array-shape check now yields this
  // package's own precise error, and — like the other request-shape defects above
  // — rejects the whole request rather than isolating per widget.
  it('rejects a widget whose "filters" is not an array', async () => {
    await expect(
      handleBatchQuery(
        { pageId: 'p1', widgets: [{ id: 'w1', table: 'sales', filters: {} }] } as any,
        ACME_CLAIMS,
        { db: makeDb(), schemaAllowlist: ['sales'], tenancy: SINGLE_TENANT },
      ),
    ).rejects.toThrow(
      /^MUI X Studio Server: Malformed widget descriptor at widgets\[0\] — "filters" must be an array/,
    );
  });

  it('rejects a widget whose "orderBy" is not an array', async () => {
    await expect(
      handleBatchQuery(
        { pageId: 'p1', widgets: [{ id: 'w1', table: 'sales', orderBy: 'region' }] } as any,
        ACME_CLAIMS,
        { db: makeDb(), schemaAllowlist: ['sales'], tenancy: SINGLE_TENANT },
      ),
    ).rejects.toThrow(
      /^MUI X Studio Server: Malformed widget descriptor at widgets\[0\] — "orderBy" must be an array/,
    );
  });

  it('rejects a widget whose "aggregations" is not an array', async () => {
    await expect(
      handleBatchQuery(
        { pageId: 'p1', widgets: [{ id: 'w1', table: 'sales', aggregations: 5 }] } as any,
        ACME_CLAIMS,
        { db: makeDb(), schemaAllowlist: ['sales'], tenancy: SINGLE_TENANT },
      ),
    ).rejects.toThrow(
      /^MUI X Studio Server: Malformed widget descriptor at widgets\[0\] — "aggregations" must be an array/,
    );
  });

  it('rejects a widget whose "joins" is not an array', async () => {
    await expect(
      handleBatchQuery(
        { pageId: 'p1', widgets: [{ id: 'w1', table: 'sales', joins: {} }] } as any,
        ACME_CLAIMS,
        { db: makeDb(), schemaAllowlist: ['sales'], tenancy: SINGLE_TENANT },
      ),
    ).rejects.toThrow(
      /^MUI X Studio Server: Malformed widget descriptor at widgets\[0\] — "joins" must be an array/,
    );
  });

  it('rejects a widget whose "columns" is not an array', async () => {
    await expect(
      handleBatchQuery(
        { pageId: 'p1', widgets: [{ id: 'w1', table: 'sales', columns: {} }] } as any,
        ACME_CLAIMS,
        { db: makeDb(), schemaAllowlist: ['sales'], tenancy: SINGLE_TENANT },
      ),
    ).rejects.toThrow(
      /^MUI X Studio Server: Malformed widget descriptor at widgets\[0\] — "columns" must be an array/,
    );
  });

  it('rejects a widget whose "having" is not an array', async () => {
    await expect(
      handleBatchQuery(
        { pageId: 'p1', widgets: [{ id: 'w1', table: 'sales', having: {} }] } as any,
        ACME_CLAIMS,
        { db: makeDb(), schemaAllowlist: ['sales'], tenancy: SINGLE_TENANT },
      ),
    ).rejects.toThrow(
      /^MUI X Studio Server: Malformed widget descriptor at widgets\[0\] — "having" must be an array/,
    );
  });
});

// Regression (finding T3 — unbounded widget fan-out): a batch request used to
// let `Promise.all` fan out one concurrent query per widget with no cap at
// all, so an arbitrarily large `widgets` array could overload the database.
describe('handleBatchQuery — widget fan-out cap (finding T3)', () => {
  it('rejects a batch exceeding MAX_WIDGETS_PER_BATCH with a clear MUI X error', async () => {
    const widgets = Array.from({ length: MAX_WIDGETS_PER_BATCH + 1 }, (_unused, i) => ({
      id: `w${i}`,
      table: 'sales',
    }));
    await expect(
      handleBatchQuery({ pageId: 'p1', widgets }, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: SINGLE_TENANT,
      }),
    ).rejects.toThrow(
      new RegExp(`exceeds the maximum of ${MAX_WIDGETS_PER_BATCH} allowed per request`),
    );
  });

  it('still accepts a batch exactly at MAX_WIDGETS_PER_BATCH', async () => {
    const widgets = Array.from({ length: MAX_WIDGETS_PER_BATCH }, (_unused, i) => ({
      id: `w${i}`,
      table: 'sales',
    }));
    const result = await handleBatchQuery({ pageId: 'p1', widgets }, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: SINGLE_TENANT,
    });
    expect(result.results).toHaveLength(MAX_WIDGETS_PER_BATCH);
  });
});

// Regression (Tier3 — resource exhaustion): `MAX_WIDGETS_PER_BATCH` bounds the
// NUMBER of widgets per request but not the size of any single widget's own
// collection fields — a single well-formed-looking widget could still smuggle
// in an arbitrarily large array, still unbounded work driven entirely by
// client input.
describe('handleBatchQuery — per-array size caps (finding Tier3 resource exhaustion)', () => {
  it.each(['filters', 'orderBy', 'aggregations', 'joins', 'columns', 'having'] as const)(
    'rejects a widget whose "%s" array exceeds MAX_ARRAY_ITEMS_PER_DESCRIPTOR',
    async (field) => {
      const oversized = Array.from({ length: MAX_ARRAY_ITEMS_PER_DESCRIPTOR + 1 }, () => ({}));
      await expect(
        handleBatchQuery(
          { pageId: 'p1', widgets: [{ id: 'w1', table: 'sales', [field]: oversized }] } as any,
          ACME_CLAIMS,
          { db: makeDb(), schemaAllowlist: ['sales'], tenancy: SINGLE_TENANT },
        ),
      ).rejects.toThrow(
        new RegExp(
          `^MUI X Studio Server: Malformed widget descriptor at widgets\\[0\\] — "${field}" contains ${MAX_ARRAY_ITEMS_PER_DESCRIPTOR + 1} entries, which exceeds the maximum of ${MAX_ARRAY_ITEMS_PER_DESCRIPTOR}`,
        ),
      );
    },
  );

  it('rejects a filters[].value "in"-list exceeding MAX_ARRAY_ITEMS_PER_DESCRIPTOR', async () => {
    const inList = Array.from({ length: MAX_ARRAY_ITEMS_PER_DESCRIPTOR + 1 }, (_unused, i) => i);
    await expect(
      handleBatchQuery(
        {
          pageId: 'p1',
          widgets: [
            {
              id: 'w1',
              table: 'sales',
              filters: [{ column: 'region', operator: 'in', value: inList }],
            },
          ],
        } as any,
        ACME_CLAIMS,
        { db: makeDb(), schemaAllowlist: ['sales'], tenancy: SINGLE_TENANT },
      ),
    ).rejects.toThrow(/"filters\[0\]\.value" contains .* which exceeds the maximum/);
  });

  it('still accepts a widget whose "filters" array is exactly at MAX_ARRAY_ITEMS_PER_DESCRIPTOR', async () => {
    const filters = Array.from({ length: MAX_ARRAY_ITEMS_PER_DESCRIPTOR }, () => ({
      column: 'region',
      operator: 'eq' as const,
      value: 'west',
    }));
    const result = await handleBatchQuery(
      { pageId: 'p1', widgets: [{ id: 'w1', table: 'sales', filters }] },
      ACME_CLAIMS,
      { db: makeDb(), schemaAllowlist: ['sales'], tenancy: SINGLE_TENANT },
    );
    expect(result.results[0].error).toBeUndefined();
  });

  // Regression (Finding 1, Tier2 — nested-array resource exhaustion): the
  // top-level "joins" array is length-capped above, but that cap never bounded
  // the size of any ONE join's own "on" sub-array. A single join with a huge
  // "on" list is still unbounded schema-allowlist-check / alias-resolution /
  // ON-clause-building work.
  it('rejects a join whose "on" array exceeds MAX_ARRAY_ITEMS_PER_DESCRIPTOR', async () => {
    const oversizedOn = Array.from({ length: MAX_ARRAY_ITEMS_PER_DESCRIPTOR + 1 }, () => [
      'sales.customer_id',
      'customers.id',
    ]);
    await expect(
      handleBatchQuery(
        {
          pageId: 'p1',
          widgets: [{ id: 'w1', table: 'sales', joins: [{ table: 'customers', on: oversizedOn }] }],
        } as any,
        ACME_CLAIMS,
        { db: makeDb(), schemaAllowlist: ['sales', 'customers'], tenancy: SINGLE_TENANT },
      ),
    ).rejects.toThrow(
      new RegExp(
        `^MUI X Studio Server: Malformed widget descriptor at widgets\\[0\\] — "joins\\[0\\]\\.on" contains ${MAX_ARRAY_ITEMS_PER_DESCRIPTOR + 1} entries, which exceeds the maximum of ${MAX_ARRAY_ITEMS_PER_DESCRIPTOR}`,
      ),
    );
  });

  it('still accepts a join whose "on" array is exactly at MAX_ARRAY_ITEMS_PER_DESCRIPTOR', async () => {
    // The mock db has no built-in "join" (inner join, the default when no
    // `type` is given) support — install the recording join helper so this test
    // exercises the size-cap validation rather than an unrelated mock gap, and
    // still runs the real ON-clause callback.
    const joinCapableDb = (table: string) => {
      const qb = makeDb()(table) as any;
      installRecordingJoins(qb, []);
      return qb;
    };
    const on: [string, string][] = [['sales.customer_id', 'customers.id']];
    const result = await handleBatchQuery(
      {
        pageId: 'p1',
        widgets: [{ id: 'w1', table: 'sales', joins: [{ table: 'customers', on }] }],
      },
      ACME_CLAIMS,
      { db: joinCapableDb, schemaAllowlist: ['sales', 'customers'], tenancy: SINGLE_TENANT },
    );
    expect(result.results[0].error).toBeUndefined();
  });

  // Regression (Finding 2, Tier2 — resource exhaustion): `columnAliases` is a
  // `Record<string,string>`, not an array, so it fell outside the
  // `Array.isArray` shape-guard loop and the per-array size cap entirely, even
  // though it is hashed unbounded in `computeQueryHash` (`security/cacheKey.ts`).
  it('rejects a widget whose "columnAliases" exceeds MAX_ARRAY_ITEMS_PER_DESCRIPTOR keys', async () => {
    const columnAliases = Object.fromEntries(
      Array.from({ length: MAX_ARRAY_ITEMS_PER_DESCRIPTOR + 1 }, (_unused, i) => [
        `alias${i}`,
        'amount',
      ]),
    );
    await expect(
      handleBatchQuery(
        { pageId: 'p1', widgets: [{ id: 'w1', table: 'sales', columnAliases }] } as any,
        ACME_CLAIMS,
        { db: makeDb(), schemaAllowlist: ['sales'], tenancy: SINGLE_TENANT },
      ),
    ).rejects.toThrow(
      new RegExp(
        `^MUI X Studio Server: Malformed widget descriptor at widgets\\[0\\] — "columnAliases" contains ${MAX_ARRAY_ITEMS_PER_DESCRIPTOR + 1} keys, which exceeds the maximum of ${MAX_ARRAY_ITEMS_PER_DESCRIPTOR}`,
      ),
    );
  });

  it('still accepts a widget whose "columnAliases" is exactly at MAX_ARRAY_ITEMS_PER_DESCRIPTOR keys', async () => {
    const columnAliases = Object.fromEntries(
      Array.from({ length: MAX_ARRAY_ITEMS_PER_DESCRIPTOR }, (_unused, i) => [
        `alias${i}`,
        'amount',
      ]),
    );
    const result = await handleBatchQuery(
      { pageId: 'p1', widgets: [{ id: 'w1', table: 'sales', columnAliases }] },
      ACME_CLAIMS,
      { db: makeDb(), schemaAllowlist: ['sales'], tenancy: SINGLE_TENANT },
    );
    expect(result.results[0].error).toBeUndefined();
  });

  // Regression (Finding 3, Tier3 — consistency gap): every other optional
  // descriptor field gets an explicit shape guard before use; `columnAliases`
  // previously got none at all.
  it.each([
    ['a non-object value', 'not-an-object'],
    ['an array', ['revenue', 'amount']],
    ['an object with a non-string value', { revenue: 42 }],
  ])('rejects a widget whose "columnAliases" is %s', async (_description, columnAliases) => {
    await expect(
      handleBatchQuery(
        { pageId: 'p1', widgets: [{ id: 'w1', table: 'sales', columnAliases }] } as any,
        ACME_CLAIMS,
        { db: makeDb(), schemaAllowlist: ['sales'], tenancy: SINGLE_TENANT },
      ),
    ).rejects.toThrow(
      /^MUI X Studio Server: Malformed widget descriptor at widgets\[0\] — "columnAliases" must be a plain object/,
    );
  });

  // Aggregate cap on the TOTAL comparison values summed across every filter in a
  // widget (the per-predicate cap bounds each `in`-list independently, but not
  // its product with the `filters` array's own length cap — 200 × 200 = 40,000
  // bound parameters for one widget, 2,000,000 for a full batch). Mirrors the
  // `joins[].on` aggregate cap immediately below.
  it('rejects filters whose value lists are each individually under the per-predicate cap but sum over MAX_PREDICATE_VALUES_PER_DESCRIPTOR', async () => {
    const perFilterValues = Array.from({ length: 150 }, (_unused, i) => i);
    // 20 × 150 = 3,000 total values; each filter's own 150 is comfortably under
    // MAX_ARRAY_ITEMS_PER_DESCRIPTOR (200) individually.
    const filters = Array.from({ length: 20 }, () => ({
      column: 'amount',
      operator: 'in',
      value: perFilterValues,
    }));
    await expect(
      handleBatchQuery(
        { pageId: 'p1', widgets: [{ id: 'w1', table: 'sales', filters }] } as any,
        ACME_CLAIMS,
        { db: makeDb(), schemaAllowlist: ['sales'], tenancy: SINGLE_TENANT },
      ),
    ).rejects.toThrow(
      new RegExp(
        `^MUI X Studio Server: Malformed widget descriptor at widgets\\[0\\] — "filters\\[\\]\\.value" contains 3000 comparison values in total across all filters, which exceeds the maximum of ${MAX_PREDICATE_VALUES_PER_DESCRIPTOR}`,
      ),
    );
  });

  it('still accepts filters whose value lists sum to exactly MAX_PREDICATE_VALUES_PER_DESCRIPTOR', async () => {
    const perFilterValues = Array.from({ length: 200 }, (_unused, i) => i);
    const filters = Array.from({ length: MAX_PREDICATE_VALUES_PER_DESCRIPTOR / 200 }, () => ({
      column: 'amount',
      operator: 'in' as const,
      value: perFilterValues,
    }));
    const result = await handleBatchQuery(
      { pageId: 'p1', widgets: [{ id: 'w1', table: 'sales', filters }] },
      ACME_CLAIMS,
      { db: makeDb(), schemaAllowlist: ['sales'], tenancy: SINGLE_TENANT },
    );
    expect(result.results[0].error).toBeUndefined();
  });

  // Aggregate cap on the TOTAL semi-join filter predicates summed across EVERY
  // nesting level (F15). The per-array cap bounds each semi-join's own "filters"
  // independently; the tree-wide sum was uncovered, so removing it survived.
  it('rejects semi-join "filters" arrays that are each under the per-array cap but sum over MAX_ARRAY_ITEMS_PER_DESCRIPTOR', async () => {
    const perSemiJoinFilters = Array.from({ length: 80 }, () => ({
      column: 'status',
      operator: 'eq',
      value: 'shipped',
    }));
    // Three nesting levels x 80 = 240 predicates in total; each level's own 80 is
    // comfortably under MAX_ARRAY_ITEMS_PER_DESCRIPTOR (200) on its own.
    const semiJoins = [
      {
        table: 'orders',
        column: 'id',
        foreignColumn: 'customer_id',
        filters: perSemiJoinFilters,
        semiJoins: [
          {
            table: 'orders',
            column: 'id',
            foreignColumn: 'id',
            filters: perSemiJoinFilters,
            semiJoins: [
              {
                table: 'orders',
                column: 'id',
                foreignColumn: 'id',
                filters: perSemiJoinFilters,
              },
            ],
          },
        ],
      },
    ];
    await expect(
      handleBatchQuery(
        { pageId: 'p1', widgets: [{ id: 'w1', table: 'sales', semiJoins }] } as any,
        ACME_CLAIMS,
        { db: makeDb(), schemaAllowlist: ['sales', 'orders'], tenancy: SINGLE_TENANT },
      ),
    ).rejects.toThrow(
      new RegExp(
        `^MUI X Studio Server: Malformed widget descriptor at widgets\\[0\\] — "semiJoins\\[\\]\\.filters" contains 240 entries in total across every nesting level, which exceeds the maximum of ${MAX_ARRAY_ITEMS_PER_DESCRIPTOR}`,
      ),
    );
  });

  it('still accepts semi-join "filters" summing to exactly MAX_ARRAY_ITEMS_PER_DESCRIPTOR', async () => {
    const half = Array.from({ length: MAX_ARRAY_ITEMS_PER_DESCRIPTOR / 2 }, () => ({
      column: 'status',
      operator: 'eq' as const,
      value: 'shipped',
    }));
    const result = await handleBatchQuery(
      {
        pageId: 'p1',
        widgets: [
          {
            id: 'w1',
            table: 'sales',
            semiJoins: [
              {
                table: 'orders',
                column: 'id',
                foreignColumn: 'customer_id',
                filters: half,
                semiJoins: [{ table: 'orders', column: 'id', foreignColumn: 'id', filters: half }],
              },
            ],
          },
        ],
      } as any,
      ACME_CLAIMS,
      { db: makeDb(), schemaAllowlist: ['sales', 'orders'], tenancy: SINGLE_TENANT },
    );
    // Accepted by the shape guards — it fails later (or not) on its own merits,
    // but never with the aggregate-cap message.
    expect(result.results[0].error ?? '').not.toMatch(
      /entries in total across every nesting level/,
    );
  });

  // Aggregate cap on the TOTAL "on"-pairs summed across every join in a widget
  // (Tier2 finding — the per-join cap above bounds each join independently, but
  // not their PRODUCT). A widget with several joins whose OWN "on" arrays each
  // stay under MAX_ARRAY_ITEMS_PER_DESCRIPTOR can still sum to a total that
  // forces building/allowlist-checking far more join conditions than the cap
  // intends for one widget.
  it('rejects joins whose "on" arrays are each individually under the per-join cap but sum over MAX_ARRAY_ITEMS_PER_DESCRIPTOR', async () => {
    const perJoinOn = Array.from({ length: 70 }, () => ['sales.customer_id', 'customers.id']);
    const joins = [
      { table: 'customers', on: perJoinOn },
      { table: 'customers', on: perJoinOn },
      { table: 'customers', on: perJoinOn },
    ];
    // 3 * 70 = 210 total "on" pairs, each join's own 70 comfortably under
    // MAX_ARRAY_ITEMS_PER_DESCRIPTOR (200) individually.
    await expect(
      handleBatchQuery(
        { pageId: 'p1', widgets: [{ id: 'w1', table: 'sales', joins }] } as any,
        ACME_CLAIMS,
        { db: makeDb(), schemaAllowlist: ['sales', 'customers'], tenancy: SINGLE_TENANT },
      ),
    ).rejects.toThrow(
      new RegExp(
        `^MUI X Studio Server: Malformed widget descriptor at widgets\\[0\\] — "joins\\[\\]\\.on" contains 210 entries in total across all joins, which exceeds the maximum of ${MAX_ARRAY_ITEMS_PER_DESCRIPTOR}`,
      ),
    );
  });

  it('still accepts joins whose "on" arrays sum to exactly MAX_ARRAY_ITEMS_PER_DESCRIPTOR in total', async () => {
    const joinCapableDb = (table: string) => {
      const qb = makeDb()(table) as any;
      installRecordingJoins(qb, []);
      return qb;
    };
    const perJoinOn: [string, string][] = Array.from(
      { length: MAX_ARRAY_ITEMS_PER_DESCRIPTOR / 2 },
      () => ['sales.customer_id', 'customers.id'],
    );
    const joins = [
      { table: 'customers', on: perJoinOn },
      { table: 'customers', on: perJoinOn },
    ];
    const result = await handleBatchQuery(
      { pageId: 'p1', widgets: [{ id: 'w1', table: 'sales', joins }] },
      ACME_CLAIMS,
      { db: joinCapableDb, schemaAllowlist: ['sales', 'customers'], tenancy: SINGLE_TENANT },
    );
    expect(result.results[0].error).toBeUndefined();
  });
});

// Regression (Tier2 — resource exhaustion): none of the array/object size caps
// above bound the LENGTH of an individual string field. A single well-formed-
// SHAPE widget (every array/object comfortably under its count cap) could
// still carry an oversized string as a "table"/"id", a "columnAliases"
// key/value, or a filter value — sailing past every existing check and getting
// recursively hashed (`security/cacheKey.ts`'s `computeQueryHash`) up to
// `MAX_WIDGETS_PER_BATCH` times per request.
describe('handleBatchQuery — per-string length caps (finding Tier2 resource exhaustion)', () => {
  it('rejects a widget whose "table" exceeds MAX_STRING_LENGTH', async () => {
    const oversizedTable = 'a'.repeat(MAX_STRING_LENGTH + 1);
    await expect(
      handleBatchQuery(
        { pageId: 'p1', widgets: [{ id: 'w1', table: oversizedTable }] } as any,
        ACME_CLAIMS,
        { db: makeDb(), schemaAllowlist: ['sales'], tenancy: SINGLE_TENANT },
      ),
    ).rejects.toThrow(
      new RegExp(
        `^MUI X Studio Server: Malformed widget descriptor at widgets\\[0\\] — "table" is ${MAX_STRING_LENGTH + 1} characters long, which exceeds the maximum of ${MAX_STRING_LENGTH}`,
      ),
    );
  });

  it('rejects a widget whose "id" exceeds MAX_STRING_LENGTH', async () => {
    const oversizedId = 'w'.repeat(MAX_STRING_LENGTH + 1);
    await expect(
      handleBatchQuery(
        { pageId: 'p1', widgets: [{ id: oversizedId, table: 'sales' }] } as any,
        ACME_CLAIMS,
        { db: makeDb(), schemaAllowlist: ['sales'], tenancy: SINGLE_TENANT },
      ),
    ).rejects.toThrow(
      new RegExp(
        `^MUI X Studio Server: Malformed widget descriptor at widgets\\[0\\] — "id" is ${MAX_STRING_LENGTH + 1} characters long, which exceeds the maximum of ${MAX_STRING_LENGTH}`,
      ),
    );
  });

  it('rejects a widget whose "columnAliases" value exceeds MAX_STRING_LENGTH', async () => {
    const oversizedValue = 'a'.repeat(MAX_STRING_LENGTH + 1);
    await expect(
      handleBatchQuery(
        {
          pageId: 'p1',
          widgets: [{ id: 'w1', table: 'sales', columnAliases: { revenue: oversizedValue } }],
        } as any,
        ACME_CLAIMS,
        { db: makeDb(), schemaAllowlist: ['sales'], tenancy: SINGLE_TENANT },
      ),
    ).rejects.toThrow(
      /"columnAliases" value for key "revenue…?" is \d+ characters long, which exceeds the maximum of \d+/,
    );
  });

  it('rejects a widget whose "columnAliases" key exceeds MAX_STRING_LENGTH', async () => {
    const oversizedKey = 'k'.repeat(MAX_STRING_LENGTH + 1);
    await expect(
      handleBatchQuery(
        {
          pageId: 'p1',
          widgets: [{ id: 'w1', table: 'sales', columnAliases: { [oversizedKey]: 'amount' } }],
        } as any,
        ACME_CLAIMS,
        { db: makeDb(), schemaAllowlist: ['sales'], tenancy: SINGLE_TENANT },
      ),
    ).rejects.toThrow(
      /a "columnAliases" key is \d+ characters long, which exceeds the maximum of \d+ allowed for an identifier/,
    );
  });

  it('rejects a widget whose filter value string exceeds MAX_STRING_VALUE_LENGTH', async () => {
    const oversizedValue = 'v'.repeat(MAX_STRING_VALUE_LENGTH + 1);
    await expect(
      handleBatchQuery(
        {
          pageId: 'p1',
          widgets: [
            {
              id: 'w1',
              table: 'sales',
              filters: [{ column: 'region', operator: 'eq', value: oversizedValue }],
            },
          ],
        } as any,
        ACME_CLAIMS,
        { db: makeDb(), schemaAllowlist: ['sales'], tenancy: SINGLE_TENANT },
      ),
    ).rejects.toThrow(
      /"filters\[0\]\.value" contains a string \d+ characters long, which exceeds the maximum of \d+/,
    );
  });

  it('rejects a widget whose filter "in"-list string element exceeds MAX_STRING_VALUE_LENGTH', async () => {
    const oversizedValue = 'v'.repeat(MAX_STRING_VALUE_LENGTH + 1);
    await expect(
      handleBatchQuery(
        {
          pageId: 'p1',
          widgets: [
            {
              id: 'w1',
              table: 'sales',
              filters: [{ column: 'region', operator: 'in', value: ['west', oversizedValue] }],
            },
          ],
        } as any,
        ACME_CLAIMS,
        { db: makeDb(), schemaAllowlist: ['sales'], tenancy: SINGLE_TENANT },
      ),
    ).rejects.toThrow(
      /"filters\[0\]\.value" contains a string \d+ characters long, which exceeds the maximum of \d+/,
    );
  });

  it('still accepts a widget whose filter value string is exactly at MAX_STRING_VALUE_LENGTH', async () => {
    const value = 'v'.repeat(MAX_STRING_VALUE_LENGTH);
    const result = await handleBatchQuery(
      {
        pageId: 'p1',
        widgets: [
          { id: 'w1', table: 'sales', filters: [{ column: 'region', operator: 'eq', value }] },
        ],
      },
      ACME_CLAIMS,
      { db: makeDb(), schemaAllowlist: ['sales'], tenancy: SINGLE_TENANT },
    );
    expect(result.results[0].error).toBeUndefined();
  });

  // A column-reference identifier (as opposed to "table"/"id"/"columnAliases",
  // checked in the upfront whole-batch shape validation above) is only length-
  // checked deeper, inside `checkQualifiedColumn` — per-widget isolated, like
  // every other column-allowlist/schema-allowlist violation.
  it('isolates an oversized "columns" entry as a per-widget error rather than rejecting the whole batch', async () => {
    const oversizedColumn = 'c'.repeat(MAX_STRING_LENGTH + 1);
    const result = await handleBatchQuery(
      {
        pageId: 'p1',
        widgets: [
          { id: 'bad', table: 'sales', columns: [oversizedColumn] },
          { id: 'good', table: 'sales' },
        ],
      },
      ACME_CLAIMS,
      { db: makeDb(), schemaAllowlist: ['sales'], tenancy: SINGLE_TENANT },
    );
    const bad = result.results.find((r) => r.id === 'bad')!;
    const good = result.results.find((r) => r.id === 'good')!;
    expect(bad.error).toMatch(
      /is \d+ characters long, which exceeds the maximum of \d+ allowed for an identifier/,
    );
    expect(good.error).toBeUndefined();
  });
});

describe('handleBatchQuery — schema allowlist enforcement', () => {
  // eslint-disable-next-line vitest/expect-expect -- assertions live in the expectWidgetError helper
  it('returns a per-widget error when a requested table is not in the allowlist', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [{ id: 'w1', table: 'users' }],
    };

    await expectWidgetError(
      handleBatchQuery(body, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: SINGLE_TENANT,
      }),
      'not in schema allowlist',
    );
  });

  it('rejects a JOINED table that is not in the allowlist, before touching the db', async () => {
    // A join's `table` is a real FROM-clause participant: it is read, and its
    // columns can be projected, filtered and ordered on. Nothing else in the
    // pipeline allowlist-checks it — `assertQualifiedColumnsAllowed` only sees
    // table-QUALIFIED column references, and this descriptor has none — so
    // deleting the `descriptor.joins` term from `assertTablesAllowed`'s argument
    // list left a non-allowlisted table fully readable through a join with the
    // whole suite still green.
    const dbSpy = vi.fn((table: string) => makeDb()(table));
    await expectWidgetError(
      handleBatchQuery(
        {
          pageId: 'p1',
          widgets: [
            {
              id: 'w1',
              table: 'sales',
              joins: [{ table: 'payroll', on: [['sales.id', 'payroll.sale_id']] }],
            },
          ],
        } as unknown as BatchQueryRequest,
        ACME_CLAIMS,
        { db: dbSpy, schemaAllowlist: ['sales'], tenancy: SINGLE_TENANT },
      ),
      /Requested table\(s\) not in schema allowlist: payroll/,
    );
    expect(dbSpy).not.toHaveBeenCalled();
  });

  it('rejects a non-allowlisted joined table whose `on` pairs are UNQUALIFIED', async () => {
    // THE SHAPE WITH NO SECOND LINE OF DEFENCE. When the `on` pairs name their
    // tables (`payroll.sale_id`), `assertQualifiedColumnsAllowed` would also
    // reject the widget — so that variant only proves the two guards disagree
    // about the message. Unqualified `on` columns carry NO table reference for
    // that check to inspect, which leaves `assertTablesAllowed`'s `joins` term as
    // the only thing that ever looks at the joined table's name: without it the
    // widget is accepted, the query is built, and `payroll` is read.
    const dbSpy = vi.fn((table: string) => makeDb()(table));
    await expectWidgetError(
      handleBatchQuery(
        {
          pageId: 'p1',
          widgets: [
            {
              id: 'w1',
              table: 'sales',
              joins: [{ table: 'payroll', on: [['id', 'sale_id']] }],
            },
          ],
        } as unknown as BatchQueryRequest,
        ACME_CLAIMS,
        { db: dbSpy, schemaAllowlist: ['sales'], tenancy: SINGLE_TENANT },
      ),
      /Requested table\(s\) not in schema allowlist: payroll/,
    );
    expect(dbSpy).not.toHaveBeenCalled();
  });

  it('names only the offending joined table, and checks outer joins too', async () => {
    // The `type` is irrelevant to the check — a LEFT join reads the joined table
    // exactly as an INNER one does.
    const result = await handleBatchQuery(
      {
        pageId: 'p1',
        widgets: [
          {
            id: 'w1',
            table: 'sales',
            joins: [
              { table: 'regions', type: 'left', on: [['sales.region', 'regions.name']] },
              { table: 'payroll', type: 'left', on: [['sales.id', 'payroll.sale_id']] },
            ],
          },
        ],
      } as unknown as BatchQueryRequest,
      ACME_CLAIMS,
      { db: makeDb(), schemaAllowlist: ['sales', 'regions'], tenancy: SINGLE_TENANT },
    );
    expect(result.results[0].rows).toEqual([]);
    expect(result.results[0].error).toMatch(
      /Requested table\(s\) not in schema allowlist: payroll/,
    );
    // The allowlisted joined table is not implicated.
    expect(result.results[0].error).not.toMatch(/regions/);
  });

  it('isolates a bad-table widget from a well-formed sibling (validation-stage isolation, finding 2.1)', async () => {
    // The core contract: one widget failing table/plan validation must NOT take
    // down its well-formed siblings. The bad widget gets `{ error }`; the good
    // widget still returns rows — the whole batch resolves.
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        { id: 'bad', table: 'users' }, // not in the allowlist
        { id: 'good', table: 'sales' }, // well-formed
      ],
    };

    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: SINGLE_TENANT,
      cacheProvider: new LRUCacheProvider({ ttlMs: 5000 }),
    });

    const bad = result.results.find((r) => r.id === 'bad')!;
    const good = result.results.find((r) => r.id === 'good')!;
    expect(bad.rows).toEqual([]);
    expect(bad.error).toMatch('not in schema allowlist');
    expect(good.error).toBeUndefined();
    expect(good.rows.length).toBeGreaterThan(0);
  });

  // eslint-disable-next-line vitest/expect-expect -- assertions live in the expectWidgetError helper
  it('rejects a qualified FILTER column naming a table outside the schema allowlist, even with no columnAllowlist configured', async () => {
    // No `columnAllowlist` here: before the fix, `validateDescriptorColumns` — the
    // only place that checked a qualified reference's table — is gated on
    // `columnAllowlist` being configured (`validateQueryPlan`'s
    // `if (columnAllowlist) {...}`), so this reference never got an
    // application-layer check and fell through to whatever the DB driver did with
    // an unregistered table. `assertQualifiedColumnsAllowed` now catches it here
    // regardless of `columnAllowlist`.
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          filters: [{ column: 'payroll.salary', operator: 'eq', value: 1 }],
        },
      ],
    };

    await expectWidgetError(
      handleBatchQuery(body, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: SINGLE_TENANT,
      }),
      'names table "payroll", which is not in the schema allowlist',
    );
  });

  // eslint-disable-next-line vitest/expect-expect -- assertions live in the expectWidgetError helper
  it('rejects a qualified PROJECTION column naming a table outside the schema allowlist, even with no columnAllowlist configured', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [{ id: 'w1', table: 'sales', columns: ['payroll.salary'] }],
    };

    await expectWidgetError(
      handleBatchQuery(body, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: SINGLE_TENANT,
      }),
      'names table "payroll", which is not in the schema allowlist',
    );
  });

  // eslint-disable-next-line vitest/expect-expect -- assertions live in the expectWidgetError helper
  it('rejects a qualified columnAliases physical target naming a table outside the schema allowlist', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          columns: ['expr-secret'],
          columnAliases: { 'expr-secret': 'payroll.salary' },
        },
      ],
    };

    await expectWidgetError(
      handleBatchQuery(body, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: SINGLE_TENANT,
      }),
      'names table "payroll", which is not in the schema allowlist',
    );
  });

  // eslint-disable-next-line vitest/expect-expect -- assertions live in the expectWidgetError helper
  it('rejects a qualified AGGREGATIONS column naming a table outside the schema allowlist, even with no columnAllowlist configured (finding 2.2)', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          aggregations: [{ column: 'payroll.salary', func: 'sum', alias: 's' }],
        },
      ],
    };

    await expectWidgetError(
      handleBatchQuery(body, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: SINGLE_TENANT,
      }),
      'names table "payroll", which is not in the schema allowlist',
    );
  });

  // eslint-disable-next-line vitest/expect-expect -- assertions live in the expectWidgetError helper
  it('rejects a qualified JOIN "on" left-side column naming a table outside the schema allowlist (finding 2.2)', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          joins: [{ table: 'customers', on: [['payroll.salary', 'customers.id']] }],
        },
      ],
    };

    await expectWidgetError(
      handleBatchQuery(body, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales', 'customers'],
        tenancy: SINGLE_TENANT,
      }),
      'names table "payroll", which is not in the schema allowlist',
    );
  });

  // eslint-disable-next-line vitest/expect-expect -- assertions live in the expectWidgetError helper
  it('rejects a qualified JOIN "on" right-side column naming a table outside the schema allowlist (finding 2.2)', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          joins: [{ table: 'customers', on: [['sales.customer_id', 'payroll.salary']] }],
        },
      ],
    };

    await expectWidgetError(
      handleBatchQuery(body, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales', 'customers'],
        tenancy: SINGLE_TENANT,
      }),
      'names table "payroll", which is not in the schema allowlist',
    );
  });

  // Tier3 iter26 finding 6: `assertQualifiedColumnsAllowed`'s `checkQualifiedColumn`
  // used to split a qualified reference at the FIRST dot only — "a.b.c" parsed as
  // table "a", column "b.c" — diverging from how a SQL engine would read the same
  // string as "schema.table.column". Reject the ambiguity outright instead.
  // eslint-disable-next-line vitest/expect-expect -- assertions live in the expectWidgetError helper
  it('rejects a filter column reference with more than one dot ("schema.table.column")', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          filters: [{ column: 'public.sales.amount', operator: 'gt', value: 0 }],
        },
      ],
    };

    await expectWidgetError(
      handleBatchQuery(body, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales', 'customers'],
        tenancy: SINGLE_TENANT,
      }),
      /contains more than one "\./,
    );
  });

  // Read-path analogue of the write path's `where: [null]` element-shape guard.
  // A `null` (or non-object) ELEMENT inside `filters[]` used to reach
  // `checkQualifiedColumn(filter.column, …)`, which dereferences `.column` on the
  // element itself (`null.column`) and threw a raw TypeError — caught downstream
  // by `sanitizeBoundaryError` and degraded to a generic message.
  // `assertQualifiedColumnsAllowed`'s up-front element-shape check now yields this
  // package's own precise error, still isolated to the offending widget.
  // eslint-disable-next-line vitest/expect-expect -- assertions live in the expectWidgetError helper
  it('rejects a null filters[] element with a clean MUI X error instead of a raw TypeError', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [{ id: 'w1', table: 'sales', filters: [null as any] }],
    };

    await expectWidgetError(
      handleBatchQuery(body, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales', 'customers'],
        tenancy: SINGLE_TENANT,
      }),
      /Malformed entry in "filters"/,
    );
  });

  // Read-path analogue of the filters[]/orderBy[]/aggregations[] element-shape
  // guards for `joins`. A `null` (or non-object) ELEMENT inside `joins[]` used to
  // reach `.table` on the null join (in the handler's join-table extraction) and
  // throw a raw TypeError, degraded to a generic per-widget message.
  // `assertQualifiedColumnsAllowed`'s join-element shape check now yields this
  // package's own precise error, still isolated to the offending widget.
  // eslint-disable-next-line vitest/expect-expect -- assertions live in the expectWidgetError helper
  it('rejects a null joins[] element with a clean MUI X error instead of a raw TypeError', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [{ id: 'w1', table: 'sales', joins: [null as any] }],
    };

    await expectWidgetError(
      handleBatchQuery(body, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales', 'customers'],
        tenancy: SINGLE_TENANT,
      }),
      /Malformed entry in "joins"/,
    );
  });

  it('isolates a bad column-plan widget (unsafe ORDER BY) from a well-formed sibling', async () => {
    // Same isolation, but for the query-PLAN validation stage rather than the
    // table stage — an unsafe ORDER BY direction on one widget must not fail a
    // sibling whose plan is valid.
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'bad',
          table: 'sales',
          columns: ['region'],
          orderBy: [{ column: 'region', direction: 'asc); drop table sales --' as any }],
        },
        { id: 'good', table: 'sales', columns: ['region'] },
      ],
    };

    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: SINGLE_TENANT,
      cacheProvider: new LRUCacheProvider({ ttlMs: 5000 }),
    });

    const bad = result.results.find((r) => r.id === 'bad')!;
    const good = result.results.find((r) => r.id === 'good')!;
    expect(bad.rows).toEqual([]);
    expect(bad.error).toMatch(/ORDER BY direction/);
    expect(good.error).toBeUndefined();
    expect(good.rows.length).toBeGreaterThan(0);
  });

  it('allows tables in the allowlist', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [{ id: 'w1', table: 'sales' }],
    };

    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: SINGLE_TENANT,
    });
    expect(result.results[0].error).toBeUndefined();
  });
});

// ─── handleBatchQuery — tenant isolation ─────────────────────────────────────

describe('handleBatchQuery — tenant isolation', () => {
  it('acme tenant only sees acme rows', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [{ id: 'w1', table: 'sales' }],
    };

    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: MULTI_TENANT,
      cacheProvider: new LRUCacheProvider({ ttlMs: 5000 }),
    });

    const rows = result.results[0].rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.tenant_id).toBe('acme');
    }
    expect(rows.some((r) => r.tenant_id === 'globex')).toBe(false);
  });

  it('globex tenant only sees globex rows', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [{ id: 'w1', table: 'sales' }],
    };

    const result = await handleBatchQuery(body, GLOBEX_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: MULTI_TENANT,
      cacheProvider: new LRUCacheProvider({ ttlMs: 5000 }),
    });

    const rows = result.results[0].rows;
    for (const row of rows) {
      expect(row.tenant_id).toBe('globex');
    }
    expect(rows.some((r) => r.tenant_id === 'acme')).toBe(false);
  });
});

// ─── handleBatchQuery — user filter predicates ───────────────────────────────

describe('handleBatchQuery — user filter predicates', () => {
  it('applies eq filter on region', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          filters: [{ column: 'region', operator: 'eq', value: 'west' }],
        },
      ],
    };

    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: MULTI_TENANT,
      cacheProvider: new LRUCacheProvider({ ttlMs: 5000 }),
    });

    const rows = result.results[0].rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.region).toBe('west');
      expect(row.tenant_id).toBe('acme');
    }
  });

  it('applies in filter on product', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          filters: [{ column: 'product', operator: 'in', value: ['widget', 'gadget'] }],
        },
      ],
    };

    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: SINGLE_TENANT,
    });

    const rows = result.results[0].rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(['widget', 'gadget']).toContain(row.product);
    }
  });

  it('applies neq filter', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          filters: [{ column: 'region', operator: 'neq', value: 'west' }],
        },
      ],
    };

    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: SINGLE_TENANT,
    });

    const rows = result.results[0].rows;
    for (const row of rows) {
      expect(row.region).not.toBe('west');
    }
  });

  it('applies gte filter on amount', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          filters: [{ column: 'amount', operator: 'gte', value: 150 }],
        },
      ],
    };

    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: SINGLE_TENANT,
    });

    const rows = result.results[0].rows;
    for (const row of rows) {
      expect(row.amount).toBeGreaterThanOrEqual(150);
    }
  });
});

// ─── handleBatchQuery — filter/limit value-shape guards (finding 3.1) ─────────
//
// `like`, the scalar comparison operators (eq/neq/lt/lte/gt/gte), and `limit`
// gained the same fail-closed value-shape guard the `in` (array) and `between`
// (2-tuple) operators already had. A malformed value produces this widget's own
// `{ error }` result (per-widget isolation) rather than reaching Knex as a
// confusing DB error or — for `limit` — being silently coerced into returning
// every tenant-scoped row. Valid inputs are proven unchanged by the sibling
// "user filter predicates" suite above.
describe('handleBatchQuery — value-shape guards (finding 3.1)', () => {
  // eslint-disable-next-line vitest/expect-expect -- assertions live in the expectWidgetError helper
  it('returns a per-widget error for a non-string "like" value (array)', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          filters: [{ column: 'product', operator: 'like', value: ['a', 'b'] as any }],
        },
      ],
    };
    await expectWidgetError(
      handleBatchQuery(body, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: SINGLE_TENANT,
      }),
      /"like" predicate on column "sales.product" requires a string value, but received an array/,
    );
  });

  // eslint-disable-next-line vitest/expect-expect -- assertions live in the expectWidgetError helper
  it('returns a per-widget error for a non-scalar "eq" value (array)', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          filters: [{ column: 'region', operator: 'eq', value: ['west'] as any }],
        },
      ],
    };
    await expectWidgetError(
      handleBatchQuery(body, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: SINGLE_TENANT,
      }),
      /"eq" predicate on column "sales.region" requires a scalar value .* but received an array/,
    );
  });

  // eslint-disable-next-line vitest/expect-expect -- assertions live in the expectWidgetError helper
  it('returns a per-widget error for a non-scalar "gte" value (object)', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          filters: [{ column: 'amount', operator: 'gte', value: { $gt: 100 } as any }],
        },
      ],
    };
    await expectWidgetError(
      handleBatchQuery(body, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: SINGLE_TENANT,
      }),
      /"gte" predicate on column "sales.amount" requires a scalar value .* but received object/,
    );
  });

  // eslint-disable-next-line vitest/expect-expect -- assertions live in the expectWidgetError helper
  it('returns a per-widget error for a negative "limit"', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [{ id: 'w1', table: 'sales', columns: ['region'], limit: -1 }],
    };
    await expectWidgetError(
      handleBatchQuery(body, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: SINGLE_TENANT,
      }),
      /Row limit "-1" is not allowed/,
    );
  });

  // eslint-disable-next-line vitest/expect-expect -- assertions live in the expectWidgetError helper
  it('returns a per-widget error for a non-integer "limit"', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [{ id: 'w1', table: 'sales', columns: ['region'], limit: 1.5 as any }],
    };
    await expectWidgetError(
      handleBatchQuery(body, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: SINGLE_TENANT,
      }),
      /Row limit "1.5" is not allowed/,
    );
  });

  // eslint-disable-next-line vitest/expect-expect -- assertions live in the expectWidgetError helper
  it('returns a per-widget error for a non-numeric "limit"', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [{ id: 'w1', table: 'sales', columns: ['region'], limit: '10' as any }],
    };
    await expectWidgetError(
      handleBatchQuery(body, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: SINGLE_TENANT,
      }),
      /Row limit "10" is not allowed/,
    );
  });

  it('still accepts a valid string "like", scalar comparison, and integer "limit"', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          filters: [
            { column: 'product', operator: 'like', value: 'wid%' },
            { column: 'amount', operator: 'gte', value: 100 },
          ],
          limit: 5,
        },
      ],
    };
    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: SINGLE_TENANT,
    });
    expect(result.results[0].error).toBeUndefined();
  });

  it('still accepts "limit: 0" (return zero rows) as distinct from no limit', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [{ id: 'w1', table: 'sales', columns: ['region'], limit: 0 }],
    };
    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: SINGLE_TENANT,
    });
    expect(result.results[0].error).toBeUndefined();
    expect(result.results[0].rows).toEqual([]);
  });
});

// ─── handleBatchQuery — columnAliases success path ───────────────────────────
//
// `mockDb.ts` previously had no `db.raw()`, so any descriptor using
// `columnAliases` would crash with "db.raw is not a function" — only the
// alias-mapping *logic* was covered (via a recording mock in preflight.test.ts
// that just asserts on the call args), never the actual renamed-output rows
// produced end-to-end through `handleBatchQuery`. `mockDb.ts` now implements a
// minimal `raw('?? as ??', [phys, alias])`, so this exercises the real success
// path: a logical column id that maps to a different physical column actually
// comes back under the logical id, with the right values.
describe('handleBatchQuery — columnAliases success path', () => {
  it('SELECTs the physical column AS the logical id (client/server tier)', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          columns: ['revenue'],
          columnAliases: { revenue: 'amount' },
        },
      ],
    };

    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: MULTI_TENANT,
    });

    expect(result.results[0].error).toBeUndefined();
    const rows = result.results[0].rows;
    expect(rows.length).toBeGreaterThan(0);

    // The logical id "revenue" must be present with the underlying "amount"
    // value, and the physical column name must NOT leak into the row shape.
    const expectedAmounts = SALES_ROWS.filter((r) => r.tenant_id === 'acme')
      .map((r) => r.amount)
      .sort((a, b) => a - b);
    expect(rows.map((r) => r.revenue as number).sort((a, b) => a - b)).toEqual(expectedAmounts);
    for (const row of rows) {
      expect(row).not.toHaveProperty('amount');
    }
  });

  // Note: the 'db' (aggregation push-down) tier also calls `db.raw('?? as ??', ...)`
  // for an aliased dimension column (see `executeForTier` in router/preflight.ts),
  // but `mockDb.ts`'s aggregation branch builds output rows directly from its
  // `groupBy()` columns rather than from `select()`'s projection list, so it does
  // not honor column-alias renaming for aggregated queries. Extending the mock's
  // aggregation-grouping code to do so is a known, currently out-of-scope gap in
  // this test double — the client/server-tier case above already proves the renamed-output
  // success path that was previously untestable at all.
});

// ─── handleBatchQuery — batch of multiple widgets ────────────────────────────

describe('handleBatchQuery — batch', () => {
  it('returns results for all widgets', async () => {
    const body: BatchQueryRequest = {
      pageId: 'dashboard-1',
      widgets: [
        { id: 'chart-1', table: 'sales' },
        {
          id: 'chart-2',
          table: 'sales',
          filters: [{ column: 'region', operator: 'eq', value: 'west' }],
        },
      ],
    };

    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: SINGLE_TENANT,
    });

    expect(result.pageId).toBe('dashboard-1');
    expect(result.results).toHaveLength(2);
    expect(result.results.map((r) => r.id)).toEqual(['chart-1', 'chart-2']);
    // chart-1 has all acme rows; chart-2 filtered to west only
    expect(result.results[0].rowCount).toBeGreaterThan(result.results[1].rowCount);
  });
});

// ─── handleBatchQuery — cache ────────────────────────────────────────────────

describe('handleBatchQuery — cache', () => {
  it('returns cached result on second identical request', async () => {
    const cache = new LRUCacheProvider({ ttlMs: 5000 });
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [{ id: 'w1', table: 'sales' }],
    };
    const opts = {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: SINGLE_TENANT,
      cacheProvider: cache,
    };

    const result1 = await handleBatchQuery(body, ACME_CLAIMS, opts);
    const result2 = await handleBatchQuery(body, ACME_CLAIMS, opts);

    expect(result2.results[0].rows).toEqual(result1.results[0].rows);
    // The cache hit reports the ORIGINATING tier. These few rows route to the
    // 'client' tier, so the second (cached) response must also report 'client'
    // — not a hardcoded 'server'. It gets there by RE-DERIVING the tier from the
    // entry's stored `rowCount` under the reader's own thresholds (finding M2),
    // not by echoing the stored `tier`; with unchanged thresholds the two are
    // the same answer, which is exactly why this assertion is unaffected.
    expect(result1.results[0].tier).toBe('client');
    expect(result2.results[0].tier).toBe('client');
  });

  it('a cache hit reports the tier that produced the cached rows (not a hardcoded server)', async () => {
    const cache = new LRUCacheProvider({ ttlMs: 5000 });
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [{ id: 'w1', table: 'sales' }],
    };
    const opts = {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: SINGLE_TENANT,
      cacheProvider: cache,
    };

    const first = await handleBatchQuery(body, ACME_CLAIMS, opts);
    const second = await handleBatchQuery(body, ACME_CLAIMS, opts);
    expect(second.results[0].tier).toBe(first.results[0].tier);
  });

  it('tags cached joined results with every joined table so a join mutation invalidates them', async () => {
    // Capture the tags used at set() time.
    const setTags: string[][] = [];
    const cache = new LRUCacheProvider({ ttlMs: 5000 });
    const originalSet = cache.set.bind(cache);
    cache.set = async (key, value, setOpts) => {
      setTags.push(setOpts?.tags ?? []);
      return originalSet(key, value, setOpts);
    };
    const joinCapableDb = (table: string) => {
      const qb = makeDb()(table) as any;
      installRecordingJoins(qb, []);
      return qb;
    };
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          joins: [
            { table: 'customers', type: 'left', on: [['sales.customer_id', 'customers.id']] },
          ],
        },
      ],
    };
    await handleBatchQuery(body, ACME_CLAIMS, {
      db: joinCapableDb,
      schemaAllowlist: ['sales', 'customers'],
      tenancy: SINGLE_TENANT,
      cacheProvider: cache,
    });
    expect(setTags[0]).toEqual(['sales', 'customers']);
  });

  it('different tenants do not share cache entries', async () => {
    const cache = new LRUCacheProvider({ ttlMs: 5000 });
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [{ id: 'w1', table: 'sales' }],
    };
    const opts = {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      cacheProvider: cache,
      tenancy: MULTI_TENANT,
    };

    const acmeResult = await handleBatchQuery(body, ACME_CLAIMS, opts);
    const globexResult = await handleBatchQuery(body, GLOBEX_CLAIMS, opts);

    const acmeTenantIds = new Set(acmeResult.results[0].rows.map((r) => r.tenant_id));
    const globexTenantIds = new Set(globexResult.results[0].rows.map((r) => r.tenant_id));
    expect([...acmeTenantIds]).toEqual(['acme']);
    expect([...globexTenantIds]).toEqual(['globex']);
  });

  it('reports a stable rowCount across cold miss and cache hit when limit truncates (finding 1.7)', async () => {
    const cache = new LRUCacheProvider({ ttlMs: 5000 });
    // 4 acme rows, but limit truncates the returned rows to 2. The reported
    // rowCount must reflect the preflight total (4) on BOTH the cold miss and the
    // subsequent cache hit — not flip to rows.length (2) on the hit.
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [{ id: 'w1', table: 'sales', limit: 2 }],
    };
    const opts = {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      cacheProvider: cache,
      tenancy: MULTI_TENANT,
    };

    const first = await handleBatchQuery(body, ACME_CLAIMS, opts);
    const second = await handleBatchQuery(body, ACME_CLAIMS, opts);

    expect(first.results[0].rows).toHaveLength(2);
    expect(first.results[0].rowCount).toBe(4);
    // Cache hit: rows still truncated, but rowCount stays the preflight total.
    expect(second.results[0].rows).toHaveLength(2);
    expect(second.results[0].rowCount).toBe(4);
  });

  // Regression (finding 3.1): `router/execute.ts` used to gate the LIMIT clause
  // on truthiness (`if (queryPlan.limit) { query.limit(...) }`), so `limit: 0`
  // — a plausible "return zero rows" request — was treated the same as "no
  // limit" and returned every scoped row instead. Fixed to `!== undefined`.
  it('returns ZERO rows for "limit: 0" instead of treating it as unlimited', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [{ id: 'w1', table: 'sales', limit: 0 }],
    };
    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: MULTI_TENANT,
    });
    expect(result.results[0].rows).toEqual([]);
  });
});

// ─── handleBatchQuery — tier routing cache ────────────────────────────────────

describe('handleBatchQuery — tier routing cache', () => {
  it('populates tier cache on cold miss', async () => {
    const tierCache = new MapTierCacheProvider();
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [{ id: 'w1', table: 'sales' }],
    };
    await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: SINGLE_TENANT,
      cacheProvider: new LRUCacheProvider({ ttlMs: 5000 }), // fresh cache — no prior entries
      tierCacheProvider: tierCache,
      tierCacheTtlMs: 60_000,
    });
    // The tier should now be cached
    expect(tierCache.size).toBe(1);
  });

  it('skips preflight on repeated cold miss using tier cache', async () => {
    const tierCache = new MapTierCacheProvider();
    // Pre-populate the data cache so the second call uses the data cache
    // (not relevant here — we test that tier is reused when data cache is empty)
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [{ id: 'w1', table: 'sales' }],
    };
    const opts = {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: SINGLE_TENANT,
      // No data cache — forces cold path each time
      cacheProvider: new LRUCacheProvider({ ttlMs: 1 }), // 1ms TTL → always expires
      tierCacheProvider: tierCache,
      tierCacheTtlMs: 60_000,
    };

    // First call: runs preflight, populates tier cache
    const r1 = await handleBatchQuery(body, ACME_CLAIMS, opts);
    expect(tierCache.size).toBe(1);
    // The tier plane's key is namespaced with TIER_CACHE_KEY_PREFIX (finding 2.1)
    // so it can never collide with the data plane's entry for the same widget.
    const tierEntry = await tierCache.get(
      TIER_CACHE_KEY_PREFIX +
        generateCacheKey(ACME_CLAIMS, body.widgets[0], undefined, SALES_POLICY_DIGEST),
    );
    expect(tierEntry?.tier).toBeDefined();

    // Second call: tier cache is hit, preflight is skipped
    // Rows should still be returned correctly
    await new Promise((r) => {
      setTimeout(r, 5);
    }); // let data cache expire
    const r2 = await handleBatchQuery(body, ACME_CLAIMS, opts);
    expect(r2.results[0].rows.length).toBe(r1.results[0].rows.length);
    expect(r2.results[0].tier).toBe(r1.results[0].tier);
  });

  it('tier cache is bypassed when tierCacheTtlMs is 0', async () => {
    const tierCache = new MapTierCacheProvider();
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [{ id: 'w1', table: 'sales' }],
    };
    await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: SINGLE_TENANT,
      tierCacheProvider: tierCache,
      tierCacheTtlMs: 0,
    });
    // Tier cache should not be populated when disabled
    expect(tierCache.size).toBe(0);
  });
});

// ─── handleBatchQuery — data/tier cache plane key isolation (finding 2.1) ──────

describe('handleBatchQuery — data cache and tier cache never collide on a shared store (finding 2.1)', () => {
  it('writes the data-cache and tier-cache entries under DISTINCT keys, even on one shared underlying store', async () => {
    // Simulate the documented "combining with RedisCacheProvider" setup: ONE
    // shared key/value store backing BOTH cache planes with no `keyPrefix` on
    // either provider — the exact precondition the finding calls out. Before the
    // fix, both planes derived their key from the SAME `generateCacheKey` output,
    // so the tier-cache SET would silently overwrite the data-cache entry (or
    // vice-versa), and a `CacheEntry` could be misparsed as a `TierEntry` (or
    // vice-versa). `TIER_CACHE_KEY_PREFIX` namespaces the tier plane so the two
    // can never land on the same key.
    const sharedStore = new Map<string, string>();

    const dataCacheProvider = {
      async get(key: string) {
        const raw = sharedStore.get(key);
        return raw ? JSON.parse(raw) : undefined;
      },
      async set(key: string, value: unknown) {
        sharedStore.set(key, JSON.stringify(value));
      },
      async invalidatePrefix() {},
      async deleteByTag() {},
    };
    const tierCacheProvider = {
      async get(key: string) {
        const raw = sharedStore.get(key);
        return raw ? JSON.parse(raw) : undefined;
      },
      async set(key: string, value: unknown) {
        sharedStore.set(key, JSON.stringify(value));
      },
      async invalidatePrefix() {},
    };

    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [{ id: 'w1', table: 'sales' }],
    };
    await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: MULTI_TENANT,
      cacheProvider: dataCacheProvider,
      tierCacheProvider,
      tierCacheTtlMs: 60_000,
    });

    // Two DISTINCT keys were written to the shared store — not one overwriting
    // the other (the pre-fix behavior collapsed this to a single key).
    expect(sharedStore.size).toBe(2);

    const keys = [...sharedStore.keys()];
    const tierKey = keys.find((k) => k.startsWith('tier:'));
    const dataKey = keys.find((k) => k !== tierKey);
    expect(tierKey).toBeDefined();
    expect(dataKey).toBeDefined();
    // The tier key is the data key with the namespace prefix applied — never an
    // independently-derived (and therefore possibly colliding) string.
    expect(tierKey).toBe(`tier:${dataKey}`);

    // The data-cache entry is a well-formed CacheEntry (has `rows`)…
    const dataEntry = JSON.parse(sharedStore.get(dataKey!)!);
    expect(Array.isArray(dataEntry.rows)).toBe(true);

    // …and the tier-cache entry (under the PREFIXED key) is a well-formed
    // TierEntry (has `tier`), never the other shape — so a concurrent reader can
    // never JSON-parse one plane's entry as the other's (the `rows: undefined`
    // failure mode the finding describes).
    const tierEntry = JSON.parse(sharedStore.get(tierKey!)!);
    expect(typeof tierEntry.tier).toBe('string');
    expect(tierEntry.rows).toBeUndefined();
  });
});

// ─── handleBatchQuery — cache-backend failures degrade gracefully (finding 2.6) ─

describe('handleBatchQuery — cache failures do not poison results (finding 2.6)', () => {
  function makeThrowingCache(overrides: {
    get?: () => Promise<never>;
    set?: () => Promise<never>;
  }) {
    return {
      async get() {
        if (overrides.get) {
          return overrides.get();
        }
        return undefined;
      },
      async set() {
        if (overrides.set) {
          await overrides.set();
        }
      },
      async invalidatePrefix() {},
      async deleteByTag() {},
    };
  }

  it('a throwing cache GET falls back to the database instead of failing the widget', async () => {
    const cacheProvider = makeThrowingCache({
      get: async () => {
        throw new Error('Redis is down');
      },
    });
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [{ id: 'w1', table: 'sales' }],
    };
    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: MULTI_TENANT,
      cacheProvider,
    });
    // The widget is served from the DB — no error, real rows, not an empty
    // error-shaped result.
    expect(result.results[0].error).toBeUndefined();
    expect(result.results[0].rows.length).toBeGreaterThan(0);
  });

  it('a throwing cache SET still returns the DB rows already fetched, instead of discarding them', async () => {
    const cacheProvider = makeThrowingCache({
      set: async () => {
        throw new Error('Redis is down');
      },
    });
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [{ id: 'w1', table: 'sales' }],
    };
    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: MULTI_TENANT,
      cacheProvider,
    });
    // Before the fix, a throwing `set` was caught by the widget's outer try/catch
    // and returned `{ rows: [], error }` — discarding rows already fetched from
    // the DB. The fix isolates the cache write so the fetched rows still return.
    expect(result.results[0].error).toBeUndefined();
    expect(result.results[0].rows.length).toBeGreaterThan(0);
  });
});

// ─── handleBatchQuery — missing HMAC secret is a per-widget error, not a
//     rejected batch (finding 2.3) ─────────────────────────────────────────────
//
// Before the fix, `generateCacheKey` ran OUTSIDE `processWidget`'s try/catch.
// `generateCacheKey` throws (fail-closed) when neither `CACHE_HMAC_SECRET` nor
// `JWT_SECRET` is configured, so that throw rejected `processWidget`'s promise,
// which rejected the whole `Promise.all` in `handleBatchQuery` — turning a
// config error into a rejected batch instead of the documented structured
// `BatchQueryResponse` with a per-widget `{ error }` result. This block runs
// with BOTH secrets unset (temporarily clearing the module-level
// `JWT_SECRET` this file sets for every other test) and asserts the batch
// still resolves, with the failure scoped to the affected widget(s).
describe('handleBatchQuery — missing HMAC secret degrades to a per-widget error (finding 2.3)', () => {
  function withoutHmacSecrets<T>(fn: () => Promise<T>): Promise<T> {
    const savedCacheSecret = process.env.CACHE_HMAC_SECRET;
    const savedJwtSecret = process.env.JWT_SECRET;
    delete process.env.CACHE_HMAC_SECRET;
    delete process.env.JWT_SECRET;
    return fn().finally(() => {
      if (savedCacheSecret === undefined) {
        delete process.env.CACHE_HMAC_SECRET;
      } else {
        process.env.CACHE_HMAC_SECRET = savedCacheSecret;
      }
      if (savedJwtSecret === undefined) {
        delete process.env.JWT_SECRET;
      } else {
        process.env.JWT_SECRET = savedJwtSecret;
      }
    });
  }

  it('resolves with a structured per-widget error instead of rejecting the whole batch', async () =>
    withoutHmacSecrets(async () => {
      const body: BatchQueryRequest = {
        pageId: 'p1',
        widgets: [{ id: 'w1', table: 'sales' }],
      };

      // The key assertion: this must RESOLVE (documented BatchQueryResponse
      // shape), never reject/throw, even though cache-key generation fails
      // closed internally.
      const result = await handleBatchQuery(body, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: SINGLE_TENANT,
      });

      expect(result.pageId).toBe('p1');
      expect(result.results).toHaveLength(1);
      expect(result.results[0].id).toBe('w1');
      expect(result.results[0].rows).toEqual([]);
      expect(result.results[0].tier).toBe('db');
      expect(result.results[0].rowCount).toBe(0);
      expect(result.results[0].error).toMatch(/No cache HMAC secret is configured/);
    }));

  it('isolates the failure per widget: every widget in the batch gets its own error result, not a rejected Promise.all', async () =>
    withoutHmacSecrets(async () => {
      const body: BatchQueryRequest = {
        pageId: 'p1',
        widgets: [
          { id: 'w1', table: 'sales' },
          { id: 'w2', table: 'sales', columns: ['region'] },
        ],
      };

      const result = await handleBatchQuery(body, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: SINGLE_TENANT,
      });

      expect(result.results).toHaveLength(2);
      for (const widgetResult of result.results) {
        expect(widgetResult.rows).toEqual([]);
        expect(widgetResult.error).toMatch(/No cache HMAC secret is configured/);
      }
    }));
});

// ─── handleBatchQuery — pathologically nested filter value degrades to a
//     per-widget error (Tier3 — cache-key-before-validation ordering) ─────────
//
// `generateCacheKey` (called inside `processWidget`'s try block, ~handler.ts:269)
// hashes the RAW widget descriptor — including `filters[].value` — BEFORE the
// shape guards on filter values ever run. `sortedStringify`'s depth guard
// (canonicalize.ts) now rejects a pathologically deep value there instead of
// recursing unbounded. Because the throw happens inside `processWidget`'s try,
// it must still degrade to that widget's own `{ error }` result — not reject
// the whole batch — exactly like the other per-widget validation failures above.
describe('handleBatchQuery — pathologically nested filter value (defense-in-depth depth guard)', () => {
  it('resolves with a per-widget error instead of rejecting the whole batch', async () => {
    let deeplyNested: unknown = 'leaf';
    for (let i = 0; i < 1000; i += 1) {
      deeplyNested = { nested: deeplyNested };
    }
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          filters: [{ column: 'region', operator: 'eq', value: deeplyNested as any }],
        },
        { id: 'w2', table: 'sales', columns: ['region'] },
      ],
    };

    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: SINGLE_TENANT,
    });

    expect(result.results).toHaveLength(2);
    const bad = result.results.find((r) => r.id === 'w1')!;
    const good = result.results.find((r) => r.id === 'w2')!;
    expect(bad.error).toMatch(/nested more than \d+ levels deep/);
    expect(good.error).toBeUndefined();
    expect(good.rows.length).toBeGreaterThan(0);
  });
});

// ─── handleBatchQuery — tier-cache failures degrade gracefully (finding 2.1) ───
//
// Before the fix, `decideTierWithCache` awaited `tierCacheProvider.get()`/`.set()`
// bare. The only enclosing try/catch was the per-widget outer catch-all, so a
// throwing tier-cache backend converted the throw into a per-widget error result
// (`{ rows: [], tier: 'db', rowCount: 0, error }`) for every non-aggregation
// widget — even though the DB itself was healthy and the preflight COUNT(*)
// could have run, exactly the outage class the DATA cache's `get`/`set` guards
// (finding 2.6, tested above) were written for. This mirrors those tests but for
// the tier-cache plane.

describe('handleBatchQuery — tier-cache failures do not poison results (finding 2.1)', () => {
  function makeThrowingTierCache(overrides: {
    get?: () => Promise<never>;
    set?: () => Promise<never>;
  }) {
    return {
      async get() {
        if (overrides.get) {
          return overrides.get();
        }
        return undefined;
      },
      async set() {
        if (overrides.set) {
          await overrides.set();
        }
      },
      async invalidatePrefix() {},
    };
  }

  it('a throwing tier-cache GET still serves rows from the DB instead of failing the widget', async () => {
    const tierCacheProvider = makeThrowingTierCache({
      get: async () => {
        throw new Error('redis tier cache down');
      },
    });
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [{ id: 'w1', table: 'sales' }],
    };
    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: MULTI_TENANT,
      tierCacheProvider,
      tierCacheTtlMs: 60_000,
    });
    // Before the fix this was `{ rows: [], tier: 'db', rowCount: 0, error: 'redis
    // tier cache down' }`. After the fix the tier-cache read failure degrades to
    // a miss, the preflight runs, and real rows come back.
    expect(result.results[0].error).toBeUndefined();
    expect(result.results[0].rows.length).toBeGreaterThan(0);
  });

  it('a throwing tier-cache SET still returns the already-decided tier and rows, instead of discarding them', async () => {
    const tierCacheProvider = makeThrowingTierCache({
      set: async () => {
        throw new Error('redis tier cache down');
      },
    });
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [{ id: 'w1', table: 'sales' }],
    };
    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: MULTI_TENANT,
      tierCacheProvider,
      tierCacheTtlMs: 60_000,
    });
    // Before the fix, a throwing `.set` discarded the preflight decision already
    // in hand and failed the widget. The fix isolates the cache write so the
    // decided tier and fetched rows still return.
    expect(result.results[0].error).toBeUndefined();
    expect(result.results[0].rows.length).toBeGreaterThan(0);
  });

  it('every non-aggregation widget in a batch still succeeds when the tier cache is down', async () => {
    const tierCacheProvider = makeThrowingTierCache({
      get: async () => {
        throw new Error('redis tier cache down');
      },
    });
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        { id: 'w1', table: 'sales' },
        { id: 'w2', table: 'sales', columns: ['region'] },
      ],
    };
    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: MULTI_TENANT,
      tierCacheProvider,
      tierCacheTtlMs: 60_000,
    });
    for (const widgetResult of result.results) {
      expect(widgetResult.error).toBeUndefined();
      expect(widgetResult.rows.length).toBeGreaterThan(0);
    }
  });
});

// ─── handleBatchQuery — aggregation push-down ────────────────────────────────

describe('handleBatchQuery — aggregation push-down', () => {
  it('forces db tier for aggregation queries regardless of row count', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          columns: ['region'],
          aggregations: [{ column: 'amount', func: 'sum', alias: 'total' }],
        },
      ],
    };

    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: SINGLE_TENANT,
    });

    expect(result.results[0].tier).toBe('db');
    expect(result.results[0].error).toBeUndefined();
  });

  it('groups rows by the specified column and sums amounts', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          columns: ['region'],
          aggregations: [{ column: 'amount', func: 'sum', alias: 'total' }],
          orderBy: [{ column: 'total', direction: 'desc' }],
        },
      ],
    };

    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: MULTI_TENANT,
    });

    const { rows, tier, rowCount } = result.results[0];
    expect(tier).toBe('db');
    // ACME has rows in west (100+150), north (75), east (200)
    expect(rows).toHaveLength(3);
    expect(rowCount).toBe(3);

    const westRow = rows.find((r) => r.region === 'west');
    expect(westRow?.total).toBe(250);

    const eastRow = rows.find((r) => r.region === 'east');
    expect(eastRow?.total).toBe(200);

    // Ordered by total DESC: east (200) or west (250) first
    expect((rows[0].total as number) >= (rows[1].total as number)).toBe(true);
  });

  // "How many rows per group" — this protocol has no `COUNT(*)` (see
  // `validateQueryPlan`'s wildcard rejection), so it is spelled by counting a
  // NOT NULL column that is NOT the group key. Counting the GROUP KEY ITSELF asks
  // a different question (see the test below): an AGGREGATED column is a measure,
  // never also a GROUP BY dimension.
  it('counts occurrences per group by counting a non-dimension column', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          columns: ['product'],
          aggregations: [{ column: 'id', func: 'count', alias: 'count' }],
          orderBy: [{ column: 'count', direction: 'desc' }],
        },
      ],
    };

    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: MULTI_TENANT,
    });

    const { rows, tier } = result.results[0];
    expect(tier).toBe('db');
    // ACME has: widget×2, gadget×2, north×1 — sorted desc by count
    expect(rows[0].count).toBeGreaterThanOrEqual(rows[1].count as number);
    // All ACME products accounted for
    const totalCount = rows.reduce((sum, r) => sum + (r.count as number), 0);
    expect(totalCount).toBe(4); // 4 ACME rows
  });

  // Regression (F1): an AGGREGATED column is a measure — never also a GROUP BY
  // dimension — whatever the aggregation's alias is spelled as. A descriptor whose
  // ONLY projected column is the one it aggregates therefore has NO dimension left
  // and is a GLOBAL aggregate. The pre-F1 rule keyed off
  // `agg.alias === <column's last dot-segment>`, so this very descriptor grouped or
  // did not group purely according to how the alias happened to be named.
  it('treats a column that is both projected and aggregated as a measure, not a dimension (F1)', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          columns: ['product'],
          aggregations: [{ column: 'product', func: 'count', alias: 'count' }],
        },
      ],
    };

    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: MULTI_TENANT,
    });

    const { rows, tier } = result.results[0];
    expect(tier).toBe('db');
    expect(rows).toEqual([{ count: 4 }]);
  });

  // Regression (F1): the exact `AggregationSpec` shape `security/queryTypes.ts`
  // documents — a measure aliased to something OTHER than its own column name —
  // projected alongside a dimension. Before F1 this emitted
  // `group by sales.region, sales.amount` and returned one row per DISTINCT AMOUNT
  // carrying a per-value total, silently at the wrong grain.
  it('groups by the dimension only when the measure is aliased differently (F1)', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          columns: ['region', 'amount'],
          aggregations: [{ column: 'amount', func: 'sum', alias: 'total_revenue' }],
          orderBy: [{ column: 'region', direction: 'asc' }],
        },
      ],
    };

    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: MULTI_TENANT,
    });

    const { rows } = result.results[0];
    // One row per REGION (not one per region+amount), and the measure is not also
    // projected as a raw per-row value beside its own aggregate.
    expect(rows).toEqual([
      { region: 'east', total_revenue: 200 },
      { region: 'north', total_revenue: 75 },
      { region: 'west', total_revenue: 250 },
    ]);
  });

  it('global aggregation (no columns) returns a single summary row', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          aggregations: [
            { column: 'amount', func: 'sum', alias: 'total' },
            { column: 'amount', func: 'min', alias: 'min' },
            { column: 'amount', func: 'max', alias: 'max' },
          ],
        },
      ],
    };

    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: MULTI_TENANT,
    });

    const { rows, tier, rowCount } = result.results[0];
    expect(tier).toBe('db');
    expect(rows).toHaveLength(1);
    expect(rowCount).toBe(1);
    // ACME amounts: 100, 200, 150, 75 → sum=525, min=75, max=200
    expect(rows[0].total).toBe(525);
    expect(rows[0].min).toBe(75);
    expect(rows[0].max).toBe(200);
  });

  it('rowCount equals number of result groups, not raw row count', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          columns: ['region'],
          aggregations: [{ column: 'amount', func: 'sum', alias: 'total' }],
        },
      ],
    };

    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: MULTI_TENANT,
    });

    // 4 ACME rows in 3 distinct regions → rowCount should be 3, not 4
    expect(result.results[0].rowCount).toBe(result.results[0].rows.length);
    expect(result.results[0].rowCount).toBe(3);
  });

  it('applies limit to aggregation results', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          columns: ['region'],
          aggregations: [{ column: 'amount', func: 'sum', alias: 'total' }],
          orderBy: [{ column: 'total', direction: 'desc' }],
          limit: 2,
        },
      ],
    };

    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: MULTI_TENANT,
    });

    expect(result.results[0].rows).toHaveLength(2);
    expect(result.results[0].rowCount).toBe(2);
  });

  it('does NOT populate tier cache for aggregation queries (bypassed to avoid stale entries)', async () => {
    const tierCache = new MapTierCacheProvider();
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          columns: ['region'],
          aggregations: [{ column: 'amount', func: 'sum', alias: 'total' }],
        },
      ],
    };

    await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: SINGLE_TENANT,
      tierCacheProvider: tierCache,
      tierCacheTtlMs: 60_000,
    });

    // Aggregation queries skip the tier cache to prevent stale 'client' entries
    // from a pre-fix run from shadowing the forced-db-tier path.
    expect(tierCache.size).toBe(0);
  });

  // finding 1.1 — an ORDER BY targeting an aggregation ALIAS (not a physical
  // column) must not be rejected by the column allowlist. A host allowlists
  // physical columns only, never a client's freely-chosen aggregation alias, so
  // "sum amount by region, ordered by the sum" — the single most common
  // aggregation shape — must keep working once `columnAllowlist` is configured.
  it('an ORDER BY on an aggregation alias succeeds under a columnAllowlist (finding 1.1)', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          columns: ['region'],
          aggregations: [{ column: 'amount', func: 'sum', alias: 'total_revenue' }],
          orderBy: [{ column: 'total_revenue', direction: 'desc' }],
        },
      ],
    };

    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: MULTI_TENANT,
      // Note: does NOT list 'total_revenue' — it's an aggregation alias, not a
      // physical column, and must never need to be allowlisted.
      columnAllowlist: { sales: ['region', 'amount'] },
    });

    expect(result.results[0].error).toBeUndefined();
    const { rows } = result.results[0];
    // ACME totals by region: west=250, east=200, north=75 — ordered desc by total_revenue.
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.region)).toEqual(['west', 'east', 'north']);
    expect(rows.map((r) => r.total_revenue)).toEqual([250, 200, 75]);
  });

  // A genuinely-invalid ORDER BY column — neither allowlisted nor an
  // aggregation alias — must still be rejected. Guards against the alias
  // exclusion above becoming too permissive.
  // eslint-disable-next-line vitest/expect-expect -- assertions live in the expectWidgetError helper
  it('still rejects an ORDER BY on a non-allowlisted, non-alias column under a columnAllowlist (finding 1.1)', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          columns: ['region'],
          aggregations: [{ column: 'amount', func: 'sum', alias: 'total_revenue' }],
          // 'product' is a real column, but not allowlisted and not an alias.
          orderBy: [{ column: 'product', direction: 'desc' }],
        },
      ],
    };

    await expectWidgetError(
      handleBatchQuery(body, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: MULTI_TENANT,
        columnAllowlist: { sales: ['region', 'amount'] },
      }),
      /Column "product" on table "sales" is not in the column allowlist/,
    );
  });

  // finding 2.4 — an unknown aggregation `func` must produce a clear, clean
  // rejection instead of being silently dropped (which would otherwise return a
  // confusing, silently-incomplete GROUP BY with a missing measure column). The
  // throw lives in `execute.ts`'s per-widget execution path (mirroring a DB
  // error), so — like any other execution failure — it surfaces as this
  // widget's `error` rather than rejecting the whole batch. The client-input
  // VALIDATION stage is now isolated the same way (finding 2.1), so both stages
  // uniformly scope a failure to the offending widget.
  it('rejects an aggregation with an unsupported "func" instead of silently dropping it (finding 2.4)', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          columns: ['region'],
          aggregations: [
            // 'median' is not a supported aggregation function — cast past the
            // literal union type since the whole point of this test is exercising
            // the runtime rejection of a value the type system would otherwise rule out.
            { column: 'amount', func: 'median' as unknown as 'sum', alias: 'total' },
          ],
        },
      ],
    };

    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: SINGLE_TENANT,
    });

    expect(result.results[0].error).toMatch(/Aggregation function "median" is not supported/);
    expect(result.results[0].rows).toEqual([]);
  });
});

// ─── handleBatchQuery — non-aggregation db-tier caching (finding 3.2) ────────

describe('handleBatchQuery — non-aggregation db-tier caching (finding 3.2)', () => {
  // Forcing both thresholds to 0 routes ANY non-empty non-aggregation result to
  // the 'db' tier (same COUNT(*)-driven path a huge real table would take),
  // without needing to seed thousands of rows.
  const FORCE_DB_TIER = { clientTier: 0, serverMemoryTier: 0 };

  it('routes a plain (non-aggregation) query to the db tier under tiny thresholds', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [{ id: 'w1', table: 'sales' }],
    };

    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: SINGLE_TENANT,
      thresholds: FORCE_DB_TIER,
      // Fresh data + tier cache providers — this same (claims, descriptor) pair
      // is reused by other tests in this file (under the default thresholds),
      // which would otherwise collide with the shared module-level default
      // caches and serve a stale cached tier/result instead of exercising
      // FORCE_DB_TIER.
      cacheProvider: new LRUCacheProvider({ ttlMs: 5000 }),
      tierCacheProvider: new MapTierCacheProvider(),
    });

    expect(result.results[0].tier).toBe('db');
    expect(result.results[0].rows.length).toBeGreaterThan(0);
  });

  it('caches a non-aggregation db-tier result — a second call is a cache hit (no re-execution)', async () => {
    const cache = new LRUCacheProvider({ ttlMs: 5000 });
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [{ id: 'w1', table: 'sales' }],
    };
    const opts = {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: SINGLE_TENANT,
      thresholds: FORCE_DB_TIER,
      cacheProvider: cache,
      // Fresh tier cache — see the comment in the previous test for why.
      tierCacheProvider: new MapTierCacheProvider(),
    };

    const r1 = await handleBatchQuery(body, ACME_CLAIMS, opts);
    expect(r1.results[0].tier).toBe('db');

    const cacheKey = generateCacheKey(ACME_CLAIMS, body.widgets[0], undefined, SALES_POLICY_DIGEST);
    const cached = await cache.get(cacheKey);
    expect(cached).toBeDefined();
    expect(cached?.tier).toBe('db');
    expect(cached?.rows).toEqual(r1.results[0].rows);

    // A second call is served straight from the cache — same rows, same tier —
    // rather than re-running the (potentially huge) raw-row query.
    const r2 = await handleBatchQuery(body, ACME_CLAIMS, opts);
    expect(r2.results[0].tier).toBe('db');
    expect(r2.results[0].rows).toEqual(r1.results[0].rows);
  });

  it('still does NOT cache an aggregation result even though it is also forced to the db tier', async () => {
    // ASSERTED ON THE PROVIDER, NOT ON A RECOMPUTED KEY. This test used to look
    // up `generateCacheKey(ACME_CLAIMS, widget)` — WITHOUT the policy digest the
    // handler folds in — so it queried a key the handler never writes, and would
    // have reported "not cached" no matter what the handler did. Removing the
    // `tier !== 'db' || !hasAggregations` gate entirely therefore survived.
    // Watching `set()` cannot miss the write, whatever key it lands under.
    const { provider, setKeys } = watchCacheWrites(new LRUCacheProvider({ ttlMs: 5000 }));
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          columns: ['region'],
          aggregations: [{ column: 'amount', func: 'sum', alias: 'total' }],
        },
      ],
    };

    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: SINGLE_TENANT,
      cacheProvider: provider,
    });

    expect(result.results[0].tier).toBe('db');
    expect(result.results[0].rows.length).toBeGreaterThan(0);
    expect(setKeys).toEqual([]);
  });

  it('DOES cache the same descriptor once its aggregations are removed (the gate has two sides)', async () => {
    // Guards against "caches nothing, ever" satisfying the assertion above.
    const { provider, setKeys } = watchCacheWrites(new LRUCacheProvider({ ttlMs: 5000 }));
    await handleBatchQuery(
      { pageId: 'p1', widgets: [{ id: 'w1', table: 'sales', columns: ['region'] }] },
      ACME_CLAIMS,
      {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: SINGLE_TENANT,
        cacheProvider: provider,
        tierCacheProvider: new MapTierCacheProvider(),
      },
    );
    expect(setKeys).toHaveLength(1);
  });
});

// ─── handleBatchQuery — an overtaken read must not populate the cache ─────────

describe('handleBatchQuery — a failing invalidation-epoch check falls back to NOT caching (F6)', () => {
  /**
   * `tagsInvalidatedSinceRead` answers `true` — "assume it WAS invalidated" —
   * when `CacheProvider.wereTagsInvalidatedSince` throws, because freshness could
   * not be established and the fail-closed direction is "don't cache".
   *
   * Flipping that catch to `false` is invisible in every ordinary run: the hook
   * does not throw, so the result is cached exactly as before. It only shows up
   * when the cache backend is degraded — and then a read that raced a commit
   * re-caches PRE-mutation rows for a full TTL, which is exactly the staleness
   * `readWriteCacheRace.test.ts` exists to prevent, reachable through a backend
   * hiccup instead of a timing window.
   */
  function throwingEpochProvider() {
    const { provider, setKeys } = watchCacheWrites(new LRUCacheProvider({ ttlMs: 5000 }));
    return {
      setKeys,
      provider: {
        ...provider,
        wereTagsInvalidatedSince: async () => {
          throw new Error('cache backend unavailable');
        },
      } as never,
    };
  }

  it('returns the rows but does NOT write them to the cache', async () => {
    const { provider, setKeys } = throwingEpochProvider();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await handleBatchQuery(
        { pageId: 'p1', widgets: [{ id: 'w1', table: 'sales' }] },
        ACME_CLAIMS,
        {
          db: makeDb(),
          schemaAllowlist: ['sales'],
          tenancy: SINGLE_TENANT,
          cacheProvider: provider,
          tierCacheProvider: new MapTierCacheProvider(),
        },
      );
      // The caller is served — a cache-plane failure never fails the widget.
      expect(result.results[0].error).toBeUndefined();
      expect(result.results[0].rows.length).toBeGreaterThan(0);
      // …but nothing is written, so a just-committed write cannot be hidden
      // behind an entry this read left behind.
      expect(setKeys).toEqual([]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('DOES write when the same provider answers the epoch check normally', async () => {
    // The other side of the gate: "never caches" must not be what makes the
    // assertion above pass.
    const { provider, setKeys } = watchCacheWrites(new LRUCacheProvider({ ttlMs: 5000 }));
    await handleBatchQuery({ pageId: 'p1', widgets: [{ id: 'w1', table: 'sales' }] }, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: SINGLE_TENANT,
      cacheProvider: {
        ...provider,
        wereTagsInvalidatedSince: async () => false,
      } as never,
      tierCacheProvider: new MapTierCacheProvider(),
    });
    expect(setKeys).toHaveLength(1);
  });
});

// ─── handleBatchQuery — HAVING predicates ────────────────────────────────────

describe('handleBatchQuery — HAVING predicates', () => {
  // ACME amounts by region: west=250, east=200, north=75
  const columnAllowlist = {
    sales: ['region', 'amount', 'tenant_id', 'product', 'sale_date', 'id'],
  };

  it('single gt HAVING predicate filters groups', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          columns: ['region'],
          aggregations: [{ column: 'amount', func: 'sum', alias: 'total' }],
          having: [{ alias: 'total', operator: 'gt', value: 100 }],
        },
      ],
    };

    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      columnAllowlist,
      tenancy: MULTI_TENANT,
    });

    const { rows } = result.results[0];
    // north (75) is excluded; west (250) and east (200) pass
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => (r.total as number) > 100)).toBe(true);
  });

  it('two HAVING conditions are both enforced (AND logic)', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          columns: ['region'],
          aggregations: [{ column: 'amount', func: 'sum', alias: 'total' }],
          having: [
            { alias: 'total', operator: 'gt', value: 100 },
            { alias: 'total', operator: 'lt', value: 260 },
          ],
        },
      ],
    };

    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      columnAllowlist,
      tenancy: MULTI_TENANT,
    });

    const { rows } = result.results[0];
    // 100 < total < 260 → west (250) ✓, east (200) ✓, north (75) ✗
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => (r.total as number) > 100 && (r.total as number) < 260)).toBe(true);
  });

  // eslint-disable-next-line vitest/expect-expect -- assertions live in the expectWidgetError helper
  it('HAVING alias not in aggregations returns a per-widget security error', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          columns: ['region'],
          aggregations: [{ column: 'amount', func: 'sum', alias: 'total' }],
          having: [{ alias: 'raw_amount', operator: 'gt', value: 100 }], // 'raw_amount' not in aggregations
        },
      ],
    };

    await expectWidgetError(
      handleBatchQuery(body, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: SINGLE_TENANT,
        columnAllowlist,
      }),
      'HAVING alias "raw_amount" does not match any aggregation alias',
    );
  });

  // eslint-disable-next-line vitest/expect-expect -- assertions live in the expectWidgetError helper
  it('rejects an undeclared HAVING alias even with NO columnAllowlist (finding 1.3)', async () => {
    // The HAVING-alias check must run unconditionally — not only when a column
    // allowlist is configured. Without this, HAVING becomes an arbitrary-column
    // comparison oracle.
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          columns: ['region'],
          aggregations: [{ column: 'amount', func: 'sum', alias: 'total' }],
          having: [{ alias: 'raw_amount', operator: 'gt', value: 100 }],
        },
      ],
    };

    await expectWidgetError(
      handleBatchQuery(body, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: SINGLE_TENANT,
        // NO columnAllowlist supplied.
      }),
      'HAVING alias "raw_amount" does not match any aggregation alias',
    );
  });

  // eslint-disable-next-line vitest/expect-expect -- assertions live in the expectWidgetError helper
  it('rejects HAVING when the descriptor declares no aggregations at all', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          columns: ['region'],
          // No aggregations — HAVING would compare an arbitrary raw column.
          having: [{ alias: 'total', operator: 'gt', value: 100 }],
        },
      ],
    };

    await expectWidgetError(
      handleBatchQuery(body, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: SINGLE_TENANT,
      }),
      /require at least one aggregation/,
    );
  });

  // eslint-disable-next-line vitest/expect-expect -- assertions live in the expectWidgetError helper
  it.each([
    ['a backtick', 'total`--'],
    ['a space', 'total sales'],
    ['a SQL keyword with punctuation', 'total; DROP TABLE sales'],
    ['a parenthesis', 'count(*)'],
  ])('rejects an aggregation alias containing %s (unsafe identifier)', async (_label, alias) => {
    // `agg.alias` is the one free-form, attacker-controlled token interpolated
    // into the SQL projection as an identifier — it must be constrained to a safe
    // identifier charset and rejected fail-closed otherwise.
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          columns: ['region'],
          aggregations: [{ column: 'amount', func: 'sum', alias }],
        },
      ],
    };

    await expectWidgetError(
      handleBatchQuery(body, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: SINGLE_TENANT,
        columnAllowlist,
      }),
      /Aggregation alias .* contains characters outside the allowed set/,
    );
  });

  it('accepts a normal snake_case aggregation alias', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          columns: ['region'],
          aggregations: [{ column: 'amount', func: 'sum', alias: 'total_sales' }],
        },
      ],
    };

    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      columnAllowlist,
      tenancy: MULTI_TENANT,
    });

    const { rows } = result.results[0];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => typeof r.total_sales !== 'undefined')).toBe(true);
  });

  it('DB error from an expression-field aggregation column is returned in the widget result, not thrown', async () => {
    // Simulate a DB that fails when SUM-ing a virtual/expression column.
    // The HAVING alias is valid (matches the aggregation alias), but the DB
    // cannot resolve the underlying column — the error must surface in
    // result.error, not as an unhandled rejection.
    const failingDb = (table: string) => {
      const qb = makeDb()(table) as any;
      qb.then = (_resolve: unknown, reject?: (err: Error) => void) => {
        reject?.(new Error('no such column: computed_revenue'));
      };
      return qb;
    };

    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          columns: ['region'],
          aggregations: [{ column: 'computed_revenue', func: 'sum', alias: 'total' }],
          having: [{ alias: 'total', operator: 'gt', value: 0 }],
        },
      ],
    };

    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: failingDb,
      schemaAllowlist: ['sales'],
      tenancy: SINGLE_TENANT,
    });

    expect(result.results[0].rows).toEqual([]);
    // The raw DB-driver error must NOT leak verbatim (finding T3.5): it is a schema
    // oracle, so it is replaced with a generic message (the real cause is logged
    // server-side) even though no `columnAllowlist` is configured here.
    expect(result.results[0].error).toMatch(/could not be completed/);
    expect(result.results[0].error).not.toMatch('computed_revenue');
  });
});

// ─── handleBatchQuery — JOIN with ambiguous column names ─────────────────────

describe('handleBatchQuery — JOIN with ambiguous column names', () => {
  it('db-tier aggregation with a JOIN qualifies column references to avoid ambiguity', async () => {
    // Regression for dd2e96b5: without qualify(), SUM(amount) would be ambiguous
    // when a JOIN introduces a second table that also has an `amount` column.
    // executeForTier() in preflight.ts uses qualify() to prefix every unqualified
    // column with the primary table name (e.g. amount → sales.amount).
    //
    // The join mock INVOKES the Knex join callback against a recording ON-clause
    // builder, so `buildSecureQuery`'s per-join callback — including
    // `applySecurityPredicatesToJoinOn` — actually executes here. The previous
    // stub (`qb.leftJoin = () => qb`) discarded the callback, so this test's own
    // "verify the full code path runs" claim excluded the entire ON clause.
    const onCalls: RecordedOnCall[] = [];
    const joinCapableDb = (table: string) => {
      const qb = makeDb()(table) as any;
      installRecordingJoins(qb, onCalls);
      return qb;
    };

    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          columns: ['region'],
          aggregations: [{ column: 'amount', func: 'sum', alias: 'total' }],
          joins: [{ table: 'regions', type: 'left', on: [['sales.region', 'regions.name']] }],
        },
      ],
    };

    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: joinCapableDb,
      schemaAllowlist: ['sales', 'regions'],
      tenancy: MULTI_TENANT,
    });

    const { rows } = result.results[0];
    // ACME rows: west(100+150=250), east(200), north(75)
    expect(rows).toHaveLength(3);
    const west = rows.find((r) => r.region === 'west');
    expect(west?.total).toBe(250);

    // The ON clause really was built — both the client's own pair (qualified on
    // each side) and, because this is a LEFT join, the joined table's tenant
    // predicate placed in ON rather than WHERE so unmatched rows stay
    // NULL-extended instead of silently degrading the join to an INNER join.
    expect(onCalls).toContainEqual({
      method: 'on',
      args: ['sales.region', '=', 'regions.name'],
    });
    expect(onCalls).toContainEqual({
      method: 'andOnVal',
      args: ['regions.tenant_id', '=', 'acme'],
    });
  });

  it('places the PRIMARY table predicate in ON for a RIGHT join, through the full handler pipeline', async () => {
    // The symmetric case: a RIGHT join makes the PRIMARY table the nullable side,
    // so its predicate moves into the first right join's ON clause. Covered
    // against real Knex in `router/__tests__/queryBuilder.test.ts`; covered HERE
    // through the handler's own composition (compiled policy → validated plan →
    // builder), which no `handleBatchQuery` test reached while the join stub
    // discarded its callback.
    const onCalls: RecordedOnCall[] = [];
    const joinCapableDb = (table: string) => {
      const qb = makeDb()(table) as any;
      installRecordingJoins(qb, onCalls);
      return qb;
    };

    const result = await handleBatchQuery(
      {
        pageId: 'p1',
        widgets: [
          {
            id: 'w1',
            table: 'sales',
            columns: ['sales.region'],
            joins: [{ table: 'regions', type: 'right', on: [['sales.region', 'regions.name']] }],
          },
        ],
      },
      ACME_CLAIMS,
      { db: joinCapableDb, schemaAllowlist: ['sales', 'regions'], tenancy: MULTI_TENANT },
    );

    expect(result.results[0].error).toBeUndefined();
    expect(onCalls).toContainEqual({
      method: 'andOnVal',
      args: ['sales.tenant_id', '=', 'acme'],
    });
  });
});

// ─── handleBatchQuery — JOIN with an empty `on` (finding 2.1) ────────────────

describe('handleBatchQuery — JOIN with an empty `on` is rejected before query construction (finding 2.1)', () => {
  it('rejects a widget whose join has an empty `on` array, and never invokes the db', async () => {
    // A `db` spy wrapping the real mock: if `buildSecureQuery` (or anything else)
    // ever reached query construction for this widget, `db('sales')` would be
    // called. Asserting it never was proves the empty-`on` join was rejected at
    // validation, before `handler.ts` calls into the query builder at all — not
    // merely that the eventually-constructed query happened to error out.
    const realDb = makeDb();
    const dbSpy = vi.fn((table: string) => realDb(table));

    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          joins: [{ table: 'customers', on: [] }],
        },
      ],
    };

    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: dbSpy,
      schemaAllowlist: ['sales', 'customers'],
      tenancy: SINGLE_TENANT,
    });

    expect(result.results[0].rows).toEqual([]);
    expect(result.results[0].error).toMatch(/no "on" conditions/i);
    expect(dbSpy).not.toHaveBeenCalled();
  });

  it('isolates an empty-`on`-join widget from a well-formed sibling', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        { id: 'bad', table: 'sales', joins: [{ table: 'customers', on: [] }] },
        { id: 'good', table: 'sales' },
      ],
    };

    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales', 'customers'],
      tenancy: SINGLE_TENANT,
    });

    const bad = result.results.find((r) => r.id === 'bad')!;
    const good = result.results.find((r) => r.id === 'good')!;
    expect(bad.rows).toEqual([]);
    expect(bad.error).toMatch(/no "on" conditions/i);
    expect(good.error).toBeUndefined();
    expect(good.rows.length).toBeGreaterThan(0);
  });
});

// ─── handleBatchQuery — partial batch failure recovery ───────────────────────

describe('handleBatchQuery — partial batch failure recovery', () => {
  it('a query error on one widget does not contaminate sibling results', async () => {
    // A db whose query for 'broken' throws during execution.
    const goodDb = createMockDb({ sales: SALES_ROWS });
    const mixedDb = (table: string) => {
      if (table === 'broken') {
        const stub: ReturnType<typeof goodDb> = {
          where() {
            return this;
          },
          whereIn() {
            return this;
          },
          whereLike() {
            return this;
          },
          whereBetween() {
            return this;
          },
          havingRaw() {
            return this;
          },
          count() {
            return this;
          },
          select() {
            return this;
          },
          orderBy() {
            return this;
          },
          limit() {
            return this;
          },
          // Knex's per-query statement timeout (F2) — every round-trip goes
          // through `applyQueryTimeout`, so a builder without it throws.
          timeout() {
            return this;
          },
          sum() {
            return this;
          },
          avg() {
            return this;
          },
          min() {
            return this;
          },
          max() {
            return this;
          },
          groupBy() {
            return this;
          },
          async first() {
            throw new Error('db connection failed');
          },
          then(_resolve: unknown, reject: (err: Error) => void) {
            reject(new Error('db connection failed'));
          },
        };
        return stub;
      }
      return goodDb(table);
    };

    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        { id: 'ok-widget', table: 'sales' },
        { id: 'err-widget', table: 'broken' },
      ],
    };

    const result = await handleBatchQuery(body, ACME_CLAIMS, {
      db: mixedDb,
      schemaAllowlist: ['sales', 'broken'],
      tenancy: SINGLE_TENANT,
    });

    // ok-widget returns rows; err-widget returns an error field
    const okResult = result.results.find((r) => r.id === 'ok-widget')!;
    const errResult = result.results.find((r) => r.id === 'err-widget')!;

    expect(okResult.rows.length).toBeGreaterThan(0);
    expect(okResult.error).toBeUndefined();
    expect(errResult.rows).toEqual([]);
    // Per-widget isolation still holds, but the raw driver error is sanitized to a
    // generic message rather than leaked verbatim (finding T3.5).
    expect(errResult.error).toMatch(/could not be completed/);
    expect(errResult.error).not.toMatch('db connection failed');
  });
});

// ─── handleBatchQuery — per-request resource governors (finding H2) ───────────
//
// `MAX_WIDGETS_PER_BATCH` capped the COUNT of widgets, but the fan-out itself was
// a bare `Promise.all` with no concurrency cap, no shared row budget, and no
// in-flight dedup. 50 identical unbounded widgets therefore issued 50 preflights
// + 50 full queries (all missing the not-yet-populated cache because they started
// concurrently) and could hold 50 x MAX_RESULT_ROWS rows live at once.
describe('handleBatchQuery — per-request resource governors (finding H2)', () => {
  /**
   * Wrap a mock DB so every builder it hands out records when it is CREATED and
   * tracks how many query executions overlap in time. `then`/`first` are deferred
   * by a macrotask so concurrent widgets are actually observable.
   */
  function trackingDb(base: ReturnType<typeof makeDb>) {
    const tablesQueried: string[] = [];
    let inFlight = 0;
    let peakInFlight = 0;
    const enter = () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
    };
    const tick = () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    const db: any = (table: string) => {
      tablesQueried.push(table);
      const qb: any = base(table);
      const originalThen = qb.then.bind(qb);
      const originalFirst = qb.first.bind(qb);
      qb.then = (resolve: (rows: unknown) => void, reject?: (err: Error) => void) => {
        enter();
        tick().then(() => {
          inFlight -= 1;
          originalThen(resolve, reject);
        }, reject);
      };
      qb.first = async () => {
        enter();
        await tick();
        inFlight -= 1;
        return originalFirst();
      };
      return qb;
    };
    db.raw = (base as any).raw;
    return { db, tablesQueried, peakInFlight: () => peakInFlight };
  }

  /** Options with FRESH cache planes so a shared module-level default cannot leak between tests. */
  function isolatedOptions(db: any) {
    return {
      db,
      schemaAllowlist: ['sales'],
      tenancy: MULTI_TENANT,
      cacheProvider: new LRUCacheProvider({ ttlMs: 5000 }),
      // Disable the tier cache so every widget's routing decision comes from its
      // own preflight — otherwise the dedup assertion below would be confounded
      // by a tier-cache hit rather than by the single-flight map.
      tierCacheTtlMs: 0,
    };
  }

  it('single-flights identical widgets: N duplicates run ONE preflight and ONE query', async () => {
    const { db, tablesQueried } = trackingDb(makeDb());
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        { id: 'w1', table: 'sales' },
        { id: 'w2', table: 'sales' },
        { id: 'w3', table: 'sales' },
        { id: 'w4', table: 'sales' },
      ],
    };
    const result = await handleBatchQuery(body, ACME_CLAIMS, isolatedOptions(db));

    // The widget `id` is deliberately excluded from the cache key, so all four
    // descriptors share ONE key and therefore ONE pipeline: 1 preflight COUNT(*)
    // + 1 data query = 2 builders. Before the fix this was 4 x 2 = 8.
    expect(tablesQueried).toEqual(['sales', 'sales']);

    // Every widget still gets its OWN id and the shared rows.
    expect(result.results.map((r) => r.id)).toEqual(['w1', 'w2', 'w3', 'w4']);
    for (const r of result.results) {
      expect(r.error).toBeUndefined();
      expect(r.rows.length).toBeGreaterThan(0);
      expect(r.rows).toEqual(result.results[0].rows);
    }
  });

  it('does NOT dedup widgets whose query shape differs', async () => {
    const { db, tablesQueried } = trackingDb(makeDb());
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          filters: [{ column: 'region', operator: 'eq', value: 'west' }],
        },
        {
          id: 'w2',
          table: 'sales',
          filters: [{ column: 'region', operator: 'eq', value: 'east' }],
        },
      ],
    };
    const result = await handleBatchQuery(body, ACME_CLAIMS, isolatedOptions(db));
    // Two distinct shapes → two independent pipelines (2 preflights + 2 queries).
    expect(tablesQueried).toHaveLength(4);
    expect(result.results[0].rows).not.toEqual(result.results[1].rows);
  });

  it('caps how many widget pipelines run at once', async () => {
    const { db, peakInFlight } = trackingDb(makeDb());
    // Distinct shapes so single-flight dedup cannot mask the concurrency cap.
    const widgets = Array.from({ length: MAX_CONCURRENT_WIDGET_QUERIES * 2 }, (_, i) => ({
      id: `w${i}`,
      table: 'sales',
      limit: i + 1,
    }));
    const result = await handleBatchQuery(
      { pageId: 'p1', widgets },
      ACME_CLAIMS,
      isolatedOptions(db),
    );
    // Before the fix, a bare `Promise.all` would put ALL of them in flight at once.
    expect(peakInFlight()).toBeLessThanOrEqual(MAX_CONCURRENT_WIDGET_QUERIES);
    // …but the batch is still genuinely concurrent, not serialized one-by-one.
    expect(peakInFlight()).toBeGreaterThan(1);
    // Results stay in request order despite the worker-pool scheduling.
    expect(result.results.map((r) => r.id)).toEqual(widgets.map((w) => w.id));
  });

  it('threads ONE shared row budget through the batch instead of one per widget', async () => {
    // Records the LIMIT each executed data query received. Rows returned by an
    // earlier widget must be charged against the allowance a LATER widget sees.
    const base = makeDb();
    const limits: number[] = [];
    const db: any = (table: string) => {
      const qb: any = base(table);
      const originalLimit = qb.limit.bind(qb);
      qb.limit = (n: number) => {
        limits.push(n);
        return originalLimit(n);
      };
      return qb;
    };
    db.raw = (base as any).raw;

    // More widgets than the concurrency cap, each with a DISTINCT query shape so
    // single-flight dedup cannot collapse them: the widgets past the first wave
    // start only after earlier ones have already charged their rows.
    const widgets = Array.from({ length: MAX_CONCURRENT_WIDGET_QUERIES + 2 }, (_, i) => ({
      id: `w${i}`,
      table: 'sales',
      filters: [{ column: 'amount', operator: 'gte' as const, value: i }],
    }));
    const result = await handleBatchQuery(
      { pageId: 'p1', widgets },
      ACME_CLAIMS,
      isolatedOptions(db),
    );
    expect(result.results.every((r) => r.error === undefined)).toBe(true);

    // One LIMIT per widget (the preflight COUNT(*) applies none).
    expect(limits).toHaveLength(widgets.length);
    // No widget may ever exceed the request-wide allowance…
    expect(Math.max(...limits)).toBe(MAX_ROWS_PER_REQUEST);
    // …and at least one later widget saw a REDUCED allowance, which is only
    // possible if all of them share ONE counter. Before the fix every widget
    // independently resolved to MAX_RESULT_ROWS, so 50 of them could sum to
    // 50 x MAX_RESULT_ROWS live rows.
    expect(limits.some((limit) => limit < MAX_ROWS_PER_REQUEST)).toBe(true);
  });
});

// ─── handleBatchQuery — malformed cache entries are treated as a MISS (L5) ────
//
// A `CacheProvider` is host-pluggable and its store is not exclusively ours: a
// Redis keyspace collision (no `keyPrefix` configured), a partially-written
// value, or a buggy custom provider all produce a truthy entry that is not a
// `CacheEntry`. The handler used to return `rows: <undefined or non-array>` in a
// field typed `Record<string, unknown>[]`, so every downstream `rows.map` /
// `rows.length` crashed on data the DB never produced.
describe('handleBatchQuery — malformed cache entry degrades to a DB fetch (finding L5)', () => {
  function makeCacheReturning(value: unknown) {
    return {
      async get() {
        return value as any;
      },
      async set() {},
      async invalidatePrefix() {},
      async deleteByTag() {},
    };
  }

  const MALFORMED_ENTRIES: Array<[string, unknown]> = [
    ['a foreign JSON value from a colliding key', { hello: 'world' }],
    ['an entry with no "rows" field', { cachedAt: Date.now(), tier: 'server' }],
    ['an entry whose "rows" is not an array', { rows: 'not-an-array', cachedAt: Date.now() }],
    ['an entry whose "rows" is null', { rows: null, cachedAt: Date.now() }],
    // The guard used to check ONLY `rows` (finding M1): `tier` and `rowCount`
    // were trusted verbatim behind a `??` that substitutes on null/undefined
    // only, so every entry below passed and populated a `WidgetQueryResult`
    // typed `tier: 'client'|'server'|'db'` / `rowCount: number` with a value
    // that is neither. The tier plane (`tierDecision.ts`) already degraded its
    // own equivalents; the data plane closed one field of three.
    [
      'an entry whose "tier" is outside the routing-tier union',
      { rows: [{ id: 1 }], cachedAt: Date.now(), tier: 'anything', rowCount: 3 },
    ],
    [
      'an entry whose "rowCount" is NaN',
      { rows: [], cachedAt: Date.now(), tier: 'client', rowCount: Number.NaN },
    ],
    [
      'an entry whose "rowCount" is a numeric string',
      { rows: [{ id: 1 }], cachedAt: Date.now(), tier: 'server', rowCount: 'banana' },
    ],
    [
      'an entry whose "rowCount" is negative infinity',
      { rows: [{ id: 1 }], cachedAt: Date.now(), rowCount: Number.NEGATIVE_INFINITY },
    ],
  ];

  it.each(MALFORMED_ENTRIES)('re-queries the database for %s', async (_label, entry) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await handleBatchQuery(
        { pageId: 'p1', widgets: [{ id: 'w1', table: 'sales' }] },
        ACME_CLAIMS,
        {
          db: makeDb(),
          schemaAllowlist: ['sales'],
          tenancy: MULTI_TENANT,
          cacheProvider: makeCacheReturning(entry),
          tierCacheTtlMs: 0,
        },
      );
      // Served from the DB with REAL rows — never `rows: undefined` / a string.
      expect(result.results[0].error).toBeUndefined();
      expect(Array.isArray(result.results[0].rows)).toBe(true);
      expect(result.results[0].rows.length).toBeGreaterThan(0);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/malformed cache entry/));
    } finally {
      warn.mockRestore();
    }
  });

  it('still serves a WELL-FORMED cache entry from the cache', async () => {
    const cachedRows = [{ id: 99, product: 'from-cache' }];
    const result = await handleBatchQuery(
      { pageId: 'p1', widgets: [{ id: 'w1', table: 'sales' }] },
      ACME_CLAIMS,
      {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: MULTI_TENANT,
        cacheProvider: makeCacheReturning({
          rows: cachedRows,
          cachedAt: Date.now(),
          tier: 'client',
          rowCount: 42,
        }),
        tierCacheTtlMs: 0,
      },
    );
    expect(result.results[0].rows).toEqual(cachedRows);
    expect(result.results[0].tier).toBe('client');
    expect(result.results[0].rowCount).toBe(42);
  });

  it('still serves a LEGACY entry that simply omits "tier"/"rowCount"', async () => {
    // Absent is not malformed: both fields are optional on `CacheEntry` for
    // backward compatibility with entries written before they existed, so the
    // guard must reject only a field that is PRESENT and invalid.
    const cachedRows = [{ id: 99, product: 'from-cache' }];
    const result = await handleBatchQuery(
      { pageId: 'p1', widgets: [{ id: 'w1', table: 'sales' }] },
      ACME_CLAIMS,
      {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: MULTI_TENANT,
        cacheProvider: makeCacheReturning({ rows: cachedRows, cachedAt: Date.now() }),
        tierCacheTtlMs: 0,
      },
    );
    expect(result.results[0].error).toBeUndefined();
    expect(result.results[0].rows).toEqual(cachedRows);
    // Falls back to `rows.length`, and the reported tier follows that count.
    expect(result.results[0].rowCount).toBe(1);
    expect(result.results[0].tier).toBe('client');
  });
});

// ─── The two cache planes report the SAME tier for the same rowCount (M2) ─────
//
// "What tier do we report on a cache hit" used to be implemented twice, with
// deliberately OPPOSITE behaviour and neither site referencing the other:
// `handler.ts` echoed the DATA-cache entry's stored `tier` verbatim, while
// `router/tierDecision.ts` explicitly refused to trust the TIER-cache entry's
// and re-derived it from the stored `rowCount`.
//
// `thresholds` is folded into neither the cache key nor the policy digest —
// which is precisely the justification `tierDecision.ts` gives for re-deriving
// — so an entry written by a node running one threshold config is read back by
// a node running another. The rows are identical either way; the client's
// in-browser filter/aggregate decision is not.
describe('handleBatchQuery — both cache planes derive the reported tier from rowCount (finding M2)', () => {
  /** A minimal in-process `CacheProvider` (no `lru-cache` dependency). */
  function makeMapCache() {
    const store = new Map<string, any>();
    return {
      async get(key: string) {
        return store.get(key);
      },
      async set(key: string, value: any) {
        store.set(key, value);
      },
      async invalidatePrefix() {},
      async deleteByTag() {},
      size: () => store.size,
    };
  }

  /** A minimal in-process `TierCacheProvider`. */
  function makeMapTierCache() {
    const store = new Map<string, any>();
    return {
      async get(key: string) {
        return store.get(key);
      },
      async set(key: string, value: any) {
        store.set(key, value);
      },
      async invalidatePrefix() {},
    };
  }

  const BODY: BatchQueryRequest = { pageId: 'p1', widgets: [{ id: 'w1', table: 'sales' }] };
  // `sales` holds 4 acme rows, so the preflight COUNT(*) is 4 on every run.
  // Node A's thresholds put 4 rows comfortably in the 'client' tier; node B's
  // (mid-rollout, tightened) put them in 'server'.
  const NODE_A = { clientTier: 10_000, serverMemoryTier: 100_000 };
  const NODE_B = { clientTier: 1, serverMemoryTier: 100_000 };

  function baseOptions() {
    return {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: MULTI_TENANT,
    };
  }

  it("reports node B's own tier for a DATA-cache entry node A wrote under looser thresholds", async () => {
    const shared = makeMapCache();

    // Node A warms the shared data cache: 4 rows ≤ 10_000 → 'client'.
    const nodeAWrite = await handleBatchQuery(BODY, ACME_CLAIMS, {
      ...baseOptions(),
      cacheProvider: shared,
      thresholds: NODE_A,
      tierCacheTtlMs: 0,
    });
    expect(nodeAWrite.results[0].tier).toBe('client');
    expect(shared.size()).toBe(1);

    // Node B reads that entry back under ITS thresholds: 4 rows > 1 → 'server'.
    const nodeBWarm = await handleBatchQuery(BODY, ACME_CLAIMS, {
      ...baseOptions(),
      cacheProvider: shared,
      thresholds: NODE_B,
      tierCacheTtlMs: 0,
    });

    // Node B's own cold answer for the same widget — the reference the warm
    // read must match. Before the fix the warm read echoed 'client' here.
    const nodeBCold = await handleBatchQuery(BODY, ACME_CLAIMS, {
      ...baseOptions(),
      cacheProvider: makeMapCache(),
      thresholds: NODE_B,
      tierCacheTtlMs: 0,
    });

    expect(nodeBWarm.results[0].tier).toBe(nodeBCold.results[0].tier);
    expect(nodeBWarm.results[0].tier).toBe('server');
    // The rows themselves are identical whichever plane served them.
    expect(nodeBWarm.results[0].rows).toEqual(nodeBCold.results[0].rows);
    expect(nodeBWarm.results[0].rowCount).toBe(nodeBCold.results[0].rowCount);
  });

  it('reports the SAME tier whether the DATA plane or the TIER plane served the hit', async () => {
    // Both planes are warmed under node A's thresholds, then read under node
    // B's — one through the data cache, one through the tier cache. Whichever
    // plane answers, the reported tier must be the same, because both re-derive
    // it from the stored rowCount through the shared `tierFromRowCount`.
    const dataCache = makeMapCache();
    const tierCache = makeMapTierCache();

    await handleBatchQuery(BODY, ACME_CLAIMS, {
      ...baseOptions(),
      cacheProvider: dataCache,
      tierCacheProvider: tierCache,
      tierCacheTtlMs: 60_000,
      thresholds: NODE_A,
    });

    // DATA plane answers (its entry is present, so the tier plane is never consulted).
    const viaDataPlane = await handleBatchQuery(BODY, ACME_CLAIMS, {
      ...baseOptions(),
      cacheProvider: dataCache,
      tierCacheProvider: tierCache,
      tierCacheTtlMs: 60_000,
      thresholds: NODE_B,
    });

    // TIER plane answers: an empty data cache falls through to the (warm) tier cache.
    const viaTierPlane = await handleBatchQuery(BODY, ACME_CLAIMS, {
      ...baseOptions(),
      cacheProvider: makeMapCache(),
      tierCacheProvider: tierCache,
      tierCacheTtlMs: 60_000,
      thresholds: NODE_B,
    });

    expect(viaDataPlane.results[0].tier).toBe(viaTierPlane.results[0].tier);
    expect(viaDataPlane.results[0].tier).toBe('server');
    expect(viaDataPlane.results[0].rowCount).toBe(viaTierPlane.results[0].rowCount);
  });

  it("leaves the reported tier unchanged when the reader's thresholds match the writer's", async () => {
    // Sanity check: re-derivation must be a no-op when nothing changed, so the
    // cache hit still reports the tier that actually produced the rows.
    const shared = makeMapCache();
    const opts = {
      ...baseOptions(),
      cacheProvider: shared,
      thresholds: NODE_A,
      tierCacheTtlMs: 0,
    };
    const cold = await handleBatchQuery(BODY, ACME_CLAIMS, opts);
    const warm = await handleBatchQuery(BODY, ACME_CLAIMS, opts);
    expect(warm.results[0].tier).toBe(cold.results[0].tier);
    expect(warm.results[0].tier).toBe('client');
  });
});

// ─── handleBatchQuery — element-shape guards for `having` / `aggregations` (L1) ──
//
// Every other client-supplied descriptor array was shape-guarded up front, so a
// malformed element produced this package's own precise `MUI X` error. `having`
// was not covered at all and `aggregations` was only checked for object-ness, so
// `having: [null]` produced `TypeError: Cannot read properties of null (reading
// 'alias')` — which `sanitizeBoundaryError` then replaced with the generic
// "could not be completed" message, telling the caller nothing about what was
// malformed. That is the exact outcome the up-front guards exist to prevent.
describe('handleBatchQuery — malformed having/aggregation elements (finding L1)', () => {
  function run(widget: Record<string, unknown>) {
    return handleBatchQuery({ pageId: 'p1', widgets: [widget as any] }, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: MULTI_TENANT,
      tierCacheTtlMs: 0,
    });
  }

  // eslint-disable-next-line vitest/expect-expect -- assertions live in the expectWidgetError helper
  it.each([[null], [42], ['nope']])(
    'rejects a "%s" entry in "having" with a precise message, not the generic fallback',
    async (element) => {
      await expectWidgetError(
        run({
          id: 'w1',
          table: 'sales',
          aggregations: [{ column: 'amount', func: 'sum', alias: 'total' }],
          having: [element],
        }),
        /Malformed entry in "having"/,
      );
    },
  );

  // eslint-disable-next-line vitest/expect-expect -- assertions live in the expectWidgetError helper
  it('rejects a "having" entry whose alias is not a string', async () => {
    await expectWidgetError(
      run({
        id: 'w1',
        table: 'sales',
        aggregations: [{ column: 'amount', func: 'sum', alias: 'total' }],
        having: [{ alias: 7, operator: 'gt', value: 1 }],
      }),
      /Malformed entry in "having" — its "alias" must be a string/,
    );
  });

  // eslint-disable-next-line vitest/expect-expect -- assertions live in the expectWidgetError helper
  it('rejects an aggregation with no "column"', async () => {
    await expectWidgetError(
      run({ id: 'w1', table: 'sales', aggregations: [{ func: 'sum', alias: 'total' }] }),
      /Malformed entry in "aggregations" — its "column" must be a string/,
    );
  });

  // eslint-disable-next-line vitest/expect-expect -- assertions live in the expectWidgetError helper
  it('rejects an aggregation with no "alias"', async () => {
    await expectWidgetError(
      run({ id: 'w1', table: 'sales', aggregations: [{ column: 'amount', func: 'sum' }] }),
      /Malformed entry in "aggregations" — its "alias" must be a string/,
    );
  });

  // eslint-disable-next-line vitest/expect-expect -- assertions live in the expectWidgetError helper
  it('rejects a non-array "joins[].on" with a precise message instead of a raw TypeError', async () => {
    // `for (const pair of join.on ?? [])` only substitutes for null/undefined —
    // a present non-iterable threw `TypeError: join.on is not iterable` from that
    // loop, pre-empting `validateJoinOnPairs`'s clean downstream message.
    await expectWidgetError(
      run({ id: 'w1', table: 'sales', joins: [{ table: 'sales', on: {} }] }),
      /Malformed "joins\[\]\.on" for table "sales"/,
    );
  });

  it('still accepts a well-formed having + aggregations pair', async () => {
    const result = await run({
      id: 'w1',
      table: 'sales',
      columns: ['product'],
      aggregations: [{ column: 'amount', func: 'sum', alias: 'total' }],
      having: [{ alias: 'total', operator: 'gt', value: 0 }],
    });
    expect(result.results[0].error).toBeUndefined();
  });
});

// ─── handleBatchQuery — implicit `" as "` alias references are rejected (L2) ──
//
// Knex's `wrapString` splits ANY identifier containing `" as "` into
// `<expr> as <alias>` before quoting; `resultKeyOf` splits only on `.`. On a
// `schemaAllowlist`-only deployment (no `columnAllowlist` — the documented
// backward-compatible posture) `columns: ["sales.amount as product", "product"]`
// therefore yielded two DIFFERENT keys here, so `validateProjectionKeyCollisions`
// saw no collision — while Knex emitted both under `product` and one silently
// overwrote the other in every row.
describe('handleBatchQuery — implicit " as " column references are rejected (finding L2)', () => {
  // Deliberately NO `columnAllowlist` — the deployment posture where the silent
  // projection-key collision actually bites (with an allowlist configured,
  // `checkColumnAgainstAllowlist` would reject the reference for a different
  // reason). The guard must therefore be unconditional.
  function run(widget: Record<string, unknown>) {
    return handleBatchQuery({ pageId: 'p1', widgets: [widget as any] }, ACME_CLAIMS, {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: MULTI_TENANT,
      tierCacheTtlMs: 0,
    });
  }

  // eslint-disable-next-line vitest/expect-expect -- assertions live in the expectWidgetError helper
  it('rejects an " as "-aliased projection column with NO columnAllowlist configured', async () => {
    await expectWidgetError(
      run({ id: 'w1', table: 'sales', columns: ['sales.amount as product', 'product'] }),
      /Column reference "sales\.amount as product" \(in columns\) contains " as "/,
    );
  });

  // eslint-disable-next-line vitest/expect-expect -- assertions live in the expectWidgetError helper
  it.each(['AS', 'As', 'aS'])('rejects the case-variant " %s " form too', async (as) => {
    await expectWidgetError(
      run({ id: 'w1', table: 'sales', columns: [`sales.amount ${as} product`] }),
      /contains " as "/,
    );
  });

  // eslint-disable-next-line vitest/expect-expect -- assertions live in the expectWidgetError helper
  it('rejects an " as "-aliased filter column', async () => {
    await expectWidgetError(
      run({
        id: 'w1',
        table: 'sales',
        filters: [{ column: 'amount as product', operator: 'eq', value: 1 }],
      }),
      /Column reference "amount as product" \(in filters\) contains " as "/,
    );
  });

  // eslint-disable-next-line vitest/expect-expect -- assertions live in the expectWidgetError helper
  it('rejects an " as "-bearing columnAliases VALUE (which would render `x as y as z`)', async () => {
    await expectWidgetError(
      run({
        id: 'w1',
        table: 'sales',
        columns: ['revenue'],
        columnAliases: { revenue: 'sales.amount as product' },
      }),
      /\(in columnAliases\) contains " as "/,
    );
  });

  it('does NOT reject a legitimate column that merely CONTAINS the letters "as"', async () => {
    // The guard matches the delimited `" as "` token Knex parses, not any
    // substring — `last_assigned` / `as_of_date` must still be queryable.
    const result = await run({ id: 'w1', table: 'sales', columns: ['product', 'sale_date'] });
    expect(result.results[0].error).toBeUndefined();
  });
});

// ─── handleBatchQuery — `like` / `between` filters actually filter ────────────
//
// These two operators had NO end-to-end row coverage: `whereLike`/`whereBetween`
// in `mockDb` indexed the row with the FULL reference (`row['sales.product']`,
// always `undefined`) while `where`/`whereIn` stripped the table qualifier. Since
// `queryBuilder.ts` qualifies every unqualified filter column with the primary
// table, every `like`/`between` filter routed through the mock matched ZERO rows,
// and the one `like` test only asserted `error` was `undefined`. These assert the
// ROWS, so the qualification path is validated end-to-end for both operators.
describe('handleBatchQuery — like / between filters return the matching rows', () => {
  const OPTS = { schemaAllowlist: ['sales'], tenancy: SINGLE_TENANT };

  it('"like" matches on the pattern and excludes non-matching rows', async () => {
    const result = await handleBatchQuery(
      {
        pageId: 'p1',
        widgets: [
          {
            id: 'w1',
            table: 'sales',
            columns: ['id', 'product'],
            filters: [{ column: 'product', operator: 'like', value: 'wid%' }],
          },
        ],
      },
      ACME_CLAIMS,
      { db: makeDb(), ...OPTS },
    );
    expect(result.results[0].error).toBeUndefined();
    // Only the two `widget` rows (ids 1 and 3); `gadget`/`thingamajig` excluded.
    expect(result.results[0].rows.map((r) => r.id).sort()).toEqual([1, 3]);
  });

  it('"like" on a QUALIFIED column resolves against the same rows', async () => {
    const result = await handleBatchQuery(
      {
        pageId: 'p1',
        widgets: [
          {
            id: 'w1',
            table: 'sales',
            columns: ['id'],
            filters: [{ column: 'sales.product', operator: 'like', value: '%adget' }],
          },
        ],
      },
      ACME_CLAIMS,
      { db: makeDb(), ...OPTS },
    );
    expect(result.results[0].rows.map((r) => r.id).sort()).toEqual([2, 5]);
  });

  it('"between" bounds the result inclusively and excludes rows outside the range', async () => {
    const result = await handleBatchQuery(
      {
        pageId: 'p1',
        widgets: [
          {
            id: 'w1',
            table: 'sales',
            columns: ['id', 'amount'],
            filters: [{ column: 'amount', operator: 'between', value: [100, 200] }],
          },
        ],
      },
      ACME_CLAIMS,
      { db: makeDb(), ...OPTS },
    );
    expect(result.results[0].error).toBeUndefined();
    // amounts 100 / 200 / 150 are in range; 500 and 75 are not.
    expect(result.results[0].rows.map((r) => r.id).sort()).toEqual([1, 2, 3]);
  });

  it('"between" returns no rows when nothing falls inside the range (not "everything")', async () => {
    const result = await handleBatchQuery(
      {
        pageId: 'p1',
        widgets: [
          {
            id: 'w1',
            table: 'sales',
            columns: ['id'],
            filters: [{ column: 'sales.amount', operator: 'between', value: [1000, 2000] }],
          },
        ],
      },
      ACME_CLAIMS,
      { db: makeDb(), ...OPTS },
    );
    expect(result.results[0].rows).toEqual([]);
  });
});

// ─── handleBatchQuery — wildcard projections ──────────────────────────────────
//
// `resultKeyOf` maps `orders.*` to the literal `"*"`, so
// `validateProjectionKeyCollisions` could not see that `SELECT sales.*,
// customers.product` returns a row object in which the joined column overwrites
// the primary table's same-named one (pg and mysql2 both key rows by field name,
// last-wins). A wildcard is admitted only as the WHOLE projection.
describe('handleBatchQuery — wildcard projections', () => {
  /**
   * A join-capable mock that also records every `.select()` projection list, so
   * a test can assert what the SELECT actually was — including the case where
   * `.select()` is never called at all, which is what makes Knex emit a bare
   * `SELECT *`.
   */
  const joinCapableDb = () => {
    const projections: unknown[][] = [];
    const onCalls: RecordedOnCall[] = [];
    const inner = createMockDb({
      sales: SALES_ROWS,
      customers: [{ id: 1, tenant_id: 'acme', product: 'other' }],
    });
    const db = ((table: string) => {
      const qb = inner(table) as any;
      // Invokes the join callback (see `installRecordingJoins`) rather than
      // discarding it, so the ON clause — and the security predicates placed in
      // it — really run in these tests too.
      installRecordingJoins(qb, onCalls);
      const { select } = qb;
      qb.select = (columns: unknown) => {
        projections.push(Array.isArray(columns) ? columns : [columns]);
        return select.call(qb, columns as any);
      };
      return qb;
    }) as any;
    db.raw = inner.raw;
    return { db, projections, onCalls };
  };

  // eslint-disable-next-line vitest/expect-expect -- assertions live in the expectWidgetError helper
  it('rejects a wildcard projected alongside a named column from another table', async () => {
    await expectWidgetError(
      handleBatchQuery(
        {
          pageId: 'p1',
          widgets: [
            {
              id: 'w1',
              table: 'sales',
              columns: ['sales.*', 'customers.product'],
              joins: [{ table: 'customers', on: [['sales.id', 'customers.id']] }],
            },
          ],
        },
        ACME_CLAIMS,
        { db: joinCapableDb().db, schemaAllowlist: ['sales', 'customers'], tenancy: SINGLE_TENANT },
      ),
      /Wildcard column reference "sales\.\*" cannot be combined/,
    );
  });

  // eslint-disable-next-line vitest/expect-expect -- assertions live in the expectWidgetError helper
  it('rejects two table-qualified wildcards with a message that names the real problem', async () => {
    await expectWidgetError(
      handleBatchQuery(
        {
          pageId: 'p1',
          widgets: [
            {
              id: 'w1',
              table: 'sales',
              columns: ['sales.*', 'customers.*'],
              joins: [{ table: 'customers', on: [['sales.id', 'customers.id']] }],
            },
          ],
        },
        ACME_CLAIMS,
        { db: joinCapableDb().db, schemaAllowlist: ['sales', 'customers'], tenancy: SINGLE_TENANT },
      ),
      /cannot be combined with another projected column or an aggregation/,
    );
  });

  it('accepts a wildcard that is the entire projection', async () => {
    const result = await handleBatchQuery(
      {
        pageId: 'p1',
        widgets: [{ id: 'w1', table: 'sales', columns: ['sales.*'] }],
      },
      ACME_CLAIMS,
      { db: makeDb(), schemaAllowlist: ['sales'], tenancy: SINGLE_TENANT },
    );
    expect(result.results[0].error).toBeUndefined();
    expect(result.results[0].rows[0]).toHaveProperty('product');
  });

  // A widget with NO `columns` and a join used to emit a bare `SELECT *` on a
  // `schemaAllowlist`-only deployment: `plan.columns` stayed empty and
  // `synthesizeProjectionFromAllowlist` only runs when a `columnAllowlist` is
  // configured. Every name the two tables share then collapsed last-wins. The
  // implicit projection is now anchored to the primary table.
  it('anchors an IMPLICIT projection to the primary table when the widget joins', async () => {
    const { db, projections } = joinCapableDb();
    const result = await handleBatchQuery(
      {
        pageId: 'p1',
        widgets: [
          {
            id: 'w1',
            table: 'sales',
            joins: [{ table: 'customers', on: [['sales.id', 'customers.id']] }],
          },
        ],
      },
      ACME_CLAIMS,
      { db, schemaAllowlist: ['sales', 'customers'], tenancy: SINGLE_TENANT },
    );
    expect(result.results[0].error).toBeUndefined();
    // Previously NO `.select()` was emitted at all (a bare `SELECT *` across both
    // joined tables); the projection is now explicitly the primary table's.
    expect(projections).toContainEqual(['sales.*']);
  });

  it('leaves an IMPLICIT projection alone for a single-table widget (SELECT * is unambiguous)', async () => {
    const { db, projections } = joinCapableDb();
    const result = await handleBatchQuery(
      { pageId: 'p1', widgets: [{ id: 'w1', table: 'sales' }] },
      ACME_CLAIMS,
      { db, schemaAllowlist: ['sales'], tenancy: SINGLE_TENANT },
    );
    expect(result.results[0].error).toBeUndefined();
    expect(result.results[0].rows.length).toBeGreaterThan(0);
    // No join, so `SELECT *` already names exactly one table's columns.
    expect(projections).toEqual([]);
  });
});

// ─── The returned `rows` array is not the cached array (finding L3, write side) ─
//
// Regression: `runWidgetPipeline` stored `{ rows, … }` in the cache and returned
// the SAME `rows` reference to the host, while `LRUCacheProvider.set` stores by
// reference (only `get` clones). A host that post-processed `results[i].rows` in
// place therefore wrote into the process-wide server cache, and every subsequent
// hit for the whole TTL served the mutated rows to every user sharing the
// security profile.
describe('handleBatchQuery — the returned rows array is not the cached array', () => {
  it('does not let a host mutating the returned array corrupt the cached entry', async () => {
    const cacheProvider = new LRUCacheProvider({ ttlMs: 5000 });
    const opts = {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      tenancy: SINGLE_TENANT,
      cacheProvider,
    };
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [{ id: 'w1', table: 'sales', columns: ['id', 'amount'] }],
    };

    const cold = await handleBatchQuery(body, ACME_CLAIMS, opts);
    const originalLength = cold.results[0].rows.length;
    expect(originalLength).toBeGreaterThan(0);

    // A host post-processing its own result in place — dropping rows, reordering,
    // truncating. The pre-fix code shared this array with the cache.
    cold.results[0].rows.length = 0;

    const warm = await handleBatchQuery(body, ACME_CLAIMS, { ...opts, db: makeDb() });
    expect(warm.results[0].rows).toHaveLength(originalLength);
  });
});

// ─── Host-config allowlist shape (fail-closed, not fail-open) ────────────────
//
// Regression: `schemaAllowlist: string[]` / `columnAllowlist: Record<string,
// string[]>` were enforced by TypeScript alone, while every membership check is
// `Array.prototype.includes`. A host reading its allowlist from the environment
// (`schemaAllowlist: process.env.STUDIO_TABLES`) supplies a STRING, and `includes`
// silently becomes `String.prototype.includes` — SUBSTRING matching, which admits
// tables/columns the host never allowlisted. These are host-CONFIGURATION errors,
// not client input, so they reject the whole request rather than becoming a
// per-widget `{ error }`.
describe('handleBatchQuery — host allowlist shape is validated at runtime', () => {
  it('rejects a STRING schemaAllowlist instead of substring-matching against it', async () => {
    const dbSpy = vi.fn((table: string) => makeDb()(table));
    await expect(
      handleBatchQuery({ pageId: 'p1', widgets: [{ id: 'w1', table: 'sales' }] }, ACME_CLAIMS, {
        db: dbSpy,
        // `'sales_public'.includes('sales')` is TRUE — the pre-fix code admitted
        // `sales`, a table this deployment never allowlisted, and emitted
        // `select * from "sales" …`.
        schemaAllowlist: 'sales_public' as unknown as string[],
        tenancy: SINGLE_TENANT,
      }),
    ).rejects.toThrow(/schemaAllowlist must be an array of strings/);
    // Nothing reached query construction.
    expect(dbSpy).not.toHaveBeenCalled();
  });

  it('rejects a STRING columnAllowlist entry instead of substring-matching against it', async () => {
    const dbSpy = vi.fn((table: string) => makeDb()(table));
    await expect(
      handleBatchQuery(
        { pageId: 'p1', widgets: [{ id: 'w1', table: 'sales', columns: ['id'] }] },
        ACME_CLAIMS,
        {
          db: dbSpy,
          schemaAllowlist: ['sales'],
          // Any substring passed — including the EMPTY string, reachable through a
          // trailing-dot reference such as `columns: ['sales.']`.
          columnAllowlist: { sales: 'id,region' } as unknown as Record<string, string[]>,
          tenancy: SINGLE_TENANT,
        },
      ),
    ).rejects.toThrow(/columnAllowlist\["sales"\] must be an array of strings/);
    expect(dbSpy).not.toHaveBeenCalled();
  });
});

// ─── Semi-joins (cross-source filter across a one-to-many relationship) ───────
//
// The motivating shape: a KPI on `customers` filtered by `orders.status`, where
// the relationship is one-to-many from the widget's side. Three DIFFERENT numbers
// are reachable from this one fixture, and the whole point of the semi-join form
// is which one comes back:
//
//   140  — the correct, semi-join answer. Each qualifying customer counted ONCE,
//          exactly what `dataSourceGraph.resolveRows` computes in memory (group
//          the cross-filters by foreign source, one conjunctive `applyFilters`,
//          one semi-join).
//   340  — what a `LEFT JOIN orders … WHERE orders.status = 'shipped'` returns:
//          customer 1 has THREE shipped orders, so its 100 is summed three times.
//          This is the fan-out the wire protocol used to force, and it is why the
//          previous round dropped such a filter with a warning instead.
//  1140  — what a semi-join whose SUBQUERY IS NOT TENANT-SCOPED returns: the
//          inner SELECT would also yield globex's order for `customer_id` 7, so
//          acme's customer 7 (worth 1000) is admitted by a filter no order of its
//          own satisfies. A cross-tenant leak that returns no foreign row at all.
describe('handleBatchQuery — semi-joins', () => {
  const CUSTOMERS = [
    { id: 1, tenant_id: 'acme', lifetime_value: 100 },
    { id: 2, tenant_id: 'acme', lifetime_value: 40 },
    // No shipped order of its own — must be excluded.
    { id: 3, tenant_id: 'acme', lifetime_value: 7 },
    // The cross-tenant collision probe: acme's customer 7 has NO acme order, but
    // globex has a shipped order whose `customer_id` is also 7.
    { id: 7, tenant_id: 'acme', lifetime_value: 1000 },
    { id: 9, tenant_id: 'globex', lifetime_value: 999 },
  ];
  const ORDERS = [
    { id: 'o1', tenant_id: 'acme', customer_id: 1, status: 'shipped' },
    { id: 'o2', tenant_id: 'acme', customer_id: 1, status: 'shipped' },
    { id: 'o3', tenant_id: 'acme', customer_id: 1, status: 'shipped' },
    { id: 'o4', tenant_id: 'acme', customer_id: 2, status: 'shipped' },
    { id: 'o5', tenant_id: 'acme', customer_id: 3, status: 'pending' },
    { id: 'o6', tenant_id: 'globex', customer_id: 7, status: 'shipped' },
    { id: 'o7', tenant_id: 'globex', customer_id: 9, status: 'shipped' },
  ];
  // Junction + remote tables for the two-hop (many-to-many) shape.
  const CUSTOMER_TAGS = [
    { id: 1, tenant_id: 'acme', customer_id: 1, tag_id: 10 },
    { id: 2, tenant_id: 'acme', customer_id: 3, tag_id: 11 },
    // globex's junction row points at the SAME tag and at a customer_id acme also
    // uses — the leak probe for the MIDDLE level.
    { id: 3, tenant_id: 'globex', customer_id: 7, tag_id: 10 },
  ];
  const TAGS = [
    { id: 10, tenant_id: 'acme', name: 'vip' },
    { id: 11, tenant_id: 'acme', name: 'standard' },
  ];

  const makeCustomersDb = () =>
    createMockDb({
      customers: CUSTOMERS,
      orders: ORDERS,
      customer_tags: CUSTOMER_TAGS,
      tags: TAGS,
    });

  const SHIPPED_SEMI_JOIN = {
    table: 'orders',
    column: 'id',
    foreignColumn: 'customer_id',
    filters: [{ column: 'status', operator: 'eq' as const, value: 'shipped' }],
  };

  const OPTIONS = {
    schemaAllowlist: ['customers', 'orders', 'customer_tags', 'tags'],
    tenancy: MULTI_TENANT,
  };

  /** `sum(lifetime_value)` over one tenant's customers, with `semiJoins` applied. */
  async function sumLifetimeValue(semiJoins: unknown, claims = ACME_CLAIMS) {
    const result = await handleBatchQuery(
      {
        pageId: 'p1',
        widgets: [
          {
            id: 'kpi',
            table: 'customers',
            aggregations: [{ column: 'lifetime_value', func: 'sum', alias: 'total' }],
            semiJoins,
          },
        ],
      } as unknown as BatchQueryRequest,
      claims,
      { db: makeCustomersDb(), ...OPTIONS, cacheProvider: new LRUCacheProvider() },
    );
    return result.results[0];
  }

  it('matches the in-memory semi-join answer — each qualifying customer counted ONCE', async () => {
    const kpi = await sumLifetimeValue([SHIPPED_SEMI_JOIN]);
    expect(kpi.error).toBeUndefined();
    // Customers 1 (100) and 2 (40) each have >= 1 shipped acme order. Customer 3
    // has only a pending one; customer 7 has none of its own.
    expect(kpi.rows).toEqual([{ total: 140 }]);
  });

  it("does NOT fan out: customer 1's three shipped orders contribute its value once, not 3x", async () => {
    const kpi = await sumLifetimeValue([SHIPPED_SEMI_JOIN]);
    // 340 is what `LEFT JOIN orders ON … WHERE orders.status = 'shipped'` would
    // return for this fixture (100x3 + 40). That number must be unreachable.
    expect(kpi.rows[0].total).not.toBe(340);
    expect(kpi.rows[0].total).toBe(140);
  });

  it("does not leak another tenant's foreign keys through the subquery", async () => {
    const kpi = await sumLifetimeValue([SHIPPED_SEMI_JOIN]);
    // 1140 = 140 + acme customer 7's 1000, admitted only if the inner SELECT
    // returned globex's `customer_id` 7. The leak returns NO globex row, so it is
    // invisible in the response rows — only the total gives it away.
    expect(kpi.rows[0].total).not.toBe(1140);
  });

  it('returns each tenant only its own answer for the identical descriptor', async () => {
    const acme = await sumLifetimeValue([SHIPPED_SEMI_JOIN], ACME_CLAIMS);
    const globex = await sumLifetimeValue([SHIPPED_SEMI_JOIN], GLOBEX_CLAIMS);
    expect(acme.rows).toEqual([{ total: 140 }]);
    // globex's customer 9 (999) has its own shipped order; acme's customers are
    // invisible to it in both the outer query and the subquery.
    expect(globex.rows).toEqual([{ total: 999 }]);
  });

  it('scopes every level of a two-hop (many-to-many) semi-join', async () => {
    const kpi = await sumLifetimeValue([
      {
        table: 'customer_tags',
        column: 'id',
        foreignColumn: 'customer_id',
        semiJoins: [
          {
            table: 'tags',
            column: 'tag_id',
            foreignColumn: 'id',
            filters: [{ column: 'name', operator: 'eq', value: 'vip' }],
          },
        ],
      },
    ]);
    // Only acme's customer 1 is tagged `vip` through an ACME junction row. The
    // globex junction row also points at tag 10 and at customer_id 7 — reachable
    // only if the JUNCTION level were unscoped, which would add 1000.
    expect(kpi.rows).toEqual([{ total: 100 }]);
    expect(kpi.rows[0].total).not.toBe(1100);
  });

  it('filters raw (non-aggregation) rows without duplicating them', async () => {
    const result = await handleBatchQuery(
      {
        pageId: 'p1',
        widgets: [
          {
            id: 'grid',
            table: 'customers',
            columns: ['id', 'lifetime_value'],
            semiJoins: [SHIPPED_SEMI_JOIN],
          },
        ],
      } as unknown as BatchQueryRequest,
      ACME_CLAIMS,
      { db: makeCustomersDb(), ...OPTIONS, cacheProvider: new LRUCacheProvider() },
    );
    // Exactly two rows — customer 1 appears ONCE despite three matching orders.
    expect(result.results[0].rows).toEqual([
      { id: 1, lifetime_value: 100 },
      { id: 2, lifetime_value: 40 },
    ]);
  });

  it('applies the semi-join to the preflight COUNT(*) too, so the reported rowCount matches', async () => {
    const result = await handleBatchQuery(
      {
        pageId: 'p1',
        widgets: [
          { id: 'grid', table: 'customers', columns: ['id'], semiJoins: [SHIPPED_SEMI_JOIN] },
        ],
      } as unknown as BatchQueryRequest,
      ACME_CLAIMS,
      { db: makeCustomersDb(), ...OPTIONS, cacheProvider: new LRUCacheProvider() },
    );
    // Unlike a join's COUNT(*), a semi-join's is not row-multiplied, so the
    // preflight total and the returned row count agree exactly.
    expect(result.results[0].rowCount).toBe(2);
    expect(result.results[0].rows).toHaveLength(2);
  });

  it('rejects a semi-join table that is not in the schema allowlist, before touching the db', async () => {
    const dbSpy = vi.fn((table: string) => makeCustomersDb()(table));
    await expectWidgetError(
      handleBatchQuery(
        {
          pageId: 'p1',
          widgets: [
            {
              id: 'w1',
              table: 'customers',
              semiJoins: [{ table: 'payroll', column: 'id', foreignColumn: 'customer_id' }],
            },
          ],
        } as unknown as BatchQueryRequest,
        ACME_CLAIMS,
        { db: dbSpy, schemaAllowlist: ['customers', 'orders'], tenancy: MULTI_TENANT },
      ),
      /Requested table\(s\) not in schema allowlist: payroll/,
    );
    expect(dbSpy).not.toHaveBeenCalled();
  });

  it('rejects a NESTED semi-join table that is not in the schema allowlist', async () => {
    const result = await handleBatchQuery(
      {
        pageId: 'p1',
        widgets: [
          {
            id: 'w1',
            table: 'customers',
            semiJoins: [
              {
                table: 'orders',
                column: 'id',
                foreignColumn: 'customer_id',
                semiJoins: [{ table: 'payroll', column: 'id', foreignColumn: 'order_id' }],
              },
            ],
          },
        ],
      } as unknown as BatchQueryRequest,
      ACME_CLAIMS,
      { db: makeCustomersDb(), schemaAllowlist: ['customers', 'orders'], tenancy: MULTI_TENANT },
    );
    expect(result.results[0].rows).toEqual([]);
    expect(result.results[0].error).toMatch(
      /Requested table\(s\) not in schema allowlist: payroll/,
    );
    // The allowlisted sibling table is not implicated — only the offending one is named.
    expect(result.results[0].error).not.toMatch(/orders/);
  });

  it('rejects a qualified subquery filter column naming a non-allowlisted table', async () => {
    const result = await handleBatchQuery(
      {
        pageId: 'p1',
        widgets: [
          {
            id: 'w1',
            table: 'customers',
            semiJoins: [
              {
                table: 'orders',
                column: 'id',
                foreignColumn: 'customer_id',
                filters: [{ column: 'payroll.salary', operator: 'gt', value: 1 }],
              },
            ],
          },
        ],
      } as unknown as BatchQueryRequest,
      ACME_CLAIMS,
      { db: makeCustomersDb(), schemaAllowlist: ['customers', 'orders'], tenancy: MULTI_TENANT },
    );
    expect(result.results[0].rows).toEqual([]);
    // Runs UNCONDITIONALLY — no `columnAllowlist` is configured here, so this is the
    // Zero-Knowledge Rule reaching a reference that names a table only through a subquery
    // predicate.
    expect(result.results[0].error).toMatch(/names table "payroll", which is not in the/);
  });

  it('rejects a qualified subquery filter column naming a non-allowlisted table at ANY nesting depth', async () => {
    // The recursion, not the top-level call. `checkSemiJoinColumns` walks
    // `semiJoin.semiJoins` at the end of each entry; dropping that one line left
    // every reference BELOW the first level unchecked. Both semi-join TABLES here
    // are allowlisted, so `assertTablesAllowed` (which is the recursive check the
    // level-1 test above also passes through) has nothing to say — the only thing
    // standing between the caller and `payroll` is this recursive column walk.
    //
    // The leak it prevents is not a projection: it is a one-bit-per-row oracle.
    // `WHERE payroll.salary > 1` inside a nested subquery decides which of the
    // caller's OWN customers come back, so a caller can binary-search a column of
    // a table it was never granted, one request at a time.
    const result = await handleBatchQuery(
      {
        pageId: 'p1',
        widgets: [
          {
            id: 'w1',
            table: 'customers',
            semiJoins: [
              {
                table: 'orders',
                column: 'id',
                foreignColumn: 'customer_id',
                semiJoins: [
                  {
                    table: 'orders',
                    column: 'id',
                    foreignColumn: 'id',
                    filters: [{ column: 'payroll.salary', operator: 'gt', value: 1 }],
                  },
                ],
              },
            ],
          },
        ],
      } as unknown as BatchQueryRequest,
      ACME_CLAIMS,
      { db: makeCustomersDb(), schemaAllowlist: ['customers', 'orders'], tenancy: MULTI_TENANT },
    );
    expect(result.results[0].rows).toEqual([]);
    expect(result.results[0].error).toMatch(/names table "payroll", which is not in the/);
  });

  it('de-duplicates a repeated semi-joined table in the cache tags (F19)', async () => {
    // `collectSemiJoinTables` skips a table it has already collected. Without
    // that check the same table is tagged once per occurrence, so every
    // `deleteByTag`-driven invalidation walks duplicate tags, and the tag list a
    // host inspects misrepresents the query's actual table set. A two-hop
    // self-referencing shape (`orders` → `orders`) is the ordinary way this
    // arises.
    const tagged: string[][] = [];
    const recordingCache = {
      get: async () => undefined,
      set: async (_key: string, _entry: unknown, opts?: { tags?: string[] }) => {
        tagged.push(opts?.tags ?? []);
      },
      invalidatePrefix: async () => {},
      deleteByTag: async () => {},
    };
    await handleBatchQuery(
      {
        pageId: 'p1',
        widgets: [
          {
            id: 'grid',
            table: 'customers',
            columns: ['id'],
            semiJoins: [
              {
                table: 'orders',
                column: 'id',
                foreignColumn: 'customer_id',
                semiJoins: [{ table: 'orders', column: 'id', foreignColumn: 'id' }],
              },
              { table: 'orders', column: 'id', foreignColumn: 'customer_id' },
            ],
          },
        ],
      } as unknown as BatchQueryRequest,
      ACME_CLAIMS,
      { db: makeCustomersDb(), ...OPTIONS, cacheProvider: recordingCache as never },
    );
    // Three references to `orders`, one tag.
    expect(tagged[0]).toEqual(['customers', 'orders']);
  });

  it('tags the cached result with every semi-joined table, so a mutation to it invalidates', async () => {
    const tagged: string[][] = [];
    const recordingCache = {
      get: async () => undefined,
      set: async (_key: string, _entry: unknown, opts?: { tags?: string[] }) => {
        tagged.push(opts?.tags ?? []);
      },
      invalidatePrefix: async () => {},
      deleteByTag: async () => {},
    };
    await handleBatchQuery(
      {
        pageId: 'p1',
        widgets: [
          {
            id: 'grid',
            table: 'customers',
            columns: ['id'],
            semiJoins: [
              {
                table: 'customer_tags',
                column: 'id',
                foreignColumn: 'customer_id',
                semiJoins: [{ table: 'tags', column: 'tag_id', foreignColumn: 'id' }],
              },
            ],
          },
        ],
      } as unknown as BatchQueryRequest,
      ACME_CLAIMS,
      { db: makeCustomersDb(), ...OPTIONS, cacheProvider: recordingCache as never },
    );
    // Both nesting levels are tagged: a mutation to either changes which outer
    // rows the subquery admits, exactly as a mutation to a JOINED table does.
    expect(tagged[0]).toEqual(['customers', 'customer_tags', 'tags']);
  });

  it('folds semiJoins into the cache key — two otherwise-identical widgets do not share an entry', () => {
    const withoutSemiJoin = generateCacheKey(ACME_CLAIMS, { id: 'w1', table: 'customers' }, 'k');
    const withSemiJoin = generateCacheKey(
      ACME_CLAIMS,
      { id: 'w1', table: 'customers', semiJoins: [SHIPPED_SEMI_JOIN] },
      'k',
    );
    const withDifferentValue = generateCacheKey(
      ACME_CLAIMS,
      {
        id: 'w1',
        table: 'customers',
        semiJoins: [
          {
            ...SHIPPED_SEMI_JOIN,
            filters: [{ column: 'status', operator: 'eq' as const, value: 'pending' }],
          },
        ],
      },
      'k',
    );
    expect(withSemiJoin).not.toBe(withoutSemiJoin);
    expect(withSemiJoin).not.toBe(withDifferentValue);
  });

  it('rejects a semiJoins tree whose TOTAL entry count exceeds the per-widget cap', async () => {
    // Each level individually satisfies the per-array cap; only the SUM across
    // levels exceeds it — the product gap the recursive walk closes.
    const wide = Array.from({ length: 120 }, () => ({
      table: 'orders',
      column: 'id',
      foreignColumn: 'customer_id',
      semiJoins: [{ table: 'tags', column: 'id', foreignColumn: 'id' }],
    }));
    await expect(
      handleBatchQuery(
        {
          pageId: 'p1',
          widgets: [{ id: 'w1', table: 'customers', semiJoins: wide }],
        } as unknown as BatchQueryRequest,
        ACME_CLAIMS,
        { db: makeCustomersDb(), ...OPTIONS },
      ),
    ).rejects.toThrow(
      // Reported count is the running total at the moment the cap is crossed
      // (201), not the tree's full size — the walk fails fast rather than
      // finishing an already-over-budget traversal.
      new RegExp(
        `"semiJoins" contains ${MAX_ARRAY_ITEMS_PER_DESCRIPTOR + 1} entries in total across every ` +
          `nesting level, which exceeds the maximum of ${MAX_ARRAY_ITEMS_PER_DESCRIPTOR}`,
      ),
    );
  });

  it('rejects a semi-join whose own "filters" array exceeds MAX_ARRAY_ITEMS_PER_DESCRIPTOR, even with no operator/value on any entry', async () => {
    // Every predicate object is invisible to `checkPredicateValueBounds` — it has
    // no "value" key at all, so it contributes 0 to the summed comparison-value
    // budget checked elsewhere in this describe block. Only the ARRAY LENGTH
    // itself — not the values inside it — should be what gets this rejected.
    const oversizedFilters = Array.from({ length: MAX_ARRAY_ITEMS_PER_DESCRIPTOR + 1 }, () => ({
      column: 'orders.status',
    }));
    await expect(
      handleBatchQuery(
        {
          pageId: 'p1',
          widgets: [
            {
              id: 'w1',
              table: 'customers',
              semiJoins: [
                {
                  table: 'orders',
                  column: 'id',
                  foreignColumn: 'customer_id',
                  filters: oversizedFilters,
                },
              ],
            },
          ],
        } as unknown as BatchQueryRequest,
        ACME_CLAIMS,
        { db: makeCustomersDb(), ...OPTIONS },
      ),
    ).rejects.toThrow(
      new RegExp(
        `"semiJoins\\[0\\]\\.filters" contains ${MAX_ARRAY_ITEMS_PER_DESCRIPTOR + 1} entries, which exceeds the maximum of ${MAX_ARRAY_ITEMS_PER_DESCRIPTOR}`,
      ),
    );
  });

  it('counts subquery predicate values against the widget-wide value budget', async () => {
    // Neither array is over its own cap and the widget's own `filters` is empty —
    // the total only exceeds the budget once the SUBQUERY predicates are counted.
    const perFilterValues = Array.from({ length: 150 }, (_unused, i) => i);
    const semiJoins = Array.from({ length: 20 }, () => ({
      table: 'orders',
      column: 'id',
      foreignColumn: 'customer_id',
      filters: [{ column: 'status', operator: 'in', value: perFilterValues }],
    }));
    await expect(
      handleBatchQuery(
        {
          pageId: 'p1',
          widgets: [{ id: 'w1', table: 'customers', semiJoins }],
        } as unknown as BatchQueryRequest,
        ACME_CLAIMS,
        { db: makeCustomersDb(), ...OPTIONS },
      ),
    ).rejects.toThrow(
      new RegExp(
        `contains 3000 comparison values in total across all filters, which exceeds the maximum of ${MAX_PREDICATE_VALUES_PER_DESCRIPTOR}`,
      ),
    );
  });

  it('rejects a non-array "semiJoins" as a whole-request shape error', async () => {
    await expect(
      handleBatchQuery(
        {
          pageId: 'p1',
          widgets: [{ id: 'w1', table: 'customers', semiJoins: 'nope' }],
        } as unknown as BatchQueryRequest,
        ACME_CLAIMS,
        { db: makeCustomersDb(), ...OPTIONS },
      ),
    ).rejects.toThrow(/"semiJoins" must be an array/);
  });
});
