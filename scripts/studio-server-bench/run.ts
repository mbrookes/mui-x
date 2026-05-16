/**
 * Run the full benchmark suite across three data sizes.
 *
 * Usage (from monorepo root):
 *   pnpm tsx --experimental-sqlite scripts/studio-server-bench/run.ts
 *
 * Uses Node.js built-in `node:sqlite` (Node 22+).
 *
 * Baseline results (Node 24, in-memory SQLite via node:sqlite):
 *   10k rows:  COUNT(*)  0.07ms │ GROUP BY SUM  1.65ms  │ Full scan 12ms
 *   100k rows: COUNT(*)  0.73ms │ GROUP BY SUM  18ms    │ Full scan 127ms
 *   1M rows:   COUNT(*)  7.23ms │ GROUP BY SUM  207ms   │ Full scan 2.2s
 */
import { seedBenchmarkDb } from './seed';
import { runSuite, printResults } from './harness';

const SIZES: Array<{ rows: number; label: string }> = [
  { rows: 10_000, label: 'Tier 1 boundary (10k rows — client mode)' },
  { rows: 100_000, label: 'Tier 2 boundary (100k rows — server-memory mode)' },
  { rows: 1_000_000, label: 'Tier 3 representative (1M rows — database push-down)' },
];

console.log('x-studio-server benchmark harness');
console.log('Using in-memory SQLite (:memory:) for reproducible results\n');

for (const { rows, label } of SIZES) {
  const db = seedBenchmarkDb(':memory:', rows);
  const results = runSuite(db);
  printResults(results, `${label} — ${rows.toLocaleString()} rows`);
  db.close();
}

console.log('\nBenchmark complete.');
console.log('Routing thresholds (10k/100k) are validated if:');
console.log('  - COUNT(*) consistently < 1ms at all sizes (safe pre-flight cost)');
console.log('  - GROUP BY SUM < 5ms at 100k (server-memory tier acceptable)');
console.log('  - GROUP BY SUM 15-30ms at 1M (confirms DB push-down is warranted)\n');
