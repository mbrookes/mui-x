import { describe, expect, it, vi } from 'vitest';
import { createBackendChatAdapter } from './studioBackendAdapter';
import { createDefaultStudioState } from '../../models/stateTypes';
import type { StudioController } from '../../store/StudioController';
import type { StudioAIConfig } from './studioBackendAdapter';
import type { ChatMessage, ChatMessageChunk, ChatStreamEnvelope } from '@mui/x-chat/headless';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeController(): StudioController {
  const state = createDefaultStudioState({
    dashboard: { id: 'd1', title: 'Dashboard', activePageId: 'page-1' },
    pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [] } },
    widgets: {},
  });

  return {
    getState: vi.fn(() => state),
    setState: vi.fn(),
    setDashboardTitle: vi.fn(),
    addPage: vi.fn(),
    removePage: vi.fn(),
    renamePage: vi.fn(),
    setActivePage: vi.fn(),
    addWidget: vi.fn(),
    removeWidget: vi.fn(),
    updateWidget: vi.fn(),
    updateWidgetConfig: vi.fn(),
    moveWidgetToPage: vi.fn(),
    duplicateWidget: vi.fn(),
    addFilter: vi.fn(),
    removeFilter: vi.fn(),
    setWidgetLayout: vi.fn(),
    setWidgetColSpanInRow: vi.fn(),
    clearSelection: vi.fn(),
    setDrawerOpen: vi.fn(),
    selectWidget: vi.fn(),
  } as unknown as StudioController;
}

function makeSseBody(events: object[]): Uint8Array {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  return new TextEncoder().encode(text);
}

let messageIndex = 0;

function makeUserMessage(text: string): ChatMessage {
  return {
    id: `m-${messageIndex++}`,
    role: 'user',
    parts: [{ type: 'text', text }],
  };
}

function makeSendInput(messages: ChatMessage[] = [makeUserMessage('')]) {
  const safeMessages = messages.length > 0 ? messages : [makeUserMessage('')];
  return {
    message: safeMessages[safeMessages.length - 1],
    messages: safeMessages,
    signal: new AbortController().signal,
  };
}

async function collectChunks(
  stream: ReadableStream<ChatMessageChunk | ChatStreamEnvelope>,
): Promise<(ChatMessageChunk | ChatStreamEnvelope)[]> {
  const reader = stream.getReader();
  const chunks: (ChatMessageChunk | ChatStreamEnvelope)[] = [];
  let done = false;
  while (!done) {
    const result = await reader.read();
    done = result.done;
    if (result.value) {
      chunks.push(result.value);
    }
  }
  return chunks;
}

function isChatMessageChunk(chunk: ChatMessageChunk | ChatStreamEnvelope): chunk is ChatMessageChunk {
  return 'type' in chunk;
}

function mockFetch(ssePayload: Uint8Array) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(ssePayload);
          ctrl.close();
        },
      }),
    }),
  );
}

// ── text-delta handling ───────────────────────────────────────────────────────

describe('createBackendChatAdapter: text-delta', () => {
  it('enqueues text-start + text-delta + text-end from SSE text-delta events', async () => {
    const sse = makeSseBody([
      { type: 'text-delta', delta: 'Hello' },
      { type: 'text-delta', delta: ' world' },
      { type: 'finish', finishReason: 'stop' },
    ]);
    mockFetch(sse);

    const config: StudioAIConfig = { endpoint: 'https://fake.test/api/ai' };
    const adapter = createBackendChatAdapter(config, makeController());
    const stream = await adapter.sendMessage(makeSendInput([makeUserMessage('Hi')]));

    const chunks = await collectChunks(stream);
    const chatChunks = chunks.filter(isChatMessageChunk);
    const types = chatChunks.map((c) => c.type);

    expect(types).toContain('text-start');
    expect(types).toContain('text-delta');
    expect(types).toContain('text-end');
    expect(types).toContain('finish');

    const deltaChunks = chatChunks.filter((c) => c.type === 'text-delta');
    const deltas = deltaChunks.map((c) => (c as { type: 'text-delta'; delta: string }).delta);
    expect(deltas).toEqual(['Hello', ' world']);

    vi.unstubAllGlobals();
  });

  it('does not emit text-start/text-end when there are no text deltas', async () => {
    const sse = makeSseBody([{ type: 'finish', finishReason: 'stop' }]);
    mockFetch(sse);

    const config: StudioAIConfig = { endpoint: 'https://fake.test/api/ai' };
    const adapter = createBackendChatAdapter(config, makeController());
    const stream = await adapter.sendMessage(makeSendInput([]));

    const chunks = await collectChunks(stream);
    const chatChunks = chunks.filter(isChatMessageChunk);
    const types = chatChunks.map((c) => c.type);

    expect(types).not.toContain('text-start');
    expect(types).not.toContain('text-end');
    expect(types).toContain('finish');

    vi.unstubAllGlobals();
  });
});

