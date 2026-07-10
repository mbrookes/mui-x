import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatMessageChunk, ChatStreamEnvelope } from '@mui/x-chat/headless';
import { createBackendChatAdapter } from './studioBackendAdapter';
import { createDefaultStudioState } from '../../models/stateTypes';
import type { CreateDefaultStudioStateOverrides } from '../../models';
import type { StudioController } from '../../store/StudioController';
import type { StudioAIConfig } from './studioBackendAdapter';

// ── Helpers ───────────────────────────────────────────────────────────────────

const DEFAULT_STATE_OVERRIDES: CreateDefaultStudioStateOverrides = {
  doc: {
    dashboard: { id: 'd1', title: 'Dashboard', activePageId: 'page-1' },
    pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [] } },
    widgets: {},
  },
};

function makeController(
  stateOverride: CreateDefaultStudioStateOverrides = DEFAULT_STATE_OVERRIDES,
): StudioController {
  const state = createDefaultStudioState(stateOverride);

  return {
    getState: vi.fn(() => state),
    getRecentMutations: vi.fn(() => []),
    // State mutations from the SSE stream are now applied through this single
    // entry point (which runs the shared `applyMutation` reducer) rather than a
    // per-mutation-type dispatch to individual controller methods.
    applyExternalMutation: vi.fn(),
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
  const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new TextEncoder().encode(text);
}

let messageIndex = 0;

function makeUserMessage(text: string): ChatMessage {
  const id = `m-${messageIndex}`;
  messageIndex += 1;
  return {
    id,
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
    // Sequential stream drain: each read depends on the previous one.
    // eslint-disable-next-line no-await-in-loop
    const result = await reader.read();
    done = result.done;
    if (result.value) {
      chunks.push(result.value);
    }
  }
  return chunks;
}

function isChatMessageChunk(
  chunk: ChatMessageChunk | ChatStreamEnvelope,
): chunk is ChatMessageChunk {
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
    expect(controller.applyExternalMutation).toHaveBeenCalledWith({
      type: 'setDashboardTitle',
      args: { title: 'Updated' },
    });

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
    expect(controller.applyExternalMutation).toHaveBeenCalledWith({
      type: 'removeWidget',
      args: { widgetId: 'widget-1' },
    });

    vi.unstubAllGlobals();
  });

  it('drops a malformed state-mutation event but still delivers text and reaches finish', async () => {
    // The one bad event must be dropped without killing the stream: the controller
    // is never touched by it, yet the following text-delta and finish arrive normally.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sse = makeSseBody([
      {
        type: 'state-mutation',
        mutation: { type: 'setWidgetLayout', args: { rows: 'not-a-matrix' } },
      },
      { type: 'text-delta', delta: 'Hello' },
      { type: 'finish', finishReason: 'stop' },
    ]);
    mockFetch(sse);

    const controller = makeController();
    const config: StudioAIConfig = { endpoint: 'https://fake.test/api/ai' };
    const adapter = createBackendChatAdapter(config, controller);
    const stream = await adapter.sendMessage(makeSendInput([]));

    const chunks = await collectChunks(stream);
    const chatChunks = chunks.filter(isChatMessageChunk);
    const types = chatChunks.map((c) => c.type);
    const deltas = chatChunks
      .filter((c) => c.type === 'text-delta')
      .map((c) => (c as { type: 'text-delta'; delta: string }).delta);

    expect(controller.applyExternalMutation).not.toHaveBeenCalled();
    expect(deltas).toContain('Hello');
    expect(types).toContain('finish');

    errorSpy.mockRestore();
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

  it('emits tool-input-available carrying the parsed input so the tool card renders arguments (finding 2.6)', async () => {
    const toolInput = { kind: 'chart', title: 'Revenue', xField: 'country' };
    const sse = makeSseBody([
      {
        type: 'tool-activity',
        toolCallId: 'call-1',
        toolName: 'add_widget',
        phase: 'start',
        input: toolInput,
      },
      { type: 'finish', finishReason: 'stop' },
    ]);
    mockFetch(sse);

    const config: StudioAIConfig = { endpoint: 'https://fake.test/api/ai' };
    const adapter = createBackendChatAdapter(config, makeController());
    const stream = await adapter.sendMessage(makeSendInput([]));

    const chunks = await collectChunks(stream);
    const chatChunks = chunks.filter(isChatMessageChunk);

    // x-chat's stream processor discards `tool-input-delta` text — only a
    // `tool-input-available` chunk populates `toolInvocation.input`. Without it,
    // the tool card shows a name/status but never the call's arguments.
    const available = chatChunks.find((c) => c.type === 'tool-input-available') as
      | { type: 'tool-input-available'; toolCallId: string; toolName: string; input: unknown }
      | undefined;
    expect(available).toBeDefined();
    expect(available!.toolCallId).toBe('call-1');
    expect(available!.toolName).toBe('add_widget');
    expect(available!.input).toEqual(toolInput);

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
    const deltaChunk = chatChunks.find((c) => c.type === 'reasoning-delta') as
      | { type: 'reasoning-delta'; delta: string }
      | undefined;
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
      stream
        .getReader()
        .read()
        .catch(() => {});
    });

    // Give the async start() function time to reach reader.read()
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });

    adapter.stop?.();

    // Give the stop() microtask time to run
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });

    expect(cancelSpy).toHaveBeenCalled();
    expect(readerRef).not.toBeNull();

    vi.unstubAllGlobals();
  });
});

