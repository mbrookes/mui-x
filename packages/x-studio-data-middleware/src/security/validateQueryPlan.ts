/**
 * Compile + validate the COLUMN-REFERENCE resolution for one widget ONCE per
 * request — the read-path analogue of `compileSecurityPolicy`.
 *
 * Gap: alias resolution (`resolveAlias`) and allowlist
 * validation (`checkColumnAgainstAllowlist`) were run at the TOP of
 * `handleBatchQuery`, but produced NO artifact — the same
 * `BatchWidgetDescriptor`, still carrying raw logical column names and a
 * `columnAliases` map, was threaded down into `buildSecureQuery` and
 * `executeForTier`, which then EACH re-ran `resolveAlias` fresh at ~10 of their
 * own call sites (SELECT / ORDER BY / GROUP BY / aggregation columns / join `on`
 * pairs / filter predicates). Validation-at-the-top gave no structural guarantee
 * that every one of those independent re-resolution sites ran (or would keep
 * running as the files evolve) — a future site reading `descriptor.columns` /
 * `.filters` / `.orderBy` directly would silently use an unresolved logical name.
 * This is exactly the class of bug the two historical drift incidents (filter
 * predicates vs. join predicates — see `shared/columnValidation.ts`) came from.
 *
 * This module centralizes resolution + validation into one boundary object:
 *
 *   - `validateQueryPlan(descriptor, columnAllowlist)` runs the UNCONDITIONAL
 *     validators (`validateHavingAliases` / `validateAggregationAliases`) and,
 *     when a `columnAllowlist` is supplied, `validateDescriptorColumns` — reusing
 *     those EXISTING functions verbatim (no error-text changes) — then resolves
 *     every column reference ONCE via `resolveAlias` into a plan whose fields are
 *     already-resolved `ColumnRef`s.
 *   - The plan carries NO `columnAliases` field and no raw unresolved logical
 *     names, so the ambiguous client form is structurally UNREACHABLE past this
 *     boundary: downstream code reads pre-resolved `ColumnRef`s off the plan and
 *     has nothing left to (mis)resolve.
 *
 * SECURITY: this stage is behavior-preserving. Resolution funnels through the
 * SAME `resolveAlias` the validators use, so centralizing changes WHERE alias
 * resolution runs (once, here) — never WHAT a given logical reference resolves to.
 */
import type {
  BatchWidgetDescriptor,
  FilterPredicate,
  HavingPredicate,
  AggregationSpec,
  SemiJoinDescriptor,
} from './types';
import {
  isWildcardReference,
  qualifiedTableOf,
  qualifyAgainst,
  resolveAlias,
  SAFE_ALIAS_PATTERN,
  validateAggregationAliases,
  validateDescriptorColumns,
  validateHavingAliases,
  validateProjectionKeyCollisions,
  validateWildcardProjection,
} from '../shared/columnValidation';
import { assertStringArrayAllowlist } from '../shared/allowlistShape';
import { MAX_SEMI_JOIN_DEPTH } from '../shared/limits';

/**
 * A physical SQL column reference that has ALREADY been alias-resolved (through
 * `resolveAlias`) and — when a column allowlist is configured — allowlist-checked.
 *
 * Branded so a plain `string` is NOT assignable to `ColumnRef` without going
 * through `validateQueryPlan` (the only place `asColumnRef` is called). A
 * downstream function that wants a `ColumnRef` therefore cannot accidentally be
 * handed an unvalidated/unresolved raw logical name — TypeScript enforces it
 * structurally, not by convention.
 */
export type ColumnRef = string & { readonly __brand: 'ColumnRef' };

/** A `FilterPredicate` whose `column` has been resolved to a physical `ColumnRef`. */
export type ResolvedFilterPredicate = FilterPredicate extends infer T
  ? T extends { column: string }
    ? Omit<T, 'column'> & { column: ColumnRef }
    : never
  : never;

/** A resolved JOIN — every `on` pair carries physical `ColumnRef`s on both sides. */
export interface ResolvedJoin {
  table: string;
  type?: 'inner' | 'left' | 'right';
  /** `[leftColumn, rightColumn]` pairs, both alias-resolved to physical columns. */
  on: [ColumnRef, ColumnRef][];
}

/**
 * A resolved SEMI-JOIN — `column IN (SELECT foreignColumn FROM table WHERE …)`.
 *
 * Both column references are alias-resolved AND already table-qualified (`column`
 * with the ENCLOSING table, `foreignColumn` with `table`), so `buildSecureQuery`
 * hands them to Knex without re-deriving either rule. Qualifying here rather than
 * at emission time matters more than for the other plan fields: the enclosing
 * table of a NESTED semi-join is its parent's `table`, not the descriptor's
 * primary table, so an emitter re-deriving the qualification would need to thread
 * that context itself — and `qualifyAgainst(plan.table, …)` (the rule every other
 * site uses) would be silently WRONG at depth ≥ 2.
 */
export interface ResolvedSemiJoin {
  table: string;
  /** Outer column, qualified with the enclosing table. */
  column: ColumnRef;
  /** Subquery projection column, qualified with `table`. */
  foreignColumn: ColumnRef;
  /** Predicates applied inside the subquery, columns alias-resolved and qualified with `table`. */
  filters: ResolvedFilterPredicate[];
  /** Nested semi-joins applied inside this subquery (two-hop many-to-many). */
  semiJoins: ResolvedSemiJoin[];
}

/** A resolved projection column. */
export interface PlanProjectionColumn {
  /** The physical (alias-resolved) column to project. */
  physical: ColumnRef;
  /**
   * The logical output id to project the physical column AS (`?? as ??`), set
   * ONLY when the client referenced an expression field whose logical id differs
   * from its physical column. `undefined` when the client referenced the physical
   * column directly (no rename) — the column is then qualified with the primary
   * table at execution time instead.
   */
  outputAlias?: string;
}

/** A resolved aggregation. */
export interface PlanAggregation {
  /** The physical (alias-resolved) column to aggregate. */
  physical: ColumnRef;
  func: AggregationSpec['func'];
  /** Output alias — already validated as a safe identifier by `validateAggregationAliases`. */
  alias: string;
}

/**
 * The five aggregate functions this package supports, mapped to their SQL name.
 *
 * ONE definition, consumed by every site that has to know the set:
 *   - `router/queryBuilder.ts`'s `applyHaving` needs the SQL NAME, because a
 *     HAVING predicate re-emits the aggregate expression (`SUM(??) > ?`) rather
 *     than the SELECT output alias, for PostgreSQL portability.
 *   - `router/execute.ts` needs the KEY as an own-property gate before calling
 *     the same-named Knex builder method (`query.sum({ [alias]: col })` etc.);
 *     the five keys are also the five Knex method names.
 *
 * `agg.func` is client JSON, so both sites must gate on
 * `Object.prototype.hasOwnProperty.call(AGGREGATE_SQL_FUNCTIONS, agg.func)` and
 * fail closed — a dropped measure would surface as a silently incomplete result.
 * Keeping the set here, next to `PlanAggregation['func']`, makes the type and the
 * runtime table impossible to drift apart; they were previously a `Record` in
 * `queryBuilder.ts` and a `switch` in `execute.ts` kept in sync by a comment.
 */
export const AGGREGATE_SQL_FUNCTIONS: Record<AggregationSpec['func'], string> = {
  sum: 'SUM',
  avg: 'AVG',
  count: 'COUNT',
  min: 'MIN',
  max: 'MAX',
};

/** A resolved ORDER BY entry. */
export interface PlanOrderBy {
  direction: 'asc' | 'desc';
  /**
   * Set when the order target is an aggregation alias (NOT a physical column) —
   * used as-is, never qualified.
   */
  aggAlias?: string;
  /**
   * Set when the order target is a physical column — qualified with the primary
   * table at execution time.
   */
  physical?: ColumnRef;
}

