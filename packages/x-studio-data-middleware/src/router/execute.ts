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
  AGGREGATE_SQL_FUNCTIONS,
  toValidatedQueryPlan,
  type ColumnRef,
  type PlanOrderBy,
  type PlanProjectionColumn,
  type ValidatedQueryPlan,
} from '../security/validateQueryPlan';
import { qualifyAgainst } from '../shared/columnValidation';

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
 * Ceiling on the number of rows one BATCH REQUEST may contribute to its
 * response, summed across every widget it contains.
 *
 * `MAX_RESULT_ROWS` bounds ONE widget's query; `MAX_WIDGETS_PER_BATCH`
 * (`handler.ts`) bounds the NUMBER of widgets. Nothing bounded their PRODUCT: 50
 * widgets on a large table, each with no `limit`, each independently resolved to
 * `MAX_RESULT_ROWS`, so one authenticated request could put 5,000,000 rows in the
 * `results` array and serialize them all again into the JSON body.
 *
 * WHAT THIS BOUNDS, EXACTLY. Every row that reaches the response is charged to
 * the request's shared `RowBudget` exactly once — by the query that fetched it
 * (`runBounded` below), by the cache-hit path, or by each extra widget that
 * shares a single-flighted pipeline (both in `handler.ts`). A widget whose rows
 * no longer fit is failed with an error instead of contributing a truncated
 * slice, so the SUM of `results[].rows.length` can never exceed
 * `MAX_ROWS_PER_REQUEST`.
 *
 * WHAT IT DOES NOT BOUND. It is not a live-memory cap on concurrently executing
 * queries: `MAX_CONCURRENT_WIDGET_QUERIES` widgets can each read the same
 * remaining allowance before any of them has rows to charge, so peak
 * simultaneously-materialized rows is bounded by
 * `MAX_ROWS_PER_REQUEST + (MAX_CONCURRENT_WIDGET_QUERIES - 1) × MAX_RESULT_ROWS`
 * — the losers of that race are then rejected at charge time rather than
 * returned. Reserving the full limit up front instead would make that peak exact,
 * but the first widget with no client `limit` would reserve the ENTIRE request
 * budget (`MAX_ROWS_PER_REQUEST` is deliberately equal to `MAX_RESULT_ROWS`) and
 * starve every sibling in the same batch, so the response bound is enforced on
 * what queries actually returned rather than on what they might return.
 *
 * Deliberately equal to `MAX_RESULT_ROWS`: a request may still materialize one
 * full-size widget result, but the batch as a whole can never exceed what a
 * single widget was already allowed to return.
 */
export const MAX_ROWS_PER_REQUEST = MAX_RESULT_ROWS;

/**
 * A mutable per-REQUEST row allowance, threaded through every widget of one
 * batch so their limits compose instead of multiplying (finding H2).
 *
 * Created once by `handleBatchQuery` and shared by every widget of that batch.
 * `remaining` is charged by `chargeRowBudgetOrThrow` at each of the three points
 * where rows enter the response, and is also read by `effectiveLimit` so a query
 * never asks the database for more than the batch has left. Direct callers (unit
 * tests) omit it entirely, which reproduces the per-widget-only `MAX_RESULT_ROWS`
 * behavior exactly.
 */
export interface RowBudget {
  /** Rows the rest of this request may still contribute. Never negative. */
  remaining: number;
}

/** Create a fresh per-request row budget. */
export function createRowBudget(maxRows: number = MAX_ROWS_PER_REQUEST): RowBudget {
  return { remaining: maxRows };
}

/**
 * The error every budget-degradation path raises.
 *
 * `handler.ts` turns it into that widget's `{ error }` result via
 * `sanitizeBoundaryError`, which passes this package's own `MUI X`-prefixed
 * messages through verbatim.
 */
function rowBudgetExhaustedError(remaining: number): Error {
  return new Error(
    `MUI X Studio Server: This widget's rows were dropped because the request's shared row budget is exhausted — ` +
      `${remaining} of ${MAX_ROWS_PER_REQUEST} rows are left for this batch and this widget's result does not fit. ` +
      `Every widget in one batch shares that budget, so returning only the rows that fit would present a truncated ` +
      `result as a complete one — silent data loss the client cannot detect, which would then be cached and served ` +
      `to later requests as a complete answer. ` +
      `Split the dashboard page across more batch requests, or set a smaller "limit" on each widget so the batch's ` +
      `limits sum to at most ${MAX_ROWS_PER_REQUEST} rows.`,
  );
}

