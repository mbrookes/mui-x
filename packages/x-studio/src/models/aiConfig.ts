/**
 * The host-facing configuration for Studio's AI features.
 *
 * In `models/` rather than beside the SSE adapter that consumes it, because it is part of the
 * package's public surface — a host writes one of these — and `internals/StudioUIConfigContext.ts`
 * needs the type. With the interface declared inside `components/StudioChatPanel/`, that was the
 * package's last upward layer edge: `internals/` reaching into `components/`.
 */
import type { StudioAIToolName, SerializableSkill } from '@mui/x-studio-core/models';

/**
 * Configuration for the x-studio AI assistant.
 *
 * `x-studio` is a UI-only package — it contains no LLM implementation.
 * Point `endpoint` at an `x-studio-ai-middleware` server (e.g. `examples/x-studio-dev-server`)
 * which holds the API key, builds the system prompt, and runs tool calls server-side.
 *
 * **Referential stability is a performance hint, not a correctness requirement.**
 * `StudioChatPanel` rebuilds its `ChatAdapter` whenever this object's identity
 * changes, and the panel re-renders on every streamed token — so passing a fresh
 * object literal on each render (the shape of the examples below) rebuilds the
 * adapter constantly. Nothing breaks: the in-flight readers a `stop()` must cancel
 * are tracked in a registry owned by the panel, deliberately OUTSIDE the adapter,
 * precisely so a rebuilt adapter can still abort the stream that is actually
 * running. Memoizing (`React.useMemo`) still saves the rebuild work.
 */
export interface StudioAIConfig {
  /**
   * Base URL of your server-side AI handler.
   * Typically `http://localhost:3020/api/ai` when using `x-studio-dev-server`.
   * The following paths are appended automatically for each operation:
   * - `/chat` — streaming chat (SSE)
   * - `/approval` — tool-call approval responses
   * - `/widget` — widget creation from description
   */
  endpoint: string;
  /**
   * Additional HTTP headers sent with every AI request.
   * Use this to authenticate with your server, e.g.:
   * ```ts
   * headers: { Authorization: `Bearer ${import.meta.env.STUDIO_SERVER_TOKEN}` }
   * ```
   */
  headers?: Record<string, string>;
  /**
   * Whitelist of built-in tool names the model is allowed to call.
   * When omitted, all built-in tools are enabled.
   * Set to `[]` to disable all built-in tools.
   */
  allowedTools?: StudioAIToolName[];
  /**
   * Skills to register with the AI assistant.
   * `execute` functions (if present) are stripped before sending to the server —
   * only the serializable fields (`name`, `mode`, `promptFragment`, `tool` schema)
   * are forwarded. All execution happens server-side.
   */
  skills?: SerializableSkill[];
  /**
   * When `true`, the current dashboard state is omitted from the system prompt.
   * The model receives schema information only — no widget configurations, field
   * names, or layout data are sent to the LLM provider.
   *
   * Use this when your dashboard displays sensitive business data and you want
   * to prevent it from being included in LLM API calls.
   *
   * **What is and isn't sent, and to whom.** This is a guarantee about the LLM
   * PROVIDER, not about your own backend. The `endpoint` below is an
   * `x-studio-ai-middleware` server that you deploy — it holds the API key, builds
   * the prompt and executes tool calls — and it already receives the entire
   * conversation. It therefore still receives `dashboardState`, which it needs to
   * execute any state-editing tool at all, and enforces private mode where it
   * actually matters: the `<dashboard_state>` block is withheld from the system
   * prompt, every state-reading tool (`get_dashboard_state`, `list_pages`,
   * `summarise_page`, `query_data_source`) is withdrawn from the advertised tool
   * set so nothing can round-trip that state back to the provider, and the write
   * tools that stay advertised phrase their rejections without disclosing state.
   *
   * What the client withholds outright is the bulk data: `pageSnapshot` (sampled
   * row values) and `richContext` (per-field statistics) are never built and never
   * sent anywhere in private mode.
   *
   * That is not the whole enumeration, though, and the difference matters to a host
   * reasoning about what its OWN endpoint receives. `serializeDashboardState` empties
   * `doc.ai.threads` and strips `runtime.dataSources[].rows`; it does not touch
   * `doc.filters`, so every filter's `value` is sent with the rest of the document —
   * and for the `cross-filter` and `interactive` scopes that value IS a real row
   * value, since it is whatever the user clicked (a chart category, a legend label, a
   * selected grid cell). A field name in a page-scoped filter is structure; the
   * category in a cross-filter is data.
   *
   * The stated guarantee is unaffected: it is provider-facing, and the middleware
   * withholds the entire `<dashboard_state>` block — filters included — from the
   * prompt in private mode, with every state-reading tool withdrawn, so none of it
   * reaches the LLM. But "no row values leave the browser" would be wrong, and this
   * doc is the only place a host learns otherwise.
   * @default false
   */
  privateMode?: boolean;
  /**
   * When `false`, tool call cards (showing which tools the AI called and their
   * results) are hidden from the chat interface. Defaults to `true`.
   *
   * Set to `false` in production to keep the conversation clean. In development,
   * leaving this enabled (the default) helps inspect AI tool usage.
   * @default true
   */
  showToolCalls?: boolean;
  /**
   * Called after each completed AI chat request with token and iteration usage.
   * Use this to display a token counter, enforce client-side budgets, or log
   * usage to an analytics service.
   *
   * Note: server-side enforcement of token budgets is configured via
   * `rateLimit` in `StudioAIHandlerOptions` (your server endpoint, not here).
   *
   * @example
   * ```tsx
   * aiConfig={{
   *   endpoint: '/api/ai',
   *   onUsage: ({ inputTokens, outputTokens, iterations }) => {
   *     console.log(`Tokens: ${inputTokens + outputTokens}, turns: ${iterations}`);
   *   },
   * }}
   * ```
   */
  onUsage?: (usage: { inputTokens: number; outputTokens: number; iterations: number }) => void;
  /**
   * Token budget for the additional "rich context" attached to each chat request
   * (per-field summary statistics, active-page layout + cross-filter graph, and
   * recent user mutations). Sections are included in priority order until the
   * budget is reached; the rest are dropped and noted to the model.
   *
   * Larger values give the model more signal at higher token cost. Has no effect
   * in `privateMode` (rich context is never sent then).
   * @default 4000
   */
  contextBudgetTokens?: number;
}
