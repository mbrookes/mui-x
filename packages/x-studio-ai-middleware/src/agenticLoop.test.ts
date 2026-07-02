/**
 * Tests for rate limiting in runAgenticLoop.
 *
 * Mocks `fetch` to return pre-built SSE streams so no real LLM calls are made.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runAgenticLoop } from './agenticLoop';
import { createDefaultStudioState } from './models/studioTypes';

// ── SSE response helpers ──────────────────────────────────────────────────────

function sseChunk(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function makeSseResponse(chunks: unknown[]): Response {
  const body = `${chunks.map(sseChunk).join('')}data: [DONE]\n\n`;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

/** A single-turn "text only" LLM response ending with a usage chunk. */
function textResponse(text: string, promptTokens: number, completionTokens: number): Response {
  return makeSseResponse([
    { choices: [{ delta: { content: text }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens } },
  ]);
}

/** A tool call whose streamed `arguments` accumulate to invalid JSON. */
function malformedToolCallResponse(toolName: string): Response {
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
          delta: { tool_calls: [{ index: 0, function: { arguments: '{not valid json' } }] },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ]);
}

/** A single-turn response that calls a tool, then (next turn) returns text. */
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
          delta: {
            tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }],
          },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 200, completion_tokens: 50 } },
  ]);
}

// ── Shared state ──────────────────────────────────────────────────────────────

function userMsg(text: string) {
  return {
    id: `msg-${Math.random()}`,
    role: 'user' as const,
    parts: [{ type: 'text' as const, text }],
  };
}

const BASE_OPTIONS = {
  endpoint: 'https://test.example/v1/chat/completions',
  model: 'gpt-4o',
};

const INITIAL_STATE = createDefaultStudioState();

async function collectEvents(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runAgenticLoop — rate limiting', () => {
  beforeEach(() => {
    vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits a usage event with token counts before finish', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(textResponse('Hello!', 150, 30));

    const events = await collectEvents(
      runAgenticLoop(
        [userMsg('Hi')],
        INITIAL_STATE,
        undefined,
        undefined,
        undefined,
        undefined,
        BASE_OPTIONS,
      ),
    );

    const usageEvent = events.find((ev) => (ev as { type: string }).type === 'usage') as
      | {
          type: string;
          inputTokens: number;
          outputTokens: number;
          iterations: number;
        }
      | undefined;

    expect(usageEvent).toBeDefined();
    expect(usageEvent?.inputTokens).toBe(150);
    expect(usageEvent?.outputTokens).toBe(30);
    expect(usageEvent?.iterations).toBe(1);

    const types = events.map((ev) => (ev as { type: string }).type);
    const usageIdx = types.indexOf('usage');
    const finishIdx = types.indexOf('finish');
    expect(usageIdx).toBeGreaterThanOrEqual(0);
    expect(finishIdx).toBeGreaterThan(usageIdx);
  });

  it('stops the loop and emits an error when maxTokensPerRequest is exceeded', async () => {
    const onLimitReached = vi.fn();

    // First turn: tool call response that costs 300 tokens (over the 200 limit).
    // The loop detects the overage after the turn before trying to continue.
    vi.mocked(fetch).mockResolvedValueOnce(toolCallResponse('get_dashboard_state', {}));

    const events = await collectEvents(
      runAgenticLoop([userMsg('Hi')], INITIAL_STATE, undefined, undefined, undefined, undefined, {
        ...BASE_OPTIONS,
        rateLimit: { maxTokensPerRequest: 200, onLimitReached },
      }),
    );

    const types = events.map((ev) => (ev as { type: string }).type);
    expect(types).toContain('error');
    expect(types).not.toContain('finish');

    const errorEvent = events.find((ev) => (ev as { type: string }).type === 'error') as {
      message: string;
    };
    expect(errorEvent.message).toMatch(/token budget exceeded/i);

    expect(onLimitReached).toHaveBeenCalledExactlyOnceWith('tokens', {
      inputTokens: 200,
      outputTokens: 50,
      iterations: 1,
    });
  });

  it('does not stop the loop when token usage is within maxTokensPerRequest', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(textResponse('OK', 100, 20));

    const onLimitReached = vi.fn();
    const events = await collectEvents(
      runAgenticLoop([userMsg('Hi')], INITIAL_STATE, undefined, undefined, undefined, undefined, {
        ...BASE_OPTIONS,
        rateLimit: { maxTokensPerRequest: 500, onLimitReached },
      }),
    );

    const types = events.map((ev) => (ev as { type: string }).type);
    expect(types).toContain('finish');
    expect(types).not.toContain('error');
    expect(onLimitReached).not.toHaveBeenCalled();
  });

  it('respects maxTurnsPerRequest and calls onLimitReached with "turns"', async () => {
    const onLimitReached = vi.fn();

    // Respond with a tool call (forces next iteration), but maxTurns=1 so loop exits
    vi.mocked(fetch).mockResolvedValueOnce(toolCallResponse('get_dashboard_state', {}));

    const events = await collectEvents(
      runAgenticLoop(
        [userMsg('Do something')],
        INITIAL_STATE,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          ...BASE_OPTIONS,
          rateLimit: { maxTurnsPerRequest: 1, onLimitReached },
        },
      ),
    );

    const types = events.map((ev) => (ev as { type: string }).type);
    expect(types).toContain('error');
    expect(types).not.toContain('finish');

    const errorEvent = events.find((ev) => (ev as { type: string }).type === 'error') as {
      message: string;
    };
    expect(errorEvent.message).toMatch(/maximum turn limit/i);

    expect(onLimitReached).toHaveBeenCalledOnce();
    expect(onLimitReached.mock.calls[0][0]).toBe('turns');
    expect(onLimitReached.mock.calls[0][1].iterations).toBe(1);
  });

  it('accumulates token usage across multiple turns', async () => {
    // Turn 1: tool call (250 + 50 tokens), turn 2: text response (180 + 40 tokens)
    vi.mocked(fetch)
      .mockResolvedValueOnce(toolCallResponse('get_dashboard_state', {}))
      .mockResolvedValueOnce(textResponse('Done!', 180, 40));

    const events = await collectEvents(
      runAgenticLoop(
        [userMsg('Go')],
        INITIAL_STATE,
        undefined,
        undefined,
        undefined,
        undefined,
        BASE_OPTIONS,
      ),
    );

    const usageEvent = events.find((ev) => (ev as { type: string }).type === 'usage') as
      | {
          inputTokens: number;
          outputTokens: number;
          iterations: number;
        }
      | undefined;

    expect(usageEvent).toBeDefined();
    expect(usageEvent?.inputTokens).toBe(200 + 180);
    expect(usageEvent?.outputTokens).toBe(50 + 40);
    expect(usageEvent?.iterations).toBe(2);
  });
});

