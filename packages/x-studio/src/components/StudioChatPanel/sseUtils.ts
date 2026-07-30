import type { StudioState } from '../../models';

/**
 * Strips the non-serializable / oversized parts of `dataSources` (raw `rows` and
 * the live `adapter` instance) before sending dashboard state to an AI backend.
 *
 * The server only needs structural information (widget configs, filters, layout)
 * — it never reads `dataSources.rows` or `dataSources.adapter`. Sending raw rows
 * can push the request body into tens of megabytes, exceeding server body-size
 * limits, and `adapter` instances aren't JSON-serializable at all.
 *
 * `doc.ai` is trimmed the same way: the server-side handler only ever reads
 * `activeThreadId` off of it (`executeToolOnState.ts`'s `rename_thread` tool and
 * its `projectStateForAI` snapshot both key off that field alone — the live
 * conversation itself already travels separately as the request's `messages`
 * array). Shipping the full `threads` array would mean every chat/widget request
 * re-sends the transcript of EVERY thread, not just the active one — unbounded
 * and redundant. This does not change what's stored in `doc.ai` client-side,
 * only the subset serialized for network transport.
 *
 * Shared by `studioBackendAdapter.ts` (main chat panel) and
 * `StudioTextWidget/useTextWidgetAI.ts` (per-widget AI text generation) — both
 * need to send a sanitized snapshot of state to the same kind of AI endpoint.
 */
export function serializeDashboardState(state: StudioState): StudioState {
  return {
    ...state,
    doc: {
      ...state.doc,
      ...(state.doc.ai ? { ai: { activeThreadId: state.doc.ai.activeThreadId, threads: [] } } : {}),
    },
    runtime: {
      ...state.runtime,
      dataSources: Object.fromEntries(
        Object.entries(state.runtime.dataSources).map(([id, source]) => {
          /* eslint-disable-next-line @typescript-eslint/naming-convention -- omit rows/adapter via rest */
          const { rows: _rows, adapter: _adapter, ...sourceWithoutData } = source;
          return [id, sourceWithoutData];
        }),
      ),
    },
  };
}

/**
 * Reads a `fetch` Response body as a `data: <json>\n\n`-delimited SSE stream and
 * invokes `onEvent` for each parsed JSON payload.
 *
 * Shared by `studioBackendAdapter.ts` and `StudioTextWidget/useTextWidgetAI.ts` so
 * the buffering/line-splitting/JSON-parsing logic (and any future protocol fix —
 * event names, buffering, abort handling) is implemented once.
 *
 * @param response The `fetch` response whose body is an SSE stream.
 * @param onEvent Called with each parsed event payload. Return `false` to stop
 *   reading the stream early (e.g. once a terminal event like `finish` arrives).
 * @param options.onReader Called with the underlying stream reader as soon as
 *   it's created, so callers that need to cancel an in-flight read (e.g. for a
 *   `stop()` action) can keep a reference to it.
 */
export async function parseSSEStream(
  response: Response,
  onEvent: (event: Record<string, unknown>) => void | false,
  options?: { onReader?: (reader: ReadableStreamDefaultReader<Uint8Array>) => void },
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error(
      `MUI X Studio: The AI endpoint returned a response with no readable body.
There is no SSE stream to parse, so the request produces no assistant output at all.
Check that the endpoint streams \`text/event-stream\` and that no proxy is buffering or stripping the response body.`,
    );
  }
  options?.onReader?.(reader);

  const decoder = new TextDecoder();
  let buffer = '';

  // Hard cap on the RESIDUAL (un-newlined) buffer — the partial line left over after the
  // complete lines of a read have been split off and processed. A well-behaved server
  // delimits every event with a newline, so that residue only ever holds a single partial
  // line. A hostile or misbehaving proxy could stream bytes containing NO newline at all,
  // which would grow it without bound — an eventual out-of-memory in a long-lived tab. If
  // the cap is exceeded we cancel the read and fail the stream cleanly (surfaced as an
  // error to the caller) rather than keep accumulating. 8 MB is far larger than any
  // legitimate single SSE event.
  //
  // Measuring the residue rather than the whole pre-split buffer matters: a single read can
  // legitimately deliver more than 8 MB of PROPERLY DELIMITED events (a large
  // `state-mutation`/`summarise_page` payload behind a buffering proxy that flushes late),
  // and checking before the split aborted that stream as "malformed" even though every byte
  // in it was newline-terminated — the exact condition the cap is supposed to permit.
  const MAX_BUFFER_SIZE = 8 * 1024 * 1024;

  // Parses one `data: <json>` line (with any trailing newline already stripped) and
  // forwards the event to `onEvent`. Shared by the main loop and the `done` flush
  // below so both paths handle a trailing/partial line identically.
  const processLine = (line: string): void | false => {
    if (!line.startsWith('data: ')) {
      return undefined;
    }
    const payload = line.slice(6).trim();
    if (!payload) {
      return undefined;
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(payload);
    } catch {
      return undefined;
    }
    return onEvent(event);
  };

  for (;;) {
    // Sequential SSE stream: each chunk depends on the previous read, so awaiting
    // inside the loop is intentional (the reads cannot be parallelized).
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) {
      // Flush any bytes the decoder buffered for a trailing multi-byte sequence, then
      // process whatever's left in `buffer` as a final event. The stream can end right
      // after a complete `data: {...}` line with no trailing newline (no closing blank
      // line) — without this, that line (and the decoder's unflushed tail) is silently
      // discarded, which can drop a `finish` event (surfacing as a spurious "stream
      // closed before a terminal chunk" error on an otherwise-successful message) or a
      // `state-mutation` event (silently losing a dashboard edit).
      buffer += decoder.decode();
      if (buffer) {
        processLine(buffer);
      }
      return;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    if (buffer.length > MAX_BUFFER_SIZE) {
      // Free the connection before surfacing the failure so a runaway stream doesn't keep the
      // socket alive. `cancel()` can reject if the stream is already errored/closed — ignore it.
      // Checked before dispatching this read's complete lines: at this point the residue alone
      // is already over the cap, so the stream is unusable regardless of what those lines say.
      reader.cancel().catch(() => {});
      throw new Error(
        `MUI X: SSE response exceeded the ${MAX_BUFFER_SIZE}-byte buffer limit without a newline. ` +
          `This usually means the server or a proxy is streaming malformed (un-delimited) data. ` +
          `The stream was aborted to avoid unbounded memory growth.`,
      );
    }

    for (const line of lines) {
      if (processLine(line) === false) {
        // The callback signalled a terminal event (`finish`/`error`). Cancel the reader so the
        // underlying socket/stream is released immediately — otherwise, if the server/proxy keeps
        // the connection open past the terminal event, it would stay alive until the caller
        // separately invokes `.stop()` or the page unloads. `cancel()` is idempotent-safe here:
        // the caller's `finally` removes this reader from its tracking set once we return, so a
        // later `.stop()` won't double-cancel it. Fire-and-forget (no await) to avoid blocking.
        reader.cancel().catch(() => {});
        return;
      }
    }
  }
}
