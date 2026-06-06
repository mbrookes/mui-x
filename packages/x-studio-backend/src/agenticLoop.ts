/**
 * Server-side agentic loop for x-studio-backend.
 *
 * Calls the LLM, accumulates tool calls, executes them via `executeToolOnState`,
 * and continues until the model produces a final text response.
 *
 * Yields `StudioAISSEEvent` objects. Callers should encode these as SSE and stream
 * them to the client.
 */
import type { ChatMessage } from '@mui/x-chat/headless';
import type { StudioState, StudioCustomWidgetDef, StateMutation, SerializableSkill } from '@mui/x-studio';
import { buildAISystemPrompt } from '@mui/x-studio/internals/buildAISystemPrompt';
import { STUDIO_AI_TOOLS } from '@mui/x-studio/StudioChatPanel/studioAITools';
import { parseSSE } from './parseSSE';
import { executeToolOnState } from './executeToolOnState';
import type { StudioAISSEEvent, StateMutation } from './models/protocol';
import type { SerializableSkill } from '@mui/x-studio';

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
  const { endpoint, apiKey, model = 'gpt-4o', headers: extraHeaders = {}, signal, onToolError } =
    options;

  const systemPrompt = buildAISystemPrompt(initialState, customWidgets, focusedWidgetId, skills);

  // Build effective tool list
  const builtInTools = allowedTools
    ? STUDIO_AI_TOOLS.filter((t) => (allowedTools as string[]).includes(t.function.name))
    : STUDIO_AI_TOOLS;

  const skillToolDefs = (skills ?? [])
    .filter((s) => s.mode === 'client-handler' && s.tool)
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

  // Safety limit on agentic turns
  for (let turn = 0; turn < 10; turn += 1) {
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

    if (toolCallEntries.length === 0) {
      // No tool calls — model produced a final text response
      yield { type: 'finish', finishReason: finishReason ?? 'stop' };
      return;
    }

    // ── Execute tool calls ────────────────────────────────────────────────────

    const toolResults: Array<{ toolCallId: string; toolName: string; input: unknown; output: string }> = [];
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

      // Check if this is a client-handler skill tool
      const isClientTool = (skills ?? [])
        .filter((s) => s.mode === 'client-handler' && s.tool)
        .some((s) => s.tool!.name === tc.name);

      if (isClientTool) {
        // Emit event for client to handle (v2 — not yet fully supported)
        yield { type: 'client-tool-call', toolCallId: tc.id, toolName: tc.name, input: toolInput };
        // Use a placeholder output so the loop can continue
        const output = JSON.stringify({ error: 'client-handler tools require client-side execution' });
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
      try {
        const result = executeToolOnState(tc.name, toolInput, currentState, customWidgets);
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
  yield { type: 'error', message: 'Agentic loop exceeded maximum turn limit.' };
}