/**
 * The compiled, validated column-reference plan for one widget descriptor.
 *
 * A single boundary object produced ONCE by `validateQueryPlan`. Every field is
 * already alias-resolved; there is deliberately NO `columnAliases` field and no
 * raw logical column names, so downstream `buildSecureQuery` / `executeForTier`
 * read pre-resolved `ColumnRef`s and never call `resolveAlias` themselves.
 */
export interface ValidatedQueryPlan {
  /** Primary table (carried through unchanged — table names are out of this stage's scope). */
  table: string;
  /** Resolved joins (both sides of every `on` pair alias-resolved). */
  joins: ResolvedJoin[];
  /** Resolved semi-joins (`column IN (SELECT foreignColumn FROM table WHERE …)`). */
  semiJoins: ResolvedSemiJoin[];
  /** Resolved user filter predicates (column alias-resolved). */
  filters: ResolvedFilterPredicate[];
  /** HAVING predicates (reference aggregation aliases, not columns — carried unchanged). */
  having: HavingPredicate[];
  /** Resolved projection columns. */
  columns: PlanProjectionColumn[];
  /** Resolved aggregations. */
  aggregations: PlanAggregation[];
  /** Resolved ORDER BY entries. */
  orderBy: PlanOrderBy[];
  /** Row limit (carried through unchanged). */
  limit?: number;
  /**
   * Discriminant so `isValidatedQueryPlan` / `toValidatedQueryPlan` can tell a
   * compiled plan apart from a raw descriptor without a structural guess.
   */
  readonly kind: 'validated-query-plan';
}

/** The single cast point that mints a `ColumnRef` from a resolved physical name. */
function asColumnRef(physical: string): ColumnRef {
  return physical as ColumnRef;
}

/**
 * The result-row KEY a directly-projected physical column lands under — the last
 * dot-segment of its (possibly table-qualified) name, e.g. `orders.category` →
 * `category`. Knex assigns a bare `SELECT orders.category` this key on the row
 * object, so it is the key an aggregation alias can collide with.
 *
 * NON-STRING TOLERANCE: `physical` derives from client JSON via
 * `resolveAlias`, so an aggregation with a missing/non-string `column` reached
 * `undefined.lastIndexOf` here and threw a raw `TypeError` that
 * `sanitizeBoundaryError` degraded to a generic message. The request path now
 * rejects that shape up front in `assertQualifiedColumnsAllowed`, but this
 * function is also reached from `buildPlan` via `toValidatedQueryPlan`, whose
 * direct-caller branch deliberately runs NO validators — coercing keeps that
 * branch's documented no-throw behavior instead of crashing on it.
 */
function resultKeyOf(physical: string): string {
  const value = typeof physical === 'string' ? physical : String(physical);
  const dot = value.lastIndexOf('.');
  return dot === -1 ? value : value.slice(dot + 1);
}

/**
 * Reject a WILDCARD in `aggregations[].column`.
 *
 * CORRECTNESS INVARIANT — runs UNCONDITIONALLY for every widget (independent of
 * whether a `columnAllowlist` is configured), mirroring
 * `validateWildcardProjection`, which is the guard this one completes.
 * `validateWildcardProjection` runs over `descriptor.columns` ONLY, so
 * `{ column: '*', func: 'count', alias: 'n' }` slipped past every check and
 * reached `execute.ts`'s `qualify()`, which emitted `count("orders".*)` on all
 * three dialects. SQLite rejects that with `near "*": syntax error` and MySQL
 * likewise — both then masked by `sanitizeBoundaryError` into the generic
 * per-widget error, so the client is told nothing about what it got wrong.
 * PostgreSQL is the worse case: it PARSES `count(orders.*)` as a composite-type
 * argument, which succeeds and answers a different question than the one asked.
 *
 * A `columnAllowlist` naming concrete columns already rejected this (`"*"` is not
 * in the list), but the two other supported postures did not: a
 * `schemaAllowlist`-only deployment (the README quick-start shape) has no column
 * list to fail against, and `columnAllowlist: { orders: ['*'] }` — the documented
 * "allow all of this table's columns" opt-out — admits the literal `"*"`.
 *
 * References are resolved through `resolveAlias` first (matching every other
 * validator), so a wildcard reached through `columnAliases` is caught too. A
 * non-string `column` is left to `validateAggregationAliases`, which owns the
 * fail-closed shape rejection and reports the real problem.
 */
function validateAggregationColumns(descriptor: BatchWidgetDescriptor): void {
  for (const agg of descriptor.aggregations ?? []) {
    const physical = resolveAlias(descriptor, agg?.column as string);
    if (typeof physical !== 'string' || !isWildcardReference(physical)) {
      continue;
    }
    throw new Error(
      `MUI X Studio Server: Aggregation column "${agg.column}" is a wildcard reference. ` +
        `An aggregate takes ONE value per row, while a wildcard stands for a whole set of columns, so this ` +
        `emits SQL such as COUNT("${descriptor.table}".*) — which SQLite and MySQL reject as a syntax error, ` +
        `and which PostgreSQL silently accepts as a composite-type argument answering a different question. ` +
        `COUNT(*) is not expressible in this protocol: aggregate a concrete column instead, counting a NOT NULL ` +
        `column when you want the number of rows.`,
    );
  }
}

/** Accepts only the two canonical SQL sort directions (case-insensitive). */
const SAFE_ORDER_BY_DIRECTION = /^(asc|desc)$/i;

/**
 * Validate every ORDER BY direction against a fail-closed allowlist.
 *
 * CORRECTNESS INVARIANT — runs UNCONDITIONALLY for every widget (independent of
 * whether a `columnAllowlist` is configured). `ob.direction` is client JSON that
 * `execute.ts` passes as the second argument of Knex `.orderBy(col, direction)`.
 *
 * This is NOT an injection guard. Knex sanitizes the direction token itself:
 * `direction()` in `knex/lib/formatter/wrappingFormatter.js` is
 * `orderBys.indexOf((value || '').toLowerCase()) !== -1 ? value : 'asc'`, so an
 * unrecognized token never reaches the SQL — verified against the pinned
 * `knex@3.2.10`, where `orderBy('a', 'asc; drop table x')` emits
 * `order by "a" asc`.
 *
 * That silent coercion is exactly why the check is worth keeping: a typo
 * (`'descending'`, `'DSC'`) or a non-string wire value does not fail, it returns
 * data sorted the OPPOSITE way with no signal at all — a wrong answer rendered as
 * a correct-looking chart. Rejecting it here turns a silently mis-sorted result
 * into a clean per-widget error naming the bad token. Kept module-private: no
 * other consumer needs it (mutations have no ORDER BY).
 */
function validateOrderByDirections(descriptor: BatchWidgetDescriptor): void {
  for (const ob of descriptor.orderBy ?? []) {
    if (typeof ob.direction !== 'string' || !SAFE_ORDER_BY_DIRECTION.test(ob.direction)) {
      throw new Error(
        `MUI X Studio Server: ORDER BY direction "${ob.direction}" is not allowed. ` +
          `The query builder silently coerces an unrecognized direction to "asc", so this widget would return ` +
          `wrongly-ordered rows with no other indication that the direction was ignored. ` +
          `Use "asc" or "desc".`,
      );
    }
  }
}