// ── state-mutation handling ───────────────────────────────────────────────────

describe('createBackendChatAdapter: state-mutation', () => {
  it('applies a setDashboardTitle mutation to the controller', async () => {
    const sse = makeSseBody([
      {
        type: 'state-mutation',
        mutation: { type: 'setDashboardTitle', args: { title: 'Updated' } },
      },
      { type: 'finish', finishReason: 'stop' },
    ]);
    mockFetch(sse);

    const controller = makeController();
    const config: StudioAIConfig = { endpoint: 'https://fake.test/api/ai' };
    const adapter = createBackendChatAdapter(config, controller);
    const stream = await adapter.sendMessage(makeSendInput([]));

    await collectChunks(stream);
    expect(controller.setDashboardTitle).toHaveBeenCalledWith('Updated');

    vi.unstubAllGlobals();
  });

  it('applies a removeWidget mutation to the controller', async () => {
    const sse = makeSseBody([
      {
        type: 'state-mutation',
        mutation: { type: 'removeWidget', args: { widgetId: 'widget-1' } },
      },
      { type: 'finish', finishReason: 'stop' },
    ]);
    mockFetch(sse);

    const controller = makeController();
    const config: StudioAIConfig = { endpoint: 'https://fake.test/api/ai' };
    const adapter = createBackendChatAdapter(config, controller);
    const stream = await adapter.sendMessage(makeSendInput([]));

    await collectChunks(stream);
    expect(controller.removeWidget).toHaveBeenCalledWith('widget-1');

    vi.unstubAllGlobals();
  });
});

// ── tool-activity handling ────────────────────────────────────────────────────

describe('createBackendChatAdapter: tool-activity', () => {
  it('emits tool-input-start on phase start', async () => {
    const sse = makeSseBody([
      {
        type: 'tool-activity',
        toolCallId: 'call-1',
        toolName: 'add_widget',
        phase: 'start',
        input: { kind: 'chart', title: 'Test' },
      },
      {
        type: 'tool-activity',
        toolCallId: 'call-1',
        toolName: 'add_widget',
        phase: 'complete',
        output: '{"success":true}',
      },
      { type: 'finish', finishReason: 'stop' },
    ]);
    mockFetch(sse);

    const config: StudioAIConfig = { endpoint: 'https://fake.test/api/ai' };
    const adapter = createBackendChatAdapter(config, makeController());
    const stream = await adapter.sendMessage(makeSendInput([]));

    const chunks = await collectChunks(stream);
    const chatChunks = chunks.filter(isChatMessageChunk);
    const types = chatChunks.map((c) => c.type);

    expect(types).toContain('tool-input-start');
    expect(types).toContain('tool-input-delta');
    expect(types).toContain('tool-output-available');

    vi.unstubAllGlobals();
  });
});

// ── error handling ────────────────────────────────────────────────────────────

