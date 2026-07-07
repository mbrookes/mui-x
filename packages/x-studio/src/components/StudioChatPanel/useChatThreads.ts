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

  const handleMessagesChange = React.useCallback(
    (messages: ChatMessageType[]) => {
      const targetThreadId = isStreamingRef.current
        ? writeTargetThreadIdRef.current
        : activeThreadIdRef.current;

      const state = controller.getState();
      const existingThreads = state.doc.ai?.threads ?? [];
      const now = new Date().toISOString();

      const updatedThreads = existingThreads.some((t) => t.id === targetThreadId)
        ? existingThreads.map((t) =>
            t.id === targetThreadId ? { ...t, messages, updatedAt: now } : t,
          )
        : [
            ...existingThreads,
            {
              id: targetThreadId,
              name: localeText.chatNewConversationName,
              createdAt: now,
              updatedAt: now,
              messages,
            },
          ];

      controller.setState({
        ...state,
        doc: {
          ...state.doc,
          ai: {
            threads: updatedThreads,
            activeThreadId: state.doc.ai?.activeThreadId ?? targetThreadId,
          },
        },
      });
    },
    [controller, localeText.chatNewConversationName],
  );

  const [threadMenuAnchor, setThreadMenuAnchor] = React.useState<HTMLElement | null>(null);

  const handleNewThread = React.useCallback(() => {
    const newId = createThreadId();
    const now = new Date().toISOString();
    const state = controller.getState();
    const existingThreads = state.doc.ai?.threads ?? [];
    controller.setState({
      ...state,
      doc: {
        ...state.doc,
        ai: {
          threads: [
            ...existingThreads,
            { id: newId, name: localeText.chatNewConversationName, createdAt: now, messages: [] },
          ],
          activeThreadId: newId,
        },
      },
    });
    // Update the stable ref so the next message goes to the new thread.
    defaultThreadId.current = newId;
  }, [controller, localeText.chatNewConversationName]);

  const handleSelectThread = React.useCallback(
    (threadId: string) => {
      const state = controller.getState();
      controller.setState({
        ...state,
        doc: {
          ...state.doc,
          ai: { ...(state.doc.ai ?? { threads: [] }), activeThreadId: threadId },
        },
      });
      defaultThreadId.current = threadId;
      setThreadMenuAnchor(null);
    },
    [controller],
  );

  const sortedThreads = React.useMemo(
    () =>
      (aiState?.threads ?? []).toSorted((a, b) => {
        const aTime = a.updatedAt ?? a.createdAt;
        const bTime = b.updatedAt ?? b.createdAt;
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
    streamThreadPinProps: { activeThreadIdRef, writeTargetThreadIdRef, isStreamingRef },
  };
}

// ── StreamThreadPin ───────────────────────────────────────────────────────────

interface StreamThreadPinProps {
  activeThreadIdRef: React.RefObject<string>;
  writeTargetThreadIdRef: React.RefObject<string>;
  isStreamingRef: React.RefObject<boolean>;
}

/**
 * Invisible component rendered inside `<ChatBox>` (inside its `useChat` context).
 * Watches `isStreaming` and, on the rising edge (streaming just started), pins
 * `writeTargetThreadIdRef` to whichever thread is active right now — the thread
 * this response's messages must be written back to, regardless of any thread
 * switch that happens before the response finishes.
 */
export function StreamThreadPin({
  activeThreadIdRef,
  writeTargetThreadIdRef,
  isStreamingRef,
}: StreamThreadPinProps) {
  const { isStreaming } = useChat();
  const wasStreamingRef = React.useRef(false);

  React.useEffect(() => {
    if (isStreaming && !wasStreamingRef.current) {
      writeTargetThreadIdRef.current = activeThreadIdRef.current;
    }
    isStreamingRef.current = isStreaming;
    wasStreamingRef.current = isStreaming;
  }, [isStreaming, activeThreadIdRef, writeTargetThreadIdRef, isStreamingRef]);

  return null;
}