/**
 * Validate every ORDER BY TARGET of an AGGREGATION widget against the query's
 * actual grain.
 *
 * CORRECTNESS INVARIANT — runs UNCONDITIONALLY for every widget (independent of
 * whether a `columnAllowlist` is configured), and is a no-op for a descriptor
 * with no `aggregations` (without a GROUP BY there is no grain to violate: every
 * row has its own value for any column, so any orderable column stays legal).
 *
 * `execute.ts`'s `orderColumnOf` qualifies ANY non-alias order target with the
 * primary table and emits it verbatim, with no check against the GROUP BY
 * dimensions. So
 *
 *   { columns: ['category'],
 *     aggregations: [{ column: 'amount', func: 'sum', alias: 'total' }],
 *     orderBy: [{ column: 'created_at', direction: 'desc' }] }
 *
 * emitted `… group by "orders"."category" order by "orders"."created_at" desc`.
 * Each result row is a whole GROUP, and `created_at` has no single value inside
 * one: PostgreSQL rejects the query (42803) and MySQL under the default
 * `ONLY_FULL_GROUP_BY` raises `ER_MIX_OF_GROUP_FUNC_AND_FIELDS` — both then
 * masked by `sanitizeBoundaryError` into the generic per-widget error, so the
 * client cannot tell what it sent wrong. SQLite is the dangerous one: it ACCEPTS
 * the query and sorts each group by an ARBITRARY member row's value, handing back
 * nondeterministic order presented as sorted data.
 *
 * This is the same class of failure `validateOrderByDirections` exists to prevent
 * (a silently wrong ordering rather than an error), and `validateHavingAliases`
 * already enforces the analogous rule for the other post-aggregation clause — so
 * this throws in the same shape, listing what IS orderable.
 *
 * A legal target is a declared aggregation ALIAS, or a projected column that is a
 * GROUP BY DIMENSION — that is, a projected column the descriptor does NOT
 * aggregate. Membership is compared on primary-table-qualified physicals,
 * exactly as `execute.ts`'s `measureColSet` / `dimensionColumns` split does, so a
 * qualified dimension and an unqualified order target still match.
 */
function validateOrderByTargets(descriptor: BatchWidgetDescriptor): void {
  const aggregations = descriptor.aggregations ?? [];
  const orderBy = descriptor.orderBy ?? [];
  if (aggregations.length === 0 || orderBy.length === 0) {
    return;
  }
  const qualify = (physical: string): string => qualifyAgainst(descriptor.table, physical);
  const aggAliases = new Set(aggregations.map((agg) => agg?.alias));
  // Every AGGREGATED column, so a projected measure is not mistaken for a
  // dimension — `execute.ts` keeps it out of GROUP BY, so it is exactly as
  // unorderable as a column that was never projected at all.
  const measurePhysicals = new Set<string>();
  for (const agg of aggregations) {
    const physical = resolveAlias(descriptor, agg?.column as string);
    if (typeof physical === 'string') {
      measurePhysicals.add(qualify(physical));
    }
  }
  const dimensions = new Set<string>();
  for (const column of descriptor.columns ?? []) {
    const physical = resolveAlias(descriptor, column);
    if (typeof physical === 'string' && !measurePhysicals.has(qualify(physical))) {
      dimensions.add(qualify(physical));
    }
  }
  for (const ob of orderBy) {
    if (typeof ob?.column !== 'string' || aggAliases.has(ob.column)) {
      // A non-string column is left to the allowlist/shape validators, which own
      // the fail-closed rejection and report the real problem.
      continue;
    }
    const physical = resolveAlias(descriptor, ob.column);
    if (typeof physical === 'string' && dimensions.has(qualify(physical))) {
      continue;
    }
    throw new Error(
      `MUI X Studio Server: ORDER BY column "${ob.column}" is neither a GROUP BY dimension nor an aggregation ` +
        `alias of this widget. Orderable here: ${[...dimensions, ...aggAliases].join(', ') || '(none)'}. ` +
        `Each row of an aggregation query is a whole GROUP, so a column outside the grouping has no single value ` +
        `to sort by: PostgreSQL and MySQL (under the default ONLY_FULL_GROUP_BY) reject the query outright, while ` +
        `SQLite accepts it and sorts each group by an ARBITRARY member row — returning nondeterministic order ` +
        `presented as sorted data. ` +
        `Order by one of the projected non-aggregated columns or by an aggregation alias, or add "${ob.column}" ` +
        `to "columns" to make it part of the grouping.`,
    );
  }
}

/** Accepts only the three canonical SQL join types (case-insensitive). */
const SAFE_JOIN_TYPE = /^(inner|left|right)$/i;

/**
 * Validate every JOIN `type` against a fail-closed allowlist.
 *
 * SECURITY INVARIANT — runs UNCONDITIONALLY for every widget (independent of
 * whether a `columnAllowlist` is configured), mirroring `validateOrderByDirections`.
 * `join.type` is client JSON that `queryBuilder.ts`'s `buildSecureQuery` matches
 * with EXACT lowercase `=== 'left'` / `=== 'right'` checks — to pick `leftJoin`/
 * `rightJoin` vs the default inner `join`, AND (critically) to decide whether the
 * joined-table security predicate goes in the ON clause (outer join) or the WHERE
 * clause. An unrecognized value (`'full'`, `'cross'`), a typo, or a wrong-case
 * `'LEFT'` would fall through EVERY exact-match check: the join silently degrades to
 * INNER and the joined table's tenant predicate lands in WHERE instead of ON. So
 * constrain the value to `inner`/`left`/`right` (fail-closed).
 *
 * NON-MUTATING: this validator does NOT rewrite `join.type` on the
 * caller's descriptor — the descriptor is the host-owned parsed request body, and a
 * pure validator must not mutate it. Canonical lowercasing happens where it is
 * actually consumed: `buildPlan` lowercases `join.type` onto the PLAN (so
 * `buildSecureQuery`'s exact-match checks stay correct), and `computeQueryHash`
 * lowercases it on a hash-input COPY (so `LEFT`/`left` share a cache entry). Runs per
 * widget inside `processWidget`, so a bad value yields that widget's own `{ error }`
 * rather than rejecting the whole batch.
 */
function validateJoinTypes(descriptor: BatchWidgetDescriptor): void {
  for (const join of descriptor.joins ?? []) {
    if (join.type === undefined) {
      continue;
    }
    if (typeof join.type !== 'string' || !SAFE_JOIN_TYPE.test(join.type)) {
      throw new Error(
        `MUI X Studio Server: JOIN type "${join.type}" is not allowed. ` +
          `The join type decides whether a joined table's security predicate is enforced in the ON clause (outer join) or the WHERE clause, and an unrecognized value silently degrades the join to INNER with the predicate misplaced. ` +
          `Use "inner", "left" or "right".`,
      );
    }
  }
}

