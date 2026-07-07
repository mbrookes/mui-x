/**
 * Tests for `mutationBuilder` — parameterized INSERT / UPDATE / DELETE construction
 * and the `validateMutation` pre-flight.
 *
 * Uses a mutable in-memory mock so no SQLite driver or real DB connection is needed.
 * The mock's `insert` / `update` / `delete` methods mutate an in-memory table and
 * return row counts matching the real Knex contract.
 */
import { describe, it, expect } from 'vitest';
import {
  validateMutation,
  buildInsertMutation,
  buildUpdateMutation,
  buildDeleteMutation,
} from '../mutationBuilder';
import type { MutationDescriptor } from '../../security/types';

// ── Mutable in-memory mock DB ─────────────────────────────────────────────────

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
          } else if (op === '<=') {
            predicates.push((r) => (r[key] as number) <= (val as number));
          } else if (op === '>') {
            predicates.push((r) => (r[key] as number) > (val as number));
          } else if (op === '>=') {
            predicates.push((r) => (r[key] as number) >= (val as number));
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
      whereBetween(col: string, [lo, hi]: [unknown, unknown]) {
        predicates.push(
          (r) => (r[col] as number) >= (lo as number) && (r[col] as number) <= (hi as number),
        );
        return qb;
      },
      whereLike(col: string, pattern: string) {
        const regex = new RegExp(`^${pattern.replace(/%/g, '.*')}$`, 'i');
        predicates.push((r) => regex.test(String(r[col])));
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
            resolve([rows.length]); // SQLite-style: returns [lastInsertRowid]
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

// ── Test claims ───────────────────────────────────────────────────────────────

const CLAIMS = { tenantId: 'acme', userId: 'u1', roleIds: ['editor'] };

// Tenancy is now a required, explicit decision at every enforcement site. Builders
// and validateMutation take a security policy: multi-tenant tests use MT_POLICY;
// tests that configure no tenant column declare ST_POLICY (single-tenant)
// explicitly — the same unscoped behavior, now stated rather than silently implied.
const MULTI_TENANT = { mode: 'multi-tenant', tenantColumn: 'tenant_id' } as const;
const SINGLE_TENANT = { mode: 'single-tenant' } as const;
const MT_POLICY = { tenancy: MULTI_TENANT } as const;
const ST_POLICY = { tenancy: SINGLE_TENANT } as const;

// ── validateMutation ──────────────────────────────────────────────────────────

describe('validateMutation', () => {
  it('passes for a valid insert with allowed columns', () => {
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'insert',
      table: 'orders',
      values: { status: 'pending', total: 100 },
    };
    expect(() =>
      validateMutation(descriptor, CLAIMS, {
        policy: ST_POLICY,
        writableColumns: { orders: ['status', 'total', 'notes'] },
      }),
    ).not.toThrow();
  });

  it('throws when an update has no WHERE predicates', () => {
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'update',
      table: 'orders',
      values: { status: 'shipped' },
    };
    expect(() => validateMutation(descriptor, CLAIMS, { policy: ST_POLICY })).toThrow(
      /requires at least one "where"/,
    );
  });

  it('throws when a delete has no WHERE predicates', () => {
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'delete',
      table: 'orders',
      where: [],
    };
    expect(() => validateMutation(descriptor, CLAIMS, { policy: ST_POLICY })).toThrow(
      /requires at least one "where"/,
    );
  });

  it('throws when a value key is not in the writable columns list', () => {
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'insert',
      table: 'orders',
      values: { status: 'ok', secret_field: 'bad' },
    };
    expect(() =>
      validateMutation(descriptor, CLAIMS, {
        policy: ST_POLICY,
        writableColumns: { orders: ['status'] },
      }),
    ).toThrow(/not in the column allowlist/);
  });

  it('throws when the client tries to set the tenant column', () => {
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'insert',
      table: 'orders',
      values: { tenant_id: 'other-tenant', status: 'ok' },
    };
    expect(() =>
      validateMutation(descriptor, CLAIMS, {
        policy: MT_POLICY,
        writableColumns: { orders: ['status', 'tenant_id'] },
      }),
    ).toThrow(/tenant isolation column/);
  });

  it('passes for a valid update with WHERE and allowed columns', () => {
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'update',
      table: 'orders',
      values: { status: 'shipped' },
      where: [{ column: 'id', operator: 'eq', value: 42 }],
    };
    expect(() =>
      validateMutation(descriptor, CLAIMS, {
        policy: ST_POLICY,
        writableColumns: { orders: ['status', 'notes'] },
      }),
    ).not.toThrow();
  });

  it('throws when a WHERE column is not in the column allowlist', () => {
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'delete',
      table: 'orders',
      where: [{ column: 'secret_internal_flag', operator: 'eq', value: true }],
    };
    expect(() =>
      validateMutation(descriptor, CLAIMS, {
        policy: ST_POLICY,
        columnAllowlist: { orders: ['id', 'status'] },
      }),
    ).toThrow(/not in the column allowlist/);
  });

  it('passes when all WHERE columns are in the column allowlist', () => {
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'update',
      table: 'orders',
      values: { status: 'shipped' },
      where: [{ column: 'id', operator: 'eq', value: 42 }],
    };
    expect(() =>
      validateMutation(descriptor, CLAIMS, {
        policy: ST_POLICY,
        columnAllowlist: { orders: ['id', 'status'] },
      }),
    ).not.toThrow();
  });

  it('validates a qualified WHERE column against the named table allowlist', () => {
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'delete',
      table: 'orders',
      where: [{ column: 'orders.deleted_at', operator: 'eq', value: null as unknown as number }],
    };
    expect(() =>
      validateMutation(descriptor, CLAIMS, {
        policy: ST_POLICY,
        columnAllowlist: { orders: ['id', 'status'] },
      }),
    ).toThrow(/Column "deleted_at" on table "orders"/);
  });
});

