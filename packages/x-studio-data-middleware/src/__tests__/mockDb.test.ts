/**
 * Tests for the TEST DOUBLES themselves (`mockDb.ts`).
 *
 * A Knex stand-in is load-bearing: every handler-level suite in this package
 * decides whether production behaviour is correct by asking this mock what a
 * query returned. When the double is wrong — or, worse, silently permissive —
 * the suites above it pass for the wrong reason. A mutation-testing audit found
 * exactly that: several of the double's own fail-closed guards were DEAD CODE
 * (no test reached them, so they could be deleted with no suite failing), and
 * one modelled behaviour was the INVERSE of SQL's.
 *
 * These tests pin the double's contract directly, so the guards cannot rot back
 * into no-ops and the ORDER BY semantics cannot re-invert.
 */
import { describe, it, expect } from 'vitest';
import {
  assertTimeoutArgs,
  compareByOrderBy,
  createMockDb,
  failClosedBuilder,
  mockRaw,
  rowKeyOf,
  sqlValueEquals,
  wherePredicate,
} from './mockDb';

describe('mockDb — wherePredicate models the operator', () => {
  it('fails closed on an operator it does not model instead of matching every row', () => {
    // THE GUARD THIS EXISTS FOR. `applyPredicate` (`shared/predicates.ts`) picks
    // the Knex form per operator, and F1 changed `like` from `.whereLike(col, p)`
    // to `.where(col, 'like', p)` precisely because the two compile differently
    // on MySQL. Before the guard, an operator the mock did not recognize pushed
    // NO predicate — so such a switch read as "the filter matched every row",
    // which is a FAIL-OPEN default in a suite whose job is to check filtering.
    expect(() => wherePredicate('sales.amount', 'ilike', '%x%')).toThrow(
      'mockDb: unsupported where operator "ilike"',
    );
    expect(() => wherePredicate('sales.amount', '<=>', 1)).toThrow(
      /unsupported where operator "<=>"/,
    );
  });

  it('distinguishes every modelled operator from equality', () => {
    const row = { amount: 10, product: 'widget' };
    expect(wherePredicate('sales.amount', '=', 10)(row)).toBe(true);
    expect(wherePredicate('sales.amount', '=', 11)(row)).toBe(false);
    // `!=` must NOT collapse to `=` — the exact bug in the two hand-rolled
    // doubles that discarded the operator argument.
    expect(wherePredicate('sales.amount', '!=', 10)(row)).toBe(false);
    expect(wherePredicate('sales.amount', '!=', 11)(row)).toBe(true);
    expect(wherePredicate('sales.amount', '<', 11)(row)).toBe(true);
    expect(wherePredicate('sales.amount', '<', 10)(row)).toBe(false);
    expect(wherePredicate('sales.amount', '<=', 10)(row)).toBe(true);
    expect(wherePredicate('sales.amount', '>', 9)(row)).toBe(true);
    expect(wherePredicate('sales.amount', '>', 10)(row)).toBe(false);
    expect(wherePredicate('sales.amount', '>=', 10)(row)).toBe(true);
    // SQL LIKE semantics, not equality.
    expect(wherePredicate('sales.product', 'like', 'wid%')(row)).toBe(true);
    expect(wherePredicate('sales.product', 'like', 'wid')(row)).toBe(false);
    expect(wherePredicate('sales.product', 'like', 'WIDGET')(row)).toBe(true);
  });

  it('compares the 2-arg form with SQL coercion rules, not JS ===', () => {
    // Knex's 2-arg `.where(col, value)` is an equality comparison and must use
    // the same rules as the 3-arg `=` branch. `===` made a numeric column
    // unmatchable by the canonical decimal STRING the security predicates bind
    // (`shared/predicates.ts` deliberately binds `String(id)`).
    expect(wherePredicate('sales.region_id', '5', undefined)({ region_id: 5 })).toBe(true);
    expect(wherePredicate('sales.region_id', 5, undefined)({ region_id: '5' })).toBe(true);
    // …and the widening that the string-only binding exists to prevent is still
    // rejected.
    expect(wherePredicate('sales.region_id', '05', undefined)({ region_id: '5' })).toBe(false);
  });

  it('strips a table qualifier before indexing the row', () => {
    expect(rowKeyOf('sales.amount')).toBe('amount');
    expect(rowKeyOf('amount')).toBe('amount');
    expect(sqlValueEquals(5, '5')).toBe(true);
    expect(sqlValueEquals('5', '05')).toBe(false);
  });
});

