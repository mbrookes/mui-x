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
import {
  consultToolPolicyArgsOnly,
  executeToolWithPolicy,
  Policy,
  type ToolPolicy,
  type ToolPolicyContext,
} from './toolPolicy';
import type { StudioAIRecentMutation } from './models/aiTypes';
import { errorResult, jsonResult, type ToolHandler } from './mcp/helpers';
import {
  TOOL_TITLES,
  TOOL_ANNOTATIONS,
  DATA_TOOL_DEFINITIONS,
  EXTRA_TOOL_DEFINITIONS,
} from './mcp/toolMetadata';
import { createDataToolHandlers, createSummarisePageHandler } from './mcp/dataTools';
import { buildApprovalDisplayInput } from './agenticLoop/toolDispatch';
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
 * host lists them in `allowedTools`. Currently empty (every built-in tool,
 * including `query_data_source`, has an MCP dispatch path), but kept as a
 * generic guard for any future tool that is chat-only.
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

/**
 * Dispatch-table data tools that return RAW ROWS (`describe_data_source` yields up
 * to 10 sample rows; `get_field_values` and `compute_field_stats` project raw
 * column values). `resources.ts` documents `query_data_source` as the single tool
 * name whose `toolPolicy` / `allowedTools` restriction governs ALL raw-row access,
 * and the resource path (`authorizeResourceDataAccess`) maps raw-row RESOURCE reads
 * onto that name (finding T2-B). Consulting the policy for these three sibling tools
 * under their OWN names left a per-`sourceId` `query_data_source` deny unable to gate
 * them — a contract violation between the tool and resource surfaces. Their policy
 * CONSULT is therefore routed under `query_data_source` (threading `sourceId`, like
 * the resource path); they stay advertised / allow-listed under their own names.
 */
const RAW_ROW_DATA_TOOLS = new Set([
  'describe_data_source',
  'get_field_values',
  'compute_field_stats',
]);

/**
 * Multi-source raw-row tools: `summarise_page` fans out live `queryDataSource`
 * calls across EVERY widget source on the resolved page (returning up to 5 real
 * sample rows per widget, plus per-field stats and GROUP BY anomaly aggregates).
 * Like the raw-row siblings above it must be governed by the documented
 * `query_data_source` contract (`resources.ts`) — otherwise a host that denies
 * `query_data_source` to lock down ALL raw-row access still leaks rows through
 * `summarise_page` (finding T2-α). Unlike those siblings it has no single
 * `sourceId` (it spans the whole page), so its consult is routed under
 * `query_data_source` SOURCE-AGNOSTICALLY — exactly mirroring the multi-source
 * `studio://dashboard/data-health` resource, whose single source-agnostic
 * `authorizeDataAccess()` consult a blanket `query_data_source` deny gates. A
 * per-`sourceId` deny does not single out one widget's source here (same
 * intentional coarseness as `data-health`); a blanket / by-name deny does.
 */
