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
    // INFORMATION DISCLOSURE (finding 3.3): the client-facing message names ONLY the
    // rejected table(s), never the full allowlist. Enumerating every allowed table
    // in an error returned verbatim to any authenticated caller (`handler.ts`'s
    // per-widget `{ error }`) hands out the server's schema map. The full allowlist
    // is logged server-side for operator debugging instead.
    // eslint-disable-next-line no-console
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
