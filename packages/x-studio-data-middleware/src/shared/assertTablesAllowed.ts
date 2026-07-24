/**
 * Shared table-allowlist assertion for @mui/x-studio-data-middleware.
 *
 * The Zero-Knowledge Rule: any table not in the caller-supplied `schemaAllowlist`
 * is rejected before any query is built. Used by BOTH the read handler
 * (`handleBatchQuery`) and the write handler (`handleMutation`) so the check —
 * and its error text — live in exactly one place.
 */
import type { BatchWidgetDescriptor, FilterPredicate } from '../security/types';

/**
 * Throw when any of `tables` is not present in `schemaAllowlist`.
 *
 * @param tables - Every table referenced by the request (primary + joined).
 * @param schemaAllowlist - The allowlist of queryable/writable table names.
 */
export function assertTablesAllowed(tables: string[], schemaAllowlist: string[]): void {
  const invalidTables = tables.filter((t) => !schemaAllowlist.includes(t));
  if (invalidTables.length > 0) {
    // INFORMATION DISCLOSURE (finding 3.3): the client-facing message names ONLY the
    // rejected table(s), never the full allowlist. Enumerating every allowed table
    // in an error returned verbatim to any authenticated caller (`handler.ts`'s
    // per-widget `{ error }`) hands out the server's schema map. The full allowlist
    // is logged server-side for operator debugging instead.

    console.warn(
      `MUI X Studio Server: Rejected table(s) not in schema allowlist: ${invalidTables.join(', ')}. ` +
        `Allowed tables: ${schemaAllowlist.join(', ')}`,
    );
    throw new Error(
      `MUI X Studio Server: Requested table(s) not in schema allowlist: ${invalidTables.join(', ')}. ` +
        `Add the table(s) to the schema allowlist if they should be queryable.`,
    );
  }
}

/** The table name embedded in a `table.column` reference, or `undefined` when unqualified. */
function qualifiedTableOf(column: string): string | undefined {
  const dotIndex = column.indexOf('.');
  return dotIndex === -1 ? undefined : column.slice(0, dotIndex);
}

/**
 * Shared by `assertQualifiedColumnsAllowed` (read path) and
 * `assertQualifiedWhereColumnsAllowed` (write path): throw when `column` is
 * table-qualified and names a table absent from `schemaAllowlist`. An
 * unqualified column, or one qualifying a table already on the allowlist, is a
 * no-op.
 *
 * RUNTIME SHAPE GUARDS (Tier3 iter26 findings 1 / 6):
 *   - `column` is typed `string` on every descriptor field this is called with
 *     (`FilterPredicate.column`, `AggregationSpec.column`, …), but the wire
 *     value is client JSON, so that type is not a runtime guarantee. A
 *     non-string `column` (e.g. `{ column: 5 }`) used to reach
 *     `qualifiedTableOf`'s `column.indexOf('.')` and throw a raw, unguarded
 *     `TypeError: column.indexOf is not a function` — escaping unsanitized
 *     past this package's own error boundary. Reject it here instead, fail
 *     closed, with this package's own `MUI X`-prefixed message.
 *   - A reference with MORE than one dot (`a.b.c` or deeper) is rejected
 *     outright rather than silently parsed at the FIRST dot (finding 6):
 *     `qualifiedTableOf` treats `a.b.c` as table `a`, column `b.c`, while
 *     Knex/SQL would read it as `schema.table.column` — a parser divergence
 *     between this package's validation and how the driver would actually
 *     interpret the same string. Not exploitable today (an unregistered
 *     "table" from the wrong split still fails closed downstream), but the
 *     divergence itself is worth closing rather than leaving two components
 *     free to disagree about what a multi-dot reference means.
 */
