/**
 * Tests for the `ToolPolicy` chokepoint: the pure effect diff, the two built-in
 * policies, and `executeToolWithPolicy`.
 *
 * `computeToolEffects` expectations are grounded in the REAL reducer output — every
 * mutation/nextState pair is produced by `executeToolOnState` (the same code the
 * transports run), never hand-built — so the diff is checked against actual
 * `applyMutation` behavior, not assumptions.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  computeToolEffects,
  createDefaultToolPolicy,
  createEffectsAwareToolPolicy,
  executeToolWithPolicy,
  Policy,
} from './toolPolicy';
import type { ToolPolicy, ToolPolicyContext } from './toolPolicy';
import { executeToolOnState } from './executeToolOnState';
import { STUDIO_AI_TOOL_NAMES, DESTRUCTIVE_TOOLS } from './studioAITools';
import { createDefaultStudioState } from './models/studioTypes';
import type { StudioState } from './models/studioTypes';

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Single page with two widgets sharing one row. */
function makeTwoWidgetState(): StudioState {
  return createDefaultStudioState({
    doc: {
      dashboard: { id: 'd1', title: 'Dashboard', activePageId: 'page-1' },
      pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['w1', 'w2']] } },
      widgets: {
        w1: {
          id: 'w1',
          kind: 'chart',
          title: 'W1',
          sourceId: 'src1',
          config: { chartType: 'bar' },
        },
        w2: {
          id: 'w2',
          kind: 'chart',
          title: 'W2',
          sourceId: 'src1',
          config: { chartType: 'bar' },
        },
      },
    },
    runtime: {
      dataSources: {
        src1: {
          id: 'src1',
          label: 'Sales',
          fields: [{ id: 'revenue', label: 'Revenue', type: 'number' }],
        },
      },
    },
  });
}

/** Two pages, each with a widget + a page-scoped filter (mirrors executeToolOnState.test). */
function makeMultiPageState(): StudioState {
  return createDefaultStudioState({
    doc: {
      dashboard: { id: 'd1', title: 'Dashboard', activePageId: 'page-1' },
      pages: {
        'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['widget-1']] },
        'page-2': { id: 'page-2', title: 'Page 2', widgetRows: [['widget-2']] },
      },
      widgets: {
        'widget-1': {
          id: 'widget-1',
          kind: 'chart',
          title: 'W1',
          sourceId: 'src1',
          config: { chartType: 'bar' },
        },
        'widget-2': {
          id: 'widget-2',
          kind: 'chart',
          title: 'W2',
          sourceId: 'src1',
          config: { chartType: 'bar' },
        },
      },
      filters: [
        {
          id: 'f-page1',
          field: 'revenue',
          operator: 'greater_than',
          value: 1,
          scope: { kind: 'page', pageId: 'page-1' },
        },
        {
          id: 'f-page2',
          field: 'revenue',
          operator: 'greater_than',
          value: 2,
          scope: { kind: 'page', pageId: 'page-2' },
        },
      ],
    },
  });
}

const EMPTY_USAGE = () => ({ committedMutations: 0, toolCalls: 0 });

// ── computeToolEffects ──────────────────────────────────────────────────────

