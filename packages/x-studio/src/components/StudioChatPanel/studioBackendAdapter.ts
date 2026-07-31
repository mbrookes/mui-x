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
// The prototype-key denylist and the wire size caps, from the package that owns them.
// Hand-rolling either here — a literal `key === '__proto__' || …`, a local `10_000` — is how
// two boundaries that must agree start disagreeing, which is the whole reason these live in
// exactly one place.
import { isSafeKey, MAX_ARRAY_LENGTH, MAX_STRING_LENGTH } from '@mui/x-studio-schema';
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
   * What the client withholds outright is the bulk data: `pageSnapshot` (sampled
   * row values) and `richContext` (per-field statistics) are never built and never
   * sent anywhere in private mode.
   *
   * That is not the whole enumeration, though, and the difference matters to a host
   * reasoning about what its OWN endpoint receives. `serializeDashboardState` empties
   * `doc.ai.threads` and strips `runtime.dataSources[].rows`; it does not touch
   * `doc.filters`, so every filter's `value` is sent with the rest of the document —
   * and for the `cross-filter` and `interactive` scopes that value IS a real row
   * value, since it is whatever the user clicked (a chart category, a legend label, a
   * selected grid cell). A field name in a page-scoped filter is structure; the
   * category in a cross-filter is data.
   *
   * The stated guarantee is unaffected: it is provider-facing, and the middleware
   * withholds the entire `<dashboard_state>` block — filters included — from the
   * prompt in private mode, with every state-reading tool withdrawn, so none of it
   * reaches the LLM. But "no row values leave the browser" would be wrong, and this
   * doc is the only place a host learns otherwise.
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

/** A plain (non-array, non-null) record — the shape every sanitizer below expects. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Serialized size of an untrusted wire value, in JSON characters, for size-capping a value
 * whose shape is not otherwise constrained. `Infinity` when the value cannot be serialized at
 * all (`undefined`, a `BigInt`, a cycle) so a caller comparing against a cap rejects it —
 * none of those can come out of `JSON.parse`, but a cap must never be the thing that throws.
 */
function wireValueSize(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Longest key NAME accepted into the `message-metadata` pass-through.
 *
 * `wireValueSize` measures the VALUE only, so without this a payload of `MAX_ARRAY_LENGTH`
 * keys whose names are megabytes long passes every value-side check and lands in the
 * persisted doc — a name is exactly as persistent as the thing it names. 128 characters is
 * far past any real metadata key (`traceId`, `x-request-id`,
 * `contextEnricher.cacheGeneration`) while keeping the name side of the budget's worst case
 * a rounding error next to the value side.
 *
 * Exported for the tests only — deliberately NOT re-exported from `x-studio`'s `index.ts`
 * (which names `createBackendChatAdapter`/`StudioAIConfig` explicitly), so this stays a
 * module detail rather than a semver-locked number, unlike the shared `wireLimits` caps.
 */
export const MAX_METADATA_KEY_LENGTH = 128;

/**
 * Total serialized size, in JSON characters, that ONE assistant turn may contribute to the
 * open `message-metadata` extension — key names and values together, summed across every
 * `message-metadata` event in that turn's stream.
 *
 * Per-event caps alone bound nothing. `processStream`'s `message-metadata` case does
 * `metadata: { ...message.metadata, ...chunk.metadata }`: N events MERGE into ONE assistant
 * message, so a per-event budget multiplies by the event count, which nothing bounds
 * (`parseSSEStream`'s 8 MB `MAX_BUFFER_SIZE` caps the un-newlined residue of a single LINE,
 * not the stream and not the number of events). Measured on the previous per-event counter:
 * 5 events x `MAX_ARRAY_LENGTH` at-cap keys = 2500 keys / 25 MB on one message, linear in
 * the event count.
 *
 * `2 * MAX_STRING_LENGTH` = 20 000 characters, so a single at-cap value plus its name still
 * fits — the budget is a ceiling on the turn, not a ban on one sizeable value — and the
 * worst case a hostile server can write per assistant turn becomes:
 *
 *     model          <=  MAX_STRING_LENGTH       = 10 000 chars
 *   + 3 numbers      ~                              25 chars
 *   + pass-through   <=  MAX_TURN_METADATA_SIZE  = 20 000 chars  (and <= 500 keys)
 *   ---------------------------------------------------------------------------
 *   total            ~                              30 KB per assistant message,
 *
 * INDEPENDENT of how many `message-metadata` events the stream carries. The growth vector
 * that remains — more assistant messages — costs the server a user-initiated turn each,
 * which is what "bounded" has to mean at this boundary.
 *
 * Exported for the tests only — see {@link MAX_METADATA_KEY_LENGTH}.
 */
export const MAX_TURN_METADATA_SIZE = 2 * MAX_STRING_LENGTH;

/**
 * Sanitized `{ id, title }` entries of an `ApprovalEffectsSummary` list, or `undefined`
 * when the wire value isn't a list of them.
 */
function sanitizeEffectEntities(value: unknown): Array<{ id: string; title: string }> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries = value.flatMap((entry) =>
    isPlainRecord(entry) && typeof entry.id === 'string' && typeof entry.title === 'string'
      ? [{ id: entry.id, title: entry.title }]
      : [],
  );
  return entries.length > 0 ? entries : undefined;
}

