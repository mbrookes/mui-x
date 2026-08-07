/**
 * Lightweight in-memory mock Knex query builder for tests.
 *
 * Implements the subset of the Knex API used by x-studio-data-middleware:
 *   db(table), .where(), .whereIn(), .whereLike(), .whereBetween(), .count(),
 *   .select(), .orderBy(), .limit(), .sum(), .avg(), .min(), .max(), .groupBy()
 *   — with real in-memory filtering and aggregation
 *
 * Every column reference the real pipeline emits is table-qualified, so every
 * builder below resolves it through `rowKeyOf` before indexing a row (rows are
 * keyed by the bare column name), and value comparisons go through
 * `sqlValueEquals` so the mock models a SQL engine's type coercion instead of
 * JS `===`.
 *
 * Also implements a minimal `db.raw(sql, bindings)` — just enough to support the
 * one shape this package actually emits, `?? as ??` (used by `executeForTier` to
 * SELECT a physical column AS a logical `columnAliases` id in its `.select()`
 * projection list). This is NOT a general raw-SQL evaluator — it only recognizes
 * that one binding pattern, which is sufficient to exercise the `columnAliases`
 * success path end-to-end (as opposed to only being able to test that a
 * `columnAliases`-bearing descriptor crashes because `db.raw` didn't exist).
 *
 * `.sum()`/`.avg()`/`.count()`/`.min()`/`.max()` accept EITHER a `"column as alias"` string OR
 * Knex's object/alias-map form (`{ [alias]: column }`) — `executeForTier` uses the latter to route
 * the aggregate column+alias through Knex's identifier-wrapping instead of string interpolation.
 * Both forms resolve to the same internal `AggSpec`.
 *
 * This avoids any native SQLite driver dependency in tests.
 */

export type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

/** Result of `db.raw('?? as ??', [physicalColumn, logicalAlias])`. */
export interface RawExpr {
  kind: 'raw';
  physicalColumn: string;
  alias: string;
}

export function isRawExpr(value: unknown): value is RawExpr {
  return typeof value === 'object' && value !== null && (value as RawExpr).kind === 'raw';
}

/**
 * Wrap a hand-written Knex stand-in so that reading a property this double does
 * NOT model throws instead of returning `undefined`.
 *
 * WHY. A test double built as `for (const m of [...]) qb[m] = () => qb` accepts
 * every builder call and models none of them, so the production code under test
 * can stop calling a method — or start calling a new one — with no test ever
 * noticing. That is how `requestRowBudget.test.ts` ended up in a state where
 * deleting `applySecurityPredicates` outright produced byte-identical results,
 * and where `join()` discarded its ON-clause callback (the exact defect
 * `installRecordingJoins` in `handler.test.ts` was written to fix).
 *
 * Properties reachable through `Object.prototype` (`toString`, `then`-probing by
 * the runtime, symbol lookups such as `Symbol.toPrimitive` /
 * `util.inspect.custom`) are passed through untouched, so awaiting, logging and
 * asserting on the builder still behave normally. Only a genuinely-unknown named
 * property — i.e. a Knex builder method this double never modelled — throws.
 */
export function failClosedBuilder<T extends object>(target: T, label: string): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (typeof prop === 'symbol' || prop in obj) {
        return Reflect.get(obj, prop, receiver);
      }
      throw new Error(
        `${label}: unmodelled Knex builder method "${String(prop)}". This test double only implements the ` +
          `subset of the Knex API the code under test used when it was written, and it fails closed rather ` +
          `than accepting the call as a no-op — a silently-ignored builder call makes the assertions below ` +
          `pass for the wrong reason. Model "${String(prop)}" in this double (or assert against a real Knex ` +
          `builder in "router/__tests__/queryBuilder.test.ts").`,
      );
    },
  });
}

/**
 * Validate the arguments `applyQueryTimeout` (`shared/queryTimeout.ts`) passes to
 * Knex's `.timeout()`.
 *
 * The doubles used to declare `timeout() { return qb; }` — accepting ANY
 * argument, including none. That made the statement-timeout wiring
 * unobservable: dropping the `timeoutMs` argument, or passing `undefined`,
 * looked exactly like passing 30_000.
 */