/**
 * Validate every JOIN `on` against a fail-closed non-empty-array guard AND a fail-closed
 * table-qualification convention.
 *
 * SECURITY INVARIANT — runs UNCONDITIONALLY for every widget (independent of
 * whether a `columnAllowlist` is configured), mirroring `validateJoinTypes` /
 * `validateOrderByDirections`. `join.on` is client JSON that `queryBuilder.ts`'s
 * `buildSecureQuery` iterates with a plain `for (const [left, right] of join.on)`
 * loop to emit `.on(left, '=', right)` conditions inside the Knex join callback —
 * nothing upstream previously required that loop to run at least once. A
 * descriptor with `on: []` (or a missing/non-array `on`) passed every existing
 * validator, then reached the query builder with ZERO `.on()` calls: Postgres
 * renders the resulting join with no condition as a syntax error (an opaque,
 * sanitized per-widget failure), but MySQL renders it as a VALID CROSS JOIN — a
 * tenant-bounded cartesian product that returns silently wrong, row-multiplied
 * results instead of failing at all. Reject fail-closed here instead, before the
 * descriptor ever reaches query construction.
 *
 * TAUTOLOGICAL / SELF-REFERENTIAL `on` PAIRS — closing the empty-`on` CROSS JOIN case above does
 * not stop a NON-empty pair that is degenerate in a different way: `on: [['customers.id',
 * 'customers.id']]`, where BOTH sides are explicitly qualified with the SAME table, passes the
 * schema allowlist (both are real columns on a real, allowlisted table) and the column allowlist
 * (both are real, allowed columns) — but it emits a tautological `customers.id = customers.id` ON
 * condition instead of a real join key, which SQL engines execute as an unconditional match: a
 * cartesian product between `customers` and whatever is already accumulated, still fully within the
 * tenant/region/department-scoped rows (no cross-tenant leak) but silently multiplying every row.
 * `joinNullIndicatorColumn` (`router/queryBuilder.ts`) already fails closed on a related shape for
 * its own narrow consumer (the right side of the FIRST `on` pair must qualify `join.table` itself);
 * this validator generalizes that same left/right table convention to the join- building path as a
 * whole, mirroring `validateDescriptorColumns`'s existing left-is-primary/right-is-joined
 * convention:
 *   - A qualified RIGHT side must name `join.table` — the joined table itself.
 *   - A qualified LEFT side must name the primary table OR a table joined
 *     EARLIER in this same descriptor (a table already available in the
 *     accumulated FROM/JOIN chain at this point) — critically, NOT `join.table`
 *     itself. This is what rejects the tautological example above: qualifying
 *     the left side with `join.table` (the table THIS join is introducing) can
 *     only ever produce `join.table.x = join.table.y`, a condition internal to
 *     the joined table rather than a real join key linking it to the rest of
 *     the query.
 * Column references are resolved via `resolveAlias` first (matching
 * `validateDescriptorColumns`'s convention) so a logical/expression-field id
 * that maps to a qualified physical column is checked on the resolved name, not
 * the raw client string. An unqualified side is left unconstrained here (Knex
 * qualifies it automatically at build time — the left with the primary table,
 * the right with `join.table` — so an unqualified pair can never land on the
 * SAME table unless the primary table and `join.table` coincide, which is out
 * of scope for this check).
 */
function validateJoinOnPairs(descriptor: BatchWidgetDescriptor): void {
  const knownTables: string[] = [descriptor.table];
  for (const join of descriptor.joins ?? []) {
    if (!Array.isArray(join.on) || join.on.length === 0) {
      throw new Error(
        `MUI X Studio Server: JOIN on table "${join.table}" has no "on" conditions. ` +
          `A join with an empty (or missing) "on" list emits no ON conditions at all, which some database ` +
          `engines (e.g. MySQL) silently execute as a CROSS JOIN — a tenant-bounded cartesian product that returns ` +
          `wrong, row-multiplied results instead of failing. ` +
          `Provide at least one [leftColumn, rightColumn] pair in "on" for every join.`,
      );
    }
    for (const [left, right] of join.on) {
      const resolvedLeft = resolveAlias(descriptor, left);
      const resolvedRight = resolveAlias(descriptor, right);
      const leftTable = qualifiedTableOf(resolvedLeft);
      const rightTable = qualifiedTableOf(resolvedRight);

      if (rightTable !== undefined && rightTable !== join.table) {
        throw new Error(
          `MUI X Studio Server: JOIN "on" pair for table "${join.table}" has a right-hand column "${right}" ` +
            `qualified with table "${rightTable}" instead of "${join.table}". ` +
            `The right side of a join's "on" pair must reference the joined table itself, so the ON condition ` +
            `expresses a real join key rather than a reference to an unrelated (or wrongly-ordered) table. ` +
            `Qualify the right-hand "on" column with "${join.table}", or leave it unqualified.`,
        );
      }
      if (leftTable !== undefined && !knownTables.includes(leftTable)) {
        throw new Error(
          `MUI X Studio Server: JOIN "on" pair for table "${join.table}" has a left-hand column "${left}" ` +
            `qualified with table "${leftTable}", which is neither the primary table "${descriptor.table}" nor a ` +
            `table joined earlier in this query. ` +
            `The left side of a join's "on" pair must reference a table already available at this point in the ` +
            `query — qualifying it with "${join.table}" itself (the table THIS join introduces) produces a ` +
            `tautological condition such as "${join.table}.x = ${join.table}.y" instead of a real join key, which ` +
            `some database engines execute as an unconditional match — a cartesian product that silently ` +
            `multiplies every row within the tenant-scoped result instead of failing. ` +
            `Qualify the left-hand "on" column with "${descriptor.table}" or an already-joined table, or leave it unqualified.`,
        );
      }
    }
    knownTables.push(join.table);
  }
}

/**
 * Validate every SEMI-JOIN against fail-closed shape, nesting-depth and
 * table-qualification guards.
 *
 * SECURITY INVARIANT — runs UNCONDITIONALLY for every widget (independent of
 * whether a `columnAllowlist` is configured), mirroring `validateJoinTypes` /
 * `validateJoinOnPairs`. A `SemiJoinDescriptor` names a SECOND TABLE and two
 * column references that `buildSecureQuery` hands straight to Knex, so it needs
 * the same unconditional shape gate every other such reference class gets.
 *
 * What each rule closes:
 *
 * - **Shape.** `table` / `column` / `foreignColumn` are client JSON, so their
 *   `string` types are not runtime guarantees. A missing/non-string `table`
 *   reaches `db(undefined)` (an opaque driver error); a non-string `column`
 *   reaches `qualifiedTableOf`'s `indexOf`. Both are rejected here with this
 *   package's own message instead. An EMPTY-string table is rejected too: it
 *   would pass `assertTablesAllowed` only if the host allowlisted `''`, but it
 *   renders as `from ""`, an opaque failure rather than a clear one.
 *
 * - **Nesting depth.** `semiJoins` is the descriptor's only RECURSIVE field, so
 *   it is the only one that opens the nesting dimension. Capped at
 *   `MAX_SEMI_JOIN_DEPTH` (see `shared/limits.ts`), which is exactly the two
 *   levels the semantics need (direct one-to-many, and two-hop many-to-many
 *   through a junction).
 *
 * - **`filters` shape.** A present non-array `filters` reaches `applyPredicates`'
 *   `for…of` and throws a raw `TypeError: … is not iterable`, pre-empting this
 *   package's own error — the same gap `assertQualifiedColumnsAllowed` closes for
 *   `joins[].on`.
 *
 * - **Table qualification, enforced in BOTH directions (fail-closed).** A
 *   qualified `foreignColumn` must name `table`, and a qualified `column` must
 *   name the ENCLOSING table (the descriptor's primary table at the top level,
 *   the PARENT semi-join's `table` when nested). This is stricter than
 *   `validateJoinOnPairs`'s left-hand rule, which admits any earlier-joined
 *   table, and deliberately so: a semi-join's two column references have exactly
 *   one correct pairing (outer key ↔ subquery projection), and getting either
 *   wrong is not a syntax error but a SILENTLY DIFFERENT filter. Projecting a
 *   column of some other table from the subquery would compare unrelated key
 *   spaces — admitting outer rows whose key coincidentally collides with a value
 *   from a column that was never the join key. Since the plan qualifies both
 *   references itself, the only reference a client can supply that this rule
 *   would reject is one it had no correct reason to write.
 *
 * References are resolved through `resolveAlias` first (matching every other
 * validator), so a logical/expression-field id mapping to a qualified physical
 * column is checked on the resolved name rather than the raw client string.
 */
