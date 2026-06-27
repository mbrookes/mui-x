/**
 * Tests for `handleMutation` — the top-level batch mutation handler.
 *
 * Covers:
 * - Table allowlist rejection (all-or-nothing)
 * - Per-mutation error isolation (one failure doesn't abort the rest)
 * - Successful insert/update/delete return ok=true with rowsAffected
 * - Tenant isolation enforced on each operation
 * - Cache invalidation called per successful mutation
 * - Unknown operation produces per-item error (not a batch throw)
 */
import { describe, it, expect } from 'vitest';
import { handleMutation } from '../handleMutation';
import type { BatchMutationRequest, CacheProvider } from '../../index';

// ── Mutable in-memory mock DB (same as mutationBuilder.test.ts) ───────────────

type Row = Record<string, unknown>;

function createMutableMockDb(initialTables: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = Object.fromEntries(
    Object.entries(initialTables).map(([k, v]) => [k, v.map((r) => ({ ...r }))]),
  );

  function db(table: string) {
    const predicates: Array<(row: Row) => boolean> = [];
    let pendingInsertValues: Row | null = null;
    let pendingUpdateValues: Row | null = null;
    let pendingDelete = false;

    const qb: any = {
      where(col: string, op: string, val?: unknown) {
        const key = col.includes('.') ? col.split('.').pop()! : col;
        if (val !== undefined) {
          if (op === '=') {
            predicates.push((r) => r[key] === val);
          } else if (op === '!=') {
            predicates.push((r) => r[key] !== val);
          } else if (op === '<') {
            predicates.push((r) => (r[key] as number) < (val as number));
          } else if (op === '>') {
            predicates.push((r) => (r[key] as number) > (val as number));
          }
        } else {
          predicates.push((r) => r[key] === op);
        }
        return qb;
      },
      whereIn(col: string, vals: unknown[]) {
        const key = col.includes('.') ? col.split('.').pop()! : col;
        predicates.push((r) => vals.includes(r[key]));
        return qb;
      },
      insert(values: Row) {
        pendingInsertValues = values;
        return qb;
      },
      update(values: Row) {
        pendingUpdateValues = values;
        return qb;
      },
      delete() {
        pendingDelete = true;
        return qb;
      },
      then(resolve: (v: unknown) => void, reject?: (err: Error) => void) {
        try {
          tables[table] ??= [];
          const rows = tables[table];
          if (pendingInsertValues !== null) {
            rows.push({ ...pendingInsertValues });
            resolve([rows.length]);
            return;
          }
          const matched = rows.filter((r) => predicates.every((p) => p(r)));
          if (pendingUpdateValues !== null) {
            for (const r of matched) {
              Object.assign(r, pendingUpdateValues);
            }
            resolve(matched.length);
            return;
          }
          if (pendingDelete) {
            const before = rows.length;
            tables[table] = rows.filter((r) => !predicates.every((p) => p(r)));
            resolve(before - tables[table].length);
            return;
          }
          resolve(matched);
        } catch (caught) {
          reject?.(caught as Error);
        }
      },
    };
    return qb;
  }

  db.snapshot = () => {
    const result: Record<string, Row[]> = {};
    for (const [k, v] of Object.entries(tables)) {
      result[k] = v.map((r) => ({ ...r }));
    }
    return result;
  };

  return db;
}

function makeCacheProvider(): CacheProvider & { deletedTags: string[] } {
  const deletedTags: string[] = [];
  return {
    deletedTags,
    async get() {
      return undefined;
    },
    async set() {},
    async invalidatePrefix() {},
    async deleteByTag(tag: string) {
      deletedTags.push(tag);
    },
  };
}

const CLAIMS = { tenantId: 'acme', userId: 'u1', roleIds: ['editor'] };
const ALLOWLIST = ['orders', 'customers'];

// ── Table allowlist ───────────────────────────────────────────────────────────

describe('handleMutation — table allowlist', () => {
  it('throws synchronously when any table is not in the allowlist', async () => {
    const db = createMutableMockDb({ orders: [] });
    const body: BatchMutationRequest = {
      mutations: [
        { id: 'm1', operation: 'insert', table: 'orders', values: { status: 'pending' } },
        {
          id: 'm2',
          operation: 'delete',
          table: 'secrets',
          where: [{ column: 'id', operator: 'eq', value: 1 }],
        },
      ],
    };
    await expect(handleMutation(body, CLAIMS, { db, schemaAllowlist: ALLOWLIST })).rejects.toThrow(
      /not in schema allowlist/,
    );
  });
});

// ── Successful mutations ──────────────────────────────────────────────────────

