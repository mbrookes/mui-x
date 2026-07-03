/**
 * Tests for rate limiting in runAgenticLoop.
 *
 * Mocks `fetch` to return pre-built SSE streams so no real LLM calls are made.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runAgenticLoop } from './agenticLoop';
import { createDefaultStudioState } from './models/studioTypes';
import type { StudioAISkill, StudioDataResolver } from './models/aiTypes';
import type { SerializableSkill } from './models/protocol';

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

/**
 * A tool call whose streamed deltas carry an `id` but never an `index` — the
 * fallback path in the accumulation loop that keys tool-call slots by `id`
 * instead of `index`.
 */
function toolCallResponseNoIndex(toolCallId: string, toolName: string, args: object): Response {
  return makeSseResponse([
    {
      choices: [
        {
          delta: {
            tool_calls: [{ id: toolCallId, function: { name: toolName, arguments: '' } }],
          },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [{ id: toolCallId, function: { arguments: JSON.stringify(args) } }],
          },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ]);
}

/**
 * Two concurrent tool calls, both accumulated purely via `id` (no `index` on
 * any delta), interleaved across chunks.
 */
function multiToolCallResponseNoIndex(): Response {
  return makeSseResponse([
    {
      choices: [
        {
          delta: {
            tool_calls: [
              { id: 'tc_a', function: { name: 'get_dashboard_state', arguments: '' } },
              { id: 'tc_b', function: { name: 'list_pages', arguments: '' } },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [
              { id: 'tc_a', function: { arguments: '{}' } },
              { id: 'tc_b', function: { arguments: '{}' } },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
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

// ── Server-tool skills ──────────────────────────────────────────────────────────

describe('runAgenticLoop — server-tool skill execution', () => {
  beforeEach(() => {
    vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeSkill(execute: NonNullable<StudioAISkill['tool']>['execute']): StudioAISkill {
    return {
      name: 'greeting_skill',
      mode: 'server-tool',
      promptFragment: 'Use greet_user to greet the user by name.',
      tool: {
        name: 'greet_user',
        description: 'Greets the user by name.',
        parameters: { type: 'object', properties: { name: { type: 'string' } } },
        execute,
      },
    };
  }

  it('executes a registered server-tool skill and applies its mutation', async () => {
    const execute = vi.fn((args: Record<string, unknown>, state) => ({
      output: JSON.stringify({ greeted: args.name }),
      mutation: { type: 'setDashboardTitle' as const, args: { title: `Hi, ${args.name}` } },
      nextState: { ...state, dashboard: { ...state.dashboard, title: `Hi, ${args.name}` } },
    }));
    const skill = makeSkill(execute);

    vi.mocked(fetch)
      .mockResolvedValueOnce(toolCallResponse('greet_user', { name: 'Ada' }))
      .mockResolvedValueOnce(textResponse('done', 10, 5));

    const events = await collectEvents(
      runAgenticLoop(
        [userMsg('Greet Ada')],
        INITIAL_STATE,
        undefined,
        undefined,
        undefined,
        [skill as unknown as SerializableSkill],
        { ...BASE_OPTIONS, skillHandlers: [skill] },
      ),
    );

    expect(execute).toHaveBeenCalledExactlyOnceWith({ name: 'Ada' }, INITIAL_STATE);

    const mutationEvent = events.find(
      (ev) => (ev as { type: string }).type === 'state-mutation',
    ) as { mutation: { type: string; args: { title: string } } } | undefined;
    expect(mutationEvent).toBeDefined();
    expect(mutationEvent?.mutation).toEqual({
      type: 'setDashboardTitle',
      args: { title: 'Hi, Ada' },
    });

    const complete = events.find(
      (ev) =>
        (ev as { type: string; toolName?: string }).type === 'tool-activity' &&
        (ev as { toolName?: string }).toolName === 'greet_user' &&
        (ev as { phase?: string }).phase === 'complete',
    ) as { output?: string } | undefined;
    expect(complete).toBeDefined();
    expect(JSON.parse(complete!.output!)).toEqual({ greeted: 'Ada' });

    expect(events.some((ev) => (ev as { type: string }).type === 'finish')).toBe(true);
  });

  it('catches a throwing server-tool skill, reports via onToolError, and feeds {error} back', async () => {
    const execute = vi.fn(() => {
      throw new Error('skill blew up');
    });
    const skill = makeSkill(execute);
    const onToolError = vi.fn();

    vi.mocked(fetch)
      .mockResolvedValueOnce(toolCallResponse('greet_user', { name: 'Ada' }))
      .mockResolvedValueOnce(textResponse('recovered', 10, 5));

    const events = await collectEvents(
      runAgenticLoop(
        [userMsg('Greet Ada')],
        INITIAL_STATE,
        undefined,
        undefined,
        undefined,
        [skill as unknown as SerializableSkill],
        { ...BASE_OPTIONS, skillHandlers: [skill], onToolError },
      ),
    );

    expect(onToolError).toHaveBeenCalledExactlyOnceWith('greet_user', expect.any(Error));
    expect((onToolError.mock.calls[0][1] as Error).message).toBe('skill blew up');

    // No mutation was applied — the loop didn't crash on the throw.
    expect(events.some((ev) => (ev as { type: string }).type === 'state-mutation')).toBe(false);

    const complete = events.find(
      (ev) =>
        (ev as { type: string; toolName?: string }).type === 'tool-activity' &&
        (ev as { toolName?: string }).toolName === 'greet_user' &&
        (ev as { phase?: string }).phase === 'complete',
    ) as { output?: string } | undefined;
    expect(complete).toBeDefined();
    expect(JSON.parse(complete!.output!)).toEqual({ error: 'skill blew up' });

    // The generator did not crash: it fed the error back to the model and finished.
    expect(events.some((ev) => (ev as { type: string }).type === 'finish')).toBe(true);
  });
});

// ── execute_query execution ─────────────────────────────────────────────────────

describe('runAgenticLoop — execute_query execution', () => {
  beforeEach(() => {
    vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves via the configured dataResolver and feeds the result back to the model', async () => {
    const resolve = vi.fn(async (query: string, sourceId?: string) => ({
      rows: [{ a: 1 }],
      columns: ['a'],
      totalCount: 1,
      _query: query,
      _sourceId: sourceId,
    }));
    const dataResolver: StudioDataResolver = { resolve: resolve as StudioDataResolver['resolve'] };

    vi.mocked(fetch)
      .mockResolvedValueOnce(
        toolCallResponse('execute_query', { query: 'SELECT 1', sourceId: 'src1' }),
      )
      .mockResolvedValueOnce(textResponse('done', 10, 5));

    const events = await collectEvents(
      runAgenticLoop(
        [userMsg('Run a query')],
        INITIAL_STATE,
        undefined,
        undefined,
        undefined,
        undefined,
        { ...BASE_OPTIONS, dataResolver },
      ),
    );

    expect(resolve).toHaveBeenCalledExactlyOnceWith('SELECT 1', 'src1');

    const complete = events.find(
      (ev) =>
        (ev as { type: string; toolName?: string }).type === 'tool-activity' &&
        (ev as { toolName?: string }).toolName === 'execute_query' &&
        (ev as { phase?: string }).phase === 'complete',
    ) as { output?: string } | undefined;
    expect(complete).toBeDefined();
    expect(JSON.parse(complete!.output!)).toMatchObject({ rows: [{ a: 1 }], totalCount: 1 });

    expect(events.some((ev) => (ev as { type: string }).type === 'finish')).toBe(true);
  });

  it('catches a rejected dataResolver.resolve(), reports via onToolError, and feeds {error} back', async () => {
    const dataResolver: StudioDataResolver = {
      resolve: vi.fn(async () => {
        throw new Error('query failed: syntax error');
      }),
    };
    const onToolError = vi.fn();

    vi.mocked(fetch)
      .mockResolvedValueOnce(toolCallResponse('execute_query', { query: 'BAD SQL' }))
      .mockResolvedValueOnce(textResponse('recovered', 10, 5));

    const events = await collectEvents(
      runAgenticLoop(
        [userMsg('Run a bad query')],
        INITIAL_STATE,
        undefined,
        undefined,
        undefined,
        undefined,
        { ...BASE_OPTIONS, dataResolver, onToolError },
      ),
    );

    expect(onToolError).toHaveBeenCalledExactlyOnceWith('execute_query', expect.any(Error));
    expect((onToolError.mock.calls[0][1] as Error).message).toBe('query failed: syntax error');

    const complete = events.find(
      (ev) =>
        (ev as { type: string; toolName?: string }).type === 'tool-activity' &&
        (ev as { toolName?: string }).toolName === 'execute_query' &&
        (ev as { phase?: string }).phase === 'complete',
    ) as { output?: string } | undefined;
    expect(complete).toBeDefined();
    expect(JSON.parse(complete!.output!)).toEqual({ error: 'query failed: syntax error' });

    // The generator recovers instead of crashing.
    expect(events.some((ev) => (ev as { type: string }).type === 'finish')).toBe(true);
  });
});

// ── Unregistered skill fallback ──────────────────────────────────────────────────

describe('runAgenticLoop — unregistered skill fallback', () => {
  beforeEach(() => {
    vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a descriptive error when a declared server-tool skill has no handler', async () => {
    const declaredSkill: SerializableSkill = {
      name: 'orphan_skill',
      mode: 'server-tool',
      promptFragment: 'Use orphan_tool for something.',
      tool: {
        name: 'orphan_tool',
        description: 'A tool declared by the client but never registered on the server.',
        parameters: { type: 'object', properties: {} },
      },
    };

    vi.mocked(fetch)
      .mockResolvedValueOnce(toolCallResponse('orphan_tool', {}))
      .mockResolvedValueOnce(textResponse('recovered', 10, 5));

    const events = await collectEvents(
      runAgenticLoop(
        [userMsg('Use the orphan tool')],
        INITIAL_STATE,
        undefined,
        undefined,
        undefined,
        [declaredSkill],
        // Note: no `skillHandlers` passed — the skill is declared but unregistered.
        BASE_OPTIONS,
      ),
    );

    // No crash, no silent no-op: the tool call gets an informative error result.
    expect(events.some((ev) => (ev as { type: string }).type === 'state-mutation')).toBe(false);

    const complete = events.find(
      (ev) =>
        (ev as { type: string; toolName?: string }).type === 'tool-activity' &&
        (ev as { toolName?: string }).toolName === 'orphan_tool' &&
        (ev as { phase?: string }).phase === 'complete',
    ) as { output?: string } | undefined;
    expect(complete).toBeDefined();
    const parsed = JSON.parse(complete!.output!) as { error?: string };
    expect(parsed.error).toMatch(/no registered handler/i);
    expect(parsed.error).toContain('orphan_tool');

    // The loop recovers and finishes on the follow-up turn.
    expect(events.some((ev) => (ev as { type: string }).type === 'finish')).toBe(true);
  });
});

// ── Tool-call delta accumulation fallback ────────────────────────────────────────

describe('runAgenticLoop — tool-call delta accumulation fallback (id without index)', () => {
  beforeEach(() => {
    vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accumulates a single tool call whose deltas carry an id but never an index', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        toolCallResponseNoIndex('tc_1', 'set_dashboard_title', { title: 'Reassembled Title' }),
      )
      .mockResolvedValueOnce(textResponse('done', 10, 5));

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

    // The arguments split across the two id-only deltas must be accumulated into
    // one coherent tool call rather than lost or corrupted.
    const start = events.find(
      (ev) =>
        (ev as { type: string }).type === 'tool-activity' &&
        (ev as { phase?: string }).phase === 'start',
    ) as { input?: unknown } | undefined;
    expect(start).toBeDefined();
    expect(start?.input).toEqual({ title: 'Reassembled Title' });

    expect(events.some((ev) => (ev as { type: string }).type === 'state-mutation')).toBe(true);
    const mutationEvent = events.find(
      (ev) => (ev as { type: string }).type === 'state-mutation',
    ) as { mutation: { type: string; args: { title: string } } } | undefined;
    expect(mutationEvent?.mutation).toEqual({
      type: 'setDashboardTitle',
      args: { title: 'Reassembled Title' },
    });

    expect(events.some((ev) => (ev as { type: string }).type === 'finish')).toBe(true);
  });

  it('accumulates two concurrent tool calls keyed purely by id (no index on any delta)', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(multiToolCallResponseNoIndex())
      .mockResolvedValueOnce(textResponse('done', 10, 5));

    const events = await collectEvents(
      runAgenticLoop(
        [userMsg('Do two things')],
        INITIAL_STATE,
        undefined,
        undefined,
        undefined,
        undefined,
        BASE_OPTIONS,
      ),
    );

    const completeEvents = events.filter(
      (ev) =>
        (ev as { type: string }).type === 'tool-activity' &&
        (ev as { phase?: string }).phase === 'complete',
    ) as Array<{ toolName: string; output?: string }>;

    // Both distinct tool calls ran (not merged/collapsed into a single slot) and
    // neither call's arguments were corrupted by the other.
    const toolNames = completeEvents.map((ev) => ev.toolName).sort();
    expect(toolNames).toEqual(['get_dashboard_state', 'list_pages']);
    completeEvents.forEach((ev) => {
      expect(() => JSON.parse(ev.output ?? '')).not.toThrow();
    });

    expect(events.some((ev) => (ev as { type: string }).type === 'finish')).toBe(true);
  });
});

// ── Tool gating enforcement (T1-1) ───────────────────────────────────────────────

describe('runAgenticLoop — tool gating enforcement (T1-1)', () => {
  beforeEach(() => {
    vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects an unadvertised tool call instead of executing it', async () => {
    // Read-only assistant: only get_dashboard_state is advertised. A prompt-injected
    // remove_page call must be rejected at dispatch time, not executed.
    const state = createDefaultStudioState();
    const seeded = {
      ...state,
      pages: {
        ...state.pages,
        'page-extra': { id: 'page-extra', title: 'Extra', widgetRows: [] as string[][] },
      },
    };

    vi.mocked(fetch)
      .mockResolvedValueOnce(toolCallResponse('remove_page', { pageId: 'page-extra' }))
      .mockResolvedValueOnce(textResponse('ok', 10, 5));

    const events = await collectEvents(
      runAgenticLoop(
        [userMsg('Delete a page')],
        seeded,
        undefined,
        undefined,
        ['get_dashboard_state'],
        undefined,
        BASE_OPTIONS,
      ),
    );

    // The excluded tool never mutated state, even though the page exists.
    expect(events.some((ev) => (ev as { type: string }).type === 'state-mutation')).toBe(false);

    const complete = events.find(
      (ev) =>
        (ev as { type: string }).type === 'tool-activity' &&
        (ev as { phase?: string }).phase === 'complete' &&
        (ev as { toolName?: string }).toolName === 'remove_page',
    ) as { output?: string } | undefined;
    expect(complete).toBeDefined();
    const parsed = JSON.parse(complete!.output!) as { error?: string };
    expect(parsed.error).toMatch(/unknown tool/i);
    expect(parsed.error).toContain('remove_page');

    // The loop recovers and finishes on the follow-up turn.
    expect(events.some((ev) => (ev as { type: string }).type === 'finish')).toBe(true);
  });

  it('does not run execute_query when it is excluded from allowedTools even with a resolver', async () => {
    const resolve = vi.fn(async () => ({ rows: [{ secret: 1 }] }));
    const dataResolver: StudioDataResolver = { resolve: resolve as StudioDataResolver['resolve'] };

    vi.mocked(fetch)
      .mockResolvedValueOnce(toolCallResponse('execute_query', { query: 'SELECT * FROM secrets' }))
      .mockResolvedValueOnce(textResponse('ok', 10, 5));

    const events = await collectEvents(
      runAgenticLoop(
        [userMsg('Run a query')],
        INITIAL_STATE,
        undefined,
        undefined,
        ['get_dashboard_state'],
        undefined,
        { ...BASE_OPTIONS, dataResolver },
      ),
    );

    // The resolver was never invoked — no raw SQL ran through it.
    expect(resolve).not.toHaveBeenCalled();

    const complete = events.find(
      (ev) =>
        (ev as { type: string }).type === 'tool-activity' &&
        (ev as { phase?: string }).phase === 'complete' &&
        (ev as { toolName?: string }).toolName === 'execute_query',
    ) as { output?: string } | undefined;
    expect(complete).toBeDefined();
    expect(JSON.parse(complete!.output!).error).toMatch(/unknown tool/i);
  });
});

// ── privateMode tool gating (T1-2) ───────────────────────────────────────────────

describe('runAgenticLoop — privateMode tool gating (T1-2)', () => {
  beforeEach(() => {
    vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function offeredToolNames(options: Record<string, unknown>): Promise<string[]> {
    vi.mocked(fetch).mockResolvedValueOnce(textResponse('ok', 10, 5));
    await collectEvents(
      runAgenticLoop([userMsg('Hi')], INITIAL_STATE, undefined, undefined, undefined, undefined, {
        ...BASE_OPTIONS,
        ...options,
      }),
    );
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string) as {
      tools: { function: { name: string } }[];
    };
    return body.tools.map((t) => t.function.name);
  }

  it('excludes get_dashboard_state, list_pages, and summarise_page from the advertised set', async () => {
    // pageSnapshot would normally enable summarise_page; privateMode still wins.
    const names = await offeredToolNames({ privateMode: true, pageSnapshot: 'snapshot' });
    expect(names).not.toContain('get_dashboard_state');
    expect(names).not.toContain('list_pages');
    expect(names).not.toContain('summarise_page');
    // Non-state-reading tools are still offered.
    expect(names).toContain('set_dashboard_title');
  });

  it('excludes execute_query in privateMode even when a dataResolver is configured', async () => {
    // A resolver would normally advertise execute_query; privateMode still wins,
    // because its output is live database rows sent straight to the provider.
    const names = await offeredToolNames({
      privateMode: true,
      dataResolver: { resolve: async () => ({ rows: [] }) },
    });
    expect(names).not.toContain('execute_query');
  });

  it('advertises execute_query when a dataResolver is configured and privateMode is off', async () => {
    const names = await offeredToolNames({
      dataResolver: { resolve: async () => ({ rows: [] }) },
    });
    expect(names).toContain('execute_query');
  });

  it('rejects a get_dashboard_state call in privateMode and never round-trips state to the provider', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(toolCallResponse('get_dashboard_state', {}))
      .mockResolvedValueOnce(textResponse('ok', 10, 5));

    const events = await collectEvents(
      runAgenticLoop(
        [userMsg('Show me everything')],
        INITIAL_STATE,
        undefined,
        undefined,
        undefined,
        undefined,
        { ...BASE_OPTIONS, privateMode: true },
      ),
    );

    const complete = events.find(
      (ev) =>
        (ev as { type: string }).type === 'tool-activity' &&
        (ev as { phase?: string }).phase === 'complete' &&
        (ev as { toolName?: string }).toolName === 'get_dashboard_state',
    ) as { output?: string } | undefined;
    expect(complete).toBeDefined();
    expect(JSON.parse(complete!.output!).error).toMatch(/unknown tool/i);

    // The tool result fed back to the provider on the next turn is the rejection,
    // not the dashboard JSON that privateMode promised to withhold.
    const secondBody = JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string) as {
      messages: { role: string; content: string }[];
    };
    const toolMsg = secondBody.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toMatch(/unknown tool/i);

    expect(events.some((ev) => (ev as { type: string }).type === 'finish')).toBe(true);
  });
});
