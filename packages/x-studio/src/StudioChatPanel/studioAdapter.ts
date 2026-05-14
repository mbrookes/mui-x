import type { ChatAdapter, ChatMessage, ChatMessageChunk } from '@mui/x-chat/headless';
import type { StudioController } from '../store/StudioController';
import type { StudioWidget } from '../models';
import { buildAISystemPrompt } from '../internals/buildAISystemPrompt';
import { STUDIO_AI_TOOLS, type StudioAIToolName } from './studioAITools';

/**
 * Configuration for the x-studio AI assistant.
 * The developer supplies these — typically from environment variables or server-side config.
 */
export interface StudioAIConfig {
  /**
   * OpenAI-compatible completions endpoint.
   *
   * **Direct (dev only):** `https://api.openai.com/v1/chat/completions`
   * **Recommended for production:** URL of your own server-side proxy, e.g.
   * `https://your-app.com/api/ai/chat`. The proxy holds the API key server-side
   * so it is never exposed in the browser bundle.
   */
  endpoint: string;
  /**
   * API key sent as `Authorization: Bearer <key>`.
   * Omit when using a server-side proxy — store the key in the proxy instead.
   * For quick local development this can be set via `LLM_API_KEY`, but
   * **never** commit or ship a key in client-side code.
   */
  apiKey?: string;
  /** Model to use, e.g. `'gpt-4o'`. Defaults to `'gpt-4o'`. */
  model?: string;
  /**
   * Additional HTTP headers sent with every request to `endpoint`.
   * Use this to authenticate with your server-side proxy without exposing the
   * LLM API key in the browser, e.g.:
   * ```ts
   * headers: { 'X-Studio-Token': import.meta.env.LLM_TOKEN }
   * ```
   */
  headers?: Record<string, string>;
}

// ── OpenAI message types (subset) ─────────────────────────────────────────────

