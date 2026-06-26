/**
 * MCP (Model Context Protocol) server factory for @mui/x-studio-ai-middleware.
 *
 * Provides `buildStudioMcpServer`, a framework-agnostic factory that creates a
 * pre-configured MCP `Server` with all x-studio AI tools registered and the
 * current dashboard state exposed as MCP resources.
 *
 * ## Usage in an Express server
 *
 * ```ts
 * import { buildStudioMcpServer, StudioMcpOptions } from '@mui/x-studio-ai-middleware';
 * import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
 * import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
 * import { randomUUID } from 'node:crypto';
 *
 * const transports: Record<string, StreamableHTTPServerTransport> = {};
 * const stateBoxes: Record<string, { current: StudioState }> = {};
 *
 * router.post('/', async (req, res) => {
 *   const sessionId = req.headers['mcp-session-id'] as string | undefined;
 *   if (sessionId && transports[sessionId]) {
 *     await transports[sessionId].handleRequest(req, res, req.body);
 *     return;
 *   }
 *   if (!sessionId && isInitializeRequest(req.body)) {
 *     const stateBox = { current: createDefaultStudioState() };
 *     const transport = new StreamableHTTPServerTransport({
 *       sessionIdGenerator: () => randomUUID(),
 *       onsessioninitialized: (sid) => { transports[sid] = transport; stateBoxes[sid] = stateBox; },
 *     });
 *     transport.onclose = () => { delete transports[transport.sessionId!]; delete stateBoxes[transport.sessionId!]; };
 *     await buildStudioMcpServer(stateBox).connect(transport);
 *     await transport.handleRequest(req, res, req.body);
 *     return;
 *   }
 *   res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request' }, id: null });
 * });
 * ```
 *
 * See `examples/x-studio-dev-server/src/routes/mcp.ts` for the complete Express integration.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  CompleteRequestSchema,
  type ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import { STUDIO_AI_TOOLS } from './studioAITools';
import { executeToolOnState } from './executeToolOnState';
import { buildAISystemPrompt, serializeFieldForAI } from './buildAISystemPrompt';
import { renderChartSvg } from './chartRenderer';
import type { ChartRendererInput } from './chartRenderer';
import type { StudioState, StudioCustomWidgetDef } from './models/studioTypes';

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
// Public types
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
   * When omitted, all tools except `execute_query` are registered.
   * - `summarise_page` works when `data` is configured (queries sources server-side);
   *   falls back to a descriptive error when `data` is not provided.
   * - `execute_query` runs raw SQL against a live DB connection — opt in explicitly
   *   only if your server validates and sandboxes the queries.
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

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tools that are registered in STUDIO_AI_TOOLS but are not suitable for MCP
 * because they require live widget row data only available client-side.
 */
const DEFAULT_EXCLUDED_TOOLS = new Set([
  // execute_query runs raw SQL against a live DB connection — not safe to expose
  // via MCP without explicit opt-in. Add it to allowedTools if you need it.
  'execute_query',
]);

