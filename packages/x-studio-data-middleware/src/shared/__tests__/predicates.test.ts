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
  applySecurityPredicates,
  applySecurityPredicatesToJoinOn,
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

  it('honors the whole-table null opt-out for the PRIMARY table too (finding 2.3)', () => {
    // A host that declares a shared lookup table `country_codes: null` must get NO
    // security columns whether it is JOINED or the PRIMARY table of the query — the
    // joined resolver already returned undefined; the primary resolver used to ignore
    // the null and inherit the fallback tenant column, emitting a predicate on a
    // non-existent column and failing every such widget/mutation forever.
    const shared: SecurityColumnsConfig = { perTable: { country_codes: null } };
    const primary = resolvePrimarySecurityColumns('country_codes', shared, TENANT_COLUMN);
    expect(primary).toEqual({});
    expect(primary.tenant).toBeUndefined();
    expect(primary.region).toBeUndefined();
    expect(primary.department).toBeUndefined();
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
    // Four `.where(...)` scalar comparisons + the `like`, which also routes to the
    // 3-arg `.where(column, 'like', pattern)` rather than `.whereLike` (F1).
    expect(calls.filter((c) => c.method === 'where')).toHaveLength(5);
    expect(calls.filter((c) => c.method === 'whereLike')).toHaveLength(0);
    expect(calls).toContainEqual({ method: 'where', args: ['notes', 'like', 'urgent%'] });
  });
});

// ── Empty "in" list must FAIL CLOSED on the read path (H1) ──────────────────
//
// REGRESSION: the read path used to DROP an empty `in` predicate entirely
// ("autoRemove"), justified by a comment claiming the alternative was a
// malformed `WHERE x IN ()`. That premise is false — Knex's
// `whereIn(column, [])` short-circuits to `where(false)` → `1 = 0`. Dropping it
// failed OPEN: a widget filter resolving to an empty selection returned every
// tenant-scoped row of the table. The same file's `regionIds: []` security
// predicate had ALWAYS relied on the correct behavior, so the two paths held
// contradictory beliefs about the identical Knex call.
describe('applyPredicates — empty "in" list fails closed (H1)', () => {
  function recordingQuery() {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const q: any = {};
    for (const method of ['where', 'whereIn', 'whereBetween', 'whereLike']) {
      q[method] = (...args: unknown[]) => {
        calls.push({ method, args });
        return q;
      };
    }
    return { q, calls };
  }

  it('emits whereIn(column, []) on the read path instead of dropping the predicate', () => {
    const { q, calls } = recordingQuery();
    const predicate: FilterPredicate = { column: 'status', operator: 'in', value: [] };
    applyPredicates(q, [predicate], 'read');
    expect(calls).toEqual([{ method: 'whereIn', args: ['status', []] }]);
  });

  it('renders as the match-nothing "1 = 0" through real Knex', () => {
    const realDb = Knex({ client: 'pg' });
    const query = realDb('orders');
    applyPredicates(query, [{ column: 'status', operator: 'in', value: [] }], 'read');
    expect(query.toString()).toBe('select * from "orders" where 1 = 0');
  });

  it('still THROWS on the write path (an empty "in" must never widen a mutation)', () => {
    const { q, calls } = recordingQuery();
    const predicate: FilterPredicate = { column: 'status', operator: 'in', value: [] };
    expect(() => applyPredicates(q, [predicate], 'write')).toThrow(
      /"in" predicate with an empty value list/,
    );
    expect(calls).toHaveLength(0);
  });

  it('does not drop the OTHER predicates alongside an empty "in"', () => {
    // The old `break` exited the `in` case only, but the fail-open result was
    // that the whole widget query lost its narrowing predicate. Pin that an
    // empty `in` now composes with its siblings.
    const { q, calls } = recordingQuery();
    applyPredicates(
      q,
      [
        { column: 'status', operator: 'in', value: [] },
        { column: 'amount', operator: 'gt', value: 10 },
      ],
      'read',
    );
    expect(calls).toEqual([
      { method: 'whereIn', args: ['status', []] },
      { method: 'where', args: ['amount', '>', 10] },
    ]);
  });
});

