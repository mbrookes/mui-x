/**
 * Tier execution engine — builds and runs the actual data query for a routing
 * tier (the projection / GROUP BY / aggregation / ORDER BY / LIMIT logic).
 *
 * Split out of `preflight.ts` (which now only holds the COUNT(*) `runPreflight`)
 * so the query-construction logic lives in an aptly named file. `buildSecureQuery`
 * (queryBuilder.ts) applies security predicates, joins and user filters; this
 * module layers the SELECT shape on top per tier.
 */
import type { JwtSecurityClaims, BatchWidgetDescriptor } from '../security/types';
import { buildSecureQuery } from './queryBuilder';
import type {
  CompiledSecurityPolicy,
  SecurityPolicyOptions,
} from '../security/compileSecurityPolicy';
import {
  toValidatedQueryPlan,
  type ColumnRef,
  type PlanOrderBy,
  type PlanProjectionColumn,
  type ValidatedQueryPlan,
} from '../security/validateQueryPlan';

type RoutingTier = 'client' | 'server' | 'db';

/**
 * Hard server-side ceiling on the number of rows a single widget query may
 * return, applied REGARDLESS of what `limit` the client requests (finding T2 —
 * Tier 2). Before this cap, `limit` was fully optional and entirely
 * client-controlled: a widget descriptor with no `limit` (or an enormous one)
 * against a multi-million-row table could attempt an uncapped SELECT and OOM
 * the server process. The effective limit applied to every executed query is
 * always `min(clientLimit ?? MAX_RESULT_ROWS, MAX_RESULT_ROWS)` — see
 * `effectiveLimit()` below.
 */
export const MAX_RESULT_ROWS = 100_000;

/**
 * Resolve the LIMIT actually applied to a query: the client's requested
 * `limit`, capped at `MAX_RESULT_ROWS`, defaulting to `MAX_RESULT_ROWS` when
 * the client omits `limit` entirely. `limit: 0` (a legitimate "return zero
 * rows" request, finding 3.1) is preserved — `??` only substitutes on
 * `undefined`, never on `0`.
 */
function effectiveLimit(clientLimit: number | undefined): number {
  return Math.min(clientLimit ?? MAX_RESULT_ROWS, MAX_RESULT_ROWS);
}

