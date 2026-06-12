/**
 * MCP (Model Context Protocol) server factory for @mui/x-studio-ai-middleware.
 *
 * Provides `buildStudioMcpServer`, a framework-agnostic factory that creates a
 * pre-configured `McpServer` with all x-studio AI tools registered and the
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
} from '@modelcontextprotocol/sdk/types.js';
import { STUDIO_AI_TOOLS } from './studioAITools';
import { executeToolOnState } from './executeToolOnState';
import { buildAISystemPrompt } from './buildAISystemPrompt';
import { serializeFieldForAI } from './buildAISystemPrompt';
import type { StudioState, StudioCustomWidgetDef } from './models/studioTypes';

export type { StudioState, StudioCustomWidgetDef };

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
  /** Sort order. */
  orderBy?: StudioDataOrderBy[];
  /** Maximum rows to return. Default 1000. */
  limit?: number;
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
   * When omitted, all tools except `summarise_page` and `execute_query` are registered.
   * - `summarise_page` requires live row data only available client-side.
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
     */
    queryDataSource: (params: StudioDataQueryParams) => Promise<StudioDataQueryResult>;
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
  'summarise_page',
  // execute_query runs raw SQL against a live DB connection — not safe to expose
  // via MCP without explicit opt-in. Add it to allowedTools if you need it.
  'execute_query',
]);

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
  },
  required: ['sourceId'],
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Core factory
// ─────────────────────────────────────────────────────────────────────────────

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
  } = options;

  const server = new Server(
    { name: serverName, version: serverVersion },
    {
      capabilities: {
        tools: {},
        prompts: {},
        resources: {
          subscribe: true,      // clients can subscribe to specific resource URIs
          listChanged: true,    // server can notify when resource list changes
        },
        completions: {},        // enables URI-template variable autocomplete
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
    const tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> =
      toolsToRegister.map((toolDef) => ({
      name: toolDef.function.name,
      description: toolDef.function.description,
      // STUDIO_AI_TOOLS parameters are standard JSON Schema objects — pass through directly.
      inputSchema: toolDef.function.parameters as Record<string, unknown>,
    }));

    if (data) {
      tools.push({
        name: 'query_data_source',
        description:
          'Query a data source (database table) with structured filters, aggregations, and sorting. ' +
          'Use this to retrieve data rows, compute aggregates (totals, averages, counts by group), ' +
          'or explore the underlying data before configuring widgets. ' +
          'Results are read-only — this tool never modifies data. ' +
          'Tip: use the studio://dashboard/state resource to discover available sourceIds and field names.',
        inputSchema: QUERY_DATA_SOURCE_SCHEMA as unknown as Record<string, unknown>,
      });
    }

    return { tools };
  });

  // ── tools/call ───────────────────────────────────────────────────────────

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name: toolName, arguments: args } = request.params;

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

      const { sourceId, columns, filters, aggregations, orderBy, limit = 1000 } = (args ?? {}) as {
        sourceId: string;
        columns?: string[];
        filters?: StudioDataFilter[];
        aggregations?: StudioDataAggregation[];
        orderBy?: StudioDataOrderBy[];
        limit?: number;
      };

      if (!sourceId) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'sourceId is required' }) }],
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
          orderBy,
          limit,
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

    // ── dashboard-mutation tools ──────────────────────────────────────────

    if (!toolsToRegister.some((t) => t.function.name === toolName)) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: `Unknown tool: ${toolName}` }) }],
        isError: true,
      };
    }

    try {
      const result = executeToolOnState(toolName, args ?? {}, stateBox.current, customWidgets);
      // Persist the updated state — next tool call in this session sees it.
      stateBox.current = result.nextState;

      // Notify any subscribed clients that the dashboard state has changed.
      if (result.mutation) {
        const urisToNotify = [
          'studio://dashboard/state',
          'studio://dashboard/system-prompt',
        ];
        for (const uri of urisToNotify) {
          if (subscribedUris.has(uri)) {
            server.sendResourceUpdated({ uri }).catch(() => {
              // Swallow errors — client may have disconnected
            });
          }
        }
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
      return {
        contents: [
          {
            uri,
            text: buildAISystemPrompt(stateBox.current, customWidgets),
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
        throw new Error(`Unknown data source: "${sourceId}". Check studio://dashboard/state for available source IDs.`);
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

    throw new Error(`Unknown resource URI: "${uri}". Use resources/list to discover available URIs.`);
  });

  server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    subscribedUris.add(request.params.uri);
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
          'Example invocations of the query_data_source tool for each configured data source. ' +
          'Useful for bootstrapping queries without needing to inspect the schema first.',
        arguments: [],
      },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name } = request.params;

    if (name === 'query_data_source_examples') {
      const sources = Object.values(stateBox.current.dataSources).filter((s) => !s.hidden && s.tableName);
      const examples = sources.map((s) => {
        // Pick a numeric field and a categorical xField for a count example
        const numericField = s.fields.find((f) => !f.hidden && f.type === 'number' && !f.capabilities?.includes('categorical'));
        const categoricalField = s.fields.find((f) => !f.hidden && (f.type === 'string' || f.capabilities?.includes('categorical')));

        const countExample = categoricalField
          ? {
              sourceId: s.id,
              columns: [categoricalField.id],
              aggregations: [{ column: categoricalField.id, func: 'count', alias: 'count' }],
              orderBy: [{ column: 'count', direction: 'desc' }],
              limit: 10,
              description: `Count of ${s.label} by ${categoricalField.label}`,
            }
          : null;

        const sumExample =
          numericField && categoricalField
            ? {
                sourceId: s.id,
                columns: [categoricalField.id],
                aggregations: [
                  { column: numericField.id, func: numericField.defaultAggregationFn ?? 'sum', alias: numericField.id },
                ],
                orderBy: [{ column: numericField.id, direction: 'desc' }],
                limit: 10,
                description: `${numericField.defaultAggregationFn ?? 'Sum'} of ${numericField.label} by ${categoricalField.label}`,
              }
            : null;

        const examples2 = [countExample, sumExample].filter(Boolean);
        return `### ${s.label} (sourceId: "${s.id}")\n${examples2.map((ex) => `- ${ex!.description}\n\`\`\`json\n${JSON.stringify({ ...ex, description: undefined }, null, 2)}\n\`\`\``).join('\n')}`;
      });

      return {
        description: 'Example query_data_source invocations for all configured data sources',
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text:
                'Here are example `query_data_source` invocations for each data source:\n\n' +
                examples.join('\n\n') +
                '\n\nAdapt these by changing `columns`, `aggregations`, `filters`, and `orderBy` as needed.',
            },
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
    // Only handle resource template completions
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
