/**
 * Builds the two DIFFERENT views every LLM-provider failure needs:
 * a full-detail one for the server's own logs, and a deliberately sparse one for
 * the untrusted client.
 *
 * Why the split: this package's callers stream errors straight to a browser. A
 * provider's error BODY is not safe to relay — OpenAI's 401 body echoes the
 * partially-masked API key and organisation, Azure/APIM and self-hosted gateways
 * commonly echo the deployment path, an internal hostname, or the received
 * `Authorization` header, and a `fetch` rejection's `message` discloses internal
 * network topology (`connect ECONNREFUSED 10.0.3.11:5432`). A hostile gateway can
 * also return a 100 MB error body, which was previously buffered whole into a
 * single SSE event. `handleGenerateInsight.ts` already got this right (it relays
 * the status only); this makes every other provider-error site consistent with it.
 *
 * The client gets the status, a SANITIZED and BOUNDED status text, and a correlation
 * id; the operator finds the body in their logs by that id.
 *
 * **`statusText` is far-side text too**. This comment used to say the
 * client "gets status + statusText", contradicting ARCHITECTURE.md's "two untrusted
 * frontiers" rule that far-side text is never relayed onward — and the code matched the
 * comment rather than the rule: the gateway-authored reason phrase reached the browser's
 * SSE `error` frame verbatim and UNBOUNDED, with only `body` capped. HTTP/1.1 lets a
 * server put an arbitrary reason phrase on the status line and `fetch` surfaces it
 * as-is, so it is a place to plant a multi-megabyte string, a forged sibling line of
 * prose, or an instruction addressed to whoever renders the frame. It now routes
 * through {@link safeIdentifier} — this package's one sanitize-and-cap chokepoint for
 * untrusted text echoed into prose — so it can only ever occupy the position it is
 * given. The same sanitized value goes into `detail`: a reason phrase is one short line
 * by definition, so there is no operator fidelity to trade away, and the raw body is
 * already there in full.
 *
 * Internal to the package — not exported from `index.ts`.
 */
import { randomUUID } from 'node:crypto';
import { safeIdentifier } from '../mcp/helpers';
import { asString, capText } from './promptCaps';
import { isPackageAuthoredError } from './packageError';

/**
 * The prefix every message this package surfaces to a client must carry (AGENTS.md).
 * Named here because the branded relay below has to TEST for it, not just prepend it.
 */
const PACKAGE_PREFIX = 'MUI X Studio: ';

/**
 * Max chars of a provider error body retained for the SERVER-SIDE log. Bounds the
 * hostile-gateway "100 MB error body" case even on the logging path — the body is
 * never relayed to the client at any length.
 */
export const MAX_PROVIDER_ERROR_DETAIL_CHARS = 2_000;

export interface ProviderErrorReport {
  /** Opaque id present in BOTH the logged detail and the client message. */
  correlationId: string;
  /** Full (bounded) detail. Log this server-side; never send it to a client. */
  detail: string;
  /** Safe to stream to an untrusted client: status/statusText + correlation id. */
  clientMessage: string;
}

/**
 * Report a non-2xx response from an LLM provider.
 *
 * @param context - What was being attempted, e.g. `'LLM provider request'`.
 * @param status - The HTTP status code.
 * @param statusText - The HTTP status text (may be empty on HTTP/2).
 * @param body - The response body, when it could be read. Bounded and kept in
 *   `detail` only.
 */
export function reportProviderHttpError(
  context: string,
  status: number,
  statusText: string,
  body?: string,
): ProviderErrorReport {
  const correlationId = randomUUID();
  // Sanitize + cap before interpolation, not after. `safeIdentifier`
  // coerces through the total `asString` (a `statusText` typed `string` still arrives
  // off the wire), caps at `MAX_ECHOED_IDENTIFIER_LENGTH`, and neutralizes the line
  // breaks, angle brackets and quotes that would otherwise let this one field forge
  // prose around itself. An empty/whitespace-only phrase drops out of the message
  // entirely, exactly as before.
  const safeStatusText = safeIdentifier(statusText);
  const statusPart = safeStatusText ? `HTTP ${status} ${safeStatusText}` : `HTTP ${status}`;
  return {
    correlationId,
    detail:
      `MUI X Studio: ${context} failed with ${statusPart} [correlationId: ${correlationId}]. ` +
      `Provider response body: ${capText(body ?? '(unavailable)', MAX_PROVIDER_ERROR_DETAIL_CHARS)}`,
    clientMessage:
      `MUI X Studio: ${context} failed (${statusPart}). This ends the current request. ` +
      "The provider's response body is withheld here because it can contain credentials or " +
      `internal infrastructure details — check the server logs for correlation id ${correlationId} ` +
      'to see it, and verify the endpoint, API key, and model configuration.',
  };
}

