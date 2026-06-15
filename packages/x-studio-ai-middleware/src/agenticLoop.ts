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
  StateMutation,
  SerializableSkill,
  StudioAISkill,
  StudioDataResolver,
  StudioAIRateLimit,
  StudioAIUsage,
} from './models/aiTypes';
import { buildAISystemPrompt } from './buildAISystemPrompt';
import { STUDIO_AI_TOOLS } from './studioAITools';
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
          role: 'assistant',
          content: null,
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
          if (p.toolInvocation.output !== undefined) {
            result.push({
              role: 'tool',
              tool_call_id: p.toolInvocation.toolCallId,
              content: JSON.stringify(p.toolInvocation.output),
            });
          }
        }
      } else if (textParts) {
        result.push({ role: 'assistant', content: textParts });
      }
    }
  }

  return result;
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
   * Pre-built data snapshot of the active page's widgets, forwarded from the client
   * where live pipeline rows are available. When present, enables the `summarise_page`
   * tool so the model can produce business-focused data summaries.
   */
  pageSnapshot?: string;
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
    pageSnapshot,
  } = options;

  // Tools that pause for user approval before execution.
  const TOOLS_REQUIRING_APPROVAL = new Set(['remove_page', 'remove_widget', 'apply_bulk_update']);

  const systemPrompt = buildAISystemPrompt(initialState, customWidgets, focusedWidgetId, skills, {
    privateMode,
  });

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
      const errText = await response.text().catch(() => response.statusText);
      yield { type: 'error', message: `HTTP ${response.status}: ${errText}` };
      return;
    }

    // Accumulate tool calls and text from this LLM response
    const reqToolCalls: Record<
      number,
      { id: string; name: string; argsBuffer: string; extra_content?: unknown }
    > = {};
    const idToIdx: Record<string, number> = {};
    let nextAutoIdx = 0;
    let finishReason: string | null = null;
    let textBuffer = '';

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
        textBuffer += delta.content;
        yield { type: 'text-delta', delta: delta.content };
      }

      if (delta.tool_calls) {
        for (const [i, tc] of delta.tool_calls.entries()) {
          let idx: number;
          const tcIndex = tc.index as number | undefined;
          if (tcIndex !== undefined) {
            idx = tcIndex;
          } else if (tc.id) {
            if (idToIdx[tc.id] !== undefined) {
              idx = idToIdx[tc.id];
            } else {
              idx = nextAutoIdx;
              idToIdx[tc.id] = idx;
              nextAutoIdx += 1;
            }
          } else {
            idx = i;
          }
          if (!reqToolCalls[idx]) {
            reqToolCalls[idx] = { id: tc.id ?? '', name: '', argsBuffer: '' };
          }
          if (tc.id) reqToolCalls[idx].id = tc.id;
          if (tc.extra_content) reqToolCalls[idx].extra_content = tc.extra_content;
          if (tc.function?.name) reqToolCalls[idx].name += tc.function.name;
          if (tc.function?.arguments) reqToolCalls[idx].argsBuffer += tc.function.arguments;
        }
      }
    }

    const toolCallEntries = Object.entries(reqToolCalls);
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
      try {
        toolInput = JSON.parse(tc.argsBuffer || '{}');
      } catch {
        toolInput = {};
      }

      yield {
        type: 'tool-activity',
        toolCallId: tc.id,
        toolName: tc.name,
        phase: 'start',
        input: toolInput,
      };

      // Check if this is a server-tool skill
      const matchedSkill = skillHandlers
        .filter((s) => s.mode === 'server-tool' && s.tool)
        .find((s) => s.tool!.name === tc.name);

      if (matchedSkill?.tool?.execute) {
        // Execute the skill server-side (may be sync or async)
        try {
          const result = await Promise.resolve(
            matchedSkill.tool.execute(toolInput as Record<string, unknown>, currentState),
          );
          const output = result.output;
          if (result.mutation) {
            yield { type: 'state-mutation', mutation: result.mutation };
          }
          currentState = result.nextState;
          toolResults.push({ toolCallId: tc.id, toolName: tc.name, input: toolInput, output });
          yield {
            type: 'tool-activity',
            toolCallId: tc.id,
            toolName: tc.name,
            phase: 'complete',
            input: toolInput,
            output,
          };
        } catch (skillErr) {
          const skillError = skillErr instanceof Error ? skillErr : new Error(String(skillErr));
          onToolError?.(tc.name, skillError);
          const output = JSON.stringify({ error: skillError.message });
          toolResults.push({ toolCallId: tc.id, toolName: tc.name, input: toolInput, output });
          yield {
            type: 'tool-activity',
            toolCallId: tc.id,
            toolName: tc.name,
            phase: 'complete',
            input: toolInput,
            output,
          };
        }
        continue;
      }

      // execute_query — resolved via the app-provided dataResolver
      if (tc.name === 'execute_query') {
        let output: string;
        try {
          if (!dataResolver) {
            output = JSON.stringify({
              error:
                'execute_query is not available: no dataResolver was configured on the server. ' +
                'Pass a dataResolver in AgenticLoopOptions to enable this tool.',
            });
          } else {
            const args = toolInput as { query: string; sourceId?: string };
            const result = await dataResolver.resolve(args.query, args.sourceId);
            output = JSON.stringify(result);
          }
        } catch (queryErr) {
          const queryError = queryErr instanceof Error ? queryErr : new Error(String(queryErr));
          onToolError?.(tc.name, queryError);
          output = JSON.stringify({ error: queryError.message });
        }
        toolResults.push({ toolCallId: tc.id, toolName: tc.name, input: toolInput, output });
        yield {
          type: 'tool-activity',
          toolCallId: tc.id,
          toolName: tc.name,
          phase: 'complete',
          input: toolInput,
          output,
        };
        continue;
      }

      // Skill was declared in the request but has no registered server handler
      const isUnregisteredSkillTool = (skills ?? [])
        .filter((s) => s.mode === 'server-tool' && s.tool)
        .some((s) => s.tool!.name === tc.name);

      if (isUnregisteredSkillTool) {
        const output = JSON.stringify({
          error: `server-tool skill '${tc.name}' has no registered handler on the server.`,
        });
        toolResults.push({ toolCallId: tc.id, toolName: tc.name, input: toolInput, output });
        yield {
          type: 'tool-activity',
          toolCallId: tc.id,
          toolName: tc.name,
          phase: 'complete',
          input: toolInput,
          output,
        };
        continue;
      }

      let output: string;
      let mutation: StateMutation | undefined;

      // Check if this tool requires user approval before execution.
      if (TOOLS_REQUIRING_APPROVAL.has(tc.name) && approvalPending) {
        yield {
          type: 'tool-approval-request',
          toolCallId: tc.id,
          toolName: tc.name,
          input: toolInput,
        };

        // Pause the loop and wait for the client to send an approval response.
        // eslint-disable-next-line no-await-in-loop -- approval is an intentional blocking pause
        const { approved, reason } = await new Promise<{ approved: boolean; reason?: string }>(
          (resolve) => {
            approvalPending.set(tc.id, (a, r) => resolve({ approved: a, reason: r }));
          },
        );

        if (!approved) {
          output = JSON.stringify({
            denied: true,
            reason: reason ?? 'User denied the operation.',
          });
          toolResults.push({ toolCallId: tc.id, toolName: tc.name, input: toolInput, output });
          yield {
            type: 'tool-activity',
            toolCallId: tc.id,
            toolName: tc.name,
            phase: 'complete',
            input: toolInput,
            output,
          };
          continue;
        }
      }

      try {
        const result = executeToolOnState(
          tc.name,
          toolInput,
          currentState,
          customWidgets,
          pageSnapshot,
        );
        output = result.output;
        mutation = result.mutation;
        currentState = result.nextState;
      } catch (err) {
        const toolErr = err instanceof Error ? err : new Error(String(err));
        onToolError?.(tc.name, toolErr);
        output = JSON.stringify({ error: toolErr.message });
      }

      if (mutation) {
        yield { type: 'state-mutation', mutation };
      }
      yield {
        type: 'tool-activity',
        toolCallId: tc.id,
        toolName: tc.name,
        phase: 'complete',
        input: toolInput,
        output,
      };
      toolResults.push({ toolCallId: tc.id, toolName: tc.name, input: toolInput, output });
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
