/**
 * Pre-flight cost evaluator — Phase 3 of the adaptive routing pipeline.
 *
 * Runs a low-cost COUNT(*) query with the full security + user filter predicates
 * applied. This determines which routing tier to use for the actual query.
 *
 * Expected timings (SQLite WAL, covering indexes):
 *   10k rows tenant slice: ~0.1–0.3ms
 *   100k rows tenant slice: ~0.2–0.5ms
 *   1M rows tenant slice:  ~0.5–1ms
 *
 * This is consistently 5–20× faster than the full aggregation query, making
 * it a safe pre-flight check even for the smallest tier.
 */
import type {
  JwtSecurityClaims,
  BatchWidgetDescriptor,
  HandleBatchQueryOptions,
} from '../security/types';
import { buildSecureQuery } from './queryBuilder';

type RoutingTier = 'client' | 'server' | 'db';

interface PreflightResult {
  rowCount: number;
}

/**
 * Run a COUNT(*) pre-flight and return the row count.
 *
 * This is a pure COUNT(*) runner. Aggregation detection, threshold-to-tier
 * mapping, and tier-cache lookups all live in `tierDecision.ts` (the single
 * source of truth for `DEFAULT_THRESHOLDS` / `tierFromRowCount`); this function
 * only executes the count so callers can feed it into that decision.
 *
 * @param db - Knex instance (provided by host app)
 * @param claims - Verified security claims
 * @param descriptor - Widget query descriptor
 * @param options - Security/tenant options forwarded to `buildSecureQuery`
 */
export async function runPreflight(
  db: any, // Knex.Knex
  claims: JwtSecurityClaims,
  descriptor: BatchWidgetDescriptor,
  options?: Pick<HandleBatchQueryOptions, 'tenantColumn' | 'securityColumns'>,
): Promise<PreflightResult> {
  // Build the query without column selection — only security + user filters
  const query = buildSecureQuery(db, claims, descriptor, options).count('* as row_count');

  const result = (await query.first()) as { row_count: number | string } | undefined;
  const rowCount = Number(result?.row_count ?? 0);

  return { rowCount };
}

/**
 * Build and execute the query for the determined tier.
 *
 * - 'client': return raw rows (client filters in-browser)
 * - 'server': return raw rows (middleware caches for re-use)
 * - 'db': return aggregated rows (DB push-down, no caching of raw data)
 */
export async function executeForTier(
  db: any,
  claims: JwtSecurityClaims,
  descriptor: BatchWidgetDescriptor,
  tier: RoutingTier,
  options?: Pick<HandleBatchQueryOptions, 'tenantColumn' | 'securityColumns'>,
): Promise<Record<string, unknown>[]> {
  /** Resolve a logical column ID to its physical SQL column (via columnAliases if set). */
  const physicalCol = (c: string): string => descriptor.columnAliases?.[c] ?? c;

  if (tier === 'client' || tier === 'server') {
    // Return the filtered (but unaggregated) rows
    const query = buildSecureQuery(db, claims, descriptor, options);
    if (descriptor.columns && descriptor.columns.length > 0) {
      // Qualify unqualified column names to avoid ambiguity when JOINs are present.
      // Skip columns that are already qualified (contain a dot) to prevent double-qualification.
      // When a column alias is defined, SELECT the physical column AS the logical ID.
      query.select(
        descriptor.columns.map((c: string) => {
          const phys = physicalCol(c);
          if (phys !== c) {
            // Expression field: SELECT physical AS logical
            return db.raw(`?? as ??`, [phys, c]);
          }
          return phys.includes('.') ? phys : `${descriptor.table}.${phys}`;
        }),
      );
    }
    if (descriptor.orderBy) {
      for (const ob of descriptor.orderBy) {
        query.orderBy(physicalCol(ob.column), ob.direction);
      }
    }
    if (descriptor.limit) {
      query.limit(descriptor.limit);
    }
    return query as Promise<Record<string, unknown>[]>;
  }

  // 'db' tier: DB push-down aggregation using explicit AggregationSpec[]
  const query = buildSecureQuery(db, claims, descriptor, options);
  const columns = descriptor.columns ?? [];

  // Qualify an unqualified physical column with the primary table to prevent
  // "ambiguous column name" errors when JOINs are present (e.g. date filter
  // on a parent table causes a LEFT JOIN; without the table prefix, SQLite
  // cannot disambiguate shared column names like `total`).
  const qualify = (phys: string): string =>
    phys.includes('.') ? phys : `${descriptor.table}.${phys}`;

  // Pure-measure columns are those whose aggregation alias equals the source
  // column (e.g. SUM(total) AS total). They must not appear in GROUP BY —
  // only in the aggregation clause. Dimension columns (date, category, …)
  // remain in both SELECT and GROUP BY.
  const measureColSet = new Set(
    (descriptor.aggregations ?? [])
      .filter((a) => a.alias === a.column)
      .map((a) => physicalCol(a.column)),
  );
  const dimensionColumns = columns.filter((c) => !measureColSet.has(physicalCol(c)));

  if (dimensionColumns.length > 0) {
    query.select(
      dimensionColumns.map((c: string) => {
        const phys = physicalCol(c);
        if (phys !== c) {
          // Cross-source / expression field: SELECT physical AS logical
          return db.raw(`?? as ??`, [phys, c]);
        }
        return qualify(phys);
      }),
    );
    query.groupBy(dimensionColumns.map((c) => qualify(physicalCol(c))));
  }

  for (const agg of descriptor.aggregations ?? []) {
    const col = qualify(physicalCol(agg.column));
    switch (agg.func) {
      case 'sum':
        query.sum(`${col} as ${agg.alias}`);
        break;
      case 'avg':
        query.avg(`${col} as ${agg.alias}`);
        break;
      case 'count':
        query.count(`${col} as ${agg.alias}`);
        break;
      case 'min':
        query.min(`${col} as ${agg.alias}`);
        break;
      case 'max':
        query.max(`${col} as ${agg.alias}`);
        break;
      default:
        break;
    }
  }

  if (descriptor.orderBy) {
    // Map logical → physical columns for ORDER BY, matching the client/server
    // tiers. An ORDER BY that targets an aggregation alias (e.g. `total`) must
    // stay as the alias — it is not a physical column — so fall back to it as-is.
    const aggAliases = new Set((descriptor.aggregations ?? []).map((a) => a.alias));
    for (const ob of descriptor.orderBy) {
      const orderColumn = aggAliases.has(ob.column) ? ob.column : physicalCol(ob.column);
      query.orderBy(orderColumn, ob.direction);
    }
  }
  if (descriptor.limit) {
    query.limit(descriptor.limit);
  }

  return query as Promise<Record<string, unknown>[]>;
}