/**
 * Total serialized size, in JSON characters, that ONE assistant turn may contribute to the
 * persisted approval payloads (`effects` plus `reason`), summed across every
 * `tool-approval-request` event in that turn's stream.
 *
 * Same sink and same reasoning as {@link MAX_TURN_METADATA_SIZE}: `processStream` writes
 * both onto `toolInvocation.approvalRequest`, i.e. onto a message PART, which
 * `useChatThreads.handleMessagesChange` persists into `doc.ai.threads[].messages` exactly
 * like `metadata`, with no load-boundary screen on the way back in. Measured before this
 * cap, from ONE `tool-approval-request` event:
 * `effectsBytes=10167825 reasonChars=1000000` — 11 MB, and unbounded in the event count.
 *
 * `4 * MAX_STRING_LENGTH` = 40 000 characters, twice `MAX_TURN_METADATA_SIZE`'s multiple
 * because a turn legitimately carries one approval per gated tool call (whereas metadata is
 * typically one usage summary), and the client cannot rely on the server's own iteration
 * budget — the server is the untrusted party here.
 *
 * Exported for the tests only — see {@link MAX_METADATA_KEY_LENGTH}.
 */
export const MAX_TURN_APPROVAL_SIZE = 4 * MAX_STRING_LENGTH;

/**
 * Longest `toolCallId`, `toolName` or `approvalId` accepted on a `tool-approval-request`.
 *
 * {@link MAX_TURN_APPROVAL_SIZE} bounds `effects` and `reason`. It does NOT bound the three
 * fields next to them, and `processStream` writes all of them onto the same `toolInvocation`
 * — the same message PART, persisted by the same `handleMessagesChange` write. Measured with
 * that budget in place: a 1 000 000-character `toolName` and a 1 000 000-character
 * `approvalId` were forwarded verbatim onto the persisted part. Bounding one field of a
 * record bounds nothing.
 *
 * 256 characters is far past any id a real server mints (`toolu_01…`, a UUID, a tool name),
 * and an over-cap value DROPS THE WHOLE EVENT rather than truncating it: all three are
 * correlation keys. `tool-activity` does not truncate its `toolCallId`, so a truncated
 * approval id would no longer match the call it gates — the mid-stream re-assert of the
 * model's own arguments would never fire — and the id POSTed back to `/approval` would be one
 * the server cannot resolve. A card nobody can answer is worse than no card.
 *
 * Exported for the tests only — see {@link MAX_METADATA_KEY_LENGTH}.
 */
export const MAX_APPROVAL_ID_LENGTH = 256;

