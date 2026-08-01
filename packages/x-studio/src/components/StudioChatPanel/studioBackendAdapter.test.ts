import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatMessageChunk, ChatStreamEnvelope } from '@mui/x-chat/headless';
// The real store and the real stream processor, so the budget tests can measure the quantity
// that is actually persisted — `JSON.stringify` of the assistant messages
// `useChatThreads.handleMessagesChange` writes into `doc.ai.threads[].messages` — rather than
// a proxy for it. Four rounds of budgets measured adapter CHUNKS and each bounded a subset.
import { ChatStore } from '@mui/x-chat-headless/store';
import { processStream } from '@mui/x-chat-headless/stream';
// Imported, never re-spelled as literals: a test that hard-codes `10_000` would keep passing
// if the shared cap moved and the adapter stopped agreeing with the rest of the boundary.
import { MAX_ARRAY_LENGTH, MAX_STRING_LENGTH, UNSAFE_KEYS } from '@mui/x-studio-schema';
// The shared clause-isolation helper and the shared size-cap inventory. The inventory is
// what makes a cap in THIS package visible to a completeness check at all: the scan it
// drives walks a list of boundary roots across packages, where its predecessor read one
// non-recursive directory in `x-studio-schema` and could not see this file.
import { expectClauseIsolated } from 'test/utils/clauseIsolation';
import { sitesProbedIn } from 'test/utils/sizeCapInventory';
import {
  createBackendChatAdapter,
  MAX_TOOL_ID_LENGTH,
  MAX_TOOL_INPUT_SIZE,
  MAX_TOOL_OUTPUT_SIZE,
  MAX_APPROVAL_INPUT_SIZE,
  MAX_METADATA_KEY_LENGTH,
  MAX_TURN_APPROVAL_INPUT_SIZE,
  MAX_TURN_TOOL_PARTS,
  MAX_TURN_TOOL_ACTIVITY_PARTS,
  MAX_TURN_APPROVAL_PARTS,
  MAX_TURN_APPROVAL_SIZE,
  MAX_TURN_METADATA_SIZE,
  MAX_TURN_TOOL_INPUT_SIZE,
  MAX_TURN_TOOL_OUTPUT_SIZE,
  MAX_TURN_MESSAGE_PARTS,
  MAX_TURN_STEP_PARTS,
  MAX_TURN_TEXT_PARTS,
  MAX_TURN_REASONING_PARTS,
  MAX_TURN_TEXT_SIZE,
  MAX_TURN_REASONING_SIZE,
  MAX_TURN_PERSISTED_MESSAGE_SIZE,
  TOOL_OUTPUT_TRUNCATED_SUFFIX,
  STREAM_TEXT_TRUNCATED_SUFFIX,
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

/**
 * The size of a string in the unit every budget on this boundary is denominated in: JSON
 * characters, i.e. what actually lands in the persisted document.
 *
 * Every assertion below measures with this rather than `String.prototype.length`, which is a
 * DIFFERENT unit — `JSON.stringify` escapes a control character to a six-character `\uXXXX`.
 * Measuring the charge in the same wrong unit the code charged it in is why the previous
 * round's budget tests could not see that the doors were ~6x wider than their docblocks said.
 */
function jsonChars(value: string): number {
  return JSON.stringify(value).length - 2;
}

/**
 * U+0001: ONE UTF-16 unit, SIX JSON characters (`\u0001`). The 6:1 escape that separates the
 * unit the budgets are denominated in from the unit they used to be spent in.
 */
const CONTROL_CHAR = String.fromCharCode(1);

/** A string whose JSON-escaped size is exactly `size`, built mostly of {@link CONTROL_CHAR}. */
function escapingString(size: number): string {
  return CONTROL_CHAR.repeat(Math.floor(size / 6)) + 'a'.repeat(size % 6);
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

/**
 * Every chunk one turn produces, for the budget tests — which need MANY events, because a
 * budget pinned by a single-event test is a budget with no count term.
 */
async function collectAllTurnChunks(events: Record<string, unknown>[]) {
  mockFetch(makeSseBody([...events, { type: 'finish', finishReason: 'stop' }]));
  const adapter = createBackendChatAdapter(
    { endpoint: 'https://fake.test/api/ai' },
    makeController(),
  );
  const stream = await adapter.sendMessage(makeSendInput([]));
  const chunks = (await collectChunks(stream)).filter(isChatMessageChunk);
  vi.unstubAllGlobals();
  return chunks;
}

/**
 * One assistant turn, driven all the way to the sink: adapter -> `processStream` -> a real
 * `ChatStore`. Returns the persisted assistant messages and their size in exactly the unit the
 * saved document is measured in.
 *
 * This is the harness the per-door tests above cannot be: they assert on the chunks the
 * adapter emits, which is one layer short of the message, and a budget verified one layer
 * short of its sink is how five rounds each bounded a subset of the same message.
 */
async function persistOneTurn(events: Record<string, unknown>[]) {
  mockFetch(makeSseBody([...events, { type: 'finish', finishReason: 'stop' }]));
  const adapter = createBackendChatAdapter(
    { endpoint: 'https://fake.test/api/ai' },
    makeController(),
  );
  const stream = await adapter.sendMessage(makeSendInput([]));
  const store = new ChatStore();
  await processStream(store, stream as never, {
    conversationId: 'c1',
    flushInterval: 0,
  }).catch(() => undefined);
  vi.unstubAllGlobals();

  const assistantMessages = store.state.messageIds
    .map((id) => store.state.messagesById[id])
    .filter((message) => message?.role === 'assistant');
  return {
    assistantMessages,
    parts: assistantMessages.flatMap((message) => message.parts),
    persistedJSONChars: JSON.stringify(assistantMessages).length,
  };
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
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunk = await collectApprovalChunk(
      approvalEvent(1, {
        effects: {
          willRemoveWidgets: entities(MAX_ARRAY_LENGTH + 1, 8),
          updatedWidgetCount: 2,
        },
      }),
    );

    // All-or-nothing, deliberately: a SHORTENED "will remove" list understates the impact a
    // human is approving — worse than showing none. What survives is the marker that says a
    // summary existed and was withheld, so the card cannot be mistaken for a harmless call.
    expect(chunk!.effects).toEqual({ effectsWithheld: true });
    warnSpy.mockRestore();
  });

  it('drops the whole effects payload when an entity title is over the shared string cap', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunk = await collectApprovalChunk(
      approvalEvent(1, {
        effects: { willRemoveWidgets: entities(1, MAX_STRING_LENGTH + 1) },
      }),
    );

    expect(chunk!.effects).toEqual({ effectsWithheld: true });
    warnSpy.mockRestore();
  });

  // `willRemoveFilters` is a list of PLAIN STRINGS, not of `{ id, title }` records, so it is
  // the one list `isWithinApprovalListLimits` screens through its `typeof entry === 'string'`
  // branch — and that branch was untested: deleting it left all 59 tests of this file green
  // while a 10 001-character filter id sailed through onto the persisted part.
  it('drops the whole effects payload when a plain-string list entry is over the string cap', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunk = await collectApprovalChunk(
      approvalEvent(1, {
        effects: {
          willRemoveFilters: ['f1', 'f'.repeat(MAX_STRING_LENGTH + 1)],
          updatedWidgetCount: 2,
        },
      }),
    );

    // All-or-nothing, like every other over-limit list: `updatedWidgetCount` goes with it,
    // leaving only the withheld marker.
    expect(chunk!.effects).toEqual({ effectsWithheld: true });
    warnSpy.mockRestore();
  });

  it('drops a `reason` over the shared string cap, keeping the rest of the chunk', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunk = await collectApprovalChunk(
      approvalEvent(1, {
        effects: { updatedWidgetCount: 1 },
        reason: 'r'.repeat(MAX_STRING_LENGTH + 1),
      }),
    );

    expect(chunk!.reason).toBe(undefined);
    // Dropped individually — the approval card itself, and its effects, still render —
    // and the drop is MARKED, so the card cannot be read as "the policy gave no reason".
    expect(chunk!.effects).toEqual({ updatedWidgetCount: 1, reasonWithheld: true });
    expect(chunk!.toolCallId).toBe('call-1');
    warnSpy.mockRestore();
  });

  /**
   * `isWithinApprovalListLimits`, one clause at a time.
   *
   * The guard is one sentence about four things — a list length and three string lengths —
   * and only three of the four were pinned. The unpinned one was `entry.id`: relaxing that
   * clause and nothing else left every test in this package green while one approval card's
   * persisted `effects` went from 399 to 20 429 JSON characters, on the exact field the
   * guard exists to bound. Its `||`-sibling one line down, `entry.title`, WAS pinned; the
   * two sit on the same `if` and are reached by the same fixture shape.
   *
   * The tests below are also the reciprocal half of `SIZE_CAP_INVENTORY`. The inventory (in
   * `test/utils/sizeCapInventory.ts`) enumerates every size cap at the studio wire
   * boundaries from the SOURCE and names, per site, the file carrying its probe — including
   * this one, which is in a different package from the constant it enforces and which no
   * package-scoped scan could ever see. The last test here checks that claim in the other
   * direction, so a probe cannot be deleted while the inventory still credits it.
   */
  describe('isWithinApprovalListLimits — every clause, both directions', () => {
    const INVENTORY_FILE = 'x-studio/src/components/StudioChatPanel/studioBackendAdapter.test.ts';
    const SITE = 'x-studio/chat/studioBackendAdapter.ts:isWithinApprovalListLimits';

    /** `{ id, title }` as the guard receives it — after the SSE JSON round trip, not as typed. */
    function entryAsDelivered(entry: Record<string, unknown>) {
      const event = approvalEvent(1, { effects: { willRemoveWidgets: [entry] } });
      const decoded = JSON.parse(JSON.stringify(event)) as {
        effects: { willRemoveWidgets: Record<string, unknown>[] };
      };
      return decoded.effects.willRemoveWidgets[0];
    }

    /** The two `||` halves of the record-entry clause, transcribed from the source. */
    const ENTRY_CLAUSES = {
      'entry.id.length > MAX_STRING_LENGTH': (entry: Record<string, unknown>) =>
        typeof entry.id === 'string' && entry.id.length > MAX_STRING_LENGTH,
      'entry.title.length > MAX_STRING_LENGTH': (entry: Record<string, unknown>) =>
        typeof entry.title === 'string' && entry.title.length > MAX_STRING_LENGTH,
    };

    async function effectsFor(effects: Record<string, unknown>) {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const chunk = await collectApprovalChunk(approvalEvent(1, { effects }));
      warnSpy.mockRestore();
      return chunk!.effects;
    }

    // Each row: the payload exactly AT the cap, and the same payload one unit over. Neither
    // direction alone is a pin — "accepts everything" passes the first, "rejects everything"
    // passes the second, and only the clause under test can tell the two apart.
    const CLAUSES = [
      {
        site: `${SITE}#0`,
        what: 'the per-list length cap',
        atCap: () => ({ willRemoveWidgets: entities(MAX_ARRAY_LENGTH, 8) }),
        overCap: () => ({ willRemoveWidgets: entities(MAX_ARRAY_LENGTH + 1, 8) }),
      },
      {
        site: `${SITE}#1`,
        what: 'the plain-STRING list entry cap, through `willRemoveFilters`',
        atCap: () => ({ willRemoveFilters: ['f'.repeat(MAX_STRING_LENGTH)] }),
        overCap: () => ({ willRemoveFilters: ['f'.repeat(MAX_STRING_LENGTH + 1)] }),
      },
      {
        site: `${SITE}#2`,
        what: "a record entry's `id`, with a short `title` so the sibling clause cannot answer",
        atCap: () => ({
          willRemoveWidgets: [{ id: 'i'.repeat(MAX_STRING_LENGTH), title: 'Q4 Revenue' }],
        }),
        overCap: () => ({
          willRemoveWidgets: [{ id: 'i'.repeat(MAX_STRING_LENGTH + 1), title: 'Q4 Revenue' }],
        }),
      },
      {
        site: `${SITE}#3`,
        what: "a record entry's `title`, with a short `id` so the sibling clause cannot answer",
        atCap: () => ({
          willRemoveWidgets: [{ id: 'w1', title: 'T'.repeat(MAX_STRING_LENGTH) }],
        }),
        overCap: () => ({
          willRemoveWidgets: [{ id: 'w1', title: 'T'.repeat(MAX_STRING_LENGTH + 1) }],
        }),
      },
    ];

    describe.each(CLAUSES)('$site', ({ what, atCap, overCap }) => {
      it(`keeps the summary for a payload exactly at the cap (${what})`, async () => {
        // A cap is a boundary, not a ban: the payload at the limit still reaches the card.
        expect(await effectsFor(atCap())).not.toEqual({ effectsWithheld: true });
      });

      it('withholds the whole summary one unit over the cap', async () => {
        // All-or-nothing on purpose: a SHORTENED "will remove" list understates the impact a
        // human is approving, which is worse than showing none.
        expect(await effectsFor(overCap())).toEqual({ effectsWithheld: true });
      });
    });

    it('reaches the `id` clause, and not its `title` sibling', () => {
      // The pin above is only worth what its route is worth. `#2` and `#3` are two halves of
      // ONE `||`, so a fixture with both fields over the cap would pass either test with
      // either clause deleted. This checks the entry as it ARRIVES — after the SSE JSON
      // round trip — rather than as it was written a few lines up.
      expect(() =>
        expectClauseIsolated({
          guard: 'studioBackendAdapter.ts:isWithinApprovalListLimits',
          clauses: ENTRY_CLAUSES,
          target: 'entry.id.length > MAX_STRING_LENGTH',
          control: entryAsDelivered({ id: 'i'.repeat(MAX_STRING_LENGTH), title: 'Q4 Revenue' }),
          observed: entryAsDelivered({
            id: 'i'.repeat(MAX_STRING_LENGTH + 1),
            title: 'Q4 Revenue',
          }),
        }),
      ).not.toThrow();
    });

    it('reaches the `title` clause, and not its `id` sibling', () => {
      expect(() =>
        expectClauseIsolated({
          guard: 'studioBackendAdapter.ts:isWithinApprovalListLimits',
          clauses: ENTRY_CLAUSES,
          target: 'entry.title.length > MAX_STRING_LENGTH',
          control: entryAsDelivered({ id: 'w1', title: 'T'.repeat(MAX_STRING_LENGTH) }),
          observed: entryAsDelivered({ id: 'w1', title: 'T'.repeat(MAX_STRING_LENGTH + 1) }),
        }),
      ).not.toThrow();
    });

    it('probes exactly the sites the shared inventory says live in this file', () => {
      expect(CLAUSES.map(({ site }) => site).sort()).toEqual(sitesProbedIn(INVENTORY_FILE).sort());
    });
  });

  it('spends ONE effects/reason budget across every approval event of the turn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
      (total, chunk) =>
        total +
        (chunk.effects && !chunk.effects.effectsWithheld
          ? JSON.stringify(chunk.effects)!.length
          : 0),
      0,
    );
    expect(charged).toBeLessThanOrEqual(MAX_TURN_APPROVAL_SIZE);
    // The later approvals degrade to a card that SAYS its summary is missing, rather than to
    // one indistinguishable from a call with no impact.
    expect(chunks.at(-1)!.effects).toEqual({ effectsWithheld: true });
    expect(chunks[0].effects).not.toBe(undefined);
    warnSpy.mockRestore();
  });

  // A withheld summary and an absent one used to be indistinguishable on the card, and the
  // budget is spent in ARRIVAL order — so an earlier verbose approval (or merely a large
  // dashboard: 40 000 characters is ~700 `{id, title}` entities) silently strips the impact
  // list off the destructive call, which in an agentic turn usually arrives LAST.
  it('marks a summary withheld by the turn budget, on the card and on the console', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const events = Array.from({ length: 6 }, (_unused, i) =>
      approvalEvent(i, { effects: { willRemoveWidgets: entities(400, 12) } }),
    );
    const chunks = await collectApprovalChunks(events);

    // The early cards carry their real summary…
    expect(chunks[0].effects).not.toEqual({ effectsWithheld: true });
    // …and the late one says the summary is missing rather than looking like a call with no
    // impact at all. Same pixels for both is the defect; `effectsWithheld` is the difference.
    expect(chunks.at(-1)!.effects).toEqual({ effectsWithheld: true });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('withheld');
    warnSpy.mockRestore();
  });

  it('marks a summary withheld by the LIST limits, with its own message', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunk = await collectApprovalChunk(
      approvalEvent(1, {
        effects: { willRemoveWidgets: entities(MAX_ARRAY_LENGTH + 1, 8) },
      }),
    );

    expect(chunk!.effects).toEqual({ effectsWithheld: true });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('per-list');
    warnSpy.mockRestore();
  });

  it('does NOT claim a summary was withheld when the server sent none', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // No `effects` at all, an empty record, and an empty list are all "this call removes
    // nothing" — marking them withheld would cry wolf on every harmless approval.
    for (const effects of [undefined, {}, { willRemoveWidgets: [] }]) {
      // Sequential on purpose: each turn is its own adapter and its own budget.
      // eslint-disable-next-line no-await-in-loop
      const chunk = await collectApprovalChunk(approvalEvent(1, effects ? { effects } : {}));
      expect(chunk!.effects).toBe(undefined);
    }
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('spends the same turn budget on `reason`, not a separate one', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reason = 'r'.repeat(MAX_STRING_LENGTH);
    const events = Array.from({ length: 6 }, (_unused, i) => approvalEvent(i, { reason }));
    const chunks = await collectApprovalChunks(events);

    // In JSON characters — `MAX_TURN_APPROVAL_SIZE`'s own unit. Measuring `reason.length`
    // here (what this test used to do) measures the same wrong unit the code charged in, so
    // it agreed with the defect instead of catching it.
    const charged = chunks.reduce(
      (total, chunk) => total + (chunk.reason ? jsonChars(chunk.reason) : 0),
      0,
    );
    expect(charged).toBeLessThanOrEqual(MAX_TURN_APPROVAL_SIZE);
    expect(chunks.filter((chunk) => chunk.reason !== undefined)).toHaveLength(
      MAX_TURN_APPROVAL_SIZE / MAX_STRING_LENGTH,
    );
    warnSpy.mockRestore();
  });

  // ── the UNIT the budgets are denominated in ────────────────────────────────
  //
  // `MAX_TURN_APPROVAL_SIZE`'s docblock says "JSON characters". `effects` and the enriched
  // `input` were charged with `JSON.stringify(...).length`; `reason` and all three ids were
  // charged with `String.prototype.length`. Those are DIFFERENT units — `JSON.stringify`
  // escapes a control character to a six-character `\uXXXX` — so every raw-charged term
  // under-charged by up to 6x. Measured against the docblocks' own claims, before this fix:
  // the approval door persisted 539 422 JSON characters against a stated ~245 KB, and the
  // metadata door 178 052 against a stated ~30 KB (`model` alone: 60 002).
  //
  // The previous round's pinning tests could not see any of it: they measured
  // `(c.reason?.length ?? 0)`, the same wrong unit the code charged in.

  it('charges `reason` in JSON characters, not in raw UTF-16 units', async () => {
    // Exactly `MAX_STRING_LENGTH` JSON characters — at the per-field cap — but only ~1 670
    // UTF-16 units. Charged raw, 23 of these fit the 40 000-character budget and put 230 000
    // JSON characters on one message; charged in the budget's own unit, four do.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reason = escapingString(MAX_STRING_LENGTH);
    expect(jsonChars(reason)).toBe(MAX_STRING_LENGTH);
    expect(reason.length).toBeLessThan(MAX_STRING_LENGTH / 5);

    const chunks = await collectApprovalChunks(
      Array.from({ length: 30 }, (_unused, i) => approvalEvent(i, { reason })),
    );

    const charged = chunks.reduce(
      (total, chunk) => total + (chunk.reason ? jsonChars(chunk.reason) : 0),
      0,
    );
    expect(charged).toBeLessThanOrEqual(MAX_TURN_APPROVAL_SIZE);
    expect(chunks.filter((chunk) => chunk.reason !== undefined)).toHaveLength(
      MAX_TURN_APPROVAL_SIZE / MAX_STRING_LENGTH,
    );
    warnSpy.mockRestore();
  });

  // The per-FIELD cap is in the same unit for the same reason: `MAX_STRING_LENGTH` is a claim
  // about what gets STORED, and 10 000 control characters store 60 000.
  it('rejects a `reason` that is over the per-field cap only once escaped', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunk = await collectApprovalChunk(
      approvalEvent(1, {
        effects: { updatedWidgetCount: 1 },
        reason: CONTROL_CHAR.repeat(MAX_STRING_LENGTH),
      }),
    );

    expect(chunk!.reason).toBe(undefined);
    // Dropped individually and marked, exactly as an over-cap plain-string reason is.
    expect(chunk!.effects).toEqual({ updatedWidgetCount: 1, reasonWithheld: true });
    warnSpy.mockRestore();
  });

  // The asymmetry `22964a2` left behind. Its own premise — '"this call removes nothing" is a
  // reason to approve, "the list did not fit" is a reason to deny, and until now they rendered
  // identically' — was exactly as true of the field NEXT to `effects`, on the same shared
  // budget, and `reason` had no marker and no warning at all.
  //
  // Measured before this fix, on the fixture below: four earlier cards spend the 40 000-
  // character budget, the fifth (`remove_page`, "This deletes the whole Finance page.")
  // arrives with `reason: undefined`, no marker of any kind, and `console.warn` called ZERO
  // times for the whole turn.
  it('marks a `reason` withheld by the turn budget, on the card and on the console', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunks = await collectApprovalChunks([
      ...Array.from({ length: 4 }, (_unused, i) =>
        approvalEvent(i, { reason: 'r'.repeat(MAX_STRING_LENGTH) }),
      ),
      approvalEvent(4, {
        toolName: 'remove_page',
        reason: 'This deletes the whole Finance page.',
      }),
    ]);

    // Every approval still gets a card…
    expect(chunks).toHaveLength(5);
    expect(chunks[0].reason).toBe('r'.repeat(MAX_STRING_LENGTH));
    // …and the destructive one — which in an agentic turn is the one that usually arrives
    // LAST, after the budget is spent — says its reason is missing instead of looking like a
    // call the policy flagged for no stated reason.
    expect(chunks.at(-1)!.reason).toBe(undefined);
    expect(chunks.at(-1)!.effects).toEqual({ reasonWithheld: true });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('reason was withheld');
    warnSpy.mockRestore();
  });

  it('marks a `reason` withheld by the per-field cap, with its own message', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunk = await collectApprovalChunk(
      approvalEvent(1, { reason: 'r'.repeat(MAX_STRING_LENGTH + 1) }),
    );

    expect(chunk!.reason).toBe(undefined);
    expect(chunk!.effects).toEqual({ reasonWithheld: true });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // A different cause from the budget one, so a different message.
    expect(String(warnSpy.mock.calls[0][0])).toContain('longer than');
    warnSpy.mockRestore();
  });

  it('does NOT claim a reason was withheld when the server sent none', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // No `reason` at all, and an empty one, are both "the policy stated nothing" — marking
    // them withheld would cry wolf on every approval that has no justification to give.
    for (const reason of [undefined, '']) {
      // Sequential on purpose: each turn is its own adapter and its own budget.
      // eslint-disable-next-line no-await-in-loop
      const chunk = await collectApprovalChunk(
        approvalEvent(1, reason === undefined ? {} : { reason }),
      );
      expect(chunk!.effects).toBe(undefined);
      expect(chunk!.reason).toBe(undefined);
    }
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // The two markers are independent and must not overwrite each other or the real summary:
  // `effects` is charged FIRST, so a card can keep its whole impact list and lose only its
  // reason — and a reader who sees the list has every reason to assume nothing else was
  // suppressed.
  it('keeps a real effects summary alongside a withheld-reason marker', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunk = await collectApprovalChunk(
      approvalEvent(1, {
        effects: { willRemovePages: [{ id: 'p1', title: 'Finance' }] },
        reason: 'r'.repeat(MAX_STRING_LENGTH + 1),
      }),
    );

    expect(chunk!.effects).toEqual({
      willRemovePages: [{ id: 'p1', title: 'Finance' }],
      reasonWithheld: true,
    });
    warnSpy.mockRestore();
  });

  // A sizeable but legal enriched `input` is forwarded untouched — the cap below is a
  // boundary, not a ban — and the model's own arguments are re-asserted over it at the settle
  // point, here by `flushApprovalGatedInputs` on the ordinary `finish` path. That re-assert is
  // a repair and NOT the bound: see the `MAX_APPROVAL_INPUT_SIZE` tests below for the exit
  // path where it never arrives.
  it('forwards a legal `input` verbatim, and the settle re-asserts the model arguments over it', async () => {
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

  // ── the enriched `input` cap ───────────────────────────────────────────────
  //
  // "It never survives into the persisted message" holds for three exit paths and fails on the
  // fourth. `errorStream` calls `ReadableStreamDefaultController.error()`, which RESETS the
  // queue: measured with one pending approval carrying a 2 MB enriched `input` and a consumer
  // awaiting a macrotask between reads (what `processStream` does), zero re-asserts were
  // delivered and the 2 000 011-byte copy was the last write to `toolInvocation.input`. It is
  // also already persisted while the human deliberates, since the approval is answered on a
  // separate POST while this stream stays open. So the bound is at the WRITE, not at the
  // repair — which means these tests do not have to reproduce that race to be meaningful.

  it('degrades an over-cap `input` to `{}` rather than to the model-supplied one', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunks = (await collectTurnChunks([
      {
        type: 'tool-activity',
        phase: 'start',
        toolCallId: 'call-1',
        toolName: 'remove_widget',
        // The model's own arguments carry the model's own labels; the enrichment exists to
        // overwrite exactly this from real state.
        input: { widgetId: 'w1', widgetTitle: 'Harmless-looking chart' },
      },
      {
        type: 'tool-approval-request',
        toolCallId: 'call-1',
        toolName: 'remove_widget',
        input: { note: 'n'.repeat(MAX_APPROVAL_INPUT_SIZE) },
      },
    ])) as ApprovalChunk[];

    const approval = chunks.find((c) => c.type === 'tool-approval-request') as ApprovalChunk;
    // `{}` — an uninformative card, which a human can deny. NOT the model's arguments: that
    // would put a model-chosen title next to an approve button, which is the one thing the
    // server-side enrichment exists to prevent.
    expect(approval.input).toEqual({});
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('deny');
    warnSpy.mockRestore();
  });

  // `ToolPart`'s `showInput` is `input !== undefined`, and `{}` is DEFINED — so the degraded
  // card above renders an "Input" section reading `{}`, byte-identical to a genuine
  // no-argument call. `22964a2` set the standard that a withheld payload must be visible on
  // the card and not only on the console; the degradation `3ada7a4` introduced was the one
  // place it was not applied.
  it('MARKS the degraded card, so `{}` is not read as "this call takes no arguments"', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunks = (await collectTurnChunks([
      {
        type: 'tool-approval-request',
        toolCallId: 'call-1',
        toolName: 'remove_widget',
        input: { note: 'n'.repeat(MAX_APPROVAL_INPUT_SIZE) },
      },
    ])) as ApprovalChunk[];

    const approval = chunks.find((c) => c.type === 'tool-approval-request') as ApprovalChunk;
    expect(approval.input).toEqual({});
    // The difference between "no arguments" and "the arguments were refused", on the card.
    expect(approval.effects).toEqual({ inputWithheld: true });
    warnSpy.mockRestore();
  });

  it('does NOT mark a genuine no-argument approval as degraded', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunk = await collectApprovalChunk(approvalEvent(1, { input: {} }));

    // `{}` from the server is a real no-argument call, and must stay indistinguishable from
    // nothing — marking it would cry wolf on every parameterless approval.
    expect(chunk!.input).toEqual({});
    expect(chunk!.effects).toBe(undefined);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('keeps a real effects summary alongside a withheld-input marker', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunks = (await collectTurnChunks([
      {
        type: 'tool-approval-request',
        toolCallId: 'call-1',
        toolName: 'remove_page',
        input: { note: 'n'.repeat(MAX_APPROVAL_INPUT_SIZE) },
        effects: { willRemovePages: [{ id: 'p1', title: 'Finance' }] },
      },
    ])) as ApprovalChunk[];

    const approval = chunks.find((c) => c.type === 'tool-approval-request') as ApprovalChunk;
    expect(approval.effects).toEqual({
      willRemovePages: [{ id: 'p1', title: 'Finance' }],
      inputWithheld: true,
    });
    warnSpy.mockRestore();
  });

  // ── the stream-end flush ───────────────────────────────────────────────────
  //
  // `flushApprovalGatedInputs` runs from `closeStream`/`errorStream` to re-assert the model's
  // own arguments over an approval card's display-enriched copy, so `toOpenAIMessages` does
  // not replay a display shape as the model's own on the NEXT request. It fires on paths
  // where the human has NOT answered: an abort mid-card, a server that closes the connection
  // mid-approval, a proxy timeout. Two things it must not do on the way.
  it('re-asserts `{}` for a DEGRADED card, not the model-supplied arguments', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunks = await collectTurnChunks([
      {
        type: 'tool-activity',
        phase: 'start',
        toolCallId: 'call-1',
        toolName: 'remove_widget',
        // The model's own labels — what the server-side enrichment exists to overwrite from
        // real state, and what `MAX_APPROVAL_INPUT_SIZE` refuses to fall back to.
        input: { widgetId: 'w1', widgetTitle: 'Harmless-looking chart' },
      },
      {
        type: 'tool-approval-request',
        toolCallId: 'call-1',
        toolName: 'remove_widget',
        input: { note: 'n'.repeat(MAX_APPROVAL_INPUT_SIZE) },
      },
      // …and the stream ends with the card still pending: no `tool-activity` `complete`.
    ]);

    const approval = chunks.find((c) => c.type === 'tool-approval-request') as ApprovalChunk;
    expect(approval.input).toEqual({});
    // The LAST write to `toolInvocation.input` — the one that persists and that
    // `toOpenAIMessages` replays — is still `{}`. Restoring the model's arguments here would
    // deliver the deceptive fallback the write-time cap refuses, by another route, and onto
    // a card the human can still answer.
    const lastInput = chunks.filter((c) => c.type === 'tool-input-available').at(-1) as {
      input: unknown;
    };
    expect(lastInput.input).toEqual({});
    warnSpy.mockRestore();
  });

  // THE FIXTURE IS PART OF THE TEST. This case used `apply_bulk_update` with
  // `input: { widgetRemovals: ['w1'] }` — ids only, no human-readable label — so it could not
  // show what the flush actually does to a card that is still on screen, and it pinned the
  // deceptive behaviour as correct for two rounds. Its neighbour above already used the
  // label-carrying `remove_widget` shape; this one now does too, and asserts BOTH halves: the
  // model's arguments go back on `input` for the replay, and the card keeps showing the
  // server-resolved copy.
  it('re-asserts the model arguments for the REPLAY without putting them on the card', async () => {
    const chunks = await collectTurnChunks([
      {
        type: 'tool-activity',
        phase: 'start',
        toolCallId: 'call-1',
        toolName: 'remove_widget',
        // The model's own label for what it wants deleted — the thing the server-side
        // enrichment exists to overwrite from real state.
        input: { widgetId: 'w1', widgetTitle: 'Scratch notes (empty, safe to delete)' },
      },
      {
        type: 'tool-approval-request',
        toolCallId: 'call-1',
        toolName: 'remove_widget',
        // …and what the server resolved it to.
        input: { widgetId: 'w1', widgetTitle: 'Q4 Revenue — Board Deck' },
      },
      // …and the stream ends with the card still pending, which is when the flush fires.
    ]);

    // The replay half: `toolInvocation.input` ends up as what the model actually said, so
    // `toOpenAIMessages` does not resend a display shape as the model's own arguments.
    const lastInput = chunks.filter((c) => c.type === 'tool-input-available').at(-1) as {
      input: unknown;
    };
    expect(lastInput.input).toEqual({
      widgetId: 'w1',
      widgetTitle: 'Scratch notes (empty, safe to delete)',
    });

    // The card half: what `ToolPart` draws above the Approve button is carried on the approval
    // chunk, which the flush never rewrites — so the human still reads the server's title, not
    // the model's. Without a field of its own, the assertion above and this one are the same
    // field, and satisfying one meant losing the other.
    const approval = chunks.find((c) => c.type === 'tool-approval-request') as ApprovalChunk;
    expect(approval.input).toEqual({ widgetId: 'w1', widgetTitle: 'Q4 Revenue — Board Deck' });
  });

  it('accepts an `input` exactly AT the per-card cap', async () => {
    // `{"note":"n…"}` serializes to exactly MAX_APPROVAL_INPUT_SIZE characters.
    const note = 'n'.repeat(MAX_APPROVAL_INPUT_SIZE - '{"note":""}'.length);
    const chunks = (await collectTurnChunks([
      { type: 'tool-approval-request', toolCallId: 'call-1', toolName: 't', input: { note } },
    ])) as ApprovalChunk[];

    const approval = chunks.find((c) => c.type === 'tool-approval-request') as ApprovalChunk;
    expect(JSON.stringify(approval.input)).toHaveLength(MAX_APPROVAL_INPUT_SIZE);
  });

  it('spends ONE enriched-input budget across every approval event of the turn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 40 events, each individually legal at half the per-card cap. A per-EVENT limit accepts
    // all 40 and puts ~800 KB of enriched inputs on one message; the turn budget does not.
    const chunks = (await collectTurnChunks(
      Array.from({ length: 40 }, (_unused, i) =>
        approvalEvent(i, { input: { note: 'n'.repeat(MAX_APPROVAL_INPUT_SIZE / 2) } }),
      ),
    )) as ApprovalChunk[];

    const approvals = chunks.filter((c) => c.type === 'tool-approval-request') as ApprovalChunk[];
    const inputBytes = approvals.reduce(
      (total, c) => total + (JSON.stringify(c.input)?.length ?? 0),
      0,
    );
    expect(inputBytes).toBeLessThanOrEqual(MAX_TURN_APPROVAL_INPUT_SIZE);
    // Every approval still gets a card — only the details are withheld once the budget is out.
    expect(approvals).toHaveLength(40);
    expect(approvals[0].input).not.toEqual({});
    expect(approvals.at(-1)!.input).toEqual({});
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  // ── id/name caps and the PART COUNT ────────────────────────────────────────
  //
  // `effects` and `reason` were capped one round ago and the commit claimed "~40 KB per
  // assistant message, independent of the event count". Both halves were false: the same
  // `toolInvocation` also carries `toolCallId`, `toolName` and `approvalId` (measured:
  // 1 000 000 characters each, forwarded verbatim), and `processStream` makes a NEW part per
  // distinct `toolCallId`, so the part count multiplied whatever the per-part fields cost
  // (measured: 50 events x 20 000-character ids = 2 003 790 bytes on one message).
  //
  // Every test below therefore emits MANY events. A budget pinned by a single-event test is
  // a budget with no count term, which is what the previous two rounds each shipped.

  /** Every chunk of one turn, not just the approval ones. */
  async function collectTurnChunks(events: Record<string, unknown>[]) {
    mockFetch(makeSseBody([...events, { type: 'finish', finishReason: 'stop' }]));
    const adapter = createBackendChatAdapter(
      { endpoint: 'https://fake.test/api/ai' },
      makeController(),
    );
    const stream = await adapter.sendMessage(makeSendInput([]));
    const chunks = (await collectChunks(stream)).filter(isChatMessageChunk);
    vi.unstubAllGlobals();
    return chunks;
  }

  it('DROPS an approval whose ids are over the id cap — over many events, and audibly', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const huge = 'x'.repeat(MAX_TOOL_ID_LENGTH + 1);
    const chunks = await collectTurnChunks(
      Array.from({ length: 50 }, (_unused, i) => ({
        type: 'tool-approval-request',
        approvalId: `${huge}-${i}`,
        toolCallId: `${huge}-${i}`,
        toolName: huge,
        input: {},
      })),
    );

    // Not truncated — dropped. All three are correlation keys: a shortened `toolCallId` no
    // longer matches the `tool-activity` that gates it, and a shortened `approvalId` names
    // nothing the server can resolve when the human answers.
    expect(chunks.filter((c) => c.type === 'tool-approval-request')).toHaveLength(0);
    // …and the dropped events left no bookkeeping behind: `approvalGatedToolCalls` was never
    // written, so the stream-end flush has nothing to re-assert for a card nobody ever saw.
    expect(chunks.filter((c) => c.type === 'tool-input-available')).toHaveLength(0);
    // Withheld, not silently withheld.
    expect(warnSpy).toHaveBeenCalledTimes(1); // once per turn, not once per event
    expect(String(warnSpy.mock.calls[0][0])).toContain('approvalId');
    warnSpy.mockRestore();
  });

  // Each clause of the guard pinned ALONE. Both tests above set all three fields over the cap
  // at once, which cannot tell a three-clause guard from a one-clause one: any single clause
  // is masked by its siblings, so the measurement `360af86`'s own message quotes — "a
  // 1 000 000-character `toolName` and a 1 000 000-character `approvalId` were forwarded
  // verbatim" — was restorable by deleting one clause with the whole suite green. (Verified:
  // deleting the `toolName` clause, and separately the `approvalId` clause, each SURVIVED the
  // full file.)
  it('DROPS an approval for an over-cap toolCallId ALONE', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunks = await collectTurnChunks(
      Array.from({ length: 20 }, (_unused, i) => ({
        type: 'tool-approval-request',
        toolCallId: `${'x'.repeat(MAX_TOOL_ID_LENGTH + 1)}-${i}`,
        toolName: 'remove_widget',
        approvalId: 'approval-1',
        input: {},
      })),
    );

    expect(chunks.filter((c) => c.type === 'tool-approval-request')).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('DROPS an approval for an over-cap toolName ALONE', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunks = await collectTurnChunks(
      Array.from({ length: 20 }, (_unused, i) =>
        approvalEvent(i, {
          toolName: 'n'.repeat(MAX_TOOL_ID_LENGTH + 1),
          approvalId: `approval-${i}`,
        }),
      ),
    );

    expect(chunks.filter((c) => c.type === 'tool-approval-request')).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('DROPS an approval for an over-cap approvalId ALONE', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunks = await collectTurnChunks(
      Array.from({ length: 20 }, (_unused, i) =>
        approvalEvent(i, { approvalId: `${'a'.repeat(MAX_TOOL_ID_LENGTH + 1)}-${i}` }),
      ),
    );

    expect(chunks.filter((c) => c.type === 'tool-approval-request')).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  // …and an ABSENT `approvalId` is not an over-cap one. `(approvalId?.length ?? 0) > CAP` said
  // so by accident of the `?? 0`; `approvalId !== undefined && …` says so on purpose, and this
  // is what stops a rewrite of that clause from dropping every approval that has no separate
  // approval id — which is most of them.
  it('does not treat an ABSENT approvalId as over-cap', async () => {
    const chunks = await collectTurnChunks([approvalEvent(1, {})]);

    const approval = chunks.find((c) => c.type === 'tool-approval-request') as ApprovalChunk;
    expect(approval).not.toBe(undefined);
    expect(approval.approvalId).toBe(undefined);
  });

  // Dropping the event is the right trade — a truncated correlation key names nothing — but
  // it is not free once a `tool-activity` `start` has already put the card on screen.
  // `processStream` leaves that part at `input-available`, which `resolveToolStatusIcon`
  // renders as an infinite SPINNER: no button ever appears, nothing says why, and the user
  // waits out the server's 120-second approval timeout before the call fails closed. Only one
  // `console.warn` marked the whole episode, and the console is not where the person holding
  // the deny button is looking.
  it('resolves the card a dropped approval would otherwise leave spinning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunks = await collectTurnChunks([
      // A perfectly ordinary call — short `toolCallId`, so the card renders…
      {
        type: 'tool-activity',
        phase: 'start',
        toolCallId: 'call-1',
        toolName: 'remove_widget',
        input: { widgetId: 'w1' },
      },
      // …and its approval is dropped for an over-cap `approvalId` ALONE.
      {
        type: 'tool-approval-request',
        toolCallId: 'call-1',
        toolName: 'remove_widget',
        approvalId: 'a'.repeat(MAX_TOOL_ID_LENGTH + 1),
        input: {},
      },
    ]);

    expect(chunks.filter((c) => c.type === 'tool-approval-request')).toHaveLength(0);
    // The card resolves — with an explanation, on the card, in the state
    // `resolveToolStatusIcon` draws as an error rather than as "still running".
    const failure = chunks.find((c) => c.type === 'tool-output-error') as {
      toolCallId: string;
      errorText: string;
    };
    expect(failure).not.toBe(undefined);
    expect(failure.toolCallId).toBe('call-1');
    expect(failure.errorText).toContain('Nothing was approved and nothing ran');
    warnSpy.mockRestore();
  });

  it('does not invent a failure card for a dropped approval nobody ever saw', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // No `tool-activity` first, and the `toolCallId` itself is over-cap: there is no part to
    // resolve, so there must be no chunk either — and certainly not one carrying the id this
    // boundary just refused to store.
    const chunks = await collectTurnChunks(
      Array.from({ length: 20 }, (_unused, i) => ({
        type: 'tool-approval-request',
        toolCallId: `${'x'.repeat(MAX_TOOL_ID_LENGTH + 1)}-${i}`,
        toolName: 'remove_widget',
        input: {},
      })),
    );

    expect(chunks.filter((c) => c.type === 'tool-output-error')).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it('accepts ids exactly AT the cap (the cap is a boundary, not a ban)', async () => {
    const atCap = 'c'.repeat(MAX_TOOL_ID_LENGTH);
    const chunks = (await collectTurnChunks([
      {
        type: 'tool-approval-request',
        approvalId: atCap,
        toolCallId: atCap,
        toolName: atCap,
        input: {},
      },
    ])) as ApprovalChunk[];

    const approval = chunks.find((c) => c.type === 'tool-approval-request') as ApprovalChunk;
    expect(approval).not.toBe(undefined);
    expect(approval.toolCallId).toBe(atCap);
    expect(approval.toolName).toBe(atCap);
    expect(approval.approvalId).toBe(atCap);
  });

  // The three ids carry NO turn budget: this cap times the part count IS their bound, so the
  // unit it is measured in is the whole bound. Measured while they were capped by
  // `String.prototype.length`: ids of 256 control characters passed the cap and persisted
  // 1 536 JSON characters apiece — 64 parts x 3 fields x 1 536 = 294 912, against the 49 152
  // the docblock's arithmetic claims.
  it('caps the ids in JSON characters, not in raw UTF-16 units', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const atRawCap = CONTROL_CHAR.repeat(MAX_TOOL_ID_LENGTH);
    expect(atRawCap.length).toBe(MAX_TOOL_ID_LENGTH);
    expect(jsonChars(atRawCap)).toBe(MAX_TOOL_ID_LENGTH * 6);

    const chunks = await collectTurnChunks(
      Array.from({ length: 50 }, (_unused, i) => {
        // Distinct per event and still INSIDE the raw cap, so only the JSON measurement can
        // reject it: charged with `String.prototype.length` all 50 of these sailed through.
        const distinct = `${CONTROL_CHAR.repeat(MAX_TOOL_ID_LENGTH - 6)}c${i}`;
        expect(distinct.length).toBeLessThanOrEqual(MAX_TOOL_ID_LENGTH);
        return {
          type: 'tool-approval-request',
          approvalId: atRawCap,
          toolCallId: distinct,
          toolName: atRawCap,
          input: {},
        };
      }),
    );

    expect(chunks.filter((c) => c.type === 'tool-approval-request')).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('accepts an escaping id whose JSON size is exactly AT the cap', async () => {
    // A unit fix, not a tightening: what the cap admits is 256 characters OF STORAGE, however
    // they are spelled.
    const atJsonCap = escapingString(MAX_TOOL_ID_LENGTH);
    expect(jsonChars(atJsonCap)).toBe(MAX_TOOL_ID_LENGTH);

    const chunks = (await collectTurnChunks([
      {
        type: 'tool-approval-request',
        approvalId: atJsonCap,
        toolCallId: atJsonCap,
        toolName: atJsonCap,
        input: {},
      },
    ])) as ApprovalChunk[];

    const approval = chunks.find((c) => c.type === 'tool-approval-request') as ApprovalChunk;
    expect(approval).not.toBe(undefined);
    expect(approval.approvalId).toBe(atJsonCap);
  });

  it('bounds the NUMBER of approval parts one turn adds to the message', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Every event individually legal — short ids, no `effects`, no `reason`. Only the COUNT
    // is hostile, which is exactly the term a size-only budget cannot see.
    const chunks = await collectTurnChunks(
      Array.from({ length: MAX_TURN_TOOL_PARTS * 4 }, (_unused, i) =>
        approvalEvent(i, { toolName: 'apply_bulk_update' }),
      ),
    );

    expect(chunks.filter((c) => c.type === 'tool-approval-request')).toHaveLength(
      MAX_TURN_TOOL_PARTS,
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('charges the part budget per DISTINCT toolCallId, so a re-prompt still gets through', async () => {
    // `processStream` routes the chunk through `withToolInvocation(chunk.toolCallId, …)`: a
    // repeat id overwrites the part it already made rather than adding one, so it costs the
    // persisted message nothing and must not cost the budget either.
    const chunks = await collectTurnChunks(
      Array.from({ length: MAX_TURN_TOOL_PARTS * 3 }, () => approvalEvent(1, {})),
    );

    expect(chunks.filter((c) => c.type === 'tool-approval-request')).toHaveLength(
      MAX_TURN_TOOL_PARTS * 3,
    );
  });

  // …and pinned in the ONE case where "per distinct id" is observable at all: AFTER the
  // budget is full. The test above sends 192 repeats of ONE id, so `turnToolPartIds.size` is 1
  // throughout and the budget is never approached — charging per EVENT instead of per distinct
  // id passes it unchanged (verified: that mutant SURVIVED the whole file). A re-prompt
  // arriving after 64 distinct ids is the only shape that tells the two apart, and it is
  // exactly the shape the distinction exists for: a server re-asking about a call the human
  // did not answer must not be silenced by a budget it already paid.
  it('lets a re-prompt through even after the part budget is FULL', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunks = await collectTurnChunks([
      // Fill the shared budget with distinct ids…
      ...Array.from({ length: MAX_TURN_TOOL_PARTS }, (_unused, i) => approvalEvent(i, {})),
      // …then a NEW id, which must be refused…
      approvalEvent(9_999, {}),
      // …and a re-prompt of one already-open card, which must not be.
      approvalEvent(0, { reason: 'still waiting on you' }),
    ]);

    const approvals = chunks.filter((c) => c.type === 'tool-approval-request') as ApprovalChunk[];
    // 64 openings + the re-prompt; the 65th distinct id is not among them.
    expect(approvals).toHaveLength(MAX_TURN_TOOL_PARTS + 1);
    expect(approvals.some((c) => c.toolCallId === 'call-9999')).toBe(false);
    expect(approvals.at(-1)!.toolCallId).toBe('call-0');
    expect(approvals.at(-1)!.reason).toBe('still waiting on you');
    warnSpy.mockRestore();
  });

  // EVERY quantity below is measured in JSON CHARACTERS — `jsonChars` for the strings,
  // `JSON.stringify(...).length` for the objects — because that is the unit the budgets are
  // denominated in and the unit the saved document is measured in. The previous version of
  // this test measured `c.toolCallId.length` and `c.reason?.length`: the same raw UTF-16 unit
  // the code charged in, so it could not see that the two disagreed with the budget.
  //
  // And every capped string here ESCAPES. Plain ASCII makes the two units coincide, which is
  // precisely how a 6x under-charge stayed green through two rounds of budget tests.
  it('holds the WHOLE per-turn arithmetic: per-field x per-part x part-count, in JSON characters', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 500 events. Every EVEN one sits at every per-field cap it can reach, spelled in
    // control characters (at-cap ids, an at-cap `reason`, a sizeable well-typed `effects`, a
    // half-cap enriched `input`); every ODD one carries the 20 000-character ids that were
    // measured going through verbatim. Every term of the bound is load-bearing here: drop the
    // id cap and the odd events multiply `idBytes` by ~78x, drop the count cap and the even
    // events multiply it by ~4x, drop either size budget and `payloadBytes`/`inputBytes` grow
    // with the event count, and charge any of them raw and the JSON totals grow ~6x.
    const chunks = (await collectTurnChunks(
      Array.from({ length: 500 }, (_unused, i) => {
        const idPrefix = `call-${i}-`;
        return i % 2 === 0
          ? {
              type: 'tool-approval-request',
              approvalId: escapingString(MAX_TOOL_ID_LENGTH),
              toolCallId: idPrefix + escapingString(MAX_TOOL_ID_LENGTH - idPrefix.length),
              toolName: escapingString(MAX_TOOL_ID_LENGTH),
              input: { note: escapingString(MAX_APPROVAL_INPUT_SIZE / 2) },
              effects: { willRemoveWidgets: entities(400, 12) },
              reason: escapingString(MAX_STRING_LENGTH),
            }
          : {
              type: 'tool-approval-request',
              approvalId: 'a'.repeat(20_000),
              toolCallId: `over-${i}`.padEnd(20_000, 'p'),
              toolName: 'n'.repeat(20_000),
              input: {},
            };
      }),
    )) as ApprovalChunk[];

    const approvals = chunks.filter((c) => c.type === 'tool-approval-request') as ApprovalChunk[];
    const idBytes = approvals.reduce(
      (total, c) =>
        total +
        jsonChars(c.toolCallId) +
        jsonChars(c.toolName) +
        (c.approvalId ? jsonChars(c.approvalId) : 0),
      0,
    );
    // The withheld MARKER and the `{}` an over-cap input degrades to are CONSTANTS per part
    // rather than payloads, so they are counted against the part count below, not against the
    // effects/reason and input budgets.
    const withheldMarkerBytes =
      '{"effectsWithheld":true,"reasonWithheld":true,"inputWithheld":true}'.length;
    const degradedInputBytes = '{}'.length;
    const payloadBytes = approvals.reduce(
      (total, c) =>
        total +
        (c.effects && !c.effects.effectsWithheld ? JSON.stringify(c.effects)!.length : 0) +
        (c.reason ? jsonChars(c.reason) : 0),
      0,
    );
    const markerBytes = approvals.reduce(
      (total, c) =>
        total +
        (c.effects?.effectsWithheld || c.effects?.reasonWithheld || c.effects?.inputWithheld
          ? withheldMarkerBytes
          : 0),
      0,
    );

    const inputBytes = approvals.reduce(
      (total, c) => total + (JSON.stringify(c.input)?.length ?? 0),
      0,
    );

    // ids/names: 3 fields x MAX_TOOL_ID_LENGTH x MAX_TURN_TOOL_PARTS = 49 152.
    expect(idBytes).toBeLessThanOrEqual(3 * MAX_TOOL_ID_LENGTH * MAX_TURN_TOOL_PARTS);
    // effects + reason: one turn-wide budget, unchanged by the part count.
    expect(payloadBytes).toBeLessThanOrEqual(MAX_TURN_APPROVAL_SIZE);
    // the display-enriched inputs: their own turn-wide budget, plus the `{}` each degraded
    // card carries.
    expect(inputBytes).toBeLessThanOrEqual(
      MAX_TURN_APPROVAL_INPUT_SIZE + degradedInputBytes * MAX_TURN_TOOL_PARTS,
    );
    // the withheld markers: a constant, x the part count.
    expect(markerBytes).toBeLessThanOrEqual(withheldMarkerBytes * MAX_TURN_TOOL_PARTS);
    // …and the whole door, stated as one number the commit message can quote: 250 816 JSON
    // characters per assistant turn.
    expect(idBytes + payloadBytes + inputBytes + markerBytes).toBeLessThanOrEqual(
      3 * MAX_TOOL_ID_LENGTH * MAX_TURN_TOOL_PARTS +
        MAX_TURN_APPROVAL_SIZE +
        MAX_TURN_APPROVAL_INPUT_SIZE +
        (withheldMarkerBytes + degradedInputBytes) * MAX_TURN_TOOL_PARTS,
    );
    // Each term is really binding here, so the total is not passing by accident.
    expect(approvals).toHaveLength(MAX_TURN_TOOL_PARTS);
    // The last card lost ALL THREE payloads to the budgets, and says so about each.
    expect(approvals.at(-1)!.effects).toEqual({
      effectsWithheld: true,
      reasonWithheld: true,
      inputWithheld: true,
    });
    expect(approvals.at(-1)!.reason).toBe(undefined);
    expect(approvals.at(-1)!.input).toEqual({});
    warnSpy.mockRestore();
  });
});

