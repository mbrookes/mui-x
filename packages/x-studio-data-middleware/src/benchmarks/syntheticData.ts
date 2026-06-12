/* eslint-disable no-plusplus */
/**
 * Deterministic synthetic data generator for x-studio-data-middleware benchmarks.
 *
 * Mirrors the schema used in packages/x-studio/src/benchmarks/syntheticData.ts
 * so results are directly comparable.
 *
 * Schema
 * ──────
 *  sales   (n rows)   id, tenant_id, region, product, amount, sale_date, status
 *
 * All values are derived from the row index — no Math.random() — so results
 * are reproducible across runs.
 */

type Row = Record<string, unknown>;

const REGIONS = ['west', 'east', 'north', 'south', 'central'];
const PRODUCTS = ['widget', 'gadget', 'thingamajig', 'doohickey', 'gizmo'];
const STATUSES = ['pending', 'completed', 'shipped', 'cancelled', 'refunded'];

/** ISO date string for day offset from 2023-01-01 */
function isoDate(dayOffset: number): string {
  const base = new Date(2023, 0, 1);
  base.setDate(base.getDate() + (dayOffset % 730)); // 2 years
  return base.toISOString().slice(0, 10);
}

/**
 * Generate n sales rows for a single tenant.
 * Deterministic — row i always has the same values.
 */
export function makeSalesRows(n: number, tenantId = 'acme'): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      id: i + 1,
      tenant_id: tenantId,
      region: REGIONS[i % REGIONS.length],
      product: PRODUCTS[i % PRODUCTS.length],
      amount: 10 + (i % 991), // 10–1000, prime modulus for spread
      sale_date: isoDate(i),
      status: STATUSES[i % STATUSES.length],
    });
  }
  return rows;
}

/**
 * Build a complete benchmark scenario for a given row count.
 * Returns rows (for mockDb) + a representative BatchWidgetDescriptor.
 */
export function buildScenario(rowCount: number): {
  rows: Row[];
  tenantId: string;
  tableKey: string;
} {
  return {
    rows: makeSalesRows(rowCount),
    tenantId: 'acme',
    tableKey: 'sales',
  };
}
