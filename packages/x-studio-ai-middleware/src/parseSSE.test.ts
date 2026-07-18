/**
 * Unit tests for `parseSSE`.
 *
 * The parser turns an OpenAI-compatible byte stream into parsed JSON objects.
 * Its tricky paths — payloads split across `reader.read()` chunks, the `[DONE]`
 * sentinel, malformed-line skipping and a missing body — were previously
 * untested.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseSSE, type ParseSSEOptions } from './parseSSE';

/**
 * Builds a minimal `Response`-like object whose body streams the given string
 * chunks. Each chunk is delivered by a separate `reader.read()` call so we can
 * exercise buffer accumulation across reads.
 */
function fakeResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const reader = {
    read: async () => {
      if (index < chunks.length) {
        const value = encoder.encode(chunks[index]);
        index += 1;
        return { done: false, value };
      }
      return { done: true, value: undefined };
    },
  };
  return { body: { getReader: () => reader } } as unknown as Response;
}

async function collect(
  response: Response,
  options?: ParseSSEOptions,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for await (const chunk of parseSSE(response, options)) {
    out.push(chunk);
  }
  return out;
}

/**
 * Like `fakeResponse`, but the reader exposes a `cancel` spy so tests can
 * assert the reader was actually released/cancelled (finding T3: the read loop
 * must clean up on every exit path, not just normal completion).
 */
function fakeResponseWithCancelSpy(chunks: string[]): {
  response: Response;
  cancel: ReturnType<typeof vi.fn>;
} {
  const encoder = new TextEncoder();
  let index = 0;
  const cancel = vi.fn(async () => {});
  const reader = {
    read: async () => {
      if (index < chunks.length) {
        const value = encoder.encode(chunks[index]);
        index += 1;
        return { done: false, value };
      }
      return { done: true, value: undefined };
    },
    cancel,
  };
  return { response: { body: { getReader: () => reader } } as unknown as Response, cancel };
}

/**
 * A response whose reader delivers one chunk and then never resolves again —
 * simulating a provider that stalls mid-stream (sends some bytes, then goes
 * silent) rather than a gateway that never responds at all (which is what
 * `agenticLoop.ts`'s time-to-headers timeout already covers).
 */
function fakeStallingResponse(firstChunk: string): {
  response: Response;
  cancel: ReturnType<typeof vi.fn>;
} {
  const encoder = new TextEncoder();
  let delivered = false;
  const cancel = vi.fn(async () => {});
  const reader = {
    read: async () => {
      if (!delivered) {
        delivered = true;
        return { done: false, value: encoder.encode(firstChunk) };
      }
      // Never resolves — the stall.
      return new Promise<{ done: boolean; value?: Uint8Array }>(() => {});
    },
    cancel,
  };
  return { response: { body: { getReader: () => reader } } as unknown as Response, cancel };
}

