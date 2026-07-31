/**
 * End-to-end seam tests for `packages/x-studio` ⇄ `packages/x-studio-ai-middleware`.
 *
 * Neither package imports the other, so every defect that lives BETWEEN them — a
 * request field one side omits and the other requires, an SSE field the producer
 * emits and the consumer drops, a value that survives the wire but is mangled on
 * replay — is invisible to both unit suites by construction. (Proof: renaming the
 * server's `state-mutation` event type fails 18 middleware tests and ZERO x-studio
 * tests.)
 *
 * These tests close that hole by wiring the real pipeline end to end:
 *
 * ```
 * fake OpenAI gateway
 *   → handleAIChat()                        (real middleware, real agentic loop)
 *   → real SSE bytes over a stubbed fetch
 *   → createBackendChatAdapter()            (real client adapter)
 *   → processStream()                       (real x-chat-headless stream processor)
 *   → ChatMessage
 *   → toOpenAIMessages()                    (real middleware replay serialiser)
 * ```
 *
 * Nothing between those layers is mocked: the only fakes are the LLM gateway at
 * the far end and the HTTP transport in the middle (a stubbed `fetch` that hands
 * the server's own `ReadableStream` to the client's own SSE parser).
 *
 * The middleware is reached through the workspace's `@mui/x-studio-ai-middleware`
 * source alias rather than a package dependency: `@mui/x-studio` does not (and must
 * not) depend on it, since the whole point of the protocol is that the two ship
 * independently. The coupling exists only in this test file.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { ChatMessage, ChatMessageChunk } from '@mui/x-chat/headless';
import { ChatStore } from '@mui/x-chat-headless/store';
import { processStream } from '@mui/x-chat-headless/stream';
import {
  handleAIChat,
  isApprovalThreadIdAuthorized,
  type OpenAIMessage,
  type StudioAIHandlerOptions,
  type PendingApproval,
} from '@mui/x-studio-ai-middleware';
import { createBackendChatAdapter, type StudioAIConfig } from './studioBackendAdapter';
import { StudioController } from '../../store/StudioController';
import type { CreateDefaultStudioStateOverrides } from '../../models';

// ── Fake OpenAI gateway ───────────────────────────────────────────────────────

const LLM_ENDPOINT = 'https://llm.test/v1/chat/completions';
const AI_ENDPOINT = 'https://backend.test/api/ai';

interface OpenAIRequest {
  model?: string;
  messages: OpenAIMessage[];
  tools?: Array<{ function: { name: string } }>;
}

function sseResponse(chunks: unknown[]): Response {
  const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

/** A completion that just answers with text. */
function textTurn(text: string): Response {
  return sseResponse([
    { choices: [{ delta: { content: text }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } },
  ]);
}

// ── The seam harness ──────────────────────────────────────────────────────────

interface SeamOptions {
  /** Scripted gateway completions, one per agentic turn. */
  turns: Response[];
  /** Client-side `StudioAIConfig` (endpoint is filled in). */
  config?: Omit<StudioAIConfig, 'endpoint'>;
  /** Server-side handler options (endpoint/model are filled in). */
  handlerOptions?: Partial<StudioAIHandlerOptions>;
  /** Initial dashboard state for the client's controller. */
  state?: CreateDefaultStudioStateOverrides;
  /** Conversation the client sends. */
  messages?: ChatMessage[];
  /**
   * Auto-responder for the `/approval` endpoint, run when the client POSTs an
   * approval decision. Returns what the reference route (`examples/
   * x-studio-dev-server/src/routes/ai.ts`) would answer.
   */
  onApprovalRequest?: (event: Record<string, unknown>) => { approved: boolean; reason?: string };
}

interface SeamResult {
  /** Every request body the fake gateway received, in order. */
  llmRequests: OpenAIRequest[];
  /** Raw request body the client POSTed to `/chat`. */
  chatRequestBody: Record<string, unknown>;
  /** Every `StudioAISSEEvent` the server actually put on the wire. */
  serverEvents: Record<string, unknown>[];
  /** Every `ChatMessageChunk` the adapter enqueued. */
  clientChunks: ChatMessageChunk[];
  /** The assistant `ChatMessage` x-chat-headless built from those chunks. */
  message: ChatMessage;
  /** `POST /approval` bodies the client sent, and the status each got back. */
  approvalPosts: Array<{ body: Record<string, unknown>; status: number }>;
  /** `'sent'` / `'error'` / `'cancelled'`, as x-chat-headless saw the stream end. */
  streamStatus: string;
  controller: StudioController;
}

const DEFAULT_STATE: CreateDefaultStudioStateOverrides = {
  doc: {
    dashboard: { id: 'd1', title: 'Dashboard', activePageId: 'page-1' },
    pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['w1']] } },
    widgets: {
      w1: { id: 'w1', kind: 'chart', title: 'W1', sourceId: 'src', config: {} },
    },
  },
};