describe('mockDb — ORDER BY puts the FIRST key first, as SQL does', () => {
  const ROWS = [
    { a: 2, b: 1, tag: 'a2b1' },
    { a: 1, b: 2, tag: 'a1b2' },
    { a: 1, b: 1, tag: 'a1b1' },
    { a: 2, b: 2, tag: 'a2b2' },
  ];

  it('orders by the leading clause, breaking ties with the next', async () => {
    // THE INVERTED-SEMANTICS REGRESSION. The mock used to run one stable
    // `sort()` per clause in FORWARD order, which makes the LAST clause the
    // primary key — the exact inverse of `ORDER BY a, b`. Every assertion about
    // multi-key ordering in the suites above was therefore checking the wrong
    // order, and nothing covered it.
    const db = createMockDb({ t: ROWS });
    const rows = await db('t').orderBy('t.a', 'asc').orderBy('t.b', 'desc');
    expect(rows.map((r) => r.tag)).toEqual(['a1b2', 'a1b1', 'a2b2', 'a2b1']);
  });

  it('is the same rule the shared comparator implements', () => {
    const clauses = [
      { column: 'a', dir: 'asc' },
      { column: 'b', dir: 'asc' },
    ];
    // Leading key decides whenever it differs…
    expect(compareByOrderBy({ a: 1, b: 9 }, { a: 2, b: 0 }, clauses)).toBeLessThan(0);
    // …and only a tie falls through to the next one.
    expect(compareByOrderBy({ a: 1, b: 9 }, { a: 1, b: 0 }, clauses)).toBeGreaterThan(0);
    expect(compareByOrderBy({ a: 1, b: 1 }, { a: 1, b: 1 }, clauses)).toBe(0);
  });
});

describe('mockDb — havingRaw fails closed', () => {
  it('throws on a HAVING operator it does not model instead of matching every group', async () => {
    // `default: return true` meant an unrecognized operator admitted EVERY
    // group — the same fail-open shape `applyHaving`'s own "Unsupported HAVING
    // operator" error exists to prevent, but inside the double that is supposed
    // to detect it.
    const db = createMockDb({ t: [{ amount: 1 }] });
    expect(() => db('t').havingRaw('sum(??) <> ?', ['t.amount', 5])).toThrow(
      'mockDb: unsupported HAVING operator "<>"',
    );
  });

  it('throws on a raw fragment neither modelled shape parses', () => {
    // The regex fallthrough returned the builder with NO predicate pushed, so a
    // production change to the emitted raw shape read as "the HAVING matched".
    const db = createMockDb({ t: [{ amount: 1 }] });
    expect(() => db('t').havingRaw('sum(amount) > 5', [])).toThrow(
      /unsupported havingRaw fragment/,
    );
  });

  it('still applies a HAVING it does model', async () => {
    const db = createMockDb({
      t: [
        { region: 'west', amount: 100 },
        { region: 'east', amount: 1 },
      ],
    });
    const rows = await db('t')
      .sum({ total: 't.amount' })
      .groupBy(['t.region'])
      .havingRaw('sum(??) > ?', ['t.amount', 50]);
    expect(rows).toEqual([{ region: 'west', total: 100 }]);
  });
});

describe('mockDb — failClosedBuilder', () => {
  it('throws when production calls a builder method the double never modelled', () => {
    // A double built as `for (const m of [...]) qb[m] = () => qb` accepts every
    // call and models none: `join()` discarded its ON-clause callback, so
    // `applySecurityPredicatesToJoinOn` never ran and deleting it changed
    // nothing.
    const qb = failClosedBuilder({ where: () => 'ok' } as any, 'testDouble');
    expect(qb.where()).toBe('ok');
    expect(() => qb.leftJoin).toThrow(/unmodelled Knex builder method "leftJoin"/);
    expect(() => qb.havingRaw).toThrow('testDouble: unmodelled Knex builder method "havingRaw"');
  });

  it('lets ordinary object/symbol property access through', () => {
    // Awaiting, logging and asserting on the builder must keep working — only a
    // genuinely-unknown Knex method is an error.
    const qb = failClosedBuilder({ where: () => 'ok' } as any, 'testDouble');
    expect(typeof qb.toString).toBe('function');
    expect(qb[Symbol.toStringTag]).toBeUndefined();
    expect(qb.hasOwnProperty('where')).toBe(true);
  });
});

describe('mockDb — timeout and raw argument checks', () => {
  it('rejects a timeout call that did not really apply a bound', () => {
    // `timeout() { return qb; }` ignored its arguments, so dropping the
    // `timeoutMs` argument in `applyQueryTimeout` looked identical to passing
    // 30_000.
    expect(() => assertTimeoutArgs('d', undefined, { cancel: false })).toThrow(
      /only bounds a query for a positive finite number/,
    );
    expect(() => assertTimeoutArgs('d', 0, { cancel: false })).toThrow(/positive finite number/);
    expect(() => assertTimeoutArgs('d', 30_000, undefined)).toThrow(
      /always passes \{ cancel: boolean \}/,
    );
    expect(() => assertTimeoutArgs('d', 30_000, {})).toThrow(/cancellation gate was bypassed/);
    expect(() => assertTimeoutArgs('d', 30_000, { cancel: false })).not.toThrow();
    expect(() => assertTimeoutArgs('d', 30_000, { cancel: true })).not.toThrow();
  });

  it('rejects a raw SQL shape it does not model', () => {
    expect(mockRaw('?? as ??', ['sales.total', 'revenue'])).toEqual({
      kind: 'raw',
      physicalColumn: 'sales.total',
      alias: 'revenue',
    });
    expect(() => mockRaw('count(*) as ??', ['n'])).toThrow(/unsupported raw SQL shape/);
  });
});