describe('computeToolEffects', () => {
  it('flags an orphaned widget when set_widget_layout drops it from the rows', () => {
    const state = makeTwoWidgetState();
    const result = executeToolOnState('set_widget_layout', { rows: [['w1']] }, state);
    expect(result.mutation).toBeDefined();

    const effects = computeToolEffects(state, result.mutation!, result.nextState);
    expect(effects.mutationType).toBe('setWidgetLayout');
    // w2 is still in state.widgets but referenced by no page's rows now — orphaned.
    expect(effects.orphanedWidgetIds).toEqual(['w2']);
    expect(effects.removedWidgetIds).toEqual([]);
    expect(effects.layoutChangedPageIds).toContain('page-1');
  });

  it('does not flag an orphan for a benign same-ids reorder', () => {
    const state = makeTwoWidgetState();
    const result = executeToolOnState('set_widget_layout', { rows: [['w2', 'w1']] }, state);
    const effects = computeToolEffects(state, result.mutation!, result.nextState);
    expect(effects.orphanedWidgetIds).toEqual([]);
    expect(effects.removedWidgetIds).toEqual([]);
    expect(effects.layoutChangedPageIds).toContain('page-1');
  });

  it('reports removedWidgetIds for a removeWidget cascade (not orphaned)', () => {
    const state = makeTwoWidgetState();
    const result = executeToolOnState('remove_widget', { widgetId: 'w1' }, state);
    const effects = computeToolEffects(state, result.mutation!, result.nextState);
    expect(effects.mutationType).toBe('removeWidget');
    expect(effects.removedWidgetIds).toEqual(['w1']);
    // w1 was deleted from state.widgets entirely — it is removed, not orphaned.
    expect(effects.orphanedWidgetIds).toEqual([]);
  });

  it('reports page/widget/filter removals for a removePage cascade', () => {
    const state = makeMultiPageState();
    const result = executeToolOnState('remove_page', { pageId: 'page-1' }, state);
    const effects = computeToolEffects(state, result.mutation!, result.nextState);
    expect(effects.mutationType).toBe('removePage');
    expect(effects.removedPageIds).toEqual(['page-1']);
    // The reducer removes the page's widget and its page-scoped filter too.
    expect(effects.removedWidgetIds).toEqual(['widget-1']);
    expect(effects.removedFilterIds).toEqual(['f-page1']);
  });

  it('reports added/removed/updated ids for an apply_bulk_update with mixed deltas', () => {
    const state = makeTwoWidgetState();
    const result = executeToolOnState(
      'apply_bulk_update',
      {
        widgetRemovals: ['w1'],
        widgetAdditions: [{ kind: 'chart', title: 'New' }],
        widgetUpdates: [{ widgetId: 'w2', title: 'Renamed' }],
      },
      state,
    );
    const effects = computeToolEffects(state, result.mutation!, result.nextState);
    expect(effects.mutationType).toBe('applyBulkUpdate');
    expect(effects.removedWidgetIds).toEqual(['w1']);
    expect(effects.updatedWidgetIds).toEqual(['w2']);
    expect(effects.addedWidgetIds).toHaveLength(1);
    expect(effects.addedWidgetIds[0]).toMatch(/^widget-/);
  });

  it('reports addedPageIds for add_page', () => {
    const state = makeTwoWidgetState();
    const result = executeToolOnState('add_page', { title: 'Extra' }, state);
    const effects = computeToolEffects(state, result.mutation!, result.nextState);
    expect(effects.mutationType).toBe('addPage');
    expect(effects.addedPageIds).toHaveLength(1);
    expect(effects.removedPageIds).toEqual([]);
  });
});

// ── createDefaultToolPolicy ─────────────────────────────────────────────────

describe('createDefaultToolPolicy', () => {
  it.each(STUDIO_AI_TOOL_NAMES)('matches DESTRUCTIVE_TOOLS membership for %s', async (name) => {
    const policy = createDefaultToolPolicy();
    const state = createDefaultStudioState();
    const decision = await policy({
      transport: 'chat',
      toolName: name,
      input: {},
      state,
      proposed: undefined,
      usage: EMPTY_USAGE(),
    });
    const expected = DESTRUCTIVE_TOOLS.has(name) ? 'require-approval' : 'allow';
    expect(decision.action).toBe(expected);
  });

  it('honors a custom approvalTools set', async () => {
    const policy = createDefaultToolPolicy(new Set(['set_dashboard_title']));
    const state = createDefaultStudioState();
    const decision = await policy({
      transport: 'chat',
      toolName: 'set_dashboard_title',
      input: {},
      state,
      proposed: undefined,
      usage: EMPTY_USAGE(),
    });
    expect(decision.action).toBe('require-approval');
  });
});

// ── createEffectsAwareToolPolicy ────────────────────────────────────────────

describe('createEffectsAwareToolPolicy', () => {
  it('requires approval for an orphaning layout change but allows a benign reorder', async () => {
    const policy = createEffectsAwareToolPolicy();
    const state = makeTwoWidgetState();

    const orphan = executeToolOnState('set_widget_layout', { rows: [['w1']] }, state);
    const orphanDecision = await policy({
      transport: 'chat',
      toolName: 'set_widget_layout',
      input: { rows: [['w1']] },
      state,
      proposed: {
        mutation: orphan.mutation!,
        nextState: orphan.nextState,
        effects: computeToolEffects(state, orphan.mutation!, orphan.nextState),
      },
      usage: EMPTY_USAGE(),
    });
    expect(orphanDecision.action).toBe('require-approval');

    const reorder = executeToolOnState('set_widget_layout', { rows: [['w2', 'w1']] }, state);
    const reorderDecision = await policy({
      transport: 'chat',
      toolName: 'set_widget_layout',
      input: { rows: [['w2', 'w1']] },
      state,
      proposed: {
        mutation: reorder.mutation!,
        nextState: reorder.nextState,
        effects: computeToolEffects(state, reorder.mutation!, reorder.nextState),
      },
      usage: EMPTY_USAGE(),
    });
    expect(reorderDecision.action).toBe('allow');
  });

  it('allows an args-only (no proposed) call', async () => {
    const policy = createEffectsAwareToolPolicy();
    const decision = await policy({
      transport: 'chat',
      toolName: 'query_data_source',
      input: { sourceId: 'src1' },
      state: createDefaultStudioState(),
      proposed: undefined,
      usage: EMPTY_USAGE(),
    });
    expect(decision.action).toBe('allow');
  });

  it('requires approval when updatedWidgetThreshold is exceeded', async () => {
    const policy = createEffectsAwareToolPolicy({ updatedWidgetThreshold: 0 });
    const state = makeTwoWidgetState();
    const update = executeToolOnState('update_widget', { widgetId: 'w1', title: 'X' }, state);
    const decision = await policy({
      transport: 'chat',
      toolName: 'update_widget',
      input: { widgetId: 'w1', title: 'X' },
      state,
      proposed: {
        mutation: update.mutation!,
        nextState: update.nextState,
        effects: computeToolEffects(state, update.mutation!, update.nextState),
      },
      usage: EMPTY_USAGE(),
    });
    expect(decision.action).toBe('require-approval');
  });
});

