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
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mutationLabel, STUDIO_AI_TOOL_REGISTRY } from '@mui/x-studio-schema';
import { STUDIO_AI_TOOLS } from './studioAITools';
import type { ToolExecutionResult } from './executeToolOnState';
import { executeToolWithPolicy, type ToolPolicy } from './toolPolicy';
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
 * Tools declared in STUDIO_AI_TOOLS that have **no functional MCP handler** and
 * are therefore never registered on the MCP surface — regardless of whether the
 * host lists them in `allowedTools`.
 *
 * `execute_query` runs arbitrary SQL. On the chat path it is backed by
 * `options.dataResolver` (an app-supplied `resolve(query, sourceId)` function),
 * but `StudioMcpOptions` has no equivalent resolver hook — `options.data` only
 * exposes structured `queryDataSource(params)`, not arbitrary SQL — and no
 * dispatch branch handles `execute_query` in this composition root. Advertising
 * it as opt-in-able via `allowedTools` was a dead end: an opted-in call fell
 * through to `executeToolOnState`'s default case and returned
 * `{"error":"Unknown tool: execute_query"}`. Until an MCP resolver hook exists it
 * is excluded unconditionally, so `tools/list` never advertises it and a
 * `tools/call` for it is rejected as `Unknown tool`. The chat loop's use of
 * `execute_query` via `dataResolver` is unaffected.
 *
 * Derived from `STUDIO_AI_TOOL_REGISTRY`'s `mcpSupported` fact
 * (`@mui/x-studio-schema`) rather than hand-maintained here, so this set can't
 * silently drift from the registry.
 */
