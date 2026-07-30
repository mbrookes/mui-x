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
 * - Opt-in `atomic: true` all-or-nothing batches (finding M3)
 */
import { describe, it, expect, vi } from 'vitest';
import { handleMutation, MAX_MUTATIONS_PER_BATCH } from '../handleMutation';
import {
  MAX_ARRAY_ITEMS_PER_DESCRIPTOR,
  MAX_PREDICATE_VALUES_PER_DESCRIPTOR,
  MAX_STRING_LENGTH,
  MAX_STRING_VALUE_LENGTH,
} from '../../shared/limits';
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
      // Knex's per-query statement timeout (F2) — accepted and ignored; this
      // mock resolves synchronously.
      timeout() {
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

  db.transactionCount = 0;
  db.rollbackCount = 0;
  /**
   * Knex-shaped `transaction(callback)` for the `atomic: true` path (finding M3).
   * Takes a snapshot up front, runs the callback against the same query builder,
   * and RESTORES the snapshot when the callback rejects — i.e. a real rollback,
   * so a test can assert that a failed atomic batch left no committed rows.
   */
  db.transaction = async (callback: (trx: unknown) => Promise<unknown>) => {
    const backup = db.snapshot();
    db.transactionCount += 1;
    try {
      return await callback(db);
    } catch (err) {
      db.rollbackCount += 1;
      for (const key of Object.keys(tables)) {
        delete tables[key];
      }
      Object.assign(tables, backup);
      throw err;
    }
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

// Tenancy is now a required, explicit decision on every options object. Tests that
// configure a tenant column use MULTI_TENANT; tests that configure none declare
// SINGLE_TENANT explicitly (the same unscoped behavior, now stated rather than
// silently implied by omission).
const MULTI_TENANT = { mode: 'multi-tenant', tenantColumn: 'tenant_id' } as const;
const SINGLE_TENANT = { mode: 'single-tenant' } as const;

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
    await expect(
      handleMutation(body, CLAIMS, { db, schemaAllowlist: ALLOWLIST, tenancy: SINGLE_TENANT }),
    ).rejects.toThrow(/not in schema allowlist/);
  });
});

