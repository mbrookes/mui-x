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

function makeStreamResponse(chunks: Uint8Array[]): Response {
  let index = 0;
  return {
    body: {
      getReader: () => ({
        read: () => {
          if (index < chunks.length) {
            const value = chunks[index];
            index += 1;
            return Promise.resolve({ done: false, value });
          }
          return Promise.resolve({ done: true, value: undefined });
        },
        cancel: () => Promise.resolve(),
        releaseLock: () => {},
      }),
    },
  } as unknown as Response;
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

  it('stops reading once onEvent returns false, even for the final flushed event', async () => {
    const encoder = new TextEncoder();
    const chunk = encoder.encode('data: {"type":"finish","finishReason":"stop"}');
    const response = makeStreamResponse([chunk]);

    const events: Record<string, unknown>[] = [];
    await parseSSEStream(response, (event) => {
      events.push(event);
      return false;
    });

    expect(events).toEqual([{ type: 'finish', finishReason: 'stop' }]);
  });
});
