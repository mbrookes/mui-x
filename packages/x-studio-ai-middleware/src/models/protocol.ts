/**
 * Wire protocol between the x-studio client and the x-studio-ai-middleware server.
 *
 * The client sends a `StudioAIRequest` as the POST body.
 * The server responds with a `text/event-stream` of `StudioAISSEEvent` objects,
 * each encoded as `data: <JSON>\n\n`.
 */
import type { StudioState, StudioCustomWidgetDef } from './studioTypes';
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
  /**
   * When `true`, the current `<dashboard_state>` is omitted from the system prompt.
   * The model receives schema information only — no widget configurations, field names,
   * or layout. Use this when the dashboard contains sensitive business data you don't
   * want sent to the LLM provider.
   * @default false
   */
  privateMode?: boolean;
  /**
   * Pre-built data snapshot of all widgets on the current page, built client-side
   * where live pipeline-filtered rows are available.
   *
   * Format: one `### Widget Title (kind)\n<CSV data>` block per widget, joined by `\n\n`.
   *
   * When present, the `summarise_page` tool returns this snapshot to the model
   * so it can write a business-focused data summary instead of a structural description.
   */
  pageSnapshot?: string;
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
  /** Token and iteration usage for the completed request. Emitted just before `finish`. */
  | { type: 'usage'; inputTokens: number; outputTokens: number; iterations: number }
  /** An unrecoverable error occurred. */
  | { type: 'error'; message: string }
  /**
   * Model reasoning / chain-of-thought output (e.g. from Claude extended thinking).
   * Signals the start of a reasoning block; client renders it as a collapsible
   * "Thinking…" section while streaming and "Reasoning" when complete.
   */
  | { type: 'reasoning-start'; id: string }
  /** A chunk of reasoning text (appended to the open reasoning block). */
  | { type: 'reasoning-delta'; id: string; delta: string }
  /** Signals that the reasoning block identified by `id` is complete. */
  | { type: 'reasoning-end'; id: string }
  /**
   * Emitted at the start of each agentic iteration after the first.
   * The client renders it as a visual separator ("step divider") so users can see
   * how many reasoning rounds the model performed.
   */
  | { type: 'step-start'; iteration: number }
  /**
   * Metadata to shallow-merge into the current assistant message.
   * Use this to attach model name, per-message token counts, trace IDs, or any
   * other structured metadata. Emitted once per agentic turn, before `finish`.
   *
   * Consumers can access this via `message.metadata` in `onMessagesChange` callbacks
   * or custom message slot components.
   */
  | { type: 'message-metadata'; metadata: Record<string, unknown> }
  /**
   * Emitted before executing a destructive tool to request user approval.
   * The stream pauses until the client calls the approval endpoint.
   * The client should render approve/deny UI (the built-in ToolPart renderer
   * handles this automatically when `state === 'approval-requested'`).
   */
  | {
      type: 'tool-approval-request';
      toolCallId: string;
      toolName: string;
      input: unknown;
    };
