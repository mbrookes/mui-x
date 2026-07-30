import { describe, expect, it, vi } from 'vitest';
import { createDefaultStudioState } from '../../models/stateTypes';
import { serializeDashboardState, parseSSEStream } from './sseUtils';

// ── serializeDashboardState: doc.ai trimming ─────────────────────────────────
//
// `doc.ai` persists the FULL transcript of every chat thread, not just the
// active one. The server-side handler only ever reads `activeThreadId` off
// this value (the live conversation travels separately as the request's
// `messages` array), so shipping the whole `threads` array on every
// chat/widget request is unbounded and unnecessary. `serializeDashboardState`
// must trim this down to `activeThreadId` only, without mutating what's
// stored in `doc.ai` client-side.

describe('serializeDashboardState', () => {
  it('keeps activeThreadId but drops the full thread transcript array', () => {
    const state = createDefaultStudioState({
      doc: {
        ai: {
          activeThreadId: 'thread-2',
          threads: [
            {
              id: 'thread-1',
              name: 'Old conversation',
              createdAt: '2026-01-01T00:00:00.000Z',
              messages: [
                { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
                { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'hi there' }] },
              ] as any,
            },
            {
              id: 'thread-2',
              name: 'Active conversation',
              createdAt: '2026-01-02T00:00:00.000Z',
              messages: [
                { id: 'm3', role: 'user', parts: [{ type: 'text', text: 'question' }] },
              ] as any,
            },
          ],
        },
      },
    });

    const serialized = serializeDashboardState(state);

    expect(serialized.doc.ai?.activeThreadId).toBe('thread-2');
    expect(serialized.doc.ai?.threads).toEqual([]);
    // Belt-and-braces: no message text from any thread survives serialization.
    expect(JSON.stringify(serialized)).not.toContain('hello');
    expect(JSON.stringify(serialized)).not.toContain('question');
  });

  it('leaves doc.ai undefined when the source state has no AI state', () => {
    const state = createDefaultStudioState();

    const serialized = serializeDashboardState(state);

    expect(serialized.doc.ai).toBeUndefined();
  });

  it('does not mutate the original state.doc.ai', () => {
    const state = createDefaultStudioState({
      doc: {
        ai: {
          activeThreadId: 'thread-1',
          threads: [
            {
              id: 'thread-1',
              name: 'Conversation',
              createdAt: '2026-01-01T00:00:00.000Z',
              messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] as any,
            },
          ],
        },
      },
    });

    serializeDashboardState(state);

    expect(state.doc.ai?.threads).toHaveLength(1);
    expect(state.doc.ai?.threads[0].messages).toHaveLength(1);
  });

  it('still strips non-serializable dataSources rows/adapter', () => {
    const state = createDefaultStudioState({
      runtime: {
        dataSources: {
          src1: {
            id: 'src1',
            label: 'Sales',
            fields: [],
            rows: [{ id: 1 }],
            adapter: {} as any,
          } as any,
        },
      },
    });

    const serialized = serializeDashboardState(state);

    expect(serialized.runtime.dataSources.src1).not.toHaveProperty('rows');
    expect(serialized.runtime.dataSources.src1).not.toHaveProperty('adapter');
  });
});

// ── parseSSEStream: trailing event / decoder flush (regression: 2.4) ────────
//
// On `done`, any complete `data: {...}` line still sitting in the internal buffer
// (not yet newline-terminated) must be processed instead of discarded — the stream
// can end right after a final event with no trailing blank line — and the decoder
// must be flushed so a trailing multi-byte sequence isn't silently dropped.

interface StreamProbe {
  response: Response;
  /** How many `read()` calls the parser made. */
  readCount: () => number;
  cancelSpy: ReturnType<typeof vi.fn>;
}