function validateSemiJoins(
  descriptor: BatchWidgetDescriptor,
  semiJoins: SemiJoinDescriptor[] | undefined,
  enclosingTable: string,
  depth: number,
): void {
  if (semiJoins === undefined) {
    return;
  }
  if (!Array.isArray(semiJoins)) {
    throw new Error(
      `MUI X Studio Server: "semiJoins" on table "${enclosingTable}" must be an array of semi-join ` +
        `descriptors, but received ${JSON.stringify(semiJoins)}. A non-array value cannot be iterated to ` +
        `build the subquery predicates and would otherwise throw a confusing internal error instead of a ` +
        `clean validation failure. Provide "semiJoins" as an array (or omit it).`,
    );
  }
  if (semiJoins.length > 0 && depth > MAX_SEMI_JOIN_DEPTH) {
    throw new Error(
      `MUI X Studio Server: "semiJoins" nest more than ${MAX_SEMI_JOIN_DEPTH} levels deep. ` +
        `Each level adds a nested subquery whose tables, columns and predicates must all be ` +
        `allowlist-checked and built, so unbounded nesting is unbounded work driven entirely by client ` +
        `input — and no Studio dashboard produces more than two levels (a direct one-to-many filter, or a ` +
        `two-hop many-to-many filter through a junction table). ` +
        `Flatten the filter to at most ${MAX_SEMI_JOIN_DEPTH} levels of "semiJoins".`,
    );
  }
  for (const semiJoin of semiJoins) {
    if (typeof semiJoin !== 'object' || semiJoin === null) {
      throw new Error(
        `MUI X Studio Server: Malformed entry in "semiJoins" — expected a semi-join descriptor object with ` +
          `"table", "column" and "foreignColumn" fields, but received ${JSON.stringify(semiJoin)}. ` +
          `A null or non-object entry has no table or column references to validate. ` +
          `Ensure every entry in "semiJoins" is an object with "table", "column" and "foreignColumn".`,
      );
    }
    if (typeof semiJoin.table !== 'string' || semiJoin.table.length === 0) {
      throw new Error(
        `MUI X Studio Server: Semi-join "table" must be a non-empty string, but received ` +
          `${JSON.stringify(semiJoin.table)}. The semi-join's subquery selects FROM that table, so a ` +
          `missing or non-string value cannot be checked against the schema allowlist and would reach the ` +
          `database driver as an opaque error. Give every "semiJoins" entry a string "table".`,
      );
    }
    for (const field of ['column', 'foreignColumn'] as const) {
      if (typeof semiJoin[field] !== 'string' || semiJoin[field].length === 0) {
        throw new Error(
          `MUI X Studio Server: Semi-join "${field}" for table "${semiJoin.table}" must be a non-empty ` +
            `string, but received ${JSON.stringify(semiJoin[field])}. Both sides of a semi-join are emitted ` +
            `as SQL identifiers ("column IN (SELECT foreignColumn …)"), so neither can be missing or ` +
            `non-string. Give every "semiJoins" entry string "column" and "foreignColumn" fields.`,
        );
      }
    }
    if (semiJoin.filters !== undefined && !Array.isArray(semiJoin.filters)) {
      throw new Error(
        `MUI X Studio Server: Semi-join "filters" for table "${semiJoin.table}" must be an array, but ` +
          `received ${JSON.stringify(semiJoin.filters)}. A non-array value cannot be iterated to build the ` +
          `subquery's WHERE clause and would otherwise throw a confusing internal error instead of a clean ` +
          `validation failure. Provide "filters" as an array (or omit it).`,
      );
    }
    const outerTable = qualifiedTableOf(resolveAlias(descriptor, semiJoin.column));
    if (outerTable !== undefined && outerTable !== enclosingTable) {
      throw new Error(
        `MUI X Studio Server: Semi-join on table "${semiJoin.table}" has an outer column ` +
          `"${semiJoin.column}" qualified with table "${outerTable}" instead of "${enclosingTable}". ` +
          `The outer side of a semi-join must reference the table the subquery filters — the widget's ` +
          `primary table, or the enclosing semi-join's table when nested — so the "IN" test compares the ` +
          `real join key rather than an unrelated column that happens to share a value space. ` +
          `Qualify the outer column with "${enclosingTable}" (or leave it unqualified).`,
      );
    }
    const foreignTable = qualifiedTableOf(resolveAlias(descriptor, semiJoin.foreignColumn));
    if (foreignTable !== undefined && foreignTable !== semiJoin.table) {
      throw new Error(
        `MUI X Studio Server: Semi-join on table "${semiJoin.table}" projects a foreign column ` +
          `"${semiJoin.foreignColumn}" qualified with table "${foreignTable}" instead of ` +
          `"${semiJoin.table}". The subquery selects FROM "${semiJoin.table}", so projecting a column of a ` +
          `different table either fails outright or silently compares an unrelated key space — admitting ` +
          `outer rows whose key merely collides with a value from a column that was never the join key. ` +
          `Qualify the foreign column with "${semiJoin.table}" (or leave it unqualified).`,
      );
    }
    validateSemiJoins(descriptor, semiJoin.semiJoins, semiJoin.table, depth + 1);
  }
}

/**
 * Validate the row LIMIT against a fail-closed non-negative-integer guard.
 *
 * SECURITY INVARIANT — runs UNCONDITIONALLY for every widget,
 * independent of whether a `columnAllowlist` is configured. `descriptor.limit` is
 * client JSON that `execute.ts` passes straight to Knex's `.limit()`. The TS type
 * (`number`) is not a runtime guarantee — the wire value can be a string, a float,
 * a negative number, `NaN`, or an object. Knex's dialect-specific `.limit()`
 * coercion can then SILENTLY DROP the clause (coercing a malformed value to
 * `NaN`/`undefined`), returning ALL tenant-scoped rows instead of the bounded page
 * the caller asked for. Constrain it to a non-negative integer (fail-closed),
 * mirroring the `SAFE_OPERATORS` / ORDER-BY-direction guards. `limit: 0` (a
 * legitimate "return zero rows" request) is allowed; only `undefined` means "no
 * limit". Runs per widget inside `processWidget`, so a malformed limit yields that
 * widget's own `{ error }` result rather than rejecting the whole batch.
 */
function validateLimit(descriptor: BatchWidgetDescriptor): void {
  const { limit } = descriptor;
  if (limit !== undefined && (!Number.isInteger(limit) || (limit as number) < 0)) {
    throw new Error(
      `MUI X Studio Server: Row limit "${limit}" is not allowed. ` +
        `The limit bounds how many rows the query returns, and a malformed value can be silently coerced by the database driver into returning every tenant-scoped row. ` +
        `Use a non-negative integer (or omit "limit" for no limit).`,
    );
  }
}

/**
 * Validate every expression-field OUTPUT ALIAS against the safe-identifier charset.
 *
 * Uses the SAME shared `SAFE_ALIAS_PATTERN` (`shared/columnValidation.ts`) that
 * `validateAggregationAliases` applies to aggregation aliases — previously this
 * was a byte-identical module-private duplicate; now there is one
 * definition to keep in sync if the charset is ever tightened.
 *
 * SECURITY INVARIANT — runs UNCONDITIONALLY for every widget (independent of
 * whether a `columnAllowlist` is configured), closing the finding-3.4 gap: an
 * output alias (`PlanProjectionColumn.outputAlias` — the client's logical column
 * id, produced by `buildPlan` when a referenced column resolves to a DIFFERENT
 * physical column) reaches `execute.ts`'s `db.raw('?? as ??', [physical, outputAlias])`
 * WITHOUT the charset check its sibling `agg.alias` gets. Both are `??`-bound and
 * therefore Knex-escaped (so this is defense-in-depth, not a live injection), but
 * the intent of `validateAggregationAliases` is to constrain EVERY client-controlled
 * identifier token in the query-building path — and the output alias was the one
 * such token that skipped it. An output alias only exists when the client-referenced
 * id differs from its resolved physical column, so — mirroring `buildPlan` — only
 * those renamed references are checked; a direct physical reference never reaches
 * the alias position.
 */
