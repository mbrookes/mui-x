/**
 * Wire protocol between the x-studio client and the x-studio-ai-middleware server.
 *
 * The client sends a `StudioAIRequest` as the POST body.
 * The server responds with a `text/event-stream` of `StudioAISSEEvent` objects,
 * each encoded as `data: <JSON>\n\n`.
 */
import type { StudioState, StudioCustomWidgetDef } from './studioTypes';
import type { MutationEnvelope, SerializableSkill, StudioAIRichContext } from './aiTypes';

// Re-exported so consumers only need to import from @mui/x-studio-ai-middleware
export type { StateMutation, MutationEnvelope, SerializableSkill } from './aiTypes';

// ── Request ───────────────────────────────────────────────────────────────────

/** POST body sent by the client to the AI backend endpoint. */
export interface StudioAIRequest {
  /** Full conversation history, including previous assistant and tool messages. */
  messages: import('@mui/x-chat-headless').ChatMessage[];
  /**
   * Current dashboard state snapshot.
   *
   * Required, INCLUDING under {@link StudioAIRequest.privateMode}: it is what resolves
   * the active page, seeds the state the tools mutate, and binds a pending approval to
   * its chat thread. Private mode changes what the server DOES with it (never
   * interpolated into the prompt, never readable back through a tool — see
   * `privateMode` below), not whether the client sends it.
   */
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
   *
   * The guarantee is PROVIDER-facing and enforced here, on the server: the state block
   * is withheld from the prompt, every state-reading tool (`get_dashboard_state`,
   * `list_pages`, `summarise_page`, `query_data_source`) is withdrawn so nothing can
   * round-trip the state back to the provider, and the write tools that stay advertised
   * phrase their rejections without disclosing state. It is NOT a request to omit
   * {@link StudioAIRequest.dashboardState} from the request body — that field stays
   * required, and a body without it is rejected in validation whatever `privateMode`
   * says. What the client withholds instead is the DATA: `pageSnapshot` and
   * `richContext` are absent in private mode.
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
  /**
   * Extra client-derived context (per-field summary statistics, active-page
   * layout + cross-filter graph, and recent user mutations) used to give the
   * model more signal. Computed client-side from live pipeline rows and bounded
   * by a token budget. Omitted entirely in `privateMode`.
   */
  richContext?: StudioAIRichContext;
}

// ── SSE events ────────────────────────────────────────────────────────────────

/**
 * State-derived summary of a proposed mutation's structural consequences, attached to
 * a `tool-approval-request` event so a human can approve a layout / removing op with the
 * real impact in view rather than an opaque widget-id matrix (finding T2-2). Every field
 * is optional and present only when non-empty; entities carry their CURRENT title (read
 * from the pre-mutation state) so removed and orphaned widgets remain human-identifiable.
 */
export interface ApprovalEffectsSummary {
  /** Widgets this op will delete outright. */
  willRemoveWidgets?: Array<{ id: string; title: string }>;
  /** Pages this op will delete outright. */
  willRemovePages?: Array<{ id: string; title: string }>;
  /** Filter ids this op will delete (filters have no user-facing title). */
  willRemoveFilters?: string[];
  /** Widgets left referenced by NO page after the op (blank cards) — the orphan case
   *  the effects-aware policy gates on. */
  willOrphanWidgets?: Array<{ id: string; title: string }>;
  /** Number of widgets whose config/placement this op updates (large bulk edits). */
  updatedWidgetCount?: number;
}

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
  /**
   * A state change the client must apply to its StudioController, addressed as
   * a {@link MutationEnvelope} (`id` + `at` alongside the `mutation` itself) so
   * each mutation crossing the wire has an identity independent of its content.
   */
  | ({ type: 'state-mutation' } & MutationEnvelope)
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
   *
   * `effects` (finding T2-2) is an OPTIONAL, state-derived summary of the structural
   * consequences the proposed mutation will have — which widgets/pages/filters get
   * removed and which widgets get orphaned — so a human approving a `set_widget_layout`
   * or bulk `layout` op sees the real impact instead of an opaque id matrix. It parallels
   * the `effects` the MCP transport already forwards to its `approvalHandler`. Additive:
   * existing clients ignore the unknown key; it is present only for layout-affecting /
   * removing tools that actually carry structural effects.
   *
   * `reason` (Tier 3, iteration 22) is the POLICY's own stated justification for why
   * this call needs approval (e.g. "this exceeds today's mutation budget of 50"),
   * when the configured `ToolPolicy` supplied one via `{ action: 'require-approval',
   * reason }`. Previously computed but silently dropped before reaching this event —
   * a human approving/denying the call had no way to see WHY it was flagged. Additive
   * and optional, like `effects`.
   *
   * `approvalId` (round-4 finding F5) is the id a client resolves this approval WITH —
   * the key of the host-shared `approvalPending` map — and it is minted server-side by
   * `randomUUID()`, independently of `toolCallId`. The two were previously the same
   * value, which made the map key PROVIDER-authored: a gateway that numbers
   * `tool_calls[].id` sequentially (`call_1`, `call_2`, …) made a host-level,
   * cross-request map enumerable, so a caller could guess another user's pending
   * approval id. Thread binding (`isApprovalThreadIdAuthorized`) is then the only
   * thing standing between a guessed id and a resolved approval — which is why
   * ARCHITECTURE.md calls it load-bearing rather than defence-in-depth. Keeping
   * `toolCallId` on the event as well is deliberate: it is what addresses the tool
   * CARD in the UI, and it stays the OpenAI-wire id. Resolve with `approvalId`,
   * render against `toolCallId`.
   */
  | {
      type: 'tool-approval-request';
      /** Unguessable, server-minted key into `approvalPending` — resolve WITH this. */
      approvalId: string;
      toolCallId: string;
      toolName: string;
      input: unknown;
      effects?: ApprovalEffectsSummary;
      reason?: string;
    };