describe('handleMutation — successful operations', () => {
  it('inserts a row and returns ok=true with rowsAffected=1', async () => {
    const db = createMutableMockDb({ orders: [] });
    const body: BatchMutationRequest = {
      mutations: [
        {
          id: 'm1',
          operation: 'insert',
          table: 'orders',
          values: { status: 'pending', total: 250 },
        },
      ],
    };
    const { results } = await handleMutation(body, CLAIMS, { db, schemaAllowlist: ALLOWLIST });
    expect(results[0]).toMatchObject({ id: 'm1', ok: true, rowsAffected: 1 });
    expect(db.snapshot().orders).toHaveLength(1);
  });

  it('updates matching rows and returns rowsAffected count', async () => {
    const db = createMutableMockDb({
      orders: [
        { id: 1, tenant_id: 'acme', status: 'pending' },
        { id: 2, tenant_id: 'acme', status: 'pending' },
      ],
    });
    const body: BatchMutationRequest = {
      mutations: [
        {
          id: 'm1',
          operation: 'update',
          table: 'orders',
          values: { status: 'shipped' },
          where: [{ column: 'status', operator: 'eq', value: 'pending' }],
        },
      ],
    };
    const { results } = await handleMutation(body, CLAIMS, {
      db,
      schemaAllowlist: ALLOWLIST,
      tenantColumn: 'tenant_id',
    });
    expect(results[0]).toMatchObject({ id: 'm1', ok: true, rowsAffected: 2 });
  });

  it('deletes matching rows and returns rowsAffected count', async () => {
    const db = createMutableMockDb({
      orders: [
        { id: 1, tenant_id: 'acme', status: 'cancelled' },
        { id: 2, tenant_id: 'acme', status: 'shipped' },
      ],
    });
    const body: BatchMutationRequest = {
      mutations: [
        {
          id: 'm1',
          operation: 'delete',
          table: 'orders',
          where: [{ column: 'status', operator: 'eq', value: 'cancelled' }],
        },
      ],
    };
    const { results } = await handleMutation(body, CLAIMS, {
      db,
      schemaAllowlist: ALLOWLIST,
      tenantColumn: 'tenant_id',
    });
    expect(results[0]).toMatchObject({ id: 'm1', ok: true, rowsAffected: 1 });
    expect(db.snapshot().orders).toHaveLength(1);
  });
});

// ── Per-mutation error isolation ──────────────────────────────────────────────

describe('handleMutation — per-mutation error isolation', () => {
  it('returns ok=false for a bad mutation but ok=true for a valid sibling', async () => {
    const db = createMutableMockDb({ orders: [], customers: [] });
    const body: BatchMutationRequest = {
      mutations: [
        // This one has no WHERE — should fail validation
        { id: 'bad', operation: 'update', table: 'orders', values: { status: 'shipped' } },
        // This one is valid
        { id: 'good', operation: 'insert', table: 'customers', values: { name: 'Alice' } },
      ],
    };
    const { results } = await handleMutation(body, CLAIMS, { db, schemaAllowlist: ALLOWLIST });
    const bad = results.find((r) => r.id === 'bad')!;
    const good = results.find((r) => r.id === 'good')!;
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/requires at least one "where"/);
    expect(good.ok).toBe(true);
    expect(good.rowsAffected).toBe(1);
  });

  it('surfaces an unknown operation error per-item without aborting the batch', async () => {
    const db = createMutableMockDb({ orders: [] });
    const body: BatchMutationRequest = {
      mutations: [
        { id: 'bad', operation: 'upsert' as any, table: 'orders', values: { status: 'ok' } },
        { id: 'good', operation: 'insert', table: 'orders', values: { status: 'pending' } },
      ],
    };
    const { results } = await handleMutation(body, CLAIMS, { db, schemaAllowlist: ALLOWLIST });
    expect(results.find((r) => r.id === 'bad')?.ok).toBe(false);
    expect(results.find((r) => r.id === 'good')?.ok).toBe(true);
  });
});

// ── Cache invalidation ────────────────────────────────────────────────────────

