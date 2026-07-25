/**
 * `handleAIChat` — the core pure function of x-studio-ai-middleware.
 *
 * This function:
 * 1. Accepts a parsed `StudioAIRequest` body and connection options
 * 2. Builds the system prompt server-side
 * 3. Runs the full agentic loop (LLM calls + tool execution)
 * 4. Streams back Server-Sent Events: text deltas, state mutations, finish
 *
 * PURE FUNCTION GUARANTEE:
 * - No HTTP framework imports (no express, fastify, next, etc.)
 * - No process.exit()
 * - No global state mutation
 * - All dependencies injected via options
 *
 * The host app is responsible for:
 * - Parsing the request body as JSON into a `StudioAIRequest`
 * - Calling `handleAIChat` and writing the returned stream to the HTTP response
 *
 * @example Next.js App Router route handler:
 * ```ts
 * // app/api/ai/chat/route.ts
 * import { handleAIChat } from '@mui/x-studio-ai-middleware';
 *
 * export async function POST(req: Request) {
 *   const body = await req.json();
 *   const stream = handleAIChat(body, {
 *     endpoint: 'https://api.openai.com/v1/chat/completions',
 *     apiKey: process.env.OPENAI_API_KEY,
 *   });
 *   return new Response(stream, {
 *     headers: {
 *       'Content-Type': 'text/event-stream',
 *       'Cache-Control': 'no-cache',
 *       Connection: 'keep-alive',
 *     },
 *   });
 * }
 * ```
 *
 * @example Express route handler:
 * ```ts
 * import { handleAIChat } from '@mui/x-studio-ai-middleware';
 * import { Readable } from 'stream';
 *
 * app.post('/api/ai/chat', async (req, res) => {
 *   res.setHeader('Content-Type', 'text/event-stream');
 *   res.setHeader('Cache-Control', 'no-cache');
 *   const sseStream = handleAIChat(req.body, {
 *     endpoint: 'https://api.openai.com/v1/chat/completions',
 *     apiKey: process.env.OPENAI_API_KEY,
 *   });
 *   Readable.fromWeb(sseStream).pipe(res);
 * });
 * ```
 */
import { runAgenticLoop } from './agenticLoop';
import type { PendingApproval } from './agenticLoop/toolDispatch';
import type { ToolPolicy } from './toolPolicy';
import { withTimeout } from './mcp/helpers';
import { capIncomingDashboardState } from './executeToolOnState';
import { capMaybeText, capText } from './internal/promptCaps';
import type { StudioAIRequest, StudioAISSEEvent } from './models/protocol';
import type {
  SerializableSkill,
  StudioAISkill,
  StudioAIDataConfig,
  StudioAIRateLimit,
  StudioAIRichContext,
  StudioAIEnrichedContext,
} from './models/aiTypes';
import type { StudioState, StudioCustomWidgetDef } from './models/studioTypes';

/** Arguments passed to a {@link StudioAIContextEnricher}. */
export interface StudioAIContextEnricherArgs {
  /** The current dashboard state from the request body. */
  dashboardState: StudioState;
  /** Client-derived rich context, if any (absent in `privateMode`). */
  richContext?: StudioAIRichContext;
  /** The request's abort signal, when provided. */
  signal?: AbortSignal;
}

/**
 * Hook to attach DB-side metadata to the AI context. See
 * {@link StudioAIHandlerOptions.contextEnricher} for usage.
 *
 * @param {StudioAIContextEnricherArgs} args - Dashboard state, client-derived rich context, and abort signal.
 * @returns {StudioAIEnrichedContext | Promise<StudioAIEnrichedContext>} Server-side metadata to render into the system prompt.
 */
export type StudioAIContextEnricher = (
  args: StudioAIContextEnricherArgs,
) => StudioAIEnrichedContext | Promise<StudioAIEnrichedContext>;

/**
 * Options for the AI chat handler.
 * These should be provided server-side; never send the `apiKey` to the client.
 */
