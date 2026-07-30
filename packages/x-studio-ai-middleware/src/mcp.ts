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
import type { CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mutationLabel, STUDIO_AI_TOOL_REGISTRY } from '@mui/x-studio-schema';
import type { StudioAIToolFacts } from '@mui/x-studio-schema';
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
import {
  describeErrorForLog,
  errorResult,
  jsonResult,
  redactedHostErrorResult,
  safeIdentifier,
  sanitizeMaxQueryRows,
  withTimeout,
  type ToolHandler,
} from './mcp/helpers';
import { isPackageAuthoredError } from './internal/packageError';
import { capToolOutput } from './internal/capToolOutput';
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
 * `authorizeDataAccess()` consult a blanket `query_data_source` deny gates.
 *
 * This entry-level consult catches a blanket / by-name deny only. A per-`sourceId`
 * deny is enforced SEPARATELY, inside the handler, via the
 * `authorizeSourceDataAccess` callback wired below (finding H3) — the analogy with
 * `data-health` breaks down for per-source rules, because `data-health`'s source set
 * is host-controlled and returns nothing but counts, whereas this handler's source
 * set is model-controlled (`add_widget` accepts any `sourceId` unchecked) and it
 * returns real rows.
 */
const MULTI_SOURCE_RAW_ROW_TOOLS = new Set(['summarise_page']);

/**
 * Default bound (ms) on the host's `onStateChange` persistence hook (finding H5).
 *
 * Every OTHER host callback reachable from a `tools/call` is explicitly bounded —
 * `approvalHandler` by `approvalTimeoutMs`, `contextEnricher` by
 * `CONTEXT_ENRICHER_TIMEOUT_MS`, every `data.queryDataSource` by `withTimeout` —
 * with the same rationale: an unsettled callback inside the per-session
 * `mutationChain` critical section hangs not only its own call but every
 * subsequent mutating call in the session, forever. `onStateChange` (e.g. an
 * `await db(...).update(...)` on a blackholed TCP connection with no
 * `statement_timeout`) was the one that escaped it. 15s matches the bound applied
 * to the data-query callbacks.
 */
const DEFAULT_PERSIST_TIMEOUT_MS = 15_000;

/**
 * Built-in tools registered as dashboard-mutation tools (not dispatch-table
 * handlers) but marked `readOnly: true` in `STUDIO_AI_TOOL_REGISTRY` — they
 * always return `nextState` as the SAME object reference passed in (see the
 * `plan` functions in `executeToolOnState.ts`), so they never have anything to
 * commit. Falling through to the mutating branch's `mutationChain` would
 * needlessly serialize them behind any in-flight mutation (including one
 * paused for minutes on a human approval), contradicting the documented
 * concurrency contract that read-only tools stay concurrent. Dispatched via
 * `runReadOnlyTool` instead, which never touches `mutationChain`.
 *
 * Derived from `STUDIO_AI_TOOL_REGISTRY`'s `readOnly` fact (`@mui/x-studio-schema`),
 * mirroring `MCP_UNSUPPORTED_TOOLS` above, rather than hand-listed — a hand-listed
 * set previously covered only `get_dashboard_state`/`list_pages` and missed
 * `summarise_page`'s no-data path (Tier 3, iteration 25, finding T3-2):
 * `summarise_page` IS registered here (readOnly: true) but is normally reached
 * through the dispatch-table `handler` branch above (`createSummarisePageHandler`,
 * only wired up when `data` is configured) BEFORE this set is ever consulted —
 * except when `data` is absent, in which case it has no dispatch handler and
 * falls through to this set, so it must be a member for its "client-side
 * limitation" error to bypass the mutex like its siblings. `query_data_source`
 * is also `readOnly: true` here but always has a dispatch-table handler
 * (`createDataToolHandlers` registers it unconditionally, reporting its own "no
 * data access configured" error), so it never reaches this set in practice —
 * harmless to include.
 */
