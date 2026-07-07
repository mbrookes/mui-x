/**
 * Tests for `useChatThreads` — thread create/switch/persistence, and the
 * message write-back race fix (a mid-stream thread switch must not redirect
 * an in-flight response's messages into the newly-active thread).
 *
 * `useStudioSelector` is mocked via the shared `studioContextMock` (required
 * because this repo runs vitest with `isolate: false` — see that module's
 * doc comment for why a per-file `vi.mock` factory isn't safe here).
 * `useStudioController` is not mocked: `useChatThreads` takes the controller
 * as a plain argument, it doesn't read it from context.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@mui/internal-test-utils';
import type { ChatMessage } from '@mui/x-chat/headless';
import { createDefaultStudioState } from '../../models/stateTypes';
import type { StudioState } from '../../models';
import type { StudioController } from '../../store/StudioController';
import { mockUseStudioSelector, configureStudioContextMock } from '../../../test/studioContextMock';
// `useChatThreads` (and its `createThreadId`/`createMessageId` re-exports via `./chatIds`)
// transitively imports `../../context`, which the `vi.mock` below replaces — this import
// MUST come after the `studioContextMock` import above, otherwise `mockUseStudioSelector`
// is referenced (inside the hoisted `vi.mock` factory) before its binding is initialized.
import { useChatThreads } from './useChatThreads';
import { createThreadId, createMessageId } from './chatIds';

vi.mock('../../context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../context')>()),
  useStudioSelector: mockUseStudioSelector,
}));

// ── Fake controller ──────────────────────────────────────────────────────────

let mockState: StudioState;

function makeController(): StudioController {
  return {
    getState: vi.fn(() => mockState),
    setState: vi.fn((next: StudioState) => {
      mockState = next;
    }),
  } as unknown as StudioController;
}

function makeMessage(text: string): ChatMessage {
  return { id: createMessageId(), role: 'user', parts: [{ type: 'text', text }] };
}

beforeEach(() => {
  mockState = createDefaultStudioState();
  configureStudioContextMock({ getState: () => mockState });
});

// ── create / switch / persistence ────────────────────────────────────────────

describe('useChatThreads: thread create/switch/persistence', () => {
  it('writes the first message to a default thread before any thread exists', () => {
    const controller = makeController();
    const { result } = renderHook(() => useChatThreads(controller));

    act(() => {
      result.current.handleMessagesChange([makeMessage('hello')]);
    });

    expect(mockState.doc.ai?.threads).toHaveLength(1);
    expect(mockState.doc.ai?.threads[0].messages).toHaveLength(1);
    expect(mockState.doc.ai?.activeThreadId).toBe(mockState.doc.ai?.threads[0].id);
  });

  it('creates a new thread and makes it active', () => {
    const controller = makeController();
    const { result } = renderHook(() => useChatThreads(controller));

    act(() => {
      result.current.handleMessagesChange([makeMessage('first thread message')]);
    });
    const firstThreadId = mockState.doc.ai?.activeThreadId;

    act(() => {
      result.current.handleNewThread();
    });

    expect(mockState.doc.ai?.threads).toHaveLength(2);
    expect(mockState.doc.ai?.activeThreadId).not.toBe(firstThreadId);
    expect(
      mockState.doc.ai?.threads.find((t) => t.id === mockState.doc.ai?.activeThreadId)?.messages,
    ).toEqual([]);
  });

  it("switches the active thread without touching either thread's messages", () => {
    const controller = makeController();
    const { result, rerender } = renderHook(() => useChatThreads(controller));

    act(() => {
      result.current.handleMessagesChange([makeMessage('in thread A')]);
    });
    const threadAId = mockState.doc.ai!.activeThreadId!;

    act(() => {
      result.current.handleNewThread();
    });
    rerender();
    const threadBId = mockState.doc.ai!.activeThreadId!;
    expect(threadBId).not.toBe(threadAId);

    act(() => {
      result.current.handleSelectThread(threadAId);
    });

    expect(mockState.doc.ai?.activeThreadId).toBe(threadAId);
    expect(mockState.doc.ai?.threads.find((t) => t.id === threadAId)?.messages).toHaveLength(1);
    expect(mockState.doc.ai?.threads.find((t) => t.id === threadBId)?.messages).toEqual([]);
  });

  it('persists messages onto the correct thread across multiple writes', () => {
    const controller = makeController();
    const { result } = renderHook(() => useChatThreads(controller));

    act(() => {
      result.current.handleMessagesChange([makeMessage('one')]);
    });
    act(() => {
      result.current.handleMessagesChange([makeMessage('one'), makeMessage('two')]);
    });

    expect(mockState.doc.ai?.threads).toHaveLength(1);
    expect(mockState.doc.ai?.threads[0].messages).toHaveLength(2);
  });
});

// ── message write-back race fix ──────────────────────────────────────────────

describe('useChatThreads: mid-stream thread-switch race', () => {
  it('keeps writing an in-flight response to the thread it started on, even after switching threads', () => {
    const controller = makeController();
    const { result, rerender } = renderHook(() => useChatThreads(controller));

    // Start thread A and send the user's message (not streaming yet).
    act(() => {
      result.current.handleMessagesChange([makeMessage('question on A')]);
    });
    const threadAId = mockState.doc.ai!.activeThreadId!;

    // Simulate `StreamThreadPin`'s rising-edge effect: a response begins
    // streaming while thread A is active, so the write target is pinned to A.
    act(() => {
      result.current.streamThreadPinProps.isStreamingRef.current = true;
      result.current.streamThreadPinProps.writeTargetThreadIdRef.current = threadAId;
    });

    // User creates + switches to a new thread B while A's response is still streaming.
    act(() => {
      result.current.handleNewThread();
    });
    rerender();
    const threadBId = mockState.doc.ai!.activeThreadId!;
    expect(threadBId).not.toBe(threadAId);

    // More chunks of A's in-flight response arrive. Because `isStreamingRef` is
    // still true and `writeTargetThreadIdRef` is still pinned to A, this must
    // land on A — not on the newly-active thread B.
    act(() => {
      result.current.handleMessagesChange([
        makeMessage('question on A'),
        makeMessage('assistant reply for A'),
      ]);
    });

    const threadA = mockState.doc.ai?.threads.find((t) => t.id === threadAId);
    const threadB = mockState.doc.ai?.threads.find((t) => t.id === threadBId);
    expect(threadA?.messages).toHaveLength(2);
    expect(threadB?.messages).toEqual([]);

    // Once the stream finishes, the pin releases and writes follow the live active thread again.
    act(() => {
      result.current.streamThreadPinProps.isStreamingRef.current = false;
    });
    act(() => {
      result.current.handleMessagesChange([makeMessage('question on B')]);
    });
    const threadBAfter = mockState.doc.ai?.threads.find((t) => t.id === threadBId);
    expect(threadBAfter?.messages).toHaveLength(1);
  });
});

// ── id collisions ─────────────────────────────────────────────────────────────

describe('chatIds: collision resistance', () => {
  it('never returns the same thread id twice, even created back to back', () => {
    const ids = Array.from({ length: 50 }, () => createThreadId());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never returns the same message id twice, even created back to back', () => {
    const ids = Array.from({ length: 50 }, () => createMessageId());
    expect(new Set(ids).size).toBe(ids.length);
  });
});