export interface StudioAIHandlerOptions {
  /**
   * OpenAI-compatible completions endpoint.
   * e.g. `'https://api.openai.com/v1/chat/completions'`
   */
  endpoint: string;
  /**
   * LLM API key. Store this in an environment variable — never expose in browser code.
   * e.g. `process.env.OPENAI_API_KEY`
   */
  apiKey?: string;
  /**
   * Model to use. Defaults to `'gpt-4o'`.
   */
  model?: string;
  /**
   * Additional HTTP headers forwarded to the LLM endpoint.
   */
  headers?: Record<string, string>;
  /**
   * Called when a tool execution throws an error.
   * Use this to log errors without interrupting the stream.
   *
   * @param {string} toolName - The name of the tool that threw.
   * @param {Error} error - The error that was thrown.
   */
  onToolError?: (toolName: string, error: Error) => void;
  /**
   * Optional `AbortSignal` for request cancellation.
   */
  signal?: AbortSignal;
  /**
   * Server-side skill handlers with `execute` functions.
   *
   * The `skills` field in the request body carries the serialisable skill metadata
   * (name, mode, promptFragment, tool schema), but `execute` functions are stripped
   * before the request is sent — functions are not JSON-serialisable.
   *
   * Pass the full `StudioAISkill` instances here so the agentic loop can call
   * `execute` when the model invokes a `server-tool` skill's tool.
   *
   * Only skills with `mode: 'server-tool'` and a `tool.execute` function are used.
   * Skills listed in `body.skills` that have no matching entry here will receive a
   * descriptive error from the model ("no registered handler on the server").
   *
   * @example
   * ```ts
   * import { handleAIChat, type StudioAIHandlerOptions } from '@mui/x-studio-ai-middleware';
   * import { myCustomSkill } from './skills';
   *
   * const stream = handleAIChat(body, {
   *   endpoint: process.env.OPENAI_ENDPOINT,
   *   apiKey: process.env.OPENAI_API_KEY,
   *   skillHandlers: [myCustomSkill],
   * });
   * ```
   */
  skillHandlers?: StudioAISkill[];
  /**
   * App-provided data-access configuration for the `query_data_source` AI tool.
   *
   * When set, the model can call `query_data_source` to run structured queries
   * (source id + columns/filters/aggregations/having/orderBy) against the
   * connected data sources. Your `queryDataSource` callback is responsible for
   * routing, security, and allowlisting — the same shape `buildStudioMcpServer`'s
   * `data` option accepts, so a single implementation covers both transports.
   *
   * @example
   * ```ts
   * const stream = handleAIChat(body, {
   *   endpoint: process.env.OPENAI_ENDPOINT,
   *   apiKey: process.env.OPENAI_API_KEY,
   *   data: {
   *     async queryDataSource(params) {
   *       const result = await handleBatchQuery(
   *         { pageId: 'chat', widgets: [{ id: 'q', table: params.tableName, ...params }] },
   *         claims,
   *         { db, schemaAllowlist },
   *       );
   *       const r = result.results[0];
   *       return { rows: r.rows, rowCount: r.rowCount, tier: r.tier };
   *     },
   *   },
   * });
   * ```
   */
  data?: StudioAIDataConfig;
  /**
   * Token and turn budget enforced for this request.
   *
   * Use this to cap LLM token spend, protect against runaway agentic loops,
   * and implement per-tenant or per-user quota policies.
   *
   * @example
   * ```ts
   * const stream = handleAIChat(body, {
   *   endpoint: process.env.OPENAI_ENDPOINT,
   *   apiKey: process.env.OPENAI_API_KEY,
   *   rateLimit: {
   *     maxTokensPerRequest: 8_000,
   *     maxTurnsPerRequest: 5,
   *     onLimitReached(reason, usage) {
   *       console.warn(`AI limit reached (${reason}):`, usage);
   *     },
   *   },
   * });
   * ```
   */
  rateLimit?: StudioAIRateLimit;
  /**
   * Shared map for human-in-the-loop tool approval.
   *
   * When set, destructive tools (`remove_page`, `remove_widget`, `apply_bulk_update`)
   * pause before execution and emit a `tool-approval-request` SSE event. The stream
   * holds open while awaiting approval. Your approval endpoint resolves the pending
   * entry using the `toolCallId` as the key.
   *
   * Each entry is a {@link PendingApproval} — `{ resolve, threadId? }`, not a bare
   * callback. `threadId` (the AI chat thread the approval was raised under, when
   * known) lets your approval endpoint refuse a resolution presented for the wrong
   * conversation instead of trusting the id alone — important because an id can be
   * observed or guessed by another caller. `toolCallId`s are also now generated with
   * `crypto.randomUUID()` (not a predictable scheme), so an id alone is no longer
   * practically guessable either; the `threadId` check is defense in depth on top of
   * that, and requires your route to also thread a thread/session identifier through
   * your approval UI. IMPORTANT: when `entry.threadId` is set, your route MUST
   * require the resolution request to present a MATCHING `threadId` — reject the
   * request (missing OR mismatched) rather than skipping the check, or a resolver
   * could bypass thread-binding entirely simply by omitting `threadId` from its
   * request body. The check is only skipped (a no-op) when `entry.threadId` itself
   * is absent — i.e. the approval wasn't bound to a thread in the first place.
   *
   * @example
   * ```ts
   * import { isApprovalThreadIdAuthorized, type PendingApproval } from '@mui/x-studio-ai-middleware';
   *
   * // Shared state (module-level in your route file)
   * const pendingApprovals = new Map<string, PendingApproval>();
   *
   * // Chat route — pass the map to handleAIChat
   * app.post('/api/ai/chat', (req, res) => {
   *   const stream = handleAIChat(req.body, { ..., approvalPending: pendingApprovals });
   *   // ... stream to response
   * });
   *
   * // Approval route — resolve the pending approval, requiring the caller's own
   * // auth (mirroring the chat route's auth) AND, whenever the entry has a thread
   * // id, a matching one from the resolution request. Use `isApprovalThreadIdAuthorized`
   * // rather than hand-rolling this check — a naive
   * // `entry.threadId !== undefined && threadId !== undefined && entry.threadId !== threadId`
   * // is bypassable simply by omitting `threadId` from the request body.
   * app.post('/api/ai/approval', (req, res) => {
   *   const claims = resolveClaims(req); // same auth check as /chat
   *   const { id, approved, reason, threadId } = req.body;
   *   const entry = pendingApprovals.get(id);
   *   if (!entry) return res.status(404).json({ error: `No pending approval for id: ${id}` });
   *   if (!isApprovalThreadIdAuthorized(entry, threadId)) {
   *     return res.status(403).json({ error: 'This approval belongs to a different chat thread.' });
   *   }
   *   pendingApprovals.delete(id);
   *   entry.resolve(approved, reason);
   *   res.json({ ok: true });
   * });
   * ```
   */
  approvalPending?: Map<string, PendingApproval>;
  /**
   * What to do when a tool's policy decision is `require-approval` but no
   * `approvalPending` channel is configured (or wired) to pause on.
   *
   * Forwarded to the agentic loop's `approvalFallback` option:
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
   * Forwarded to the agentic loop. When an approval is neither granted nor denied
   * within this window, the loop tells the model the approval timed out and cleans
   * up, rather than holding the SSE stream open indefinitely.
   *
   * @default 120000
   */
  approvalTimeoutMs?: number;
  /**
   * Optional hook to attach DB-side metadata to the AI context.
   *
   * Called once per request, before the agentic loop starts. Use it to enrich
   * the system prompt with information that only the server has — e.g. exact row
   * counts per dimension value, or schema comments from the database catalog.
   * The returned `StudioAIEnrichedContext` is rendered into a `<server_context>`
   * block in the system prompt (omitted in `privateMode`).
   *
   * Enrichment is best-effort: if the callback throws, OR does not settle within
   * `CONTEXT_ENRICHER_TIMEOUT_MS` (finding T2-2, iteration 25 — a hung DB query
   * previously blocked the entire chat stream before the first LLM call, since
   * nothing bounded this `await`), the error/timeout is reported via
   * `onToolError('contextEnricher', err)` and the chat proceeds without it — the
   * same graceful degradation `mcp/resources.ts`'s `studio://dashboard/system-prompt`
   * resource applies to its own call to this same callback.
   * Keep the returned payload small — it counts against the LLM token budget;
   * bound large maps/notes yourself before returning.
   *
   * @example
   * ```ts
   * const stream = handleAIChat(body, {
   *   endpoint: process.env.OPENAI_ENDPOINT,
   *   apiKey: process.env.OPENAI_API_KEY,
   *   async contextEnricher({ dashboardState }) {
   *     const rowCounts = await db.countByDimension('orders', 'region');
   *     return { rowCounts: { region: rowCounts } };
   *   },
   * });
   * ```
   */
  contextEnricher?: StudioAIContextEnricher;
  /**
   * Server-enforced tool allowlist. The effective tool set is the INTERSECTION of
   * this and the request body's `allowedTools` (a body that omits `allowedTools`
   * allows all tools, so the intersection is this list). Omit to preserve the
   * current behavior (the client-asserted `body.allowedTools` is trusted as-is).
   *
   * Use this when a host must guarantee an integration can never call certain tools
   * regardless of what the client puts in the request body.
   */
  allowedTools?: string[];
  /**
   * Server-enforced skill allow-list, by skill `name`. The client asserts `body.skills`
   * (name, mode, `promptFragment`, tool schema), and each skill's `promptFragment` is
   * interpolated into the higher-trust **system** prompt region.
   *
   * IMPORTANT (finding T1-1, iteration 25): naming a skill here does **not**, by
   * itself, admit any client-supplied CONTENT — it only admits a client-supplied
   * SELECTION. The original finding-2.1 fix filtered `body.skills` by `name` alone,
   * but that still let a request assert `{ name: 'an-allowlisted-name', promptFragment:
   * '<attacker-authored instructions>' }`: the name passed the allow-list, while the
   * attacker's own fragment (and, for `server-tool` mode, their own tool
   * `description`/`parameters`) rode along unchanged into the system prompt — a full
   * bypass of the allow-list's intent. So for every body-supplied skill whose `name`
   * is in this list, the entry is now SUBSTITUTED with the matching, host-authored
   * definition registered in `options.skillHandlers` (matched by `name`) — the same
   * registry already used to look up `execute` for `server-tool` skills — rather than
   * trusting any field of the body's object. A body skill's `name` is therefore only
   * ever a *selector* into `skillHandlers`; its own `promptFragment`/`tool` are never
   * used. A name in this list with no matching `skillHandlers` entry is dropped —
   * there is nothing server-vetted to substitute, so the body's content is never
   * used as a fallback. Omit `allowedSkills` to preserve the current behavior
   * (`body.skills` trusted as-is, including its content).
   *
   * Use this on a multi-tenant/public endpoint to guarantee an integration can never
   * inject skill prompt fragments (or tool schemas) the host did not author — pair
   * it with a `skillHandlers` entry for every allowlisted name.
   */
  allowedSkills?: string[];
  /**
   * Server-enforced private mode. The effective private mode is
   * `options.privateMode || body.privateMode`: the client can opt INTO private mode
   * but can never opt OUT of a server-mandated one. Omit to preserve the current
   * behavior (the client-asserted `body.privateMode` is trusted as-is).
   */
  privateMode?: boolean;
  /**
   * Per-call authorization policy — the single chokepoint every built-in mutating
   * tool call passes through. Defaults to `createDefaultToolPolicy()` (require
   * approval for `DESTRUCTIVE_TOOLS`, allow everything else). Supply a custom policy
   * to `deny`/`require-approval`/`allow` per call based on tool name, args, and the
   * derived structural effects.
   */
  toolPolicy?: ToolPolicy;
}

/**
 * Timeout (ms) for the host-supplied `contextEnricher` callback (finding T2-2,
 * iteration 25). Every other host-supplied callback in this package is already
 * bounded by `withTimeout` — server-tool skills and `queryDataSource` at 15s,
 * `approvalHandler` at up to 120s, LLM fetches at 120s — but `contextEnricher`
 * was awaited unbounded on both transports (here, and in
 * `mcp/resources.ts`'s `studio://dashboard/system-prompt` resource read), so a
 * hung DB query stalled the entire response before the first LLM call. Sized
 * the same as `queryDataSource`/server-tool skills since it is the same shape
 * of call — a single server-side data-access hook — and enrichment is
 * documented as best-effort, so a shorter bound is appropriate (this is not a
 * user-facing tool call the model is waiting on turn budget for).
 *
 * Exported so `mcp/resources.ts` shares the exact same value, and so tests can
 * assert against it directly.
 */
export const CONTEXT_ENRICHER_TIMEOUT_MS = 15_000;

/**
 * Max number of entries accepted in a request's `body.messages` array (finding F2,
 * Tier 2). The conversation history comes straight from the client `body` and is
 * serialized into the first LLM request by `toOpenAIMessages` with no length cap of
 * its own, so a client could post an unbounded number of messages (or a handful of
 * multi-megabyte ones) and blow the request up before any per-turn token/turn budget
 * — checked only AFTER a turn completes — could apply. Sized generously (a real chat
 * thread is nowhere near this) so it only ever trips for a runaway/hostile payload;
 * rejected (not silently truncated) with an actionable error, since truncating could
 * silently drop the user's latest message.
 */
export const MAX_REQUEST_MESSAGES = 1_000;

/**
 * Max total size (chars, ~bytes of the JSON text) of a request's `body.messages`
 * array (finding F2, Tier 2). Complements {@link MAX_REQUEST_MESSAGES}: a small
 * number of enormous messages is the same unbounded-first-request class as a large
 * number of small ones. Sized generously so only a runaway/hostile payload trips it.
 */
export const MAX_REQUEST_MESSAGES_TOTAL_CHARS = 2_000_000;

/**
 * Max string length a capped `richContext`/`customWidgets` free-text field is
 * truncated to (Tier 1 resource-exhaustion finding, sibling to
 * `executeToolOnState.ts`'s `MAX_TITLE_LENGTH`). Both `richContext` and
 * `customWidgets` are client-supplied request fields interpolated into the
 * FIRST system prompt (via `buildAISystemPrompt.ts`'s `buildRichContextBlock`
 * and its custom-widget listing loop) with only `sanitizeForPrompt`'s
 * angle-bracket escaping — no length bound of its own. Sized the same as
 * `MAX_TITLE_LENGTH` rather than inventing a second constant for the same
 * class of free-text string.
 */
const MAX_REQUEST_STRING_LENGTH = 200;

