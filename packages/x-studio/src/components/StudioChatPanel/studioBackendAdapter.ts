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
 * Serialized size of a STRING, in the SAME JSON characters every budget on this boundary is
 * denominated in — `JSON.stringify`'s length minus the two framing quotes, so it measures the
 * string's own escaped characters and composes additively with {@link wireValueSize}.
 *
 * `String.prototype.length` is NOT that unit and must not be used to charge or cap anything
 * that lands in the persisted doc. `JSON.stringify` escapes a control character to a
 * six-character `\uXXXX`, a quote/backslash to two, and an astral character stays two UTF-16
 * units — so a raw-length charge under-charges by up to 6x, and every budget denominated in
 * JSON characters but spent in raw ones is off by that factor. Measured on the previous
 * mixed-unit code, against docblocks claiming 245 KB and 30 KB per assistant message: a turn
 * of control-character `reason`s and ids persisted 539 422 JSON characters through the
 * approval door, and a single 10 000-unit control-character `model` persisted 60 002 through
 * the metadata door.
 *
 * The fixed JSON framing each field costs on top of this — its two quotes, its key name, the
 * enclosing braces — is a constant per part, not a term a hostile server can grow, so the
 * budgets below bound the field CONTENTS and the framing rides along as that constant.
 */
function wireStringSize(value: string): number {
  return JSON.stringify(value).length - 2;
}

/**
 * The longest prefix of `value` whose {@link wireStringSize} is at most `max`.
 *
 * Binary search on the MEASURED size rather than `slice(0, max)`, because the two are
 * different lengths: one escaped character can cost six, so a character slice can leave a
 * string that is still over a JSON-character budget. Searching on the measured size also
 * makes a split surrogate pair harmless — a lone surrogate escapes to `\uXXXX` and the search
 * accounts for it — so this cannot return a prefix that is over `max`, however the input is
 * spelled.
 */
