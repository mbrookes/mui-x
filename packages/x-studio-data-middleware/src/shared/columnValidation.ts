/**
 * Shared column-reference validation for @mui/x-studio-data-middleware.
 *
 * A single source of truth for checking a client-supplied column reference
 * against a per-table allowlist, used by BOTH the read path
 * (`handler.ts` → `validateDescriptorColumns`) and the write path
 * (`mutations/mutationBuilder.ts` → `validateMutation`).
 *
 * SECURITY — the check is deliberately FAIL-CLOSED:
 *   - When an allowlist is supplied at all, every referenced table MUST have an
 *     entry. A table with no entry is rejected (rather than passing all columns
 *     through), closing the hole where a client dodges validation by qualifying a
 *     column with a table name that has no allowlist entry.
 *   - `'*'` is the explicit opt-out: a table whose allowed list is `['*']` accepts
 *     any of its columns.
 *
 * Qualified names (`table.column`) are split and checked against the allowlist for
 * the named table; unqualified names are checked against `defaultTable`.
 * Logical field IDs are resolved to their physical column via `resolveAlias`
 * BEFORE splitting, so aliased expression fields are validated against the real
 * physical table/column.
 */
import type { BatchWidgetDescriptor } from '../security/types';

/**
 * Resolve a logical column/field reference to its physical SQL column via the
 * descriptor's `columnAliases` map (a client-declared logical-ID → physical-column
 * mapping, derived from the dashboard's expression fields/relationships). Returns
 * `column` unchanged when no alias is declared for it.
 *
 * This is the ONE place alias resolution happens. Every site that touches a
 * descriptor's column references — allowlist validation, filter predicates, join
 * conditions, SELECT/ORDER BY/aggregation projection — must resolve through this
 * function rather than re-implementing the `columnAliases?.[x] ?? x` lookup
 * inline. That invariant is what guarantees validation and execution can never
 * disagree about which physical column a client's logical reference points to:
 * this package hit that exact divergence twice (once for filter predicates, once
 * for join predicates) before this function existed, because two independent
 * inline lookups were free to drift. With one implementation, a new descriptor
 * field that touches columns either calls this function (and is safe by
 * construction) or visibly doesn't (a code-review-catchable omission, not a
 * silent gap).
 *
 * Because every resolution path funnels through here and `checkColumnAgainstAllowlist`
 * validates whatever physical column comes out, this mechanism can only ever
 * RELABEL a column the caller could already reach — it cannot make a query touch
 * a column that isn't in the allowlist. (See `columnAliases resolution
 * (allowlist-bypass regression)` in `queryBuilder.test.ts` for the pinned property.)
 */
export function resolveAlias(descriptor: BatchWidgetDescriptor, column: string): string {
  const aliases = descriptor.columnAliases;
  // Gate on an OWN-property check BEFORE the lookup (finding 2.4). `column` is
  // client JSON, and a plain object literal inherits from `Object.prototype`, so a
  // bare `aliases?.[column] ?? column` on a `column` naming an inherited member
  // (`"constructor"`, `"toString"`, `"__proto__"`, …) resolves to a truthy
  // inherited function/object instead of `undefined`, defeating the `?? column`
  // fallback and letting a non-string `ColumnRef` flow downstream (a `TypeError`
  // in the allowlist check, or a silently-dropped filter when Knex treats the
  // function as a grouped-where callback). Restrict to own string entries — the
  // same fail-closed posture as `applyHaving`'s opMap gate — so an inherited key
  // resolves to the literal `column` string, exactly like any unmapped reference.
  if (aliases && Object.prototype.hasOwnProperty.call(aliases, column)) {
    const mapped = aliases[column];
    if (typeof mapped === 'string') {
      return mapped;
    }
  }
  return column;
}

/**
 * Validate a single (already alias-resolved) column reference against a
 * per-table allowlist. Throws (fail-closed) when the table has no entry or the
 * column is not allowed.
 *
 * Callers must resolve logical field IDs via `resolveAlias` BEFORE calling this
 * — it never reads `columnAliases` itself, so there is no second, independent
 * resolution path for it to disagree with the caller's.
 *
 * @param physical - The physical column reference (may be `table.column`), already alias-resolved.
 * @param defaultTable - Table used when `physical` is unqualified.
 * @param allowlist - Per-table allowlist (`{ table: [...columns] }`).
 * @param context - Short label describing where the reference came from (e.g. `'columns'`, `'where'`).
 */