function makeStreamProbe(chunks: Uint8Array[]): StreamProbe {
  let index = 0;
  let reads = 0;
  const cancelSpy = vi.fn(() => Promise.resolve());
  const response = {
    body: {
      getReader: () => ({
        read: () => {
          reads += 1;
          if (index < chunks.length) {
            const value = chunks[index];
            index += 1;
            return Promise.resolve({ done: false, value });
          }
          return Promise.resolve({ done: true, value: undefined });
        },
        cancel: cancelSpy,
        releaseLock: () => {},
      }),
    },
  } as unknown as Response;
  return { response, readCount: () => reads, cancelSpy };
}

function makeStreamResponse(chunks: Uint8Array[]): Response {
  return makeStreamProbe(chunks).response;
}

describe('parseSSEStream', () => {
  it('processes a final data line with no trailing newline instead of discarding it', async () => {
    // No trailing "\n\n" after the last event — the stream just ends right after it,
    // which is exactly what a server closing the connection right after the final
    // chunk looks like.
    const encoder = new TextEncoder();
    const chunk = encoder.encode('data: {"type":"finish","finishReason":"stop"}');
    const response = makeStreamResponse([chunk]);

    const events: Record<string, unknown>[] = [];
    await parseSSEStream(response, (event) => {
      events.push(event);
    });

    expect(events).toEqual([{ type: 'finish', finishReason: 'stop' }]);
  });

  it('processes a final unterminated state-mutation event instead of losing the edit', async () => {
    const encoder = new TextEncoder();
    const chunk = encoder.encode(
      'data: {"type":"state-mutation","mutation":{"type":"setDashboardTitle","args":{"title":"New"}}}',
    );
    const response = makeStreamResponse([chunk]);

    const events: Record<string, unknown>[] = [];
    await parseSSEStream(response, (event) => {
      events.push(event);
    });

    expect(events).toEqual([
      {
        type: 'state-mutation',
        mutation: { type: 'setDashboardTitle', args: { title: 'New' } },
      },
    ]);
  });

  it('still processes normally newline-terminated events unaffected by the done-flush path', async () => {
    const encoder = new TextEncoder();
    const chunk = encoder.encode(
      'data: {"type":"text-delta","delta":"Hi"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n',
    );
    const response = makeStreamResponse([chunk]);

    const events: Record<string, unknown>[] = [];
    await parseSSEStream(response, (event) => {
      events.push(event);
    });

    expect(events).toEqual([
      { type: 'text-delta', delta: 'Hi' },
      { type: 'finish', finishReason: 'stop' },
    ]);
  });

  it('flushes the TextDecoder (calls decode() with no arguments) when the stream ends', async () => {
    const decodeSpy = vi.spyOn(TextDecoder.prototype, 'decode');
    const encoder = new TextEncoder();
    const chunk = encoder.encode('data: {"type":"finish","finishReason":"stop"}\n\n');
    const response = makeStreamResponse([chunk]);

    await parseSSEStream(response, () => {});

    // The final decode() call (the flush) is made with no arguments so any bytes the
    // decoder is holding internally for a trailing multi-byte sequence are recovered
    // instead of silently dropped.
    const flushCalls = decodeSpy.mock.calls.filter((args) => args.length === 0);
    expect(flushCalls.length).toBeGreaterThanOrEqual(1);

    decodeSpy.mockRestore();
  });

  it('does not throw when the trailing unterminated buffer is not valid JSON', async () => {
    const encoder = new TextEncoder();
    const chunk = encoder.encode('data: {not valid json');
    const response = makeStreamResponse([chunk]);

    const events: Record<string, unknown>[] = [];
    await expect(
      parseSSEStream(response, (event) => {
        events.push(event);
      }),
    ).resolves.toBeUndefined();
    expect(events).toEqual([]);
  });

  // The previous version of this test fed a single chunk that the stream ended right
  // after, so "stopped early" and "ran to completion" were indistinguishable — and the
  // `done` branch discards `processLine`'s return value anyway, so returning `false`
  // there changes nothing. Feeding events the parser would otherwise keep consuming is
  // what makes the early stop observable.
  it('stops reading, and cancels the reader, once onEvent returns false', async () => {
    const encoder = new TextEncoder();
    const probe = makeStreamProbe([
      encoder.encode('data: {"type":"finish","finishReason":"stop"}\n\n'),
      encoder.encode('data: {"type":"text-delta","delta":"never read"}\n\n'),
    ]);

    const events: Record<string, unknown>[] = [];
    await parseSSEStream(probe.response, (event) => {
      events.push(event);
      return false;
    });

    // Only the terminal event was delivered — the second chunk was never pulled.
    expect(events).toEqual([{ type: 'finish', finishReason: 'stop' }]);
    expect(probe.readCount()).toBe(1);
    // The socket is released immediately rather than left open until `.stop()`.
    expect(probe.cancelSpy).toHaveBeenCalled();
  });

  it('keeps reading while onEvent returns undefined', async () => {
    // Control for the test above: with no `false` return, every chunk IS consumed —
    // so the assertions above are pinning the early stop, not the mock's shape.
    const encoder = new TextEncoder();
    const probe = makeStreamProbe([
      encoder.encode('data: {"type":"text-delta","delta":"a"}\n\n'),
      encoder.encode('data: {"type":"text-delta","delta":"b"}\n\n'),
    ]);

    const events: Record<string, unknown>[] = [];
    await parseSSEStream(probe.response, (event) => {
      events.push(event);
    });

    expect(events).toHaveLength(2);
    expect(probe.readCount()).toBe(3); // two chunks + the `done` read
    expect(probe.cancelSpy).not.toHaveBeenCalled();
  });
});

