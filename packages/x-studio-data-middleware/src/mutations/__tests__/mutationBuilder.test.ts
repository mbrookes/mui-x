/**
 * Tests for `mutationBuilder` — parameterized INSERT / UPDATE / DELETE construction
 * and the `validateMutation` pre-flight.
 *
 * Uses a mutable in-memory mock so no SQLite driver or real DB connection is needed.
 * The mock's `insert` / `update` / `delete` methods mutate an in-memory table and
 * return row counts matching the real Knex contract.
 */
import { describe, it, expect, vi } from 'vitest';
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
          if (op === '=') predicates.push((r) => r[key] === val);
          else if (op === '!=') predicates.push((r) => r[key] !== val);
          else if (op === '<') predicates.push((r) => (r[key] as number) < (val as number));
          else if (op === '<=') predicates.push((r) => (r[key] as number) <= (val as number));
          else if (op === '>') predicates.push((r) => (r[key] as number) > (val as number));
          else if (op === '>=') predicates.push((r) => (r[key] as number) >= (val as number));
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
      then(resolve: (v: unknown) => void, reject?: (e: Error) => void) {
        try {
          const rows = (tables[table] ??= []);
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
        } catch (err) {
          reject?.(err as Error);
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
      validateMutation(descriptor, {
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
    expect(() => validateMutation(descriptor, {})).toThrow(/requires at least one "where"/);
  });

  it('throws when a delete has no WHERE predicates', () => {
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'delete',
      table: 'orders',
      where: [],
    };
    expect(() => validateMutation(descriptor, {})).toThrow(/requires at least one "where"/);
  });

  it('throws when a value key is not in the writable columns list', () => {
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'insert',
      table: 'orders',
      values: { status: 'ok', secret_field: 'bad' },
    };
    expect(() => validateMutation(descriptor, { writableColumns: { orders: ['status'] } })).toThrow(
      /not in the writable columns allowlist/,
    );
  });

  it('throws when the client tries to set the tenant column', () => {
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'insert',
      table: 'orders',
      values: { tenant_id: 'other-tenant', status: 'ok' },
    };
    expect(() =>
      validateMutation(descriptor, {
        writableColumns: { orders: ['status', 'tenant_id'] },
        tenantColumn: 'tenant_id',
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
      validateMutation(descriptor, { writableColumns: { orders: ['status', 'notes'] } }),
    ).not.toThrow();
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
    await buildInsertMutation(db, CLAIMS, descriptor, 'tenant_id');
    const { orders } = db.snapshot();
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ status: 'pending', total: 100, tenant_id: 'acme' });
  });

  it('inserts without tenant column when tenantColumn is undefined', async () => {
    const db = createMutableMockDb({ orders: [] });
    const descriptor: MutationDescriptor = {
      id: 'm1',
      operation: 'insert',
      table: 'orders',
      values: { status: 'pending' },
    };
    await buildInsertMutation(db, CLAIMS, descriptor);
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
    const result = await buildInsertMutation(db, CLAIMS, descriptor);
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
    const rowsAffected = await buildUpdateMutation(db, CLAIMS, descriptor, 'tenant_id');
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
    await buildUpdateMutation(db, CLAIMS, descriptor, 'tenant_id');
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
    const count = await buildUpdateMutation(db, CLAIMS, descriptor, 'tenant_id');
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
    const rowsAffected = await buildDeleteMutation(db, CLAIMS, descriptor, 'tenant_id');
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
    const count = await buildDeleteMutation(db, CLAIMS, descriptor, 'tenant_id');
    expect(count).toBe(2);
  });
});
