/**
 * Unit tests for `executeForTier`'s query-shape contract per routing tier.
 *
 * These assert the Knex call sequence directly (via a recording stand-in) rather
 * than through the in-memory mock DB — the mock ignores `groupBy` when there are
 * no aggregate specs, so it cannot distinguish "grouped" from "raw" rows for a
 * non-aggregation descriptor. The recording contract is what actually diverges
 * against a real Knex/SQL backend, so that is what is pinned here.
 */
import { describe, it, expect } from 'vitest';
import Knex from 'knex';
import { executeForTier, MAX_RESULT_ROWS } from '../execute';
import { validateQueryPlan } from '../../security/validateQueryPlan';
import type { JwtSecurityClaims, BatchWidgetDescriptor } from '../../security/types';

interface RecordedCall {
  method: string;
  args: unknown[];
}

/** A Knex stand-in that records every chained call. Not thenable, so awaiting the
 *  returned builder resolves to the builder itself (no query executes). */
function createRecordingDb() {
  const calls: RecordedCall[] = [];
  const builder: Record<string, (...args: unknown[]) => unknown> = {};
  const chainMethods = [
    'where',
    'whereIn',
    'whereLike',
    'whereBetween',
    'count',
    'select',
    'orderBy',
    'limit',
    'groupBy',
    'sum',
    'avg',
    'min',
    'max',
    'havingRaw',
  ];
  for (const method of chainMethods) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  }
  const joinCtx = {
    on(...args: unknown[]) {
      calls.push({ method: 'on', args });
      return joinCtx;
    },
  };
  for (const method of ['join', 'leftJoin', 'rightJoin']) {
    builder[method] = (table: unknown, cb: unknown) => {
      calls.push({ method, args: [table] });
      if (typeof cb === 'function') {
        (cb as (this: typeof joinCtx) => void).call(joinCtx);
      }
      return builder;
    };
  }
  const db = (table: string) => {
    calls.push({ method: 'from', args: [table] });
    return builder;
  };
  (db as any).raw = (_sql: string, bindings: unknown[]) => ({ kind: 'raw', bindings });
  return { db, calls };
}

const BASE_CLAIMS: JwtSecurityClaims = {
  tenantId: 'acme',
  userId: 'user-1',
  roleIds: ['viewer'],
};

const SINGLE_TENANT = { mode: 'single-tenant' } as const;

function descriptor(overrides: Partial<BatchWidgetDescriptor> = {}): BatchWidgetDescriptor {
  return { id: 'w1', table: 'sales', ...overrides };
}

