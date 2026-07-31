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
 * The middleware is reached by a RELATIVE SOURCE IMPORT, the same way
 * `x-studio-data-middleware`'s `clientWireSeam.test.ts` reaches this package, and for the same
 * reason: `@mui/x-studio` does not (and must not) depend on it, since the whole point of the
 * protocol is that the two ship independently. The coupling exists only in this test file.
 *
 * NOT via a `paths` entry in the workspace `tsconfig.json`. That is how it was first written, and
 * it silently removed the dependency-direction guard for the WHOLE repo: `packages/x-studio` does
 * not list the middleware in any dependency field and it is absent from its `node_modules`, so a
 * production `import … from '@mui/x-studio-ai-middleware'` used to fail `tsc`. With the mapping in
 * place it typechecked from any file in the repo, and nothing else stood in the way — the vitest
 * alias is global, and the `no-restricted-imports` block for package sources only bans three-level
 * deep `@mui` subpaths and self-imports. A relative import needs no mapping, so the guard stays.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { ChatMessage, ChatMessageChunk } from '@mui/x-chat/headless';
import { ChatStore } from '@mui/x-chat-headless/store';
import { processStream } from '@mui/x-chat-headless/stream';
/* eslint-disable import/no-relative-packages */
import {
  handleAIChat,
  isApprovalThreadIdAuthorized,
  toOpenAIMessages,
  type OpenAIMessage,
  type StudioAIHandlerOptions,
  type PendingApproval,
} from '../../../../x-studio-ai-middleware/src';
/* eslint-enable import/no-relative-packages */
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