// ── buildInsertMutation ───────────────────────────────────────────────────────

describe('buildInsertMutation', () => {
  it('inserts a row and injects the tenant column from claims', async () => {
    const db = createMutableMockDb({ orders: [] });
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'insert',
      table: 'orders',
      values: { status: 'pending', total: 100 },
    };
    await buildInsertMutation(db, CLAIMS, descriptor, MT_POLICY);
    const { orders } = db.snapshot();
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ status: 'pending', total: 100, tenant_id: 'acme' });
  });

  it('inserts without a tenant column in single-tenant mode', async () => {
    const db = createMutableMockDb({ orders: [] });
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'insert',
      table: 'orders',
      values: { status: 'pending' },
    };
    await buildInsertMutation(db, CLAIMS, descriptor, ST_POLICY);
    expect(db.snapshot().orders[0]).not.toHaveProperty('tenant_id');
  });

  it('returns an array (SQLite-style) as the insert result', async () => {
    const db = createMutableMockDb({ orders: [] });
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'insert',
      table: 'orders',
      values: { status: 'pending' },
    };
    const result = await buildInsertMutation(db, CLAIMS, descriptor, ST_POLICY);
    expect(Array.isArray(result)).toBe(true);
  });
});

// ── buildUpdateMutation ───────────────────────────────────────────────────────

describe('buildUpdateMutation', () => {
  it('updates only rows matching both tenant scope and WHERE predicates', async () => {
    const db = createMutableMockDb({
      orders: [
        { id: 1, tenant_id: 'acme', status: 'pending' },
        { id: 2, tenant_id: 'acme', status: 'pending' },
        { id: 3, tenant_id: 'other', status: 'pending' },
      ],
    });
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'update',
      table: 'orders',
      values: { status: 'shipped' },
      where: [{ column: 'id', operator: 'eq', value: 1 }],
    };
    const rowsAffected = await buildUpdateMutation(db, CLAIMS, descriptor, MT_POLICY);
    expect(rowsAffected).toBe(1);
    const { orders } = db.snapshot();
    expect(orders.find((r) => r.id === 1)?.status).toBe('shipped');
    expect(orders.find((r) => r.id === 2)?.status).toBe('pending'); // untouched
    expect(orders.find((r) => r.id === 3)?.status).toBe('pending'); // wrong tenant
  });

  it('strips the tenant column from update values (cannot re-tenant a row)', async () => {
    const db = createMutableMockDb({
      orders: [{ id: 1, tenant_id: 'acme', status: 'pending' }],
    });
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'update',
      table: 'orders',
      values: { status: 'shipped', tenant_id: 'attacker' },
      where: [{ column: 'id', operator: 'eq', value: 1 }],
    };
    await buildUpdateMutation(db, CLAIMS, descriptor, MT_POLICY);
    // tenant_id must remain 'acme'
    expect(db.snapshot().orders[0].tenant_id).toBe('acme');
  });

  it('returns the count of rows updated', async () => {
    const db = createMutableMockDb({
      orders: [
        { id: 1, tenant_id: 'acme', status: 'pending' },
        { id: 2, tenant_id: 'acme', status: 'pending' },
      ],
    });
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'update',
      table: 'orders',
      values: { status: 'shipped' },
      where: [{ column: 'status', operator: 'eq', value: 'pending' }],
    };
    const count = await buildUpdateMutation(db, CLAIMS, descriptor, MT_POLICY);
    expect(count).toBe(2);
  });
});

