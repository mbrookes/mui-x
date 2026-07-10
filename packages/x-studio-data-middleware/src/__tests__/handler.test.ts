/**
 * Integration tests for @mui/x-studio-data-middleware
 *
 * Tests the full pipeline: security extraction → cache key → query building
 * → tier selection → handler output. Uses a lightweight in-memory mock Knex
 * builder (no native module dependencies).
 */
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { handleBatchQuery } from '../handler';
import { generateCacheKey } from '../security/cacheKey';
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

function makeDb() {
  return createMockDb({ sales: SALES_ROWS });
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

  function makeJwt(payload: Record<string, unknown>, secret: string): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
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
  it('rejects a referenced table that has no entry in the column allowlist', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [{ id: 'w1', table: 'sales', columns: ['region'] }],
    };
    await expect(
      handleBatchQuery(body, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: SINGLE_TENANT,
        columnAllowlist: { orders: ['id'] }, // no 'sales' entry
      }),
    ).rejects.toThrow(/Table "sales" has no entry in the column allowlist/);
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

  it('rejects a NO-columns widget whose table has no allowlist entry (finding 1.1)', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [{ id: 'w1', table: 'sales' }],
    };
    await expect(
      handleBatchQuery(body, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: SINGLE_TENANT,
        columnAllowlist: { orders: ['id'] }, // no 'sales' entry
      }),
    ).rejects.toThrow(/Table "sales" has no entry in the column allowlist/);
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
    // No columnAllowlist needed — the direction check is unconditional and
    // rejects the whole batch.
    await expect(
      handleBatchQuery(body, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: SINGLE_TENANT,
      }),
    ).rejects.toThrow(/ORDER BY direction/);
  });

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
    await expect(
      handleBatchQuery(body, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales', 'customers'],
        tenancy: SINGLE_TENANT,
        // 'sales' present, but no 'customers' entry → join.on right side is rejected.
        columnAllowlist: { sales: ['region', 'customer_id'] },
      }),
    ).rejects.toThrow(/Table "customers" has no entry in the column allowlist \(join.on\)/);
  });

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
    await expect(
      handleBatchQuery(body, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales', 'customers'],
        tenancy: SINGLE_TENANT,
        columnAllowlist: { sales: ['region', 'customer_id', 'id'], customers: ['name'] },
      }),
    ).rejects.toThrow(/Column "id" on table "customers" is not in the column allowlist/);
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
      await expect(
        handleBatchQuery({ pageId: 'p1', widgets: [widget] }, ACME_CLAIMS, {
          db: makeDb(),
          schemaAllowlist: ['sales', 'customers'],
          tenancy: SINGLE_TENANT,
          columnAllowlist: { sales: ['region', 'revenue', 'customer_id'], customers: [] },
        }),
      ).rejects.toThrow(/is not in the column allowlist/);
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

describe('handleBatchQuery — schema allowlist enforcement', () => {
  it('throws when a requested table is not in the allowlist', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [{ id: 'w1', table: 'users' }],
    };

    await expect(
      handleBatchQuery(body, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: SINGLE_TENANT,
      }),
    ).rejects.toThrow('not in schema allowlist');
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
    // The cache hit echoes the ORIGINATING tier. These few rows route to the
    // 'client' tier, so the second (cached) response must also report 'client'
    // — not a hardcoded 'server'.
    expect(result1.results[0].tier).toBe('client');
    expect(result2.results[0].tier).toBe('client');
  });

  it('a cache hit echoes the tier that produced the cached rows (not a hardcoded server)', async () => {
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
      qb.leftJoin = () => qb;
      qb.join = () => qb;
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
      TIER_CACHE_KEY_PREFIX + generateCacheKey(ACME_CLAIMS, body.widgets[0]),
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

  it('counts occurrences per group (same column in columns and aggregations)', async () => {
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [
        {
          id: 'w1',
          table: 'sales',
          columns: ['product'],
          aggregations: [{ column: 'product', func: 'count', alias: 'count' }],
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

    await expect(
      handleBatchQuery(body, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: MULTI_TENANT,
        columnAllowlist: { sales: ['region', 'amount'] },
      }),
    ).rejects.toThrow(/Column "product" on table "sales" is not in the column allowlist/);
  });

  // finding 2.4 — an unknown aggregation `func` must produce a clear, clean
  // rejection instead of being silently dropped (which would otherwise return a
  // confusing, silently-incomplete GROUP BY with a missing measure column). The
  // throw lives in `execute.ts`'s per-widget execution path (mirroring a DB
  // error), so — like any other execution failure — it surfaces as this
  // widget's `error` rather than rejecting the whole batch (finding 2.1's
  // execution/validation error-isolation asymmetry is a deliberate, separate
  // design decision, not something this fix changes).
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

    const cacheKey = generateCacheKey(ACME_CLAIMS, body.widgets[0]);
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
    const cache = new LRUCacheProvider({ ttlMs: 5000 });
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
      cacheProvider: cache,
    });

    expect(result.results[0].tier).toBe('db');
    const cacheKey = generateCacheKey(ACME_CLAIMS, body.widgets[0]);
    expect(await cache.get(cacheKey)).toBeUndefined();
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

  it('HAVING alias not in aggregations throws a security error', async () => {
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

    await expect(
      handleBatchQuery(body, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: SINGLE_TENANT,
        columnAllowlist,
      }),
    ).rejects.toThrow('HAVING alias "raw_amount" does not match any aggregation alias');
  });

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

    await expect(
      handleBatchQuery(body, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: SINGLE_TENANT,
        // NO columnAllowlist supplied.
      }),
    ).rejects.toThrow('HAVING alias "raw_amount" does not match any aggregation alias');
  });

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

    await expect(
      handleBatchQuery(body, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: SINGLE_TENANT,
      }),
    ).rejects.toThrow(/require at least one aggregation/);
  });

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

    await expect(
      handleBatchQuery(body, ACME_CLAIMS, {
        db: makeDb(),
        schemaAllowlist: ['sales'],
        tenancy: SINGLE_TENANT,
        columnAllowlist,
      }),
    ).rejects.toThrow(/Aggregation alias .* contains characters outside the allowed set/);
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
    expect(result.results[0].error).toMatch('no such column: computed_revenue');
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
    // The mock adds leftJoin support (no-op) to verify the full code path runs
    // without throwing and returns the primary table's aggregated values.
    const joinCapableDb = (table: string) => {
      const qb = makeDb()(table) as any;
      qb.leftJoin = () => qb;
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
    expect(errResult.error).toMatch('db connection failed');
  });
});
