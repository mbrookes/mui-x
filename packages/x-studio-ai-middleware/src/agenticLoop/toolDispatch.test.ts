/**
 * Unit tests for the tool approval + dispatch machinery extracted from
 * `agenticLoop.ts`. These exercise `waitForApproval` and `dispatchToolCall`
 * directly, independent of the LLM loop that drives them.
 */
import { describe, it, expect, vi } from 'vitest';
import { createDefaultStudioState } from '../models/studioTypes';
import type { StudioState } from '../models/studioTypes';
import type { StudioAISkill } from '../models/aiTypes';
import type { ToolPolicy, ToolEffectSummary } from '../toolPolicy';
import {
  waitForApproval,
  dispatchToolCall,
  buildApprovalEffectsSummary,
  extractToolErrorMessage,
  isApprovalThreadIdAuthorized,
  type ToolDispatchContext,
  type PendingApproval,
} from './toolDispatch';
import type { AccumulatedToolCall } from './openaiWire';

const INITIAL_STATE = createDefaultStudioState();

const allowPolicy: ToolPolicy = () => ({ action: 'allow' });

function makeCtx(overrides: Partial<ToolDispatchContext> = {}): ToolDispatchContext {
  return {
    skillHandlers: [],
    skills: [],
    data: undefined,
    customWidgets: undefined,
    pageSnapshot: undefined,
    threadId: undefined,
    approvalPending: undefined,
    approvalTimeoutMs: 1000,
    approvalFallback: 'deny',
    signal: undefined,
    onToolError: undefined,
    advertisedToolNames: new Set(),
    toolPolicy: allowPolicy,
    usage: { committedMutations: 0, toolCalls: 0 },
    ...overrides,
  };
}

function tc(name: string, argsBuffer = '{}', id = 'call_1'): AccumulatedToolCall {
  return { id, name, argsBuffer };
}

/** Drives a dispatch generator to completion, capturing yielded events + return. */
async function runDispatch(
  gen: AsyncGenerator<unknown, unknown>,
): Promise<{ events: unknown[]; outcome: unknown }> {
  const events: unknown[] = [];
  let step = await gen.next();
  while (!step.done) {
    events.push(step.value);
    // eslint-disable-next-line no-await-in-loop -- draining an async generator: each next() depends on the previous one's result, not parallelizable.
    step = await gen.next();
  }
  return { events, outcome: step.value };
}

// ── waitForApproval ─────────────────────────────────────────────────────────────

describe('waitForApproval', () => {
  it('resolves with the human decision and removes its own map entry', async () => {
    const pending = new Map<string, PendingApproval>();
    const promise = waitForApproval('id1', pending, undefined, 1000, undefined);
    // The resolver is registered synchronously.
    expect(pending.has('id1')).toBe(true);
    pending.get('id1')!.resolve(true, 'looks good');
    const outcome = await promise;
    expect(outcome).toEqual({ kind: 'resolved', approved: true, reason: 'looks good' });
    expect(pending.has('id1')).toBe(false);
  });

  it('times out when no decision arrives, and cleans up the entry', async () => {
    const pending = new Map<string, PendingApproval>();
    const outcome = await waitForApproval('id1', pending, undefined, 5, undefined);
    expect(outcome).toEqual({ kind: 'timeout' });
    expect(pending.has('id1')).toBe(false);
  });

  it('resolves aborted immediately when the signal is already aborted', async () => {
    const pending = new Map<string, PendingApproval>();
    const outcome = await waitForApproval('id1', pending, AbortSignal.abort(), 1000, undefined);
    expect(outcome).toEqual({ kind: 'aborted' });
    expect(pending.has('id1')).toBe(false);
  });

  it('resolves aborted when the signal fires later', async () => {
    const pending = new Map<string, PendingApproval>();
    const controller = new AbortController();
    const promise = waitForApproval('id1', pending, controller.signal, 1000, undefined);
    controller.abort();
    const outcome = await promise;
    expect(outcome).toEqual({ kind: 'aborted' });
    expect(pending.has('id1')).toBe(false);
  });

  it('refuses a duplicate toolCallId without touching the existing entry', async () => {
    const pending = new Map<string, PendingApproval>();
    const existing: PendingApproval = { resolve: vi.fn() };
    pending.set('id1', existing);
    const outcome = (await waitForApproval('id1', pending, undefined, 1000, undefined)) as {
      kind: string;
      approved: boolean;
      reason: string;
    };
    expect(outcome.kind).toBe('resolved');
    expect(outcome.approved).toBe(false);
    expect(outcome.reason).toMatch(/duplicate toolCallId/);
    // The pre-existing entry must be left intact (not overwritten or deleted).
    expect(pending.get('id1')).toBe(existing);
  });

  it('binds the entry to the given threadId', async () => {
    const pending = new Map<string, PendingApproval>();
    const promise = waitForApproval('id1', pending, undefined, 1000, 'thread-42');
    expect(pending.get('id1')?.threadId).toBe('thread-42');
    pending.get('id1')!.resolve(true);
    await promise;
  });

  it('leaves threadId undefined when none is provided', async () => {
    const pending = new Map<string, PendingApproval>();
    const promise = waitForApproval('id1', pending, undefined, 1000, undefined);
    expect(pending.get('id1')?.threadId).toBeUndefined();
    pending.get('id1')!.resolve(true);
    await promise;
  });
});

