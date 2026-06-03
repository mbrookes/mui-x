/**
 * Integration tests for @mui/x-studio-middleware
 *
 * Tests the full pipeline: security extraction → cache key → query building
 * → tier selection → handler output. Uses a lightweight in-memory mock Knex
 * builder (no native module dependencies).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { handleBatchQuery } from '../handler';
import { generateCacheKey } from '../security/cacheKey';
import { extractSecurityClaims } from '../security/extractSecurityClaims';
import { LRUCacheProvider } from '../cache/LRUCacheProvider';
import type { JwtSecurityClaims, BatchQueryRequest } from '../security/types';
import { createMockDb } from './mockDb';

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
    const { createHmac } = require('node:crypto') as typeof import('node:crypto');
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
    });

    const rows = result.results[0].rows;
    for (const row of rows) {
      expect(row.amount).toBeGreaterThanOrEqual(150);
    }
  });
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
    const opts = { db: makeDb(), schemaAllowlist: ['sales'], cacheProvider: cache };

    const result1 = await handleBatchQuery(body, ACME_CLAIMS, opts);
    const result2 = await handleBatchQuery(body, ACME_CLAIMS, opts);

    expect(result2.results[0].rows).toEqual(result1.results[0].rows);
    expect(result2.results[0].tier).toBe('server');
  });

  it('different tenants do not share cache entries', async () => {
    const cache = new LRUCacheProvider({ ttlMs: 5000 });
    const body: BatchQueryRequest = {
      pageId: 'p1',
      widgets: [{ id: 'w1', table: 'sales' }],
    };
    const opts = { db: makeDb(), schemaAllowlist: ['sales'], cacheProvider: cache };

    const acmeResult = await handleBatchQuery(body, ACME_CLAIMS, opts);
    const globexResult = await handleBatchQuery(body, GLOBEX_CLAIMS, opts);

    const acmeTenantIds = new Set(acmeResult.results[0].rows.map((r) => r.tenant_id));
    const globexTenantIds = new Set(globexResult.results[0].rows.map((r) => r.tenant_id));
    expect([...acmeTenantIds]).toEqual(['acme']);
    expect([...globexTenantIds]).toEqual(['globex']);
  });
});

// ─── LRUCacheProvider ─────────────────────────────────────────────────────────

describe('LRUCacheProvider', () => {
  it('stores and retrieves values', async () => {
    const cache = new LRUCacheProvider({ ttlMs: 5000 });
    const entry = { rows: [{ id: 1 }], cachedAt: Date.now() };
    await cache.set('key1', entry);
    const retrieved = await cache.get('key1');
    expect(retrieved?.rows).toEqual(entry.rows);
  });

  it('returns undefined for missing keys', async () => {
    const cache = new LRUCacheProvider();
    const result = await cache.get('nonexistent');
    expect(result).toBeUndefined();
  });

  it('invalidates entries by prefix', async () => {
    const cache = new LRUCacheProvider({ ttlMs: 5000 });
    const entry = { rows: [], cachedAt: Date.now() };
    await cache.set('studio:v1:acme:abc:123', entry);
    await cache.set('studio:v1:acme:abc:456', entry);
    await cache.set('studio:v1:globex:def:789', entry);

    await cache.invalidatePrefix('studio:v1:acme:');
    expect(await cache.get('studio:v1:acme:abc:123')).toBeUndefined();
    expect(await cache.get('studio:v1:acme:abc:456')).toBeUndefined();
    expect(await cache.get('studio:v1:globex:def:789')).toBeDefined();
  });
});
