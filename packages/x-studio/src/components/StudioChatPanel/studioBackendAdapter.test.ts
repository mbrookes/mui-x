import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatMessageChunk, ChatStreamEnvelope } from '@mui/x-chat/headless';
// Imported, never re-spelled as literals: a test that hard-codes `10_000` would keep passing
// if the shared cap moved and the adapter stopped agreeing with the rest of the boundary.
import { MAX_ARRAY_LENGTH, MAX_STRING_LENGTH, UNSAFE_KEYS } from '@mui/x-studio-schema';
import {
  createBackendChatAdapter,
  MAX_METADATA_KEY_LENGTH,
  MAX_TURN_APPROVAL_SIZE,
  MAX_TURN_METADATA_SIZE,
} from './studioBackendAdapter';
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

/**
 * What `x-chat-headless`' `processStream` actually persists for `message-metadata`:
 * `metadata: { ...message.metadata, ...chunk.metadata }` — every chunk of the turn folded
 * into ONE assistant message. Asserting on a single chunk measures the wrong quantity.
 */
function mergeMetadataChunks(chunks: ChatMessageChunk[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const chunk of chunks) {
    if (chunk.type === 'message-metadata') {
      Object.assign(merged, (chunk as { metadata: Record<string, unknown> }).metadata);
    }
  }
  return merged;
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

  // Regression coverage (finding 2.6b): a malformed/unexpected `tool-activity` event
  // shape (missing fields entirely) must degrade gracefully — coerced to safe string
  // defaults — rather than enqueueing e.g. `toolCallId: undefined`, which would leave
  // a tool-activity card stuck in a permanent "input-streaming" state.
  it('coerces a malformed tool-activity event to safe defaults instead of forwarding undefined fields', async () => {
    const sse = makeSseBody([
      // Missing toolCallId/toolName/phase entirely.
      { type: 'tool-activity', input: { foo: 'bar' } },
      { type: 'finish', finishReason: 'stop' },
    ]);
    mockFetch(sse);

    const config: StudioAIConfig = { endpoint: 'https://fake.test/api/ai' };
    const adapter = createBackendChatAdapter(config, makeController());
    const stream = await adapter.sendMessage(makeSendInput([]));

    // Must not throw despite the malformed event; the stream still reaches finish.
    const chunks = await collectChunks(stream);
    const chatChunks = chunks.filter(isChatMessageChunk);
    const types = chatChunks.map((c) => c.type);
    expect(types).toContain('finish');
    // No `phase` matched 'start'/'complete', so no tool chunk is enqueued for it —
    // proving the malformed event was safely coerced rather than throwing or
    // producing chunks with `undefined` ids.
    expect(types).not.toContain('tool-input-start');

    vi.unstubAllGlobals();
  });
});

// ── tool-approval-request handling ────────────────────────────────────────────
//
// `approvalId` identifies the APPROVAL, not the tool call, and the two need not be 1:1 (a
// server can gate several calls behind one prompt, or re-prompt for the same call).
// `x-chat-headless` already carries it on the chunk and `ToolPart` already responds with
// `approvalId ?? toolCallId`, so the only missing link was this re-emit dropping the field.
// It is forwarded only when the event actually carries one: defaulting it to `toolCallId`
// would be indistinguishable from "absent" and would defeat the consumer's own fallback.
//
// `@mui/x-studio-ai-middleware` does not emit `approvalId` yet, so this half is inert until
// it does — forward-compatible by design.

type ApprovalChunk = ChatMessageChunk & {
  approvalId?: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  effects?: Record<string, unknown>;
  reason?: string;
};