// ── usage handling ────────────────────────────────────────────────────────────

// ── the tool-activity door ────────────────────────────────────────────────────
//
// The FOURTH recurrence of one class, and the door beside the one the last round bounded.
// `tool-activity` writes `toolInvocation.toolCallId`/`toolName`/`input`/`output` onto
// `doc.ai.threads[].messages` through exactly the same `handleMessagesChange` write the
// approval door does — and it needs no approval gating at all, so it is the CHEAPER of the
// two to abuse. It had no id cap, no input cap, no output cap and no part-count cap.
//
// Measured on ONE assistant message before these budgets: 50 `start` events with
// 20 000-character ids and 200 000-character inputs plus their 50 `complete` events with
// 2 000 000-character outputs persisted 112 000 790 JSON characters — 112 MB, against the
// approval door's freshly-argued 245 KB, and 56x the 2 003 790 bytes that motivated capping
// the approval door in the first place.
//
// Every test here therefore emits MANY events.

describe('createBackendChatAdapter: tool-activity size limits', () => {
  function startEvent(index: number, extra: Record<string, unknown> = {}) {
    return {
      type: 'tool-activity',
      phase: 'start',
      toolCallId: `call-${index}`,
      toolName: 'query_data_source',
      input: { table: 'orders' },
      ...extra,
    };
  }

  function completeEvent(index: number, extra: Record<string, unknown> = {}) {
    return {
      type: 'tool-activity',
      phase: 'complete',
      toolCallId: `call-${index}`,
      toolName: 'query_data_source',
      output: 'ok',
      ...extra,
    };
  }

  it('DROPS a tool activity whose ids are over the id cap — over many events, and audibly', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const huge = 'x'.repeat(MAX_TOOL_ID_LENGTH + 1);
    const chunks = await collectAllTurnChunks(
      Array.from({ length: 50 }, (_unused, i) => ({
        type: 'tool-activity',
        phase: 'start',
        toolCallId: `${huge}-${i}`,
        toolName: huge,
        input: {},
      })),
    );

    // Not truncated — dropped. `toolCallId` is the key `withToolInvocation` matches parts by
    // and the key an approval correlates against; a shortened one names nothing.
    expect(chunks.filter((c) => c.type === 'tool-input-start')).toHaveLength(0);
    expect(chunks.filter((c) => c.type === 'tool-input-available')).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledTimes(1); // once per turn, not once per event
    expect(String(warnSpy.mock.calls[0][0])).toContain('toolCallId');
    warnSpy.mockRestore();
  });

  it('caps the tool-activity ids in JSON characters, not in raw UTF-16 units', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // At the RAW cap, six times over it once stored — the same unit defect the approval door
    // carried, on the door that had no cap at all.
    const atRawCap = CONTROL_CHAR.repeat(MAX_TOOL_ID_LENGTH);
    expect(atRawCap.length).toBe(MAX_TOOL_ID_LENGTH);

    const chunks = await collectAllTurnChunks(
      Array.from({ length: 50 }, (_unused, i) => ({
        type: 'tool-activity',
        phase: 'start',
        toolCallId: `${CONTROL_CHAR.repeat(MAX_TOOL_ID_LENGTH - 6)}c${i}`,
        toolName: atRawCap,
        input: {},
      })),
    );

    expect(chunks.filter((c) => c.type === 'tool-input-start')).toHaveLength(0);
    warnSpy.mockRestore();
  });

  // Each clause of the id guard pinned ALONE. A test that sets every field over the cap at
  // once cannot tell a two-clause guard from a three-clause one: any single clause is masked
  // by its siblings, and the defect it guards is restorable one clause at a time with the
  // suite green.
  it('drops a tool activity for an over-cap toolCallId ALONE', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunks = await collectAllTurnChunks(
      Array.from({ length: 20 }, (_unused, i) =>
        startEvent(i, { toolCallId: `${'x'.repeat(MAX_TOOL_ID_LENGTH + 1)}-${i}` }),
      ),
    );

    expect(chunks.filter((c) => c.type === 'tool-input-start')).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it('drops a tool activity for an over-cap toolName ALONE', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunks = await collectAllTurnChunks(
      Array.from({ length: 20 }, (_unused, i) =>
        startEvent(i, { toolName: 'n'.repeat(MAX_TOOL_ID_LENGTH + 1) }),
      ),
    );

    expect(chunks.filter((c) => c.type === 'tool-input-start')).toHaveLength(0);
    warnSpy.mockRestore();
  });

  // The same spinner, through the other door: a `complete` dropped for an over-cap `toolName`
  // leaves the part its own `start` created stuck at `input-available` forever.
  it('resolves the card when a `complete` is dropped for an over-cap toolName', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunks = await collectAllTurnChunks([
      startEvent(1),
      completeEvent(1, { toolName: 'n'.repeat(MAX_TOOL_ID_LENGTH + 1) }),
    ]);

    expect(chunks.filter((c) => c.type === 'tool-output-available')).toHaveLength(0);
    const failure = chunks.find((c) => c.type === 'tool-output-error') as {
      toolCallId: string;
      errorText: string;
    };
    expect(failure).not.toBe(undefined);
    expect(failure.toolCallId).toBe('call-1');
    expect(failure.errorText).toContain('too long to store');
    warnSpy.mockRestore();
  });

  it('accepts tool-activity ids exactly AT the cap (a boundary, not a ban)', async () => {
    const atCap = 'c'.repeat(MAX_TOOL_ID_LENGTH);
    const chunks = await collectAllTurnChunks([
      { type: 'tool-activity', phase: 'start', toolCallId: atCap, toolName: atCap, input: {} },
    ]);

    const start = chunks.find((c) => c.type === 'tool-input-start') as { toolCallId: string };
    expect(start).not.toBe(undefined);
    expect(start.toolCallId).toBe(atCap);
  });

  it('bounds the NUMBER of tool parts one turn adds to the message', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Every event individually legal — short ids, tiny input. Only the COUNT is hostile,
    // which is exactly the term a size-only budget cannot see, and the term this door did
    // not have at all.
    const chunks = await collectAllTurnChunks(
      Array.from({ length: MAX_TURN_TOOL_PARTS * 4 }, (_unused, i) => startEvent(i)),
    );

    // This door's slice of the shared budget, not the whole of it: the remainder is reserved
    // for approvals, which lose an approve button where this door loses a read-only card.
    expect(chunks.filter((c) => c.type === 'tool-input-start')).toHaveLength(
      MAX_TURN_TOOL_ACTIVITY_PARTS,
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('charges the part budget per DISTINCT toolCallId, so start+complete of one call costs one', async () => {
    // The ordinary agentic shape: `start` then `complete` for the same id is ONE part, and
    // `withToolInvocation` updates it in place — so it must cost the shared budget once.
    const events = Array.from({ length: MAX_TURN_TOOL_ACTIVITY_PARTS }, (_unused, i) => [
      startEvent(i),
      completeEvent(i),
    ]).flat();
    const chunks = await collectAllTurnChunks(events);

    expect(chunks.filter((c) => c.type === 'tool-input-start')).toHaveLength(
      MAX_TURN_TOOL_ACTIVITY_PARTS,
    );
    expect(chunks.filter((c) => c.type === 'tool-output-available')).toHaveLength(
      MAX_TURN_TOOL_ACTIVITY_PARTS,
    );
  });

  // The same distinction, pinned where it is observable: AFTER the budget is full. Charging
  // per EVENT rather than per distinct id passes every test that never fills the budget —
  // and here it would strand 64 already-open cards on a spinner, because their `complete`
  // events would be dropped by a budget their `start` events already paid.
  it('lets a repeat of an already-open call through even after the part budget is FULL', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunks = await collectAllTurnChunks([
      // Fill this door's slice of the shared budget with distinct ids…
      ...Array.from({ length: MAX_TURN_TOOL_ACTIVITY_PARTS }, (_unused, i) => startEvent(i)),
      // …then a NEW id, which must be refused…
      startEvent(9_999),
      // …a REPEAT of an already-open id, which must not be: `withToolInvocation` updates that
      // part in place, so it adds nothing to the message and must cost the budget nothing.
      // This is the event the per-EVENT charge drops and the per-DISTINCT-id charge does not.
      startEvent(0, { input: { table: 'orders', retry: true } }),
      // …and every already-open call settling, which must not be either.
      ...Array.from({ length: MAX_TURN_TOOL_ACTIVITY_PARTS }, (_unused, i) => completeEvent(i)),
    ]);

    const starts = chunks.filter((c) => c.type === 'tool-input-start') as {
      toolCallId: string;
    }[];
    // 48 openings + the repeat of `call-0`; the 49th distinct id is not among them.
    expect(starts).toHaveLength(MAX_TURN_TOOL_ACTIVITY_PARTS + 1);
    expect(starts.some((c) => c.toolCallId === 'call-9999')).toBe(false);
    expect(starts.at(-1)!.toolCallId).toBe('call-0');
    // Every card that was opened also resolves — none is stranded on a spinner by a budget
    // its own `start` already paid.
    expect(chunks.filter((c) => c.type === 'tool-output-available')).toHaveLength(
      MAX_TURN_TOOL_ACTIVITY_PARTS,
    );
    warnSpy.mockRestore();
  });

  // The part budget is ONE budget across BOTH doors, because both add parts to the same
  // message and a part either door creates is indistinguishable from one the other created.
  // Two budgets of 64 would bound each door at 64 and the message at 128.
  it('shares ONE part budget with the approval door, minus the approvals reserve', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunks = await collectAllTurnChunks([
      ...Array.from({ length: MAX_TURN_TOOL_PARTS }, (_unused, i) => startEvent(i)),
      ...Array.from({ length: MAX_TURN_APPROVAL_PARTS * 2 }, (_unused, i) => ({
        type: 'tool-approval-request',
        toolCallId: `approval-only-${i}`,
        toolName: 'remove_widget',
        input: {},
      })),
    ]);

    // The tool-activity events spent every part they are allowed…
    expect(chunks.filter((c) => c.type === 'tool-input-start')).toHaveLength(
      MAX_TURN_TOOL_ACTIVITY_PARTS + 1, // + the one notice part the refused approvals earn
    );
    // …and the approvals, which name NEW ids, still get the reserve — the whole point of it.
    expect(chunks.filter((c) => c.type === 'tool-approval-request')).toHaveLength(
      MAX_TURN_APPROVAL_PARTS,
    );
    // …but not one part more: the two doors add at most MAX_TURN_TOOL_PARTS between them.
    expect(
      new Set(
        (
          chunks.filter(
            (c) => c.type === 'tool-input-start' || c.type === 'tool-approval-request',
          ) as { toolCallId: string }[]
        ).map((c) => c.toolCallId),
      ).size,
    ).toBeLessThanOrEqual(MAX_TURN_TOOL_PARTS + 1);
    warnSpy.mockRestore();
  });

  // …and the reserve exists for ONE case, so that case is pinned on its own: cheap read-only
  // traffic must not be able to delete a destructive call's approve button. Before the
  // reserve, 64 `query_data_source` cards — every one of them individually legal — spent the
  // shared budget and the `remove_page` card that followed did not exist: no part, no button,
  // one `console.warn`, and the server blocking for its 120-second approval timeout.
  it('cannot have a destructive approval card evicted by cheap read-only tool traffic', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunks = await collectAllTurnChunks([
      ...Array.from({ length: MAX_TURN_TOOL_PARTS }, (_unused, i) => startEvent(i)),
      {
        type: 'tool-approval-request',
        toolCallId: 'destructive-1',
        toolName: 'remove_page',
        input: { pageId: 'page-1' },
        effects: { willRemovePages: [{ id: 'page-1', title: 'Finance' }] },
      },
    ]);

    const approval = chunks.find((c) => c.type === 'tool-approval-request') as {
      toolCallId: string;
      effects: unknown;
    };
    expect(approval).not.toBe(undefined);
    expect(approval.toolCallId).toBe('destructive-1');
    // …with its real impact summary, so the human answers against the server's own titles.
    expect(approval.effects).toEqual({ willRemovePages: [{ id: 'page-1', title: 'Finance' }] });
    warnSpy.mockRestore();
  });

  // And when even the reserve is spent, "the card cannot be shown" reaches the person who
  // would have answered it — not only `console.warn`. Exactly ONE notice part per turn, so
  // the visibility does not become the next unbounded part factory.
  it('SHOWS that an approval could not be displayed, once, when the reserve is spent too', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunks = await collectAllTurnChunks([
      ...Array.from({ length: MAX_TURN_TOOL_ACTIVITY_PARTS }, (_unused, i) => startEvent(i)),
      ...Array.from({ length: MAX_TURN_APPROVAL_PARTS + 10 }, (_unused, i) => ({
        type: 'tool-approval-request',
        toolCallId: `destructive-${i}`,
        toolName: 'remove_page',
        input: {},
      })),
    ]);

    const notices = chunks.filter((c) => c.type === 'tool-output-error') as {
      toolCallId: string;
      errorText: string;
    }[];
    expect(notices).toHaveLength(1);
    expect(notices[0].errorText).toContain('could not be shown');
    // It resolves a part of its own — an adapter-minted id, so it cannot collide with, or
    // overwrite, a card the server actually earned.
    expect(notices[0].toolCallId).not.toContain('destructive-');
    expect(
      chunks.some(
        (c) =>
          c.type === 'tool-input-start' &&
          (c as { toolCallId: string }).toolCallId === notices[0].toolCallId,
      ),
    ).toBe(true);
    warnSpy.mockRestore();
  });

  // ── charge only what persists ──────────────────────────────────────────────
  //
  // `tool-output-available` passes a NULL initial part to `withToolInvocation`, so a
  // `complete` naming an id no part was ever created for writes nothing to the message. The
  // part budget already knew that (`phase === 'start' &&`); the OUTPUT budget did not, and
  // charged the turn's whole allowance for text no document ever held — so a client-side part
  // budget destroyed the results of the calls it had itself accepted.
  it('spends no output budget on a `complete` for a call that never got a part', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ghostOutput = 'g'.repeat(MAX_TOOL_OUTPUT_SIZE);
    const realOutput = 'r'.repeat(MAX_TOOL_OUTPUT_SIZE);
    const chunks = await collectAllTurnChunks([
      // Three completes whose `start` never arrived — 600 000 characters that persist NOTHING.
      ...Array.from({ length: 3 }, (_unused, i) => ({
        type: 'tool-activity',
        phase: 'complete',
        toolCallId: `ghost-${i}`,
        toolName: 'query_data_source',
        output: ghostOutput,
      })),
      // …then one ordinary call, at the per-call cap and well inside the turn total.
      startEvent(100),
      completeEvent(100, { output: realOutput }),
    ]);

    const outputs = chunks.filter((c) => c.type === 'tool-output-available') as {
      toolCallId: string;
      output: string;
    }[];
    // The ghosts produce no chunk at all: nothing to store, so nothing to charge.
    expect(outputs.map((c) => c.toolCallId)).toEqual(['call-100']);
    // …and the real call keeps its whole result, unmarked.
    expect(outputs[0].output).toBe(realOutput);
    expect(outputs[0].output).not.toContain('truncated');
    warnSpy.mockRestore();
  });

  // The same starvation without a hostile server: a server running more calls than this
  // client stores has the `start` of the extras dropped HERE, so their `complete`s are exactly
  // those ghosts — and used to burn the turn budget belonging to the calls that DID get cards.
  it('does not let calls this client itself dropped starve the calls it accepted', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const atCap = 'r'.repeat(MAX_TOOL_OUTPUT_SIZE);
    const chunks = await collectAllTurnChunks([
      // One accepted call whose result must survive…
      startEvent(0),
      // …then enough distinct calls to exhaust this door's part budget, so the extras'
      // `start` events are dropped and their `complete` events name unknown ids.
      ...Array.from({ length: MAX_TURN_TOOL_ACTIVITY_PARTS + 3 }, (_unused, i) =>
        startEvent(i + 1),
      ),
      ...Array.from({ length: 3 }, (_unused, i) =>
        completeEvent(MAX_TURN_TOOL_ACTIVITY_PARTS + i, { output: atCap }),
      ),
      completeEvent(0, { output: atCap }),
    ]);

    const first = (
      chunks.filter((c) => c.type === 'tool-output-available') as {
        toolCallId: string;
        output: string;
      }[]
    ).find((c) => c.toolCallId === 'call-0')!;
    expect(first.output).toBe(atCap);
    expect(first.output).not.toContain('truncated');
    warnSpy.mockRestore();
  });

  // `367deaa` un-capped this field because DOCTORING it teaches the model a shape its own
  // schema rejects. That rationale forbids truncating or substituting the value — it does not
  // require storing an unbounded one, and dropping the event stores nothing at all.
  it('DROPS an over-cap tool input rather than doctoring it, over many events', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunks = await collectAllTurnChunks(
      Array.from({ length: 50 }, (_unused, i) =>
        startEvent(i, { input: { note: 'n'.repeat(MAX_TOOL_INPUT_SIZE) } }),
      ),
    );

    expect(chunks.filter((c) => c.type === 'tool-input-start')).toHaveLength(0);
    // Nothing entered `modelToolInputs` either, so no `tool-input-available` carries a
    // shortened or substituted copy of the arguments.
    expect(chunks.filter((c) => c.type === 'tool-input-available')).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('shortened');
    warnSpy.mockRestore();
  });

  it('accepts a tool input exactly AT the per-call cap', async () => {
    const note = 'n'.repeat(MAX_TOOL_INPUT_SIZE - '{"note":""}'.length);
    const chunks = await collectAllTurnChunks([startEvent(1, { input: { note } })]);

    const available = chunks.find((c) => c.type === 'tool-input-available') as { input: unknown };
    expect(JSON.stringify(available.input)).toHaveLength(MAX_TOOL_INPUT_SIZE);
  });

  it('spends ONE tool-input budget across every tool-activity event of the turn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 40 events, each individually legal at half the per-call cap. A per-EVENT limit accepts
    // all 40 and puts ~800 KB of model arguments on one message; the turn budget does not.
    const chunks = await collectAllTurnChunks(
      Array.from({ length: 40 }, (_unused, i) =>
        startEvent(i, { input: { note: 'n'.repeat(MAX_TOOL_INPUT_SIZE / 2) } }),
      ),
    );

    const inputBytes = chunks
      .filter((c) => c.type === 'tool-input-available')
      .reduce((total, c) => total + JSON.stringify((c as { input: unknown }).input)!.length, 0);
    expect(inputBytes).toBeLessThanOrEqual(MAX_TURN_TOOL_INPUT_SIZE);
    expect(chunks.filter((c) => c.type === 'tool-input-available').length).toBeLessThan(40);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  // The one over-cap payload on this boundary that is TRUNCATED rather than dropped, and the
  // reason is the failure the id drop causes elsewhere: `processStream` advances a part to
  // `output-available` only on `tool-output-available`, so dropping the chunk would leave the
  // card at `input-available` — an infinite spinner with nothing to explain it.
  it('TRUNCATES and MARKS an over-cap tool output instead of dropping it, over many events', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunks = await collectAllTurnChunks(
      Array.from({ length: MAX_TURN_TOOL_ACTIVITY_PARTS }, (_unused, i) => [
        startEvent(i),
        completeEvent(i, { output: 'o'.repeat(2_000_000) }),
      ]).flat(),
    );

    const outputs = chunks.filter((c) => c.type === 'tool-output-available') as {
      output: string;
    }[];
    // Every call still resolves — the card never sits on a spinner nothing will clear.
    expect(outputs).toHaveLength(MAX_TURN_TOOL_ACTIVITY_PARTS);
    // …and the truncation is stated, so neither the human nor the model (which replays this
    // through `toOpenAIMessages`) mistakes a partial result for a whole one.
    expect(outputs[0].output).toContain('truncated');
    expect(outputs[0].output.length).toBeLessThan(2_000_000);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('truncated');
    warnSpy.mockRestore();
  });

  // THE UNIT, on the one field the previous round added last — and the one field of the whole
  // boundary whose unit nothing pinned. Restoring `wireStringSize(rawOutput)` to
  // `rawOutput.length` left all 112 tests green while a 200 000-unit control-character output
  // persisted 1 200 000 JSON characters against a stated 200 000: `.length` is a different
  // quantity from the one `MAX_TOOL_OUTPUT_SIZE` is denominated in, and the gap is the escape
  // ratio. This test is the one that can tell them apart, so it is spelled in escaping
  // characters and asserts on `jsonChars`, never on `.length`.
  it('caps the tool output in JSON characters, not in raw UTF-16 units', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // UNDER the cap when measured raw (50 000 <= 200 000), 1.5x OVER it once stored
    // (300 000 JSON characters). A raw-unit comparison stores the whole thing untouched.
    const output = CONTROL_CHAR.repeat(50_000);
    expect(output.length).toBeLessThan(MAX_TOOL_OUTPUT_SIZE);
    expect(jsonChars(output)).toBeGreaterThan(MAX_TOOL_OUTPUT_SIZE);

    const chunks = await collectAllTurnChunks([startEvent(1), completeEvent(1, { output })]);
    const stored = (chunks.find((c) => c.type === 'tool-output-available') as { output: string })
      .output;

    expect(jsonChars(stored)).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_SIZE);
    // …and truncated, not dropped: the card still resolves and says it is incomplete.
    expect(stored).toContain('truncated');
    warnSpy.mockRestore();
  });

  // The marker's own size is charged to the allowance it is appended under — stated by
  // `MAX_TOOL_OUTPUT_SIZE`'s docblock ("is itself charged to the budget") and, until this
  // test, asserted nowhere. Dropping the subtraction leaves the stored output one whole
  // marker over its own per-call cap, which is exactly the kind of "off by a constant" that
  // a `toBeLessThan(2_000_000)` assertion cannot see.
  it('charges the truncation marker to the per-call output cap it is appended under', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunks = await collectAllTurnChunks([
      startEvent(1),
      completeEvent(1, { output: 'o'.repeat(MAX_TOOL_OUTPUT_SIZE + 100) }),
    ]);
    const stored = (chunks.find((c) => c.type === 'tool-output-available') as { output: string })
      .output;

    // The kept prefix AND the marker together, not the prefix alone.
    expect(stored.endsWith(TOOL_OUTPUT_TRUNCATED_SUFFIX)).toBe(true);
    expect(jsonChars(stored)).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_SIZE);
    // Binding: without the subtraction this is MAX_TOOL_OUTPUT_SIZE exactly and the assertion
    // above fails by the marker's length, so the cap is reached rather than merely approached.
    expect(jsonChars(stored)).toBeGreaterThan(
      MAX_TOOL_OUTPUT_SIZE - 2 * jsonChars(TOOL_OUTPUT_TRUNCATED_SUFFIX),
    );
    warnSpy.mockRestore();
  });

  it('spends ONE tool-output budget across every tool-activity event of the turn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 40 completions, each individually legal at half the per-call cap: a per-EVENT limit
    // accepts all 40 and puts ~4 MB of tool results on one message.
    const chunks = await collectAllTurnChunks(
      Array.from({ length: 40 }, (_unused, i) => [
        startEvent(i),
        completeEvent(i, { output: 'o'.repeat(MAX_TOOL_OUTPUT_SIZE / 2) }),
      ]).flat(),
    );

    const outputBytes = chunks
      .filter((c) => c.type === 'tool-output-available')
      .reduce((total, c) => total + jsonChars((c as { output: string }).output), 0);
    // The turn total, plus the marker each truncated result carries.
    expect(outputBytes).toBeLessThanOrEqual(
      MAX_TURN_TOOL_OUTPUT_SIZE + jsonChars(TOOL_OUTPUT_TRUNCATED_SUFFIX) * MAX_TURN_TOOL_PARTS,
    );
    // Still 40 resolved cards — the budget trims, it does not strand.
    expect(chunks.filter((c) => c.type === 'tool-output-available')).toHaveLength(40);
    warnSpy.mockRestore();
  });

  it('leaves a within-budget output byte-identical', async () => {
    const output = JSON.stringify({ rows: [{ id: 1, name: 'Ada' }] });
    const chunks = await collectAllTurnChunks([startEvent(1), completeEvent(1, { output })]);

    const available = chunks.find((c) => c.type === 'tool-output-available') as { output: string };
    expect(available.output).toBe(output);
  });

  it('holds the WHOLE tool-activity arithmetic: per-field x per-part x part-count', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The measured 112 MB shape: 200 distinct calls, every id at its cap and spelled in
    // control characters, over-cap outputs throughout, and the first ten carrying half-cap
    // model arguments so the input budget binds too. Every term of the bound is load-bearing
    // — drop the id cap and `idBytes` grows with the id length, drop the count cap and every
    // term grows with the event count, drop either size budget and `inputBytes`/`outputBytes`
    // do.
    const chunks = await collectAllTurnChunks(
      Array.from({ length: 200 }, (_unused, i) => {
        const prefix = `call-${i}-`;
        const id = prefix + escapingString(MAX_TOOL_ID_LENGTH - prefix.length);
        return [
          {
            type: 'tool-activity',
            phase: 'start',
            toolCallId: id,
            toolName: escapingString(MAX_TOOL_ID_LENGTH),
            input: i < 10 ? { note: escapingString(MAX_TOOL_INPUT_SIZE / 2) } : { table: 'orders' },
          },
          {
            type: 'tool-activity',
            phase: 'complete',
            toolCallId: id,
            toolName: escapingString(MAX_TOOL_ID_LENGTH),
            output: 'o'.repeat(MAX_TOOL_OUTPUT_SIZE * 2),
          },
        ];
      }).flat(),
    );

    const starts = chunks.filter((c) => c.type === 'tool-input-start') as {
      toolCallId: string;
      toolName: string;
    }[];
    const inputs = chunks.filter((c) => c.type === 'tool-input-available') as { input: unknown }[];
    // Only the outputs that can reach the DOCUMENT. `tool-output-available` passes a null
    // initial part to `withToolInvocation`, so one naming an id no part was ever created for
    // is a no-op on the persisted message — the part count is what bounds the marker term.
    const partIds = new Set(starts.map((c) => c.toolCallId));
    const outputs = (
      chunks.filter((c) => c.type === 'tool-output-available') as {
        toolCallId: string;
        output: string;
      }[]
    ).filter((c) => partIds.has(c.toolCallId));

    const idBytes = starts.reduce(
      (total, c) => total + jsonChars(c.toolCallId) + jsonChars(c.toolName),
      0,
    );
    const inputBytes = inputs.reduce((total, c) => total + JSON.stringify(c.input)!.length, 0);
    const outputBytes = outputs.reduce((total, c) => total + jsonChars(c.output), 0);

    // ids/names: 2 fields x MAX_TOOL_ID_LENGTH x MAX_TURN_TOOL_PARTS = 32 768.
    expect(idBytes).toBeLessThanOrEqual(2 * MAX_TOOL_ID_LENGTH * MAX_TURN_TOOL_PARTS);
    // the model's arguments: one turn-wide budget, unchanged by the event count.
    expect(inputBytes).toBeLessThanOrEqual(MAX_TURN_TOOL_INPUT_SIZE);
    // the tools' results: their own turn-wide budget, plus one marker per truncated result.
    expect(outputBytes).toBeLessThanOrEqual(
      MAX_TURN_TOOL_OUTPUT_SIZE + jsonChars(TOOL_OUTPUT_TRUNCATED_SUFFIX) * MAX_TURN_TOOL_PARTS,
    );
    // …and the whole door, stated as one number the commit message can quote.
    expect(idBytes + inputBytes + outputBytes).toBeLessThanOrEqual(
      2 * MAX_TOOL_ID_LENGTH * MAX_TURN_TOOL_PARTS +
        MAX_TURN_TOOL_INPUT_SIZE +
        MAX_TURN_TOOL_OUTPUT_SIZE +
        jsonChars(TOOL_OUTPUT_TRUNCATED_SUFFIX) * MAX_TURN_TOOL_PARTS,
    );
    // Each term is really binding, so the total is not passing by accident.
    expect(starts).toHaveLength(MAX_TURN_TOOL_ACTIVITY_PARTS);
    expect(outputs.at(-1)!.output).toContain('truncated');
    warnSpy.mockRestore();
  });
});

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

  // …and the budget is spent on the key NAMES too, not only on the values. Above, the names
  // are 5 characters against a 5 002-character value, so nothing there can tell whether the
  // `key.length +` term in `entrySize` is doing anything: deleting it leaves every other test
  // in this file green. Invert the ratio and the names become the whole quantity. Without the
  // charge the real worst case is MAX_TURN_METADATA_SIZE + MAX_ARRAY_LENGTH *
  // MAX_METADATA_KEY_LENGTH = 20 000 + 500 * 128 = 84 000 characters, ~2.8x what the budget
  // claims — and a name is exactly as persistent as the value it names.
  it('charges the key NAMES to the turn budget, not just the values', async () => {
    const atCapKey = 'k'.repeat(MAX_METADATA_KEY_LENGTH);
    const events: object[] = [];
    for (let event = 0; event < 5; event += 1) {
      const metadata: Record<string, unknown> = {};
      for (let i = 0; i < 200; i += 1) {
        // A one-character value: everything this payload costs the persisted message is name.
        metadata[`${event}-${i}-${atCapKey}`.slice(0, MAX_METADATA_KEY_LENGTH)] = 1;
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

    const merged = mergeMetadataChunks(chatChunks);
    const nameBytes = Object.keys(merged).reduce((total, key) => total + key.length, 0);
    const chargedSize = Object.entries(merged).reduce(
      (total, [key, value]) => total + key.length + JSON.stringify(value)!.length,
      0,
    );

    // The names alone stay inside the whole turn budget…
    expect(nameBytes).toBeLessThanOrEqual(MAX_TURN_METADATA_SIZE);
    // …and so does everything persisted, which is what the budget's arithmetic claims.
    expect(chargedSize).toBeLessThanOrEqual(MAX_TURN_METADATA_SIZE);
    // The key COUNT cap is not what stopped it here — the size budget ran out first, which is
    // the term this test exists to pin.
    expect(Object.keys(merged).length).toBeLessThan(MAX_ARRAY_LENGTH);

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

  // -- the UNIT, on this door ------------------------------------------------
  //
  // `MAX_TURN_METADATA_SIZE` says "JSON characters" and the VALUES were charged in them, but
  // `model` and the key NAMES were capped and charged with `String.prototype.length`. Those
  // are different units: `JSON.stringify` escapes a control character to six characters.
  // Measured against this door's own "~30 KB per assistant message": 178 052 JSON characters
  // persisted, of which the single `model` string was 60 002.
  it('caps `model` in JSON characters, not in raw UTF-16 units', async () => {
    // `model` is exempt from the turn budget, so its per-field cap IS its bound: 10 000
    // control characters are 10 000 UTF-16 units and 60 000 JSON characters.
    const escapingModel = CONTROL_CHAR.repeat(MAX_STRING_LENGTH);
    expect(escapingModel.length).toBe(MAX_STRING_LENGTH);
    expect(jsonChars(escapingModel)).toBe(MAX_STRING_LENGTH * 6);

    mockFetch(
      makeSseBody([
        { type: 'message-metadata', metadata: { model: escapingModel, traceId: 't' } },
        { type: 'finish', finishReason: 'stop' },
      ]),
    );
    const adapter = createBackendChatAdapter(
      { endpoint: 'https://fake.test/api/ai' },
      makeController(),
    );
    const stream = await adapter.sendMessage(makeSendInput([]));
    const chatChunks = (await collectChunks(stream)).filter(isChatMessageChunk);
    const merged = mergeMetadataChunks(chatChunks);

    expect(Object.hasOwn(merged, 'model')).toBe(false);
    // Dropped individually, like any other over-cap field: the rest of the metadata survives.
    expect(merged.traceId).toBe('t');

    vi.unstubAllGlobals();
  });

  it('charges the key NAMES in JSON characters, so escaping names cannot outrun the budget', async () => {
    // A one-character value per key, so everything this payload costs the document is NAME —
    // and every name is spelled in control characters, at exactly `MAX_METADATA_KEY_LENGTH`
    // JSON characters and a sixth of that in UTF-16 units. Charged in the budget's own unit,
    // ~155 of them fit; charged raw, the key COUNT cap runs out first at 500 and the persisted
    // metadata is ~64 500 JSON characters against a claimed 20 000.
    const events: object[] = [];
    for (let event = 0; event < 10; event += 1) {
      const metadata: Record<string, unknown> = {};
      for (let i = 0; i < 100; i += 1) {
        const prefix = `${event}-${i}-`;
        metadata[prefix + escapingString(MAX_METADATA_KEY_LENGTH - prefix.length)] = 1;
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
    const merged = mergeMetadataChunks(chatChunks);

    const chargedSize = Object.entries(merged).reduce(
      (total, [key, value]) => total + jsonChars(key) + JSON.stringify(value)!.length,
      0,
    );
    expect(chargedSize).toBeLessThanOrEqual(MAX_TURN_METADATA_SIZE);
    // …and what actually lands on the message — the quantity the docblock's "~30 KB" is a
    // claim about — stays inside the door's whole stated worst case.
    expect(JSON.stringify(merged)!.length).toBeLessThanOrEqual(
      MAX_STRING_LENGTH + 69 + MAX_TURN_METADATA_SIZE,
    );
    // The names really are what bound it here: the key COUNT cap never came near binding.
    expect(Object.keys(merged).length).toBeLessThan(MAX_ARRAY_LENGTH);

    vi.unstubAllGlobals();
  });

  // A key name whose RAW length is at the cap but whose stored form is 6x that is over the
  // cap, and dropped — the cap is a claim about the document, not about UTF-16.
  it('caps a metadata key NAME in JSON characters too', async () => {
    const escapingKey = CONTROL_CHAR.repeat(MAX_METADATA_KEY_LENGTH);
    const atJsonCapKey = escapingString(MAX_METADATA_KEY_LENGTH);
    mockFetch(
      makeSseBody([
        {
          type: 'message-metadata',
          metadata: { [escapingKey]: 1, [atJsonCapKey]: 2, traceId: 't' },
        },
        { type: 'finish', finishReason: 'stop' },
      ]),
    );
    const adapter = createBackendChatAdapter(
      { endpoint: 'https://fake.test/api/ai' },
      makeController(),
    );
    const stream = await adapter.sendMessage(makeSendInput([]));
    const chatChunks = (await collectChunks(stream)).filter(isChatMessageChunk);
    const merged = mergeMetadataChunks(chatChunks);

    expect(Object.hasOwn(merged, escapingKey)).toBe(false);
    // …and one whose STORED size is exactly at the cap is kept: a unit fix, not a tightening.
    expect(merged[atJsonCapKey]).toBe(2);
    expect(merged.traceId).toBe('t');

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

// ── the stream-text doors, and the bound on the whole message ─────────────────
//
// The FIFTH and SIXTH doors, found in the same if/else chain the four rounds before them were
// editing. `text-delta` and `reasoning-delta` append to a persisted part's `text` with nothing
// on the path measuring anything, and `reasoning-*`/`step-start` allocate a brand-new part per
// unseen id / per event. Measured on ONE assistant message, no tool call and no approval:
//
//     100 x text-delta of 20 000 control characters      -> 12 000 201 JSON chars
//      50 x reasoning-delta of 20 000, distinct ids      ->  6 002 460 JSON chars
//     200 x (reasoning-start + 10 000-char delta + end)  ->  2 009 360 JSON chars, 201 parts
//  20 000 x step-start                                   ->    440 160 JSON chars, 20 000 parts
//   5 000 x (text-delta + step-start)                    ->    365 160 JSON chars, 5 000 parts
//
// So the tests below do not add a sixth per-door budget test: they pin the accounting every
// part-creating branch now goes through, and then measure the MESSAGE.

describe('createBackendChatAdapter: stream-text budgets', () => {
  const HUGE_DELTA = CONTROL_CHAR.repeat(20_000); // 20 000 UTF-16 units, 120 000 JSON chars

  it('bounds the TEXT one turn adds, and MARKS the truncation rather than trimming silently', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunks = await collectAllTurnChunks(
      Array.from({ length: 100 }, () => ({ type: 'text-delta', delta: HUGE_DELTA })),
    );

    const deltas = chunks.filter((c) => c.type === 'text-delta') as { delta: string }[];
    const total = deltas.reduce((sum, c) => sum + jsonChars(c.delta), 0);
    // 12 000 000 JSON characters of answer, bounded to the turn's ceiling — INCLUDING the
    // marker, not plus it. `STREAM_TEXT_TRUNCATED_SUFFIX`'s own docblock says it is "charged to
    // the budget it terminates, like the tool-output marker, so a turn cannot exceed its
    // ceiling by the marker's own length", and this is the assertion that holds it to that: an
    // allowance of `+ marker` here is a ceiling nobody is standing on, and it left the
    // subtraction in `chargeStreamText` deletable with the suite still green.
    expect(total).toBeLessThanOrEqual(MAX_TURN_TEXT_SIZE);
    // …and the cut says so. A truncated answer that reads as a finished one is the one
    // failure mode a text budget must not have: the tail is where the conclusion lives.
    expect(deltas.at(-1)!.delta).toContain('truncated');
    expect(deltas.at(-1)!.delta).toContain('INCOMPLETE');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('charges the text budget in JSON characters, not in raw UTF-16 units', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Half the budget when counted raw, three times it once stored.
    const chunks = await collectAllTurnChunks(
      Array.from({ length: 24 }, () => ({ type: 'text-delta', delta: HUGE_DELTA })),
    );
    const deltas = chunks.filter((c) => c.type === 'text-delta') as { delta: string }[];

    expect(deltas.reduce((sum, c) => sum + c.delta.length, 0)).toBeLessThan(MAX_TURN_TEXT_SIZE);
    expect(deltas.reduce((sum, c) => sum + jsonChars(c.delta), 0)).toBeLessThanOrEqual(
      MAX_TURN_TEXT_SIZE,
    );
    warnSpy.mockRestore();
  });

  it('bounds the REASONING one turn adds, on its own budget', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunks = await collectAllTurnChunks(
      Array.from({ length: 100 }, () => ({
        type: 'reasoning-delta',
        id: 'r-1',
        delta: HUGE_DELTA,
      })),
    );

    const deltas = chunks.filter((c) => c.type === 'reasoning-delta') as { delta: string }[];
    expect(deltas.reduce((sum, c) => sum + jsonChars(c.delta), 0)).toBeLessThanOrEqual(
      MAX_TURN_REASONING_SIZE,
    );
    warnSpy.mockRestore();
  });

  // The `MAX_TURN_APPROVAL_PARTS` argument, on the door beside it: a budget spent in ARRIVAL
  // order lets whatever arrives first consume all of it, and reasoning always arrives before
  // the answer. One shared stream-text budget would therefore let a verbose thinking block
  // truncate the reply it was thinking about — so the two halves are split.
  it('does not let a turn-long thinking block truncate the answer that follows it', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const answer = 'a'.repeat(MAX_TURN_TEXT_SIZE);
    const chunks = await collectAllTurnChunks([
      // Ten times the reasoning budget, arriving first…
      ...Array.from({ length: 50 }, () => ({
        type: 'reasoning-delta',
        id: 'r-1',
        delta: HUGE_DELTA,
      })),
      // …and then the model's actual answer, at the whole of its own budget.
      { type: 'text-delta', delta: answer },
    ]);

    const deltas = chunks.filter((c) => c.type === 'text-delta') as { delta: string }[];
    expect(deltas).toHaveLength(1);
    expect(deltas[0].delta).toBe(answer);
    expect(deltas[0].delta).not.toContain('truncated');
    warnSpy.mockRestore();
  });

  it('bounds the NUMBER of reasoning parts, per DISTINCT stream id', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunks = await collectAllTurnChunks(
      Array.from({ length: MAX_TURN_REASONING_PARTS * 6 }, (_unused, i) => ({
        type: 'reasoning-start',
        id: `r-server-${i}`,
      })),
    );

    // `resolveTextLikePartIndex` allocates a fresh persisted part per unseen id, exactly as
    // `withToolInvocation` does per unseen `toolCallId`. The count INCLUDES the synthetic
    // "Thinking…" part this adapter emits itself — a budget that exempts the parts it knows
    // about is the same mistake as one that exempts the fields it knows about.
    expect(chunks.filter((c) => c.type === 'reasoning-start')).toHaveLength(
      MAX_TURN_REASONING_PARTS,
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('bounds reasoning parts opened by a bare `reasoning-delta` too', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // `createIfMissing: true` on the delta path: no `reasoning-start` is needed to allocate a
    // part, so a cap that only guarded `reasoning-start` would guard nothing.
    const chunks = await collectAllTurnChunks(
      Array.from({ length: MAX_TURN_REASONING_PARTS * 6 }, (_unused, i) => ({
        type: 'reasoning-delta',
        id: `r-server-${i}`,
        delta: 'thinking',
      })),
    );

    const ids = new Set(
      (chunks.filter((c) => c.type === 'reasoning-delta') as { id: string }[]).map((c) => c.id),
    );
    expect(ids.size).toBeLessThanOrEqual(MAX_TURN_REASONING_PARTS);
    warnSpy.mockRestore();
  });

  it('bounds the NUMBER of step-start parts one turn adds', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunks = await collectAllTurnChunks(
      Array.from({ length: MAX_TURN_STEP_PARTS * 6 }, () => ({ type: 'step-start' })),
    );

    expect(chunks.filter((c) => c.type === 'start-step')).toHaveLength(MAX_TURN_STEP_PARTS);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  // `step-start` re-armed the text door: `endTextPart` mints a fresh `text-${n}` id on every
  // one, and a fresh id is a fresh PART — so the SERVER decided how many text parts a turn
  // created. Bounding the count here must not cost a single character of the answer, which is
  // why the cap works by refusing to CLOSE the open run rather than refusing to store text.
  it('bounds the NUMBER of text parts without dropping a character of the answer', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sent = Array.from({ length: 200 }, (_unused, i) => `segment-${i} `);
    const chunks = await collectAllTurnChunks(
      sent.flatMap((delta) => [{ type: 'text-delta', delta }, { type: 'step-start' }]),
    );

    const deltas = chunks.filter((c) => c.type === 'text-delta') as {
      id: string;
      delta: string;
    }[];
    // The count is bounded…
    expect(new Set(deltas.map((c) => c.id)).size).toBeLessThanOrEqual(MAX_TURN_TEXT_PARTS);
    // …and nothing the model said was lost to bounding it.
    expect(deltas.map((c) => c.delta).join('')).toBe(sent.join(''));
    warnSpy.mockRestore();
  });
});

// ── the bound on the MESSAGE ─────────────────────────────────────────────────

describe('createBackendChatAdapter: the whole persisted assistant message', () => {
  it('bounds every door AT ONCE, measured on what a real ChatStore holds', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const atCapId = (prefix: string) => prefix + escapingString(MAX_TOOL_ID_LENGTH - prefix.length);

    const events: Record<string, unknown>[] = [
      // (a)+(b) the text door: 6 000 000 JSON characters of answer.
      ...Array.from({ length: 50 }, () => ({
        type: 'text-delta',
        delta: CONTROL_CHAR.repeat(20_000),
      })),
      // (a)+(b) the reasoning door: 6 000 000 more, across distinct stream ids.
      ...Array.from({ length: 50 }, (_unused, i) => ({
        type: 'reasoning-delta',
        id: `r-${i}`,
        delta: CONTROL_CHAR.repeat(20_000),
      })),
      // (a) the step door: a part apiece, no dedup.
      ...Array.from({ length: 300 }, () => ({ type: 'step-start' })),
      // (a)+(b) the tool-activity door: at-cap ids, at-cap inputs, over-cap outputs.
      ...Array.from({ length: 80 }, (_unused, i) => [
        {
          type: 'tool-activity',
          phase: 'start',
          toolCallId: atCapId(`call-${i}-`),
          toolName: escapingString(MAX_TOOL_ID_LENGTH),
          input: { note: escapingString(MAX_TOOL_INPUT_SIZE / 2) },
        },
        {
          type: 'tool-activity',
          phase: 'complete',
          toolCallId: atCapId(`call-${i}-`),
          toolName: escapingString(MAX_TOOL_ID_LENGTH),
          output: 'o'.repeat(MAX_TOOL_OUTPUT_SIZE),
        },
      ]).flat(),
      // (a)+(b) the approval door: at-cap enriched inputs, effects and reasons.
      ...Array.from({ length: 30 }, (_unused, i) => ({
        type: 'tool-approval-request',
        toolCallId: atCapId(`approval-${i}-`),
        toolName: escapingString(MAX_TOOL_ID_LENGTH),
        approvalId: atCapId(`ap-${i}-`),
        input: { note: escapingString(MAX_APPROVAL_INPUT_SIZE / 2) },
        effects: { willRemovePages: [{ id: 'p1', title: escapingString(MAX_STRING_LENGTH) }] },
        reason: escapingString(MAX_STRING_LENGTH),
      })),
      // (b) the metadata door: at-cap names and values, merged into one message.
      ...Array.from({ length: 10 }, () => ({
        type: 'message-metadata',
        metadata: {
          model: escapingString(MAX_STRING_LENGTH),
          ...Object.fromEntries(
            Array.from({ length: 50 }, (_unused, k) => [
              `k${k}-${escapingString(MAX_METADATA_KEY_LENGTH - 6)}`,
              escapingString(MAX_STRING_LENGTH - 2),
            ]),
          ),
        },
      })),
    ];

    const { parts, persistedJSONChars } = await persistOneTurn(events);

    // The number this round exists to make true: ONE number for the whole message, not one
    // per door. Uncapped, the text and reasoning halves of this same turn alone measured
    // 18 MB. The bound is `per-field x per-item x item-count` summed across every branch of
    // the chain — see `MAX_TURN_PERSISTED_MESSAGE_SIZE`.
    expect(persistedJSONChars).toBeLessThanOrEqual(MAX_TURN_PERSISTED_MESSAGE_SIZE);
    // …and the count term, which no size budget can express. `+ 1` is the single notice part
    // an unshowable approval is allowed to mint.
    expect(parts.length).toBeLessThanOrEqual(MAX_TURN_MESSAGE_PARTS + 1);

    // Every door really is exercised, so the total is not passing because a door was silent.
    const kinds = new Set(parts.map((part) => part.type));
    expect(kinds.has('text')).toBe(true);
    expect(kinds.has('reasoning')).toBe(true);
    expect(kinds.has('step-start')).toBe(true);
    expect(kinds.has('dynamic-tool')).toBe(true);
    warnSpy.mockRestore();
  });

  // The truncation marker's own charge, measured where it matters: on the characters the store
  // actually holds, for BOTH stream-text kinds at once, each against its own half of the
  // budget. The marker is part of what persists, so it is part of what the budget has to cover
  // — the previous round reported exactly this defect on `TOOL_OUTPUT_TRUNCATED_SUFFIX` and
  // then re-created it, unpinned, on the stream-text path in the same commit.
  it('charges the truncation marker to the budget it terminates, at the sink', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { parts } = await persistOneTurn([
      ...Array.from({ length: 60 }, () => ({
        type: 'reasoning-delta',
        id: 'r-1',
        delta: CONTROL_CHAR.repeat(20_000),
      })),
      ...Array.from({ length: 60 }, () => ({
        type: 'text-delta',
        delta: CONTROL_CHAR.repeat(20_000),
      })),
    ]);

    const sizeOf = (type: string) =>
      (parts.filter((part) => part.type === type) as { text: string }[]).reduce(
        (sum, part) => sum + jsonChars(part.text),
        0,
      );

    // Both doors were pushed past their ceiling and both stopped AT it, marker included.
    expect(sizeOf('reasoning')).toBeLessThanOrEqual(MAX_TURN_REASONING_SIZE);
    expect(sizeOf('text')).toBeLessThanOrEqual(MAX_TURN_TEXT_SIZE);
    // …and each really did truncate, so the ceilings above are not being met by silence.
    expect(sizeOf('reasoning')).toBeGreaterThan(
      MAX_TURN_REASONING_SIZE - jsonChars(STREAM_TEXT_TRUNCATED_SUFFIX) * 2,
    );
    expect(sizeOf('text')).toBeGreaterThan(
      MAX_TURN_TEXT_SIZE - jsonChars(STREAM_TEXT_TRUNCATED_SUFFIX) * 2,
    );
    warnSpy.mockRestore();
  });

  // ── the TOTAL, not just the slices ─────────────────────────────────────────
  //
  // Every other part-count test above drives ONE door and is stopped by that door's sub-limit,
  // so the total clause of `canAffordMessagePart` was never the binding one and could be
  // deleted with the whole suite still green. Its one live use is the deliberate over-slice
  // charge: `reportApprovalCannotBeShown` mints a notice part against `MAX_TURN_TOOL_PARTS + 1`
  // so a refused approval is visible, and the TOTAL is the only thing that stops that `+ 1`
  // from being a 193rd part on a message already holding 192.
  it('refuses even the over-slice approval notice once the MESSAGE total is spent', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const events: Record<string, unknown>[] = [
      // text -> 32 parts, and step -> 32 along the way: each `step-start` closes the open text
      // run and mints the next id, which is what makes a text part cost a charge.
      ...Array.from({ length: MAX_TURN_TEXT_PARTS }, (_unused, i) => [
        { type: 'text-delta', delta: `t${i} ` },
        { type: 'step-start' },
      ]).flat(),
      // step -> 64.
      ...Array.from({ length: MAX_TURN_STEP_PARTS - MAX_TURN_TEXT_PARTS }, () => ({
        type: 'step-start',
      })),
      // reasoning -> 32, one of which the adapter's own synthetic "Thinking…" part already
      // spent before the stream was read.
      ...Array.from({ length: MAX_TURN_REASONING_PARTS - 1 }, (_unused, i) => ({
        type: 'reasoning-start',
        id: `r-${i}`,
      })),
      // tool -> 48 from the activity door…
      ...Array.from({ length: MAX_TURN_TOOL_ACTIVITY_PARTS }, (_unused, i) => ({
        type: 'tool-activity',
        phase: 'start',
        toolCallId: `call-${i}`,
        toolName: 'do_thing',
        input: {},
      })),
      // …and 16 more from the approval door, which is exactly the reservation held for it.
      ...Array.from({ length: MAX_TURN_APPROVAL_PARTS }, (_unused, i) => ({
        type: 'tool-approval-request',
        toolCallId: `approval-${i}`,
        toolName: 'do_thing',
        approvalId: `ap-${i}`,
        input: {},
      })),
      // The message now holds MAX_TURN_MESSAGE_PARTS parts. This approval cannot be shown, so
      // the boundary would like to say so — and the ONE thing standing between that notice and
      // a 193rd part is the total.
      {
        type: 'tool-approval-request',
        toolCallId: 'approval-over',
        toolName: 'do_thing',
        approvalId: 'ap-over',
        input: {},
      },
    ];

    const { parts } = await persistOneTurn(events);

    const byKind = parts.reduce<Record<string, number>>((acc, part) => {
      acc[part.type] = (acc[part.type] ?? 0) + 1;
      return acc;
    }, {});
    // Every slice is at its ceiling and they sum to exactly the root — which is the same fact
    // that leaves the total no slack to act in for these four kinds, and why the notice part is
    // the only place it can be observed.
    expect(byKind).toEqual({
      text: MAX_TURN_TEXT_PARTS,
      reasoning: MAX_TURN_REASONING_PARTS,
      'step-start': MAX_TURN_STEP_PARTS,
      // The two tool doors land as different part types in the store — `dynamic-tool` for the
      // activity door, `tool` for the approval door — but they share ONE sub-limit here.
      'dynamic-tool': MAX_TURN_TOOL_ACTIVITY_PARTS,
      tool: MAX_TURN_APPROVAL_PARTS,
    });
    expect(parts).toHaveLength(MAX_TURN_MESSAGE_PARTS);
    // Not `<= MAX_TURN_MESSAGE_PARTS + 1`: the `+ 1` is affordable only while the total is not
    // spent, and here it is. Without the total clause — or without the total being incremented
    // — the notice lands and the message holds 193.
    expect(
      parts.some(
        (part) =>
          'toolCallId' in part &&
          (part as { toolCallId: string }).toolCallId.includes('unshowable'),
      ),
    ).toBe(false);
    warnSpy.mockRestore();
  });

  // ── the total IS the binding clause for text, and this is the measurement ──────
  //
  // The test that had to exist before the `text-delta` branch's part guard could be called
  // unreachable — and did not, so the guard was deleted on a prose argument instead. The
  // argument was that "the other three slices sum to 160, plus the one over-slice approval
  // notice = 161 < 192, so the charge cannot fail". It omits the text parts ALREADY charged:
  // `canAffordMessagePart('text')` is `turnPartCounts.text < 32 && turnMessageParts < 192`, so
  // with text at 31 and the other doors at 64 + 32 + 48 + 16 + 1 = 161 the total is exactly
  // 192 while the SUB-limit still has room. The total is the binding clause, and the charge
  // fails.
  //
  // Nor does the other half of the argument save it. `endTextPart` refuses to close once
  // `canAffordMessagePart('text')` is false — but it closed HERE at a moment when it was still
  // true, and the doors below then spent the last slot before this `text-delta` arrived. So
  // `textStarted` is `false`, a new part is wanted, and there is no slot for it.
  //
  // Driven to exactly that state and measured at the sink: with the charge's result ignored
  // the message holds 193 parts against a stated ceiling of 192, and the 32nd text part is one
  // no counter ever saw.
  it('refuses a NEW text part once the MESSAGE total is spent, though the text slice has room', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const events: Record<string, unknown>[] = [
      // text -> 31, ONE short of its slice, and step -> 31 along the way. The last `step-start`
      // closes the open run while the total is still affordable, so `textStarted` is `false`
      // and the next `text-delta` will want a brand-new part.
      ...Array.from({ length: MAX_TURN_TEXT_PARTS - 1 }, (_unused, i) => [
        { type: 'text-delta', delta: `t${i} ` },
        { type: 'step-start' },
      ]).flat(),
      // step -> 64.
      ...Array.from({ length: MAX_TURN_STEP_PARTS - (MAX_TURN_TEXT_PARTS - 1) }, () => ({
        type: 'step-start',
      })),
      // reasoning -> 32, one of which the synthetic "Thinking…" part already spent.
      ...Array.from({ length: MAX_TURN_REASONING_PARTS - 1 }, (_unused, i) => ({
        type: 'reasoning-start',
        id: `r-${i}`,
      })),
      // tool -> 48 from the activity door and 16 from the approval door = the whole slice.
      ...Array.from({ length: MAX_TURN_TOOL_ACTIVITY_PARTS }, (_unused, i) => ({
        type: 'tool-activity',
        phase: 'start',
        toolCallId: `call-${i}`,
        toolName: 'do_thing',
        input: {},
      })),
      ...Array.from({ length: MAX_TURN_APPROVAL_PARTS }, (_unused, i) => ({
        type: 'tool-approval-request',
        toolCallId: `approval-${i}`,
        toolName: 'do_thing',
        approvalId: `ap-${i}`,
        input: {},
      })),
      // …and the one deliberate over-slice charge takes the TOTAL to exactly 192 while the
      // text slice still shows 31 < 32. This is the state the deleted guard was declared
      // unable to reach.
      {
        type: 'tool-approval-request',
        toolCallId: 'approval-over',
        toolName: 'do_thing',
        approvalId: 'ap-over',
        input: {},
      },
      // The 193rd part, if the charge's result is ignored.
      { type: 'text-delta', delta: 'THE-UNCHARGED-PART' },
    ];

    const { parts, persistedJSONChars } = await persistOneTurn(events);

    const byKind = parts.reduce<Record<string, number>>((acc, part) => {
      acc[part.type] = (acc[part.type] ?? 0) + 1;
      return acc;
    }, {});
    expect(byKind).toEqual({
      // 31, not 32: the slice had room and the TOTAL refused it anyway.
      text: MAX_TURN_TEXT_PARTS - 1,
      reasoning: MAX_TURN_REASONING_PARTS,
      'step-start': MAX_TURN_STEP_PARTS,
      'dynamic-tool': MAX_TURN_TOOL_ACTIVITY_PARTS + 1,
      tool: MAX_TURN_APPROVAL_PARTS,
    });
    expect(parts).toHaveLength(MAX_TURN_MESSAGE_PARTS);
    // The delta of the part that could not be opened is not smuggled into a neighbouring one
    // either: no part on this message carries it.
    expect(JSON.stringify(parts)).not.toContain('THE-UNCHARGED-PART');
    expect(persistedJSONChars).toBeLessThanOrEqual(MAX_TURN_PERSISTED_MESSAGE_SIZE);
    warnSpy.mockRestore();
  });

  // ── the allocation, not a prediction of it ─────────────────────────────────
  //
  // Every test above sends each reasoning stream id ONCE. That is the shape the charge was
  // written against, and it is why "one part per DISTINCT id" read as true for five rounds:
  // `resolveTextLikePartIndex` reuses a part for an id only while that part is not `done`, and
  // `reasoning-end` marks it `done` — so a REPEATED start/delta/end cycle on one id allocated a
  // brand-new persisted part per cycle and was charged nothing after the first. Measured at
  // 60 000 cycles before the fix: 60 001 parts and 3 260 181 JSON characters against a stated
  // whole-message ceiling of 2 226 805.
  //
  // These four pin the property the adapter now relies on, in BOTH directions, at the sink.
  it('bounds a reasoning id the server re-opens after ending it', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cycles = MAX_TURN_REASONING_PARTS * 60;
    const { parts, persistedJSONChars } = await persistOneTurn(
      Array.from({ length: cycles }, () => [
        { type: 'reasoning-start', id: 'r' },
        { type: 'reasoning-delta', id: 'r', delta: 'thinking' },
        { type: 'reasoning-end', id: 'r' },
      ]).flat(),
    );

    expect(parts.filter((part) => part.type === 'reasoning')).toHaveLength(
      MAX_TURN_REASONING_PARTS,
    );
    expect(parts.length).toBeLessThanOrEqual(MAX_TURN_MESSAGE_PARTS + 1);
    expect(persistedJSONChars).toBeLessThanOrEqual(MAX_TURN_PERSISTED_MESSAGE_SIZE);
    warnSpy.mockRestore();
  });

  // …including the id the ADAPTER itself opened, which `endReasoning` finalizes on the first
  // real content — so a server needs no id of its own to reach the same door.
  it('bounds the same re-open cycle run on the ADAPTER-owned thinking id', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cycles = MAX_TURN_REASONING_PARTS * 60;
    const { parts, persistedJSONChars } = await persistOneTurn(
      Array.from({ length: cycles }, () => [
        { type: 'reasoning-start', id: 'r-thinking' },
        { type: 'reasoning-delta', id: 'r-thinking', delta: 'thinking' },
        { type: 'reasoning-end', id: 'r-thinking' },
      ]).flat(),
    );

    expect(parts.filter((part) => part.type === 'reasoning').length).toBeLessThanOrEqual(
      MAX_TURN_REASONING_PARTS,
    );
    expect(parts.length).toBeLessThanOrEqual(MAX_TURN_MESSAGE_PARTS + 1);
    expect(persistedJSONChars).toBeLessThanOrEqual(MAX_TURN_PERSISTED_MESSAGE_SIZE);
    warnSpy.mockRestore();
  });

  // The other direction, which is what makes the cap above safe to state: an ORDINARY thinking
  // run — one id, one `-end`, however many deltas — must still cost exactly ONE part, or the
  // cap would start dropping the deltas of a perfectly well-behaved server. Without this the
  // whole per-run dedup could be deleted and every test above would stay green.
  it('costs ONE part for one ordinary thinking run, however many deltas it carries', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deltas = MAX_TURN_REASONING_PARTS * 8;
    const { parts } = await persistOneTurn([
      { type: 'reasoning-start', id: 'r' },
      ...Array.from({ length: deltas }, (_unused, i) => ({
        type: 'reasoning-delta',
        id: 'r',
        delta: `d${i} `,
      })),
      { type: 'reasoning-end', id: 'r' },
    ]);

    const reasoningParts = parts.filter((part) => part.type === 'reasoning') as {
      text: string;
    }[];
    // Two: the adapter's synthetic "Thinking…" part, closed by the server's own run, and the
    // server's run itself. Not one per delta, and not one per event.
    expect(reasoningParts).toHaveLength(2);
    // …and nothing the server said was lost to bounding the count.
    expect(reasoningParts[1].text).toBe(
      Array.from({ length: deltas }, (_unused, i) => `d${i} `).join(''),
    );
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // The text door has always had the shape the reasoning door has only just been given — its
  // stream ids are minted HERE (`text-${n}`) and never re-opened after `text-end`, so no server
  // id can drive its part count. Pinned at the sink so that stops being an accident.
  it('bounds the text door against the same re-open cycle, at the sink', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runs = MAX_TURN_TEXT_PARTS * 60;
    const { parts, persistedJSONChars } = await persistOneTurn(
      Array.from({ length: runs }, (_unused, i) => [
        { type: 'text-delta', delta: `answer-${i} ` },
        // `step-start` is what closes a text run and mints the next id.
        { type: 'step-start' },
      ]).flat(),
    );

    expect(parts.filter((part) => part.type === 'text').length).toBeLessThanOrEqual(
      MAX_TURN_TEXT_PARTS,
    );
    expect(parts.length).toBeLessThanOrEqual(MAX_TURN_MESSAGE_PARTS + 1);
    expect(persistedJSONChars).toBeLessThanOrEqual(MAX_TURN_PERSISTED_MESSAGE_SIZE);
    // Lossless: bounding the SEGMENTATION must never cost a character of the answer.
    expect(
      (parts.filter((part) => part.type === 'text') as { text: string }[])
        .map((part) => part.text)
        .join(''),
    ).toBe(Array.from({ length: runs }, (_unused, i) => `answer-${i} `).join(''));
    warnSpy.mockRestore();
  });

  it('resets every budget for the next sendMessage — the lifetime is the TURN', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const events = [
      ...Array.from({ length: 20 }, () => ({
        type: 'text-delta',
        delta: CONTROL_CHAR.repeat(20_000),
      })),
      ...Array.from({ length: 100 }, () => ({ type: 'step-start' })),
    ];

    const first = await persistOneTurn(events);
    const second = await persistOneTurn(events);

    // A budget that leaked across turns would make the second answer shorter than the first,
    // which is the failure mode a per-adapter (rather than per-`sendMessage`) counter has.
    expect(second.parts.length).toBe(first.parts.length);
    expect(second.persistedJSONChars).toBe(first.persistedJSONChars);
    expect(first.persistedJSONChars).toBeLessThanOrEqual(MAX_TURN_PERSISTED_MESSAGE_SIZE);
    warnSpy.mockRestore();
  });
});
