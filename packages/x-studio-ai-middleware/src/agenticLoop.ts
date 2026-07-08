/**
 * Server-side agentic loop for x-studio-ai-middleware.
 *
 * Calls the LLM, accumulates tool calls, executes them via `executeToolOnState`,
 * and continues until the model produces a final text response.
 *
 * Yields `StudioAISSEEvent` objects. Callers should encode these as SSE and stream
 * them to the client.
 */
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
import type { StudioAISSEEvent } from './models/protocol';
import {
  toOpenAIMessages,
  createToolCallAccumulator,
  accumulateToolCallDeltas,
  type OpenAIAssistantMessage,
  type OpenAIToolResultMessage,
} from './agenticLoop/openaiWire';
import {
  dispatchToolCall,
  type ToolDispatchContext,
  type ToolDispatchOutcome,
} from './agenticLoop/toolDispatch';

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
   */
  approvalPending?: Map<string, (approved: boolean, reason?: string) => void>;
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
  const toolPolicy: ToolPolicy = Policy.all(
    Policy.mutationBudget({
      max: maxMutations,
      getCommitted: (ctx) => ctx.usage.committedMutations,
      onExceeded: () => rateLimit?.onLimitReached?.('mutations', { ...usage }),
      reason: (committed, max) =>
        'MUI X Studio: Mutation budget exceeded — this request may commit at most ' +
        `${max} state mutation${max === 1 ? '' : 's'} ` +
        `(already committed ${committed}). This change was not applied.`,
    }),
    hostToolPolicy,
  );

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
  const effectiveSkills = (skills ?? []).filter((s) => !collidesWithBuiltIn(s));
  const effectiveSkillHandlers = skillHandlers.filter((s) => !collidesWithBuiltIn(s));

  const systemPrompt = buildAISystemPrompt(
    initialState,
    customWidgets,
    focusedWidgetId,
    effectiveSkills,
    {
      privateMode,
      richContext,
      enrichedContext,
    },
  );

  // T1-2 — state-reading tools whose output would defeat `privateMode`. In
  // private mode the `<dashboard_state>` block is withheld from the system prompt
  // so sensitive business data is never sent to the provider, but these tools
  // return that same data (field distinct values, widget configs, filter values,
  // source labels) which then round-trips back to the provider in the tool-result
  // message. `query_data_source` belongs here for the same reason: when `data`
  // is configured it returns live database rows straight to the provider as tool
  // output — at least as sensitive as dashboard structure or field values — so
  // private mode must withhold it too, even when `data` is configured. We use
  // approach (a) from the review — exclude them from the advertised built-in
  // list entirely — rather than redacting tool output, keeping the fix
  // self-contained to this file. Combined with the T1-1 dispatch-time gate, an
  // injected call to one of these is rejected as an unadvertised tool.
  //
  // Derived from `STUDIO_AI_TOOL_REGISTRY`'s `privateModeExcluded` fact
  // (`@mui/x-studio-schema`) rather than hand-maintained here, so this set
  // can't silently drift from the registry.
  const PRIVATE_MODE_EXCLUDED_TOOLS = new Set(
    (Object.entries(STUDIO_AI_TOOL_REGISTRY) as Array<[string, StudioAIToolFacts]>)
      .filter(([, facts]) => facts.privateModeExcluded)
      .map(([name]) => name),
  );

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
      return Boolean(data);
    }
    if (t.function.name === 'summarise_page') {
      // Enable when a live data snapshot was pre-built client-side, or host opts in explicitly.
      return Boolean(pageSnapshot) || Boolean(allowedTools?.includes('summarise_page'));
    }
    return true;
  });

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

  // Static per-request context shared by every tool dispatch.
  const dispatchCtx: ToolDispatchContext = {
    skillHandlers: effectiveSkillHandlers,
    skills: effectiveSkills,
    data,
    customWidgets,
    pageSnapshot,
    approvalPending,
    approvalTimeoutMs,
    approvalFallback,
    signal,
    onToolError,
    advertisedToolNames,
    toolPolicy,
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
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential LLM calls; each depends on previous result
      response = await fetch(endpoint, {
        method: 'POST',
        signal,
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
      });
    } catch (err) {
      if (signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return;
      }
      yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
      return;
    }

    if (!response.ok) {
      // eslint-disable-next-line no-await-in-loop -- single error-path read; cannot be parallelized
      const errText = await response.text().catch(() => response.statusText);
      yield { type: 'error', message: `HTTP ${response.status}: ${errText}` };
      return;
    }

    // Accumulate tool calls and text from this LLM response
    const acc = createToolCallAccumulator();
    let finishReason: string | null = null;

    // eslint-disable-next-line no-await-in-loop -- sequential SSE streaming; cannot be parallelized
    for await (const chunk of parseSSE(response)) {
      if (signal?.aborted) {
        return;
      }

      const choices = chunk.choices as Array<{
        delta: {
          content?: string | null;
          tool_calls?: Array<{
            index: number;
            id?: string;
            function?: { name?: string; arguments?: string };
            extra_content?: unknown;
          }>;
        };
        finish_reason?: string | null;
      }>;

      // Accumulate token usage from the final usage chunk (stream_options: include_usage)
      const chunkUsage = chunk.usage as
        | { prompt_tokens?: number; completion_tokens?: number }
        | undefined;
      if (chunkUsage) {
        usage.inputTokens += chunkUsage.prompt_tokens ?? 0;
        usage.outputTokens += chunkUsage.completion_tokens ?? 0;
      }

      if (!choices?.length) {
        continue;
      }

      const choice = choices[0];
      const delta = choice.delta;
      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }

      if (delta.content) {
        yield { type: 'text-delta', delta: delta.content };
      }

      if (delta.tool_calls) {
        accumulateToolCallDeltas(delta.tool_calls, acc);
      }
    }

    const toolCallEntries = Object.entries(acc.reqToolCalls);
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

    // Check token budget before executing tools and continuing
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
      content: null,
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

      toolResults.push({
        toolCallId: tc.id,
        toolName: tc.name,
        input: toolInput,
        output: outcome.output,
      });
      yield {
        type: 'tool-activity',
        toolCallId: tc.id,
        toolName: tc.name,
        phase: 'complete',
        input: toolInput,
        output: outcome.output,
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
