/**
 * Unit tests for the security-column resolvers in `shared/predicates.ts`.
 *
 * Focus: the own-property gate on the two `perTable[table]` lookups (finding 2.2).
 * `table` is client JSON (`descriptor.table` / `joins[].table`), so a table named
 * like an `Object.prototype` member must resolve to "no per-table override" instead
 * of an inherited prototype object. These were the last two ungated table-keyed
 * prototype-chain reads in the package; every sibling lookup is
 * `Object.prototype.hasOwnProperty.call`-gated.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Knex from 'knex';
import {
  resolvePrimarySecurityColumns,
  resolveJoinSecurityColumns,
  applyPredicates,
} from '../predicates';
import type { SecurityColumnsConfig, FilterPredicate } from '../../security/types';

const TENANT_COLUMN = 'tenant_id';
const DEFAULT_COLUMNS = { tenant: TENANT_COLUMN, region: 'region_id', department: 'department' };

// Object.prototype member names a client could send as a table name.
const PROTO_KEYS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'];

describe('resolvePrimarySecurityColumns / resolveJoinSecurityColumns — own-property gate (finding 2.2)', () => {
  it.each(PROTO_KEYS)(
    'resolvePrimarySecurityColumns falls through to the default columns for a table named "%s"',
    (table) => {
      const config: SecurityColumnsConfig = { perTable: {} };
      expect(resolvePrimarySecurityColumns(table, config, TENANT_COLUMN)).toEqual(DEFAULT_COLUMNS);
    },
  );

  it.each(PROTO_KEYS)(
    'resolveJoinSecurityColumns inherits the default columns for a table named "%s" (not the whole-table opt-out)',
    (table) => {
      const config: SecurityColumnsConfig = { perTable: {} };
      // Must NOT resolve to `undefined` (the explicit-shared-table opt-out) via an
      // inherited prototype member — a proto-named joined table stays scoped.
      expect(resolveJoinSecurityColumns(table, config, TENANT_COLUMN)).toEqual(DEFAULT_COLUMNS);
    },
  );

  it('works when perTable is omitted entirely (no config)', () => {
    for (const table of PROTO_KEYS) {
      expect(resolvePrimarySecurityColumns(table, undefined, TENANT_COLUMN)).toEqual(
        DEFAULT_COLUMNS,
      );
      expect(resolveJoinSecurityColumns(table, undefined, TENANT_COLUMN)).toEqual(DEFAULT_COLUMNS);
    }
  });

  it('a real own-property override is still honored (gate does not break the normal path)', () => {
    const config: SecurityColumnsConfig = { perTable: { customers: { tenant: 'org_id' } } };
    expect(resolvePrimarySecurityColumns('customers', config, TENANT_COLUMN).tenant).toBe('org_id');
    expect(resolveJoinSecurityColumns('customers', config, TENANT_COLUMN)!.tenant).toBe('org_id');
    // country_codes: null still opts a shared/lookup table out entirely.
    const shared: SecurityColumnsConfig = { perTable: { country_codes: null } };
    expect(resolveJoinSecurityColumns('country_codes', shared, TENANT_COLUMN)).toBeUndefined();
  });
});

// ── Value-shape guards for like / scalar comparisons (finding 3.1) ────────────
//
// `like`, and the scalar comparison operators (eq/neq/lt/lte/gt/gte), gained the
// same fail-closed value-shape guard the `in` (array) and `between` (2-tuple)
// operators already had. A malformed value throws a clear per-operator message
// BEFORE any Knex call (so nothing is ever emitted); a legitimate value is
// untouched and still routed to the right Knex primitive.
describe('applyPredicates — value-shape guards (finding 3.1)', () => {
  /** Records the Knex call each predicate makes so we can assert valid values pass through. */
  function recordingQuery() {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const q: any = {};
    for (const method of [
      'where',
      'whereIn',
      'whereLike',
      'whereBetween',
      'whereNull',
      'whereNotNull',
    ]) {
      q[method] = (...args: unknown[]) => {
        calls.push({ method, args });
        return q;
      };
    }
    return { q, calls };
  }

  it('throws fail-closed for a non-string "like" value (array), before any Knex call', () => {
    const { q, calls } = recordingQuery();
    const predicate = {
      column: 'notes',
      operator: 'like',
      value: ['a', 'b'],
    } as unknown as FilterPredicate;
    expect(() => applyPredicates(q, [predicate], 'read')).toThrow(
      /"like" predicate on column "notes" requires a string value, but received an array/,
    );
    expect(calls).toHaveLength(0);
  });

  it('throws fail-closed for a non-string "like" value (number)', () => {
    const { q } = recordingQuery();
    const predicate = {
      column: 'notes',
      operator: 'like',
      value: 42,
    } as unknown as FilterPredicate;
    expect(() => applyPredicates(q, [predicate], 'read')).toThrow(
      /"like" predicate on column "notes" requires a string value, but received number/,
    );
  });

  it.each(['eq', 'neq', 'lt', 'lte', 'gt', 'gte'] as const)(
    'throws fail-closed for a non-scalar "%s" value (array), before any Knex call',
    (operator) => {
      const { q, calls } = recordingQuery();
      const predicate = { column: 'amount', operator, value: [1, 2] } as unknown as FilterPredicate;
      expect(() => applyPredicates(q, [predicate], 'read')).toThrow(
        new RegExp(
          `"${operator}" predicate on column "amount" requires a scalar value .* but received an array`,
        ),
      );
      expect(calls).toHaveLength(0);
    },
  );

  it('throws fail-closed for a non-scalar scalar-comparison value (object)', () => {
    const { q } = recordingQuery();
    const predicate = {
      column: 'amount',
      operator: 'gte',
      value: {},
    } as unknown as FilterPredicate;
    expect(() => applyPredicates(q, [predicate], 'read')).toThrow(
      /"gte" predicate on column "amount" requires a scalar value .* but received object/,
    );
  });

  it('throws fail-closed for an undefined scalar-comparison value', () => {
    const { q } = recordingQuery();
    const predicate = {
      column: 'amount',
      operator: 'eq',
      value: undefined,
    } as unknown as FilterPredicate;
    expect(() => applyPredicates(q, [predicate], 'read')).toThrow(
      /"eq" predicate on column "amount" requires a scalar value .* but received undefined/,
    );
  });

  // T2.2: `eq null` must route to `.whereNull` and `neq null` to `.whereNotNull`.
  // The 3-arg `.where(col, '=', null)` renders the NEVER-TRUE `col = NULL` (Knex's
  // null→whereNull conversion applies only to the 2-arg / `'is'` forms), so an
  // `eq null` filter that reached `.where(col,'=',null)` would silently return zero
  // rows instead of the rows whose column IS NULL.
  it('routes a null "eq" value to whereNull and a null "neq" value to whereNotNull (not .where)', () => {
    const { q, calls } = recordingQuery();
    const predicates = [
      { column: 'deleted_at', operator: 'eq', value: null },
      { column: 'deleted_at', operator: 'neq', value: null },
    ] as unknown as FilterPredicate[];
    expect(() => applyPredicates(q, predicates, 'read')).not.toThrow();
    // Never the 3-arg `.where(col, '=', null)` (which renders `col = NULL`).
    expect(calls.filter((c) => c.method === 'where')).toHaveLength(0);
    expect(calls).toContainEqual({ method: 'whereNull', args: ['deleted_at'] });
    expect(calls).toContainEqual({ method: 'whereNotNull', args: ['deleted_at'] });
  });

  // Real-Knex render pin (mirrors the outer-join / HAVING suites in
  // queryBuilder.test.ts): renders through the real `knex` pg dialect to prove the
  // emitted SQL is `IS NULL` / `IS NOT NULL`, and that the pre-fix 3-arg form would
  // have produced the never-true `= NULL`.
  it('renders IS NULL / IS NOT NULL through real Knex for null eq/neq', () => {
    const realDb = Knex({ client: 'pg' });
    const eqQuery = realDb('orders');
    applyPredicates(
      eqQuery,
      [{ column: 'deleted_at', operator: 'eq', value: null }] as any,
      'read',
    );
    expect(eqQuery.toString()).toBe('select * from "orders" where "deleted_at" is null');

    const neqQuery = realDb('orders');
    applyPredicates(
      neqQuery,
      [{ column: 'deleted_at', operator: 'neq', value: null }] as any,
      'read',
    );
    expect(neqQuery.toString()).toBe('select * from "orders" where "deleted_at" is not null');

    // Document the bug this fix closes: the 3-arg form renders the never-true
    // `= NULL` (which matches zero rows), NOT `IS NULL`.
    const buggy = realDb('orders').where('deleted_at', '=', null);
    expect(buggy.toString()).toBe('select * from "orders" where "deleted_at" = NULL');
  });

  it('accepts legitimate scalar / string / Date values and routes them to Knex', () => {
    const { q, calls } = recordingQuery();
    const validPredicates = [
      { column: 'region', operator: 'eq', value: 'west' },
      { column: 'amount', operator: 'gte', value: 100 },
      { column: 'active', operator: 'neq', value: true },
      { column: 'sale_date', operator: 'lt', value: new Date('2024-01-01') },
      { column: 'notes', operator: 'like', value: 'urgent%' },
    ] as unknown as FilterPredicate[];
    expect(() => applyPredicates(q, validPredicates, 'read')).not.toThrow();
    // Four `.where(...)` scalar comparisons + one `.whereLike(...)`.
    expect(calls.filter((c) => c.method === 'where')).toHaveLength(4);
    expect(calls.filter((c) => c.method === 'whereLike')).toHaveLength(1);
  });
});

