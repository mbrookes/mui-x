/**
 * Builds the two DIFFERENT views every LLM-provider failure needs (finding H4):
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
 * The client gets status + statusText + a correlation id; the operator finds the
 * body in their logs by that id.
 *
 * Internal to the package — not exported from `index.ts`.
 */
import { randomUUID } from 'node:crypto';
import { capText } from './promptCaps';
import { isPackageAuthoredError } from './packageError';

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
  const statusPart = statusText ? `HTTP ${status} ${statusText}` : `HTTP ${status}`;
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
 * The exception is a PACKAGE-AUTHORED error — currently only a `withTimeout`
 * deadline, whose message is `"LLM provider request timed out after <constant>ms"`.
 * That names a server-authored label and a compile-time constant, discloses nothing
 * about the network, and is the one thing that tells an operator (and the user
 * watching the stream) that the provider went silent rather than refused. It is
 * relayed verbatim.
 */
export function reportProviderFetchError(context: string, err: unknown): ProviderErrorReport {
  const correlationId = randomUUID();
  const raw = err instanceof Error ? err.message : String(err);
  if (isPackageAuthoredError(err)) {
    const message = capText(raw, MAX_PROVIDER_ERROR_DETAIL_CHARS);
    return {
      correlationId,
      detail: `MUI X Studio: ${message} [correlationId: ${correlationId}]`,
      clientMessage: `MUI X Studio: ${message}. This ends the current request. Check that the LLM provider endpoint is reachable and responding within the configured deadline.`,
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