// ── Element-shape guards for "in" / "between" (iter22 finding) ──────────────
//
// The array-SHAPE guards ("is an array", "has exactly 2 elements") already
// existed; this closes the gap where an individual ELEMENT of a legitimately
// array-shaped value could still be a non-primitive (object/array/null),
// reaching `whereIn`/`whereBetween` as a binding the driver rejects with a
// confusing error instead of a clean validation one. Not a security guard —
// values still stay parameterized either way.
describe('applyPredicates — element-shape guards for "in" / "between" (iter22 finding)', () => {
  function recordingQuery() {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const q: any = {};
    for (const method of ['where', 'whereIn', 'whereBetween']) {
      q[method] = (...args: unknown[]) => {
        calls.push({ method, args });
        return q;
      };
    }
    return { q, calls };
  }

  it('throws for an "in" list containing an object element', () => {
    const { q, calls } = recordingQuery();
    const predicate = {
      column: 'customer_id',
      operator: 'in',
      value: [1, { nested: true }, 3],
    } as unknown as FilterPredicate;
    expect(() => applyPredicates(q, [predicate], 'read')).toThrow(
      /"in" predicate on column "customer_id" requires every element to be a primitive .* element at index 1 is object/,
    );
    expect(calls).toHaveLength(0);
  });

  it('throws for an "in" list containing a nested array element', () => {
    const { q } = recordingQuery();
    const predicate = {
      column: 'customer_id',
      operator: 'in',
      value: [[1, 2]],
    } as unknown as FilterPredicate;
    expect(() => applyPredicates(q, [predicate], 'read')).toThrow(/element at index 0 is an array/);
  });

  it('throws for an "in" list containing a null element', () => {
    const { q } = recordingQuery();
    const predicate = {
      column: 'customer_id',
      operator: 'in',
      value: [1, null],
    } as unknown as FilterPredicate;
    expect(() => applyPredicates(q, [predicate], 'read')).toThrow(/element at index 1 is null/);
  });

  it('accepts an "in" list of legitimate primitives (string/number/boolean/Date)', () => {
    const { q, calls } = recordingQuery();
    const predicate = {
      column: 'customer_id',
      operator: 'in',
      value: [1, 'abc', true, new Date('2024-01-01')],
    } as unknown as FilterPredicate;
    expect(() => applyPredicates(q, [predicate], 'read')).not.toThrow();
    expect(calls).toContainEqual({ method: 'whereIn', args: ['customer_id', predicate.value] });
  });

  it('throws for a "between" pair with a non-primitive low bound', () => {
    const { q, calls } = recordingQuery();
    const predicate = {
      column: 'amount',
      operator: 'between',
      value: [{ nested: true }, 20],
    } as unknown as FilterPredicate;
    expect(() => applyPredicates(q, [predicate], 'read')).toThrow(
      /"between" predicate on column "amount" requires both bounds to be a primitive .* the low bound is object/,
    );
    expect(calls).toHaveLength(0);
  });

  it('throws for a "between" pair with a non-primitive high bound (array)', () => {
    const { q } = recordingQuery();
    const predicate = {
      column: 'amount',
      operator: 'between',
      value: [10, [20]],
    } as unknown as FilterPredicate;
    expect(() => applyPredicates(q, [predicate], 'read')).toThrow(/the high bound is an array/);
  });

  it('throws for a "between" pair with a null bound', () => {
    const { q } = recordingQuery();
    const predicate = {
      column: 'amount',
      operator: 'between',
      value: [null, 20],
    } as unknown as FilterPredicate;
    expect(() => applyPredicates(q, [predicate], 'read')).toThrow(/the low bound is null/);
  });

  it('accepts a "between" pair of legitimate primitives', () => {
    const { q, calls } = recordingQuery();
    const predicate = {
      column: 'amount',
      operator: 'between',
      value: [10, 20],
    } as unknown as FilterPredicate;
    expect(() => applyPredicates(q, [predicate], 'read')).not.toThrow();
    expect(calls).toContainEqual({ method: 'whereBetween', args: ['amount', [10, 20]] });
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

// ── `like` must render as a plain `LIKE ?` on every supported dialect (F1) ────
//
// `query.whereLike(column, value)` looks dialect-neutral, but Knex's MySQL query
// compiler hard-codes a trailing `COLLATE utf8_bin` on `whereLike` (see
// `knex/lib/dialects/mysql/query/mysql-querycompiler.js`). On MySQL 8 — whose
// server/table default charset is utf8mb4 — comparing a utf8mb4 column against an
// explicitly `utf8_bin`-collated operand raises
// `ER_CANT_AGGREGATE_2COLLATIONS` / `ER_COLLATION_CHARSET_MISMATCH`, and
// `sanitizeBoundaryError` then masks the driver message behind the generic
// "query for this widget could not be completed". The net effect was that `like`
// — one of the nine `SAFE_OPERATORS`, on BOTH the read path (`buildSecureQuery`)
// and the write path (`buildUpdateMutation`/`buildDeleteMutation`) — was silently
// dead deployment-wide on MySQL, with no diagnostic.
//
// The mock-DB suites cannot catch this: they record the METHOD NAME, not the SQL
// a dialect compiles it to. These assertions render through the real Knex query
// compilers instead, which is the only place the divergence is observable.
describe('applyPredicates — "like" renders as plain LIKE on every dialect (F1)', () => {
  it('does not emit a COLLATE clause on mysql2', () => {
    const realDb = Knex({ client: 'mysql2' });
    const query = realDb('orders');
    applyPredicates(query, [{ column: 'orders.name', operator: 'like', value: '%a%' }], 'read');
    expect(query.toString()).toBe("select * from `orders` where `orders`.`name` like '%a%'");
    expect(query.toString()).not.toMatch(/COLLATE/i);
  });

  it('renders the same shape on pg and better-sqlite3', () => {
    const pgDb = Knex({ client: 'pg' });
    const pgQuery = pgDb('orders');
    applyPredicates(pgQuery, [{ column: 'orders.name', operator: 'like', value: '%a%' }], 'read');
    // Case-SENSITIVE `like`, never pg's `ilike` — the operator's documented
    // semantics are the dialect's own `LIKE`, not a forced case-insensitive match.
    expect(pgQuery.toString()).toBe('select * from "orders" where "orders"."name" like \'%a%\'');

    const sqliteDb = Knex({ client: 'better-sqlite3', connection: { filename: ':memory:' } });
    const sqliteQuery = sqliteDb('orders');
    applyPredicates(
      sqliteQuery,
      [{ column: 'orders.name', operator: 'like', value: '%a%' }],
      'read',
    );
    expect(sqliteQuery.toString()).toBe("select * from `orders` where `orders`.`name` like '%a%'");
  });

  it('applies on the WRITE path too (update/delete `where` predicates)', () => {
    const realDb = Knex({ client: 'mysql2' });
    const updateQuery = realDb('orders');
    applyPredicates(
      updateQuery,
      [{ column: 'orders.name', operator: 'like', value: 'a%' }],
      'write',
    );
    expect(updateQuery.update({ status: 'x' }).toString()).not.toMatch(/COLLATE/i);
  });

  it('keeps the pattern parameterized (never inlined into the SQL text)', () => {
    const realDb = Knex({ client: 'mysql2' });
    const query = realDb('orders');
    applyPredicates(query, [{ column: 'orders.name', operator: 'like', value: "%o'--" }], 'read');
    const compiled = query.toSQL();
    expect(compiled.sql).toBe('select * from `orders` where `orders`.`name` like ?');
    expect(compiled.bindings).toEqual(["%o'--"]);
  });
});

// ── Security-predicate columns route through `qualifyAgainst` (F3) ────────────
//
// `emitSecurityPredicates` built its three column references with a bare
// `${table}.${securityColumns.X}` template — a second, divergent implementation
// of the qualification rule `qualifyAgainst` (`shared/columnValidation.ts`) owns.
// The two disagree on exactly one input: an ALREADY-QUALIFIED configured column
// name. `qualifyAgainst` leaves it alone; the template always prefixed, so a host
// configuring `securityColumns: { region: 'customers.region_id' }` emitted the
// three-segment `orders.customers.region_id` and every read AND write for that
// deployment failed with a driver error (which `sanitizeBoundaryError` then
// masked). Config-only and fail-closed — but ARCHITECTURE.md claims all three
// security-predicate dimensions go through the single helper, and now they do.
describe('emitSecurityPredicates — qualification goes through qualifyAgainst (F3)', () => {
  const CLAIMS = { tenantId: 'acme', regionIds: [5], department: 'sales' } as any;

  /** Records the column reference handed to each Knex primitive. */
  function recordingQuery() {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const q: any = {};
    for (const method of ['where', 'whereIn']) {
      q[method] = (...args: unknown[]) => {
        calls.push({ method, args });
        return q;
      };
    }
    return { q, calls };
  }

  it.each([
    ['tenant', { tenant: 'customers.tenant_id' }, 'customers.tenant_id'],
    ['region', { region: 'customers.region_id' }, 'customers.region_id'],
    ['department', { department: 'customers.department' }, 'customers.department'],
  ])(
    'leaves an already-qualified %s column untouched (never double-prefixes)',
    (_dimension, securityColumns, expected) => {
      const { q, calls } = recordingQuery();
      applySecurityPredicates(q, 'orders', CLAIMS, securityColumns, 'read');
      const columns = calls.map((c) => c.args[0]);
      expect(columns).toContain(expected);
      expect(columns.every((c) => String(c).split('.').length === 2)).toBe(true);
    },
  );

  it('still qualifies an UNQUALIFIED column with the owning table (normal path)', () => {
    const { q, calls } = recordingQuery();
    applySecurityPredicates(
      q,
      'orders',
      CLAIMS,
      { tenant: 'tenant_id', region: 'region_id', department: 'department' },
      'read',
    );
    expect(calls.map((c) => c.args[0])).toEqual([
      'orders.tenant_id',
      'orders.region_id',
      'orders.department',
    ]);
  });

  it('applies to the ON-clause emitter too (both emitters share one rule)', () => {
    const calls: Array<unknown[]> = [];
    const onBuilder: any = {
      andOnVal: (...args: unknown[]) => {
        calls.push(args);
        return onBuilder;
      },
      andOnIn: (...args: unknown[]) => {
        calls.push(args);
        return onBuilder;
      },
    };
    applySecurityPredicatesToJoinOn(
      onBuilder,
      'orders',
      CLAIMS,
      { tenant: 'customers.tenant_id', region: 'region_id' },
      'read',
    );
    expect(calls.map((c) => c[0])).toEqual(['customers.tenant_id', 'orders.region_id']);
  });

  it('renders a single, valid two-segment identifier through real Knex', () => {
    const realDb = Knex({ client: 'pg' });
    const query = realDb('orders');
    applySecurityPredicates(query, 'orders', CLAIMS, { tenant: 'customers.tenant_id' }, 'read');
    // Not `"orders"."customers"."tenant_id"`, which every driver rejects.
    expect(query.toString()).toBe(
      'select * from "orders" where "customers"."tenant_id" = \'acme\'',
    );
  });
});
