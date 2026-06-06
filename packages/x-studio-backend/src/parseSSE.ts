/**
 * Parses an OpenAI-compatible Server-Sent Events stream.
 *
 * Yields each parsed JSON object from `data:` lines.
 * Stops on `[DONE]` sentinel.
 */
export async function* parseSSE(
  response: Response,
): AsyncGenerator<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) {
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    // eslint-disable-next-line no-await-in-loop -- sequential streaming read; cannot be parallelized
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') {
          return;
        }
        try {
          yield JSON.parse(payload) as Record<string, unknown>;
        } catch {
          // skip malformed lines
        }
      }
    }
  }
}
