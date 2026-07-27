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
import { StudioController } from '../../store/StudioController';
import { mockUseStudioSelector, configureStudioContextMock } from '../../../test/studioContextMock';
// `useChatThreads` (and its `createThreadId`/`createMessageId` re-exports via `./chatIds`)
// transitively imports `../../context`, which the `vi.mock` below replaces — this import
// MUST come after the `studioContextMock` import above, otherwise `mockUseStudioSelector`
// is referenced (inside the hoisted `vi.mock` factory) before its binding is initialized.
import { useChatThreads, deriveThreadName } from './useChatThreads';
import { createThreadId, createMessageId, nextAutoSubmitSeq } from './chatIds';

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

  // Regression coverage for architecture-review finding #10: every "New conversation"
  // click used to append a fresh thread with no pruning, so repeated clicks bloated
  // `doc.ai.threads` (and every subsequent `serializeState()` payload) indefinitely.
  it('does not grow doc.ai.threads when creating a new thread while no message has ever been sent', () => {
    const controller = makeController();
    const { result } = renderHook(() => useChatThreads(controller));

    act(() => {
      result.current.handleNewThread();
    });

    // No thread has ever been materialized (no message sent yet) — the click is a no-op.
    expect(mockState.doc.ai?.threads ?? []).toHaveLength(0);
  });

  it('does not grow doc.ai.threads when the currently active thread is already empty', () => {
    const controller = makeController();
    const { result, rerender } = renderHook(() => useChatThreads(controller));

    // Thread A gets a message, then the user opens a fresh (empty) thread B.
    act(() => {
      result.current.handleMessagesChange([makeMessage('in thread A')]);
    });
    act(() => {
      result.current.handleNewThread();
    });
    rerender();
    expect(mockState.doc.ai?.threads).toHaveLength(2);
    const threadBId = mockState.doc.ai!.activeThreadId!;

    // Clicking "New conversation" again while B is still empty must reuse B in place,
    // not mint a third thread.
    act(() => {
      result.current.handleNewThread();
    });
    rerender();

    expect(mockState.doc.ai?.threads).toHaveLength(2);
    expect(mockState.doc.ai?.activeThreadId).toBe(threadBId);
  });

  // The abort used to run BEFORE the "current thread is already empty, reuse it"
  // early return, so a "New conversation" click on an already-empty thread killed
  // the in-flight response and then returned without creating or switching anything
  // — a click that visibly did nothing except truncate what the user was reading.
  it('does not abort an in-flight stream when the click is a no-op reuse', () => {
    const controller = makeController();
    const { result, rerender } = renderHook(() => useChatThreads(controller));
    const stopStreaming = vi.fn();

    act(() => {
      result.current.handleMessagesChange([makeMessage('in thread A')]);
    });
    act(() => {
      result.current.handleNewThread(); // thread B, empty + active
    });
    rerender();
    const threadBId = mockState.doc.ai!.activeThreadId!;

    // A response is streaming (into A, per the write-target pin).
    act(() => {
      result.current.streamThreadPinProps.isStreamingRef.current = true;
      result.current.streamThreadPinProps.stopStreamRef.current = stopStreaming;
    });

    act(() => {
      result.current.handleNewThread(); // B is empty → reuse, nothing to do
    });
    rerender();

    expect(stopStreaming).not.toHaveBeenCalled();
    expect(mockState.doc.ai?.activeThreadId).to.equal(threadBId);
    expect(mockState.doc.ai?.threads).toHaveLength(2);
  });

  it('still aborts an in-flight stream when a new thread is actually created', () => {
    const controller = makeController();
    const { result } = renderHook(() => useChatThreads(controller));
    const stopStreaming = vi.fn();

    act(() => {
      result.current.handleMessagesChange([makeMessage('in thread A')]);
    });
    act(() => {
      result.current.streamThreadPinProps.isStreamingRef.current = true;
      result.current.streamThreadPinProps.stopStreamRef.current = stopStreaming;
    });

    act(() => {
      result.current.handleNewThread(); // A is non-empty → really creates B
    });

    expect(stopStreaming).toHaveBeenCalledTimes(1);
    expect(mockState.doc.ai?.threads).toHaveLength(2);
  });

  it('does not drop the final write-back flushed by aborting the stream', () => {
    // Stopping the stream flushes one last `onMessagesChange` into `doc.ai`, so the
    // pre-abort state snapshot is stale by the time the new thread is committed.
    const controller = makeController();
    const { result } = renderHook(() => useChatThreads(controller));

    act(() => {
      result.current.handleMessagesChange([makeMessage('question on A')]);
    });
    const threadAId = mockState.doc.ai!.activeThreadId!;

    act(() => {
      result.current.streamThreadPinProps.isStreamingRef.current = true;
      result.current.streamThreadPinProps.writeTargetThreadIdRef.current = threadAId;
      result.current.streamThreadPinProps.stopStreamRef.current = () => {
        result.current.handleMessagesChange([
          makeMessage('question on A'),
          makeMessage('final partial answer'),
        ]);
      };
    });

    act(() => {
      result.current.handleNewThread();
    });

    expect(mockState.doc.ai?.threads.find((t) => t.id === threadAId)?.messages).toHaveLength(2);
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

// ── thread naming ─────────────────────────────────────────────────────────────
//
// Every thread used to be created with the same `chatNewConversationName`
// placeholder and nothing ever changed it except the model's optional
// `rename_thread` tool, so the switcher menu showed N rows all reading "New
// conversation" with no way to tell them apart.

describe('deriveThreadName', () => {
  it('uses the first user message', () => {
    expect(deriveThreadName([makeMessage('Why did revenue drop in Q3?')])).to.equal(
      'Why did revenue drop in Q3?',
    );
  });

  it('skips assistant messages and reads the first USER turn', () => {
    const messages: ChatMessage[] = [
      { id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'Hi, how can I help?' }] },
      makeMessage('Break down sales by region'),
    ];
    expect(deriveThreadName(messages)).to.equal('Break down sales by region');
  });

  it('collapses whitespace and truncates a long prompt', () => {
    const name = deriveThreadName([
      makeMessage(
        `Compare\n  this quarter's revenue against the same quarter last year, by region`,
      ),
    ]);
    expect(name).to.have.length.lessThan(52);
    expect(name!.endsWith('…')).to.equal(true);
    expect(name!.startsWith('Compare this')).to.equal(true);
  });

  it('returns undefined when there is nothing to derive from', () => {
    expect(deriveThreadName([])).to.equal(undefined);
    expect(deriveThreadName([{ id: 'x', role: 'user', parts: [] }])).to.equal(undefined);
    expect(deriveThreadName([makeMessage('   ')])).to.equal(undefined);
  });
});