export function assertTimeoutArgs(label: string, ms: unknown, opts: unknown): void {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) {
    throw new Error(
      `${label}: .timeout() received ${JSON.stringify(ms)}, but Knex only bounds a query for a positive ` +
        `finite number of milliseconds. "applyQueryTimeout" is documented to skip the call entirely for a ` +
        `non-positive timeout, so reaching this double with one means the statement timeout is not applied.`,
    );
  }
  if (typeof opts !== 'object' || opts === null || typeof (opts as any).cancel !== 'boolean') {
    throw new Error(
      `${label}: .timeout() received options ${JSON.stringify(opts)}, but "applyQueryTimeout" always passes ` +
        `{ cancel: boolean } — dialect-gated on "client.canCancelQuery". A missing or non-boolean "cancel" ` +
        `means the cancellation gate was bypassed.`,
    );
  }
}

/**
 * Build the predicate for one `.where()` call, modelling the OPERATOR rather than
 * discarding it.
 *
 * Shared by every Knex stand-in in this package's tests. Two of them used to
 * implement `where(column, opOrValue, value?)` as
 * `row[key] === (value !== undefined ? value : opOrValue)` — collapsing `!=`,
 * `<`, `>`, `>=`, `<=` and `like` into equality. Any production change that
 * altered which operator a predicate emits (exactly what F1's
 * `whereLike` → `where(col, 'like', ...)` switch was) therefore could not fail a
 * test.
 *
 * Fails closed on an operator this helper does not model: pushing NO predicate
 * would mean "the filter matched every row", which fails OPEN.
 */
/**
 * SQL three-valued logic, as a guard.
 *
 * A comparison against NULL is UNKNOWN, and a WHERE clause keeps only rows for which the predicate
 * is TRUE — so a NULL row value fails EVERY scalar comparison, including `<>`. That is not a detail
 * this mock can skip: it is the one place the two execution engines are documented to disagree
 * (`EXECUTION_SEMANTICS.md`, the degradation register — the in-memory evaluator KEEPS a NULL row
 * for `not_equals`, SQL drops it), so a mock that quietly returned JS answers instead
 * (`null != 'open'` is `true`; `null < 5` is `true`, because `null` coerces to `0`) reported the
 * two engines as agreeing on the exact case where they do not.
 *
 * `executionConformance.test.ts` is what surfaced this: its known-divergence case asserts the
 * divergence still EXISTS, and it failed here — against the mock, not against the product.
 */
function sqlComparable(rowValue: unknown): boolean {
  return rowValue !== null && rowValue !== undefined;
}

export function wherePredicate(
  column: string,
  opOrValue: unknown,
  value: unknown,
): (row: Row) => boolean {
  const key = rowKeyOf(column);
  if (value === undefined) {
    // Knex's 2-arg `.where(column, value)` — an equality comparison, so it must
    // use the same SQL-engine coercion rules as the 3-arg `=` branch below
    // rather than JS `===`.
    return (row) => sqlComparable(row[key]) && sqlValueEquals(row[key], opOrValue);
  }
  const op = opOrValue as string;
  switch (op) {
    case '=':
    case '==':
      return (row) => sqlComparable(row[key]) && sqlValueEquals(row[key], value);
    case '!=':
      // NOT `!sqlValueEquals(...)`. A NULL row value makes `col <> ?` UNKNOWN, so SQL drops the
      // row — see `sqlComparable`. This is the known divergence from the in-memory evaluator,
      // which keeps it.
      return (row) => sqlComparable(row[key]) && !sqlValueEquals(row[key], value);
    case '<':
      return (row) => sqlComparable(row[key]) && (row[key] as number) < (value as number);
    case '<=':
      return (row) => sqlComparable(row[key]) && (row[key] as number) <= (value as number);
    case '>':
      return (row) => sqlComparable(row[key]) && (row[key] as number) > (value as number);
    case '>=':
      return (row) => sqlComparable(row[key]) && (row[key] as number) >= (value as number);
    case 'like':
      // `applyPredicate`'s `like` branch emits the 3-arg form rather than
      // `.whereLike` — Knex's MySQL compiler appends `COLLATE utf8_bin` to
      // `whereLike` only. Without this branch the mock silently dropped
      // every `like` filter and returned the unfiltered table.
      return (row) => sqlComparable(row[key]) && likeMatches(row[key], value as string);
    default:
      // FAIL CLOSED on an operator this mock does not model. The `else` used to
      // fall through, pushing NO predicate — so a production change to an
      // unmodelled operator turned into "the filter matched every row" rather
      // than a test failure.
      throw new Error(`mockDb: unsupported where operator "${op}"`);
  }
}

