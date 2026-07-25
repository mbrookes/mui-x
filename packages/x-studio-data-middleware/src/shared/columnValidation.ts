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
import { MAX_STRING_LENGTH } from './limits';

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
  // Length cap (Tier2 finding — resource exhaustion): `column` is a client
  // JSON string used as a `columnAliases` MAP KEY here — its length was
  // otherwise unbounded at this lookup site. Guarding with a plain `typeof`
  // check (rather than trusting the `string` parameter type) mirrors every
  // other defensive guard in this module, since the wire value's runtime type
  // is not guaranteed by the TS signature.
  if (typeof column === 'string' && column.length > MAX_STRING_LENGTH) {
    throw new Error(
      `MUI X Studio Server: Column reference "${column.slice(0, 80)}…" is ${column.length} characters long, ` +
        `which exceeds the maximum of ${MAX_STRING_LENGTH} allowed for an identifier. ` +
        `An unbounded identifier string is expensive to hash (it is folded into the query cache key) and to ` +
        `resolve repeatedly across a batch. Shorten the column reference to at most ${MAX_STRING_LENGTH} characters.`,
    );
  }
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
 * Qualify a column reference with `table` unless the client already qualified it.
 *
 * This is the ONE place the "qualify with the owning table unless already dotted"
 * rule is expressed. Every site that hands a column reference to Knex —
 * `router/queryBuilder.ts` (join `on` sides, user filter predicates, the HAVING
 * aggregate column, the join null-indicator column), `router/execute.ts`'s
 * `qualify()` (SELECT / GROUP BY / ORDER BY / aggregation columns) and
 * `security/validateQueryPlan.ts`'s pure-measure/projection-key membership tests
 * — must route through this function rather than re-inlining
 * `ref.includes('.') ? ref : `${table}.${ref}``.
 *
 * INVARIANT: a validator and an executor can never disagree about which table an
 * unqualified reference belongs to. That matters concretely because
 * `validateQueryPlan` decides whether a projected column IS an aggregation's own
 * pure measure by comparing QUALIFIED physicals, and `execute.ts` repeats that
 * exact membership test to decide what goes in GROUP BY — two copies of the rule
 * disagreeing would silently change the query's grain. It is the same class of
 * divergence `resolveAlias` exists to prevent for the sibling concern (alias
 * resolution), and it is enforced structurally here instead of by hand.
 *
 * A bare `*` is qualified too (`orders.*`), which is deliberate: an unqualified
 * `*` under a JOIN would project every column of every joined table, collapsing
 * same-named columns last-wins on the row object. Anchoring it to one table keeps
 * the projection key-able.
 */
export function qualifyAgainst(table: string, reference: string): string {
  return reference.includes('.') ? reference : `${table}.${reference}`;
}

/**
 * The table name embedded in a `table.column` reference, or `undefined` when the
 * reference is unqualified.
 *
 * NON-STRING TOLERANT: returns `undefined` rather than throwing for a non-string
 * reference. Callers that require a string (`assertTablesAllowed.ts`'s
 * `checkQualifiedColumn`) reject that shape themselves, with their own message,
 * before calling; callers on the no-throw path (`validateJoinOnPairs`, reached
 * from `toValidatedQueryPlan`'s deliberately validator-free direct-caller branch)
 * rely on the tolerance. Previously defined twice with DIFFERENT guards, which is
 * exactly the drift this single definition removes.
 */
export function qualifiedTableOf(reference: string): string | undefined {
  if (typeof reference !== 'string') {
    return undefined;
  }
  const dotIndex = reference.indexOf('.');
  return dotIndex === -1 ? undefined : reference.slice(0, dotIndex);
}

/**
 * Reject a reference carrying MORE than one dot (`a.b.c` or deeper).
 *
 * Every reference parser in this package splits a qualified reference at the
 * FIRST dot, reading `a.b.c` as table `a`, column `b.c` — while Knex/SQL read the
 * same string as `schema.table.column`. Rather than leave this package's
 * validation and the driver's interpretation free to disagree, a deeper reference
 * is rejected outright (fail-closed, matching the `" as "` rejection below).
 *
 * Shared by `checkColumnAgainstAllowlist` (runs only when a `columnAllowlist` is
 * configured) and `assertTablesAllowed.ts`'s `checkQualifiedColumn` (runs
 * unconditionally), so the identical rule can no longer carry two different error
 * texts — it previously did, under two different `MUI X` prefixes.
 */
