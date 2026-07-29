/**
 * Small shared helper for formatting a caught value into a log-friendly string.
 *
 * Distinct from `shared/sanitizeError.ts`'s `sanitizeBoundaryError`: that
 * function classifies and sanitizes an error message that may be sent back to
 * a CLIENT (never leaking raw DB-driver internals). `describeCause` is for the
 * opposite side of the boundary — a SERVER-SIDE `console.warn` `Cause: …`
 * fragment describing a caught error that is never returned to the caller, so
 * there is nothing to sanitize; it only needs a readable string.
 */

/**
 * Format a caught value (any thrown value, not just `Error`) as a readable
 * string for a server-side log line, e.g. `` `Cause: ${describeCause(err)}` ``.
 */
export function describeCause(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
