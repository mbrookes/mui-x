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
import type { StudioCustomWidgetDef, SerializableSkill } from '../../models';
import { applyStateMutation } from './applyStateMutation';
import type { StudioAIToolName } from './studioAITools';
import { buildWidgetDataSummary } from './generateInsight';
import { buildRichContext } from './richContext';
import { parseSSEStream, serializeDashboardState } from './sseUtils';
import { createMessageId } from './chatIds';
import type { StudioChatTurnMutationLedger } from './chatTurnMutations';

/**
 * Configuration for the x-studio AI assistant.
 *
 * `x-studio` is a UI-only package — it contains no LLM implementation.
 * Point `endpoint` at an `x-studio-ai-middleware` server (e.g. `examples/x-studio-dev-server`)
 * which holds the API key, builds the system prompt, and runs tool calls server-side.
 *
 * **Referential stability is a performance hint, not a correctness requirement.**
 * `StudioChatPanel` rebuilds its `ChatAdapter` whenever this object's identity
 * changes, and the panel re-renders on every streamed token — so passing a fresh
 * object literal on each render (the shape of the examples below) rebuilds the
 * adapter constantly. Nothing breaks: the in-flight readers a `stop()` must cancel
 * are tracked in a registry owned by the panel, deliberately OUTSIDE the adapter,
 * precisely so a rebuilt adapter can still abort the stream that is actually
 * running. Memoizing (`React.useMemo`) still saves the rebuild work.
 */
export interface StudioAIConfig {
  /**
   * Base URL of your server-side AI handler.
   * Typically `http://localhost:3020/api/ai` when using `x-studio-dev-server`.
   * The following paths are appended automatically for each operation:
   * - `/chat` — streaming chat (SSE)
   * - `/approval` — tool-call approval responses
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
   *
   * **What is and isn't sent, and to whom.** This is a guarantee about the LLM
   * PROVIDER, not about your own backend. The `endpoint` below is an
   * `x-studio-ai-middleware` server that you deploy — it holds the API key, builds
   * the prompt and executes tool calls — and it already receives the entire
   * conversation. It therefore still receives `dashboardState`, which it needs to
   * execute any state-editing tool at all, and enforces private mode where it
   * actually matters: the `<dashboard_state>` block is withheld from the system
   * prompt, every state-reading tool (`get_dashboard_state`, `list_pages`,
   * `summarise_page`, `query_data_source`) is withdrawn from the advertised tool
   * set so nothing can round-trip that state back to the provider, and the write
   * tools that stay advertised phrase their rejections without disclosing state.
   *
   * What the client withholds outright is the data itself: `pageSnapshot` (sampled
   * row values) and `richContext` (per-field statistics) are never built and never
   * sent anywhere in private mode.
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

/** Response-body reader of one in-flight `sendMessage` stream. */
export type StudioStreamReader = ReadableStreamDefaultReader<Uint8Array>;

export interface CreateBackendChatAdapterOptions {
  /**
   * Registry of the response-body readers of every in-flight `sendMessage` stream,
   * cancelled by `stop()`.
   *
   * Pass a caller-owned `Set` whose lifetime is INDEPENDENT of the adapter's. The
   * adapter is rebuilt whenever any of `createBackendChatAdapter`'s inputs change
   * identity — `aiConfig` is a public prop that hosts routinely pass as an inline
   * object literal, and `focusedWidgetId` changes while the panel is open (clicking
   * another widget's "Analysis" mid-stream) — and the panel re-renders on every
   * streamed token, so rebuilds happen constantly DURING a stream. With the registry
   * living inside the adapter, the rebuilt adapter (the one `stop()` is dispatched
   * to) starts with an empty set and `stop()` cancels nothing, while the reader
   * holding the live connection is only reachable from the discarded closure.
   *
   * Defaults to an adapter-local `Set`, which is correct only when the adapter is
   * never rebuilt mid-stream.
   */
  activeReaders?: Set<StudioStreamReader>;
  /**
   * Records the `doc` snapshots around each applied `state-mutation`, keyed by the
   * assistant message id of the turn that produced it, so **Retry** can revert a
   * failed turn's already-applied edits before replaying it (see
   * `chatTurnMutations.ts`). Omit to disable that tracking.
   */
  mutationLedger?: StudioChatTurnMutationLedger;
}

/** Coerces untrusted wire data to a finite number, falling back to `0` otherwise. */
function toFiniteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

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
  options?: CreateBackendChatAdapterOptions,
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