describe('executeForTier — "db" tier', () => {
  // Regression (finding 2.1): a NON-aggregation descriptor can be routed to the
  // 'db' tier when its preflight COUNT(*) exceeds the server threshold. The db
  // branch used to GROUP BY every projected column (silently de-duplicating rows)
  // — or emit `SELECT *` with no columns — changing the row shape vs. the
  // client/server tiers. With no aggregations it must now fall back to a plain
  // select/orderBy/limit, matching those tiers.
  it('returns raw (non-grouped) rows for a non-aggregation descriptor', async () => {
    const { db, calls } = createRecordingDb();
    await executeForTier(
      db,
      BASE_CLAIMS,
      descriptor({ columns: ['category', 'amount'], limit: 500 }),
      'db',
      { tenancy: SINGLE_TENANT },
    );
    // Columns are projected…
    expect(calls.some((c) => c.method === 'select')).toBe(true);
    // …the limit is applied…
    expect(calls).toContainEqual({ method: 'limit', args: [500] });
    // …and crucially NO GROUP BY (would de-duplicate) and NO aggregate clauses.
    expect(calls.some((c) => c.method === 'groupBy')).toBe(false);
    expect(calls.some((c) => ['sum', 'avg', 'count', 'min', 'max'].includes(c.method))).toBe(false);
  });

  it('applies ORDER BY (not GROUP BY) for a non-aggregation descriptor', async () => {
    const { db, calls } = createRecordingDb();
    await executeForTier(
      db,
      BASE_CLAIMS,
      descriptor({ columns: ['category'], orderBy: [{ column: 'category', direction: 'asc' }] }),
      'db',
      { tenancy: SINGLE_TENANT },
    );
    expect(calls).toContainEqual({ method: 'orderBy', args: ['sales.category', 'asc'] });
    expect(calls.some((c) => c.method === 'groupBy')).toBe(false);
  });

  // Contrast: an aggregation descriptor still uses the GROUP BY / aggregate
  // push-down path — the fix must not disturb the intended db-tier behavior.
  it('still GROUP-BYs dimension columns for an aggregation descriptor', async () => {
    const { db, calls } = createRecordingDb();
    await executeForTier(
      db,
      BASE_CLAIMS,
      descriptor({
        columns: ['category'],
        aggregations: [{ column: 'amount', func: 'sum', alias: 'total' }],
      }),
      'db',
      { tenancy: SINGLE_TENANT },
    );
    expect(calls).toContainEqual({ method: 'groupBy', args: [['sales.category']] });
    expect(calls.some((c) => c.method === 'sum')).toBe(true);
  });

  // Regression (finding 2.2): a table-qualified pure measure (`SUM(orders.amount)
  // AS amount`) must be recognised as a measure and kept OUT of GROUP BY. The old
  // raw-string `alias === column` test never matched a dotted `agg.column`, so the
  // measure column landed in GROUP BY and the aggregate ran per (amount, region)
  // instead of per region — wrong data, silently.
  it('keeps a table-qualified pure measure out of GROUP BY (finding 2.2)', async () => {
    const { db, calls } = createRecordingDb();
    await executeForTier(
      db,
      BASE_CLAIMS,
      descriptor({
        table: 'orders',
        columns: ['orders.amount', 'customers.region'],
        aggregations: [{ column: 'orders.amount', func: 'sum', alias: 'amount' }],
        joins: [{ table: 'customers', type: 'left', on: [['orders.customer_id', 'customers.id']] }],
      }),
      'db',
      { tenancy: SINGLE_TENANT },
    );
    const groupByCalls = calls.filter((c) => c.method === 'groupBy');
    expect(groupByCalls).toHaveLength(1);
    // Only the dimension is grouped — the pure measure `orders.amount` is absent.
    expect(groupByCalls[0].args[0]).toEqual(['customers.region']);
    expect(calls.some((c) => c.method === 'sum')).toBe(true);
  });

  // Regression (finding 3.1): all three tier branches used to gate `.limit()` on
  // truthiness (`if (queryPlan.limit) {...}`), so `limit: 0` — a legitimate
  // "return zero rows" request — was silently treated as "no limit" and never
  // reached `query.limit()` at all. Fixed to `!== undefined` in every branch.
  it('applies .limit(0) for a non-aggregation descriptor routed to the db tier (no false-y skip)', async () => {
    const { db, calls } = createRecordingDb();
    await executeForTier(db, BASE_CLAIMS, descriptor({ columns: ['category'], limit: 0 }), 'db', {
      tenancy: SINGLE_TENANT,
    });
    expect(calls).toContainEqual({ method: 'limit', args: [0] });
  });

  it('applies .limit(0) for an aggregation descriptor on the db tier (no false-y skip)', async () => {
    const { db, calls } = createRecordingDb();
    await executeForTier(
      db,
      BASE_CLAIMS,
      descriptor({
        columns: ['category'],
        aggregations: [{ column: 'amount', func: 'sum', alias: 'total' }],
        limit: 0,
      }),
      'db',
      { tenancy: SINGLE_TENANT },
    );
    expect(calls).toContainEqual({ method: 'limit', args: [0] });
  });
});

describe('executeForTier — "client"/"server" tiers', () => {
  it('applies .limit(0) instead of treating it as "no limit" (finding 3.1)', async () => {
    const { db, calls } = createRecordingDb();
    await executeForTier(
      db,
      BASE_CLAIMS,
      descriptor({ columns: ['category'], limit: 0 }),
      'server',
      { tenancy: SINGLE_TENANT },
    );
    expect(calls).toContainEqual({ method: 'limit', args: [0] });
  });
});

