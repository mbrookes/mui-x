/**
 * Per-query statement timeouts (F2).
 *
 * WHY THIS EXISTS. Every database round-trip this package issues went out
 * untimed, and `MAX_CONCURRENT_WIDGET_QUERIES` (6, `handler.ts`) bounds ONE
 * request, not one caller. Ten concurrent batches of six distinct widgets each
 * put 60 queries in flight against a host Knex pool whose defaults are
 * `max: 10` / `acquireConnectionTimeout: 60_000`. The preflight COUNT(*) is
 * deliberately LIMIT-less, so one slow count pins a pooled connection for as long
 * as the database takes — and the host's own non-Studio traffic starts failing on
 * connection acquisition. The middleware's blast radius has to stop at its own
 * queries.
 *
 * A timeout converts that into a bounded, per-widget `{ error }` (the read path's
 * error boundary) or a per-mutation `{ ok: false }` (the write path's), which is
 * a failure mode the host can see and act on.
 *
 * SINGLE HELPER, BY DESIGN. Applied from inside `runBounded`
 * (`router/execute.ts`), `runPreflight` (`router/preflight.ts`) and the write
 * path's one mutation-dispatch site, mirroring the discipline `runBounded`
 * already enforces for LIMIT: a new exit path through those functions cannot
 * forget the timeout, because it does not apply it itself.
 */

/**
 * Default per-query statement timeout, in milliseconds.
 *
 * 30s is far above any interactive dashboard query worth serving (the preflight's
 * own docblock budgets it at sub-millisecond up to 1M rows) and far below the
 * 60s `acquireConnectionTimeout` a default Knex pool gives the host's OTHER
 * traffic — so a runaway Studio query surfaces as a Studio error before it can
 * starve anything else. Hosts that genuinely need longer raise
 * `queryTimeoutMs`; hosts that manage timeouts at the driver or database level
 * (`statement_timeout`, `MAX_EXECUTION_TIME`) set `queryTimeoutMs: 0` to opt out.
 */
export const DEFAULT_QUERY_TIMEOUT_MS = 30_000;

/**
 * Validate and resolve a host-supplied `queryTimeoutMs` into the number the query
 * helpers apply.
 *
 * Called ONCE per request, at the handler boundary, so a misconfigured value
 * rejects the whole request with one clear error instead of surfacing as an
 * identical per-widget `{ error }` on all 50 widgets.
 *
 * - `undefined` → {@link DEFAULT_QUERY_TIMEOUT_MS}.
 * - `0` → no timeout is applied (explicit opt-out for hosts enforcing one at the
 *   driver/database level). Knex itself ignores a non-positive `.timeout()`, so
 *   this is a documented intent rather than a silently-swallowed value.
 * - anything else must be a positive, finite integer.
 */
export function resolveQueryTimeoutMs(configured: number | undefined): number {
  if (configured === undefined) {
    return DEFAULT_QUERY_TIMEOUT_MS;
  }
  if (typeof configured !== 'number' || !Number.isFinite(configured) || configured < 0) {
    throw new Error(
      `MUI X Studio Server: "queryTimeoutMs" must be a non-negative finite number of milliseconds, ` +
        `but received ${typeof configured === 'number' ? configured : JSON.stringify(configured)}. ` +
        `Every query this middleware issues is bounded by that timeout so a slow query cannot pin a pooled ` +
        `connection and starve the host application's own traffic, and an unusable value would silently leave ` +
        `queries untimed. Pass a positive number of milliseconds (default ${DEFAULT_QUERY_TIMEOUT_MS}), or 0 to ` +
        `opt out because the timeout is enforced at the driver or database level.`,
    );
  }
  return configured;
}

/**
 * Apply the statement timeout to a Knex query builder and return it.
 *
 * CANCELLATION IS DIALECT-GATED. Knex's `.timeout(ms, { cancel: true })` calls
 * `client.assertCanCancelQuery()` SYNCHRONOUSLY at builder time and THROWS
 * (`Query cancelling not supported for this dialect`) for any client reporting
 * `canCancelQuery === false` — which includes sqlite3 and better-sqlite3.
 * Requesting cancellation unconditionally would therefore break every SQLite
 * deployment outright at query-build time: the same class of dialect-specific
 * defect as F1's `whereLike`/`COLLATE utf8_bin`, and just as invisible to a
 * mock-DB test suite. So it is requested only where the client advertises
 * support (mysql/mysql2, pg and friends).
 *
 * Without cancellation Knex still bounds the wait and marks the connection
 * `__knex__disposed`, so the pool destroys and replaces it rather than handing
 * back a socket still busy with the abandoned query — the pool slot, which is
 * the resource this fix is about, is reclaimed either way. Cancellation
 * additionally kills the query server-side, which is strictly better where the
 * dialect can do it.
 *
 * A `timeoutMs` of `0` applies nothing (the documented opt-out).
 */
export function applyQueryTimeout<T>(query: T, timeoutMs: number): T {
  if (timeoutMs <= 0) {
    return query;
  }
  const builder = query as any;
  const canCancel = builder?.client?.canCancelQuery === true;
  builder.timeout(timeoutMs, { cancel: canCancel });
  return query;
}