function checkQualifiedColumn(column: string, context: string, schemaAllowlist: string[]): void {
  if (typeof column !== 'string') {
    throw new Error(
      `MUI X Studio Server: Column reference in ${context} must be a string, but received ` +
        `${JSON.stringify(column)}. A non-string column reference cannot be safely checked against the schema ` +
        `allowlist. Ensure every column reference in "${context}" is a string.`,
    );
  }
  if (column.split('.').length > 2) {
    throw new Error(
      `MUI X: Column reference "${column}" (in ${context}) contains more than one ".". ` +
        `This package validates a qualified reference as "table.column", splitting at the FIRST dot — a deeper ` +
        `reference such as "schema.table.column" would be parsed differently here than a SQL engine would parse ` +
        `the same string, which is rejected outright rather than resolved ambiguously. ` +
        `Reference the column as "table.column", not a deeper-qualified path.`,
    );
  }
  const table = qualifiedTableOf(column);
  if (table === undefined || schemaAllowlist.includes(table)) {
    return;
  }
  // Mirrors `assertTablesAllowed`'s information-disclosure posture (finding
  // 3.3): the client-facing error names only the rejected table, never the
  // full allowlist; the full list is logged server-side for operator debugging.
  console.warn(
    `MUI X Studio Server: Rejected qualified column reference "${column}" (in ${context}) — ` +
      `table "${table}" is not in the schema allowlist. Allowed tables: ${schemaAllowlist.join(', ')}`,
  );
  throw new Error(
    `MUI X: Qualified column reference "${column}" (in ${context}) names table "${table}", which is not in the ` +
      `schema allowlist. Every table a query can touch — including one named only through a qualified column ` +
      `reference, not just the primary table or an explicit join — must be explicitly allowlisted, or an ` +
      `unregistered table could be probed through a filter/column/orderBy reference alone. ` +
      `Add "${table}" to the schema allowlist if it should be queryable, or reference a column on an ` +
      `already-allowlisted table.`,
  );
}

/**
 * Enforce the Zero-Knowledge Rule on every table-QUALIFIED column reference in a
 * read descriptor — `columns`, `filters[].column`, `orderBy[].column`, the
 * physical (value) side of `columnAliases`, `aggregations[].column`, and both
 * sides of every `joins[].on` pair — independent of whether a `columnAllowlist`
 * is configured for this deployment.
 *
 * GAP THIS CLOSES: `assertTablesAllowed` only checks `descriptor.table` and
 * `descriptor.joins[].table` — the tables a query structurally touches via
 * FROM/JOIN. A qualified column reference such as `"other_table.balance"` inside
 * `filters` / `columns` / `orderBy` / `columnAliases` / `aggregations` / a join's
 * `on` pair names a THIRD table that never reaches that check. When a
 * `columnAllowlist` IS configured, `validateDescriptorColumns`
 * (`shared/columnValidation.ts`) happens to reject this too (it splits the
 * qualified reference and requires the named table to have its OWN allowlist
 * entry) — but that validator runs ONLY when a `columnAllowlist` is supplied
 * (`security/validateQueryPlan.ts`'s `if (columnAllowlist) {
 * validateDescriptorColumns(...) }` gate). A deployment that scopes access via
 * `schemaAllowlist` alone (no `columnAllowlist`) therefore had NO
 * application-layer check for this reference at all — the query still failed
 * CLOSED (an unregistered/nonexistent table surfaces as a raw DB error), but as
 * an opaque downstream failure instead of this package's own clear, actionable
 * error, which is an inconsistency in the "Zero-Knowledge Rule" surface (every
 * OTHER table reference gets a clean application-layer rejection). Running this
 * check unconditionally — regardless of `columnAllowlist` — closes that
 * inconsistency.
 *
 * Originally only checked `columns` / `filters` / `orderBy` / `columnAliases`;
 * `aggregations[].column` and both sides of `joins[].on` were missed (finding
 * 2.2), contradicting this function's own claim above of covering "every table a
 * query can touch" — a qualified `aggregations: [{ column: 'payroll.salary', ... }]`
 * or a qualified `join.on` side naming a non-allowlisted table sailed through on
 * a `schemaAllowlist`-only deployment. Both are now checked with the same
 * pattern.
 *
 * @param descriptor - The widget descriptor being validated.
 * @param schemaAllowlist - The allowlist of queryable table names.
 */
/**
 * Guard a `{ column }`-shaped element of a read descriptor array
 * (`filters[]`, `orderBy[]`) before its `.column` is dereferenced.
 *
 * These fields are typed as arrays of objects, but the wire value is client
 * JSON, so a `null`/`undefined`/primitive ELEMENT (e.g. `filters: [null]`) is
 * not a runtime impossibility. Dereferencing `.column` on it (`null.column`)
 * would throw a raw `TypeError`; while that is currently caught downstream by
 * `sanitizeBoundaryError` (inside `processWidget`'s try) and degraded to a
 * generic message, rejecting it here — the write path's
 * `assertValidBatchMutationRequest` does the equivalent up front — yields this
 * package's own precise, `MUI X`-prefixed error instead.
 */
