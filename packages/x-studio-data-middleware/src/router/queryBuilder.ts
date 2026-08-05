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
  AGGREGATE_SQL_FUNCTIONS,
  toValidatedQueryPlan,
  type PlanAggregation,
  type ResolvedSemiJoin,
  type ValidatedQueryPlan,
} from '../security/validateQueryPlan';
import { qualifiedTableOf, qualifyAgainst } from '../shared/columnValidation';

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
  // VOLUME (Tier2 finding — resource exhaustion): this loop, and the per-pair
  // `.on()` calls inside it, run once per `[left, right]` pair across every
  // join. `handler.ts`'s `assertValidBatchQueryRequest` caps both the number of
  // joins AND each join's own `on` length individually — AND (the fix for this
  // finding) the TOTAL `on`-pairs summed across every join in the widget — so
  // this loop can never be asked to build more than `MAX_ARRAY_ITEMS_PER_DESCRIPTOR`
  // join conditions for one widget, regardless of how the client distributes
  // them across the `joins` array.
  //
  // OUTER-JOIN SECURITY PLACEMENT: the security predicate for the
  // NULLABLE side of an outer join goes in the JOIN's ON clause, not WHERE. A
  // joined-table tenant predicate in WHERE drops every NULL-extended row a LEFT
  // JOIN was meant to keep (turning it into an INNER join); the symmetric case for
  // a RIGHT JOIN drops the preserved joined-side rows via the PRIMARY table's WHERE
  // predicate. Placing it in ON scopes which rows JOIN (matched joined rows are
  // still tenant-checked — no cross-tenant fan-out) while preserving unmatched
  // outer rows. See `applySecurityPredicatesToJoinOn`.
  //
  // MULTI-RIGHT-JOIN ON-CLAUSE CORRECTNESS (data-corruption fix): the PRIMARY
  // table's security predicate belongs ONLY in the FIRST right join's ON clause,
  // never in a later one. Chained joins associate left-to-right, so
  // `(A RIGHT JOIN B) RIGHT JOIN C` computes `A RIGHT JOIN B` FIRST — by the time
  // that intermediate result reaches the SECOND right join, the primary table `A`
  // is already fully resolved (either a tenant-matching row, or legitimately NULL
  // because it had no match in the first join, or failed that join's own security
  // check). Re-adding `A`'s predicate to the SECOND join's ON clause tests a column
  // that is now legitimately NULL for rows where the first join's `B` genuinely
  // matched — `NULL = :tenant` reads as unknown/false, so the second join treats
  // that as "no match" and NULL-extends the WHOLE accumulated left side, wiping out
  // `B`'s already-resolved, legitimate columns too (not just `A`'s, which were
  // correctly NULL already). That silently corrupts the result: a row that should
  // show `B`'s data (with `A` correctly NULL) instead shows `B` wrongly NULLed out
  // as well. `firstRightJoinIndex` is the one join where the primary table is
  // actually a direct participant and could first become null-extended — injecting
  // the predicate there, and NOWHERE else, applies it exactly once, at the only
  // point it is semantically correct (mirroring how a LEFT join's joined-table
  // predicate is scoped to that join's OWN `on` clause and never re-applied later).
  const firstRightJoinIndex = queryPlan.joins.findIndex((j) => j.type === 'right');
  queryPlan.joins.forEach((join, index) => {
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
      // TABLE-QUALIFICATION: the join `on` pair is the last
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
      // qualified) column untouched. `qualifyAgainst` (`shared/columnValidation.ts`)
      // is the single implementation of that rule, shared with the filter,
      // HAVING, null-indicator and `execute.ts` projection sites.
      for (const [left, right] of join.on) {
        this.on(qualifyAgainst(queryPlan.table, left), '=', qualifyAgainst(join.table, right));
      }
      if (join.type === 'left') {
        // The joined (right) side is nullable — scope it in ON so genuinely
        // unmatched rows stay NULL-extended instead of being dropped by WHERE.
        applySecurityPredicatesToJoinOn(this, join.table, claims, joinedSecurity, 'read');
      } else if (join.type === 'right' && index === firstRightJoinIndex) {
        // The primary (left) side is nullable — scope the PRIMARY table in ON so
        // the preserved joined-side rows with no primary match survive. ONLY at the
        // first right join (see the block comment above) — re-applying this at a
        // later right join re-tests an already-resolved (possibly legitimately
        // NULL) primary table and corrupts the result.
        applySecurityPredicatesToJoinOn(this, queryPlan.table, claims, primarySecurity, 'read');
      }
    });
  });

  // ── Phase 1: Security predicates (applied unconditionally) ────────────────
  // Applied to the primary table and, by default, to every joined table — a
  // joined table inherits the primary table's resolved security columns unless
  // the host explicitly opts it out as a shared/lookup table (`perTable[table] =
  // null`). See `resolveJoinSecurityColumns`.
  //
  // Placement: the primary table is scoped in WHERE, UNLESS a RIGHT
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
  //
  // TENANT-LEAK FIX (Tier1, iter24 finding) — the relaxation itself is only safe
  // when its `OR <join-key> IS NULL` indicator column can ONLY read NULL because
  // of that later null-extension. `joinNullIndicatorColumn` now refuses to supply
  // one for a join whose OWN type is `right` — that table is itself the
  // PRESERVED side of ITS OWN join, so its own join-key column can be genuinely
  // NULL in a legitimately-participating row (no later null-extension involved),
  // and trusting it as the indicator let a cross-tenant row with a NULL join key
  // bypass its security predicate entirely. Such a join falls through to the
  // strict, unconditional `applySecurityPredicates` below instead (fail-closed —
  // may under-preserve a row in the multi-right-join edge case, never leaks one).
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
      // `joinNullIndicatorColumn` returns `undefined` for a `right`-typed join
      // (Tier1 fix — no column derived from ITS OWN `on` pair is a safe
      // null-extension indicator, see that function's doc comment) or a
      // degenerate/empty `on` (rejected fail-closed by `validateJoinOnPairs` in
      // `validateQueryPlan.ts` for the request path — kept as a defensive
      // fallback for a direct/test caller that bypasses that validator) — in
      // either case fall through to the strict WHERE below rather than skip
      // enforcement entirely.
    }
    applySecurityPredicates(query, join.table, claims, security, 'read');
  });

  // ── Phase 2: User-supplied filter predicates ────────────────────────────
  // The filter columns are already alias-resolved on the plan (`plan.filters`
  // carry physical `ColumnRef`s — the same resolution `validateDescriptorColumns`
  // checked against `columnAllowlist`), so execution can never target a different
  // physical column than validation approved.
  //
  // TABLE-QUALIFICATION: every OTHER column reference on the read
  // path is table-qualified to avoid "ambiguous column" errors under joins — SELECT
  // / GROUP BY / ORDER BY / aggregations (`execute.ts`'s `qualify()`) and all three
  // security-predicate dimensions (`emitSecurityPredicates` in `shared/predicates.ts`,
  // used above via `applySecurityPredicates`/`applySecurityPredicatesToJoinOn`). User
  // filter predicates were the sole exception: `applyPredicate` emits a bare
  // `where('<col>', ...)`, which Postgres/MySQL reject as ambiguous once a joined
  // table shares the column name (`region_id`, `id`, `status`, …). Qualify an
  // unqualified resolved filter column with the PRIMARY table here, through the
  // SAME `qualifyAgainst` (`shared/columnValidation.ts`) `execute.ts`'s `qualify()`
  // uses — a column already containing a `.` (a client-qualified reference, e.g.
  // `customers.region_id`) is left untouched so it still resolves against the
  // table the caller explicitly named.
  const qualifiedFilters = (queryPlan.filters as FilterPredicate[]).map((filter) => {
    const qualified = qualifyAgainst(queryPlan.table, filter.column);
    return qualified === filter.column ? filter : { ...filter, column: qualified };
  });
  applyPredicates(query, qualifiedFilters, 'read');

  // ── Phase 2b: Semi-joins ────────────────────────────────────────────────
  // `column IN (SELECT foreignColumn FROM table WHERE …)`. Applied AFTER the
  // outer user filters purely for readability of the emitted SQL — every
  // predicate here is AND-ed, so order carries no semantics, and the SECURITY
  // predicates (the ones whose ordering is load-bearing) were already applied to
  // both the outer query above and each subquery inside `applySemiJoins`.
  applySemiJoins(db, query, queryPlan.semiJoins, claims, policy);

  // ── Phase 3: Post-aggregation HAVING predicates ──────────────────────────
  // Only allowed against aggregation aliases (validated by handler.ts before
  // this function is called). Uses Knex parameterized havingRaw to prevent injection.
  for (const h of queryPlan.having) {
    applyHaving(query, h, queryPlan.aggregations, queryPlan.table);
  }

  return query;
}