/**
 * Max number of `richContext.fieldStats` keys retained (Tier 1
 * resource-exhaustion finding). `buildRichContextBlock` iterates
 * `Object.entries(rc.fieldStats)` with no existing cap before interpolating
 * every entry into `<dashboard_context>`. `StudioAIRichContext`'s own doc
 * comment says the CLIENT is expected to stay under a token budget — that is
 * a documented assumption, not a server-enforced bound, so a hostile/buggy
 * client is not actually stopped by it.
 */
const MAX_RICH_CONTEXT_FIELD_STATS = 500;

/** Max number of `richContext.pageLayout.rows` retained (see {@link MAX_RICH_CONTEXT_FIELD_STATS}). */
const MAX_RICH_CONTEXT_LAYOUT_ROWS = 200;

/** Max number of widget cells retained per `richContext.pageLayout.rows` row (see {@link MAX_RICH_CONTEXT_FIELD_STATS}). */
const MAX_RICH_CONTEXT_ROW_CELLS = 50;

/** Max number of `richContext.pageLayout.crossFilters` entries retained (see {@link MAX_RICH_CONTEXT_FIELD_STATS}). */
const MAX_RICH_CONTEXT_CROSS_FILTERS = 200;

/** Max number of `richContext.recentMutations` entries retained (see {@link MAX_RICH_CONTEXT_FIELD_STATS}). */
const MAX_RICH_CONTEXT_RECENT_MUTATIONS = 200;

/** Max number of `richContext.omitted` entries retained (see {@link MAX_RICH_CONTEXT_FIELD_STATS}). */
const MAX_RICH_CONTEXT_OMITTED = 50;

/**
 * Max number of `customWidgets` entries retained from the request body
 * (Tier 1 resource-exhaustion finding). `buildAISystemPrompt.ts` loops over
 * the whole array, unbounded, to list each custom widget kind in the system
 * prompt.
 */
const MAX_REQUEST_CUSTOM_WIDGETS = 200;

/**
 * Max number of `defaultConfig` keys retained per `customWidgets` entry (see
 * {@link MAX_REQUEST_CUSTOM_WIDGETS}). `buildAISystemPrompt.ts` interpolates
 * `Object.keys(cw.defaultConfig)` in full with no existing cap.
 */
const MAX_CUSTOM_WIDGET_CONFIG_KEYS = 200;

/**
 * Max number of `body.skills` entries retained (finding H1a). Nothing capped
 * `skills` AT ALL before: `validateStudioAIRequestBody` only checked that each
 * entry's `name` is a string, and every retained entry's `promptFragment` (and, for
 * `server-tool` mode, its tool `description`/`parameters`) is interpolated into the
 * system prompt — which is then re-sent on EVERY one of up to 10 turns.
 */
const MAX_REQUEST_SKILLS = 100;

/**
 * Max length of a skill's `promptFragment` (finding H1a). This is deliberately far
 * larger than {@link MAX_REQUEST_STRING_LENGTH} — a fragment is real instruction
 * prose, not a label — but it must still be bounded: a single
 * `promptFragment: 'A'.repeat(50e6)` produced a 50 MB system prompt, re-sent every
 * turn, before any token budget (checked only AFTER a turn completes) could apply.
 */
const MAX_SKILL_PROMPT_FRAGMENT_CHARS = 20_000;

/** Max length of a `server-tool` skill's tool `description` (see {@link MAX_SKILL_PROMPT_FRAGMENT_CHARS}). */
const MAX_SKILL_TOOL_DESCRIPTION_CHARS = 4_000;

/**
 * Max serialized size of a `server-tool` skill's JSON-Schema `parameters` object
 * (finding H1a). Sent verbatim in the `tools` array of every LLM request. A schema
 * over this size is rejected — replaced with an empty object schema — rather than
 * truncated, since a half-truncated JSON Schema is not a valid schema.
 */
const MAX_SKILL_TOOL_PARAMETERS_CHARS = 20_000;

/**
 * Max length of `body.pageSnapshot` (finding H1b). Validated as a string but never
 * length-capped: its mere presence advertises `summarise_page`, whose output is the
 * snapshot VERBATIM — which is then appended to `currentMessages` and re-sent on
 * every remaining turn. Sized to a generous page-summary CSV (~25K tokens).
 */
const MAX_PAGE_SNAPSHOT_CHARS = 100_000;

/**
 * How many SSE frames may sit in the returned stream's internal queue before the
 * producer waits for the consumer (finding L2). Small enough that a client which
 * stops reading cannot accumulate a whole response in memory, large enough that a
 * healthy stream never pays a scheduling round-trip per text delta.
 */
const SSE_QUEUE_HIGH_WATER_MARK = 64;

/**
 * How long (ms) the producer waits before re-checking `desiredSize` while the SSE
 * queue is full (finding L2). Only ever reached when a consumer has stopped
 * draining, so the polling cost is paid exclusively by a stalled client.
 */
const SSE_DRAIN_POLL_MS = 25;

/** Cap a value to {@link MAX_REQUEST_STRING_LENGTH} when it is a string; pass through otherwise. */
function capRequestString(value: unknown): unknown {
  return capMaybeText(value, MAX_REQUEST_STRING_LENGTH);
}

/** Plain-object guard mirroring `buildAISystemPrompt.ts`'s own defensive shape checks. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Cap every present string-typed field of a `richContext.fieldStats` entry
 * (Tier 1 architecture-review finding, sibling to the array/count caps below).
 * `min`/`max`/`mean`/`distinctCount`/`sampledRows`/`type` are nominally typed
 * `number`/enum, but `richContext` is client-supplied JSON with no runtime type
 * check, so a crafted body can smuggle an oversized string into any of them —
 * `buildRichContextBlock` interpolates every one via `sanitizeForPrompt(String(v))`
 * with no length bound of its own. Only fields actually present on the entry are
 * touched, so an entry missing e.g. `min` does not gain a spurious `min: undefined`
 * key. Non-string values (the well-formed common case) pass through
 * `capRequestString` unchanged.
 */
function capFieldStatEntry(stat: Record<string, unknown>): Record<string, unknown> {
  const capped: Record<string, unknown> = { ...stat };
  for (const key of ['type', 'min', 'max', 'mean', 'distinctCount', 'sampledRows'] as const) {
    if (Object.hasOwn(stat, key)) {
      capped[key] = capRequestString(stat[key]);
    }
  }
  return capped;
}

/**
 * Cap every present string-typed field of a `richContext.pageLayout.rows` cell
 * (a `StudioAILayoutWidget`) — see {@link capFieldStatEntry} for the same
 * rationale. `widgetId`/`kind`/`title`/`chartType` are echoed verbatim into
 * `<dashboard_context>`, and `colSpan` (nominally `number`) is echoed the same
 * way (`buildAISystemPrompt.ts` already notes it can carry a smuggled string).
 */
function capLayoutWidgetCell(cell: Record<string, unknown>): Record<string, unknown> {
  const capped: Record<string, unknown> = { ...cell };
  for (const key of ['widgetId', 'kind', 'title', 'chartType', 'colSpan'] as const) {
    if (Object.hasOwn(cell, key)) {
      capped[key] = capRequestString(cell[key]);
    }
  }
  return capped;
}

/**
 * Cap every present string-typed field of a `richContext.pageLayout.crossFilters`
 * entry (a `StudioAICrossFilterEdge`) — see {@link capFieldStatEntry}.
 * `sourceWidgetId`/`field`/`scope` are all echoed verbatim into
 * `<dashboard_context>`'s cross-filter graph listing.
 */
function capCrossFilterEdge(edge: Record<string, unknown>): Record<string, unknown> {
  const capped: Record<string, unknown> = { ...edge };
  for (const key of ['sourceWidgetId', 'field', 'scope'] as const) {
    if (Object.hasOwn(edge, key)) {
      capped[key] = capRequestString(edge[key]);
    }
  }
  return capped;
}

/**
 * Cap a client-supplied `richContext` (Tier 1 resource-exhaustion finding,
 * sibling to `executeToolOnState.ts`'s `capIncomingDashboardState`) before it
 * is threaded into `buildAISystemPrompt`'s `<dashboard_context>` block.
 * `buildRichContextBlock` already defensively guards against malformed shapes
 * (a non-plain-object `fieldStats`, a non-array `pageLayout.rows`, …) via
 * `isPlainObject`/`Array.isArray` checks and simply omits a malformed
 * section — so this cap mirrors those SAME shape guards and only bounds the
 * count/length of an otherwise-well-shaped section, leaving a malformed one
 * untouched for `buildRichContextBlock` to skip as it already does.
 *
 * Caps element/entry COUNTS as before, and additionally caps the LENGTH of
 * every individual string field inside each retained element (Tier 1
 * architecture-review finding): `fieldStats` entry values (via
 * {@link capFieldStatEntry}), `pageLayout.pageId`, each `pageLayout.rows` cell
 * (via {@link capLayoutWidgetCell}), and each `pageLayout.crossFilters` entry
 * (via {@link capCrossFilterEdge}) — the same class of gap the sibling
 * `recentMutations.label` cap already closed for its own section.
 *
 * Applied once, at the same request-handling chokepoint as
 * `capIncomingDashboardState`, before `richContext` reaches the context
 * enricher or the agentic loop. Returns the input unchanged when it is not a
 * plain object (including `undefined`); never mutates the input.
 */
