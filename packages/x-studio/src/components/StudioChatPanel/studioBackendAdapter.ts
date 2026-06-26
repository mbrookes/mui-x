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
import type { ChatAdapter, ChatMessageChunk } from '@mui/x-chat/headless';
import type { StudioController } from '../../store/StudioController';
import type { StudioCustomWidgetDef, StateMutation, SerializableSkill } from '../../models';
import { applyStateMutation } from './applyStateMutation';
import type { StudioAIToolName } from './studioAITools';
import { buildWidgetDataSummary } from './generateInsight';
import { buildRichContext } from './richContext';

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
   * When `false`, tool call cards (showing which tools the AI called and their
   * results) are hidden from the chat interface. Defaults to `true`.
   *
   * Set to `false` in production to keep the conversation clean. In development,
   * leaving this enabled (the default) helps inspect AI tool usage.
   * @default true
   */
  showToolCalls?: boolean;
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
  /**
   * Token budget for the additional "rich context" attached to each chat request
   * (per-field summary statistics, active-page layout + cross-filter graph, and
   * recent user mutations). Sections are included in priority order until the
   * budget is reached; the rest are dropped and noted to the model.
   *
   * Larger values give the model more signal at higher token cost. Has no effect
   * in `privateMode` (rich context is never sent then).
   * @default 4000
   */
  contextBudgetTokens?: number;
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
  const {
    endpoint,
    headers: extraHeaders,
    allowedTools,
    skills,
    privateMode,
    onUsage,
    contextBudgetTokens,
  } = config;
  const baseUrl = endpoint.replace(/\/?$/, '');
  const chatUrl = `${baseUrl}/chat`;
  const approvalUrl = `${baseUrl}/approval`;

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

  // Strip non-serializable fields from custom widgets before sending to the server.
  // `icon` (a React element), `component`, and `setupPanel` (React components) are never
  // consumed server-side and, in development, JSX elements carry an `_owner` Fiber reference
  // that makes `JSON.stringify` throw on the circular React internals. Only the metadata the
  // server uses for the system prompt and tool execution is forwarded.
  const serializableCustomWidgets = customWidgets?.map((w) => ({
    kind: w.kind,
    label: w.label,
    description: w.description,
    requiresDataSource: w.requiresDataSource,
    aiInsight: w.aiInsight,
    defaultConfig: w.defaultConfig,
  }));

  // Active response body reader — cancelled by stop() for immediate abort cleanup.
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  return {
    async sendMessage(input: ChatSendMessageInput): Promise<ReadableStream<ChatMessageChunk>> {
      const msgId = `msg-${Date.now()}`;
      const textPartId = `text-0`;
      const reasoningId = `r-thinking`;
      let textStarted = false;
      let reasoningEnded = false;

      // Helper: close the synthetic "Thinking…" reasoning part once real content arrives.
      const endReasoning = (
        streamController: ReadableStreamDefaultController<ChatMessageChunk>,
      ) => {
        if (!reasoningEnded) {
          reasoningEnded = true;
          streamController.enqueue({ type: 'reasoning-end', id: reasoningId });
        }
      };

      // Build a per-widget data snapshot from the active page so the server-side
      // summarise_page handler has live pipeline-filtered row data to work with.
      const state = controller.getState();
      const activePage = state.pages[state.dashboard.activePageId];
      const pageWidgetIds = (activePage?.widgetRows ?? []).flat() as string[];
      const pageSnapshotParts = pageWidgetIds.flatMap((id) => {
        const w = state.widgets[id];
        if (!w) {
          return [];
        }
        // Cap at 15 rows per widget to keep the total snapshot small enough for the
        // model to have room to generate a text response. Stats (min/max/avg) are
        // always included from the full filtered dataset regardless of this limit.
        const dataSummary = buildWidgetDataSummary(w, state, { sampling: 'stride', maxRows: 15 });
        if (!dataSummary) {
          return []; // skip non-data widgets (text, filter, alert-banner, etc.)
        }
        return [`### ${w.title} (${w.kind})\n${dataSummary}`];
      });
      const pageSnapshot =
        pageSnapshotParts.length > 0 ? pageSnapshotParts.join('\n\n') : undefined;

      // Richer, purely-additive context (field stats, layout + cross-filter graph,
      // recent mutations) to give the model more signal. Never sent in private mode
      // since field statistics expose real data values.
      const richContext = privateMode
        ? undefined
        : buildRichContext(state, controller, { budgetTokens: contextBudgetTokens });

      // Strip raw data rows and adapter instances before sending state to the server.
      // The server uses state only for structural information (widget configs, filters, layout)
      // and never reads dataSources.rows or dataSources.adapter. Sending raw rows can push
      // the request body into tens of megabytes, exceeding server body-size limits.
      // The pageSnapshot (built above from live client-side pipeline rows) is the server's
      // source of truth for data analysis via the summarise_page tool.
      const serializableState = {
        ...state,
        dataSources: Object.fromEntries(
          Object.entries(state.dataSources).map(([id, source]) => {
            /* eslint-disable-next-line @typescript-eslint/naming-convention -- omit rows/adapter via rest */
            const { rows: _rows, adapter: _adapter, ...sourceWithoutData } = source;
            return [id, sourceWithoutData];
          }),
        ),
      };

      return new ReadableStream<ChatMessageChunk>({
        async start(streamController) {
          streamController.enqueue({ type: 'start', messageId: msgId });

          // Emit a synthetic reasoning part immediately so the user sees "Thinking…"
          // while the server processes the request. It will be closed when real content arrives.
          streamController.enqueue({ type: 'reasoning-start', id: reasoningId });

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
                dashboardState: serializableState,
                customWidgets: serializableCustomWidgets,
                focusedWidgetId,
                allowedTools,
                skills: serializableSkills,
                privateMode,
                pageSnapshot,
                richContext,
              }),
            });
          } catch (err) {
            endReasoning(streamController);
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
            endReasoning(streamController);
            const errText = await response.text().catch(() => response.statusText);
            streamController.error(new Error(`HTTP ${response.status}: ${errText}`));
            return;
          }

          // Parse the `StudioAISSEEvent` stream
          const reader = response.body?.getReader();
          if (!reader) {
            endReasoning(streamController);
            streamController.error(new Error('No response body.'));
            return;
          }
          activeReader = reader;

          const decoder = new TextDecoder();
          let buffer = '';

          const processLine = (line: string) => {
            if (!line.startsWith('data: ')) {
              return;
            }
            const payload = line.slice(6).trim();
            if (!payload) {
              return;
            }
            let event: Record<string, unknown>;
            try {
              event = JSON.parse(payload);
            } catch {
              return;
            }

            const { type } = event;

            if (type === 'text-delta') {
              endReasoning(streamController);
              if (!textStarted) {
                streamController.enqueue({ type: 'text-start', id: textPartId });
                textStarted = true;
              }
              streamController.enqueue({
                type: 'text-delta',
                id: textPartId,
                delta: String(event.delta ?? ''),
              });
            } else if (type === 'reasoning-start') {
              // Forward server-emitted reasoning chunks (e.g. from Claude extended thinking).
              // Close our synthetic "Thinking…" block first so blocks don't overlap.
              endReasoning(streamController);
              streamController.enqueue({
                type: 'reasoning-start',
                id: String(event.id ?? 'r-server'),
              });
            } else if (type === 'reasoning-delta') {
              streamController.enqueue({
                type: 'reasoning-delta',
                id: String(event.id ?? 'r-server'),
                delta: String(event.delta ?? ''),
              });
            } else if (type === 'reasoning-end') {
              streamController.enqueue({
                type: 'reasoning-end',
                id: String(event.id ?? 'r-server'),
              });
            } else if (type === 'tool-activity') {
              endReasoning(streamController);
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
            } else if (type === 'step-start') {
              // Emit an x-chat start-step chunk to visually separate agentic iterations.
              streamController.enqueue({ type: 'start-step' });
            } else if (type === 'message-metadata') {
              // Forward model name + token counts into the assistant message metadata.
              streamController.enqueue({
                type: 'message-metadata',
                metadata: (event as { metadata: Record<string, unknown> }).metadata,
              });
            } else if (type === 'tool-approval-request') {
              // Forward the approval request as an x-chat chunk so the UI can
              // render an inline confirmation card (via ChatConfirmation / ToolPart).
              streamController.enqueue({
                type: 'tool-approval-request',
                toolCallId: String((event as { toolCallId?: string }).toolCallId ?? ''),
                toolName: String((event as { toolName?: string }).toolName ?? ''),
                input: (event as { input?: unknown }).input ?? {},
              });
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
              endReasoning(streamController);
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
              endReasoning(streamController);
              streamController.error(
                /* minify-error-disabled */ new Error(
                  String(event.message ?? 'Unknown server error'),
                ),
              );
            }
          };

          try {
            while (true) {
              // Sequential SSE stream: each chunk depends on the previous read, so awaiting
              // inside the loop is intentional (the reads cannot be parallelized).
              // eslint-disable-next-line no-await-in-loop
              const { done, value } = await reader.read();
              if (done) {
                break;
              }

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
          } finally {
            activeReader = null;
          }
        },
      });
    },

    stop() {
      // Cancel the active response body reader so the browser releases the connection.
      // ChatBox has already aborted the fetch signal before calling stop(), so this
      // is a best-effort cleanup to free resources immediately.
      activeReader?.cancel().catch(() => {});
      activeReader = null;
    },

    async addToolApprovalResponse({
      id,
      approved,
      reason,
    }: {
      id: string;
      approved: boolean;
      reason?: string;
    }) {
      await fetch(approvalUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...extraHeaders },
        body: JSON.stringify({ id, approved, reason }),
      });
    },
  };
}
