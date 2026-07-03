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
import type { StudioState, StudioCustomWidgetDef } from './models/studioTypes';
import type {
  SerializableSkill,
  StudioAISkill,
  StudioDataResolver,
  StudioAIRateLimit,
  StudioAIUsage,
  StudioAIRichContext,
  StudioAIEnrichedContext,
} from './models/aiTypes';
import { buildAISystemPrompt } from './buildAISystemPrompt';
import { STUDIO_AI_TOOLS, DESTRUCTIVE_TOOLS } from './studioAITools';
import { parseSSE } from './parseSSE';
import { executeToolOnState } from './executeToolOnState';
import type { StudioAISSEEvent } from './models/protocol';

// ── OpenAI message types ──────────────────────────────────────────────────────

interface OpenAIUserMessage {
  role: 'user';
  content: string;
}

interface OpenAIAssistantMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
    extra_content?: unknown;
  }>;
}

interface OpenAIToolResultMessage {
  role: 'tool';
  tool_call_id: string;
  content: string;
}

interface OpenAISystemMessage {
  role: 'system';
  content: string;
}

type OpenAIMessage =
  | OpenAISystemMessage
  | OpenAIUserMessage
  | OpenAIAssistantMessage
  | OpenAIToolResultMessage;

// ── Conversation serialisation ────────────────────────────────────────────────

function toOpenAIMessages(systemPrompt: string, messages: ChatMessage[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = [{ role: 'system', content: systemPrompt }];

  for (const msg of messages) {
    const textParts = msg.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');

    const toolParts = msg.parts.filter((p) => p.type === 'dynamic-tool') as Array<{
      type: 'dynamic-tool';
      toolInvocation: {
        toolCallId: string;
        toolName: string;
        input: unknown;
        output: unknown;
        state: string;
      };
    }>;

    if (msg.role === 'user') {
      if (textParts) {
        result.push({ role: 'user', content: textParts });
      }
    } else if (msg.role === 'assistant') {
      if (toolParts.length > 0) {
        result.push({
          // Preserve any assistant text alongside the tool calls — OpenAI allows a
          // `tool_calls` message to also carry `content`, and dropping it loses the
          // model's own reasoning/commentary from the replayed history.
          role: 'assistant',
          content: textParts || null,
          tool_calls: toolParts.map((p) => ({
            id: p.toolInvocation.toolCallId,
            type: 'function' as const,
            function: {
              name: p.toolInvocation.toolName,
              arguments: JSON.stringify(p.toolInvocation.input ?? {}),
            },
          })),
        });
        for (const p of toolParts) {
          // OpenAI requires every `tool_calls` entry to be followed by a matching
          // tool message. A result that is still pending (`output === undefined`)
          // would otherwise be skipped, leaving an unmatched tool call and a 400 on
          // the next turn — emit a placeholder result instead of dropping it.
          result.push({
            role: 'tool',
            tool_call_id: p.toolInvocation.toolCallId,
            content:
              p.toolInvocation.output !== undefined
                ? JSON.stringify(p.toolInvocation.output)
                : JSON.stringify({ status: 'unknown' }),
          });
        }
      } else if (textParts) {
        result.push({ role: 'assistant', content: textParts });
      }
    }
  }

  return result;
}

// ── Tool-call delta accumulation ──────────────────────────────────────────────

interface AccumulatedToolCall {
  id: string;
  name: string;
  argsBuffer: string;
  extra_content?: unknown;
}

interface ToolCallAccumulator {
  reqToolCalls: Record<number, AccumulatedToolCall>;
  idToIdx: Record<string, number>;
  nextAutoIdx: number;
}

interface ToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
  extra_content?: unknown;
}

/**
 * Seed for synthetic indices assigned to id-only tool-call deltas.
 *
 * Providers key streamed tool-call fragments either by a numeric `index` or by an
 * `id`. For id-only deltas we mint our own index; seeding from a high, disjoint
 * range (rather than `0`) guarantees a synthetic index can never collide with a
 * real provider-supplied `index: 0` in a mixed stream, which would otherwise merge
 * two distinct calls' fragments.
 */
const SYNTHETIC_INDEX_BASE = 1_000_000;

function createToolCallAccumulator(): ToolCallAccumulator {
  return { reqToolCalls: {}, idToIdx: {}, nextAutoIdx: SYNTHETIC_INDEX_BASE };
}

/**
 * Merges a chunk's `tool_calls` deltas into the accumulator, resolving each
 * fragment to a stable slot by `index`, then by `id` (synthetic index), then by
 * position. Mutates `acc` in place.
 */