/**
 * Model `db.raw()` for the one shape this package emits, `?? as ??`.
 *
 * Fails closed on anything else rather than returning an opaque token, so a new
 * raw fragment in production cannot slip through a test double as `{}`.
 */
export function mockRaw(sql: string, bindings: unknown[]): RawExpr {
  if (!/^\?\?\s+as\s+\?\?$/i.test(sql.trim())) {
    throw new Error(
      `mockDb.raw(): unsupported raw SQL shape "${sql}" — only "?? as ??" is implemented.`,
    );
  }
  const [physicalColumn, alias] = bindings as [string, string];
  return { kind: 'raw', physicalColumn, alias };
}

/**
 * Compare two result rows against an ORDER BY clause list, with the FIRST clause
 * primary — SQL's rule.
 *
 * The mock used to `sort()` once per clause in FORWARD order with a stable sort,
 * which makes the LAST clause the primary key: the exact INVERSE of SQL. A
 * multi-key ORDER BY therefore came back in an order no database would produce,
 * and a production bug that reordered the clause list could not be detected.
 */
export function compareByOrderBy(
  a: Row,
  b: Row,
  clauses: { column: string; dir: string }[],
): number {
  for (const { column, dir } of clauses) {
    const av = a[column] as string | number;
    const bv = b[column] as string | number;
    if (av < bv) {
      return dir === 'asc' ? -1 : 1;
    }
    if (av > bv) {
      return dir === 'asc' ? 1 : -1;
    }
  }
  return 0;
}

/**
 * Is `value` another builder from this mock (a semi-join subquery), rather than a
 * literal `whereIn` value list?
 *
 * Checks BOTH "not an array" and "thenable": an array is the ordinary value-list
 * form and must never be mistaken for a subquery, and a plain object with no
 * `then` cannot be drained.
 */
function isMockBuilder(value: unknown): value is MockQueryBuilder {
  return (
    !Array.isArray(value) &&
    typeof value === 'object' &&
    value !== null &&
    typeof (value as MockQueryBuilder).then === 'function'
  );
}

interface MockQueryBuilder {
  where(column: string, op: string, value: unknown): MockQueryBuilder;
  where(column: string, value: unknown): MockQueryBuilder;
  /**
   * `values` is either a literal list OR — for a SEMI-JOIN
   * (`buildSecureQuery`'s `applySemiJoins`) — another `MockQueryBuilder` standing
   * in for Knex's `whereIn(column, subqueryBuilder)` subquery form.
   */
  whereIn(column: string, values: unknown[] | MockQueryBuilder): MockQueryBuilder;
  whereLike(column: string, pattern: string): MockQueryBuilder;
  whereBetween(column: string, range: [unknown, unknown]): MockQueryBuilder;
  whereNot?: (column: string, value: unknown) => MockQueryBuilder;
  havingRaw(expr: string, bindings: unknown[]): MockQueryBuilder;
  count(expr: string | Record<string, string>): MockQueryBuilder;
  select(columns: string | (string | RawExpr)[]): MockQueryBuilder;
  orderBy(column: string, dir?: string): MockQueryBuilder;
  limit(n: number): MockQueryBuilder;
  /**
   * Knex's per-query statement timeout. Applied by `runBounded` /
   * `runPreflight` / the mutation dispatch helper to EVERY round-trip, so a mock
   * that lacks it fails with "timeout is not a function" — which is deliberate:
   * a builder this mock does not model must not silently pass.
   */
  timeout(ms: number, opts?: { cancel?: boolean }): MockQueryBuilder;
  sum(expr: string | Record<string, string>): MockQueryBuilder;
  avg(expr: string | Record<string, string>): MockQueryBuilder;
  min(expr: string | Record<string, string>): MockQueryBuilder;
  max(expr: string | Record<string, string>): MockQueryBuilder;
  groupBy(columns: string | string[]): MockQueryBuilder;
  first(): Promise<Row | undefined>;
  then(resolve: (rows: Row[]) => void, reject?: (err: Error) => void): void;
}