describe('runAgenticLoop — built-in tool gating', () => {
  beforeEach(() => {
    vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Run one text-only turn and return the tool names advertised to the model. */
  async function offeredToolNames(
    allowedTools: string[] | undefined,
    options: Record<string, unknown> = {},
  ): Promise<string[]> {
    vi.mocked(fetch).mockResolvedValueOnce(textResponse('ok', 10, 5));
    await collectEvents(
      runAgenticLoop(
        [userMsg('Hi')],
        INITIAL_STATE,
        undefined,
        undefined,
        allowedTools,
        undefined,
        { ...BASE_OPTIONS, ...options },
      ),
    );
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string) as {
      tools: { function: { name: string } }[];
    };
    return body.tools.map((t) => t.function.name);
  }

  it('does not advertise summarise_page by default (needs client-side row data)', async () => {
    const names = await offeredToolNames(undefined);
    expect(names).not.toContain('summarise_page');
  });

  it('does not advertise execute_query when no dataResolver is configured', async () => {
    const names = await offeredToolNames(undefined);
    expect(names).not.toContain('execute_query');
  });

  it('advertises execute_query when a dataResolver is configured', async () => {
    const names = await offeredToolNames(undefined, {
      dataResolver: { resolve: async () => ({ rows: [] }) },
    });
    expect(names).toContain('execute_query');
  });

  it('advertises summarise_page only when explicitly opted in via allowedTools', async () => {
    const names = await offeredToolNames(['summarise_page', 'get_dashboard_state']);
    expect(names).toContain('summarise_page');
  });
});

// ── Malformed tool arguments ────────────────────────────────────────────────────

describe('runAgenticLoop — malformed tool arguments', () => {
  beforeEach(() => {
    vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('feeds an error back to the model and does NOT execute the tool', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(malformedToolCallResponse('set_dashboard_title'))
      .mockResolvedValueOnce(textResponse('recovered', 10, 5));

    const events = await collectEvents(
      runAgenticLoop(
        [userMsg('Rename the dashboard')],
        INITIAL_STATE,
        undefined,
        undefined,
        undefined,
        undefined,
        BASE_OPTIONS,
      ),
    );

    // The tool never ran — no state mutation was produced by the coerced `{}`.
    expect(events.some((ev) => (ev as { type: string }).type === 'state-mutation')).toBe(false);

    const complete = events.find(
      (ev) =>
        (ev as { type: string }).type === 'tool-activity' &&
        (ev as { phase?: string }).phase === 'complete',
    ) as { output?: string } | undefined;
    expect(complete).toBeDefined();
    expect(String(complete?.output)).toContain('invalid tool arguments');

    // The loop recovers and finishes on the follow-up turn.
    expect(events.some((ev) => (ev as { type: string }).type === 'finish')).toBe(true);
  });
});

// ── Tool approval ───────────────────────────────────────────────────────────────

describe('runAgenticLoop — tool approval', () => {
  beforeEach(() => {
    vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('times out an unanswered approval, tells the model, and cleans up the map entry', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(toolCallResponse('remove_widget', { widgetId: 'w1' }))
      .mockResolvedValueOnce(textResponse('done', 10, 5));

    const approvalPending = new Map<string, (approved: boolean, reason?: string) => void>();

    const events = await collectEvents(
      runAgenticLoop(
        [userMsg('Remove the widget')],
        INITIAL_STATE,
        undefined,
        undefined,
        undefined,
        undefined,
        { ...BASE_OPTIONS, approvalPending, approvalTimeoutMs: 20 },
      ),
    );

    expect(events.some((ev) => (ev as { type: string }).type === 'tool-approval-request')).toBe(
      true,
    );

    const timedOut = events.find(
      (ev) =>
        (ev as { type: string }).type === 'tool-activity' &&
        (ev as { phase?: string }).phase === 'complete' &&
        String((ev as { output?: string }).output).includes('approval timed out'),
    );
    expect(timedOut).toBeDefined();

    // The pending entry is always removed — no leak.
    expect(approvalPending.size).toBe(0);
    // The loop recovers and finishes.
    expect(events.some((ev) => (ev as { type: string }).type === 'finish')).toBe(true);
  });

  it('ends silently when the request is aborted during an approval wait', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(toolCallResponse('remove_widget', { widgetId: 'w1' }));

    const approvalPending = new Map<string, (approved: boolean, reason?: string) => void>();
    const ac = new AbortController();

    const gen = runAgenticLoop(
      [userMsg('Remove the widget')],
      INITIAL_STATE,
      undefined,
      undefined,
      undefined,
      undefined,
      { ...BASE_OPTIONS, approvalPending, approvalTimeoutMs: 60_000, signal: ac.signal },
    );

    const events: unknown[] = [];
    for await (const ev of gen) {
      events.push(ev);
      if ((ev as { type: string }).type === 'tool-approval-request') {
        // Simulate the client abandoning the request while we await approval.
        ac.abort();
      }
    }

    const types = events.map((ev) => (ev as { type: string }).type);
    expect(types).toContain('tool-approval-request');
    // Abort ends the stream silently — no finish, no error event.
    expect(types).not.toContain('finish');
    expect(types).not.toContain('error');
    // The pending entry is cleaned up even on abort.
    expect(approvalPending.size).toBe(0);
  });

  it('resolves an approved tool call and applies the mutation', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(toolCallResponse('remove_widget', { widgetId: 'w1' }))
      .mockResolvedValueOnce(textResponse('removed', 10, 5));

    // Seed a state that actually has the widget so removal succeeds post-approval.
    const state = createDefaultStudioState();
    const activePageId = state.dashboard.activePageId;
    const seeded = {
      ...state,
      widgets: {
        w1: { id: 'w1', kind: 'chart' as const, title: 'W1', sourceId: 's', config: {} },
      },
      pages: {
        ...state.pages,
        [activePageId]: { ...state.pages[activePageId], widgetRows: [['w1']] },
      },
    };

    const approvalPending = new Map<string, (approved: boolean, reason?: string) => void>();

    const gen = runAgenticLoop(
      [userMsg('Remove the widget')],
      seeded,
      undefined,
      undefined,
      undefined,
      undefined,
      { ...BASE_OPTIONS, approvalPending, approvalTimeoutMs: 60_000 },
    );

    const events: unknown[] = [];
    for await (const ev of gen) {
      events.push(ev);
      if ((ev as { type: string }).type === 'tool-approval-request') {
        const id = (ev as { toolCallId: string }).toolCallId;
        // The loop registers its resolver only once it resumes past this yield, so
        // grant approval on the next tick when the map entry exists.
        setTimeout(() => approvalPending.get(id)?.(true), 0);
      }
    }

    expect(events.some((ev) => (ev as { type: string }).type === 'state-mutation')).toBe(true);
    expect(approvalPending.size).toBe(0);
    expect(events.some((ev) => (ev as { type: string }).type === 'finish')).toBe(true);
  });
});