describe('createBackendChatAdapter: overlapping streams stop()', () => {
  it('still cancels a live stream after an earlier overlapping stream finished (regression: 2.9)', async () => {
    // The panel can switch threads mid-stream, so two sendMessage streams can be
    // in flight at once. When the "done" stream completes, its cleanup must remove
    // only its OWN reader — not the still-live stream's — so a later stop() can
    // still cancel the live one. With a single shared reader variable, the done
    // stream's `finally` nulled the live stream's reader and stop() became a no-op.
    const liveCancelSpy = vi.fn().mockResolvedValue(undefined);

    // Route each request by its message text so ordering/timing of the two
    // concurrent start() calls does not affect which body each stream gets.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as {
          messages: { parts: { text: string }[] }[];
        };
        const text = body.messages[0]?.parts[0]?.text;
        if (text === 'live') {
          // Still-live stream: its reader never resolves.
          return Promise.resolve({
            ok: true,
            body: {
              getReader: () => ({
                read: vi.fn().mockImplementation(() => new Promise(() => {})),
                cancel: liveCancelSpy,
                releaseLock: vi.fn(),
              }),
            },
          });
        }
        // "done" stream: completes with a finish event so its finally() runs.
        const sse = makeSseBody([{ type: 'finish', finishReason: 'stop' }]);
        return Promise.resolve({
          ok: true,
          body: new ReadableStream({
            start(ctrl) {
              ctrl.enqueue(sse);
              ctrl.close();
            },
          }),
        });
      }),
    );

    const config: StudioAIConfig = { endpoint: 'https://fake.test/api/ai' };
    const adapter = createBackendChatAdapter(config, makeController());

    // Start the live stream and begin reading so its start() runs and registers
    // its reader before anything else happens.
    const liveStream = await adapter.sendMessage(makeSendInput([makeUserMessage('live')]));
    liveStream
      .getReader()
      .read()
      .catch(() => {});
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });

    // Now run an overlapping stream to completion. Its cleanup must not disturb the
    // live stream's registered reader.
    const doneStream = await adapter.sendMessage(makeSendInput([makeUserMessage('done')]));
    await collectChunks(doneStream);

    // stop() must still reach the live stream's reader.
    adapter.stop?.();
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });

    expect(liveCancelSpy).toHaveBeenCalled();

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

// ── stream lifecycle: ends without a `finish` event ──────────────────────────