// Regression (finding T2 — Tier 2): `limit` used to be fully optional and
// entirely client-controlled — an omitted `limit` meant NO `.limit()` call at
// all, so a widget query against a multi-million-row table could attempt an
// uncapped SELECT and OOM the server process. A hard server-side ceiling
// (`MAX_RESULT_ROWS`) must now always be applied, regardless of what `limit`
// the client requests (or omits).
describe('executeForTier — server-side result cap (finding T2)', () => {
  it('applies MAX_RESULT_ROWS as the limit when the client omits "limit" entirely (client/server tier)', async () => {
    const { db, calls } = createRecordingDb();
    await executeForTier(db, BASE_CLAIMS, descriptor({ columns: ['category'] }), 'server', {
      tenancy: SINGLE_TENANT,
    });
    expect(calls).toContainEqual({ method: 'limit', args: [MAX_RESULT_ROWS] });
  });

  it('caps a client-requested limit that exceeds MAX_RESULT_ROWS (client/server tier)', async () => {
    const { db, calls } = createRecordingDb();
    await executeForTier(
      db,
      BASE_CLAIMS,
      descriptor({ columns: ['category'], limit: MAX_RESULT_ROWS * 10 }),
      'client',
      { tenancy: SINGLE_TENANT },
    );
    expect(calls).toContainEqual({ method: 'limit', args: [MAX_RESULT_ROWS] });
  });

  it('leaves a client-requested limit below MAX_RESULT_ROWS unchanged (client/server tier)', async () => {
    const { db, calls } = createRecordingDb();
    await executeForTier(
      db,
      BASE_CLAIMS,
      descriptor({ columns: ['category'], limit: 25 }),
      'server',
      { tenancy: SINGLE_TENANT },
    );
    expect(calls).toContainEqual({ method: 'limit', args: [25] });
  });

  it('applies MAX_RESULT_ROWS for a non-aggregation descriptor with no limit routed to the db tier', async () => {
    const { db, calls } = createRecordingDb();
    await executeForTier(db, BASE_CLAIMS, descriptor({ columns: ['category'] }), 'db', {
      tenancy: SINGLE_TENANT,
    });
    expect(calls).toContainEqual({ method: 'limit', args: [MAX_RESULT_ROWS] });
  });

  it('caps an oversized limit for an aggregation descriptor on the db tier', async () => {
    const { db, calls } = createRecordingDb();
    await executeForTier(
      db,
      BASE_CLAIMS,
      descriptor({
        columns: ['category'],
        aggregations: [{ column: 'amount', func: 'sum', alias: 'total' }],
        limit: MAX_RESULT_ROWS + 1,
      }),
      'db',
      { tenancy: SINGLE_TENANT },
    );
    expect(calls).toContainEqual({ method: 'limit', args: [MAX_RESULT_ROWS] });
  });
});

// End-to-end regression for the Tier 1 SELECT * column-allowlist bypass on joined
// tables (finding 1.1). Exercises the REAL `validateQueryPlan` + `executeForTier`
// together against the recording query builder — the only faithful way to observe
// the emitted projection, since the in-memory mock never merges joined columns.
describe('executeForTier — joined-table SELECT * bypass (finding 1.1)', () => {
  // The exact config + descriptor from the review: "orders fully visible,
  // customers restricted to id". A no-columns widget that JOINs customers.
  const columnAllowlist = { orders: ['*'], customers: ['id'] };
  const joinedDescriptor = (): BatchWidgetDescriptor => ({
    id: 'w1',
    table: 'orders',
    joins: [
      {
        table: 'customers',
        type: 'left',
        on: [['orders.customer_id', 'customers.id']],
      },
    ],
    // no `columns`, no `aggregations`
  });

  it('emits an explicit orders.* projection (NOT a bare SELECT *) so joined columns are not leaked', async () => {
    const plan = validateQueryPlan(joinedDescriptor(), columnAllowlist);

    const { db, calls } = createRecordingDb();
    await executeForTier(
      db,
      BASE_CLAIMS,
      joinedDescriptor(),
      'client',
      { tenancy: SINGLE_TENANT },
      plan,
    );

    // Before the fix: plan.columns was [] → executeForTier skipped .select()
    // entirely → the query ran as a bare `SELECT * FROM orders LEFT JOIN customers`,
    // returning every `customers` column (ssn, credit_limit, …). Now `.select()`
    // IS called, and only with the primary-table-qualified wildcard.
    const selectCalls = calls.filter((c) => c.method === 'select');
    expect(selectCalls).toHaveLength(1);
    const projected = selectCalls[0].args[0] as unknown[];
    expect(projected).toEqual(['orders.*']);
    // The projection names ONLY the primary table — no `customers.*` and no
    // implicit `customers` column. Joined columns must now be requested explicitly
    // (which routes them back through the allowlist check).
    expect(projected.every((col) => col === 'orders.*')).toBe(true);
    expect(projected.some((col) => String(col).includes('customers'))).toBe(false);
  });

  it('a single-table ["*"] widget still gets its SELECT * opt-out (as table.*)', async () => {
    const plan = validateQueryPlan({ id: 'w1', table: 'orders' }, { orders: ['*'] });

    const { db, calls } = createRecordingDb();
    await executeForTier(
      db,
      BASE_CLAIMS,
      { id: 'w1', table: 'orders' },
      'client',
      { tenancy: SINGLE_TENANT },
      plan,
    );

    const selectCalls = calls.filter((c) => c.method === 'select');
    expect(selectCalls).toHaveLength(1);
    expect(selectCalls[0].args[0]).toEqual(['orders.*']);
  });
});