// ── executeToolWithPolicy ────────────────────────────────────────────────────

describe('executeToolWithPolicy', () => {
  it('increments toolCalls, allows a benign tool, and never touches committedMutations', async () => {
    const state = makeTwoWidgetState();
    const usage = EMPTY_USAGE();
    const outcome = await executeToolWithPolicy('set_dashboard_title', { title: 'X' }, state, {
      policy: createDefaultToolPolicy(),
      transport: 'chat',
      usage,
    });
    expect(outcome.kind).toBe('allowed');
    expect(usage.toolCalls).toBe(1);
    expect(usage.committedMutations).toBe(0);
  });

  it('returns needs-approval with derived effects for a destructive tool under the default policy', async () => {
    const state = makeTwoWidgetState();
    const outcome = await executeToolWithPolicy('remove_widget', { widgetId: 'w1' }, state, {
      policy: createDefaultToolPolicy(),
      transport: 'chat',
      usage: EMPTY_USAGE(),
    });
    expect(outcome.kind).toBe('needs-approval');
    const effects = outcome.kind === 'needs-approval' ? outcome.effects : undefined;
    expect(effects?.removedWidgetIds).toEqual(['w1']);
  });

  it('returns denied with the policy reason', async () => {
    const state = makeTwoWidgetState();
    const outcome = await executeToolWithPolicy('set_dashboard_title', { title: 'X' }, state, {
      policy: () => ({ action: 'deny', reason: 'nope' }),
      transport: 'chat',
      usage: EMPTY_USAGE(),
    });
    expect(outcome).toEqual({ kind: 'denied', reason: 'nope' });
  });

  it('surfaces proposed.effects to the policy for a mutating tool', async () => {
    const state = makeTwoWidgetState();
    let seen: unknown;
    await executeToolWithPolicy('remove_widget', { widgetId: 'w2' }, state, {
      policy: (ctx) => {
        seen = ctx.proposed?.effects;
        return { action: 'allow' };
      },
      transport: 'mcp',
      usage: EMPTY_USAGE(),
    });
    expect(seen).toMatchObject({ mutationType: 'removeWidget', removedWidgetIds: ['w2'] });
  });
});

// ── Policy.all / Policy.mutationBudget ───────────────────────────────────────

/** A ctx carrying a real `proposed` mutation (removes widget w1 from a two-widget state). */
function makeProposedCtx(usage = EMPTY_USAGE()): ToolPolicyContext {
  const state = makeTwoWidgetState();
  const result = executeToolOnState('remove_widget', { widgetId: 'w1' }, state);
  return {
    transport: 'chat',
    toolName: 'remove_widget',
    input: { widgetId: 'w1' },
    state,
    proposed: {
      mutation: result.mutation!,
      nextState: result.nextState,
      effects: computeToolEffects(state, result.mutation!, result.nextState),
    },
    usage,
  };
}

/** A ctx with no proposed mutation (args-only call). */
function makeArgsOnlyCtx(usage = EMPTY_USAGE()): ToolPolicyContext {
  return {
    transport: 'chat',
    toolName: 'query_data_source',
    input: {},
    state: createDefaultStudioState(),
    proposed: undefined,
    usage,
  };
}

const ALLOW: ToolPolicy = () => ({ action: 'allow' });
const REQUIRE_APPROVAL: ToolPolicy = () => ({ action: 'require-approval' });
const DENY: ToolPolicy = () => ({ action: 'deny', reason: 'denied' });

