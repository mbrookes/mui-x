/**
 * Unit tests for `handleAIChat`.
 *
 * `handleAIChat` wraps the agentic loop in a `ReadableStream` of SSE strings.
 * Rather than mock the loop module (unsafe under this project's
 * `isolate: false` config), we drive the real loop with a stubbed `fetch`
 * returning canned LLM SSE — the same approach as `agenticLoop.test.ts` — and
 * assert handleAIChat's own contract: SSE framing, a terminal `finish`,
 * forwarding the conversation, surfacing errors, and closing the stream.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleAIChat, type StudioAIHandlerOptions } from './handleAIChat';
import { createDefaultStudioState } from './models/studioTypes';
import type { StudioAIRequest, StudioAISSEEvent } from './models/protocol';

// ── LLM SSE response helpers (mirrors agenticLoop.test.ts) ──────────────────────

function makeSseResponse(chunks: unknown[]): Response {
  const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function textResponse(text: string, promptTokens = 100, completionTokens = 20): Response {
  return makeSseResponse([
    { choices: [{ delta: { content: text }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens } },
  ]);
}

function toolCallResponse(toolName: string, args: object): Response {
  return makeSseResponse([
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: 'tc_1', function: { name: toolName, arguments: '' } }],
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
    { choices: [], usage: { prompt_tokens: 200, completion_tokens: 50 } },
  ]);
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

async function readAll(stream: ReadableStream<string>): Promise<string[]> {
  const reader = stream.getReader();
  const chunks: string[] = [];
  while (true) {
    // eslint-disable-next-line no-await-in-loop -- sequential stream read
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
  }
  return chunks;
}

/** Parse the SSE frames back into events. */
function parseEvents(chunks: string[]): StudioAISSEEvent[] {
  return chunks.map((c) => JSON.parse(c.replace(/^data: /, '').trimEnd()) as StudioAISSEEvent);
}

const OPTIONS: StudioAIHandlerOptions = {
  endpoint: 'https://test.example/v1/chat/completions',
  model: 'gpt-4o',
};

function makeBody(overrides: Partial<StudioAIRequest> = {}): StudioAIRequest {
  return {
    messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Hi there' }] }],
    dashboardState: createDefaultStudioState(),
    ...overrides,
  } as unknown as StudioAIRequest;
}

/** A dashboard state with a single widget, so `remove_widget` produces a real mutation. */
function seedWidgetState() {
  const state = createDefaultStudioState();
  const activePageId = state.doc.dashboard.activePageId;
  return {
    ...state,
    doc: {
      ...state.doc,
      widgets: {
        w1: { id: 'w1', kind: 'chart' as const, title: 'W1', sourceId: 's', config: {} },
      },
      pages: {
        ...state.doc.pages,
        [activePageId]: { ...state.doc.pages[activePageId], widgetRows: [['w1']] },
      },
    },
  };
}