/**
 * Apply every semi-join in `semiJoins` to `query` as
 * `WHERE <column> IN (SELECT <foreignColumn> FROM <table> WHERE …)`.
 *
 * WHY A SEMI-JOIN EXISTS AT ALL. A cross-source filter across a relationship that
 * is one-to-many from the querying widget's side cannot be expressed as a
 * `JoinDescriptor` without changing the answer: `LEFT JOIN orders ON
 * orders.customer_id = customers.id WHERE orders.status = 'shipped'` makes a
 * customer with three shipped orders contribute three rows, so `SUM(lifetime_value)`
 * reads 3× — wrong by a data-dependent factor, and invisible. The subquery form
 * filters the outer row set without multiplying it, which is exactly what
 * `dataSourceGraph.resolveRows` does in memory (group the cross-filters by foreign
 * source, evaluate them with ONE conjunctive pass, then ONE semi-join). See
 * `SemiJoinDescriptor` for why `IN (SELECT …)` rather than a correlated `EXISTS`.
 *
 * ── SECURITY: THE SUBQUERY IS A SECOND TABLE REFERENCE ──────────────────────
 *
 * Everything the join path guarantees for `joins[].table` must hold here, and the
 * one that is easy to get wrong is the ROW-LEVEL-SECURITY PREDICATE'S PLACEMENT.
 *
 * It goes INSIDE the subquery — `applySecurityPredicates(sub, …)` below — not on
 * the outer query. Scoping only the outer query would leave the inner SELECT
 * UNSCOPED, so it returns EVERY tenant's foreign keys, and any outer row whose own
 * (correctly tenant-scoped) key collides with one of them survives a filter it
 * never matched. With the tenant column typically being a surrogate id, collisions
 * are not hypothetical: `customers.id IN (SELECT customer_id FROM orders WHERE
 * status = 'shipped')` over an unscoped subquery lets tenant A's customer #7 be
 * admitted because tenant B's order references ITS customer #7. That is a
 * cross-tenant information leak — the EXISTENCE and filterable attributes of
 * another tenant's rows, read out through which of the caller's own rows survive —
 * and it leaks without ever returning a foreign row, so no row-level inspection of
 * the response would reveal it. The predicate is applied per NESTING LEVEL for the
 * same reason: an unscoped junction subquery leaks in exactly the same way.
 *
 * The scope is resolved through `policy.forJoinedTable(table)`, the SAME resolver
 * a `joins[].table` uses — so a semi-joined table is scoped BY DEFAULT (inheriting
 * the primary table's resolved column names when it has no `perTable` entry), a
 * per-dimension `null` drops just that dimension, and only an explicit whole-entry
 * `perTable[table] = null` (the host declaring a genuinely shared lookup table)
 * makes it unscoped. Reusing that resolver rather than re-deriving one is what
 * keeps a semi-joined table and the same table reached through a join from being
 * scoped differently.
 *
 * Predicate ORDER inside the subquery mirrors the outer query's invariant:
 * security predicates first, user filters second, so a client filter can never
 * be AND-ed ahead of — or in place of — the scope.
 *
 * Both column references arrive ALREADY table-qualified from the plan (see
 * `ResolvedSemiJoin`): `column` with the enclosing table and `foreignColumn` with
 * `table`. This function deliberately does not re-qualify them — the enclosing
 * table of a nested semi-join is its parent's `table`, not `plan.table`, so the
 * `qualifyAgainst(plan.table, …)` rule every other emission site applies would be
 * wrong here at depth ≥ 2.
 *
 * @param db - Knex instance, needed to construct each subquery's own builder.
 * @param query - The builder the `IN` predicate is attached to (the outer query,
 *   or a parent subquery when recursing).
 * @param semiJoins - Resolved semi-joins for THIS level.
 * @param claims - Pre-verified security claims.
 * @param policy - The compiled security policy every level resolves its scope through.
 */