export function capIncomingRichContext(
  richContext: StudioAIRichContext | undefined,
): StudioAIRichContext | undefined {
  if (!isPlainRecord(richContext)) {
    return richContext;
  }
  const rc = richContext as unknown as {
    fieldStats?: unknown;
    pageLayout?: unknown;
    recentMutations?: unknown;
    omitted?: unknown;
  };
  const capped: Record<string, unknown> = { ...richContext };

  if (isPlainRecord(rc.fieldStats)) {
    capped.fieldStats = Object.fromEntries(
      Object.entries(rc.fieldStats)
        .slice(0, MAX_RICH_CONTEXT_FIELD_STATS)
        // Finding (Tier 2): the entry KEY (the field name itself) was never
        // length-capped — only the entry COUNT and each entry's VALUES were.
        // `buildRichContextBlock` echoes the raw key verbatim with no length bound
        // of its own, so an oversized key is the same token-bomb class every
        // capped value here already guards against. `capRequestString` only
        // touches strings (a no-op guard, since `Object.entries` keys are always
        // strings) so the cast is safe.
        .map(([key, stat]) => [
          capRequestString(key) as string,
          isPlainRecord(stat) ? capFieldStatEntry(stat) : stat,
        ]),
    );
  }

  if (isPlainRecord(rc.pageLayout)) {
    const layout = rc.pageLayout as { pageId?: unknown; rows?: unknown; crossFilters?: unknown };
    const cappedLayout: Record<string, unknown> = { ...layout };
    if (Object.hasOwn(layout, 'pageId')) {
      cappedLayout.pageId = capRequestString(layout.pageId);
    }
    if (Array.isArray(layout.rows)) {
      cappedLayout.rows = layout.rows
        .slice(0, MAX_RICH_CONTEXT_LAYOUT_ROWS)
        .map((row) =>
          Array.isArray(row)
            ? row
                .slice(0, MAX_RICH_CONTEXT_ROW_CELLS)
                .map((cell) => (isPlainRecord(cell) ? capLayoutWidgetCell(cell) : cell))
            : row,
        );
    }
    if (Array.isArray(layout.crossFilters)) {
      cappedLayout.crossFilters = layout.crossFilters
        .slice(0, MAX_RICH_CONTEXT_CROSS_FILTERS)
        .map((edge) => (isPlainRecord(edge) ? capCrossFilterEdge(edge) : edge));
    }
    capped.pageLayout = cappedLayout;
  }

  if (Array.isArray(rc.recentMutations)) {
    capped.recentMutations = rc.recentMutations
      .slice(0, MAX_RICH_CONTEXT_RECENT_MUTATIONS)
      .map((m) => (isPlainRecord(m) ? { ...m, label: capRequestString(m.label) } : m));
  }

  if (Array.isArray(rc.omitted)) {
    capped.omitted = rc.omitted.slice(0, MAX_RICH_CONTEXT_OMITTED).map(capRequestString);
  }

  return capped as StudioAIRichContext;
}

/**
 * Cap a client-supplied `customWidgets` array (Tier 1 resource-exhaustion
 * finding, sibling to {@link capIncomingRichContext}) before it is threaded
 * into `buildAISystemPrompt`'s custom-widget listing loop and the agentic
 * loop's widget-creation tools. Caps the array length
 * ({@link MAX_REQUEST_CUSTOM_WIDGETS}) and, per entry, the `kind`/`label`/
 * `description` string length ({@link MAX_REQUEST_STRING_LENGTH}) and the
 * `defaultConfig` key count ({@link MAX_CUSTOM_WIDGET_CONFIG_KEYS}).
 * `kind` is capped for the SAME reason `label`/`description` are: it is echoed
 * straight into the first system prompt (both in the custom-widget listing and
 * — for a widget actually created with that kind — into every subsequent
 * `<dashboard_state>` via `describeWidget`'s `pushField('kind', widget.kind)`),
 * so an unbounded `kind` is exactly the same persistent token-bomb class as an
 * unbounded `label` (Tier 1 architecture-review finding). `defaultConfig`'s
 * key/value VALIDATION (not just its key-count cap here) happens later, at the
 * point a widget of that kind is actually built — see
 * `executeToolOnState.ts`'s `buildWidgetFromArgs`. `validateStudioAIRequestBody`
 * has already guaranteed each element is a plain object with a string `kind` by
 * the time this runs. Returns the input unchanged when it is `undefined`; never
 * mutates the input.
 */
export function capIncomingCustomWidgets(
  customWidgets: StudioCustomWidgetDef[] | undefined,
): StudioCustomWidgetDef[] | undefined {
  if (!customWidgets) {
    return customWidgets;
  }
  return customWidgets.slice(0, MAX_REQUEST_CUSTOM_WIDGETS).map((cw) => ({
    ...cw,
    kind: capRequestString(cw.kind) as string,
    label: capRequestString(cw.label) as string,
    ...(cw.description !== undefined
      ? { description: capRequestString(cw.description) as string }
      : {}),
    ...(isPlainRecord(cw.defaultConfig)
      ? {
          defaultConfig: Object.fromEntries(
            Object.entries(cw.defaultConfig)
              .slice(0, MAX_CUSTOM_WIDGET_CONFIG_KEYS)
              // Finding H1f: only the key COUNT was capped, never the key STRING —
              // and `buildAISystemPrompt.ts` echoes `Object.keys(cw.defaultConfig)`
              // verbatim into the custom-widget listing. The identical gap was
              // already closed for `richContext.fieldStats` keys above; this sibling
              // was missed. `capRequestString` only touches strings (a no-op guard,
              // since `Object.entries` keys are always strings), so the cast is safe.
              .map(([key, value]) => [capRequestString(key) as string, value]),
          ),
        }
      : {}),
  }));
}

/**
 * Cap a client-supplied `skills` array (finding H1a) before its content reaches the
 * system prompt (`buildAISystemPrompt.ts`'s `buildSkillSection`) and the advertised
 * `tools` array (`agenticLoop.ts`'s `skillToolDefs`).
 *
 * `skills` had NO cap of any kind — not entry count, not `promptFragment` length,
 * not tool `description`/`parameters` size — while being interpolated into the
 * HIGHER-TRUST system region and re-sent on every one of up to 10 turns. A single
 * `skills: [{ name: 'x', mode: 'instruction-only', promptFragment: 'A'.repeat(50e6) }]`
 * produced a 50 MB system prompt per turn, and the per-turn token budget cannot
 * help: it is checked only AFTER a turn completes (and is a documented no-op when a
 * gateway omits usage chunks).
 *
 * Note this is a SIZE cap only. It is not, and cannot be, a trust boundary — the
 * server-side lever for untrusted skill CONTENT is `options.allowedSkills`, which
 * substitutes host-authored definitions by name.
 *
 * `validateStudioAIRequestBody` has already guaranteed each element is an object
 * with a string `name` by the time this runs. Returns the input unchanged when it is
 * `undefined`; never mutates the input.
 */
export function capIncomingSkills(
  skills: SerializableSkill[] | undefined,
): SerializableSkill[] | undefined {
  if (!skills) {
    return skills;
  }
  return skills.slice(0, MAX_REQUEST_SKILLS).map((skill) => {
    const tool: unknown = (skill as { tool?: unknown }).tool;
    let cappedTool: SerializableSkill['tool'];
    if (isPlainRecord(tool)) {
      let parameters = tool.parameters;
      // A JSON Schema cannot be truncated and stay a schema, so an oversized one is
      // REPLACED with a permissive empty object schema. The tool stays callable; the
      // model just loses the (hostile-sized) argument hints.
      let serializedLength: number;
      try {
        serializedLength = JSON.stringify(parameters ?? null).length;
      } catch {
        // Cyclic/unserializable — treat as over budget; it could not be sent anyway.
        serializedLength = Number.POSITIVE_INFINITY;
      }
      if (serializedLength > MAX_SKILL_TOOL_PARAMETERS_CHARS) {
        parameters = { type: 'object', properties: {} };
      }
      cappedTool = {
        ...tool,
        name: capText(tool.name, MAX_REQUEST_STRING_LENGTH),
        description: capText(tool.description, MAX_SKILL_TOOL_DESCRIPTION_CHARS),
        parameters: (parameters ?? {}) as object,
      };
    }
    return {
      ...skill,
      name: capText(skill.name, MAX_REQUEST_STRING_LENGTH),
      mode: capText(skill.mode, MAX_REQUEST_STRING_LENGTH) as SerializableSkill['mode'],
      promptFragment: capText(skill.promptFragment, MAX_SKILL_PROMPT_FRAGMENT_CHARS),
      ...(cappedTool !== undefined ? { tool: cappedTool } : {}),
    };
  });
}

/**
 * Cap a client-supplied `pageSnapshot` (finding H1b) to
 * {@link MAX_PAGE_SNAPSHOT_CHARS}.
 *
 * Applied at the same request-handling chokepoint as the other caps, BEFORE the
 * value reaches the agentic loop — where its presence advertises `summarise_page`
 * and its content becomes that tool's output verbatim, appended to the conversation
 * and re-sent on every remaining turn.
 */
export function capIncomingPageSnapshot(pageSnapshot: string | undefined): string | undefined {
  return typeof pageSnapshot === 'string'
    ? capText(pageSnapshot, MAX_PAGE_SNAPSHOT_CHARS)
    : pageSnapshot;
}

/**
 * Encodes a `StudioAISSEEvent` as an SSE-formatted string.
 */