describe('useChatThreads: thread naming', () => {
  it('names a newly created thread after its first user message', () => {
    const controller = makeController();
    const { result } = renderHook(() => useChatThreads(controller));

    act(() => {
      result.current.handleMessagesChange([makeMessage('Why did revenue drop in Q3?')]);
    });

    expect(mockState.doc.ai?.threads[0].name).to.equal('Why did revenue drop in Q3?');
  });

  it('backfills the placeholder name of an existing thread on its first user message', () => {
    const controller = makeController();
    const { result, rerender } = renderHook(() => useChatThreads(controller));

    // Thread A gets a message, thread B is created empty (name = placeholder).
    act(() => {
      result.current.handleMessagesChange([makeMessage('first')]);
    });
    act(() => {
      result.current.handleNewThread();
    });
    rerender();
    const threadBId = mockState.doc.ai!.activeThreadId!;
    expect(mockState.doc.ai?.threads.find((t) => t.id === threadBId)?.name).to.equal(
      'New conversation',
    );

    act(() => {
      result.current.handleMessagesChange([makeMessage('Show me churn by cohort')]);
    });

    expect(mockState.doc.ai?.threads.find((t) => t.id === threadBId)?.name).to.equal(
      'Show me churn by cohort',
    );
  });

  it('never overwrites a name that is not the untouched placeholder', () => {
    // e.g. the model's `rename_thread` tool, or a name loaded from a persisted doc.
    const controller = makeController();
    const { result } = renderHook(() => useChatThreads(controller));

    act(() => {
      result.current.handleMessagesChange([makeMessage('first question')]);
    });
    const threadId = mockState.doc.ai!.activeThreadId!;
    mockState = {
      ...mockState,
      doc: {
        ...mockState.doc,
        ai: {
          ...mockState.doc.ai!,
          threads: mockState.doc.ai!.threads.map((t) => ({ ...t, name: 'Q3 planning' })),
        },
      },
    };

    act(() => {
      result.current.handleMessagesChange([makeMessage('first question'), makeMessage('another')]);
    });

    expect(mockState.doc.ai?.threads.find((t) => t.id === threadId)?.name).to.equal('Q3 planning');
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

// ── undo-history pollution (finding 1.8) ──────────────────────────────────────

describe('useChatThreads: streaming writes never pollute undo history', () => {
  it('does not push undo entries while chat messages stream in', () => {
    // A REAL controller (not the fake above) so the undo stack is exercised for real.
    const controller = new StudioController();
    configureStudioContextMock({ getState: () => controller.getState() });

    const originalTitle = controller.getState().doc.dashboard.title;

    // One genuine, undoable document edit the user made before chatting.
    controller.setDashboardTitle('My dashboard');
    expect(controller.canUndo()).toBe(true);

    const { result } = renderHook(() => useChatThreads(controller));

    // Simulate a multi-second AI response: `onMessagesChange` fires on every
    // streamed token delta (~every 16ms → hundreds of times per response).
    act(() => {
      for (let i = 1; i <= 200; i += 1) {
        result.current.handleMessagesChange([makeMessage(`partial reply ${i}`)]);
      }
    });

    // The streamed messages were persisted to the thread...
    expect(controller.getState().doc.ai?.threads[0].messages).toHaveLength(1);

    // ...but NONE of those 200 writes entered the undo timeline. If any had, the
    // undo stack would hold chat snapshots on top of the real edit, and a single
    // undo would land on a stale chat snapshot instead of reverting the title.
    // Proof the stack length is unchanged (still exactly the one real edit): one
    // undo reaches the title edit, and nothing remains undoable afterwards.
    controller.undo();
    expect(controller.getState().doc.dashboard.title).toBe(originalTitle);
    expect(controller.canUndo()).toBe(false);
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

  // `nextAutoSubmitSeq` backs the auto-submit queue's `seq`/`id` values (StudioChatPanel's
  // `initialPrompt` auto-submit and StudioContent's `pendingInsight.id`, forwarded as
  // `pendingMessage.id`) — replacing a former `Date.now()` at both sites, whose millisecond
  // resolution let two same-millisecond auto-submit-eligible events collide on `seq` and have
  // one silently dropped by the queue's dedup (finding 13). A monotonic counter guarantees
  // distinctness regardless of timing, even when `Date.now()` itself is frozen.
  it('never returns the same auto-submit seq twice, even when Date.now() is frozen (finding 13)', () => {
    const originalNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const seqs = Array.from({ length: 50 }, () => nextAutoSubmitSeq());
      expect(new Set(seqs).size).toBe(seqs.length);
    } finally {
      Date.now = originalNow;
    }
  });

  it('returns strictly increasing auto-submit seqs', () => {
    const first = nextAutoSubmitSeq();
    const second = nextAutoSubmitSeq();
    expect(second).toBeGreaterThan(first);
  });
});