describe('createBackendChatAdapter: tool-approval-request', () => {
  async function collectApprovalChunk(event: Record<string, unknown>) {
    mockFetch(makeSseBody([event, { type: 'finish', finishReason: 'stop' }]));
    const config: StudioAIConfig = { endpoint: 'https://fake.test/api/ai' };
    const adapter = createBackendChatAdapter(config, makeController());
    const stream = await adapter.sendMessage(makeSendInput([]));
    const chunks = (await collectChunks(stream)).filter(isChatMessageChunk);
    vi.unstubAllGlobals();
    return chunks.find((c) => c.type === 'tool-approval-request') as ApprovalChunk | undefined;
  }

  /** Every approval chunk of one turn, for the budget tests below (which need more than one). */
  async function collectApprovalChunks(events: Record<string, unknown>[]) {
    mockFetch(makeSseBody([...events, { type: 'finish', finishReason: 'stop' }]));
    const config: StudioAIConfig = { endpoint: 'https://fake.test/api/ai' };
    const adapter = createBackendChatAdapter(config, makeController());
    const stream = await adapter.sendMessage(makeSendInput([]));
    const chunks = (await collectChunks(stream)).filter(isChatMessageChunk);
    vi.unstubAllGlobals();
    return chunks.filter((c) => c.type === 'tool-approval-request') as ApprovalChunk[];
  }

  function approvalEvent(index: number, extra: Record<string, unknown>) {
    return {
      type: 'tool-approval-request',
      toolCallId: `call-${index}`,
      toolName: 'apply_bulk_update',
      input: {},
      ...extra,
    };
  }

  /** A well-typed `{ id, title }` list of `count` entries, each title `titleLength` long. */
  function entities(count: number, titleLength: number) {
    return Array.from({ length: count }, (_unused, i) => ({
      id: `w${i}`,
      title: 'T'.repeat(titleLength),
    }));
  }

  it('forwards approvalId when the event carries one', async () => {
    const chunk = await collectApprovalChunk({
      type: 'tool-approval-request',
      approvalId: 'approval-1',
      toolCallId: 'call-1',
      toolName: 'add_widget',
      input: { kind: 'kpi' },
    });

    expect(chunk).not.toBe(undefined);
    expect(chunk!.approvalId).toBe('approval-1');
    // The other three fields are unchanged.
    expect(chunk!.toolCallId).toBe('call-1');
    expect(chunk!.toolName).toBe('add_widget');
    expect(chunk!.input).toEqual({ kind: 'kpi' });
  });

  it('omits approvalId (rather than defaulting it to toolCallId) when the event has none', async () => {
    const chunk = await collectApprovalChunk({
      type: 'tool-approval-request',
      toolCallId: 'call-1',
      toolName: 'add_widget',
      input: { kind: 'kpi' },
    });

    expect(chunk).not.toBe(undefined);
    // Absent — NOT `'call-1'`. `ToolPart` falls back to `toolCallId` itself; stamping it
    // here would make "no separate approval id" indistinguishable from "the approval id
    // happens to equal the tool call id".
    expect(chunk!.approvalId).toBe(undefined);
    expect(chunk!.toolCallId).toBe('call-1');
    expect(chunk!.toolName).toBe('add_widget');
    expect(chunk!.input).toEqual({ kind: 'kpi' });
  });

  it('ignores a non-string / empty approvalId, keeping the chunk valid', async () => {
    const chunk = await collectApprovalChunk({
      type: 'tool-approval-request',
      approvalId: 42,
      toolCallId: 'call-1',
      toolName: 'add_widget',
      input: {},
    });

    expect(chunk).not.toBe(undefined);
    expect(chunk!.approvalId).toBe(undefined);
    expect(chunk!.toolCallId).toBe('call-1');
    expect(chunk!.toolName).toBe('add_widget');
  });

  // ── effects/reason size limits ──────────────────────────────────────────────
  //
  // `effects` and `reason` land on `toolInvocation.approvalRequest` — a message PART, which
  // `useChatThreads.handleMessagesChange` writes into `doc.ai.threads[].messages` exactly
  // like `metadata`, with no load-boundary screen on the way back in. Narrowing the key set
  // and the value TYPES (which is all `sanitizeApprovalEffects` used to do) bounds neither
  // list length nor string length: measured from ONE event,
  // `effectsBytes=10167825 reasonChars=1000000`.

  it('keeps a well-formed effects payload that is inside every limit', async () => {
    const effects = {
      willRemoveWidgets: entities(3, 20),
      willRemoveFilters: ['f1', 'f2'],
      updatedWidgetCount: 4,
    };
    const chunk = await collectApprovalChunk(
      approvalEvent(1, { effects, reason: 'policy says no' }),
    );

    // The cap is a boundary, not a ban: nothing about a real approval changes.
    expect(chunk!.effects).toEqual(effects);
    expect(chunk!.reason).toBe('policy says no');
  });

  it('drops the whole effects payload when a list is longer than the shared array cap', async () => {
    const chunk = await collectApprovalChunk(
      approvalEvent(1, {
        effects: {
          willRemoveWidgets: entities(MAX_ARRAY_LENGTH + 1, 8),
          updatedWidgetCount: 2,
        },
      }),
    );

    // All-or-nothing, deliberately: a SHORTENED "will remove" list understates the impact a
    // human is approving — worse than showing none, which is the card's pre-`effects` shape.
    expect(chunk!.effects).toBe(undefined);
  });

  it('drops the whole effects payload when an entity title is over the shared string cap', async () => {
    const chunk = await collectApprovalChunk(
      approvalEvent(1, {
        effects: { willRemoveWidgets: entities(1, MAX_STRING_LENGTH + 1) },
      }),
    );

    expect(chunk!.effects).toBe(undefined);
  });

  it('drops a `reason` over the shared string cap, keeping the rest of the chunk', async () => {
    const chunk = await collectApprovalChunk(
      approvalEvent(1, {
        effects: { updatedWidgetCount: 1 },
        reason: 'r'.repeat(MAX_STRING_LENGTH + 1),
      }),
    );

    expect(chunk!.reason).toBe(undefined);
    // Dropped individually — the approval card itself, and its effects, still render.
    expect(chunk!.effects).toEqual({ updatedWidgetCount: 1 });
    expect(chunk!.toolCallId).toBe('call-1');
  });

  it('spends ONE effects/reason budget across every approval event of the turn', async () => {
    // Each event is individually legal: 400 entities well under `MAX_ARRAY_LENGTH`, titles
    // well under `MAX_STRING_LENGTH`. ~10 KB of serialized effects apiece, so a per-EVENT
    // limit accepts all six and puts ~60 KB on one message.
    const events = Array.from({ length: 6 }, (_unused, i) =>
      approvalEvent(i, { effects: { willRemoveWidgets: entities(400, 12) } }),
    );
    const chunks = await collectApprovalChunks(events);

    // Every approval still gets a card — only the oversized payload is withheld.
    expect(chunks).toHaveLength(6);
    const charged = chunks.reduce(
      (total, chunk) => total + (chunk.effects ? JSON.stringify(chunk.effects)!.length : 0),
      0,
    );
    expect(charged).toBeLessThanOrEqual(MAX_TURN_APPROVAL_SIZE);
    // The later approvals degrade to the pre-`effects` card rather than growing the doc.
    expect(chunks.at(-1)!.effects).toBe(undefined);
    expect(chunks[0].effects).not.toBe(undefined);
  });

  it('spends the same turn budget on `reason`, not a separate one', async () => {
    const reason = 'r'.repeat(MAX_STRING_LENGTH);
    const events = Array.from({ length: 6 }, (_unused, i) => approvalEvent(i, { reason }));
    const chunks = await collectApprovalChunks(events);

    const charged = chunks.reduce((total, chunk) => total + (chunk.reason?.length ?? 0), 0);
    expect(charged).toBeLessThanOrEqual(MAX_TURN_APPROVAL_SIZE);
    expect(chunks.filter((chunk) => chunk.reason !== undefined)).toHaveLength(
      MAX_TURN_APPROVAL_SIZE / MAX_STRING_LENGTH,
    );
  });

  // `input` is the one field on this chunk that is NOT capped, and that is a decision, not an
  // oversight: it never survives into the persisted message. The model's own arguments are
  // re-asserted over this display-enriched copy at every settle point — here, by
  // `flushApprovalGatedInputs` on the ordinary `finish` path.
  it('forwards `input` verbatim, and the settle re-asserts the model arguments over it', async () => {
    const bigInput = { note: 'n'.repeat(MAX_STRING_LENGTH + 1) };
    mockFetch(
      makeSseBody([
        {
          type: 'tool-activity',
          phase: 'start',
          toolCallId: 'call-1',
          toolName: 'apply_bulk_update',
          input: { widgetRemovals: ['w1'] },
        },
        {
          type: 'tool-approval-request',
          toolCallId: 'call-1',
          toolName: 'apply_bulk_update',
          input: bigInput,
        },
        { type: 'finish', finishReason: 'stop' },
      ]),
    );
    const adapter = createBackendChatAdapter(
      { endpoint: 'https://fake.test/api/ai' },
      makeController(),
    );
    const stream = await adapter.sendMessage(makeSendInput([]));
    const chunks = (await collectChunks(stream)).filter(isChatMessageChunk);
    vi.unstubAllGlobals();

    const approval = chunks.find((c) => c.type === 'tool-approval-request') as ApprovalChunk;
    expect(approval.input).toEqual(bigInput);
    // …and the LAST write to `toolInvocation.input` — the one that persists — is the model's
    // own arguments, so capping the approval copy would bound nothing that outlives the card.
    const lastInputAvailable = chunks.filter((c) => c.type === 'tool-input-available').at(-1) as {
      input: unknown;
    };
    expect(lastInputAvailable.input).toEqual({ widgetRemovals: ['w1'] });
  });
});