// ── buildDeleteMutation ───────────────────────────────────────────────────────

describe('buildDeleteMutation', () => {
  it('deletes only rows matching both tenant scope and WHERE predicates', async () => {
    const db = createMutableMockDb({
      orders: [
        { id: 1, tenant_id: 'acme', status: 'cancelled' },
        { id: 2, tenant_id: 'acme', status: 'shipped' },
        { id: 3, tenant_id: 'other', status: 'cancelled' },
      ],
    });
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'delete',
      table: 'orders',
      where: [{ column: 'status', operator: 'eq', value: 'cancelled' }],
    };
    const rowsAffected = await buildDeleteMutation(db, CLAIMS, descriptor, MT_POLICY);
    expect(rowsAffected).toBe(1); // only acme's cancelled row
    const { orders } = db.snapshot();
    expect(orders).toHaveLength(2); // id=2 (acme) + id=3 (other)
    expect(orders.find((r) => r.id === 1)).toBeUndefined();
    expect(orders.find((r) => r.id === 3)).toBeDefined(); // other tenant untouched
  });

  it('returns the count of rows deleted', async () => {
    const db = createMutableMockDb({
      orders: [
        { id: 1, tenant_id: 'acme', status: 'cancelled' },
        { id: 2, tenant_id: 'acme', status: 'cancelled' },
      ],
    });
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'delete',
      table: 'orders',
      where: [{ column: 'status', operator: 'eq', value: 'cancelled' }],
    };
    const count = await buildDeleteMutation(db, CLAIMS, descriptor, MT_POLICY);
    expect(count).toBe(2);
  });
});

// ── Write-path predicate safety (empty IN, unknown operator) ──────────────────

describe('write-path predicate safety', () => {
  it('REJECTS a delete whose only WHERE is an empty "in" list (would wipe the tenant table)', () => {
    const db = createMutableMockDb({
      orders: [
        { id: 1, tenant_id: 'acme', status: 'a' },
        { id: 2, tenant_id: 'acme', status: 'b' },
      ],
    });
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'delete',
      table: 'orders',
      where: [{ column: 'id', operator: 'in', value: [] }],
    };
    // Build throws synchronously — the predicate is NOT silently dropped.
    expect(() => buildDeleteMutation(db, CLAIMS, descriptor, MT_POLICY)).toThrow(
      /"in" predicate with an empty value list/,
    );
    // Nothing was deleted.
    expect(db.snapshot().orders).toHaveLength(2);
  });

  it('REJECTS an update whose only WHERE is an empty "in" list', () => {
    const db = createMutableMockDb({ orders: [{ id: 1, tenant_id: 'acme', status: 'a' }] });
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'update',
      table: 'orders',
      values: { status: 'z' },
      where: [{ column: 'id', operator: 'in', value: [] }],
    };
    expect(() => buildUpdateMutation(db, CLAIMS, descriptor, MT_POLICY)).toThrow(
      /"in" predicate with an empty value list/,
    );
    expect(db.snapshot().orders[0].status).toBe('a');
  });

  it('REJECTS an unknown operator on the write path (no silent drop)', () => {
    const db = createMutableMockDb({ orders: [{ id: 1, tenant_id: 'acme' }] });
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'delete',
      table: 'orders',
      where: [{ column: 'id', operator: 'sql' as any, value: 1 }],
    };
    expect(() => buildDeleteMutation(db, CLAIMS, descriptor, MT_POLICY)).toThrow(
      /Unsupported filter operator/,
    );
    expect(db.snapshot().orders).toHaveLength(1);
  });

  it('allows a non-empty "in" list on the write path', async () => {
    const db = createMutableMockDb({
      orders: [
        { id: 1, tenant_id: 'acme', status: 'a' },
        { id: 2, tenant_id: 'acme', status: 'b' },
      ],
    });
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'delete',
      table: 'orders',
      where: [{ column: 'id', operator: 'in', value: [1] }],
    };
    const count = await buildDeleteMutation(db, CLAIMS, descriptor, MT_POLICY);
    expect(count).toBe(1);
    expect(db.snapshot().orders.map((r) => r.id)).toEqual([2]);
  });
});