export function assertSingleDotReference(reference: string, context: string): void {
  if (reference.split('.').length > 2) {
    throw new Error(
      `MUI X Studio Server: Column reference "${reference}" (in ${context}) contains more than one ".". ` +
        `This package validates a qualified reference as "table.column", splitting at the FIRST dot — a deeper ` +
        `reference such as "schema.table.column" would be parsed differently here than a SQL engine would parse ` +
        `the same string, which is rejected outright rather than resolved ambiguously. ` +
        `Reference the column as "table.column", not a deeper-qualified path.`,
    );
  }
}

/**
 * Does this (already alias-resolved) reference project a WILDCARD — a bare `*` or
 * a table-qualified `<table>.*`?
 *
 * A wildcard expands, at the database, to a set of columns this package cannot
 * enumerate (it holds no schema metadata), so its result-row keys are UNKNOWN.
 * `resultKeyOf` would hand back the literal `"*"`, which is not a key any row
 * actually carries — see `validateWildcardProjection` for what that costs.
 */
export function isWildcardReference(reference: string): boolean {
  return reference === '*' || reference.endsWith('.*');
}

/**
 * Reject a wildcard projection that cannot be checked for result-key collisions.
 *
 * INVARIANT UPHELD: `validateProjectionKeyCollisions` can only do its job when
 * every projected column's result-row key is KNOWN. A wildcard's keys are not —
 * this package has no schema metadata — so a wildcard is admitted ONLY when it is
 * the entire projection: the sole `columns` entry, unrenamed, with no
 * aggregations. Then there is nothing for it to collide with and the row shape is
 * exactly one table's columns.
 *
 * What this closes (all three verified against `resultKeyOf`, which maps
 * `orders.*` to the literal `"*"`):
 *   - `columns: ['orders.*', 'customers.name']` keyed as `['*', 'name']` — no
 *     collision reported, yet `SELECT orders.*, customers.name` returns a row
 *     object in which `customers.name` OVERWRITES `orders.name` (pg and mysql2
 *     both key rows by field name, last-wins). This is the real hazard: a
 *     silently wrong value in every row.
 *   - `columns: ['orders.*', 'customers.*']` keyed as `['*', '*']` — reported as a
 *     collision on the meaningless key `"*"`. Still rejected, but now with a
 *     message that says what is actually wrong.
 *   - a wildcard reached through `columnAliases` (`{ all: 'orders.*' }`) would
 *     emit `SELECT "orders".* as "all"`, which is a syntax error on every dialect.
 *
 * A wildcard alongside an AGGREGATION is rejected for the same reason: the
 * expansion may contain the aggregation's alias, and neither this validator nor
 * `validateAggregationAliases` can see it.
 *
 * @param projection - One entry per projected column: its alias-resolved physical
 *   reference and whether the client renamed it (`?? as ??`).
 * @param aggregationCount - How many aggregations the same widget declares.
 */
export function validateWildcardProjection(
  projection: readonly { physical: string; renamed: boolean }[],
  aggregationCount: number,
): void {
  for (const column of projection) {
    if (typeof column.physical !== 'string' || !isWildcardReference(column.physical)) {
      continue;
    }
    if (column.renamed) {
      throw new Error(
        `MUI X Studio Server: Wildcard column reference "${column.physical}" cannot be renamed. ` +
          `A rename is emitted as "<column> AS <alias>", and a wildcard has no single column to rename — the ` +
          `database rejects the resulting SQL outright. ` +
          `Reference the individual columns you want to rename instead of a wildcard.`,
      );
    }
    if (projection.length > 1 || aggregationCount > 0) {
      throw new Error(
        `MUI X Studio Server: Wildcard column reference "${column.physical}" cannot be combined with another ` +
          `projected column or an aggregation. ` +
          `A wildcard expands to a set of columns this middleware cannot enumerate, so it is impossible to tell ` +
          `whether one of them lands on the same result-row key as another projected column or aggregation alias — ` +
          `and a collision would silently overwrite one of the two values in every result row. ` +
          `List the wildcard's columns explicitly, or project the wildcard on its own.`,
      );
    }
  }
}