/** A completion that calls one tool with `args`. */
function toolCallTurn(toolCallId: string, toolName: string, args: object): Response {
  return sseResponse([
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: toolCallId, function: { name: toolName, arguments: '' } }],
          },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        {
          delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 5 } },
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
  /**
   * Which id the approval decision is POSTed under. `'approvalId'` (the default) is
   * what `ToolPart` does — `approvalId ?? toolCallId`. `'toolCallId'` forces the
   * pre-F5 shape so a test can show that the provider-authored id no longer resolves
   * anything.
   */
  resolveWith?: 'approvalId' | 'toolCallId';
  /**
   * Abort the request the moment the approval card appears, instead of answering it —
   * the user clicking Stop while a confirmation is on screen. Aborts the send signal
   * and calls `adapter.stop()`, exactly as `ChatBox` does.
   */
  abortOnApprovalRequest?: boolean;
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
    resolveWith = 'approvalId',
    abortOnApprovalRequest = false,
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
        // Short on purpose: an approval that fails closed must surface as a fast
        // `{"denied":true,"reason":"approval timed out"}` rather than stalling the
        // suite for the production 120s.
        approvalTimeoutMs: 300,
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
  const sendAbort = new AbortController();
  const chunkStream = await adapter.sendMessage({
    message: messages[messages.length - 1],
    messages,
    signal: sendAbort.signal,
  } as never);

  // Tap the chunk stream on its way into x-chat-headless so a test can assert on
  // the chunks themselves AND on the ChatMessage they build.
  const clientChunks: ChatMessageChunk[] = [];
  const tapped = chunkStream.pipeThrough(
    new TransformStream<ChatMessageChunk, ChatMessageChunk>({
      transform(chunk, ctrl) {
        clientChunks.push(chunk);
        // The user hits Stop while the confirmation card is on screen. `ChatBox`
        // aborts the send signal first and then calls `stop()`, which cancels the
        // response-body reader; the server is left paused on its own approval.
        if (chunk.type === 'tool-approval-request' && abortOnApprovalRequest) {
          sendAbort.abort();
          adapter.stop!();
        }
        // An approval request pauses the server until the client answers, so the
        // decision has to be dispatched from inside the stream, not after it.
        if (chunk.type === 'tool-approval-request' && onApprovalRequest) {
          const decision = onApprovalRequest(chunk as unknown as Record<string, unknown>);
          const approvalChunk = chunk as unknown as { approvalId?: string; toolCallId: string };
          // `ToolPart`'s own rule: the approval's id when it has one, the tool call's
          // otherwise. `resolveWith: 'toolCallId'` forces the pre-F5 shape.
          const id =
            resolveWith === 'toolCallId'
              ? approvalChunk.toolCallId
              : (approvalChunk.approvalId ?? approvalChunk.toolCallId);
          // A 4xx from the reference route rejects out of `addToolApprovalResponse`;
          // the real consumer (`useChatController`) handles it, this tap must not let
          // it surface as an unhandled rejection and fail the run.
          adapter.addToolApprovalResponse!({ id, ...decision } as never)?.catch?.(() => {});
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

// ── F2: tool-approval thread binding ──────────────────────────────────────────
//
// The loop binds every pending approval to `doc.ai.activeThreadId`, which
// `serializeDashboardState` preserves and `useChatThreads` sets as soon as a thread
// exists — so `entry.threadId` is set in normal operation. `isApprovalThreadIdAuthorized`
// (documented mandatory, and used verbatim by the reference `/approval` route) denies a
// MISSING threadId as well as a mismatched one. The adapter never sent one, so every
// approval in a real conversation 403'd and the tool call then failed closed after the
// full approval timeout with `{"denied":true,"reason":"approval timed out"}`.

const STATE_WITH_THREAD: CreateDefaultStudioStateOverrides = {
  doc: {
    ...DEFAULT_STATE.doc,
    // The thread itself has to exist: `screenAIState` drops an `activeThreadId` that
    // names no thread, exactly as a real conversation would never have one.
    ai: {
      activeThreadId: 'thread-42',
      threads: [{ id: 'thread-42', name: 'Chat', createdAt: '2026-01-01T00:00:00Z', messages: [] }],
    },
  },
};

/** The `output` string of the first dynamic-tool part of a streamed message. */
function firstToolOutput(message: ChatMessage): string {
  const part = message.parts.find((p) => p.type === 'dynamic-tool') as
    | { toolInvocation: { output?: unknown; input?: unknown; toolName?: string } }
    | undefined;
  return String(part?.toolInvocation.output ?? '');
}

describe('x-studio ⇄ x-studio-ai-middleware seam: tool approval (F2)', () => {
  it('sends the active thread id with the approval so the host route authorizes it', async () => {
    const result = await runSeam({
      turns: [toolCallTurn('tc-1', 'remove_widget', { widgetId: 'w1' }), textTurn('Removed it')],
      state: STATE_WITH_THREAD,
      onApprovalRequest: () => ({ approved: true }),
    });

    expect(result.approvalPosts).toHaveLength(1);
    // The defect: no `threadId` in the POST body → 403 from the reference route.
    expect(result.approvalPosts[0].body.threadId).toBe('thread-42');
    expect(result.approvalPosts[0].status).toBe(200);

    // …and the approved tool actually ran instead of timing out.
    expect(firstToolOutput(result.message)).not.toContain('approval timed out');
    expect(firstToolOutput(result.message)).toContain('success');
  });

  it('still resolves an approval when the dashboard has no chat thread yet', async () => {
    const result = await runSeam({
      turns: [toolCallTurn('tc-1', 'remove_widget', { widgetId: 'w1' }), textTurn('Removed it')],
      onApprovalRequest: () => ({ approved: true }),
    });

    // No thread → nothing to bind to; the field is omitted rather than sent as
    // `undefined`/`''`, which `isApprovalThreadIdAuthorized` treats as unbound.
    expect(result.approvalPosts[0].body.threadId).toBeUndefined();
    expect(result.approvalPosts[0].status).toBe(200);
    expect(firstToolOutput(result.message)).toContain('success');
  });

  it('carries a denial back to the model as the tool result', async () => {
    const result = await runSeam({
      turns: [toolCallTurn('tc-1', 'remove_widget', { widgetId: 'w1' }), textTurn('Left it')],
      state: STATE_WITH_THREAD,
      onApprovalRequest: () => ({ approved: false, reason: 'Not today' }),
    });

    expect(result.approvalPosts[0].status).toBe(200);
    expect(firstToolOutput(result.message)).toContain('Not today');
  });
});

// ── Round-4 F5: the approval is resolved by `approvalId`, not `toolCallId` ────
//
// The `approvalPending` map is host-shared and cross-request, and its key used to be
// the provider's `tool_calls[].id`. A gateway numbering those sequentially made every
// in-flight approval in the process enumerable, leaving the OPTIONAL `threadId`
// binding as the only thing between a guessed id and a resolved destructive call.
//
// The server now mints an `approvalId` with `randomUUID()` and publishes it on the
// event; `studioBackendAdapter` forwards it on the chunk when non-empty (never
// defaulting it to `toolCallId`), `processStream` puts it on the invocation, and
// `ToolPart` responds with `approvalId ?? toolCallId`. Only an end-to-end run can show
// that those five layers agree — each half was green on its own for two rounds while
// the feature was inert.

describe('x-studio ⇄ x-studio-ai-middleware seam: approval id (F5)', () => {
  it('resolves the approval by the server-minted approvalId, never the tool-call id', async () => {
    const result = await runSeam({
      turns: [toolCallTurn('tc-1', 'remove_widget', { widgetId: 'w1' }), textTurn('Removed it')],
      state: STATE_WITH_THREAD,
      onApprovalRequest: () => ({ approved: true }),
    });

    const serverEvent = result.serverEvents.find(
      (event) => event.type === 'tool-approval-request',
    ) as { approvalId?: string; toolCallId?: string } | undefined;
    expect(serverEvent?.toolCallId).toBe('tc-1');
    // Minted server-side, independent of the (here fully predictable) wire id.
    expect(serverEvent?.approvalId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    // Forwarded verbatim on the chunk…
    const chunk = result.clientChunks.find((c) => c.type === 'tool-approval-request') as unknown as
      | { approvalId?: string; toolCallId?: string }
      | undefined;
    expect(chunk?.approvalId).toBe(serverEvent?.approvalId);
    expect(chunk?.toolCallId).toBe('tc-1');

    // …and carried onto the invocation, which is what `ToolPart` reads to build its
    // `addToolApprovalResponse({ id: approvalId ?? toolCallId })` call.
    const toolPart = result.message.parts.find((p) => p.type === 'dynamic-tool') as
      | { toolInvocation: { approvalId?: string; toolCallId: string } }
      | undefined;
    expect(toolPart?.toolInvocation.approvalId).toBe(serverEvent?.approvalId);

    // The POST resolves by the approval id, and the reference `/approval` route finds
    // the entry under it — the tool ran rather than sitting out the timeout.
    expect(result.approvalPosts).toHaveLength(1);
    expect(result.approvalPosts[0].body.id).toBe(serverEvent?.approvalId);
    expect(result.approvalPosts[0].body.id).not.toBe('tc-1');
    expect(result.approvalPosts[0].status).toBe(200);
    expect(firstToolOutput(result.message)).not.toContain('approval timed out');
    expect(firstToolOutput(result.message)).toContain('success');
  });

  it('rejects a resolution presented for the tool-call id instead of the approval id', async () => {
    // The complement: the provider-authored id is no longer a key into the map at all,
    // so a caller who only knows it (or guessed it) resolves nothing.
    const result = await runSeam({
      turns: [toolCallTurn('tc-1', 'remove_widget', { widgetId: 'w1' }), textTurn('Left it')],
      state: STATE_WITH_THREAD,
      onApprovalRequest: () => ({ approved: true }),
      resolveWith: 'toolCallId',
    });

    expect(result.approvalPosts[0].body.id).toBe('tc-1');
    expect(result.approvalPosts[0].status).toBe(404);
    // Nothing resolved, so the call failed closed on the (short) timeout.
    expect(firstToolOutput(result.message)).toContain('approval timed out');
  });
});

// ── F3 / F4: what the next request replays ────────────────────────────────────
//
// The point of round-5's per-turn replay work was that a follow-up request repeats
// the bytes the earlier turns were actually sent as (turn structure AND payload), so
// the provider's prefix cache survives and the model is never taught a call it did
// not make. Two things broke that, and only an end-to-end comparison can see either:
//
// F3 — the `tool-approval-request` event carries a DISPLAY-enriched `input`
// (`apply_bulk_update`'s `widgetRemovals: ['w1']` becomes `[{id, title}]`, so a human
// approves against real titles instead of opaque ids), and `processStream`'s approval
// branch writes it straight over `toolInvocation.input`. The enriched object was then
// replayed as the model's own arguments — and since the tool's schema declares
// `items: { type: 'string' }`, the executor rejects the object form and treats the
// removal list as EMPTY. The replayed history taught the model a shape that silently
// no-ops.
//
// F4 — `output` is already a JSON STRING client-side, and the replay serialiser
// called `JSON.stringify` on it again, so every tool result came back double-encoded.

/** The assistant turn carrying tool calls, from a set of OpenAI messages. */
function assistantToolCallTurn(messages: OpenAIMessage[]) {
  return messages.find(
    (m): m is Extract<OpenAIMessage, { role: 'assistant' }> =>
      m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
  );
}

/** The tool-result message for `toolCallId`, from a set of OpenAI messages. */
function toolResultMessage(messages: OpenAIMessage[], toolCallId: string) {
  return messages.find(
    (m): m is Extract<OpenAIMessage, { role: 'tool' }> =>
      m.role === 'tool' && m.tool_call_id === toolCallId,
  );
}

describe('x-studio ⇄ x-studio-ai-middleware seam: replay fidelity (F3, F4)', () => {
  it('replays an approved tool call with the arguments the model actually sent', async () => {
    const result = await runSeam({
      turns: [
        toolCallTurn('tc-1', 'apply_bulk_update', { widgetRemovals: ['w1'] }),
        textTurn('Removed'),
      ],
      state: STATE_WITH_THREAD,
      onApprovalRequest: () => ({ approved: true }),
    });

    // The approval card still shows the state-derived enrichment, which is what makes
    // a human able to approve against real titles rather than opaque ids (and what
    // stops a prompt-injected model from labelling the removal with a title of its
    // own choosing).
    const approvalChunk = result.clientChunks.find(
      (c) => c.type === 'tool-approval-request',
    ) as unknown as { input: { widgetRemovals: Array<{ id: string; title: string }> } };
    expect(approvalChunk.input.widgetRemovals).toEqual([{ id: 'w1', title: 'W1' }]);

    // …and the replayed history still says what the model said.
    const sentByServer = assistantToolCallTurn(result.llmRequests[1].messages);
    const replayed = assistantToolCallTurn(toOpenAIMessages('SYSTEM', [result.message]));
    expect(replayed?.tool_calls?.[0].function.arguments).toBe('{"widgetRemovals":["w1"]}');
    expect(replayed?.tool_calls?.[0].function.arguments).toBe(
      sentByServer?.tool_calls?.[0].function.arguments,
    );
  });

  it('replays a tool result byte-for-byte as the server sent it', async () => {
    const result = await runSeam({
      turns: [toolCallTurn('tc-1', 'add_page', { title: 'New page' }), textTurn('Added')],
    });

    const sentByServer = toolResultMessage(result.llmRequests[1].messages, 'tc-1');
    const replayed = toolResultMessage(toOpenAIMessages('SYSTEM', [result.message]), 'tc-1');
    expect(replayed?.content).toBe(sentByServer?.content);
    // Not `"{\"success\":true,…}"` — a JSON string re-stringified into a JSON string.
    expect(replayed?.content.startsWith('{')).toBe(true);
  });
});

// ── Round-6 F3 residual: abort DURING an open approval ────────────────────────
//
// F3's fix re-asserts the model's real arguments over the approval card's
// display-enriched ones with a `tool-input-available` chunk when the gated call
// COMPLETES — approved, denied or timed out, all of which arrive as `tool-activity`
// `complete`. Aborting while the approval is still open never reaches that event: the
// reader is cancelled and the stream closes with the enriched payload still sitting in
// `toolInvocation.input`, which `toOpenAIMessages` then replays to the model as its own
// arguments on the next request. That is precisely the defect F3 fixed, on the abort
// path — and for `apply_bulk_update` it is not cosmetic: the tool's schema declares
// `widgetRemovals` as `items: { type: 'string' }`, so the object form the enrichment
// produces makes the executor treat the removal list as EMPTY. The replayed history
// teaches the model a shape that silently no-ops.

describe('x-studio ⇄ x-studio-ai-middleware seam: abort during an open approval', () => {
  it("replays the model's own arguments after an abort mid-approval", async () => {
    const result = await runSeam({
      turns: [
        toolCallTurn('tc-1', 'apply_bulk_update', { widgetRemovals: ['w1'] }),
        textTurn('unreached'),
      ],
      state: STATE_WITH_THREAD,
      abortOnApprovalRequest: true,
    });

    // The approval card was shown with the state-derived enrichment (that half must
    // keep working — it is what lets a human approve against real titles).
    const approvalChunk = result.clientChunks.find(
      (c) => c.type === 'tool-approval-request',
    ) as unknown as { input: { widgetRemovals: unknown } };
    expect(approvalChunk.input.widgetRemovals).toEqual([{ id: 'w1', title: 'W1' }]);

    // …and the call never completed, so nothing re-asserted the real arguments by the
    // ordinary `tool-activity` `complete` route.
    expect(
      result.clientChunks.some((c) => c.type === 'tool-output-available' || c.type === 'finish'),
    ).toBe(false);

    // The defect: the enriched object was replayed as the model's own tool arguments.
    const replayed = assistantToolCallTurn(toOpenAIMessages('SYSTEM', [result.message]));
    expect(replayed?.tool_calls?.[0].function.arguments).toBe('{"widgetRemovals":["w1"]}');
  });

  it("leaves an ungated aborted call's arguments untouched", async () => {
    // The complement: nothing was ever overwritten for a call that was not approval
    // gated, so the flush must not invent a chunk for it. `add_page` is not gated.
    const result = await runSeam({
      turns: [toolCallTurn('tc-1', 'add_page', { title: 'New page' }), textTurn('Added')],
    });

    const reasserts = result.clientChunks.filter((c) => c.type === 'tool-input-available');
    // Exactly one — the `tool-activity` `start` chunk that populates the tool card.
    expect(reasserts).toHaveLength(1);
    const replayed = assistantToolCallTurn(toOpenAIMessages('SYSTEM', [result.message]));
    expect(replayed?.tool_calls?.[0].function.arguments).toBe('{"title":"New page"}');
  });
});

// ── F5: approval `effects` / `reason` ─────────────────────────────────────────
//
// The server attaches `effects` (what the call will remove/orphan, each entity with
// its real current title) and `reason` (the policy's own justification) to a
// `tool-approval-request` precisely "so a human can approve with the real impact in
// view". The adapter dropped both, so the feature was inert end to end.
//
// The whole path now exists: the adapter forwards both,
// `ChatToolApprovalRequestChunk` declares them, `processStream` carries them onto
// `toolInvocation.approvalRequest`, `ToolPart` renders `reason` and mounts the
// `approvalDetails` slot, and `chatToolRenderers`' `StudioApprovalEffects` fills it.
// These tests assert at the chunk boundary AND on the invocation the message ends up
// with — the last point this package can see.

describe('x-studio ⇄ x-studio-ai-middleware seam: approval effects/reason (F5)', () => {
  it('forwards the effects summary the server computed for the approval', async () => {
    const result = await runSeam({
      turns: [
        toolCallTurn('tc-1', 'apply_bulk_update', { widgetRemovals: ['w1'] }),
        textTurn('Removed'),
      ],
      onApprovalRequest: () => ({ approved: true }),
    });

    const serverEvent = result.serverEvents.find((event) => event.type === 'tool-approval-request');
    expect(serverEvent?.effects).toEqual({ willRemoveWidgets: [{ id: 'w1', title: 'W1' }] });

    const chunk = result.clientChunks.find((c) => c.type === 'tool-approval-request') as unknown as
      | { effects?: unknown }
      | undefined;
    expect(chunk?.effects).toEqual(serverEvent?.effects);

    // …and it survives `processStream`, which builds the invocation from named fields
    // and used to drop both keys here. This is what `StudioApprovalEffects` renders.
    const toolPart = result.message.parts.find((p) => p.type === 'dynamic-tool') as
      | { toolInvocation: { approvalRequest?: { effects?: unknown } } }
      | undefined;
    expect(toolPart?.toolInvocation.approvalRequest?.effects).toEqual(serverEvent?.effects);
  });

  it("forwards the policy's stated reason for requiring approval", async () => {
    const result = await runSeam({
      turns: [toolCallTurn('tc-1', 'remove_widget', { widgetId: 'w1' }), textTurn('Removed')],
      handlerOptions: {
        toolPolicy: async () => ({
          action: 'require-approval',
          reason: 'this exceeds the daily mutation budget',
        }),
      },
      onApprovalRequest: () => ({ approved: true }),
    });

    const serverEvent = result.serverEvents.find((event) => event.type === 'tool-approval-request');
    expect(serverEvent?.reason).toBe('this exceeds the daily mutation budget');

    const chunk = result.clientChunks.find((c) => c.type === 'tool-approval-request') as unknown as
      | { reason?: string }
      | undefined;
    expect(chunk?.reason).toBe('this exceeds the daily mutation budget');

    // …through to the invocation `ToolPart` renders it from.
    const toolPart = result.message.parts.find((p) => p.type === 'dynamic-tool') as
      | { toolInvocation: { approvalRequest?: { reason?: string } } }
      | undefined;
    expect(toolPart?.toolInvocation.approvalRequest?.reason).toBe(
      'this exceeds the daily mutation budget',
    );
  });

  it('omits both keys when the event carries neither', async () => {
    const result = await runSeam({
      turns: [toolCallTurn('tc-1', 'remove_page', { pageId: 'nope' }), textTurn('Done')],
      onApprovalRequest: () => ({ approved: true }),
    });

    const chunk = result.clientChunks.find((c) => c.type === 'tool-approval-request') as unknown as
      | Record<string, unknown>
      | undefined;
    expect(chunk).toBeDefined();
    expect(chunk).not.toHaveProperty('effects');
    expect(chunk).not.toHaveProperty('reason');

    const toolPart = result.message.parts.find((p) => p.type === 'dynamic-tool') as
      | { toolInvocation: { approvalRequest?: unknown } }
      | undefined;
    expect(toolPart?.toolInvocation.approvalRequest).toBeUndefined();
  });
});