describe('createBackendChatAdapter: stream ends without finish', () => {
  it('closes the stream cleanly when the connection ends without a finish event', async () => {
    // No `finish` event — simulates the server closing the connection mid-response
    // (proxy timeout, server restart). Without the fix, the returned ReadableStream's
    // controller is never closed and `collectChunks` below would hang forever.
    const sse = makeSseBody([{ type: 'text-delta', delta: 'partial' }]);
    mockFetch(sse);

    const config: StudioAIConfig = { endpoint: 'https://fake.test/api/ai' };
    const adapter = createBackendChatAdapter(config, makeController());
    const stream = await adapter.sendMessage(makeSendInput([makeUserMessage('hi')]));

    const chunks = await collectChunks(stream);
    const chatChunks = chunks.filter(isChatMessageChunk);
    const types = chatChunks.map((c) => c.type);

    expect(types).toContain('text-delta');
    expect(types).not.toContain('finish');
    // Reaching this point at all (collectChunks resolved instead of hanging) proves
    // the stream was closed by the post-parseSSEStream cleanup.

    vi.unstubAllGlobals();
  });

  it('ignores any event that arrives after a finish event in the same payload', async () => {
    // A stray event batched after `finish` in the same SSE payload must not be
    // processed — `processEvent` returns `false` on `finish`, which stops
    // `parseSSEStream` before it reaches this trailing event. Without that, the
    // adapter would try to `enqueue`/`text-start` on an already-closed controller,
    // which throws and would reject this stream instead of resolving cleanly.
    const sse = makeSseBody([
      { type: 'finish', finishReason: 'stop' },
      { type: 'text-delta', delta: 'ignored' },
    ]);
    mockFetch(sse);

    const config: StudioAIConfig = { endpoint: 'https://fake.test/api/ai' };
    const adapter = createBackendChatAdapter(config, makeController());
    const stream = await adapter.sendMessage(makeSendInput([makeUserMessage('hi')]));

    const chunks = await collectChunks(stream);
    const chatChunks = chunks.filter(isChatMessageChunk);
    const types = chatChunks.map((c) => c.type);
    const deltas = chatChunks
      .filter((c) => c.type === 'text-delta')
      .map((c) => (c as { type: 'text-delta'; delta: string }).delta);

    expect(types).toContain('finish');
    expect(deltas).not.toContain('ignored');

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

  it('strips rows and adapter from dataSources before sending', async () => {
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

    const adapterStub = { getRows: vi.fn() };
    const stateWithData = createDefaultStudioState({
      doc: {
        dashboard: { id: 'd1', title: 'Dashboard', activePageId: 'page-1' },
        pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [] } },
        widgets: {},
      },
      runtime: {
        dataSources: {
          src1: {
            id: 'src1',
            label: 'Sales',
            fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
            rows: [{ amount: 100 }, { amount: 200 }],
            adapter: adapterStub as never,
          },
          src2: {
            id: 'src2',
            label: 'Orders',
            fields: [{ id: 'count', label: 'Count', type: 'number' }],
            // no rows or adapter
          },
        },
      },
    });

    const controller = {
      getState: vi.fn(() => stateWithData),
      getRecentMutations: vi.fn(() => []),
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

    const config: StudioAIConfig = { endpoint: 'https://fake.test/api/ai' };
    const adapter = createBackendChatAdapter(config, controller as never);
    const stream = await adapter.sendMessage(makeSendInput([makeUserMessage('summarise')]));
    await collectChunks(stream);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      dashboardState: { runtime: { dataSources: Record<string, Record<string, unknown>> } };
    };

    const src1 = body.dashboardState.runtime.dataSources.src1;
    expect(src1).not.toHaveProperty('rows');
    expect(src1).not.toHaveProperty('adapter');
    expect(src1.id).toBe('src1');
    expect(src1.label).toBe('Sales');
    expect(src1.fields).toHaveLength(1);

    // Source without rows/adapter should also be present and intact
    const src2 = body.dashboardState.runtime.dataSources.src2;
    expect(src2.id).toBe('src2');
    expect(src2).not.toHaveProperty('rows');

    vi.unstubAllGlobals();
  });
});

// ── privateMode (finding 2.21) ────────────────────────────────────────────────
//
// The single most important test in this unit given the security history: the
// same class of bug (a privateMode bypass leaking real data/structure to the LLM
// provider) was found and fixed twice before, in `createWidgetFromDescription.ts`
// and `useTextWidgetAI.ts`, both of which now have dedicated privateMode tests.
// The main chat adapter builds `pageSnapshot` (sampled sibling-widget row values),
// `dashboardState` (full serialized state), and `richContext` (per-field stats)
// inside one `if (!privateMode)` block. These tests pin that gate so a future
// refactor moving one builder out of the block ships a failing test, not a silent
// leak.
describe('createBackendChatAdapter: privateMode', () => {
  // A page with a data-backed grid widget so that — when privateMode is OFF —
  // `pageSnapshot`, `dashboardState`, and `richContext` are all actually built
  // (an empty page would leave pageSnapshot/richContext undefined regardless).
  const stateWithDataWidget: CreateDefaultStudioStateOverrides = {
    doc: {
      dashboard: { id: 'd1', title: 'Dashboard', activePageId: 'page-1' },
      pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['grid-1']] } },
      widgets: {
        'grid-1': {
          id: 'grid-1',
          kind: 'grid',
          title: 'Sales grid',
          sourceId: 'src1',
          config: { columns: [{ fieldId: 'amount' }] },
        },
      },
    },
    runtime: {
      dataSources: {
        src1: {
          id: 'src1',
          label: 'Sales',
          fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
          rows: [{ amount: 12345 }],
        },
      },
    },
  };

  function captureRequestBody(): { fetchMock: ReturnType<typeof vi.fn> } {
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
    return { fetchMock };
  }

  it('sends pageSnapshot, dashboardState, and richContext and forwards privateMode:false when off', async () => {
    const { fetchMock } = captureRequestBody();

    const config: StudioAIConfig = { endpoint: 'https://fake.test/api/ai', privateMode: false };
    const adapter = createBackendChatAdapter(config, makeController(stateWithDataWidget));
    const stream = await adapter.sendMessage(makeSendInput([makeUserMessage('summarise')]));
    await collectChunks(stream);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const rawBody = String(init.body);
    const body = JSON.parse(rawBody) as {
      privateMode?: boolean;
      pageSnapshot?: unknown;
      dashboardState?: unknown;
      richContext?: unknown;
    };

    expect(body.privateMode).toBe(false);
    expect(body.pageSnapshot).toBeDefined();
    expect(body.dashboardState).toBeDefined();
    expect(body.richContext).toBeDefined();
    // The real sibling-widget row value is present on the leak path.
    expect(rawBody).toContain('12345');

    vi.unstubAllGlobals();
  });

  it('omits pageSnapshot, dashboardState, and richContext and forwards privateMode:true when on', async () => {
    const { fetchMock } = captureRequestBody();

    const config: StudioAIConfig = { endpoint: 'https://fake.test/api/ai', privateMode: true };
    const adapter = createBackendChatAdapter(config, makeController(stateWithDataWidget));
    const stream = await adapter.sendMessage(makeSendInput([makeUserMessage('summarise')]));
    await collectChunks(stream);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const rawBody = String(init.body);
    const body = JSON.parse(rawBody) as {
      privateMode?: boolean;
      pageSnapshot?: unknown;
      dashboardState?: unknown;
      richContext?: unknown;
    };

    expect(body.privateMode).toBe(true);
    expect(body.pageSnapshot).toBeUndefined();
    expect(body.dashboardState).toBeUndefined();
    expect(body.richContext).toBeUndefined();
    // Neither the real row value nor a widget/field name leaks into the payload.
    expect(rawBody).not.toContain('12345');
    expect(rawBody).not.toContain('Sales grid');

    vi.unstubAllGlobals();
  });
});

