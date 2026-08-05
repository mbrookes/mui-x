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
 *   tools (server-tool skills, `query_data_source` and other data-config-backed
 *   tools) must therefore go through the ARGS-ONLY policy path (`proposed: undefined`) —
 *   the policy is consulted BEFORE they execute — and must never masquerade as a
 *   dry-run through `executeToolWithPolicy`.
 */
import type { StudioState, StudioCustomWidgetDef } from './models/studioTypes';
import type { StateMutation } from './models/aiTypes';
import { executeToolOnState, type ToolExecutionResult } from './executeToolOnState';
import { DESTRUCTIVE_TOOLS } from './studioAITools';

/** Structural effects of a proposed mutation, derived by diffing prevState vs nextState. */
export interface ToolEffectSummary {
  /**
   * Absent when there is no actual proposed mutation to report a type for — e.g. a
   * `require-approval` decision on a non-mutating (read-only) built-in tool call,
   * which has no `StateMutation` at all. Never fabricate an unrelated real mutation
   * type as a placeholder here (see `executeToolWithPolicy`'s fallback).
   */
  mutationType?: StateMutation['type'];
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
   *  skills, query_data_source, and read-only tools — args-only judgment for those. */
  proposed?: {
    mutation: StateMutation;
    nextState: StudioState;
    effects: ToolEffectSummary;
  };
  /**
   * Discriminates the two consult shapes that both present `proposed: undefined`:
   *
   *  - `'pre-check'` — the cheap consult `executeToolWithPolicy` makes BEFORE the
   *    expensive pure dry-run of a built-in tool, and ONLY when the caller supplied
   *    an explicit `preCheckPolicy` (see that option). A host policy passed as
   *    `opts.policy` is NEVER consulted in this phase: it is consulted exactly once
   *    per call, in `'final'`. A policy that DOES receive this phase is one the
   *    caller nominated as budget-style — decidable from the tool name and the usage
   *    counters alone, without knowing whether this call proposes a mutation.
   *  - `'final'` — the consult whose decision is actually acted on: either the real
   *    execute-then-gate consult (`proposed` set when the tool mutates) or a genuine
   *    args-only consult via `consultToolPolicyArgsOnly` (`proposed: undefined`
   *    because the tool is inherently side-effectful and must be authorized before
   *    it runs, e.g. `query_data_source`, server-tool skills).
   *
   * So a host policy that keys `deny` off `!ctx.proposed` (a plausible "deny all
   * side-effectful calls" catch-all) sees only genuine args-only consults, and can
   * never be tripped by the pre-check optimization.
   */
  phase: 'pre-check' | 'final';
  /**
   * Hint that this ARGS-ONLY call (`proposed: undefined`) is capable of committing a
   * mutation once it runs. `true` for server-tool skills — any skill's `execute` may
   * return a mutation, and the args alone can't tell us, so we conservatively treat
   * every skill as mutating-capable. `false`/omitted for genuinely read-only
   * side-effectful calls (`query_data_source`, the MCP read-only data tools). This
   * lets `Policy.mutationBudget` gate a skill mutation exactly like a built-in one —
   * safe because the skill is authorized BEFORE it runs (pre-execution), honoring the
   * purity invariant above (we can't drop a mutation post-execution once its side
   * effects have already fired).
   */
  mayMutate?: boolean;
  usage: { committedMutations: number; toolCalls: number };
}

export type ToolPolicyDecision =
  | { action: 'allow' }
  | { action: 'deny'; reason: string }
  | { action: 'require-approval'; reason?: string };