// Regression for finding 2.2: a renamed (expression-field) projection column
// (`col.outputAlias !== undefined`) used to emit its physical column into
// `db.raw('?? as ??', [col.physical, col.outputAlias])` WITHOUT qualifying
// `col.physical` with the primary table first — the last unqualified read-path
// column reference in the package, inconsistent with GROUP BY/ORDER BY/direct
// SELECT columns (all qualified via `qualify()`) in the very same query. Under a
// join where the physical column name also exists on the joined table, this is
// exactly the "ambiguous column" shape Postgres/MySQL reject.
describe('executeForTier — renamed projection column qualification under a join (finding 2.2)', () => {
  // The exact shape from the architecture review: an expression field
  // `revenue -> total` on `orders`, joined against `customers` (which also has
  // its own `total` column in a real schema — the ambiguity trigger).
  const joinedRenameDescriptor = (): BatchWidgetDescriptor => ({
    id: 'w1',
    table: 'orders',
    columns: ['revenue', 'status'],
    columnAliases: { revenue: 'total' },
    joins: [
      {
        table: 'customers',
        type: 'inner',
        on: [['orders.customer_id', 'customers.id']],
      },
    ],
  });

  it("qualifies the renamed column's physical source with the primary table (recording contract)", async () => {
    const { db, calls } = createRecordingDb();
    await executeForTier(db, BASE_CLAIMS, joinedRenameDescriptor(), 'client', {
      tenancy: SINGLE_TENANT,
    });

    const selectCalls = calls.filter((c) => c.method === 'select');
    expect(selectCalls).toHaveLength(1);
    const projected = selectCalls[0].args[0] as unknown[];

    // The renamed column ('revenue' -> physical 'total'): before the fix this
    // was `{ kind: 'raw', bindings: ['total', 'revenue'] }` — the bare physical
    // column, ambiguous under the join. After the fix the physical source is
    // qualified with the primary table before it reaches the `??` binding; the
    // output row KEY ('revenue') is unchanged.
    expect(projected[0]).toEqual({ kind: 'raw', bindings: ['orders.total', 'revenue'] });
    // The direct (non-renamed) column is qualified the same way it always was.
    expect(projected[1]).toBe('orders.status');
  });

  // Real-Knex render pin (this package's now-standard verification technique,
  // e.g. `queryBuilder.test.ts`'s "real Knex SQL rendering" sections): renders
  // the actual `?? as ??` raw fragment through Knex's `pg` dialect so a Knex
  // upgrade that changed how a dotted `??` identifier splits would fail this
  // test instead of silently reintroducing the ambiguous-column bug.
  describe('real Knex SQL rendering', () => {
    const realDb = Knex({ client: 'pg' });

    it('demonstrates the pre-fix shape (bare column) is what Postgres rejects as ambiguous', () => {
      // Sanity check for the bug this fix closes: an unqualified `total` in the
      // raw `?? as ??` fragment renders as a bare, unqualified identifier — under
      // a join where BOTH `orders` and `customers` carry a `total` column,
      // Postgres/MySQL reject this as `column reference "total" is ambiguous`.
      const buggyRaw = realDb.raw('?? as ??', ['total', 'revenue']);
      expect(buggyRaw.toString()).toBe('"total" as "revenue"');
    });

    it('renders the qualified, unambiguous fragment after the fix', () => {
      // `qualify(col.physical)` prefixes the primary table before the raw
      // binding — Knex splits the dotted `??` identifier into
      // `"orders"."total"`, unambiguous even when `customers` has its own
      // `total` column. The output alias (row key) is untouched.
      const fixedRaw = realDb.raw('?? as ??', ['orders.total', 'revenue']);
      expect(fixedRaw.toString()).toBe('"orders"."total" as "revenue"');
    });

    it('renders the full projected SELECT list for the joined-rename descriptor unambiguously', () => {
      // End-to-end sanity: the same two projected values `executeForTier` builds
      // for the joined-rename descriptor above, rendered together the way they
      // would appear in the final SELECT list.
      const renamedFragment = realDb.raw('?? as ??', ['orders.total', 'revenue']);
      const directColumn = 'orders.status';
      const rendered = `select ${renamedFragment.toString()}, "${directColumn.replace('.', '"."')}"`;
      expect(rendered).toBe('select "orders"."total" as "revenue", "orders"."status"');
    });
  });
});