// Regression: a malformed body used to reach `body.mutations.map(...)` directly
// and throw a raw, unsanitized `TypeError` (e.g. "Cannot read properties of
// undefined (reading 'map')") instead of one of this package's own
// `MUI X`-prefixed, actionable errors.
describe('handleMutation — malformed request body guard', () => {
  it('rejects an empty object body with a sanitized MUI X error instead of a raw TypeError', async () => {
    const db = createMutableMockDb({ orders: [] });
    await expect(
      handleMutation({} as any, CLAIMS, { db, schemaAllowlist: ALLOWLIST, tenancy: SINGLE_TENANT }),
    ).rejects.toThrow(/^MUI X Studio Server: Malformed batch mutation request/);
  });

  it('rejects a null body', async () => {
    const db = createMutableMockDb({ orders: [] });
    await expect(
      handleMutation(null as any, CLAIMS, {
        db,
        schemaAllowlist: ALLOWLIST,
        tenancy: SINGLE_TENANT,
      }),
    ).rejects.toThrow(/^MUI X Studio Server: Malformed batch mutation request/);
  });

  it('rejects a body whose "mutations" is not an array', async () => {
    const db = createMutableMockDb({ orders: [] });
    await expect(
      handleMutation({ mutations: 42 } as any, CLAIMS, {
        db,
        schemaAllowlist: ALLOWLIST,
        tenancy: SINGLE_TENANT,
      }),
    ).rejects.toThrow(/^MUI X Studio Server: Malformed batch mutation request/);
  });

  // Regression: `body.mutations.map((m) => m.table)` (the upfront table-allowlist
  // check) ran BEFORE any try/catch, so a `null` element threw a raw, unguarded
  // `TypeError` immediately — exactly the failure mode this guard exists to
  // prevent. A malformed element must now be rejected as a clean validation
  // error instead of crashing the whole call.
  it('rejects a null element in "mutations" with a sanitized MUI X error instead of a raw TypeError', async () => {
    const db = createMutableMockDb({ orders: [] });
    await expect(
      handleMutation({ mutations: [null] } as any, CLAIMS, {
        db,
        schemaAllowlist: ALLOWLIST,
        tenancy: SINGLE_TENANT,
      }),
    ).rejects.toThrow(/^MUI X Studio Server: Malformed mutation descriptor at mutations\[0\]/);
  });

  it('rejects a non-object element (e.g. a string) in "mutations"', async () => {
    const db = createMutableMockDb({ orders: [] });
    await expect(
      handleMutation({ mutations: ['oops'] } as any, CLAIMS, {
        db,
        schemaAllowlist: ALLOWLIST,
        tenancy: SINGLE_TENANT,
      }),
    ).rejects.toThrow(/^MUI X Studio Server: Malformed mutation descriptor at mutations\[0\]/);
  });

  it('rejects a mutation descriptor missing "table"', async () => {
    const db = createMutableMockDb({ orders: [] });
    await expect(
      handleMutation(
        { mutations: [{ id: 'm1', operation: 'insert', values: { status: 'ok' } }] } as any,
        CLAIMS,
        { db, schemaAllowlist: ALLOWLIST, tenancy: SINGLE_TENANT },
      ),
    ).rejects.toThrow(/^MUI X Studio Server: Malformed mutation descriptor at mutations\[0\]/);
  });

  // Regression: the write path had no cap on batch size (unlike the read path's
  // `MAX_WIDGETS_PER_BATCH`), protected only by a comment claiming "batch sizes
  // are small" rather than an enforced limit.
  it('rejects a batch exceeding MAX_MUTATIONS_PER_BATCH with a clear MUI X error', async () => {
    const db = createMutableMockDb({ orders: [] });
    const mutations = Array.from({ length: MAX_MUTATIONS_PER_BATCH + 1 }, (_unused, i) => ({
      id: `m${i}`,
      operation: 'insert' as const,
      table: 'orders',
      values: { status: 'ok' },
    }));
    await expect(
      handleMutation({ mutations }, CLAIMS, {
        db,
        schemaAllowlist: ALLOWLIST,
        tenancy: SINGLE_TENANT,
      }),
    ).rejects.toThrow(
      new RegExp(`exceeds the maximum of ${MAX_MUTATIONS_PER_BATCH} allowed per request`),
    );
  });

  it('still accepts a batch exactly at MAX_MUTATIONS_PER_BATCH', async () => {
    const db = createMutableMockDb({ orders: [] });
    const mutations = Array.from({ length: MAX_MUTATIONS_PER_BATCH }, (_unused, i) => ({
      id: `m${i}`,
      operation: 'insert' as const,
      table: 'orders',
      values: { status: 'ok' },
    }));
    const result = await handleMutation({ mutations }, CLAIMS, {
      db,
      schemaAllowlist: ALLOWLIST,
      tenancy: SINGLE_TENANT,
    });
    expect(result.results).toHaveLength(MAX_MUTATIONS_PER_BATCH);
    expect(result.results.every((r) => r.ok)).toBe(true);
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
    const { results } = await handleMutation(body, CLAIMS, {
      db,
      schemaAllowlist: ALLOWLIST,
      tenancy: SINGLE_TENANT,
    });
    expect(results[0]).toMatchObject({ id: 'm1', ok: true, rowsAffected: 1 });
    expect(db.snapshot().orders).toHaveLength(1);
  });

  // Tier3 iter26 finding 3: Knex `insert()` on PostgreSQL without `.returning()`
  // resolves to `[]`, so a naive `rowsAffected = result.length` reported `0` for
  // a successfully COMMITTED single-row insert. Simulate that driver behavior
  // directly (the shared `createMutableMockDb` above always resolves
  // `[rows.length]`, which never exercises the empty-array case).
  it('reports rowsAffected=1 for a Postgres-style insert that resolves to an empty array', async () => {
    // Knex's `insert()` returns a BUILDER (thenable), not a bare promise — the
    // write path applies its statement timeout to it (F2) before awaiting, so the
    // stand-in has to be builder-shaped too.
    const pgLikeDb: any = () => ({
      insert: (_values: Row) => ({
        timeout() {
          return this;
        },
        then(resolve: (v: unknown) => void) {
          resolve([]);
        },
      }),
    });
    const body: BatchMutationRequest = {
      mutations: [
        {
          id: 'm1',
          operation: 'insert',
          table: 'orders',
          values: { status: 'pending' },
        },
      ],
    };
    const { results } = await handleMutation(body, CLAIMS, {
      db: pgLikeDb,
      schemaAllowlist: ALLOWLIST,
      tenancy: SINGLE_TENANT,
    });
    expect(results[0]).toMatchObject({ id: 'm1', ok: true, rowsAffected: 1 });
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
      tenancy: MULTI_TENANT,
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
      tenancy: MULTI_TENANT,
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
    const { results } = await handleMutation(body, CLAIMS, {
      db,
      schemaAllowlist: ALLOWLIST,
      tenancy: SINGLE_TENANT,
    });
    const bad = results.find((r) => r.id === 'bad')!;
    const good = results.find((r) => r.id === 'good')!;
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/requires at least one "where"/);
    expect(good.ok).toBe(true);
    expect(good.rowsAffected).toBe(1);
  });

  it('sanitizes a raw DB-driver error rather than leaking it verbatim (finding T3.5)', async () => {
    // A db whose write rejects with a driver-style error (a schema oracle).
    const throwingDb = (_table: string) => {
      const qb: any = {
        where: () => qb,
        whereIn: () => qb,
        insert: () => qb,
        update: () => qb,
        delete: () => qb,
        // Modelled so the query is actually awaited and rejects with the driver
        // error below. Without it the builder throws at `applyQueryTimeout`
        // first and this test would pass without `secret_col` ever being in play.
        timeout: () => qb,
        then: (_resolve: unknown, reject?: (err: Error) => void) => {
          reject?.(new Error('insert into "orders" — no such column: secret_col'));
        },
      };
      return qb;
    };
    const body: BatchMutationRequest = {
      mutations: [
        { id: 'm1', operation: 'insert', table: 'orders', values: { status: 'pending' } },
      ],
    };
    const { results } = await handleMutation(body, CLAIMS, {
      db: throwingDb,
      schemaAllowlist: ALLOWLIST,
      tenancy: SINGLE_TENANT,
    });
    expect(results[0].ok).toBe(false);
    // Generic message returned; the raw driver text (a schema oracle) is not leaked.
    expect(results[0].error).toMatch(/could not be completed/);
    expect(results[0].error).not.toMatch('secret_col');
  });

  it('surfaces an unknown operation error per-item without aborting the batch', async () => {
    const db = createMutableMockDb({ orders: [] });
    const body: BatchMutationRequest = {
      mutations: [
        { id: 'bad', operation: 'upsert' as any, table: 'orders', values: { status: 'ok' } },
        { id: 'good', operation: 'insert', table: 'orders', values: { status: 'pending' } },
      ],
    };
    const { results } = await handleMutation(body, CLAIMS, {
      db,
      schemaAllowlist: ALLOWLIST,
      tenancy: SINGLE_TENANT,
    });
    expect(results.find((r) => r.id === 'bad')?.ok).toBe(false);
    expect(results.find((r) => r.id === 'good')?.ok).toBe(true);
  });

  // AGENTS.md requires every error thrown from a public package to say what
  // happened, WHY IT IS A PROBLEM, and how to fix it. This one named the bad
  // operation and listed the allowed set but never stated the consequence (F6).
  it('explains the consequence of an unknown mutation operation, not just the allowed set', async () => {
    const db = createMutableMockDb({ orders: [] });
    const body: BatchMutationRequest = {
      mutations: [
        { id: 'bad', operation: 'upsert' as any, table: 'orders', values: { status: 'ok' } },
      ],
    };
    const { results } = await handleMutation(body, CLAIMS, {
      db,
      schemaAllowlist: ALLOWLIST,
      tenancy: SINGLE_TENANT,
    });
    const error = results[0].error ?? '';
    // What happened…
    expect(error).toMatch(/Unknown mutation operation "upsert"/);
    // …why it is a problem…
    expect(error).toMatch(/no query to build/);
    // …and how to fix it.
    expect(error).toMatch(/Use "insert", "update" or "delete"/);
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
    await handleMutation(body, CLAIMS, {
      db,
      schemaAllowlist: ALLOWLIST,
      tenancy: SINGLE_TENANT,
      cacheProvider: cache,
    });
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
    await handleMutation(body, CLAIMS, {
      db,
      schemaAllowlist: ALLOWLIST,
      tenancy: SINGLE_TENANT,
      cacheProvider: cache,
    });
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
      handleMutation(body, CLAIMS, { db, schemaAllowlist: ALLOWLIST, tenancy: SINGLE_TENANT }),
    ).resolves.toMatchObject({ results: [{ id: 'm1', ok: true }] });
  });

  // Regression for finding 2.6: a throwing `deleteByTag` (e.g. Redis down) used to
  // be inside the SAME try/catch as the DB write, so a cache-backend failure after
  // a SUCCESSFULLY COMMITTED insert reported `ok: false` — a reasonable client
  // retry on that false failure would then insert a DUPLICATE row. The fix wraps
  // the cache invalidation in its own try/catch so a committed write is always
  // reported as such.
  it('reports ok=true for a committed insert even when deleteByTag throws (cache failure must not poison the result)', async () => {
    const db = createMutableMockDb({ orders: [] });
    const throwingCache: CacheProvider = {
      async get() {
        return undefined;
      },
      async set() {},
      async invalidatePrefix() {},
      async deleteByTag() {
        throw new Error('Redis is down');
      },
    };
    const body: BatchMutationRequest = {
      mutations: [
        { id: 'm1', operation: 'insert', table: 'orders', values: { status: 'pending' } },
      ],
    };
    const { results } = await handleMutation(body, CLAIMS, {
      db,
      schemaAllowlist: ALLOWLIST,
      tenancy: SINGLE_TENANT,
      cacheProvider: throwingCache,
    });
    // The row WAS committed to the DB…
    expect(db.snapshot().orders).toHaveLength(1);
    // …so the result must report success, not a spurious failure that could
    // prompt a client retry and a duplicate insert.
    expect(results[0]).toMatchObject({ id: 'm1', ok: true, rowsAffected: 1 });
  });
});

// ── WHERE-column allowlist ────────────────────────────────────────────────────

