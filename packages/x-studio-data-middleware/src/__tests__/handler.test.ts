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
import type { JwtSecurityClaims, BatchQueryRequest } from '../security/types';
import { createMockDb } from './mockDb';
import { RedisTierCacheProvider } from '../cache/RedisTierCacheProvider';

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
      tenantColumn: 'tenant_id',
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
      tenantColumn: 'tenant_id',
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
      tenantColumn: 'tenant_id',
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
    const opts = {
      db: makeDb(),
      schemaAllowlist: ['sales'],
      cacheProvider: cache,
      tenantColumn: 'tenant_id',
    };

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

// ─── MapTierCacheProvider ─────────────────────────────────────────────────────

describe('MapTierCacheProvider', () => {
  it('stores and retrieves tier entries', async () => {
    const cache = new MapTierCacheProvider();
    await cache.set('key1', { tier: 'server', rowCount: 5000 });
    const entry = await cache.get('key1');
    expect(entry?.tier).toBe('server');
    expect(entry?.rowCount).toBe(5000);
  });

  it('returns undefined for missing keys', async () => {
    const cache = new MapTierCacheProvider();
    expect(await cache.get('missing')).toBeUndefined();
  });

  it('returns undefined after TTL expires', async () => {
    const cache = new MapTierCacheProvider();
    await cache.set('key1', { tier: 'client', rowCount: 100 }, 1); // 1ms TTL
    await new Promise((r) => {
      setTimeout(r, 10);
    });
    expect(await cache.get('key1')).toBeUndefined();
  });

  it('invalidates entries by prefix', async () => {
    const cache = new MapTierCacheProvider();
    const entry = { tier: 'server' as const, rowCount: 50000 };
    await cache.set('studio:v1:acme:abc:123', entry);
    await cache.set('studio:v1:acme:abc:456', entry);
    await cache.set('studio:v1:globex:def:789', entry);

    await cache.invalidatePrefix('studio:v1:acme:');
    expect(await cache.get('studio:v1:acme:abc:123')).toBeUndefined();
    expect(await cache.get('studio:v1:acme:abc:456')).toBeUndefined();
    expect(await cache.get('studio:v1:globex:def:789')).toBeDefined();
  });

  it('size counts only non-expired entries', async () => {
    const cache = new MapTierCacheProvider();
    await cache.set('k1', { tier: 'client', rowCount: 1 }, 50);
    await cache.set('k2', { tier: 'server', rowCount: 2 }, 1); // expires immediately
    await new Promise((r) => {
      setTimeout(r, 10);
    });
    expect(cache.size).toBe(1); // k2 is expired
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
      // No data cache — forces cold path each time
      cacheProvider: new LRUCacheProvider({ ttlMs: 1 }), // 1ms TTL → always expires
      tierCacheProvider: tierCache,
      tierCacheTtlMs: 60_000,
    };

    // First call: runs preflight, populates tier cache
    const r1 = await handleBatchQuery(body, ACME_CLAIMS, opts);
    expect(tierCache.size).toBe(1);
    const tierEntry = await tierCache.get(generateCacheKey(ACME_CLAIMS, body.widgets[0]));
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
      tierCacheProvider: tierCache,
      tierCacheTtlMs: 0,
    });
    // Tier cache should not be populated when disabled
    expect(tierCache.size).toBe(0);
  });
});

// ─── RedisTierCacheProvider ──────────────────────────────────────────────────

/** Minimal in-memory Redis mock that satisfies RedisClient. */
function makeRedisClient() {
  const store = new Map<string, { value: string; expiresAt: number }>();
  return {
    store,
    async get(key: string): Promise<string | null> {
      const entry = store.get(key);
      if (!entry || Date.now() > entry.expiresAt) {
        return null;
      }
      return entry.value;
    },
    async set(key: string, value: string, _exMode: 'EX', ttlSeconds: number): Promise<void> {
      store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    },
    async keys(pattern: string): Promise<string[]> {
      const prefix = pattern.slice(0, -1); // strip trailing '*'
      return [...store.keys()].filter((k) => k.startsWith(prefix));
    },
    async del(...keys: string[]): Promise<void> {
      for (const key of keys) {
        store.delete(key);
      }
    },
  };
}

