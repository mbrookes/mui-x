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
import type { StudioAIRequest, StudioAISSEEvent } from './models/protocol';
import type {
  StudioAISkill,
  StudioDataResolver,
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
   * App-provided data resolver for the `execute_query` AI tool.
   *
   * When set, the model can call `execute_query` to run ad-hoc queries against
   * the connected data sources. The resolver receives the SQL string (and an
   * optional `sourceId`) and must return the rows.
   *
   * @example
   * ```ts
   * const stream = handleAIChat(body, {
   *   endpoint: process.env.OPENAI_ENDPOINT,
   *   apiKey: process.env.OPENAI_API_KEY,
   *   dataResolver: {
   *     async resolve(query, sourceId) {
   *       const rows = await db.query(query);
   *       return { rows };
   *     },
   *   },
   * });
   * ```
   */
  dataResolver?: StudioDataResolver;
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
   * @example
   * ```ts
   * // Shared state (module-level in your route file)
   * const pendingApprovals = new Map<string, (approved: boolean, reason?: string) => void>();
   *
   * // Chat route — pass the map to handleAIChat
   * app.post('/api/ai/chat', (req, res) => {
   *   const stream = handleAIChat(req.body, { ..., approvalPending: pendingApprovals });
   *   // ... stream to response
   * });
   *
   * // Approval route — resolve the pending approval
   * app.post('/api/ai/approval', (req, res) => {
   *   const { id, approved, reason } = req.body;
   *   const resolve = pendingApprovals.get(id);
   *   if (resolve) { resolve(approved, reason); pendingApprovals.delete(id); }
   *   res.json({ ok: true });
   * });
   * ```
   */
  approvalPending?: Map<string, (approved: boolean, reason?: string) => void>;
  /**
   * Optional hook to attach DB-side metadata to the AI context.
   *
   * Called once per request, before the agentic loop starts. Use it to enrich
   * the system prompt with information that only the server has — e.g. exact row
   * counts per dimension value, or schema comments from the database catalog.
   * The returned `StudioAIEnrichedContext` is rendered into a `<server_context>`
   * block in the system prompt (omitted in `privateMode`).
   *
   * Enrichment is best-effort: if the callback throws, the error is reported via
   * `onToolError('contextEnricher', err)` and the chat proceeds without it.
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
}

/**
 * Encodes a `StudioAISSEEvent` as an SSE-formatted string.
 */
function encodeSSE(event: StudioAISSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
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
    allowedTools,
    skills,
    privateMode,
    pageSnapshot,
    richContext,
  } = body;

  return new ReadableStream<string>({
    async start(controller) {
      try {
        // Best-effort server-side context enrichment. Failures never abort the chat.
        let enrichedContext: StudioAIEnrichedContext | undefined;
        if (options.contextEnricher && !privateMode) {
          try {
            enrichedContext = await options.contextEnricher({
              dashboardState,
              richContext,
              signal: options.signal,
            });
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
          allowedTools,
          skills,
          {
            endpoint: options.endpoint,
            apiKey: options.apiKey,
            model: options.model,
            headers: options.headers,
            signal: options.signal,
            onToolError: options.onToolError,
            skillHandlers: options.skillHandlers,
            dataResolver: options.dataResolver,
            privateMode,
            rateLimit: options.rateLimit,
            approvalPending: options.approvalPending,
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
        controller.enqueue(encodeSSE({ type: 'error', message }));
      } finally {
        controller.close();
      }
    },
  });
}
