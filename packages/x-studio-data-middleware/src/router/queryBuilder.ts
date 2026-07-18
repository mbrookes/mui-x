/**
 * Secure Knex query builder — Phase 1, Task 1.3.
 *
 * Constructs parameterized WHERE clauses from verified JwtSecurityClaims
 * and user-supplied FilterPredicates.
 *
 * SECURITY INVARIANTS:
 * 1. All WHERE values use Knex parameterized bindings (never string concat)
 * 2. Table and column names are validated against the caller's allowlists
 *    BEFORE this function is called — see `shared/columnValidation.ts`
 *    (`validateDescriptorColumns`). This function trusts the descriptor has
 *    already been vetted.
 * 3. Security claims are applied FIRST and cannot be overridden by user filters
 * 4. The Knex `??` operator (double question mark) is used for identifier binding
 *
 * OWASP note: Parameterized queries = Defense Option 1 (recommended).
 * String-predicate injection is OWASP Defense Option 4 (STRONGLY DISCOURAGED).
 */
import type {
  JwtSecurityClaims,
  BatchWidgetDescriptor,
  FilterPredicate,
  HavingPredicate,
} from '../security/types';
import {
  applyPredicates,
  applySecurityPredicates,
  applySecurityPredicatesOrNull,
  applySecurityPredicatesToJoinOn,
} from '../shared/predicates';
import {
  toCompiledSecurityPolicy,
  type CompiledSecurityPolicy,
  type SecurityPolicyOptions,
} from '../security/compileSecurityPolicy';
import {
  toValidatedQueryPlan,
  type PlanAggregation,
  type ValidatedQueryPlan,
} from '../security/validateQueryPlan';

/**
 * Build a Knex query builder with security predicates, joins, and user filters applied.
 *
 * The caller is responsible for:
 * - Adding SELECT columns (or COUNT)
 * - Adding ORDER BY / LIMIT
 * - Validating table and column names against the allowlists (done in handler.ts)
 *
 * @param db - Knex instance
 * @param claims - Pre-verified security claims
 * @param descriptor - Widget query descriptor (validated before calling)
 * @param options - Compiled security policy (request path) or the raw `SecurityPolicyOptions`
 *   (direct callers). REQUIRED — an enforcement site is never reachable without an explicit
 *   tenancy decision, not even from a direct/test caller.
 * @param plan - Pre-compiled `ValidatedQueryPlan` (request path). Direct callers omit it; a plan is then
 *   resolved on the spot from `descriptor`, reproducing the pre-refactor inline `resolveAlias` behavior.
 */
