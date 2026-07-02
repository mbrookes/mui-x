/**
 * MCP (Model Context Protocol) server factory for @mui/x-studio-ai-middleware.
 *
 * Provides `buildStudioMcpServer`, a framework-agnostic factory that creates a
 * pre-configured MCP `Server` with all x-studio AI tools registered and the
 * current dashboard state exposed as MCP resources.
 *
 * This file is the **composition root**: it creates the `Server`, holds the
 * `StudioStateBox` and the session-scoped mutable state (recent-changes log,
 * subscribed URIs), and wires in the handlers extracted into the `mcp/`
 * subdirectory:
 *
 * - `mcp/toolMetadata.ts` — tool titles/annotations + tool-list definitions
 * - `mcp/dataTools.ts` — data-query, chart, and summarise-page tool handlers
 * - `mcp/resources.ts` — resource list/read/subscribe/unsubscribe handlers
 * - `mcp/prompts.ts` — prompt list/get + completion handlers
 * - `mcp/helpers.ts` — `errorResult`/`jsonResult` result shapes + `ToolHandler`
 * - `mcp/types.ts` — the public types re-exported below
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
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mutationLabel } from '@mui/x-studio-schema';
import { STUDIO_AI_TOOLS } from './studioAITools';
import { executeToolOnState } from './executeToolOnState';
import type { StudioAIRecentMutation } from './models/aiTypes';
import { errorResult, jsonResult, type ToolHandler } from './mcp/helpers';
import {
  TOOL_TITLES,
  TOOL_ANNOTATIONS,
  DATA_TOOL_DEFINITIONS,
  EXTRA_TOOL_DEFINITIONS,
} from './mcp/toolMetadata';
import { createDataToolHandlers, createSummarisePageHandler } from './mcp/dataTools';
import { registerResourceHandlers } from './mcp/resources';
import { registerPromptHandlers } from './mcp/prompts';
import type { StudioMcpOptions, StudioStateBox } from './mcp/types';

// Re-export the public types so the package entry point (`from './mcp'`) is unchanged.
export type {
  StudioState,
  StudioDataFilter,
  StudioDataAggregation,
  StudioDataOrderBy,
  StudioDataHavingPredicate,
  StudioDataQueryParams,
  StudioDataQueryResult,
  StudioMcpOptions,
  StudioStateBox,
} from './mcp/types';

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
    onStateChange,
    logger,
    contextEnricher,
  } = options;

  const MAX_QUERY_ROWS = data?.maxQueryRows ?? 1000;

  // Session-scoped log of recent state mutations (oldest first), surfaced via the
  // `get_recent_changes` tool. Only captures changes made through this MCP
  // session — not edits a user makes in a separate browser session.
  const MAX_RECENT_CHANGES = 20;
  const recentChanges: StudioAIRecentMutation[] = [];

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
    const builtinTools = toolsToRegister.map((toolDef) => ({
      name: toolDef.function.name,
      title: TOOL_TITLES[toolDef.function.name],
      description: toolDef.function.description,
      // STUDIO_AI_TOOLS parameters are standard JSON Schema objects — pass through directly.
      inputSchema: toolDef.function.parameters as Record<string, unknown>,
      annotations: TOOL_ANNOTATIONS[toolDef.function.name],
    }));

    return {
      tools: [...builtinTools, ...(data ? DATA_TOOL_DEFINITIONS : []), ...EXTRA_TOOL_DEFINITIONS],
    };
  });

  // ── tools/call ───────────────────────────────────────────────────────────
  //
  // Special-cased tools (data queries, chart rendering, dashboard reads, and —
  // when data is configured — `summarise_page`) are looked up in this dispatch
  // table. Everything else falls through to the shared `executeToolOnState`
  // mutation path below, so adding a data tool is a table entry, not a new
  // branch in a long if-chain.
  const toolHandlers: Record<string, ToolHandler> = {
    // ── get_dashboard_state — returns the raw StudioState ───────────────
    // Canonical output contract shared with the chat path (see
    // executeToolOnState.ts `get_dashboard_state`): both transports return the
    // raw `StudioState` so the tool means the same thing on both surfaces.
    get_dashboard_state: () => jsonResult({ output: stateBox.current }),
    ...createDataToolHandlers({
      stateBox,
      data,
      maxQueryRows: MAX_QUERY_ROWS,
      recentChanges,
      logger,
    }),
  };

  // summarise_page is only special-cased when data access is configured; without
  // it, the tool falls through to executeToolOnState, which returns a descriptive
  // error explaining the client-side limitation.
  if (data) {
    toolHandlers.summarise_page = createSummarisePageHandler({ stateBox, data, logger });
  }

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name: toolName, arguments: args } = request.params;
    const t0 = Date.now();
    logger?.log(`[mcp] ${toolName}`);

    let threw = false;
    try {
      const handler = toolHandlers[toolName];
      if (handler) {
        return await handler(args);
      }

      // ── dashboard-mutation tools ──────────────────────────────────────────

      if (!toolsToRegister.some((t) => t.function.name === toolName)) {
        return errorResult(`Unknown tool: ${toolName}`);
      }

      try {
        const result = executeToolOnState(toolName, args ?? {}, stateBox.current, customWidgets);
        // Persist the updated state — next tool call in this session sees it.
        stateBox.current = result.nextState;

        // Notify any subscribed clients that the dashboard state has changed.
        if (result.mutation) {
          // Record the change in the session-scoped log surfaced by get_recent_changes.
          recentChanges.push({
            label: mutationLabel(result.mutation),
            at: new Date().toISOString(),
          });
          if (recentChanges.length > MAX_RECENT_CHANGES) {
            recentChanges.shift();
          }

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

        return jsonResult(responsePayload);
      } catch (err) {
        return errorResult(String(err));
      }
    } catch (err) {
      threw = true;
      logger?.error(
        `[mcp] ${toolName} threw after ${Date.now() - t0}ms: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
      return errorResult(String(err));
    } finally {
      if (!threw) {
        logger?.log(`[mcp] ${toolName} — ${Date.now() - t0}ms`);
      }
    }
  });

  // ── resources/* and prompts/* + completion/* ──────────────────────────────

  registerResourceHandlers(server, {
    stateBox,
    data,
    customWidgets,
    contextEnricher,
    logger,
    subscribedUris,
  });

  registerPromptHandlers(server, { stateBox });

  return server;
}
