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
 * Logical field IDs are resolved to their physical column via `columnAliases`
 * (when supplied) BEFORE splitting, so aliased expression fields are validated
 * against the real physical table/column.
 */
import type { BatchWidgetDescriptor } from '../security/types';

/**
 * Validate a single column reference against a per-table allowlist.
 * Throws (fail-closed) when the table has no entry or the column is not allowed.
 *
 * @param rawColumn - The column reference (may be `table.column`, or a logical ID).
 * @param defaultTable - Table used when `rawColumn` is unqualified.
 * @param allowlist - Per-table allowlist (`{ table: [...columns] }`).
 * @param context - Short label describing where the reference came from (e.g. `'columns'`, `'where'`).
 * @param columnAliases - Optional logical-ID → physical-column map.
 */
export function checkColumnAgainstAllowlist(
  rawColumn: string,
  defaultTable: string,
  allowlist: Record<string, string[]>,
  context: string,
  columnAliases?: Record<string, string>,
): void {
  // If the logical column ID has a physical alias, validate the physical column instead.
  const physical = columnAliases?.[rawColumn] ?? rawColumn;
  const dotIdx = physical.indexOf('.');
  const table = dotIdx !== -1 ? physical.slice(0, dotIdx) : defaultTable;
  const column = dotIdx !== -1 ? physical.slice(dotIdx + 1) : physical;

  const allowed = allowlist[table];
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
    throw new Error(
      `MUI X Studio Server: Column "${column}" on table "${table}" is not in the column allowlist (${context}). ` +
        `Allowed columns for "${table}": ${allowed.join(', ')}`,
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
      rawColumn,
      descriptor.table,
      columnAllowlist,
      context,
      descriptor.columnAliases,
    );

  for (const col of descriptor.columns ?? []) {
    check(col, 'columns');
  }
  for (const pred of descriptor.filters ?? []) {
    check(pred.column, 'filters');
  }
  for (const ob of descriptor.orderBy ?? []) {
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
        left,
        descriptor.table,
        columnAllowlist,
        'join.on',
        descriptor.columnAliases,
      );
      checkColumnAgainstAllowlist(
        right,
        join.table,
        columnAllowlist,
        'join.on',
        descriptor.columnAliases,
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
  }
}

/** Safe identifier charset for aggregation aliases (letters, digits, underscore). */
const SAFE_ALIAS_PATTERN = /^[A-Za-z0-9_]+$/;

/**
 * Validate every aggregation alias in a read descriptor against a safe-identifier
 * charset.
 *
 * SECURITY INVARIANT — runs UNCONDITIONALLY for every widget (independent of
 * whether a `columnAllowlist` is configured). `agg.column` is allowlist-validated,
 * but `agg.alias` is free-form client text that `execute.ts` interpolates into the
 * projection (`` `${col} as ${agg.alias}` ``) rather than passing through a Knex
 * `?`/`??` binding. Constraining it to `[A-Za-z0-9_]` (fail-closed) keeps the one
 * attacker-controlled token in the query-building path from carrying quoting,
 * whitespace, or SQL syntax into the identifier position.
 */
export function validateAggregationAliases(descriptor: BatchWidgetDescriptor): void {
  for (const agg of descriptor.aggregations ?? []) {
    if (!SAFE_ALIAS_PATTERN.test(agg.alias)) {
      throw new Error(
        `MUI X Studio Server: Aggregation alias "${agg.alias}" contains characters outside the allowed set. ` +
          `The alias is interpolated into the SQL projection as an identifier, so it must be a safe identifier to avoid altering the query. ` +
          `Use only letters, digits and underscores (matching ${SAFE_ALIAS_PATTERN}).`,
      );
    }
  }
}