/**
 * Reject a column reference that carries Knex's IMPLICIT `" as "` alias syntax
 * (finding L2).
 *
 * Knex's `wrapString` (`knex/lib/formatter/wrappingFormatter.js`) splits ANY
 * identifier containing `" as "` — case-insensitively — into `<expr> as <alias>`
 * BEFORE quoting it. This package's own reference parsers do not: `resultKeyOf`
 * (`security/validateQueryPlan.ts`) splits only on `.`, so it reads
 * `"orders.total as amount"` as the result key `"total as amount"` while Knex
 * emits the row under `amount`. That divergence defeats
 * `validateProjectionKeyCollisions`: on a `schemaAllowlist`-only deployment (no
 * `columnAllowlist` — the documented backward-compatible posture),
 * `columns: ["orders.total as amount", "customers.amount"]` yields two distinct
 * keys here, so no collision is reported, yet Knex emits BOTH under `amount` and
 * one silently overwrites the other in every row — exactly the hazard that guard
 * exists to close. The same string in `columnAliases` reaches
 * `db.raw('?? as ??', …)` and renders the nonsensical
 * `"orders"."x" as "y" as "a"`, an opaque driver error.
 *
 * Rejected outright rather than resolved, for the same reason (and with the same
 * fail-closed posture) as the multi-dot rejection in `checkColumnAgainstAllowlist`
 * / `checkQualifiedColumn`: two components must never be free to disagree about
 * what a client's reference string means. Client-side renaming already has a
 * first-class channel — `columnAliases` plus `PlanProjectionColumn.outputAlias` —
 * which routes the alias through a `??` binding and the `SAFE_ALIAS_PATTERN`
 * charset check instead.
 */