function applySemiJoins(
  db: any, // Knex.Knex
  query: any,
  semiJoins: ResolvedSemiJoin[],
  claims: JwtSecurityClaims,
  policy: CompiledSecurityPolicy,
): void {
  for (const semiJoin of semiJoins) {
    const subquery = db(semiJoin.table);
    // Exactly ONE projected column: `x IN (SELECT a, b …)` is a syntax error on
    // every mainstream dialect, and the descriptor shape (a single
    // `foreignColumn`) makes a multi-column projection unrepresentable.
    subquery.select(semiJoin.foreignColumn);
    // SECURITY FIRST, INSIDE the subquery — see this function's docblock. Resolved
    // through the same `forJoinedTable` a joined table uses, so a semi-joined table
    // is scoped by default and only a host-declared shared table joins unscoped.
    applySecurityPredicates(
      subquery,
      semiJoin.table,
      claims,
      policy.forJoinedTable(semiJoin.table),
      'read',
    );
    // User filters second. Columns are already qualified with `semiJoin.table` on
    // the plan, so no re-resolution or re-qualification happens here — the same
    // structural guarantee `buildSecureQuery`'s outer filter loop relies on.
    applyPredicates(subquery, semiJoin.filters as FilterPredicate[], 'read');
    // Nested levels (two-hop many-to-many) recurse into the SUBQUERY, so each
    // level gets its own inner security predicate. Bounded by
    // `MAX_SEMI_JOIN_DEPTH`, enforced fail-closed in `validateSemiJoins`.
    applySemiJoins(db, subquery, semiJoin.semiJoins, claims, policy);
    // Knex accepts a query builder as `whereIn`'s second argument and renders it
    // as a subquery — the same `whereIn` the value-list form uses, so there is no
    // second predicate-emission path to keep in sync.
    query.whereIn(semiJoin.column, subquery);
  }
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
 * TENANT-LEAK FIX (Tier1, iter24 finding) — this indicator is only safe when
 * `join.table`'s OWN join REQUIRES a match for `join.table` to appear at all
 * (an inner join: `NULL` never equals anything, so a matched row's join-key
 * column is guaranteed non-null; the ONLY way it later reads NULL is a
 * SUBSEQUENT join null-extending the whole accumulated side, which is exactly
 * the condition this indicator is meant to detect). That guarantee does NOT
 * hold when `join.table` is itself the PRESERVED (right) side of ITS OWN join
 * (`join.type === 'right'`) — a right join keeps every row of `join.table`
 * regardless of whether the `on` match succeeded, so `join.table`'s own
 * join-key column can be genuinely NULL in the raw, legitimately-participating
 * row (e.g. an untouched nullable FK), with no later null-extension involved at
 * all. Trusting that column as the indicator then lets a cross-tenant row with
 * a coincidentally-NULL join key satisfy the `OR <col> IS NULL` escape hatch and
 * bypass its tenant/region/department predicate entirely — a real leak once >= 2
 * right joins are chained (`(A RIGHT JOIN B) RIGHT JOIN C`, tenant predicate
 * relaxed on B). This package has no NOT-NULL schema metadata that would let it
 * pick a genuinely-safe substitute column for a right-joined table, so it fails
 * CLOSED instead: returning `undefined` here for a `right`-typed join routes the
 * caller to the existing "no safe indicator" fallback, which keeps the STRICT,
 * unconditional WHERE predicate for that table. That can, for a multi-right-join
 * shape, drop a row a LATER right join legitimately preserved (the routing/perf
 * cost the iter22 relaxation existed to avoid) — a correctness/perf regression,
 * never a security leak, and the explicitly preferred tradeoff here.
 *
 * CONVENTION VERIFICATION (untrusted-convention finding): nothing upstream
 * actually PROVES the right side names `join.table` — `validateDescriptorColumns`
 * (only run when a `columnAllowlist` is configured) checks an UNQUALIFIED right
 * side against `join.table`'s allowlist entry, but a client-QUALIFIED reference
 * (`otherTable.col`) is instead checked against `otherTable`'s OWN allowlist
 * entry, which happily passes for a column belonging to a WHOLLY DIFFERENT table
 * (e.g. the primary table, if the client inverts or malforms the `on` pair). If
 * this function blindly trusted such a reference, it would hand
 * `applySecurityPredicatesOrNull` a null-indicator column that does not actually
 * belong to `join.table` — in a multi-right-join shape, an `IS NULL` check on the
 * WRONG column can admit rows the security-predicate relaxation was never meant
 * to let through. When the resolved right-side reference is explicitly
 * table-qualified, this now verifies the qualifying table IS `join.table` and
 * throws (fail-closed) otherwise, instead of silently using a column from a
 * different table. An unqualified reference is qualified with `join.table` here
 * (as before) — that's the same qualification the ON-clause loop above applies to
 * the identical pair, so there is no room for it to name a different table. This
 * verification only runs for a NON-`right` join now — a `right`-typed join
 * returns `undefined` above before reaching it, since the resulting column would
 * be discarded either way.
 *
 * Returns `undefined` for a `right`-typed join (see above) or a join with no
 * `on` pairs at all (rejected fail-closed by `validateJoinOnPairs` in
 * `validateQueryPlan.ts` for every request-path descriptor — every join
 * reaching this function via the request path is guaranteed at least one `on`
 * pair; the empty-array branch here is a defensive fallback for a direct/test
 * caller that bypasses that validator, rather than a crash).
 */
function joinNullIndicatorColumn(join: {
  table: string;
  type?: 'inner' | 'left' | 'right';
  on: [string, string][];
}): string | undefined {
  if (join.type === 'right') {
    return undefined;
  }
  const firstPair = join.on[0];
  if (!firstPair) {
    return undefined;
  }
  const [, right] = firstPair;
  const qualifiedTable = qualifiedTableOf(right);
  if (qualifiedTable === undefined) {
    // Unqualified — qualified with `join.table` here, the SAME rule (and the same
    // `qualifyAgainst` implementation) the ON-clause loop above applies to this
    // identical pair, so the two can never name different tables.
    return qualifyAgainst(join.table, right);
  }
  if (qualifiedTable !== join.table) {
    throw new Error(
      `MUI X Studio Server: JOIN "on" pair for table "${join.table}" has a right-hand column ` +
        `"${right}" qualified with table "${qualifiedTable}" instead of "${join.table}". ` +
        `The right side of a join's "on" pair must reference the joined table itself — this column is used ` +
        `to detect when "${join.table}" was null-extended by a later right join, and trusting a column from ` +
        `a different table there could admit rows a security predicate was meant to exclude. ` +
        `Qualify the right-hand "on" column with "${join.table}" (or leave it unqualified).`,
    );
  }
  return right;
}

/**
 * Apply a HAVING predicate to a Knex query.
 *
 * The alias is already validated against aggregations by the caller (handler.ts).
 * Uses havingRaw with Knex bindings to prevent injection.
 *
 * DIALECT PORTABILITY: the predicate re-emits the actual aggregate
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
      `MUI X Studio Server: Unsupported HAVING operator "${h.operator}". ` +
        `The operator becomes the comparison in the emitted HAVING fragment, so one outside the supported set has ` +
        `no comparison to compile to — admitting it would either build malformed SQL or drop the predicate, ` +
        `returning every aggregation group as though the filter had matched them all. ` +
        `Use one of: eq, gt, lt, gte, lte.`,
    );
  }
  const op = opMap[h.operator];

  // Re-emit the aggregate expression rather than the alias. The
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
  // Own-property-gated against the SHARED `AGGREGATE_SQL_FUNCTIONS`
  // (`security/validateQueryPlan.ts`) that `execute.ts` gates on too — one table,
  // so the two enforcement sites cannot disagree about which functions exist.
  if (!Object.prototype.hasOwnProperty.call(AGGREGATE_SQL_FUNCTIONS, agg.func)) {
    throw new Error(
      `MUI X Studio Server: Aggregation function "${agg.func}" is not supported in HAVING. ` +
        `Supported aggregation functions are: sum, avg, count, min, max.`,
    );
  }
  const func = AGGREGATE_SQL_FUNCTIONS[agg.func];
  // Qualify an unqualified aggregate column with the primary table (as SELECT /
  // GROUP BY / aggregations are in `execute.ts`) to avoid ambiguity under joins —
  // through the shared `qualifyAgainst`, the same rule those sites use.
  const physical = qualifyAgainst(table, agg.physical);
  // havingRaw: ?? binds the column identifier, ? binds the value; the FUNC and
  // operator are fixed tokens from own-property-gated maps (never client text).
  query.havingRaw(`${func}(??) ${op} ?`, [physical, h.value]);
}