function accumulateToolCallDeltas(deltas: ToolCallDelta[], acc: ToolCallAccumulator): void {
  for (const [i, tc] of deltas.entries()) {
    let idx: number;
    const tcIndex = tc.index;
    if (tcIndex !== undefined) {
      idx = tcIndex;
    } else if (tc.id) {
      if (acc.idToIdx[tc.id] !== undefined) {
        idx = acc.idToIdx[tc.id];
      } else {
        idx = acc.nextAutoIdx;
        acc.idToIdx[tc.id] = idx;
        acc.nextAutoIdx += 1;
      }
    } else {
      idx = i;
    }
    if (!acc.reqToolCalls[idx]) {
      acc.reqToolCalls[idx] = { id: tc.id ?? '', name: '', argsBuffer: '' };
    }
    if (tc.id) {
      acc.reqToolCalls[idx].id = tc.id;
    }
    if (tc.extra_content) {
      acc.reqToolCalls[idx].extra_content = tc.extra_content;
    }
    if (tc.function?.name) {
      acc.reqToolCalls[idx].name += tc.function.name;
    }
    if (tc.function?.arguments) {
      acc.reqToolCalls[idx].argsBuffer += tc.function.arguments;
    }
  }
}

// ── Tool approval ─────────────────────────────────────────────────────────────

type ApprovalOutcome =
  | { kind: 'resolved'; approved: boolean; reason?: string }
  | { kind: 'timeout' }
  | { kind: 'aborted' };

/**
 * Waits for a destructive tool's approval, but never unconditionally: races the
 * approval callback against the abort signal and a timeout so an abandoned prompt
 * can't hang the stream and leak the map entry forever. The `approvalPending`
 * entry is always removed once the race settles.
 */