  // Strip any non-serializable fields (notably an `execute` function) by rebuilding
  // each skill from only its serializable fields — `name`, `mode`, `promptFragment`,
  // and the `tool` schema — before it is sent to the server.
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

  // Response-body readers of every in-flight `sendMessage` stream, cancelled by
  // stop() for immediate abort cleanup. This is a Set — not a single shared
  // variable — because the panel can switch threads mid-stream (the
  // `StreamThreadPin` machinery), so multiple streams can overlap. With one shared
  // variable, the first stream's cleanup (`activeReader = null`) would drop a later
  // stream's still-live reader, making `stop()` a no-op for it. Each request adds
  // its own reader and removes only that reader when it settles, so `stop()` always
  // cancels exactly the readers that are still live.
  //
  // The registry is caller-INJECTED (see `CreateBackendChatAdapterOptions.
  // activeReaders`): a per-adapter Set solves overlapping streams but not adapter
  // churn. This adapter is rebuilt whenever `aiConfig`/`customWidgets`/
  // `focusedWidgetId` change identity, which for an unmemoized host prop is every
  // render — i.e. every streamed token — so `stop()` reaches a brand-new adapter
  // whose own Set is empty while the live reader sits in the discarded one's.
  // Ownership therefore belongs to whoever outlives the adapter, not the adapter.
  const activeReaders = options?.activeReaders ?? new Set<StudioStreamReader>();
  const mutationLedger = options?.mutationLedger;

