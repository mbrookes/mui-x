/**
 * Server-side agentic loop for x-studio-ai-middleware.
 *
 * Calls the LLM, accumulates tool calls, executes them via `executeToolOnState`,
 * and continues until the model produces a final text response.
 *
 * Yields `StudioAISSEEvent` objects. Callers should encode these as SSE and stream
 * them to the client.
 */
import { randomUUID } from 'node:crypto';
import type { ChatMessage } from '@mui/x-chat-headless';
import { STUDIO_AI_TOOL_REGISTRY, type StudioAIToolFacts } from '@mui/x-studio-schema';
import type { StudioState, StudioCustomWidgetDef } from './models/studioTypes';
import type {
  SerializableSkill,
  StudioAISkill,
  StudioAIDataConfig,
  StudioAIRateLimit,
  StudioAIUsage,
  StudioAIRichContext,
  StudioAIEnrichedContext,
} from './models/aiTypes';
import { buildAISystemPrompt } from './buildAISystemPrompt';
import { STUDIO_AI_TOOLS, STUDIO_AI_TOOL_NAMES } from './studioAITools';
import { parseSSE } from './parseSSE';
import { createDefaultToolPolicy, Policy, type ToolPolicy } from './toolPolicy';
import { withTimeout } from './mcp/helpers';
import type { StudioAISSEEvent } from './models/protocol';
import {
  toOpenAIMessages,
  createToolCallAccumulator,
  accumulateToolCallDeltas,
  dedupeToolCallEntriesById,
  type OpenAIAssistantMessage,
  type OpenAIToolResultMessage,
  type ToolCallDelta,
} from './agenticLoop/openaiWire';
import {
  dispatchToolCall,
  type PendingApproval,
  type ToolDispatchContext,
  type ToolDispatchOutcome,
} from './agenticLoop/toolDispatch';
import { capToolOutput } from './internal/capToolOutput';
import { linkAbortSignal, readBodyWithTimeout } from './internal/llmFetch';
import { reportProviderFetchError, reportProviderHttpError } from './internal/providerError';
import { markPackageAuthored } from './internal/packageError';

/**
 * Timeout (ms) for the LLM provider's HTTP request. Without this, a hung/overloaded
 * gateway that never responds (and never errors) would block the loop — and the
 * whole SSE stream — indefinitely, with no signal to the caller. Mirrors the
 * `withTimeout` pattern `mcp/summarisePage.ts` already applies to its own request-
 * scoped operations, sized to the same order of magnitude as the approval-wait
 * timeout (`approvalTimeoutMs`, default 120_000ms) since a legitimate multi-turn
 * tool-calling response can take a while to stream.
 *
 * Exported so `handleGenerateInsight.ts` and `generateFieldDescriptions.ts` can
 * apply the SAME fetch-timeout mechanism (`withTimeout`) and value to their own
 * (non-streaming) LLM fetch calls, rather than each hand-rolling — or omitting —
 * a timeout.
 */
export const LLM_FETCH_TIMEOUT_MS = 120_000;

/**
 * Idle-timeout (ms) for the SSE read loop, forwarded to `parseSSE`. Bounds how
 * long the stream may go WITHOUT a new chunk before it's considered stalled —
 * distinct from `LLM_FETCH_TIMEOUT_MS` above, which only bounds the wait for
 * the initial response (headers) to arrive. Once the stream starts, that
 * fetch-level timeout has already resolved and can never fire again, so a
 * provider that sends some bytes then goes silent would otherwise hang the
 * connection forever (finding: mid-stream stall). Sized shorter than
 * `LLM_FETCH_TIMEOUT_MS` since a healthy stream should keep producing chunks
 * continuously — an idle gap this long between chunks is itself a signal
 * something is wrong, even if the overall response is expected to take longer.
 */
const LLM_STREAM_IDLE_TIMEOUT_MS = 60_000;

/**
 * Default cap on total tool calls (mutating or read-only) dispatched across a
 * single `runAgenticLoop` request, when `rateLimit.maxToolCallsPerRequest` is not
 * set. Guards against a single turn requesting an unbounded number of tool calls
 * (e.g. hundreds of `query_data_source` calls, each a live DB query) that
 * `maxTurnsPerRequest`/`maxMutationsPerRequest` don't bound on their own.
 */
const DEFAULT_MAX_TOOL_CALLS_PER_REQUEST = 50;

/**
 * Hard ceiling (chars, ~bytes for the ASCII/UTF-8 text a chat model streams) on
 * `turnTextBuffer` — the accumulated `delta.content` text for a SINGLE turn (finding
 * 6, iteration 24). `rateLimit.maxTokensPerRequest` is the intended backstop against
 * a runaway response, but it is OPTIONAL and, per the "KNOWN LIMITATION" note below,
 * silently never trips at all when a gateway omits usage chunks. Without an
 * independent cap here, a misbehaving/malicious gateway that keeps emitting
 * `delta.content` chunks without ever sending `[DONE]` or a usage chunk could grow
 * this buffer (and therefore this process's memory) without bound for the lifetime
 * of a single request. Sized generously — 2,000,000 chars is roughly 500K tokens at
 * ~4 chars/token, far beyond any legitimate single-turn assistant response — so this
 * only ever trips for a genuinely runaway stream, mirroring how
 * `DEFAULT_MAX_TOOL_CALLS_PER_REQUEST` above is a generous-but-bounded default of the
 * same kind. Exceeding it throws, which the enclosing try/catch (below) turns into a
 * clean `{ type: 'error' }` SSE event — the same "must not propagate as an uncaught
 * rejection" contract that governs every other failure in this loop.
 *
 * Exported (mirroring `LLM_FETCH_TIMEOUT_MS` above) so tests can assert against the
 * exact cap rather than a hardcoded duplicate of this constant.
 */
export const MAX_TURN_TEXT_BUFFER_CHARS = 2_000_000;