// ── Host-config allowlist shape (fail-closed, not fail-open) ─────────────────
//
// Regression: `writableColumns` (like `schemaAllowlist`/`columnAllowlist`) was
// enforced by TypeScript alone, and reaches `checkColumnAgainstAllowlist`, whose
// membership test is `Array.prototype.includes`. A STRING entry degrades that to
// SUBSTRING matching, admitting any substring of the entry as a writable column.
// A mis-shaped host allowlist is a configuration error, so the WHOLE batch is
// rejected before any mutation runs — not isolated into a per-item result that
// would let the other mutations write through a broken allowlist.
describe('handleMutation — host allowlist shape is validated at runtime', () => {
  it('rejects a STRING writableColumns entry instead of substring-matching against it', async () => {
    const db = createMutableMockDb({ orders: [] });
    const body: BatchMutationRequest = {
      mutations: [{ id: 'm1', operation: 'insert', table: 'orders', values: { status: 'ok' } }],
    };

    await expect(
      handleMutation(body, CLAIMS, {
        db,
        schemaAllowlist: ALLOWLIST,
        tenancy: SINGLE_TENANT,
        // `'id,status'.includes('status')` is true, and so is `.includes('')`.
        writableColumns: { orders: 'id,status' } as unknown as Record<string, string[]>,
      }),
    ).rejects.toThrow(/writableColumns\["orders"\] must be an array of strings/);
    // Rejected before any write.
    expect(db.snapshot().orders).toHaveLength(0);
  });

  it('rejects a STRING schemaAllowlist instead of substring-matching against it', async () => {
    const db = createMutableMockDb({ orders: [] });
    const body: BatchMutationRequest = {
      mutations: [{ id: 'm1', operation: 'insert', table: 'orders', values: { status: 'ok' } }],
    };

    await expect(
      handleMutation(body, CLAIMS, {
        db,
        // `'orders_public'.includes('orders')` is true — the pre-fix code wrote to
        // `orders`, a table this deployment never allowlisted.
        schemaAllowlist: 'orders_public' as unknown as string[],
        tenancy: SINGLE_TENANT,
      }),
    ).rejects.toThrow(/schemaAllowlist must be an array of strings/);
    expect(db.snapshot().orders).toHaveLength(0);
  });
});

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
      tenancy: SINGLE_TENANT,
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
      tenancy: MULTI_TENANT,
    });
    expect(results[0]).toMatchObject({ id: 'm1', ok: true, rowsAffected: 1 });
  });
});

// ── Qualified WHERE-column schema allowlist (Zero-Knowledge Rule parity) ──────
//
// The read path's `assertQualifiedColumnsAllowed` unconditionally rejects a
// qualified column reference naming a table outside `schemaAllowlist`, regardless
// of whether `columnAllowlist` is configured. The write path had no equivalent for
// a qualified `where[].column` — `assertQualifiedWhereColumnsAllowed` closes that
// gap. These tests pin the write-path parity.

describe('handleMutation — qualified where-column schema allowlist', () => {
  it('rejects a qualified where column naming a table outside the schema allowlist, even with no columnAllowlist configured', async () => {
    const db = createMutableMockDb({
      orders: [{ id: 1, tenant_id: 'acme', status: 'pending' }],
    });
    const body: BatchMutationRequest = {
      mutations: [
        {
          id: 'm1',
          operation: 'delete',
          table: 'orders',
          where: [{ column: 'other_table.secret', operator: 'eq', value: 1 }],
        },
      ],
    };
    // Rejected up front (like the table-allowlist check), not as a per-mutation
    // `{ error }` — a clean, actionable MUI X error, not an opaque driver error.
    await expect(
      handleMutation(body, CLAIMS, { db, schemaAllowlist: ALLOWLIST, tenancy: SINGLE_TENANT }),
    ).rejects.toThrow(/names table "other_table", which is not in the schema allowlist/);
    // Rejected before any query was built — the row must be untouched.
    expect(db.snapshot().orders).toHaveLength(1);
  });

  it('rejects a qualified where column naming an unregistered table across a batch of mutations (whole-batch, all-or-nothing)', async () => {
    const db = createMutableMockDb({ orders: [], customers: [] });
    const body: BatchMutationRequest = {
      mutations: [
        { id: 'm1', operation: 'insert', table: 'orders', values: { status: 'pending' } },
        {
          id: 'm2',
          operation: 'delete',
          table: 'customers',
          where: [{ column: 'payroll.salary', operator: 'eq', value: 1 }],
        },
      ],
    };
    await expect(
      handleMutation(body, CLAIMS, { db, schemaAllowlist: ALLOWLIST, tenancy: SINGLE_TENANT }),
    ).rejects.toThrow(/names table "payroll", which is not in the schema allowlist/);
    // Neither mutation should have run — the whole batch is rejected up front.
    expect(db.snapshot().orders).toHaveLength(0);
  });

  it('allows a qualified where column naming an allowlisted table', async () => {
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
          where: [{ column: 'orders.status', operator: 'eq', value: 'pending' }],
        },
      ],
    };
    const { results } = await handleMutation(body, CLAIMS, {
      db,
      schemaAllowlist: ALLOWLIST,
      tenancy: SINGLE_TENANT,
    });
    expect(results[0]).toMatchObject({ id: 'm1', ok: true, rowsAffected: 1 });
  });

  it('allows an unqualified where column, unaffected by the new check', async () => {
    const db = createMutableMockDb({
      orders: [{ id: 1, tenant_id: 'acme', status: 'pending' }],
    });
    const body: BatchMutationRequest = {
      mutations: [
        {
          id: 'm1',
          operation: 'delete',
          table: 'orders',
          where: [{ column: 'status', operator: 'eq', value: 'pending' }],
        },
      ],
    };
    const { results } = await handleMutation(body, CLAIMS, {
      db,
      schemaAllowlist: ALLOWLIST,
      tenancy: SINGLE_TENANT,
    });
    expect(results[0]).toMatchObject({ id: 'm1', ok: true, rowsAffected: 1 });
    expect(db.snapshot().orders).toHaveLength(0);
  });

  // The pre-existing `columnAllowlist`-configured path (`checkColumnAgainstAllowlist`
  // via `validateMutation`) must keep working unaffected by the new unconditional
  // schema check — the two checks are independent and additive.
  it('still enforces columnAllowlist rejection for a non-allowlisted column, independent of the new schema check', async () => {
    const db = createMutableMockDb({
      orders: [{ id: 1, tenant_id: 'acme', status: 'pending', secret: 'x' }],
    });
    const body: BatchMutationRequest = {
      mutations: [
        {
          id: 'm1',
          operation: 'delete',
          table: 'orders',
          where: [{ column: 'orders.secret', operator: 'eq', value: 'x' }],
        },
      ],
    };
    const { results } = await handleMutation(body, CLAIMS, {
      db,
      schemaAllowlist: ALLOWLIST,
      tenancy: SINGLE_TENANT,
      columnAllowlist: { orders: ['id', 'status'] },
    });
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toMatch(/not in the column allowlist/);
    expect(db.snapshot().orders).toHaveLength(1);
  });

  it('still allows a qualified where column that is in the schema allowlist AND the column allowlist', async () => {
    const db = createMutableMockDb({
      orders: [{ id: 1, tenant_id: 'acme', status: 'pending' }],
    });
    const body: BatchMutationRequest = {
      mutations: [
        {
          id: 'm1',
          operation: 'delete',
          table: 'orders',
          where: [{ column: 'orders.status', operator: 'eq', value: 'pending' }],
        },
      ],
    };
    const { results } = await handleMutation(body, CLAIMS, {
      db,
      schemaAllowlist: ALLOWLIST,
      tenancy: SINGLE_TENANT,
      columnAllowlist: { orders: ['id', 'status'] },
    });
    expect(results[0]).toMatchObject({ id: 'm1', ok: true, rowsAffected: 1 });
  });
});

// ── Malformed "where" shapes (Tier3 iter26 finding 1) ─────────────────────────
//
// The upfront qualified-where-column loop in `handleMutation` (which runs
// `assertQualifiedWhereColumnsAllowed(mutation.where, schemaAllowlist)` OUTSIDE
// any per-mutation try/catch, before `processMutation` even exists) used to let
// two malformed shapes escape as raw, unguarded TypeErrors instead of this
// package's own `MUI X`-prefixed rejections:
//   - `where: {}` (a non-array) — `for (const predicate of where ?? [])` threw
//     `TypeError: where is not iterable`.
//   - `where: [{ column: 5 }]` (a non-string column) — `qualifiedTableOf`'s
//     `column.indexOf('.')` threw `TypeError: column.indexOf is not a function`.

