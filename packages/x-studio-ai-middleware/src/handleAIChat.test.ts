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
});