function validateOutputAliases(descriptor: BatchWidgetDescriptor): void {
  for (const column of descriptor.columns ?? []) {
    const physical = resolveAlias(descriptor, column);
    // Only a rename becomes an interpolated `?? as ??` output alias (see
    // `buildPlan`); a direct physical column reference is never aliased.
    if (physical !== column && !SAFE_ALIAS_PATTERN.test(column)) {
      throw new Error(
        `MUI X Studio Server: Output alias "${column}" contains characters outside the allowed set. ` +
          `The alias is interpolated into the SQL projection as an identifier (\`?? as ??\`), so it must be a safe identifier to avoid altering the query. ` +
          `Use only letters, digits, underscores and hyphens (matching ${SAFE_ALIAS_PATTERN}).`,
      );
    }
  }
}

/**
 * Close the SELECT * allowlist-bypass: when a `columnAllowlist` is configured but
 * a widget declares NO projection columns and NO aggregations, Knex would emit
 * `SELECT *` and return every column — including ones the host never allowlisted.
 * Synthesize an explicit projection from the allowlist instead (fail-closed by
 * construction). Mutates `plan.columns` in place.
 *
 *   - No allowlist entry for the table → throw fail-closed, mirroring
 *     `checkColumnAgainstAllowlist`'s "has no entry" error (context `'columns'`).
 *     Today this shape silently returns `SELECT *` — the worst variant of the bug.
 *   - Entry is `['*']` → synthesize an explicit PRIMARY-TABLE wildcard projection
 *     (`<table>.*`) rather than leaving `plan.columns` empty. `['*']` means "all
 *     columns OF THIS TABLE", which SQL expresses as `orders.*`, NOT a bare `*`.
 *     Leaving the projection empty made `executeForTier` skip `.select()` and emit
 *     a bare `SELECT *`, which returns every column of every JOINed table too —
 *     bypassing a joined table's own (stricter) allowlist entry. Qualifying the
 *     wildcard to the primary table preserves the single-table `SELECT *` opt-out
 *     while forcing joined-table columns to be named explicitly (which then route
 *     back through `checkColumnAgainstAllowlist`).
 *   - Otherwise → project exactly the allowlisted physical columns, in allowlist
 *     order, with NO `outputAlias` (direct physical columns, not expression-field
 *     renames). `executeForTier`'s `qualify()` prefixes them with the primary
 *     table at execution time, so the row shape matches an explicit projection.
 */
function synthesizeProjectionFromAllowlist(
  plan: ValidatedQueryPlan,
  table: string,
  columnAllowlist: Record<string, string[]>,
): void {
  // Own-property gate, matching `checkColumnAgainstAllowlist`: a
  // primary `table` naming an inherited `Object.prototype` member would otherwise
  // read a truthy inherited value and skip the fail-closed "has no entry" throw,
  // then crash on `.includes`. Treat a non-own key as "no entry".
  const allowed = Object.prototype.hasOwnProperty.call(columnAllowlist, table)
    ? columnAllowlist[table]
    : undefined;
  if (!allowed) {
    // Same message (and therefore same extracted error code) as
    // `checkColumnAgainstAllowlist`'s "has no entry" throw — the context token is
    // interpolated so the template matches verbatim rather than forking a code.
    const context = 'columns';
    throw new Error(
      `MUI X Studio Server: Table "${table}" has no entry in the column allowlist (${context}). ` +
        `When a column allowlist is supplied, every referenced table must declare its allowed columns so unlisted tables cannot be probed. ` +
        `Add "${table}" to the allowlist (use ["*"] to allow all of its columns).`,
    );
  }
  // FAIL CLOSED on a mis-shaped entry, matching `checkColumnAgainstAllowlist`:
  // `Record<string, string[]>` is compile-time only. A STRING entry makes the
  // `.includes('*')` test below `String.prototype.includes` (substring matching,
  // which fails open), and made the `allowed.map(...)` projection synthesis throw
  // a raw `TypeError` — a third, inconsistent behavior for the same
  // misconfiguration. One shared, actionable error instead.
  assertStringArrayAllowlist(allowed, `column allowlist entry for table "${table}"`);
  if (allowed.includes('*')) {
    // Explicit opt-out, but scoped to the PRIMARY table's columns only. `['*']`
    // means "all columns of THIS table" → `<table>.*`, never a bare `*`. A bare
    // `*` (empty projection) would leak every column of every JOINed table,
    // bypassing that table's own allowlist entry — the Tier 1 finding. Qualifying
    // the wildcard keeps single-table `SELECT *` semantics while forcing joined
    // columns to be named explicitly (routed through `checkColumnAgainstAllowlist`).
    plan.columns = [{ physical: asColumnRef(qualifyAgainst(table, '*')) }];
    return;
  }
  plan.columns = allowed.map((col) => ({ physical: asColumnRef(col) }));
}

/**
 * Build the resolved plan from a descriptor — PURE alias resolution, no
 * validation. Every `ColumnRef` funnels through the shared `resolveAlias`, so the
 * plan can only ever RELABEL a column the descriptor already referenced.
 */