/**
 * The host-supplied authorization decision function.
 *
 * INVOCATION CONTRACT — a policy passed as `executeToolWithPolicy`/
 * `consultToolPolicyArgsOnly`'s `opts.policy` is consulted EXACTLY ONCE per tool
 * call, always with `phase: 'final'`. It therefore does not need to be idempotent:
 * a policy that audits, meters against an external rate limiter, or writes an
 * access-log row can do that work inline without double-counting. The separate
 * `preCheckPolicy` hook (see `executeToolWithPolicy`) is the only thing consulted
 * twice, and it is caller-supplied rather than host-supplied precisely so this
 * contract holds.
 *
 * DEADLINE CONTRACT — the consult is bounded by {@link TOOL_POLICY_TIMEOUT_MS}
 * (overridable per call via {@link ToolPolicyConsultBounds.policyTimeoutMs}) and, when
 * the transport supplies one, by the request's abort signal. Blowing either DENIES the
 * call: this is an authorization decision, so it fails CLOSED, the opposite of the
 * best-effort `onStateChange` persistence hook. A policy that legitimately needs to
 * consult a slow external authority must do its own caching or raise the bound — it
 * must not simply block.
 *
 * @param {ToolPolicyContext} ctx - The tool call being authorized, including its proposed
 *   effects when they are known at consult time.
 * @returns {ToolPolicyDecision | Promise<ToolPolicyDecision>} The authorization decision,
 *   resolved synchronously or asynchronously.
 */
export type ToolPolicy = (
  ctx: ToolPolicyContext,
) => ToolPolicyDecision | Promise<ToolPolicyDecision>;

// ── Bounding the host policy ──────────────────────────────────────────────────

/**
 * Default deadline (ms) on the host's `ToolPolicy`.
 *
 * `toolPolicy` is the ONLY host callback consulted on every `tools/call`,
 * `resources/read` and `prompts/get`, and it was the one host callback in this
 * package still awaited with no bound at all — while `approvalHandler`
 * (`approvalTimeoutMs`), `contextEnricher` (`CONTEXT_ENRICHER_TIMEOUT_MS`),
 * `onStateChange` (`persistTimeoutMs`) and every `queryDataSource` (`withTimeout`)
 * were each closed in turn for the same reason. A policy that never settles is not
 * hypothetical: `await fetch(authzService)` against a blackholed TCP connection, or
 * a rules-table query with no client-side statement timeout, both produce it.
 *
 * The consequence is worse here than for any of the siblings. On MCP the consult in
 * the mutating `tools/call` branch runs INSIDE the per-session `mutationChain`
 * critical section, so one unsettled policy call wedges every subsequent mutating
 * call for the lifetime of that session — one call is enough. On chat the same await
 * hangs the SSE stream: `consultToolPolicyArgsOnlyGuarded` converts a policy THROW
 * into a redacted deny, but nothing converted a HANG.
 *
 * 15s matches `CONTEXT_ENRICHER_TIMEOUT_MS`, `DEFAULT_PERSIST_TIMEOUT_MS` and the
 * `queryDataSource` bound — an authorization decision that needs longer than a live
 * analytical query is a broken policy, not a slow one.
 */
export const TOOL_POLICY_TIMEOUT_MS = 15_000;

/**
 * Per-call bounds on the host `ToolPolicy` consult, accepted by both chokepoints.
 *
 * Kept as a separate interface (intersected into each function's `opts`) so the two
 * entry points cannot drift, and so a transport that gains a cancellation channel
 * later only has to start passing `signal`.
 */
export interface ToolPolicyConsultBounds {
  /**
   * Deadline (ms) on the host policy for THIS consult. On expiry the call is DENIED
   * — see {@link TOOL_POLICY_TIMEOUT_MS} for why this one fails closed while the
   * persistence hook's deadline fails open.
   * @default TOOL_POLICY_TIMEOUT_MS
   */
  policyTimeoutMs?: number;
  /**
   * Cancellation signal for the request this consult belongs to (MCP's per-request
   * `RequestHandlerExtra.signal`, or the chat transport's request signal). Consulted
   * so an abandoned request stops waiting on the policy immediately instead of
   * holding the consult — and, on MCP's mutating branch, the mutation queue behind
   * it — until the deadline elapses. An abort denies, for the same fail-closed
   * reason a deadline does: no decision was ever returned.
   */
  signal?: AbortSignal;
}

/** Race sentinels — distinguishing which arm won without any error-identity check. */
const POLICY_TIMED_OUT = Symbol('toolPolicy-timeout');
const POLICY_ABORTED = Symbol('toolPolicy-abort');

