/**
 * Shared table-allowlist assertion for @mui/x-studio-data-middleware.
 *
 * The Zero-Knowledge Rule: any table not in the caller-supplied `schemaAllowlist`
 * is rejected before any query is built. Used by BOTH the read handler
 * (`handleBatchQuery`) and the write handler (`handleMutation`) so the check —
 * and its error text — live in exactly one place.
 */

/**
 * Throw when any of `tables` is not present in `schemaAllowlist`.
 *
 * @param tables - Every table referenced by the request (primary + joined).
 * @param schemaAllowlist - The allowlist of queryable/writable table names.
 */
export function assertTablesAllowed(tables: string[], schemaAllowlist: string[]): void {
  const invalidTables = tables.filter((t) => !schemaAllowlist.includes(t));
  if (invalidTables.length > 0) {
    throw new Error(
      `MUI X Studio Server: Requested table(s) not in schema allowlist: ${invalidTables.join(', ')}. ` +
        `Allowed tables: ${schemaAllowlist.join(', ')}`,
    );
  }
}