describe('createBackendChatAdapter: error events', () => {
  it('rejects the stream on a server error event', async () => {
    const sse = makeSseBody([{ type: 'error', message: 'Internal server error' }]);
    mockFetch(sse);

    const config: StudioAIConfig = { endpoint: 'https://fake.test/api/ai' };
    const adapter = createBackendChatAdapter(config, makeController());
    const stream = await adapter.sendMessage(makeSendInput([]));

    await expect(collectChunks(stream)).rejects.toThrow('Internal server error');

    vi.unstubAllGlobals();
  });

  it('rejects the stream on a non-ok HTTP response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: () => Promise.resolve('Upstream failure'),
      }),
    );

    const config: StudioAIConfig = { endpoint: 'https://fake.test/api/ai' };
    const adapter = createBackendChatAdapter(config, makeController());
    const stream = await adapter.sendMessage(makeSendInput([]));

    await expect(collectChunks(stream)).rejects.toThrow('HTTP 500');

    vi.unstubAllGlobals();
  });
});

// ── synthetic reasoning ("Thinking…") ────────────────────────────────────────

describe('createBackendChatAdapter: synthetic reasoning', () => {
  it('emits reasoning-start immediately before the fetch resolves', async () => {
    const sse = makeSseBody([
      { type: 'text-delta', delta: 'Hi' },
      { type: 'finish', finishReason: 'stop' },
    ]);
    mockFetch(sse);

    const config: StudioAIConfig = { endpoint: 'https://fake.test/api/ai' };
    const adapter = createBackendChatAdapter(config, makeController());
    const stream = await adapter.sendMessage(makeSendInput([makeUserMessage('Hello')]));

    const chunks = await collectChunks(stream);
    const chatChunks = chunks.filter(isChatMessageChunk);
    const types = chatChunks.map((c) => c.type);

    // reasoning-start must appear before the first text-start
    const reasoningStartIdx = types.indexOf('reasoning-start');
    const textStartIdx = types.indexOf('text-start');
    expect(reasoningStartIdx).toBeGreaterThanOrEqual(0);
    expect(reasoningStartIdx).toBeLessThan(textStartIdx);

    vi.unstubAllGlobals();
  });

  it('emits reasoning-end before the first text-delta', async () => {
    const sse = makeSseBody([
      { type: 'text-delta', delta: 'Answer' },
      { type: 'finish', finishReason: 'stop' },
    ]);
    mockFetch(sse);

    const config: StudioAIConfig = { endpoint: 'https://fake.test/api/ai' };
    const adapter = createBackendChatAdapter(config, makeController());
    const stream = await adapter.sendMessage(makeSendInput([makeUserMessage('?')]));

    const chunks = await collectChunks(stream);
    const chatChunks = chunks.filter(isChatMessageChunk);
    const types = chatChunks.map((c) => c.type);

    const reasoningEndIdx = types.indexOf('reasoning-end');
    const textDeltaIdx = types.indexOf('text-delta');
    expect(reasoningEndIdx).toBeGreaterThanOrEqual(0);
    expect(reasoningEndIdx).toBeLessThan(textDeltaIdx);

    vi.unstubAllGlobals();
  });

  it('emits reasoning-end before the first tool-activity', async () => {
    const sse = makeSseBody([
      {
        type: 'tool-activity',
        toolCallId: 'call-1',
        toolName: 'add_widget',
        phase: 'start',
        input: {},
      },
      {
        type: 'tool-activity',
        toolCallId: 'call-1',
        toolName: 'add_widget',
        phase: 'complete',
        output: '{}',
      },
      { type: 'finish', finishReason: 'stop' },
    ]);
    mockFetch(sse);

    const config: StudioAIConfig = { endpoint: 'https://fake.test/api/ai' };
    const adapter = createBackendChatAdapter(config, makeController());
    const stream = await adapter.sendMessage(makeSendInput([makeUserMessage('add widget')]));

    const chunks = await collectChunks(stream);
    const chatChunks = chunks.filter(isChatMessageChunk);
    const types = chatChunks.map((c) => c.type);

    const reasoningEndIdx = types.indexOf('reasoning-end');
    const toolStartIdx = types.indexOf('tool-input-start');
    expect(reasoningEndIdx).toBeGreaterThanOrEqual(0);
    expect(reasoningEndIdx).toBeLessThan(toolStartIdx);

    vi.unstubAllGlobals();
  });

  it('emits reasoning-end on finish even when there is no text or tool activity', async () => {
    const sse = makeSseBody([{ type: 'finish', finishReason: 'stop' }]);
    mockFetch(sse);

    const config: StudioAIConfig = { endpoint: 'https://fake.test/api/ai' };
    const adapter = createBackendChatAdapter(config, makeController());
    const stream = await adapter.sendMessage(makeSendInput([]));

    const chunks = await collectChunks(stream);
    const chatChunks = chunks.filter(isChatMessageChunk);
    const types = chatChunks.map((c) => c.type);

    expect(types).toContain('reasoning-end');
    expect(types).toContain('finish');

    vi.unstubAllGlobals();
  });
});

