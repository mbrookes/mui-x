/**
 * AI conversation-thread state for MUI X Studio.
 *
 * Persisted and restored as part of `StudioState.ai` so conversation history
 * can travel alongside the dashboard document. Shared by both the client
 * (`@mui/x-studio`) and the server (`@mui/x-studio-ai-middleware`).
 */
import type { ChatMessage } from '@mui/x-chat-headless';

/**
 * A single named conversation thread between the user and the AI assistant.
 * Threads are serialized inside `StudioState.ai` so conversation history
 * can be persisted alongside the dashboard state.
 */
export interface StudioAIChatThread {
  /** Unique thread identifier. */
  id: string;
  /** Display name shown in the thread selector. Auto-generated or user-renamed. */
  name: string;
  /** ISO 8601 timestamp when the thread was created. */
  createdAt: string;
  /** ISO 8601 timestamp of the most recent message. Updated on every send. */
  updatedAt?: string;
  /** Full message history for this thread. */
  messages: ChatMessage[];
}

/**
 * AI assistant state stored inside `StudioState`.
 *
 * Persisted via `serializeState`/`deserializeState` so conversation history
 * travels with the dashboard — enabling pre-loaded demos, cross-session memory,
 * and shareable dashboards with embedded AI context.
 */
export interface StudioAIState {
  /** All conversation threads. Ordered by `updatedAt` descending in the UI. */
  threads: StudioAIChatThread[];
  /** ID of the currently active thread. `undefined` means no thread is selected. */
  activeThreadId?: string;
}
