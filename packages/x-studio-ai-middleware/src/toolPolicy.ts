/**
 * `ToolPolicy` — the single authorization chokepoint for state-mutating tool
 * calls on BOTH transports (chat agentic loop and MCP server).
 *
 * Every built-in mutating tool call is run through `executeToolWithPolicy`, which
 * performs the existing pure `executeToolOnState` dry-run, diffs the resulting
 * `nextState` against the pre-execution `state` to derive a structural
 * `ToolEffectSummary`, and hands both the args and the derived effects to a
 * host-supplied `ToolPolicy` before the caller commits anything. The policy can
 * `allow`, `deny`, or `require-approval`.
 *
 * PURITY INVARIANT — this design depends on it and silently breaks without it:
 *
 *   The "execute-then-gate" (`proposed` present) path is only safe because
 *   `executeToolOnState` is a PURE function: it builds a `StateMutation` and
 *   computes `nextState = applyMutation(state, mutation)` WITHOUT performing any
 *   I/O or mutating shared state. The actual commit (writing the state box,
 *   emitting `state-mutation`, notifying resources, persisting) happens later, at
 *   the CALLER's commit point, only after the policy has allowed/approved it.
 *
 *   Any new `executeToolOnState` case — or any skill-like branch — that performs
 *   a side effect DURING execution rather than at the caller's commit point
 *   defeats this entire chokepoint: the "dry run" will have already fired the
 *   effect before the policy ever runs, so a `deny` cannot undo it. Side-effectful
 *   tools (server-tool skills, `execute_query` and other resolver-backed tools)
 *   must therefore go through the ARGS-ONLY policy path (`proposed: undefined`) —
 *   the policy is consulted BEFORE they execute — and must never masquerade as a
 *   dry-run through `executeToolWithPolicy`.
 */
import type { StudioState, StudioCustomWidgetDef } from './models/studioTypes';
import type { StateMutation } from './models/aiTypes';
import { executeToolOnState, type ToolExecutionResult } from './executeToolOnState';
import { DESTRUCTIVE_TOOLS } from './studioAITools';

/** Structural effects of a proposed mutation, derived by diffing prevState vs nextState. */
export interface ToolEffectSummary {
  mutationType: StateMutation['type'];
  removedWidgetIds: string[];
  removedPageIds: string[];
  removedFilterIds: string[];
  /** Widgets still in state.widgets but referenced by NO page's widgetRows after
   *  apply, while they WERE referenced before — the set_widget_layout orphan case. */
  orphanedWidgetIds: string[];
  addedWidgetIds: string[];
  addedPageIds: string[];
  updatedWidgetIds: string[];
  layoutChangedPageIds: string[];
}

export interface ToolPolicyContext {
  transport: 'chat' | 'mcp';
  toolName: string;
  input: unknown;
  state: StudioState; // pre-execution state
  /** Present for built-in mutating tools (execute-then-gate). Absent for server-tool
   *  skills, execute_query, and read-only tools — args-only judgment for those. */
  proposed?: {
    mutation: StateMutation;
    nextState: StudioState;
    effects: ToolEffectSummary;
  };
  usage: { committedMutations: number; toolCalls: number };
}

export type ToolPolicyDecision =
  | { action: 'allow' }
  | { action: 'deny'; reason: string }
  | { action: 'require-approval'; reason?: string };

export type ToolPolicy = (
  ctx: ToolPolicyContext,
) => ToolPolicyDecision | Promise<ToolPolicyDecision>;

// ── Effect diffing ────────────────────────────────────────────────────────────

/** Collect every widget id referenced by any page's `widgetRows` in a state. */
function collectReferencedWidgetIds(state: StudioState): Set<string> {
  const ids = new Set<string>();
  for (const page of Object.values(state.doc.pages)) {
    for (const row of page.widgetRows ?? []) {
      for (const id of row) {
        ids.add(id);
      }
    }
  }
  return ids;
}