export function assertNoImplicitAlias(reference: string, context: string): void {
  if (reference.toLowerCase().includes(' as ')) {
    throw new Error(
      `MUI X Studio Server: Column reference "${reference}" (in ${context}) contains " as ". ` +
        `The query builder parses that as an implicit "<column> as <alias>" rename, which this package's own ` +
        `result-key and allowlist parsers do not — so a reference aliased this way can silently collide with ` +
        `another projected column and overwrite it in every result row. ` +
        `Reference the plain column and declare the rename via "columnAliases" instead.`,
    );
  }
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
  // Length cap (Tier2 finding — resource exhaustion). This is the runtime
  // choke point for a mutation's `values` KEYS (`validateMutation` calls this
  // with each `Object.keys(values)` entry, context `'values'`) — a reference
  // shape that never flows through `checkQualifiedColumn`'s own identical cap
  // (mutation values keys are never table-qualified, so they take a different
  // validation path). Checked first, before any parsing below.
  if (typeof physical === 'string' && physical.length > MAX_STRING_LENGTH) {
    throw new Error(
      `MUI X Studio Server: Column reference "${physical.slice(0, 80)}…" (in ${context}) is ${physical.length} ` +
        `characters long, which exceeds the maximum of ${MAX_STRING_LENGTH} allowed for an identifier. ` +
        `An unbounded identifier string is expensive to hash and validate repeatedly across a batch. ` +
        `Shorten the identifier in "${context}" to at most ${MAX_STRING_LENGTH} characters.`,
    );
  }
  // Reject a reference with MORE than one dot (`a.b.c` or deeper) before parsing
  // it at the FIRST dot below. One shared implementation with
  // `assertTablesAllowed.ts`'s `checkQualifiedColumn` — see
  // `assertSingleDotReference`.
  assertSingleDotReference(physical, context);
  // Reject Knex's implicit `" as "` alias syntax (finding L2) alongside the
  // multi-dot rejection above — same class of parser divergence, same
  // fail-closed posture. See `assertNoImplicitAlias`.
  assertNoImplicitAlias(physical, context);
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
  const aggAliases = new Set(aggregations.map((a) => a?.alias));
  for (const h of descriptor.having) {
    // ELEMENT SHAPE (finding L1) — `having` is client JSON, so a `null`/primitive
    // element (or one with a non-string `alias`) is not a runtime impossibility.
    // The `h.alias` dereference just below used to throw a raw `TypeError` that
    // `sanitizeBoundaryError` degraded to the generic "could not be completed"
    // message. The request path now rejects this earlier, in
    // `assertQualifiedColumnsAllowed`; this guard keeps direct callers of this
    // validator (which is exported and unconditional) on the same footing.
    if (typeof h !== 'object' || h === null || typeof h.alias !== 'string') {
      throw new Error(
        `MUI X Studio Server: Malformed HAVING predicate ${JSON.stringify(h)} — expected an object with a string ` +
          `"alias" naming a declared aggregation. A null, non-object, or unaliased HAVING predicate cannot be ` +
          `matched to an aggregation and would otherwise surface as a confusing internal error. ` +
          `Give every "having" entry a string "alias" matching an "aggregations" entry.`,
      );
    }
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
 * Validate that no two PROJECTED columns land on the same result-row key.
 *
 * SECURITY/CORRECTNESS INVARIANT (Tier3, iter24 finding) — runs UNCONDITIONALLY
 * for every widget (independent of whether a `columnAllowlist` is configured),
 * mirroring `validateAggregationAliases`'s existing agg-vs-projection and
 * agg-vs-agg collision guards. Two directly-projected columns from different
 * tables whose RESULT KEY collides (e.g. `orders.category` and
 * `customers.category` both key as `category` — the last dot-segment Knex
 * assigns a bare `SELECT <table>.<column>` on the row object) previously had no
 * guard at all: `execute.ts`'s `projectColumn` SELECTs both under the same key,
 * so one column's value silently overwrites the other in every result row —
 * the same "one field silently dropped" hazard `validateAggregationAliases`
 * already closes for an agg-vs-projection or agg-vs-agg collision, just for the
 * one remaining pairing (projection-vs-projection) it didn't cover.
 *
 * `projectionKeys` is the SAME per-column result-key list `validateQueryPlan`
 * already computes and threads into `validateAggregationAliases` — one
 * source of truth for "what key will this projected column land under",
 * shared by both collision checks so they can never disagree.
 */
export function validateProjectionKeyCollisions(projectionKeys: Iterable<string>): void {
  const seen = new Set<string>();
  for (const key of projectionKeys) {
    if (seen.has(key)) {
      throw new Error(
        `MUI X Studio Server: Two projected columns collide on the result-row key "${key}". ` +
          `Both columns are SELECT-ed under the same key, so one column's value silently overwrites ` +
          `the other in every result row. ` +
          `Qualify or alias the columns (e.g. via "columnAliases") so each lands on a distinct key.`,
      );
    }
    seen.add(key);
  }
}

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
  projectionKeys?: Iterable<string>,
): void {
  const projectionKeySet = projectionKeys ? new Set(projectionKeys) : undefined;
  const seen = new Set<string>();
  for (const agg of descriptor.aggregations ?? []) {
    // ELEMENT SHAPE (finding L1) — every dereference below (`agg.alias.length`,
    // the regex test, the collision checks) assumes a string alias, but
    // `aggregations` is client JSON. The request path rejects this earlier in
    // `assertQualifiedColumnsAllowed`; this keeps direct callers of this exported,
    // unconditional validator from getting a raw `TypeError` instead.
    if (typeof agg !== 'object' || agg === null || typeof agg.alias !== 'string') {
      throw new Error(
        `MUI X Studio Server: Malformed aggregation ${JSON.stringify(agg)} — expected an object with a string ` +
          `"alias". The alias becomes the aggregate's result-row key and is emitted into the SQL projection as an ` +
          `identifier, so it cannot be missing or non-string. ` +
          `Give every "aggregations" entry a string "alias".`,
      );
    }
    // Length cap (Tier2 finding — resource exhaustion): `SAFE_ALIAS_PATTERN`
    // constrains the CHARSET of an alias but not its length — a client could
    // still send an arbitrarily long string built entirely from allowed
    // characters (letters/digits/underscore/hyphen). Checked BEFORE the regex
    // test so a pathologically long alias is rejected without ever running the
    // (linear-time, but still client-input-driven) pattern scan over it.
    if (agg.alias.length > MAX_STRING_LENGTH) {
      throw new Error(
        `MUI X Studio Server: Aggregation alias "${agg.alias.slice(0, 80)}…" is ${agg.alias.length} characters ` +
          `long, which exceeds the maximum of ${MAX_STRING_LENGTH} allowed for an identifier. ` +
          `An unbounded alias string is expensive to hash (it is folded into the query cache key) and to ` +
          `validate repeatedly across a batch. Shorten the aggregation alias to at most ${MAX_STRING_LENGTH} characters.`,
      );
    }
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
    // An `agg.alias` colliding with a PROJECTED COLUMN'S RESULT KEY is the same
    // key-collision hazard across the two SELECT sources — whether that column is a
    // renamed expression field (SELECT-ed AS its logical id via `?? as ??`, finding
    // 3.4) OR a direct dimension column (SELECT-ed under the last dot-segment of its
    // physical name, e.g. `orders.category` → `category`, finding 2.1). Both land on
    // ONE result-row key that row-object drivers collapse last-wins, silently
    // dropping a field. `projectionKeys` is threaded by `validateQueryPlan` (already
    // excluding any column that IS an aggregation's own pure measure — that column
    // is projected only inside the aggregate clause, so it produces no separate
    // key); direct aggregation-only callers omit it (no projection to collide with).
    if (projectionKeySet?.has(agg.alias)) {
      throw new Error(
        `MUI X Studio Server: Aggregation alias "${agg.alias}" collides with a projected column. ` +
          `The aggregate and the projected column would be SELECT-ed under the same result-row key (one value would silently overwrite the other). ` +
          `Give the aggregation a distinct alias.`,
      );
    }
    seen.add(agg.alias);
  }
}