interface AggSpec {
  func: 'sum' | 'avg' | 'count' | 'min' | 'max';
  column: string;
  alias: string;
}

/**
 * The row key a (possibly table-qualified) column reference addresses.
 *
 * Rows in this mock are keyed by the BARE column name, while the real pipeline
 * qualifies every column reference it hands to Knex with its owning table
 * (`shared/columnValidation.ts`'s `qualifyAgainst`, applied by `queryBuilder.ts`
 * to join `on` sides / filter predicates / HAVING columns and by `execute.ts` to
 * the projection, GROUP BY and ORDER BY). Every predicate builder below must
 * strip that qualifier — `whereLike`/`whereBetween` did not, so once filter
 * columns became qualified they indexed `row['sales.product']` (always
 * `undefined`) and matched ZERO rows for every `like`/`between` filter.
 */
export function rowKeyOf(column: string): string {
  return column.includes('.') ? column.split('.').pop()! : column;
}

/**
 * Model SQL's `LIKE` pattern semantics (`%` → any run, `_` → any single char).
 *
 * Shared by the 3-arg `.where(column, 'like', pattern)` form the pipeline now
 * emits and the legacy `.whereLike(column, pattern)` builder this mock still
 * exposes, so the two can never disagree about what a pattern matches.
 */
export function likeMatches(rowValue: unknown, pattern: string): boolean {
  const regex = new RegExp(`^${pattern.replace(/%/g, '.*').replace(/_/g, '.')}$`, 'i');
  return regex.test(String(rowValue));
}

/**
 * Compare one row value against one bound predicate value the way a SQL engine
 * would, rather than with JS `===`.
 *
 * The security predicates bind region ids as canonical decimal STRINGS
 * (`shared/predicates.ts`) and let the engine coerce them against the column's
 * type. A strict `===` mock would therefore never match a numerically-typed
 * region column, so it models the engine's rule instead: the COLUMN's type
 * decides the comparison. A numeric row value compares numerically (`'5'` matches
 * `5`); a string row value compares as a string (`'5'` matches `'5'` but NOT
 * `'05'` — the exact widening the string-only binding exists to prevent).
 */
export function sqlValueEquals(rowValue: unknown, boundValue: unknown): boolean {
  if (rowValue === boundValue) {
    return true;
  }
  if (typeof rowValue === 'number' && typeof boundValue === 'string') {
    return boundValue.trim() !== '' && Number(boundValue) === rowValue;
  }
  if (typeof rowValue === 'string' && typeof boundValue === 'number') {
    return rowValue.trim() !== '' && Number(rowValue) === boundValue;
  }
  return false;
}

function computeAgg(func: AggSpec['func'], groupRows: Row[], column: string): number {
  if (func === 'count') {
    return groupRows.filter((r) => r[column] != null).length;
  }
  const values = groupRows
    .map((r) => r[column] as number)
    .filter((v) => v != null && !Number.isNaN(v));
  if (values.length === 0) {
    return 0;
  }
  switch (func) {
    case 'sum':
      return values.reduce((acc, v) => acc + v, 0);
    case 'avg':
      return values.reduce((acc, v) => acc + v, 0) / values.length;
    case 'min':
      return Math.min(...values);
    case 'max':
      return Math.max(...values);
    default:
      return 0;
  }
}