// ── parseSSEStream: un-newlined buffer cap ───────────────────────────────────
//
// The cap exists to stop a hostile/broken proxy streaming bytes with NO newline from
// growing the buffer without bound. It must be measured against the RESIDUAL partial
// line, not the whole pre-split buffer: a single read can legitimately carry more than
// the cap in properly delimited events (a large `state-mutation` behind a proxy that
// flushes late), and aborting that stream as "malformed" is a false positive that
// silently loses a dashboard edit.

describe('parseSSEStream buffer cap', () => {
  const CAP = 8 * 1024 * 1024;

  it('aborts a stream whose un-newlined residue exceeds the cap', async () => {
    const encoder = new TextEncoder();
    const probe = makeStreamProbe([encoder.encode(`data: ${'x'.repeat(CAP + 1)}`)]);

    await expect(parseSSEStream(probe.response, () => {})).rejects.toThrow(
      /exceeded the \d+-byte buffer limit/,
    );
    // The connection is released rather than left accumulating.
    expect(probe.cancelSpy).toHaveBeenCalled();
  });

  it('does not abort a large but properly newline-delimited read', async () => {
    // One read carrying well over the cap, every byte of it newline-terminated.
    const encoder = new TextEncoder();
    const bigPayload = 'y'.repeat(Math.ceil(CAP / 4));
    const line = `data: {"type":"text-delta","delta":"${bigPayload}"}\n\n`;
    const probe = makeStreamProbe([encoder.encode(line.repeat(5))]);

    const events: Record<string, unknown>[] = [];
    await expect(
      parseSSEStream(probe.response, (event) => {
        events.push(event);
      }),
    ).resolves.toBeUndefined();

    expect(events).toHaveLength(5);
    expect(probe.cancelSpy).not.toHaveBeenCalled();
  });
});

// AGENTS.md: an error must say what happened, why it is a problem, and how to fix it,
// behind a `MUI X`/`MUI X <Package>` prefix. The buffer-cap throw 70 lines below already
// did all three; this one said only `No response body.`
describe('parseSSEStream: missing body', () => {
  it('throws a prefixed, actionable error when the response carries no body', async () => {
    await expect(parseSSEStream({ body: null } as unknown as Response, () => {})).rejects.toThrow(
      /^MUI X Studio: /,
    );
  });
});
