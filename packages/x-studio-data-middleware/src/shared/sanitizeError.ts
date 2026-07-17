/**
 * Boundary error classification for @mui/x-studio-data-middleware.
 *
 * The read (`handleBatchQuery`) and write (`handleMutation`) handlers isolate a
 * single failing item as its own `{ error }` / `{ ok: false, error }` result. The
 * message returned there is sent verbatim to any authenticated caller, so it must
 * not be a raw database-driver error: a Knex/driver message such as
 * `no such column: orders.secret` or `relation "payroll" does not exist` is a
 * schema oracle that leaks table/column names even on a deployment that configured
 * NO `columnAllowlist` — undercutting the allowlist disclosure hardening (finding
 * T3.5).
 *
 * This package's OWN thrown errors are deliberately authored, actionable, and safe
 * to disclose (they are `MUI X`-prefixed and never echo schema internals the caller
 * could not already infer from its own request). So classify at the boundary: pass
 * our own messages through unchanged, and replace anything else with a generic
 * client-facing message while logging the original server-side for operators.
 */

/** Marker every error this package throws carries (`MUI X Studio Server:` / `MUI X:`). */
const OWN_ERROR_PREFIX = 'MUI X';

/**
 * Return a client-safe message for a per-item boundary failure.
 *
 * @param err - The caught error (any thrown value).
 * @param genericMessage - The `MUI X`-prefixed message to return (and log alongside
 *   the original cause) when `err` is NOT one of this package's own errors.
 */
export function sanitizeBoundaryError(err: unknown, genericMessage: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Our own errors are safe, deliberate, and actionable — disclose them as-is.
  if (raw.startsWith(OWN_ERROR_PREFIX)) {
    return raw;
  }
  // Anything else (a DB driver error, an unexpected throw) may leak schema details —
  // log the real cause server-side and return only the generic message.
  console.warn(`${genericMessage} Original cause (server-side only): ${raw}`);
  return genericMessage;
}
