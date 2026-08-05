'use client';

import * as React from 'react';
import type { ChatMessage as ChatMessageType } from '@mui/x-chat/headless';
import { useChat } from '@mui/x-chat/headless';
import { useStudioSelector, selectAi } from '../../context';
import { useStudioLocaleText } from '../../internals/StudioUIConfigContext';
import type { StudioAIChatThread } from '../../models';
import type { StudioController } from '../../store/StudioController';
import { createThreadId } from './chatIds';

// ── Thread management ────────────────────────────────────────────────────────
//
// Owns all reads/writes of `state.ai` (threads + active thread) so
// `StudioChatPanel` doesn't need to know about the underlying `controller.setState`
// shape. Also owns the fix for a message write-back race: `ChatBox` calls
// `onMessagesChange` on every incoming stream chunk, and if the user switches
// threads (or creates a new one) while a response is still streaming, a naive
// implementation that reads the "current" active thread id from a closure would
// write the in-flight response into the *newly* active thread instead of the
// one the request actually belongs to.
//
// Fix: `handleMessagesChange` only reads the live active thread id while no
// response is streaming. Once a response starts streaming, writes are pinned
// to `writeTargetThreadIdRef`, which is captured once — at the moment
// `useChat().isStreaming` flips from `false` to `true` — via the `StreamThreadPin`
// component below (rendered as a child of `<ChatBox>`, the only place
// `useChat()` is reachable). Switching the active thread mid-stream updates
// `activeThreadIdRef` for future turns but cannot retroactively redirect the
// pinned, in-flight write target.

/** Max length of an auto-derived thread name before it is ellipsized. */
const MAX_DERIVED_THREAD_NAME_LENGTH = 48;

/**
 * Derives a human-readable conversation name from its first user message.
 *
 * Without this, every thread is created with the same `chatNewConversationName`
 * placeholder and nothing ever changes it except the model's optional
 * `rename_thread` tool — so the switcher menu (which renders `thread.name`
 * verbatim, ordered only by `updatedAt`) shows five rows all reading "New
 * conversation" and the user cannot tell them apart.
 *
 * Deriving from the first message rather than adding a rename dialog: it needs no
 * new UI surface, no new locale keys, and no new persisted field, and the first
 * question a user asks is what they actually remember a conversation by. An
 * explicit rename affordance is still worth adding, but it is a deliberate UX
 * addition rather than a fix for unusable naming.
 *
 * Returns `undefined` when there's nothing to derive from (no user message yet, or
 * only non-text parts), leaving the caller's placeholder in place.
 */
export function deriveThreadName(messages: ChatMessageType[]): string | undefined {
  const firstUserMessage = messages.find((message) => message.role === 'user');
  if (!firstUserMessage) {
    return undefined;
  }
  const text = firstUserMessage.parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join(' ')
    // Collapse newlines/runs of whitespace: the name renders on a single ellipsized
    // line, and a multi-line prompt would otherwise produce a name full of gaps.
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) {
    return undefined;
  }
  return text.length > MAX_DERIVED_THREAD_NAME_LENGTH
    ? `${text.slice(0, MAX_DERIVED_THREAD_NAME_LENGTH).trimEnd()}…`
    : text;
}

export interface UseChatThreadsResult {
  activeThreadId: string;
  activeThread: StudioAIChatThread | undefined;
  threadMessages: ChatMessageType[];
  sortedThreads: StudioAIChatThread[];
  activeThreadName: string;
  threadMenuAnchor: HTMLElement | null;
  setThreadMenuAnchor: React.Dispatch<React.SetStateAction<HTMLElement | null>>;
  handleMessagesChange: (messages: ChatMessageType[]) => void;
  handleNewThread: () => void;
  handleSelectThread: (threadId: string) => void;
  /**
   * Ref-backed props for `StreamThreadPin`. Render `<StreamThreadPin {...streamThreadPinProps} />`
   * as a child of `<ChatBox>` (inside its adapter/message context) so it can observe
   * `useChat().isStreaming` and pin the write target at the moment streaming starts.
   */
  streamThreadPinProps: StreamThreadPinProps;
}