/** Deny reason for a policy that blew its deadline. Server-authored: nothing untrusted in it. */
function policyDeadlineReason(timeoutMs: number): string {
  return (
    `MUI X Studio: The host toolPolicy did not return an authorization decision within ${timeoutMs}ms, ` +
    'so this tool call was DENIED. An authorization decision fails CLOSED on its deadline — unlike ' +
    'the best-effort persistence hook, a call that has not been authorized must not run — and on MCP ' +
    "this consult holds the session's mutation queue, so waiting indefinitely would wedge every " +
    'subsequent mutating call. Check the toolPolicy implementation for an unbounded await (an ' +
    'authorization-service request or a database query with no client-side timeout).'
  );
}

/** Deny reason for a consult cut short by the request's abort signal. */
const POLICY_ABORTED_REASON =
  'MUI X Studio: The request was aborted while the host toolPolicy was still deciding, so this tool ' +
  'call was denied without running. No authorization was ever granted, so it must not proceed.';

/**
 * Render a rejected `decision.action` for the deny reason below WITHOUT letting host
 * (or, transitively, request-derived) content into a message that reaches a model and
 * an operator log. Only a short, plainly-identifier-shaped string is echoed back; every
 * other value is described by type alone.
 */
function describeRejectedAction(action: unknown): string {
  if (typeof action === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(action)) {
    return `"${action}"`;
  }
  return `a value of type ${typeof action}`;
}

/**
 * Deny reason for a decision whose `action` is none of the three documented values.
 * Server-authored: the only interpolation is filtered by {@link describeRejectedAction}.
 */
function unrecognizedDecisionReason(action: unknown): string {
  return (
    `MUI X Studio: The host toolPolicy returned ${describeRejectedAction(action)} as its ` +
    "decision `action`, which is not one of 'allow', 'deny' or 'require-approval', so this tool " +
    'call was DENIED. An unrecognized decision is treated as a deny for the same fail-CLOSED reason ' +
    'a deadline is: the call was never actually authorized, and interpreting an unknown action as ' +
    'permission would silently grant exactly what the policy was written to block. Check the ' +
    'toolPolicy implementation for a misspelled or miscapitalized action (e.g. `Deny`, `denied`) or ' +
    'a code path that returns no `action` at all.'
  );
}

/**
 * Coerce a host-returned decision to one this package's three consumers can safely
 * branch on.
 *
 * Every consumer of a decision tests only the two NEGATIVE cases (`deny`,
 * `require-approval`) and falls through to allow, because those are the only two that
 * need handling. That makes `allow` the behavior for any value that is not literally
 * one of the other two — so `{ action: 'Deny' }`, `{ action: 'denied' }` or `{}` from a
 * host policy authorized every call the policy existed to block. (A policy returning
 * `undefined`/`null` already failed closed, by throwing into the call sites' catches,
 * which is what made the well-shaped-but-unrecognized case easy to miss.)
 *
 * Normalizing HERE, once, rather than adding a positive `=== 'allow'` test at each
 * consumer, keeps the fail-closed judgement in one place — a consumer added later
 * inherits it instead of having to remember it, exactly as with the deadline bound.
 *
 * A nullish return is deliberately passed through untouched rather than normalized:
 * it already fails closed by throwing at the consumer's `decision.action` read, and
 * that throw is what routes the host's detail to `onToolError`/`logger` — the same
 * reason a policy THROW is not converted here either.
 */
function normalizePolicyDecision(decision: ToolPolicyDecision): ToolPolicyDecision {
  if (decision === null || decision === undefined) {
    return decision;
  }
  const action: unknown = (decision as { action?: unknown }).action;
  if (action === 'allow' || action === 'deny' || action === 'require-approval') {
    return decision;
  }
  return { action: 'deny', reason: unrecognizedDecisionReason(action) };
}