// ── Write-path predicate operators beyond eq/in (between, like, lte, gte) ──────
//
// `applyPredicates` (shared/predicates.ts) supports the full `SAFE_OPERATORS`
// set on both read and write, but until now no mutation test exercised
// `between`/`like`/`lte`/`gte` — only `eq` and `in` were proven to actually
// scope a mutation. These prove each operator narrows the UPDATE/DELETE to the
// matching rows (not merely "accepted without throwing").

describe('write-path predicate operators (between/like/lte/gte)', () => {
  it('"gte" scopes an update to rows at or above the threshold', async () => {
    const db = createMutableMockDb({
      orders: [
        { id: 1, tenant_id: 'acme', total: 50, status: 'pending' },
        { id: 2, tenant_id: 'acme', total: 100, status: 'pending' },
        { id: 3, tenant_id: 'acme', total: 150, status: 'pending' },
      ],
    });
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'update',
      table: 'orders',
      values: { status: 'shipped' },
      where: [{ column: 'total', operator: 'gte', value: 100 }],
    };
    const count = await buildUpdateMutation(db, CLAIMS, descriptor, MT_POLICY);
    expect(count).toBe(2);
    const { orders } = db.snapshot();
    expect(orders.find((r) => r.id === 1)?.status).toBe('pending'); // below threshold
    expect(orders.find((r) => r.id === 2)?.status).toBe('shipped');
    expect(orders.find((r) => r.id === 3)?.status).toBe('shipped');
  });

  it('"lte" scopes a delete to rows at or below the threshold', async () => {
    const db = createMutableMockDb({
      orders: [
        { id: 1, tenant_id: 'acme', total: 50 },
        { id: 2, tenant_id: 'acme', total: 100 },
        { id: 3, tenant_id: 'acme', total: 150 },
      ],
    });
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'delete',
      table: 'orders',
      where: [{ column: 'total', operator: 'lte', value: 100 }],
    };
    const count = await buildDeleteMutation(db, CLAIMS, descriptor, MT_POLICY);
    expect(count).toBe(2);
    expect(db.snapshot().orders.map((r) => r.id)).toEqual([3]); // only the row above threshold survives
  });

  it('"between" scopes an update to rows inside the inclusive range', async () => {
    const db = createMutableMockDb({
      orders: [
        { id: 1, tenant_id: 'acme', total: 40, status: 'pending' },
        { id: 2, tenant_id: 'acme', total: 100, status: 'pending' }, // inclusive lower bound
        { id: 3, tenant_id: 'acme', total: 150, status: 'pending' },
        { id: 4, tenant_id: 'acme', total: 200, status: 'pending' }, // inclusive upper bound
        { id: 5, tenant_id: 'acme', total: 260, status: 'pending' },
      ],
    });
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'update',
      table: 'orders',
      values: { status: 'shipped' },
      where: [{ column: 'total', operator: 'between', value: [100, 200] }],
    };
    const count = await buildUpdateMutation(db, CLAIMS, descriptor, MT_POLICY);
    expect(count).toBe(3);
    const { orders } = db.snapshot();
    expect(orders.find((r) => r.id === 1)?.status).toBe('pending'); // below range
    expect(orders.find((r) => r.id === 2)?.status).toBe('shipped');
    expect(orders.find((r) => r.id === 3)?.status).toBe('shipped');
    expect(orders.find((r) => r.id === 4)?.status).toBe('shipped');
    expect(orders.find((r) => r.id === 5)?.status).toBe('pending'); // above range
  });

  it('"like" scopes a delete to rows matching the pattern', async () => {
    const db = createMutableMockDb({
      orders: [
        { id: 1, tenant_id: 'acme', notes: 'urgent: rush order' },
        { id: 2, tenant_id: 'acme', notes: 'standard delivery' },
        { id: 3, tenant_id: 'acme', notes: 'urgent: hold for pickup' },
      ],
    });
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'delete',
      table: 'orders',
      where: [{ column: 'notes', operator: 'like', value: 'urgent%' }],
    };
    const count = await buildDeleteMutation(db, CLAIMS, descriptor, MT_POLICY);
    expect(count).toBe(2);
    expect(db.snapshot().orders.map((r) => r.id)).toEqual([2]); // only the non-matching row survives
  });

  it('"between"/"like"/"lte"/"gte" still respect tenant scoping (do not leak across tenants)', async () => {
    const db = createMutableMockDb({
      orders: [
        { id: 1, tenant_id: 'acme', total: 150 },
        { id: 2, tenant_id: 'other', total: 150 }, // same shape, different tenant
      ],
    });
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'delete',
      table: 'orders',
      where: [{ column: 'total', operator: 'between', value: [100, 200] }],
    };
    const count = await buildDeleteMutation(db, CLAIMS, descriptor, MT_POLICY);
    expect(count).toBe(1);
    expect(db.snapshot().orders.map((r) => r.id)).toEqual([2]); // other tenant's row untouched
  });
});