export function useChatThreads(controller: StudioController): UseChatThreadsResult {
  const localeText = useStudioLocaleText();
  const aiState = useStudioSelector(selectAi);
  // Stable default thread id so the first thread is always available even
  // before any message has been sent (and hence before `state.ai` exists).
  const defaultThreadId = React.useRef(createThreadId());
  const activeThreadId = aiState?.activeThreadId ?? defaultThreadId.current;

  // Always-current mirror of `activeThreadId`, readable from refs/effects that
  // must not themselves trigger re-renders or depend on stale closures.
  const activeThreadIdRef = React.useRef(activeThreadId);
  activeThreadIdRef.current = activeThreadId;

  const activeThread = aiState?.threads.find((t) => t.id === activeThreadId);
  const threadMessages = activeThread?.messages ?? [];

  // See the module doc comment above for how these two refs cooperate.
  const isStreamingRef = React.useRef(false);
  const writeTargetThreadIdRef = React.useRef(activeThreadId);
  // Holds the current `useChat().stopStreaming` action, mirrored out of the ChatBox
  // context by `StreamThreadPin`, so the thread-switch handlers below (which live
  // outside that context) can abort an in-flight stream before switching.
  const stopStreamRef = React.useRef<(() => void) | null>(null);

  // Abort any in-flight stream that belongs to the thread we're leaving. On a thread
  // switch, ChatBox's controlled `messages` prop resyncs its internal store to the new
  // thread, after which the still-running stream's writes target an assistant message
  // id that no longer exists in the active thread — they silently no-op and the
  // remaining tokens are dropped with no error or warning, leaving the user with a
  // truncated response and no indication anything went wrong (and the underlying fetch
  // still running). Aborting first mirrors the explicit stop-streaming path (the same
  // `stopStreaming` action the stop button uses), so the partial response already
  // written to the previous thread is cleanly terminated and preserved instead of
  // silently truncated.
  const abortInFlightStream = React.useCallback(() => {
    if (isStreamingRef.current) {
      stopStreamRef.current?.();
    }
  }, []);

  const handleMessagesChange = React.useCallback(
    (messages: ChatMessageType[]) => {
      const targetThreadId = isStreamingRef.current
        ? writeTargetThreadIdRef.current
        : activeThreadIdRef.current;

      const state = controller.getState();
      const existingThreads = state.doc.ai?.threads ?? [];
      const now = new Date().toISOString();

      // Name the conversation after its first user message. Only ever overwrites the
      // untouched placeholder, so the model's `rename_thread` tool (and any name a
      // persisted doc already carries) always wins — this fills the gap where nothing
      // named the thread at all, it does not compete for the name.
      const derivedName = deriveThreadName(messages);

      const updatedThreads = existingThreads.some((t) => t.id === targetThreadId)
        ? existingThreads.map((t) =>
            t.id === targetThreadId
              ? {
                  ...t,
                  messages,
                  updatedAt: now,
                  name:
                    derivedName && t.name === localeText.chatNewConversationName
                      ? derivedName
                      : t.name,
                }
              : t,
          )
        : [
            ...existingThreads,
            {
              id: targetThreadId,
              name: derivedName ?? localeText.chatNewConversationName,
              createdAt: now,
              updatedAt: now,
              messages,
            },
          ];

      // Non-undoable: `onMessagesChange` fires on every streamed token delta
      // (~every 16ms). A `{ undoable: true }` write here would push a fresh undo
      // snapshot per delta — hundreds per response — flooding and evicting the
      // user's real document-editing undo history. Chat-thread state lives in `doc`
      // (it is persisted) but is not part of the authored-edit timeline.
      controller.setState(
        {
          ...state,
          doc: {
            ...state.doc,
            ai: {
              threads: updatedThreads,
              activeThreadId: state.doc.ai?.activeThreadId ?? targetThreadId,
            },
          },
        },
        { undoable: false },
      );
    },
    [controller, localeText.chatNewConversationName],
  );

  const [threadMenuAnchor, setThreadMenuAnchor] = React.useState<HTMLElement | null>(null);

  const handleNewThread = React.useCallback(() => {
    const state = controller.getState();
    const existingThreads = state.doc.ai?.threads ?? [];
    const currentActiveId = state.doc.ai?.activeThreadId ?? defaultThreadId.current;
    const currentActiveThread = existingThreads.find((t) => t.id === currentActiveId);
    // Finding #10: every "New conversation" click used to append a fresh thread with
    // no pruning, so repeated clicks (with nothing typed in between) bloated
    // `doc.ai.threads` indefinitely — each dead entry adds weight to every subsequent
    // `serializeState()` payload. If the CURRENTLY active thread has never had a
    // message sent — either it hasn't been materialized into `doc.ai.threads` yet, or
    // it exists with an empty `messages` array — it already IS a fresh, empty
    // conversation, so reuse it in place instead of minting a new one.
    if (!currentActiveThread || currentActiveThread.messages.length === 0) {
      return;
    }
    // Abort AFTER the reuse check, never before it. Aborting first meant the "the
    // current thread is already empty, reuse it" path killed an in-flight stream and
    // then returned without creating or switching anything — a click that visibly did
    // nothing except truncate the response the user was reading.
    abortInFlightStream();
    const newId = createThreadId();
    const now = new Date().toISOString();
    // Re-read after the abort: terminating the stream flushes a final
    // `onMessagesChange` write-back into `doc.ai`, so the pre-abort snapshot above is
    // stale by now and committing it would drop that last partial response.
    const stateAfterAbort = controller.getState();
    const threadsAfterAbort = stateAfterAbort.doc.ai?.threads ?? existingThreads;
    // Non-undoable: creating/switching chat threads is not an authored dashboard
    // edit and must not consume the user's undo history (see handleMessagesChange).
    controller.setState(
      {
        ...stateAfterAbort,
        doc: {
          ...stateAfterAbort.doc,
          ai: {
            threads: [
              ...threadsAfterAbort,
              { id: newId, name: localeText.chatNewConversationName, createdAt: now, messages: [] },
            ],
            activeThreadId: newId,
          },
        },
      },
      { undoable: false },
    );
    // Update the stable ref so the next message goes to the new thread.
    defaultThreadId.current = newId;
  }, [controller, localeText.chatNewConversationName, abortInFlightStream]);

  const handleSelectThread = React.useCallback(
    (threadId: string) => {
      abortInFlightStream();
      const state = controller.getState();
      // Non-undoable: switching the active chat thread is not an authored edit.
      controller.setState(
        {
          ...state,
          doc: {
            ...state.doc,
            ai: { ...(state.doc.ai ?? { threads: [] }), activeThreadId: threadId },
          },
        },
        { undoable: false },
      );
      defaultThreadId.current = threadId;
      setThreadMenuAnchor(null);
    },
    [controller, abortInFlightStream],
  );

  const sortedThreads = React.useMemo(
    () =>
      (aiState?.threads ?? []).toSorted((a, b) => {
        // Defense-in-depth (the schema-side `repairThreadLeafShapes` load-boundary repair also
        // coerces these): coerce to string here too so an untrusted / hand-edited persisted doc
        // that slips a non-string (or entirely missing) `updatedAt`/`createdAt` past the loader
        // can never throw a `TypeError` on `.localeCompare` and take down the whole chat panel on
        // mount. The comparator only runs with 2+ threads, so a single bad thread never surfaces it.
        const aTime = String(a.updatedAt ?? a.createdAt ?? '');
        const bTime = String(b.updatedAt ?? b.createdAt ?? '');
        return bTime.localeCompare(aTime);
      }),
    [aiState?.threads],
  );

  const activeThreadName = activeThread?.name ?? localeText.chatNewConversationName;

  return {
    activeThreadId,
    activeThread,
    threadMessages,
    sortedThreads,
    activeThreadName,
    threadMenuAnchor,
    setThreadMenuAnchor,
    handleMessagesChange,
    handleNewThread,
    handleSelectThread,
    streamThreadPinProps: {
      activeThreadIdRef,
      writeTargetThreadIdRef,
      isStreamingRef,
      stopStreamRef,
    },
  };
}