const MULTI_SOURCE_RAW_ROW_TOOLS = new Set(['summarise_page']);

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

  // Per-session mutation budget, layered BEFORE the host policy via `Policy.all`:
  // once the cap is reached, any further mutating call (one whose dry-run produced
  // a `proposed` mutation) is denied without consulting the host policy.
  // `onLimitReached` fires once per breach.
  const maxSessionMutations = rateLimit?.maxMutationsPerSession;
  const sessionToolPolicy: ToolPolicy = Policy.all(
    Policy.mutationBudget({
      max: maxSessionMutations,
      getCommitted: () => sessionUsage.committedMutations,
      onExceeded: () => rateLimit?.onLimitReached?.('mutations', sessionUsage.committedMutations),
      reason: (committed, max) =>
        'MUI X Studio: Mutation budget exceeded — this MCP session may commit at most ' +
        `${max} state mutation${max === 1 ? '' : 's'} ` +
        `(already committed ${committed}). This change was not applied.`,
    }),
    hostToolPolicy,
  );

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
  // - `query_data_source` additionally requires `options.data` to be configured —
  //   without it, `createDataToolHandlers` has no `queryDataSource` callback to
  //   call, so advertising the tool would only dead-end into an error result.
  // - If allowedTools is provided, use that exact list (caller takes responsibility).
  const toolsToRegister = STUDIO_AI_TOOLS.filter((toolDef) => {
    const name = toolDef.function.name;
    if (MCP_UNSUPPORTED_TOOLS.has(name)) {
      return false;
    }
    if (name === 'query_data_source' && !data) {
      return false;
    }
    if (allowedTools) {
      return allowedTools.includes(name);
    }
    return true;
  });

  // The registered built-in (`STUDIO_AI_TOOLS`) subset for this session. The
  // MCP-only "extra" surface (data-query tools, render_chart, get_recent_changes)
  // is dispatched via `toolHandlers` below and is NOT part of STUDIO_AI_TOOLS.
  const registeredToolNames = new Set<string>(toolsToRegister.map((t) => t.function.name));
  // When `allowedTools` is supplied it is the EXHAUSTIVE allow-list for the WHOLE MCP
  // tool surface — built-in mutation tools AND the extra data/chart/log tools. A tool
  // absent from it is rejected as unknown, so even `allowedTools: []` disables the
  // extra tools (previously always-on). When omitted, every tool is allowed.
  const isToolAllowed = (name: string): boolean => !allowedTools || allowedTools.includes(name);

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

    // Extra (non-STUDIO_AI_TOOLS) tools are also gated by `allowedTools` when it is
    // supplied — otherwise a host could not hide describe_data_source et al.
    return {
      tools: [
        ...builtinTools,
        ...(data ? DATA_TOOL_DEFINITIONS.filter((d) => isToolAllowed(d.name)) : []),
        ...EXTRA_TOOL_DEFINITIONS.filter((d) => isToolAllowed(d.name)),
      ],
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
    // `get_dashboard_state` is intentionally NOT special-cased here: it falls through
    // to the shared `executeToolWithPolicy` path (read-only → allowed, no mutation),
    // which puts it behind the policy chokepoint, unifies its output envelope with the
    // chat path (a JSON string, not a raw object), and picks up the row-data redaction
    // from the single pure plan in `executeToolOnState.ts`.
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

  /**
   * Bridge a `require-approval` decision to the host's `approvalHandler` (MCP has no
   * built-in pause channel). Returns `{ approved, reason }` — a clean deny (never a
   * throw) when no handler is configured or the handler declines. Shared by the
   * read-only dispatch-table path (args-only, `proposed: undefined`) and the mutation
   * path (which passes the proposed mutation/effects).
   */
  async function bridgeApproval(
    toolName: string,
    args: Record<string, unknown> | undefined,
    proposed?: ToolPolicyContext['proposed'],
  ): Promise<{ approved: boolean; reason: string }> {
    if (!approvalHandler) {
      return {
        approved: false,
        reason:
          'This tool call requires human approval and this MCP session has no approval ' +
          'channel configured. Set StudioMcpOptions.approvalHandler to enable it.',
      };
    }
    // Enrich human-facing approval labels from the REAL current state before handing
    // `input` to the host (finding T2-A). The chat transport already rewrites
    // `remove_widget`/`remove_page`/`apply_bulk_update` titles to the actual
    // state-derived entity title via `buildApprovalDisplayInput`; without the same
    // enrichment here, a prompt-injected model could get a destructive removal
    // approved under a spoofed `widgetTitle`/`pageTitle` a host renders in its
    // confirmation UI. Display-only — execution still keys off the raw id. For any
    // non-destructive tool the helper returns the input unchanged.
    const displayInput = buildApprovalDisplayInput(toolName, args ?? {}, stateBox.current);
    const approved = await approvalHandler({
      transport: 'mcp',
      toolName,
      input: displayInput,
      state: stateBox.current,
      proposed,
      usage: sessionUsage,
    });
    return approved
      ? { approved: true, reason: '' }
      : {
          approved: false,
          reason: 'This tool call was not approved by the configured approvalHandler.',
        };
  }

  // Per-session mutex for the MUTATING `tools/call` branch. The snapshot → dry-run →
  // policy → approval → commit sequence for a non-dispatch-table tool runs as one
  // chained critical section, so a concurrent mutating call (e.g. one that commits
  // while this one is blocked on a minutes-long approval) can't clobber this one's
  // commit with a stale `stateBox.current` snapshot. Read-only dispatch-table tools
  // stay concurrent — they never write the state box.
  let mutationChain: Promise<unknown> = Promise.resolve();

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name: toolName, arguments: args } = request.params;
    const t0 = Date.now();
    logger?.log(`[mcp] ${toolName}`);

    let threw = false;
    try {
      // `allowedTools`, when supplied, is the EXHAUSTIVE allow-list for the whole MCP
      // tool surface (built-in AND extra tools). Reject anything not listed before any
      // dispatch — this is what lets `allowedTools: []` disable describe_data_source
      // et al., and what excludes get_dashboard_state / summarise_page when the host
      // omits them.
      if (!isToolAllowed(toolName)) {
        return errorResult(`Unknown tool: ${toolName}`);
      }

      // Resolve the special-cased handler with an `Object.hasOwn` guard so a
      // model/client-supplied name that is an `Object.prototype` member
      // ("constructor", "toString", "valueOf", "__proto__", …) resolves to
      // `undefined` instead of an inherited prototype value that would then be
      // invoked as `handler(args)`. Then reject any name that is neither a
      // special-cased handler nor a registered mutation tool BEFORE either
      // dispatch branch, so every unrecognized name — prototype member or not —
      // receives the same clean `Unknown tool` error uniformly.
      const handler = Object.hasOwn(toolHandlers, toolName) ? toolHandlers[toolName] : undefined;
      if (!handler && !registeredToolNames.has(toolName)) {
        return errorResult(`Unknown tool: ${toolName}`);
      }

      // Special-cased read-only / side-effectful tools (data queries, chart render,
      // recent-changes, and — when data is configured — summarise_page). These
      // previously bypassed the policy entirely; now they pass an ARGS-ONLY
      // authorization consult (they never mutate dashboard state, so `mayMutate` is
      // omitted) and, on require-approval, bridge to the host's approvalHandler exactly
      // like the mutation path. Only on allow/approved does the handler run.
      if (handler) {
        // Raw-row data tools (`describe_data_source` / `get_field_values` /
        // `compute_field_stats`) consult the policy under `query_data_source` — the
        // single tool name `resources.ts` documents as governing ALL raw-row access,
        // and the same name the raw-row RESOURCE path (`authorizeResourceDataAccess`)
        // maps onto (finding T2-B). Thread `sourceId` into the consult input exactly
        // like that resource path, so one per-`sourceId` `query_data_source` rule gates
        // every raw-row surface (tool AND resource) identically. These tools stay
        // advertised / allow-listed under their OWN names (the `isToolAllowed` check
        // above is unchanged); only the policy-consult and approval-bridge tool name
        // is remapped. `summarise_page` is remapped the same way but SOURCE-AGNOSTIC
        // (it spans every widget source on the page — finding T2-α; see
        // MULTI_SOURCE_RAW_ROW_TOOLS). Every other dispatch-table tool consults under
        // its own name with its full args, as before.
        const isRawRowDataTool = RAW_ROW_DATA_TOOLS.has(toolName);
        const isMultiSourceRawRowTool = MULTI_SOURCE_RAW_ROW_TOOLS.has(toolName);
        const policyToolName =
          isRawRowDataTool || isMultiSourceRawRowTool ? 'query_data_source' : toolName;
        // Consult input: a raw-row tool threads its single `sourceId`;
        // `summarise_page` is source-agnostic (it spans the whole page — `{}` — see
        // MULTI_SOURCE_RAW_ROW_TOOLS); every other tool consults with its full args.
        let consultInput: Record<string, unknown> = args ?? {};
        if (isRawRowDataTool) {
          consultInput = { sourceId: (args as { sourceId?: unknown } | undefined)?.sourceId };
        } else if (isMultiSourceRawRowTool) {
          consultInput = {};
        }
        const gate = await consultToolPolicyArgsOnly(
          policyToolName,
          consultInput,
          stateBox.current,
          {
            policy: sessionToolPolicy,
            transport: 'mcp',
            usage: sessionUsage,
          },
        );
        if (gate.kind === 'denied') {
          return errorResult(gate.reason);
        }
        if (gate.kind === 'needs-approval') {
          const bridged = await bridgeApproval(policyToolName, consultInput);
          if (!bridged.approved) {
            return errorResult(bridged.reason);
          }
        }
        return await handler(args);
      }

      // ── dashboard-mutation tools ──────────────────────────────────────────
      // (`registeredToolNames.has(toolName)` is guaranteed true here: any name
      // that is neither a handler nor a registered mutation tool was already
      // rejected as unknown above.)

      // Serialize the mutating branch per session (see `mutationChain`): capturing the
      // snapshot inside the chained critical section makes cross-call staleness
      // impossible even when an approval blocks for minutes.
      const runMutation = async (): Promise<CallToolResult> => {
        try {
          // Single policy chokepoint (execute-then-gate). The pure dry-run + effect
          // diff + policy decision happen here; nothing is written to the session state
          // box until the policy allows/approves the commit.
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
            const bridged = await bridgeApproval(
              toolName,
              args,
              outcome.result.mutation
                ? {
                    mutation: outcome.result.mutation,
                    nextState: outcome.result.nextState,
                    effects: outcome.effects,
                  }
                : undefined,
            );
            if (!bridged.approved) {
              return errorResult(bridged.reason);
            }
            return await commitMutation(outcome.result, toolName);
          }

          // Allowed — commit exactly like today, just gated now.
          return await commitMutation(outcome.result, toolName);
        } catch (err) {
          return errorResult(String(err));
        }
      };

      // Chain onto the previous mutating task (running it on both fulfil and reject so a
      // prior failure doesn't stall the queue), then keep the chain alive for the next
      // call. `runMutation` maps its own errors to `errorResult`, so it never rejects.
      const pending = mutationChain.then(runMutation, runMutation);
      mutationChain = pending.catch(() => undefined);
      return await pending;
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

  /**
   * Authorization gate for the two resource URI families that execute a LIVE data
   * query — `studio://data/{sourceId}` and `studio://dashboard/data-health`.
   * Resource reads are a parallel data-access surface that previously bypassed
   * every authorization chokepoint the tool path enforces (finding 2.1). This runs
   * the SAME gate the dispatch-table data tools run before returning rows —
   * `isToolAllowed` + the args-only policy consult + the approval bridge — mapped
   * onto `query_data_source`, the tool these resource reads conceptually invoke
   * (and the one whose `allowedTools`/`toolPolicy` restriction a host expects to
   * govern all raw-row access). Returns a deny-reason string, or `null` to proceed.
   * `consultToolPolicyArgsOnly` also increments `sessionUsage.toolCalls`, so a
   * usage-aware policy no longer undercounts these reads.
   *
   * `input.sourceId` (finding 2.3) is threaded into the policy consult AND the
   * approval bridge, so a per-source `toolPolicy` rule (deny `query_data_source`
   * for one `sourceId`) or an `approvalHandler` that renders `ctx.input` sees which
   * source the `studio://data/{sourceId}` read targets — it is no longer blind.
   * `studio://dashboard/data-health` is a multi-source operation and calls this
   * without a `sourceId`, gated once against the tool-name allow-list/policy.
   */
  async function authorizeResourceDataAccess(
    input: {
      sourceId?: string;
    } = {},
  ): Promise<string | null> {
    const gatedToolName = 'query_data_source';
    if (!isToolAllowed(gatedToolName)) {
      return (
        `MUI X Studio: Reading this resource runs a live '${gatedToolName}' query, but that ` +
        `tool is not in this MCP session's allowedTools. Raw-data resource reads honor the same ` +
        `allow-list as the data tools. Add '${gatedToolName}' to allowedTools to permit it.`
      );
    }
    const gate = await consultToolPolicyArgsOnly(gatedToolName, input, stateBox.current, {
      policy: sessionToolPolicy,
      transport: 'mcp',
      usage: sessionUsage,
    });
    if (gate.kind === 'denied') {
      return gate.reason;
    }
    if (gate.kind === 'needs-approval') {
      const bridged = await bridgeApproval(gatedToolName, input);
      if (!bridged.approved) {
        return bridged.reason;
      }
    }
    return null;
  }

  /**
   * Authorization gate for the read surfaces that expose the SAME payload family as
   * the `get_dashboard_state` TOOL — `studio://dashboard/state` (the
   * `projectStateForAI` JSON), `studio://dashboard/system-prompt` (that state
   * rendered as prompt text), `studio://schema/{id}` (a per-source slice), and the
   * `query_data_source_examples` MCP prompt (a further-reduced per-source schema
   * slice; finding T2-2). The tool-call path rejects `get_dashboard_state` when it
   * is excluded from `allowedTools`, but these other read surfaces served
   * equivalent payloads ungated (finding 2.1, T2-2). This runs the SAME
   * `isToolAllowed` + args-only policy consult + approval bridge the tool path
   * uses, mapped onto `get_dashboard_state`, so a host that hides that tool also
   * blocks every equivalent resource/prompt read. Returns a deny-reason string, or
   * `null` to proceed.
   */
  async function authorizeResourceStateAccess(): Promise<string | null> {
    const gatedToolName = 'get_dashboard_state';
    if (!isToolAllowed(gatedToolName)) {
      return (
        `MUI X Studio: Reading this resource returns the same dashboard state as the ` +
        `'${gatedToolName}' tool, but that tool is not in this MCP session's allowedTools. ` +
        `Dashboard-state resource reads honor the same allow-list as the tool. Add ` +
        `'${gatedToolName}' to allowedTools to permit it.`
      );
    }
    const gate = await consultToolPolicyArgsOnly(gatedToolName, {}, stateBox.current, {
      policy: sessionToolPolicy,
      transport: 'mcp',
      usage: sessionUsage,
    });
    if (gate.kind === 'denied') {
      return gate.reason;
    }
    if (gate.kind === 'needs-approval') {
      const bridged = await bridgeApproval(gatedToolName, {});
      if (!bridged.approved) {
        return bridged.reason;
      }
    }
    return null;
  }

  registerResourceHandlers(server, {
    stateBox,
    data,
    customWidgets,
    contextEnricher,
    logger,
    subscribedUris,
    authorizeDataAccess: authorizeResourceDataAccess,
    authorizeStateAccess: authorizeResourceStateAccess,
  });

  registerPromptHandlers(server, {
    stateBox,
    // Same `get_dashboard_state` gate as `studio://schema/{id}` (finding T2-2):
    // `query_data_source_examples` serves a per-source schema slice of the same
    // payload family, so it must honor the same allowedTools/toolPolicy chokepoint.
    authorizeStateAccess: authorizeResourceStateAccess,
  });

  return server;
}
