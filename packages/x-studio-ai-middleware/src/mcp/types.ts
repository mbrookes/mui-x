/**
 * Public types for the x-studio MCP server.
 *
 * These live in their own module (rather than in `mcp.ts`) so the extracted
 * handler modules can import them without creating an import cycle back through
 * the composition root. `mcp.ts` re-exports every symbol here, so the package's
 * public entry point (`from './mcp'`) is unchanged.
 */

import type { StudioState, StudioCustomWidgetDef } from '../models/studioTypes';
import type { StudioAIContextEnricher } from '../handleAIChat';
import type { ToolPolicy, ToolPolicyContext } from '../toolPolicy';
import type { StudioAIDataConfig } from '../models/aiTypes';

export type { StudioState };

// ─────────────────────────────────────────────────────────────────────────────
// Data query types — now shared with the chat transport. Defined in
// `../models/aiTypes` (so `agenticLoop.ts`/`handleAIChat.ts` can import them
// without depending on this MCP-specific module) and re-exported here under
// their original names, since `mcp.ts` re-exports every symbol in this file.
// ─────────────────────────────────────────────────────────────────────────────

export type {
  StudioDataFilter,
  StudioDataAggregation,
  StudioDataOrderBy,
  StudioDataHavingPredicate,
  StudioDataQueryParams,
  StudioDataQueryResult,
} from '../models/aiTypes';

/**
 * Tool names registered directly by the MCP server that are NOT part of
 * `StudioAIToolName` (the built-in `STUDIO_AI_TOOLS` shared with the chat
 * transport): the read-only data-access tools (registered when `data` is
 * configured) plus the two tools registered unconditionally.
 *
 * `mcp/toolMetadata.ts` types `TOOL_TITLES`/`TOOL_ANNOTATIONS` as
 * `Record<StudioAIToolName | McpExtraToolName, …>` so a missing or phantom
 * entry for any MCP-registered tool is a compile error.
 */
export type McpExtraToolName =
  | 'describe_data_source'
  | 'get_field_values'
  | 'compute_field_stats'
  | 'render_chart'
  | 'get_recent_changes';

// ─────────────────────────────────────────────────────────────────────────────
// Public options / state box
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Options for `buildStudioMcpServer`.
 */
