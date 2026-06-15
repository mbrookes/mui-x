/* eslint-disable no-console */
/**
 * Benchmark measurement harness for x-studio-server pipeline stages.
 *
 * Runs a SQL statement N times (with one warm-up pass to prime SQLite's
 * query plan cache) and returns timing statistics.
 *
 * Uses Node.js built-in `node:sqlite` (Node 22+).
 */
import { performance } from 'perf_hooks';
import { DatabaseSync } from 'node:sqlite';

export interface BenchResult {
  label: string;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  rowsReturned: number;
  iterations: number;
}

/**
 * Measure query execution time over multiple iterations.
 * Includes one warm-up pass (not counted) to prime SQLite's plan cache.
 */
export function bench(
  db: DatabaseSync,
  label: string,
  sql: string,
  params: unknown[] = [],
  iterations = 20,
): BenchResult {
  const stmt = db.prepare(sql);

  // Warm-up: primes query plan cache; result not measured
  stmt.all(...params);

  const times: number[] = [];
  let rowsReturned = 0;

  for (let i = 0; i < iterations; i += 1) {
    const t0 = performance.now();
    const rows = stmt.all(...params) as unknown[];
    times.push(performance.now() - t0);
    if (i === 0) {
      rowsReturned = rows.length;
    }
  }

  times.sort((a, b) => a - b);

  return {
    label,
    avgMs: times.reduce((a, b) => a + b, 0) / iterations,
    p50Ms: times[Math.floor(iterations * 0.5)],
    p95Ms: times[Math.floor(iterations * 0.95)],
    minMs: times[0],
    maxMs: times[iterations - 1],
    rowsReturned,
    iterations,
  };
}

/**
 * Run the standard benchmark suite against a database.
 */
export function runSuite(db: DatabaseSync, tenantId = 'acme'): BenchResult[] {
  return [
    bench(
      db,
      'COUNT(*) preflight — tenant+region (indexed)',
      'SELECT COUNT(*) as cnt FROM sales WHERE tenant_id = ? AND region = ?',
      [tenantId, 'west'],
    ),
    bench(
      db,
      'GROUP BY region + SUM (full tenant)',
      `SELECT region, SUM(amount) AS revenue, COUNT(*) AS cnt
       FROM sales WHERE tenant_id = ? GROUP BY region ORDER BY revenue DESC`,
      [tenantId],
    ),
    bench(
      db,
      'Time-series: daily revenue last 30d',
      `SELECT sale_date, SUM(amount) AS daily_total
       FROM sales WHERE tenant_id = ? AND sale_date >= date('now', '-30 days')
       GROUP BY sale_date ORDER BY sale_date`,
      [tenantId],
    ),
    bench(
      db,
      'Full filtered scan — tenant only (no aggregation)',
      'SELECT * FROM sales WHERE tenant_id = ?',
      [tenantId],
    ),
  ];
}

/** Pretty-print a results table to the console. */
export function printResults(results: BenchResult[], heading?: string): void {
  if (heading) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`  ${heading}`);
    console.log('─'.repeat(70));
  }

  const table = results.map((r) => ({
    label: r.label.slice(0, 48),
    'avg ms': r.avgMs.toFixed(2),
    'p50 ms': r.p50Ms.toFixed(2),
    'p95 ms': r.p95Ms.toFixed(2),
    rows: r.rowsReturned.toLocaleString(),
  }));

  console.table(table);
}