function encodeSSE(event: StudioAISSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * True for a non-null, non-array value whose `typeof` is `'object'`.
 *
 * Every call site below gates a field this validator expects to be a plain
 * object/record (the request body, `dashboardState`, `doc`, and `doc`'s
 * `dashboard`/`pages`/`widgets` records) — none of them are legitimately
 * array-shaped. The previous version accepted arrays too (finding 3, iteration 24),
 * which weakened e.g. the `doc.pages` guard: a crafted `dashboardState.doc.pages: []`
 * would pass this check as an "object" and only crash downstream, with an opaque
 * `TypeError`, once code that expects a `Record<string, StudioPage>` tries to look up
 * a page by id on the array. Excluding arrays here closes that gap without affecting
 * any of the (genuinely array-shaped) fields validated separately via `Array.isArray`
 * below, such as `messages` and `doc.filters`.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates the minimal shape `handleAIChat` actually dereferences downstream —
 * `body.messages` and each message's `parts` array (iterated by `toOpenAIMessages`
 * and, per tool-call message, `agenticLoop/openaiWire.ts`'s `msg.parts.flatMap`), and
 * `body.dashboardState.doc`'s `dashboard`/`pages`/`widgets`/`filters` fields (read by
 * `buildAISystemPrompt` — `filters.filter(...)` once an active page resolves — and,
 * for `snapshotPageId`, `runAgenticLoop` itself via `initialState.doc.dashboard.activePageId`).
 *
 * Without this check, a malformed body (e.g. a `dashboardState` missing `doc`, one
 * whose `doc` is missing `pages`/`widgets`/`dashboard`/`filters`, or a `messages` entry
 * shaped like an OpenAI `{ role, content }` message instead of a `ChatMessage` with
 * `parts`) only surfaces once the agentic loop dereferences the missing field, as an
 * opaque native `TypeError` ("Cannot read properties of undefined (reading
 * 'activePageId')" / "msg.parts.flatMap is not a function") — violating this project's
 * error-message convention (say what happened, why it matters, how to fix it) and
 * giving an integrator no clue which request field was wrong. Returns an actionable
 * `MUI X Studio:`-prefixed message describing the problem, or `undefined` when the body
 * is well-formed enough to proceed.
 *
 * Deliberately shallow: this only guards against the shapes that would otherwise crash
 * with a raw `TypeError`, not full schema validation of every optional field.
 *
 * Exported (finding L5) so a consumer driving `runAgenticLoop` directly — the
 * documented "build your own loop" path — can run the same request validation
 * `handleAIChat` does, instead of having no reachable input validation at all.
 *
 * @param body - The parsed request body to validate.
 * @returns An actionable `MUI X Studio:`-prefixed message, or `undefined` when the
 *   body is well-formed enough to proceed.
 */