// ── isApprovalThreadIdAuthorized (finding 5, Tier 3) ────────────────────────────

describe('isApprovalThreadIdAuthorized', () => {
  it('authorizes when the entry has no threadId, regardless of what the request asserts', () => {
    expect(isApprovalThreadIdAuthorized({ threadId: undefined }, undefined)).toBe(true);
    expect(isApprovalThreadIdAuthorized({ threadId: undefined }, 'thread-a')).toBe(true);
  });

  it('authorizes a matching threadId', () => {
    expect(isApprovalThreadIdAuthorized({ threadId: 'thread-a' }, 'thread-a')).toBe(true);
  });

  it('denies a mismatched threadId', () => {
    expect(isApprovalThreadIdAuthorized({ threadId: 'thread-a' }, 'thread-b')).toBe(false);
  });

  // The exact bypass finding 5 flags: a naive
  // `entry.threadId !== undefined && threadId !== undefined && entry.threadId !== threadId`
  // check degrades to a no-op (treated as authorized) the moment the resolving
  // request OMITS `threadId` — this helper must deny that instead.
  it('denies when the entry has a threadId but the request omits one', () => {
    expect(isApprovalThreadIdAuthorized({ threadId: 'thread-a' }, undefined)).toBe(false);
  });
});

// ── buildApprovalEffectsSummary (T2-2) ──────────────────────────────────────────

describe('buildApprovalEffectsSummary', () => {
  const emptyEffects = (): ToolEffectSummary => ({
    mutationType: 'setWidgetLayout',
    removedWidgetIds: [],
    removedPageIds: [],
    removedFilterIds: [],
    orphanedWidgetIds: [],
    addedWidgetIds: [],
    addedPageIds: [],
    updatedWidgetIds: [],
    layoutChangedPageIds: [],
  });

  const stateWithEntities = createDefaultStudioState({
    doc: {
      dashboard: { id: 'd', title: 'D', activePageId: 'p1' },
      pages: {
        p1: { id: 'p1', title: 'Page One', widgetRows: [['w1', 'w2']] },
      },
      widgets: {
        w1: { id: 'w1', kind: 'chart', title: 'Revenue', config: { chartType: 'bar' } },
        w2: { id: 'w2', kind: 'chart', title: 'Orders', config: { chartType: 'bar' } },
      },
    },
  });

  it('returns undefined when there are no effects at all', () => {
    expect(buildApprovalEffectsSummary(undefined, stateWithEntities)).toBeUndefined();
  });

  it('returns undefined when effects carry no structural changes', () => {
    expect(buildApprovalEffectsSummary(emptyEffects(), stateWithEntities)).toBeUndefined();
  });

  it('resolves removed and orphaned widget ids to their current titles', () => {
    const summary = buildApprovalEffectsSummary(
      { ...emptyEffects(), removedWidgetIds: ['w1'], orphanedWidgetIds: ['w2'] },
      stateWithEntities,
    );
    expect(summary?.willRemoveWidgets).toEqual([{ id: 'w1', title: 'Revenue' }]);
    expect(summary?.willOrphanWidgets).toEqual([{ id: 'w2', title: 'Orders' }]);
  });

  it('resolves removed page ids to titles and passes filter ids through', () => {
    const summary = buildApprovalEffectsSummary(
      { ...emptyEffects(), removedPageIds: ['p1'], removedFilterIds: ['f1', 'f2'] },
      stateWithEntities,
    );
    expect(summary?.willRemovePages).toEqual([{ id: 'p1', title: 'Page One' }]);
    expect(summary?.willRemoveFilters).toEqual(['f1', 'f2']);
  });

  it('falls back to a placeholder title for an unknown widget id', () => {
    const summary = buildApprovalEffectsSummary(
      { ...emptyEffects(), removedWidgetIds: ['ghost'] },
      stateWithEntities,
    );
    expect(summary?.willRemoveWidgets).toEqual([{ id: 'ghost', title: '(unknown widget)' }]);
  });
});