// ── Write-path region / department scoping (symmetry with reads) ───────────────

describe('write-path security scoping', () => {
  const REGION_CLAIMS = { tenantId: 'acme', userId: 'u1', roleIds: ['editor'], regionIds: [1] };

  it('update only affects rows inside the caller region', async () => {
    const db = createMutableMockDb({
      orders: [
        { id: 1, tenant_id: 'acme', region_id: 1, status: 'pending' },
        { id: 2, tenant_id: 'acme', region_id: 2, status: 'pending' },
      ],
    });
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'update',
      table: 'orders',
      values: { status: 'shipped' },
      where: [{ column: 'status', operator: 'eq', value: 'pending' }],
    };
    const count = await buildUpdateMutation(db, REGION_CLAIMS, descriptor, MT_POLICY);
    expect(count).toBe(1);
    const { orders } = db.snapshot();
    expect(orders.find((r) => r.id === 1)?.status).toBe('shipped'); // region 1
    expect(orders.find((r) => r.id === 2)?.status).toBe('pending'); // region 2 untouched
  });

  it('delete only affects rows inside the caller region', async () => {
    const db = createMutableMockDb({
      orders: [
        { id: 1, tenant_id: 'acme', region_id: 1, status: 'cancelled' },
        { id: 2, tenant_id: 'acme', region_id: 2, status: 'cancelled' },
      ],
    });
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'delete',
      table: 'orders',
      where: [{ column: 'status', operator: 'eq', value: 'cancelled' }],
    };
    const count = await buildDeleteMutation(db, REGION_CLAIMS, descriptor, MT_POLICY);
    expect(count).toBe(1);
    const { orders } = db.snapshot();
    expect(orders.map((r) => r.id)).toEqual([2]); // region 2 row survives
  });

  it('respects a custom region column name from securityColumns', async () => {
    const db = createMutableMockDb({
      orders: [
        { id: 1, tenant_id: 'acme', sales_region: 1, status: 'pending' },
        { id: 2, tenant_id: 'acme', sales_region: 9, status: 'pending' },
      ],
    });
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'update',
      table: 'orders',
      values: { status: 'shipped' },
      where: [{ column: 'status', operator: 'eq', value: 'pending' }],
    };
    const count = await buildUpdateMutation(db, REGION_CLAIMS, descriptor, {
      tenancy: MULTI_TENANT,
      securityColumns: {
        region: 'sales_region',
      },
    });
    expect(count).toBe(1);
    expect(db.snapshot().orders.find((r) => r.id === 2)?.status).toBe('pending');
  });
});

// ── Empty-region scope (regionIds: []) is fail-CLOSED on writes ────────────────
//
// Regression: `regionIds: []` means "authorized for zero regions" and must NOT
// be conflated with `regionIds: undefined` ("this deployment is not region
// scoped"). On the write path an empty region scope must REJECT the mutation
// rather than silently drop the region predicate (which would widen it).