describe('handleMutation — malformed "where" shapes', () => {
  it('rejects a non-array "where" with a clean MUI X error instead of a raw TypeError', async () => {
    const db = createMutableMockDb({ orders: [{ id: 1, tenant_id: 'acme', status: 'pending' }] });
    const body: BatchMutationRequest = {
      mutations: [{ id: 'm1', operation: 'delete', table: 'orders', where: {} as any }],
    };
    await expect(
      handleMutation(body, CLAIMS, { db, schemaAllowlist: ALLOWLIST, tenancy: SINGLE_TENANT }),
    ).rejects.toThrow(/^MUI X Studio Server: Malformed mutation descriptor at mutations\[0\]/);
    // Rejected before any query was built — the row must be untouched.
    expect(db.snapshot().orders).toHaveLength(1);
  });

  it('rejects a non-string where[].column with a clean MUI X error instead of a raw TypeError', async () => {
    const db = createMutableMockDb({ orders: [{ id: 1, tenant_id: 'acme', status: 'pending' }] });
    const body: BatchMutationRequest = {
      mutations: [
        {
          id: 'm1',
          operation: 'delete',
          table: 'orders',
          where: [{ column: 5 as any, operator: 'eq', value: 1 }],
        },
      ],
    };
    await expect(
      handleMutation(body, CLAIMS, { db, schemaAllowlist: ALLOWLIST, tenancy: SINGLE_TENANT }),
    ).rejects.toThrow(/MUI X Studio Server: Column reference in where must be a string/);
    expect(db.snapshot().orders).toHaveLength(1);
  });

  // One level deeper than the two cases above (iter26 non-array `where`, iter27
  // non-string `where[].column`): a `null`/`undefined`/primitive ELEMENT of the
  // `where` array. `checkQualifiedColumn(predicate.column, …)` dereferences
  // `.column` on the element itself — `null.column` threw a raw, unguarded
  // TypeError in the upfront `assertQualifiedWhereColumnsAllowed` loop, OUTSIDE
  // any error boundary. The element-shape check in
  // `assertValidBatchMutationRequest` now rejects it up front.
  it('rejects a null "where" element with a clean MUI X error instead of a raw TypeError', async () => {
    const db = createMutableMockDb({ orders: [{ id: 1, tenant_id: 'acme', status: 'pending' }] });
    const body: BatchMutationRequest = {
      mutations: [{ id: 'm1', operation: 'delete', table: 'orders', where: [null as any] }],
    };
    await expect(
      handleMutation(body, CLAIMS, { db, schemaAllowlist: ALLOWLIST, tenancy: SINGLE_TENANT }),
    ).rejects.toThrow(
      /^MUI X Studio Server: Malformed mutation descriptor at mutations\[0\] — "where\[0\]"/,
    );
    // Rejected before any query was built — the row must be untouched.
    expect(db.snapshot().orders).toHaveLength(1);
  });

  it('rejects an undefined/primitive "where" element with a clean MUI X error', async () => {
    const db = createMutableMockDb({ orders: [{ id: 1, tenant_id: 'acme', status: 'pending' }] });
    const body: BatchMutationRequest = {
      mutations: [
        {
          id: 'm1',
          operation: 'delete',
          table: 'orders',
          where: [{ column: 'id', operator: 'eq', value: 1 }, 5 as any],
        },
      ],
    };
    await expect(
      handleMutation(body, CLAIMS, { db, schemaAllowlist: ALLOWLIST, tenancy: SINGLE_TENANT }),
    ).rejects.toThrow(
      /^MUI X Studio Server: Malformed mutation descriptor at mutations\[0\] — "where\[1\]"/,
    );
    expect(db.snapshot().orders).toHaveLength(1);
  });
});

// Regression (Tier3 — asymmetric validation): "where" was validated up front as
// an array of objects, but "values" had no equivalent object-shape guard, so a
// non-object "values" (an array, string, number, or null) reached
// `validateMutation`/`buildInsertMutation`/`buildUpdateMutation` in
// `mutationBuilder.ts`, none of which throw for it — producing a silently
// degraded insert/update instead of a clean validation error.
describe('handleMutation — malformed "values" shape', () => {
  it('rejects an array "values" with a clean MUI X error instead of silently degrading the insert', async () => {
    const db = createMutableMockDb({ orders: [] });
    const body: BatchMutationRequest = {
      mutations: [{ id: 'm1', operation: 'insert', table: 'orders', values: ['pending'] as any }],
    };
    await expect(
      handleMutation(body, CLAIMS, { db, schemaAllowlist: ALLOWLIST, tenancy: SINGLE_TENANT }),
    ).rejects.toThrow(
      /^MUI X Studio Server: Malformed mutation descriptor at mutations\[0\] — "values" must be a plain object/,
    );
    expect(db.snapshot().orders).toHaveLength(0);
  });

  it('rejects a string "values"', async () => {
    const db = createMutableMockDb({ orders: [] });
    const body: BatchMutationRequest = {
      mutations: [{ id: 'm1', operation: 'insert', table: 'orders', values: 'pending' as any }],
    };
    await expect(
      handleMutation(body, CLAIMS, { db, schemaAllowlist: ALLOWLIST, tenancy: SINGLE_TENANT }),
    ).rejects.toThrow(
      /^MUI X Studio Server: Malformed mutation descriptor at mutations\[0\] — "values" must be a plain object/,
    );
  });

  it('rejects a null "values"', async () => {
    const db = createMutableMockDb({ orders: [] });
    const body: BatchMutationRequest = {
      mutations: [{ id: 'm1', operation: 'insert', table: 'orders', values: null as any }],
    };
    await expect(
      handleMutation(body, CLAIMS, { db, schemaAllowlist: ALLOWLIST, tenancy: SINGLE_TENANT }),
    ).rejects.toThrow(
      /^MUI X Studio Server: Malformed mutation descriptor at mutations\[0\] — "values" must be a plain object/,
    );
  });

  it('rejects a numeric "values"', async () => {
    const db = createMutableMockDb({ orders: [] });
    const body: BatchMutationRequest = {
      mutations: [{ id: 'm1', operation: 'insert', table: 'orders', values: 42 as any }],
    };
    await expect(
      handleMutation(body, CLAIMS, { db, schemaAllowlist: ALLOWLIST, tenancy: SINGLE_TENANT }),
    ).rejects.toThrow(
      /^MUI X Studio Server: Malformed mutation descriptor at mutations\[0\] — "values" must be a plain object/,
    );
  });

  it('still accepts a well-formed object "values"', async () => {
    const db = createMutableMockDb({ orders: [] });
    const body: BatchMutationRequest = {
      mutations: [
        { id: 'm1', operation: 'insert', table: 'orders', values: { status: 'pending' } },
      ],
    };
    const { results } = await handleMutation(body, CLAIMS, {
      db,
      schemaAllowlist: ALLOWLIST,
      tenancy: SINGLE_TENANT,
    });
    expect(results[0]).toMatchObject({ id: 'm1', ok: true });
  });
});

