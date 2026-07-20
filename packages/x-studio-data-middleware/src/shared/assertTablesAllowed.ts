/**
 * Shared table-allowlist assertion for @mui/x-studio-data-middleware.
 *
 * The Zero-Knowledge Rule: any table not in the caller-supplied `schemaAllowlist`
 * is rejected before any query is built. Used by BOTH the read handler
 * (`handleBatchQuery`) and the write handler (`handleMutation`) so the check —
 * and its error text — live in exactly one place.
 */
import type { BatchWidgetDescriptor } from '../security/types';

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
 * Enforce the Zero-Knowledge Rule on every table-QUALIFIED column reference in a
 * read descriptor — `columns`, `filters[].column`, `orderBy[].column`, and the
 * physical (value) side of `columnAliases` — independent of whether a
 * `columnAllowlist` is configured for this deployment.
 *
 * GAP THIS CLOSES: `assertTablesAllowed` only checks `descriptor.table` and
 * `descriptor.joins[].table` — the tables a query structurally touches via
 * FROM/JOIN. A qualified column reference such as `"other_table.balance"` inside
 * `filters` / `columns` / `orderBy` / `columnAliases` names a THIRD table that
 * never reaches that check. When a `columnAllowlist` IS configured,
 * `validateDescriptorColumns` (`shared/columnValidation.ts`) happens to reject
 * this too (it splits the qualified reference and requires the named table to
 * have its OWN allowlist entry) — but that validator runs ONLY when a
 * `columnAllowlist` is supplied (`security/validateQueryPlan.ts`'s
 * `if (columnAllowlist) { validateDescriptorColumns(...) }` gate). A deployment
 * that scopes access via `schemaAllowlist` alone (no `columnAllowlist`) therefore
 * had NO application-layer check for this reference at all — the query still
 * failed CLOSED (an unregistered/nonexistent table surfaces as a raw DB error),
 * but as an opaque downstream failure instead of this package's own clear,
 * actionable error, which is an inconsistency in the "Zero-Knowledge Rule"
 * surface (every OTHER table reference gets a clean application-layer rejection).
 * Running this check unconditionally — regardless of `columnAllowlist` — closes
 * that inconsistency.
 *
 * @param descriptor - The widget descriptor being validated.
 * @param schemaAllowlist - The allowlist of queryable table names.
 */
export function assertQualifiedColumnsAllowed(
  descriptor: BatchWidgetDescriptor,
  schemaAllowlist: string[],
): void {
  const check = (column: string, context: string): void => {
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
  };

  for (const column of descriptor.columns ?? []) {
    check(column, 'columns');
  }
  for (const filter of descriptor.filters ?? []) {
    check(filter.column, 'filters');
  }
  for (const orderBy of descriptor.orderBy ?? []) {
    check(orderBy.column, 'orderBy');
  }
  for (const physical of Object.values(descriptor.columnAliases ?? {})) {
    if (typeof physical === 'string') {
      check(physical, 'columnAliases');
    }
  }
}