/**
 * Charge `rowCount` rows to the request's shared budget, or throw when they do
 * not fit.
 *
 * INVARIANT: every row that reaches `BatchQueryResponse.results[].rows` is
 * charged here exactly once — freshly queried rows (`runBounded`), rows served
 * from the data cache, and rows a widget receives by attaching to another
 * widget's single-flighted pipeline (the last two in `handler.ts`). A charge that
 * does not fit leaves `remaining` UNTOUCHED and throws: the oversized widget
 * fails, but a smaller sibling later in the batch can still be served.
 *
 * With no budget threaded (direct callers) this is a no-op.
 */
export function chargeRowBudgetOrThrow(budget: RowBudget | undefined, rowCount: number): void {
  if (budget === undefined) {
    return;
  }
  if (rowCount > budget.remaining) {
    throw rowBudgetExhaustedError(budget.remaining);
  }
  budget.remaining -= rowCount;
}

/**
 * The LIMIT a widget may ask for on its own: the client's requested `limit`
 * capped at `MAX_RESULT_ROWS`, defaulting to that cap when `limit` is omitted.
 * `limit: 0` (a legitimate "return zero rows" request, finding 3.1) is preserved
 * — `??` only substitutes on `undefined`, never on `0`.
 */
function widgetLimit(clientLimit: number | undefined): number {
  return Math.max(0, Math.min(clientLimit ?? MAX_RESULT_ROWS, MAX_RESULT_ROWS));
}

/**
 * Resolve the LIMIT actually applied to a query: `widgetLimit` further reduced by
 * whatever the request's shared `RowBudget` still allows, so a query never asks
 * the database for rows the batch could not return anyway.
 *
 * With no budget threaded (direct callers), this is `widgetLimit` exactly.
 */
function effectiveLimit(clientLimit: number | undefined, budget: RowBudget | undefined): number {
  const cap = widgetLimit(clientLimit);
  return budget === undefined ? cap : Math.min(cap, Math.max(0, budget.remaining));
}

/**
 * Apply the effective LIMIT, run the query, charge the rows it returned against
 * the request's shared budget, and FAIL rather than return a result the budget
 * degraded.
 *
 * Every one of `executeForTier`'s three exit paths (client/server tier, db tier
 * without aggregations, db tier with aggregations) goes through this single
 * helper so none of them can drift on how the limit is derived, forget to charge
 * the budget, or return a silently-shortened result.
 *
 * DEGRADATION IS AN ERROR, NOT A SHORTER SUCCESS. Two things can shorten a result
 * for reasons the client never asked for, and both throw:
 *   - the charge does not fit — widgets running concurrently consumed the
 *     remaining allowance while this query was in flight;
 *   - the applied LIMIT came from the budget rather than from the client's own
 *     `limit`/`MAX_RESULT_ROWS`, and the query filled it, so more matching rows
 *     exist behind it.
 * Returning those rows would be indistinguishable from a normal limited page:
 * the client would report "N of M rows" with no way to tell that the server, not
 * the query, chose N — and `handler.ts` would cache that slice and serve it to
 * later requests as a complete answer for the whole TTL. The second test is
 * deliberately fail-closed: a query that returns exactly as many rows as a
 * budget-reduced LIMIT allowed MAY have had nothing more to return, but that is
 * indistinguishable from truncation without fetching an extra row, so it is
 * treated as degraded.
 *
 * Rows that were fetched and then dropped stay CHARGED. They were materialized,
 * and refunding them would let the next widget re-issue the identical
 * about-to-be-truncated query, burning a round-trip per remaining widget to
 * produce the same error.
 */