export function buildSecureQuery(
  db: any, // Knex.Knex
  claims: JwtSecurityClaims,
  descriptor: BatchWidgetDescriptor,
  options: CompiledSecurityPolicy | SecurityPolicyOptions,
  plan?: ValidatedQueryPlan,
): any {
  // Resolve the validated query plan ONCE. In the request path this is the plan
  // already compiled + threaded from the handler (returned as-is, no re-resolution);
  // direct callers (unit tests) pass only the descriptor, from which a plan is
  // resolved on the spot. Every column reference below reads a pre-resolved
  // `ColumnRef` off the plan — this function never calls `resolveAlias` itself, so
  // the ambiguous logical form is structurally unreachable here.
  const queryPlan = plan ?? toValidatedQueryPlan(descriptor);

  const query = db(queryPlan.table);

  // Resolve the security policy ONCE. In the request path this is the compiled
  // policy already threaded from the handler (returned as-is, no recompile);
  // direct callers (unit tests) may still pass the legacy raw option pair, which
  // is compiled on the spot. Enforcement then goes through the policy's
  // `forPrimaryTable` / `forJoinedTable` — never the fallback chain inline.
  const policy = toCompiledSecurityPolicy(options);

  // ── Joins (Phase 7) ────────────────────────────────────────────────────────
  // Applied before WHERE predicates so joined columns are available to filters.
  // Each join uses the Knex callback form so ALL `on` pairs become `.on()`
  // conditions within a SINGLE join — a per-pair call would join the same table
  // once per pair, producing invalid SQL ("table name not unique") for composite
  // keys.
  //
  // The `on` pairs are already alias-resolved on the plan (`ResolvedJoin.on`
  // carries physical `ColumnRef`s on both sides — the SAME resolution
  // `validateDescriptorColumns` checked against the allowlist), so execution can
  // never target a different physical column than validation approved.
  //
  // OUTER-JOIN SECURITY PLACEMENT (finding 2.3): the security predicate for the
  // NULLABLE side of an outer join goes in the JOIN's ON clause, not WHERE. A
  // joined-table tenant predicate in WHERE drops every NULL-extended row a LEFT
  // JOIN was meant to keep (turning it into an INNER join); the symmetric case for
  // a RIGHT JOIN drops the preserved joined-side rows via the PRIMARY table's WHERE
  // predicate. Placing it in ON scopes which rows JOIN (matched joined rows are
  // still tenant-checked — no cross-tenant fan-out) while preserving unmatched
  // outer rows. See `applySecurityPredicatesToJoinOn`.
  for (const join of queryPlan.joins) {
    let joinMethod: string;
    if (join.type === 'left') {
      joinMethod = 'leftJoin';
    } else if (join.type === 'right') {
      joinMethod = 'rightJoin';
    } else {
      joinMethod = 'join';
    }
    const joinedSecurity = policy.forJoinedTable(join.table);
    const primarySecurity = policy.forPrimaryTable(queryPlan.table);
    query[joinMethod](join.table, function joinOn(this: any) {
      // TABLE-QUALIFICATION (finding 2.1, iter9): the join `on` pair is the last
      // read-path column reference to reach raw SQL unqualified — every other one
      // (SELECT/GROUP BY/ORDER BY/aggregations via `execute.ts`'s `qualify()`,
      // security predicates, and user filter columns just below) is already
      // qualified. `JoinDescriptor.on` deliberately accepts unqualified columns
      // (`validateDescriptorColumns` checks the left side against the primary
      // table and the right side against `join.table`), so an unqualified `on`
      // column shared by both joined tables (`id`, `tenant_id`, `region_id`, …)
      // renders an ambiguous identifier Postgres/MySQL reject outright. Qualify
      // each side with the table it's validated against — left with the primary
      // table, right with `join.table` — leaving an already-dotted (client-
      // qualified) column untouched, mirroring the filter qualify-if-no-dot pass.
      for (const [left, right] of join.on) {
        const qualifiedLeft = left.includes('.') ? left : `${queryPlan.table}.${left}`;
        const qualifiedRight = right.includes('.') ? right : `${join.table}.${right}`;
        this.on(qualifiedLeft, '=', qualifiedRight);
      }
      if (join.type === 'left') {
        // The joined (right) side is nullable — scope it in ON so genuinely
        // unmatched rows stay NULL-extended instead of being dropped by WHERE.
        applySecurityPredicatesToJoinOn(this, join.table, claims, joinedSecurity, 'read');
      } else if (join.type === 'right') {
        // The primary (left) side is nullable — scope the PRIMARY table in ON so
        // the preserved joined-side rows with no primary match survive.
        applySecurityPredicatesToJoinOn(this, queryPlan.table, claims, primarySecurity, 'read');
      }
    });
  }

  // ── Phase 1: Security predicates (applied unconditionally) ────────────────
  // Applied to the primary table and, by default, to every joined table — a
  // joined table inherits the primary table's resolved security columns unless
  // the host explicitly opts it out as a shared/lookup table (`perTable[table] =
  // null`). See `resolveJoinSecurityColumns`.
  //
  // Placement (finding 2.3): the primary table is scoped in WHERE, UNLESS a RIGHT
  // join makes it the nullable side (then its predicate moved to that join's ON
  // above). Joined tables are scoped in WHERE for inner/right joins; a LEFT join's
  // joined-table predicate already went into its ON clause above.
  //
  // MULTI-RIGHT-JOIN CORRECTNESS (iter22 finding) — a plain WHERE predicate on a
  // joined table is only safe when that table is guaranteed non-null in the
  // FINAL result. That holds for the LAST right join in the list (nothing joins
  // afterward to null it back out) but NOT for an EARLIER one: chained joins
  // associate left-to-right, so `(A RIGHT JOIN B) RIGHT JOIN C` null-extends the
  // ENTIRE accumulated `(A, B)` side — including B, even though B is the
  // guaranteed/preserved side of ITS OWN join — for a `C` row with no match. A
  // plain `WHERE b.<security column> = ...` then silently drops that preserved
  // `C` row. `lastRightJoinIndex` identifies the one join position that's safe
  // to treat as unconditionally non-null; every join at an EARLIER index is at
  // risk of being null-extended by that later right join (regardless of its OWN
  // type — an inner-joined table sitting between two right joins is equally at
  // risk) and gets the `OR <join-key> IS NULL` relaxation from
  // `applySecurityPredicatesOrNull` instead of a bare WHERE. See that function's
  // doc comment for why this does NOT just move the predicate to the join's own
  // ON clause (that would reopen the cross-tenant fan-out finding 2.3 closes).
  const rightJoinIndices = queryPlan.joins.reduce<number[]>((acc, join, index) => {
    if (join.type === 'right') {
      acc.push(index);
    }
    return acc;
  }, []);
  const lastRightJoinIndex =
    rightJoinIndices.length > 0 ? rightJoinIndices[rightJoinIndices.length - 1] : -1;
  const hasRightJoin = lastRightJoinIndex !== -1;
  if (!hasRightJoin) {
    applySecurityPredicates(
      query,
      queryPlan.table,
      claims,
      policy.forPrimaryTable(queryPlan.table),
      'read',
    );
  }

  queryPlan.joins.forEach((join, index) => {
    if (join.type === 'left') {
      return;
    }
    const security = policy.forJoinedTable(join.table);
    if (index < lastRightJoinIndex) {
      const nullIndicatorColumn = joinNullIndicatorColumn(join);
      if (nullIndicatorColumn) {
        applySecurityPredicatesOrNull(query, join.table, claims, security, nullIndicatorColumn);
        return;
      }
      // No `on` pair to key a null-check off of (degenerate/empty `on`, not
      // reachable via a validated descriptor) — fall through to the strict
      // WHERE below rather than skip enforcement entirely.
    }
    applySecurityPredicates(query, join.table, claims, security, 'read');
  });

  // ── Phase 2: User-supplied filter predicates ────────────────────────────
  // The filter columns are already alias-resolved on the plan (`plan.filters`
  // carry physical `ColumnRef`s — the same resolution `validateDescriptorColumns`
  // checked against `columnAllowlist`), so execution can never target a different
  // physical column than validation approved.
  //
  // TABLE-QUALIFICATION (finding 2.1): every OTHER column reference on the read
  // path is table-qualified to avoid "ambiguous column" errors under joins — SELECT
  // / GROUP BY / ORDER BY / aggregations (`execute.ts`'s `qualify()`) and all three
  // security-predicate dimensions (`emitSecurityPredicates` in `shared/predicates.ts`,
  // used above via `applySecurityPredicates`/`applySecurityPredicatesToJoinOn`). User
  // filter predicates were the sole exception: `applyPredicate` emits a bare
  // `where('<col>', ...)`, which Postgres/MySQL reject as ambiguous once a joined
  // table shares the column name (`region_id`, `id`, `status`, …). Qualify an
  // unqualified resolved filter column with the PRIMARY table here, mirroring
  // `execute.ts`'s `qualify()` — a column already containing a `.` (a
  // client-qualified reference, e.g. `customers.region_id`) is left untouched so it
  // still resolves against the table the caller explicitly named.
  const qualifiedFilters = (queryPlan.filters as FilterPredicate[]).map((filter) =>
    filter.column.includes('.')
      ? filter
      : { ...filter, column: `${queryPlan.table}.${filter.column}` },
  );
  applyPredicates(query, qualifiedFilters, 'read');

  // ── Phase 3: Post-aggregation HAVING predicates ──────────────────────────
  // Only allowed against aggregation aliases (validated by handler.ts before
  // this function is called). Uses Knex parameterized havingRaw to prevent injection.
  for (const h of queryPlan.having) {
    applyHaving(query, h, queryPlan.aggregations, queryPlan.table);
  }

  return query;
}