function buildPlan(descriptor: BatchWidgetDescriptor): ValidatedQueryPlan {
  const resolve = (column: string): ColumnRef => asColumnRef(resolveAlias(descriptor, column));

  const aggAliasSet = new Set((descriptor.aggregations ?? []).map((a) => a.alias));

  const columns: PlanProjectionColumn[] = (descriptor.columns ?? []).map((column) => {
    const physical = resolve(column);
    // When the resolved physical column differs from the referenced id, the id is
    // an expression-field output alias (`?? as ??`); otherwise there is no rename.
    return physical !== (column as ColumnRef) ? { physical, outputAlias: column } : { physical };
  });

  const filters: ResolvedFilterPredicate[] = (descriptor.filters ?? []).map(
    (predicate) => ({ ...predicate, column: resolve(predicate.column) }) as ResolvedFilterPredicate,
  );

  const joins: ResolvedJoin[] = (descriptor.joins ?? []).map((join) => ({
    table: join.table,
    // Normalize to canonical lowercase (on the request path already validated +
    // normalized by `validateJoinTypes`). `String(...).toLowerCase()` keeps this
    // non-throwing on the direct-caller path (`toValidatedQueryPlan`), which skips
    // the validators — so `buildSecureQuery`'s exact-match `=== 'left'`/`'right'`
    // checks stay correct even for a case-varying type from a direct caller.
    type:
      join.type === undefined
        ? undefined
        : (String(join.type).toLowerCase() as 'inner' | 'left' | 'right'),
    on: join.on.map(([left, right]): [ColumnRef, ColumnRef] => [resolve(left), resolve(right)]),
  }));

  /**
   * Resolve one nesting level of semi-joins, alias-resolving AND table-qualifying
   * every column reference (see `ResolvedSemiJoin` for why qualification happens
   * here rather than at emission time).
   *
   * Deliberately tolerant of a malformed entry — `buildPlan` is also reached from
   * `toValidatedQueryPlan`'s direct-caller branch, which documents a no-throw,
   * resolution-only contract and runs NO validators. On the request path
   * `validateSemiJoins` has already rejected every shape this coerces.
   */
  const resolveQualified = (raw: unknown, table: string): ColumnRef => {
    // `String(...)` on the non-string branch keeps the direct-caller path
    // non-throwing (`qualifyAgainst` would crash on `undefined.includes`), the
    // same tolerance `buildPlan` already applies to `join.type` / `ob.direction`.
    const reference = typeof raw === 'string' ? resolveAlias(descriptor, raw) : String(raw);
    return asColumnRef(qualifyAgainst(table, reference));
  };
  const resolveSemiJoins = (
    entries: SemiJoinDescriptor[] | undefined,
    enclosingTable: string,
  ): ResolvedSemiJoin[] =>
    (Array.isArray(entries) ? entries : []).map((semiJoin) => {
      const table = String(semiJoin?.table);
      return {
        table,
        column: resolveQualified(semiJoin?.column, enclosingTable),
        foreignColumn: resolveQualified(semiJoin?.foreignColumn, table),
        // A semi-join's own filters are scoped to its subquery, so they qualify
        // against ITS table — not the primary table the outer `filters` use.
        filters: (Array.isArray(semiJoin?.filters) ? semiJoin.filters : []).map(
          (predicate) =>
            ({
              ...predicate,
              column: resolveQualified(predicate?.column, table),
            }) as ResolvedFilterPredicate,
        ),
        semiJoins: resolveSemiJoins(semiJoin?.semiJoins, table),
      };
    });

  const semiJoins = resolveSemiJoins(descriptor.semiJoins, descriptor.table);

  // NO PRE-COMPUTED "is this a pure measure" FLAG. The plan used to carry
  // `pureMeasure: agg.alias === resultKeyOf(physical)`, which `execute.ts` used to
  // decide whether an aggregated column also belonged in GROUP BY — an alias-NAME
  // heuristic standing in for "is this column aggregated", and wrong whenever the
  // alias was not simply the column's own name. The GROUP BY split now keys off
  // membership in `aggregations` itself, so there is no derived flag left to drift
  // from that question.
  const aggregations: PlanAggregation[] = (descriptor.aggregations ?? []).map((agg) => ({
    physical: resolve(agg.column),
    func: agg.func,
    alias: agg.alias,
  }));

  const orderBy: PlanOrderBy[] = (descriptor.orderBy ?? []).map((ob) => {
    // Normalize the direction (on the request path already validated by
    // `validateOrderByDirections`) to canonical lowercase so downstream Knex
    // `.orderBy` calls and the `PlanOrderBy` type stay canonical. `String(...)`
    // keeps this non-throwing on the direct-caller path (`toValidatedQueryPlan`),
    // which deliberately skips the validators — a non-string direction there
    // normalizes rather than crashing, preserving those callers' no-throw behavior.
    const direction = String(ob.direction).toLowerCase() as 'asc' | 'desc';
    // An ORDER BY that targets an aggregation alias must stay the alias (it is not
    // a physical column); otherwise it is a physical column, resolved + qualified.
    return aggAliasSet.has(ob.column)
      ? { direction, aggAlias: ob.column }
      : { direction, physical: resolve(ob.column) };
  });

  return {
    table: descriptor.table,
    joins,
    semiJoins,
    filters,
    having: descriptor.having ?? [],
    columns,
    aggregations,
    orderBy,
    limit: descriptor.limit,
    kind: 'validated-query-plan',
  };
}

/**
 * Compile + validate a widget descriptor's column references into a
 * `ValidatedQueryPlan`.
 *
 * Call this ONCE per widget descriptor at the top of `handleBatchQuery` and
 * thread the returned plan down in place of re-deriving validation/resolution
 * downstream. Runs, in order (matching the pre-refactor handler's intra-widget
 * order):
 *   1. `validateHavingAliases`             — UNCONDITIONAL (throws on an invalid HAVING).
 *   1a0. `validateWildcardProjection`      — UNCONDITIONAL (throws when a
 *      wildcard `<table>.*` shares the projection with another column or an
 *      aggregation — its result keys are unknowable, so no collision check can
 *      cover it). Runs FIRST of the projection checks so the key list below
 *      contains only real, comparable keys.
 *   1a1. `validateAggregationColumns`     — UNCONDITIONAL (throws on a wildcard
 *      in `aggregations[].column`, which `validateWildcardProjection` cannot see
 *      — it reads `columns` only — and which emits `COUNT(<table>.*)`, F3).
 * 1a. `validateProjectionKeyCollisions` — UNCONDITIONAL (throws when two
 *      projected columns share a result-row key, e.g. `orders.category` and
 *      `customers.category` both keying as `category` — one would silently
 *      overwrite the other, Tier3 iter24 finding). Runs immediately before
 *      `validateAggregationAliases` since both consume the same `projectionKeys`.
 *   2. `validateAggregationAliases`  — UNCONDITIONAL (throws on an unsafe alias,
 *      a duplicate alias, or an alias colliding with a projected column's key).
 *   3. `validateOutputAliases`       — UNCONDITIONAL (throws on an unsafe
 *      expression-field output alias — the token is interpolated into the SQL
 *      projection via `?? as ??`).
 *   4. `validateOrderByDirections`   — UNCONDITIONAL (throws on a non-asc/desc
 *      direction — the token is interpolated into the SQL ORDER BY clause).
 *   5. `validateJoinTypes`           — UNCONDITIONAL (throws on a non-inner/left/
 *      right join type, normalizing case — an unrecognized value silently degrades
 *      the join to INNER and misplaces the joined table's security predicate).
 *   5a. `validateJoinOnPairs`       — UNCONDITIONAL (throws on a missing/empty
 *      `on` list — some database engines silently execute the resulting
 *      condition-less join as a CROSS JOIN).
 *   5b. `validateSemiJoins`        — UNCONDITIONAL (throws on a malformed
 *      semi-join descriptor, a `semiJoins` chain nested past
 *      `MAX_SEMI_JOIN_DEPTH`, or a column qualified with a table other than the
 *      one it must belong to — a semi-join names a SECOND TABLE and two SQL
 *      identifiers, so it needs the same unconditional shape gate the join
 *      fields get).
 *   6. `validateLimit`               — UNCONDITIONAL (throws on a non-integer /
 *      negative `limit` — a malformed value can be silently coerced by the DB
 *      driver into returning every tenant-scoped row).
 *   7. `validateDescriptorColumns`   — ONLY when a `columnAllowlist` is supplied
 *      (throws fail-closed on an unlisted table/column).
 *   8. `validateOrderByTargets`      — UNCONDITIONAL (throws when an AGGREGATION
 *      widget orders by something that is neither a GROUP BY dimension nor a
 *      declared aggregation alias — pg/MySQL reject that query outright while
 *      SQLite sorts each group by an ARBITRARY member row, F4). Deliberately
 *      LAST, after the allowlist check: a column that is both unlisted and not a
 *      dimension should be reported as the allowlist violation it also is.
 * then resolves every column reference into the plan and replaces an IMPLICIT
 * projection (no `columns`, no `aggregations` — which would make Knex emit a bare
 * `SELECT *`) with an explicit single-table one: from the allowlist when a
 * `columnAllowlist` is configured, or — for a joined widget on a
 * `schemaAllowlist`-only deployment — anchored to the primary table as
 * `<table>.*`, so a joined `SELECT *` can never collapse two tables' same-named
 * columns onto one result-row key.
 *
 * The reused HAVING/aggregation/allowlist validators are the EXISTING
 * single-source-of-truth functions — this module never re-implements their logic
 * or error text.
 */