async function runBounded(
  query: any,
  clientLimit: number | undefined,
  budget: RowBudget | undefined,
): Promise<Record<string, unknown>[]> {
  const ownLimit = widgetLimit(clientLimit);
  const appliedLimit = effectiveLimit(clientLimit, budget);
  query.limit(appliedLimit);
  const rows = (await query) as Record<string, unknown>[];
  const returned = Array.isArray(rows) ? rows.length : 0;
  chargeRowBudgetOrThrow(budget, returned);
  if (appliedLimit < ownLimit && returned >= appliedLimit) {
    throw rowBudgetExhaustedError(budget === undefined ? 0 : budget.remaining);
  }
  return rows;
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
 * @param rowBudget - The request's shared, mutable row allowance (finding H2, request path). Caps this
 *   query's LIMIT at whatever the batch has left and is charged by the rows actually returned, so
 *   `MAX_WIDGETS_PER_BATCH × MAX_RESULT_ROWS` can no longer multiply into a single-request OOM. THROWS
 *   rather than returning a shortened result when the budget is what shortened it — see `runBounded`.
 *   Direct callers omit it, which restores the previous per-widget-only `MAX_RESULT_ROWS` cap.
 */
export async function executeForTier(
  db: any,
  claims: JwtSecurityClaims,
  descriptor: BatchWidgetDescriptor,
  tier: RoutingTier,
  options: CompiledSecurityPolicy | SecurityPolicyOptions,
  plan?: ValidatedQueryPlan,
  rowBudget?: RowBudget,
): Promise<Record<string, unknown>[]> {
  const queryPlan = plan ?? toValidatedQueryPlan(descriptor);

  // Budget exhausted by earlier widgets in this same batch: fail this widget
  // WITHOUT issuing a query at all. Emitting `LIMIT 0` would cost a database
  // round-trip per remaining widget, which is exactly the fan-out this budget
  // exists to contain — and an empty SUCCESS would tell the client "0 rows out
  // of <rowCount>", a starved result presented as the real answer. Only
  // reachable when a budget is threaded (the request path).
  if (rowBudget !== undefined && rowBudget.remaining <= 0) {
    throw rowBudgetExhaustedError(rowBudget.remaining);
  }

  // Qualify an unqualified physical column with the primary table to prevent
  // "ambiguous column name" errors when JOINs are present (e.g. an ORDER BY on a
  // column that exists on both joined tables).
  const qualify = (phys: ColumnRef): string => qualifyAgainst(queryPlan.table, phys);

  // Project one resolved column: an expression field (physical differs from its
  // output id) SELECTs `physical AS outputAlias`; a direct column is qualified.
  // The source column is qualified in BOTH branches — an unqualified renamed
  // column (e.g. `total` from `columnAliases: { revenue: 'total' }`) is just as
  // ambiguous under a join as an unqualified direct column, so `qualify()` runs
  // on `col.physical` here too before it goes into the `??` binding. Only the
  // SOURCE reference is qualified; the output row KEY (`col.outputAlias`) is
  // unaffected, so client row shapes are unchanged (finding 2.2).
  //
  // NO RESULT-KEY COLLISION GUARD HERE (Tier3, iter24 finding) — deliberately.
  // Two projected columns whose result key collides (e.g. `orders.category` and
  // `customers.category`, both keying as `category`) would silently overwrite
  // one another on the row object built from this function's output, with no
  // way for THIS function to detect it (it only ever sees one column at a
  // time). The guard instead runs once, up front, over the whole projection
  // list: `validateProjectionKeyCollisions` (`shared/columnValidation.ts`),
  // wired into `validateQueryPlan` — every request-path descriptor is rejected
  // fail-closed before it ever reaches this function.
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
    // capped at `MAX_RESULT_ROWS` (finding T2) and at the request's remaining
    // row budget (finding H2) rather than left unbounded.
    return runBounded(query, queryPlan.limit, rowBudget);
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
    // Always apply an effective limit — see finding 3.1 / T2 / H2 above.
    return runBounded(query, queryPlan.limit, rowBudget);
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
    //
    // `agg.func` is client-JSON-sourced, so its TS type is not a runtime guarantee:
    // gate on own-property membership of the shared `AGGREGATE_SQL_FUNCTIONS` table
    // before dispatching, and fail closed on anything else. Silently omitting the
    // aggregation would surface as a confusing, silently-incomplete result rather
    // than a clear error. The table's five keys ARE the five Knex builder method
    // names, so the dispatch reads straight off it — the same table `applyHaving`
    // uses, so the two cannot drift.
    if (!Object.prototype.hasOwnProperty.call(AGGREGATE_SQL_FUNCTIONS, agg.func)) {
      throw new Error(
        `MUI X Studio Server: Aggregation function "${agg.func}" is not supported. ` +
          `Supported aggregation functions are: sum, avg, count, min, max. ` +
          `Check the widget descriptor's "aggregations" entries for a typo or unsupported function.`,
      );
    }
    query[agg.func]({ [agg.alias]: col });
  }

  for (const ob of queryPlan.orderBy) {
    // Map logical → physical columns for ORDER BY, matching the client/server
    // tiers, and qualify them with the primary table (as SELECT/GROUP BY are) to
    // avoid join ambiguity. An ORDER BY that targets an aggregation alias
    // (e.g. `total`) must stay as the alias — it is not a physical column — so
    // fall back to it as-is.
    query.orderBy(orderColumnOf(ob), ob.direction);
  }
  // Always apply an effective limit — see finding 3.1 / T2 / H2 above.
  return runBounded(query, queryPlan.limit, rowBudget);
}