// Regression (Tier3 — resource exhaustion): the batch-size caps
// (`MAX_MUTATIONS_PER_BATCH`) bound the NUMBER of mutations per request but not
// the size of any single mutation's own "where" array / "values" object — an
// unbounded array/object inside one otherwise-well-formed mutation is still
// unbounded query-building work driven entirely by client input.
describe('handleMutation — per-array size caps (finding Tier3 resource exhaustion)', () => {
  it('rejects a "where" array exceeding MAX_ARRAY_ITEMS_PER_DESCRIPTOR', async () => {
    const db = createMutableMockDb({ orders: [] });
    const where = Array.from({ length: MAX_ARRAY_ITEMS_PER_DESCRIPTOR + 1 }, (_unused, i) => ({
      column: 'id',
      operator: 'eq' as const,
      value: i,
    }));
    const body: BatchMutationRequest = {
      mutations: [{ id: 'm1', operation: 'delete', table: 'orders', where }],
    };
    await expect(
      handleMutation(body, CLAIMS, { db, schemaAllowlist: ALLOWLIST, tenancy: SINGLE_TENANT }),
    ).rejects.toThrow(
      new RegExp(
        `^MUI X Studio Server: Malformed mutation descriptor at mutations\\[0\\] — "where" contains ${MAX_ARRAY_ITEMS_PER_DESCRIPTOR + 1} predicates, which exceeds the maximum of ${MAX_ARRAY_ITEMS_PER_DESCRIPTOR}`,
      ),
    );
  });

  it('rejects a where[].value "in"-list exceeding MAX_ARRAY_ITEMS_PER_DESCRIPTOR', async () => {
    const db = createMutableMockDb({ orders: [] });
    const inList = Array.from({ length: MAX_ARRAY_ITEMS_PER_DESCRIPTOR + 1 }, (_unused, i) => i);
    const body: BatchMutationRequest = {
      mutations: [
        {
          id: 'm1',
          operation: 'delete',
          table: 'orders',
          where: [{ column: 'id', operator: 'in', value: inList }],
        },
      ],
    };
    await expect(
      handleMutation(body, CLAIMS, { db, schemaAllowlist: ALLOWLIST, tenancy: SINGLE_TENANT }),
    ).rejects.toThrow(/"where\[0\]\.value" contains .* which exceeds the maximum/);
  });

  it('rejects a "values" object exceeding MAX_ARRAY_ITEMS_PER_DESCRIPTOR keys', async () => {
    const db = createMutableMockDb({ orders: [] });
    const values = Object.fromEntries(
      Array.from({ length: MAX_ARRAY_ITEMS_PER_DESCRIPTOR + 1 }, (_unused, i) => [`col${i}`, i]),
    );
    const body: BatchMutationRequest = {
      mutations: [{ id: 'm1', operation: 'insert', table: 'orders', values }],
    };
    await expect(
      handleMutation(body, CLAIMS, { db, schemaAllowlist: ALLOWLIST, tenancy: SINGLE_TENANT }),
    ).rejects.toThrow(
      new RegExp(
        `^MUI X Studio Server: Malformed mutation descriptor at mutations\\[0\\] — "values" contains ${MAX_ARRAY_ITEMS_PER_DESCRIPTOR + 1} keys, which exceeds the maximum of ${MAX_ARRAY_ITEMS_PER_DESCRIPTOR}`,
      ),
    );
  });

  // Aggregate cap on the TOTAL comparison values summed across every predicate
  // (the per-predicate cap bounds each `in`-list independently, but not its
  // product with the `where` array's own length cap — 200 × 200 = 40,000 bound
  // parameters for one mutation). Mirrors the read path's `filters[].value`
  // aggregate cap in `handler.ts`.
  it('rejects where[].value lists that are each individually under the per-predicate cap but sum over MAX_PREDICATE_VALUES_PER_DESCRIPTOR', async () => {
    const db = createMutableMockDb({ orders: [] });
    const perPredicateValues = Array.from({ length: 150 }, (_unused, i) => i);
    // 20 × 150 = 3,000 total values; each predicate's own 150 is under the
    // per-predicate cap of 200.
    const where = Array.from({ length: 20 }, () => ({
      column: 'id',
      operator: 'in' as const,
      value: perPredicateValues,
    }));
    await expect(
      handleMutation(
        { mutations: [{ id: 'm1', operation: 'delete', table: 'orders', where }] },
        CLAIMS,
        { db, schemaAllowlist: ALLOWLIST, tenancy: SINGLE_TENANT },
      ),
    ).rejects.toThrow(
      new RegExp(
        `^MUI X Studio Server: Malformed mutation descriptor at mutations\\[0\\] — "where\\[\\]\\.value" contains 3000 comparison values in total across all predicates, which exceeds the maximum of ${MAX_PREDICATE_VALUES_PER_DESCRIPTOR}`,
      ),
    );
  });

  it('still accepts a "where" array exactly at MAX_ARRAY_ITEMS_PER_DESCRIPTOR', async () => {
    const db = createMutableMockDb({
      orders: Array.from({ length: 1 }, (_unused, i) => ({
        id: i,
        tenant_id: 'acme',
        status: 'pending',
      })),
    });
    const where = Array.from({ length: MAX_ARRAY_ITEMS_PER_DESCRIPTOR }, (_unused, i) => ({
      column: 'id',
      operator: 'eq' as const,
      value: i,
    }));
    const result = await handleMutation(
      { mutations: [{ id: 'm1', operation: 'delete', table: 'orders', where }] },
      CLAIMS,
      { db, schemaAllowlist: ALLOWLIST, tenancy: SINGLE_TENANT },
    );
    expect(result.results[0].ok).toBe(true);
  });
});