describe('write-path empty-region scope (regionIds: [])', () => {
  const ZERO_REGION_CLAIMS = { tenantId: 'acme', userId: 'u1', roleIds: ['editor'], regionIds: [] };

  it('REJECTS an update when the caller is authorized for zero regions', () => {
    const db = createMutableMockDb({ orders: [{ id: 1, tenant_id: 'acme', status: 'pending' }] });
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'update',
      table: 'orders',
      values: { status: 'shipped' },
      where: [{ column: 'status', operator: 'eq', value: 'pending' }],
    };
    expect(() => buildUpdateMutation(db, ZERO_REGION_CLAIMS, descriptor, MT_POLICY)).toThrow(
      /authorized for zero regions/,
    );
    // Nothing was updated.
    expect(db.snapshot().orders[0].status).toBe('pending');
  });

  it('REJECTS a delete when the caller is authorized for zero regions', () => {
    const db = createMutableMockDb({ orders: [{ id: 1, tenant_id: 'acme', status: 'cancelled' }] });
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'delete',
      table: 'orders',
      where: [{ column: 'status', operator: 'eq', value: 'cancelled' }],
    };
    expect(() => buildDeleteMutation(db, ZERO_REGION_CLAIMS, descriptor, MT_POLICY)).toThrow(
      /authorized for zero regions/,
    );
    expect(db.snapshot().orders).toHaveLength(1);
  });

  it('REJECTS an insert that stamps ANY region_id when authorized for zero regions', () => {
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'insert',
      table: 'orders',
      values: { status: 'ok', region_id: 3 },
    };
    expect(() =>
      validateMutation(descriptor, ZERO_REGION_CLAIMS, {
        policy: MT_POLICY,
        writableColumns: { orders: ['status', 'region_id'] },
      }),
    ).toThrow(/outside the caller's permitted regions/);
  });

  it('still allows an update with regionIds: undefined (deployment is not region-scoped)', async () => {
    const NO_REGION_CLAIMS = { tenantId: 'acme', userId: 'u1', roleIds: ['editor'] };
    const db = createMutableMockDb({
      orders: [
        { id: 1, tenant_id: 'acme', region_id: 1, status: 'pending' },
        { id: 2, tenant_id: 'acme', region_id: 2, status: 'pending' },
      ],
    });
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'update',
      table: 'orders',
      values: { status: 'shipped' },
      where: [{ column: 'status', operator: 'eq', value: 'pending' }],
    };
    // No region scoping → both tenant rows are updated (undefined ≠ []).
    const count = await buildUpdateMutation(db, NO_REGION_CLAIMS, descriptor, MT_POLICY);
    expect(count).toBe(2);
  });
});

// ── INSERT tenant stamping in multi-tenant mode ───────────────────────────────
//
// Regression for finding 1.1 (CRITICAL): a multi-tenant deployment must stamp the
// caller's tenant on insert AND reject a client-supplied tenant value. (The global
// tenant column now lives in the required `tenancy` posture rather than a
// `securityColumns.tenant` field, so multi-tenant mode is the equivalent premise;
// a per-table override still lets a single table use a different tenant column.)

describe('INSERT tenant stamping (multi-tenant)', () => {
  it('stamps the tenant column in multi-tenant mode', async () => {
    const db = createMutableMockDb({ orders: [] });
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'insert',
      table: 'orders',
      values: { status: 'pending', total: 100 },
    };
    await buildInsertMutation(db, CLAIMS, descriptor, MT_POLICY);
    const { orders } = db.snapshot();
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ status: 'pending', total: 100, tenant_id: 'acme' });
  });

  it('rejects a client-supplied tenant value in multi-tenant mode', () => {
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'insert',
      table: 'orders',
      values: { tenant_id: 'victim-tenant', status: 'ok' },
    };
    expect(() =>
      validateMutation(descriptor, CLAIMS, {
        policy: MT_POLICY,
        writableColumns: { orders: ['status', 'tenant_id'] },
      }),
    ).toThrow(/tenant isolation column/);
  });

  it('resolves the tenant column from a perTable override', async () => {
    const db = createMutableMockDb({ orders: [] });
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'insert',
      table: 'orders',
      values: { status: 'pending' },
    };
    await buildInsertMutation(db, CLAIMS, descriptor, {
      tenancy: MULTI_TENANT,
      securityColumns: {
        perTable: { orders: { tenant: 'org_id' } },
      },
    });
    expect(db.snapshot().orders[0]).toMatchObject({ status: 'pending', org_id: 'acme' });
  });
});