describe('Policy.all', () => {
  it('deny beats require-approval beats allow, regardless of argument order', async () => {
    const ctx = makeArgsOnlyCtx();

    await expect(Policy.all(DENY, REQUIRE_APPROVAL, ALLOW)(ctx)).resolves.toMatchObject({
      action: 'deny',
    });
    await expect(Policy.all(ALLOW, REQUIRE_APPROVAL, DENY)(ctx)).resolves.toMatchObject({
      action: 'deny',
    });
    await expect(Policy.all(REQUIRE_APPROVAL, ALLOW)(ctx)).resolves.toMatchObject({
      action: 'require-approval',
    });
    await expect(Policy.all(ALLOW, REQUIRE_APPROVAL)(ctx)).resolves.toMatchObject({
      action: 'require-approval',
    });
    await expect(Policy.all(ALLOW, ALLOW)(ctx)).resolves.toEqual({ action: 'allow' });
  });

  it('returns allow when called with no policies', async () => {
    await expect(Policy.all()(makeArgsOnlyCtx())).resolves.toEqual({ action: 'allow' });
  });

  it('short-circuits without evaluating later policies once a deny is reached', async () => {
    const later = vi.fn(ALLOW);
    const decision = await Policy.all(DENY, later)(makeArgsOnlyCtx());
    expect(decision).toMatchObject({ action: 'deny' });
    expect(later).not.toHaveBeenCalled();
  });

  it('still evaluates later policies after a require-approval (no deny yet seen)', async () => {
    const later = vi.fn(DENY);
    const decision = await Policy.all(REQUIRE_APPROVAL, later)(makeArgsOnlyCtx());
    expect(decision).toMatchObject({ action: 'deny' });
    expect(later).toHaveBeenCalledTimes(1);
  });
});

describe('Policy.mutationBudget', () => {
  it('denies a proposed mutation once committed reaches max, allows under max', async () => {
    const budget = Policy.mutationBudget({
      max: 2,
      getCommitted: (ctx) => ctx.usage.committedMutations,
      reason: (committed, max) => `budget exceeded: ${committed}/${max}`,
    });

    const under = await budget(makeProposedCtx({ committedMutations: 1, toolCalls: 1 }));
    expect(under).toEqual({ action: 'allow' });

    const atMax = await budget(makeProposedCtx({ committedMutations: 2, toolCalls: 2 }));
    expect(atMax).toEqual({ action: 'deny', reason: 'budget exceeded: 2/2' });

    const overMax = await budget(makeProposedCtx({ committedMutations: 3, toolCalls: 3 }));
    expect(overMax).toEqual({ action: 'deny', reason: 'budget exceeded: 3/2' });
  });

  it('allows args-only (no proposed) calls even at/over the budget', async () => {
    const budget = Policy.mutationBudget({
      max: 0,
      getCommitted: (ctx) => ctx.usage.committedMutations,
      reason: () => 'should not fire',
    });
    const decision = await budget(makeArgsOnlyCtx({ committedMutations: 5, toolCalls: 5 }));
    expect(decision).toEqual({ action: 'allow' });
  });

  it('always allows when max is undefined (no cap)', async () => {
    const budget = Policy.mutationBudget({
      max: undefined,
      getCommitted: (ctx) => ctx.usage.committedMutations,
      reason: () => 'should not fire',
    });
    const decision = await budget(makeProposedCtx({ committedMutations: 1000, toolCalls: 1000 }));
    expect(decision).toEqual({ action: 'allow' });
  });

  it('fires onExceeded exactly once across multiple over-budget calls', async () => {
    const onExceeded = vi.fn();
    const budget = Policy.mutationBudget({
      max: 1,
      getCommitted: (ctx) => ctx.usage.committedMutations,
      onExceeded,
      reason: () => 'exceeded',
    });

    await budget(makeProposedCtx({ committedMutations: 1, toolCalls: 1 }));
    await budget(makeProposedCtx({ committedMutations: 2, toolCalls: 2 }));
    await budget(makeProposedCtx({ committedMutations: 3, toolCalls: 3 }));

    expect(onExceeded).toHaveBeenCalledTimes(1);
  });

  it('reads getCommitted fresh on every call, reflecting a live caller-owned counter', async () => {
    const usage = { committedMutations: 0, toolCalls: 0 };
    const budget = Policy.mutationBudget({
      max: 2,
      getCommitted: () => usage.committedMutations,
      reason: (committed, max) => `${committed}/${max}`,
    });

    const ctx = makeProposedCtx(usage);

    expect(await budget(ctx)).toEqual({ action: 'allow' });
    usage.committedMutations = 2;
    expect(await budget(ctx)).toEqual({ action: 'deny', reason: '2/2' });
  });
});