const READ_ONLY_NO_MUTEX_TOOLS = new Set(
  (Object.entries(STUDIO_AI_TOOL_REGISTRY) as [string, StudioAIToolFacts][])
    .filter(([, facts]) => facts.readOnly)
    .map(([name]) => name),
);

/**
 * Apply the shared `capToolOutput` budget to every text content item of a
 * `tools/call` result (finding M3).
 *
 * `capToolOutput` was imported in exactly ONE place — the `ToolDispatchOutcome.output`
 * fold-in in `agenticLoop.ts` — so the byte budget it enforces was CHAT-ONLY, even
 * though its own motivating scenario (`query_data_source({ limit: 1000 })` against a
 * table with a ~1 MB `notes TEXT` column) applies verbatim here: `maxQueryRows` bounds
 * the ROW count, but nothing bounded the bytes per row. Every dispatch-table data tool,
 * `summarise_page`, `render_chart`'s raw SVG and `get_dashboard_state` reach MCP clients
 * through this one return path, so capping here — rather than in each producer — is the
 * MCP-side equivalent of that single fold-in point, and makes the transport-neutral
 * claim in ARCHITECTURE.md's "Bounding what goes out" actually true.
 *
 * Only `type: 'text'` items are touched. An `image`/`audio` item's `data` is base64
 * bounded by whatever produced it (`render_chart`'s `renderChartSvg`), and slicing
 * base64 would corrupt it rather than truncate it.
 *
 * Same known limitation as on chat: the producer has already built its own JSON string
 * by the time this runs, so this cannot prevent a `RangeError` inside a producer's own
 * `JSON.stringify`.
 */