/**
 * A join-key column belonging to `join.table`, suitable as the `IS NULL`
 * null-extension indicator for `applySecurityPredicatesOrNull` (iter22 finding).
 *
 * Uses the RIGHT side of the join's first `on` pair — per `JoinDescriptor.on`'s
 * documented convention ("left column is from the primary table; right column
 * is from the joined table"), that's a column of `join.table` itself. Qualified
 * with `join.table` when the resolved column isn't already dotted, mirroring the
 * qualification the ON-clause loop above applies to the same pairs.
 *
 * Returns `undefined` only for a join with no `on` pairs at all — not reachable
 * via a validated descriptor (every join requires at least one `on` pair), kept
 * as a defensive fallback rather than a crash.
 */
function joinNullIndicatorColumn(join: {
  table: string;
  on: [string, string][];
}): string | undefined {
  const firstPair = join.on[0];
  if (!firstPair) {
    return undefined;
  }
  const [, right] = firstPair;
  return right.includes('.') ? right : `${join.table}.${right}`;
}

/** SQL aggregate function name per plan aggregation func — same five as `execute.ts`. */
const HAVING_FUNC_MAP: Record<PlanAggregation['func'], string> = {
  sum: 'SUM',
  avg: 'AVG',
  count: 'COUNT',
  min: 'MIN',
  max: 'MAX',
};

