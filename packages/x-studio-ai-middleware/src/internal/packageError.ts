/**
 * Distinguishes error text THIS package authored from error text that crossed the
 * host boundary.
 *
 * Every host-facing catch block in this package redacts: the host/DB error is
 * written to the server log and the model/browser gets a generic sentence plus a
 * correlation id (see `redactedHostErrorMessage` in `mcp/helpers.ts` and
 * `reportProviderFetchError` in `./providerError`). That is right for host-authored
 * text, which routinely carries credentials, SQL fragments, and internal hostnames.
 *
 * It is wrong for the errors this package generates itself. A `withTimeout`
 * rejection names a server-authored label and a duration and nothing else — there is
 * no untrusted content in it to leak, and it is the single most useful thing an
 * operator (or the model deciding whether to retry) can see. Redacting it costs real
 * diagnostics for zero security benefit, and it makes "the call hung" indistinguishable
 * from "the database rejected the query".
 *
 * So package-authored errors carry a brand, and the redaction helpers relay a branded
 * error verbatim while still redacting everything else. The brand is a
 * `Symbol.for` registry symbol and is checked as an own property rather than by
 * `instanceof`, so it survives a duplicated copy of this module in the dependency
 * graph.
 *
 * Internal to the package — not exported from `index.ts`.
 */

/** Brand marking an `Error` as authored by this package, hence safe to relay verbatim. */
export const PACKAGE_AUTHORED_ERROR: unique symbol = Symbol.for(
  '@mui/x-studio-ai-middleware.packageAuthoredError',
);

/**
 * The rejection `withTimeout` produces. Branded, so the redaction helpers relay its
 * message (`"<label> timed out after <ms>ms"`) instead of replacing it with a
 * correlation id.
 */
export class StudioTimeoutError extends Error {
  readonly [PACKAGE_AUTHORED_ERROR] = true;

  /** The deadline that elapsed, in milliseconds. */
  readonly timeoutMs: number;

  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = 'StudioTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Brand `err` as package-authored, so the redaction helpers relay its message verbatim
 * instead of withholding it behind a correlation id.
 *
 * Lives here rather than beside any one thrower because every self-imposed cap in this
 * package needs it: the stream buffer cap (`parseSSE`), the tool-call count and
 * argument-buffer caps (`agenticLoop/openaiWire`), and the turn-text cap
 * (`agenticLoop`). When one of those trips it is OUR limit firing, not the provider
 * failing — an unbranded throw reaches `reportProviderFetchError`'s redacting arm and
 * the browser is told "the LLM provider was unreachable or the request timed out",
 * which is false and sends the operator to check network egress rules for a gateway
 * that was, in fact, reachable and streaming.
 *
 * Only ever apply it to messages built purely from server-authored prose and
 * compile-time constants — there is nothing untrusted in those to leak. The brand is an
 * OWN property keyed by a `Symbol.for` registry symbol (never an `instanceof` check),
 * so it survives a duplicated copy of this module in the dependency graph.
 */
export function markPackageAuthored(err: Error): Error {
  (err as unknown as Record<symbol, unknown>)[PACKAGE_AUTHORED_ERROR] = true;
  return err;
}

/**
 * Whether `err` was authored by this package and therefore carries no untrusted
 * content — the single predicate every redaction site consults before deciding
 * whether to withhold the message.
 */
export function isPackageAuthoredError(err: unknown): err is Error {
  return (
    err instanceof Error &&
    (err as unknown as Record<symbol, unknown>)[PACKAGE_AUTHORED_ERROR] === true
  );
}
