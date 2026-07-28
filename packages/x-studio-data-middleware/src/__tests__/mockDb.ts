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
 * `.sum()`/`.avg()`/`.count()`/`.min()`/`.max()` accept EITHER a `"column as
 * alias"` string OR Knex's object/alias-map form (`{ [alias]: column }`) —
 * `executeForTier` uses the latter (see finding 2.2) to route the aggregate
 * column+alias through Knex's identifier-wrapping instead of string
 * interpolation. Both forms resolve to the same internal `AggSpec`.
 *
 * This avoids any native SQLite driver dependency in tests.
 */

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

/** Result of `db.raw('?? as ??', [physicalColumn, logicalAlias])`. */
interface RawExpr {
  kind: 'raw';
  physicalColumn: string;
  alias: string;
}

function isRawExpr(value: unknown): value is RawExpr {
  return typeof value === 'object' && value !== null && (value as RawExpr).kind === 'raw';
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
function rowKeyOf(column: string): string {
  return column.includes('.') ? column.split('.').pop()! : column;
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
function sqlValueEquals(rowValue: unknown, boundValue: unknown): boolean {
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
        // Strip table prefix (e.g. "sales.tenant_id" → "tenant_id") for mock row lookup
        const key = rowKeyOf(column);
        if (value !== undefined) {
          const op = opOrValue as string;
          if (op === '=' || op === '==') {
            predicates.push((row) => row[key] === value);
          } else if (op === '!=') {
            predicates.push((row) => row[key] !== value);
          } else if (op === '<') {
            predicates.push((row) => (row[key] as number) < (value as number));
          } else if (op === '<=') {
            predicates.push((row) => (row[key] as number) <= (value as number));
          } else if (op === '>') {
            predicates.push((row) => (row[key] as number) > (value as number));
          } else if (op === '>=') {
            predicates.push((row) => (row[key] as number) >= (value as number));
          }
        } else {
          predicates.push((row) => row[key] === opOrValue);
        }
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
        predicates.push((row) => values.some((value) => sqlValueEquals(row[key], value)));
        return qb;
      },
      whereLike(column: string, pattern: string) {
        const key = rowKeyOf(column);
        const regex = new RegExp(`^${pattern.replace(/%/g, '.*').replace(/_/g, '.')}$`, 'i');
        predicates.push((row) => regex.test(String(row[key])));
        return qb;
      },
      whereBetween(column: string, [lo, hi]: [unknown, unknown]) {
        const key = rowKeyOf(column);
        predicates.push(
          (row) => (row[key] as number) >= (lo as number) && (row[key] as number) <= (hi as number),
        );
        return qb;
      },
      havingRaw(expr: string, bindings: unknown[]) {
        // The handler now re-emits the aggregate EXPRESSION rather than the SELECT
        // output alias for cross-dialect portability (finding 2.5): the raw shape is
        // `FUNC(??) op ?` with bindings `[physicalColumn, value]`. The mock keeps its
        // aggregation results keyed by ALIAS, so resolve the referenced aggregate
        // back to its alias by matching (func, column) against the recorded
        // `aggSpecs`. (The predicate closure runs at `then()` time, by which point
        // `aggSpecs` — populated after `havingRaw` in `executeForTier` — is filled.)
        const compare = (v: number, op: string, value: number): boolean => {
          switch (op) {
            case '=':
              return v === value;
            case '>':
              return v > value;
            case '<':
              return v < value;
            case '>=':
              return v >= value;
            case '<=':
              return v <= value;
            default:
              return true;
          }
        };
        const funcMatch = expr.match(/^([A-Za-z]+)\(\?\?\)\s*([<>=!]+)\s*\?$/);
        if (funcMatch) {
          const func = funcMatch[1].toLowerCase();
          const op = funcMatch[2];
          const [physical, value] = bindings as [string, number];
          const physKey = rowKeyOf(physical);
          havingPredicates.push((row) => {
            const spec = aggSpecs.find((a) => {
              const specKey = rowKeyOf(a.column);
              return a.func === func && specKey === physKey;
            });
            const key = spec ? spec.alias : physKey;
            return compare(row[key] as number, op, value);
          });
          return qb;
        }
        // Legacy "?? op ?" shape (bindings [alias, value]) — kept for any direct
        // caller still emitting the alias form.
        const opMatch = expr.match(/\?\?\s*([<>=!]+)\s*\?/);
        if (opMatch) {
          const op = opMatch[1];
          const [alias, value] = bindings as [string, number];
          havingPredicates.push((row) => compare(row[alias] as number, op, value));
        }
        return qb;
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

            // Apply ORDER BY
            for (const { column, dir } of orderByClauses) {
              result.sort((a, b) => {
                const av = a[column] as string | number;
                const bv = b[column] as string | number;
                if (av < bv) {
                  return dir === 'asc' ? -1 : 1;
                }
                if (av > bv) {
                  return dir === 'asc' ? 1 : -1;
                }
                return 0;
              });
            }

            // Apply LIMIT
            if (limitValue !== null) {
              result = result.slice(0, limitValue);
            }

            resolve(result);
            return;
          }

          // Raw rows path
          if (orderByClauses.length > 0) {
            // Apply each ORDER BY clause in sequence (last wins for equal values)
            for (const { column, dir } of orderByClauses) {
              filtered.sort((a, b) => {
                const av = a[column] as string | number;
                const bv = b[column] as string | number;
                if (av < bv) {
                  return dir === 'asc' ? -1 : 1;
                }
                if (av > bv) {
                  return dir === 'asc' ? 1 : -1;
                }
                return 0;
              });
            }
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
                  // (finding 1.1) — for a single-table query that returns the whole
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

  db.raw = (sql: string, bindings: unknown[]): RawExpr => {
    // Only the "?? as ??" pattern used by executeForTier() is supported.
    if (!/^\?\?\s+as\s+\?\?$/i.test(sql.trim())) {
      throw new Error(
        `mockDb.raw(): unsupported raw SQL shape "${sql}" — only "?? as ??" is implemented.`,
      );
    }
    const [physicalColumn, alias] = bindings as [string, string];
    return { kind: 'raw', physicalColumn, alias };
  };

  return db;
}
