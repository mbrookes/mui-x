/**
 * Tier execution engine — builds and runs the actual data query for a routing
 * tier (the projection / GROUP BY / aggregation / ORDER BY / LIMIT logic).
 *
 * Split out of `preflight.ts` (which now only holds the COUNT(*) `runPreflight`)
 * so the query-construction logic lives in an aptly named file. `buildSecureQuery`
 * (queryBuilder.ts) applies security predicates, joins and user filters; this
 * module layers the SELECT shape on top per tier.
 */
import type {
  JwtSecurityClaims,
  BatchWidgetDescriptor,
  HandleBatchQueryOptions,
} from '../security/types';
import { buildSecureQuery } from './queryBuilder';
import { resolveAlias } from '../shared/columnValidation';
import type { CompiledSecurityPolicy } from '../security/compileSecurityPolicy';

type RoutingTier = 'client' | 'server' | 'db';

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
  options?:
    | CompiledSecurityPolicy
    | Pick<HandleBatchQueryOptions, 'tenantColumn' | 'securityColumns'>,
): Promise<Record<string, unknown>[]> {
  /** Resolve a logical column ID to its physical SQL column via the shared resolver. */
  const physicalCol = (c: string): string => resolveAlias(descriptor, c);

  // Qualify an unqualified physical column with the primary table to prevent
  // "ambiguous column name" errors when JOINs are present (e.g. an ORDER BY on a
  // column that exists on both joined tables).
  const qualify = (phys: string): string =>
    phys.includes('.') ? phys : `${descriptor.table}.${phys}`;

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
          return qualify(phys);
        }),
      );
    }
    if (descriptor.orderBy) {
      // Qualify unqualified ORDER BY columns for the same reason SELECT/GROUP BY
      // are qualified — an order column shared by both joined tables is otherwise
      // ambiguous. Aggregation aliases are not physical columns, so leave them
      // as-is (matches the db tier).
      const aggAliases = new Set((descriptor.aggregations ?? []).map((a) => a.alias));
      for (const ob of descriptor.orderBy) {
        const orderColumn = aggAliases.has(ob.column) ? ob.column : qualify(physicalCol(ob.column));
        query.orderBy(orderColumn, ob.direction);
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
    // tiers, and qualify them with the primary table (as SELECT/GROUP BY are) to
    // avoid join ambiguity. An ORDER BY that targets an aggregation alias
    // (e.g. `total`) must stay as the alias — it is not a physical column — so
    // fall back to it as-is.
    const aggAliases = new Set((descriptor.aggregations ?? []).map((a) => a.alias));
    for (const ob of descriptor.orderBy) {
      const orderColumn = aggAliases.has(ob.column) ? ob.column : qualify(physicalCol(ob.column));
      query.orderBy(orderColumn, ob.direction);
    }
  }
  if (descriptor.limit) {
    query.limit(descriptor.limit);
  }

  return query as Promise<Record<string, unknown>[]>;
}
