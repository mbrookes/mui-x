/**
 * Thin client adapter for `@mui/x-studio-ai-middleware` endpoints.
 *
 * This adapter:
 * 1. Serializes skills (strips non-JSON-serializable `execute` functions)
 * 2. POSTs `StudioAIRequest` JSON to the configured backend endpoint
 * 3. Reads the `StudioAISSEEvent` stream back
 * 4. Feeds text deltas to the chat stream
 * 5. Applies `state-mutation` events to the local `StudioController`
 */
import type { ChatAdapter, ChatMessage, ChatMessageChunk } from '@mui/x-chat/headless';
import type { StudioController } from '../../store/StudioController';
import type { StudioCustomWidgetDef, StateMutation, SerializableSkill } from '../../models';
import { applyStateMutation } from './applyStateMutation';
import type { StudioAIToolName } from './studioAITools';

/**
 * Configuration for the x-studio AI assistant.
 *
 * `x-studio` is a UI-only package — it contains no LLM implementation.
 * Point `endpoint` at an `x-studio-ai-middleware` server (e.g. `examples/x-studio-dev-server`)
 * which holds the API key, builds the system prompt, and runs tool calls server-side.
 */
export interface StudioAIConfig {
  /**
   * Base URL of your server-side AI handler.
   * Typically `http://localhost:3020/api/ai` when using `x-studio-dev-server`.
   * The following paths are appended automatically for each operation:
   * - `/chat` — streaming chat (SSE)
   * - `/insight` — widget insight generation
   * - `/title` — chat session title generation
   * - `/widget` — widget creation from description
   */
  endpoint: string;
  /**
   * Additional HTTP headers sent with every AI request.
   * Use this to authenticate with your server, e.g.:
   * ```ts
   * headers: { Authorization: `Bearer ${import.meta.env.STUDIO_SERVER_TOKEN}` }
   * ```
   */
  headers?: Record<string, string>;
  /**
   * Whitelist of built-in tool names the model is allowed to call.
   * When omitted, all built-in tools are enabled.
   * Set to `[]` to disable all built-in tools.
   */
  allowedTools?: StudioAIToolName[];
  /**
   * Skills to register with the AI assistant.
   * `execute` functions (if present) are stripped before sending to the server —
   * only the serializable fields (`name`, `mode`, `promptFragment`, `tool` schema)
   * are forwarded. All execution happens server-side.
   */
  skills?: SerializableSkill[];
  /**
   * When `true`, the current dashboard state is omitted from the system prompt.
   * The model receives schema information only — no widget configurations, field
   * names, or layout data are sent to the LLM provider.
   *
   * Use this when your dashboard displays sensitive business data and you want
   * to prevent it from being included in LLM API calls.
   * @default false
   */
  privateMode?: boolean;
  /**
   * Called after each completed AI chat request with token and iteration usage.
   * Use this to display a token counter, enforce client-side budgets, or log
   * usage to an analytics service.
   *
   * Note: server-side enforcement of token budgets is configured via
   * `rateLimit` in `StudioAIHandlerOptions` (your server endpoint, not here).
   *
   * @example
   * ```tsx
   * aiConfig={{
   *   endpoint: '/api/ai',
   *   onUsage: ({ inputTokens, outputTokens, iterations }) => {
   *     console.log(`Tokens: ${inputTokens + outputTokens}, turns: ${iterations}`);
   *   },
   * }}
   * ```
   */
  onUsage?: (usage: { inputTokens: number; outputTokens: number; iterations: number }) => void;
}

type ChatSendMessageInput = Parameters<ChatAdapter['sendMessage']>[0];

/**
 * Creates a `ChatAdapter` that delegates the full AI pipeline to an
 * `x-studio-ai-middleware` server endpoint.
 *
 * The server builds the system prompt, calls the LLM, executes tool calls,
 * and streams `StudioAISSEEvent` objects back. This adapter applies the
 * `state-mutation` events to the local controller.
 */