// ── extractToolErrorMessage (finding 7) ─────────────────────────────────────────

// Regression for finding 7 (Tier 3, latent, iteration 24): a `JSON.parse` of an
// `isError` tool result's text used to be inline and unguarded — a future/misbehaving
// tool handler returning plain non-JSON error text would make it throw, and (since it
// used to live inside `dispatchToolCall`'s broader try block) that throw would be
// caught by the OUTER `catch (queryErr)`, replacing the real tool error with a
// generic "Unexpected token ... in JSON" parse-error message. Tested directly (rather
// than by forcing a real `query_data_source` dispatch to return non-JSON error text,
// which would require mocking `createDataToolHandlers` — unsafe in this suite, which
// runs vitest with `isolate: false`; see `vitest.shared.mts`).
describe('extractToolErrorMessage', () => {
  it('unwraps the `error` field from valid JSON text', () => {
    expect(extractToolErrorMessage(JSON.stringify({ error: 'sourceId is required' }))).toBe(
      'sourceId is required',
    );
  });

  it('falls back to the raw text when it is not JSON at all', () => {
    expect(extractToolErrorMessage('plain-text failure, not JSON')).toBe(
      'plain-text failure, not JSON',
    );
  });

  it('falls back to the raw text when it is valid JSON but has no `error` field', () => {
    const raw = JSON.stringify({ message: 'no error key here' });
    expect(extractToolErrorMessage(raw)).toBe(raw);
  });

  it('does not throw on malformed JSON that looks JSON-ish', () => {
    expect(() => extractToolErrorMessage('{not valid json')).not.toThrow();
    expect(extractToolErrorMessage('{not valid json')).toBe('{not valid json');
  });
});

// ── dispatchToolCall ─────────────────────────────────────────────────────────────