function waitForApproval(
  toolCallId: string,
  approvalPending: Map<string, (approved: boolean, reason?: string) => void>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<ApprovalOutcome> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  return new Promise<ApprovalOutcome>((resolve) => {
    approvalPending.set(toolCallId, (a, r) =>
      resolve({ kind: 'resolved', approved: a, reason: r }),
    );
    timeoutId = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
    if (signal) {
      if (signal.aborted) {
        resolve({ kind: 'aborted' });
      } else {
        onAbort = () => resolve({ kind: 'aborted' });
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
  }).finally(() => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    if (signal && onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
    approvalPending.delete(toolCallId);
  });
}

// ── Tool dispatch ─────────────────────────────────────────────────────────────

/** Static, per-request context shared by every `dispatchToolCall` invocation. */
interface ToolDispatchContext {
  skillHandlers: StudioAISkill[];
  skills: SerializableSkill[] | undefined;
  dataResolver?: StudioDataResolver;
  customWidgets: StudioCustomWidgetDef[] | undefined;
  pageSnapshot?: string;
  approvalPending?: Map<string, (approved: boolean, reason?: string) => void>;
  approvalTimeoutMs: number;
  signal?: AbortSignal;
  onToolError?: (toolName: string, error: Error) => void;
  /** Names of tools actually advertised to the model this request (T1-1 gate). */
  advertisedToolNames: Set<string>;
  /** Tools that pause for user approval before execution. */
  toolsRequiringApproval: ReadonlySet<string>;
}

/**
 * Outcome of dispatching a single tool call. `aborted` propagates a mid-approval
 * abort up to the loop so it can end the stream silently; otherwise the loop turns
 * `output`/`nextState` into the tool-result + `tool-activity` pair exactly once.
 */
type ToolDispatchOutcome =
  | { kind: 'aborted' }
  | { kind: 'result'; output: string; nextState?: StudioState };

function toError(err: unknown): Error {
  return err instanceof Error ? err : /* minify-error-disabled */ new Error(String(err));
}

/**
 * Executes one tool call, owning the full dispatch decision (parse-failure →
 * gating → server-tool skill → execute_query → unregistered skill → approval +
 * built-in). Yields the side-effect events that must precede the result
 * (`state-mutation`, `tool-approval-request`) and returns a uniform outcome; the
 * caller performs the single result/`tool-activity` pairing for every path.
 */
async function* dispatchToolCall(
  tc: AccumulatedToolCall,
  toolInput: unknown,
  argsParseFailed: boolean,
  currentState: StudioState,
  ctx: ToolDispatchContext,
): AsyncGenerator<StudioAISSEEvent, ToolDispatchOutcome> {
  const { name } = tc;

  // The model streamed tool-call arguments that aren't valid JSON. Executing the
  // tool with a coerced `{}` would run it with the wrong (empty) args and, for
  // non-validating destructive tools, report a no-op as success. Surface the parse
  // failure to the model so it can retry with valid JSON.
  if (argsParseFailed) {
    const rawArgs = tc.argsBuffer ?? '';
    const snippet = rawArgs.length > 200 ? `${rawArgs.slice(0, 200)}…` : rawArgs;
    return {
      kind: 'result',
      output: JSON.stringify({ error: `invalid tool arguments: ${snippet}` }),
    };
  }

  // T1-1 — enforce the effective tool set at dispatch time, not just at
  // advertisement time. `allowedTools`/`privateMode`/resolver filtering only
  // controls what is offered to the model; without this gate a prompt-injected
  // call to an unadvertised tool (e.g. `remove_page` in a read-only assistant, or
  // `execute_query` excluded from `allowedTools`) would still be executed. Unknown
  // or unadvertised names get the same error the default path produces — never run.
  if (!ctx.advertisedToolNames.has(name)) {
    return { kind: 'result', output: JSON.stringify({ error: `Unknown tool: ${name}` }) };
  }

  // Registered server-tool skill — execute it server-side (may be sync or async).
  const matchedSkill = ctx.skillHandlers
    .filter((s) => s.mode === 'server-tool' && s.tool)
    .find((s) => s.tool!.name === name);

  if (matchedSkill?.tool?.execute) {
    try {
      const result = await Promise.resolve(
        matchedSkill.tool.execute(toolInput as Record<string, unknown>, currentState),
      );
      if (result.mutation) {
        yield { type: 'state-mutation', mutation: result.mutation };
      }
      return { kind: 'result', output: result.output, nextState: result.nextState };
    } catch (skillErr) {
      const skillError = toError(skillErr);
      ctx.onToolError?.(name, skillError);
      return { kind: 'result', output: JSON.stringify({ error: skillError.message }) };
    }
  }

  // execute_query — resolved via the app-provided dataResolver.
  if (name === 'execute_query') {
    let output: string;
    try {
      if (!ctx.dataResolver) {
        output = JSON.stringify({
          error:
            'execute_query is not available: no dataResolver was configured on the server. ' +
            'Pass a dataResolver in AgenticLoopOptions to enable this tool.',
        });
      } else {
        const args = toolInput as { query: string; sourceId?: string };
        const result = await ctx.dataResolver.resolve(args.query, args.sourceId);
        output = JSON.stringify(result);
      }
    } catch (queryErr) {
      const queryError = toError(queryErr);
      ctx.onToolError?.(name, queryError);
      output = JSON.stringify({ error: queryError.message });
    }
    return { kind: 'result', output };
  }

  // Skill was declared in the request but has no registered server handler.
  const isUnregisteredSkillTool = (ctx.skills ?? [])
    .filter((s) => s.mode === 'server-tool' && s.tool)
    .some((s) => s.tool!.name === name);

  if (isUnregisteredSkillTool) {
    return {
      kind: 'result',
      output: JSON.stringify({
        error: `server-tool skill '${name}' has no registered handler on the server.`,
      }),
    };
  }

  // Built-in tool — pause for user approval first when required.
  if (ctx.toolsRequiringApproval.has(name) && ctx.approvalPending) {
    yield { type: 'tool-approval-request', toolCallId: tc.id, toolName: name, input: toolInput };

    const outcome = await waitForApproval(
      tc.id,
      ctx.approvalPending,
      ctx.signal,
      ctx.approvalTimeoutMs,
    );

    // Abort: end silently, matching how aborts are handled elsewhere in the loop.
    if (outcome.kind === 'aborted') {
      return { kind: 'aborted' };
    }
    if (outcome.kind === 'timeout') {
      return {
        kind: 'result',
        output: JSON.stringify({ denied: true, reason: 'approval timed out' }),
      };
    }
    if (!outcome.approved) {
      return {
        kind: 'result',
        output: JSON.stringify({
          denied: true,
          reason: outcome.reason ?? 'User denied the operation.',
        }),
      };
    }
  }

  try {
    const result = executeToolOnState(
      name,
      toolInput,
      currentState,
      ctx.customWidgets,
      ctx.pageSnapshot,
    );
    if (result.mutation) {
      yield { type: 'state-mutation', mutation: result.mutation };
    }
    return { kind: 'result', output: result.output, nextState: result.nextState };
  } catch (err) {
    const toolErr = toError(err);
    ctx.onToolError?.(name, toolErr);
    return { kind: 'result', output: JSON.stringify({ error: toolErr.message }) };
  }
}

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
   * App-provided data resolver for the `execute_query` tool.
   * When set, the AI can call `execute_query` to run ad-hoc queries against
   * the connected data sources and incorporate live results into its response.
   * If not provided, `execute_query` calls return an informative error.
   */
  dataResolver?: StudioDataResolver;
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
   * Shared map of pending tool approval callbacks.
   *
   * When a destructive tool (remove_page, remove_widget, apply_bulk_update) is
   * called, the loop registers a resolve function here before yielding a
   * `tool-approval-request` event and pausing. The host app's approval endpoint
   * should look up the toolCallId in this map, call the resolver with the user's
   * decision, and delete the entry.
   *
   * When not provided, destructive tools execute without approval.
   */
  approvalPending?: Map<string, (approved: boolean, reason?: string) => void>;
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
    dataResolver,
    privateMode = false,
    rateLimit,
    approvalPending,
    approvalTimeoutMs = 120_000,
    pageSnapshot,
    richContext,
    enrichedContext,
  } = options;

  // Tools that pause for user approval before execution. Derived directly from
  // `DESTRUCTIVE_TOOLS` (`studioAITools.ts`) — the single source of truth for
  // "which tools are destructive" — so the chat approval gate and the MCP
  // `destructiveHint` annotations can't drift apart.
  const TOOLS_REQUIRING_APPROVAL = DESTRUCTIVE_TOOLS;

  const systemPrompt = buildAISystemPrompt(initialState, customWidgets, focusedWidgetId, skills, {
    privateMode,
    richContext,
    enrichedContext,
  });

  // T1-2 — state-reading tools whose output would defeat `privateMode`. In
  // private mode the `<dashboard_state>` block is withheld from the system prompt
  // so sensitive business data is never sent to the provider, but these tools
  // return that same data (field distinct values, widget configs, filter values,
  // source labels) which then round-trips back to the provider in the tool-result
  // message. `execute_query` belongs here for the same reason: when a
  // `dataResolver` is configured it returns live database rows straight to the
  // provider as tool output — at least as sensitive as dashboard structure or
  // field values — so private mode must withhold it too, even when a resolver is
  // present. We use approach (a) from the review — exclude them from the
  // advertised built-in list entirely — rather than redacting tool output,
  // keeping the fix self-contained to this file. Combined with the T1-1
  // dispatch-time gate, an injected call to one of these is rejected as an
  // unadvertised tool.
  const PRIVATE_MODE_EXCLUDED_TOOLS = new Set([
    'get_dashboard_state',
    'list_pages',
    'summarise_page',
    'execute_query',
  ]);

  // Build effective tool list.
  //
  // Two built-in tools can't function in this server-side loop unless the host
  // opts in, so we never advertise them to the model by default — otherwise it
  // calls them and dead-ends on a runtime error:
  // - `summarise_page` needs live per-widget row data that only exists on the
  //   client (see useChartWidgetData); the server only receives structural state.
  //   Offered only when the host explicitly lists it in `allowedTools`.
  // - `execute_query` needs an app-provided `dataResolver`; without one it can
  //   only return an error. Offered only when a resolver is configured.
  const builtInTools = (
    allowedTools
      ? STUDIO_AI_TOOLS.filter((t) => (allowedTools as string[]).includes(t.function.name))
      : STUDIO_AI_TOOLS
  ).filter((t) => {
    // T1-2 — never advertise state-reading tools in private mode.
    if (privateMode && PRIVATE_MODE_EXCLUDED_TOOLS.has(t.function.name)) {
      return false;
    }
    if (t.function.name === 'execute_query') {
      return Boolean(dataResolver);
    }
    if (t.function.name === 'summarise_page') {
      // Enable when a live data snapshot was pre-built client-side, or host opts in explicitly.
      return Boolean(pageSnapshot) || Boolean(allowedTools?.includes('summarise_page'));
    }
    return true;
  });

  const skillToolDefs = (skills ?? [])
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
    skillHandlers,
    skills,
    dataResolver,
    customWidgets,
    pageSnapshot,
    approvalPending,
    approvalTimeoutMs,
    signal,
    onToolError,
    advertisedToolNames,
    toolsRequiringApproval: TOOLS_REQUIRING_APPROVAL,
  };

  let currentMessages = toOpenAIMessages(systemPrompt, messages);
  let currentState = initialState;

  // Token usage accumulator across all iterations
  const usage: StudioAIUsage = { inputTokens: 0, outputTokens: 0, iterations: 0 };
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