describe('parseSSE', () => {
  it('yields parsed JSON objects from data: lines', async () => {
    const result = await collect(fakeResponse(['data: {"a":1}\n', 'data: {"b":2}\n']));
    expect(result).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('parses multiple data: lines from a single chunk', async () => {
    const result = await collect(fakeResponse(['data: {"a":1}\ndata: {"b":2}\n']));
    expect(result).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('reassembles a payload split across multiple reads', async () => {
    const result = await collect(fakeResponse(['data: {"a":', '1,"b":', '2}\n']));
    expect(result).toEqual([{ a: 1, b: 2 }]);
  });

  it('stops at the [DONE] sentinel and ignores anything after it', async () => {
    const result = await collect(
      fakeResponse(['data: {"a":1}\n', 'data: [DONE]\n', 'data: {"b":2}\n']),
    );
    expect(result).toEqual([{ a: 1 }]);
  });

  it('skips malformed JSON lines without throwing', async () => {
    const result = await collect(
      fakeResponse(['data: {"a":1}\n', 'data: not-json\n', 'data: {"b":2}\n']),
    );
    expect(result).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('ignores non-data lines (comments, event lines, blank lines)', async () => {
    const result = await collect(
      fakeResponse([': keep-alive\n', 'event: message\n', '\n', 'data: {"a":1}\n']),
    );
    expect(result).toEqual([{ a: 1 }]);
  });

  it('returns nothing when the response has no body', async () => {
    const result = await collect({ body: null } as unknown as Response);
    expect(result).toEqual([]);
  });

  // Regression for T3-4a: a stream that ends WITHOUT a trailing newline leaves its final
  // `data:` line sitting in the buffer. The parser must flush that remaining buffer after
  // the read loop, otherwise the last event (possibly the `usage` record or the closing
  // delta) is silently dropped.
  it('flushes a trailing data: line that lacks a newline terminator', async () => {
    const result = await collect(fakeResponse(['data: {"a":1}\n', 'data: {"b":2}']));
    expect(result).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('honors the [DONE] sentinel when it is the final unterminated line', async () => {
    const result = await collect(fakeResponse(['data: {"a":1}\n', 'data: [DONE]']));
    expect(result).toEqual([{ a: 1 }]);
  });

  it('does not emit a malformed trailing line on flush', async () => {
    const result = await collect(fakeResponse(['data: {"a":1}\n', 'data: not-json']));
    expect(result).toEqual([{ a: 1 }]);
  });

  it('handles CRLF (\\r\\n) line terminators', async () => {
    // Some servers terminate SSE lines with CRLF; the split must treat `\r\n` as a
    // single terminator so no stray `\r` leaks into the buffered payload.
    const result = await collect(fakeResponse(['data: {"a":1}\r\ndata: {"b":2}\r\n']));
    expect(result).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('honors the [DONE] sentinel even with a CRLF terminator', async () => {
    const result = await collect(
      fakeResponse(['data: {"a":1}\r\n', 'data: [DONE]\r\n', 'data: {"b":2}\r\n']),
    );
    expect(result).toEqual([{ a: 1 }]);
  });

  it('accepts data: lines with no space after the colon (finding T3-9)', async () => {
    // The SSE spec makes the space optional; some OpenAI-compatible servers omit it.
    const result = await collect(fakeResponse(['data:{"a":1}\n', 'data:{"b":2}\n']));
    expect(result).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('honors the [DONE] sentinel with no space after the colon (finding T3-9)', async () => {
    const result = await collect(
      fakeResponse(['data:{"a":1}\n', 'data:[DONE]\n', 'data:{"b":2}\n']),
    );
    expect(result).toEqual([{ a: 1 }]);
  });
});

// Regression for Tier 2 finding 1: previously the read loop had no idle-time bound
// once the stream started, so a provider that emits some bytes then goes silent
// mid-stream would hang the SSE connection forever — the time-to-headers timeout in
// `agenticLoop.ts` only bounds the wait for the initial `fetch()` response and can
// never fire again once it has resolved.
describe('parseSSE — idle-timeout on a stalled stream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws a clear timeout error and cancels the reader when the stream stalls mid-stream', async () => {
    const { response, cancel } = fakeStallingResponse('data: {"a":1}\n');

    const resultPromise = collect(response, { idleTimeoutMs: 5_000 });
    // Prevent an "unhandled rejection" warning before the assertion below observes it.
    resultPromise.catch(() => {});

    await vi.advanceTimersByTimeAsync(5_000);

    await expect(resultPromise).rejects.toThrow(/timed out after 5000ms/);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('does not time out when chunks keep arriving within the idle window', async () => {
    // Three chunks, each delivered synchronously (no artificial delay) — well within
    // a 5s idle window — followed by a normal close. Guards against a version of the
    // fix that races ALL reads against a single, non-resetting timer.
    const result = await collect(
      fakeResponse(['data: {"a":1}\n', 'data: {"b":2}\n', 'data: {"c":3}\n']),
      { idleTimeoutMs: 5_000 },
    );
    expect(result).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });
});

// Regression for Tier 3 finding 3: the reader must be cancelled/released on every
// exit path (normal completion, an early `break` by the caller, or an error thrown
// mid-read), not only on normal completion — otherwise an early-exited consumer (or
// a thrown idle-timeout error) leaves the underlying connection open indefinitely.
describe('parseSSE — reader cleanup on all exit paths', () => {
  it('cancels the reader on normal completion', async () => {
    const { response, cancel } = fakeResponseWithCancelSpy(['data: {"a":1}\n']);
    const result = await collect(response);
    expect(result).toEqual([{ a: 1 }]);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('cancels the reader when the caller stops consuming early (break)', async () => {
    const { response, cancel } = fakeResponseWithCancelSpy([
      'data: {"a":1}\n',
      'data: {"b":2}\n',
      'data: {"c":3}\n',
    ]);

    const out: Record<string, unknown>[] = [];
    for await (const chunk of parseSSE(response)) {
      out.push(chunk);
      break;
    }

    expect(out).toEqual([{ a: 1 }]);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('cancels the reader when the [DONE] sentinel causes an early return', async () => {
    const { response, cancel } = fakeResponseWithCancelSpy([
      'data: {"a":1}\n',
      'data: [DONE]\n',
      'data: {"b":2}\n',
    ]);
    const result = await collect(response);
    expect(result).toEqual([{ a: 1 }]);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('does not throw when the reader stub has no cancel method', async () => {
    // `fakeResponse` (used throughout this file) intentionally omits `cancel` to
    // model a minimal reader stub — cleanup must degrade gracefully rather than
    // throwing a secondary error that would mask whatever caused the exit.
    await expect(collect(fakeResponse(['data: {"a":1}\n']))).resolves.toEqual([{ a: 1 }]);
  });
});
