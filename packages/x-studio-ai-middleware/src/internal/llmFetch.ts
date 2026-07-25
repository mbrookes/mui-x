/**
 * Abort/cleanup helpers shared by every LLM fetch in this package (finding M5).
 *
 * `withTimeout` (`mcp/helpers.ts`) is a bare `Promise.race`: it makes the CALLER
 * stop waiting, but it never aborts the underlying request. So a fetch that
 * "timed out" at `LLM_FETCH_TIMEOUT_MS` kept running to completion upstream —
 * fully billed — with its response body never consumed or cancelled, pinning a
 * socket per abandoned request. These helpers give every call site a real
 * `AbortSignal` (linked to the caller's own signal, when there is one) and make a
 * timed-out body read release the connection.
 *
 * Internal to the package — not exported from `index.ts`.
 */
import { withTimeout } from '../mcp/helpers';

export interface LinkedAbort {
  /** Pass to `fetch({ signal })`. Aborts on timeout OR when `external` aborts. */
  signal: AbortSignal;
  /**
   * Cancel ONLY the timeout, keeping the link to `external` alive.
   *
   * Use this once a streaming response's headers have arrived: the fetch-level
   * deadline no longer applies (an idle-timeout bounds the stream from there),
   * but an external abort must still tear the response down.
   */
  clearTimer: () => void;
  /** Always call when the response is fully done with: clears the timer AND unsubscribes. */
  dispose: () => void;
}

/**
 * Create an `AbortSignal` that fires after `timeoutMs`, or as soon as `external`
 * aborts.
 *
 * Hand-rolled rather than using `AbortSignal.any`/`AbortSignal.timeout` so this
 * works on every runtime this package supports (both are relatively recent
 * additions and are missing from some test environments), and so `dispose` can
 * remove the `external` listener — a long-lived host signal reused across many
 * requests would otherwise accumulate one listener per request.
 */
export function linkAbortSignal(external: AbortSignal | undefined, timeoutMs: number): LinkedAbort {
  const controller = new AbortController();
  if (external?.aborted) {
    controller.abort();
    return { signal: controller.signal, clearTimer: () => {}, dispose: () => {} };
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // `unref` where available (Node) so a pending timer can never hold the process
  // open past the request it belongs to.
  (timer as unknown as { unref?: () => void }).unref?.();
  const onExternalAbort = () => controller.abort();
  external?.addEventListener('abort', onExternalAbort, { once: true });
  const clearTimer = () => clearTimeout(timer);
  return {
    signal: controller.signal,
    clearTimer,
    dispose: () => {
      clearTimer();
      external?.removeEventListener('abort', onExternalAbort);
    },
  };
}

/**
 * Read a response body under a timeout, cancelling the body when the read does
 * not settle in time.
 *
 * Without the cancel, a gateway that returns headers then stalls the body leaves
 * the connection open with an unread body for as long as the socket survives —
 * `withTimeout` only stops the caller waiting.
 *
 * @param response - The response whose body is being read.
 * @param read - The read to perform, e.g. `() => response.text()`.
 * @param timeoutMs - How long to wait before giving up.
 * @param label - Human-readable label used in the timeout error.
 */
export async function readBodyWithTimeout<T>(
  response: Response,
  read: () => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  try {
    return await withTimeout(read(), timeoutMs, label);
  } catch (err) {
    try {
      // Best effort: `text()`/`json()` may already have locked the body, in which
      // case `cancel()` throws and there is nothing further to release.
      await response.body?.cancel();
    } catch {
      // Body already locked/consumed/closed — nothing to release.
    }
    throw err;
  }
}