// ── usage handling ────────────────────────────────────────────────────────────

describe('createBackendChatAdapter: usage', () => {
  it('forwards well-formed numeric usage fields to onUsage', async () => {
    const sse = makeSseBody([
      { type: 'usage', inputTokens: 100, outputTokens: 50, iterations: 2 },
      { type: 'finish', finishReason: 'stop' },
    ]);
    mockFetch(sse);

    const onUsage = vi.fn();
    const config: StudioAIConfig = { endpoint: 'https://fake.test/api/ai', onUsage };
    const adapter = createBackendChatAdapter(config, makeController());
    const stream = await adapter.sendMessage(makeSendInput([]));
    await collectChunks(stream);

    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 100, outputTokens: 50, iterations: 2 });

    vi.unstubAllGlobals();
  });

  // Regression coverage (finding 2.6b): a malformed `usage` event (non-numeric or
  // missing fields) must not pass unchecked garbage straight through to the
  // consumer's `onUsage` — it degrades to safe numeric fallbacks instead.
  it('coerces a malformed usage event to safe numeric fallbacks instead of forwarding garbage', async () => {
    const sse = makeSseBody([
      { type: 'usage', inputTokens: 'not-a-number', iterations: null },
      { type: 'finish', finishReason: 'stop' },
    ]);
    mockFetch(sse);

    const onUsage = vi.fn();
    const config: StudioAIConfig = { endpoint: 'https://fake.test/api/ai', onUsage };
    const adapter = createBackendChatAdapter(config, makeController());
    const stream = await adapter.sendMessage(makeSendInput([]));
    await collectChunks(stream);

    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 0, outputTokens: 0, iterations: 0 });

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

  // `message-metadata` is documented as the channel for "trace IDs, or any other
  // structured metadata". A fixed `model`/`inputTokens`/`outputTokens`/`iterations`
  // whitelist silently truncated exactly the extension the protocol promises: a host
  // whose middleware attaches a `traceId` found it gone, with no error anywhere.
  it('carries unknown metadata keys through instead of truncating them', async () => {
    const metadata = {
      model: 'gpt-4o',
      inputTokens: 100,
      traceId: 'trace-abc',
      cacheHit: true,
      provider: { name: 'acme', region: 'eu' },
    };
    const sse = makeSseBody([
      { type: 'message-metadata', metadata },
      { type: 'finish', finishReason: 'stop' },
    ]);
    mockFetch(sse);

    const adapter = createBackendChatAdapter(
      { endpoint: 'https://fake.test/api/ai' },
      makeController(),
    );
    const stream = await adapter.sendMessage(makeSendInput([]));
    const chatChunks = (await collectChunks(stream)).filter(isChatMessageChunk);

    const metaChunk = chatChunks.find((c) => c.type === 'message-metadata') as
      | { metadata: Record<string, unknown> }
      | undefined;
    expect(metaChunk?.metadata).toEqual(metadata);

    vi.unstubAllGlobals();
  });

  // …while the four fields the renderer actually draws stay validated: a non-string
  // `model` reaches JSX as a React child, and a non-numeric count breaks the `!= null`
  // reads in `StudioMessageRoot`.
  it('still drops a wrong-typed model or token count, and prototype keys', async () => {
    // Parsed from raw JSON, not written as a literal: `{ __proto__: … }` in an object
    // literal SETS the prototype (and vanishes from `JSON.stringify`), whereas
    // `JSON.parse` — which is what the SSE reader runs on the wire text — creates a
    // real own property with that name.
    const metadata = JSON.parse(
      '{"model":{"evil":true},"inputTokens":"lots","outputTokens":12,"traceId":"trace-abc","__proto__":{"polluted":true}}',
    ) as Record<string, unknown>;
    const sse = makeSseBody([
      { type: 'message-metadata', metadata },
      { type: 'finish', finishReason: 'stop' },
    ]);
    mockFetch(sse);

    const adapter = createBackendChatAdapter(
      { endpoint: 'https://fake.test/api/ai' },
      makeController(),
    );
    const stream = await adapter.sendMessage(makeSendInput([]));
    const chatChunks = (await collectChunks(stream)).filter(isChatMessageChunk);

    const metaChunk = chatChunks.find((c) => c.type === 'message-metadata') as
      | { metadata: Record<string, unknown> }
      | undefined;
    expect(metaChunk?.metadata).toEqual({ outputTokens: 12, traceId: 'trace-abc' });
    expect(Object.hasOwn(metaChunk!.metadata, '__proto__')).toBe(false);

    vi.unstubAllGlobals();
  });

  // The pass-through above is a write into the PERSISTED partition, not a display-only
  // forward: `ChatMessage.metadata` → `useChatThreads.handleMessagesChange` →
  // `doc.ai.threads[].messages`, and `doc` is what gets serialized, undone and reloaded.
  // The load boundary does not screen it back down (`repairThreadLeafShapes` deliberately
  // does not own-key-screen a surviving message), so an unbounded pass-through lets a
  // server grow the saved document without limit, one assistant message at a time.
  it('drops a pass-through value larger than the shared wire size cap', async () => {
    const metadata = {
      model: 'gpt-4o',
      traceId: 'trace-abc',
      // One character over `MAX_STRING_LENGTH` — the same cap `parseStateMutation` and
      // `repairFilterDependsOn` enforce, so a payload bounded on one path cannot be
      // unbounded on this one.
      bulk: 'x'.repeat(MAX_STRING_LENGTH + 1),
      // Size is measured on the SERIALIZED value, not just on strings: a nested record is
      // exactly as persistent as a flat one.
      bulkNested: { blob: ['y'.repeat(MAX_STRING_LENGTH)] },
      // At the cap, not over it — kept, proving the cap is a boundary and not a ban on
      // anything sizeable.
      atCap: 'z'.repeat(MAX_STRING_LENGTH - 2),
    };
    const sse = makeSseBody([
      { type: 'message-metadata', metadata },
      { type: 'finish', finishReason: 'stop' },
    ]);
    mockFetch(sse);

    const adapter = createBackendChatAdapter(
      { endpoint: 'https://fake.test/api/ai' },
      makeController(),
    );
    const stream = await adapter.sendMessage(makeSendInput([]));
    const chatChunks = (await collectChunks(stream)).filter(isChatMessageChunk);

    const metaChunk = chatChunks.find((c) => c.type === 'message-metadata') as
      | { metadata: Record<string, unknown> }
      | undefined;
    expect(metaChunk?.metadata).toEqual({
      model: 'gpt-4o',
      traceId: 'trace-abc',
      atCap: 'z'.repeat(MAX_STRING_LENGTH - 2),
    });

    vi.unstubAllGlobals();
  });

  it('caps the number of pass-through keys, without spending the budget on the known four', async () => {
    const metadata: Record<string, unknown> = {
      model: 'gpt-4o',
      inputTokens: 1,
      outputTokens: 2,
      iterations: 3,
    };
    for (let i = 0; i < MAX_ARRAY_LENGTH + 25; i += 1) {
      metadata[`k${i}`] = i;
    }
    const sse = makeSseBody([
      { type: 'message-metadata', metadata },
      { type: 'finish', finishReason: 'stop' },
    ]);
    mockFetch(sse);

    const adapter = createBackendChatAdapter(
      { endpoint: 'https://fake.test/api/ai' },
      makeController(),
    );
    const stream = await adapter.sendMessage(makeSendInput([]));
    const chatChunks = (await collectChunks(stream)).filter(isChatMessageChunk);

    const metaChunk = chatChunks.find((c) => c.type === 'message-metadata') as
      | { metadata: Record<string, unknown> }
      | undefined;
    const forwarded = metaChunk!.metadata;
    // The four known fields do not consume the pass-through budget…
    expect(forwarded.model).toBe('gpt-4o');
    expect(forwarded.iterations).toBe(3);
    // …and the open extension is bounded: the first `MAX_ARRAY_LENGTH` unknown keys survive,
    // the overflow is dropped rather than persisted.
    expect(Object.keys(forwarded)).toHaveLength(4 + MAX_ARRAY_LENGTH);
    expect(forwarded.k0).toBe(0);
    expect(Object.hasOwn(forwarded, `k${MAX_ARRAY_LENGTH - 1}`)).toBe(true);
    expect(Object.hasOwn(forwarded, `k${MAX_ARRAY_LENGTH}`)).toBe(false);

    vi.unstubAllGlobals();
  });

  // The hazard keys are dropped by `@mui/x-studio-schema`'s shared `isSafeKey`, not by a
  // literal re-spelled here. `constructor` and `prototype` are the siblings the existing
  // `__proto__` assertion above never covered — a hand-rolled triple that lost one of them
  // would still pass that test.
  it('drops every shared UNSAFE_KEYS member, not just __proto__', async () => {
    const metadata = JSON.parse(
      '{"traceId":"t","__proto__":{"a":1},"constructor":{"b":2},"prototype":{"c":3}}',
    ) as Record<string, unknown>;
    const sse = makeSseBody([
      { type: 'message-metadata', metadata },
      { type: 'finish', finishReason: 'stop' },
    ]);
    mockFetch(sse);

    const adapter = createBackendChatAdapter(
      { endpoint: 'https://fake.test/api/ai' },
      makeController(),
    );
    const stream = await adapter.sendMessage(makeSendInput([]));
    const chatChunks = (await collectChunks(stream)).filter(isChatMessageChunk);

    const metaChunk = chatChunks.find((c) => c.type === 'message-metadata') as
      | { metadata: Record<string, unknown> }
      | undefined;
    expect(Object.keys(metaChunk!.metadata)).toEqual(['traceId']);
    for (const key of UNSAFE_KEYS) {
      expect(Object.hasOwn(metaChunk!.metadata, key)).toBe(false);
    }

    vi.unstubAllGlobals();
  });

  // The cap is on the MESSAGE, not on the event. `processStream`'s `message-metadata` case
  // does `metadata: { ...message.metadata, ...chunk.metadata }` — every event of the turn
  // MERGES into the single assistant message `useChatThreads.handleMessagesChange` persists —
  // and nothing bounds how many events a stream carries (`parseSSEStream`'s `MAX_BUFFER_SIZE`
  // caps the un-newlined residue of ONE LINE, not the stream). A budget reset per event is
  // therefore not a budget: measured at 5 events x `MAX_ARRAY_LENGTH` at-cap keys it admitted
  // 2500 keys / 25 MB onto one message, linear in the event count.
  it('spends ONE size budget across every metadata event of the turn, not one per event', async () => {
    // Six events, each carrying one value at half the per-value cap: individually every one
    // of them is well inside every per-event check, so a per-event budget accepts all six.
    const half = 'x'.repeat(MAX_STRING_LENGTH / 2);
    const events: object[] = [];
    for (let i = 0; i < 6; i += 1) {
      events.push({ type: 'message-metadata', metadata: { [`blob${i}`]: half } });
    }
    events.push({ type: 'finish', finishReason: 'stop' });
    mockFetch(makeSseBody(events));

    const adapter = createBackendChatAdapter(
      { endpoint: 'https://fake.test/api/ai' },
      makeController(),
    );
    const stream = await adapter.sendMessage(makeSendInput([]));
    const chatChunks = (await collectChunks(stream)).filter(isChatMessageChunk);

    // Reproduce the sink: what reaches the persisted message is the MERGE of every forwarded
    // chunk, which is the quantity that has to be bounded.
    const merged = mergeMetadataChunks(chatChunks);
    const chargedSize = Object.entries(merged).reduce(
      (total, [key, value]) => total + key.length + JSON.stringify(value)!.length,
      0,
    );
    expect(chargedSize).toBeLessThanOrEqual(MAX_TURN_METADATA_SIZE);
    // `blob0` (5) + the serialized value (5002) = 5007 per entry, so three fit and the fourth
    // would overshoot 20 000. The point is not the exact three: it is that the overflow is
    // dropped instead of merged, which a per-event budget never does.
    expect(Object.keys(merged)).toEqual(['blob0', 'blob1', 'blob2']);

    vi.unstubAllGlobals();
  });

  // Same merge, the key-COUNT half of the budget.
  it('spends ONE key-count budget across every metadata event of the turn', async () => {
    const events: object[] = [];
    for (let event = 0; event < 3; event += 1) {
      const metadata: Record<string, unknown> = {};
      for (let i = 0; i < MAX_ARRAY_LENGTH; i += 1) {
        metadata[`e${event}k${i}`] = i;
      }
      events.push({ type: 'message-metadata', metadata });
    }
    events.push({ type: 'finish', finishReason: 'stop' });
    mockFetch(makeSseBody(events));

    const adapter = createBackendChatAdapter(
      { endpoint: 'https://fake.test/api/ai' },
      makeController(),
    );
    const stream = await adapter.sendMessage(makeSendInput([]));
    const chatChunks = (await collectChunks(stream)).filter(isChatMessageChunk);

    // 1500 distinct keys offered across three events; the persisted message keeps
    // `MAX_ARRAY_LENGTH` of them in TOTAL, not `MAX_ARRAY_LENGTH` per event.
    const merged = mergeMetadataChunks(chatChunks);
    expect(Object.keys(merged)).toHaveLength(MAX_ARRAY_LENGTH);
    expect(Object.hasOwn(merged, 'e1k0')).toBe(false);

    vi.unstubAllGlobals();
  });

  // `wireValueSize` measures the VALUE. A key NAME is exactly as persistent as the value it
  // names, so without its own cap `MAX_ARRAY_LENGTH` megabyte-long names pass every
  // value-side check.
  it('drops a pass-through key whose NAME is over the key-length cap', async () => {
    const overLongKey = `k${'n'.repeat(MAX_METADATA_KEY_LENGTH)}`;
    const atCapKey = 'k'.repeat(MAX_METADATA_KEY_LENGTH);
    const sse = makeSseBody([
      { type: 'message-metadata', metadata: { [overLongKey]: 1, [atCapKey]: 2, traceId: 't' } },
      { type: 'finish', finishReason: 'stop' },
    ]);
    mockFetch(sse);

    const adapter = createBackendChatAdapter(
      { endpoint: 'https://fake.test/api/ai' },
      makeController(),
    );
    const stream = await adapter.sendMessage(makeSendInput([]));
    const chatChunks = (await collectChunks(stream)).filter(isChatMessageChunk);

    const metaChunk = chatChunks.find((c) => c.type === 'message-metadata') as
      | { metadata: Record<string, unknown> }
      | undefined;
    expect(Object.hasOwn(metaChunk!.metadata, overLongKey)).toBe(false);
    // At the cap, kept — a boundary, not a ban on descriptive keys.
    expect(metaChunk!.metadata[atCapKey]).toBe(2);
    expect(metaChunk!.metadata.traceId).toBe('t');

    vi.unstubAllGlobals();
  });

  // `model` is exempt from the pass-through budget because it is the fixed, renderer-read
  // part of the payload — but it is still a server-controlled string, so the one field the
  // budget does not cover must not be the one that defeats it.
  it('drops a `model` string over the shared wire size cap', async () => {
    const sse = makeSseBody([
      {
        type: 'message-metadata',
        metadata: { model: 'm'.repeat(MAX_STRING_LENGTH + 1), traceId: 't' },
      },
      { type: 'finish', finishReason: 'stop' },
    ]);
    mockFetch(sse);

    const adapter = createBackendChatAdapter(
      { endpoint: 'https://fake.test/api/ai' },
      makeController(),
    );
    const stream = await adapter.sendMessage(makeSendInput([]));
    const chatChunks = (await collectChunks(stream)).filter(isChatMessageChunk);

    const metaChunk = chatChunks.find((c) => c.type === 'message-metadata') as
      | { metadata: Record<string, unknown> }
      | undefined;
    expect(Object.hasOwn(metaChunk!.metadata, 'model')).toBe(false);
    expect(metaChunk!.metadata.traceId).toBe('t');

    vi.unstubAllGlobals();
  });

  // The budget is per `sendMessage`, so a turn that exhausted it must not starve the NEXT
  // turn — otherwise "bounded" would silently mean "the panel stops recording trace ids
  // after one large response", and the same adapter instance serves every turn of a session.
  it('resets the turn budget for the next sendMessage', async () => {
    const half = 'x'.repeat(MAX_STRING_LENGTH / 2);
    const events: object[] = [];
    for (let i = 0; i < 6; i += 1) {
      events.push({ type: 'message-metadata', metadata: { [`blob${i}`]: half } });
    }
    events.push({ type: 'finish', finishReason: 'stop' });

    const adapter = createBackendChatAdapter(
      { endpoint: 'https://fake.test/api/ai' },
      makeController(),
    );

    const keysOfNextTurn = async () => {
      mockFetch(makeSseBody(events));
      const stream = await adapter.sendMessage(makeSendInput([]));
      const chatChunks = (await collectChunks(stream)).filter(isChatMessageChunk);
      return Object.keys(mergeMetadataChunks(chatChunks));
    };

    expect(await keysOfNextTurn()).toEqual(['blob0', 'blob1', 'blob2']);
    expect(await keysOfNextTurn()).toEqual(['blob0', 'blob1', 'blob2']);

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

// ── stop() across an adapter rebuild (regression: H6) ─────────────────────────
//
// The panel rebuilds its adapter whenever `aiConfig`/`customWidgets`/`focusedWidgetId`
// change identity — and `aiConfig` is a public prop that hosts routinely pass inline,
// while the panel re-renders on every streamed token. `ChatBox` dispatches `stop()` to
// whichever adapter it currently holds, so with the reader registry living inside the
// adapter closure, Stop reached a brand-new adapter with an empty set and cancelled
// nothing, while the reader holding the live connection sat unreachable in the
// discarded one. The registry is therefore owned by the caller.

describe('createBackendChatAdapter: stop() survives an adapter rebuild', () => {
  it('cancels a stream started by a previous adapter when the registry is shared', async () => {
    const cancelSpy = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        body: {
          getReader: () => ({
            read: vi.fn().mockImplementation(() => new Promise(() => {})), // never resolves
            cancel: cancelSpy,
            releaseLock: vi.fn(),
          }),
        },
      }),
    );

    const controller = makeController();
    const activeReaders = new Set<ReadableStreamDefaultReader<Uint8Array>>();

    // The adapter the stream starts on…
    const firstAdapter = createBackendChatAdapter(
      { endpoint: 'https://fake.test/api/ai' },
      controller,
      undefined,
      undefined,
      { activeReaders },
    );
    const stream = await firstAdapter.sendMessage(makeSendInput([makeUserMessage('stop me')]));
    stream
      .getReader()
      .read()
      .catch(() => {});
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(activeReaders.size).to.equal(1);

    // …is replaced mid-stream (a fresh `aiConfig` literal, or the user clicking another
    // widget's "Analysis", both of which happen while the response is streaming).
    const rebuiltAdapter = createBackendChatAdapter(
      { endpoint: 'https://fake.test/api/ai' },
      controller,
      undefined,
      'widget-b',
      { activeReaders },
    );

    // Stop is dispatched to the CURRENT adapter, which never started this stream.
    rebuiltAdapter.stop?.();
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });

    expect(cancelSpy).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('cannot cancel it when each adapter owns its own registry (the bug)', async () => {
    // Control: the same scenario WITHOUT a shared registry, pinning that the assertion
    // above is about the shared ownership and not about `stop()` in general.
    const cancelSpy = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        body: {
          getReader: () => ({
            read: vi.fn().mockImplementation(() => new Promise(() => {})),
            cancel: cancelSpy,
            releaseLock: vi.fn(),
          }),
        },
      }),
    );

    const controller = makeController();
    const firstAdapter = createBackendChatAdapter(
      { endpoint: 'https://fake.test/api/ai' },
      controller,
    );
    const stream = await firstAdapter.sendMessage(makeSendInput([makeUserMessage('stop me')]));
    stream
      .getReader()
      .read()
      .catch(() => {});
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });

    const rebuiltAdapter = createBackendChatAdapter(
      { endpoint: 'https://fake.test/api/ai' },
      controller,
    );
    rebuiltAdapter.stop?.();
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });

    expect(cancelSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

// ── turn-mutation ledger (regression: M14) ────────────────────────────────────

describe('createBackendChatAdapter: mutation ledger', () => {
  it('records the doc snapshots around each applied state-mutation, keyed by message id', async () => {
    const sse = makeSseBody([
      {
        type: 'state-mutation',
        mutation: { type: 'setDashboardTitle', args: { title: 'Updated' } },
      },
      { type: 'finish', finishReason: 'stop' },
    ]);
    mockFetch(sse);

    // A controller whose doc identity actually changes when a mutation is applied —
    // the ledger deliberately ignores no-op mutations.
    let doc: object = { dashboard: { title: 'Before' } };
    const controller = {
      // `runtime`/`session` are present because the adapter always serializes state
      // for the request body now (see the `privateMode` note above) — the ledger
      // assertions below are about `doc` alone.
      getState: () => ({ doc, session: {}, runtime: { dataSources: {} } }) as any,
      applyExternalMutation: vi.fn(() => {
        doc = { dashboard: { title: 'Updated' } };
      }),
      getRecentMutations: () => [],
      setState: vi.fn(),
    } as unknown as StudioController;

    const recorded: { messageId: string; before: object; after: object }[] = [];
    const adapter = createBackendChatAdapter(
      { endpoint: 'https://fake.test/api/ai', privateMode: true },
      controller,
      undefined,
      undefined,
      {
        mutationLedger: {
          record: (messageId, before, after) =>
            recorded.push({ messageId, before: before as object, after: after as object }),
          revert: () => false,
          has: () => false,
        },
      },
    );

    const stream = await adapter.sendMessage(makeSendInput([makeUserMessage('add a chart')]));
    const chunks = await collectChunks(stream);

    expect(recorded).toHaveLength(1);
    expect(recorded[0].before).to.deep.equal({ dashboard: { title: 'Before' } });
    expect(recorded[0].after).to.deep.equal({ dashboard: { title: 'Updated' } });
    // Keyed by the assistant message id this turn streamed under, which is what
    // `StudioMessageActions` retries by.
    const startChunk = chunks.filter(isChatMessageChunk).find((chunk) => chunk.type === 'start') as
      | { messageId: string }
      | undefined;
    expect(recorded[0].messageId).to.equal(startChunk?.messageId);

    vi.unstubAllGlobals();
  });

  it('does not record a mutation that left the document unchanged', async () => {
    const sse = makeSseBody([
      { type: 'state-mutation', mutation: { type: 'setDashboardTitle', args: { title: 'Same' } } },
      { type: 'finish', finishReason: 'stop' },
    ]);
    mockFetch(sse);

    const doc = { dashboard: { title: 'Same' } };
    const controller = {
      // `runtime`/`session` are present because the adapter always serializes state
      // for the request body now (see the `privateMode` note above) — the ledger
      // assertions below are about `doc` alone.
      getState: () => ({ doc, session: {}, runtime: { dataSources: {} } }) as any,
      applyExternalMutation: vi.fn(), // reducer no-op: same doc reference back
      getRecentMutations: () => [],
      setState: vi.fn(),
    } as unknown as StudioController;

    const record = vi.fn();
    const adapter = createBackendChatAdapter(
      { endpoint: 'https://fake.test/api/ai', privateMode: true },
      controller,
      undefined,
      undefined,
      { mutationLedger: { record, revert: () => false, has: () => false } },
    );

    await collectChunks(await adapter.sendMessage(makeSendInput([makeUserMessage('noop')])));

    expect(record).not.toHaveBeenCalled();

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

  // `dashboardState` is deliberately NOT omitted here. The endpoint's own validator
  // (`validateStudioAIRequestBody`) hard-requires `dashboardState.doc`, so omitting it
  // made EVERY private-mode request fail before the first LLM call — a defect invisible
  // to this file, which only ever inspects the request body (see
  // `aiMiddlewareSeam.test.ts`, which drives both sides of that wire). What private mode
  // withholds client-side is the DATA: `pageSnapshot`'s sampled row values and
  // `richContext`'s per-field statistics. The dashboard structure is withheld from the
  // PROMPT by the server instead, which is where the provider-facing promise lives.
  it('omits pageSnapshot and richContext, still sends dashboardState, and forwards privateMode:true when on', async () => {
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
    expect(body.dashboardState).toBeDefined();
    expect(body.richContext).toBeUndefined();
    // The real sibling-widget row value never leaves the client in private mode.
    expect(rawBody).not.toContain('12345');

    vi.unstubAllGlobals();
  });

  // Completing the enumeration the `privateMode` doc makes. "The client withholds the
  // data" is true of `pageSnapshot` and `richContext`, and NOT true of `doc.filters`:
  // `serializeDashboardState` empties `doc.ai.threads` and strips
  // `runtime.dataSources[].rows`, but leaves filters untouched — and a `cross-filter`
  // or `interactive` filter's value is a real row value, whatever the user clicked.
  // The provider-facing guarantee still holds (the middleware withholds the whole
  // `<dashboard_state>` block from the prompt), so this pins the boundary where it
  // actually is rather than asserting a leak: if a future change starts scrubbing
  // filter values, or stops sending `doc.filters`, the doc must move with it.
  it('still sends a cross-filter value — a real clicked row value — inside dashboardState', async () => {
    const { fetchMock } = captureRequestBody();

    const withCrossFilter: CreateDefaultStudioStateOverrides = {
      ...stateWithDataWidget,
      doc: {
        ...stateWithDataWidget.doc!,
        filters: [
          {
            id: 'f-cross',
            field: 'region',
            operator: 'equals',
            // Not a field name and not a widget title: the category the user clicked.
            value: 'Zephyr-Northwind',
            scope: { kind: 'cross-filter', sourceWidgetId: 'grid-1', pageId: 'page-1' },
          },
        ],
      },
    };

    const config: StudioAIConfig = { endpoint: 'https://fake.test/api/ai', privateMode: true };
    const adapter = createBackendChatAdapter(config, makeController(withCrossFilter));
    const stream = await adapter.sendMessage(makeSendInput([makeUserMessage('summarise')]));
    await collectChunks(stream);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const rawBody = String(init.body);

    // Sampled rows and field stats: withheld, as documented.
    expect(rawBody).not.toContain('12345');
    // The clicked category: sent, also as documented (now).
    expect(rawBody).toContain('Zephyr-Northwind');
    const body = JSON.parse(rawBody) as {
      dashboardState?: { doc?: { filters?: Array<{ value?: unknown }> } };
    };
    expect(body.dashboardState?.doc?.filters?.[0]?.value).toBe('Zephyr-Northwind');

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

// ── addToolApprovalResponse: non-ok response handling (regression: 2.5) ──────
//
// A 4xx/5xx approval response (e.g. an expired approval id) must not resolve
// cleanly as if the approval was delivered — the server-side loop never actually
// resumes, and the UI would otherwise think the approval went through while the
// conversation hangs. `addToolApprovalResponse` must throw so the caller
// (`useChatController`) can roll back its optimistic update and surface an error.
describe('createBackendChatAdapter: addToolApprovalResponse', () => {
  it('resolves without throwing on a 2xx approval response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('') }),
    );

    const config: StudioAIConfig = { endpoint: 'https://fake.test/api/ai' };
    const adapter = createBackendChatAdapter(config, makeController());

    await expect(
      adapter.addToolApprovalResponse?.({ id: 'call-1', approved: true }),
    ).resolves.toBeUndefined();

    vi.unstubAllGlobals();
  });

  it('throws when the approval endpoint returns a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 410,
        text: () => Promise.resolve('Approval expired'),
      }),
    );

    const config: StudioAIConfig = { endpoint: 'https://fake.test/api/ai' };
    const adapter = createBackendChatAdapter(config, makeController());

    await expect(
      adapter.addToolApprovalResponse?.({ id: 'call-1', approved: true }),
    ).rejects.toThrow('410');

    vi.unstubAllGlobals();
  });
});

// `HTTP 500: <body>` says what happened but names neither the package nor a next step.
describe('createBackendChatAdapter: HTTP failure messages', () => {
  it('prefixes and explains the sendMessage transport failure', async () => {
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

    await expect(collectChunks(stream)).rejects.toThrow(/^MUI X Studio: .*500.*Upstream failure/s);

    vi.unstubAllGlobals();
  });

  it('prefixes and explains the tool-approval transport failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 410,
        statusText: 'Gone',
        text: () => Promise.resolve('Approval expired'),
      }),
    );

    const config: StudioAIConfig = { endpoint: 'https://fake.test/api/ai' };
    const adapter = createBackendChatAdapter(config, makeController());

    await expect(
      adapter.addToolApprovalResponse!({ id: 'call-1', approved: true }),
    ).rejects.toThrow(/^MUI X Studio: .*410.*Approval expired/s);

    vi.unstubAllGlobals();
  });
});
