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

export type { StudioState };

// ─────────────────────────────────────────────────────────────────────────────
// Data query types (framework-agnostic — no Knex dependency in this package)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Structured filter predicate for `query_data_source`.
 * Operators match those accepted by `@mui/x-studio-data-middleware`'s
 * `FilterPredicate` type so the dev server can forward them unchanged.
 */
export interface StudioDataFilter {
  /** Field ID (column name) to filter on. */
  field: string;
  /** Comparison operator. */
  operator: 'eq' | 'neq' | 'in' | 'lt' | 'lte' | 'gt' | 'gte' | 'like' | 'between';
  /** Filter value. For `between`, this is the lower bound; supply `value2` for the upper. */
  value: unknown;
  /** Upper bound for `between` operator. */
  value2?: unknown;
}

/** Single aggregation function for `query_data_source`. */
export interface StudioDataAggregation {
  /** Column to aggregate (field ID / column name). */
  column: string;
  /** Aggregation function. */
  func: 'sum' | 'avg' | 'count' | 'min' | 'max';
  /** Alias used as the result column key in returned rows. */
  alias: string;
}

/** Sort descriptor for `query_data_source`. */
export interface StudioDataOrderBy {
  /** Column name (field ID or aggregation alias). */
  column: string;
  /** Sort direction. */
  direction: 'asc' | 'desc';
}

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
  | 'query_data_source'
  | 'describe_data_source'
  | 'get_field_values'
  | 'compute_field_stats'
  | 'render_chart'
  | 'get_recent_changes';

/** Post-aggregation HAVING predicate for `query_data_source`. */
export interface StudioDataHavingPredicate {
  /** Aggregation alias (from `aggregations[].alias`) to filter on. */
  alias: string;
  /** Comparison operator. */
  operator: 'eq' | 'gt' | 'lt' | 'gte' | 'lte';
  /** Numeric threshold. */
  value: number;
}

/** Arguments for the `query_data_source` MCP tool. */
export interface StudioDataQueryParams {
  /** Data source ID from the dashboard state (e.g. `"source-orders"`). */
  sourceId: string;
  /**
   * Physical table name resolved from the data source.
   * Set internally by the tool handler — callers should not need to set this.
   */
  tableName: string;
  /** Field IDs to project. Omit to return all non-hidden fields. */
  columns?: string[];
  /** Structured WHERE predicates. Never raw SQL. */
  filters?: StudioDataFilter[];
  /**
   * Aggregation functions applied via GROUP BY.
   * Non-aggregated `columns` entries form the GROUP BY list.
   */
  aggregations?: StudioDataAggregation[];
  /**
   * Post-aggregation HAVING predicates.
   * Each alias must match an entry in `aggregations[].alias`.
   */
  having?: StudioDataHavingPredicate[];
  /** Sort order. */
  orderBy?: StudioDataOrderBy[];
  /** Maximum rows to return. Default 1000. */
  limit?: number;
  /** Number of rows to skip before returning results. Use with `limit` for pagination. Default 0. */
  offset?: number;
}

/** Result returned by `queryDataSource` and surfaced in the `query_data_source` tool response. */
export interface StudioDataQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  /** Routing tier applied by the data middleware. */
  tier?: 'client' | 'server' | 'db';
}

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
   * - `execute_query` cannot be enabled via MCP. It runs arbitrary SQL, which on
   *   the chat path is backed by `handleAIChat`'s `dataResolver`; `StudioMcpOptions`
   *   has no equivalent resolver hook, so there is no handler to dispatch it to.
   *   Listing it here has no effect — it is excluded unconditionally so an opted-in
   *   call cannot dead-end on an `Unknown tool` error.
   */
  allowedTools?: string[];
  /**
   * Optional data access configuration.
   *
   * When provided, the `query_data_source` MCP tool becomes available, allowing
   * MCP clients to query the underlying data sources (order history, CRM contacts,
   * products, etc.) using structured filters and aggregations.
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
  data?: {
    /**
     * Execute a structured query against a data source.
     * The implementation is responsible for security, allowlisting, and DB routing.
     * @param {StudioDataQueryParams} params - The structured query (source, columns, aggregations, filters, ordering).
     * @returns {Promise<StudioDataQueryResult>} The resolved rows together with the row count and routing tier.
     */
    queryDataSource: (params: StudioDataQueryParams) => Promise<StudioDataQueryResult>;
    /**
     * Hard upper bound on the number of rows the `query_data_source` tool may request.
     * The model-supplied `limit` (or the default of 1000) is clamped to this value before
     * the query reaches your `queryDataSource` implementation.
     * @default 1000
     */
    maxQueryRows?: number;
  };
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