/**
 * Await the host policy under a deadline and (when supplied) the request's abort
 * signal, mapping either to a fail-CLOSED `deny` rather than an unbounded wait.
 *
 * Wrapping HERE rather than at each of the seven call sites is deliberate: this is
 * the single point both chokepoints funnel through, so a transport added later
 * inherits the bound instead of having to remember it.
 *
 * A policy THROW is deliberately NOT converted here. Every call site already has its
 * own redaction wiring for that (chat's `consultToolPolicyArgsOnlyGuarded` /
 * `executeToolWithPolicy` catch route the detail to `onToolError`; MCP's catches
 * route it to `logger`), and swallowing the rejection in this module — which has no
 * logger — would discard the server-side detail those sites exist to preserve. Only
 * the two outcomes nobody else can observe (the deadline, the abort) are handled.
 */
async function consultPolicyBounded(
  policy: ToolPolicy,
  ctx: ToolPolicyContext,
  bounds: ToolPolicyConsultBounds,
): Promise<ToolPolicyDecision> {
  const timeoutMs = bounds.policyTimeoutMs ?? TOOL_POLICY_TIMEOUT_MS;
  const { signal } = bounds;

  if (signal?.aborted) {
    // Already abandoned — don't invoke the host at all.
    return { action: 'deny', reason: POLICY_ABORTED_REASON };
  }

  const decisionPromise = Promise.resolve(policy(ctx));
  // A `Promise.race` forwards only the WINNING promise's rejection, so a policy that
  // rejects AFTER the deadline fired would otherwise be an unobserved rejection (an
  // `unhandledRejection` crash under Node's default). This second, independent
  // subscription swallows that case without affecting what the race below settles
  // with — the same pattern `mcp.ts`'s `bridgeApproval` uses for `approvalPromise`.
  decisionPromise.catch(() => {});

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let outcome: ToolPolicyDecision | typeof POLICY_TIMED_OUT | typeof POLICY_ABORTED;
  try {
    outcome = await Promise.race([
      decisionPromise,
      new Promise<typeof POLICY_TIMED_OUT>((resolve) => {
        timeoutId = setTimeout(() => resolve(POLICY_TIMED_OUT), timeoutMs);
      }),
      ...(signal
        ? [
            new Promise<typeof POLICY_ABORTED>((resolve) => {
              onAbort = () => resolve(POLICY_ABORTED);
              signal.addEventListener('abort', onAbort, { once: true });
            }),
          ]
        : []),
    ]);
  } finally {
    // Always tear both losers down: a fast-deciding policy must not leave a pending
    // timer holding the event loop open, nor an abort listener pinned to a signal
    // that outlives this consult (an MCP session signal outlives every call on it).
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    if (signal && onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
  }

  if (outcome === POLICY_TIMED_OUT) {
    return { action: 'deny', reason: policyDeadlineReason(timeoutMs) };
  }
  if (outcome === POLICY_ABORTED) {
    return { action: 'deny', reason: POLICY_ABORTED_REASON };
  }
  // An `action` outside the documented three is denied HERE, once, rather
  // than reaching three consumers that each only test the negative cases and so would
  // each read it as an allow. See `normalizePolicyDecision`.
  return normalizePolicyDecision(outcome);
}

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
 * (defaulting to `DESTRUCTIVE_TOOLS`), reproducing the chat loop's historical
 * `TOOLS_REQUIRING_APPROVAL` behavior byte-for-byte — COMPOSED with the
 * effects-aware orphan/removal check (`createEffectsAwareToolPolicy()`) so a tool
 * that isn't itself classified `destructive` (e.g. `set_widget_layout`, which is
 * merely `idempotent`) still requires approval when its ACTUAL structural effect
 * removes or orphans a widget/page/filter. Without this composition, a
 * non-destructive-named tool could drop a widget from every page's layout with
 * zero approval, silently orphaning it.
 */
export function createDefaultToolPolicy(
  approvalTools: ReadonlySet<string> = DESTRUCTIVE_TOOLS,
): ToolPolicy {
  // Composed by hand (rather than via `Policy.all`, which is declared further down
  // this file and would trip `no-use-before-define`) — equivalent to
  // `Policy.all(nameCheck, effectsAware)` since `createEffectsAwareToolPolicy` never
  // returns `deny`, so evaluation order can't change the outcome.
  const effectsAware = createEffectsAwareToolPolicy();
  return async (ctx) => {
    if (approvalTools.has(ctx.toolName)) {
      return { action: 'require-approval' };
    }
    return effectsAware(ctx);
  };
}