export function validateStudioAIRequestBody(body: unknown): string | undefined {
  if (!isObject(body)) {
    return (
      'MUI X Studio: handleAIChat was called with a missing or non-object request body. ' +
      'This prevents the agentic loop from reading the conversation history and dashboard ' +
      'state it needs to run. Pass the parsed JSON request body — an object shaped like ' +
      '`{ messages, dashboardState, ... }` (see `StudioAIRequest`) — as the first argument.'
    );
  }
  if (!Array.isArray(body.messages)) {
    return (
      'MUI X Studio: The request body is missing a `messages` array (`StudioAIRequest.messages`). ' +
      'Without it there is no conversation history to send to the LLM. Ensure the client sends ' +
      '`{ messages: ChatMessage[], ... }` and that the host route forwards the parsed body as-is.'
    );
  }
  // Finding F2 (Tier 2): the client-supplied `messages` array is serialized into the
  // FIRST LLM request with no length/size cap of its own — the per-turn token/turn
  // budgets are checked only AFTER a turn completes, so nothing bounds the initial
  // request. Reject (rather than truncate, which could silently drop the user's latest
  // message) an over-count or over-size `messages` array up front.
  if (body.messages.length > MAX_REQUEST_MESSAGES) {
    return (
      `MUI X Studio: The request body has ${body.messages.length} \`messages\` entries, which ` +
      `exceeds the limit of ${MAX_REQUEST_MESSAGES} (\`StudioAIRequest.messages\`). This prevents ` +
      'the first LLM request from growing unbounded before any per-turn token/turn budget can ' +
      'apply. Trim the conversation history client-side before sending.'
    );
  }
  let messagesTotalChars = 0;
  for (let i = 0; i < body.messages.length; i += 1) {
    messagesTotalChars += JSON.stringify(body.messages[i] ?? null).length;
    if (messagesTotalChars > MAX_REQUEST_MESSAGES_TOTAL_CHARS) {
      return (
        "MUI X Studio: The request body's `messages` array exceeds the maximum total size of " +
        `${MAX_REQUEST_MESSAGES_TOTAL_CHARS} characters (\`StudioAIRequest.messages\`). This prevents ` +
        'the first LLM request from growing unbounded before any per-turn token budget can apply. ' +
        'Trim the conversation history (or oversized message parts) client-side before sending.'
      );
    }
  }
  // Each message must carry a `parts` array (finding 3b, iteration 24) — the shape
  // `toOpenAIMessages`/`agenticLoop/openaiWire.ts` actually iterate. An OpenAI-shaped
  // `{ role, content }` message (no `parts`) passes the `messages` array check above
  // but crashes `msg.parts.flatMap` the first time the loop serialises it.
  for (let i = 0; i < body.messages.length; i += 1) {
    const message: unknown = body.messages[i];
    if (!isObject(message) || !Array.isArray(message.parts)) {
      return (
        `MUI X Studio: \`messages[${i}]\` is missing a \`parts\` array (\`ChatMessage.parts\`). ` +
        "This prevents the agentic loop from reading the message's content when building the " +
        'LLM conversation. Ensure every entry in `messages` is a `ChatMessage` — e.g. ' +
        `\`{ id, role, parts: [{ type: 'text', text: '...' }] }\` — not a raw OpenAI ` +
        '`{ role, content }` chat-completion message.'
      );
    }
    // Finding 2 (Tier 3): validate each `parts` ELEMENT too, not just that `parts` is
    // an array. A malformed element (`null`, or a `dynamic-tool` part missing
    // `toolInvocation`) previously passed this shallow check and only crashed later,
    // deep in `agenticLoop/openaiWire.ts`'s `toOpenAIMessages` — `p.type` on `null`
    // (~line 52) or `p.toolInvocation.toolCallId` on `undefined` (~line 92) — as an
    // opaque native `TypeError`, defeating this validator's whole purpose.
    for (let j = 0; j < message.parts.length; j += 1) {
      const part: unknown = message.parts[j];
      if (!isObject(part) || typeof part.type !== 'string') {
        return (
          `MUI X Studio: \`messages[${i}].parts[${j}]\` is missing a string \`type\` field ` +
          '(`ChatMessage.parts[number].type`). This prevents the agentic loop from reading the ' +
          "part's content when serialising the conversation for the LLM. Ensure every part is an " +
          `object shaped like \`{ type: 'text', text: '...' }\` or \`{ type: 'dynamic-tool', ` +
          'toolInvocation: { toolCallId, toolName, input, output, state } }` — not `null` or a ' +
          'bare value.'
        );
      }
      if (part.type === 'dynamic-tool') {
        const { toolInvocation } = part as { toolInvocation?: unknown };
        if (!isObject(toolInvocation) || typeof toolInvocation.toolCallId !== 'string') {
          return (
            `MUI X Studio: \`messages[${i}].parts[${j}]\` is a \`dynamic-tool\` part missing a ` +
            'valid `toolInvocation.toolCallId` (`ChatMessage.parts[number].toolInvocation`). This ' +
            'prevents the agentic loop from matching the tool call to its result when replaying ' +
            'the conversation history to the LLM. Ensure every `dynamic-tool` part carries a ' +
            '`toolInvocation` object with at least `{ toolCallId: string, toolName, input, output, state }`.'
          );
        }
        // Finding F5 (Tier 3): `toOpenAIMessages` reads `toolInvocation.toolName` into an
        // OpenAI `function.name` — a non-string value produces a malformed OpenAI message
        // and an opaque provider 400 instead of a clean validation error. Require it to be
        // a string when present (it is optional on the wire; only its TYPE is enforced).
        if (toolInvocation.toolName !== undefined && typeof toolInvocation.toolName !== 'string') {
          return (
            `MUI X Studio: \`messages[${i}].parts[${j}]\` is a \`dynamic-tool\` part whose ` +
            '`toolInvocation.toolName` is not a string (`ChatMessage.parts[number].toolInvocation.toolName`). ' +
            'This would be serialized into a malformed OpenAI `function.name`, which the model provider ' +
            'rejects with an opaque 400 when replaying the conversation history. Ensure every ' +
            "`dynamic-tool` part's `toolName` is a string (the built-in/skill tool name it invoked)."
          );
        }
      }
    }
  }
  const { dashboardState } = body as { dashboardState?: unknown };
  if (!isObject(dashboardState) || !isObject(dashboardState.doc)) {
    return (
      'MUI X Studio: The request body is missing `dashboardState.doc` (`StudioAIRequest.dashboardState`). ' +
      'This prevents the agentic loop from resolving the active page and building the system ' +
      "prompt's dashboard-state context. Ensure the client sends the full `StudioState` snapshot " +
      '(as returned by `serializeState`/`createDefaultStudioState`) under `dashboardState`.'
    );
  }
  const { doc } = dashboardState;
  if (
    !isObject(doc.dashboard) ||
    !isObject(doc.pages) ||
    !isObject(doc.widgets) ||
    !Array.isArray(doc.filters)
  ) {
    return (
      'MUI X Studio: `dashboardState.doc` is missing one or more required `dashboard`/`pages`/`widgets`/`filters` ' +
      'fields (`StudioDoc`). This prevents the agentic loop from resolving the active page, dashboard ' +
      'layout, and active filters (`buildAISystemPrompt.ts` calls `.filter(...)` on `doc.filters` once an ' +
      'active page resolves). Ensure `dashboardState` is a complete, unmodified `StudioState` snapshot ' +
      'rather than a partial or hand-built object.'
    );
  }
  // Finding M3: the check above validates that `widgets`/`pages`/`filters` are the
  // right CONTAINER shape, but not the shape of any individual ENTRY — the exact
  // class of gap this validator exists to prevent, and the one it was already
  // closing for `runtime.dataSources` (below), `messages[]`, and `customWidgets[]`.
  // Verified raw `TypeError`s from a crafted body: `doc.widgets: { w1: null }` →
  // "Cannot read properties of null (reading 'id')" in `capIncomingDashboardState`;
  // `doc.pages: { p1: null }` → "…(reading 'widgetColSpans')"; `doc.filters: [null]`
  // → "…(reading 'field')"; `page.widgetRows: 'abc'` → ".map is not a function". All
  // surfaced as opaque, unprefixed `TypeError` text in an SSE `error` frame — a
  // per-request denial of service that also violates this project's error-message
  // convention.
  for (const [widgetId, widget] of Object.entries(doc.widgets)) {
    if (!isObject(widget)) {
      return (
        `MUI X Studio: \`dashboardState.doc.widgets[${JSON.stringify(widgetId)}]\` is not an ` +
        'object (`StudioWidget`). This prevents the agentic loop from reading the widget when ' +
        "capping the incoming state and building the system prompt's `<dashboard_state>` block. " +
        'Ensure every entry in `doc.widgets` is a complete `StudioWidget` — e.g. ' +
        '`{ id, kind, title, config }` — not `null` or a bare value.'
      );
    }
  }
  for (const [pageId, page] of Object.entries(doc.pages)) {
    if (!isObject(page)) {
      return (
        `MUI X Studio: \`dashboardState.doc.pages[${JSON.stringify(pageId)}]\` is not an object ` +
        '(`StudioPage`). This prevents the agentic loop from resolving the page layout when ' +
        'capping the incoming state and building the system prompt. Ensure every entry in ' +
        '`doc.pages` is a complete `StudioPage` — e.g. `{ id, title, widgetRows }` — not `null` ' +
        'or a bare value.'
      );
    }
    const { widgetRows } = page as { widgetRows?: unknown };
    if (
      widgetRows !== undefined &&
      (!Array.isArray(widgetRows) || !widgetRows.every((row) => Array.isArray(row)))
    ) {
      return (
        `MUI X Studio: \`dashboardState.doc.pages[${JSON.stringify(pageId)}].widgetRows\` must be ` +
        'an array of arrays of widget-id strings (`StudioPage.widgetRows`). This prevents a crash ' +
        'while capping the layout and rendering the `## Layout` section of the system prompt ' +
        '(`row.slice(...)` on a non-array row). Omit `widgetRows` for an empty page, or pass e.g. ' +
        "`[['widget-1', 'widget-2'], ['widget-3']]`."
      );
    }
  }
  for (let i = 0; i < doc.filters.length; i += 1) {
    if (!isObject(doc.filters[i])) {
      return (
        `MUI X Studio: \`dashboardState.doc.filters[${i}]\` is not an object ` +
        '(`StudioFilterState`). This prevents the agentic loop from reading the filter when ' +
        "capping the incoming state and rendering the system prompt's active-filter list. Ensure " +
        'every entry in `doc.filters` is a complete `StudioFilterState` — e.g. ' +
        '`{ id, scope, field, operator, value }` — not `null` or a bare value.'
      );
    }
  }
  // Finding F2 (Tier 3): `doc` is not the only partition dereferenced downstream —
  // `buildAISystemPrompt`'s `buildDashboardState` destructures `state.session.mode`
  // and `state.runtime.dataSources`, and `executeToolOnState.ts`'s
  // `projectStateForAI` does `Object.entries(state.runtime.dataSources)`. A body that
  // supplies a valid `doc` but omits `session`/`runtime` previously passed this
  // validator and only crashed once the first prompt was built, as an opaque native
  // `TypeError`. `mode` itself is left unchecked (every read site tolerates it being
  // absent/wrong), but `session` and `runtime.dataSources` must be objects for those
  // destructures/`Object.entries` calls to succeed.
  if (
    !isObject(dashboardState.session) ||
    !isObject(dashboardState.runtime) ||
    !isObject(dashboardState.runtime.dataSources)
  ) {
    return (
      'MUI X Studio: `dashboardState` is missing its `session` and/or `runtime.dataSources` fields ' +
      '(`StudioState`). This prevents the agentic loop from building the dashboard-state context — ' +
      '`buildAISystemPrompt.ts` reads `state.session.mode` and `state.runtime.dataSources`, and ' +
      '`executeToolOnState.ts` iterates `state.runtime.dataSources`. Ensure `dashboardState` is a ' +
      'complete, unmodified `StudioState` snapshot (all three of `doc`/`session`/`runtime`) rather ' +
      'than a partial or hand-built object.'
    );
  }
  // Tier 3 crash-resilience gap (companion to the Tier 1 `runtime.dataSources`
  // resource-exhaustion cap in `capIncomingDashboardState`): the check above only
  // validates that `runtime.dataSources` itself is a map, not the shape of any
  // individual entry. `describeSource` (`buildAISystemPrompt.ts`) does
  // `source.fields.filter(...)` unconditionally, so a `dataSources[id]` entry with
  // a missing/non-array `fields` throws an unprefixed native `TypeError` the first
  // time the system prompt is built — currently masked by the outer `try`/`catch`
  // in `handleAIChat`'s `start()`, which reports it as a generic error rather than
  // this codebase's actionable `MUI X Studio:`-prefixed message. Validate each
  // entry has at least a string `id`/`label` and an array `fields`, mirroring how
  // `doc.pages`/`doc.widgets`/`doc.filters`/`messages[].parts` are validated above.
  for (const [sourceId, source] of Object.entries(dashboardState.runtime.dataSources)) {
    if (
      !isObject(source) ||
      typeof source.id !== 'string' ||
      typeof source.label !== 'string' ||
      !Array.isArray(source.fields)
    ) {
      return (
        `MUI X Studio: \`dashboardState.runtime.dataSources[${JSON.stringify(sourceId)}]\` is ` +
        'missing a string `id`, a string `label`, and/or an array `fields` (`StudioDataSource`). ' +
        "This prevents `buildAISystemPrompt.ts`'s `describeSource` from reading the source's field " +
        'list when building the system prompt. Ensure every entry in `dashboardState.runtime.' +
        'dataSources` is a complete `StudioDataSource` — e.g. ' +
        '`{ id, label, fields: StudioDataField[], ... }` — not a partial or hand-built object.'
      );
    }
    // Finding M3: the check above validates that `fields` is an array, not that its
    // ENTRIES are objects — a `fields: [null]` threw a raw `TypeError` reading
    // `field.label` in `capDataSourceField`.
    for (let i = 0; i < source.fields.length; i += 1) {
      if (!isObject(source.fields[i])) {
        return (
          `MUI X Studio: \`dashboardState.runtime.dataSources[${JSON.stringify(sourceId)}].fields[${i}]\` ` +
          'is not an object (`StudioDataField`). This prevents the agentic loop from reading the ' +
          "field when capping the incoming state and rendering the system prompt's data-source " +
          "list. Ensure every entry in a source's `fields` is a `StudioDataField` — e.g. " +
          '`{ id, type, label }` — not `null` or a bare value.'
        );
      }
    }
  }
  // Finding F2 (Tier 3), related smaller gap: a non-array `allowedTools` reaches
  // `agenticLoop.ts`'s `(allowedTools as string[]).includes(...)` — on a string body
  // this silently degrades to SUBSTRING matching rather than array membership
  // (client-asserted so no privilege is widened, but the behavior is silently wrong
  // instead of erroring). Validate array-of-strings shape up front instead.
  const { allowedTools } = body as { allowedTools?: unknown };
  if (
    allowedTools !== undefined &&
    (!Array.isArray(allowedTools) || !allowedTools.every((t) => typeof t === 'string'))
  ) {
    return (
      'MUI X Studio: `allowedTools` must be an array of tool-name strings ' +
      '(`StudioAIRequest.allowedTools`) when provided. This prevents it from being misread as a ' +
      'single string (downstream `.includes(...)` checks would silently treat that as a substring ' +
      'match instead of an exact tool-name match). Omit `allowedTools` to allow all tools, or pass ' +
      "e.g. `['add_widget', 'remove_widget']`."
    );
  }
  // Finding F2 (Tier 3), related smaller gap: a non-array `customWidgets` throws
  // inside `buildWidgetFromArgs` the first time a widget-creating tool call reads it.
  const { customWidgets } = body as { customWidgets?: unknown };
  if (customWidgets !== undefined && !Array.isArray(customWidgets)) {
    return (
      'MUI X Studio: `customWidgets` must be an array (`StudioAIRequest.customWidgets[]`) when ' +
      'provided. This prevents a crash inside `buildWidgetFromArgs` the first time a widget-creating ' +
      'tool call reads it. Omit `customWidgets` if there are none, or pass an array of ' +
      '`StudioCustomWidgetDef` objects.'
    );
  }
  // Finding F4 (Tier 3): the array check above does NOT validate element shapes — a
  // `customWidgets: [null]` (or an element with no string `kind`) throws a raw
  // `TypeError` deeper in `buildAISystemPrompt.ts`'s widget-listing loop and
  // `buildWidgetFromArgs`, currently swallowed by outer try/catches rather than
  // surfacing as the actionable `MUI X Studio:`-prefixed message every other malformed
  // field gets. Validate each element is a plain object with a string `kind`.
  if (Array.isArray(customWidgets)) {
    for (let i = 0; i < customWidgets.length; i += 1) {
      const cw: unknown = customWidgets[i];
      if (!isObject(cw) || typeof (cw as { kind?: unknown }).kind !== 'string') {
        return (
          `MUI X Studio: \`customWidgets[${i}]\` must be an object with a string \`kind\` field ` +
          '(`StudioAIRequest.customWidgets[number]` / `StudioCustomWidgetDef`). This prevents a crash ' +
          "inside `buildAISystemPrompt.ts`'s widget-listing loop and `buildWidgetFromArgs` when a " +
          'malformed element (e.g. `null` or one without a `kind`) is read. Ensure every custom ' +
          'widget is shaped like `{ kind: string, ... }`.'
        );
      }
    }
  }
  // Finding F1 (Tier 2): `handleAIChat` previously computed `effectiveSkills` from
  // `body.skills` BEFORE this validator ran, so a malformed `skills` (a truthy
  // non-array, or an array containing a `null`/non-object/nameless entry) threw a
  // synchronous `TypeError` out of `handleAIChat` itself — before the `ReadableStream`
  // was even constructed — violating the "always returns a stream, never throws"
  // contract documented in ARCHITECTURE.md. Without `options.allowedSkills`
  // configured, the same malformed value instead reached `agenticLoop.ts`'s
  // `(skills ?? []).filter` and surfaced as an opaque `TypeError` SSE error.
  // Validating the shape here lets both cases surface as one clean, actionable SSE
  // error frame instead.
  const { skills } = body as { skills?: unknown };
  if (
    skills !== undefined &&
    (!Array.isArray(skills) ||
      !skills.every((s) => isObject(s) && typeof (s as { name?: unknown }).name === 'string'))
  ) {
    return (
      'MUI X Studio: `skills` must be an array of skill objects, each with a string `name` ' +
      '(`StudioAIRequest.skills` / `SerializableSkill[]`), when provided. This prevents a crash while ' +
      'filtering skills against the server allow-list/built-in tool names (`handleAIChat.ts`/' +
      '`agenticLoop.ts` both call array methods on this value assuming that shape). Omit `skills` if ' +
      'there are none, or pass an array of `SerializableSkill` objects (each shaped like ' +
      '`{ name, mode, promptFragment, tool? }`).'
    );
  }
  // Finding F6 (Tier 3): a truthy non-string `pageSnapshot` both enables the
  // `summarise_page` tool advertisement and is returned VERBATIM as that tool's output
  // (`agenticLoop.ts`/`executeToolOnState.ts`). A non-string value therefore lands as
  // non-string `content` in the next OpenAI turn message, which the provider rejects
  // with an opaque 400. Require it, when present, to be a string so the failure is a
  // clean, actionable SSE error frame instead.
  const { pageSnapshot } = body as { pageSnapshot?: unknown };
  if (pageSnapshot !== undefined && typeof pageSnapshot !== 'string') {
    return (
      'MUI X Studio: `pageSnapshot` must be a string (`StudioAIRequest.pageSnapshot`) when provided. ' +
      'This prevents a non-string value from being advertised via the `summarise_page` tool and then ' +
      'echoed verbatim as non-string message `content`, which the model provider rejects with an ' +
      'opaque 400. Omit `pageSnapshot` if there is none, or pass a plain-text snapshot string.'
    );
  }
  return undefined;
}

