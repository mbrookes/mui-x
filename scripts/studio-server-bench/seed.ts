/**
 * Benchmark database seeder for x-studio-server performance tests.
 *
 * Creates a `sales` table in a SQLite database using Node.js built-in
 * `node:sqlite` (available in Node 22+) with WAL mode and covering indexes.
 *
 * Usage:
 *   pnpm tsx scripts/studio-server-bench/seed.ts
 */
import { DatabaseSync } from 'node:sqlite';

const REGIONS = ['north', 'south', 'east', 'west'] as const;
const PRODUCTS = ['widget', 'gadget', 'doohickey', 'thingamajig'] as const;
const INSERT_BATCH = 1000;

export function seedBenchmarkDb(path: string, rowCount: number): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sales (
      id          INTEGER PRIMARY KEY,
      tenant_id   TEXT    NOT NULL,
      region      TEXT    NOT NULL,
      product     TEXT    NOT NULL,
      amount      REAL    NOT NULL,
      sale_date   TEXT    NOT NULL,
      rep_id      INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sales_tenant
      ON sales(tenant_id);

    CREATE INDEX IF NOT EXISTS idx_sales_tenant_region
      ON sales(tenant_id, region);

    CREATE INDEX IF NOT EXISTS idx_sales_tenant_date
      ON sales(tenant_id, sale_date);

    CREATE INDEX IF NOT EXISTS idx_sales_tenant_region_date
      ON sales(tenant_id, region, sale_date);
  `);

  const insert = db.prepare(
    `INSERT INTO sales(tenant_id, region, product, amount, sale_date, rep_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const THREE_YEARS_MS = 3.15e10;
  const now = Date.now();

  console.log(`Seeding ${rowCount.toLocaleString()} rows…`);

  // node:sqlite doesn't have built-in transaction batching — use BEGIN/COMMIT
  db.exec('BEGIN');
  for (let i = 0; i < rowCount; i++) {
    insert.run(
      Math.random() < 0.8 ? 'acme' : 'globex',
      REGIONS[Math.floor(Math.random() * REGIONS.length)],
      PRODUCTS[Math.floor(Math.random() * PRODUCTS.length)],
      +(Math.random() * 1000).toFixed(2),
      new Date(now - Math.random() * THREE_YEARS_MS).toISOString().slice(0, 10),
      Math.floor(Math.random() * 50) + 1,
    );
    if (i > 0 && i % 100_000 === 0) {
      db.exec('COMMIT');
      db.exec('BEGIN');
      console.log(`  ${i.toLocaleString()} rows inserted…`);
    }
  }
  db.exec('COMMIT');

  return db;
}

if (process.argv[1] === import.meta.filename) {
  const rows = 100_000;
  const db = seedBenchmarkDb(':memory:', rows);
  console.log(`Seeded ${rows.toLocaleString()} rows.`);
  db.close();
}
