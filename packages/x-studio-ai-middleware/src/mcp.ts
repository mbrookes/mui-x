/**
 * MCP (Model Context Protocol) server factory for @mui/x-studio-ai-middleware.
 *
 * Provides `buildStudioMcpServer`, a framework-agnostic factory that creates a
 * pre-configured `McpServer` with all 16 x-studio AI tools registered and the
 * current dashboard state exposed as an MCP resource.
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
} from '@modelcontextprotocol/sdk/types.js';
import { STUDIO_AI_TOOLS } from './studioAITools';
import { executeToolOnState } from './executeToolOnState';
import { buildAISystemPrompt } from './buildAISystemPrompt';
import type { StudioState, StudioCustomWidgetDef } from './models/studioTypes';

export type { StudioState, StudioCustomWidgetDef };

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
   * When omitted, all tools except `summarise_page` are registered.
   * `summarise_page` requires live row data not available server-side; pass it
   * explicitly in `allowedTools` only if you have a custom handler for it.
   */
  allowedTools?: string[];
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
// Tools excluded from MCP by default
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tools that are registered in STUDIO_AI_TOOLS but are not suitable for MCP
 * because they require live widget row data only available client-side.
 */
const DEFAULT_EXCLUDED_TOOLS = new Set(['summarise_page']);

// ─────────────────────────────────────────────────────────────────────────────
// Core: build a McpServer bound to a specific session's state box
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a pre-configured `McpServer` with all x-studio AI tools registered.
 *
 * Each tool handler delegates to `executeToolOnState` (the same pure function
 * used by the AI agentic loop), which returns `{ output, mutation?, nextState }`.
 * The handler writes `nextState` back to `stateBox.current` so subsequent tool
 * calls in the same session see the updated dashboard state.
 *
 * The server also registers two readable MCP resources:
 * - `studio://dashboard/state` — the full `StudioState` JSON
 * - `studio://dashboard/system-prompt` — the AI system prompt built from current state
 *
 * @param stateBox  A boxed `StudioState` reference, shared across all tool handlers.
 *                  Typically `{ current: createDefaultStudioState() }` or loaded from a DB.
 * @param options   Optional configuration (server name/version, custom widgets, allowed tools).
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
  } = options;

  const server = new Server(
    { name: serverName, version: serverVersion },
    { capabilities: { tools: {}, resources: {} } },
  );

  // Determine which tools to expose.
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

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolsToRegister.map((toolDef) => ({
      name: toolDef.function.name,
      description: toolDef.function.description,
      // STUDIO_AI_TOOLS parameters are standard JSON Schema objects — pass through directly.
      inputSchema: toolDef.function.parameters as Record<string, unknown>,
    })),
  }));

  // ── tools/call ───────────────────────────────────────────────────────────

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name: toolName, arguments: args } = request.params;

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

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
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
    ],
  }));

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

    throw new Error(`Unknown resource URI: ${uri}`);
  });

  return server;
}
