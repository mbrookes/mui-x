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
import type { CompiledSecurityPolicy } from '../security/compileSecurityPolicy';
import {
  toValidatedQueryPlan,
  type ColumnRef,
  type PlanOrderBy,
  type PlanProjectionColumn,
  type ValidatedQueryPlan,
} from '../security/validateQueryPlan';

type RoutingTier = 'client' | 'server' | 'db';

/**
 * Build and execute the query for the determined tier.
 *
 * - 'client': return raw rows (client filters in-browser)
 * - 'server': return raw rows (middleware caches for re-use)
 * - 'db': return aggregated rows (DB push-down, no caching of raw data)
 *
 * @param plan - Pre-compiled `ValidatedQueryPlan` (request path, threaded from the handler). Direct
 *   callers omit it; a plan is then resolved on the spot from `descriptor`, reproducing the pre-refactor
 *   inline `resolveAlias` behavior. Every column reference below reads a pre-resolved `ColumnRef` off the
 *   plan — this module never calls `resolveAlias` itself.
 */
export async function executeForTier(
  db: any,
  claims: JwtSecurityClaims,
  descriptor: BatchWidgetDescriptor,
  tier: RoutingTier,
  options?:
    | CompiledSecurityPolicy
    | Pick<HandleBatchQueryOptions, 'tenantColumn' | 'securityColumns'>,
  plan?: ValidatedQueryPlan,
): Promise<Record<string, unknown>[]> {
  const queryPlan = plan ?? toValidatedQueryPlan(descriptor);

  // Qualify an unqualified physical column with the primary table to prevent
  // "ambiguous column name" errors when JOINs are present (e.g. an ORDER BY on a
  // column that exists on both joined tables).
  const qualify = (phys: ColumnRef): string =>
    phys.includes('.') ? phys : `${queryPlan.table}.${phys}`;

  // Project one resolved column: an expression field (physical differs from its
  // output id) SELECTs `physical AS outputAlias`; a direct column is qualified.
  const projectColumn = (col: PlanProjectionColumn): unknown =>
    col.outputAlias !== undefined
      ? db.raw(`?? as ??`, [col.physical, col.outputAlias])
      : qualify(col.physical);

  // Resolve one ORDER BY target: an aggregation alias stays as-is (not a physical
  // column); a physical column is qualified. Mirrors the db and client/server tiers.
  const orderColumnOf = (ob: PlanOrderBy): string =>
    ob.aggAlias !== undefined ? ob.aggAlias : qualify(ob.physical as ColumnRef);

  if (tier === 'client' || tier === 'server') {
    // Return the filtered (but unaggregated) rows
    const query = buildSecureQuery(db, claims, descriptor, options, queryPlan);
    if (queryPlan.columns.length > 0) {
      // Qualify unqualified column names to avoid ambiguity when JOINs are present.
      // Skip columns that are already qualified (contain a dot) to prevent double-qualification.
      // When a column alias is defined, SELECT the physical column AS the logical ID.
      query.select(queryPlan.columns.map(projectColumn));
    }
    for (const ob of queryPlan.orderBy) {
      // Qualify unqualified ORDER BY columns for the same reason SELECT/GROUP BY
      // are qualified — an order column shared by both joined tables is otherwise
      // ambiguous. Aggregation aliases are not physical columns, so leave them
      // as-is (matches the db tier).
      query.orderBy(orderColumnOf(ob), ob.direction);
    }
    if (queryPlan.limit) {
      query.limit(queryPlan.limit);
    }
    return query as Promise<Record<string, unknown>[]>;
  }

  // 'db' tier: DB push-down aggregation using explicit AggregationSpec[]
  const query = buildSecureQuery(db, claims, descriptor, options, queryPlan);

  // Pure-measure columns are those whose aggregation alias equals the source
  // column (e.g. SUM(total) AS total). They must not appear in GROUP BY —
  // only in the aggregation clause. Dimension columns (date, category, …)
  // remain in both SELECT and GROUP BY.
  const measureColSet = new Set(
    queryPlan.aggregations.filter((a) => a.pureMeasure).map((a) => a.physical),
  );
  const dimensionColumns = queryPlan.columns.filter((c) => !measureColSet.has(c.physical));

  if (dimensionColumns.length > 0) {
    query.select(dimensionColumns.map(projectColumn));
    query.groupBy(dimensionColumns.map((c) => qualify(c.physical)));
  }

  for (const agg of queryPlan.aggregations) {
    const col = qualify(agg.physical);
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

  for (const ob of queryPlan.orderBy) {
    // Map logical → physical columns for ORDER BY, matching the client/server
    // tiers, and qualify them with the primary table (as SELECT/GROUP BY are) to
    // avoid join ambiguity. An ORDER BY that targets an aggregation alias
    // (e.g. `total`) must stay as the alias — it is not a physical column — so
    // fall back to it as-is.
    query.orderBy(orderColumnOf(ob), ob.direction);
  }
  if (queryPlan.limit) {
    query.limit(queryPlan.limit);
  }

  return query as Promise<Record<string, unknown>[]>;
}
