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
import type { StudioAIRequest, StudioAISSEEvent } from './models/protocol';
import type {
  StudioAISkill,
  StudioAIDataConfig,
  StudioAIRateLimit,
  StudioAIRichContext,
  StudioAIEnrichedContext,
} from './models/aiTypes';
import type { StudioState } from './models/studioTypes';

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
   * your approval UI — omit it and the check is simply skipped.
   *
   * @example
   * ```ts
   * import type { PendingApproval } from '@mui/x-studio-ai-middleware';
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
   * // auth (mirroring the chat route's auth) AND, when both sides have one, a
   * // matching thread id.
   * app.post('/api/ai/approval', (req, res) => {
   *   const claims = resolveClaims(req); // same auth check as /chat
   *   const { id, approved, reason, threadId } = req.body;
   *   const entry = pendingApprovals.get(id);
   *   if (!entry) return res.status(404).json({ error: `No pending approval for id: ${id}` });
   *   if (entry.threadId !== undefined && threadId !== undefined && entry.threadId !== threadId) {
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
 */
function validateStudioAIRequestBody(body: unknown): string | undefined {
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

  // Server-side allowlist / private-mode enforcement (invariant 10: the client
  // asserts these in the body; a host that needs a hard guarantee overrides them
  // here). The effective tool set is the INTERSECTION of the server allowlist and
  // the body's — a body omitting `allowedTools` allows all, so intersecting yields
  // the server list. Effective private mode is `server || body`: the client may opt
  // in but never out of a server-mandated private mode. When both server options are
  // omitted, both values are bit-identical to the raw body values (current behavior).
  let effectiveAllowedTools: string[] | undefined;
  if (!options.allowedTools) {
    // No server allowlist — trust the body's list (or its absence = all tools).
    effectiveAllowedTools = bodyAllowedTools;
  } else if (bodyAllowedTools) {
    // Both present — intersect (server can only ever narrow the client's list).
    effectiveAllowedTools = options.allowedTools.filter((t) => bodyAllowedTools.includes(t));
  } else {
    // Body omits its list (allows all) — the server list is the effective set.
    effectiveAllowedTools = options.allowedTools;
  }
  const effectivePrivateMode = Boolean(options.privateMode || bodyPrivateMode);

  // Server-side skill allow-list enforcement (finding 2.1, hardened for T1-1). A
  // client-asserted `body.skills` entry's `promptFragment` (and, for `server-tool`
  // mode, its tool `description`/`parameters`) lands in the higher-trust system
  // region. Filtering by `name` alone is NOT sufficient — a body can assert an
  // allowlisted `name` paired with its own hostile `promptFragment`, and the name
  // check alone would let that fragment through unchanged. So when the host supplies
  // `allowedSkills`, a body skill's `name` is used only to SELECT a definition —
  // never to admit the body's own content: each allowlisted name is looked up in
  // `options.skillHandlers` (the same host-registered registry the agentic loop uses
  // to execute `server-tool` skills) and that server-authored definition is what's
  // actually used. A name with no matching `skillHandlers` entry is dropped rather
  // than falling back to the body's (unvetted) object. Omitting `allowedSkills`
  // preserves the current behavior (`body.skills` trusted as-is, content included).
  const effectiveSkills = options.allowedSkills
    ? (skills ?? [])
        .filter((s) => options.allowedSkills!.includes(s.name))
        .map((s) => options.skillHandlers?.find((h) => h.name === s.name))
        .filter((s): s is StudioAISkill => Boolean(s))
    : skills;

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

  return new ReadableStream<string>({
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
                  dashboardState,
                  richContext,
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
          dashboardState,
          customWidgets,
          focusedWidgetId,
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
            pageSnapshot,
            richContext,
            enrichedContext,
          },
        );

        for await (const event of loop) {
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
        try {
          controller.close();
        } catch {
          // Stream already closed/cancelled.
        }
      }
    },
    cancel() {
      // Consumer stopped reading — propagate cancellation into the loop.
      cleanupExternalAbortListener();
      abortController.abort();
    },
  });
}
