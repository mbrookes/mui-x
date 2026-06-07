/**
 * Wire protocol between the x-studio client and the x-studio-ai-middleware server.
 *
 * The client sends a `StudioAIRequest` as the POST body.
 * The server responds with a `text/event-stream` of `StudioAISSEEvent` objects,
 * each encoded as `data: <JSON>\n\n`.
 */
import type { StudioState, StudioCustomWidgetDef } from '@mui/x-studio';
import type { StateMutation, SerializableSkill } from './aiTypes';

// Re-exported so consumers only need to import from @mui/x-studio-ai-middleware
export type { StateMutation, SerializableSkill } from './aiTypes';

// ── Request ───────────────────────────────────────────────────────────────────

/** POST body sent by the client to the AI backend endpoint. */
export interface StudioAIRequest {
  /** Full conversation history, including previous assistant and tool messages. */
  messages: import('@mui/x-chat-headless').ChatMessage[];
  /** Current dashboard state snapshot. */
  dashboardState: StudioState;
  /** Custom widget definitions (for prompt context and tool defaults). */
  customWidgets?: StudioCustomWidgetDef[];
  /** If set, the AI focuses on this specific widget. */
  focusedWidgetId?: string;
  /** Whitelist of built-in tool names. When omitted, all tools are enabled. */
  allowedTools?: string[];
  /** Serialized skills (prompt fragments + optional tool definitions). */
  skills?: SerializableSkill[];
}

// ── SSE events ────────────────────────────────────────────────────────────────

/**
 * Union of all SSE events emitted by the backend.
 * Each event is JSON-encoded and sent as `data: <JSON>\n\n`.
 */
export type StudioAISSEEvent =
  /** A text token from the model. */
  | { type: 'text-delta'; delta: string }
  /** Informational: a tool call started or completed (for UI display). */
  | {
      type: 'tool-activity';
      toolCallId: string;
      toolName: string;
      phase: 'start' | 'complete';
      input?: unknown;
      output?: string;
    }
  /** A state change the client must apply to its StudioController. */
  | { type: 'state-mutation'; mutation: StateMutation }
  /** The model finished generating. */
  | { type: 'finish'; finishReason: string }
  /** An unrecoverable error occurred. */
  | { type: 'error'; message: string };