  return {
    async sendMessage(input: ChatSendMessageInput): Promise<ReadableStream<ChatMessageChunk>> {
      const msgId = createMessageId();
      // This request's own reader, captured so cleanup removes only it (never a
      // concurrent request's reader) from the shared `activeReaders` set.
      let requestReader: StudioStreamReader | null = null;
      // A single agentic turn can interleave text and tool calls across multiple
      // steps: preamble text → tool call → final answer. Each contiguous text run
      // must render as its OWN text part, in arrival order — otherwise the final
      // answer's deltas get appended into the SAME text part as the preamble and
      // render spliced ABOVE the (earlier) tool card instead of below it (finding
      // 2.23). So the text-part id is per-run, not fixed: a new id is minted every
      // time a text run is closed by an intervening `step-start` or `tool-activity`.
      let textPartCounter = 0;
      let textPartId = `text-${textPartCounter}`;
      const reasoningId = `r-thinking`;
      let textStarted = false;
      let reasoningEnded = false;
      // Tracks whether the returned ReadableStream's controller has already been
      // closed or errored, so it's only ever settled once — calling `close()`/`error()`
      // a second time (e.g. once from a `finish` event and again from the cleanup
      // below) throws. Also lets the cleanup path detect "the stream ended without
      // a terminal `finish`/`error` event" (server closed the connection mid-response)
      // and close the stream itself instead of leaving the chat panel hung in a
      // permanently-streaming state.
      let streamSettled = false;

      // Helper: close the synthetic "Thinking…" reasoning part once real content arrives.
      const endReasoning = (
        streamController: ReadableStreamDefaultController<ChatMessageChunk>,
      ) => {
        if (!reasoningEnded) {
          reasoningEnded = true;
          streamController.enqueue({ type: 'reasoning-end', id: reasoningId });
        }
      };

      // Helper: close the current text part (if one is open) and mint a fresh id for
      // the next text run, so a text run interrupted by a tool call or a new step is
      // finalized before the tool card renders and any later text starts its own part
      // in correct arrival order (finding 2.23).
      const endTextPart = (streamController: ReadableStreamDefaultController<ChatMessageChunk>) => {
        if (textStarted) {
          streamController.enqueue({ type: 'text-end', id: textPartId });
          textStarted = false;
          textPartCounter += 1;
          textPartId = `text-${textPartCounter}`;
        }
      };

      const state = controller.getState();

      // Private mode: the client withholds the two payloads that carry actual DATA —
      // `pageSnapshot` (sampled row values) and `richContext` (per-field statistics) —
      // so they are never built and never leave the browser at all.
      //
      // `dashboardState` is deliberately NOT gated here. Gating it made private mode
      // 100% inoperative: `validateStudioAIRequestBody` hard-requires
      // `dashboardState.doc` (it is what resolves the active page and seeds the state
      // the tools mutate), so every private-mode request died in validation with zero
      // LLM calls — a defect neither package's unit suite could see, since they sit on
      // opposite sides of the wire (see `aiMiddlewareSeam.test.ts`). Withholding it is
      // also not what `privateMode` promises: the promise is provider-facing, and the
      // endpoint is the host's OWN middleware, which already receives the full
      // conversation and enforces private mode where it counts (state withheld from
      // the prompt, every state-reading tool withdrawn). See the `privateMode` doc on
      // `StudioAIConfig` for the full boundary.
      let pageSnapshot: string | undefined;
      let richContext: ReturnType<typeof buildRichContext> | undefined;

      // Strip raw data rows and adapter instances before sending state to the server.
      // The pageSnapshot (built below from live client-side pipeline rows) is the server's
      // source of truth for data analysis via the summarise_page tool.
      const serializableState = serializeDashboardState(state);

      if (!privateMode) {
        // Build a per-widget data snapshot from the active page so the server-side
        // summarise_page handler has live pipeline-filtered row data to work with.
        const activePage = state.doc.pages[state.doc.dashboard.activePageId];
        const pageWidgetIds = (activePage?.widgetRows ?? []).flat() as string[];
        const pageSnapshotParts = pageWidgetIds.flatMap((id) => {
          const w = state.doc.widgets[id];
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
        pageSnapshot = pageSnapshotParts.length > 0 ? pageSnapshotParts.join('\n\n') : undefined;

        // Richer, purely-additive context (field stats, layout + cross-filter graph,
        // recent mutations) to give the model more signal.
        richContext = buildRichContext(state, controller, { budgetTokens: contextBudgetTokens });
      }

      return new ReadableStream<ChatMessageChunk>({
        async start(streamController) {
          streamController.enqueue({ type: 'start', messageId: msgId });

          // Emit a synthetic reasoning part immediately so the user sees "Thinking…"
          // while the server processes the request. It will be closed when real content arrives.
          streamController.enqueue({ type: 'reasoning-start', id: reasoningId });

          // Close/error the stream exactly once. Guarding both here means every call
          // site can settle the stream unconditionally instead of separately tracking
          // whether some other branch already did — including the final cleanup below,
          // which settles the stream if a `finish`/`error` event never arrives (e.g. the
          // server closes the connection mid-response) so the chat panel never gets
          // stuck in a permanently-streaming state.
          const closeStream = () => {
            if (streamSettled) {
              return;
            }
            streamSettled = true;
            streamController.close();
          };
          const errorStream = (err: unknown) => {
            if (streamSettled) {
              return;
            }
            streamSettled = true;
            streamController.error(err);
          };

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
              closeStream();
            } else {
              errorStream(err);
            }
            return;
          }

          if (!response.ok) {
            endReasoning(streamController);
            const errText = await response.text().catch(() => response.statusText);
            errorStream(
              new Error(`MUI X Studio: The AI endpoint responded with HTTP ${response.status}: ${errText}
The request never reached the model, so the conversation cannot continue.
Check the endpoint URL, its authentication headers, and the server logs for this status.`),
            );
            return;
          }

          // Parse the `StudioAISSEEvent` stream. Returning `false` from a branch signals
          // `parseSSEStream` to stop reading further events — used for `finish`/`error`
          // so that any event arriving after the stream has already been settled (e.g. a
          // stray event batched in the same chunk) is never processed and never attempts
          // to `enqueue` on an already-closed/errored controller, which would throw.
          const processEvent = (event: Record<string, unknown>): void | false => {
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
              // Close any preamble text run before the tool card so the tool card
              // renders after it, and so a later (post-tool) text run starts its own
              // fresh part instead of being appended to the preamble (finding 2.23).
              endTextPart(streamController);
              // Defensive coercion (matching the `tool-approval-request` branch below):
              // a malformed/unexpected event shape must degrade gracefully rather than
              // enqueue e.g. `toolCallId: undefined`, which would leave a tool-activity
              // card permanently stuck in an "input-streaming" state.
              const rawToolActivity = event as {
                phase?: unknown;
                toolCallId?: unknown;
                toolName?: unknown;
                input?: unknown;
                output?: unknown;
              };
              const phase = String(rawToolActivity.phase ?? '');
              const toolCallId = String(rawToolActivity.toolCallId ?? '');
              const toolName = String(rawToolActivity.toolName ?? '');
              const toolInput = rawToolActivity.input;
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
                // The `tool-input-delta` above only advances the invocation to
                // `input-streaming` — x-chat's stream processor never parses its
                // text back into `toolInvocation.input`. Emit a `tool-input-available`
                // chunk carrying the already-parsed input object (mirroring the
                // `tool-approval-request` path, which forwards `input` directly) so
                // the tool card actually renders the call's arguments. The invocation
                // was already created as a dynamic tool by the `tool-input-start`
                // above, so the processor's update path just fills in `input` here.
                streamController.enqueue({
                  type: 'tool-input-available',
                  toolCallId,
                  toolName,
                  input: toolInput ?? {},
                });
              } else if (phase === 'complete') {
                streamController.enqueue({
                  type: 'tool-output-available',
                  toolCallId,
                  output: String(rawToolActivity.output ?? ''),
                });
              }
            } else if (type === 'step-start') {
              // A new agentic step begins: finalize the current text run (if any) into
              // its own part so the next step's text renders as a separate segment in
              // arrival order rather than merging into the previous step's text (2.23).
              endTextPart(streamController);
              // Emit an x-chat start-step chunk to visually separate agentic iterations.
              streamController.enqueue({ type: 'start-step' });
            } else if (type === 'message-metadata') {
              // Forward model name + token counts into the assistant message metadata.
              // Defensive coercion (matching the `tool-activity`/`usage` branches, which never
              // pass untrusted wire data straight through): the renderer (`StudioMessageRoot`)
              // draws `{metadata.model}` directly as a React child and reads numeric token /
              // iteration counts, so a non-string `model` or a non-numeric count from a
              // malformed event would crash the message renderer in non-production builds. Emit
              // only a sanitized record — validate `model` as a string, keep each numeric field
              // solely when it is a finite number (preserving the renderer's `!= null` checks),
              // and drop the whole `metadata` object if it isn't a plain record.
              const rawMetadata = (event as { metadata?: unknown }).metadata;
              if (
                rawMetadata != null &&
                typeof rawMetadata === 'object' &&
                !Array.isArray(rawMetadata)
              ) {
                const md = rawMetadata as Record<string, unknown>;
                const cleanMetadata: {
                  model?: string;
                  inputTokens?: number;
                  outputTokens?: number;
                  iterations?: number;
                } = {};
                if (typeof md.model === 'string') {
                  cleanMetadata.model = md.model;
                }
                if (typeof md.inputTokens === 'number' && Number.isFinite(md.inputTokens)) {
                  cleanMetadata.inputTokens = md.inputTokens;
                }
                if (typeof md.outputTokens === 'number' && Number.isFinite(md.outputTokens)) {
                  cleanMetadata.outputTokens = md.outputTokens;
                }
                if (typeof md.iterations === 'number' && Number.isFinite(md.iterations)) {
                  cleanMetadata.iterations = md.iterations;
                }
                streamController.enqueue({
                  type: 'message-metadata',
                  metadata: cleanMetadata,
                });
              }
            } else if (type === 'tool-approval-request') {
              // Forward the approval request as an x-chat chunk so the UI can
              // render an inline confirmation card (via ChatConfirmation / ToolPart).
              const rawApproval = event as {
                approvalId?: unknown;
                toolCallId?: unknown;
                toolName?: unknown;
                input?: unknown;
              };
              // `approvalId` identifies the APPROVAL, which need not be 1:1 with the tool
              // call (a server can batch several calls behind one prompt, or re-prompt for
              // the same call). `ToolPart` responds with `approvalId ?? toolCallId`, so
              // dropping it here silently degrades every such case to per-tool-call
              // responses. Forwarded only when the event actually carries one — defaulting
              // it to `toolCallId` would be indistinguishable from "absent" and defeat the
              // fallback the consumer already implements.
              const approvalId =
                typeof rawApproval.approvalId === 'string' && rawApproval.approvalId !== ''
                  ? rawApproval.approvalId
                  : undefined;
              streamController.enqueue({
                type: 'tool-approval-request',
                ...(approvalId ? { approvalId } : {}),
                toolCallId: String(rawApproval.toolCallId ?? ''),
                toolName: String(rawApproval.toolName ?? ''),
                input: rawApproval.input ?? {},
              });
            } else if (type === 'state-mutation') {
              try {
                // Untyped forward: `event.mutation` is untrusted wire data, so it is
                // passed as `unknown` and validated inside `applyStateMutation` via
                // `parseStateMutation`. The try/catch is now only a secondary safety
                // net — `applyStateMutation` drops a malformed payload itself rather
                // than throwing, so this catches only unexpected controller-side errors.
                const docBefore = controller.getState().doc;
                applyStateMutation((event as { mutation?: unknown }).mutation, controller);
                const docAfter = controller.getState().doc;
                // Record only mutations that actually moved the document, keyed by THIS
                // turn's assistant message id, so a Retry of this message can revert
                // exactly what it applied instead of replaying it on top (see
                // `chatTurnMutations.ts`). A dropped/no-op mutation leaves `doc`
                // reference-identical and is not worth tracking.
                if (docAfter !== docBefore) {
                  mutationLedger?.record(msgId, docBefore, docAfter);
                }
              } catch (err) {
                console.error('[StudioBackendAdapter] Failed to apply state mutation:', err);
              }
            } else if (type === 'usage') {
              // Defensive coercion (matching the `tool-approval-request` branch above): a
              // malformed/unexpected event shape must not pass unchecked garbage (e.g.
              // `undefined`/a string) straight through to the consumer's `onUsage`.
              const rawUsage = event as {
                inputTokens?: unknown;
                outputTokens?: unknown;
                iterations?: unknown;
              };
              onUsage?.({
                inputTokens: toFiniteNumber(rawUsage.inputTokens),
                outputTokens: toFiniteNumber(rawUsage.outputTokens),
                iterations: toFiniteNumber(rawUsage.iterations),
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
              closeStream();
              return false;
            } else if (type === 'error') {
              endReasoning(streamController);
              errorStream(
                /* minify-error-disabled */ new Error(
                  String(event.message ?? 'Unknown server error'),
                ),
              );
              return false;
            }
            return undefined;
          };

          try {
            await parseSSEStream(response, processEvent, {
              onReader: (reader) => {
                requestReader = reader;
                activeReaders.add(reader);
              },
            });
          } catch (err) {
            if (err instanceof Error && err.message === 'No response body.') {
              endReasoning(streamController);
            }
            if (!input.signal?.aborted) {
              errorStream(err);
            }
          } finally {
            if (requestReader) {
              activeReaders.delete(requestReader);
              requestReader = null;
            }
            // The SSE stream ended (server closed the connection, proxy timeout, etc.)
            // without ever emitting a `finish`/`error` event and without the abort or
            // HTTP-error paths above having settled the stream either. Close it now so
            // the chat panel doesn't stay in a streaming state indefinitely — a no-op
            // if the stream was already settled by any of the branches above.
            closeStream();
          }
        },
      });
    },

    stop() {
      // Cancel every in-flight response body reader so the browser releases the
      // connections. ChatBox has already aborted the fetch signal before calling
      // stop(), so this is a best-effort cleanup to free resources immediately.
      // Cancelling per-reader (rather than a single shared reader) means overlapping
      // streams from mid-stream thread switches are all stopped correctly, and
      // because the registry is owned by the caller rather than by this closure, it
      // also covers streams started by a PREVIOUS adapter instance that a re-render
      // has since replaced.
      for (const reader of activeReaders) {
        reader.cancel().catch(() => {});
      }
      activeReaders.clear();
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
      // The AI chat thread this decision is being made under. The server binds every
      // pending approval to `doc.ai.activeThreadId` (captured from the request that
      // raised it) and `isApprovalThreadIdAuthorized` — the check the reference
      // `/approval` route and the package's own resolver both run — denies a MISSING
      // thread id just as it denies a mismatched one, deliberately: a check that only
      // fires when the resolver happens to supply one is bypassable by omitting the
      // field. So not sending it made every approval in a real conversation 403, and
      // the tool call then failed closed after the FULL approval timeout with
      // `{"denied":true,"reason":"approval timed out"}` — the worst of both worlds,
      // since the user had already clicked Approve.
      //
      // Read at send time (not captured when the adapter was built): the panel can
      // switch threads while an approval card is pending, and the binding that matters
      // is the one the server recorded for the request that is still paused.
      // Omitted entirely when there is no thread — an approval raised with no
      // `entry.threadId` is unbound, and sending `undefined` would be indistinguishable
      // from that anyway.
      const threadId = controller.getState().doc.ai?.activeThreadId;
      const response = await fetch(approvalUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...extraHeaders },
        body: JSON.stringify({ id, approved, reason, ...(threadId ? { threadId } : {}) }),
      });
      // A 4xx/5xx here (e.g. an expired approval id) must not resolve as if the
      // approval was delivered — the server-side agentic loop never actually resumes,
      // leaving the conversation hung in a streaming state with no error shown until
      // the SSE connection eventually times out. Throwing surfaces through
      // `useChatController`'s existing `addToolApprovalResponse` error handling (it
      // rolls back the optimistic UI update and sets a user-visible error), mirroring
      // the non-ok handling in `sendMessage` above.
      if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText);
        throw new Error(`MUI X Studio: The AI endpoint responded with HTTP ${response.status}: ${errText}
The request never reached the model, so the conversation cannot continue.
Check the endpoint URL, its authentication headers, and the server logs for this status.`);
      }
    },
  };
}
