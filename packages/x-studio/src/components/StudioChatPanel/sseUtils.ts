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
 * Shared by `studioBackendAdapter.ts` (main chat panel) and
 * `StudioTextWidget/useTextWidgetAI.ts` (per-widget AI text generation) — both
 * need to send a sanitized snapshot of state to the same kind of AI endpoint.
 */
export function serializeDashboardState(state: StudioState): StudioState {
  return {
    ...state,
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
    throw new Error('No response body.');
  }
  options?.onReader?.(reader);

  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    // Sequential SSE stream: each chunk depends on the previous read, so awaiting
    // inside the loop is intentional (the reads cannot be parallelized).
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) {
      return;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) {
        continue;
      }
      const payload = line.slice(6).trim();
      if (!payload) {
        continue;
      }
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(payload);
      } catch {
        continue;
      }
      if (onEvent(event) === false) {
        return;
      }
    }
  }
}
