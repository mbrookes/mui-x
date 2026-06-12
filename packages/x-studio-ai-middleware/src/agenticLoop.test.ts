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
  const body = chunks.map(sseChunk).join('') + 'data: [DONE]\n\n';
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

/** A single-turn response that calls a tool, then (next turn) returns text. */
function toolCallResponse(toolName: string, args: object): Response {
  return makeSseResponse([
    {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: 'tc_1', function: { name: toolName, arguments: '' } },
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
              { index: 0, function: { arguments: JSON.stringify(args) } },
            ],
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

    const usageEvent = events.find((e) => (e as { type: string }).type === 'usage') as {
      type: string;
      inputTokens: number;
      outputTokens: number;
      iterations: number;
    } | undefined;

    expect(usageEvent).toBeDefined();
    expect(usageEvent?.inputTokens).toBe(150);
    expect(usageEvent?.outputTokens).toBe(30);
    expect(usageEvent?.iterations).toBe(1);

    const types = events.map((e) => (e as { type: string }).type);
    const usageIdx = types.indexOf('usage');
    const finishIdx = types.indexOf('finish');
    expect(usageIdx).toBeGreaterThanOrEqual(0);
    expect(finishIdx).toBeGreaterThan(usageIdx);
  });

  it('stops the loop and emits an error when maxTokensPerRequest is exceeded', async () => {
    const onLimitReached = vi.fn();

    // First turn: tool call response that costs 300 tokens (over the 200 limit).
    // The loop detects the overage after the turn before trying to continue.
    vi.mocked(fetch).mockResolvedValueOnce(
      toolCallResponse('get_dashboard_state', {}),
    );

    const events = await collectEvents(
      runAgenticLoop(
        [userMsg('Hi')],
        INITIAL_STATE,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          ...BASE_OPTIONS,
          rateLimit: { maxTokensPerRequest: 200, onLimitReached },
        },
      ),
    );

    const types = events.map((e) => (e as { type: string }).type);
    expect(types).toContain('error');
    expect(types).not.toContain('finish');

    const errorEvent = events.find((e) => (e as { type: string }).type === 'error') as {
      message: string;
    };
    expect(errorEvent.message).toMatch(/token budget exceeded/i);

    expect(onLimitReached).toHaveBeenCalledOnce();
    expect(onLimitReached).toHaveBeenCalledWith('tokens', {
      inputTokens: 200,
      outputTokens: 50,
      iterations: 1,
    });
  });

  it('does not stop the loop when token usage is within maxTokensPerRequest', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(textResponse('OK', 100, 20));

    const onLimitReached = vi.fn();
    const events = await collectEvents(
      runAgenticLoop(
        [userMsg('Hi')],
        INITIAL_STATE,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          ...BASE_OPTIONS,
          rateLimit: { maxTokensPerRequest: 500, onLimitReached },
        },
      ),
    );

    const types = events.map((e) => (e as { type: string }).type);
    expect(types).toContain('finish');
    expect(types).not.toContain('error');
    expect(onLimitReached).not.toHaveBeenCalled();
  });

  it('respects maxTurnsPerRequest and calls onLimitReached with "turns"', async () => {
    const onLimitReached = vi.fn();

    // Respond with a tool call (forces next iteration), but maxTurns=1 so loop exits
    vi.mocked(fetch).mockResolvedValueOnce(
      toolCallResponse('get_dashboard_state', {}),
    );

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

    const types = events.map((e) => (e as { type: string }).type);
    expect(types).toContain('error');
    expect(types).not.toContain('finish');

    const errorEvent = events.find((e) => (e as { type: string }).type === 'error') as {
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

    const usageEvent = events.find((e) => (e as { type: string }).type === 'usage') as {
      inputTokens: number;
      outputTokens: number;
      iterations: number;
    } | undefined;

    expect(usageEvent).toBeDefined();
    expect(usageEvent?.inputTokens).toBe(200 + 180);
    expect(usageEvent?.outputTokens).toBe(50 + 40);
    expect(usageEvent?.iterations).toBe(2);
  });
});
