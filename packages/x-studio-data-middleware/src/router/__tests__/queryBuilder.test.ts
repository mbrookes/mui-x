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
      // EXACTLY ONE comparison value per region — the canonical decimal string.
      // Emitting the numeric form alongside it (`IN (1, '1', 2, '2')`) WIDENS the
      // predicate on MySQL: a numeric literal compared against a TEXT region
      // column coerces the whole comparison to numbers, so region `1` would also
      // match rows stored as `'01'`, `' 1'` or `'1abc'`. See
      // `shared/predicates.ts`'s `applySecurityPredicates` doc comment.
      expect(calls).toContainEqual({
        method: 'whereIn',
        args: ['sales.region_id', ['1', '2']],
      });
    });

    it('emits ONLY the string form of each region id (no numeric duplicate that could widen scope)', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(db, { ...BASE_CLAIMS, regionIds: [5] }, descriptor(), {
        tenancy: SINGLE_TENANT,
      });
      const regionCall = calls.find(
        (c) => c.method === 'whereIn' && c.args[0] === 'sales.region_id',
      )!;
      expect(regionCall.args[1]).toEqual(['5']);
      // The numeric form must be absent: `region_id IN (5, '5')` on MySQL matches
      // a TEXT region stored as '05'/' 5'/'5.0'/'5abc' — a widening of a
      // row-level-security predicate.
      expect(regionCall.args[1]).not.toContain(5);
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

    it('emits a match-nothing whereIn for an empty "in" list instead of dropping it (fail-closed)', () => {
      // REGRESSION (H1): this used to assert the OPPOSITE — that an empty `in`
      // was dropped ("autoRemove"), justified by the claim that the alternative
      // was a malformed `WHERE x IN ()`. That claim is false: Knex 3.x's
      // `whereIn(col, [])` short-circuits to `where(false)` → `1 = 0`. Dropping
      // the predicate failed OPEN — a filter widget with an empty selection
      // returned every tenant-scoped row of the table.
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          filters: [{ column: 'product', operator: 'in', value: [] }],
        }),
        { tenancy: SINGLE_TENANT },
      );
      expect(calls).toContainEqual({ method: 'whereIn', args: ['sales.product', []] });
    });

    // Deliberately the 3-arg `.where(column, 'like', pattern)` and NOT
    // `.whereLike(column, pattern)`: Knex's MySQL compiler appends `COLLATE
    // utf8_bin` to `whereLike` only, which is an error against a utf8mb4 column
    // on MySQL 8 (F1 — see `shared/__tests__/predicates.test.ts` for the
    // real-Knex SQL pins).
    it('maps "like" to the 3-arg .where(column, \'like\', pattern) form', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          filters: [{ column: 'name', operator: 'like', value: 'Ac%' }],
        }),
        { tenancy: SINGLE_TENANT },
      );
      expect(calls).toContainEqual({ method: 'where', args: ['sales.name', 'like', 'Ac%'] });
      expect(calls.some((c) => c.method === 'whereLike')).toBe(false);
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
      expect(calls).toContainEqual({ method: 'where', args: ['sales.amount', 'like', '123%'] });
      // …and never the raw, non-allowlisted logical name `ssn`.
      expect(calls.some((c) => c.args[0] === 'ssn')).toBe(false);
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
        args: ['customers.region_id', ['1', '2']],
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

  describe('multiple right joins (iter22 finding, corrected by the iter24 Tier1 tenant-leak fix)', () => {
    // Chained joins right-associate: `(A RIGHT JOIN B) RIGHT JOIN C` computes
    // `A RIGHT JOIN B` first, then RIGHT JOINs the WHOLE result to C. A `C` row
    // with no match against the accumulated `(A, B)` side null-extends B too —
    // not just the primary table A — even though B is the guaranteed/preserved
    // side of ITS OWN join. A bare `WHERE customers.tenant_id = ...` would then
    // silently DROP that legitimately-preserved `orders` row (fail-closed —
    // under-inclusive, never a leak).
    //
    // iter22 "fixed" this by relaxing the earlier right join's predicate to
    // `OR <join-key> IS NULL`, on the assumption that `customers`'s own join-key
    // column can only read NULL because of null-extension by the LATER (orders)
    // join. That assumption is FALSE here: `customers` is itself the PRESERVED
    // (right) side of ITS OWN join (`sales RIGHT JOIN customers`), so a right
    // join keeps every `customers` row regardless of whether the `on` match
    // succeeded — `customers.id` can be genuinely NULL on a real,
    // legitimately-participating, WRONG-TENANT row, with no null-extension
    // involved at all. That row then satisfies `(tenant_id = 'acme' OR id IS
    // NULL)` via the `IS NULL` arm and LEAKS PAST THE TENANT CHECK — a real
    // cross-tenant leak once >= 2 right joins are chained (Tier1, iter24
    // finding). This section now pins the FIXED behavior: an earlier join whose
    // OWN type is `right` gets the STRICT, unconditional WHERE predicate (no
    // relaxation, fail-closed) — the relaxation remains available only for a
    // non-`right` (inner) earlier join, where the "own match required" guarantee
    // genuinely holds. The LAST right join (nothing joins after it) has always
    // kept the strict predicate and still does.
    function twoRightJoinsDescriptor() {
      return descriptor({
        joins: [
          { table: 'customers', type: 'right', on: [['sales.customer_id', 'customers.id']] },
          { table: 'orders', type: 'right', on: [['customers.id', 'orders.customer_id']] },
        ],
      });
    }

    it('SECURITY REGRESSION (Tier1): the EARLIER right join (customers) - itself the preserved side of its OWN join - gets the STRICT WHERE predicate, never the OR-IS-NULL relaxation', () => {
      const { db, calls } = createRecordingDb();
      buildSecureQuery(db, BASE_CLAIMS, twoRightJoinsDescriptor(), { tenancy: MULTI_TENANT });
      // The strict, unconditional predicate — never relaxed.
      expect(calls).toContainEqual({ method: 'where', args: ['customers.tenant_id', '=', 'acme'] });
      // Never the vulnerable grouped/relaxed shape: no `andWhere` grouping and no
      // `orWhereNull` keyed on customers' own join key. Reintroducing either of
      // these for a `right`-typed join is exactly the cross-tenant leak this
      // fix closes.
      expect(calls.some((c) => c.method === 'where(group)')).toBe(false);
      expect(calls.some((c) => c.method === 'orWhereNull' && c.args[0] === 'customers.id')).toBe(
        false,
      );
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

    it('an EARLIER join that is NOT itself a right join (inner) still gets the OR <join-key> IS NULL relaxation', () => {
      // Contrast case: when the earlier join's OWN type is `inner` (a match is
      // REQUIRED for it to appear at all — NULL never equals, so a matched row's
      // join-key column is guaranteed non-null), the "own join guarantees
      // non-null unless null-extended later" premise genuinely holds, and the
      // relaxation remains correct and necessary (dropping the iter22 fix's own
      // correctness benefit for this case would be an unwarranted regression).
      const { db, calls } = createRecordingDb();
      buildSecureQuery(
        db,
        BASE_CLAIMS,
        descriptor({
          joins: [
            { table: 'customers', on: [['sales.customer_id', 'customers.id']] }, // default type: inner
            { table: 'orders', type: 'right', on: [['customers.id', 'orders.customer_id']] },
          ],
        }),
        { tenancy: MULTI_TENANT },
      );
      expect(calls).toContainEqual({
        method: 'andWhere',
        args: ['customers.tenant_id', '=', 'acme'],
      });
      expect(calls).toContainEqual({ method: 'orWhereNull', args: ['customers.id'] });
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

      it('renders a STRICT (non-relaxed) WHERE for the earlier right join — no OR/IS NULL escape hatch', () => {
        const query = buildSecureQuery(realDb, BASE_CLAIMS, twoRightJoinsDescriptor(), {
          tenancy: MULTI_TENANT,
        });
        // The second right join's ON clause does not repeat "sales.tenant_id",
        // and the WHERE clause ANDs both tables' tenant predicates unconditionally
        // — no "or ... is null" anywhere. This is the fixed, leak-free shape.
        expect(query.toString()).toBe(
          'select * from "sales" ' +
            'right join "customers" on "sales"."customer_id" = "customers"."id" and "sales"."tenant_id" = \'acme\' ' +
            'right join "orders" on "customers"."id" = "orders"."customer_id" ' +
            'where "customers"."tenant_id" = \'acme\' and "orders"."tenant_id" = \'acme\'',
        );
        expect(query.toString()).not.toMatch(/or\s+"customers"\."id"\s+is null/i);
      });

      // SECURITY REGRESSION (Tier1, iter24 finding) — this is the exact scenario
      // from the architecture review: a cross-tenant `customers` row with a
      // legitimately-present-but-NULL join-key column must NOT satisfy the
      // tenant predicate. The vulnerable (pre-fix) shape rendered
      // `where (("customers"."tenant_id" = 'acme') or "customers"."id" is null)
      // and "orders"."tenant_id" = 'acme'` — under that WHERE clause, a
      // "customers" row `{ tenant_id: 'evil-corp', id: NULL }` (a real row: it
      // is the preserved side of "sales RIGHT JOIN customers", so its presence
      // never required a match, and its own `id` column can be NULL in the raw
      // data independent of any later join) satisfies the predicate via the
      // `... OR "customers"."id" is null` arm and would have been returned to
      // the "acme" caller despite belonging to a different tenant. The fixed
      // predicate rendered above (`where "customers"."tenant_id" = 'acme' and
      // ...`, no OR arm at all) evaluates to `'evil-corp' = 'acme'` → false for
      // that exact row, excluding it. This test evaluates both shapes'
      // row-admission semantics directly (mirroring the boolean logic Postgres
      // would apply) against that row to make the leak-vs-no-leak difference an
      // executable assertion, not just a comment.
      it('a cross-tenant row with a legitimately-NULL join key is excluded (was admitted by the pre-fix OR-IS-NULL relaxation)', () => {
        const query = buildSecureQuery(realDb, BASE_CLAIMS, twoRightJoinsDescriptor(), {
          tenancy: MULTI_TENANT,
        });
        const fixedSql = query.toString();
        expect(fixedSql).toContain('"customers"."tenant_id" = \'acme\'');
        expect(fixedSql).not.toContain('is null');

        // A real, legitimately-present "customers" row from a different tenant,
        // whose own join-key column happens to be NULL in the raw data (nothing
        // to do with null-extension — this row was never null-extended, it is a
        // genuine row of "customers").
        const crossTenantRowWithNullJoinKey = { tenant_id: 'evil-corp', id: null as string | null };

        // The historical, VULNERABLE predicate shape this package used to emit
        // for an earlier right-joined table (`(tenant = ? OR joinKey IS NULL)`),
        // reproduced here ONLY to demonstrate what it would have admitted — this
        // is not live code in the package (the fix removes this shape entirely).
        const vulnerablePredicate = (row: { tenant_id: string; id: string | null }): boolean =>
          row.tenant_id === 'acme' || row.id === null;
        // The fixed predicate this package now actually emits for such a table
        // (a bare, unconditional tenant equality check).
        const fixedPredicate = (row: { tenant_id: string; id: string | null }): boolean =>
          row.tenant_id === 'acme';

        expect(vulnerablePredicate(crossTenantRowWithNullJoinKey)).toBe(true); // pre-fix: LEAKED
        expect(fixedPredicate(crossTenantRowWithNullJoinKey)).toBe(false); // post-fix: excluded

        // A legitimate same-tenant row is admitted either way (no regression for
        // the caller's own data).
        const sameTenantRow = { tenant_id: 'acme', id: null as string | null };
        expect(fixedPredicate(sameTenantRow)).toBe(true);
      });
    });

    describe('joinNullIndicatorColumn convention verification (untrusted-convention finding)', () => {
      it('throws when an earlier NON-right (inner) join\'s "on" pair right-hand column is qualified with a table other than its own', () => {
        // Malformed descriptor: the "customers" join's `on` pair right-hand side
        // is qualified with "sales" (the PRIMARY table) instead of "customers"
        // (its own table) — violating the documented `JoinDescriptor.on`
        // convention. "customers" here is an INNER join (default type) sitting
        // BEFORE the last right join (index 0 < lastRightJoinIndex 1), so
        // `buildSecureQuery` must pick a null-indicator column for it — unlike a
        // `right`-typed earlier join (Tier1 fix above), which now fails closed
        // WITHOUT ever reaching this qualification check (its own join key is
        // never trusted as an indicator at all, regardless of qualification).
        // Trusting the malformed pair without verification would hand
        // `applySecurityPredicatesOrNull` a column that does not belong to
        // "customers" at all, letting the `OR ... IS NULL` escape hatch key off
        // the wrong table's nullability — this now fails closed instead.
        const { db } = createRecordingDb();
        const malformed = descriptor({
          joins: [
            { table: 'customers', on: [['sales.customer_id', 'sales.tenant_id']] }, // default type: inner
            { table: 'orders', type: 'right', on: [['customers.id', 'orders.customer_id']] },
          ],
        });
        expect(() =>
          buildSecureQuery(db, BASE_CLAIMS, malformed, { tenancy: MULTI_TENANT }),
        ).toThrow(
          /right-hand column "sales\.tenant_id" qualified with table "sales" instead of "customers"/,
        );
      });

      it('a malformed earlier RIGHT join\'s "on" pair no longer reaches the qualification check at all — it fails closed to the strict predicate regardless', () => {
        // Same malformed "on" pair as above, but on a `right`-typed earlier join.
        // Before the Tier1 fix this would have thrown the qualification error (or,
        // pre-that-hardening, silently trusted the wrong-table column). Now
        // `joinNullIndicatorColumn` returns `undefined` for ANY `right`-typed join
        // before it even looks at the "on" pair — the malformed pair is simply
        // irrelevant, and the table gets the strict WHERE predicate like any other
        // right-typed earlier join.
        const { db, calls } = createRecordingDb();
        const malformed = descriptor({
          joins: [
            { table: 'customers', type: 'right', on: [['sales.customer_id', 'sales.tenant_id']] },
            { table: 'orders', type: 'right', on: [['customers.id', 'orders.customer_id']] },
          ],
        });
        expect(() =>
          buildSecureQuery(db, BASE_CLAIMS, malformed, { tenancy: MULTI_TENANT }),
        ).not.toThrow();
        expect(calls).toContainEqual({
          method: 'where',
          args: ['customers.tenant_id', '=', 'acme'],
        });
      });
    });
  });

  describe('empty regionIds ([]) on the outer-join ON-clause path (Tier3 finding 3.1)', () => {
    // Regression (coverage-only — see finding 3.1): the
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
      expect(calls).toContainEqual({ method: 'whereIn', args: ['sales.sales_region', ['7']] });
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
      expect(calls).toContainEqual({ method: 'whereIn', args: ['sales.region_id', ['1']] });
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
        args: ['customers.region_id', ['1', '2']],
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
      expect(calls).toContainEqual({ method: 'whereIn', args: ['sales.region_id', ['7']] });
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

  // ── Empty USER "in" filter renders `1 = 0`, not "no filter" (H1) ────────────
  // The sibling of the `regionIds: []` rendering tests above, for the USER-filter
  // path. The two paths held CONTRADICTORY beliefs about the identical Knex call:
  // the security path relied on `whereIn(col, [])` rendering `1 = 0`, while the
  // user-filter path DROPPED the predicate on the (false) premise that Knex would
  // otherwise emit a malformed `WHERE x IN ()`. Pinning the rendered SQL here
  // means a future Knex version that changed the empty-`whereIn` behavior fails
  // this test instead of silently failing OPEN.
  describe('real Knex SQL rendering — empty user "in" filter (H1)', () => {
    const realDb = Knex({ client: 'pg' });

    it('renders an empty "in" filter as the match-nothing "1 = 0"', () => {
      const query = buildSecureQuery(
        realDb,
        BASE_CLAIMS,
        descriptor({ filters: [{ column: 'status', operator: 'in', value: [] }] }),
        { tenancy: MULTI_TENANT },
      );
      expect(query.toString()).toBe(
        'select * from "sales" where "sales"."tenant_id" = \'acme\' and 1 = 0',
      );
    });

    it('renders a NON-empty "in" filter as a real IN list (unchanged)', () => {
      const query = buildSecureQuery(
        realDb,
        BASE_CLAIMS,
        descriptor({ filters: [{ column: 'status', operator: 'in', value: ['a', 'b'] }] }),
        { tenancy: MULTI_TENANT },
      );
      expect(query.toString()).toBe(
        'select * from "sales" where "sales"."tenant_id" = \'acme\' ' +
          'and "sales"."status" in (\'a\', \'b\')',
      );
    });
  });
});

// ── SEMI-JOINS ───────────────────────────────────────────────────────────────
//
// Every assertion here renders through REAL Knex. The recording mock elsewhere in
// this file cannot express a semi-join faithfully — its `db(table)` returns one
// shared builder, so an outer query and its subquery would be the same object —
// and, more importantly, what a semi-join must be pinned on IS the emitted SQL:
// the whole reason the form exists is that a structurally similar `LEFT JOIN`
// produces a DIFFERENT answer, and only the rendered string shows that.
describe('buildSecureQuery — semi-joins', () => {
  const realDb = Knex({ client: 'pg' });

  const CUSTOMERS: JwtSecurityClaims = {
    tenantId: 'acme',
    userId: 'user-1',
    roleIds: ['viewer'],
  };
  const MULTI = { mode: 'multi-tenant', tenantColumn: 'tenant_id' } as const;
  const SINGLE = { mode: 'single-tenant' } as const;

  /** A `customers` widget filtered by "has at least one shipped order". */
  function customersFilteredByOrders(
    overrides: Partial<BatchWidgetDescriptor> = {},
  ): BatchWidgetDescriptor {
    return {
      id: 'w1',
      table: 'customers',
      semiJoins: [
        {
          table: 'orders',
          column: 'id',
          foreignColumn: 'customer_id',
          filters: [{ column: 'status', operator: 'eq', value: 'shipped' }],
        },
      ],
      ...overrides,
    };
  }

  it('renders "IN (SELECT …)" with the subquery scoped to ITS OWN table', () => {
    const query = buildSecureQuery(realDb, CUSTOMERS, customersFilteredByOrders(), {
      tenancy: MULTI,
    });
    expect(query.toString()).toBe(
      'select * from "customers" where "customers"."tenant_id" = \'acme\' ' +
        'and "customers"."id" in (' +
        'select "orders"."customer_id" from "orders" ' +
        'where "orders"."tenant_id" = \'acme\' and "orders"."status" = \'shipped\')',
    );
  });

  // THE TENANCY LEAK THIS FORM MUST NOT HAVE.
  //
  // A semi-join's subquery is a second table reference, so the caller's row-level
  // security predicate has to be applied INSIDE it. Applied only to the outer
  // query, the inner SELECT returns EVERY tenant's foreign keys, and any outer row
  // whose own (correctly scoped) key collides with one of them survives a filter
  // it never matched — a cross-tenant leak of the existence and filterable
  // attributes of another tenant's rows, invisible in the returned rows because no
  // foreign row is ever returned.
  //
  // Asserted three ways so a regression cannot slip past on wording: the inner
  // predicate is present, it is INSIDE the parentheses (not merely somewhere in
  // the string), and the leaking shape is pinned separately so what "wrong" looks
  // like is on the record.
  it('applies the tenancy predicate INSIDE the subquery, not only on the outer query', () => {
    const sql = buildSecureQuery(realDb, CUSTOMERS, customersFilteredByOrders(), {
      tenancy: MULTI,
    }).toString();
    const subquery = sql.slice(sql.indexOf('(select'), sql.lastIndexOf(')') + 1);
    expect(subquery).toContain('"orders"."tenant_id" = \'acme\'');
    // And the scope precedes the user filter inside the subquery, mirroring the
    // outer query's "security predicates first" invariant.
    expect(subquery.indexOf('"orders"."tenant_id"')).toBeLessThan(
      subquery.indexOf('"orders"."status"'),
    );
  });

  it('demonstrates the leaking shape an unscoped subquery would render', () => {
    // Built directly through Knex (not through `buildSecureQuery`, which no longer
    // produces it) purely to document the bug: the inner SELECT has no tenant
    // predicate, so it returns every tenant's `customer_id`. An `acme` customer
    // whose id happens to equal a `globex` order's `customer_id` is then admitted
    // by a filter no order of its own satisfied.
    const leaking = realDb('customers')
      .where('customers.tenant_id', '=', 'acme')
      .whereIn(
        'customers.id',
        realDb('orders').select('orders.customer_id').where('orders.status', '=', 'shipped'),
      );
    expect(leaking.toString()).toBe(
      'select * from "customers" where "customers"."tenant_id" = \'acme\' ' +
        'and "customers"."id" in (' +
        'select "orders"."customer_id" from "orders" where "orders"."status" = \'shipped\')',
    );
    // The distinguishing feature, stated as the property rather than the string:
    // the fixed shape scopes the subquery, this one does not.
    expect(leaking.toString()).not.toContain('"orders"."tenant_id"');
  });

  it('scopes EVERY nesting level of a two-hop (many-to-many) semi-join', () => {
    const query = buildSecureQuery(
      realDb,
      CUSTOMERS,
      {
        id: 'w1',
        table: 'customers',
        semiJoins: [
          {
            table: 'customer_tags',
            column: 'id',
            foreignColumn: 'customer_id',
            semiJoins: [
              {
                table: 'tags',
                column: 'tag_id',
                foreignColumn: 'id',
                filters: [{ column: 'name', operator: 'eq', value: 'vip' }],
              },
            ],
          },
        ],
      },
      { tenancy: MULTI },
    );
    // The junction level is scoped too — an unscoped junction leaks exactly the
    // way an unscoped leaf does, one hop further out.
    expect(query.toString()).toBe(
      'select * from "customers" where "customers"."tenant_id" = \'acme\' ' +
        'and "customers"."id" in (' +
        'select "customer_tags"."customer_id" from "customer_tags" ' +
        'where "customer_tags"."tenant_id" = \'acme\' ' +
        'and "customer_tags"."tag_id" in (' +
        'select "tags"."id" from "tags" ' +
        'where "tags"."tenant_id" = \'acme\' and "tags"."name" = \'vip\'))',
    );
  });

  it('resolves the subquery scope through forJoinedTable — a per-dimension null keeps tenant scoping', () => {
    const query = buildSecureQuery(
      realDb,
      { ...CUSTOMERS, regionIds: [5] },
      customersFilteredByOrders(),
      {
        tenancy: MULTI,
        // `orders` carries `tenant_id` but no region column — the documented
        // per-dimension opt-out. The tenant predicate must survive it.
        securityColumns: { perTable: { orders: { region: null } } },
      },
    );
    expect(query.toString()).toContain('"orders"."tenant_id" = \'acme\'');
    expect(query.toString()).not.toContain('"orders"."region_id"');
    // The OUTER table is still region-scoped — the override is per-table.
    expect(query.toString()).toContain('"customers"."region_id" in (\'5\')');
  });

  it('joins a host-declared SHARED table unscoped, exactly as a joined table would', () => {
    const query = buildSecureQuery(realDb, CUSTOMERS, customersFilteredByOrders(), {
      tenancy: MULTI,
      // The whole-entry `null` sentinel: the host explicitly declares `orders` a
      // shared/lookup table with no tenant column. This is the ONLY way a
      // semi-join subquery goes unscoped.
      securityColumns: { perTable: { orders: null } },
    });
    expect(query.toString()).toBe(
      'select * from "customers" where "customers"."tenant_id" = \'acme\' ' +
        'and "customers"."id" in (' +
        'select "orders"."customer_id" from "orders" where "orders"."status" = \'shipped\')',
    );
  });

  it('renders the match-nothing "1 = 0" INSIDE the subquery for regionIds: []', () => {
    // The `regionIds: []` distinction (authorized for ZERO regions, not
    // "unscoped") must hold at every level. Dropping it inside a subquery would
    // fail OPEN: the subquery would return every region's foreign keys.
    const query = buildSecureQuery(
      realDb,
      { ...CUSTOMERS, regionIds: [] },
      customersFilteredByOrders(),
      { tenancy: SINGLE, securityColumns: { region: 'region_id' } },
    );
    expect(query.toString()).toBe(
      'select * from "customers" where 1 = 0 and "customers"."id" in (' +
        'select "orders"."customer_id" from "orders" ' +
        'where 1 = 0 and "orders"."status" = \'shipped\')',
    );
  });

  it('qualifies an unqualified outer column with the enclosing table, not the foreign one', () => {
    const query = buildSecureQuery(realDb, CUSTOMERS, customersFilteredByOrders(), {
      tenancy: SINGLE,
    });
    expect(query.toString()).toContain('"customers"."id" in (select "orders"."customer_id"');
  });

  it('leaves an explicitly-qualified column pair untouched', () => {
    const query = buildSecureQuery(
      realDb,
      CUSTOMERS,
      customersFilteredByOrders({
        semiJoins: [
          { table: 'orders', column: 'customers.id', foreignColumn: 'orders.customer_id' },
        ],
      }),
      { tenancy: SINGLE },
    );
    expect(query.toString()).toBe(
      'select * from "customers" where "customers"."id" in (' +
        'select "orders"."customer_id" from "orders")',
    );
  });

  it('applies every semi-join in the array (conjunctively)', () => {
    const query = buildSecureQuery(
      realDb,
      CUSTOMERS,
      customersFilteredByOrders({
        semiJoins: [
          { table: 'orders', column: 'id', foreignColumn: 'customer_id' },
          { table: 'tickets', column: 'id', foreignColumn: 'customer_id' },
        ],
      }),
      { tenancy: SINGLE },
    );
    expect(query.toString()).toBe(
      'select * from "customers" where ' +
        '"customers"."id" in (select "orders"."customer_id" from "orders") ' +
        'and "customers"."id" in (select "tickets"."customer_id" from "tickets")',
    );
  });

  // ── The reason this whole form exists ──────────────────────────────────────
  //
  // Pins the DIFFERENCE between the semi-join and the `LEFT JOIN` the wire
  // protocol used to force. Both express "customers with a shipped order"; only
  // one of them leaves the customer row set alone. The join's row multiplication
  // is invisible in the SQL text, so this test states it as the structural
  // property — the join adds a second table to the FROM/JOIN chain, the semi-join
  // does not — which is exactly what makes `SUM(customers.lifetime_value)` read
  // once per customer instead of once per matching order.
  it('does not add the foreign table to the outer FROM/JOIN chain (the join does)', () => {
    const semiJoinSql = buildSecureQuery(realDb, CUSTOMERS, customersFilteredByOrders(), {
      tenancy: SINGLE,
    }).toString();
    const joinSql = buildSecureQuery(
      realDb,
      CUSTOMERS,
      {
        id: 'w1',
        table: 'customers',
        joins: [{ table: 'orders', type: 'left', on: [['customers.id', 'orders.customer_id']] }],
        filters: [{ column: 'orders.status', operator: 'eq', value: 'shipped' }],
      },
      { tenancy: SINGLE },
    ).toString();

    expect(joinSql).toContain('left join "orders"');
    expect(semiJoinSql).not.toContain('join "orders"');
    // Both reference `orders`, but only the join's reference multiplies the outer
    // rows — the semi-join's lives entirely inside a subquery.
    expect(semiJoinSql).toContain('in (select "orders"."customer_id" from "orders"');
  });

  // The x-studio adapter (`createBatchingAdapter`'s `resolveField`) emits every semi-join column
  // FULLY QUALIFIED, and qualifies a nested level's outer column with its PARENT's table rather
  // than the widget's primary table. Pinning that exact wire shape here is what keeps the two
  // packages' conventions from drifting apart silently — qualification is the one part of this
  // protocol where a wrong-but-well-formed value produces a different ANSWER rather than an error.
  it('accepts the fully-qualified two-hop shape the x-studio adapter emits', () => {
    const query = buildSecureQuery(
      realDb,
      CUSTOMERS,
      {
        id: 'w1',
        table: 'customers',
        semiJoins: [
          {
            table: 'customer_tags',
            column: 'customers.id',
            foreignColumn: 'customer_tags.cId',
            filters: [],
            semiJoins: [
              {
                table: 'tags',
                // Qualified with the PARENT (`customer_tags`), not with `customers`.
                column: 'customer_tags.tId',
                foreignColumn: 'tags.tagId',
                filters: [{ column: 'tags.name', operator: 'eq', value: 'vip' }],
              },
            ],
          },
        ],
      },
      { tenancy: MULTI },
    );
    expect(query.toString()).toBe(
      'select * from "customers" where "customers"."tenant_id" = \'acme\' ' +
        'and "customers"."id" in (' +
        'select "customer_tags"."cId" from "customer_tags" ' +
        'where "customer_tags"."tenant_id" = \'acme\' ' +
        'and "customer_tags"."tId" in (' +
        'select "tags"."tagId" from "tags" ' +
        'where "tags"."tenant_id" = \'acme\' and "tags"."name" = \'vip\'))',
    );
  });

  it('applies the subquery to the COUNT(*) preflight shape too (no SELECT of its own)', () => {
    // `runPreflight` builds through this same function and then calls `.count()`,
    // so a semi-join must survive a descriptor with no projection.
    const query = buildSecureQuery(realDb, CUSTOMERS, customersFilteredByOrders(), {
      tenancy: MULTI,
    });
    expect(query.clone().count('* as count').toString()).toBe(
      'select count(*) as "count" from "customers" where "customers"."tenant_id" = \'acme\' ' +
        'and "customers"."id" in (' +
        'select "orders"."customer_id" from "orders" ' +
        'where "orders"."tenant_id" = \'acme\' and "orders"."status" = \'shipped\')',
    );
  });
});