describe('handleAIChat', () => {
  beforeEach(() => {
    vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('encodes loop events as SSE data frames ending with finish', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(textResponse('Hello world'));

    const chunks = await readAll(handleAIChat(makeBody(), OPTIONS));

    expect(chunks.length).toBeGreaterThan(0);
    chunks.forEach((c) => expect(c).toMatch(/^data: .*\n\n$/s));

    const events = parseEvents(chunks);
    const text = events
      .filter(
        (event): event is { type: 'text-delta'; delta: string } => event.type === 'text-delta',
      )
      .map((event) => event.delta)
      .join('');
    expect(text).toContain('Hello world');
    expect(events.at(-1)?.type).toBe('finish');
  });

  it('emits a usage event before the finish event', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(textResponse('Done', 150, 30));

    const events = parseEvents(await readAll(handleAIChat(makeBody(), OPTIONS)));
    const types = events.map((event) => event.type);
    expect(types).toContain('usage');
    expect(types.indexOf('usage')).toBeLessThan(types.indexOf('finish'));
  });

  it('forwards the conversation and endpoint to the LLM call', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(textResponse('ok'));

    await readAll(handleAIChat(makeBody(), OPTIONS));

    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(OPTIONS.endpoint);
    const sentBody = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(JSON.stringify(sentBody.messages)).toContain('Hi there');
  });

  it('closes the stream after the terminal event', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(textResponse('bye'));
    const reader = handleAIChat(makeBody(), OPTIONS).getReader();
    // Drain all frames.
    let done = false;
    while (!done) {
      // eslint-disable-next-line no-await-in-loop -- sequential drain
      ({ done } = await reader.read());
    }
    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });

  it('forwards a loop error event (e.g. rate limit) without a finish', async () => {
    // A tool-call turn costs 250 tokens, exceeding the 200-token budget.
    vi.mocked(fetch).mockResolvedValueOnce(toolCallResponse('get_dashboard_state', {}));

    const events = parseEvents(
      await readAll(
        handleAIChat(makeBody(), { ...OPTIONS, rateLimit: { maxTokensPerRequest: 200 } }),
      ),
    );
    const types = events.map((event) => event.type);
    expect(types).toContain('error');
    expect(types).not.toContain('finish');
  });

  it('surfaces a transport failure as an error frame', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('network down'));

    const events = parseEvents(await readAll(handleAIChat(makeBody(), OPTIONS)));
    const errorEvent = events.find(
      (event): event is { type: 'error'; message: string } => event.type === 'error',
    );
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.message).toContain('network down');
    expect(events.map((event) => event.type)).not.toContain('finish');
  });

  // Finding: a malformed request body (e.g. a `dashboardState` missing `doc`, or a body
  // that isn't an object at all) previously fell straight through to the agentic loop,
  // which dereferenced the missing field and threw a raw, opaque `TypeError` — caught
  // only by the generic `catch` in `start()`. `handleAIChat` never calls `fetch` for
  // any of these (the loop never even starts), which is itself part of the regression
  // guard: a bad request must fail fast with an actionable message, not partially run.
  describe('request body validation', () => {
    it('rejects a missing/non-object body', async () => {
      const events = parseEvents(
        await readAll(handleAIChat(undefined as unknown as StudioAIRequest, OPTIONS)),
      );
      const errorEvent = events.find(
        (event): event is { type: 'error'; message: string } => event.type === 'error',
      );
      expect(errorEvent?.message).toMatch(/^MUI X Studio:/);
      expect(errorEvent?.message).toMatch(/missing or non-object request body/);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('rejects a body missing `messages`', async () => {
      const body = makeBody();
      delete (body as { messages?: unknown }).messages;

      const events = parseEvents(await readAll(handleAIChat(body, OPTIONS)));
      const errorEvent = events.find(
        (event): event is { type: 'error'; message: string } => event.type === 'error',
      );
      expect(errorEvent?.message).toMatch(/^MUI X Studio:/);
      expect(errorEvent?.message).toMatch(/missing a `messages` array/);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('rejects a dashboardState missing `doc`', async () => {
      const body = makeBody({ dashboardState: {} as unknown as StudioAIRequest['dashboardState'] });

      const events = parseEvents(await readAll(handleAIChat(body, OPTIONS)));
      const errorEvent = events.find(
        (event): event is { type: 'error'; message: string } => event.type === 'error',
      );
      expect(errorEvent?.message).toMatch(/^MUI X Studio:/);
      expect(errorEvent?.message).toMatch(/missing `dashboardState\.doc`/);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('rejects a dashboardState.doc missing required pages/widgets/dashboard fields', async () => {
      const state = createDefaultStudioState();
      const body = makeBody({
        dashboardState: {
          ...state,
          doc: { ...state.doc, pages: undefined as never },
        },
      });

      const events = parseEvents(await readAll(handleAIChat(body, OPTIONS)));
      const errorEvent = events.find(
        (event): event is { type: 'error'; message: string } => event.type === 'error',
      );
      expect(errorEvent?.message).toMatch(/^MUI X Studio:/);
      expect(errorEvent?.message).toMatch(/dashboard`\/`pages`\/`widgets`/);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('accepts a well-formed body and proceeds to call the LLM', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(textResponse('ok'));
      const events = parseEvents(await readAll(handleAIChat(makeBody(), OPTIONS)));
      expect(events.map((event) => event.type)).not.toContain('error');
      expect(fetch).toHaveBeenCalledOnce();
    });
  });

  it('runs contextEnricher and injects its output into the system prompt', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(textResponse('ok'));
    const contextEnricher = vi.fn().mockResolvedValue({ notes: 'Enriched by the server.' });

    await readAll(handleAIChat(makeBody(), { ...OPTIONS, contextEnricher }));

    expect(contextEnricher).toHaveBeenCalledOnce();
    const sentBody = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    const systemMessage = sentBody.messages.find((m) => m.role === 'system');
    expect(systemMessage?.content).toContain('<server_context>');
    expect(systemMessage?.content).toContain('Enriched by the server.');
  });

  it('skips contextEnricher in private mode', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(textResponse('ok'));
    const contextEnricher = vi.fn().mockResolvedValue({ notes: 'secret' });

    await readAll(handleAIChat(makeBody({ privateMode: true }), { ...OPTIONS, contextEnricher }));

    expect(contextEnricher).not.toHaveBeenCalled();
  });

  it('continues the chat when contextEnricher throws', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(textResponse('ok'));
    const onToolError = vi.fn();
    const contextEnricher = vi.fn().mockRejectedValue(new Error('enricher boom'));

    const events = parseEvents(
      await readAll(handleAIChat(makeBody(), { ...OPTIONS, contextEnricher, onToolError })),
    );

    expect(onToolError).toHaveBeenCalledWith('contextEnricher', expect.any(Error));
    expect(events.at(-1)?.type).toBe('finish');
  });

  it('propagates consumer stream cancellation to the loop via an abort signal', async () => {
    let capturedSignal: AbortSignal | undefined;
    // Return a stream that emits one frame then stays open, so the loop is mid-flight
    // when we cancel.
    vi.mocked(fetch).mockImplementation((_url, init) => {
      capturedSignal = (init as RequestInit | undefined)?.signal ?? undefined;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
            ),
          );
          // Intentionally never closed — the loop is left awaiting more chunks.
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    });

    const reader = handleAIChat(makeBody(), OPTIONS).getReader();
    await reader.read(); // consume the first frame
    expect(capturedSignal?.aborted).toBe(false);

    await reader.cancel();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('ends cleanly when an already-aborted external signal is provided', async () => {
    // Loop's fetch sees an aborted signal and returns silently — no finish, no error.
    vi.mocked(fetch).mockImplementation((_url, init) => {
      const signal = (init as RequestInit | undefined)?.signal;
      return Promise.reject(
        Object.assign(new DOMException('Aborted', 'AbortError'), { aborted: signal?.aborted }),
      );
    });

    const ac = new AbortController();
    ac.abort();

    const events = parseEvents(
      await readAll(handleAIChat(makeBody(), { ...OPTIONS, signal: ac.signal })),
    );
    const types = events.map((event) => event.type);
    expect(types).not.toContain('finish');
    expect(types).not.toContain('error');
  });

  // Finding: the listener `handleAIChat` adds to a host-supplied `options.signal`
  // was previously never explicitly removed on normal completion — `{ once: true }`
  // alone only unregisters it once the signal actually FIRES. A host that reuses
  // one long-lived `AbortSignal` across many `handleAIChat` calls would otherwise
  // accumulate one listener per request that never fires and never gets cleaned up.
  it('removes the external abort-signal listener once the stream finishes normally (no leak across reused signals)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(textResponse('done'));
    const ac = new AbortController();
    const addSpy = vi.spyOn(ac.signal, 'addEventListener');
    const removeSpy = vi.spyOn(ac.signal, 'removeEventListener');

    const events = parseEvents(
      await readAll(handleAIChat(makeBody(), { ...OPTIONS, signal: ac.signal })),
    );
    expect(events.at(-1)?.type).toBe('finish');

    expect(addSpy).toHaveBeenCalledTimes(1);
    const [eventName, listener] = addSpy.mock.calls[0];
    expect(eventName).toBe('abort');
    expect(removeSpy).toHaveBeenCalledWith('abort', listener);
  });

  it('removes the external abort-signal listener when the consumer cancels the stream', async () => {
    vi.mocked(fetch).mockImplementation(() => {
      // A stream that never closes — the loop is left mid-flight until cancelled.
      const body = new ReadableStream<Uint8Array>({ start() {} });
      return Promise.resolve(new Response(body, { status: 200 }));
    });
    const ac = new AbortController();
    const addSpy = vi.spyOn(ac.signal, 'addEventListener');
    const removeSpy = vi.spyOn(ac.signal, 'removeEventListener');

    const reader = handleAIChat(makeBody(), { ...OPTIONS, signal: ac.signal }).getReader();
    await reader.cancel();

    const [eventName, listener] = addSpy.mock.calls[0];
    expect(eventName).toBe('abort');
    expect(removeSpy).toHaveBeenCalledWith('abort', listener);
  });

  it('does not throw from the error path when the stream was already cancelled', async () => {
    const rejections: unknown[] = [];
    const handler = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', handler);
    try {
      let rejectFetch: (err: unknown) => void = () => {};
      vi.mocked(fetch).mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            rejectFetch = reject;
          }),
      );

      const reader = handleAIChat(makeBody(), OPTIONS).getReader();
      await reader.cancel(); // controller is now closed/cancelled
      // The pending transport now fails → the catch block tries to enqueue an error
      // frame (and finally to close) on an already-cancelled controller. Both are
      // guarded, so nothing should escape as an unhandled rejection.
      rejectFetch(new Error('late transport failure'));
      await new Promise((r) => {
        setTimeout(r, 20);
      });
    } finally {
      process.removeListener('unhandledRejection', handler);
    }
    expect(rejections).toHaveLength(0);
  });

  // ── approvalFallback threading (review finding 2.7) ─────────────────────────
  //
  // `runAgenticLoop` has always supported `approvalFallback`, but until now
  // `StudioAIHandlerOptions` (handleAIChat's public entry point) neither declared
  // nor forwarded it, so it was unreachable from the actual public API. These
  // tests drive the option through `handleAIChat` end-to-end and assert an
  // OBSERVABLE difference (whether the mutation is applied) rather than just
  // that a value was passed along.

  it('defaults to denying a require-approval tool with no approvalPending wired (fail-closed)', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(toolCallResponse('remove_widget', { widgetId: 'w1' }))
      .mockResolvedValueOnce(textResponse('done', 10, 5));

    const events = parseEvents(
      await readAll(
        handleAIChat(
          makeBody({ dashboardState: seedWidgetState() } as Partial<StudioAIRequest>),
          OPTIONS,
        ),
      ),
    );

    expect(events.some((event) => event.type === 'state-mutation')).toBe(false);
    expect(events.at(-1)?.type).toBe('finish');
  });

  it("threads approvalFallback: 'allow' through to the agentic loop, auto-approving the tool", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(toolCallResponse('remove_widget', { widgetId: 'w1' }))
      .mockResolvedValueOnce(textResponse('done', 10, 5));

    const events = parseEvents(
      await readAll(
        handleAIChat(makeBody({ dashboardState: seedWidgetState() } as Partial<StudioAIRequest>), {
          ...OPTIONS,
          approvalFallback: 'allow',
        }),
      ),
    );

    // Same tool call, same missing approvalPending — only `approvalFallback` differs,
    // and now the mutation actually commits, proving the option reached the loop.
    expect(events.some((event) => event.type === 'state-mutation')).toBe(true);
    expect(events.at(-1)?.type).toBe('finish');
  });
});

// ── Server-side allowedTools / privateMode enforcement ──────────────────────────

describe('handleAIChat — server-side allowedTools/privateMode enforcement', () => {
  beforeEach(() => {
    vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Run one text-only turn and return the tool names advertised to the model. */
  async function advertisedTools(
    body: StudioAIRequest,
    options: Partial<StudioAIHandlerOptions>,
  ): Promise<string[]> {
    vi.mocked(fetch).mockResolvedValueOnce(textResponse('ok'));
    await readAll(handleAIChat(body, { ...OPTIONS, ...options }));
    const sentBody = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string) as {
      tools: { function: { name: string } }[];
    };
    return sentBody.tools.map((t) => t.function.name);
  }

  it('intersects options.allowedTools with the body allowedTools (server wins on exclusion)', async () => {
    const names = await advertisedTools(makeBody({ allowedTools: ['remove_page', 'add_widget'] }), {
      allowedTools: ['add_widget'],
    });
    expect(names).toContain('add_widget');
    // remove_page is in the body list but not the server allowlist → excluded.
    expect(names).not.toContain('remove_page');
  });

  it('uses options.allowedTools as-is when the body omits allowedTools', async () => {
    const names = await advertisedTools(makeBody(), { allowedTools: ['add_widget'] });
    expect(names).toEqual(['add_widget']);
  });

  it('forces private mode when options.privateMode is set even if the body opts out', async () => {
    const names = await advertisedTools(makeBody({ privateMode: false }), { privateMode: true });
    // State-reading tools are withheld from advertisement under effective private mode.
    expect(names).not.toContain('get_dashboard_state');
    expect(names).not.toContain('list_pages');
    // Non-state-reading tools are still offered.
    expect(names).toContain('set_dashboard_title');
  });

  it('leaves behavior unchanged when neither server option is provided', async () => {
    const names = await advertisedTools(makeBody(), {});
    // Body allows all → default full set including state-reading tools.
    expect(names).toContain('get_dashboard_state');
    expect(names).toContain('list_pages');
  });
});