// ── multi-step text parts (finding 2.23) ──────────────────────────────────────
//
// A single agentic turn can interleave text and tool calls: preamble text → tool
// call → final answer. Each contiguous text run must render as its own text part
// in arrival order. With a single fixed `text-0` id, the final answer's deltas got
// appended into the SAME part as the preamble, rendering the conclusion spliced
// ABOVE the (earlier) tool card instead of below it.
describe('createBackendChatAdapter: multi-step text parts', () => {
  it('closes the preamble text part before a tool call and starts a fresh part for the final answer', async () => {
    const sse = makeSseBody([
      { type: 'text-delta', delta: 'Let me check.' },
      {
        type: 'tool-activity',
        toolCallId: 'call-1',
        toolName: 'query_data_source',
        phase: 'start',
        input: {},
      },
      {
        type: 'tool-activity',
        toolCallId: 'call-1',
        toolName: 'query_data_source',
        phase: 'complete',
        output: '{"rows":1}',
      },
      { type: 'step-start', iteration: 2 },
      { type: 'text-delta', delta: 'Here is the answer.' },
      { type: 'finish', finishReason: 'stop' },
    ]);
    mockFetch(sse);

    const config: StudioAIConfig = { endpoint: 'https://fake.test/api/ai' };
    const adapter = createBackendChatAdapter(config, makeController());
    const stream = await adapter.sendMessage(makeSendInput([makeUserMessage('multi-step')]));

    const chunks = await collectChunks(stream);
    const chatChunks = chunks.filter(isChatMessageChunk);

    // Two distinct text parts, each with its own start/end and its own id.
    const textStartIds = chatChunks
      .filter((c) => c.type === 'text-start')
      .map((c) => (c as { type: 'text-start'; id: string }).id);
    const textEndIds = chatChunks
      .filter((c) => c.type === 'text-end')
      .map((c) => (c as { type: 'text-end'; id: string }).id);

    expect(textStartIds).toHaveLength(2);
    expect(textEndIds).toHaveLength(2);
    // The two runs use different part ids (the fix): not a single merged `text-0`.
    expect(new Set(textStartIds).size).toBe(2);

    // Ordering: the preamble part is closed BEFORE the tool card renders, and the
    // final answer's part starts AFTER the tool output.
    const types = chatChunks.map((c) => c.type);
    const firstTextEndIdx = types.indexOf('text-end');
    const toolInputStartIdx = types.indexOf('tool-input-start');
    const toolOutputIdx = types.indexOf('tool-output-available');
    const lastTextStartIdx = types.lastIndexOf('text-start');

    expect(firstTextEndIdx).toBeGreaterThanOrEqual(0);
    expect(firstTextEndIdx).toBeLessThan(toolInputStartIdx);
    expect(lastTextStartIdx).toBeGreaterThan(toolOutputIdx);

    // Each delta is routed to the id of its own run, never merged.
    const deltaByRun = new Map<string, string[]>();
    for (const c of chatChunks) {
      if (c.type === 'text-delta') {
        const { id, delta } = c as { type: 'text-delta'; id: string; delta: string };
        deltaByRun.set(id, [...(deltaByRun.get(id) ?? []), delta]);
      }
    }
    expect(deltaByRun.size).toBe(2);
    const runs = [...deltaByRun.values()].map((parts) => parts.join(''));
    expect(runs).toContain('Let me check.');
    expect(runs).toContain('Here is the answer.');

    vi.unstubAllGlobals();
  });
});