export function createBackendChatAdapter(
  config: StudioAIConfig,
  controller: StudioController,
  customWidgets?: StudioCustomWidgetDef[],
  focusedWidgetId?: string,
): ChatAdapter {
  const { endpoint, headers: extraHeaders, allowedTools, skills, privateMode, onUsage } = config;
  const chatUrl = `${endpoint.replace(/\/?$/, '')}/chat`;

  // Skills are already in serializable form — the execute function (if present) is stripped
  // by the caller (StudioAISkill satisfies SerializableSkill structurally).
  const serializableSkills = skills?.map((s) => ({
    name: s.name,
    mode: s.mode,
    promptFragment: s.promptFragment,
    tool: s.tool
      ? { name: s.tool.name, description: s.tool.description, parameters: s.tool.parameters }
      : undefined,
  }));

  return {
    async sendMessage(input: ChatSendMessageInput): Promise<ReadableStream<ChatMessageChunk>> {
      const msgId = `msg-${Date.now()}`;
      const textPartId = `text-0`;
      let textStarted = false;

      return new ReadableStream<ChatMessageChunk>({
        async start(streamController) {
          streamController.enqueue({ type: 'start', messageId: msgId });

          let response: Response;
          try {
            response = await fetch(chatUrl, {
              method: 'POST',
              signal: input.signal,
              headers: {
                'Content-Type': 'application/json',
                ...extraHeaders,
              },
              body: JSON.stringify({
                messages: input.messages,
                dashboardState: controller.getState(),
                customWidgets,
                focusedWidgetId,
                allowedTools,
                skills: serializableSkills,
                privateMode,
              }),
            });
          } catch (err) {
            if (
              input.signal?.aborted ||
              (err instanceof DOMException && err.name === 'AbortError')
            ) {
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

          // Parse the `StudioAISSEEvent` stream
          const reader = response.body?.getReader();
          if (!reader) {
            streamController.error(new Error('No response body.'));
            return;
          }

          const decoder = new TextDecoder();
          let buffer = '';

          const processLine = (line: string) => {
            if (!line.startsWith('data: ')) return;
            const payload = line.slice(6).trim();
            if (!payload) return;
            let event: Record<string, unknown>;
            try {
              event = JSON.parse(payload);
            } catch {
              return;
            }

            const { type } = event;

            if (type === 'text-delta') {
              if (!textStarted) {
                streamController.enqueue({ type: 'text-start', id: textPartId });
                textStarted = true;
              }
              streamController.enqueue({
                type: 'text-delta',
                id: textPartId,
                delta: String(event.delta ?? ''),
              });
            } else if (type === 'tool-activity') {
              const {
                phase,
                toolCallId,
                toolName,
                input: toolInput,
              } = event as {
                phase: string;
                toolCallId: string;
                toolName: string;
                input: unknown;
                output?: string;
              };
              if (phase === 'start') {
                streamController.enqueue({
                  type: 'tool-input-start',
                  toolCallId,
                  toolName,
                  dynamic: true,
                });
                streamController.enqueue({
                  type: 'tool-input-delta',
                  toolCallId,
                  inputTextDelta: JSON.stringify(toolInput ?? {}),
                });
              } else if (phase === 'complete') {
                streamController.enqueue({
                  type: 'tool-output-available',
                  toolCallId,
                  output: String((event as { output?: string }).output ?? ''),
                });
              }
            } else if (type === 'state-mutation') {
              try {
                applyStateMutation((event as { mutation: StateMutation }).mutation, controller);
              } catch (err) {
                console.error('[StudioBackendAdapter] Failed to apply state mutation:', err);
              }
            } else if (type === 'usage') {
              onUsage?.({
                inputTokens: (event as { inputTokens: number }).inputTokens,
                outputTokens: (event as { outputTokens: number }).outputTokens,
                iterations: (event as { iterations: number }).iterations,
              });
            } else if (type === 'finish') {
              if (textStarted) {
                streamController.enqueue({ type: 'text-end', id: textPartId });
              }
              streamController.enqueue({
                type: 'finish',
                messageId: msgId,
                finishReason: String(event.finishReason ?? 'stop'),
              });
              streamController.close();
            } else if (type === 'error') {
              streamController.error(new Error(String(event.message ?? 'Unknown server error')));
            }
          };

          try {
            while (true) {
              // eslint-disable-next-line no-await-in-loop -- sequential streaming read
              // react-doctor-disable-next-line react-doctor/async-await-in-loop -- sequential stream: each chunk depends on the previous
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() ?? '';
              for (const line of lines) {
                processLine(line);
              }
            }
          } catch (err) {
            if (!input.signal?.aborted) {
              streamController.error(err);
            }
          }
        },
      });
    },
  };
}