// ── server-emitted reasoning events ──────────────────────────────────────────

describe('createBackendChatAdapter: server-emitted reasoning events', () => {
  it('forwards reasoning-start/delta/end from server and closes synthetic reasoning first', async () => {
    const sse = makeSseBody([
      { type: 'reasoning-start', id: 'r-server' },
      { type: 'reasoning-delta', id: 'r-server', delta: 'thinking...' },
      { type: 'reasoning-end', id: 'r-server' },
      { type: 'text-delta', delta: 'Done' },
      { type: 'finish', finishReason: 'stop' },
    ]);
    mockFetch(sse);

    const config: StudioAIConfig = { endpoint: 'https://fake.test/api/ai' };
    const adapter = createBackendChatAdapter(config, makeController());
    const stream = await adapter.sendMessage(makeSendInput([makeUserMessage('reason')]));

    const chunks = await collectChunks(stream);
    const chatChunks = chunks.filter(isChatMessageChunk);
    const types = chatChunks.map((c) => c.type);

    expect(types).toContain('reasoning-start');
    expect(types).toContain('reasoning-delta');
    expect(types).toContain('reasoning-end');

    // Verify delta content
    const deltaChunk = chatChunks.find(
      (c) => c.type === 'reasoning-delta',
    ) as { type: 'reasoning-delta'; delta: string } | undefined;
    expect(deltaChunk?.delta).toBe('thinking...');

    vi.unstubAllGlobals();
  });
});

// ── step-start → start-step ───────────────────────────────────────────────────

describe('createBackendChatAdapter: step-start → start-step', () => {
  it('converts step-start SSE event to start-step x-chat chunk', async () => {
    const sse = makeSseBody([
      { type: 'text-delta', delta: 'Turn 1' },
      { type: 'step-start', iteration: 1 },
      { type: 'text-delta', delta: 'Turn 2' },
      { type: 'finish', finishReason: 'stop' },
    ]);
    mockFetch(sse);

    const config: StudioAIConfig = { endpoint: 'https://fake.test/api/ai' };
    const adapter = createBackendChatAdapter(config, makeController());
    const stream = await adapter.sendMessage(makeSendInput([makeUserMessage('multi-turn')]));

    const chunks = await collectChunks(stream);
    const chatChunks = chunks.filter(isChatMessageChunk);
    const types = chatChunks.map((c) => c.type);

    expect(types).toContain('start-step');
    expect(types).not.toContain('step-start');

    vi.unstubAllGlobals();
  });
});

// ── message-metadata ──────────────────────────────────────────────────────────

describe('createBackendChatAdapter: message-metadata', () => {
  it('forwards message-metadata chunk with model and token counts', async () => {
    const metadata = { model: 'gpt-4o', inputTokens: 100, outputTokens: 50, iterations: 2 };
    const sse = makeSseBody([
      { type: 'message-metadata', metadata },
      { type: 'finish', finishReason: 'stop' },
    ]);
    mockFetch(sse);

    const config: StudioAIConfig = { endpoint: 'https://fake.test/api/ai' };
    const adapter = createBackendChatAdapter(config, makeController());
    const stream = await adapter.sendMessage(makeSendInput([]));

    const chunks = await collectChunks(stream);
    const chatChunks = chunks.filter(isChatMessageChunk);

    const metaChunk = chatChunks.find((c) => c.type === 'message-metadata') as
      | { type: 'message-metadata'; metadata: Record<string, unknown> }
      | undefined;

    expect(metaChunk).toBeDefined();
    expect(metaChunk?.metadata).toEqual(metadata);

    vi.unstubAllGlobals();
  });
});