function truncateToWireSize(value: string, max: number): string {
  if (max <= 0) {
    return '';
  }
  if (wireStringSize(value) <= max) {
    return value;
  }
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (wireStringSize(value.slice(0, mid)) <= max) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return value.slice(0, low);
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
 * Measured — and charged — in JSON characters ({@link wireStringSize}), like every other term
 * of {@link MAX_TURN_METADATA_SIZE}. A name of 128 control characters is 128 UTF-16 units and
 * 768 JSON characters; charged raw, 500 of them cost the budget 64 000 and the document
 * 384 000.
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
 *     model          <=  MAX_STRING_LENGTH       = 10 000 JSON chars
 *   + 3 numbers      <=  3 x 23 (a double's longest JSON form)
 *                                               =      69 JSON chars
 *   + pass-through   <=  MAX_TURN_METADATA_SIZE  = 20 000 JSON chars (names AND values,
 *                                                                    and <= 500 keys)
 *   ---------------------------------------------------------------------------
 *   total            <=                            30 069 JSON chars (~30 KB) per
 *                                                  assistant message,
 *
 * INDEPENDENT of how many `message-metadata` events the stream carries. The growth vector
 * that remains — more assistant messages — costs the server a user-initiated turn each,
 * which is what "bounded" has to mean at this boundary.
 *
 * EVERY term above is JSON characters, measured with `wireValueSize`/{@link wireStringSize},
 * because that is the unit the budget is denominated in and the unit the doc actually
 * persists. The previous round charged `model` and the key NAMES with
 * `String.prototype.length` instead, and a JSON-character budget spent in raw UTF-16 units is
 * off by the escape ratio: measured against this same "~30 KB" claim, a turn of
 * control-character names and one control-character `model` persisted 178 052 JSON characters,
 * of which `model` alone was 60 002. Re-measured with every term in one unit, the same hostile
 * turn (10 events x 500 at-cap names, at-cap values, an at-cap `model`) persists 29 404 JSON
 * characters of `metadata`, 29 279 of which are the fields above.
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
 * BOTH fields are charged in JSON characters — `effects` through `wireValueSize`, `reason`
 * through {@link wireStringSize}. `reason` was charged with `String.prototype.length` until
 * this round, which is a different unit from the one this constant names: four at-cap
 * control-character reasons charged 40 000 and persisted 240 008.
 *
 * Exported for the tests only — see {@link MAX_METADATA_KEY_LENGTH}.
 */
export const MAX_TURN_APPROVAL_SIZE = 4 * MAX_STRING_LENGTH;

/**
 * Longest `toolCallId`, `toolName` or `approvalId` accepted on ANY tool event —
 * `tool-approval-request` AND `tool-activity`.
 *
 * {@link MAX_TURN_APPROVAL_SIZE} bounds `effects` and `reason`. It does NOT bound the three
 * fields next to them, and `processStream` writes all of them onto the same `toolInvocation`
 * — the same message PART, persisted by the same `handleMessagesChange` write. Measured with
 * that budget in place: a 1 000 000-character `toolName` and a 1 000 000-character
 * `approvalId` were forwarded verbatim onto the persisted part. Bounding one field of a
 * record bounds nothing.
 *
 * ONE constant for both doors, not two spellings of 256, because they are the SAME FIELDS on
 * the SAME PART: `withToolInvocation` keys parts by `toolCallId`, so a `tool-activity` and a
 * `tool-approval-request` naming one id write one `toolInvocation.toolCallId` and one
 * `toolInvocation.toolName`. It also has to be one constant for the drop-don't-truncate rule
 * below to hold: a `toolCallId` that one door truncates and the other does not is a
 * correlation key that no longer correlates.
 *
 * 256 JSON characters — measured with {@link wireStringSize}, not `String.prototype.length`,
 * because these fields carry no turn budget of their own: this cap times
 * {@link MAX_TURN_TOOL_PARTS} IS their bound, so a bound spent in the wrong unit is the
 * whole bound. Measured while they were charged raw: 256 control characters passed the cap and
 * persisted 1 536 JSON characters apiece.
 *
 * 256 characters is far past any id a real server mints (`toolu_01…`, a UUID, a tool name),
 * and an over-cap value DROPS THE WHOLE EVENT rather than truncating it: all three are
 * correlation keys. A truncated id would no longer match the call it gates — the mid-stream
 * re-assert of the model's own arguments would never fire — and the id POSTed back to
 * `/approval` would be one the server cannot resolve. A card nobody can answer is worse than
 * no card. See `warnApprovalOnce('approval-id-length', …)` for what the user is told, which
 * is the other half of "dropped" not meaning "silently dropped".
 *
 * Exported for the tests only — see {@link MAX_METADATA_KEY_LENGTH}.
 */
export const MAX_TOOL_ID_LENGTH = 256;

/**
 * How many tool PARTS one assistant turn may add to the persisted message — across BOTH
 * doors, `tool-activity` and `tool-approval-request` together.
 *
 * The count term, without which the per-field caps above are not a bound. `processStream`
 * routes both event kinds through `withToolInvocation(chunk.toolCallId, …)`: a new
 * `toolCallId` creates a NEW part, so the number of parts a turn persists is the number of
 * distinct tool call ids the server names — which nothing else limits. Measured with
 * the id caps absent: 50 approval events x 20 000-character ids = 2 003 790 bytes on ONE
 * assistant message, against a claimed "~40 KB per assistant message, independent of the
 * event count". Charged per DISTINCT `toolCallId`, because re-prompting the same call
 * overwrites its part instead of adding one.
 *
 * ONE budget shared by both doors, spent from one `Set` of ids, because they add parts to the
 * SAME message and a part either door creates is indistinguishable from one the other
 * created. Two budgets of 64 would bound each door at 64 and the message at 128 — and the
 * ordinary flow (`tool-activity` `start` -> `tool-approval-request` -> `tool-activity`
 * `complete`, all naming one id) spends the shared budget exactly once, so sharing costs a
 * legitimate turn nothing.
 *
 * 64 is comfortably above `x-studio-ai-middleware`'s own
 * `DEFAULT_MAX_TOOL_CALLS_PER_REQUEST` (50) — while keeping the worst case a number rather
 * than a function of the stream length. It also bounds `approvalGatedToolCalls` (entries are
 * only ever added behind this check), and so bounds the stream-end flush that walks it.
 *
 * WORST CASE PER ASSISTANT TURN, from this door — every term in JSON CHARACTERS, the unit
 * the budgets are denominated in and the unit the saved document is measured in:
 *
 *     ids/names   <=  3 * MAX_TOOL_ID_LENGTH * MAX_TURN_TOOL_PARTS
 *                 =   3 * 256 * 64                    =  49 152 JSON chars
 *   + effects
 *     and reason  <=  MAX_TURN_APPROVAL_SIZE          =  40 000 JSON chars (turn-wide, not
 *                                                                          per part)
 *   + enriched
 *     inputs      <=  MAX_TURN_APPROVAL_INPUT_SIZE    = 160 000 JSON chars (turn-wide, not
 *                                                                          per part)
 *   + the per-part constants a degraded card carries — the withheld markers
 *     (`{"effectsWithheld":true,"reasonWithheld":true,"inputWithheld":true}`, 67) plus the
 *     `{}` an over-cap input degrades to (2):
 *                 <=  69 * MAX_TURN_TOOL_PARTS    =   4 416 JSON chars
 *   --------------------------------------------------------------------------------
 *   total         <=                                    253 568 JSON chars (~248 KB) per
 *                                                       assistant message
 *
 * INDEPENDENT of the number of `tool-approval-request` events, which is the term the
 * previous round's arithmetic omitted.
 *
 * THE UNIT IS LOAD-BEARING and was wrong until this round. `effects` and the enriched `input`
 * were charged with `wireValueSize` (real JSON length) while `reason` and all three ids were
 * charged with `String.prototype.length`. `JSON.stringify` escapes a control character to six
 * characters, so every raw-length-charged term under-charged by up to 6x and the sum above was
 * a claim about a quantity nothing measured: measured against this docblock's own "~245 KB",
 * one turn of control-character reasons and ids persisted 539 422 JSON characters. Re-measured
 * with every term charged through {@link wireStringSize}, the same hostile turn (500 events,
 * every capped field filled with control characters to exactly its cap in JSON characters)
 * yields 248 850 JSON characters across the fields above and 258 654 for the whole persisted
 * assistant message — the ~10 KB difference being the fixed JSON framing of 64 parts, which is
 * a constant per part and not something a server can grow.
 *
 * The approval chunk's `input` is bounded separately — see {@link MAX_APPROVAL_INPUT_SIZE} —
 * and the model's own arguments and the tool's output, which arrive through the OTHER door
 * onto these same parts, by {@link MAX_TOOL_INPUT_SIZE} and {@link MAX_TOOL_OUTPUT_SIZE}.
 *
 * Exported for the tests only — see {@link MAX_METADATA_KEY_LENGTH}.
 */
export const MAX_TURN_TOOL_PARTS = 64;

/**
 * Largest `input` one `tool-activity` `start` may carry — the model's OWN tool arguments —
 * and {@link MAX_TURN_TOOL_INPUT_SIZE} the turn-wide total.
 *
 * THE FOURTH RECURRENCE OF ONE CLASS. `message-metadata`, then `effects`/`reason`, then the
 * approval ids and part count were each bounded in turn while the door beside them stayed
 * open. `tool-activity` is that door: it writes `toolInvocation.input`/`output`/`toolCallId`/
 * `toolName` onto `doc.ai.threads[].messages` through exactly the same
 * `handleMessagesChange` write, it needs NO approval gating to do it, and it had no id cap,
 * no input cap, no output cap and no part-count cap. Measured on one assistant message: 50
 * `tool-activity` `start` events with 20 000-character ids and 200 000-character inputs, plus
 * their 50 `complete` events with 2 000 000-character outputs, persisted 112 000 790 JSON
 * characters — 112 MB, against the approval door's freshly-argued 245 KB, and 56x the
 * 2 003 790 bytes that motivated capping the approval door in the first place.
 *
 * `367deaa`'s "don't doctor the model's own args" decision is respected and is the reason an
 * over-cap `input` DROPS THE WHOLE EVENT rather than truncating or replacing it. That
 * decision is about never handing the model a shape its own schema rejects; refusing to
 * record a call at all does not do that, whereas a truncated argument object does. Nothing
 * enters `modelToolInputs` from a dropped event either, so the stream-end flush cannot
 * re-assert what this door refused.
 *
 * `4 * MAX_STRING_LENGTH` = 40 000 JSON characters, the same figure as
 * {@link MAX_APPROVAL_INPUT_SIZE} — and that is the generous end of the comparison, since the
 * approval card's DISPLAY-ENRICHED input is strictly larger than the raw arguments it
 * enriches (`widgetRemovals: ['w1']` becomes `[{id, title}]`). The reference server's own
 * `MAX_TOOL_CALL_ARGS_BUFFER_CHARS` is 1 000 000 and its comment calls that "far past any
 * legitimate tool call's arguments"; this client stores what it accepts, so it does not have
 * to be as generous as the buffer that merely parses it.
 *
 * Exported for the tests only — see {@link MAX_METADATA_KEY_LENGTH}.
 */
export const MAX_TOOL_INPUT_SIZE = 4 * MAX_STRING_LENGTH;

/** Turn-wide total for every `tool-activity` `input` — the count term for the cap above. */
export const MAX_TURN_TOOL_INPUT_SIZE = 16 * MAX_STRING_LENGTH;

/**
 * Largest `output` one `tool-activity` `complete` may carry, and
 * {@link MAX_TURN_TOOL_OUTPUT_SIZE} the turn-wide total.
 *
 * `20 * MAX_STRING_LENGTH` = 200 000 JSON characters, deliberately EQUAL to the reference
 * server's own per-call `MAX_TOOL_OUTPUT_CHARS`, so a legitimate result that the server has
 * already capped and marked passes this boundary untouched. The turn total is
 * `60 * MAX_STRING_LENGTH` = 600 000, i.e. three at-server-cap results per assistant turn
 * before anything is trimmed — generous for a real agentic turn (whose results are kilobytes,
 * not hundreds of them) while keeping a number where the stream length used to be.
 *
 * Unlike every other over-cap payload on this boundary, an over-cap `output` is TRUNCATED and
 * MARKED rather than dropped. Dropping it would drop the `tool-output-available` chunk, and
 * `processStream` advances a part to `output-available` only on that chunk — so the card
 * would sit at `input-available`, which `resolveToolStatusIcon` renders as a spinner that
 * never resolves. A visibly-partial result is worth having; an invisible permanent "still
 * running" is not. The marker is appended (it is what `capToolOutput` does server-side, for
 * the same reason: a model reasoning over silently-truncated data reports a wrong answer with
 * full confidence) and is itself charged to the budget.
 *
 * Exported for the tests only — see {@link MAX_METADATA_KEY_LENGTH}.
 */
export const MAX_TOOL_OUTPUT_SIZE = 20 * MAX_STRING_LENGTH;

/** Turn-wide total for every `tool-activity` `output` — the count term for the cap above. */
export const MAX_TURN_TOOL_OUTPUT_SIZE = 60 * MAX_STRING_LENGTH;

/**
 * Appended in place of the tail this client refused to store, so a truncated tool result is
 * never mistaken — by the human reading the card or by the model replaying it through
 * `toOpenAIMessages` — for a complete one. Mirrors `capToolOutput`'s
 * `TOOL_OUTPUT_TRUNCATED_SUFFIX` on the server side of the same wire.
 */
export const TOOL_OUTPUT_TRUNCATED_SUFFIX =
  '\n…[MUI X Studio: this tool result was truncated by the browser because it exceeded the ' +
  'size this client stores per response. It is INCOMPLETE — do not treat it as a full answer.]';

/**
 * WORST CASE PER ASSISTANT TURN across BOTH tool doors, in JSON characters. The two share the
 * part count and the id fields, so the terms are summed once, not once per door:
 *
 *     ids/names        <=  3 * MAX_TOOL_ID_LENGTH * MAX_TURN_TOOL_PARTS
 *                      =   3 * 256 * 64                      =  49 152
 *   + effects/reason   <=  MAX_TURN_APPROVAL_SIZE             =  40 000
 *   + enriched inputs  <=  MAX_TURN_APPROVAL_INPUT_SIZE       = 160 000
 *   + model inputs     <=  MAX_TURN_TOOL_INPUT_SIZE           = 160 000
 *   + tool outputs     <=  MAX_TURN_TOOL_OUTPUT_SIZE          = 600 000
 *   + per-part constants (withheld markers 67, degraded `{}` 2,
 *     truncation suffix ~170)
 *                      <=  239 * MAX_TURN_TOOL_PARTS          =  15 296
 *     ------------------------------------------------------------------
 *     total                                                     1 024 448 JSON chars (~1 000 KB)
 *
 * Conservative twice over: `toolInvocation.input` is ONE field that both input budgets write
 * to (last write wins, so they cannot both be present), and a turn spending the whole output
 * budget has no room left for much else. It is stated as a sum anyway — an upper bound that
 * over-counts is still a bound, and one that under-counts is what the last three rounds each
 * shipped.
 *
 * MEASURED, on the persisted assistant message, with every field of both doors filled to its
 * cap in JSON characters across 200 tool calls and 10 at-cap `message-metadata` events:
 * 899 547 JSON characters (~878 KB), 64 parts — inside the 1 021 696 above plus the metadata
 * door's 30 069. The `tool-activity` door alone, on the shape that measured 112 000 790 JSON
 * characters before this bound existed, now measures 762 891 — a 147x reduction, and a number
 * rather than a function of the stream length.
 */

/**
 * Largest display-enriched `input` one approval card may carry, and the turn-wide total.
 *
 * This cap exists because the justification for NOT having one does not survive the error
 * path. The reasoning was: the enriched `input` never outlives the card, since the model's
 * own arguments are re-asserted over it at every settle point — by `tool-activity`
 * `complete` mid-stream, and by `flushApprovalGatedInputs` from `closeStream` and
 * `errorStream` otherwise. Three of those are sound (measured: `finish`, a stream that ends
 * without `finish`, and an abort all deliver). `errorStream` is not:
 * `ReadableStreamDefaultController.error()` RESETS the queue, so a re-assert the consumer has
 * not already read is discarded. Measured with one pending approval carrying a 2 MB enriched
 * `input`, the consumer awaiting a macrotask between reads (exactly what `processStream` does
 * — it awaits `updateMessage`/`onToolCall`) and the server sending an `error` event: zero
 * re-asserts delivered, and the 2 000 011-byte enriched copy is the last write to
 * `toolInvocation.input`. With the reader parked in a pending `read()` instead, both arrived.
 * Racy, not absent — which is the same thing as unbounded when the writer is untrusted.
 *
 * It is not repairable at the transport: nothing a producer can do makes a consumer drain a
 * queue `error()` is about to reset. And the enriched copy is ALREADY persisted long before
 * any exit path runs — `handleMessagesChange` writes as the stream streams, and an approval is
 * answered on a separate POST while the SSE stream stays open, so the enriched copy sits in
 * `doc.ai.threads` for the whole human-deliberation window regardless. The re-assert is a
 * repair, not a prevention; a bound has to come from the write itself.
 *
 * Over-cap input degrades the card to `{}` rather than to `modelToolInputs`' copy, and that
 * choice is the whole point of the enrichment: the server resolves ids against real state so
 * a prompt-injected model cannot label a removal with a title of its own choosing
 * (`remove_widget`'s `widgetTitle` is overwritten from state). Falling back to the model's own
 * arguments would put exactly those model-chosen labels next to an approve button — a
 * deceptive card is worse than an uninformative one, and an uninformative one is easy to deny.
 *
 * `4 * MAX_STRING_LENGTH` = 40 000 characters per card is far past a real enriched payload (an
 * `apply_bulk_update` removing 200 widgets as `{id, title}` pairs is ~10 000 characters), and
 * {@link MAX_TURN_APPROVAL_INPUT_SIZE} = 160 000 characters spans the turn, because — as
 * everywhere else on this boundary — a per-event limit times an unbounded event count is not a
 * limit.
 *
 * Exported for the tests only — see {@link MAX_METADATA_KEY_LENGTH}.
 */
export const MAX_APPROVAL_INPUT_SIZE = 4 * MAX_STRING_LENGTH;

/**
 * Turn-wide total for the display-enriched `input`s of every approval card in one assistant
 * turn — the count term for {@link MAX_APPROVAL_INPUT_SIZE}, which alone would bound one card
 * and leave the message bounded only by the part count.
 */
export const MAX_TURN_APPROVAL_INPUT_SIZE = 16 * MAX_STRING_LENGTH;

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
/**
 * Whether the RAW `effects` payload claimed any impact at all — used to tell "the server sent
 * nothing to show" (say nothing) apart from "the server sent something and this client
 * withheld it" (say so, on the card). Deliberately shape-blind about the entries: a list of
 * over-long ids and a list of well-formed ones both count as content, because both mean the
 * server believes the call has an impact the human should see.
 */
function approvalEffectsHadContent(value: unknown): boolean {
  if (!isPlainRecord(value)) {
    return false;
  }
  if (value.updatedWidgetCount !== undefined) {
    return true;
  }
  return (
    ['willRemoveWidgets', 'willRemovePages', 'willOrphanWidgets', 'willRemoveFilters'] as const
  ).some((key) => Array.isArray(value[key]) && (value[key] as unknown[]).length > 0);
}

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
      // turn has already opened a PART for, through EITHER door. `processStream` creates one
      // part per new id, so this is the count of parts the two doors have added to the
      // persisted message between them. See `MAX_TURN_TOOL_PARTS`.
      const turnToolPartIds = new Set<string>();

      // The same discipline once more, for the door that needed no approval to reach the same
      // sink: the model's own tool arguments and the tools' outputs, both written onto
      // `toolInvocation` by `tool-activity`. Measured before these budgets: 112 000 790 JSON
      // characters on one assistant message. See `MAX_TOOL_INPUT_SIZE`/`MAX_TOOL_OUTPUT_SIZE`.
      let turnToolInputSize = 0;
      let turnToolOutputSize = 0;

      // The display-enriched `input`s of this turn's approval cards. A separate budget from
      // `turnApprovalSize` because it buys something different — the card's readability, not
      // its impact summary — and because it is the one field whose "it never persists"
      // justification the error path breaks. See `MAX_APPROVAL_INPUT_SIZE`.
      let turnApprovalInputSize = 0;

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
          // closes the connection mid-approval. On the ERRORED path it is best effort and
          // not more than that — `controller.error()` resets the queue (see `errorStream`) —
          // which is why the payload it repairs is capped at the write. Only gated calls
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
            // Best effort on this path, and measured to be: `controller.error()` resets the
            // queue, so a re-assert the consumer has not already read is DISCARDED. With the
            // consumer awaiting a macrotask between reads — what `processStream` actually
            // does — zero of two pending re-asserts were delivered; with the reader parked in
            // a pending `read()`, both were. Nothing a producer can do fixes that, which is
            // why the enriched `input` this would have repaired is size-capped at the write
            // instead (`MAX_APPROVAL_INPUT_SIZE`) rather than trusted to this call. Enqueuing
            // it still costs nothing and still lands whenever the consumer has drained past.
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

              // THE SAME DISCIPLINE AS THE APPROVAL DOOR, on the door beside it. Everything
              // below lands on `toolInvocation` — the same message PART, written into
              // `doc.ai.threads[].messages` by the same `handleMessagesChange` — and this
              // door needs no approval gating to get there, so it is the CHEAPER of the two
              // to abuse. Measured with the approval door fully capped and this one not: 50
              // `start` events with 20 000-character ids and 200 000-character inputs, plus
              // their `complete` events with 2 000 000-character outputs, put 112 000 790
              // JSON characters on ONE assistant message. See `MAX_TOOL_INPUT_SIZE`.
              //
              // Ids first, and they DROP the event rather than truncating it, for the same
              // reason the approval door does: `toolCallId` is the key `withToolInvocation`
              // matches parts by and the key an approval correlates against, so a shortened
              // one names nothing. It is the same cap constant on purpose — see
              // `MAX_TOOL_ID_LENGTH`.
              if (
                wireStringSize(toolCallId) > MAX_TOOL_ID_LENGTH ||
                wireStringSize(toolName) > MAX_TOOL_ID_LENGTH
              ) {
                warnApprovalOnce(
                  'tool-activity-id-length',
                  `The AI server sent a tool activity event whose toolCallId or toolName is ` +
                    `longer than ${MAX_TOOL_ID_LENGTH} characters once stored. These ids are ` +
                    `saved in the dashboard and are what match a tool call to its approval, so ` +
                    `the event was dropped instead of shortened — a shortened id would identify ` +
                    `nothing. That tool call will not appear in the conversation. Check what the ` +
                    `AI endpoint is sending for these fields.`,
                );
                return undefined;
              }
              // …then the PART COUNT, shared with the approval door because both add parts to
              // the same message and one id costs one part however many doors name it.
              // Charged on `start` ONLY, which is the phase that creates a part
              // (`tool-input-start`). A `complete` cannot: `tool-output-available` passes a
              // null initial part to `withToolInvocation`, so an unknown id is a no-op, and
              // the re-assert beside it only fires for a gated id the approval door has
              // already counted. Charging it there too would spend the budget on parts that
              // do not exist.
              if (
                phase === 'start' &&
                !turnToolPartIds.has(toolCallId) &&
                turnToolPartIds.size >= MAX_TURN_TOOL_PARTS
              ) {
                warnApprovalOnce(
                  'tool-part-budget',
                  `The AI server reported more than ${MAX_TURN_TOOL_PARTS} different tool calls ` +
                    `in one response. Each one is stored in the saved dashboard, so the extra ` +
                    `ones were dropped and will not appear in the conversation. Check whether ` +
                    `the endpoint's tool-call limit is set higher than this client's.`,
                );
                return undefined;
              }
              // …then the model's own arguments, which only `start` carries. Over-cap DROPS
              // THE WHOLE EVENT rather than truncating or substituting: `367deaa` un-capped
              // this field because a DOCTORED value teaches the model a shape its own schema
              // rejects, and refusing to record a call at all does not do that. Nothing
              // enters `modelToolInputs` from a dropped event either, so the stream-end flush
              // cannot re-assert what was refused here.
              const toolInputSize = phase === 'start' ? wireValueSize(toolInput ?? {}) : 0;
              if (
                phase === 'start' &&
                (toolInputSize > MAX_TOOL_INPUT_SIZE ||
                  turnToolInputSize + toolInputSize > MAX_TURN_TOOL_INPUT_SIZE)
              ) {
                warnApprovalOnce(
                  'tool-input-size',
                  `The AI server sent tool call arguments larger than this client stores per ` +
                    `response (${MAX_TOOL_INPUT_SIZE} characters per call, ` +
                    `${MAX_TURN_TOOL_INPUT_SIZE} per response). The call was dropped rather ` +
                    `than shortened, because shortened arguments would be replayed to the model ` +
                    `as if it had sent them. That tool call will not appear in the ` +
                    `conversation. Check what the AI endpoint is sending as the call's input.`,
                );
                return undefined;
              }
              if (phase === 'start') {
                turnToolPartIds.add(toolCallId);
                turnToolInputSize += toolInputSize;
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
                // The tool's OUTPUT — server-generated, persisted onto the same part, and
                // replayed to the model by `toOpenAIMessages` on the next request. Measured
                // uncapped at 2 000 000 characters from one event, x 50 events.
                //
                // TRUNCATED AND MARKED, not dropped, and it is the only over-cap payload on
                // this boundary that is. Dropping it would drop this `tool-output-available`
                // chunk, and `processStream` advances a part to `output-available` only on
                // that chunk — so the card would sit at `input-available`, which
                // `resolveToolStatusIcon` draws as a spinner that never resolves. The marker
                // is what keeps the truncation from being a silent lie to the model, exactly
                // as `capToolOutput` does on the server side of this wire.
                const rawOutput = String(rawToolActivity.output ?? '');
                const outputAllowance = Math.min(
                  MAX_TOOL_OUTPUT_SIZE,
                  MAX_TURN_TOOL_OUTPUT_SIZE - turnToolOutputSize,
                );
                let toolOutput = rawOutput;
                if (wireStringSize(rawOutput) > outputAllowance) {
                  toolOutput =
                    truncateToWireSize(
                      rawOutput,
                      outputAllowance - wireStringSize(TOOL_OUTPUT_TRUNCATED_SUFFIX),
                    ) + TOOL_OUTPUT_TRUNCATED_SUFFIX;
                  warnApprovalOnce(
                    'tool-output-size',
                    `The AI server sent a tool result larger than this client stores per ` +
                      `response (${MAX_TOOL_OUTPUT_SIZE} characters per call, ` +
                      `${MAX_TURN_TOOL_OUTPUT_SIZE} per response). It was truncated and marked ` +
                      `as incomplete rather than dropped, so the tool card still resolves — but ` +
                      `neither you nor the model is seeing the whole result. Check what the AI ` +
                      `endpoint is sending as the call's output.`,
                  );
                }
                turnToolOutputSize += wireStringSize(toolOutput);
                streamController.enqueue({
                  type: 'tool-output-available',
                  toolCallId,
                  output: toolOutput,
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
                    // `wireStringSize`, not `.length`: `model` is the one string this door
                    // exempts from the turn budget, so this cap IS its bound — and a bound
                    // spent in raw UTF-16 units against a JSON-character claim is off by up
                    // to 6x (measured: a 10 000-unit control-character `model` persisted
                    // 60 002 JSON characters against a stated 10 000).
                    if (typeof value === 'string' && wireStringSize(value) <= MAX_STRING_LENGTH) {
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
                  } else if (wireStringSize(key) <= MAX_METADATA_KEY_LENGTH) {
                    // Both terms in JSON characters, the unit `MAX_TURN_METADATA_SIZE` is
                    // denominated in. A name is exactly as persistent as the value it names,
                    // and it escapes exactly as expansively.
                    const entrySize = wireStringSize(key) + wireValueSize(value);
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
              // events x 20 000-character ids). See `MAX_TOOL_ID_LENGTH` and
              // `MAX_TURN_TOOL_PARTS` for the shape of the bound and the arithmetic.
              //
              // Both checks reject the WHOLE event rather than repairing it, and both run
              // BEFORE `approvalGatedToolCalls.set` — an event that never reaches the
              // consumer never overwrote `toolInvocation.input`, so it must not enter the
              // re-assert bookkeeping either, or the stream-end flush would emit a
              // `tool-input-available` for a call no card was ever shown for.
              //
              // All three are measured with `wireStringSize` — JSON characters, the unit the
              // budgets around them are denominated in. These three carry no turn budget at
              // all: this cap times `MAX_TURN_TOOL_PARTS` IS their bound, so measuring
              // them in raw UTF-16 units let 256 control characters persist 1 536 JSON
              // characters apiece and multiplied the door's stated worst case by ~6x.
              if (
                wireStringSize(approvalToolCallId) > MAX_TOOL_ID_LENGTH ||
                wireStringSize(approvalToolName) > MAX_TOOL_ID_LENGTH ||
                (approvalId !== undefined && wireStringSize(approvalId) > MAX_TOOL_ID_LENGTH)
              ) {
                warnApprovalOnce(
                  'approval-id-length',
                  `The AI server sent a tool approval request whose toolCallId, toolName or ` +
                    `approvalId is longer than ${MAX_TOOL_ID_LENGTH} characters. These ids ` +
                    `are stored in the saved dashboard and are sent back to the server to answer ` +
                    `the request, so the request was dropped instead of shortened — a shortened ` +
                    `id would identify nothing. The tool call will not show an approval card. ` +
                    `Check what the AI endpoint is sending for these fields.`,
                );
                return undefined;
              }
              if (
                !turnToolPartIds.has(approvalToolCallId) &&
                turnToolPartIds.size >= MAX_TURN_TOOL_PARTS
              ) {
                warnApprovalOnce(
                  'approval-part-budget',
                  `The AI server asked for approval of more than ${MAX_TURN_TOOL_PARTS} ` +
                    `different tool calls in one response. Each one is stored in the saved ` +
                    `dashboard, so the extra requests were dropped and those tool calls will not ` +
                    `show an approval card. Check whether the endpoint's tool-call limit is set ` +
                    `higher than this client's.`,
                );
                return undefined;
              }
              turnToolPartIds.add(approvalToolCallId);
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
              //
              // A WITHHELD summary is announced, on the card and on the console, because the
              // two ways a card can arrive with no impact list are not the same thing: "this
              // call removes nothing" is a reason to approve, "the list did not fit" is a
              // reason to deny, and until now they rendered identically. It matters most in
              // the case it is most likely to hit — the budget is spent in ARRIVAL order and
              // the destructive call usually arrives last in an agentic turn, so an earlier
              // verbose approval (or merely a large dashboard: 40 000 characters is ~700
              // `{id, title}` entities) is exactly what strips the summary off the card that
              // most needs one. The adapter cannot reserve budget for a card it has not seen
              // yet, so it says so instead.
              //
              // `effectsWithheld` is charged nothing: it is a constant ~24 characters and its
              // count is already bounded by `MAX_TURN_TOOL_PARTS`.
              let effects: Record<string, unknown> | undefined;
              // The markers that make a WITHHELD payload distinguishable from an ABSENT one.
              // Collected rather than assigned straight onto `effects`, because more than one
              // can apply to the same card and they must not overwrite each other or the real
              // summary: a card can lose its impact list AND its reason to the same budget.
              const withheldMarkers: Record<string, true> = {};
              const candidateEffects = sanitizeApprovalEffects(rawApproval.effects);
              if (candidateEffects) {
                const effectsSize = wireValueSize(candidateEffects);
                if (turnApprovalSize + effectsSize <= MAX_TURN_APPROVAL_SIZE) {
                  turnApprovalSize += effectsSize;
                  effects = candidateEffects;
                } else {
                  withheldMarkers.effectsWithheld = true;
                  warnApprovalOnce(
                    'approval-effects-budget',
                    `A tool approval request's impact summary was withheld: this response has ` +
                      `already used its ${MAX_TURN_APPROVAL_SIZE}-character budget for approval ` +
                      `summaries, which are stored in the saved dashboard. The card says so and ` +
                      `lists nothing, so deny the request unless you know what it does.`,
                  );
                }
              } else if (approvalEffectsHadContent(rawApproval.effects)) {
                // The server sent a summary and the sanitizer rejected all of it — an
                // over-limit list, or nothing well-typed enough to render. Same user-visible
                // outcome, different cause, so the console message is different.
                withheldMarkers.effectsWithheld = true;
                warnApprovalOnce(
                  'approval-effects-shape',
                  `A tool approval request's impact summary was withheld: it exceeded this ` +
                    `client's per-list or per-string limits, or carried nothing it could ` +
                    `render. The card says so and lists nothing, so deny the request unless you ` +
                    `know what it does. Check what the AI endpoint is sending as \`effects\`.`,
                );
              }
              // `reason` is charged in the SAME unit as `effects` above and as the budget
              // itself: JSON characters. Charging `String.prototype.length` here — which is
              // what shipped — spent a 40 000-JSON-character budget in raw UTF-16 units, so
              // four at-cap control-character reasons charged 40 000 and persisted 240 008.
              //
              // …and a withheld `reason` is ANNOUNCED, on exactly the argument that made
              // `effectsWithheld` necessary: "the policy gave no reason" and "the reason did
              // not fit" are opposite signals and used to render identically. They share ONE
              // budget, spent in arrival order, so the case is the same one and is if anything
              // more likely — `effects` is charged first, so a card can lose only its reason
              // while keeping its impact list, and a reader who sees the list has every
              // reason to assume nothing else was suppressed.
              let policyReason: string | undefined;
              const reasonSize =
                typeof rawApproval.reason === 'string' ? wireStringSize(rawApproval.reason) : 0;
              if (typeof rawApproval.reason === 'string' && rawApproval.reason !== '') {
                if (reasonSize > MAX_STRING_LENGTH) {
                  withheldMarkers.reasonWithheld = true;
                  warnApprovalOnce(
                    'approval-reason-size',
                    `A tool approval request's reason was withheld: it is longer than the ` +
                      `${MAX_STRING_LENGTH} characters this client stores for one. The card says ` +
                      `so and states no reason, so deny the request unless you know what it ` +
                      `does. Check what the AI endpoint is sending as \`reason\`.`,
                  );
                } else if (turnApprovalSize + reasonSize > MAX_TURN_APPROVAL_SIZE) {
                  withheldMarkers.reasonWithheld = true;
                  warnApprovalOnce(
                    'approval-reason-budget',
                    `A tool approval request's reason was withheld: this response has already ` +
                      `used its ${MAX_TURN_APPROVAL_SIZE}-character budget for approval ` +
                      `summaries and reasons, which are stored in the saved dashboard. The card ` +
                      `says so and states no reason, so deny the request unless you know what it ` +
                      `does.`,
                  );
                } else {
                  turnApprovalSize += reasonSize;
                  policyReason = rawApproval.reason;
                }
              }
              // The display-enriched `input`, capped per card AND per turn.
              //
              // This one used to be forwarded verbatim, on the grounds that it never outlives
              // the confirmation card — the model's own arguments are re-asserted over it at
              // every settle point. That holds for three exit paths and fails on the fourth:
              // `errorStream` calls `ReadableStreamDefaultController.error()`, which RESETS
              // the queue, so a re-assert the consumer has not already read is discarded
              // (measured: zero delivered, a 2 MB enriched copy left as the last write to
              // `toolInvocation.input`). It is also persisted the moment the card renders and
              // stays there for the whole human-deliberation window, since the approval is
              // answered on a separate POST while this stream stays open. The re-assert is a
              // repair, not a prevention. See `MAX_APPROVAL_INPUT_SIZE` for the full
              // measurement and for why the fallback is `{}` rather than the model's own
              // arguments.
              //
              // Still uncapped, deliberately: `modelToolInputs`' copy — the model's OWN
              // arguments, which `toOpenAIMessages` replays verbatim, and which `367deaa`
              // un-capped precisely because a doctored value teaches the model a shape its
              // own schema rejects.
              const rawApprovalInput = rawApproval.input ?? {};
              const approvalInputSize = wireValueSize(rawApprovalInput);
              let approvalInput: unknown = {};
              if (
                approvalInputSize <= MAX_APPROVAL_INPUT_SIZE &&
                turnApprovalInputSize + approvalInputSize <= MAX_TURN_APPROVAL_INPUT_SIZE
              ) {
                turnApprovalInputSize += approvalInputSize;
                approvalInput = rawApprovalInput;
              } else {
                // …and the degradation is MARKED, on `22964a2`'s own standard. `ToolPart`'s
                // `showInput` is `input !== undefined` and `{}` is defined, so without this
                // the card renders an "Input" section reading `{}` — byte-identical to a
                // genuine no-argument call. "This call takes no arguments" and "this client
                // refused to store the arguments" are very different things to be approving,
                // and the console warning below reaches nobody holding the deny button.
                withheldMarkers.inputWithheld = true;
                warnApprovalOnce(
                  'approval-input-size',
                  `The AI server sent a tool approval request whose details are larger than this ` +
                    `client stores per response (${MAX_APPROVAL_INPUT_SIZE} characters per ` +
                    `request, ${MAX_TURN_APPROVAL_INPUT_SIZE} per response). The approval card ` +
                    `is showing no details for it, so deny the request unless you know what it ` +
                    `does. Check what the AI endpoint is sending as the request's input.`,
                );
              }
              // The real summary and the withheld markers ride the same field, because
              // `effects` is the only payload `ToolPart`'s `approvalDetails` slot receives.
              // Merged, not either/or: a card whose impact list fit but whose reason did not
              // must show both.
              const cardEffects =
                effects || Object.keys(withheldMarkers).length > 0
                  ? { ...effects, ...withheldMarkers }
                  : undefined;
              streamController.enqueue({
                type: 'tool-approval-request',
                ...(approvalId ? { approvalId } : {}),
                toolCallId: approvalToolCallId,
                toolName: approvalToolName,
                input: approvalInput,
                ...(cardEffects ? { effects: cardEffects } : {}),
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
