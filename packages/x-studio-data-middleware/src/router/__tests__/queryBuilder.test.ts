/**
 * Unit tests for `buildSecureQuery`.
 *
 * `handler.test.ts` exercises the query builder end-to-end through an in-memory
 * mock DB, but only covers the `eq`, `in`, `neq` and `gte` operators and never
 * touches joins or the unsupported-operator rejection path. These tests assert
 * the Knex call contract directly so every operator, the SAFE_OPERATORS guard,
 * the join types, and the "security predicates first" invariant are covered.
 */
import { describe, it, expect } from 'vitest';
import Knex from 'knex';
import { buildSecureQuery } from '../queryBuilder';
import type { JwtSecurityClaims, BatchWidgetDescriptor } from '../../security/types';

interface RecordedCall {
  method: string;
  args: unknown[];
}

/**
 * A Knex stand-in that records every chained call instead of touching a DB.
 * Returns itself from every method so `.where().whereIn()...` chains resolve.
 */
function createRecordingDb() {
  const calls: RecordedCall[] = [];
  const builder: Record<string, (...args: unknown[]) => unknown> = {};
  const chainMethods = [
    'where',
    'whereIn',
    'whereLike',
    'whereBetween',
    'orWhereNull',
    'count',
    'select',
    'orderBy',
    'limit',
    'groupBy',
    'havingRaw',
  ];
  for (const method of chainMethods) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  }
  // `.where(callback)` (the grouped form `applySecurityPredicatesOrNull` uses,
  // NESTED one level deep, to build `(A AND B) OR <col> IS NULL`, iter22
  // finding) is Knex's callback form too — run the callback against a context
  // whose `.andWhere()`/`.whereIn()`/`.orWhereNull()`/nested `.where()` all
  // record into the SAME `calls` array (mirroring the `join` callback handling
  // just below) and, like real Knex, always return the SAME context object
  // (`this`) rather than a fresh one — `.where(fn).orWhereNull(...)` chains the
  // `orWhereNull` onto the OUTER context, not the inner group, exactly as it
  // must for the grouping this fix depends on.
  function makeConditionCtx(): Record<string, (...args: unknown[]) => unknown> {
    const ctx: Record<string, (...args: unknown[]) => unknown> = {};
    ctx.andWhere = (...args: unknown[]) => {
      calls.push({ method: 'andWhere', args });
      return ctx;
    };
    ctx.whereIn = (...args: unknown[]) => {
      calls.push({ method: 'whereIn', args });
      return ctx;
    };
    ctx.orWhereNull = (...args: unknown[]) => {
      calls.push({ method: 'orWhereNull', args });
      return ctx;
    };
    ctx.where = (...args: unknown[]) => {
      if (typeof args[0] === 'function') {
        calls.push({ method: 'where(group)', args: [] });
        (args[0] as (this: typeof ctx) => void).call(makeConditionCtx());
      } else {
        calls.push({ method: 'where', args });
      }
      return ctx;
    };
    return ctx;
  }
  builder.where = (...args: unknown[]) => {
    if (typeof args[0] === 'function') {
      calls.push({ method: 'where(group)', args: [] });
      (args[0] as (this: ReturnType<typeof makeConditionCtx>) => void).call(makeConditionCtx());
      return builder;
    }
    calls.push({ method: 'where', args });
    return builder;
  };
  // Join methods use Knex's callback form: `join(table, function () { this.on(...) })`.
  // Record the join once (with only the table), then run the callback against a
  // context whose `.on()` records each condition — so a composite-key join is a
  // single join with multiple `on` calls (not one join per pair). `andOnVal`/
  // `andOnIn` are the ON-clause analogues of `where`/`whereIn` (finding 2.3) that
  // `applySecurityPredicatesToJoinOn` uses to scope an outer join's nullable side
  // WITHOUT dropping unmatched rows the way a WHERE predicate would.
  const joinCtx = {
    on(...args: unknown[]) {
      calls.push({ method: 'on', args });
      return joinCtx;
    },
    andOnVal(...args: unknown[]) {
      calls.push({ method: 'andOnVal', args });
      return joinCtx;
    },
    andOnIn(...args: unknown[]) {
      calls.push({ method: 'andOnIn', args });
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
  return { db, calls };
}

const BASE_CLAIMS: JwtSecurityClaims = {
  tenantId: 'acme',
  userId: 'user-1',
  roleIds: ['viewer'],
};

// Tenancy is now a required, explicit decision at every enforcement site. Tests
// that configure a tenant column use MULTI_TENANT; tests that configure none
// declare SINGLE_TENANT explicitly (the same unscoped behavior, now stated rather
// than silently implied by omission).
const MULTI_TENANT = { mode: 'multi-tenant', tenantColumn: 'tenant_id' } as const;
const SINGLE_TENANT = { mode: 'single-tenant' } as const;

function descriptor(overrides: Partial<BatchWidgetDescriptor> = {}): BatchWidgetDescriptor {
  return { id: 'w1', table: 'sales', ...overrides };
}

// Returns the index of the first call matching `method` and (optionally) args.
function indexOf(calls: RecordedCall[], method: string, predicate?: (c: RecordedCall) => boolean) {
  return calls.findIndex((c) => c.method === method && (predicate ? predicate(c) : true));
}

describe('buildSecureQuery', () => {
  describe('security predicates', () => {
    it('applies a qualified tenant predicate when tenantColumn is set', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(db, BASE_CLAIMS, descriptor(), { tenancy: MULTI_TENANT });
      expect(calls).toContainEqual({ method: 'where', args: ['sales.tenant_id', '=', 'acme'] });
    });

    it('does not apply a tenant predicate in single-tenant mode', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(db, BASE_CLAIMS, descriptor(), { tenancy: SINGLE_TENANT });
      expect(calls.some((c) => c.method === 'where')).toBe(false);
    });

    it('applies a region whereIn predicate when regionIds are present', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(db, { ...BASE_CLAIMS, regionIds: [1, 2] }, descriptor(), {
        tenancy: SINGLE_TENANT,
      });
      // Both the numeric claim and its string form are included (finding 2.1) so
      // this predicate matches a TEXT-typed region column the same way
      // `validateSecurityColumnValues` already tolerates one on the write path —
      // see `shared/predicates.ts`'s `applySecurityPredicates` doc comment.
      expect(calls).toContainEqual({
        method: 'whereIn',
        args: ['sales.region_id', [1, '1', 2, '2']],
      });
    });

    it('does not apply a region predicate when regionIds is undefined (no region scoping)', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(db, { ...BASE_CLAIMS, regionIds: undefined }, descriptor(), {
        tenancy: SINGLE_TENANT,
      });
      expect(calls.some((c) => c.method === 'whereIn')).toBe(false);
    });

    it('applies a match-nothing region predicate when regionIds is an empty array (fail-closed)', () => {
      // Regression: `regionIds: []` means "authorized for zero regions" — it must
      // NOT be conflated with `undefined` (no region scoping). On reads we emit
      // `whereIn(col, [])`, which Knex renders as `1 = 0` (matches zero rows),
      // instead of dropping the predicate and returning the full tenant table.
      const { db, calls } = createRecordingDb();
      buildSecureQuery(db, { ...BASE_CLAIMS, regionIds: [] }, descriptor(), {
        tenancy: SINGLE_TENANT,
      });
      expect(calls).toContainEqual({ method: 'whereIn', args: ['sales.region_id', []] });
    });

    it('applies a department predicate when department is present', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(db, { ...BASE_CLAIMS, department: 'sales' }, descriptor(), {
        tenancy: SINGLE_TENANT,
      });
      expect(calls).toContainEqual({ method: 'where', args: ['sales.department', '=', 'sales'] });
    });

    it('applies security predicates BEFORE user filters (cannot be overridden)', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        { ...BASE_CLAIMS, department: 'sales' },
        descriptor({
          filters: [{ column: 'status', operator: 'eq', value: 'active' }],
        }),
        { tenancy: MULTI_TENANT },
      );

      const securityIdx = indexOf(calls, 'where', (c) => c.args[0] === 'sales.tenant_id');
      const userFilterIdx = indexOf(calls, 'where', (c) => c.args[0] === 'sales.status');
      expect(securityIdx).toBeGreaterThanOrEqual(0);
      expect(userFilterIdx).toBeGreaterThanOrEqual(0);
      expect(securityIdx).toBeLessThan(userFilterIdx);
    });
  });

  describe('filter operators', () => {
    it.each([
      ['eq', '=', 'active'],
      ['neq', '!=', 'archived'],
      ['lt', '<', 100],
      ['lte', '<=', 100],
      ['gt', '>', 0],
      ['gte', '>=', 0],
    ] as const)('maps "%s" to where(col, "%s", value)', (operator, sqlOp, value) => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({ filters: [{ column: 'amount', operator, value }] }),
        { tenancy: SINGLE_TENANT },
      );
      // Table-qualified with the primary table (finding 2.1) — see the
      // "read-path filter column qualification" describe block below.
      expect(calls).toContainEqual({ method: 'where', args: ['sales.amount', sqlOp, value] });
    });

    it('maps "in" to whereIn', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          filters: [{ column: 'product', operator: 'in', value: ['a', 'b'] }],
        }),
        { tenancy: SINGLE_TENANT },
      );
      expect(calls).toContainEqual({ method: 'whereIn', args: ['sales.product', ['a', 'b']] });
    });

    it('skips an empty "in" list (autoRemove) rather than emitting WHERE x IN ()', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          filters: [{ column: 'product', operator: 'in', value: [] }],
        }),
        { tenancy: SINGLE_TENANT },
      );
      expect(calls.some((c) => c.method === 'whereIn')).toBe(false);
    });

    it('maps "like" to whereLike', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          filters: [{ column: 'name', operator: 'like', value: 'Ac%' }],
        }),
        { tenancy: SINGLE_TENANT },
      );
      expect(calls).toContainEqual({ method: 'whereLike', args: ['sales.name', 'Ac%'] });
    });

    it('maps "between" to whereBetween with a [lo, hi] tuple', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          filters: [{ column: 'amount', operator: 'between', value: [10, 20] }],
        }),
        { tenancy: SINGLE_TENANT },
      );
      expect(calls).toContainEqual({ method: 'whereBetween', args: ['sales.amount', [10, 20]] });
    });

    it('throws on an unsupported operator (allowlist guard)', () => {
      const { db } = createRecordingDb();
      expect(() =>
        buildSecureQuery(
          db,
          BASE_CLAIMS,
          descriptor({
            // Cast: deliberately exercise the runtime guard with a forbidden operator.
            filters: [{ column: 'amount', operator: 'sql' as any, value: '1; DROP TABLE sales' }],
          }),
          { tenancy: SINGLE_TENANT },
        ),
      ).toThrow(/Unsupported filter operator/);
    });

    it('applies multiple filter predicates in order', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          filters: [
            { column: 'status', operator: 'eq', value: 'active' },
            { column: 'amount', operator: 'gt', value: 0 },
          ],
        }),
        { tenancy: SINGLE_TENANT },
      );
      const whereCalls = calls.filter((c) => c.method === 'where');
      expect(whereCalls).toEqual([
        { method: 'where', args: ['sales.status', '=', 'active'] },
        { method: 'where', args: ['sales.amount', '>', 0] },
      ]);
    });
  });

  describe('columnAliases resolution (allowlist-bypass regression)', () => {
    // Regression for the column-allowlist bypass: `validateDescriptorColumns`
    // resolves `columnAliases` when checking a filter column against the
    // allowlist, so execution MUST filter on the SAME resolved physical column.
    // Before the fix, `buildSecureQuery` bound the raw logical column, letting a
    // client alias a non-allowlisted column (`ssn`) onto an allowlisted one
    // (`amount`), pass validation, yet run `WHERE ssn LIKE …` — a comparison
    // oracle against any column in the table.
    it('filters on the physical (allowlisted) column, not the raw logical alias', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          columnAliases: { ssn: 'amount' },
          filters: [{ column: 'ssn', operator: 'like', value: '123%' }],
        }),
        { tenancy: SINGLE_TENANT },
      );
      // The WHERE clause targets the validated physical column `amount`,
      // table-qualified with the primary table (finding 2.1)…
      expect(calls).toContainEqual({ method: 'whereLike', args: ['sales.amount', '123%'] });
      // …and never the raw, non-allowlisted logical name `ssn`.
      expect(calls.some((c) => c.method === 'whereLike' && c.args[0] === 'ssn')).toBe(false);
    });

    it('resolves aliases for every operator, including qualified physical columns', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          columnAliases: { region: 'customers.region_id' },
          filters: [{ column: 'region', operator: 'eq', value: 'us' }],
        }),
        { tenancy: SINGLE_TENANT },
      );
      expect(calls).toContainEqual({
        method: 'where',
        args: ['customers.region_id', '=', 'us'],
      });
      expect(calls.some((c) => c.method === 'where' && c.args[0] === 'region')).toBe(false);
    });

    it('leaves a filter column unchanged (other than table-qualification) when it has no alias entry', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          columnAliases: { ssn: 'amount' },
          filters: [{ column: 'status', operator: 'eq', value: 'active' }],
        }),
        { tenancy: SINGLE_TENANT },
      );
      expect(calls).toContainEqual({ method: 'where', args: ['sales.status', '=', 'active'] });
    });

    // Regression for finding 2.4: an EMPTY `columnAliases` object still inherits
    // from `Object.prototype`. Before the own-property gate, a filter naming an
    // inherited member (`constructor`, `toString`, …) resolved `resolveAlias` to
    // the inherited FUNCTION rather than `undefined`, and Knex's `.where(fn, ...)`
    // silently treats a function first-argument as a grouped-where callback,
    // dropping the user's filter instead of filtering on the literal column name.
    it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__'])(
      'filters on the literal column name "%s" (not an inherited Object.prototype member) with an empty columnAliases map',
      (column) => {
        const { db, calls } = createRecordingDb();
        buildSecureQuery(
          db,
          BASE_CLAIMS,
          descriptor({
            columnAliases: {},
            filters: [{ column, operator: 'eq', value: 'x' }],
          }),
          { tenancy: SINGLE_TENANT },
        );
        // The literal string column name (table-qualified per finding 2.1) reaches
        // `.where(...)` as the first arg — never a function (which would signal
        // Knex's grouped-where form instead).
        const whereCall = calls.find((c) => c.method === 'where' && c.args[2] === 'x');
        expect(whereCall).toBeDefined();
        expect(whereCall!.args[0]).toBe(`sales.${column}`);
        expect(typeof whereCall!.args[0]).toBe('string');
      },
    );
  });

  describe('joins', () => {
    it('uses leftJoin for type "left" with a single join call + on() condition', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          joins: [
            { table: 'customers', type: 'left', on: [['sales.customer_id', 'customers.id']] },
          ],
        }),
        { tenancy: SINGLE_TENANT },
      );
      expect(calls).toContainEqual({ method: 'leftJoin', args: ['customers'] });
      expect(calls).toContainEqual({
        method: 'on',
        args: ['sales.customer_id', '=', 'customers.id'],
      });
    });

    it('uses rightJoin for type "right"', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          joins: [
            { table: 'customers', type: 'right', on: [['sales.customer_id', 'customers.id']] },
          ],
        }),
        { tenancy: SINGLE_TENANT },
      );
      expect(calls).toContainEqual({ method: 'rightJoin', args: ['customers'] });
      expect(calls).toContainEqual({
        method: 'on',
        args: ['sales.customer_id', '=', 'customers.id'],
      });
    });

    it('uses inner join for type "inner" and when type is omitted', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          joins: [
            { table: 'customers', type: 'inner', on: [['sales.customer_id', 'customers.id']] },
            { table: 'regions', on: [['sales.region_id', 'regions.id']] },
          ],
        }),
        { tenancy: SINGLE_TENANT },
      );
      const joinCalls = calls.filter((c) => c.method === 'join');
      expect(joinCalls).toEqual([
        { method: 'join', args: ['customers'] },
        { method: 'join', args: ['regions'] },
      ]);
    });

    it('joins a composite-key table exactly once, with one on() per pair', () => {
      // Regression: the previous per-pair loop called join() once per pair,
      // joining the same table twice → "table name not unique" on real DBs.
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          joins: [
            {
              table: 'customers',
              on: [
                ['sales.a', 'customers.a'],
                ['sales.b', 'customers.b'],
              ],
            },
          ],
        }),
        { tenancy: SINGLE_TENANT },
      );
      // Exactly one join call for the table…
      expect(calls.filter((c) => c.method === 'join')).toEqual([
        { method: 'join', args: ['customers'] },
      ]);
      // …and one on() condition per pair.
      expect(calls.filter((c) => c.method === 'on')).toEqual([
        { method: 'on', args: ['sales.a', '=', 'customers.a'] },
        { method: 'on', args: ['sales.b', '=', 'customers.b'] },
      ]);
    });

    it('applies joins BEFORE security predicates', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          joins: [
            { table: 'customers', type: 'left', on: [['sales.customer_id', 'customers.id']] },
          ],
        }),
        { tenancy: MULTI_TENANT },
      );
      const joinIdx = indexOf(calls, 'leftJoin');
      const securityIdx = indexOf(calls, 'where', (c) => c.args[0] === 'sales.tenant_id');
      expect(joinIdx).toBeLessThan(securityIdx);
    });
  });

  describe('join on-pair column qualification (finding 2.1, iter9)', () => {
    // Regression: every OTHER read-path column reference (SELECT / GROUP BY /
    // ORDER BY / aggregations in `execute.ts`, all three security-predicate
    // dimensions, and user filter columns — the two prior rounds' fixes) is
    // table-qualified to avoid "ambiguous column" errors under joins. The join
    // `on` pair was the sole remaining exception: `JoinDescriptor.on` deliberately
    // accepts unqualified columns (`validateDescriptorColumns` checks the left
    // side against the primary table and the right side against `join.table`),
    // so `buildSecureQuery` emitted `this.on(left, '=', right)` verbatim. An
    // unqualified `on` column shared by both joined tables (`region_id`, `id`,
    // `tenant_id`, …) renders an ambiguous identifier Postgres/MySQL reject
    // outright. `buildSecureQuery` now qualifies an unqualified `on` column —
    // left with the PRIMARY table, right with `join.table` — before handing it
    // to `.on()`.
    it('qualifies both sides of an unqualified on pair with the primary/joined table', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          // `region_id` exists on both `sales` and `customers` — the classic
          // ambiguous-column scenario, this time on the JOIN's `on` pair.
          joins: [{ table: 'customers', on: [['region_id', 'region_id']] }],
        }),
        { tenancy: SINGLE_TENANT },
      );
      expect(calls).toContainEqual({
        method: 'on',
        args: ['sales.region_id', '=', 'customers.region_id'],
      });
      expect(calls.some((c) => c.method === 'on' && c.args[0] === 'region_id')).toBe(false);
      expect(calls.some((c) => c.method === 'on' && c.args[2] === 'region_id')).toBe(false);
    });

    it('leaves an already client-qualified on pair (containing a dot) untouched', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          joins: [{ table: 'customers', on: [['sales.customer_id', 'customers.id']] }],
        }),
        { tenancy: SINGLE_TENANT },
      );
      // The client explicitly named both tables — respected as-is, not
      // re-qualified.
      expect(calls).toContainEqual({
        method: 'on',
        args: ['sales.customer_id', '=', 'customers.id'],
      });
    });

    it('qualifies a mixed pair (one side unqualified) independently per side', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          joins: [{ table: 'customers', on: [['sales.customer_id', 'id']] }],
        }),
        { tenancy: SINGLE_TENANT },
      );
      expect(calls).toContainEqual({
        method: 'on',
        args: ['sales.customer_id', '=', 'customers.id'],
      });
    });

    // Real-Knex render pin, mirroring the filter-qualification sub-suite above:
    // the mock `createRecordingDb` only asserts the Knex CALL contract, not the
    // actual rendered SQL. This section renders through the real `knex` package
    // to pin the literal SQL, so a Knex upgrade that changed how an
    // unqualified/qualified ON column renders would fail this test instead of
    // silently reintroducing an ambiguous-column error.
    describe('real Knex SQL rendering', () => {
      const realDb = Knex({ client: 'pg' });

      it('renders an unambiguous, fully-qualified JOIN ON clause for a shared unqualified column name', () => {
        const query = buildSecureQuery(
          realDb,
          BASE_CLAIMS,
          descriptor({
            joins: [{ table: 'customers', on: [['region_id', 'region_id']] }],
          }),
          { tenancy: SINGLE_TENANT },
        );
        expect(query.toString()).toBe(
          'select * from "sales" inner join "customers" on "sales"."region_id" = "customers"."region_id"',
        );
      });

      it('demonstrates the pre-fix shape (bare on columns) is what Postgres rejects as ambiguous', () => {
        // Sanity check for the bug this fix closes: bare, unqualified `on`
        // columns sharing a name on both joined tables is exactly the SQL
        // Postgres/MySQL reject with "column reference \"region_id\" is
        // ambiguous". This test renders that shape directly via Knex (bypassing
        // `buildSecureQuery`, which no longer produces it) purely to
        // document/pin what the bug looked like.
        const buggyQuery = realDb('sales').join('customers', function joinOn(this: any) {
          this.on('region_id', '=', 'region_id');
        });
        expect(buggyQuery.toString()).toBe(
          'select * from "sales" inner join "customers" on "region_id" = "region_id"',
        );
      });
    });
  });

  describe('outer-join security predicate placement (finding 2.3 — no INNER-join degradation)', () => {
    // Regression: a joined-table (or, for RIGHT joins, primary-table) security
    // predicate placed in WHERE silently drops every NULL-extended row an outer
    // join was meant to preserve, turning a LEFT/RIGHT join into an INNER join.
    // The fix moves the NULLABLE side's predicate into the JOIN's ON clause via
    // `andOnVal`/`andOnIn` instead.

    it('LEFT JOIN: scopes the joined (nullable) table in ON, not WHERE', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          joins: [
            { table: 'customers', type: 'left', on: [['sales.customer_id', 'customers.id']] },
          ],
        }),
        { tenancy: MULTI_TENANT },
      );
      // The joined table's tenant predicate is bound to the ON clause…
      expect(calls).toContainEqual({
        method: 'andOnVal',
        args: ['customers.tenant_id', '=', 'acme'],
      });
      // …and is NEVER emitted as a WHERE predicate against the joined table (which
      // would drop unmatched/NULL-extended rows and silently degrade to INNER JOIN).
      expect(
        calls.some((c) => c.method === 'where' && String(c.args[0]).startsWith('customers.')),
      ).toBe(false);
      // The PRIMARY table (non-nullable side of a LEFT join) is still WHERE-scoped.
      expect(calls).toContainEqual({ method: 'where', args: ['sales.tenant_id', '=', 'acme'] });
    });

    it('RIGHT JOIN: scopes the primary (nullable) table in ON, not WHERE', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          joins: [
            { table: 'customers', type: 'right', on: [['sales.customer_id', 'customers.id']] },
          ],
        }),
        { tenancy: MULTI_TENANT },
      );
      // The PRIMARY table's tenant predicate is bound to the ON clause (it is the
      // nullable side of a RIGHT join)…
      expect(calls).toContainEqual({
        method: 'andOnVal',
        args: ['sales.tenant_id', '=', 'acme'],
      });
      // …and is NEVER emitted as a WHERE predicate against the primary table.
      expect(calls.some((c) => c.method === 'where' && c.args[0] === 'sales.tenant_id')).toBe(
        false,
      );
      // The JOINED table (non-nullable side of a RIGHT join) is still WHERE-scoped.
      expect(calls).toContainEqual({ method: 'where', args: ['customers.tenant_id', '=', 'acme'] });
    });

    it('INNER JOIN (default): both sides stay WHERE-scoped (equivalent to ON placement)', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          joins: [{ table: 'customers', on: [['sales.customer_id', 'customers.id']] }],
        }),
        { tenancy: MULTI_TENANT },
      );
      expect(calls).toContainEqual({ method: 'where', args: ['sales.tenant_id', '=', 'acme'] });
      expect(calls).toContainEqual({ method: 'where', args: ['customers.tenant_id', '=', 'acme'] });
      expect(calls.some((c) => c.method === 'andOnVal')).toBe(false);
    });

    it('LEFT JOIN: region/department predicates on the joined table also move to ON', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        { ...BASE_CLAIMS, regionIds: [1, 2], department: 'ops' },
        descriptor({
          joins: [
            { table: 'customers', type: 'left', on: [['sales.customer_id', 'customers.id']] },
          ],
        }),
        { tenancy: MULTI_TENANT },
      );
      expect(calls).toContainEqual({
        method: 'andOnIn',
        args: ['customers.region_id', [1, '1', 2, '2']],
      });
      expect(calls).toContainEqual({
        method: 'andOnVal',
        args: ['customers.department', '=', 'ops'],
      });
      expect(
        calls.some((c) => c.method === 'whereIn' && String(c.args[0]).startsWith('customers.')),
      ).toBe(false);
    });
  });

  describe('multiple right joins (iter22 finding)', () => {
    // Chained joins right-associate: `(A RIGHT JOIN B) RIGHT JOIN C` computes
    // `A RIGHT JOIN B` first, then RIGHT JOINs the WHOLE result to C. A `C` row
    // with no match against the accumulated `(A, B)` side null-extends B too —
    // not just the primary table A — even though B is the guaranteed/preserved
    // side of ITS OWN join. A bare `WHERE customers.tenant_id = ...` (the pre-fix
    // behavior) would then silently drop that legitimately-preserved `orders`
    // row. This section pins that an EARLIER right join (customers) gets an
    // `OR <join-key> IS NULL` relaxed WHERE group instead of a bare WHERE, while
    // the LAST right join (orders) keeps the strict, unconditional WHERE
    // predicate it has always had — nothing joins after it to null it back out.
    function twoRightJoinsDescriptor() {
      return descriptor({
        joins: [
          { table: 'customers', type: 'right', on: [['sales.customer_id', 'customers.id']] },
          { table: 'orders', type: 'right', on: [['customers.id', 'orders.customer_id']] },
        ],
      });
    }

    it('the EARLIER right join (customers) gets an OR <join-key> IS NULL relaxed WHERE group, not a bare WHERE', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(db, BASE_CLAIMS, twoRightJoinsDescriptor(), { tenancy: MULTI_TENANT });
      // Never a bare `.where('customers.tenant_id', ...)` — that is exactly the
      // pre-fix shape that drops legitimately-preserved `orders` rows.
      expect(calls.some((c) => c.method === 'where' && c.args[0] === 'customers.tenant_id')).toBe(
        false,
      );
      // Instead, the predicate is inside a grouped `.where(fn)`...
      expect(calls).toContainEqual({
        method: 'andWhere',
        args: ['customers.tenant_id', '=', 'acme'],
      });
      // ...followed by an `orWhereNull` escape hatch keyed on customers' own join key,
      // so a customers row that is legitimately null-extended by the SECOND right
      // join (orders) is not wrongly excluded.
      expect(calls).toContainEqual({ method: 'orWhereNull', args: ['customers.id'] });
    });

    it('the LAST right join (orders) keeps the strict, unconditional WHERE predicate', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(db, BASE_CLAIMS, twoRightJoinsDescriptor(), { tenancy: MULTI_TENANT });
      expect(calls).toContainEqual({ method: 'where', args: ['orders.tenant_id', '=', 'acme'] });
      // The last right join's table never gets the OR-null relaxation — nothing
      // joins after it that could null-extend it back out.
      expect(calls.some((c) => c.method === 'orWhereNull' && c.args[0] === 'orders.id')).toBe(
        false,
      );
    });

    // BUG FIX (data-corruption finding): this test used to assert that the
    // primary table's ("sales") security predicate was injected into EVERY
    // right join's ON clause (`toHaveLength(2)`) — that was the BUGGY behavior,
    // pinned here by mistake as if it were intended. It is only correct for the
    // FIRST right join: by the time the query reaches the SECOND right join
    // (orders), "sales" is already fully resolved by the first join (either a
    // tenant-matching row, or legitimately NULL). Re-testing "sales.tenant_id"
    // again in the second join's ON clause evaluates to unknown/false whenever
    // "sales" is legitimately NULL, which makes THAT join treat an otherwise
    // genuine "customers"-"orders" match as "no match" and NULL-extends the
    // whole accumulated left side — wiping out "customers"'s already-resolved,
    // legitimate columns too, not just "sales"'s. That silently corrupts the
    // result. The corrected behavior below applies the primary table's
    // predicate exactly ONCE, to the FIRST right join only.
    it(
      'applies the PRIMARY table predicate ONLY to the FIRST right join ON clause, ' +
        'never repeated on a later right join, never WHERE',
      () => {
        const { db, calls } = createRecordingDb();
        buildSecureQuery(db, BASE_CLAIMS, twoRightJoinsDescriptor(), { tenancy: MULTI_TENANT });
        expect(calls.some((c) => c.method === 'where' && c.args[0] === 'sales.tenant_id')).toBe(
          false,
        );
        // Exactly once — NOT once per right join (the old, buggy assertion).
        expect(
          calls.filter((c) => c.method === 'andOnVal' && c.args[0] === 'sales.tenant_id'),
        ).toHaveLength(1);
        // ...and it's attached to the FIRST right join (customers): the call must
        // occur before the SECOND right join (orders) even starts.
        const ordersJoinIndex = calls.findIndex(
          (c) => c.method === 'rightJoin' && c.args[0] === 'orders',
        );
        const salesPredicateIndex = calls.findIndex(
          (c) => c.method === 'andOnVal' && c.args[0] === 'sales.tenant_id',
        );
        expect(salesPredicateIndex).toBeGreaterThanOrEqual(0);
        expect(salesPredicateIndex).toBeLessThan(ordersJoinIndex);
      },
    );

    describe('real Knex SQL rendering', () => {
      const realDb = Knex({ client: 'pg' });

      it('renders the OR-null-relaxed WHERE group for the earlier right join, preserving orders rows null-extended on customers', () => {
        const query = buildSecureQuery(realDb, BASE_CLAIMS, twoRightJoinsDescriptor(), {
          tenancy: MULTI_TENANT,
        });
        // The second right join's ON clause no longer repeats "sales.tenant_id"
        // (bug fix) — this string would have included
        // `and "sales"."tenant_id" = 'acme'` a second time, after
        // `"customers"."id" = "orders"."customer_id"`, under the pre-fix behavior.
        expect(query.toString()).toBe(
          'select * from "sales" ' +
            'right join "customers" on "sales"."customer_id" = "customers"."id" and "sales"."tenant_id" = \'acme\' ' +
            'right join "orders" on "customers"."id" = "orders"."customer_id" ' +
            'where (("customers"."tenant_id" = \'acme\') or "customers"."id" is null) and "orders"."tenant_id" = \'acme\'',
        );
      });
    });

    describe('joinNullIndicatorColumn convention verification (untrusted-convention finding)', () => {
      it('throws when an earlier right join\'s "on" pair right-hand column is qualified with a table other than its own', () => {
        // Malformed descriptor: the "customers" join's `on` pair right-hand side
        // is qualified with "sales" (the PRIMARY table) instead of "customers"
        // (its own table) — violating the documented `JoinDescriptor.on`
        // convention. "customers" sits BEFORE the last right join (index 0 <
        // lastRightJoinIndex 1), so `buildSecureQuery` must pick a null-indicator
        // column for it. Trusting the malformed pair without verification would
        // hand `applySecurityPredicatesOrNull` a column that does not belong to
        // "customers" at all, letting the `OR ... IS NULL` escape hatch key off
        // the wrong table's nullability — this now fails closed instead.
        const { db } = createRecordingDb();
        const malformed = descriptor({
          joins: [
            { table: 'customers', type: 'right', on: [['sales.customer_id', 'sales.tenant_id']] },
            { table: 'orders', type: 'right', on: [['customers.id', 'orders.customer_id']] },
          ],
        });
        expect(() =>
          buildSecureQuery(db, BASE_CLAIMS, malformed, { tenancy: MULTI_TENANT }),
        ).toThrow(
          /right-hand column "sales\.tenant_id" qualified with table "sales" instead of "customers"/,
        );
      });
    });
  });

  describe('empty regionIds ([]) on the outer-join ON-clause path (Tier3 finding 3.1)', () => {
    // Regression (coverage-only — see ARCHITECTURE_REVIEW.md finding 3.1): the
    // WHERE-clause `regionIds: []` case is pinned above ("applies a
    // match-nothing region predicate when regionIds is an empty array"), and the
    // outer-join ON-clause path was previously only pinned with a NON-empty
    // region set ("LEFT JOIN: region/department predicates on the joined table
    // also move to ON"). The empty-array + ON-clause combination — which routes
    // through `andOnIn(col, [])` — was untested. If a future Knex version ever
    // rendered an empty `onIn` as a no-op (dropped) instead of a match-nothing
    // `1 = 0`, a zero-region caller's LEFT/RIGHT join would fail OPEN and pull in
    // same-tenant rows from unauthorized regions on the nullable side. Pinning
    // the exact `andOnIn(col, [])` call here (mirroring the WHERE-path pin) turns
    // that silent regression into a failing test.
    it('LEFT JOIN: regionIds: [] emits andOnIn(col, []) in the joined table ON clause', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        { ...BASE_CLAIMS, regionIds: [] },
        descriptor({
          joins: [
            { table: 'customers', type: 'left', on: [['sales.customer_id', 'customers.id']] },
          ],
        }),
        { tenancy: MULTI_TENANT },
      );
      expect(calls).toContainEqual({ method: 'andOnIn', args: ['customers.region_id', []] });
      // Never dropped, and never emitted as a WHERE predicate against the joined
      // (nullable) side, which would degrade the LEFT JOIN to an INNER JOIN.
      expect(
        calls.some((c) => c.method === 'whereIn' && String(c.args[0]).startsWith('customers.')),
      ).toBe(false);
    });

    it('RIGHT JOIN: regionIds: [] emits andOnIn(col, []) in the primary table ON clause', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        { ...BASE_CLAIMS, regionIds: [] },
        descriptor({
          joins: [
            { table: 'customers', type: 'right', on: [['sales.customer_id', 'customers.id']] },
          ],
        }),
        { tenancy: MULTI_TENANT },
      );
      expect(calls).toContainEqual({ method: 'andOnIn', args: ['sales.region_id', []] });
      expect(calls.some((c) => c.method === 'whereIn' && c.args[0] === 'sales.region_id')).toBe(
        false,
      );
    });
  });

  describe('join columnAliases resolution (allowlist-bypass regression)', () => {
    // Regression for the join-predicate variant of the column-allowlist bypass:
    // `validateDescriptorColumns` resolves `columnAliases` when checking BOTH
    // sides of every `join.on` pair against the allowlist, so execution MUST join
    // on the SAME resolved physical columns. Before the fix, `buildSecureQuery`
    // built `.on()` from the raw alias names, letting a client alias a
    // non-allowlisted column (`sales.ssn`) onto an allowlisted one
    // (`sales.amount`), pass validation, yet run `ON sales.ssn = customers.id` —
    // a correlation oracle against a forbidden column.
    it('joins on the physical (allowlisted) column, not the raw logical alias', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          columnAliases: { 'sales.ssn': 'sales.amount' },
          joins: [{ table: 'customers', on: [['sales.ssn', 'customers.id']] }],
        }),
        { tenancy: SINGLE_TENANT },
      );
      // The join condition targets the validated physical column `sales.amount`…
      expect(calls).toContainEqual({
        method: 'on',
        args: ['sales.amount', '=', 'customers.id'],
      });
      // …and never the raw, non-allowlisted logical name `sales.ssn`.
      expect(calls.some((c) => c.method === 'on' && c.args[0] === 'sales.ssn')).toBe(false);
    });

    it('resolves an alias on the RIGHT side of a join pair as well', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          columnAliases: { 'customers.secret': 'customers.id' },
          joins: [{ table: 'customers', on: [['sales.customer_id', 'customers.secret']] }],
        }),
        { tenancy: SINGLE_TENANT },
      );
      expect(calls).toContainEqual({
        method: 'on',
        args: ['sales.customer_id', '=', 'customers.id'],
      });
      expect(calls.some((c) => c.method === 'on' && c.args[1] === 'customers.secret')).toBe(false);
    });

    it('leaves a join pass through unchanged when neither side is aliased', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          columnAliases: { 'sales.ssn': 'sales.amount' },
          joins: [{ table: 'customers', on: [['sales.customer_id', 'customers.id']] }],
        }),
        { tenancy: SINGLE_TENANT },
      );
      expect(calls).toContainEqual({
        method: 'on',
        args: ['sales.customer_id', '=', 'customers.id'],
      });
    });

    it('resolves EVERY pair of a composite-key join, not just the first', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          columnAliases: { 'sales.a_alias': 'sales.a', 'customers.b_alias': 'customers.b' },
          joins: [
            {
              table: 'customers',
              on: [
                ['sales.a_alias', 'customers.a'],
                ['sales.b', 'customers.b_alias'],
              ],
            },
          ],
        }),
        { tenancy: SINGLE_TENANT },
      );
      // Both pairs are resolved to their physical columns…
      expect(calls.filter((c) => c.method === 'on')).toEqual([
        { method: 'on', args: ['sales.a', '=', 'customers.a'] },
        { method: 'on', args: ['sales.b', '=', 'customers.b'] },
      ]);
      // …and neither raw alias reaches the executed join.
      expect(
        calls.some(
          (c) =>
            c.method === 'on' &&
            (c.args[0] === 'sales.a_alias' || c.args[1] === 'customers.b_alias'),
        ),
      ).toBe(false);
    });
  });

  describe('configurable security columns', () => {
    it('uses a custom region column name from securityColumns', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(db, { ...BASE_CLAIMS, regionIds: [7] }, descriptor(), {
        tenancy: SINGLE_TENANT,
        securityColumns: { region: 'sales_region' },
      });
      expect(calls).toContainEqual({ method: 'whereIn', args: ['sales.sales_region', [7, '7']] });
    });

    it('uses a custom department column name from securityColumns', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(db, { ...BASE_CLAIMS, department: 'ops' }, descriptor(), {
        tenancy: SINGLE_TENANT,
        securityColumns: { department: 'dept_code' },
      });
      expect(calls).toContainEqual({ method: 'where', args: ['sales.dept_code', '=', 'ops'] });
    });

    it('defaults to region_id / department when securityColumns is omitted', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(db, { ...BASE_CLAIMS, regionIds: [1], department: 'ops' }, descriptor(), {
        tenancy: SINGLE_TENANT,
      });
      expect(calls).toContainEqual({ method: 'whereIn', args: ['sales.region_id', [1, '1']] });
      expect(calls).toContainEqual({ method: 'where', args: ['sales.department', '=', 'ops'] });
    });

    it('scopes a joined table that has a configured tenant column', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          joins: [{ table: 'customers', on: [['sales.customer_id', 'customers.id']] }],
        }),
        {
          tenancy: MULTI_TENANT,
          securityColumns: { perTable: { customers: { tenant: 'tenant_id' } } },
        },
      );
      // Both the primary table and the joined table get a tenant predicate.
      expect(calls).toContainEqual({ method: 'where', args: ['sales.tenant_id', '=', 'acme'] });
      expect(calls).toContainEqual({ method: 'where', args: ['customers.tenant_id', '=', 'acme'] });
    });

    it('scopes a joined table by DEFAULT (inherits primary security columns) with no perTable entry', () => {
      // Regression (cross-tenant fan-out): an unregistered joined table used to be
      // fully unscoped, so a tenant-filtered primary joined to it on a non-unique
      // key pulled in every other tenant's rows. Now the joined table inherits the
      // primary table's resolved tenant column by default.
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          joins: [{ table: 'customers', on: [['sales.region_id', 'customers.region_id']] }],
        }),
        { tenancy: MULTI_TENANT },
      );
      expect(calls).toContainEqual({ method: 'where', args: ['sales.tenant_id', '=', 'acme'] });
      // The joined table is now scoped by the inherited tenant column — no leak.
      expect(calls).toContainEqual({ method: 'where', args: ['customers.tenant_id', '=', 'acme'] });
    });

    it('inherits region/department scoping onto a joined table by default', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        { ...BASE_CLAIMS, regionIds: [1, 2], department: 'ops' },
        descriptor({
          joins: [{ table: 'customers', on: [['sales.customer_id', 'customers.id']] }],
        }),
        { tenancy: MULTI_TENANT },
      );
      expect(calls).toContainEqual({
        method: 'whereIn',
        args: ['customers.region_id', [1, '1', 2, '2']],
      });
      expect(calls).toContainEqual({ method: 'where', args: ['customers.department', '=', 'ops'] });
    });

    it('does NOT scope a joined table explicitly opted out via perTable[table] = null (shared lookup)', () => {
      // A genuinely shared/lookup table (no tenant column) opts out with an
      // explicit `null` sentinel and still joins successfully, unscoped.
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        { ...BASE_CLAIMS, regionIds: [1] },
        descriptor({
          joins: [{ table: 'country_codes', on: [['sales.country', 'country_codes.code']] }],
        }),
        { tenancy: MULTI_TENANT, securityColumns: { perTable: { country_codes: null } } },
      );
      expect(calls).toContainEqual({ method: 'where', args: ['sales.tenant_id', '=', 'acme'] });
      // No predicate of any kind is emitted against the opted-out shared table.
      expect(calls.some((c) => String(c.args[0]).startsWith('country_codes.'))).toBe(false);
    });

    it('drops ONLY region/department on a joined table via a per-dimension null, keeping tenant scope (finding 2.1)', () => {
      // A joined table (audit_log) carries tenant_id but has NO region column. With
      // `{ region: null, department: null }` it stays tenant-scoped while emitting
      // no region/department predicate — instead of being forced onto the
      // whole-table `null` opt-out, which would drop tenant scoping and re-open the
      // cross-tenant fan-out on a non-unique join key.
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        { ...BASE_CLAIMS, regionIds: [7], department: 'ops' },
        descriptor({
          joins: [{ table: 'audit_log', on: [['sales.id', 'audit_log.sale_id']] }],
        }),
        {
          tenancy: MULTI_TENANT,
          securityColumns: { perTable: { audit_log: { region: null, department: null } } },
        },
      );
      // The joined table KEEPS its inherited tenant predicate…
      expect(calls).toContainEqual({ method: 'where', args: ['audit_log.tenant_id', '=', 'acme'] });
      // …but emits NO region/department predicate against it (no such column).
      expect(calls.some((c) => String(c.args[0]).startsWith('audit_log.region'))).toBe(false);
      expect(calls.some((c) => c.method === 'where' && c.args[0] === 'audit_log.department')).toBe(
        false,
      );
      // The PRIMARY table is still fully region/department-scoped.
      expect(calls).toContainEqual({ method: 'whereIn', args: ['sales.region_id', [7, '7']] });
      expect(calls).toContainEqual({ method: 'where', args: ['sales.department', '=', 'ops'] });
    });
  });

  describe('non-array in/between values are rejected fail-closed (finding 3.1)', () => {
    it('throws when an "in" value is not an array (e.g. a bare string)', () => {
      const { db } = createRecordingDb();
      // The error message reports the table-qualified column (finding 2.1
      // qualification happens before `applyPredicate` runs its runtime guards).
      expect(() =>
        buildSecureQuery(
          db,
          BASE_CLAIMS,
          // Cast: the wire value is client JSON, whose runtime type is not the
          // declared array — exactly what the guard defends against.
          descriptor({ filters: [{ column: 'product', operator: 'in', value: 'abc' as any }] }),
          { tenancy: SINGLE_TENANT },
        ),
      ).toThrow(/"in" predicate on column "sales.product" requires an array value/);
    });

    it('throws when a "between" value is not an array', () => {
      const { db } = createRecordingDb();
      expect(() =>
        buildSecureQuery(
          db,
          BASE_CLAIMS,
          descriptor({ filters: [{ column: 'amount', operator: 'between', value: 10 as any }] }),
          { tenancy: SINGLE_TENANT },
        ),
      ).toThrow(/"between" predicate on column "sales.amount" requires a two-element/);
    });

    it('throws when a "between" array does not have exactly two elements', () => {
      const { db } = createRecordingDb();
      expect(() =>
        buildSecureQuery(
          db,
          BASE_CLAIMS,
          descriptor({ filters: [{ column: 'amount', operator: 'between', value: [10] as any }] }),
          { tenancy: SINGLE_TENANT },
        ),
      ).toThrow(/two-element/);
    });
  });

  describe('HAVING operator allowlist', () => {
    // A valid descriptor that reaches `applyHaving`: a declared aggregation plus a
    // HAVING predicate referencing its alias.
    const havingDescriptor = (operator: unknown) =>
      descriptor({
        aggregations: [{ column: 'amount', func: 'sum', alias: 'total' }],
        // Cast: the wire value is client JSON, whose runtime type is not the
        // declared `'eq' | 'gt' | ...` — that is exactly what the guard defends.
        having: [{ alias: 'total', operator: operator as any, value: 1 }],
      });

    it.each(['eq', 'gt', 'lt', 'gte', 'lte'] as const)(
      'emits a parameterized havingRaw for the supported operator "%s"',
      (operator) => {
        const { db, calls } = createRecordingDb();
        buildSecureQuery(db, BASE_CLAIMS, havingDescriptor(operator), {
          tenancy: SINGLE_TENANT,
        });
        const havingCall = calls.find((c) => c.method === 'havingRaw');
        expect(havingCall).toBeDefined();
        // Finding 2.5 — re-emits the aggregate EXPRESSION (qualified physical
        // column), not the SELECT output alias, so HAVING stays valid on
        // PostgreSQL (which rejects an alias reference in HAVING).
        expect(havingCall!.args[0]).toMatch(/^SUM\(\?\?\)/);
        expect(havingCall!.args[1]).toEqual(['sales.amount', 1]);
      },
    );

    // Regression for finding 2.5: PostgreSQL rejects `HAVING <select-alias> op ?`
    // (`42703 column ... does not exist`); MySQL/SQLite silently tolerate it. The
    // fix must NEVER emit the bare alias as the havingRaw identifier binding.
    it('never binds the SELECT output alias as the HAVING identifier (dialect portability)', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(db, BASE_CLAIMS, havingDescriptor('gt'), { tenancy: SINGLE_TENANT });
      const havingCall = calls.find((c) => c.method === 'havingRaw');
      expect(havingCall!.args[1]).not.toContain('total');
    });

    it('qualifies the aggregate column with the primary table to avoid join ambiguity', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          aggregations: [{ column: 'revenue', func: 'sum', alias: 'total_revenue' }],
          having: [{ alias: 'total_revenue', operator: 'gt', value: 10_000 }],
        }),
        { tenancy: SINGLE_TENANT },
      );
      const havingCall = calls.find((c) => c.method === 'havingRaw');
      expect(havingCall!.args[0]).toBe('SUM(??) > ?');
      expect(havingCall!.args[1]).toEqual(['sales.revenue', 10_000]);
    });

    it('emits the correct aggregate function for each supported HAVING aggregation', () => {
      const funcs = ['sum', 'avg', 'count', 'min', 'max'] as const;
      const expectedSql = ['SUM', 'AVG', 'COUNT', 'MIN', 'MAX'];
      funcs.forEach((func, i) => {
        const { db, calls } = createRecordingDb();
        buildSecureQuery(
          db,
          BASE_CLAIMS,
          descriptor({
            aggregations: [{ column: 'amount', func, alias: 'agg_alias' }],
            having: [{ alias: 'agg_alias', operator: 'gt', value: 1 }],
          }),
          { tenancy: SINGLE_TENANT },
        );
        const havingCall = calls.find((c) => c.method === 'havingRaw');
        expect(havingCall!.args[0]).toBe(`${expectedSql[i]}(??) > ?`);
      });
    });

    // Regression: `opMap` is a plain object literal that inherits from
    // `Object.prototype`, so a `!op` falsiness guard alone let an operator naming
    // an inherited member (`"toString"`, `"constructor"`, …) resolve to a truthy
    // inherited function and reach `havingRaw` as a stringified native function.
    // The own-property gate must reject these with the same "Unsupported HAVING
    // operator" error, never interpolating the inherited value.
    it.each(['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__'])(
      'rejects the prototype-inherited operator "%s" (allowlist bypass guard)',
      (operator) => {
        const { db, calls } = createRecordingDb();
        expect(() =>
          buildSecureQuery(db, BASE_CLAIMS, havingDescriptor(operator), {
            tenancy: SINGLE_TENANT,
          }),
        ).toThrow(/Unsupported HAVING operator/);
        // The inherited value never reached the raw SQL fragment.
        expect(calls.some((c) => c.method === 'havingRaw')).toBe(false);
      },
    );
  });

  it('queries the descriptor table and returns the builder', () => {
    const { db, calls } = createRecordingDb();
    const result = buildSecureQuery(db, BASE_CLAIMS, descriptor(), { tenancy: SINGLE_TENANT });
    expect(calls[0]).toEqual({ method: 'from', args: ['sales'] });
    expect(typeof result.where).toBe('function');
  });

  describe('read-path filter column qualification (finding 2.1)', () => {
    // Regression: every OTHER read-path column reference (SELECT / GROUP BY /
    // ORDER BY / aggregations in `execute.ts`, and all three security-predicate
    // dimensions in `shared/predicates.ts`) is table-qualified to avoid
    // "ambiguous column" errors under a join. User filter predicates were the
    // sole exception — `applyPredicate` emitted a bare `where('<col>', ...)`,
    // which Postgres/MySQL reject outright once a joined table shares the
    // column name (e.g. `region_id`). `buildSecureQuery` now qualifies an
    // unqualified resolved filter column with the PRIMARY table before handing
    // it to `applyPredicates`.
    it('qualifies an unqualified filter column with the primary table under a join', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          joins: [
            { table: 'customers', type: 'left', on: [['sales.customer_id', 'customers.id']] },
          ],
          // `region_id` exists on both `sales` and `customers` — the classic
          // ambiguous-column scenario.
          filters: [{ column: 'region_id', operator: 'eq', value: 5 }],
        }),
        { tenancy: SINGLE_TENANT },
      );
      expect(calls).toContainEqual({ method: 'where', args: ['sales.region_id', '=', 5] });
      expect(calls.some((c) => c.method === 'where' && c.args[0] === 'region_id')).toBe(false);
    });

    it('leaves a client-qualified filter column (containing a dot) untouched', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          joins: [{ table: 'customers', on: [['sales.customer_id', 'customers.id']] }],
          filters: [{ column: 'customers.region_id', operator: 'eq', value: 5 }],
        }),
        { tenancy: SINGLE_TENANT },
      );
      // The client explicitly named the joined table — respected as-is, not
      // re-qualified against the primary table.
      expect(calls).toContainEqual({ method: 'where', args: ['customers.region_id', '=', 5] });
    });

    // Real-Knex render pin: the mock `createRecordingDb` above (like the rest of
    // the suite) only asserts the Knex CALL contract, not the actual rendered
    // SQL string. This section renders through the real `knex` package (a
    // `peerDependency`/`devDependency` of this package — no native driver
    // needed, since `.toString()`/`.toSQL()` only build the SQL text) to pin the
    // literal SQL, so a Knex upgrade that changed how an unqualified/qualified
    // WHERE column renders would fail this test instead of silently
    // reintroducing an ambiguous-column error.
    describe('real Knex SQL rendering', () => {
      const realDb = Knex({ client: 'pg' });

      it('renders an unambiguous, fully-qualified WHERE clause under a join with a shared column name', () => {
        const query = buildSecureQuery(
          realDb,
          BASE_CLAIMS,
          descriptor({
            joins: [
              { table: 'customers', type: 'left', on: [['sales.customer_id', 'customers.id']] },
            ],
            filters: [{ column: 'region_id', operator: 'eq', value: 5 }],
          }),
          { tenancy: MULTI_TENANT },
        );
        expect(query.toString()).toBe(
          'select * from "sales" left join "customers" on "sales"."customer_id" = "customers"."id" ' +
            'and "customers"."tenant_id" = \'acme\' where "sales"."tenant_id" = \'acme\' and "sales"."region_id" = 5',
        );
      });

      it('demonstrates the pre-fix shape (bare column) is what Postgres rejects as ambiguous', () => {
        // Sanity check for the bug this fix closes: a bare, unqualified
        // `region_id` reference under a join where BOTH `sales` and `customers`
        // carry that column name is exactly the SQL Postgres/MySQL reject with
        // "column reference \"region_id\" is ambiguous". This test renders that
        // shape directly via Knex (bypassing `buildSecureQuery`, which no longer
        // produces it) purely to document/pin what the bug looked like.
        const buggyQuery = realDb('sales')
          .leftJoin('customers', 'sales.customer_id', 'customers.id')
          .where('sales.tenant_id', '=', 'acme')
          .where('region_id', '=', 5);
        expect(buggyQuery.toString()).toBe(
          'select * from "sales" left join "customers" on "sales"."customer_id" = "customers"."id" ' +
            'where "sales"."tenant_id" = \'acme\' and "region_id" = 5',
        );
      });
    });
  });

  describe('real Knex SQL rendering (Tier3 finding 3.1)', () => {
    // Pins the exact rendered SQL for the previously-untested `regionIds: []` +
    // outer-join ON-clause combination, so a future Knex version that changed
    // how an empty `onIn` renders (e.g. dropping the predicate instead of
    // `1 = 0`) would fail this test rather than silently fail OPEN.
    const realDb = Knex({ client: 'pg' });

    it('LEFT JOIN + regionIds: [] renders "and 1 = 0" inside the JOIN ON clause', () => {
      const query = buildSecureQuery(
        realDb,
        { ...BASE_CLAIMS, regionIds: [] },
        descriptor({
          joins: [
            { table: 'customers', type: 'left', on: [['sales.customer_id', 'customers.id']] },
          ],
        }),
        { tenancy: MULTI_TENANT, securityColumns: { region: 'region_id' } },
      );
      expect(query.toString()).toBe(
        'select * from "sales" left join "customers" on "sales"."customer_id" = "customers"."id" ' +
          'and "customers"."tenant_id" = \'acme\' and 1 = 0 where "sales"."tenant_id" = \'acme\' and 1 = 0',
      );
    });

    it('RIGHT JOIN + regionIds: [] renders "and 1 = 0" inside the JOIN ON clause', () => {
      const query = buildSecureQuery(
        realDb,
        { ...BASE_CLAIMS, regionIds: [] },
        descriptor({
          joins: [
            { table: 'customers', type: 'right', on: [['sales.customer_id', 'customers.id']] },
          ],
        }),
        { tenancy: MULTI_TENANT, securityColumns: { region: 'region_id' } },
      );
      expect(query.toString()).toBe(
        'select * from "sales" right join "customers" on "sales"."customer_id" = "customers"."id" ' +
          'and "sales"."tenant_id" = \'acme\' and 1 = 0 where "customers"."tenant_id" = \'acme\' and 1 = 0',
      );
    });
  });
});