// ── INSERT region / department scope validation (finding 1.5) ─────────────────

describe('INSERT region/department scope validation', () => {
  const REGION_CLAIMS = { tenantId: 'acme', userId: 'u1', roleIds: ['editor'], regionIds: [5] };
  const DEPT_CLAIMS = { tenantId: 'acme', userId: 'u1', roleIds: ['editor'], department: 'Sales' };

  it('rejects an insert whose region_id is outside the caller regions', () => {
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'insert',
      table: 'orders',
      values: { status: 'ok', region_id: 6 },
    };
    expect(() =>
      validateMutation(descriptor, REGION_CLAIMS, {
        policy: MT_POLICY,
        writableColumns: { orders: ['status', 'region_id'] },
      }),
    ).toThrow(/outside the caller's permitted regions/);
  });

  it('allows an insert whose region_id is inside the caller regions', () => {
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'insert',
      table: 'orders',
      values: { status: 'ok', region_id: 5 },
    };
    expect(() =>
      validateMutation(descriptor, REGION_CLAIMS, {
        policy: MT_POLICY,
        writableColumns: { orders: ['status', 'region_id'] },
      }),
    ).not.toThrow();
  });

  it('rejects an insert whose department is outside the caller department', () => {
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'insert',
      table: 'orders',
      values: { status: 'ok', department: 'Finance' },
    };
    expect(() =>
      validateMutation(descriptor, DEPT_CLAIMS, {
        policy: MT_POLICY,
        writableColumns: { orders: ['status', 'department'] },
      }),
    ).toThrow(/outside the caller's department/);
  });
});

// ── Write-path column validation is fail-closed + wildcard-aware (finding 1.4) ─

describe('write-path column validation (fail-closed + wildcard)', () => {
  it('rejects a value key when the target table has NO writableColumns entry (fail-closed)', () => {
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'insert',
      table: 'orders',
      values: { status: 'ok' },
    };
    // writableColumns supplied, but 'orders' has no entry — must reject, not pass.
    expect(() =>
      validateMutation(descriptor, CLAIMS, {
        policy: ST_POLICY,
        writableColumns: { customers: ['name'] },
      }),
    ).toThrow(/has no entry in the column allowlist/);
  });

  it('rejects a WHERE column when the target table has NO columnAllowlist entry (fail-closed)', () => {
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'delete',
      table: 'orders',
      where: [{ column: 'status', operator: 'eq', value: 'x' }],
    };
    expect(() =>
      validateMutation(descriptor, CLAIMS, {
        policy: ST_POLICY,
        columnAllowlist: { customers: ['id'] },
      }),
    ).toThrow(/has no entry in the column allowlist/);
  });

  it('honors ["*"] as an opt-out for writable value keys', () => {
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'insert',
      table: 'orders',
      values: { status: 'ok', anything: 1 },
    };
    expect(() =>
      validateMutation(descriptor, CLAIMS, {
        policy: ST_POLICY,
        writableColumns: { orders: ['*'] },
      }),
    ).not.toThrow();
  });

  it('honors ["*"] as an opt-out for WHERE columns', () => {
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'delete',
      table: 'orders',
      where: [{ column: 'whatever', operator: 'eq', value: 'x' }],
    };
    expect(() =>
      validateMutation(descriptor, CLAIMS, {
        policy: ST_POLICY,
        columnAllowlist: { orders: ['*'] },
      }),
    ).not.toThrow();
  });
});

// ── Qualified `values` keys are rejected (finding 1.2) ────────────────────────
//
// A table-qualified `values` key (`table.column`) must be rejected outright.
// `validateSecurityColumnValues` matches on BARE column names, so a dotted key
// like `'orders.region_id'` would slip past the region/department/tenant scope
// checks while the writableColumns allowlist (which splits on the first dot)
// wrongly waves it through. Rejection closes that bypass and, incidentally, the
// cross-table allowlist quirk (a qualifier naming a different table).