/**
 * T1-2 — state-reading tools whose output would defeat `privateMode`. In private
 * mode the `<dashboard_state>` block is withheld from the system prompt so
 * sensitive business data is never sent to the provider, but these tools return
 * that same data (field distinct values, widget configs, filter values, source
 * labels) which then round-trips back to the provider in the tool-result
 * message. `query_data_source` belongs here for the same reason: when `data` is
 * configured it returns live database rows straight to the provider as tool
 * output — at least as sensitive as dashboard structure or field values — so
 * private mode must withhold it too, even when `data` is configured. We use
 * approach (a) from the review — exclude them from the advertised built-in list
 * entirely — rather than redacting tool output, keeping the fix self-contained
 * to this file. Combined with the T1-1 dispatch-time gate, an injected call to
 * one of these is rejected as an unadvertised tool.
 *
 * Derived from `STUDIO_AI_TOOL_REGISTRY`'s `privateModeExcluded` fact
 * (`@mui/x-studio-schema`) rather than hand-maintained here, so this set can't
 * silently drift from the registry.
 *
 * Module-scope (like the sibling `DESTRUCTIVE_TOOLS`, `MCP_UNSUPPORTED_TOOLS`,
 * and `READ_ONLY_NO_MUTEX_TOOLS` sets derived the same way) since the registry
 * is static — no need to rebuild this on every `runAgenticLoop` call.
 */
const PRIVATE_MODE_EXCLUDED_TOOLS = new Set(
  (Object.entries(STUDIO_AI_TOOL_REGISTRY) as Array<[string, StudioAIToolFacts]>)
    .filter(([, facts]) => facts.privateModeExcluded)
    .map(([name]) => name),
);

// ── Loop options ──────────────────────────────────────────────────────────────

export interface AgenticLoopOptions {
  endpoint: string;
  apiKey?: string;
  model?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  onToolError?: (toolName: string, error: Error) => void;
  /**
   * Server-side skill handlers. When a `server-tool` skill's tool is called by the
   * model, the loop looks up the matching handler here to execute it server-side.
   * Skills without a registered handler return a descriptive error to the model.
   */
  skillHandlers?: StudioAISkill[];
  /**
   * App-provided data-access configuration for the `query_data_source` tool.
   * When set, the AI can call `query_data_source` to run structured queries
   * against the connected data sources and incorporate live results into its
   * response. If not provided, `query_data_source` calls return an
   * informative error.
   *
   * Pass the SAME `StudioAIDataConfig` object here and to
   * `buildStudioMcpServer`'s `data` option (from `@mui/x-studio-ai-middleware`'s
   * MCP entry point) for identical `query_data_source` behavior across both
   * transports.
   */
  data?: StudioAIDataConfig;
  /**
   * When `true`, the `<dashboard_state>` block is omitted from the system prompt.
   * The model operates without knowing current widget/field/layout details.
   * Use when the dashboard contains sensitive business data.
   * @default false
   */
  privateMode?: boolean;
  /**
   * Token and turn budget enforced for this request.
   * Use this to cap LLM spend per call and protect against runaway agentic loops.
   */
  rateLimit?: StudioAIRateLimit;
  /**
   * Per-call authorization policy — the single chokepoint every built-in mutating
   * tool call passes through. Defaults to `createDefaultToolPolicy()`, which
   * requires approval for `DESTRUCTIVE_TOOLS` and allows everything else (the
   * historical `TOOLS_REQUIRING_APPROVAL` behavior). Supply a custom policy to
   * `deny`, `require-approval`, or `allow` per call based on the tool name, args,
   * and — for built-in mutating tools — the derived structural effects.
   *
   * When `rateLimit.maxMutationsPerRequest` is set, a mutation-budget check runs
   * BEFORE this policy and denies once the budget is exhausted, so a host policy's
   * `allow` cannot exceed the configured cap.
   */
  toolPolicy?: ToolPolicy;
  /**
   * Shared map of pending tool approval callbacks.
   *
   * When a destructive tool (remove_page, remove_widget, apply_bulk_update) is
   * called, the loop registers a resolve function here before yielding a
   * `tool-approval-request` event and pausing. The host app's approval endpoint
   * should look up the toolCallId in this map, call the resolver with the user's
   * decision, and delete the entry.
   *
   * When not provided, the `approvalFallback` option decides whether a
   * require-approval tool is denied (default) or auto-approved.
   *
   * Each entry is a {@link PendingApproval} (a resolver plus the AI chat thread
   * id the approval was raised under), not a bare callback — see that type for
   * the ownership-binding rationale.
   */
  approvalPending?: Map<string, PendingApproval>;
  /**
   * What to do when a tool's policy decision is `require-approval` but no
   * `approvalPending` channel is configured to pause on.
   *
   * - `'deny'` (**default**) — refuse the call with an actionable error so the model
   *   can recover. This closes the previous fail-open behavior where destructive tools
   *   ran unapproved whenever a host forgot to wire `approvalPending`.
   * - `'allow'` — auto-approve and proceed (the historical behavior), additionally
   *   firing `onToolError` with a warning that a require-approval decision was
   *   auto-approved.
   *
   * BREAKING: an integration that relied on destructive tools running without any
   * `approvalPending` map must now either wire one or set this to `'allow'`.
   *
   * @default 'deny'
   */
  approvalFallback?: 'allow' | 'deny';
  /**
   * How long (ms) to wait for a pending tool approval before giving up.
   *
   * When a destructive tool's approval is neither granted nor denied within this
   * window, the loop stops waiting, feeds the model `{ denied: true, reason:
   * 'approval timed out' }` so it can recover, and always removes its own
   * `approvalPending` entry. Prevents an abandoned approval prompt from hanging the
   * SSE stream and leaking server resources forever.
   *
   * @default 120000
   */
  approvalTimeoutMs?: number;
  /**
   * Pre-built data snapshot of the active page's widgets, forwarded from the client
   * where live pipeline rows are available. When present, enables the `summarise_page`
   * tool so the model can produce business-focused data summaries.
   */
  pageSnapshot?: string;
  /**
   * Extra client-derived context (field statistics, layout + cross-filter graph,
   * recent mutations). Rendered into a `<dashboard_context>` block in the system
   * prompt unless `privateMode` is set.
   */
  richContext?: StudioAIRichContext;
  /**
   * Server-side metadata produced by the host's `contextEnricher`. Rendered into a
   * `<server_context>` block in the system prompt unless `privateMode` is set.
   */
  enrichedContext?: StudioAIEnrichedContext;
}