function capCallToolResult(result: CallToolResult): CallToolResult {
  if (!Array.isArray(result.content)) {
    return result;
  }
  let changed = false;
  const content = result.content.map((item) => {
    if (item.type !== 'text' || typeof item.text !== 'string') {
      return item;
    }
    const capped = capToolOutput(item.text);
    if (capped === item.text) {
      return item;
    }
    changed = true;
    return { ...item, text: capped };
  });
  // Returned byte-identical (same object) when nothing was over budget, so the
  // overwhelming majority of results are never reshaped.
  return changed ? { ...result, content } : result;
}

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
    approvalTimeoutMs = 120_000,
    persistTimeoutMs = DEFAULT_PERSIST_TIMEOUT_MS,
    rateLimit,
  } = options;

  const MAX_QUERY_ROWS = sanitizeMaxQueryRows(data?.maxQueryRows);

  // Session-scoped usage, threaded into the policy context. `committedMutations` is
  // bumped only when a mutation is actually committed to `stateBox.current`.
  const sessionUsage = { committedMutations: 0, toolCalls: 0 };

  // Latches once `onStateChange` has blown `persistTimeoutMs`. See the call site: a
  // per-call timeout alone bounds ONE call, but a permanently-hung persistence hook
  // (a dead DB connection with no statement_timeout) would then re-hang every
  // subsequent mutating call for the full timeout, each one inside the `mutationChain`
  // critical section. A hook that has already proven it can hang is not awaited again.
  let persistHookDegraded = false;

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
  // Total tool-call budget (mutating OR read-only), same layering as the mutation
  // budget above and mirroring the chat agentic loop's `Policy.toolCallBudget`
  // (`agenticLoop.ts`): it runs BEFORE the host policy via `Policy.all`, so once the
  // per-session call count reaches the cap, EVERY further tool call is denied
  // outright — not just mutating ones. Without this, `maxMutationsPerSession` alone
  // does not bound a session that dispatches an unbounded number of read-only calls
  // (e.g. hundreds of `query_data_source` live DB queries). `onLimitReached('toolCalls', …)`
  // fires once per breach.
  //
  // DELIBERATE ASYMMETRY WITH THE CHAT TRANSPORT: `agenticLoop.ts` defaults
  // `maxToolCallsPerRequest` to `DEFAULT_MAX_TOOL_CALLS_PER_REQUEST` (50) when the host
  // omits `rateLimit`; MCP defaults BOTH budgets to `undefined`, i.e. no cap. That is
  // intentional and not an oversight. A chat request is a single bounded turn-taking
  // exchange, so a per-request ceiling has an obvious right order of magnitude. An MCP
  // session is a long-lived connection an operator drives interactively for as long as
  // they like — any session-scoped default would simply wedge the connection partway
  // through a normal working session, and it would break existing integrations the same
  // way defaulting `hostToolPolicy` to require-approval would (see the allow-all default
  // above). So the default here stays "no cap", and hosts that need one set
  // `rateLimit.maxToolCallsPerSession` / `maxMutationsPerSession` explicitly. Combined
  // with the allow-all `hostToolPolicy` default, a default-configured MCP session has no
  // bound on live DB queries or committed mutations — which is the whole reason this is
  // spelled out here rather than left implicit in two `?? undefined` reads.
  const maxSessionToolCalls = rateLimit?.maxToolCallsPerSession;
  // Budget chain, built separately from `hostToolPolicy` so it can also serve as
  // `executeToolWithPolicy`'s `preCheckPolicy` — see that option. A host policy must
  // never be consulted in the `'pre-check'` phase: that consult presents
  // `proposed: undefined` on a call that may well be mutating, which is a false premise
  // for a host policy (and would invoke it twice per call). A budget is decidable from
  // the tool name and the usage counters alone, and is idempotent.
  const sessionBudgetPolicy: ToolPolicy = Policy.all(
    Policy.mutationBudget({
      max: maxSessionMutations,
      getCommitted: () => sessionUsage.committedMutations,
      onExceeded: () => rateLimit?.onLimitReached?.('mutations', sessionUsage.committedMutations),
      reason: (committed, max) =>
        'MUI X Studio: Mutation budget exceeded — this MCP session may commit at most ' +
        `${max} state mutation${max === 1 ? '' : 's'} ` +
        `(already committed ${committed}). This change was not applied.`,
    }),
    Policy.toolCallBudget({
      max: maxSessionToolCalls,
      getCalls: () => sessionUsage.toolCalls,
      onExceeded: () => rateLimit?.onLimitReached?.('toolCalls', sessionUsage.toolCalls),
      reason: (calls, max) =>
        'MUI X Studio: Tool-call budget exceeded — this MCP session may dispatch at most ' +
        `${max} tool call${max === 1 ? '' : 's'} (already dispatched ${calls}). ` +
        'This call was not executed.',
    }),
  );
  // The policy that actually decides each call: budgets first (so an exhausted budget
  // denies without ever consulting the host), then the host's own. Consulted exactly
  // once per tool call — see the invocation contract on `ToolPolicy`.
  const sessionToolPolicy: ToolPolicy = Policy.all(sessionBudgetPolicy, hostToolPolicy);

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

  // Extra (non-STUDIO_AI_TOOLS) tools, gated by `allowedTools` when it is supplied —
  // otherwise a host could not hide describe_data_source et al. Hoisted out of the
  // `tools/list` handler so the advertised NAME set below is derived from the very same
  // arrays that handler returns, rather than recomputed from the same inputs: the two
  // must not be able to drift.
  const advertisedDataTools = data
    ? DATA_TOOL_DEFINITIONS.filter((d) => isToolAllowed(d.name))
    : [];
  const advertisedExtraTools = EXTRA_TOOL_DEFINITIONS.filter((d) => isToolAllowed(d.name));

  /**
   * The EXACT tool set this session advertises — the names `tools/list` returns.
   *
   * Threaded into `buildAISystemPrompt` for the `studio://dashboard/system-prompt`
   * resource so its dynamic tool hints are gated by the effective set, exactly as the
   * chat transport already gates them (invariant 17). MCP does narrow that set —
   * `allowedTools`, `MCP_UNSUPPORTED_TOOLS` and the `query_data_source`-needs-`data`
   * rule all remove tools — so without this the resource emitted prose telling the
   * model to call tools this session would reject as `Unknown tool`, costing it a turn,
   * a tool-call budget unit and a full conversation re-send to find out.
   */
  const advertisedToolNames: ReadonlySet<string> = new Set<string>([
    ...registeredToolNames,
    ...advertisedDataTools.map((d) => d.name),
    ...advertisedExtraTools.map((d) => d.name),
  ]);

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

    return { tools: [...builtinTools, ...advertisedDataTools, ...advertisedExtraTools] };
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
    toolHandlers.summarise_page = createSummarisePageHandler({
      stateBox,
      data,
      logger,
      maxQueryRows: MAX_QUERY_ROWS,
      // Finding H3: the source-agnostic consult below (see MULTI_SOURCE_RAW_ROW_TOOLS)
      // only catches a BLANKET `query_data_source` deny. `summarise_page`'s source set
      // is MODEL-controlled — `add_widget` accepts any `sourceId` and performs no
      // existence or authorization check — and each widget yields 5 real rows, so a
      // host rule that denies `query_data_source` for one `sourceId` was bypassable by
      // adding a widget on that source (a mutation, so the rule never fired) and then
      // calling `summarise_page`. Thread the SAME per-source gate the
      // `studio://data/{sourceId}` resource read passes; the handler consults it once
      // per distinct widget source and skips the ones that are denied.
      authorizeSourceDataAccess: (input) => authorizeResourceDataAccess(input),
    });
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
      //
      // TWO of the five subscribable URI families, deliberately — not an oversight.
      // A `StateMutation` only ever rewrites `doc` (see `applyMutation`), and exactly
      // these two resources are rendered FROM `doc`: `studio://dashboard/state` is
      // `projectStateForAI(stateBox.current)` and `studio://dashboard/system-prompt` is
      // that same payload as prompt text. The other three are derived from
      // `runtime.dataSources` and the live database — `studio://schema/{id}` reads a
      // source's `fields`, `studio://data/{id}` and `studio://dashboard/data-health`
      // issue fresh queries — none of which a dashboard mutation can change. Notifying
      // them would tell every subscriber to re-read (and, for two of the three, re-run
      // a live query) on every `add_widget`. Add a family here only when a mutation can
      // actually alter its content.
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
      if (persistHookDegraded) {
        // The hook already blew its deadline once in this session, so it is invoked
        // but NOT awaited: re-awaiting a hook that is known to hang would re-impose
        // `persistTimeoutMs` on this call and on every mutating call after it, inside
        // the `mutationChain` critical section — the session would still be
        // effectively wedged, just in `persistTimeoutMs`-sized slices. The write is
        // still ATTEMPTED (a hook whose backing connection recovers resumes
        // persisting); only the wait is dropped.
        void Promise.resolve()
          .then(() => onStateChange(stateBox.current))
          .catch((persistErr: unknown) => {
            logger?.error(
              `[mcp] onStateChange (persistence hook, not awaited — already timed out once this ` +
                `session) failed after ${toolName} already applied: ${describeErrorForLog(persistErr)}`,
            );
          });
      } else {
        try {
          // Bounded (finding H5): this `await` runs INSIDE the per-session
          // `mutationChain` critical section, so an `onStateChange` promise that never
          // settles hung this call AND every subsequent mutating call in the session
          // forever — the exact failure mode `approvalTimeoutMs` was added to close for
          // `approvalHandler`, a few lines above. A timeout is treated like any other
          // persistence failure by the catch below: logged, non-fatal, the already-
          // applied mutation still reports success.
          await withTimeout(
            Promise.resolve(onStateChange(stateBox.current)),
            persistTimeoutMs,
            'onStateChange (persistence hook)',
          );
        } catch (persistErr) {
          if (isPackageAuthoredError(persistErr)) {
            // It was the deadline, not the host throwing — latch, so the next mutating
            // call does not pay the same wait again.
            persistHookDegraded = true;
          }
          logger?.error(
            `[mcp] onStateChange (persistence hook) failed after ${toolName} already applied: ` +
              `${describeErrorForLog(persistErr)}`,
          );
        }
      }
    }

    return jsonResult(responsePayload);
  }

  /**
   * Runs a `READ_ONLY_NO_MUTEX_TOOLS` member OUTSIDE the `mutationChain` mutex —
   * see that constant's rationale. Still goes through the same policy chokepoint
   * (`executeToolWithPolicy`) and approval bridge as the mutating path, but never
   * writes `stateBox.current` back: a read-only tool's `nextState` is always the
   * same object reference it was given, so there is nothing to commit, no
   * subscriber notification to send, and no `committedMutations` bump — and
   * skipping the write-back also avoids clobbering `stateBox.current` with a
   * stale snapshot if a concurrent mutation commits while this call is paused on
   * approval.
   */
  async function runReadOnlyTool(
    toolName: string,
    args: Record<string, unknown> | undefined,
    signal: AbortSignal | undefined,
  ): Promise<CallToolResult> {
    try {
      const outcome = await executeToolWithPolicy(toolName, args ?? {}, stateBox.current, {
        policy: sessionToolPolicy,
        preCheckPolicy: sessionBudgetPolicy,
        customWidgets,
        transport: 'mcp',
        usage: sessionUsage,
        // Finding H1: bound the host policy consult. Defaults to
        // `TOOL_POLICY_TIMEOUT_MS`; `signal` is the SDK's per-request
        // `RequestHandlerExtra.signal`, so a cancelled request stops waiting at once.
        signal,
      });

      if (outcome.kind === 'denied') {
        return errorResult(outcome.reason);
      }

      if (outcome.kind === 'needs-approval') {
        const bridged = await bridgeApproval(toolName, args);
        if (!bridged.approved) {
          return errorResult(bridged.reason);
        }
      }

      return jsonResult({ output: outcome.result.output });
    } catch (err) {
      // Finding H4: never relay raw error text — a `toolPolicy` / `approvalHandler`
      // implementation is host code and its throw can carry credentials, SQL, or
      // internal hostnames exactly like a driver error. Full detail to the log, a
      // generic message + correlation id to the caller.
      return redactedHostErrorResult(`tool "${safeIdentifier(toolName)}"`, err, logger);
    }
  }

  /**
   * Bridge a `require-approval` decision to the host's `approvalHandler` (MCP has no
   * built-in pause channel). Returns `{ approved, reason }` — a clean deny (never a
   * throw on timeout) when no handler is configured, the handler declines, or the
   * handler never resolves in time. Shared by the read-only dispatch-table path
   * (args-only, `proposed: undefined`) and the mutation path (which passes the
   * proposed mutation/effects).
   *
   * Bounded wait (Tier 2, iteration 24, finding 1): mirrors
   * `agenticLoop/toolDispatch.ts`'s `waitForApproval`, which races the chat
   * transport's approval pause against BOTH `approvalTimeoutMs` and an
   * `AbortSignal` so an abandoned approval can never hang the stream forever. MCP
   * has no per-call `AbortSignal` to race, so only the timeout half of that pattern
   * applies here — but it is just as necessary: this call runs INSIDE the
   * serialized `mutationChain` critical section (see below), so an
   * `approvalHandler` promise that never settles (a closed approval-UI tab, a
   * dropped connection) previously hung not just this call but every subsequent
   * mutating tool call queued behind it for the rest of the MCP session. The
   * timer is always cleared once the race settles, so a fast-resolving handler
   * never leaves a dangling timer behind.
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

    const approvalPromise = approvalHandler({
      transport: 'mcp',
      toolName,
      input: displayInput,
      state: stateBox.current,
      proposed,
      phase: 'final',
      usage: sessionUsage,
    });
    // If the timeout below wins the race, `approvalPromise` is left running with no
    // other observer. Should it later reject (e.g. the host's approval UI throws
    // after the user has already been told the call was denied), Node would report
    // an unhandled rejection since `Promise.race` only forwards the WINNING
    // promise's rejection to its own callers. This second, independent
    // subscription — a Promise.race "loser" is otherwise unobserved — swallows
    // that eventuality without affecting what `Promise.race` itself resolves/
    // rejects with below.
    approvalPromise.catch(() => {});

    const TIMED_OUT = Symbol('mcp-approval-timeout');
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let outcome: boolean | typeof TIMED_OUT;
    try {
      outcome = await Promise.race([
        approvalPromise,
        new Promise<typeof TIMED_OUT>((resolve) => {
          timeoutId = setTimeout(() => resolve(TIMED_OUT), approvalTimeoutMs);
        }),
      ]);
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }

    if (outcome === TIMED_OUT) {
      return {
        approved: false,
        reason:
          `MUI X Studio: Approval for "${toolName}" did not resolve within ${approvalTimeoutMs}ms ` +
          'and was treated as denied. This bounds the wait so a stalled approval UI (e.g. a ' +
          "closed tab) cannot hang this MCP session's mutation queue indefinitely. Increase " +
          'StudioMcpOptions.approvalTimeoutMs if legitimate approvals need longer.',
      };
    }
    return outcome
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

  /**
   * The `tools/call` body. Extracted from the registration below so every one of its
   * many returns funnels through the single `capCallToolResult` boundary (finding M3)
   * — the MCP-side analogue of the chat loop's one `capToolOutput` fold-in point.
   *
   * `signal` is the SDK's per-request `RequestHandlerExtra.signal`, threaded into the
   * policy consults so an abandoned request stops waiting on a host policy at once
   * rather than holding this call — and, on the mutating branch, the whole mutation
   * queue behind it — until the policy deadline elapses (finding H1).
   */
  async function handleCallTool(
    request: CallToolRequest,
    signal: AbortSignal | undefined,
  ): Promise<CallToolResult> {
    const { name: toolName, arguments: args } = request.params;
    const t0 = Date.now();
    // `safeIdentifier`, not the raw name: `toolName` is entirely client-supplied and
    // unbounded at this point (this line runs BEFORE `isToolAllowed`), so an
    // unsanitized interpolation lets a client forge lines in the operator's audit log
    // — a `toolName` of `x\n[mcp] remove_page` writes a second, fabricated entry.
    const safeToolName = safeIdentifier(toolName);
    logger?.log(`[mcp] ${safeToolName}`);

    let threw = false;
    try {
      // `allowedTools`, when supplied, is the EXHAUSTIVE allow-list for the whole MCP
      // tool surface (built-in AND extra tools). Reject anything not listed before any
      // dispatch — this is what lets `allowedTools: []` disable describe_data_source
      // et al., and what excludes get_dashboard_state / summarise_page when the host
      // omits them.
      if (!isToolAllowed(toolName)) {
        // Sanitized + capped before echoing (finding M7): `toolName` is entirely
        // client-supplied and unbounded here — it never matched a registered tool.
        return errorResult(`Unknown tool: ${safeIdentifier(toolName)}`);
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
        // Sanitized + capped before echoing (finding M7): `toolName` is entirely
        // client-supplied and unbounded here — it never matched a registered tool.
        return errorResult(`Unknown tool: ${safeIdentifier(toolName)}`);
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
            // Finding H1 — see `runReadOnlyTool`.
            signal,
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

      // Registered (non-dispatch-table) tools marked `readOnly: true` in
      // `STUDIO_AI_TOOL_REGISTRY` (`get_dashboard_state`, `list_pages`) — dispatch
      // outside `mutationChain` (see `READ_ONLY_NO_MUTEX_TOOLS`) so they stay
      // concurrent with any in-flight mutation, matching the documented contract.
      if (READ_ONLY_NO_MUTEX_TOOLS.has(toolName)) {
        return await runReadOnlyTool(toolName, args, signal);
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
            preCheckPolicy: sessionBudgetPolicy,
            customWidgets,
            transport: 'mcp',
            usage: sessionUsage,
            // Finding H1: THE consult this bound exists for — it runs inside the
            // `mutationChain` critical section below, so an unsettled host policy used
            // to wedge every subsequent mutating call in the session forever. Denying on
            // the deadline (or on an abandoned request) keeps the queue advancing.
            signal,
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
          // Finding H4 — see `runReadOnlyTool` above.
          return redactedHostErrorResult(`tool "${safeIdentifier(toolName)}"`, err, logger);
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
      // Sanitized like the entry log above — this line also runs for a name that never
      // passed `isToolAllowed`, so the raw value must not reach the operator's log.
      // `describeErrorForLog`, not a hand-rolled `err instanceof Error ? … : String(err)`
      // (finding F7's class, and the last raw `String` in this family): `String(x)` is
      // not total, and a logging line inside a catch must not be able to throw a second,
      // worse error over the one it is reporting. The helper keeps the stack for a real
      // `Error` and degrades through `asString` → JSON → runtime shape for anything else,
      // so this line still says something useful. The two sibling sites in this file
      // already used it.
      logger?.error(
        `[mcp] ${safeToolName} threw after ${Date.now() - t0}ms: ${describeErrorForLog(err)}`,
      );
      // Finding H4: the full detail is already in the log line above; the result the
      // model sees carries only the generic message + correlation id.
      return redactedHostErrorResult(`tool "${safeToolName}"`, err, logger);
    } finally {
      if (!threw) {
        logger?.log(`[mcp] ${safeToolName} — ${Date.now() - t0}ms`);
      }
    }
  }

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
    // The single MCP-side output-budget boundary (finding M3) — see `capCallToolResult`.
    // `extra?.signal`: the SDK always supplies `extra`, but reading it unguarded makes the
    // handler non-total for any caller that invokes it directly, and a throw here surfaces
    // as an opaque JSON-RPC internal error rather than a tool result. The signal is an
    // optimization (it cancels a bounded wait early); its absence must not break the call.
    capCallToolResult(await handleCallTool(request, extra?.signal)),
  );

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
      /** The reading request's abort signal, threaded into the policy consult (finding H1). */
      signal?: AbortSignal;
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
    // `signal` is stripped from the consult INPUT — a host policy inspecting
    // `ctx.input` should see the source being read, not an internal plumbing object —
    // and passed as a bound instead.
    const { signal, ...consultInput } = input;
    const gate = await consultToolPolicyArgsOnly(gatedToolName, consultInput, stateBox.current, {
      policy: sessionToolPolicy,
      transport: 'mcp',
      usage: sessionUsage,
      // Finding H1: bound the host policy here too. This gate is reached from
      // `resources/read` and from `summarise_page`'s per-source fan-out, neither of
      // which had any bound on the consult before.
      signal,
    });
    if (gate.kind === 'denied') {
      return gate.reason;
    }
    if (gate.kind === 'needs-approval') {
      const bridged = await bridgeApproval(gatedToolName, consultInput);
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
  async function authorizeResourceStateAccess(
    /** The reading request's abort signal, threaded into the policy consult (finding H1). */
    signal?: AbortSignal,
  ): Promise<string | null> {
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
      // Finding H1 — see `authorizeResourceDataAccess`.
      signal,
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
    // Invariant 17: gate the system-prompt resource's dynamic tool hints by the set this
    // session actually advertises — see `advertisedToolNames`. The chat transport already
    // passes its effective set; MCP did not, so the two transports disagreed.
    advertisedToolNames,
    authorizeDataAccess: authorizeResourceDataAccess,
    authorizeStateAccess: authorizeResourceStateAccess,
  });

  registerPromptHandlers(server, {
    stateBox,
    // Same `get_dashboard_state` gate as `studio://schema/{id}` (finding T2-2):
    // `query_data_source_examples` serves a per-source schema slice of the same
    // payload family, so it must honor the same allowedTools/toolPolicy chokepoint.
    authorizeStateAccess: authorizeResourceStateAccess,
    // Finding H2: the gate reaches host code (`toolPolicy`, `approvalHandler`), and a
    // throw from it must be redacted rather than returned verbatim through
    // `prompts/get`. The redaction writes the full detail here.
    logger,
  });

  return server;
}