describe('dispatchToolCall', () => {
  it('reports invalid JSON arguments back to the model', async () => {
    const usage = { committedMutations: 0, toolCalls: 0 };
    const ctx = makeCtx({ advertisedToolNames: new Set(['list_pages']), usage });
    const { events, outcome } = await runDispatch(
      dispatchToolCall(tc('list_pages', '{not json'), {}, true, INITIAL_STATE, ctx),
    );
    expect(events).toEqual([]);
    expect(outcome).toEqual({
      kind: 'result',
      output: JSON.stringify({ error: 'invalid tool arguments: {not json' }),
    });
    // Regression: this early return happens before `executeToolWithPolicy`/
    // `consultToolPolicyArgsOnly` ever run, so it must bump `usage.toolCalls` itself —
    // otherwise a malformed tool call would consume a turn for free against the
    // tool-call budget.
    expect(usage.toolCalls).toBe(1);
  });

  it('rejects a call to a tool that was not advertised this request', async () => {
    const usage = { committedMutations: 0, toolCalls: 0 };
    const ctx = makeCtx({ advertisedToolNames: new Set(['list_pages']), usage });
    const { outcome } = await runDispatch(
      dispatchToolCall(tc('remove_page'), {}, false, INITIAL_STATE, ctx),
    );
    expect(outcome).toEqual({
      kind: 'result',
      output: JSON.stringify({ error: 'Unknown tool: remove_page' }),
    });
    // Regression: same accounting gap as the parse-failure case above — an
    // unadvertised/hallucinated tool name must still count against the tool-call budget.
    expect(usage.toolCalls).toBe(1);
  });

  it('runs a registered server-tool skill and forwards its output', async () => {
    const execute = vi.fn(async () => ({ output: 'skill-ran', nextState: INITIAL_STATE }));
    const skill: StudioAISkill = {
      name: 'my_skill',
      mode: 'server-tool',
      promptFragment: '',
      tool: { name: 'my_skill', description: 'd', parameters: {}, execute },
    };
    const ctx = makeCtx({
      advertisedToolNames: new Set(['my_skill']),
      skillHandlers: [skill],
    });
    const { events, outcome } = await runDispatch(
      dispatchToolCall(tc('my_skill', '{"x":1}'), { x: 1 }, false, INITIAL_STATE, ctx),
    );
    expect(execute).toHaveBeenCalledWith({ x: 1 }, INITIAL_STATE);
    expect(events).toEqual([]);
    expect(outcome).toEqual({ kind: 'result', output: 'skill-ran', nextState: INITIAL_STATE });
  });

  it('emits a state-mutation event and increments the mutation counter when a skill mutates', async () => {
    const mutation = { type: 'setDashboardTitle', title: 'New' } as never;
    const execute = vi.fn(async () => ({ output: 'ok', mutation, nextState: INITIAL_STATE }));
    const skill: StudioAISkill = {
      name: 'mutating_skill',
      mode: 'server-tool',
      promptFragment: '',
      tool: { name: 'mutating_skill', description: 'd', parameters: {}, execute },
    };
    const usage = { committedMutations: 0, toolCalls: 0 };
    const ctx = makeCtx({
      advertisedToolNames: new Set(['mutating_skill']),
      skillHandlers: [skill],
      usage,
    });
    const { events, outcome } = await runDispatch(
      dispatchToolCall(tc('mutating_skill'), {}, false, INITIAL_STATE, ctx),
    );
    expect(events).toHaveLength(1);
    expect((events[0] as { type: string }).type).toBe('state-mutation');
    expect(usage.committedMutations).toBe(1);
    expect((outcome as { kind: string }).kind).toBe('result');
  });

  it('surfaces a skill execute() throw as an error result and fires onToolError', async () => {
    const onToolError = vi.fn();
    const execute = vi.fn(async () => {
      throw new Error('boom');
    });
    const skill: StudioAISkill = {
      name: 'bad_skill',
      mode: 'server-tool',
      promptFragment: '',
      tool: { name: 'bad_skill', description: 'd', parameters: {}, execute },
    };
    const ctx = makeCtx({
      advertisedToolNames: new Set(['bad_skill']),
      skillHandlers: [skill],
      onToolError,
    });
    const { outcome } = await runDispatch(
      dispatchToolCall(tc('bad_skill'), {}, false, INITIAL_STATE, ctx),
    );
    expect(onToolError).toHaveBeenCalledOnce();
    expect(outcome).toEqual({ kind: 'result', output: JSON.stringify({ error: 'boom' }) });
  });

  it('returns an informative error for query_data_source when no data config is set', async () => {
    const ctx = makeCtx({ advertisedToolNames: new Set(['query_data_source']) });
    const { outcome } = await runDispatch(
      dispatchToolCall(tc('query_data_source'), {}, false, INITIAL_STATE, ctx),
    );
    const parsed = JSON.parse((outcome as { output: string }).output) as { error: string };
    expect(parsed.error).toMatch(/no data access was configured/);
  });

  // Regression for finding 7 (Tier 3, latent, iteration 24): a real `data.queryDataSource`
  // failure still goes through `errorResult` (`mcp/helpers.ts`), i.e. valid JSON, and
  // the fix must not have broken that ordinary path — `onToolError` should still
  // receive the UNWRAPPED `error` string, not the raw `{"error":"..."}` JSON text.
  it('unwraps the JSON error field from a real query_data_source failure', async () => {
    const onToolError = vi.fn();
    const state = createDefaultStudioState({
      runtime: {
        dataSources: { src1: { id: 'src1', label: 'Source 1', tableName: 't', fields: [] } },
      },
    });
    const ctx = makeCtx({
      advertisedToolNames: new Set(['query_data_source']),
      data: {
        queryDataSource: vi.fn(async () => {
          throw new Error('db unreachable');
        }),
      },
      onToolError,
    });
    const { outcome } = await runDispatch(
      dispatchToolCall(
        tc('query_data_source', JSON.stringify({ sourceId: 'src1' })),
        { sourceId: 'src1' },
        false,
        state,
        ctx,
      ),
    );
    expect(JSON.parse((outcome as { output: string }).output)).toEqual({
      error: expect.stringContaining('db unreachable'),
    });
    expect(onToolError).toHaveBeenCalledOnce();
    const [toolName, error] = onToolError.mock.calls[0] as [string, Error];
    expect(toolName).toBe('query_data_source');
    // Unwrapped from the `{"error": "..."}` JSON, not the raw JSON text itself.
    expect(error.message).toContain('db unreachable');
    expect(error.message).not.toMatch(/^\{/);
  });

  // Finding: the chat-transport `query_data_source` call had no timeout at all — a
  // hung DB connection would block the whole agentic-loop turn indefinitely.
  // Mirrors the 15s timeout `mcp/summarisePage.ts` already applies to its own
  // `data.queryDataSource` calls via the same `withTimeout` helper.
  it('times out a hanging data.queryDataSource instead of waiting forever', async () => {
    vi.useFakeTimers();
    try {
      const state = createDefaultStudioState({
        runtime: {
          dataSources: {
            src1: { id: 'src1', label: 'Source 1', tableName: 'src1_table', fields: [] },
          },
        },
      });
      const queryDataSource = vi.fn(() => new Promise<never>(() => {}));
      const ctx = makeCtx({
        advertisedToolNames: new Set(['query_data_source']),
        data: { queryDataSource },
      });

      const dispatchPromise = runDispatch(
        dispatchToolCall(
          tc('query_data_source', JSON.stringify({ sourceId: 'src1' })),
          { sourceId: 'src1' },
          false,
          state,
          ctx,
        ),
      );

      await vi.advanceTimersByTimeAsync(15_000);
      const { outcome } = await dispatchPromise;
      const parsed = JSON.parse((outcome as { output: string }).output) as { error: string };
      // Two independent timeouts now race the same underlying `data.queryDataSource`
      // call: this call site's own `QUERY_DATA_SOURCE_TIMEOUT_MS` wrapper, AND (since
      // Tier 3, iteration 22) `mcp/queryTools.ts`'s own `withTimeout` around the same
      // call — added to close the same gap on the MCP transport, which has no
      // equivalent outer wrapper of its own. Both are bounded at 15s, so either
      // message is an acceptable, equally-valid proof that the call does not hang
      // forever; don't couple this assertion to which one wins the race.
      expect(parsed.error).toMatch(/timed out after 15000ms/);
    } finally {
      vi.useRealTimers();
    }
  });

  // Finding: a server-tool skill's `execute()` had no timeout wrap, unlike the sibling
  // `query_data_source` path above — a hanging skill (e.g. one awaiting a stuck
  // external API call) would block the whole agentic-loop turn indefinitely.
  it('times out a hanging server-tool skill instead of waiting forever', async () => {
    vi.useFakeTimers();
    try {
      const execute = vi.fn(() => new Promise<never>(() => {}));
      const skill: StudioAISkill = {
        name: 'hanging_skill',
        mode: 'server-tool',
        promptFragment: '',
        tool: { name: 'hanging_skill', description: 'd', parameters: {}, execute },
      };
      const ctx = makeCtx({
        advertisedToolNames: new Set(['hanging_skill']),
        skillHandlers: [skill],
      });

      const dispatchPromise = runDispatch(
        dispatchToolCall(tc('hanging_skill'), {}, false, INITIAL_STATE, ctx),
      );

      await vi.advanceTimersByTimeAsync(15_000);
      const { outcome } = await dispatchPromise;
      const parsed = JSON.parse((outcome as { output: string }).output) as { error: string };
      expect(parsed.error).toMatch(/timed out after 15000ms/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports an unregistered server-tool skill (declared but no handler)', async () => {
    const ctx = makeCtx({
      advertisedToolNames: new Set(['declared_skill']),
      skills: [
        {
          name: 'declared_skill',
          mode: 'server-tool',
          promptFragment: '',
          tool: { name: 'declared_skill', description: 'd', parameters: {} },
        },
      ],
    });
    const { outcome } = await runDispatch(
      dispatchToolCall(tc('declared_skill'), {}, false, INITIAL_STATE, ctx),
    );
    expect(outcome).toEqual({
      kind: 'result',
      output: JSON.stringify({
        error: "server-tool skill 'declared_skill' has no registered handler on the server.",
      }),
    });
  });

  it('denies a policy-denied tool without executing it', async () => {
    const denyPolicy: ToolPolicy = () => ({ action: 'deny', reason: 'not allowed' });
    const execute = vi.fn(async () => ({ output: 'ran', nextState: INITIAL_STATE }));
    const skill: StudioAISkill = {
      name: 'gated_skill',
      mode: 'server-tool',
      promptFragment: '',
      tool: { name: 'gated_skill', description: 'd', parameters: {}, execute },
    };
    const ctx = makeCtx({
      advertisedToolNames: new Set(['gated_skill']),
      skillHandlers: [skill],
      toolPolicy: denyPolicy,
    });
    const { outcome } = await runDispatch(
      dispatchToolCall(tc('gated_skill'), {}, false, INITIAL_STATE, ctx),
    );
    expect(execute).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: 'result', output: JSON.stringify({ error: 'not allowed' }) });
  });

  describe('require-approval flow', () => {
    const approvalPolicy: ToolPolicy = () => ({ action: 'require-approval' });

    function makeApprovalSkill(execute: () => Promise<{ output: string; nextState: StudioState }>) {
      const skill: StudioAISkill = {
        name: 'approve_skill',
        mode: 'server-tool',
        promptFragment: '',
        tool: { name: 'approve_skill', description: 'd', parameters: {}, execute },
      };
      return skill;
    }

    it('yields tool-approval-request and executes once approved', async () => {
      const execute = vi.fn(async () => ({ output: 'approved-run', nextState: INITIAL_STATE }));
      const approvalPending = new Map<string, PendingApproval>();
      const ctx = makeCtx({
        advertisedToolNames: new Set(['approve_skill']),
        skillHandlers: [makeApprovalSkill(execute)],
        toolPolicy: approvalPolicy,
        approvalPending,
      });

      const gen = dispatchToolCall(tc('approve_skill'), {}, false, INITIAL_STATE, ctx);
      const first = await gen.next();
      expect((first.value as { type: string }).type).toBe('tool-approval-request');

      const pendingStep = gen.next();
      // Let the generator register its resolver before we approve.
      await Promise.resolve();
      approvalPending.get('call_1')!.resolve(true);
      const done = await pendingStep;
      expect(done.done).toBe(true);
      expect(done.value).toEqual({
        kind: 'result',
        output: 'approved-run',
        nextState: INITIAL_STATE,
      });
      expect(execute).toHaveBeenCalledOnce();
    });

    // Finding T2/T3 (approval-hijack): the pending entry must carry the request's
    // `ctx.threadId` — the same AI-chat-thread identity `rename_thread` stamps onto
    // mutations — so a host that also threads it through its approval endpoint can
    // refuse a resolution presented for a different conversation.
    it('binds the pending approval entry to ctx.threadId', async () => {
      const execute = vi.fn(async () => ({ output: 'approved-run', nextState: INITIAL_STATE }));
      const approvalPending = new Map<string, PendingApproval>();
      const ctx = makeCtx({
        advertisedToolNames: new Set(['approve_skill']),
        skillHandlers: [makeApprovalSkill(execute)],
        toolPolicy: approvalPolicy,
        approvalPending,
        threadId: 'thread-abc',
      });

      const gen = dispatchToolCall(tc('approve_skill'), {}, false, INITIAL_STATE, ctx);
      await gen.next();
      const pendingStep = gen.next();
      // The entry is registered once the generator resumes past the yield and calls
      // `waitForApproval` — let that microtask run before inspecting the map.
      await Promise.resolve();
      expect(approvalPending.get('call_1')?.threadId).toBe('thread-abc');
      approvalPending.get('call_1')!.resolve(true);
      await pendingStep;
    });

    it('leaves the pending entry unbound when ctx.threadId is not set', async () => {
      const execute = vi.fn(async () => ({ output: 'approved-run', nextState: INITIAL_STATE }));
      const approvalPending = new Map<string, PendingApproval>();
      const ctx = makeCtx({
        advertisedToolNames: new Set(['approve_skill']),
        skillHandlers: [makeApprovalSkill(execute)],
        toolPolicy: approvalPolicy,
        approvalPending,
      });

      const gen = dispatchToolCall(tc('approve_skill'), {}, false, INITIAL_STATE, ctx);
      await gen.next();
      const pendingStep = gen.next();
      await Promise.resolve();
      expect(approvalPending.has('call_1')).toBe(true);
      expect(approvalPending.get('call_1')?.threadId).toBeUndefined();
      approvalPending.get('call_1')!.resolve(true);
      await pendingStep;
    });

    it('returns the denial output and skips execution when denied', async () => {
      const execute = vi.fn(async () => ({ output: 'should-not-run', nextState: INITIAL_STATE }));
      const approvalPending = new Map<string, PendingApproval>();
      const ctx = makeCtx({
        advertisedToolNames: new Set(['approve_skill']),
        skillHandlers: [makeApprovalSkill(execute)],
        toolPolicy: approvalPolicy,
        approvalPending,
      });

      const gen = dispatchToolCall(tc('approve_skill'), {}, false, INITIAL_STATE, ctx);
      await gen.next();
      const pendingStep = gen.next();
      await Promise.resolve();
      approvalPending.get('call_1')!.resolve(false, 'user said no');
      const done = await pendingStep;
      expect(execute).not.toHaveBeenCalled();
      const parsed = JSON.parse((done.value as { output: string }).output) as {
        denied: boolean;
        reason: string;
      };
      expect(parsed).toEqual({ denied: true, reason: 'user said no' });
    });

    it('denies by default when approval is required but no approvalPending map is configured', async () => {
      const execute = vi.fn(async () => ({ output: 'ran', nextState: INITIAL_STATE }));
      const ctx = makeCtx({
        advertisedToolNames: new Set(['approve_skill']),
        skillHandlers: [makeApprovalSkill(execute)],
        toolPolicy: approvalPolicy,
        approvalPending: undefined,
        approvalFallback: 'deny',
      });
      const { events, outcome } = await runDispatch(
        dispatchToolCall(tc('approve_skill'), {}, false, INITIAL_STATE, ctx),
      );
      expect(events).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
      const parsed = JSON.parse((outcome as { output: string }).output) as { denied: boolean };
      expect(parsed.denied).toBe(true);
    });

    it("auto-approves and warns when approvalFallback is 'allow' and no map is configured", async () => {
      const onToolError = vi.fn();
      const execute = vi.fn(async () => ({ output: 'auto-ran', nextState: INITIAL_STATE }));
      const ctx = makeCtx({
        advertisedToolNames: new Set(['approve_skill']),
        skillHandlers: [makeApprovalSkill(execute)],
        toolPolicy: approvalPolicy,
        approvalPending: undefined,
        approvalFallback: 'allow',
        onToolError,
      });
      const { outcome } = await runDispatch(
        dispatchToolCall(tc('approve_skill'), {}, false, INITIAL_STATE, ctx),
      );
      expect(execute).toHaveBeenCalledOnce();
      expect(onToolError).toHaveBeenCalledOnce();
      expect(outcome).toEqual({ kind: 'result', output: 'auto-ran', nextState: INITIAL_STATE });
    });

    // Regression for T2-2: a built-in tool that needs approval must attach a state-derived
    // structural-effects summary to its `tool-approval-request` event, so a human isn't
    // approving a removing/orphaning op blind.
    it('attaches an effects summary to the approval event for a built-in removing tool', async () => {
      const stateWithWidget = createDefaultStudioState({
        doc: {
          dashboard: { id: 'd', title: 'D', activePageId: 'p1' },
          pages: { p1: { id: 'p1', title: 'P1', widgetRows: [['w1']] } },
          widgets: {
            w1: { id: 'w1', kind: 'chart', title: 'My Widget', config: { chartType: 'bar' } },
          },
        },
      });
      const approvalPending = new Map<string, PendingApproval>();
      const ctx = makeCtx({
        advertisedToolNames: new Set(['remove_widget']),
        toolPolicy: approvalPolicy,
        approvalPending,
      });

      const gen = dispatchToolCall(
        tc('remove_widget', JSON.stringify({ widgetId: 'w1' })),
        { widgetId: 'w1' },
        false,
        stateWithWidget,
        ctx,
      );
      const first = await gen.next();
      const ev = first.value as {
        type: string;
        effects?: { willRemoveWidgets?: Array<{ id: string; title: string }> };
      };
      expect(ev.type).toBe('tool-approval-request');
      expect(ev.effects?.willRemoveWidgets).toEqual([{ id: 'w1', title: 'My Widget' }]);

      // Drain: approve so the generator completes cleanly.
      const pendingStep = gen.next();
      await Promise.resolve();
      approvalPending.get('call_1')!.resolve(true);
      await pendingStep;
    });

    // Tier 3, iteration 22: the policy's own `reason` for a `require-approval`
    // decision (e.g. "exceeds daily mutation budget") used to be silently dropped
    // between `toolPolicy.ts` and here — a human approving the call never saw WHY
    // it was flagged. It must now be threaded into the `tool-approval-request` event.
    it('attaches the policy-supplied reason to the approval event for a built-in tool', async () => {
      const stateWithWidget = createDefaultStudioState({
        doc: {
          dashboard: { id: 'd', title: 'D', activePageId: 'p1' },
          pages: { p1: { id: 'p1', title: 'P1', widgetRows: [['w1']] } },
          widgets: {
            w1: { id: 'w1', kind: 'chart', title: 'My Widget', config: { chartType: 'bar' } },
          },
        },
      });
      const approvalPending = new Map<string, PendingApproval>();
      const policyWithReason: ToolPolicy = () => ({
        action: 'require-approval',
        reason: 'exceeds daily mutation budget',
      });
      const ctx = makeCtx({
        advertisedToolNames: new Set(['remove_widget']),
        toolPolicy: policyWithReason,
        approvalPending,
      });

      const gen = dispatchToolCall(
        tc('remove_widget', JSON.stringify({ widgetId: 'w1' })),
        { widgetId: 'w1' },
        false,
        stateWithWidget,
        ctx,
      );
      const first = await gen.next();
      const ev = first.value as { type: string; reason?: string };
      expect(ev.type).toBe('tool-approval-request');
      expect(ev.reason).toBe('exceeds daily mutation budget');

      const pendingStep = gen.next();
      await Promise.resolve();
      approvalPending.get('call_1')!.resolve(true);
      await pendingStep;
    });

    // Same fix, for a server-tool skill's args-only require-approval path.
    it('attaches the policy-supplied reason to the approval event for a server-tool skill', async () => {
      const execute = vi.fn(async () => ({ output: 'ran', nextState: INITIAL_STATE }));
      const approvalPending = new Map<string, PendingApproval>();
      const policyWithReason: ToolPolicy = () => ({
        action: 'require-approval',
        reason: 'live query needs confirmation',
      });
      const ctx = makeCtx({
        advertisedToolNames: new Set(['approve_skill']),
        skillHandlers: [makeApprovalSkill(execute)],
        toolPolicy: policyWithReason,
        approvalPending,
      });
      const gen = dispatchToolCall(tc('approve_skill'), {}, false, INITIAL_STATE, ctx);
      const first = await gen.next();
      const ev = first.value as { type: string; reason?: string };
      expect(ev.type).toBe('tool-approval-request');
      expect(ev.reason).toBe('live query needs confirmation');

      const pendingStep = gen.next();
      await Promise.resolve();
      approvalPending.get('call_1')!.resolve(true);
      await pendingStep;
    });

    // The no-approvalPending-channel fallback denial must also surface the
    // policy's reason (Tier 3, iteration 22) — otherwise the LLM, which only sees
    // this JSON output, has no idea why the call was flagged in the first place.
    it('includes the policy reason in the fallback denial message when no approvalPending channel is configured', async () => {
      const execute = vi.fn(async () => ({ output: 'ran', nextState: INITIAL_STATE }));
      const policyWithReason: ToolPolicy = () => ({
        action: 'require-approval',
        reason: 'exceeds daily mutation budget',
      });
      const ctx = makeCtx({
        advertisedToolNames: new Set(['approve_skill']),
        skillHandlers: [makeApprovalSkill(execute)],
        toolPolicy: policyWithReason,
        approvalPending: undefined,
        approvalFallback: 'deny',
      });
      const { outcome } = await runDispatch(
        dispatchToolCall(tc('approve_skill'), {}, false, INITIAL_STATE, ctx),
      );
      const parsed = JSON.parse((outcome as { output: string }).output) as {
        denied: boolean;
        reason: string;
      };
      expect(parsed.denied).toBe(true);
      expect(parsed.reason).toMatch(/exceeds daily mutation budget/);
    });

    it('ends with an aborted outcome when the approval is aborted mid-wait', async () => {
      const execute = vi.fn(async () => ({ output: 'ran', nextState: INITIAL_STATE }));
      const approvalPending = new Map<string, PendingApproval>();
      const controller = new AbortController();
      const ctx = makeCtx({
        advertisedToolNames: new Set(['approve_skill']),
        skillHandlers: [makeApprovalSkill(execute)],
        toolPolicy: approvalPolicy,
        approvalPending,
        signal: controller.signal,
      });
      const gen = dispatchToolCall(tc('approve_skill'), {}, false, INITIAL_STATE, ctx);
      await gen.next();
      const pendingStep = gen.next();
      await Promise.resolve();
      controller.abort();
      const done = await pendingStep;
      expect(execute).not.toHaveBeenCalled();
      expect(done.value).toEqual({ kind: 'aborted' });
    });
  });
});