// Regression (Tier2 — resource exhaustion): none of the array/object size caps
// above bound the LENGTH of an individual string field. A single well-formed-
// shape mutation (arrays/objects comfortably under their count caps) could
// still carry an oversized string in "table"/"id"/a where-predicate value/a
// "values" key or value.
describe('handleMutation — per-string length caps (finding Tier2 resource exhaustion)', () => {
  it('rejects a "table" exceeding MAX_STRING_LENGTH', async () => {
    const db = createMutableMockDb({ orders: [] });
    const oversizedTable = 'a'.repeat(MAX_STRING_LENGTH + 1);
    const body: BatchMutationRequest = {
      mutations: [
        { id: 'm1', operation: 'insert', table: oversizedTable, values: { status: 'x' } },
      ],
    };
    await expect(
      handleMutation(body, CLAIMS, { db, schemaAllowlist: ALLOWLIST, tenancy: SINGLE_TENANT }),
    ).rejects.toThrow(
      new RegExp(
        `^MUI X Studio Server: Malformed mutation descriptor at mutations\\[0\\] — "table" is ${MAX_STRING_LENGTH + 1} characters long, which exceeds the maximum of ${MAX_STRING_LENGTH}`,
      ),
    );
  });

  it('rejects an "id" exceeding MAX_STRING_LENGTH', async () => {
    const db = createMutableMockDb({ orders: [] });
    const oversizedId = 'm'.repeat(MAX_STRING_LENGTH + 1);
    const body: BatchMutationRequest = {
      mutations: [
        { id: oversizedId, operation: 'insert', table: 'orders', values: { status: 'x' } },
      ],
    };
    await expect(
      handleMutation(body, CLAIMS, { db, schemaAllowlist: ALLOWLIST, tenancy: SINGLE_TENANT }),
    ).rejects.toThrow(
      new RegExp(
        `^MUI X Studio Server: Malformed mutation descriptor at mutations\\[0\\] — "id" is ${MAX_STRING_LENGTH + 1} characters long, which exceeds the maximum of ${MAX_STRING_LENGTH}`,
      ),
    );
  });

  it('rejects a where[].value string exceeding MAX_STRING_VALUE_LENGTH', async () => {
    const db = createMutableMockDb({ orders: [] });
    const oversizedValue = 'v'.repeat(MAX_STRING_VALUE_LENGTH + 1);
    const body: BatchMutationRequest = {
      mutations: [
        {
          id: 'm1',
          operation: 'delete',
          table: 'orders',
          where: [{ column: 'status', operator: 'eq', value: oversizedValue }],
        },
      ],
    };
    await expect(
      handleMutation(body, CLAIMS, { db, schemaAllowlist: ALLOWLIST, tenancy: SINGLE_TENANT }),
    ).rejects.toThrow(
      /"where\[0\]\.value" contains a string \d+ characters long, which exceeds the maximum of \d+/,
    );
  });

  it('rejects a "values" key exceeding MAX_STRING_LENGTH', async () => {
    const db = createMutableMockDb({ orders: [] });
    const oversizedKey = 'k'.repeat(MAX_STRING_LENGTH + 1);
    const body: BatchMutationRequest = {
      mutations: [
        { id: 'm1', operation: 'insert', table: 'orders', values: { [oversizedKey]: 'x' } },
      ],
    };
    await expect(
      handleMutation(body, CLAIMS, { db, schemaAllowlist: ALLOWLIST, tenancy: SINGLE_TENANT }),
    ).rejects.toThrow(
      /a "values" key is \d+ characters long, which exceeds the maximum of \d+ allowed for an identifier/,
    );
  });

  it('rejects a "values" string value exceeding MAX_STRING_VALUE_LENGTH', async () => {
    const db = createMutableMockDb({ orders: [] });
    const oversizedValue = 'v'.repeat(MAX_STRING_VALUE_LENGTH + 1);
    const body: BatchMutationRequest = {
      mutations: [
        { id: 'm1', operation: 'insert', table: 'orders', values: { status: oversizedValue } },
      ],
    };
    await expect(
      handleMutation(body, CLAIMS, { db, schemaAllowlist: ALLOWLIST, tenancy: SINGLE_TENANT }),
    ).rejects.toThrow(
      /"values" value for key "status…?" is \d+ characters long, which exceeds the maximum of \d+/,
    );
  });

  it('still accepts a "values" string value exactly at MAX_STRING_VALUE_LENGTH', async () => {
    const db = createMutableMockDb({ orders: [] });
    const value = 'v'.repeat(MAX_STRING_VALUE_LENGTH);
    const body: BatchMutationRequest = {
      mutations: [{ id: 'm1', operation: 'insert', table: 'orders', values: { status: value } }],
    };
    const result = await handleMutation(body, CLAIMS, {
      db,
      schemaAllowlist: ALLOWLIST,
      tenancy: SINGLE_TENANT,
    });
    expect(result.results[0].ok).toBe(true);
  });
});

// ── Empty-IN write scoping (data-loss guard) ──────────────────────────────────

describe('handleMutation — empty-IN write guard', () => {
  it('rejects a delete whose only WHERE is an empty "in" list instead of wiping the table', async () => {
    const db = createMutableMockDb({
      orders: [
        { id: 1, tenant_id: 'acme', status: 'a' },
        { id: 2, tenant_id: 'acme', status: 'b' },
      ],
    });
    const body: BatchMutationRequest = {
      mutations: [
        {
          id: 'm1',
          operation: 'delete',
          table: 'orders',
          where: [{ column: 'id', operator: 'in', value: [] }],
        },
      ],
    };
    const { results } = await handleMutation(body, CLAIMS, {
      db,
      schemaAllowlist: ALLOWLIST,
      tenancy: MULTI_TENANT,
    });
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toMatch(/"in" predicate with an empty value list/);
    // The table must be intact — the mutation must NOT have widened to all rows.
    expect(db.snapshot().orders).toHaveLength(2);
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
      tenancy: MULTI_TENANT,
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
      tenancy: MULTI_TENANT,
    });
    const { orders } = db.snapshot();
    expect(orders.find((r) => r.id === 1)?.status).toBe('hijacked'); // acme affected
    expect(orders.find((r) => r.id === 2)?.status).toBe('pending'); // rival untouched
  });
});

// ── Tenant isolation via multi-tenant tenancy ─────────────────────────────────
//
// Regression for finding 1.1 (CRITICAL): the highest-value missing test in the
// package. A multi-tenant deployment must stamp inserts with the caller's tenant
// AND reject a client-supplied tenant. (Previously this path was exercised via a
// `securityColumns.tenant`-only config; the global tenant column now lives in the
// required `tenancy` posture, so multi-tenant mode is the equivalent premise.)

describe('handleMutation — tenant isolation via multi-tenant tenancy', () => {
  it('stamps the caller tenant on insert in multi-tenant mode', async () => {
    const db = createMutableMockDb({ orders: [] });
    const body: BatchMutationRequest = {
      mutations: [{ id: 'm1', operation: 'insert', table: 'orders', values: { status: 'ok' } }],
    };
    const { results } = await handleMutation(body, CLAIMS, {
      db,
      schemaAllowlist: ALLOWLIST,
      tenancy: MULTI_TENANT,
    });
    expect(results[0]).toMatchObject({ id: 'm1', ok: true });
    // (a) the stored row carries the caller's tenant.
    expect(db.snapshot().orders[0].tenant_id).toBe('acme');
  });

  it('rejects a client-supplied tenant value in insert values (multi-tenant mode)', async () => {
    const db = createMutableMockDb({ orders: [] });
    const body: BatchMutationRequest = {
      mutations: [
        {
          id: 'm1',
          operation: 'insert',
          table: 'orders',
          values: { status: 'ok', tenant_id: 'victim-tenant' },
        },
      ],
    };
    const { results } = await handleMutation(body, CLAIMS, {
      db,
      schemaAllowlist: ALLOWLIST,
      tenancy: MULTI_TENANT,
      writableColumns: { orders: ['status', 'tenant_id'] },
    });
    // (b) a client-supplied tenant value is rejected — no row injected.
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toMatch(/tenant isolation column/);
    expect(db.snapshot().orders).toHaveLength(0);
  });
});

// ── Intra-batch mutation ordering (finding 1.6) ───────────────────────────────

describe('handleMutation — batch ordering', () => {
  it('processes mutations sequentially so [insert, update-that-row] is deterministic', async () => {
    const db = createMutableMockDb({ orders: [] });
    const body: BatchMutationRequest = {
      mutations: [
        { id: 'ins', operation: 'insert', table: 'orders', values: { id: 1, status: 'new' } },
        {
          id: 'upd',
          operation: 'update',
          table: 'orders',
          values: { status: 'processed' },
          where: [{ column: 'id', operator: 'eq', value: 1 }],
        },
      ],
    };
    const { results } = await handleMutation(body, CLAIMS, {
      db,
      schemaAllowlist: ALLOWLIST,
      tenancy: MULTI_TENANT,
    });
    // The update ran AFTER the insert and observed the inserted row.
    expect(results.find((r) => r.id === 'ins')?.ok).toBe(true);
    expect(results.find((r) => r.id === 'upd')).toMatchObject({ ok: true, rowsAffected: 1 });
    expect(db.snapshot().orders[0]).toMatchObject({
      id: 1,
      status: 'processed',
      tenant_id: 'acme',
    });
  });
});

// ── Opt-in atomic batches (finding M3) ────────────────────────────────────────
//
// Regression: batch mutations were not transactional and the package contained
// no rollback of any kind, so `[insert parent, insert child-that-fails]` left the
// parent committed with `[{ok:true},{ok:false}]` returned and no way for the
// client to undo it. The per-item isolation is deliberate and stays the DEFAULT;
// `atomic: true` is the new opt-in for hosts that want all-or-nothing.