function assertPredicateElementShape(element: unknown, context: string): void {
  if (typeof element !== 'object' || element === null) {
    throw new Error(
      `MUI X Studio Server: Malformed entry in "${context}" — expected a predicate object with a "column" field, ` +
        `but received ${JSON.stringify(element)}. A null or non-object entry has no "column" to validate against ` +
        `the schema allowlist. Ensure every entry in "${context}" is an object with a "column" field.`,
    );
  }
}

export function assertQualifiedColumnsAllowed(
  descriptor: BatchWidgetDescriptor,
  schemaAllowlist: string[],
): void {
  for (const column of descriptor.columns ?? []) {
    checkQualifiedColumn(column, 'columns', schemaAllowlist);
  }
  for (const filter of descriptor.filters ?? []) {
    assertPredicateElementShape(filter, 'filters');
    checkQualifiedColumn(filter.column, 'filters', schemaAllowlist);
  }
  for (const orderBy of descriptor.orderBy ?? []) {
    assertPredicateElementShape(orderBy, 'orderBy');
    checkQualifiedColumn(orderBy.column, 'orderBy', schemaAllowlist);
  }
  for (const physical of Object.values(descriptor.columnAliases ?? {})) {
    if (typeof physical === 'string') {
      checkQualifiedColumn(physical, 'columnAliases', schemaAllowlist);
    }
  }
  for (const agg of descriptor.aggregations ?? []) {
    assertPredicateElementShape(agg, 'aggregations');
    checkQualifiedColumn(agg.column, 'aggregations', schemaAllowlist);
  }
  for (const join of descriptor.joins ?? []) {
    for (const pair of join.on ?? []) {
      if (!Array.isArray(pair)) {
        throw new Error(
          `MUI X Studio Server: Malformed entry in "joins.on" — expected a [left, right] column pair, ` +
            `but received ${JSON.stringify(pair)}. A non-array "on" entry cannot be destructured into a ` +
            `column pair to validate against the schema allowlist. Ensure every "joins[].on" entry is a ` +
            `[left, right] tuple of column references.`,
        );
      }
      const [left, right] = pair;
      checkQualifiedColumn(left, 'joins.on', schemaAllowlist);
      checkQualifiedColumn(right, 'joins.on', schemaAllowlist);
    }
  }
}

/**
 * Enforce the Zero-Knowledge Rule on every table-QUALIFIED `where[].column`
 * reference in a WRITE (mutation) descriptor — the write-path analogue of
 * `assertQualifiedColumnsAllowed` above. Runs unconditionally, independent of
 * whether `HandleMutationOptions.columnAllowlist` is configured for this
 * deployment, mirroring the read path's unconditional posture.
 *
 * GAP THIS CLOSES: on the read path, a qualified column reference naming a
 * table absent from `schemaAllowlist` always gets a clean, actionable
 * `MUI X`-prefixed rejection via `assertQualifiedColumnsAllowed` above — even
 * when no `columnAllowlist` is configured. The write path had no equivalent:
 * `handleMutation` only ran `assertTablesAllowed` (primary table only — a
 * mutation never joins), so a qualified `where[].column` (the one
 * client-controlled qualified reference `applyPredicate` emits verbatim into
 * `query.where(where[].column, …)`) was only checked against a table
 * allowlist when `options.columnAllowlist` happened to be configured (via
 * `validateMutation` → `checkColumnAgainstAllowlist`). A
 * `schemaAllowlist`-only deployment therefore had no application-layer
 * rejection for this reference — the query still failed CLOSED (mutations are
 * always single-table with the tenant predicate AND-ed in first, and
 * `sanitizeBoundaryError` generalizes the resulting driver error to a generic
 * message), but as an opaque downstream failure rather than this package's own
 * clear error, the same inconsistency `assertQualifiedColumnsAllowed` closes
 * for reads. Running this check unconditionally closes it for writes too.
 *
 * @param where - The mutation descriptor's `where` predicates, if any.
 * @param schemaAllowlist - The allowlist of writable table names.
 */
export function assertQualifiedWhereColumnsAllowed(
  where: FilterPredicate[] | undefined,
  schemaAllowlist: string[],
): void {
  for (const predicate of where ?? []) {
    checkQualifiedColumn(predicate.column, 'where', schemaAllowlist);
  }
}
