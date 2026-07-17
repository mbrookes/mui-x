/**
 * Parses an OpenAI-compatible Server-Sent Events stream.
 *
 * Yields each parsed JSON object from `data:` lines.
 * Stops on `[DONE]` sentinel.
 */
export async function* parseSSE(response: Response): AsyncGenerator<Record<string, unknown>> {
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

  while (true) {
    // eslint-disable-next-line no-await-in-loop -- sequential streaming read; cannot be parallelized
    const { done, value } = await reader.read();
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
}
