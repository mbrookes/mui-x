/**
 * Lightweight in-memory mock Knex query builder for tests.
 *
 * Implements the subset of the Knex API used by x-studio-server:
 *   db(table), .where(), .whereIn(), .count(), .select(), .orderBy(), .limit()
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
  count(expr: string): MockQueryBuilder;
  select(columns: string | string[]): MockQueryBuilder;
  orderBy(column: string, dir?: string): MockQueryBuilder;
  limit(n: number): MockQueryBuilder;
  sum(expr: string): MockQueryBuilder;
  avg(expr: string): MockQueryBuilder;
  groupBy(columns: string | string[]): MockQueryBuilder;
  first(): Promise<Row | undefined>;
  then(resolve: (rows: Row[]) => void, reject?: (err: Error) => void): void;
}

export function createMockDb(tables: Tables): (table: string) => MockQueryBuilder {
  return function db(table: string): MockQueryBuilder {
    let rows = [...(tables[table] ?? [])];
    let isCount = false;
    let countAlias = 'count';
    let selectedColumns: string[] | null = null;
    let limitValue: number | null = null;
    let orderByClause: { column: string; dir: string } | null = null;

    const predicates: Array<(row: Row) => boolean> = [];

    const qb: MockQueryBuilder = {
      where(column: string, opOrValue: unknown, value?: unknown) {
        if (value !== undefined) {
          const op = opOrValue as string;
          if (op === '=' || op === '==') {
            predicates.push((row) => row[column] === value);
          } else if (op === '!=') {
            predicates.push((row) => row[column] !== value);
          } else if (op === '<') {
            predicates.push((row) => (row[column] as number) < (value as number));
          } else if (op === '<=') {
            predicates.push((row) => (row[column] as number) <= (value as number));
          } else if (op === '>') {
            predicates.push((row) => (row[column] as number) > (value as number));
          } else if (op === '>=') {
            predicates.push((row) => (row[column] as number) >= (value as number));
          }
        } else {
          predicates.push((row) => row[column] === opOrValue);
        }
        return qb;
      },
      whereIn(column: string, values: unknown[]) {
        predicates.push((row) => values.includes(row[column]));
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
      count(expr: string) {
        isCount = true;
        countAlias = expr.includes(' as ') ? expr.split(' as ')[1].trim() : 'count';
        return qb;
      },
      select(columns: string | string[]) {
        selectedColumns = Array.isArray(columns) ? columns : [columns];
        return qb;
      },
      orderBy(column: string, dir = 'asc') {
        orderByClause = { column, dir };
        return qb;
      },
      limit(n: number) {
        limitValue = n;
        return qb;
      },
      sum() {
        return qb; // Not needed for current tests
      },
      avg() {
        return qb;
      },
      groupBy() {
        return qb;
      },
      async first() {
        const filtered = rows.filter((row) => predicates.every((p) => p(row)));
        if (isCount) {
          return { [countAlias]: filtered.length };
        }
        return filtered[0];
      },
      then(resolve, reject) {
        try {
          let filtered = rows.filter((row) => predicates.every((p) => p(row)));

          if (isCount) {
            resolve([{ [countAlias]: filtered.length }]);
            return;
          }

          if (orderByClause) {
            const { column, dir } = orderByClause;
            filtered.sort((a, b) => {
              const av = a[column] as string | number;
              const bv = b[column] as string | number;
              if (av < bv) return dir === 'asc' ? -1 : 1;
              if (av > bv) return dir === 'asc' ? 1 : -1;
              return 0;
            });
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
        } catch (e) {
          reject?.(e as Error);
        }
      },
    };

    return qb;
  };
}