export function checkColumnAgainstAllowlist(
  physical: string,
  defaultTable: string,
  allowlist: Record<string, string[]>,
  context: string,
): void {
  const dotIdx = physical.indexOf('.');
  const table = dotIdx !== -1 ? physical.slice(0, dotIdx) : defaultTable;
  const column = dotIdx !== -1 ? physical.slice(dotIdx + 1) : physical;

  // Own-property gate (finding 2.4): `table` is derived from a client-qualified
  // column name, and `allowlist` is a plain object, so a qualified reference such
  // as `constructor.x` would otherwise read the inherited `Object.prototype`
  // member (a truthy function) and BYPASS the fail-closed "has no entry" branch
  // below, then crash on `allowed.includes`. Treat a non-own key as "no entry".
  const allowed = Object.prototype.hasOwnProperty.call(allowlist, table)
    ? allowlist[table]
    : undefined;
  if (!allowed) {
    throw new Error(
      `MUI X Studio Server: Table "${table}" has no entry in the column allowlist (${context}). ` +
        `When a column allowlist is supplied, every referenced table must declare its allowed columns so unlisted tables cannot be probed. ` +
        `Add "${table}" to the allowlist (use ["*"] to allow all of its columns).`,
    );
  }
  if (allowed.includes('*')) {
    return;
  }
  if (!allowed.includes(column)) {
    // INFORMATION DISCLOSURE (finding 3.3): the client-facing message names ONLY the
    // rejected column, never the table's full allowed-column list. Enumerating every
    // allowlisted column in an error returned verbatim to any authenticated caller
    // (`handler.ts`'s per-widget `{ error }`) hands out the table's column map. The
    // full list is logged server-side for operator debugging instead.
    // eslint-disable-next-line no-console
    console.warn(
      `MUI X Studio Server: Column "${column}" on table "${table}" is not in the column allowlist (${context}). ` +
        `Allowed columns for "${table}": ${allowed.join(', ')}`,
    );
    throw new Error(
      `MUI X Studio Server: Column "${column}" on table "${table}" is not in the column allowlist (${context}).`,
    );
  }
}

/**
 * Validate every column reference in a read descriptor against `columnAllowlist`.
 *
 * Covers projection columns, filter predicates, ORDER BY, aggregations and BOTH
 * sides of every `join.on` pair — a join condition is an attacker-controlled
 * channel (`join foo ON secret.col = public.col`) that must be constrained to
 * allowlisted columns just like filters/columns.
 */
export function validateDescriptorColumns(
  descriptor: BatchWidgetDescriptor,
  columnAllowlist: Record<string, string[]>,
): void {
  const check = (rawColumn: string, context: string): void =>
    checkColumnAgainstAllowlist(
      resolveAlias(descriptor, rawColumn),
      descriptor.table,
      columnAllowlist,
      context,
    );

  // An ORDER BY target that names a declared aggregation alias (e.g. "order by
  // total_revenue desc" where `total_revenue` is an `aggregations[].alias`) is
  // NOT a physical column — it is never going to appear in a host's column
  // allowlist, which only lists real columns. Mirrors `buildPlan`'s
  // `aggAliasSet.has(ob.column)` check in `security/validateQueryPlan.ts`, which
  // resolves aggregation-alias ORDER BY targets without an allowlist check.
  // Skipping the allowlist check here is safe: the alias itself is separately
  // charset-restricted by `validateAggregationAliases`, and its underlying
  // aggregated column is already allowlist-checked below via `agg.column`.
  const aggAliasSet = new Set((descriptor.aggregations ?? []).map((agg) => agg.alias));

  for (const col of descriptor.columns ?? []) {
    check(col, 'columns');
  }
  for (const pred of descriptor.filters ?? []) {
    check(pred.column, 'filters');
  }
  for (const ob of descriptor.orderBy ?? []) {
    if (aggAliasSet.has(ob.column)) {
      continue;
    }
    check(ob.column, 'orderBy');
  }
  for (const agg of descriptor.aggregations ?? []) {
    check(agg.column, 'aggregations');
  }
  for (const join of descriptor.joins ?? []) {
    for (const [left, right] of join.on) {
      // Per `JoinDescriptor.on`, the LEFT column conventionally references the
      // PRIMARY table and the RIGHT column the JOINED table. Validate each side
      // against the table it actually belongs to so an UNQUALIFIED column is
      // checked against the allowlist for the table Knex will resolve it against
      // at execution time. Using the primary table for the right side would let a
      // column allowlisted only on the primary table, but present and sensitive
      // on the joined table, pass validation yet execute against the joined table.
      checkColumnAgainstAllowlist(
        resolveAlias(descriptor, left),
        descriptor.table,
        columnAllowlist,
        'join.on',
      );
      checkColumnAgainstAllowlist(
        resolveAlias(descriptor, right),
        join.table,
        columnAllowlist,
        'join.on',
      );
    }
  }
}