// ── stop() / abort ────────────────────────────────────────────────────────────

describe('createBackendChatAdapter: stop()', () => {
  it('cancels the active reader when stop() is called', async () => {
    let readerRef: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const cancelSpy = vi.fn().mockResolvedValue(undefined);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        body: {
          getReader: () => {
            const reader = {
              read: vi.fn().mockImplementation(() => new Promise(() => {})), // never resolves
              cancel: cancelSpy,
              releaseLock: vi.fn(),
            };
            readerRef = reader as unknown as ReadableStreamDefaultReader<Uint8Array>;
            return reader;
          },
        },
      }),
    );

    const config: StudioAIConfig = { endpoint: 'https://fake.test/api/ai' };
    const adapter = createBackendChatAdapter(config, makeController());

    // Start a stream but don't await it (it will hang)
    adapter.sendMessage(makeSendInput([makeUserMessage('stop me')])).then((stream) => {
      stream.getReader().read().catch(() => {});
    });

    // Give the async start() function time to reach reader.read()
    await new Promise((resolve) => setTimeout(resolve, 10));

    adapter.stop();

    // Give the stop() microtask time to run
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(cancelSpy).toHaveBeenCalled();
    expect(readerRef).not.toBeNull();

    vi.unstubAllGlobals();
  });
});

describe('createBackendChatAdapter: abort signal', () => {
  it('emits abort chunk when the fetch is aborted via signal', async () => {
    const ac = new AbortController();

    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(Object.assign(new DOMException('Aborted', 'AbortError'), {})),
    );

    const config: StudioAIConfig = { endpoint: 'https://fake.test/api/ai' };
    const adapter = createBackendChatAdapter(config, makeController());

    ac.abort();
    const stream = await adapter.sendMessage({
      message: makeUserMessage('abort'),
      messages: [makeUserMessage('abort')],
      signal: ac.signal,
    });

    const chunks = await collectChunks(stream);
    const chatChunks = chunks.filter(isChatMessageChunk);
    const types = chatChunks.map((c) => c.type);

    expect(types).toContain('abort');
    expect(types).not.toContain('finish');

    vi.unstubAllGlobals();
  });
});

// ── unknown event type ────────────────────────────────────────────────────────

describe('createBackendChatAdapter: unknown event types', () => {
  it('ignores unknown event types without throwing', async () => {
    const sse = makeSseBody([
      {
        type: 'unknown-future-event',
        someField: 'value',
      },
      { type: 'finish', finishReason: 'stop' },
    ]);
    mockFetch(sse);

    const config: StudioAIConfig = { endpoint: 'https://fake.test/api/ai' };
    const adapter = createBackendChatAdapter(config, makeController());
    const stream = await adapter.sendMessage(makeSendInput([]));

    const chunks = await collectChunks(stream);
    expect(chunks.filter(isChatMessageChunk).some((c) => c.type === 'finish')).toBe(true);
    vi.unstubAllGlobals();
  });
});

// ── POST body content ─────────────────────────────────────────────────────────

describe('createBackendChatAdapter: POST body', () => {
  it('sends dashboardState, messages, and allowedTools in the request body', async () => {
    const sse = makeSseBody([{ type: 'finish', finishReason: 'stop' }]);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(sse);
          ctrl.close();
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const controller = makeController();
    const config: StudioAIConfig = {
      endpoint: 'https://fake.test/api/ai',
      allowedTools: ['add_widget', 'get_dashboard_state'],
    };
    const adapter = createBackendChatAdapter(config, controller);
    const stream = await adapter.sendMessage(makeSendInput([makeUserMessage('add a chart')]));

    await collectChunks(stream);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://fake.test/api/ai/chat');
    const body = JSON.parse(String(init.body)) as {
      dashboardState: unknown;
      messages: unknown;
      allowedTools: string[];
    };
    expect(body.dashboardState).toBeDefined();
    expect(body.messages).toHaveLength(1);
    expect(body.allowedTools).toEqual(['add_widget', 'get_dashboard_state']);

    vi.unstubAllGlobals();
  });
});
