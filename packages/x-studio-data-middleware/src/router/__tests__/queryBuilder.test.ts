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
  // Join methods use Knex's callback form: `join(table, function () { this.on(...) })`.
  // Record the join once (with only the table), then run the callback against a
  // context whose `.on()` records each condition — so a composite-key join is a
  // single join with multiple `on` calls (not one join per pair).
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
      const userFilterIdx = indexOf(calls, 'where', (c) => c.args[0] === 'status');
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
      expect(calls).toContainEqual({ method: 'where', args: ['amount', sqlOp, value] });
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
      expect(calls).toContainEqual({ method: 'whereIn', args: ['product', ['a', 'b']] });
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
      expect(calls).toContainEqual({ method: 'whereLike', args: ['name', 'Ac%'] });
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
      expect(calls).toContainEqual({ method: 'whereBetween', args: ['amount', [10, 20]] });
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
        { method: 'where', args: ['status', '=', 'active'] },
        { method: 'where', args: ['amount', '>', 0] },
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
      // The WHERE clause targets the validated physical column `amount`…
      expect(calls).toContainEqual({ method: 'whereLike', args: ['amount', '123%'] });
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

    it('leaves a filter column unchanged when it has no alias entry', () => {
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
      expect(calls).toContainEqual({ method: 'where', args: ['status', '=', 'active'] });
    });
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
      expect(() =>
        buildSecureQuery(
          db,
          BASE_CLAIMS,
          // Cast: the wire value is client JSON, whose runtime type is not the
          // declared array — exactly what the guard defends against.
          descriptor({ filters: [{ column: 'product', operator: 'in', value: 'abc' as any }] }),
          { tenancy: SINGLE_TENANT },
        ),
      ).toThrow(/"in" predicate on column "product" requires an array value/);
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
      ).toThrow(/"between" predicate on column "amount" requires a two-element/);
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
        expect(havingCall!.args[1]).toEqual(['total', 1]);
      },
    );

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
});
