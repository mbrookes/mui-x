import { withTimeout } from './mcp/helpers';

/**
 * Default idle-timeout (ms): the max time the read loop will wait for the
 * NEXT chunk before treating the stream as stalled. Reset after every chunk
 * actually received (finding: a provider that emits some bytes then goes
 * silent mid-stream would previously hang the connection forever — the
 * time-to-headers timeout `agenticLoop.ts` applies to the initial `fetch()`
 * only bounds the wait for the response to START; it already resolved by the
 * time the read loop below begins, so it can never fire again for a stall
 * that happens after the first byte).
 */
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

export interface ParseSSEOptions {
  /**
   * Max time (ms) to wait for the next `reader.read()` to resolve before
   * treating the stream as stalled and aborting it. Reset on every chunk
   * received. @default 60_000
   */
  idleTimeoutMs?: number;
}

/**
 * Parses an OpenAI-compatible Server-Sent Events stream.
 *
 * Yields each parsed JSON object from `data:` lines.
 * Stops on `[DONE]` sentinel.
 *
 * Bounded by an idle timeout (`options.idleTimeoutMs`, reset per chunk) so a
 * mid-stream stall doesn't hang forever, and always cancels/releases the
 * underlying reader on exit — including an early exit via the caller
 * `break`-ing out of its `for await` loop, or an error thrown mid-read (such
 * as the idle timeout itself) — so the underlying connection is never left
 * open.
 */
export async function* parseSSE(
  response: Response,
  options: ParseSSEOptions = {},
): AsyncGenerator<Record<string, unknown>> {
  const { idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS } = options;
  const reader = response.body?.getReader();
  if (!reader) {
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';

  // Parse a single complete SSE line, yielding its payload. Returns `true` on the
  // `[DONE]` sentinel so the caller can stop. Shared by the read loop and the
  // end-of-stream flush so both paths handle `data:` lines identically.
  function* emit(line: string): Generator<Record<string, unknown>, boolean> {
    // Accept both `data: ` (with the conventional single space) and `data:` with no
    // space — the SSE spec makes the space optional and some OpenAI-compatible
    // servers omit it, so a strict `data: ` prefix would silently drop those events.
    if (line.startsWith('data:')) {
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') {
        return true;
      }
      try {
        yield JSON.parse(payload) as Record<string, unknown>;
      } catch {
        // skip malformed lines
      }
    }
    return false;
  }

  // try/finally (finding T3): guarantee the reader is cancelled/released on every
  // exit path — normal completion, an error thrown mid-read (including the idle
  // timeout below), AND the caller stopping early (e.g. `break`-ing out of its
  // `for await` loop, which resumes this generator via `.return()` and runs this
  // `finally` block). Previously only normal completion released the stream,
  // leaving the underlying connection (and, for a stalled provider, the socket)
  // open indefinitely on any other exit.
  try {
    while (true) {
      // Bounded by `idleTimeoutMs`, reset every iteration: a provider that sends
      // some bytes then goes silent would otherwise hang this read forever, since
      // `agenticLoop.ts`'s time-to-headers timeout already resolved once the
      // response headers arrived and can't fire again. Reuses the same
      // race-a-timeout mechanism (`withTimeout`) the fetch-level timeout uses, for
      // consistency. Calling `reader.cancel()` in the `finally` block below (which
      // this rejection triggers) aborts the underlying fetch per the Streams/Fetch
      // spec integration, so the stalled connection is actually torn down, not just
      // abandoned.
      // eslint-disable-next-line no-await-in-loop -- sequential streaming read; cannot be parallelized
      const { done, value } = await withTimeout(
        reader.read(),
        idleTimeoutMs,
        'MUI X Studio: LLM response stream (no data received)',
      );
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      // Split on LF or CRLF explicitly so a `\r` terminator is stripped by the split
      // rather than relying on the incidental `.trim()` of the payload below.
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (yield* emit(line)) {
          return;
        }
      }
    }

    // Flush the final line (finding T3-4a): a stream that ends WITHOUT a trailing newline
    // leaves its last `data:` line sitting in `buffer` — never split out, so it would be
    // dropped when the reader reports `done`, silently losing the final event (which may
    // be the `usage` record or the closing delta). Process whatever remains.
    if (buffer.trim() !== '') {
      yield* emit(buffer);
    }
  } finally {
    // Best-effort cleanup: cancelling an already-fully-consumed (or already
    // cancelled/errored) stream should be a no-op, but some implementations can
    // reject if the reader was already released — and a caller-provided/test
    // reader stub may not implement `cancel` at all. Guard both so cleanup never
    // throws a secondary error that masks the real one propagating out of `try`.
    try {
      void reader.cancel?.()?.catch?.(() => {});
    } catch {
      // ignore — see above
    }
  }
}