interface OpenAITextMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenAIToolCallMessage {
  role: 'assistant';
  content: null;
  tool_calls: Array<{
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

type OpenAIMessage = OpenAITextMessage | OpenAIToolCallMessage | OpenAIToolResultMessage;

// ── Helpers ───────────────────────────────────────────────────────────────────

type ChatSendMessageInput = Parameters<ChatAdapter['sendMessage']>[0];

/**
 * Convert x-chat ChatMessage[] to OpenAI messages format.
 * Extracts text parts and tool invocations from each message.
 */
function toOpenAIMessages(systemPrompt: string, messages: ChatMessage[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = [{ role: 'system', content: systemPrompt }];

  for (const msg of messages) {
    const textParts = msg.parts
      .filter((p) => p.type === 'text')
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('');

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
        // Assistant message with tool calls
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
        // Follow up with tool results
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

// ── Tool executor ─────────────────────────────────────────────────────────────

interface ToolCallResult {
  toolCallId: string;
  toolName: string;
  input: unknown;
  output: string;
}

/**
 * Executes a single tool call against the studio controller.
 * Returns a result string for the OpenAI tool message.
 */
function executeTool(toolName: string, input: unknown, controller: StudioController): string {
  const args = (input ?? {}) as Record<string, unknown>;
  const name = toolName as StudioAIToolName;
  const state = controller.getState();

  switch (name) {
    case 'get_dashboard_state': {
      return buildAISystemPrompt(state);
    }

    case 'add_page': {
      const title = String(args.title ?? 'New Page');
      const newId = controller.addPage(title);
      return JSON.stringify({ success: true, pageId: newId, title });
    }

    case 'set_dashboard_title': {
      const title = String(args.title ?? '');
      controller.setDashboardTitle(title);
      return JSON.stringify({ success: true, title });
    }

    case 'add_widget': {
      const kind = String(args.kind ?? 'chart') as StudioWidget['kind'];
      const title = String(args.title ?? '');
      const sourceId = args.sourceId ? String(args.sourceId) : undefined;
      const config = (args.config ?? {}) as StudioWidget['config'];
      const newWidget: StudioWidget = {
        id: `widget-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        kind,
        title,
        sourceId,
        config,
      };
      controller.addWidget(newWidget);
      return JSON.stringify({ success: true, widgetId: newWidget.id, title });
    }

    case 'update_widget': {
      const widgetId = String(args.widgetId ?? '');
      const changes: Partial<Omit<StudioWidget, 'id'>> = {};
      if (args.title !== undefined) {
        changes.title = String(args.title);
      }
      if (args.sourceId !== undefined) {
        changes.sourceId = String(args.sourceId);
      }
      if (args.config !== undefined) {
        controller.updateWidgetConfig(widgetId, args.config as StudioWidget['config']);
      }
      if (Object.keys(changes).length > 0) {
        controller.updateWidget(widgetId, changes);
      }
      return JSON.stringify({ success: true, widgetId });
    }

    case 'remove_widget': {
      // remove_widget is handled separately (needs confirmation) — should not reach here in normal flow
      const widgetId = String(args.widgetId ?? '');
      controller.removeWidget(widgetId);
      return JSON.stringify({ success: true, widgetId });
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  }
}

// ── SSE parser ────────────────────────────────────────────────────────────────

async function* parseSSE(response: Response): AsyncGenerator<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) {
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') {
          return;
        }
        try {
          yield JSON.parse(payload) as Record<string, unknown>;
        } catch {
          // skip malformed lines
        }
      }
    }
  }
}

// ── Main adapter factory ──────────────────────────────────────────────────────

/**
 * Creates a `ChatAdapter` that connects x-studio to any OpenAI-compatible LLM endpoint.
 *
 * @param config - Endpoint URL, optional API key, and model name.
 * @param controller - The `StudioController` instance (tools call methods on it directly).
 * @param onRemoveWidgetRequest - Called when the LLM requests `remove_widget`;
 *   the host should show a confirmation dialog and resolve `true` to proceed or `false` to cancel.
 */
export function createStudioChatAdapter(
  config: StudioAIConfig,
  controller: StudioController,
  onRemoveWidgetRequest?: (widgetId: string, widgetTitle: string) => Promise<boolean>,
): ChatAdapter {
  const { endpoint, apiKey, model = 'gpt-4o', headers: extraHeaders } = config;

  return {
    async sendMessage(input: ChatSendMessageInput): Promise<ReadableStream<ChatMessageChunk>> {
      const systemPrompt = buildAISystemPrompt(controller.getState());
      const openAIMessages = toOpenAIMessages(systemPrompt, input.messages);

      const msgId = `msg-${Date.now()}`;
      let textPartId = 'text-0';
      let textStarted = false;

      return new ReadableStream<ChatMessageChunk>({
        async start(streamController) {
          streamController.enqueue({ type: 'start', messageId: msgId });

          async function doRequest(messages: OpenAIMessage[], isRetry = false): Promise<void> {
            let response: Response;
            try {
              response = await fetch(endpoint, {
                method: 'POST',
                signal: input.signal,
                headers: {
                  'Content-Type': 'application/json',
                  ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
                  ...extraHeaders,
                },
                body: JSON.stringify({
                  model,
                  messages,
                  tools: STUDIO_AI_TOOLS,
                  tool_choice: 'auto',
                  stream: true,
                }),
              });
            } catch (err) {
              if (input.signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
                streamController.enqueue({ type: 'abort', messageId: msgId });
                streamController.close();
              } else {
                streamController.error(err);
              }
              return;
            }

            if (!response.ok) {
              const errText = await response.text().catch(() => response.statusText);
              streamController.error(new Error(`HTTP ${response.status}: ${errText}`));
              return;
            }

            // Track tool call accumulation for this request
            const reqToolCalls: Record<
              number,
              { id: string; name: string; argsBuffer: string; extra_content?: unknown }
            > = {};
            // Gemini omits `index` but provides `id`; map id → idx so that tool calls
            // arriving in separate SSE chunks (each with a single entry, no index) are
            // correctly assigned to distinct slots instead of all collapsing to index 0.
            const idToIdx: Record<string, number> = {};
            let nextAutoIdx = 0;
            let finishReason: string | null = null;

            for await (const chunk of parseSSE(response)) {
              if (input.signal.aborted) {
                streamController.enqueue({ type: 'abort', messageId: msgId });
                streamController.close();
                return;
              }

              const choices = chunk.choices as Array<{
                delta: {
                  content?: string | null;
                  tool_calls?: Array<{
                    index: number;
                    id?: string;
                    function?: { name?: string; arguments?: string };
                    // Gemini-specific: thought_signature required for tool results
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
              const finish = choice.finish_reason;
              if (finish) {
                finishReason = finish;
              }

              // Text content
              if (delta.content) {
                if (!textStarted) {
                  streamController.enqueue({ type: 'text-start', id: textPartId });
                  textStarted = true;
                }
                streamController.enqueue({
                  type: 'text-delta',
                  id: textPartId,
                  delta: delta.content,
                });
              }

              // Tool calls accumulation
              if (delta.tool_calls) {
                delta.tool_calls.forEach((tc, i) => {
                  // Resolve the slot index for this tool-call fragment:
                  // 1. OpenAI always provides `index` — use it directly.
                  // 2. Gemini omits `index` but provides a stable `id` — look up or
                  //    assign a new auto-incrementing slot so that each distinct tool
                  //    call gets its own entry even when chunks arrive one-per-delta.
                  // 3. Last resort: fall back to the forEach position `i`.
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
                  if (tc.id) {
                    reqToolCalls[idx].id = tc.id;
                  }
                  if (tc.extra_content) {
                    reqToolCalls[idx].extra_content = tc.extra_content;
                  }
                  if (tc.function?.name) {
                    reqToolCalls[idx].name += tc.function.name;
                  }
                  if (tc.function?.arguments) {
                    reqToolCalls[idx].argsBuffer += tc.function.arguments;
                  }
                });
              }
            }

            // Finalize text
            if (textStarted && !isRetry) {
              streamController.enqueue({ type: 'text-end', id: textPartId });
              textStarted = false;
              textPartId = `text-${Date.now()}`;
            }

            // Process tool calls if any (Gemini may use finish_reason 'stop' even for tool calls)
            const toolCallEntries = Object.entries(reqToolCalls);
            if (toolCallEntries.length > 0) {
              const toolResults: ToolCallResult[] = [];
              const assistantToolCallMsg: OpenAIToolCallMessage = {
                role: 'assistant',
                content: null,
                tool_calls: toolCallEntries.map(([, tc]) => ({
                  id: tc.id,
                  type: 'function' as const,
                  function: { name: tc.name, arguments: tc.argsBuffer },
                  // Echo back thought_signature so Gemini can correlate tool results
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

                // Emit tool-input-start and available chunks so UI shows the tool call
                streamController.enqueue({
                  type: 'tool-input-start',
                  toolCallId: tc.id,
                  toolName: tc.name,
                  dynamic: true,
                });
                streamController.enqueue({
                  type: 'tool-input-delta',
                  toolCallId: tc.id,
                  inputTextDelta: tc.argsBuffer,
                });

                // Confirmation for remove_widget
                if (tc.name === 'remove_widget' && onRemoveWidgetRequest) {
                  const args = toolInput as { widgetId: string; widgetTitle?: string };
                  // eslint-disable-next-line no-await-in-loop
                  const confirmed = await onRemoveWidgetRequest(
                    args.widgetId ?? '',
                    args.widgetTitle ?? args.widgetId ?? 'this widget',
                  );
                  if (!confirmed) {
                    streamController.enqueue({
                      type: 'tool-output-denied',
                      toolCallId: tc.id,
                      reason: 'User cancelled the removal.',
                    });
                    toolResults.push({
                      toolCallId: tc.id,
                      toolName: tc.name,
                      input: toolInput,
                      output: JSON.stringify({ cancelled: true }),
                    });
                    continue;
                  }
                }

                const output = executeTool(tc.name, toolInput, controller);
                streamController.enqueue({
                  type: 'tool-output-available',
                  toolCallId: tc.id,
                  output,
                });

                toolResults.push({
                  toolCallId: tc.id,
                  toolName: tc.name,
                  input: toolInput,
                  output,
                });
              }

              // Build follow-up messages with tool results and continue
              const followUpMessages: OpenAIMessage[] = [
                ...messages,
                assistantToolCallMsg,
                ...toolResults.map(
                  (r): OpenAIToolResultMessage => ({
                    role: 'tool',
                    tool_call_id: r.toolCallId,
                    content: r.output,
                  }),
                ),
              ];

              // Re-emit text-start for the follow-up response
              if (!textStarted) {
                textPartId = `text-${Date.now()}`;
              }
              await doRequest(followUpMessages, false);
              return;
            }

            streamController.enqueue({
              type: 'finish',
              messageId: msgId,
              finishReason: finishReason ?? 'stop',
            });
            streamController.close();
          }

          try {
            await doRequest(openAIMessages);
          } catch (err) {
            // Catch anything not handled inside doRequest (e.g. thrown by parseSSE,
            // executeTool, or a recursive doRequest call) and surface it as a stream
            // error so processStream can report it instead of hanging forever.
            // eslint-disable-next-line no-console
            console.error('[StudioChatAdapter] Unhandled error in doRequest:', err);
            try {
              streamController.error(err);
            } catch {
              // Controller may already be closed/errored — ignore.
            }
          }
        },
      });
    },
  };
}
