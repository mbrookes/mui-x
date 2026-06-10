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
import type { JwtSecurityClaims, BatchWidgetDescriptor, FilterPredicate, HandleBatchQueryOptions } from '../security/types';
import { buildSecureQuery } from './queryBuilder';

export type RoutingTier = 'client' | 'server' | 'db';

export interface PreflightResult {
  rowCount: number;
  tier: RoutingTier;
}

const DEFAULT_CLIENT_THRESHOLD = 10_000;
const DEFAULT_SERVER_MEMORY_THRESHOLD = 100_000;

/**
 * Run a COUNT(*) pre-flight and determine the routing tier.
 *
 * @param db - Knex instance (provided by host app)
 * @param claims - Verified security claims
 * @param descriptor - Widget query descriptor
 * @param thresholds - Optional tier boundary overrides
 */
export async function runPreflight(
   
  db: any, // Knex.Knex
  claims: JwtSecurityClaims,
  descriptor: BatchWidgetDescriptor,
  thresholds?: { clientTier?: number; serverMemoryTier?: number },
  options?: Pick<HandleBatchQueryOptions, 'tenantColumn'>,
): Promise<PreflightResult> {
  const clientThreshold = thresholds?.clientTier ?? DEFAULT_CLIENT_THRESHOLD;
  const serverThreshold = thresholds?.serverMemoryTier ?? DEFAULT_SERVER_MEMORY_THRESHOLD;

  // Build the query without column selection — only security + user filters
  const query = buildSecureQuery(db, claims, descriptor, options).count('* as row_count');

  const result = (await query.first()) as { row_count: number | string } | undefined;
  const rowCount = Number(result?.row_count ?? 0);

  let tier: RoutingTier;
  if (rowCount <= clientThreshold) {
    tier = 'client';
  } else if (rowCount <= serverThreshold) {
    tier = 'server';
  } else {
    tier = 'db';
  }

  return { rowCount, tier };
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
  options?: Pick<HandleBatchQueryOptions, 'tenantColumn'>,
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

  const groupByColumns = columns.filter(
    (c: string) => !descriptor.aggregations?.some((a) => a.column === c),
  );
  if (groupByColumns.length > 0) {
    // SELECT with aliases for expression fields; GROUP BY the physical columns
    query.select(
      groupByColumns.map((c: string) => {
        const phys = physicalCol(c);
        if (phys !== c) {
          return db.raw(`?? as ??`, [phys, c]);
        }
        return phys;
      }),
    );
    query.groupBy(groupByColumns.map(physicalCol));
  }

  for (const agg of descriptor.aggregations ?? []) {
    const col = physicalCol(agg.column);
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

  return query as Promise<Record<string, unknown>[]>;
}