/**
 * Report a transport-level failure (a rejected `fetch`, a timeout) talking to an
 * LLM provider. `err.message` goes to `detail` only — it routinely names internal
 * hosts, ports, and IP addresses.
 *
 * The exception is a PACKAGE-AUTHORED error: a `withTimeout` deadline, and every
 * self-imposed cap that can trip mid-stream (`parseSSE`'s buffer cap, `openaiWire`'s
 * tool-call count and argument-buffer caps, `agenticLoop`'s turn-text cap). Each is
 * built from a server-authored sentence and a compile-time constant, discloses nothing
 * about the network, and is the one thing that tells an operator — and the user
 * watching the stream — WHICH of "the provider went silent", "the provider refused"
 * and "our own limit fired" actually happened. Relaying them verbatim is what keeps
 * the generic sentence below from asserting the opposite: a cap trips precisely when
 * the provider is reachable and streaming.
 */
export function reportProviderFetchError(context: string, err: unknown): ProviderErrorReport {
  const correlationId = randomUUID();
  // `asString`, not the raw `String` global (the same hazard as in
  // `handleAIChat.ts`): `String(x)` is not total — `String({ toString: 1 })` throws
  // `TypeError: Cannot convert object to primitive value`. A reporter that throws on
  // the input class it exists to neutralize is worse than no reporter, and this one
  // runs inside catch blocks where the thrown value is entirely arbitrary.
  const raw = err instanceof Error ? err.message : asString(err);
  if (isPackageAuthoredError(err)) {
    // Most branded messages already open with the package prefix; `withTimeout`'s does
    // not, because it composes a bare label with a duration. Prepending unconditionally
    // would render "MUI X Studio: MUI X Studio: …" for the former, so add the prefix
    // only when it is actually missing rather than requiring every thrower to guess
    // which arm it will be relayed through.
    const message = capText(raw, MAX_PROVIDER_ERROR_DETAIL_CHARS);
    const withPrefix = message.startsWith(PACKAGE_PREFIX) ? message : `${PACKAGE_PREFIX}${message}`;
    // `withTimeout` ends its message with a bare duration, the caps end theirs with a
    // full stop; terminate here so the sentence that follows never runs on.
    const prefixed = withPrefix.endsWith('.') ? withPrefix : `${withPrefix}.`;
    return {
      correlationId,
      detail: `${prefixed} [correlationId: ${correlationId}]`,
      // Deliberately vaguer than the old "reachable and responding within the configured
      // deadline": this arm now also carries the self-imposed caps (stream buffer,
      // tool-call count, argument buffer), which trip on a provider that IS reachable and
      // IS responding. Each branded message states its own cause, so the tail only has to
      // say where to look next without contradicting it.
      clientMessage: `${prefixed} This ends the current request. The full text above is the server's own diagnosis — check the LLM provider endpoint and the gateway's streaming behaviour.`,
    };
  }
  return {
    correlationId,
    detail: `MUI X Studio: ${context} failed [correlationId: ${correlationId}]: ${capText(raw, MAX_PROVIDER_ERROR_DETAIL_CHARS)}`,
    clientMessage:
      `MUI X Studio: ${context} could not be completed — the LLM provider was unreachable or the ` +
      'request timed out. This ends the current request. The underlying transport error is withheld ' +
      'here because it can disclose internal network details — check the server logs for ' +
      `correlation id ${correlationId}, then verify the endpoint URL and network egress rules.`,
  };
}