describe('handleMutation — atomic batches', () => {
  it('commits every mutation when the whole batch succeeds', async () => {
    const db = createMutableMockDb({ orders: [] });
    const body: BatchMutationRequest = {
      mutations: [
        { id: 'm1', operation: 'insert', table: 'orders', values: { id: 1, status: 'new' } },
        {
          id: 'm2',
          operation: 'update',
          table: 'orders',
          values: { status: 'processed' },
          where: [{ column: 'id', operator: 'eq', value: 1 }],
        },
      ],
    };

    const { results } = await handleMutation(body, CLAIMS, {
      db,
      schemaAllowlist: ALLOWLIST,
      tenancy: MULTI_TENANT,
      atomic: true,
    });

    expect(results.every((r) => r.ok)).toBe(true);
    expect(db.transactionCount).toBe(1);
    expect(db.rollbackCount).toBe(0);
    expect(db.snapshot().orders[0]).toMatchObject({ id: 1, status: 'processed' });
  });

  it('rolls back an earlier committed insert when a later mutation fails', async () => {
    const db = createMutableMockDb({ orders: [], customers: [] });
    const body: BatchMutationRequest = {
      mutations: [
        { id: 'parent', operation: 'insert', table: 'customers', values: { id: 7, name: 'Ada' } },
        // Rejected by the writable-columns allowlist — the pre-fix behavior left
        // the parent row committed with no way to undo it.
        {
          id: 'child',
          operation: 'insert',
          table: 'orders',
          values: { customer_id: 7, internal_notes: 'nope' },
        },
      ],
    };

    const { results } = await handleMutation(body, CLAIMS, {
      db,
      schemaAllowlist: ALLOWLIST,
      tenancy: MULTI_TENANT,
      writableColumns: { customers: ['id', 'name'], orders: ['customer_id'] },
      atomic: true,
    });

    // Every item reports failure — nothing in the batch was applied.
    expect(results.map((r) => r.ok)).toEqual([false, false]);
    expect(results[0].error).toMatch(/rolled back because another mutation/);
    expect(results[1].error).toMatch(/not in the column allowlist/);
    // …and the DB proves it: the parent insert was rolled back.
    expect(db.rollbackCount).toBe(1);
    expect(db.snapshot().customers).toHaveLength(0);
    expect(db.snapshot().orders).toHaveLength(0);
  });

  it('rolls back an [update A, update B] pair when B fails', async () => {
    const db = createMutableMockDb({
      orders: [
        { id: 1, status: 'pending', tenant_id: 'acme' },
        { id: 2, status: 'pending', tenant_id: 'acme' },
      ],
    });
    const body: BatchMutationRequest = {
      mutations: [
        {
          id: 'a',
          operation: 'update',
          table: 'orders',
          values: { status: 'shipped' },
          where: [{ column: 'id', operator: 'eq', value: 1 }],
        },
        // No `where` — rejected by the required-predicate invariant.
        { id: 'b', operation: 'update', table: 'orders', values: { status: 'shipped' } },
      ],
    };

    const { results } = await handleMutation(body, CLAIMS, {
      db,
      schemaAllowlist: ALLOWLIST,
      tenancy: MULTI_TENANT,
      atomic: true,
    });

    expect(results.map((r) => r.ok)).toEqual([false, false]);
    // Row 1's update was undone — it is still 'pending'.
    expect(db.snapshot().orders.find((r) => r.id === 1)?.status).toBe('pending');
  });

  it('keeps per-item isolation (and opens no transaction) by DEFAULT', async () => {
    const db = createMutableMockDb({ orders: [], customers: [] });
    const body: BatchMutationRequest = {
      mutations: [
        { id: 'parent', operation: 'insert', table: 'customers', values: { id: 7, name: 'Ada' } },
        { id: 'child', operation: 'insert', table: 'orders', values: { internal_notes: 'nope' } },
      ],
    };

    const { results } = await handleMutation(body, CLAIMS, {
      db,
      schemaAllowlist: ALLOWLIST,
      tenancy: MULTI_TENANT,
      writableColumns: { customers: ['id', 'name'], orders: ['customer_id'] },
    });

    // Unchanged default behavior: the first mutation still commits.
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(db.transactionCount).toBe(0);
    expect(db.snapshot().customers).toHaveLength(1);
  });

  it('invalidates the cache ONCE per distinct table, after the commit', async () => {
    const db = createMutableMockDb({ orders: [] });
    const cacheProvider = makeCacheProvider();
    const body: BatchMutationRequest = {
      mutations: [
        { id: 'm1', operation: 'insert', table: 'orders', values: { id: 1, status: 'a' } },
        { id: 'm2', operation: 'insert', table: 'orders', values: { id: 2, status: 'b' } },
      ],
    };

    await handleMutation(body, CLAIMS, {
      db,
      schemaAllowlist: ALLOWLIST,
      tenancy: MULTI_TENANT,
      cacheProvider,
      atomic: true,
    });

    expect(cacheProvider.deletedTags).toEqual(['orders']);
  });

  it('does not invalidate the cache at all when the batch rolls back', async () => {
    const db = createMutableMockDb({ orders: [] });
    const cacheProvider = makeCacheProvider();
    const body: BatchMutationRequest = {
      mutations: [
        { id: 'm1', operation: 'insert', table: 'orders', values: { id: 1, status: 'a' } },
        // Missing `where` — fails, rolling the batch back.
        { id: 'm2', operation: 'delete', table: 'orders' },
      ],
    };

    const { results } = await handleMutation(body, CLAIMS, {
      db,
      schemaAllowlist: ALLOWLIST,
      tenancy: MULTI_TENANT,
      cacheProvider,
      atomic: true,
    });

    expect(results.every((r) => r.ok === false)).toBe(true);
    expect(cacheProvider.deletedTags).toEqual([]);
  });

  it('rejects atomic: true when the injected db exposes no transaction()', async () => {
    const db = createMutableMockDb({ orders: [] });
    // A minimal host db (e.g. a hand-rolled query builder) with no transaction support.
    const dbWithoutTransactions = ((table: string) => db(table)) as any;
    const body: BatchMutationRequest = {
      mutations: [{ id: 'm1', operation: 'insert', table: 'orders', values: { status: 'ok' } }],
    };

    await expect(
      handleMutation(body, CLAIMS, {
        db: dbWithoutTransactions,
        schemaAllowlist: ALLOWLIST,
        tenancy: MULTI_TENANT,
        atomic: true,
      }),
    ).rejects.toThrow(/does not expose a "transaction" method/);
  });

  it('reports every item as failed with a sanitized message when the transaction itself throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = createMutableMockDb({ orders: [] });
    db.transaction = async () => {
      // A raw driver-shaped failure — must never reach the client verbatim.
      throw new Error('SQLITE_BUSY: database is locked (orders.tenant_id)');
    };
    const body: BatchMutationRequest = {
      mutations: [
        { id: 'm1', operation: 'insert', table: 'orders', values: { status: 'a' } },
        { id: 'm2', operation: 'insert', table: 'orders', values: { status: 'b' } },
      ],
    };

    const { results } = await handleMutation(body, CLAIMS, {
      db,
      schemaAllowlist: ALLOWLIST,
      tenancy: MULTI_TENANT,
      atomic: true,
    });

    expect(results.map((r) => r.id)).toEqual(['m1', 'm2']);
    expect(results.every((r) => r.ok === false)).toBe(true);
    for (const result of results) {
      expect(result.error).toMatch(/could not be committed and was rolled back/);
      expect(result.error).not.toMatch(/SQLITE_BUSY/);
    }
    warnSpy.mockRestore();
  });

  // ── COMMIT-time failure (the shape the pre-fix discrimination misread) ──────
  //
  // Regression: `runAtomicBatch` discriminated its own rollback sentinel from a
  // genuine transaction failure by testing `results !== undefined` — a variable
  // the SUCCESS path assigns too, from inside the same callback. A failure raised
  // AFTER the callback resolves (a Postgres 40001 serialization failure or a
  // deferred-constraint violation at COMMIT, a lost connection, a MySQL deadlock
  // surfacing at commit) therefore arrived with `results` already holding the
  // fully-assembled, all-`ok: true` per-item results and was returned verbatim:
  // the client marked the write saved while the database had rolled everything
  // back. The pre-existing test above stubs `transaction` to throw BEFORE invoking
  // the callback, so `results` was still `undefined` and only the generic path
  // ever ran — which is exactly why this shape went unnoticed.
  it('reports every item as failed (and evicts nothing) when the COMMIT fails after the callback resolved', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = createMutableMockDb({ orders: [] });
    const cacheProvider = makeCacheProvider();
    const realTransaction = db.transaction;
    // Snapshot / run / restore is the REAL mock transaction; the only change is
    // that the commit at the end of the callback fails, which is what a 40001 or
    // a deferred-constraint violation looks like from the caller's side.
    db.transaction = async (callback: (trx: unknown) => Promise<unknown>) =>
      realTransaction(async (trx: unknown) => {
        // The batch runs to completion — every mutation succeeds and the
        // per-item results are assembled …
        await callback(trx);
        // … and only THEN does the commit fail.
        throw new Error('could not serialize access due to concurrent update (40001)');
      });
    const body: BatchMutationRequest = {
      mutations: [
        { id: 'm1', operation: 'insert', table: 'orders', values: { status: 'a' } },
        { id: 'm2', operation: 'insert', table: 'orders', values: { status: 'b' } },
      ],
    };

    const { results } = await handleMutation(body, CLAIMS, {
      db,
      schemaAllowlist: ALLOWLIST,
      tenancy: MULTI_TENANT,
      cacheProvider,
      atomic: true,
    });

    expect(results.map((r) => r.id)).toEqual(['m1', 'm2']);
    // The bug returned `[{ok:true},{ok:true}]` here.
    expect(results.map((r) => r.ok)).toEqual([false, false]);
    for (const result of results) {
      expect(result.error).toMatch(/could not be committed and was rolled back/);
      // The raw driver error is a schema/concurrency oracle — never verbatim.
      expect(result.error).not.toMatch(/40001/);
    }
    // The rollback really happened — no row survived the failed commit …
    expect(db.snapshot().orders).toHaveLength(0);
    // … and nothing was evicted, because nothing changed in the database.
    expect(cacheProvider.deletedTags).toEqual([]);
    warnSpy.mockRestore();
  });

  it('reports every item as failed when db.transaction resolves without running the callback', async () => {
    const db = createMutableMockDb({ orders: [] });
    // A host `transaction()` that never awaits (or never runs) its callback.
    db.transaction = async () => undefined;
    const body: BatchMutationRequest = {
      mutations: [
        { id: 'm1', operation: 'insert', table: 'orders', values: { status: 'a' } },
        { id: 'm2', operation: 'insert', table: 'orders', values: { status: 'b' } },
      ],
    };

    const { results } = await handleMutation(body, CLAIMS, {
      db,
      schemaAllowlist: ALLOWLIST,
      tenancy: MULTI_TENANT,
      atomic: true,
    });

    // Every requested mutation gets a result — the previous `results ?? []`
    // fallback returned an empty array, silently dropping both.
    expect(results.map((r) => r.id)).toEqual(['m1', 'm2']);
    expect(results.every((r) => r.ok === false)).toBe(true);
    expect(results[0].error).toMatch(/resolved without running the batch callback/);
  });
});