/**
 * An independent effects-only policy: `require-approval` when the proposed
 * mutation removes any widget/page/filter or orphans a widget, regardless of tool
 * name; otherwise `allow`. An optional `updatedWidgetThreshold` also triggers
 * approval when more than that many widgets are updated by a single call.
 *
 * This deliberately does NOT wrap `createDefaultToolPolicy` — keeping it clean and
 * independent lets callers compose the two (e.g. approve when EITHER says so).
 * `createDefaultToolPolicy` itself now composes this policy in (via `Policy.all`)
 * so the default gating catches structural orphan/removal effects even for tools
 * not classified `destructive`; call this standalone only if you want the
 * effects-only half in isolation (e.g. inside a fully custom policy).
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
 * Wraps `fn` so it fires at most once, no matter how many times the returned
 * function is called. Shared by `mutationBudget` and `toolCallBudget` below,
 * which are otherwise different policies (different comparison operator,
 * different trigger condition) that both independently need an `onExceeded`
 * callback to fire exactly once per breach rather than once per subsequent
 * denied call.
 */
function onceLatch(fn?: () => void): () => void {
  let fired = false;
  return () => {
    if (!fired) {
      fired = true;
      fn?.();
    }
  };
}

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
        // Composed policies are invoked directly rather than through
        // `consultPolicyBounded` (the composite itself is what gets bounded, once, by
        // the caller), so the same fail-closed normalization has to be applied to each
        // member here. Without it an inner policy's `{ action: 'Deny' }` would neither
        // short-circuit nor raise `strictest`, and `all` would return `allow`.
        // eslint-disable-next-line no-await-in-loop -- sequential evaluation so a deny short-circuits before later policies run
        const decision = normalizePolicyDecision(await policy(ctx));
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
   * A mutation-rate budget as a composable policy. Denies any call that either
   * carries a `proposed` mutation (built-in execute-then-gate path) OR is flagged
   * `mayMutate` (an args-only server-tool skill that could commit a mutation once it
   * runs) once `getCommitted(ctx) >= max`, reading the committed
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
    const fireExceeded = onceLatch(onExceeded);
    return (ctx) => {
      const committed = getCommitted(ctx);
      if ((ctx.proposed || ctx.mayMutate) && max !== undefined && committed >= max) {
        fireExceeded();
        return { action: 'deny', reason: reason(committed, max) };
      }
      return { action: 'allow' };
    };
  },

  /**
   * A total-tool-call budget as a composable policy. Unlike `mutationBudget`, this
   * applies to EVERY tool call — mutating or read-only — so a turn that dispatches
   * an unbounded number of calls (e.g. hundreds of `query_data_source` live DB
   * queries) is bounded too, not just ones that commit a mutation.
   *
   * Both `executeToolWithPolicy` and `consultToolPolicyArgsOnly` increment
   * `usage.toolCalls` BEFORE consulting the policy, so by the time this runs,
   * `getCalls(ctx)` already includes the call currently being gated — hence `>`,
   * not `>=` (the `mutationBudget` counter, by contrast, is only bumped on an
   * actual commit, which happens AFTER the policy allows, so it compares `>=`).
   * `onExceeded` fires exactly once per breach (an internal latch). `max: undefined`
   * means no cap — every call is allowed through to whatever policy runs next.
   */
  toolCallBudget(opts: {
    max: number | undefined;
    getCalls: (ctx: ToolPolicyContext) => number;
    onExceeded?: () => void;
    reason: (calls: number, max: number) => string;
  }): ToolPolicy {
    const { max, getCalls, onExceeded, reason } = opts;
    const fireExceeded = onceLatch(onExceeded);
    return (ctx) => {
      const calls = getCalls(ctx);
      if (max !== undefined && calls > max) {
        fireExceeded();
        return { action: 'deny', reason: reason(calls, max) };
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
  | {
      kind: 'needs-approval';
      result: ToolExecutionResult;
      effects: ToolEffectSummary;
      /**
       * The POLICY's own stated reason for requiring approval (from
       * `ToolPolicyDecision`'s `{ action: 'require-approval', reason }` — e.g. "this
       * exceeds today's mutation budget"), when the policy supplied one. Tier 3,
       * This used to be silently dropped here — the policy computed it,
       * but no caller ever read `decision.reason` on the require-approval branch — so
       * neither the human-facing approval prompt nor (on an auto-denied fallback, e.g.
       * no `approvalPending` channel configured) the message relayed back to the LLM
       * could ever explain WHY approval was needed. Threaded through so
       * `agenticLoop/toolDispatch.ts`'s `runApprovalFlow` can surface it on both paths.
       */
      reason?: string;
    };

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
    /**
     * OPTIONAL budget-only policy consulted BEFORE the pure dry-run, purely as a cost
     * optimization: `executeToolOnState` can be arbitrarily expensive for built-in read
     * tools that project/stringify the whole state (e.g. `get_dashboard_state`), and a
     * call a budget is going to reject anyway gets none of that value back. Only a
     * `deny` is acted on (short-circuiting the dry-run); `allow`/`require-approval` fall
     * through to the unchanged path below, since only the real dry-run can supply the
     * `result`/`effects` those outcomes must carry.
     *
     * MUST be decidable from the tool name and the usage counters alone — it is called
     * with `proposed: undefined` and `phase: 'pre-check'` on a call that may well turn
     * out to be mutating, so a policy that keys `deny` off `!ctx.proposed` would deny
     * every built-in tool, including read-only ones, before the dry-run ever ran. It is
     * also called IN ADDITION to `opts.policy`'s single `'final'` consult, so it must be
     * idempotent (no auditing, no external metering).
     *
     * `opts.policy` — the host's own policy, composed or not — must therefore never be
     * passed here. Callers build the budget chain (`Policy.mutationBudget` /
     * `Policy.toolCallBudget`, which satisfy both requirements) separately and pass that.
     * Omit it entirely to skip the pre-check: the only cost is the wasted dry-run on a
     * call the budgets would have rejected.
     */
    preCheckPolicy?: ToolPolicy;
    customWidgets?: StudioCustomWidgetDef[];
    pageSnapshot?: string;
    /** Page the `pageSnapshot` covers (request-time active page) — see `ToolPlanContext`. */
    snapshotPageId?: string;
    /**
     * Whether the request runs under `privateMode` — see `ToolPlanContext.privateMode`.
     * Forwarded so a still-advertised WRITE tool's rejection states the
     * constraint rather than the withheld state that violates it.
     */
    privateMode?: boolean;
    transport: 'chat' | 'mcp';
    usage: { committedMutations: number; toolCalls: number };
  } & ToolPolicyConsultBounds,
): Promise<ExecuteToolWithPolicyResult> {
  opts.usage.toolCalls += 1;

  // Cheap budget-only pre-check BEFORE the pure dry-run — see `opts.preCheckPolicy`.
  // Deliberately NOT `opts.policy`: the composed policy includes the host's own, and a
  // host policy is entitled to key its decision off `ctx.proposed` (the `phase` doc on
  // `ToolPolicyContext` describes exactly that shape), which is `undefined` here on a
  // call that may well be mutating. Consulting it on that false premise silently bricked
  // every built-in tool for such a host, and double-invoked every host policy per call.
  //
  // Deliberately NOT routed through `consultPolicyBounded`: `preCheckPolicy` is
  // CALLER-supplied (both transports pass their own synchronous budget chain), not a
  // host callback, so it is not part of the boundary `TOOL_POLICY_TIMEOUT_MS` exists
  // to bound. `opts.policy` — which is where the host's policy actually lives, whether
  // passed bare or composed under `Policy.all` — is bounded below.
  if (opts.preCheckPolicy) {
    const preDecision = await opts.preCheckPolicy({
      transport: opts.transport,
      toolName,
      input,
      state,
      proposed: undefined,
      phase: 'pre-check',
      usage: opts.usage,
    });
    if (preDecision.action === 'deny') {
      return { kind: 'denied', reason: preDecision.reason };
    }
  }

  const result = executeToolOnState(
    toolName,
    input,
    state,
    opts.customWidgets,
    opts.pageSnapshot,
    opts.snapshotPageId,
    opts.privateMode,
  );

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
    phase: 'final',
    usage: opts.usage,
  };

  // Deadline- and abort-bounded, failing CLOSED — see `consultPolicyBounded`.
  const decision = await consultPolicyBounded(opts.policy, ctx, opts);

  if (decision.action === 'deny') {
    return { kind: 'denied', reason: decision.reason };
  }
  if (decision.action === 'require-approval') {
    return {
      kind: 'needs-approval',
      result,
      // A require-approval on a mutation always has effects; a policy that requires
      // approval on a non-mutating call gets an all-empty summary rather than crashing.
      // `mutationType` is omitted rather than fabricated: there is no real mutation
      // to name here (`result.mutation` is undefined on this branch — if it were
      // defined, `effects` would already be present from the `computeToolEffects`
      // call above), so making up an unrelated real mutation type (e.g.
      // `'setDashboardTitle'`) would mislead any approval UI reading it.
      effects: effects ?? {
        removedWidgetIds: [],
        removedPageIds: [],
        removedFilterIds: [],
        orphanedWidgetIds: [],
        addedWidgetIds: [],
        addedPageIds: [],
        updatedWidgetIds: [],
        layoutChangedPageIds: [],
      },
      // Thread the policy's own require-approval reason through — see this field's doc
      // comment on `ExecuteToolWithPolicyResult`.
      reason: decision.reason,
    };
  }
  return { kind: 'allowed', result };
}

