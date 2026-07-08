/**
 * Unit tests for the tool approval + dispatch machinery extracted from
 * `agenticLoop.ts`. These exercise `waitForApproval` and `dispatchToolCall`
 * directly, independent of the LLM loop that drives them.
 */
import { describe, it, expect, vi } from 'vitest';
import { createDefaultStudioState } from '../models/studioTypes';
import type { StudioState } from '../models/studioTypes';
import type { StudioAISkill } from '../models/aiTypes';
import type { ToolPolicy } from '../toolPolicy';
import { waitForApproval, dispatchToolCall, type ToolDispatchContext } from './toolDispatch';
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
    const pending = new Map<string, (approved: boolean, reason?: string) => void>();
    const promise = waitForApproval('id1', pending, undefined, 1000);
    // The resolver is registered synchronously.
    expect(pending.has('id1')).toBe(true);
    pending.get('id1')!(true, 'looks good');
    const outcome = await promise;
    expect(outcome).toEqual({ kind: 'resolved', approved: true, reason: 'looks good' });
    expect(pending.has('id1')).toBe(false);
  });

  it('times out when no decision arrives, and cleans up the entry', async () => {
    const pending = new Map<string, (approved: boolean, reason?: string) => void>();
    const outcome = await waitForApproval('id1', pending, undefined, 5);
    expect(outcome).toEqual({ kind: 'timeout' });
    expect(pending.has('id1')).toBe(false);
  });

  it('resolves aborted immediately when the signal is already aborted', async () => {
    const pending = new Map<string, (approved: boolean, reason?: string) => void>();
    const outcome = await waitForApproval('id1', pending, AbortSignal.abort(), 1000);
    expect(outcome).toEqual({ kind: 'aborted' });
    expect(pending.has('id1')).toBe(false);
  });

  it('resolves aborted when the signal fires later', async () => {
    const pending = new Map<string, (approved: boolean, reason?: string) => void>();
    const controller = new AbortController();
    const promise = waitForApproval('id1', pending, controller.signal, 1000);
    controller.abort();
    const outcome = await promise;
    expect(outcome).toEqual({ kind: 'aborted' });
    expect(pending.has('id1')).toBe(false);
  });

  it('refuses a duplicate toolCallId without touching the existing entry', async () => {
    const pending = new Map<string, (approved: boolean, reason?: string) => void>();
    const existing = vi.fn();
    pending.set('id1', existing);
    const outcome = (await waitForApproval('id1', pending, undefined, 1000)) as {
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
});

// ── dispatchToolCall ─────────────────────────────────────────────────────────────

describe('dispatchToolCall', () => {
  it('reports invalid JSON arguments back to the model', async () => {
    const ctx = makeCtx({ advertisedToolNames: new Set(['list_pages']) });
    const { events, outcome } = await runDispatch(
      dispatchToolCall(tc('list_pages', '{not json'), {}, true, INITIAL_STATE, ctx),
    );
    expect(events).toEqual([]);
    expect(outcome).toEqual({
      kind: 'result',
      output: JSON.stringify({ error: 'invalid tool arguments: {not json' }),
    });
  });

  it('rejects a call to a tool that was not advertised this request', async () => {
    const ctx = makeCtx({ advertisedToolNames: new Set(['list_pages']) });
    const { outcome } = await runDispatch(
      dispatchToolCall(tc('remove_page'), {}, false, INITIAL_STATE, ctx),
    );
    expect(outcome).toEqual({
      kind: 'result',
      output: JSON.stringify({ error: 'Unknown tool: remove_page' }),
    });
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
      const approvalPending = new Map<string, (approved: boolean, reason?: string) => void>();
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
      approvalPending.get('call_1')!(true);
      const done = await pendingStep;
      expect(done.done).toBe(true);
      expect(done.value).toEqual({
        kind: 'result',
        output: 'approved-run',
        nextState: INITIAL_STATE,
      });
      expect(execute).toHaveBeenCalledOnce();
    });

    it('returns the denial output and skips execution when denied', async () => {
      const execute = vi.fn(async () => ({ output: 'should-not-run', nextState: INITIAL_STATE }));
      const approvalPending = new Map<string, (approved: boolean, reason?: string) => void>();
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
      approvalPending.get('call_1')!(false, 'user said no');
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

    it('ends with an aborted outcome when the approval is aborted mid-wait', async () => {
      const execute = vi.fn(async () => ({ output: 'ran', nextState: INITIAL_STATE }));
      const approvalPending = new Map<string, (approved: boolean, reason?: string) => void>();
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