export interface StudioMcpOptions {
  /**
   * Custom widget definitions to include in system-prompt resources and tool handling.
   * @default []
   */
  customWidgets?: StudioCustomWidgetDef[];
  /**
   * Server name reported in the MCP `initialize` response.
   * @default 'x-studio'
   */
  serverName?: string;
  /**
   * Server version reported in the MCP `initialize` response.
   * @default '1.0.0'
   */
  serverVersion?: string;
  /**
   * Subset of STUDIO_AI_TOOL names to expose via MCP.
   * When omitted, all tools except those with no functional MCP handler are registered.
   * - `summarise_page` works when `data` is configured (queries sources server-side);
   *   falls back to a descriptive error when `data` is not provided.
   * - `query_data_source` works when `data` is configured; when it is not, the tool
   *   is left off the advertised list but its dispatch handler still exists, so an
   *   opted-in call returns a descriptive "no data access configuration" error
   *   rather than an `Unknown tool` error.
   */
  allowedTools?: string[];
  /**
   * Optional data access configuration.
   *
   * When provided, the `query_data_source` tool becomes available on both this
   * MCP server AND `handleAIChat`'s chat loop — pass the SAME `StudioAIDataConfig`
   * object to both for identical behavior across transports. Allows clients to
   * query the underlying data sources (order history, CRM contacts, products,
   * etc.) using structured filters and aggregations.
   *
   * Supply a `queryDataSource` callback that routes queries to the correct database.
   * The dev server implements this via `handleBatchQuery` from `@mui/x-studio-data-middleware`.
   * Your own server can provide any implementation as long as it returns `StudioDataQueryResult`.
   *
   * @example
   * ```ts
   * import { handleBatchQuery } from '@mui/x-studio-data-middleware';
   *
   * const options: StudioMcpOptions = {
   *   data: {
   *     queryDataSource: async (params) => {
   *       const result = await handleBatchQuery(
   *         { pageId: 'mcp', widgets: [{ id: 'q', table: params.tableName,
   *           columns: params.columns, filters: params.filters as any,
   *           aggregations: params.aggregations as any, orderBy: params.orderBy as any,
   *           limit: params.limit }] },
   *         claims,
   *         { db, schemaAllowlist }
   *       );
   *       const r = result.results[0];
   *       return { rows: r.rows, rowCount: r.rowCount, tier: r.tier };
   *     }
   *   }
   * };
   * ```
   */
  data?: StudioAIDataConfig;
  /**
   * Called after every state-mutating tool call with the updated `StudioState`.
   * Use this to persist the session state to a database so it can be reloaded
   * on the next session.
   *
   * @param {StudioState} state The updated studio state after the tool mutation.
   * @returns {void | Promise<void>} Nothing; the return value is ignored.
   * @example
   * ```ts
   * buildStudioMcpServer(stateBox, {
   *   onStateChange: async (state) => {
   *     await db('mcp_sessions').where({ id: sessionId }).update({
   *       state: JSON.stringify(state),
   *     });
   *   },
   * });
   * ```
   *
   * To restore a previous session, set `stateBox.current` to the saved state
   * before calling `buildStudioMcpServer`:
   * ```ts
   * const saved = await db('mcp_sessions').where({ id: sessionId }).first();
   * const stateBox: StudioStateBox = {
   *   current: saved ? JSON.parse(saved.state) : createDefaultStudioState(),
   * };
   * ```
   */
  onStateChange?: (state: StudioState) => void | Promise<void>;
  /**
   * Optional logger for tool-call diagnostics.
   * When provided, each invocation is logged with its tool name on entry,
   * elapsed time on completion, and full error details on failure.
   * In the dev server, pass the server's `log` / `error` functions here.
   */
  logger?: {
    log: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  /**
   * Optional hook to attach DB-side metadata (row counts per dimension value,
   * schema comments) to the `studio://dashboard/system-prompt` resource — the
   * MCP analogue of `handleAIChat`'s `contextEnricher`. It runs each time that
   * resource is read and its result is rendered into a `<server_context>` block.
   *
   * Best-effort: if the callback throws, the error is logged and the prompt is
   * built without it. Keep the payload small — it adds to every read.
   */
  contextEnricher?: StudioAIContextEnricher;
  /**
   * Per-call authorization policy — the single chokepoint every state-mutating
   * `tools/call` passes through.
   *
   * IMPORTANT: the default when omitted is an ALLOW-ALL policy (`() => ({ action:
   * 'allow' })`), NOT `createDefaultToolPolicy()`. MCP has no approval-pause channel
   * today, so an existing integration that omits this must keep executing every tool
   * exactly as before. Supply a custom policy to `deny`/`require-approval`/`allow`
   * per call; pair `require-approval` with `approvalHandler` to actually gate it.
   */
  toolPolicy?: ToolPolicy;
  /**
   * Bridges a `require-approval` policy decision to a host-controlled approval
   * channel (MCP has no built-in pause). When a call needs approval and this is
   * configured, it is awaited: `true` commits the mutation, `false` denies it with a
   * clear reason. When a call needs approval and this is NOT configured, the call is
   * denied cleanly (never thrown) with a message explaining no approval channel is
   * wired up.
   *
   * @param {ToolPolicyContext} ctx The policy context for the call awaiting approval (tool name, args, pre-execution state, and — for a mutating call — the proposed mutation/effects).
   * @returns {Promise<boolean>} `true` to commit the mutation, `false` to deny it.
   */
  approvalHandler?: (ctx: ToolPolicyContext) => Promise<boolean>;
  /**
   * Bound (in ms) on how long a single `require-approval` call waits on
   * `approvalHandler` before being treated as denied. MCP has no per-call
   * `AbortSignal` to race (unlike the chat transport's `waitForApproval` in
   * `agenticLoop/toolDispatch.ts`, which races the handler against BOTH a timeout
   * and an abort signal), so this only bounds the timeout side of that pattern —
   * but it closes the same hole: without it, a human approval UI that never
   * resolves (a closed tab, a dropped connection) hangs the awaited promise
   * forever, and because the mutating `tools/call` branch runs this INSIDE the
   * per-session `mutationChain` critical section, every subsequent mutating call
   * in the session queues behind it and hangs too.
   * @default 120000
   */
  approvalTimeoutMs?: number;
  /**
   * Per-session mutation and tool-call budgets. Both are layered BEFORE the host
   * `toolPolicy` (via `Policy.all`), mirroring `AgenticLoopOptions.rateLimit` on the
   * chat transport.
   *
   * - `maxMutationsPerSession`: once this many committed mutations are reached, any
   *   further mutating `tools/call` is denied with a clear reason. Read-only calls
   *   never count against it.
   * - `maxToolCallsPerSession`: once this many total `tools/call` invocations (mutating
   *   OR read-only) are reached, EVERY further call is denied — this is what actually
   *   bounds a session that dispatches an unbounded number of read-only calls (e.g.
   *   hundreds of `query_data_source` live DB queries), which `maxMutationsPerSession`
   *   alone does not cap. Omit for no cap (current behavior).
   *
   * `onLimitReached(reason, count)` fires once per breach, per budget.
   */
  rateLimit?: {
    maxMutationsPerSession?: number;
    maxToolCallsPerSession?: number;
    onLimitReached?: (reason: 'mutations' | 'toolCalls', count: number) => void;
  };
}

/**
 * A boxed reference to a `StudioState` value.
 *
 * Using a box (object wrapper) lets all registered tool handlers share a single
 * mutable pointer to the current state — when a tool mutates the state, it writes
 * to `box.current` and the next tool call in the same session automatically sees
 * the updated state.
 *
 * ```ts
 * const stateBox: StudioStateBox = { current: createDefaultStudioState() };
 * const server = buildStudioMcpServer(stateBox);
 * // After an add_widget tool call, stateBox.current has the new widget.
 * ```
 */
export interface StudioStateBox {
  current: StudioState;
}

/** Diagnostic logger passed through `StudioMcpOptions.logger`. */
export type StudioMcpLogger = NonNullable<StudioMcpOptions['logger']>;

/** Data-access configuration passed through `StudioMcpOptions.data`. */
export type StudioMcpData = NonNullable<StudioMcpOptions['data']>;