// ── The args-only chokepoint ───────────────────────────────────────────────────

/** Discriminated outcome of an args-only policy consult (no dry-run performed). */
export type ConsultToolPolicyArgsOnlyResult =
  | { kind: 'allowed' }
  | { kind: 'denied'; reason: string }
  | {
      kind: 'needs-approval';
      /**
       * The POLICY's own stated reason for requiring approval, when supplied — see the
       * identically-purposed field on `ExecuteToolWithPolicyResult`.
       */
      reason?: string;
    };

/**
 * The single ARGS-ONLY authorization consult, shared by both transports for
 * side-effectful tools that must be authorized BEFORE they run and therefore
 * cannot use the execute-then-gate dry-run (`proposed: undefined`): server-tool
 * skills and `query_data_source` on chat, and the read-only data tools on MCP.
 * See the PURITY INVARIANT at the top of this file.
 *
 * Increments `usage.toolCalls` unconditionally, builds the `proposed: undefined`
 * context (threading `mayMutate` so a mutating-capable skill is still gated by the
 * mutation budget), awaits the policy, and maps the decision to a uniform outcome.
 * Approval bridging is transport-specific and stays at the call site: chat handles
 * `needs-approval` via `runApprovalFlow`, MCP via its `approvalHandler`.
 */
export async function consultToolPolicyArgsOnly(
  toolName: string,
  input: unknown,
  state: StudioState,
  opts: {
    policy: ToolPolicy;
    transport: 'chat' | 'mcp';
    usage: { committedMutations: number; toolCalls: number };
    mayMutate?: boolean;
  } & ToolPolicyConsultBounds,
): Promise<ConsultToolPolicyArgsOnlyResult> {
  opts.usage.toolCalls += 1;

  const ctx: ToolPolicyContext = {
    transport: opts.transport,
    toolName,
    input,
    state,
    proposed: undefined,
    phase: 'final',
    mayMutate: opts.mayMutate,
    usage: opts.usage,
  };

  // Deadline- and abort-bounded, failing CLOSED — see `consultPolicyBounded`.
  const decision = await consultPolicyBounded(opts.policy, ctx, opts);

  if (decision.action === 'deny') {
    return { kind: 'denied', reason: decision.reason };
  }
  if (decision.action === 'require-approval') {
    return { kind: 'needs-approval', reason: decision.reason };
  }
  return { kind: 'allowed' };
}