/**
 * Validate a descriptor's HAVING predicates against its declared aggregation
 * aliases.
 *
 * SECURITY INVARIANT — runs UNCONDITIONALLY for every widget (independent of
 * whether a `columnAllowlist` is configured). HAVING may only reference an
 * aggregation alias; referencing an arbitrary column would turn HAVING into a
 * comparison oracle on columns the widget never selected. A descriptor that
 * supplies `having` with no `aggregations` at all is rejected.
 *
 * VALUE SHAPE (finding 2.1) — each `h.value` must ALSO be a finite number. The
 * documented HAVING contract is numeric-only (see `HavingPredicate.value: number`),
 * but the wire value is client JSON whose TS type is not a runtime guarantee.
 * `applyHaving` binds it as `havingRaw('FUNC(??) op ?', [col, h.value])`; a
 * non-scalar `h.value` (array / object / `undefined` / `NaN`) would expand to
 * malformed SQL or an opaque driver error instead of a clean per-widget validation
 * error. It is NOT injectable (still `?`-bound), so this enforces the numeric-only
 * contract fail-closed, mirroring the filter path's scalar/in/between/like guards.
 */
export function validateHavingAliases(descriptor: BatchWidgetDescriptor): void {
  if (!descriptor.having || descriptor.having.length === 0) {
    return;
  }
  const aggregations = descriptor.aggregations ?? [];
  if (aggregations.length === 0) {
    throw new Error(
      `MUI X Studio Server: HAVING predicates require at least one aggregation, but the widget declares none. ` +
        `HAVING filters post-aggregation groups, so without an aggregation it would compare an arbitrary raw column. ` +
        `Add an "aggregations" entry whose alias the HAVING predicate references, or remove the "having" clause.`,
    );
  }
  const aggAliases = new Set(aggregations.map((a) => a.alias));
  for (const h of descriptor.having) {
    if (!aggAliases.has(h.alias)) {
      throw new Error(
        `MUI X Studio Server: HAVING alias "${h.alias}" does not match any aggregation alias. ` +
          `Declared aliases: ${[...aggAliases].join(', ') || '(none)'}. ` +
          `Only aggregation aliases may be used in HAVING predicates.`,
      );
    }
    if (typeof h.value !== 'number' || !Number.isFinite(h.value)) {
      throw new Error(
        `MUI X Studio Server: HAVING value for alias "${h.alias}" must be a finite number, received ${JSON.stringify(h.value)}. ` +
          `HAVING compares a numeric aggregate, and a non-numeric value (array, object, null, NaN) would expand into malformed SQL or an opaque driver error. ` +
          `Provide a finite number as the HAVING predicate "value".`,
      );
    }
  }
}