/**
 * Apply a HAVING predicate to a Knex query.
 *
 * The alias is already validated against aggregations by the caller (handler.ts).
 * Uses havingRaw with Knex bindings to prevent injection.
 *
 * DIALECT PORTABILITY (finding 2.5): the predicate re-emits the actual aggregate
 * EXPRESSION (`SUM(col) > ?`) rather than the SELECT output alias (`total > ?`).
 * PostgreSQL (and standard SQL) does not allow referencing a SELECT output alias
 * in HAVING — `HAVING total > 10000` errors with `42703 column "total" does not
 * exist` — whereas MySQL/SQLite tolerate it (which is why the jsdom `mockDb` test
 * suite, running neither Postgres nor a real SQL engine, never caught it). The
 * aggregate expression is valid on all three dialects. The `func`/column come from
 * the plan's `PlanAggregation` (whose alias the caller matched to `h.alias`), the
 * column identifier stays `??`-bound and the value `?`-bound.
 */
function applyHaving(
  query: any,
  h: HavingPredicate,
  aggregations: PlanAggregation[],
  table: string,
): void {
  const opMap: Record<HavingPredicate['operator'], string> = {
    eq: '=',
    gt: '>',
    lt: '<',
    gte: '>=',
    lte: '<=',
  };
  // Gate on an OWN-property check BEFORE the lookup. `h.operator` is client JSON
  // whose TS type is not a runtime guarantee, and `opMap` inherits from
  // `Object.prototype`, so a `!op` falsiness guard alone is bypassable: an
  // operator naming an inherited member (`"toString"`, `"constructor"`,
  // `"valueOf"`, …) resolves to a truthy inherited function and defeats the guard,
  // string-coercing a native-function source into the raw `havingRaw` fragment.
  // `hasOwnProperty` restricts the lookup to the five real, own operator keys —
  // the same fail-closed allowlist posture as `SAFE_OPERATORS` on the filter path.
  if (!Object.prototype.hasOwnProperty.call(opMap, h.operator)) {
    throw new Error(
      `MUI X Studio Server: Unsupported HAVING operator "${h.operator}". Allowed: eq, gt, lt, gte, lte.`,
    );
  }
  const op = opMap[h.operator];

  // Re-emit the aggregate expression rather than the alias (finding 2.5). The
  // matching aggregation is guaranteed to exist on the request path
  // (`validateHavingAliases` rejects a HAVING alias with no aggregation before this
  // runs); a direct caller that skipped validation fails closed with a clear error.
  const agg = aggregations.find((a) => a.alias === h.alias);
  if (!agg) {
    throw new Error(
      `MUI X Studio Server: HAVING alias "${h.alias}" does not match any aggregation alias. ` +
        `HAVING may only filter a declared aggregation, and the predicate re-emits that aggregate ` +
        `expression for cross-dialect portability. Declare an aggregation whose alias the HAVING references.`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(HAVING_FUNC_MAP, agg.func)) {
    throw new Error(
      `MUI X Studio Server: Aggregation function "${agg.func}" is not supported in HAVING. ` +
        `Supported aggregation functions are: sum, avg, count, min, max.`,
    );
  }
  const func = HAVING_FUNC_MAP[agg.func];
  // Qualify an unqualified aggregate column with the primary table (as SELECT /
  // GROUP BY / aggregations are in `execute.ts`) to avoid ambiguity under joins.
  const physical = agg.physical.includes('.') ? agg.physical : `${table}.${agg.physical}`;
  // havingRaw: ?? binds the column identifier, ? binds the value; the FUNC and
  // operator are fixed tokens from own-property-gated maps (never client text).
  query.havingRaw(`${func}(??) ${op} ?`, [physical, h.value]);
}