/**
 * Handle an AI chat request from a Studio dashboard.
 *
 * @param body - Parsed `StudioAIRequest` (user messages + dashboard state).
 * @param options - Server-side connection options (endpoint, API key, model).
 * @returns A `ReadableStream<string>` of Server-Sent Events.
 */
export function handleAIChat(
  body: StudioAIRequest,
  options: StudioAIHandlerOptions,
): ReadableStream<string> {
  const {
    messages,
    dashboardState,
    customWidgets,
    focusedWidgetId,
    allowedTools: bodyAllowedTools,
    skills,
    privateMode: bodyPrivateMode,
    pageSnapshot,
    richContext,
  } = body ?? ({} as StudioAIRequest);

  // Internal abort controller so consumer-side stream cancellation (`reader.cancel()`)
  // actually propagates into the agentic loop. It is also linked to any external
  // `options.signal` so a host-wired abort still stops the loop.
  const abortController = new AbortController();
  // Tracked so it can be explicitly removed once this request's stream finishes —
  // `{ once: true }` alone only unregisters the listener once `options.signal`
  // actually FIRES. A host that reuses one long-lived `AbortSignal` across many
  // `handleAIChat` calls (e.g. a single process-lifetime signal) would otherwise
  // accumulate one listener per request that never fires and is never cleaned up:
  // a slow listener leak. `cleanupExternalAbortListener` (called from both the
  // `finally` below and `cancel()`) removes it unconditionally once this request
  // is done, whether or not `options.signal` ever aborted.
  let onExternalAbort: (() => void) | undefined;
  if (options.signal) {
    if (options.signal.aborted) {
      abortController.abort();
    } else {
      onExternalAbort = () => abortController.abort();
      options.signal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }
  const cleanupExternalAbortListener = () => {
    if (options.signal && onExternalAbort) {
      options.signal.removeEventListener('abort', onExternalAbort);
      onExternalAbort = undefined;
    }
  };

  // ── Backpressure (finding L2) ───────────────────────────────────────────────
  //
  // Events are PUSHED from `start()`, so nothing throttled the producer: a client
  // that stops reading (a backgrounded tab, a dead TCP peer that hasn't reset yet)
  // accumulated the whole response in the stream's internal queue — bounded only by
  // `MAX_TURN_TEXT_BUFFER_CHARS` × turns plus every tool result.
  //
  // This waits on `controller.desiredSize` (which rises the moment the consumer
  // dequeues a chunk) rather than on the `pull()` callback: per the Streams spec
  // `pull` is not invoked until `start()`'s promise settles, and `start()` here runs
  // for the whole request — so a `pull`-based wait would deadlock immediately.
  const waitForDrain = async (
    controller: ReadableStreamDefaultController<string>,
  ): Promise<void> => {
    // `desiredSize` is `null` for an errored stream (nothing to wait for) and `<= 0`
    // once the queue is full.
    while (
      !abortController.signal.aborted &&
      controller.desiredSize !== null &&
      controller.desiredSize <= 0
    ) {
      // eslint-disable-next-line no-await-in-loop -- waiting for the consumer to drain
      await new Promise<void>((resolve) => {
        setTimeout(resolve, SSE_DRAIN_POLL_MS);
      });
    }
  };

  return new ReadableStream<string>(
    {
      async start(controller) {
        try {
          // Validate the request body shape BEFORE any downstream use (finding: a
          // malformed `dashboardState` previously only surfaced once the agentic loop
          // dereferenced a missing field, as an opaque native `TypeError`). Checked here,
          // inside the existing error-surfacing path, rather than thrown synchronously out
          // of `handleAIChat` itself, so this keeps the same "always returns a stream, never
          // throws" contract as every other failure mode below (transport errors, rate
          // limits, aborts) and the host gets one uniform `{ type: 'error' }` frame to handle.
          const validationError = validateStudioAIRequestBody(body);
          if (validationError) {
            controller.enqueue(encodeSSE({ type: 'error', message: validationError }));
            return;
          }

          // Finding F2 (Tier 2): cap the client-supplied `dashboardState` BEFORE it is used
          // anywhere — for context enrichment or interpolated into the system prompt via the
          // agentic loop. The per-tool `cap*` helpers only run when an AI tool MUTATES state,
          // so without this the very first request's titles/filter values/widget counts reach
          // `<dashboard_state>` completely unbounded (see `capIncomingDashboardState`). The
          // validator above has already guaranteed the `doc`/`session`/`runtime` shape this
          // relies on. This capped snapshot is what the loop threads forward as its starting
          // `currentState`, so subsequent mutations build on the bounded state too.
          const cappedDashboardState = capIncomingDashboardState(dashboardState);

          // Tier 1 resource-exhaustion finding, sibling gap to the above: `richContext`
          // and `customWidgets` are ALSO client-supplied and interpolated into the very
          // first system prompt (`buildAISystemPrompt.ts`'s `buildRichContextBlock` and
          // its custom-widget listing loop) with only `sanitizeForPrompt`'s angle-bracket
          // escaping — no count/length bound of its own. Capped here, at the same
          // request-handling chokepoint as `cappedDashboardState` above, BEFORE either
          // reaches the context enricher or the agentic loop.
          const cappedRichContext = capIncomingRichContext(richContext);
          const cappedCustomWidgets = capIncomingCustomWidgets(customWidgets);
          // Finding H1a/H1b/H1g — the three remaining client-supplied prompt inputs
          // that reached the system prompt (and, for `pageSnapshot`, the conversation
          // itself) with no size bound at all. Capped at the SAME chokepoint as the
          // three above so there is one place to look for "what bounds request input".
          const cappedSkills = capIncomingSkills(skills);
          const cappedPageSnapshot = capIncomingPageSnapshot(pageSnapshot);
          // `focusedWidgetId` is echoed VERBATIM into the `## Per-widget focus` block
          // (`buildAISystemPrompt.ts`) whenever it names a real widget — and it is a
          // widget MAP KEY, which `capIncomingDashboardState` bounds but which is a
          // separate string from the `widget.id` field that was already capped.
          const cappedFocusedWidgetId =
            typeof focusedWidgetId === 'string'
              ? capText(focusedWidgetId, MAX_REQUEST_STRING_LENGTH)
              : focusedWidgetId;

          // Server-side allowlist / private-mode enforcement (invariant 10: the client
          // asserts these in the body; a host that needs a hard guarantee overrides them
          // here). The effective tool set is the INTERSECTION of the server allowlist and
          // the body's — a body omitting `allowedTools` allows all, so intersecting yields
          // the server list. Effective private mode is `server || body`: the client may opt
          // in but never out of a server-mandated private mode. When both server options are
          // omitted, both values are bit-identical to the raw body values (current behavior).
          //
          // Finding F1 (Tier 2): computed HERE, after `validateStudioAIRequestBody` has
          // already rejected a malformed `body.allowedTools` (a truthy non-array, whose
          // `.includes(...)` is undefined) and INSIDE `start()` — not at the top of
          // `handleAIChat` as before. Previously the intersection ran before validation and
          // before the stream existed, so a truthy non-array `body.allowedTools` threw a
          // synchronous `TypeError` straight out of `handleAIChat`, violating its "always
          // returns a stream, never throws" contract (the same bug class the `effectiveSkills`
          // relocation fixed). Now a malformed value is always caught by validation first and
          // surfaces as a normal `{ type: 'error' }` SSE frame.
          let effectiveAllowedTools: string[] | undefined;
          if (!options.allowedTools) {
            // No server allowlist — trust the body's list (or its absence = all tools).
            effectiveAllowedTools = bodyAllowedTools;
          } else if (bodyAllowedTools) {
            // Both present — intersect (server can only ever narrow the client's list).
            effectiveAllowedTools = options.allowedTools.filter((t) =>
              bodyAllowedTools.includes(t),
            );
          } else {
            // Body omits its list (allows all) — the server list is the effective set.
            effectiveAllowedTools = options.allowedTools;
          }
          const effectivePrivateMode = Boolean(options.privateMode || bodyPrivateMode);

          // Server-side skill allow-list enforcement (finding 2.1, hardened for T1-1).
          // A client-asserted `body.skills` entry's `promptFragment` (and, for
          // `server-tool` mode, its tool `description`/`parameters`) lands in the
          // higher-trust system region. Filtering by `name` alone is NOT sufficient —
          // a body can assert an allowlisted `name` paired with its own hostile
          // `promptFragment`, and the name check alone would let that fragment through
          // unchanged. So when the host supplies `allowedSkills`, a body skill's
          // `name` is used only to SELECT a definition — never to admit the body's own
          // content: each allowlisted name is looked up in `options.skillHandlers`
          // (the same host-registered registry the agentic loop uses to execute
          // `server-tool` skills) and that server-authored definition is what's
          // actually used. A name with no matching `skillHandlers` entry is dropped
          // rather than falling back to the body's (unvetted) object. Omitting
          // `allowedSkills` preserves the current behavior (`body.skills` trusted
          // as-is, content included).
          //
          // Finding F1 (Tier 2): computed HERE, after `validateStudioAIRequestBody`
          // has already rejected a malformed `body.skills` (truthy non-array, or an
          // array with a non-object/nameless entry) and INSIDE `start()` (i.e. after
          // the `ReadableStream` is already under construction) — not at the top of
          // `handleAIChat` as before. Previously this ran before validation and before
          // the stream existed, so a malformed `skills` threw a synchronous `TypeError`
          // straight out of `handleAIChat`, violating its "always returns a stream,
          // never throws" contract. Now a malformed value is always caught by
          // validation first and surfaces as a normal `{ type: 'error' }` SSE frame.
          //
          // Note the two branches differ in WHERE the content comes from, and only the
          // pass-through branch needs the size cap: with `allowedSkills` configured the
          // body's object is discarded entirely in favour of the host-authored
          // `skillHandlers` entry, so `cappedSkills` (finding H1a) applies to the
          // trusted-as-is branch.
          const effectiveSkills = options.allowedSkills
            ? (skills ?? [])
                .filter((s) => options.allowedSkills!.includes(s.name))
                .map((s) => options.skillHandlers?.find((h) => h.name === s.name))
                .filter((s): s is StudioAISkill => Boolean(s))
            : cappedSkills;

          // Best-effort server-side context enrichment. Failures never abort the chat.
          // Bounded by `CONTEXT_ENRICHER_TIMEOUT_MS` (finding T2-2) — without this, a
          // hung `contextEnricher` (e.g. a stalled DB query) would block this `await`
          // indefinitely, stalling the entire SSE stream before the first LLM call is
          // even made. A timeout degrades the same way a thrown error already does:
          // logged via `onToolError` and the chat proceeds without enrichment.
          let enrichedContext: StudioAIEnrichedContext | undefined;
          if (options.contextEnricher && !effectivePrivateMode) {
            try {
              enrichedContext = await withTimeout(
                Promise.resolve(
                  options.contextEnricher({
                    dashboardState: cappedDashboardState,
                    richContext: cappedRichContext,
                    signal: abortController.signal,
                  }),
                ),
                CONTEXT_ENRICHER_TIMEOUT_MS,
                'contextEnricher',
              );
            } catch (err) {
              options.onToolError?.(
                'contextEnricher',
                err instanceof Error ? err : new Error(String(err)),
              );
            }
          }

          const loop = runAgenticLoop(
            messages,
            cappedDashboardState,
            cappedCustomWidgets,
            cappedFocusedWidgetId,
            effectiveAllowedTools,
            effectiveSkills,
            {
              endpoint: options.endpoint,
              apiKey: options.apiKey,
              model: options.model,
              headers: options.headers,
              signal: abortController.signal,
              onToolError: options.onToolError,
              skillHandlers: options.skillHandlers,
              data: options.data,
              privateMode: effectivePrivateMode,
              rateLimit: options.rateLimit,
              toolPolicy: options.toolPolicy,
              approvalPending: options.approvalPending,
              approvalFallback: options.approvalFallback,
              approvalTimeoutMs: options.approvalTimeoutMs,
              pageSnapshot: cappedPageSnapshot,
              richContext: cappedRichContext,
              enrichedContext,
            },
          );

          for await (const event of loop) {
            // Finding L2 — respect backpressure. Events are pushed from `start()`, so
            // without this a client that stops reading (a paused/backgrounded tab, a
            // dead TCP peer that hasn't reset yet) accumulates the ENTIRE response in
            // the stream's internal queue, bounded only by `MAX_TURN_TEXT_BUFFER_CHARS`
            // × turns plus every tool result. Waiting while `desiredSize` is
            // exhausted makes the producer run at the consumer's pace.
            // eslint-disable-next-line no-await-in-loop -- backpressure is inherently sequential
            await waitForDrain(controller);
            controller.enqueue(encodeSSE(event));
            if (event.type === 'finish' || event.type === 'error') {
              break;
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // Guard the enqueue: if the stream was already cancelled/closed (e.g. the
          // consumer called `reader.cancel()`), enqueueing throws — swallow it so the
          // error path itself doesn't blow up.
          try {
            controller.enqueue(encodeSSE({ type: 'error', message }));
          } catch {
            // Stream already cancelled/closed — nothing to surface the error to.
          }
        } finally {
          cleanupExternalAbortListener();
          // Finding M5 — abort the request's own controller. This is what actually
          // stops any still-in-flight LLM `fetch` (and releases its socket) once the
          // stream is done: `withTimeout` alone only makes the loop stop WAITING, so a
          // turn that timed out at `LLM_FETCH_TIMEOUT_MS` previously left the upstream
          // completion running to completion — fully billed, body never read.
          abortController.abort();
          try {
            controller.close();
          } catch {
            // Stream already closed/cancelled.
          }
        }
      },
      cancel() {
        // Consumer stopped reading — propagate cancellation into the loop. A producer
        // parked in `waitForDrain` observes this abort and stops waiting.
        cleanupExternalAbortListener();
        abortController.abort();
      },
    },
    // Finding L2 — an explicit queuing strategy. The default (`highWaterMark: 1`)
    // would park the producer after literally every event, adding a
    // microtask-scheduling round-trip per SSE frame to an otherwise-healthy stream.
    // A small buffer keeps normal streaming smooth while still bounding what a
    // non-reading consumer can accumulate. Chunk-COUNT based (no `size`), which is
    // the default for a non-byte stream.
    { highWaterMark: SSE_QUEUE_HIGH_WATER_MARK },
  );
}