/** Race a promise against a timeout. Rejects with a descriptive error if the timeout fires first. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

// ── Anomaly detection helpers (inlined — mcp.ts cannot import from @mui/x-studio) ─
// Canonical implementations: anomalyDetection.ts + temporalUtils.ts in @mui/x-studio.

const ANOMALY_CHART_TYPES = new Set(['bar', 'bar-stacked', 'bar-100', 'line']);

/** ISO week number for a UTC date. Mirror of isoWeek() in temporalUtils.ts. */
function mcpIsoWeek(d: Date): { year: number; week: number } {
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  tmp.setUTCDate(tmp.getUTCDate() + 4 - (tmp.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: tmp.getUTCFullYear(), week };
}

/** Truncate an ISO-date-string value to a period-key. Mirror of truncateToGranularity(). */
function mcpTruncateToPeriod(value: unknown, granularity: string): string | null {
  const raw =
    typeof value === 'string' ? value : value instanceof Date ? value.toISOString() : null;
  if (!raw) return null;
  const y = Number(raw.slice(0, 4));
  const m = Number(raw.slice(5, 7)) - 1; // 0-indexed
  const day = Number(raw.slice(8, 10));
  if (Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(day)) return null;
  switch (granularity) {
    case 'day':
      return `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    case 'week': {
      const { year, week } = mcpIsoWeek(new Date(Date.UTC(y, m, day)));
      return `${year}-W${String(week).padStart(2, '0')}`;
    }
    case 'month':
      return `${y}-${String(m + 1).padStart(2, '0')}`;
    case 'quarter':
      return `${y}-Q${Math.floor(m / 3) + 1}`;
    case 'year':
      return String(y);
    default:
      return null;
  }
}

/** Tukey IQR outlier detection. Mirror of detectAnomaliesIQR() in anomalyDetection.ts. */
function mcpMedian(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
function mcpDetectAnomaliesIQR(values: number[]): Set<number> {
  if (values.length < 4) return new Set();
  const sorted = values.toSorted((a, b) => a - b);
  const q1 = mcpMedian(sorted.slice(0, Math.floor(sorted.length / 2)));
  const q3 = mcpMedian(sorted.slice(Math.ceil(sorted.length / 2)));
  const iqr = q3 - q1;
  if (iqr === 0) return new Set();
  const lower = q1 - 1.5 * iqr;
  const upper = q3 + 1.5 * iqr;
  const result = new Set<number>();
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] < lower || values[i] > upper) result.add(i);
  }
  return result;
}

/** JSON Schema for the `query_data_source` tool input. */
const QUERY_DATA_SOURCE_SCHEMA = {
  type: 'object',
  properties: {
    sourceId: {
      type: 'string',
      description:
        'The data source ID from the dashboard state (e.g. "source-orders", "source-crm-deals"). ' +
        'Read the studio://dashboard/state resource to discover available sources and their field IDs.',
    },
    columns: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Field IDs to return. Omit to return all non-hidden fields. ' +
        'Field IDs exactly match the column names in the database (camelCase).',
    },
    filters: {
      type: 'array',
      description:
        'Structured WHERE predicates. Each filter narrows the result set. ' +
        'Do NOT use raw SQL — use these structured operators only.',
      items: {
        type: 'object',
        properties: {
          field: { type: 'string', description: 'Field ID (column name) to filter on.' },
          operator: {
            type: 'string',
            enum: ['eq', 'neq', 'in', 'lt', 'lte', 'gt', 'gte', 'like', 'between'],
            description:
              'eq=equal, neq=not equal, in=one of array, lt/lte/gt/gte=numeric comparison, ' +
              'like=substring (%value%), between=inclusive range (supply value + value2).',
          },
          value: { description: 'Filter value. For between, this is the lower bound.' },
          value2: { description: 'Upper bound for the between operator.' },
        },
        required: ['field', 'operator', 'value'],
      },
    },
    aggregations: {
      type: 'array',
      description:
        'Aggregation functions applied via GROUP BY. ' +
        'Non-aggregated columns in `columns` become the GROUP BY list. ' +
        'Examples: count orders per status, sum revenue per category.',
      items: {
        type: 'object',
        properties: {
          column: { type: 'string', description: 'Field ID to aggregate.' },
          func: {
            type: 'string',
            enum: ['sum', 'avg', 'count', 'min', 'max'],
            description:
              'Use count for counting rows, sum for totals, avg for averages, min/max for extremes.',
          },
          alias: {
            type: 'string',
            description: 'Output key for this aggregated value in returned rows.',
          },
        },
        required: ['column', 'func', 'alias'],
      },
    },
    having: {
      type: 'array',
      description:
        'Post-aggregation filters (HAVING clause). Each entry filters on an aggregation alias. ' +
        'Example: to show only categories with total revenue > 10 000, combine ' +
        '`aggregations: [{ column: "revenue", func: "sum", alias: "total_revenue" }]` with ' +
        '`having: [{ alias: "total_revenue", operator: "gt", value: 10000 }]`.',
      items: {
        type: 'object',
        properties: {
          alias: {
            type: 'string',
            description:
              'Aggregation alias to filter on (must match an entry in aggregations[].alias).',
          },
          operator: {
            type: 'string',
            enum: ['eq', 'gt', 'lt', 'gte', 'lte'],
            description: 'eq=equal, gt=greater than, lt=less than, gte/lte=inclusive.',
          },
          value: { type: 'number', description: 'Numeric threshold.' },
        },
        required: ['alias', 'operator', 'value'],
      },
    },
    orderBy: {
      type: 'array',
      description: 'Sort the result rows. Apply after aggregations when using GROUP BY.',
      items: {
        type: 'object',
        properties: {
          column: {
            type: 'string',
            description: 'Column name or aggregation alias to sort by.',
          },
          direction: { type: 'string', enum: ['asc', 'desc'] },
        },
        required: ['column', 'direction'],
      },
    },
    limit: {
      type: 'number',
      description:
        'Maximum rows to return. Default 1000. Use a smaller value for exploration; ' +
        'use aggregations instead of high limits for analytical summaries.',
      default: 1000,
    },
    offset: {
      type: 'number',
      description:
        'Number of rows to skip before returning results. Use with limit for pagination. Default 0.',
      default: 0,
    },
  },
  required: ['sourceId'],
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Core factory
// ─────────────────────────────────────────────────────────────────────────────

/** Human-readable display titles for MCP tools (shown in Claude Desktop's permission editor). */
const TOOL_TITLES: Record<string, string> = {
  get_dashboard_state: 'Get dashboard state',
  set_dashboard_title: 'Set dashboard title',
  add_page: 'Add page',
  rename_page: 'Rename page',
  remove_page: 'Remove page',
  set_active_page: 'Switch page',
  add_widget: 'Add widget',
  update_widget: 'Update widget',
  remove_widget: 'Remove widget',
  set_widget_layout: 'Set widget layout',
  set_widget_width: 'Set widget width',
  set_widget_forecast: 'Set widget forecast',
  add_page_filter: 'Add page filter',
  remove_page_filter: 'Remove page filter',
  add_widget_filter: 'Add widget filter',
  remove_widget_filter: 'Remove widget filter',
  summarise_page: 'Summarise page',
  apply_bulk_update: 'Apply bulk update',
  rename_thread: 'Rename thread',
  execute_query: 'Execute query',
  get_current_date: 'Get current date',
  query_data_source: 'Query data source',
  describe_data_source: 'Describe data source',
  get_field_values: 'Get field values',
  compute_field_stats: 'Compute field stats',
  render_chart: 'Render chart',
};

/** MCP tool annotations for each tool name (both built-in and dynamically added tools). */
const TOOL_ANNOTATIONS: Record<string, ToolAnnotations> = {
  // Read-only — never modifies state.
  get_dashboard_state: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  list_pages: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  render_chart: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  query_data_source: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  describe_data_source: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  get_field_values: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  compute_field_stats: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  summarise_page: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  execute_query: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  // Destructive — permanently deletes an entity.
  remove_widget: { destructiveHint: true, openWorldHint: false },
  remove_page: { destructiveHint: true, openWorldHint: false },
  remove_page_filter: { destructiveHint: true, openWorldHint: false },
  remove_widget_filter: { destructiveHint: true, openWorldHint: false },
  // Idempotent setters — applying the same args twice has no additional effect.
  set_dashboard_title: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  set_widget_layout: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  set_widget_width: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  rename_page: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  set_active_page: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  update_widget: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  apply_bulk_update: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  rename_thread: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  set_widget_forecast: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  // Additive — each call creates a new entity; not idempotent.
  add_page: { destructiveHint: false, openWorldHint: false },
  add_widget: { destructiveHint: false, openWorldHint: false },
  add_page_filter: { destructiveHint: false, openWorldHint: false },
  add_widget_filter: { destructiveHint: false, openWorldHint: false },
};

/**
 * Creates a pre-configured `McpServer` with all x-studio AI tools registered.
 *
 * Each tool handler delegates to `executeToolOnState` (the same pure function
 * used by the AI agentic loop), which returns `{ output, mutation?, nextState }`.
 * The handler writes `nextState` back to `stateBox.current` so subsequent tool
 * calls in the same session see the updated dashboard state.
 *
 * The server also registers MCP resources:
 * - `studio://dashboard/state` — the full `StudioState` JSON
 * - `studio://dashboard/system-prompt` — the AI system prompt built from current state
 *
 * When `options.data` is provided, the `query_data_source` tool is also registered,
 * enabling MCP clients to query the underlying databases.
 *
 * @param stateBox  A boxed `StudioState` reference, shared across all tool handlers.
 *                  Typically `{ current: createDefaultStudioState() }` or loaded from a DB.
 * @param options   Optional configuration (server name/version, custom widgets, allowed tools, data access).
 *
 * @example
 * ```ts
 * import { buildStudioMcpServer, StudioStateBox } from '@mui/x-studio-ai-middleware';
 * import { createDefaultStudioState } from '@mui/x-studio-ai-middleware';
 *
 * const stateBox: StudioStateBox = { current: createDefaultStudioState() };
 * const mcpServer = buildStudioMcpServer(stateBox);
 * // Connect to a transport (e.g. StreamableHTTPServerTransport) and serve.
 * await mcpServer.connect(transport);
 * ```
 */
export function buildStudioMcpServer(
  stateBox: StudioStateBox,
  options: StudioMcpOptions = {},
): Server {
  const {
    customWidgets = [],
    serverName = 'x-studio',
    serverVersion = '1.0.0',
    allowedTools,
    data,
    onStateChange,
    logger,
  } = options;

  const MAX_QUERY_ROWS = data?.maxQueryRows ?? 1000;

  const server = new Server(
    { name: serverName, version: serverVersion },
    {
      capabilities: {
        tools: {},
        prompts: {},
        resources: {
          subscribe: true, // clients can subscribe to specific resource URIs
          listChanged: true, // server can notify when resource list changes
        },
        completions: {}, // enables URI-template variable autocomplete
      },
    },
  );

  // Track subscribed resource URIs for state-change notifications.
  const subscribedUris = new Set<string>();

  // Determine which dashboard-mutation tools to expose.
  // - By default, exclude tools that require live client-side row data.
  // - If allowedTools is provided, use that exact list (caller takes responsibility).
  const toolsToRegister = STUDIO_AI_TOOLS.filter((toolDef) => {
    const name = toolDef.function.name;
    if (allowedTools) {
      return allowedTools.includes(name);
    }
    return !DEFAULT_EXCLUDED_TOOLS.has(name);
  });

  // ── tools/list ───────────────────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: Array<{
      name: string;
      title?: string;
      description: string;
      inputSchema: Record<string, unknown>;
      annotations?: ToolAnnotations;
    }> = toolsToRegister.map((toolDef) => ({
      name: toolDef.function.name,
      title: TOOL_TITLES[toolDef.function.name],
      description: toolDef.function.description,
      // STUDIO_AI_TOOLS parameters are standard JSON Schema objects — pass through directly.
      inputSchema: toolDef.function.parameters as Record<string, unknown>,
      annotations: TOOL_ANNOTATIONS[toolDef.function.name],
    }));

    if (data) {
      tools.push({
        name: 'query_data_source',
        title: TOOL_TITLES.query_data_source,
        description:
          'Query a data source (database table) with structured filters, aggregations, and sorting. ' +
          'Use this to retrieve data rows, compute aggregates (totals, averages, counts by group), ' +
          'or explore the underlying data before configuring widgets. ' +
          'Supports HAVING predicates to filter on aggregation results (e.g. "categories where revenue > $10K"). ' +
          'Results are read-only — this tool never modifies data. ' +
          'Tip: use the studio://dashboard/state resource to discover available sourceIds and field names.',
        inputSchema: QUERY_DATA_SOURCE_SCHEMA as unknown as Record<string, unknown>,
        annotations: TOOL_ANNOTATIONS.query_data_source,
      });

      tools.push({
        name: 'describe_data_source',
        title: TOOL_TITLES.describe_data_source,
        description:
          'Returns the schema (field definitions), total row count, up to 10 sample rows, and basic ' +
          'per-field statistics for a data source. Call this first when you need to understand a ' +
          'source before querying — it gives you the field IDs, types, and scale in one request.',
        inputSchema: {
          type: 'object',
          properties: {
            sourceId: {
              type: 'string',
              description: 'Data source ID from the dashboard state (e.g. "source-orders").',
            },
          },
          required: ['sourceId'],
        } as Record<string, unknown>,
        annotations: TOOL_ANNOTATIONS.describe_data_source,
      });

      tools.push({
        name: 'get_field_values',
        title: TOOL_TITLES.get_field_values,
        description:
          'Returns the distinct values and their occurrence counts for a specific field. ' +
          'Use this to understand categorical fields before filtering or grouping ' +
          '(e.g. "what statuses exist?", "which regions are represented?").',
        inputSchema: {
          type: 'object',
          properties: {
            sourceId: {
              type: 'string',
              description: 'Data source ID from the dashboard state.',
            },
            fieldId: {
              type: 'string',
              description: 'Field ID (column name) to get distinct values for.',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of distinct values to return. Default 50.',
              default: 50,
            },
          },
          required: ['sourceId', 'fieldId'],
        } as Record<string, unknown>,
        annotations: TOOL_ANNOTATIONS.get_field_values,
      });

      tools.push({
        name: 'compute_field_stats',
        title: TOOL_TITLES.compute_field_stats,
        description:
          'Computes accurate min, max, average, sum, and count for one or more numeric fields ' +
          'across the full dataset. More reliable than summarise_page for large tables because ' +
          'it runs a DB-tier aggregation rather than sampling.',
        inputSchema: {
          type: 'object',
          properties: {
            sourceId: {
              type: 'string',
              description: 'Data source ID from the dashboard state.',
            },
            fields: {
              type: 'array',
              items: { type: 'string' },
              description: 'Field IDs (column names) to compute statistics for.',
            },
          },
          required: ['sourceId', 'fields'],
        } as Record<string, unknown>,
        annotations: TOOL_ANNOTATIONS.compute_field_stats,
      });
    }

    tools.push({
      name: 'render_chart',
      title: TOOL_TITLES.render_chart,
      description:
        'Render an arbitrary chart as a standalone SVG image. ' +
        'Useful for visualising query results, comparisons, or any data the model has available. ' +
        'Supported types: "bar", "line", "pie", "scatter", "donut", "stacked_bar". ' +
        'For bar/pie/donut charts provide `data` as an array of { label, value } objects. ' +
        'For single-series line charts use `data`; for multi-series lines/stacked_bar use `xLabels` + `series`. ' +
        'For scatter charts use `xLabels` (x values as strings) and a single series of y-values, or supply ' +
        'two series where series[0] = x-values and series[1] = y-values. ' +
        'The SVG is returned as a base64-encoded image/svg+xml content item.',
      inputSchema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['bar', 'line', 'pie', 'scatter', 'donut', 'stacked_bar'],
            description: 'Chart type.',
          },
          title: { type: 'string', description: 'Optional chart title.' },
          data: {
            type: 'array',
            description: 'Data points for bar, pie, donut, or single-series line/scatter charts.',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                value: { type: 'number' },
              },
              required: ['label', 'value'],
            },
          },
          xLabels: {
            type: 'array',
            items: { type: 'string' },
            description: 'X-axis labels for multi-series line, stacked_bar, and scatter charts.',
          },
          series: {
            type: 'array',
            description: 'Named series for multi-series line, stacked_bar, and scatter charts.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                values: { type: 'array', items: { type: 'number' } },
              },
              required: ['name', 'values'],
            },
          },
          width: { type: 'number', description: 'SVG width in pixels. Default: 600.' },
          height: { type: 'number', description: 'SVG height in pixels. Default: 400.' },
          colors: {
            type: 'array',
            items: { type: 'string' },
            description: 'Custom hex colour palette. Cycles if more series than colours.',
          },
        },
        required: ['type'],
      } as Record<string, unknown>,
      annotations: TOOL_ANNOTATIONS.render_chart,
    });

    return { tools };
  });

  // ── tools/call ───────────────────────────────────────────────────────────

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name: toolName, arguments: args } = request.params;
    const t0 = Date.now();
    logger?.log(`[mcp] ${toolName}`);

    let threw = false;
    try {
      // ── get_dashboard_state — returns full state JSON for MCP context ────
      if (toolName === 'get_dashboard_state') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ output: stateBox.current }),
            },
          ],
        };
      }

      // ── summarise_page — synthesised from live data when data option provided ─
      if (toolName === 'summarise_page') {
        if (!data) {
          // No data access — fall through to executeToolOnState which returns
          // a descriptive error explaining the client-side limitation.
        } else {
          const state = stateBox.current;
          // Accept optional pageId arg; fall back to active page.
          const requestedPageId = (args as { pageId?: string })?.pageId;
          const resolvedPageId = requestedPageId ?? state.dashboard.activePageId;
          const activePage = resolvedPageId ? state.pages[resolvedPageId] : null;

          if (!activePage) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: requestedPageId
                    ? `Page "${requestedPageId}" not found.`
                    : 'No active page found.',
                },
              ],
            };
          }

          const widgetIds = (activePage.widgetRows ?? []).flat();
          const widgets = widgetIds.map((id) => state.widgets[id]).filter(Boolean);
          type SectionItem = { text: string };
          const sections: SectionItem[] = [];

          await Promise.all(
            widgets.map(async (widget) => {
              const sourceId = widget.sourceId;
              if (!sourceId) return;
              const source = state.dataSources[sourceId];
              if (!source?.tableName) return;

              const visibleFields = (source.fields ?? []).filter((f) => !f.hidden);
              const numericFields = visibleFields.filter((f) => f.type === 'number');

              try {
                const isTimeSeries =
                  widget.kind === 'chart' &&
                  Boolean(widget.config.xGroupBy) &&
                  ANOMALY_CHART_TYPES.has(widget.config.chartType ?? 'bar');

                const result = await withTimeout(
                  data.queryDataSource({
                    sourceId,
                    tableName: source.tableName as string,
                    limit: 50,
                  }),
                  15_000,
                  `sample query for ${source.tableName}`,
                );

                const { rows, rowCount } = result;

                // Compute basic stats for numeric fields from the sample rows.
                const stats = numericFields
                  .map((f) => {
                    const values = rows.map((r) => Number(r[f.id])).filter((v) => !Number.isNaN(v));
                    if (values.length === 0) return null;
                    const sum = values.reduce((a, b) => a + b, 0);
                    const min = Math.min(...values);
                    const max = Math.max(...values);
                    const avg = sum / values.length;
                    return `${f.label}: sum=${sum.toLocaleString()}, avg=${avg.toFixed(2)}, min=${min}, max=${max}`;
                  })
                  .filter(Boolean);

                // CSV excerpt — header + first 5 rows.
                const headers = visibleFields.map((f) => f.label);
                const csvRows = rows.slice(0, 5).map((r) =>
                  visibleFields.map((f) => {
                    const v = r[f.id];
                    return v == null ? '' : String(v);
                  }),
                );
                const csv = [headers, ...csvRows].map((row) => row.join('\t')).join('\n');

                const label = widget.title || source.label;
                const lines = [
                  `### ${label} (${rowCount.toLocaleString()} rows)`,
                  ...(stats.length > 0
                    ? [`Stats (from ${rows.length} sample rows): ${stats.join(' | ')}`]
                    : []),
                  '```',
                  csv,
                  '```',
                ];

                // Time-series aggregation: GROUP BY query for anomaly detection and charting.
                // Skip blended charts — the y-field belongs to a different source's table.
                const isBlended = (widget.config.ySeries ?? []).some(
                  (s: any) => s.sourceId && s.sourceId !== widget.sourceId,
                );
                let tsLabels: string[] | null = null;
                let tsValues: number[] | null = null;

                if (isTimeSeries && !isBlended) {
                  const xField = widget.config.xField;
                  const yField =
                    widget.config.yField ??
                    (widget.config.ySeries?.[0]?.fieldId as string | undefined);
                  const yAgg = (widget.config.yAggregation ?? 'sum') as
                    | 'sum'
                    | 'avg'
                    | 'count'
                    | 'min'
                    | 'max';
                  const xGroupBy = widget.config.xGroupBy!;
                  if (xField && yField) {
                    const aggResult = await withTimeout(
                      data.queryDataSource({
                        sourceId,
                        tableName: source.tableName as string,
                        columns: [xField],
                        aggregations: [{ column: yField, func: yAgg, alias: 'y_agg' }],
                        limit: 20000,
                      }),
                      15_000,
                      `aggregation query for ${source.tableName}`,
                    );
                    const grouped = new Map<string, number>();
                    for (const row of aggResult.rows) {
                      const periodKey = mcpTruncateToPeriod(row[xField], xGroupBy);
                      if (!periodKey) continue;
                      grouped.set(
                        periodKey,
                        (grouped.get(periodKey) ?? 0) + Number(row.y_agg ?? 0),
                      );
                    }
                    tsLabels = [...grouped.keys()].sort();
                    tsValues = tsLabels.map((l) => grouped.get(l)!);
                    const outlierIndices = mcpDetectAnomaliesIQR(tsValues);
                    // Trim first and last period (partial periods cause false-positive low outliers).
                    const lastIdx = tsValues.length - 1;
                    const anomalyLabels = [...outlierIndices]
                      .filter((i) => i > 0 && i < lastIdx)
                      .map((i) => tsLabels![i]);
                    if (anomalyLabels.length > 0) {
                      lines.push(`Anomalies detected at: ${anomalyLabels.join(', ')}`);
                    }
                  }
                }

                sections.push({ text: lines.join('\n') });
              } catch (err) {
                logger?.error(
                  `[mcp] summarise_page skipped widget "${widget.title || sourceId}": ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }),
          );

          const pageLabel = activePage.title || resolvedPageId || 'active page';

          if (sections.length === 0) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `No queryable widgets found on page "${pageLabel}".`,
                },
              ],
            };
          }

          // Return the page summary as a single coherent text block: a heading
          // followed by one section per widget. (Splitting into separate content
          // items fragments the summary for MCP clients that render only the first.)
          const summaryText = [`## ${pageLabel}`, ...sections.map((s) => s.text)].join('\n\n');

          return { content: [{ type: 'text' as const, text: summaryText }] };
        }
      }

      // ── query_data_source — routed separately from state-mutation tools ──
      if (toolName === 'query_data_source') {
        if (!data) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error:
                    'query_data_source is not available: this MCP server was started without data access configuration.',
                }),
              },
            ],
            isError: true,
          };
        }

        const { sourceId, columns, filters, aggregations, having, orderBy, limit, offset } =
          (args ?? {}) as {
            sourceId: string;
            columns?: string[];
            filters?: StudioDataFilter[];
            aggregations?: StudioDataAggregation[];
            having?: StudioDataHavingPredicate[];
            orderBy?: StudioDataOrderBy[];
            limit?: number;
            offset?: number;
          };

        const clampedLimit = Math.min(limit ?? MAX_QUERY_ROWS, MAX_QUERY_ROWS);

        if (!sourceId) {
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify({ error: 'sourceId is required' }) },
            ],
            isError: true,
          };
        }

        // Resolve the physical table name from the current dashboard state.
        const source = stateBox.current.dataSources[sourceId];
        const tableName = source?.tableName ?? sourceId;

        try {
          const result = await data.queryDataSource({
            sourceId,
            tableName,
            columns,
            filters,
            aggregations,
            ...(having && having.length > 0 && { having }),
            orderBy,
            limit: clampedLimit,
            ...(offset !== undefined && { offset }),
          });

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ sourceId, ...result }),
              },
            ],
          };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: String(err) }) }],
            isError: true,
          };
        }
      }

      // ── describe_data_source — schema + row count + sample + stats ────────
      if (toolName === 'describe_data_source') {
        if (!data) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ error: 'Data access not configured.' }),
              },
            ],
            isError: true,
          };
        }
        const { sourceId } = (args ?? {}) as { sourceId: string };
        if (!sourceId) {
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify({ error: 'sourceId is required' }) },
            ],
            isError: true,
          };
        }
        const source = stateBox.current.dataSources[sourceId];
        if (!source || !source.tableName) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: `Unknown data source: "${sourceId}". Check studio://dashboard/state for available source IDs.`,
                }),
              },
            ],
            isError: true,
          };
        }
        try {
          const visibleFields = (source.fields ?? []).filter((f) => !f.hidden);
          const numericFields = visibleFields.filter((f) => f.type === 'number');

          // Run sample rows and row count in parallel with per-field numeric stats.
          const [sampleResult, ...statsResults] = await Promise.all([
            data.queryDataSource({ sourceId, tableName: source.tableName as string, limit: 10 }),
            ...numericFields.map((f) =>
              data
                .queryDataSource({
                  sourceId,
                  tableName: source.tableName as string,
                  aggregations: [
                    { column: f.id, func: 'min', alias: 'min' },
                    { column: f.id, func: 'max', alias: 'max' },
                    { column: f.id, func: 'avg', alias: 'avg' },
                    { column: f.id, func: 'sum', alias: 'sum' },
                  ],
                  limit: 1,
                })
                .catch(() => null),
            ),
          ]);

          const fieldStats: Record<
            string,
            { min: unknown; max: unknown; avg: unknown; sum: unknown }
          > = {};
          numericFields.forEach((f, i) => {
            const row = statsResults[i]?.rows?.[0];
            if (row) {
              fieldStats[f.id] = {
                min: row.min,
                max: row.max,
                avg: typeof row.avg === 'number' ? Math.round(row.avg * 100) / 100 : row.avg,
                sum: row.sum,
              };
            }
          });

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    sourceId,
                    label: source.label,
                    tableName: source.tableName,
                    description: source.aiDescription,
                    rowCount: sampleResult.rowCount,
                    fields: visibleFields.map((f) => ({
                      id: f.id,
                      label: f.label,
                      type: f.type,
                      ...(f.format && { format: f.format }),
                      ...(fieldStats[f.id] && { stats: fieldStats[f.id] }),
                      ...(source.fieldDistinctValues?.[f.id] && {
                        sampleValues: source.fieldDistinctValues[f.id].slice(0, 5),
                      }),
                    })),
                    sampleRows: sampleResult.rows,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: String(err) }) }],
            isError: true,
          };
        }
      }

      // ── get_field_values — distinct values + counts ────────────────────────
      if (toolName === 'get_field_values') {
        if (!data) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ error: 'Data access not configured.' }),
              },
            ],
            isError: true,
          };
        }
        const {
          sourceId,
          fieldId,
          limit: fieldLimit,
        } = (args ?? {}) as {
          sourceId: string;
          fieldId: string;
          limit?: number;
        };
        if (!sourceId || !fieldId) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ error: 'sourceId and fieldId are required' }),
              },
            ],
            isError: true,
          };
        }
        const source = stateBox.current.dataSources[sourceId];
        if (!source || !source.tableName) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ error: `Unknown data source: "${sourceId}".` }),
              },
            ],
            isError: true,
          };
        }
        try {
          const clampedFieldLimit = Math.min(fieldLimit ?? 50, 200);
          const result = await data.queryDataSource({
            sourceId,
            tableName: source.tableName as string,
            columns: [fieldId],
            aggregations: [{ column: fieldId, func: 'count', alias: 'count' }],
            orderBy: [{ column: 'count', direction: 'desc' }],
            limit: clampedFieldLimit,
          });
          type GfvContentItem =
            | { type: 'text'; text: string }
            | { type: 'image'; data: string; mimeType: string };
          const gfvItems: GfvContentItem[] = [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  sourceId,
                  fieldId,
                  totalDistinctValues: result.rowCount,
                  values: result.rows,
                },
                null,
                2,
              ),
            },
          ];
          // Auto-render a bar chart of the top values (best-effort).
          const chartData = result.rows.slice(0, 20).map((r) => ({
            label: String(r[fieldId] ?? '(null)'),
            value: Number(r.count ?? 0),
          }));
          if (chartData.length >= 2) {
            try {
              const fieldLabel =
                stateBox.current.dataSources[sourceId]?.fields?.find((f) => f.id === fieldId)
                  ?.label ?? fieldId;
              const svg = renderChartSvg({
                type: 'bar',
                title: `${fieldLabel} distribution`,
                data: chartData,
              });
              gfvItems.push({
                type: 'image',
                data: Buffer.from(svg).toString('base64'),
                mimeType: 'image/svg+xml',
              });
            } catch {
              // Chart rendering is best-effort.
            }
          }
          return { content: gfvItems };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: String(err) }) }],
            isError: true,
          };
        }
      }

      // ── compute_field_stats — full-table min/max/avg/sum/count ────────────
      if (toolName === 'compute_field_stats') {
        if (!data) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ error: 'Data access not configured.' }),
              },
            ],
            isError: true,
          };
        }
        const { sourceId, fields: statFields } = (args ?? {}) as {
          sourceId: string;
          fields: string[];
        };
        if (!sourceId || !statFields || statFields.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: 'sourceId and fields (non-empty array) are required',
                }),
              },
            ],
            isError: true,
          };
        }
        const source = stateBox.current.dataSources[sourceId];
        if (!source || !source.tableName) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ error: `Unknown data source: "${sourceId}".` }),
              },
            ],
            isError: true,
          };
        }
        try {
          const aggregations = statFields.flatMap((f) => [
            { column: f, func: 'min' as const, alias: `${f}__min` },
            { column: f, func: 'max' as const, alias: `${f}__max` },
            { column: f, func: 'avg' as const, alias: `${f}__avg` },
            { column: f, func: 'sum' as const, alias: `${f}__sum` },
            { column: f, func: 'count' as const, alias: `${f}__count` },
          ]);
          const result = await data.queryDataSource({
            sourceId,
            tableName: source.tableName as string,
            aggregations,
            limit: 1,
          });
          const row = result.rows[0] ?? {};
          const statsOut: Record<
            string,
            { min: unknown; max: unknown; avg: unknown; sum: unknown; count: unknown }
          > = {};
          for (const f of statFields) {
            statsOut[f] = {
              min: row[`${f}__min`],
              max: row[`${f}__max`],
              avg:
                typeof row[`${f}__avg`] === 'number'
                  ? Math.round((row[`${f}__avg`] as number) * 100) / 100
                  : row[`${f}__avg`],
              sum: row[`${f}__sum`],
              count: row[`${f}__count`],
            };
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ sourceId, stats: statsOut }, null, 2),
              },
            ],
          };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: String(err) }) }],
            isError: true,
          };
        }
      }

      // ── render_chart — pure SVG chart rendering ───────────────────────────
      if (toolName === 'render_chart') {
        try {
          const chartInput = (args ?? {}) as unknown as ChartRendererInput;
          if (!chartInput.type) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    error: '`type` is required (bar, line, pie, scatter, donut, or stacked_bar).',
                  }),
                },
              ],
              isError: true,
            };
          }
          const svgString = renderChartSvg(chartInput);
          const base64 = Buffer.from(svgString).toString('base64');
          return {
            content: [
              {
                type: 'image' as const,
                data: base64,
                mimeType: 'image/svg+xml',
              },
              {
                type: 'text' as const,
                text: svgString,
              },
            ],
          };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: String(err) }) }],
            isError: true,
          };
        }
      }

      // ── dashboard-mutation tools ──────────────────────────────────────────

      if (!toolsToRegister.some((t) => t.function.name === toolName)) {
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ error: `Unknown tool: ${toolName}` }) },
          ],
          isError: true,
        };
      }

      try {
        const result = executeToolOnState(toolName, args ?? {}, stateBox.current, customWidgets);
        // Persist the updated state — next tool call in this session sees it.
        stateBox.current = result.nextState;

        // Notify any subscribed clients that the dashboard state has changed.
        if (result.mutation) {
          const urisToNotify = ['studio://dashboard/state', 'studio://dashboard/system-prompt'];
          for (const uri of urisToNotify) {
            if (subscribedUris.has(uri)) {
              server.sendResourceUpdated({ uri }).catch(() => {
                // Swallow errors — client may have disconnected
              });
            }
          }
          // Notify consumer so they can persist the new state.
          await onStateChange?.(stateBox.current);
        }

        const responsePayload: Record<string, unknown> = { output: result.output };
        if (result.mutation) {
          responsePayload.mutation = result.mutation;
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(responsePayload) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: String(err) }) }],
          isError: true,
        };
      }
    } catch (err) {
      threw = true;
      logger?.error(
        `[mcp] ${toolName} threw after ${Date.now() - t0}ms: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: String(err) }) }],
        isError: true,
      };
    } finally {
      if (!threw) {
        logger?.log(`[mcp] ${toolName} — ${Date.now() - t0}ms`);
      }
    }
  });

  // ── resources/list ───────────────────────────────────────────────────────

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const sources = Object.values(stateBox.current.dataSources).filter((s) => !s.hidden);

    const schemaResources = sources.map((s) => ({
      uri: `studio://schema/${s.id}`,
      name: `${s.label} Schema`,
      description: `Field definitions for the ${s.label} data source (sourceId: "${s.id}").`,
      mimeType: 'application/json',
    }));

    const dataResources = data
      ? sources
          .filter((s) => s.tableName)
          .map((s) => ({
            uri: `studio://data/${s.id}`,
            name: `${s.label} Preview`,
            description:
              `Raw row preview for the ${s.label} data source (up to 20 rows). ` +
              `Use query_data_source for filtered/aggregated queries.`,
            mimeType: 'application/json',
          }))
      : [];

    const staticResources = [
      {
        uri: 'studio://dashboard/state',
        name: 'Dashboard State',
        description:
          'The current x-studio dashboard state: pages, widgets, data sources, filters, and layout.',
        mimeType: 'application/json',
      },
      {
        uri: 'studio://dashboard/system-prompt',
        name: 'AI System Prompt',
        description:
          'The x-studio AI assistant system prompt, grounded in the current dashboard state. ' +
          'Useful for understanding the current context when building prompts.',
        mimeType: 'text/plain',
      },
      ...(data
        ? [
            {
              uri: 'studio://dashboard/data-health',
              name: 'Data Health',
              description:
                'Row counts for all configured data sources. ' +
                'Read this before querying to understand data scale.',
              mimeType: 'application/json',
            },
          ]
        : []),
    ];

    return { resources: [...staticResources, ...schemaResources, ...dataResources] };
  });

  // ── resources/read ───────────────────────────────────────────────────────

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    if (uri === 'studio://dashboard/state') {
      return {
        contents: [
          {
            uri,
            text: JSON.stringify(stateBox.current, null, 2),
            mimeType: 'application/json',
          },
        ],
      };
    }

    if (uri === 'studio://dashboard/system-prompt') {
      const dataToolNames = data
        ? ['query_data_source', 'describe_data_source', 'get_field_values', 'compute_field_stats']
        : undefined;
      return {
        contents: [
          {
            uri,
            text: buildAISystemPrompt(stateBox.current, customWidgets, undefined, undefined, {
              availableDataTools: dataToolNames,
            }),
            mimeType: 'text/plain',
          },
        ],
      };
    }

    if (uri === 'studio://dashboard/data-health') {
      if (!data) {
        throw new Error('Data access is not configured for this MCP server instance.');
      }
      const counts: Record<string, number> = {};
      const errors: Record<string, string> = {};
      await Promise.all(
        Object.values(stateBox.current.dataSources)
          .filter((s) => !s.hidden && s.tableName)
          .map(async (s) => {
            try {
              const result = await data.queryDataSource({
                sourceId: s.id,
                tableName: s.tableName as string,
                aggregations: [{ column: '*', func: 'count', alias: 'count' }],
                limit: 1,
              });
              const row = result.rows[0];
              counts[s.id] = Number(row?.count ?? result.rowCount ?? 0);
            } catch (err) {
              errors[s.id] = String(err);
            }
          }),
      );
      return {
        contents: [
          {
            uri,
            text: JSON.stringify(
              { counts, ...(Object.keys(errors).length > 0 && { errors }) },
              null,
              2,
            ),
            mimeType: 'application/json',
          },
        ],
      };
    }

    // studio://schema/{sourceId} — field metadata for a specific source
    if (uri.startsWith('studio://schema/')) {
      const sourceId = uri.slice('studio://schema/'.length);
      const source = stateBox.current.dataSources[sourceId];
      if (!source) {
        throw new Error(
          `Unknown data source: "${sourceId}". Check studio://dashboard/state for available source IDs.`,
        );
      }
      const visibleFields = source.fields.filter((f) => !f.hidden);
      return {
        contents: [
          {
            uri,
            text: JSON.stringify(
              {
                id: source.id,
                label: source.label,
                tableName: source.tableName,
                description: source.aiDescription,
                fields: visibleFields.map((f) => ({
                  id: f.id,
                  label: f.label,
                  type: f.type,
                  ...(f.format && { format: f.format }),
                  ...(f.capabilities?.length && { capabilities: f.capabilities }),
                  ...(f.defaultAggregationFn && { defaultAggregationFn: f.defaultAggregationFn }),
                  ...(f.aiDescription && { description: f.aiDescription }),
                  ...(source.fieldDistinctValues?.[f.id] && {
                    sampleValues: source.fieldDistinctValues[f.id].slice(0, 8),
                  }),
                  serialized: serializeFieldForAI(f, source.fieldDistinctValues?.[f.id]),
                })),
              },
              null,
              2,
            ),
            mimeType: 'application/json',
          },
        ],
      };
    }

    // studio://data/{sourceId} — raw row preview (up to 20 rows)
    if (uri.startsWith('studio://data/')) {
      if (!data) {
        throw new Error('Data access is not configured for this MCP server instance.');
      }
      const sourceId = uri.slice('studio://data/'.length);
      const source = stateBox.current.dataSources[sourceId];
      if (!source || !source.tableName) {
        throw new Error(
          `Unknown data source: "${sourceId}". Check studio://dashboard/state for available source IDs.`,
        );
      }
      const result = await data.queryDataSource({
        sourceId,
        tableName: source.tableName as string,
        limit: 20,
      });
      return {
        contents: [
          {
            uri,
            text: JSON.stringify(
              { sourceId, label: source.label, rowCount: result.rowCount, rows: result.rows },
              null,
              2,
            ),
            mimeType: 'application/json',
          },
        ],
      };
    }

    throw new Error(
      `Unknown resource URI: "${uri}". Use resources/list to discover available URIs.`,
    );
  });

  server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    const { uri } = request.params;
    subscribedUris.add(uri);
    // Immediately notify so clients that wait for a push before reading (e.g. the
    // MCP Inspector in proxy mode) get the current value right after subscribing.
    server.sendResourceUpdated({ uri }).catch(() => {});
    return {};
  });

  server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    subscribedUris.delete(request.params.uri);
    return {};
  });

  // ── prompts/list + prompts/get ────────────────────────────────────────────

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: 'query_data_source_examples',
        description:
          'Example `query_data_source` invocations for a data source. ' +
          'Pass a sourceId to focus on one source, or omit to see all.',
        arguments: [
          {
            name: 'sourceId',
            description:
              'ID of the data source to show examples for (e.g. "source-orders"). ' +
              'Omit to include all configured sources.',
            required: false,
          },
        ],
      },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: promptArgs } = request.params;

    if (name === 'query_data_source_examples') {
      const requestedId = promptArgs?.sourceId;
      const allSources = Object.values(stateBox.current.dataSources).filter(
        (s) => !s.hidden && s.tableName,
      );

      if (requestedId && !allSources.some((s) => s.id === requestedId)) {
        throw new Error(
          `Unknown sourceId: "${requestedId}". ` +
            `Available: ${allSources.map((s) => s.id).join(', ')}.`,
        );
      }

      const sources = requestedId ? allSources.filter((s) => s.id === requestedId) : allSources;

      const exampleBlocks = sources.map((s) => {
        const numericField = s.fields.find(
          (f) => !f.hidden && f.type === 'number' && !f.capabilities?.includes('categorical'),
        );
        const categoricalField = s.fields.find(
          (f) => !f.hidden && (f.type === 'string' || f.capabilities?.includes('categorical')),
        );

        const countExample = categoricalField
          ? {
              sourceId: s.id,
              columns: [categoricalField.id],
              aggregations: [{ column: categoricalField.id, func: 'count', alias: 'count' }],
              orderBy: [{ column: 'count', direction: 'desc' }],
              limit: 10,
              _desc: `Count of ${s.label} by ${categoricalField.label}`,
            }
          : null;

        const sumExample =
          numericField && categoricalField
            ? {
                sourceId: s.id,
                columns: [categoricalField.id],
                aggregations: [
                  {
                    column: numericField.id,
                    func: numericField.defaultAggregationFn ?? 'sum',
                    alias: numericField.id,
                  },
                ],
                orderBy: [{ column: numericField.id, direction: 'desc' }],
                limit: 10,
                _desc: `${numericField.defaultAggregationFn ?? 'Sum'} of ${numericField.label} by ${categoricalField.label}`,
              }
            : null;

        const queries = [countExample, sumExample].filter(
          (q): q is NonNullable<typeof q> => q !== null,
        );
        const lines = queries.map(({ _desc, ...params }) => {
          return `- ${_desc}\n\`\`\`json\n${JSON.stringify(params, null, 2)}\n\`\`\``;
        });
        return `### ${s.label} (sourceId: "${s.id}")\n${lines.join('\n')}`;
      });

      const subject =
        sources.length === 1
          ? `the **${sources[0].label}** data source`
          : `${sources.length} data source${sources.length !== 1 ? 's' : ''}`;

      const assistantText =
        `I have access to ${subject} and can query ${sources.length === 1 ? 'it' : 'them'} ` +
        `using the \`query_data_source\` tool. Here are some example queries to get started:\n\n` +
        `${exampleBlocks.join('\n\n')}\n\n` +
        `Adapt these by changing \`columns\`, \`aggregations\`, \`filters\`, and \`orderBy\` as needed.`;

      const userText =
        sources.length === 1
          ? `Help me explore the ${sources[0].label} data.`
          : `Help me explore the data.`;

      return {
        description:
          sources.length === 1
            ? `Example queries for the ${sources[0].label} data source`
            : 'Example queries for all configured data sources',
        messages: [
          {
            role: 'assistant' as const,
            content: { type: 'text' as const, text: assistantText },
          },
          {
            role: 'user' as const,
            content: { type: 'text' as const, text: userText },
          },
        ],
      };
    }

    throw new Error(`Unknown prompt: "${name}".`);
  });

  // ── completion/complete — URI autocomplete ────────────────────────────────
  // Returns sourceId completions when clients type studio://schema/ or studio://data/.

  server.setRequestHandler(CompleteRequestSchema, async (request) => {
    const { ref, argument } = request.params;

    // Prompt argument autocomplete: sourceId for query_data_source_examples
    if (
      ref.type === 'ref/prompt' &&
      ref.name === 'query_data_source_examples' &&
      argument.name === 'sourceId'
    ) {
      const partial = argument.value ?? '';
      const matches = Object.values(stateBox.current.dataSources)
        .filter((s) => !s.hidden && s.tableName && s.id.startsWith(partial))
        .map((s) => s.id);
      return { completion: { values: matches, total: matches.length, hasMore: false } };
    }

    // Only handle resource template completions below
    if (ref.type !== 'ref/resource') {
      return { completion: { values: [], total: 0, hasMore: false } };
    }
    // argument.value is the partial string the user has typed so far
    const partial = argument.value ?? '';
    const sourceIds = Object.keys(stateBox.current.dataSources).filter(
      (id) => !stateBox.current.dataSources[id].hidden,
    );

    let matches: string[] = [];
    if (ref.uri.startsWith('studio://schema/') || partial.startsWith('studio://schema/')) {
      const fragment = partial.startsWith('studio://schema/')
        ? partial.slice('studio://schema/'.length)
        : partial;
      matches = sourceIds
        .filter((id) => id.startsWith(fragment))
        .map((id) => `studio://schema/${id}`);
    } else if (ref.uri.startsWith('studio://data/') || partial.startsWith('studio://data/')) {
      const fragment = partial.startsWith('studio://data/')
        ? partial.slice('studio://data/'.length)
        : partial;
      matches = sourceIds
        .filter((id) => id.startsWith(fragment) && stateBox.current.dataSources[id].tableName)
        .map((id) => `studio://data/${id}`);
    }

    return { completion: { values: matches, total: matches.length, hasMore: false } };
  });

  return server;
}