/**
 * Safe identifier charset for aggregation aliases and expression-field output
 * aliases (letters, digits, underscore AND hyphen).
 *
 * The hyphen is deliberately permitted (finding 1.1): the real x-studio client
 * mints expression-field logical IDs as `expr-<timestamp>-<counter>` (hyphenated)
 * and sends them verbatim as `columns` entries / aggregation aliases, mapped to a
 * physical column via `columnAliases` (e.g. `{ 'expr-order-country': 'customers.country' }`).
 * A hyphen-free charset rejected EVERY such join expression-field widget at the
 * alias charset check. Allowing `-` is still injection-safe: both alias positions
 * are Knex identifier-escaped — the expression-field output alias via
 * `db.raw('?? as ??', [physical, outputAlias])` and the aggregation alias via
 * Knex's object form `query.sum({ [alias]: col })` — so a hyphen becomes part of a
 * quoted identifier and can never carry SQL syntax, exactly like an underscore.
 * Genuinely dangerous tokens (`;`, spaces, quotes, parentheses) stay rejected.
 * The hyphen is placed LAST in the character class so it is a literal, not a range.
 *
 * Exported (finding 3.4) — this used to be duplicated verbatim in
 * `security/validateQueryPlan.ts` (which interpolates the SAME class of
 * client-controlled identifier token, an expression-field output alias, via
 * `?? as ??`). A single shared constant means a future charset tightening
 * can't land in one file but not the other.
 */
export const SAFE_ALIAS_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Validate every aggregation alias in a read descriptor against a safe-identifier
 * charset.
 *
 * SECURITY INVARIANT — runs UNCONDITIONALLY for every widget (independent of
 * whether a `columnAllowlist` is configured). `agg.column` is allowlist-validated,
 * but `agg.alias` is free-form client text. `execute.ts` now feeds the alias to
 * Knex's object form (`query.sum({ [alias]: col })`), which DOES escape the alias
 * identifier — so this charset check is defense-in-depth rather than the sole
 * barrier. It is kept (not removed) because it fails closed at the validation
 * stage with a clear per-widget message, and it guards against a future
 * query-builder refactor that reintroduces raw interpolation of the alias without
 * re-adding a guard. Constraining it to `[A-Za-z0-9_-]` keeps a client-controlled
 * identifier token from ever carrying quoting, whitespace, or SQL syntax while
 * still admitting the hyphenated `expr-…` logical IDs the real client mints.
 */
export function validateAggregationAliases(
  descriptor: BatchWidgetDescriptor,
  outputAliases?: Iterable<string>,
): void {
  const outputAliasSet = outputAliases ? new Set(outputAliases) : undefined;
  const seen = new Set<string>();
  for (const agg of descriptor.aggregations ?? []) {
    if (!SAFE_ALIAS_PATTERN.test(agg.alias)) {
      throw new Error(
        `MUI X Studio Server: Aggregation alias "${agg.alias}" contains characters outside the allowed set. ` +
          `The alias is interpolated into the SQL projection as an identifier, so it must be a safe identifier to avoid altering the query. ` +
          `Use only letters, digits, underscores and hyphens (matching ${SAFE_ALIAS_PATTERN}).`,
      );
    }
    // UNIQUENESS (finding 3.4): two aggregations sharing one alias both pass the
    // charset check, but `execute.ts` SELECTs both aggregates AS the same key
    // (they collide onto ONE result-row key, silently dropping one) and
    // `applyHaving` binds a HAVING on that alias to whichever `aggregations.find`
    // returns first. Reject the duplicate as a clean per-widget error.
    if (seen.has(agg.alias)) {
      throw new Error(
        `MUI X Studio Server: Duplicate aggregation alias "${agg.alias}". ` +
          `Two aggregations sharing one alias collide on a single result-row key (one aggregate is silently dropped) and make a HAVING on that alias ambiguous. ` +
          `Give each aggregation a distinct alias.`,
      );
    }
    // An `agg.alias` colliding with a projection output alias (a renamed
    // expression field, `?? as ??`) is the same key-collision hazard across the two
    // SELECT sources. `outputAliases` is threaded by `validateQueryPlan`; direct
    // aggregation-only callers omit it (no projection to collide with).
    if (outputAliasSet?.has(agg.alias)) {
      throw new Error(
        `MUI X Studio Server: Aggregation alias "${agg.alias}" collides with a projection output alias. ` +
          `The aggregate and the projected column would be SELECT-ed under the same key and collide on one result-row key. ` +
          `Give the aggregation a distinct alias.`,
      );
    }
    seen.add(agg.alias);
  }
}
