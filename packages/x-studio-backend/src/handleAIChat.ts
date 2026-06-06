/**
 * `handleAIChat` — the core pure function of x-studio-backend.
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
 * import { handleAIChat } from '@mui/x-studio-backend';
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
 * import { handleAIChat } from '@mui/x-studio-backend';
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
   */
  onToolError?: (toolName: string, error: Error) => void;
  /**
   * Optional `AbortSignal` for request cancellation.
   */
  signal?: AbortSignal;
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
  const { messages, dashboardState, customWidgets, focusedWidgetId, allowedTools, skills } = body;

  return new ReadableStream<string>({
    async start(controller) {
      try {
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
