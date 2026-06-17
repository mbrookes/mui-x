/**
 * Lightweight in-memory mock Knex query builder for tests.
 *
 * Implements the subset of the Knex API used by x-studio-data-middleware:
 *   db(table), .where(), .whereIn(), .count(), .select(), .orderBy(), .limit()
 *   .sum(), .avg(), .min(), .max(), .groupBy() — with real in-memory aggregation
 *
 * This avoids any native SQLite driver dependency in tests.
 */

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

interface MockQueryBuilder {
  where(column: string, op: string, value: unknown): MockQueryBuilder;
  where(column: string, value: unknown): MockQueryBuilder;
  whereIn(column: string, values: unknown[]): MockQueryBuilder;
  whereLike(column: string, pattern: string): MockQueryBuilder;
  whereBetween(column: string, range: [unknown, unknown]): MockQueryBuilder;
  whereNot?: (column: string, value: unknown) => MockQueryBuilder;
  havingRaw(expr: string, bindings: unknown[]): MockQueryBuilder;
  count(expr: string): MockQueryBuilder;
  select(columns: string | string[]): MockQueryBuilder;
  orderBy(column: string, dir?: string): MockQueryBuilder;
  limit(n: number): MockQueryBuilder;
  sum(expr: string): MockQueryBuilder;
  avg(expr: string): MockQueryBuilder;
  min(expr: string): MockQueryBuilder;
  max(expr: string): MockQueryBuilder;
  groupBy(columns: string | string[]): MockQueryBuilder;
  first(): Promise<Row | undefined>;
  then(resolve: (rows: Row[]) => void, reject?: (err: Error) => void): void;
}

interface AggSpec {
  func: 'sum' | 'avg' | 'count' | 'min' | 'max';
  column: string;
  alias: string;
}

function computeAgg(func: AggSpec['func'], groupRows: Row[], column: string): number {
  if (func === 'count') {
    return groupRows.filter((r) => r[column] != null).length;
  }
  const values = groupRows.map((r) => r[column] as number).filter((v) => v != null && !isNaN(v));
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

export function createMockDb(tables: Tables): (table: string) => MockQueryBuilder {
  return function db(table: string): MockQueryBuilder {
    const rows = [...(tables[table] ?? [])];
    let isStarCount = false;
    let starCountAlias = 'count';
    let selectedColumns: string[] | null = null;
    let groupByColumns: string[] | null = null;
    let limitValue: number | null = null;
    const orderByClauses: { column: string; dir: string }[] = [];
    const aggSpecs: AggSpec[] = [];

    const predicates: Array<(row: Row) => boolean> = [];
    const havingPredicates: Array<(row: Row) => boolean> = [];

    const parseExpr = (expr: string): { column: string; alias: string } => {
      const parts = expr.split(' as ');
      return { column: parts[0].trim(), alias: parts[1]?.trim() ?? parts[0].trim() };
    };

    const qb: MockQueryBuilder = {
      where(column: string, opOrValue: unknown, value?: unknown) {
        // Strip table prefix (e.g. "sales.tenant_id" → "tenant_id") for mock row lookup
        const key = column.includes('.') ? column.split('.')[1] : column;
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
      whereIn(column: string, values: unknown[]) {
        const key = column.includes('.') ? column.split('.')[1] : column;
        predicates.push((row) => values.includes(row[key]));
        return qb;
      },
      whereLike(column: string, pattern: string) {
        const regex = new RegExp(`^${pattern.replace(/%/g, '.*').replace(/_/g, '.')}$`, 'i');
        predicates.push((row) => regex.test(String(row[column])));
        return qb;
      },
      whereBetween(column: string, [lo, hi]: [unknown, unknown]) {
        predicates.push(
          (row) =>
            (row[column] as number) >= (lo as number) && (row[column] as number) <= (hi as number),
        );
        return qb;
      },
      havingRaw(expr: string, bindings: unknown[]) {
        // Parse "?? op ?" with alias and value bindings
        const [alias, value] = bindings as [string, number];
        const opMatch = expr.match(/\?\?\s*([<>=!]+)\s*\?/);
        if (opMatch) {
          const op = opMatch[1];
          havingPredicates.push((row) => {
            const v = row[alias] as number;
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
          });
        }
        return qb;
      },
      count(expr: string) {
        const { column, alias } = parseExpr(expr);
        if (column === '*') {
          isStarCount = true;
          starCountAlias = alias;
        } else {
          aggSpecs.push({ func: 'count', column, alias });
        }
        return qb;
      },
      sum(expr: string) {
        const { column, alias } = parseExpr(expr);
        aggSpecs.push({ func: 'sum', column, alias });
        return qb;
      },
      avg(expr: string) {
        const { column, alias } = parseExpr(expr);
        aggSpecs.push({ func: 'avg', column, alias });
        return qb;
      },
      min(expr: string) {
        const { column, alias } = parseExpr(expr);
        aggSpecs.push({ func: 'min', column, alias });
        return qb;
      },
      max(expr: string) {
        const { column, alias } = parseExpr(expr);
        aggSpecs.push({ func: 'max', column, alias });
        return qb;
      },
      select(columns: string | string[]) {
        selectedColumns = Array.isArray(columns) ? columns : [columns];
        return qb;
      },
      orderBy(column: string, dir = 'asc') {
        orderByClauses.push({ column, dir });
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
                    const k = c.includes('.') ? c.split('.')[1] : c;
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
                  const k = col.includes('.') ? col.split('.')[1] : col;
                  outRow[k] = groupRows[0][k];
                }
                for (const agg of aggSpecs) {
                  const k = agg.column.includes('.') ? agg.column.split('.')[1] : agg.column;
                  outRow[agg.alias] = computeAgg(agg.func, groupRows, k);
                }
                return outRow;
              });
            } else {
              // Global aggregation: single result row
              const outRow: Row = {};
              for (const agg of aggSpecs) {
                const k = agg.column.includes('.') ? agg.column.split('.')[1] : agg.column;
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
                // Handle "table.column" qualified names
                const key = col.includes('.') ? col.split('.')[1] : col;
                projected[key] = row[key];
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
}