/** Deep-equal check for two `widgetRows` layouts (array of id-arrays). */
function widgetRowsEqual(a: string[][] | undefined, b: string[][] | undefined): boolean {
  const aa = a ?? [];
  const bb = b ?? [];
  if (aa.length !== bb.length) {
    return false;
  }
  for (let i = 0; i < aa.length; i += 1) {
    const rowA = aa[i];
    const rowB = bb[i];
    if (rowA.length !== rowB.length) {
      return false;
    }
    for (let j = 0; j < rowA.length; j += 1) {
      if (rowA[j] !== rowB[j]) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Pure structural diff of `prev` vs `next` for a single mutation. Derives every
 * field purely from the actual before/after state objects — it re-encodes NO
 * tool-specific logic (e.g. it does not special-case `apply_bulk_update`'s
 * cross-page-reference preservation; it just observes the real reducer output).
 *
 * `updatedWidgetIds` / `layoutChangedPageIds` rely on `applyMutation`'s immutable
 * update discipline: an unchanged widget/page keeps its object reference, so a
 * reference change marks a genuine update.
 */
export function computeToolEffects(
  prev: StudioState,
  mutation: StateMutation,
  next: StudioState,
): ToolEffectSummary {
  const prevWidgetIds = Object.keys(prev.doc.widgets);
  const nextWidgetIds = Object.keys(next.doc.widgets);
  const nextWidgetIdSet = new Set(nextWidgetIds);
  const prevWidgetIdSet = new Set(prevWidgetIds);

  const prevPageIds = Object.keys(prev.doc.pages);
  const nextPageIds = Object.keys(next.doc.pages);
  const nextPageIdSet = new Set(nextPageIds);
  const prevPageIdSet = new Set(prevPageIds);

  const prevFilterIds = new Set((prev.doc.filters ?? []).map((f) => f.id));
  const nextFilterIds = new Set((next.doc.filters ?? []).map((f) => f.id));

  const removedWidgetIds = prevWidgetIds.filter((id) => !nextWidgetIdSet.has(id));
  const addedWidgetIds = nextWidgetIds.filter((id) => !prevWidgetIdSet.has(id));
  const removedPageIds = prevPageIds.filter((id) => !nextPageIdSet.has(id));
  const addedPageIds = nextPageIds.filter((id) => !prevPageIdSet.has(id));
  const removedFilterIds = [...prevFilterIds].filter((id) => !nextFilterIds.has(id));

  const prevReferenced = collectReferencedWidgetIds(prev);
  const nextReferenced = collectReferencedWidgetIds(next);
  // Orphaned: still in next.widgets, referenced by no page in next, but WAS
  // referenced by some page in prev.
  const orphanedWidgetIds = nextWidgetIds.filter(
    (id) => !nextReferenced.has(id) && prevReferenced.has(id),
  );

  // Updated: present in both, but the widget object identity changed (immutable
  // reducer → a new object means a real change).
  const updatedWidgetIds = nextWidgetIds.filter(
    (id) => prevWidgetIdSet.has(id) && prev.doc.widgets[id] !== next.doc.widgets[id],
  );

  // Layout changed: page present in both, but its `widgetRows` differs.
  const layoutChangedPageIds = nextPageIds.filter(
    (id) =>
      prevPageIdSet.has(id) &&
      !widgetRowsEqual(prev.doc.pages[id]?.widgetRows, next.doc.pages[id]?.widgetRows),
  );

  return {
    mutationType: mutation.type,
    removedWidgetIds,
    removedPageIds,
    removedFilterIds,
    orphanedWidgetIds,
    addedWidgetIds,
    addedPageIds,
    updatedWidgetIds,
    layoutChangedPageIds,
  };
}

// ── Built-in policies ───────────────────────────────────────────────────────

/**
 * The default policy: `require-approval` iff `ctx.toolName` is in `approvalTools`
 * (defaulting to `DESTRUCTIVE_TOOLS`), else `allow`. Reproduces the chat loop's
 * historical `TOOLS_REQUIRING_APPROVAL` behavior byte-for-byte.
 */
export function createDefaultToolPolicy(
  approvalTools: ReadonlySet<string> = DESTRUCTIVE_TOOLS,
): ToolPolicy {
  return (ctx) =>
    approvalTools.has(ctx.toolName) ? { action: 'require-approval' } : { action: 'allow' };
}

/**
 * An independent effects-only policy: `require-approval` when the proposed
 * mutation removes any widget/page/filter or orphans a widget, regardless of tool
 * name; otherwise `allow`. An optional `updatedWidgetThreshold` also triggers
 * approval when more than that many widgets are updated by a single call.
 *
 * This deliberately does NOT wrap `createDefaultToolPolicy` — keeping it clean and
 * independent lets callers compose the two if they want (e.g. approve when EITHER
 * says so).
 */
export function createEffectsAwareToolPolicy(options?: {
  updatedWidgetThreshold?: number;
}): ToolPolicy {
  const threshold = options?.updatedWidgetThreshold;
  return (ctx) => {
    const effects = ctx.proposed?.effects;
    if (!effects) {
      return { action: 'allow' };
    }
    if (
      effects.removedWidgetIds.length > 0 ||
      effects.removedPageIds.length > 0 ||
      effects.removedFilterIds.length > 0 ||
      effects.orphanedWidgetIds.length > 0
    ) {
      return { action: 'require-approval' };
    }
    if (threshold !== undefined && effects.updatedWidgetIds.length > threshold) {
      return { action: 'require-approval' };
    }
    return { action: 'allow' };
  };
}

// ── Composable policy combinators ────────────────────────────────────────────

/**
 * A small combinator library for building up a `ToolPolicy` from independent
 * concerns (a mutation-rate budget, a host's own approval rules, …) without each
 * concern needing to know about the others.
 */
export const Policy = {
  /**
   * Evaluates `policies` in order; the strictest decision wins (deny >
   * require-approval > allow), short-circuiting on the first `deny` — once a
   * `deny` is seen, no later policy can soften it, so evaluation stops there.
   * With no `deny`, all policies still run so a later `require-approval` is not
   * missed; the first `require-approval` decision wins over `allow`, and
   * `allow` is returned only if every policy allows.
   *
   * This lets a budget check run BEFORE a host's own policy: `Policy.all(budget,
   * hostPolicy)` denies once the budget is exhausted without the host policy ever
   * being consulted, while still deferring to the host policy's own
   * deny/require-approval/allow when the budget isn't exhausted.
   */
  all(...policies: ToolPolicy[]): ToolPolicy {
    return async (ctx) => {
      let strictest: ToolPolicyDecision = { action: 'allow' };
      for (const policy of policies) {
        // eslint-disable-next-line no-await-in-loop -- sequential evaluation so a deny short-circuits before later policies run
        const decision = await policy(ctx);
        if (decision.action === 'deny') {
          return decision;
        }
        if (decision.action === 'require-approval' && strictest.action === 'allow') {
          strictest = decision;
        }
      }
      return strictest;
    };
  },

  /**
   * A mutation-rate budget as a composable policy. Denies any call carrying a
   * `proposed` mutation once `getCommitted(ctx) >= max`, reading the committed
   * count via a caller-supplied accessor so both transports can plug in their own
   * usage-tracking shape (chat's `ctx.usage.committedMutations`, MCP's
   * session-scoped counter) without this function needing to know which shape it
   * is. `onExceeded` fires exactly once per breach (an internal latch), not once
   * per subsequent denied call. `max: undefined` means no cap — every call is
   * allowed through to whatever policy runs next.
   */
  mutationBudget(opts: {
    max: number | undefined;
    getCommitted: (ctx: ToolPolicyContext) => number;
    onExceeded?: () => void;
    reason: (committed: number, max: number) => string;
  }): ToolPolicy {
    const { max, getCommitted, onExceeded, reason } = opts;
    let exceededFired = false;
    return (ctx) => {
      const committed = getCommitted(ctx);
      if (ctx.proposed && max !== undefined && committed >= max) {
        if (!exceededFired) {
          exceededFired = true;
          onExceeded?.();
        }
        return { action: 'deny', reason: reason(committed, max) };
      }
      return { action: 'allow' };
    };
  },

  /** Re-expression of `createDefaultToolPolicy` as a named combinator-library member. */
  approveDestructive(tools?: ReadonlySet<string>): ToolPolicy {
    return createDefaultToolPolicy(tools);
  },
};

// ── The chokepoint ────────────────────────────────────────────────────────────

/** Discriminated outcome of running a built-in tool through the policy. */
export type ExecuteToolWithPolicyResult =
  | { kind: 'allowed'; result: ToolExecutionResult }
  | { kind: 'denied'; reason: string }
  | { kind: 'needs-approval'; result: ToolExecutionResult; effects: ToolEffectSummary };

/**
 * The single execute-then-gate chokepoint for built-in tools. Calls
 * `executeToolOnState` exactly once (the existing pure dry-run), derives
 * `effects` via `computeToolEffects` when the tool produced a mutation, builds the
 * `ToolPolicyContext`, awaits the policy, and returns a discriminated result.
 *
 * `opts.usage.toolCalls` is incremented UNCONDITIONALLY. `opts.usage.committedMutations`
 * is NOT touched here: a `needs-approval` outcome might still be denied later, so the
 * CALLER must increment `committedMutations` only once it actually commits the
 * mutation (on `allowed`, or on `needs-approval` after approval is granted).
 */
export async function executeToolWithPolicy(
  toolName: string,
  input: unknown,
  state: StudioState,
  opts: {
    policy: ToolPolicy;
    customWidgets?: StudioCustomWidgetDef[];
    pageSnapshot?: string;
    transport: 'chat' | 'mcp';
    usage: { committedMutations: number; toolCalls: number };
  },
): Promise<ExecuteToolWithPolicyResult> {
  opts.usage.toolCalls += 1;

  const result = executeToolOnState(toolName, input, state, opts.customWidgets, opts.pageSnapshot);

  const effects = result.mutation
    ? computeToolEffects(state, result.mutation, result.nextState)
    : undefined;

  const ctx: ToolPolicyContext = {
    transport: opts.transport,
    toolName,
    input,
    state,
    proposed:
      result.mutation && effects
        ? { mutation: result.mutation, nextState: result.nextState, effects }
        : undefined,
    usage: opts.usage,
  };

  const decision = await opts.policy(ctx);

  if (decision.action === 'deny') {
    return { kind: 'denied', reason: decision.reason };
  }
  if (decision.action === 'require-approval') {
    return {
      kind: 'needs-approval',
      result,
      // A require-approval on a mutation always has effects; a policy that requires
      // approval on a non-mutating call gets an all-empty summary rather than crashing.
      effects: effects ?? {
        mutationType: (result.mutation?.type ?? 'setDashboardTitle') as StateMutation['type'],
        removedWidgetIds: [],
        removedPageIds: [],
        removedFilterIds: [],
        orphanedWidgetIds: [],
        addedWidgetIds: [],
        addedPageIds: [],
        updatedWidgetIds: [],
        layoutChangedPageIds: [],
      },
    };
  }
  return { kind: 'allowed', result };
}