// ── StreamThreadPin ───────────────────────────────────────────────────────────

interface StreamThreadPinProps {
  activeThreadIdRef: React.RefObject<string>;
  writeTargetThreadIdRef: React.RefObject<string>;
  isStreamingRef: React.RefObject<boolean>;
  stopStreamRef: React.RefObject<(() => void) | null>;
}

/**
 * Invisible component rendered inside `<ChatBox>` (inside its `useChat` context).
 * Watches `isStreaming` and, on the rising edge (streaming just started), pins
 * `writeTargetThreadIdRef` to whichever thread is active right now — the thread
 * this response's messages must be written back to, regardless of any thread
 * switch that happens before the response finishes.
 *
 * Also mirrors `useChat().stopStreaming` out to `stopStreamRef` so the thread-switch
 * handlers (which live outside the `useChat` context) can abort an in-flight stream
 * before switching threads.
 */
export function StreamThreadPin({
  activeThreadIdRef,
  writeTargetThreadIdRef,
  isStreamingRef,
  stopStreamRef,
}: StreamThreadPinProps) {
  const { isStreaming, stopStreaming } = useChat();
  const wasStreamingRef = React.useRef(false);

  // Keep the exposed stop-streaming action current (latest-ref pattern). Assigning a
  // ref during render is side-effect-free and is the same pattern `useChatThreads`
  // uses for `activeThreadIdRef`.
  stopStreamRef.current = stopStreaming;

  React.useEffect(() => {
    if (isStreaming && !wasStreamingRef.current) {
      writeTargetThreadIdRef.current = activeThreadIdRef.current;
    }
    isStreamingRef.current = isStreaming;
    wasStreamingRef.current = isStreaming;
  }, [isStreaming, activeThreadIdRef, writeTargetThreadIdRef, isStreamingRef]);

  return null;
}