// These tests would FAIL if the own-property gate were reverted: a polluted
// `Object.prototype[table]` entry is exactly what an inherited-member read would
// pick up, flipping scoping for that table on EVERY request. The gate reads own
// properties only, so it is immune. Cleanup runs synchronously in `afterEach`.
describe('resolvers ignore host-side Object.prototype pollution (finding 2.2 — reversion guard)', () => {
  const POLLUTED_TABLE = '__mui_x_polluted_test_table__';

  afterEach(() => {
    delete (Object.prototype as Record<string, unknown>)[POLLUTED_TABLE];
  });

  it('resolveJoinSecurityColumns ignores a whole-entry null on the prototype (would UNSCOPE if ungated)', () => {
    // An ungated `config.perTable[POLLUTED_TABLE]` would read this inherited `null`
    // and return `undefined` — a fully unscoped cross-tenant join.
    (Object.prototype as Record<string, unknown>)[POLLUTED_TABLE] = null;
    const config: SecurityColumnsConfig = { perTable: {} };
    expect(resolveJoinSecurityColumns(POLLUTED_TABLE, config, TENANT_COLUMN)).toEqual(
      DEFAULT_COLUMNS,
    );
  });

  it('resolvePrimarySecurityColumns ignores an inherited { tenant: null } (would DROP the tenant predicate if ungated)', () => {
    // An ungated read would pick up `{ tenant: null }` and resolve the tenant column
    // to `undefined`, silently dropping the tenant predicate for this table.
    (Object.prototype as Record<string, unknown>)[POLLUTED_TABLE] = { tenant: null };
    const config: SecurityColumnsConfig = { perTable: {} };
    expect(resolvePrimarySecurityColumns(POLLUTED_TABLE, config, TENANT_COLUMN)).toEqual(
      DEFAULT_COLUMNS,
    );
    expect(resolveJoinSecurityColumns(POLLUTED_TABLE, config, TENANT_COLUMN)).toEqual(
      DEFAULT_COLUMNS,
    );
  });
});