async function runSeam(options: SeamOptions): Promise<SeamResult> {
  const {
    turns,
    config = {},
    handlerOptions = {},
    state = DEFAULT_STATE,
    messages = [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Do it' }] }],
    onApprovalRequest,
  } = options;

  const controller = new StudioController(state);
  const llmRequests: OpenAIRequest[] = [];
  const serverEvents: Record<string, unknown>[] = [];
  const approvalPosts: Array<{ body: Record<string, unknown>; status: number }> = [];
  let chatRequestBody: Record<string, unknown> = {};
  let turnIndex = 0;

  // The host-owned pending-approval registry, exactly as a host wires it.
  const pendingApprovals = new Map<string, PendingApproval>();

  const fetchStub = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    if (url === LLM_ENDPOINT) {
      llmRequests.push(JSON.parse(String(init.body)) as OpenAIRequest);
      const response = turns[turnIndex] ?? textTurn('done');
      turnIndex += 1;
      return response;
    }

    if (url === `${AI_ENDPOINT}/chat`) {
      chatRequestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      // The real handler, driven by the real body the client just built.
      const sse = handleAIChat(chatRequestBody as never, {
        endpoint: LLM_ENDPOINT,
        model: 'gpt-4o',
        apiKey: 'k',
        approvalPending: pendingApprovals,
        approvalTimeoutMs: 5000,
        ...handlerOptions,
      });
      // Tee the server's own frames so a test can assert on the wire itself, then
      // re-encode to the bytes a real `text/event-stream` response carries.
      const bytes = sse.pipeThrough(
        new TransformStream<string, Uint8Array>({
          transform(frame, ctrl) {
            for (const line of frame.split('\n')) {
              if (line.startsWith('data: ')) {
                serverEvents.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
              }
            }
            ctrl.enqueue(new TextEncoder().encode(frame));
          },
        }),
      );
      return new Response(bytes, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }

    if (url === `${AI_ENDPOINT}/approval`) {
      // The reference `/approval` route from `examples/x-studio-dev-server`.
      const body = JSON.parse(String(init.body)) as {
        id: string;
        approved: boolean;
        reason?: string;
        threadId?: string;
      };
      const entry = pendingApprovals.get(body.id);
      let status = 200;
      if (!entry) {
        status = 404;
      } else if (!isApprovalThreadIdAuthorized(entry, body.threadId)) {
        status = 403;
      } else {
        pendingApprovals.delete(body.id);
        entry.resolve(body.approved, body.reason, body.threadId);
      }
      approvalPosts.push({ body: body as unknown as Record<string, unknown>, status });
      return new Response(status === 200 ? '{"ok":true}' : '{"error":"denied"}', { status });
    }

    throw new Error(`Unexpected fetch to ${url}`);
  });
  vi.stubGlobal('fetch', fetchStub);

  const adapter = createBackendChatAdapter({ endpoint: AI_ENDPOINT, ...config }, controller);
  const chunkStream = await adapter.sendMessage({
    message: messages[messages.length - 1],
    messages,
    signal: new AbortController().signal,
  } as never);

  // Tap the chunk stream on its way into x-chat-headless so a test can assert on
  // the chunks themselves AND on the ChatMessage they build.
  const clientChunks: ChatMessageChunk[] = [];
  const tapped = chunkStream.pipeThrough(
    new TransformStream<ChatMessageChunk, ChatMessageChunk>({
      transform(chunk, ctrl) {
        clientChunks.push(chunk);
        // An approval request pauses the server until the client answers, so the
        // decision has to be dispatched from inside the stream, not after it.
        if (chunk.type === 'tool-approval-request' && onApprovalRequest) {
          const decision = onApprovalRequest(chunk as unknown as Record<string, unknown>);
          const approvalChunk = chunk as unknown as { approvalId?: string; toolCallId: string };
          adapter.addToolApprovalResponse!({
            id: approvalChunk.approvalId ?? approvalChunk.toolCallId,
            ...decision,
          } as never);
        }
        ctrl.enqueue(chunk);
      },
    }),
  );

  const store = new ChatStore();
  const streamResult = await processStream(store, tapped, {
    conversationId: 'c1',
    flushInterval: 0,
  }).catch(() => ({ status: 'error' as const }));

  const assistantId = store.state.messageIds[store.state.messageIds.length - 1];
  return {
    llmRequests,
    chatRequestBody,
    serverEvents,
    clientChunks,
    message: store.state.messagesById[assistantId] as ChatMessage,
    approvalPosts,
    streamStatus: streamResult.status,
    controller,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Harness self-check ────────────────────────────────────────────────────────

describe('x-studio ⇄ x-studio-ai-middleware seam: harness', () => {
  it('streams a plain text answer all the way from the gateway to a ChatMessage', async () => {
    const result = await runSeam({ turns: [textTurn('Hello there')] });

    expect(result.llmRequests).toHaveLength(1);
    expect(result.serverEvents.map((event) => event.type)).toContain('finish');
    expect(result.message.parts).toContainEqual(
      expect.objectContaining({ type: 'text', text: 'Hello there' }),
    );
  });
});

// ── F1: privateMode ───────────────────────────────────────────────────────────
//
// The client omitted `dashboardState` entirely under `privateMode` while the
// server's `validateStudioAIRequestBody` hard-required `dashboardState.doc` with no
// exemption — so EVERY private-mode chat request died in validation: 0 LLM calls, 0
// SSE events beyond the error frame. Both sides were pinned green
// (`studioBackendAdapter.test.ts` asserted the omission, `handleAIChat.test.ts`'s
// `makeBody()` always supplied it), which is exactly the blind spot this file exists
// to cover.
//
// Resolution: the SERVER is right. `privateMode` is documented as a
// provider-facing guarantee ("no ... are sent to the LLM provider"), the middleware
// is the host's OWN backend (it holds the API key and already receives the whole
// conversation), and the server enforces the guarantee at the only boundary that
// matters — the state never enters the prompt and every state-echoing tool is
// withdrawn. So the client now always sends `dashboardState`, and keeps withholding
// the two payloads that carry actual row values (`pageSnapshot`, `richContext`).

describe('x-studio ⇄ x-studio-ai-middleware seam: privateMode (F1)', () => {
  it('completes a privateMode chat request end to end', async () => {
    const result = await runSeam({
      turns: [textTurn('Private answer')],
      config: { privateMode: true },
    });

    // The defect: validation rejected the body, so the loop never ran.
    expect(result.serverEvents.filter((event) => event.type === 'error')).toHaveLength(0);
    expect(result.llmRequests).toHaveLength(1);
    expect(result.streamStatus).toBe('sent');
    expect(result.message.parts).toContainEqual(
      expect.objectContaining({ type: 'text', text: 'Private answer' }),
    );
  });

  it('still withholds dashboard state and row data from the LLM provider', async () => {
    const result = await runSeam({
      turns: [textTurn('Private answer')],
      config: { privateMode: true },
    });

    // The client sends the state to its own backend…
    expect(result.chatRequestBody.dashboardState).toBeDefined();
    expect(result.chatRequestBody.privateMode).toBe(true);
    // …but never the payloads carrying sampled row values / field statistics.
    expect(result.chatRequestBody.pageSnapshot).toBeUndefined();
    expect(result.chatRequestBody.richContext).toBeUndefined();

    // …and none of it reaches the provider: no `<dashboard_state>` block, no widget
    // title, and no state-reading tool advertised for the model to fetch it with.
    const sentToProvider = JSON.stringify(result.llmRequests[0]);
    expect(sentToProvider).not.toContain('<dashboard_state>');
    expect(sentToProvider).not.toContain('W1');
    const advertised = (result.llmRequests[0].tools ?? []).map((t) => t.function.name);
    expect(advertised).not.toContain('get_dashboard_state');
    expect(advertised).not.toContain('summarise_page');
    expect(advertised).not.toContain('query_data_source');
  });
});