/**
 * How many approval PARTS one assistant turn may add to the persisted message.
 *
 * The count term, without which the per-field caps above are not a bound. `processStream`
 * routes a `tool-approval-request` through `withToolInvocation(chunk.toolCallId, …)`: a new
 * `toolCallId` creates a NEW part, so the number of parts a turn persists is the number of
 * distinct gated tool call ids the server names — which nothing else limits. Measured with
 * the id caps absent: 50 approval events x 20 000-character ids = 2 003 790 bytes on ONE
 * assistant message, against a claimed "~40 KB per assistant message, independent of the
 * event count". Charged per DISTINCT `toolCallId`, because re-prompting the same call
 * overwrites its part instead of adding one.
 *
 * 64 is comfortably above `x-studio-ai-middleware`'s own
 * `DEFAULT_MAX_TOOL_CALLS_PER_REQUEST` (50) — every one of which would have to be gated to
 * reach it — while keeping the worst case a number rather than a function of the stream
 * length. It also bounds `approvalGatedToolCalls` (entries are only ever added here), and so
 * bounds the stream-end flush that walks it.
 *
 * WORST CASE PER ASSISTANT TURN, from this door:
 *
 *     ids/names   <=  3 * MAX_APPROVAL_ID_LENGTH * MAX_TURN_APPROVAL_PARTS
 *                 =   3 * 256 * 64                  = 49 152 chars
 *   + effects
 *     and reason  <=  MAX_TURN_APPROVAL_SIZE         = 40 000 chars  (turn-wide, not per part)
 *   ------------------------------------------------------------------------------
 *   total         ~                                    89 KB per assistant message
 *
 * INDEPENDENT of the number of `tool-approval-request` events, which is the term the
 * previous round's arithmetic omitted.
 *
 * NOT included, and deliberately so: the chunk's `input`. Both copies of it — the
 * display-enriched one forwarded here and the model's own arguments held in
 * `modelToolInputs` — are uncapped by an explicit earlier decision (`367deaa`: a doctored
 * `input` teaches the model a shape its own schema rejects). See the `input` comment on the
 * enqueue below. This budget is a bound on the fields this door OWNS, not a claim that the
 * persisted message is bounded overall.
 *
 * Exported for the tests only — see {@link MAX_METADATA_KEY_LENGTH}.
 */
export const MAX_TURN_APPROVAL_PARTS = 64;

/**
 * Whether an approval `effects` payload's lists are within the shared wire limits, checked
 * BEFORE narrowing so the answer covers the raw wire shape.
 *
 * Deliberately all-or-nothing (the caller drops the whole `effects` object on `false`)
 * rather than truncating a list or dropping over-long entries: this payload is the impact
 * summary a human reads before approving a destructive call, and a silently SHORTENED
 * "will remove" list understates that impact — strictly worse than showing none, which
 * degrades the card to the shape it had before `effects` existed at all.
 */
function isWithinApprovalListLimits(value: Record<string, unknown>): boolean {
  for (const key of [
    'willRemoveWidgets',
    'willRemovePages',
    'willOrphanWidgets',
    'willRemoveFilters',
  ] as const) {
    const list = value[key];
    if (!Array.isArray(list)) {
      continue;
    }
    if (list.length > MAX_ARRAY_LENGTH) {
      return false;
    }
    for (const entry of list) {
      if (typeof entry === 'string') {
        if (entry.length > MAX_STRING_LENGTH) {
          return false;
        }
      } else if (isPlainRecord(entry)) {
        if (
          (typeof entry.id === 'string' && entry.id.length > MAX_STRING_LENGTH) ||
          (typeof entry.title === 'string' && entry.title.length > MAX_STRING_LENGTH)
        ) {
          return false;
        }
      }
    }
  }
  return true;
}

/**
 * The `effects` summary attached to a `tool-approval-request` event: which
 * widgets/pages/filters the proposed call will remove, which widgets it will orphan,
 * and how many it will update — each entity carrying its CURRENT title, read
 * server-side from the pre-mutation state.
 *
 * Sanitized on the same principle as `message-metadata` (below) — and that sentence is only
 * true because of the size limits here. Narrowing the key set and the value TYPES bounds
 * neither the list lengths nor the string lengths, so before these checks one event could
 * (measured) put 10 MB of well-typed `{ id, title }` entries into the persisted doc through
 * `toolInvocation.approvalRequest`, which is the same sink `metadata` writes to. Bounding
 * one of two adjacent doors bounds nothing.
 *
 * Two limits, both shared with the rest of the boundary rather than re-spelled here:
 * per-list length and per-string length (`isWithinApprovalListLimits`, all-or-nothing), plus
 * a per-turn total the CALLER charges against {@link MAX_TURN_APPROVAL_SIZE}, because — as
 * with `message-metadata` — a per-event limit multiplied by an unbounded event count is not
 * a limit.
 *
 * These strings also exist to be RENDERED next to an approve/deny button, so a non-string
 * title from a malformed event must never reach JSX. Returns `undefined` when nothing
 * survived, so the key is omitted rather than forwarded empty.
 */