describe('qualified values keys are rejected (finding 1.2)', () => {
  const REGION_CLAIMS = { tenantId: 'acme', userId: 'u1', roleIds: ['editor'], regionIds: [5] };
  const DEPT_CLAIMS = { tenantId: 'acme', userId: 'u1', roleIds: ['editor'], department: 'Sales' };

  it('rejects a qualified region key on insert (the exploit — bypasses scope otherwise)', () => {
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'insert',
      table: 'orders',
      // Bare region_id: 6 would be rejected by the scope check; the qualifier is
      // what smuggles it past — so validateMutation must reject the qualified key.
      values: { status: 'ok', 'orders.region_id': 6 },
    };
    expect(() =>
      validateMutation(descriptor, REGION_CLAIMS, {
        policy: MT_POLICY,
        writableColumns: { orders: ['*'] },
      }),
    ).toThrow(/table-qualified/);
  });

  it('rejects a qualified tenant key on insert (bypasses tenant isolation otherwise)', () => {
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'insert',
      table: 'orders',
      values: { 'orders.tenant_id': 'victim-tenant', status: 'ok' },
    };
    expect(() =>
      validateMutation(descriptor, CLAIMS, {
        policy: MT_POLICY,
        writableColumns: { orders: ['status', 'tenant_id'] },
      }),
    ).toThrow(/table-qualified/);
  });

  it('rejects a qualified department key on insert', () => {
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'insert',
      table: 'orders',
      values: { 'orders.department': 'Finance' },
    };
    expect(() =>
      validateMutation(descriptor, DEPT_CLAIMS, {
        policy: MT_POLICY,
        writableColumns: { orders: ['*'] },
      }),
    ).toThrow(/table-qualified/);
  });

  it('rejects a qualified tenant key on update via validateMutation', () => {
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'update',
      table: 'orders',
      values: { 'orders.tenant_id': 'attacker', status: 'shipped' },
      where: [{ column: 'id', operator: 'eq', value: 1 }],
    };
    expect(() =>
      validateMutation(descriptor, CLAIMS, {
        policy: MT_POLICY,
        writableColumns: { orders: ['*'] },
      }),
    ).toThrow(/table-qualified/);
  });

  it('rejects a qualified key naming a DIFFERENT table (qualifier-agnostic)', () => {
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'insert',
      table: 'orders',
      values: { 'customers.region_id': 6, status: 'ok' },
    };
    expect(() =>
      validateMutation(descriptor, REGION_CLAIMS, {
        policy: MT_POLICY,
        writableColumns: { orders: ['*'], customers: ['*'] },
      }),
    ).toThrow(/table-qualified/);
  });

  it('buildInsertMutation rejects a qualified key directly and mutates nothing', () => {
    const db = createMutableMockDb({ orders: [] });
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'insert',
      table: 'orders',
      values: { status: 'ok', 'orders.tenant_id': 'victim-tenant' },
    };
    expect(() => buildInsertMutation(db, CLAIMS, descriptor, MT_POLICY)).toThrow(/table-qualified/);
    expect(db.snapshot().orders).toHaveLength(0);
  });

  it('buildUpdateMutation rejects a qualified key directly and mutates nothing', () => {
    const db = createMutableMockDb({ orders: [{ id: 1, tenant_id: 'acme', status: 'pending' }] });
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'update',
      table: 'orders',
      values: { status: 'shipped', 'orders.region_id': 6 },
      where: [{ column: 'id', operator: 'eq', value: 1 }],
    };
    expect(() => buildUpdateMutation(db, CLAIMS, descriptor, MT_POLICY)).toThrow(/table-qualified/);
    expect(db.snapshot().orders[0].status).toBe('pending');
  });

  it('leaves bare-key values unaffected (qualified-WHERE and positive paths still work)', () => {
    // Bare value keys pass exactly as before — the guard only fires on dots.
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'insert',
      table: 'orders',
      values: { status: 'pending', total: 100 },
    };
    expect(() =>
      validateMutation(descriptor, CLAIMS, {
        policy: ST_POLICY,
        writableColumns: { orders: ['status', 'total', 'notes'] },
      }),
    ).not.toThrow();
  });
});