export function createMockDb(
  tables: Tables,
): ((table: string) => MockQueryBuilder) & { raw: (sql: string, bindings: unknown[]) => RawExpr } {
  const db = function db(table: string): MockQueryBuilder {
    const rows = [...(tables[table] ?? [])];
    let isStarCount = false;
    let starCountAlias = 'count';
    let selectedColumns: (string | RawExpr)[] | null = null;
    let groupByColumns: string[] | null = null;
    let limitValue: number | null = null;
    const orderByClauses: { column: string; dir: string }[] = [];
    const aggSpecs: AggSpec[] = [];

    const predicates: Array<(row: Row) => boolean> = [];
    const havingPredicates: Array<(row: Row) => boolean> = [];

    const parseExpr = (
      expr: string | Record<string, string>,
    ): { column: string; alias: string } => {
      if (typeof expr === 'string') {
        const parts = expr.split(' as ');
        return { column: parts[0].trim(), alias: parts[1]?.trim() ?? parts[0].trim() };
      }
      // Knex's object/alias-map form: `{ [alias]: column }`.
      const [alias, column] = Object.entries(expr)[0];
      return { column, alias };
    };

    const qb: MockQueryBuilder = {
      where(column: string, opOrValue: unknown, value?: unknown) {
        // `wherePredicate` strips the table prefix (e.g. "sales.tenant_id" →
        // "tenant_id") for mock row lookup, models the OPERATOR, and fails closed
        // on one it does not implement. Shared with the other Knex stand-ins in
        // this package so they cannot disagree about what an operator means.
        predicates.push(wherePredicate(column, opOrValue, value));
        return qb;
      },
      whereIn(column: string, values: unknown[] | MockQueryBuilder) {
        const key = rowKeyOf(column);
        // SEMI-JOIN (`whereIn(column, subqueryBuilder)`). Knex renders a builder
        // passed here as `column IN (SELECT … )`; this mock materializes the
        // subquery's single projected column into the allowed-value set instead.
        //
        // Materialized LAZILY (inside the predicate, memoized) rather than now:
        // `buildSecureQuery` attaches the subquery's own security predicates and
        // filters BEFORE handing it to `whereIn`, but a NESTED semi-join's
        // predicates are attached to the same builder in the same pass, so
        // draining it eagerly would read a partially-built subquery. Every
        // predicate closure in this mock already runs at `then()` time, by which
        // point the whole tree is built.
        if (isMockBuilder(values)) {
          let allowed: unknown[] | null = null;
          predicates.push((row) => {
            if (allowed === null) {
              const drained: unknown[] = [];
              // `then` resolves synchronously in this mock.
              values.then((subRows) => {
                for (const subRow of subRows) {
                  // The subquery projects exactly one column
                  // (`applySemiJoins`'s `select(foreignColumn)`), so the row has
                  // exactly one value — read it positionally rather than by name,
                  // since the projected key is the foreign table's column name,
                  // not the outer `column`.
                  drained.push(Object.values(subRow)[0]);
                }
              });
              allowed = drained;
            }
            // A NULL outer key matches nothing: SQL's `NULL IN (…)` is UNKNOWN,
            // which a WHERE treats as "exclude" — the same rule
            // `dataSourceGraph`'s `normalizeJoinKey(...) !== null` guard applies
            // in memory. `sqlValueEquals` would otherwise report `null === null`
            // for a subquery row carrying a NULL foreign key.
            const outerValue = row[key];
            if (outerValue === null || outerValue === undefined) {
              return false;
            }
            return allowed.some((value) => sqlValueEquals(outerValue, value));
          });
          return qb;
        }
        // Type-directed comparison rather than `values.includes(row[key])` — see
        // `sqlValueEquals`. An empty `values` still matches nothing, mirroring the
        // `1 = 0` Knex renders for `whereIn(col, [])`.
        predicates.push(
          (row) =>
            sqlComparable(row[key]) && values.some((value) => sqlValueEquals(row[key], value)),
        );
        return qb;
      },
      whereLike(column: string, pattern: string) {
        const key = rowKeyOf(column);
        predicates.push((row) => likeMatches(row[key], pattern));
        return qb;
      },
      whereBetween(column: string, [lo, hi]: [unknown, unknown]) {
        const key = rowKeyOf(column);
        predicates.push(
          (row) =>
            sqlComparable(row[key]) &&
            (row[key] as number) >= (lo as number) &&
            (row[key] as number) <= (hi as number),
        );
        return qb;
      },
      havingRaw(expr: string, bindings: unknown[]) {
        // The handler now re-emits the aggregate EXPRESSION rather than the SELECT
        // output alias for cross-dialect portability: the raw shape is
        // `FUNC(??) op ?` with bindings `[physicalColumn, value]`. The mock keeps its
        // aggregation results keyed by ALIAS, so resolve the referenced aggregate
        // back to its alias by matching (func, column) against the recorded
        // `aggSpecs`. (The predicate closure runs at `then()` time, by which point
        // `aggSpecs` — populated after `havingRaw` in `executeForTier` — is filled.)
        //
        // FAILS CLOSED on an operator it does not model. `default: return true`
        // meant an unrecognized HAVING operator matched EVERY group — the same
        // fail-open shape as a dropped WHERE predicate, and precisely the outcome
        // `applyHaving`'s own "admitting it would … drop the predicate, returning
        // every aggregation group as though the filter had matched them all"
        // error exists to prevent.
        // Resolved EAGERLY, at `havingRaw()` time rather than inside the deferred
        // predicate, so an unmodelled operator surfaces where it was emitted.
        const comparatorFor = (op: string): ((v: number, value: number) => boolean) => {
          switch (op) {
            case '=':
              return (v, value) => v === value;
            case '>':
              return (v, value) => v > value;
            case '<':
              return (v, value) => v < value;
            case '>=':
              return (v, value) => v >= value;
            case '<=':
              return (v, value) => v <= value;
            default:
              throw new Error(`mockDb: unsupported HAVING operator "${op}"`);
          }
        };
        const funcMatch = expr.match(/^([A-Za-z]+)\(\?\?\)\s*([<>=!]+)\s*\?$/);
        if (funcMatch) {
          const func = funcMatch[1].toLowerCase();
          const compare = comparatorFor(funcMatch[2]);
          const [physical, value] = bindings as [string, number];
          const physKey = rowKeyOf(physical);
          havingPredicates.push((row) => {
            const spec = aggSpecs.find((a) => {
              const specKey = rowKeyOf(a.column);
              return a.func === func && specKey === physKey;
            });
            const key = spec ? spec.alias : physKey;
            return compare(row[key] as number, value);
          });
          return qb;
        }
        // Legacy "?? op ?" shape (bindings [alias, value]) — kept for any direct
        // caller still emitting the alias form.
        const opMatch = expr.match(/\?\?\s*([<>=!]+)\s*\?/);
        if (opMatch) {
          const compare = comparatorFor(opMatch[1]);
          const [alias, value] = bindings as [string, number];
          havingPredicates.push((row) => compare(row[alias] as number, value));
          return qb;
        }
        // FAIL CLOSED on a HAVING fragment neither shape recognizes. Returning
        // `qb` with NO predicate pushed made an unparsed HAVING match every
        // group, so a production change to the emitted raw shape would have
        // looked like "the HAVING filter is satisfied" instead of a test failure.
        throw new Error(
          `mockDb: unsupported havingRaw fragment "${expr}" — only "FUNC(??) <op> ?" and the legacy ` +
            `"?? <op> ?" shapes are modelled. Pushing no predicate would make this HAVING match every group.`,
        );
      },
      count(expr: string | Record<string, string>) {
        const { column, alias } = parseExpr(expr);
        if (column === '*') {
          isStarCount = true;
          starCountAlias = alias;
        } else {
          aggSpecs.push({ func: 'count', column, alias });
        }
        return qb;
      },
      sum(expr: string | Record<string, string>) {
        const { column, alias } = parseExpr(expr);
        aggSpecs.push({ func: 'sum', column, alias });
        return qb;
      },
      avg(expr: string | Record<string, string>) {
        const { column, alias } = parseExpr(expr);
        aggSpecs.push({ func: 'avg', column, alias });
        return qb;
      },
      min(expr: string | Record<string, string>) {
        const { column, alias } = parseExpr(expr);
        aggSpecs.push({ func: 'min', column, alias });
        return qb;
      },
      max(expr: string | Record<string, string>) {
        const { column, alias } = parseExpr(expr);
        aggSpecs.push({ func: 'max', column, alias });
        return qb;
      },
      select(columns: string | (string | RawExpr)[]) {
        selectedColumns = Array.isArray(columns) ? columns : [columns];
        return qb;
      },
      orderBy(column: string, dir = 'asc') {
        // Strip any "table." qualifier so the sort key matches the row keys
        // (rows are keyed by the bare column name in this mock). The real
        // `executeForTier` qualifies unqualified ORDER BY columns with the
        // primary table to avoid join ambiguity.
        const key = rowKeyOf(column);
        orderByClauses.push({ column: key, dir });
        return qb;
      },
      limit(n: number) {
        limitValue = n;
        return qb;
      },
      // Recorded-and-ignored: this mock resolves synchronously, so there is
      // nothing to time out. Its presence is what lets the real code path apply
      // the statement timeout without the mock throwing — but the ARGUMENTS
      // are checked, because a `timeout()` that ignores them cannot tell a real
      // 30s bound apart from `timeout(undefined)`.
      timeout(ms: number, opts?: { cancel?: boolean }) {
        assertTimeoutArgs('mockDb', ms, opts);
        return qb;
      },
      groupBy(columns: string | string[]) {
        groupByColumns = Array.isArray(columns) ? columns : [columns];
        return qb;
      },
      async first() {
        const filtered = rows.filter((row) => predicates.every((p) => p(row)));
        if (isStarCount) {
          return { [starCountAlias]: filtered.length };
        }
        return filtered[0];
      },
      then(resolve, reject) {
        try {
          let filtered = rows.filter((row) => predicates.every((p) => p(row)));

          if (isStarCount) {
            resolve([{ [starCountAlias]: filtered.length }]);
            return;
          }

          if (aggSpecs.length > 0) {
            // In-memory aggregation (with optional GROUP BY)
            let result: Row[];
            if (groupByColumns && groupByColumns.length > 0) {
              const groups = new Map<string, Row[]>();
              for (const row of filtered) {
                const key = groupByColumns
                  .map((c) => {
                    const k = rowKeyOf(c);
                    return String(row[k]);
                  })
                  .join('\x00');
                if (!groups.has(key)) {
                  groups.set(key, []);
                }
                groups.get(key)!.push(row);
              }
              result = [...groups.values()].map((groupRows) => {
                const outRow: Row = {};
                for (const col of groupByColumns!) {
                  const k = rowKeyOf(col);
                  outRow[k] = groupRows[0][k];
                }
                for (const agg of aggSpecs) {
                  const k = rowKeyOf(agg.column);
                  outRow[agg.alias] = computeAgg(agg.func, groupRows, k);
                }
                return outRow;
              });
            } else {
              // Global aggregation: single result row
              const outRow: Row = {};
              for (const agg of aggSpecs) {
                const k = rowKeyOf(agg.column);
                outRow[agg.alias] = computeAgg(agg.func, filtered, k);
              }
              result = [outRow];
            }

            // Apply HAVING predicates
            if (havingPredicates.length > 0) {
              result = result.filter((row) => havingPredicates.every((p) => p(row)));
            }

            // Apply ORDER BY — one comparator over the WHOLE clause list, so the
            // FIRST clause is the primary key (see `compareByOrderBy`).
            if (orderByClauses.length > 0) {
              result.sort((a, b) => compareByOrderBy(a, b, orderByClauses));
            }

            // Apply LIMIT
            if (limitValue !== null) {
              result = result.slice(0, limitValue);
            }

            resolve(result);
            return;
          }

          // Raw rows path. One comparator over every clause, FIRST clause
          // primary — the mock used to `sort()` once per clause in FORWARD order
          // with a stable sort, which makes the LAST clause primary: the exact
          // INVERSE of SQL's `ORDER BY a, b`.
          if (orderByClauses.length > 0) {
            filtered.sort((a, b) => compareByOrderBy(a, b, orderByClauses));
          }

          if (limitValue !== null) {
            filtered = filtered.slice(0, limitValue);
          }

          if (selectedColumns) {
            filtered = filtered.map((row) => {
              const projected: Row = {};
              for (const col of selectedColumns!) {
                if (isRawExpr(col)) {
                  // db.raw('?? as ??', [physicalColumn, logicalAlias]) — resolve the
                  // physical column (stripping any "table." qualifier) and project
                  // its value under the logical alias, mirroring `SELECT phys AS alias`.
                  const physKey = rowKeyOf(col.physicalColumn);
                  projected[col.alias] = row[physKey];
                } else if (col === '*' || col.endsWith('.*')) {
                  // Wildcard projection: a bare `*` or a table-qualified `table.*`
                  // selects EVERY column of the row (mirroring SQL). `executeForTier`
                  // emits `table.*` for the `columnAllowlist[table] === ['*']` opt-out
                  //  — for a single-table query that returns the whole
                  // row, exactly like the previous bare-SELECT-* behavior.
                  Object.assign(projected, row);
                } else {
                  // Handle "table.column" qualified names
                  const key = rowKeyOf(col);
                  projected[key] = row[key];
                }
              }
              return projected;
            });
          }

          resolve(filtered);
        } catch (err) {
          reject?.(err as Error);
        }
      },
    };

    return qb;
  };

  // Only the "?? as ??" pattern used by executeForTier() is supported.
  db.raw = mockRaw;

  return db;
}
