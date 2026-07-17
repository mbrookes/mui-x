import { describe, expect, it } from 'vitest';
import { createDefaultStudioState } from '../../models/stateTypes';
import { serializeDashboardState } from './sseUtils';

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
