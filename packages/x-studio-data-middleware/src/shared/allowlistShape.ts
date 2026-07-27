/**
 * RUNTIME shape validation for the host-supplied allowlists.
 *
 * `schemaAllowlist: string[]`, `columnAllowlist: Record<string, string[]>` and
 * `writableColumns: Record<string, string[]>` are enforced by TypeScript alone —
 * and TypeScript is not present at runtime for a host that reads its
 * configuration from the environment, a JSON/YAML config file, or a database
 * row. The realistic misconfiguration is a STRING where an array is expected:
 *
 * ```ts
 * schemaAllowlist: process.env.STUDIO_TABLES  // "orders_public"
 * ```
 *
 * Every membership check in this package is `Array.prototype.includes`, and on a
 * string that silently degrades to `String.prototype.includes` — SUBSTRING
 * matching, which FAILS OPEN:
 *
 *   - `schemaAllowlist: 'orders_public'` → `'orders_public'.includes('orders')` is
 *     `true`, so a query against the never-allowlisted `orders` table is admitted
 *     and `select * from "orders" …` is emitted.
 *   - `columnAllowlist: { orders: 'id,status' }` → any substring is admitted,
 *     including the EMPTY string (reachable, because `checkColumnAgainstAllowlist`
 *     splits a qualified reference at its first dot, so `columns: ['orders.']`
 *     yields `column === ''`).
 *
 * These validators are the allowlists' analogue of the runtime `tenantColumn`
 * check in `security/compileSecurityPolicy.ts`, which exists for exactly the same
 * reason (a compile-time-only type wired to an unset environment variable), and
 * they are invoked from the same place: `compileSecurityPolicy`, the single
 * config choke point both `handleBatchQuery` and `handleMutation` run first.
 *
 * They are ALSO re-asserted at each membership site (`assertTablesAllowed`,
 * `checkColumnAgainstAllowlist`, `synthesizeProjectionFromAllowlist`), because
 * those functions are exported and reachable by direct callers that never compile
 * a policy. Fail closed in both places.
 */

/** Describe a rejected allowlist value for a config-error message. */
function describeValue(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return `the string ${JSON.stringify(value.slice(0, 80))}`;
  }
  if (Array.isArray(value)) {
    return 'an array';
  }
  return `a ${typeof value}`;
}

/**
 * Assert that an allowlist is an array of strings (`schemaAllowlist`, or one
 * table's entry inside `columnAllowlist` / `writableColumns`).
 */
export function assertStringArrayAllowlist(
  value: unknown,
  label: string,
): asserts value is string[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `MUI X Studio Server: ${label} must be an array of strings, but received ${describeValue(value)}. ` +
        `Membership is checked with Array.prototype.includes, so a string silently degrades to SUBSTRING matching ` +
        `and admits names that were never allowlisted (e.g. "orders_public".includes("orders") is true) — the ` +
        `allowlist would fail OPEN. This commonly happens when the allowlist is wired straight to an environment ` +
        `variable. Split the value into an array (e.g. process.env.X.split(",")) before passing it.`,
    );
  }
  const invalid = value.find((entry) => typeof entry !== 'string');
  if (invalid !== undefined) {
    throw new Error(
      `MUI X Studio Server: ${label} contains ${describeValue(invalid)}, but every entry must be a string. ` +
        `A non-string entry can never match a table or column name, so it either silently does nothing or — for a ` +
        `nested array — matches by coercion in ways the allowlist does not intend. ` +
        `Remove the entry or replace it with the table/column name it was meant to be.`,
    );
  }
}

/**
 * Assert that a per-table allowlist is a plain object whose every value is an
 * array of strings (`columnAllowlist`, `writableColumns`).
 */
export function assertPerTableAllowlist(
  value: unknown,
  label: string,
): asserts value is Record<string, string[]> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(
      `MUI X Studio Server: ${label} must be a plain object mapping each table name to an array of allowed ` +
        `columns, but received ${describeValue(value)}. ` +
        `A non-object value cannot be looked up per table, so every referenced table would be treated as having no ` +
        `entry (rejecting every request) or, for an array, would match by index instead of by name. ` +
        `Pass a { [table: string]: string[] } object, or omit the option entirely to disable the check.`,
    );
  }
  for (const table of Object.keys(value)) {
    assertStringArrayAllowlist((value as Record<string, unknown>)[table], `${label}["${table}"]`);
  }
}
