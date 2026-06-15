/**
 * Unit tests for `parseSSE`.
 *
 * The parser turns an OpenAI-compatible byte stream into parsed JSON objects.
 * Its tricky paths — payloads split across `reader.read()` chunks, the `[DONE]`
 * sentinel, malformed-line skipping and a missing body — were previously
 * untested.
 */
import { describe, it, expect } from 'vitest';
import { parseSSE } from './parseSSE';

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

async function collect(response: Response): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for await (const chunk of parseSSE(response)) {
    out.push(chunk);
  }
  return out;
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

  it('does not emit a trailing data: line that lacks a newline terminator', async () => {
    // The final line stays in the buffer because it is never newline-terminated.
    const result = await collect(fakeResponse(['data: {"a":1}\n', 'data: {"b":2}']));
    expect(result).toEqual([{ a: 1 }]);
  });
});