// ── Mutation value shape (finding M2) ─────────────────────────────────────────
//
// Regression: `values` KEYS were validated three ways but the VALUES themselves
// never were — a non-string value skipped the MAX_STRING_VALUE_LENGTH cap
// entirely and reached `db(table).insert(values)`, where mysql2 silently writes
// "[object Object]" and pg raises an opaque error.

describe('handleMutation — non-scalar mutation values', () => {
  it('rejects a nested-object value instead of writing it, and writes no row', async () => {
    const db = createMutableMockDb({ orders: [] });
    const body: BatchMutationRequest = {
      mutations: [
        {
          id: 'm1',
          operation: 'insert',
          table: 'orders',
          values: { notes: { a: Array.from({ length: 1_000 }, (_unused, i) => i) } } as any,
        },
      ],
    };

    const { results } = await handleMutation(body, CLAIMS, {
      db,
      schemaAllowlist: ALLOWLIST,
      tenancy: SINGLE_TENANT,
    });

    expect(results[0].ok).toBe(false);
    expect(results[0].error).toMatch(/only scalar values/);
    expect(db.snapshot().orders).toHaveLength(0);
  });

  it('rejects an array value on update and leaves the row untouched', async () => {
    const db = createMutableMockDb({ orders: [{ id: 1, status: 'pending' }] });
    const body: BatchMutationRequest = {
      mutations: [
        {
          id: 'm1',
          operation: 'update',
          table: 'orders',
          values: { status: ['a', 'b'] } as any,
          where: [{ column: 'id', operator: 'eq', value: 1 }],
        },
      ],
    };

    const { results } = await handleMutation(body, CLAIMS, {
      db,
      schemaAllowlist: ALLOWLIST,
      tenancy: SINGLE_TENANT,
    });

    expect(results[0].ok).toBe(false);
    expect(results[0].error).toMatch(/only scalar values/);
    expect(db.snapshot().orders[0].status).toBe('pending');
  });

  it('still accepts every legitimate scalar (string, number, boolean, null)', async () => {
    const db = createMutableMockDb({ orders: [] });
    const body: BatchMutationRequest = {
      mutations: [
        {
          id: 'm1',
          operation: 'insert',
          table: 'orders',
          values: { status: 'ok', total: 12.5, paid: true, cancelled_at: null },
        },
      ],
    };

    const { results } = await handleMutation(body, CLAIMS, {
      db,
      schemaAllowlist: ALLOWLIST,
      tenancy: SINGLE_TENANT,
    });

    expect(results[0]).toMatchObject({ id: 'm1', ok: true });
    expect(db.snapshot().orders[0]).toMatchObject({
      status: 'ok',
      total: 12.5,
      paid: true,
      cancelled_at: null,
    });
  });
});

// ── Row-level-security column non-disclosure (finding L3) ─────────────────────

describe('handleMutation — RLS column names are not disclosed to the client', () => {
  it('does not name the tenant column in the client-facing error, but logs it server-side', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = createMutableMockDb({ orders: [] });
    const body: BatchMutationRequest = {
      mutations: [
        {
          id: 'm1',
          operation: 'insert',
          table: 'orders',
          values: { status: 'ok', tenant_id: 'victim' },
        },
      ],
    };

    const { results } = await handleMutation(body, CLAIMS, {
      db,
      schemaAllowlist: ALLOWLIST,
      tenancy: MULTI_TENANT,
      writableColumns: { orders: ['status', 'tenant_id'] },
    });

    expect(results[0].ok).toBe(false);
    // The class of violation is still stated…
    expect(results[0].error).toMatch(/tenant isolation column/);
    // …but the column NAME never reaches the client (it would confirm the
    // deployment's tenancy schema to any authenticated prober).
    expect(results[0].error).not.toMatch(/tenant_id/);
    // The operator still gets the full detail server-side.
    const warned = warnSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warned).toMatch(/tenant_id/);
    warnSpy.mockRestore();
  });
});