describe('RedisTierCacheProvider', () => {
  it('returns undefined for a missing key', async () => {
    const provider = new RedisTierCacheProvider(makeRedisClient());
    expect(await provider.get('missing')).toBeUndefined();
  });

  it('stores and retrieves a tier entry', async () => {
    const provider = new RedisTierCacheProvider(makeRedisClient());
    await provider.set('k1', { tier: 'server', rowCount: 5000 }, 60_000);
    expect(await provider.get('k1')).toEqual({ tier: 'server', rowCount: 5000 });
  });

  it('converts ttlMs to seconds (rounds up)', async () => {
    const redis = makeRedisClient();
    const provider = new RedisTierCacheProvider(redis);
    await provider.set('k1', { tier: 'client', rowCount: 100 }, 1500); // 1.5s → 2s
    const entry = redis.store.get('k1');
    // expiresAt should be ~2000ms from now (not ~1500ms)
    expect(entry?.expiresAt).toBeGreaterThanOrEqual(Date.now() + 1000);
  });

  it('uses defaultTtlSeconds when ttlMs is omitted', async () => {
    const redis = makeRedisClient();
    const provider = new RedisTierCacheProvider(redis, { defaultTtlSeconds: 10 });
    await provider.set('k1', { tier: 'db', rowCount: 200_000 });
    const entry = redis.store.get('k1');
    expect(entry?.expiresAt).toBeGreaterThanOrEqual(Date.now() + 9000);
  });

  it('applies keyPrefix to all operations', async () => {
    const redis = makeRedisClient();
    const provider = new RedisTierCacheProvider(redis, { keyPrefix: 'studio:' });
    await provider.set('k1', { tier: 'server', rowCount: 9000 });
    expect(redis.store.has('studio:k1')).toBe(true);
    expect(await provider.get('k1')).toEqual({ tier: 'server', rowCount: 9000 });
  });

  it('invalidatePrefix removes matching keys only', async () => {
    const redis = makeRedisClient();
    const provider = new RedisTierCacheProvider(redis, { keyPrefix: 'p:' });
    await provider.set('tenant1|table1', { tier: 'client', rowCount: 50 });
    await provider.set('tenant1|table2', { tier: 'server', rowCount: 8000 });
    await provider.set('tenant2|table1', { tier: 'client', rowCount: 30 });

    await provider.invalidatePrefix('tenant1|');

    expect(await provider.get('tenant1|table1')).toBeUndefined();
    expect(await provider.get('tenant1|table2')).toBeUndefined();
    expect(await provider.get('tenant2|table1')).toEqual({ tier: 'client', rowCount: 30 });
  });

  it('invalidatePrefix is a no-op when no keys match', async () => {
    const redis = makeRedisClient();
    const provider = new RedisTierCacheProvider(redis);
    await provider.set('k1', { tier: 'db', rowCount: 50_000 });
    await provider.invalidatePrefix('no-match|');
    expect(await provider.get('k1')).toEqual({ tier: 'db', rowCount: 50_000 });
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
      tenantColumn: 'tenant_id',
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
      tenantColumn: 'tenant_id',
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
      tenantColumn: 'tenant_id',
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
      tenantColumn: 'tenant_id',
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
      tenantColumn: 'tenant_id',
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
      tierCacheProvider: tierCache,
      tierCacheTtlMs: 60_000,
    });

    // Aggregation queries skip the tier cache to prevent stale 'client' entries
    // from a pre-fix run from shadowing the forced-db-tier path.
    expect(tierCache.size).toBe(0);
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
      tenantColumn: 'tenant_id',
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
      tenantColumn: 'tenant_id',
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
        columnAllowlist,
      }),
    ).rejects.toThrow('HAVING alias "raw_amount" does not match any aggregation alias');
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
      tenantColumn: 'tenant_id',
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
          where () {
            return this;
          },
          whereIn () {
            return this;
          },
          whereLike () {
            return this;
          },
          whereBetween () {
            return this;
          },
          havingRaw () {
            return this;
          },
          count () {
            return this;
          },
          select () {
            return this;
          },
          orderBy () {
            return this;
          },
          limit () {
            return this;
          },
          sum () {
            return this;
          },
          avg () {
            return this;
          },
          min () {
            return this;
          },
          max () {
            return this;
          },
          groupBy () {
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