// ── Provider wire-value validation ────────────────────────────────────────────

/**
 * True only for a value usable as a token count (finding M7).
 *
 * `chunk.usage.prompt_tokens`/`completion_tokens` are TYPED `number` but arrive as raw
 * JSON from the provider, which this package's threat model treats as untrusted input on
 * the same footing as the request body (invariant 15 — "a field's declared TypeScript
 * type says nothing about what arrives"). They are also the ONLY input to
 * `rateLimit.maxTokensPerRequest`, so accepting them unvalidated hands a hostile gateway
 * the spend budget: a negative count makes the running sum diverge downward so the limit
 * never trips, a string makes `usage.inputTokens += …` concatenate rather than add, and
 * `NaN`/`Infinity` make every subsequent comparison meaningless (`NaN >= limit` is always
 * false — the budget silently disappears).
 *
 * Finite, non-negative numbers only. `Number.isFinite` already excludes `NaN`,
 * `Infinity` and every non-number, so this is the complete check.
 */
function isUsableTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * True only for a value usable as streamed assistant text (finding M7's sibling sweep).
 *
 * `delta.content` is TYPED `string | null` but is raw provider JSON like everything else
 * on this wire. An object there was previously appended to `turnTextBuffer` with `+=`
 * (yielding `"[object Object]"`, replayed to the provider on the next turn as if the
 * model had said it) and yielded verbatim in a `text-delta` SSE event, shipping a
 * non-string `delta` to a browser whose `StudioAISSEEvent` type promises a string.
 */
function isUsableDeltaText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

// ── Main loop ─────────────────────────────────────────────────────────────────

/**
 * Runs the full agentic loop and yields `StudioAISSEEvent` objects.
 *
 * The caller is responsible for encoding events as SSE and streaming them to
 * the client.
 */
export async function* runAgenticLoop(
  messages: ChatMessage[],
  initialState: StudioState,
  customWidgets: StudioCustomWidgetDef[] | undefined,
  focusedWidgetId: string | undefined,
  allowedTools: string[] | undefined,
  skills: SerializableSkill[] | undefined,
  options: AgenticLoopOptions,
): AsyncGenerator<StudioAISSEEvent> {
  const {
    endpoint,
    apiKey,
    model = 'gpt-4o',
    headers: extraHeaders = {},
    signal,
    onToolError,
    skillHandlers = [],
    data,
    privateMode = false,
    rateLimit,
    approvalPending,
    approvalTimeoutMs = 120_000,
    approvalFallback = 'deny',
    pageSnapshot,
    richContext,
    enrichedContext,
  } = options;

  // The per-call authorization policy. Defaults to `createDefaultToolPolicy()`,
  // which requires approval for `DESTRUCTIVE_TOOLS` and allows everything else —
  // byte-for-byte the historical `TOOLS_REQUIRING_APPROVAL` behavior (that set is
  // this policy's default `approvalTools`, so the chat approval gate and the MCP
  // `destructiveHint` annotations still can't drift apart).
  const hostToolPolicy = options.toolPolicy ?? createDefaultToolPolicy();

  // Mutable per-request usage, threaded into the policy context. `committedMutations`
  // is bumped only when a mutation is actually committed; the mutation-budget check
  // below reads it to enforce `rateLimit.maxMutationsPerRequest`.
  const toolUsage = { committedMutations: 0, toolCalls: 0 };

  // Token/iteration usage accumulator across all iterations. Declared here (before the
  // budget wrapper closes over it) so the `onLimitReached('mutations', …)` call can
  // report the token usage at the point of the breach.
  const usage: StudioAIUsage = { inputTokens: 0, outputTokens: 0, iterations: 0 };

  // Mutation budget. Layered as a policy that runs BEFORE the host policy via
  // `Policy.all`: once the committed-mutation count reaches the cap, any further
  // MUTATING call (i.e. one the dry-run produced a `proposed` mutation for) is
  // denied outright, without even consulting the host policy. This must NOT kill
  // the stream — the denial surfaces to the model as a `{ error }` tool result and
  // the loop continues (still bounded by `maxTurnsPerRequest`). `onLimitReached('mutations', …)`
  // fires once per breach.
  const maxMutations = rateLimit?.maxMutationsPerRequest;
  // Total tool-call budget (mutating OR read-only), same layering as the mutation
  // budget above: it runs BEFORE the host policy via `Policy.all`, so once the
  // per-request call count reaches the cap, EVERY further tool call — not just
  // mutating ones — is denied outright. This is what actually bounds a single turn
  // that requests an unbounded number of tool calls (e.g. hundreds of
  // `query_data_source` calls, each a live DB query): `maxTurnsPerRequest` only
  // bounds LLM round-trips, and `maxMutationsPerRequest` only bounds committed
  // mutations, so neither caps a purely read-only tool-call flood on its own. Like
  // the mutation budget, this must NOT kill the stream — the denial surfaces to the
  // model as a `{ error }` tool result and the loop continues (still bounded by
  // `maxTurnsPerRequest`). `onLimitReached('toolCalls', …)` fires once per breach.
  const maxToolCalls = rateLimit?.maxToolCallsPerRequest ?? DEFAULT_MAX_TOOL_CALLS_PER_REQUEST;
  // The budget chain, built SEPARATELY from `hostToolPolicy` so it can be handed to
  // `executeToolWithPolicy` as its `preCheckPolicy` (the cheap consult that skips an
  // expensive dry-run for a call the budgets will reject anyway) without dragging the
  // host policy into that phase. Budget policies are decidable from the tool name and
  // the usage counters alone and are idempotent — `onExceeded` is latched inside each
  // combinator — which is exactly what `preCheckPolicy` requires and a host policy does
  // not guarantee. The same two instances are reused in `toolPolicy` below, so the
  // latches and counters stay shared between the two phases.
  const budgetPolicy: ToolPolicy = Policy.all(
    Policy.mutationBudget({
      max: maxMutations,
      getCommitted: (ctx) => ctx.usage.committedMutations,
      onExceeded: () => rateLimit?.onLimitReached?.('mutations', { ...usage }),
      reason: (committed, max) =>
        'MUI X Studio: Mutation budget exceeded — this request may commit at most ' +
        `${max} state mutation${max === 1 ? '' : 's'} ` +
        `(already committed ${committed}). This change was not applied.`,
    }),
    Policy.toolCallBudget({
      max: maxToolCalls,
      getCalls: (ctx) => ctx.usage.toolCalls,
      onExceeded: () => rateLimit?.onLimitReached?.('toolCalls', { ...usage }),
      reason: (calls, max) =>
        'MUI X Studio: Tool-call budget exceeded — this request may dispatch at most ' +
        `${max} tool call${max === 1 ? '' : 's'} (already dispatched ${calls}). ` +
        'This call was not executed.',
    }),
  );
  // The policy that actually decides each call: budgets first (so an exhausted budget
  // denies without ever consulting the host), then the host's own. Consulted exactly
  // once per tool call — see the invocation contract on `ToolPolicy`.
  const toolPolicy: ToolPolicy = Policy.all(budgetPolicy, hostToolPolicy);

  // A `server-tool` whose tool name collides with a built-in `STUDIO_AI_TOOLS`
  // name is ignored — the built-in handler always wins for a built-in name. This
  // holds for BOTH sources of server-tools:
  //
  //  - Client-declared `skills` (request body): advertising a collision would let a
  //    body-declared skill shadow a built-in in `tools/list`, and — because the
  //    `query_data_source` dispatch branch runs before the unregistered-skill check —
  //    a skill literally named `query_data_source` would be routed to the client's
  //    handler rather than the built-in.
  //  - Host-registered `skillHandlers` (`options.skillHandlers`): the `matchedSkill`
  //    lookup in `dispatchToolCall` runs BEFORE the approval-required branch, so a
  //    host that registered `skillHandlers['remove_page']` would silently route the
  //    destructive built-in to its own handler and skip the approval pause. Nothing
  //    about `skillHandlers` is meant to override built-ins, so the same guard drops
  //    those collisions too.
  //
  // Dropping collisions here (before the advertised list, the prompt, and the
  // dispatch context are built) keeps a built-in name resolving only to its
  // built-in handler.
  const builtInToolNameSet = new Set<string>(STUDIO_AI_TOOL_NAMES);
  const collidesWithBuiltIn = (entry: { mode: string; tool?: { name: string } }): boolean =>
    entry.mode === 'server-tool' && Boolean(entry.tool) && builtInToolNameSet.has(entry.tool!.name);
  // Finding M6 — `allowedTools` bounds the WHOLE tool surface, `server-tool` skills
  // included, and it does so HERE so the exclusion reaches the prompt as well as the
  // advertised list.
  //
  // It used to gate the built-in list only, while every skill tool was appended
  // unconditionally. That made one option mean two different things on the two
  // transports for no stated reason: on MCP `allowedTools` is documented (and
  // implemented, via `isToolAllowed`) as the EXHAUSTIVE allow-list for the whole tool
  // surface, so `allowedTools: []` disables even always-present tools; on chat, a host
  // that set `allowedTools: ['get_dashboard_state']` for a read-only assistant still had
  // every mutating `server-tool` in `skillHandlers` advertised AND callable, because the
  // dispatch-time `advertisedToolNames` gate is derived from the same unfiltered list.
  // `StudioAIHandlerOptions.allowedTools` is documented as the lever for "a host must
  // guarantee an integration can never call certain tools regardless of what the client
  // puts in the request body" — a guarantee that cannot hold while an entire category of
  // tool is exempt from it. `packages/x-studio`'s own `useTextWidgetAI` depends on
  // exactly this: it sends a read-only `allowedTools` list for a text-generation surface.
  //
  // Filtered at the SKILL level, not just where `skillToolDefs` is built, for two
  // reasons: a filtered-out skill's `promptFragment` must not stay in the system prompt
  // telling the model to call a tool it will be rejected for (invariant 17), and
  // dropping it from `skillHandlers` too means its `execute` is unreachable even if the
  // dispatch-time gate were ever bypassed (invariant 9 — advertisement is not
  // authorization, so don't rely on the advertised list alone).
  //
  // Only `server-tool` skills are affected: `instruction-only` and `client-handler`
  // skills expose no tool, so `allowedTools` — a list of TOOL names — has nothing to say
  // about them. A host that wants a skill alongside a restricted built-in set lists the
  // skill's `tool.name` in `allowedTools`, exactly as MCP already requires for its
  // non-built-in tools (`render_chart`, `get_recent_changes`).
  const excludedByAllowedTools = (entry: { mode: string; tool?: { name: string } }): boolean =>
    entry.mode === 'server-tool' &&
    Boolean(entry.tool) &&
    Boolean(allowedTools) &&
    !(allowedTools as string[]).includes(entry.tool!.name);
  const skillIsEffective = (entry: { mode: string; tool?: { name: string } }): boolean =>
    !collidesWithBuiltIn(entry) && !excludedByAllowedTools(entry);
  const effectiveSkills = (skills ?? []).filter(skillIsEffective);
  const effectiveSkillHandlers = skillHandlers.filter(skillIsEffective);

  // Build effective tool list.
  //
  // Two built-in tools can't function in this server-side loop unless the host
  // opts in, so we never advertise them to the model by default — otherwise it
  // calls them and dead-ends on a runtime error:
  // - `summarise_page` needs live per-widget row data that only exists on the
  //   client (see useChartWidgetData); the server only receives structural state.
  //   Offered only when the host explicitly lists it in `allowedTools`.
  // - `query_data_source` needs an app-provided `data` config; without one it can
  //   only return an error. Offered only when `data` is configured.
  const builtInTools = (
    allowedTools
      ? STUDIO_AI_TOOLS.filter((t) => (allowedTools as string[]).includes(t.function.name))
      : STUDIO_AI_TOOLS
  ).filter((t) => {
    // T1-2 — never advertise state-reading tools in private mode.
    if (privateMode && PRIVATE_MODE_EXCLUDED_TOOLS.has(t.function.name)) {
      return false;
    }
    if (t.function.name === 'query_data_source') {
      // Deliberately gated on `data` alone, NOT on `data.allowedTables !== undefined`.
      // A `data` config without `allowedTables` hits the fail-closed branch in
      // `toolDispatch.ts` and every call returns "this server has not configured a table
      // allowlist" — so advertising it does cost a turn per attempt. Withdrawing the
      // advertisement instead would trade that bounded, self-announcing cost for a
      // SILENT capability gap: the fail-closed message is written as remediation prose
      // and is the only channel through which a mis-wired host learns what to fix, since
      // this package has no other diagnostic path to the operator. A host that hits it
      // gets a one-line fix; a host whose tool silently disappeared gets "the assistant
      // can't see my data" and nothing to grep for. Documented rather than changed.
      return Boolean(data);
    }
    if (t.function.name === 'summarise_page') {
      // Enable when a live data snapshot was pre-built client-side, or host opts in explicitly.
      return Boolean(pageSnapshot) || Boolean(allowedTools?.includes('summarise_page'));
    }
    return true;
  });

  // `effectiveSkills` is already `allowedTools`-filtered (finding M6, see above), so
  // this maps the surviving skills straight into wire-format tool definitions.
  const skillToolDefs = effectiveSkills
    .filter((s) => s.mode === 'server-tool' && s.tool)
    .map((s) => ({
      type: 'function' as const,
      function: {
        name: s.tool!.name,
        description: s.tool!.description,
        parameters: s.tool!.parameters,
      },
    }));

  const effectiveTools = [...builtInTools, ...skillToolDefs];

  // T1-1 — the exact set of tool names advertised to the model this request.
  // `dispatchToolCall` rejects any call whose name is not in this set so gating is
  // enforced at execution time, not merely at advertisement time.
  const advertisedToolNames = new Set(effectiveTools.map((t) => t.function.name));

  // Built AFTER the effective tool set, not before it: prompt prose that tells the model
  // to call a specific tool is only correct if that tool is actually advertised, and
  // `allowedTools`/`privateMode`/`data`/`pageSnapshot` all narrow the set. Threading
  // `advertisedToolNames` in lets `buildAISystemPrompt` gate those hints instead of
  // assuming the full built-in surface.
  const systemPrompt = buildAISystemPrompt(
    initialState,
    customWidgets,
    focusedWidgetId,
    effectiveSkills,
    {
      privateMode,
      advertisedToolNames,
      richContext,
      enrichedContext,
    },
  );

  // Static per-request context shared by every tool dispatch.
  const dispatchCtx: ToolDispatchContext = {
    skillHandlers: effectiveSkillHandlers,
    skills: effectiveSkills,
    data,
    customWidgets,
    pageSnapshot,
    // The page the `pageSnapshot` covers, captured ONCE from the request's initial
    // state. Threaded so `summarise_page` compares against the snapshot's page rather
    // than the threaded active page, which a same-turn `set_active_page` mutates
    // (finding 2-2).
    snapshotPageId: initialState.doc.dashboard.activePageId,
    // Same identity `rename_thread` (`executeToolOnState.ts`) stamps onto mutations —
    // captured once from the request's initial state, mirroring `snapshotPageId`, so a
    // pending approval this request raises can be bound to the conversation that
    // raised it (see `PendingApproval`).
    threadId: initialState.doc.ai?.activeThreadId,
    approvalPending,
    approvalTimeoutMs,
    approvalFallback,
    signal,
    onToolError,
    advertisedToolNames,
    toolPolicy,
    budgetPolicy,
    usage: toolUsage,
  };

  let currentMessages = toOpenAIMessages(systemPrompt, messages);
  let currentState = initialState;

  const maxTurns = rateLimit?.maxTurnsPerRequest ?? 10;

  // Safety limit on agentic turns
  for (let turn = 0; turn < maxTurns; turn += 1) {
    // On iterations after the first, emit a step separator so the client can show
    // visual dividers between agentic reasoning rounds.
    if (turn > 0) {
      yield { type: 'step-start', iteration: turn };
    }

    let response: Response;
    // Finding M5 — a REAL abort signal for this fetch. `withTimeout` only races the
    // promise; it never aborts the in-flight request, so a timed-out turn previously
    // left the upstream completion running (and billed) with its body unread. The
    // linked signal fires on `LLM_FETCH_TIMEOUT_MS` OR on the caller's own abort, so
    // the socket is released either way. `dispose()` clears the timer and unsubscribes.
    const fetchAbort = linkAbortSignal(signal, LLM_FETCH_TIMEOUT_MS);
    try {
      // Bounded by `LLM_FETCH_TIMEOUT_MS` (finding: this call previously had no
      // timeout at all) — a hung/overloaded gateway that never resolves would
      // otherwise block this turn, and therefore the whole SSE stream, forever.
      // eslint-disable-next-line no-await-in-loop -- sequential LLM calls; each depends on previous result
      response = await withTimeout(
        fetch(endpoint, {
          method: 'POST',
          signal: fetchAbort.signal,
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            ...extraHeaders,
          },
          body: JSON.stringify({
            model,
            messages: currentMessages,
            tools: effectiveTools,
            tool_choice: 'auto',
            stream: true,
            stream_options: { include_usage: true },
          }),
        }),
        LLM_FETCH_TIMEOUT_MS,
        'LLM provider request',
      );
    } catch (err) {
      fetchAbort.dispose();
      if (signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return;
      }
      // Finding H4 — a transport error's `message` routinely names internal hosts,
      // ports, and IPs (`connect ECONNREFUSED 10.0.3.11:5432`). Log the detail
      // server-side and give the untrusted client only a correlation id.
      const report = reportProviderFetchError('LLM provider request', err);
      onToolError?.('llm-provider', new Error(report.detail));
      yield { type: 'error', message: report.clientMessage };
      return;
    }

    // The response headers have arrived, so the fetch-level DEADLINE no longer
    // applies — `parseSSE`'s idle timeout bounds the stream from here on, and the
    // timer must not fire mid-stream and kill a healthy long response. The link to
    // the caller's own `signal` deliberately stays alive (`clearTimer`, not
    // `dispose`) so an external abort still tears the response body down.
    fetchAbort.clearTimer();

    if (!response.ok) {
      // Bounded by `LLM_FETCH_TIMEOUT_MS` (finding 2, iteration 24) — the fetch-level
      // timeout above only bounds the wait for HEADERS to arrive; a gateway that
      // returns a non-2xx status then stalls the body would otherwise hang this read
      // forever. `readBodyWithTimeout` additionally CANCELS the body on a timeout
      // (finding M5) instead of leaving the socket pinned with an unread body.
      // eslint-disable-next-line no-await-in-loop -- single error-path read; cannot be parallelized
      const errText = await readBodyWithTimeout(
        response,
        () => response.text(),
        LLM_FETCH_TIMEOUT_MS,
        'LLM provider error response body',
      ).catch(() => undefined);
      // Finding H4 — the provider's error BODY is never relayed to the client: an
      // OpenAI 401 body carries the partially-masked key and org, and Azure/APIM and
      // self-hosted gateways echo deployment paths, internal hostnames, and even the
      // received `Authorization` header. A hostile gateway can also return a 100 MB
      // body, which was previously buffered whole into this one SSE event. The body
      // goes to the server log (bounded); the client gets status + correlation id.
      const report = reportProviderHttpError(
        'LLM provider request',
        response.status,
        response.statusText,
        errText,
      );
      onToolError?.('llm-provider', new Error(report.detail));
      fetchAbort.dispose();
      yield { type: 'error', message: report.clientMessage };
      return;
    }

    // Accumulate tool calls and text from this LLM response
    const acc = createToolCallAccumulator();
    let finishReason: string | null = null;
    // Buffers this turn's `delta.content` fragments so the assistant's own
    // commentary/reasoning can be preserved on the follow-up `tool_calls` message
    // below, instead of always being replaced with `content: null` — mirroring
    // `openaiWire.ts`'s `toOpenAIMessages`, which deliberately keeps assistant text
    // alongside `tool_calls` for exactly this reason.
    let turnTextBuffer = '';

    // Per-TURN usage, captured from the LAST usage-bearing chunk of this response rather
    // than summed across chunks (finding T3-4b). The OpenAI wire contract emits usage once
    // (in the final chunk under `stream_options: include_usage`), but some gateways repeat
    // a CUMULATIVE usage on every chunk; summing those would multiply the real token count
    // by the chunk count and trip `maxTokensPerRequest` far too early. Assign-from-last-seen
    // is correct for both shapes: a single final chunk and a repeated-cumulative stream both
    // leave the true per-turn total in these locals, which we fold into `usage` once below.
    let turnInputTokens = 0;
    let turnOutputTokens = 0;

    // try/catch (finding: a mid-stream stall — or any other read error — must not
    // propagate as an uncaught rejection out of this generator). `runAgenticLoop` is
    // a public export consumers may drive directly (see index.ts: "Re-exported for
    // consumers who want to build custom loops"), not only through `handleAIChat`'s
    // outer try/catch, so every failure here must surface the same way the
    // fetch-level timeout above does: a `{ type: 'error' }` event, not a thrown
    // exception. `parseSSE`'s idle timeout (reset per chunk) is what actually
    // catches a provider that sends some bytes then goes silent — the fetch-level
    // timeout above only bounds the wait for the response to START and has already
    // resolved by the time this loop runs.
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential SSE streaming; cannot be parallelized
      for await (const chunk of parseSSE(response, { idleTimeoutMs: LLM_STREAM_IDLE_TIMEOUT_MS })) {
        if (signal?.aborted) {
          return;
        }

        // NOTE (finding M7's sibling sweep): this is a CAST, not a validation — every
        // field below is raw provider JSON and is checked at its point of use
        // (`isUsableDeltaText`, `isUsableTokenCount`, `Array.isArray` on `tool_calls`,
        // and `openaiWire.ts`'s per-field checks inside `accumulateToolCallDeltas`).
        // Read the declared types here as documentation of the wire CONTRACT, never as a
        // guarantee about the bytes.
        const choices = chunk.choices as Array<{
          delta?: {
            content?: unknown;
            tool_calls?: unknown;
          };
          finish_reason?: unknown;
        }>;

        // Accumulate token usage from the final usage chunk (stream_options: include_usage).
        //
        // Finding M7 — every field here is RAW PROVIDER JSON, and its declared
        // TypeScript type says nothing about what actually arrives (invariant 15). These
        // two numbers are the entire input to `maxTokensPerRequest`, so an unvalidated
        // read hands a hostile/broken gateway the token budget itself:
        //  - `prompt_tokens: -1e15` keeps the running sum hugely negative, so the budget
        //    comparison below NEVER trips and `maxTurnsPerRequest` becomes the only
        //    remaining bound on spend;
        //  - `prompt_tokens: "1000"` (a string) turns `usage.inputTokens` into a STRING
        //    via `+=`, which then CONCATENATES across turns ("0100010001000…"), trips the
        //    budget almost immediately, and ships a non-number to the browser in the
        //    `usage` and `message-metadata` events.
        // `isUsableTokenCount` is the same shape of wire-value type check
        // `openaiWire.ts`'s `isUsableToolCallIndex` applies to `tool_calls[].index`. A
        // rejected value leaves the previous value in place, exactly as a missing field
        // does — a gateway that sends garbage is treated as one that sent nothing, which
        // is the documented "budget silently no-ops" case below, not a worse one.
        const chunkUsage = chunk.usage as
          | { prompt_tokens?: unknown; completion_tokens?: unknown }
          | undefined;
        if (chunkUsage) {
          turnInputTokens = isUsableTokenCount(chunkUsage.prompt_tokens)
            ? chunkUsage.prompt_tokens
            : turnInputTokens;
          turnOutputTokens = isUsableTokenCount(chunkUsage.completion_tokens)
            ? chunkUsage.completion_tokens
            : turnOutputTokens;
        }

        if (!choices?.length) {
          continue;
        }

        const choice = choices[0];
        // A finish-reason-only chunk (real behavior for some OpenAI-compatible gateways) may
        // omit `delta` entirely — default to `{}` so the checks below degrade gracefully
        // instead of throwing on `undefined.content`.
        const delta = choice.delta ?? {};
        // `finish_reason` is relayed to the browser in the `finish` SSE event, whose
        // protocol type declares it a string — so a non-string one is rejected here
        // rather than forwarded (finding M7's sibling sweep).
        if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
          finishReason = choice.finish_reason;
        }

        // NOTE: `StudioAISSEEvent` (`models/protocol.ts`) declares `reasoning-start` /
        // `reasoning-delta` / `reasoning-end` events for provider-emitted chain-of-thought,
        // but this loop never yields them: the `delta` type above (and every provider this
        // package has been run against) carries only `content`/`tool_calls`, with no
        // `reasoning`/`reasoning_content` streaming field to map from. A future provider
        // integration that streams reasoning tokens over an OpenAI-compatible wire format
        // (e.g. a `delta.reasoning_content`) should inspect it here and yield
        // `reasoning-start`/`reasoning-delta`/`reasoning-end` around it, mirroring the
        // `text-delta` handling below.
        if (isUsableDeltaText(delta.content)) {
          yield { type: 'text-delta', delta: delta.content };
          turnTextBuffer += delta.content;
          // Finding 6 — bound `turnTextBuffer` growth independently of the (optional,
          // and sometimes silently-inert — see the KNOWN LIMITATION note below) token
          // budget. Thrown here, inside the try/catch around this read loop, so it
          // surfaces as a clean `{ type: 'error' }` event rather than an uncaught
          // rejection.
          if (turnTextBuffer.length > MAX_TURN_TEXT_BUFFER_CHARS) {
            // Branded package-authored (see `markPackageAuthored`) so the redaction split
            // in the catch below relays this message verbatim instead of withholding it
            // behind a correlation id — it names only a server-authored sentence and a
            // compile-time constant. The `MUI X Studio:` prefix is added by that split,
            // so it is deliberately absent here.
            throw markPackageAuthored(
              new Error(
                `LLM response exceeded the maximum buffered text size for a single turn ` +
                  `(${MAX_TURN_TEXT_BUFFER_CHARS} chars). This can happen when a misbehaving gateway ` +
                  'streams text indefinitely without ever completing the response, which would otherwise ' +
                  "let a single request grow this process's memory without bound. Aborting this request.",
              ),
            );
          }
        }

        // `Array.isArray`, not a truthiness check (finding M7's sibling sweep): a
        // provider sending `tool_calls: {}` used to reach `deltas.entries()` and throw a
        // bare `TypeError` that the catch below then reported as a transport failure —
        // "the LLM provider was unreachable", of a gateway that was reachable and
        // streaming. A non-array is simply not a tool-call list; skip it.
        if (Array.isArray(delta.tool_calls)) {
          accumulateToolCallDeltas(delta.tool_calls as ToolCallDelta[], acc);
        }
      }
    } catch (err) {
      // Mirrors the fetch-level catch above: end the stream silently on an external
      // abort, otherwise surface a clear `{ type: 'error' }` event (this is what
      // `parseSSE`'s idle-timeout rejection — a mid-stream stall — surfaces as).
      fetchAbort.dispose();
      if (signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return;
      }
      // Not every error reaching here is package-authored: `parseSSE` awaits
      // `reader.read()`, which rejects with a TRANSPORT error when the connection drops
      // mid-stream (`fetch failed`, `terminated`, `read ECONNRESET 10.0.3.11:443`) — the
      // same class of provider-authored text the pre-headers catch above already routes
      // through `reportProviderFetchError`. So this catch uses the identical split: full
      // detail to the server's `onToolError` channel under a correlation id, only the
      // generic sentence to the browser. Package-authored errors (`parseSSE`'s branded
      // idle timeout, the buffer cap above) are relayed verbatim by that helper, so the
      // "the stream stalled" vs "the connection dropped" distinction survives.
      const report = reportProviderFetchError('LLM response stream', err);
      onToolError?.('llm-provider', new Error(report.detail));
      yield { type: 'error', message: report.clientMessage };
      return;
    }
    // The response is fully consumed — release the external-abort subscription so a
    // long-lived host signal doesn't accumulate one listener per turn.
    fetchAbort.dispose();

    // Fold this turn's usage into the cumulative per-request total ONCE (finding T3-4b).
    usage.inputTokens += turnInputTokens;
    usage.outputTokens += turnOutputTokens;

    const rawToolCallEntries = Object.entries(acc.reqToolCalls);
    // Mint a synthetic id for any tool call the provider left un-id'd (finding T3-5).
    // The accumulator seeds `id: ''` when a delta carries no `id`; two such calls in one
    // turn would both address as `toolCallId: ''`, so the second is wrongly rejected by the
    // approval-dispatch duplicate guard with a misleading "duplicate across concurrent
    // requests" message. This id also becomes the key into the shared `approvalPending`
    // map for destructive tools (see `toolDispatch.ts`), so it must be unguessable, not
    // merely unique — a deterministic `call-${turn}-${idx}` scheme let anyone who can
    // observe (or simply enumerate) a few requests predict another in-flight request's
    // pending-approval id and resolve/deny it themselves. `randomUUID()` is unique per
    // call AND cryptographically unpredictable, closing that hole while keeping the
    // OpenAI-wire-protocol `tool_calls[].id` field (which this same value fills) a plain
    // opaque string, exactly as the wire format requires.
    for (const [, tc] of rawToolCallEntries) {
      if (!tc.id) {
        tc.id = randomUUID();
      }
    }
    // Finding F1 — collapse any two slots that ended up sharing one `tool_call_id`.
    // AFTER the id minting above, so entries the provider left un-id'd (all seeded
    // `''`) are compared by their freshly minted unique ids rather than collapsing
    // into one. The accumulator is what should prevent a split in the first place;
    // this guarantees the invariant the OpenAI wire format actually requires — one
    // `role: 'tool'` reply per `tool_calls[]` entry — holds no matter what the
    // gateway streamed, since a duplicated id makes the NEXT turn's request body
    // malformed (provider 400, chat over) and double-fires this call's browser
    // frames. Applied to the entry list itself, not just to `assistantToolCallMsg`,
    // so the dispatch loop below stays in lockstep with the message it answers.
    const toolCallEntries = dedupeToolCallEntriesById(rawToolCallEntries);
    usage.iterations += 1;

    if (toolCallEntries.length === 0) {
      // No tool calls — model produced a final text response.
      // Emit message-metadata so the client can display model name + token counts.
      yield {
        type: 'message-metadata',
        metadata: {
          model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          iterations: usage.iterations,
        },
      };
      yield {
        type: 'usage',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        iterations: usage.iterations,
      };
      yield { type: 'finish', finishReason: finishReason ?? 'stop' };
      return;
    }

    // Check token budget before executing tools and continuing.
    //
    // KNOWN LIMITATION: this budget is only as good as the usage data the provider
    // actually sends. `turnInputTokens`/`turnOutputTokens` (folded into `usage`
    // above) are populated ENTIRELY from `chunk.usage` (the `stream_options:
    // include_usage` chunk) — if a gateway omits usage chunks altogether (some
    // OpenAI-compatible proxies do, especially non-streaming-aware ones bolted onto
    // a streaming endpoint), `usage.inputTokens`/`usage.outputTokens` silently stay
    // at their initial value and this check never trips. In that case the ONLY
    // remaining bound on spend for a misbehaving/malicious conversation is
    // `maxTurnsPerRequest` (and, for mutations, `maxMutationsPerRequest` /
    // `maxToolCallsPerRequest`). A full fix would estimate token usage client-side
    // (e.g. a tokenizer over `currentMessages`) when the provider omits usage data —
    // out of scope for this pass; flagged here so a future reader isn't surprised
    // that `maxTokensPerRequest` silently no-ops against such a gateway.
    //
    // A gateway that sends usage of the WRONG TYPE (or a negative count) now degrades to
    // exactly that same case rather than a worse one: `isUsableTokenCount` rejects the
    // value at the read site, so `usage.*` stay non-negative numbers and this comparison
    // stays meaningful (finding M7). Before that check, `prompt_tokens: -1e15` drove the
    // sum permanently negative — turning the budget OFF outright — and a string count
    // turned `+=` into concatenation, which both tripped the budget spuriously and put a
    // non-number into the `usage`/`message-metadata` events the browser reads.
    if (
      rateLimit?.maxTokensPerRequest !== undefined &&
      usage.inputTokens + usage.outputTokens >= rateLimit.maxTokensPerRequest
    ) {
      rateLimit.onLimitReached?.('tokens', { ...usage });
      yield {
        type: 'usage',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        iterations: usage.iterations,
      };
      yield {
        type: 'error',
        message:
          'MUI X Studio: Request stopped — token budget exceeded. ' +
          `Used ${usage.inputTokens + usage.outputTokens} tokens (limit: ${rateLimit.maxTokensPerRequest}).`,
      };
      return;
    }

    // ── Execute tool calls ────────────────────────────────────────────────────

    const toolResults: Array<{
      toolCallId: string;
      toolName: string;
      input: unknown;
      output: string;
    }> = [];
    const assistantToolCallMsg: OpenAIAssistantMessage = {
      role: 'assistant',
      // Preserve any text the model streamed alongside its tool calls this turn
      // (finding: this previously hardcoded `null`, silently dropping the model's
      // own commentary/reasoning from the in-flight conversation) — mirrors
      // `toOpenAIMessages` in `openaiWire.ts`, which preserves assistant text
      // alongside `tool_calls` for replayed history for the exact same reason.
      content: turnTextBuffer || null,
      tool_calls: toolCallEntries.map(([, tc]) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.argsBuffer },
        ...(tc.extra_content ? { extra_content: tc.extra_content } : {}),
      })),
    };

    for (const [, tc] of toolCallEntries) {
      let toolInput: unknown;
      let argsParseFailed = false;
      try {
        toolInput = JSON.parse(tc.argsBuffer || '{}');
      } catch {
        argsParseFailed = true;
        toolInput = {};
      }

      yield {
        type: 'tool-activity',
        toolCallId: tc.id,
        toolName: tc.name,
        phase: 'start',
        input: toolInput,
      };

      // Drive the dispatch generator: forward its side-effect events
      // (`state-mutation`, `tool-approval-request`) verbatim, then act on the
      // uniform outcome. This is the single point where the tool-result +
      // `tool-activity` (`complete`) pair is emitted for every dispatch path.
      const dispatch = dispatchToolCall(tc, toolInput, argsParseFailed, currentState, dispatchCtx);
      let outcome: ToolDispatchOutcome;
      while (true) {
        // eslint-disable-next-line no-await-in-loop -- sequential tool execution; each call depends on prior state
        const step = await dispatch.next();
        if (step.done) {
          outcome = step.value;
          break;
        }
        yield step.value;
      }

      // A mid-approval abort ends the stream silently, matching how aborts are
      // handled elsewhere in this loop.
      if (outcome.kind === 'aborted') {
        return;
      }

      if (outcome.nextState) {
        currentState = outcome.nextState;
      }

      // Finding H2 — every INPUT to a tool is bounded, but the OUTPUT was not, and a
      // tool result is not a one-shot cost: it is appended to `currentMessages` below
      // and re-sent on EVERY remaining turn (O(turns × size)), as well as forwarded to
      // the browser in the `tool-activity` event just below. `capToolOutput` is applied
      // HERE, at the single `ToolDispatchOutcome` boundary every producer funnels
      // through, so it covers `query_data_source`, `describe_data_source`,
      // `get_field_values`, `summarise_page`, `get_dashboard_state` and any future tool
      // uniformly, regardless of which file emits the result. Results within budget are
      // returned byte-identical.
      const cappedOutput = capToolOutput(outcome.output);

      toolResults.push({
        toolCallId: tc.id,
        toolName: tc.name,
        input: toolInput,
        output: cappedOutput,
      });
      yield {
        type: 'tool-activity',
        toolCallId: tc.id,
        toolName: tc.name,
        phase: 'complete',
        input: toolInput,
        output: cappedOutput,
      };
    }

    // Build follow-up messages for next LLM turn
    currentMessages = [
      ...currentMessages,
      assistantToolCallMsg,
      ...toolResults.map(
        (r): OpenAIToolResultMessage => ({
          role: 'tool',
          tool_call_id: r.toolCallId,
          content: r.output,
        }),
      ),
    ];
  }

  // Exceeded max turns
  rateLimit?.onLimitReached?.('turns', { ...usage });
  yield {
    type: 'usage',
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    iterations: usage.iterations,
  };
  yield {
    type: 'error',
    message: `MUI X Studio: Agentic loop exceeded maximum turn limit (${maxTurns}).`,
  };
}