const MCP_UNSUPPORTED_TOOLS = new Set(
  Object.entries(STUDIO_AI_TOOL_REGISTRY)
    .filter(([, facts]) => !facts.mcpSupported)
    .map(([name]) => name),
);

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
    approvalHandler,
    rateLimit,
  } = options;

  const MAX_QUERY_ROWS = data?.maxQueryRows ?? 1000;

  // Session-scoped usage, threaded into the policy context. `committedMutations` is
  // bumped only when a mutation is actually committed to `stateBox.current`.
  const sessionUsage = { committedMutations: 0, toolCalls: 0 };

  // CRITICAL compatibility default: when the host omits `toolPolicy`, the policy is
  // ALLOW-ALL — NOT `createDefaultToolPolicy()`. MCP has no approval-pause channel
  // today, so defaulting to require-approval for `remove_page` etc. would break every
  // existing MCP integration. This keeps the historical "execute everything" behavior.
  const hostToolPolicy: ToolPolicy = options.toolPolicy ?? (() => ({ action: 'allow' }));

  // Per-session mutation budget, layered BEFORE the host policy: once the cap is
  // reached, any further mutating call (one whose dry-run produced a `proposed`
  // mutation) is denied without consulting the host policy. `onLimitReached` fires
  // once per breach.
  const maxSessionMutations = rateLimit?.maxMutationsPerSession;
  let mutationLimitFired = false;
  const sessionToolPolicy: ToolPolicy = (ctx) => {
    if (
      ctx.proposed &&
      maxSessionMutations !== undefined &&
      sessionUsage.committedMutations >= maxSessionMutations
    ) {
      if (!mutationLimitFired) {
        mutationLimitFired = true;
        rateLimit?.onLimitReached?.('mutations', sessionUsage.committedMutations);
      }
      return {
        action: 'deny',
        reason:
          'MUI X Studio: Mutation budget exceeded — this MCP session may commit at most ' +
          `${maxSessionMutations} state mutation${maxSessionMutations === 1 ? '' : 's'} ` +
          `(already committed ${sessionUsage.committedMutations}). This change was not applied.`,
      };
    }
    return hostToolPolicy(ctx);
  };

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
  // - Tools with no functional MCP handler (`MCP_UNSUPPORTED_TOOLS`) are never
  //   registered, even if the host lists them in `allowedTools` — there is
  //   nothing to dispatch them to, so advertising them would only dead-end.
  // - If allowedTools is provided, use that exact list (caller takes responsibility).
  const toolsToRegister = STUDIO_AI_TOOLS.filter((toolDef) => {
    const name = toolDef.function.name;
    if (MCP_UNSUPPORTED_TOOLS.has(name)) {
      return false;
    }
    if (allowedTools) {
      return allowedTools.includes(name);
    }
    return true;
  });

  // Names of every STUDIO_AI_TOOL, used to enforce `allowedTools` gating before
  // the special-case dispatch table (T1-3). Tools outside this set (render_chart,
  // get_recent_changes, data-query tools) are always-available by design.
  const studioAiToolNames = new Set<string>(STUDIO_AI_TOOLS.map((t) => t.function.name));
  const registeredToolNames = new Set<string>(toolsToRegister.map((t) => t.function.name));

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

  /**
   * Commit a policy-cleared tool result to the session: write `nextState` back into
   * the box, record + notify the mutation, and run the host's `onStateChange`
   * persistence hook. This runs ONLY on allow / approved-true — the exact steps that
   * previously ran unconditionally, now gated behind the policy chokepoint.
   */
  async function commitMutation(
    result: ToolExecutionResult,
    toolName: string,
  ): Promise<CallToolResult> {
    // Persist the updated state — next tool call in this session sees it.
    stateBox.current = result.nextState;

    if (result.mutation) {
      sessionUsage.committedMutations += 1;
      // Record the change in the session-scoped log surfaced by get_recent_changes.
      recentChanges.push({
        label: mutationLabel(result.mutation),
        at: new Date().toISOString(),
      });
      if (recentChanges.length > MAX_RECENT_CHANGES) {
        recentChanges.shift();
      }

      // Notify any subscribed clients that the dashboard state has changed.
      const urisToNotify = ['studio://dashboard/state', 'studio://dashboard/system-prompt'];
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

    // The state mutation has already applied to the session's live `stateBox` by
    // this point, so the tool-call result MUST report success now, before invoking
    // the host's persistence hook. `onStateChange` is the host's persistence concern
    // and runs AFTER the mutation is committed to session state: if it throws, that
    // is a persistence failure the host must surface through its own monitoring — it
    // must NOT make an already-applied mutation look failed to the calling AI, which
    // would otherwise retry and duplicate the mutation. We log it server-side (when a
    // logger is configured) and otherwise swallow it, leaving the successful
    // tool-call result untouched.
    if (result.mutation && onStateChange) {
      try {
        await onStateChange(stateBox.current);
      } catch (persistErr) {
        logger?.error(
          `[mcp] onStateChange (persistence hook) failed after ${toolName} already applied: ` +
            `${persistErr instanceof Error ? (persistErr.stack ?? persistErr.message) : String(persistErr)}`,
        );
      }
    }

    return jsonResult(responsePayload);
  }

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name: toolName, arguments: args } = request.params;
    const t0 = Date.now();
    logger?.log(`[mcp] ${toolName}`);

    let threw = false;
    try {
      // T1-3 — enforce `allowedTools` gating BEFORE the special-case dispatch
      // table for any tool that is a STUDIO_AI_TOOL. `get_dashboard_state` (always
      // in the table) and `summarise_page` (in the table when `data` is configured)
      // are STUDIO_AI_TOOLS, so without this check they would be callable even when
      // the host excluded them via `allowedTools` (e.g. `allowedTools: []` still
      // serving full dashboard state). Non-STUDIO_AI_TOOLS (render_chart,
      // get_recent_changes, data-query tools) are always-available by design and
      // fall through to the table unchanged.
      if (studioAiToolNames.has(toolName) && !registeredToolNames.has(toolName)) {
        return errorResult(`Unknown tool: ${toolName}`);
      }

      const handler = toolHandlers[toolName];
      if (handler) {
        return await handler(args);
      }

      // ── dashboard-mutation tools ──────────────────────────────────────────

      if (!registeredToolNames.has(toolName)) {
        return errorResult(`Unknown tool: ${toolName}`);
      }

      try {
        // Run through the single policy chokepoint (execute-then-gate). The pure
        // dry-run + effect diff + policy decision all happen here; nothing is written
        // to the session state box until the policy allows/approves the commit.
        const outcome = await executeToolWithPolicy(toolName, args ?? {}, stateBox.current, {
          policy: sessionToolPolicy,
          customWidgets,
          transport: 'mcp',
          usage: sessionUsage,
        });

        if (outcome.kind === 'denied') {
          // A tool result (not a protocol error), matching the errorResult convention.
          return errorResult(outcome.reason);
        }

        if (outcome.kind === 'needs-approval') {
          // MCP has no built-in pause channel — bridge to the host's approvalHandler.
          if (!approvalHandler) {
            return errorResult(
              'This tool call requires human approval and this MCP session has no approval ' +
                'channel configured. Set StudioMcpOptions.approvalHandler to enable it.',
            );
          }
          const approved = await approvalHandler({
            transport: 'mcp',
            toolName,
            input: args ?? {},
            state: stateBox.current,
            proposed: outcome.result.mutation
              ? {
                  mutation: outcome.result.mutation,
                  nextState: outcome.result.nextState,
                  effects: outcome.effects,
                }
              : undefined,
            usage: sessionUsage,
          });
          if (!approved) {
            return errorResult(
              'This tool call was not approved by the configured approvalHandler.',
            );
          }
          return await commitMutation(outcome.result, toolName);
        }

        // Allowed — commit exactly like today, just gated now.
        return await commitMutation(outcome.result, toolName);
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