function sanitizeApprovalEffects(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainRecord(value) || !isWithinApprovalListLimits(value)) {
    return undefined;
  }
  const effects: Record<string, unknown> = {};
  for (const key of ['willRemoveWidgets', 'willRemovePages', 'willOrphanWidgets'] as const) {
    const entities = sanitizeEffectEntities(value[key]);
    if (entities) {
      effects[key] = entities;
    }
  }
  if (Array.isArray(value.willRemoveFilters)) {
    const filterIds = value.willRemoveFilters.filter((id): id is string => typeof id === 'string');
    if (filterIds.length > 0) {
      effects.willRemoveFilters = filterIds;
    }
  }
  if (typeof value.updatedWidgetCount === 'number' && Number.isFinite(value.updatedWidgetCount)) {
    effects.updatedWidgetCount = value.updatedWidgetCount;
  }
  return Object.keys(effects).length > 0 ? effects : undefined;
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

      // The arguments the MODEL actually sent for each tool call, captured from the
      // `tool-activity` `start` event, plus the ids that were later gated behind a
      // human approval.
      //
      // A `tool-approval-request` carries a DISPLAY-enriched `input`: the server
      // resolves ids against the real state so the human approves against real titles
      // (`apply_bulk_update`'s `widgetRemovals: ['w1']` becomes `[{id, title}]`) and so
      // a prompt-injected model cannot label a removal with a title of its own choosing
      // (`remove_widget`'s `widgetTitle` is overwritten from state). x-chat's stream
      // processor writes that chunk's `input` straight over `toolInvocation.input`, so
      // the enriched object became the message's permanent record of the call and
      // `toOpenAIMessages` replayed it as the model's own arguments on the NEXT
      // request. For `apply_bulk_update` that is not merely noisy: the tool's schema
      // declares `widgetRemovals` as `items: { type: 'string' }`, so the executor
      // rejects the object form and treats the list as empty — the replayed history
      // teaches the model a shape that silently no-ops.
      //
      // Both values are needed, at different times: enriched WHILE the card is
      // pending, real once the call is settled. The chunk can only carry one, so the
      // adapter keeps the real one here and re-asserts it (via `tool-input-available`,
      // whose update path only rewrites `input`) the moment the call completes —
      // approved, denied or timed out, all of which arrive as `tool-activity`
      // `complete`. Until `ChatToolApprovalRequestChunk` grows a field for the display
      // payload, this is where the two are reconciled.
      //
      // `approvalGatedToolCalls` maps a gated `toolCallId` to its `toolName`, because
      // the re-assert does not always have a `tool-activity` event in hand to read the
      // name off: the STREAM-END flush below has only what was recorded here (see
      // `flushApprovalGatedInputs`).
      const modelToolInputs = new Map<string, unknown>();
      const approvalGatedToolCalls = new Map<string, string>();

      // Pass-through `message-metadata` budget for THIS turn — declared here, at
      // `sendMessage` scope, and NOT inside the `message-metadata` branch, because the sink
      // is per-MESSAGE, not per-event: `processStream` merges every event's metadata into the
      // one assistant message (`{ ...message.metadata, ...chunk.metadata }`) that
      // `useChatThreads.handleMessagesChange` persists. A counter reset on each event bounds
      // one event and leaves the message bounded only by the (unbounded) event count.
      // See `MAX_TURN_METADATA_SIZE` for the arithmetic.
      let turnMetadataKeys = 0;
      let turnMetadataSize = 0;

      // The same discipline for the adjacent door: `effects`/`reason` land on
      // `toolInvocation.approvalRequest`, a message PART, persisted by the same
      // `handleMessagesChange` write as `metadata`. One approval per gated tool call, an
      // unbounded number of events — so the budget spans the turn, not the event.
      // See `MAX_TURN_APPROVAL_SIZE`.
      let turnApprovalSize = 0;

      // …and the term a size budget alone cannot express: the distinct `toolCallId`s this
      // turn has already opened an approval PART for. `processStream` creates one part per
      // new id, so this is the count of parts the door has added to the persisted message.
      // See `MAX_TURN_APPROVAL_PARTS`.
      const turnApprovalPartIds = new Set<string>();

      // A payload the boundary withheld is a difference the human cannot see on the card, so
      // it is announced — once per turn per reason, since the events that trigger it are
      // unbounded in number and a per-event warning would be its own flood. The key set is
      // bounded by the fixed number of call sites below.
      const warnedApprovalKeys = new Set<string>();
      const warnApprovalOnce = (key: string, message: string) => {
        if (warnedApprovalKeys.has(key)) {
          return;
        }
        warnedApprovalKeys.add(key);
        console.warn(`MUI X Studio: ${message}`);
      };

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
          // Re-assert the model's own arguments for every approval-gated call that is
          // STILL OPEN when the stream ends.
          //
          // The `tool-activity` `complete` branch below does this the moment a gated
          // call settles — approved, denied or timed out. Aborting WHILE a confirmation
          // card is on screen never reaches it: `stop()` cancels the response-body
          // reader, the SSE stream ends, and no `complete` ever arrives. Without this
          // flush the approval card's display-enriched `input` (which x-chat wrote over
          // `toolInvocation.input`) stays in the message and `toOpenAIMessages` replays
          // it to the model as its own arguments on the NEXT request — the exact defect
          // the `complete`-path re-assert was added to fix, on the abort path. For
          // `apply_bulk_update` that is not cosmetic: the tool's schema declares
          // `widgetRemovals` as `items: { type: 'string' }`, so the replayed object form
          // makes the executor treat the removal list as empty and teaches the model a
          // shape that silently no-ops.
          //
          // Called from the two settle points below, so it also covers a server that
          // closes the connection mid-approval and an errored stream. Only gated calls
          // are flushed: an ungated call's `input` was never overwritten, so re-emitting
          // it would be pure noise (the same condition the `complete` branch applies).
          const flushApprovalGatedInputs = () => {
            for (const [toolCallId, toolName] of approvalGatedToolCalls) {
              streamController.enqueue({
                type: 'tool-input-available',
                toolCallId,
                toolName,
                input: modelToolInputs.get(toolCallId) ?? {},
              });
            }
            approvalGatedToolCalls.clear();
          };

          const closeStream = () => {
            if (streamSettled) {
              return;
            }
            // Before `close()`, never after: chunks enqueued after it throw, and the
            // queue is still delivered to the reader on a clean close.
            flushApprovalGatedInputs();
            streamSettled = true;
            streamController.close();
          };
          const errorStream = (err: unknown) => {
            if (streamSettled) {
              return;
            }
            // Best effort on this path — `controller.error()` resets the queue, so an
            // unread re-assert is dropped. Enqueuing it costs nothing and is delivered
            // whenever the consumer has already drained past it.
            flushApprovalGatedInputs();
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
                // The model's own arguments, kept so an approval's display-enriched
                // `input` can be un-done once the call settles (see `modelToolInputs`).
                modelToolInputs.set(toolCallId, toolInput ?? {});
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
                // Restore the model's own arguments over the approval card's
                // display-enriched ones before the call is recorded as finished, so the
                // next request replays what the model actually said rather than a
                // display shape the tool's own schema rejects (see `modelToolInputs`).
                // Only for calls that were actually gated: an ungated call's `input` was
                // never overwritten, and re-emitting it would be pure noise.
                if (approvalGatedToolCalls.has(toolCallId)) {
                  approvalGatedToolCalls.delete(toolCallId);
                  streamController.enqueue({
                    type: 'tool-input-available',
                    toolCallId,
                    toolName,
                    input: modelToolInputs.get(toolCallId) ?? {},
                  });
                }
                modelToolInputs.delete(toolCallId);
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
              // Forward the assistant message's metadata (model name, token counts, and
              // whatever else the server attached).
              //
              // Defensive coercion for the fields the RENDERER reads (matching the
              // `tool-activity`/`usage` branches, which never pass untrusted wire data
              // straight through): `StudioMessageRoot` draws `{metadata.model}` directly as
              // a React child and reads the numeric token/iteration counts, so a non-string
              // `model` or a non-numeric count from a malformed event would crash the
              // message renderer in non-production builds. Those four are validated
              // individually and dropped when they are the wrong type (preserving the
              // renderer's `!= null` checks); the whole object is dropped if it isn't a
              // plain record.
              //
              // Every OTHER key is carried through — BOUNDED. `message-metadata` is
              // documented as the channel for "trace IDs, or any other structured metadata",
              // and a fixed whitelist silently truncated exactly the extension the protocol
              // promises — a host whose middleware attaches a `traceId` (or a custom
              // `contextEnricher`'s own bookkeeping) would find it gone with no error. The
              // crash-safety rationale above does not extend to them: nothing renders an
              // unknown key, and the value is JSON already (it came out of `JSON.parse`).
              //
              // But this is a write into the PERSISTED partition, not a display-only
              // forward. The chunk's metadata becomes `ChatMessage.metadata`, which
              // `useChatThreads.handleMessagesChange` writes verbatim into
              // `doc.ai.threads[].messages` — and `doc` is the partition that is serialized,
              // undone/redone, and reloaded. The load boundary does not screen it back down
              // either: `repairThreadLeafShapes` deliberately does NOT own-key-screen a
              // surviving message, a decision taken when a message carried only role and
              // content rather than a server-controlled open record. So the same open
              // extension that makes `traceId` work would, unbounded, let a server grow the
              // saved document without limit, one assistant message at a time.
              //
              // Hence the same caps every other untrusted-payload check in the schema
              // package enforces (`wireLimits.ts`, imported — not re-declared): at most
              // `MAX_ARRAY_LENGTH` pass-through keys, each at most `MAX_STRING_LENGTH`
              // serialized characters. Deliberately generous — far past any real trace id or
              // bookkeeping record — because the job is to make the persisted size BOUNDED,
              // not to guess a legitimate maximum. Over-cap keys are dropped individually so
              // one oversized value cannot cost the message its other metadata.
              //
              // Those caps are spent from a budget that spans the whole TURN
              // (`turnMetadataKeys`/`turnMetadataSize`, declared at `sendMessage` scope), not
              // one budget reset per event. The sink is a MERGE — `processStream` folds every
              // event's metadata into the ONE assistant message that gets persisted — so a
              // per-event budget bounds an event and leaves the message bounded only by the
              // event count, which nothing bounds. Key NAMES are charged to that budget and
              // separately capped at `MAX_METADATA_KEY_LENGTH`: `wireValueSize` measures the
              // value, and a name is exactly as persistent as the value it names.
              //
              // The four known fields are exempt from the key COUNT and from the size budget
              // (they are the fixed, renderer-read part of the payload, not the open
              // extension) and keep their individual type validation — but `model` is a
              // server-controlled STRING, so it carries the shared length cap of its own;
              // otherwise the one field exempted from the budget is the one that defeats it.
              // Prototype-hazard keys are dropped via the shared `isSafeKey`, so no forwarded
              // record can carry one into a downstream merge.
              const rawMetadata = (event as { metadata?: unknown }).metadata;
              if (isPlainRecord(rawMetadata)) {
                const cleanMetadata: Record<string, unknown> = {};
                for (const [key, value] of Object.entries(rawMetadata)) {
                  if (!isSafeKey(key)) {
                    continue;
                  }
                  if (key === 'model') {
                    if (typeof value === 'string' && value.length <= MAX_STRING_LENGTH) {
                      cleanMetadata.model = value;
                    }
                  } else if (
                    key === 'inputTokens' ||
                    key === 'outputTokens' ||
                    key === 'iterations'
                  ) {
                    if (typeof value === 'number' && Number.isFinite(value)) {
                      cleanMetadata[key] = value;
                    }
                  } else if (key.length <= MAX_METADATA_KEY_LENGTH) {
                    const entrySize = key.length + wireValueSize(value);
                    if (
                      turnMetadataKeys < MAX_ARRAY_LENGTH &&
                      wireValueSize(value) <= MAX_STRING_LENGTH &&
                      turnMetadataSize + entrySize <= MAX_TURN_METADATA_SIZE
                    ) {
                      turnMetadataKeys += 1;
                      turnMetadataSize += entrySize;
                      cleanMetadata[key] = value;
                    }
                  }
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
                effects?: unknown;
                reason?: unknown;
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
              const approvalToolCallId = String(rawApproval.toolCallId ?? '');
              const approvalToolName = String(rawApproval.toolName ?? '');
              // The three fields `effects`/`reason`'s budget does not cover, and the count of
              // parts neither of them covers. All of them ride the SAME persisted sink — one
              // `toolInvocation`, written into `doc.ai.threads[].messages` — so capping only
              // the two payload fields left the door open by 2 MB per turn (measured: 50
              // events x 20 000-character ids). See `MAX_APPROVAL_ID_LENGTH` and
              // `MAX_TURN_APPROVAL_PARTS` for the shape of the bound and the arithmetic.
              //
              // Both checks reject the WHOLE event rather than repairing it, and both run
              // BEFORE `approvalGatedToolCalls.set` — an event that never reaches the
              // consumer never overwrote `toolInvocation.input`, so it must not enter the
              // re-assert bookkeeping either, or the stream-end flush would emit a
              // `tool-input-available` for a call no card was ever shown for.
              if (
                approvalToolCallId.length > MAX_APPROVAL_ID_LENGTH ||
                approvalToolName.length > MAX_APPROVAL_ID_LENGTH ||
                (approvalId?.length ?? 0) > MAX_APPROVAL_ID_LENGTH
              ) {
                warnApprovalOnce(
                  'approval-id-length',
                  `The AI server sent a tool approval request whose toolCallId, toolName or ` +
                    `approvalId is longer than ${MAX_APPROVAL_ID_LENGTH} characters. These ids ` +
                    `are stored in the saved dashboard and are sent back to the server to answer ` +
                    `the request, so the request was dropped instead of shortened — a shortened ` +
                    `id would identify nothing. The tool call will not show an approval card. ` +
                    `Check what the AI endpoint is sending for these fields.`,
                );
                return undefined;
              }
              if (
                !turnApprovalPartIds.has(approvalToolCallId) &&
                turnApprovalPartIds.size >= MAX_TURN_APPROVAL_PARTS
              ) {
                warnApprovalOnce(
                  'approval-part-budget',
                  `The AI server asked for approval of more than ${MAX_TURN_APPROVAL_PARTS} ` +
                    `different tool calls in one response. Each one is stored in the saved ` +
                    `dashboard, so the extra requests were dropped and those tool calls will not ` +
                    `show an approval card. Check whether the endpoint's tool-call limit is set ` +
                    `higher than this client's.`,
                );
                return undefined;
              }
              turnApprovalPartIds.add(approvalToolCallId);
              // This chunk's `input` is the display-enriched one, and x-chat writes it
              // over `toolInvocation.input`. Remember that it happened — with the tool
              // name, which the stream-end flush has no other source for — so the
              // model's own arguments can be re-asserted once the call settles, or when
              // the stream ends without it ever settling (see `modelToolInputs` and
              // `flushApprovalGatedInputs`).
              approvalGatedToolCalls.set(approvalToolCallId, approvalToolName);
              // `effects` (what the call will remove/orphan, with real titles) and
              // `reason` (the policy's own justification for flagging the call) exist so
              // a human can approve with the real impact in view instead of an opaque
              // id matrix. Both were computed server-side and then dropped here, which
              // left the whole feature inert — `reason` for the second time, having been
              // added specifically because it was "previously computed but silently
              // dropped".
              //
              // The rest of that path has since landed:
              // `ChatToolApprovalRequestChunk` declares both fields,
              // `processStream` carries them to `toolInvocation.approvalRequest`, and
              // `ToolPart` renders `reason` itself while mounting `chatToolRenderers`'
              // `StudioApprovalEffects` in its `approvalDetails` slot for `effects` —
              // so no cast is needed here any more and the forward is no longer inert.
              //
              // `sanitizeApprovalEffects` still runs, and still matters: the payload is
              // destined for JSX beside an approve/deny button, so a non-string title
              // from a malformed event must never reach a React child position. The
              // renderer narrows again on its side (the field is `unknown` there) —
              // both, deliberately, because either one alone is one edit away from
              // being the only guard.
              //
              // …and it is SIZE-capped, not only type-narrowed, because this is the same
              // persisted sink `message-metadata` writes to: `processStream` puts both
              // fields on `toolInvocation.approvalRequest`, a message part, which
              // `useChatThreads.handleMessagesChange` writes into `doc.ai.threads[].messages`
              // with no load-boundary screen on the way back. Both are charged, all-or-
              // nothing, against a budget spanning the whole TURN (`turnApprovalSize`) — a
              // per-event limit times an unbounded event count is not a limit. Once the
              // budget is spent the card degrades to the shape it had before `effects` and
              // `reason` existed, which is honest; a truncated impact list would not be.
              let effects: Record<string, unknown> | undefined;
              const candidateEffects = sanitizeApprovalEffects(rawApproval.effects);
              if (candidateEffects) {
                const effectsSize = wireValueSize(candidateEffects);
                if (turnApprovalSize + effectsSize <= MAX_TURN_APPROVAL_SIZE) {
                  turnApprovalSize += effectsSize;
                  effects = candidateEffects;
                }
              }
              let policyReason: string | undefined;
              if (
                typeof rawApproval.reason === 'string' &&
                rawApproval.reason !== '' &&
                rawApproval.reason.length <= MAX_STRING_LENGTH &&
                turnApprovalSize + rawApproval.reason.length <= MAX_TURN_APPROVAL_SIZE
              ) {
                turnApprovalSize += rawApproval.reason.length;
                policyReason = rawApproval.reason;
              }
              streamController.enqueue({
                type: 'tool-approval-request',
                ...(approvalId ? { approvalId } : {}),
                toolCallId: approvalToolCallId,
                toolName: approvalToolName,
                // `input` is deliberately NOT capped here, and that is not an oversight.
                //
                // It never survives into the persisted message: this chunk's `input` is the
                // DISPLAY-enriched one, and the model's own arguments are re-asserted over it
                // at every settle point — by the `tool-activity` `complete` branch mid-stream,
                // and by `flushApprovalGatedInputs` from BOTH `closeStream` and `errorStream`
                // otherwise. So a cap here would bound nothing that outlives the confirmation
                // card, while costing the card exactly the enrichment it exists for (real
                // titles instead of opaque ids) and, when it fired, asking a human to approve
                // a destructive call rendered as `{}`.
                //
                // The `input` that IS persisted is `modelToolInputs`' copy, captured from
                // `tool-activity` — the model's own tool arguments, which `toOpenAIMessages`
                // replays verbatim on the next request. Capping THAT is what `367deaa`
                // deliberately undid (a doctored `input` teaches the model a shape its own
                // schema rejects), so it stays a known, uncapped channel rather than a
                // silently corrupted one.
                input: rawApproval.input ?? {},
                ...(effects ? { effects } : {}),
                ...(policyReason ? { reason: policyReason } : {}),
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
      // This reads the CURRENTLY active thread, which is NOT the same thing as the one
      // the server recorded: the server captured `initialState.doc.ai.activeThreadId`
      // from the request that raised the approval, and the panel can switch threads
      // afterwards. The two agree because of an invariant that lives in
      // `useChatThreads`, not here — `handleSelectThread` and `handleNewThread` both
      // call `abortInFlightStream()` BEFORE mutating `activeThreadId`, so a request that
      // is still paused cannot outlive the id it was recorded under. (Pinned by "aborts
      // the in-flight stream before the active thread id changes" in
      // `useChatThreads.test.ts`, so the ordering cannot be quietly reversed.)
      //
      // Reading here rather than capturing it in `sendMessage` is deliberate, not an
      // oversight. `addToolApprovalResponse` is dispatched on whichever adapter instance
      // is current when the user clicks, and this adapter is rebuilt whenever
      // `aiConfig`/`customWidgets`/`focusedWidgetId` change identity — for an unmemoized
      // host prop, every render, i.e. every streamed token (which is exactly why
      // `activeReaders` is caller-INJECTED). A value closed over by the `sendMessage`
      // that issued the request would therefore be MISSING on the adapter that receives
      // the click, and `isApprovalThreadIdAuthorized` denies a missing thread id just as
      // it denies a mismatched one — re-creating the 403-then-timeout failure described
      // above. Making the genuinely-recorded id readable here needs a caller-owned
      // registry that outlives the adapter (the `activeReaders`/`mutationLedger` shape),
      // keyed by BOTH `approvalId` and `toolCallId`, since `ToolPart` answers with
      // `approvalId ?? toolCallId`.
      //
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