export function validateQueryPlan(
  descriptor: BatchWidgetDescriptor,
  columnAllowlist?: Record<string, string[]>,
): ValidatedQueryPlan {
  validateHavingAliases(descriptor);
  // A WILDCARD projection (`*` / `<table>.*`) has UNKNOWN result-row keys — this
  // package holds no schema metadata, and `resultKeyOf` would hand back the
  // literal `"*"`, a key no row actually carries. Reject a wildcard that shares
  // the projection with anything else BEFORE the key computation below, so
  // `validateProjectionKeyCollisions` only ever sees real, comparable keys.
  // See `validateWildcardProjection`.
  validateWildcardProjection(
    (descriptor.columns ?? []).map((column) => {
      const physical = resolveAlias(descriptor, column);
      return { physical, renamed: physical !== column };
    }),
    (descriptor.aggregations ?? []).length,
  );
  // The other half of the wildcard guard: `validateWildcardProjection` above
  // only sees `descriptor.columns`, so a wildcard in `aggregations[].column`
  // reached query construction and emitted `count(<table>.*)`.
  validateAggregationColumns(descriptor);
  // Compute the RESULT-ROW KEY of every projected column so
  // `validateAggregationAliases` can reject an `agg.alias` that would collide with
  // one on the row object:
  //   - a renamed expression field (resolveAlias(col) !== col) is SELECT-ed AS its
  //     logical id, so its key is that id (`?? as ??`);
  //   - a direct column lands under the last dot-segment of its resolved physical
  //     name (`orders.category` → `category`).
  // A projected column this descriptor AGGREGATES is EXCLUDED here: `execute.ts`
  // projects it only inside the aggregate clause (not as a SELECT dimension), so
  // it yields no separate result-row key and must not count as a collision.
  // Membership is compared on primary-table-qualified physicals, exactly as
  // `execute.ts`'s `measureColSet` / `dimensionColumns` split does, so an
  // unqualified column and its qualified aggregation still match.
  //
  // EVERY aggregation registers, not only those whose alias happens to equal the
  // column's own name. The old `agg.alias === resultKeyOf(physical)` test was
  // the same alias-NAME heuristic `execute.ts` used for the GROUP BY split, and it
  // failed CLOSED on this side: a projected expression field aggregated under its
  // own logical id (`columnAliases: { 'expr-1': 'orders.amount' }`, `alias:
  // 'expr-1'`) compared `expr-1` against the PHYSICAL column's last segment
  // (`amount`), kept `expr-1` in the key list, and hard-rejected the widget with
  // "Aggregation alias … collides with a projected column" — a collision that
  // cannot happen, because the column is never SELECT-ed as a dimension.
  const qualify = (physical: string): string => qualifyAgainst(descriptor.table, physical);
  const measurePhysicals = new Set<string>();
  for (const agg of descriptor.aggregations ?? []) {
    // Optional-chained: this pre-pass runs BEFORE
    // `validateAggregationAliases` (which owns the fail-closed shape rejection),
    // so a malformed element must not crash it with a raw `TypeError` before that
    // validator can report the real problem. A malformed entry simply doesn't
    // register as a measure and is rejected a few lines below.
    const physical = resolveAlias(descriptor, agg?.column as string);
    if (typeof physical === 'string') {
      measurePhysicals.add(qualify(physical));
    }
  }
  const projectionKeys = (descriptor.columns ?? []).flatMap((column) => {
    const physical = resolveAlias(descriptor, column);
    if (measurePhysicals.has(qualify(physical))) {
      return [];
    }
    // A wildcard contributes NO key: its expansion is unknown, so `"*"` would be
    // a fictional key that both collision checks would then compare against real
    // ones. `validateWildcardProjection` above already guaranteed such a wildcard
    // is the ENTIRE projection (no sibling column, no aggregation), so dropping
    // it here leaves nothing unchecked.
    if (isWildcardReference(physical)) {
      return [];
    }
    return [physical !== column ? column : resultKeyOf(physical)];
  });
  // Projection-vs-projection collision (iter24 finding) — two directly projected columns from
  // different tables whose result key collides (e.g. `orders.category` / `customers.category` both
  // keying as `category`) had no guard before this, unlike the agg-vs-projection/agg-vs-agg guards
  // below. Runs BEFORE `validateAggregationAliases` so the more fundamental
  // projection-vs-projection collision is reported first when both are present.
  validateProjectionKeyCollisions(projectionKeys);
  validateAggregationAliases(descriptor, projectionKeys);
  validateOutputAliases(descriptor);
  validateOrderByDirections(descriptor);
  validateJoinTypes(descriptor);
  validateJoinOnPairs(descriptor);
  validateSemiJoins(descriptor, descriptor.semiJoins, descriptor.table, 1);
  validateLimit(descriptor);
  if (columnAllowlist) {
    validateDescriptorColumns(descriptor, columnAllowlist);
  }
  // Runs LAST, deliberately AFTER the allowlist check. An ORDER BY column
  // that is both unlisted and not a dimension violates two rules at once, and the
  // ALLOWLIST one is the more fundamental — "that column is not yours to
  // reference" outranks "that column is at the wrong grain", and reporting the
  // grain problem first would coach a client into adding an unlisted column to
  // `columns` only to be rejected again. Still unconditional: with no
  // `columnAllowlist` configured there is no earlier check to defer to.
  validateOrderByTargets(descriptor);
  const plan = buildPlan(descriptor);
  // An IMPLICIT projection (no `columns`, no `aggregations`) makes `execute.ts`
  // skip `.select()` entirely, so Knex emits a bare `SELECT *`. Both branches
  // below replace that with an explicit, single-table projection. Aggregation
  // widgets are exempt — the db tier emits only aggregation/GROUP BY clauses,
  // never `SELECT *`, and a `<table>.*` entry would land in GROUP BY.
  if (plan.columns.length === 0 && plan.aggregations.length === 0) {
    if (columnAllowlist) {
      // Allowlisted deployment: project exactly the allowlisted columns (or
      // `<table>.*` for the `['*']` opt-out), so a bare `SELECT *` can never
      // return a column the host never allowlisted.
      synthesizeProjectionFromAllowlist(plan, descriptor.table, columnAllowlist);
    } else if (plan.joins.length > 0) {
      // `schemaAllowlist`-only deployment (the README quick-start shape) WITH a
      // join — the case with no allowlist to synthesize from. A bare `SELECT *`
      // across a join returns one row object per row with EVERY column of EVERY
      // joined table folded into it, so each name the two tables share (`id`,
      // `name`, `created_at`, `tenant_id`, …) collapses last-wins: `orders.id`
      // silently becomes `customers.id` in the result the client renders. Anchor
      // the implicit wildcard to the PRIMARY table so the row shape is exactly
      // one table's columns and every key is unambiguous; a client that wants
      // joined-table columns names them explicitly (which then routes through
      // `validateProjectionKeyCollisions`). Without a join, `SELECT *` already
      // names exactly one table's columns, so it is left untouched.
      plan.columns = [{ physical: asColumnRef(qualifyAgainst(descriptor.table, '*')) }];
    }
  }
  return plan;
}

/** Type guard: has this already been compiled into a `ValidatedQueryPlan`? */
export function isValidatedQueryPlan(value: unknown): value is ValidatedQueryPlan {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as ValidatedQueryPlan).kind === 'validated-query-plan'
  );
}

/**
 * Coerce an enforcement-path argument to a `ValidatedQueryPlan`.
 *
 * Mirrors `toCompiledSecurityPolicy`'s dual-acceptance:
 * - Already-compiled plan (the request path) → returned as-is (no recompile,
 *   no re-resolution).
 * - Raw descriptor (direct unit-test callers of `buildSecureQuery` /
 *   `executeForTier` / `runPreflight`) → resolved on the spot via `buildPlan`.
 *   The descriptor branch deliberately does NOT run the validators: these direct
 *   callers were never routed through the handler's validation, and adding throws
 *   here would change the pre-refactor behavior of those functions (which never
 *   validated — the handler did). Resolution alone reproduces exactly what the
 *   old inline `resolveAlias` calls produced.
 */
export function toValidatedQueryPlan(
  value: ValidatedQueryPlan | BatchWidgetDescriptor,
): ValidatedQueryPlan {
  if (isValidatedQueryPlan(value)) {
    return value;
  }
  return buildPlan(value);
}