/**
 * Build and execute the query for the determined tier.
 *
 * - 'client': return raw rows (client filters in-browser)
 * - 'server': return raw rows (middleware caches for re-use)
 * - 'db': for an AGGREGATION descriptor, returns aggregated/grouped rows
 *   (DB push-down; `handler.ts` does not cache these). For a NON-aggregation
 *   descriptor whose preflight COUNT(*) exceeded `serverMemoryTier`, falls back
 *   to the SAME plain select/orderBy/limit shape as 'client'/'server' — those
 *   raw rows ARE cached by `handler.ts`, exactly like the other two tiers
 *   (finding 3.2 — this used to say "no caching of raw data" for every 'db'
 *   result, which was only ever true for the aggregation branch).
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
  options: CompiledSecurityPolicy | SecurityPolicyOptions,
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
  // The source column is qualified in BOTH branches — an unqualified renamed
  // column (e.g. `total` from `columnAliases: { revenue: 'total' }`) is just as
  // ambiguous under a join as an unqualified direct column, so `qualify()` runs
  // on `col.physical` here too before it goes into the `??` binding. Only the
  // SOURCE reference is qualified; the output row KEY (`col.outputAlias`) is
  // unaffected, so client row shapes are unchanged (finding 2.2).
  const projectColumn = (col: PlanProjectionColumn): unknown =>
    col.outputAlias !== undefined
      ? db.raw(`?? as ??`, [qualify(col.physical), col.outputAlias])
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
    // Always apply an effective limit — `limit: 0` is a legitimate "return zero
    // rows" request (finding 3.1), and an omitted or excessive client `limit` is
    // capped at `MAX_RESULT_ROWS` (finding T2) rather than left unbounded.
    query.limit(effectiveLimit(queryPlan.limit));
    return query as Promise<Record<string, unknown>[]>;
  }

  // 'db' tier: DB push-down aggregation using explicit AggregationSpec[]
  const query = buildSecureQuery(db, claims, descriptor, options, queryPlan);

  // A descriptor with NO aggregations can still reach the 'db' tier: a plain
  // (non-aggregation) query whose preflight COUNT(*) exceeds `serverMemoryTier`
  // is routed here by `tierFromRowCount`. The GROUP-BY/aggregate-push-down logic
  // below assumes aggregations exist — with none it would GROUP BY every
  // projected column (silently de-duplicating rows) or emit an unbounded
  // `SELECT *` when there are no columns either, both of which change the row
  // shape vs. what the client/server tiers return for the same descriptor.
  // Fall back to the SAME plain select/orderBy/limit shape those tiers produce.
  if (queryPlan.aggregations.length === 0) {
    if (queryPlan.columns.length > 0) {
      query.select(queryPlan.columns.map(projectColumn));
    }
    for (const ob of queryPlan.orderBy) {
      query.orderBy(orderColumnOf(ob), ob.direction);
    }
    // Always apply an effective limit — see finding 3.1 / finding T2 above.
    query.limit(effectiveLimit(queryPlan.limit));
    return query as Promise<Record<string, unknown>[]>;
  }

  // Pure-measure columns are those whose aggregation alias equals the source
  // column (e.g. SUM(total) AS total). They must not appear in GROUP BY —
  // only in the aggregation clause. Dimension columns (date, category, …)
  // remain in both SELECT and GROUP BY.
  // Compare on PRIMARY-TABLE-QUALIFIED physicals (finding 2.2): a pure measure may
  // be qualified (`orders.amount`) while the matching projection column is not
  // (`amount`), or vice-versa, so a raw-string `.has(c.physical)` would miss the
  // match and leave the measure column in GROUP BY (wrong grain). Qualifying both
  // sides makes the membership test grain-correct.
  const measureColSet = new Set(
    queryPlan.aggregations.filter((a) => a.pureMeasure).map((a) => qualify(a.physical)),
  );
  const dimensionColumns = queryPlan.columns.filter((c) => !measureColSet.has(qualify(c.physical)));

  if (dimensionColumns.length > 0) {
    query.select(dimensionColumns.map(projectColumn));
    query.groupBy(dimensionColumns.map((c) => qualify(c.physical)));
  }

  for (const agg of queryPlan.aggregations) {
    const col = qualify(agg.physical);
    // Knex's object/alias-map form (`{ [alias]: column }`) routes both the
    // column and the alias through Knex's own identifier-wrapping (the same
    // escaping `??` bindings use elsewhere in this package), rather than
    // building an "col as alias" fragment via template-string interpolation.
    // Not currently exploitable (agg.alias is charset-restricted by
    // `validateAggregationAliases`, and `col` is either allowlisted or
    // Knex-escaped either way), but this keeps the aggregate clause on the same
    // binding-based footing as the rest of the query-building code (finding 2.2).
    switch (agg.func) {
      case 'sum':
        query.sum({ [agg.alias]: col });
        break;
      case 'avg':
        query.avg({ [agg.alias]: col });
        break;
      case 'count':
        query.count({ [agg.alias]: col });
        break;
      case 'min':
        query.min({ [agg.alias]: col });
        break;
      case 'max':
        query.max({ [agg.alias]: col });
        break;
      default:
        // `agg.func` is client-JSON-sourced and its TS type ('sum'|'avg'|'count'|
        // 'min'|'max') is not a runtime guarantee. Reject fail-closed rather than
        // silently omitting the aggregation from the query — a dropped measure
        // column would otherwise surface as a confusing, silently-incomplete
        // result instead of a clear error (finding 2.4).
        throw new Error(
          `MUI X Studio Server: Aggregation function "${agg.func}" is not supported. ` +
            `Supported aggregation functions are: sum, avg, count, min, max. ` +
            `Check the widget descriptor's "aggregations" entries for a typo or unsupported function.`,
        );
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
  // Always apply an effective limit — see finding 3.1 / finding T2 above.
  query.limit(effectiveLimit(queryPlan.limit));

  return query as Promise<Record<string, unknown>[]>;
}