describe('handleMutation — cache invalidation', () => {
  it('calls deleteByTag for the table after each successful mutation', async () => {
    const db = createMutableMockDb({ orders: [] });
    const cache = makeCacheProvider();
    const body: BatchMutationRequest = {
      mutations: [
        { id: 'm1', operation: 'insert', table: 'orders', values: { status: 'pending' } },
        { id: 'm2', operation: 'insert', table: 'orders', values: { status: 'shipped' } },
      ],
    };
    await handleMutation(body, CLAIMS, { db, schemaAllowlist: ALLOWLIST, cacheProvider: cache });
    expect(cache.deletedTags).toEqual(['orders', 'orders']);
  });

  it('does not call deleteByTag for failed mutations', async () => {
    const db = createMutableMockDb({ orders: [] });
    const cache = makeCacheProvider();
    const body: BatchMutationRequest = {
      mutations: [
        // No WHERE — should fail
        { id: 'm1', operation: 'update', table: 'orders', values: { status: 'shipped' } },
        // Valid insert
        { id: 'm2', operation: 'insert', table: 'orders', values: { status: 'pending' } },
      ],
    };
    await handleMutation(body, CLAIMS, { db, schemaAllowlist: ALLOWLIST, cacheProvider: cache });
    // Only the successful insert should trigger invalidation
    expect(cache.deletedTags).toEqual(['orders']);
  });

  it('works correctly when no cacheProvider is supplied', async () => {
    const db = createMutableMockDb({ orders: [] });
    const body: BatchMutationRequest = {
      mutations: [
        { id: 'm1', operation: 'insert', table: 'orders', values: { status: 'pending' } },
      ],
    };
    await expect(
      handleMutation(body, CLAIMS, { db, schemaAllowlist: ALLOWLIST }),
    ).resolves.toMatchObject({ results: [{ id: 'm1', ok: true }] });
  });
});

// ── WHERE-column allowlist ────────────────────────────────────────────────────

describe('handleMutation — where-column allowlist', () => {
  it('returns ok=false when a mutation references a column outside the allowlist', async () => {
    const db = createMutableMockDb({
      orders: [{ id: 1, tenant_id: 'acme', status: 'pending', secret: 'x' }],
    });
    const body: BatchMutationRequest = {
      mutations: [
        {
          id: 'm1',
          operation: 'delete',
          table: 'orders',
          where: [{ column: 'secret', operator: 'eq', value: 'x' }],
        },
      ],
    };
    const { results } = await handleMutation(body, CLAIMS, {
      db,
      schemaAllowlist: ALLOWLIST,
      columnAllowlist: { orders: ['id', 'status'] },
    });
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toMatch(/not in the column allowlist/);
    // The row must not have been deleted.
    expect(db.snapshot().orders).toHaveLength(1);
  });

  it('allows a mutation whose WHERE columns are all in the allowlist', async () => {
    const db = createMutableMockDb({
      orders: [{ id: 1, tenant_id: 'acme', status: 'pending' }],
    });
    const body: BatchMutationRequest = {
      mutations: [
        {
          id: 'm1',
          operation: 'update',
          table: 'orders',
          values: { status: 'shipped' },
          where: [{ column: 'id', operator: 'eq', value: 1 }],
        },
      ],
    };
    const { results } = await handleMutation(body, CLAIMS, {
      db,
      schemaAllowlist: ALLOWLIST,
      columnAllowlist: { orders: ['id', 'status'] },
      tenantColumn: 'tenant_id',
    });
    expect(results[0]).toMatchObject({ id: 'm1', ok: true, rowsAffected: 1 });
  });
});

// ── Tenant isolation end-to-end ───────────────────────────────────────────────

describe('handleMutation — tenant isolation', () => {
  it('insert always stamps the tenant_id from claims regardless of values', async () => {
    const db = createMutableMockDb({ orders: [] });
    const body: BatchMutationRequest = {
      mutations: [{ id: 'm1', operation: 'insert', table: 'orders', values: { status: 'ok' } }],
    };
    await handleMutation(body, CLAIMS, {
      db,
      schemaAllowlist: ALLOWLIST,
      tenantColumn: 'tenant_id',
    });
    expect(db.snapshot().orders[0].tenant_id).toBe('acme');
  });

  it('update cannot affect rows from a different tenant', async () => {
    const db = createMutableMockDb({
      orders: [
        { id: 1, tenant_id: 'acme', status: 'pending' },
        { id: 2, tenant_id: 'rival', status: 'pending' },
      ],
    });
    const body: BatchMutationRequest = {
      mutations: [
        {
          id: 'm1',
          operation: 'update',
          table: 'orders',
          values: { status: 'hijacked' },
          where: [{ column: 'status', operator: 'eq', value: 'pending' }],
        },
      ],
    };
    await handleMutation(body, CLAIMS, {
      db,
      schemaAllowlist: ALLOWLIST,
      tenantColumn: 'tenant_id',
    });
    const { orders } = db.snapshot();
    expect(orders.find((r) => r.id === 1)?.status).toBe('hijacked'); // acme affected
    expect(orders.find((r) => r.id === 2)?.status).toBe('pending'); // rival untouched
  });
});
