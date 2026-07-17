/**
 * Tool approval + dispatch machinery for the x-studio-ai-middleware agentic loop.
 *
 * Owns the human-in-the-loop approval race and the per-tool-call dispatch decision
 * (parse-failure → gating → server-tool skill → query_data_source → unregistered
 * skill → approval + built-in). Extracted from `agenticLoop.ts` verbatim.
 */
import { createMutationEnvelope } from '@mui/x-studio-schema';
import type { StudioState, StudioCustomWidgetDef } from '../models/studioTypes';
import type { SerializableSkill, StudioAISkill, StudioAIDataConfig } from '../models/aiTypes';
import {
  consultToolPolicyArgsOnly,
  executeToolWithPolicy,
  type ToolPolicy,
  type ToolEffectSummary,
} from '../toolPolicy';
import type { StudioAISSEEvent, ApprovalEffectsSummary } from '../models/protocol';
import { createDataToolHandlers } from '../mcp/dataTools';
import type { AccumulatedToolCall } from './openaiWire';

/** Default cap on rows `query_data_source` may request, mirroring `mcp.ts`'s default. */
const DEFAULT_MAX_QUERY_ROWS = 1000;

// ── Tool approval ─────────────────────────────────────────────────────────────

type ApprovalOutcome =
  | { kind: 'resolved'; approved: boolean; reason?: string }
  | { kind: 'timeout' }
  | { kind: 'aborted' };

/**
 * A pending tool-call approval: the resolver a host calls with the human's
 * decision, plus the AI chat thread (`state.doc.ai?.activeThreadId` — the SAME
 * identity `rename_thread` in `executeToolOnState.ts` already stamps onto
 * mutations, not a newly invented concept) this approval was raised under.
 *
 * Storing this alongside the resolver — rather than a bare callback — is what
 * lets a host bind a resolution request to the conversation that raised it: a
 * predictable/leaked `toolCallId` alone is no longer sufficient to resolve
 * someone else's pending approval, because the host can additionally require
 * the resolving request's thread id to match `threadId` before ever calling
 * `resolve` (see `examples/x-studio-dev-server/src/routes/ai.ts`'s `/approval`
 * route). `threadId` is optional and a host that has not wired thread-id
 * passthrough into its approval UI can still resolve by id alone — this is a
 * defense-in-depth addition, not a hard requirement.
 */
export interface PendingApproval {
  resolve: (approved: boolean, reason?: string) => void;
  threadId?: string;
}

/**
 * Waits for a destructive tool's approval, but never unconditionally: races the
 * approval callback against the abort signal and a timeout so an abandoned prompt
 * can't hang the stream and leak the map entry forever. The `approvalPending`
 * entry is always removed once the race settles.
 */
export function waitForApproval(
  toolCallId: string,
  approvalPending: Map<string, PendingApproval>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  threadId: string | undefined,
): Promise<ApprovalOutcome> {
  // Cross-request collision guard: `approvalPending` is a host-shared, module-level
  // map keyed by bare `toolCallId`. If another in-flight request already registered
  // a resolver under this id, registering ours would overwrite theirs — their request
  // would then hang until timeout and the human's decision could misroute to the wrong
  // call. Refuse the duplicate instead: resolve immediately as not-approved WITHOUT
  // touching (or, via the early return, deleting) the existing entry.
  if (approvalPending.has(toolCallId)) {
    return Promise.resolve({
      kind: 'resolved',
      approved: false,
      reason:
        'duplicate toolCallId across concurrent requests — approval refused to prevent misrouting',
    });
  }
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  return new Promise<ApprovalOutcome>((resolve) => {
    approvalPending.set(toolCallId, {
      resolve: (a, r) => resolve({ kind: 'resolved', approved: a, reason: r }),
      threadId,
    });
    timeoutId = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
    if (signal) {
      if (signal.aborted) {
        resolve({ kind: 'aborted' });
      } else {
        onAbort = () => resolve({ kind: 'aborted' });
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
  }).finally(() => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    if (signal && onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
    approvalPending.delete(toolCallId);
  });
}

// ── Tool dispatch ─────────────────────────────────────────────────────────────

/** Static, per-request context shared by every `dispatchToolCall` invocation. */
export interface ToolDispatchContext {
  skillHandlers: StudioAISkill[];
  skills: SerializableSkill[] | undefined;
  data?: StudioAIDataConfig;
  customWidgets: StudioCustomWidgetDef[] | undefined;
  pageSnapshot?: string;
  /** Page the `pageSnapshot` covers — the active page when the request began. Captured
   *  once per request so a same-turn `set_active_page` can't misdirect `summarise_page`. */
  snapshotPageId?: string;
  /**
   * The AI chat thread (`state.doc.ai?.activeThreadId`) captured once from the
   * request's initial state, mirroring how `snapshotPageId` captures the
   * active page. Threaded into `waitForApproval` so a pending approval this
   * request raises is bound to the conversation that raised it (see
   * `PendingApproval`).
   */
  threadId?: string;
  approvalPending?: Map<string, PendingApproval>;
  approvalTimeoutMs: number;
  /** What to do when a `require-approval` decision has no `approvalPending` channel
   *  to pause on. `'deny'` (default) refuses the call; `'allow'` auto-approves it and
   *  fires `onToolError` as a loud warning. */
  approvalFallback: 'allow' | 'deny';
  signal?: AbortSignal;
  onToolError?: (toolName: string, error: Error) => void;
  /** Names of tools actually advertised to the model this request (T1-1 gate). */
  advertisedToolNames: Set<string>;
  /**
   * The per-call authorization policy (the single chokepoint). Consulted after the
   * pure dry-run for built-in mutating tools (`proposed` present) and args-only for
   * server-tool skills / `query_data_source` (`proposed: undefined`).
   */
  toolPolicy: ToolPolicy;
  /**
   * Mutable per-request usage counters, threaded into the policy context and
   * incremented as tools run/commit. `committedMutations` is bumped only when a
   * mutation is actually committed (never for a denied/timed-out/aborted approval).
   */
  usage: { committedMutations: number; toolCalls: number };
}

/**
 * Outcome of dispatching a single tool call. `aborted` propagates a mid-approval
 * abort up to the loop so it can end the stream silently; otherwise the loop turns
 * `output`/`nextState` into the tool-result + `tool-activity` pair exactly once.
 */
export type ToolDispatchOutcome =
  | { kind: 'aborted' }
  | { kind: 'result'; output: string; nextState?: StudioState };

function toError(err: unknown): Error {
  return err instanceof Error ? err : /* minify-error-disabled */ new Error(String(err));
}

/**
 * Builds the `input` payload shown in a `tool-approval-request` event for a
 * destructive tool, deriving any human-readable entity label from the ACTUAL
 * current state rather than trusting the model-supplied label argument.
 *
 * `remove_widget`/`remove_page` accept a `widgetTitle`/`pageTitle` arg described
 * as "used in the confirmation message", but nothing binds it to the real entity
 * the id points at. A prompt-injected model could claim `widgetTitle: "harmless
 * widget"` while `widgetId` targets something else, so the human would approve a
 * removal based on a title the model chose. Overwriting the display label with
 * `state.widgets[widgetId]?.title` / `state.pages[pageId]?.title` makes the
 * approval prompt reflect what will really be removed. The model-supplied field is
 * only ever a display hint (execution keys off the id), so overriding it here does
 * not change what the tool does once approved. If the entity does not exist in
 * state (a case the executed tool then rejects), the input is left untouched.
 *
 * Exported so the MCP transport's approval bridge (`mcp.ts` `bridgeApproval`) can
 * apply the SAME state-derived label enrichment before handing `input` to the host
 * `approvalHandler` — otherwise the two transports would disagree and the MCP path
 * would forward the raw, spoofable model label (finding T2-A).
 */
export function buildApprovalDisplayInput(
  toolName: string,
  toolInput: unknown,
  state: StudioState,
): unknown {
  const input = (toolInput ?? {}) as Record<string, unknown>;
  // `Object.hasOwn`-guarded lookups (finding T2-1): a prototype-member id must not
  // resolve to an inherited value via the prototype chain — display-only here, but
  // kept consistent with the executor's own-property discipline.
  const readWidget = (id: string): StudioState['doc']['widgets'][string] | undefined =>
    Object.hasOwn(state.doc.widgets, id) ? state.doc.widgets[id] : undefined;
  const readPage = (id: string): StudioState['doc']['pages'][string] | undefined =>
    Object.hasOwn(state.doc.pages, id) ? state.doc.pages[id] : undefined;
  if (toolName === 'remove_widget') {
    const realTitle = readWidget(String(input.widgetId ?? ''))?.title;
    return realTitle !== undefined ? { ...input, widgetTitle: realTitle } : toolInput;
  }
  if (toolName === 'remove_page') {
    const realTitle = readPage(String(input.pageId ?? ''))?.title;
    return realTitle !== undefined ? { ...input, pageTitle: realTitle } : toolInput;
  }
  if (toolName === 'apply_bulk_update') {
    // `apply_bulk_update` is destructive: `widgetRemovals` is a raw array of
    // model-supplied widget ids. Enrich it for display with each widget's REAL
    // current title so the human approves against what will actually be removed,
    // not an opaque id list. Display-only — execution still keys off the raw ids.
    const removals = input.widgetRemovals;
    if (Array.isArray(removals)) {
      return {
        ...input,
        widgetRemovals: removals.map((id) => {
          const widgetId = String(id);
          return { id: widgetId, title: readWidget(widgetId)?.title ?? '(unknown widget)' };
        }),
      };
    }
    return toolInput;
  }
  return toolInput;
}

/**
 * Builds the OPTIONAL, state-derived `effects` summary attached to a
 * `tool-approval-request` event (finding T2-2). The chat channel historically shipped
 * only `{toolName,input}`, so a human approving an orphaning `set_widget_layout` or bulk
 * `layout` op saw an opaque id matrix — while the MCP transport already forwards the
 * structural `effects` to its host `approvalHandler`. This closes that gap: it turns the
 * policy's `ToolEffectSummary` (id lists) into a human-readable summary, resolving each
 * removed/orphaned entity to its CURRENT title from the pre-mutation state (removed and
 * orphaned widgets still exist in `state.doc.widgets` at approval time).
 *
 * Returns `undefined` when there are no structural effects to report (e.g. an args-only
 * gate with no proposed mutation, or a mutation that removes/orphans nothing), so the
 * event's `effects` key is omitted rather than emitted empty.
 */
export function buildApprovalEffectsSummary(
  effects: ToolEffectSummary | undefined,
  state: StudioState,
): ApprovalEffectsSummary | undefined {
  if (!effects) {
    return undefined;
  }
  const widgetTitle = (id: string): string =>
    (Object.hasOwn(state.doc.widgets, id) ? state.doc.widgets[id]?.title : undefined) ??
    '(unknown widget)';
  const pageTitle = (id: string): string =>
    (Object.hasOwn(state.doc.pages, id) ? state.doc.pages[id]?.title : undefined) ??
    '(unknown page)';

  const summary: ApprovalEffectsSummary = {};
  if (effects.removedWidgetIds.length > 0) {
    summary.willRemoveWidgets = effects.removedWidgetIds.map((id) => ({
      id,
      title: widgetTitle(id),
    }));
  }
  if (effects.removedPageIds.length > 0) {
    summary.willRemovePages = effects.removedPageIds.map((id) => ({ id, title: pageTitle(id) }));
  }
  if (effects.removedFilterIds.length > 0) {
    summary.willRemoveFilters = [...effects.removedFilterIds];
  }
  if (effects.orphanedWidgetIds.length > 0) {
    summary.willOrphanWidgets = effects.orphanedWidgetIds.map((id) => ({
      id,
      title: widgetTitle(id),
    }));
  }
  if (effects.updatedWidgetIds.length > 0) {
    summary.updatedWidgetCount = effects.updatedWidgetIds.length;
  }
  return Object.keys(summary).length > 0 ? summary : undefined;
}

/** Result of the shared human-in-the-loop approval pause. */
type ApprovalFlowResult =
  | { kind: 'aborted' }
  | { kind: 'denied'; output: string }
  | { kind: 'approved' };

/**
 * The single approval-pause implementation, shared by the built-in
 * `require-approval` path and the args-only (skill / `query_data_source`)
 * `require-approval` path so the pause/timeout/abort race lives in exactly one
 * place. Yields the `tool-approval-request` event, then reuses `waitForApproval`
 * verbatim.
 *
 * When `approvalPending` is not configured there is no channel to pause on. The
 * `approvalFallback` option decides what happens then: `'deny'` (the default)
 * refuses the call with an actionable message, closing the historical fail-open hole
 * where destructive tools executed unapproved whenever no `approvalPending` map was
 * supplied; `'allow'` preserves that historical behavior but fires `onToolError` as a
 * loud warning that a require-approval decision was auto-approved.
 */
async function* runApprovalFlow(
  toolCallId: string,
  toolName: string,
  displayInput: unknown,
  effectsSummary: ApprovalEffectsSummary | undefined,
  ctx: ToolDispatchContext,
): AsyncGenerator<StudioAISSEEvent, ApprovalFlowResult> {
  if (!ctx.approvalPending) {
    if (ctx.approvalFallback === 'allow') {
      ctx.onToolError?.(
        toolName,
        /* minify-error-disabled */ new Error(
          `MUI X Studio: "${toolName}" required approval but no approvalPending map is configured; ` +
            `approvalFallback: 'allow' auto-approved it. Wire an approval channel to gate ` +
            `destructive tools, or keep approvalFallback: 'allow' to opt into this behavior.`,
        ),
      );
      return { kind: 'approved' };
    }
    return {
      kind: 'denied',
      output: JSON.stringify({
        denied: true,
        reason:
          `"${toolName}" requires approval but no approvalPending map is configured. ` +
          `Wire an approval channel (pass approvalPending) or set approvalFallback: 'allow'.`,
      }),
    };
  }
  yield {
    type: 'tool-approval-request',
    toolCallId,
    toolName,
    input: displayInput,
    ...(effectsSummary ? { effects: effectsSummary } : {}),
  };
  const outcome = await waitForApproval(
    toolCallId,
    ctx.approvalPending,
    ctx.signal,
    ctx.approvalTimeoutMs,
    ctx.threadId,
  );
  if (outcome.kind === 'aborted') {
    return { kind: 'aborted' };
  }
  if (outcome.kind === 'timeout') {
    return {
      kind: 'denied',
      output: JSON.stringify({ denied: true, reason: 'approval timed out' }),
    };
  }
  if (!outcome.approved) {
    return {
      kind: 'denied',
      output: JSON.stringify({
        denied: true,
        reason: outcome.reason ?? 'User denied the operation.',
      }),
    };
  }
  return { kind: 'approved' };
}

/**
 * Executes one tool call, owning the full dispatch decision (parse-failure →
 * gating → server-tool skill → query_data_source → unregistered skill → approval +
 * built-in). Yields the side-effect events that must precede the result
 * (`state-mutation`, `tool-approval-request`) and returns a uniform outcome; the
 * caller performs the single result/`tool-activity` pairing for every path.
 */
export async function* dispatchToolCall(
  tc: AccumulatedToolCall,
  toolInput: unknown,
  argsParseFailed: boolean,
  currentState: StudioState,
  ctx: ToolDispatchContext,
): AsyncGenerator<StudioAISSEEvent, ToolDispatchOutcome> {
  const { name } = tc;

  // The model streamed tool-call arguments that aren't valid JSON. Executing the
  // tool with a coerced `{}` would run it with the wrong (empty) args and, for
  // non-validating destructive tools, report a no-op as success. Surface the parse
  // failure to the model so it can retry with valid JSON.
  if (argsParseFailed) {
    const rawArgs = tc.argsBuffer ?? '';
    const snippet = rawArgs.length > 200 ? `${rawArgs.slice(0, 200)}…` : rawArgs;
    return {
      kind: 'result',
      output: JSON.stringify({ error: `invalid tool arguments: ${snippet}` }),
    };
  }

  // T1-1 — enforce the effective tool set at dispatch time, not just at
  // advertisement time. `allowedTools`/`privateMode`/data-config filtering only
  // controls what is offered to the model; without this gate a prompt-injected
  // call to an unadvertised tool (e.g. `remove_page` in a read-only assistant, or
  // `query_data_source` excluded from `allowedTools`) would still be executed.
  // Unknown or unadvertised names get the same error the default path produces —
  // never run.
  if (!ctx.advertisedToolNames.has(name)) {
    return { kind: 'result', output: JSON.stringify({ error: `Unknown tool: ${name}` }) };
  }

  // Registered server-tool skill — execute it server-side (may be sync or async).
  const matchedSkill = ctx.skillHandlers
    .filter((s) => s.mode === 'server-tool' && s.tool)
    .find((s) => s.tool!.name === name);

  if (matchedSkill?.tool?.execute) {
    // Server-tool skills are SIDE-EFFECTFUL: their `execute` runs real work, so the
    // policy must be consulted args-only (`proposed: undefined`) BEFORE it runs —
    // never as a post-hoc dry-run. See the purity invariant in `toolPolicy.ts`.
    // `mayMutate: true` — a skill's `execute` may return a mutation, so it counts
    // against the mutation budget exactly like a built-in mutating tool.
    const gate = await consultToolPolicyArgsOnly(name, toolInput, currentState, {
      policy: ctx.toolPolicy,
      transport: 'chat',
      usage: ctx.usage,
      mayMutate: true,
    });
    if (gate.kind === 'denied') {
      return { kind: 'result', output: JSON.stringify({ error: gate.reason }) };
    }
    if (gate.kind === 'needs-approval') {
      const displayInput = buildApprovalDisplayInput(name, toolInput, currentState);
      // No structural effects to summarize here: a server-tool skill is gated args-only
      // (no pure dry-run), so no `ToolEffectSummary` is available before it runs.
      const approval = yield* runApprovalFlow(tc.id, name, displayInput, undefined, ctx);
      if (approval.kind === 'aborted') {
        return { kind: 'aborted' };
      }
      if (approval.kind === 'denied') {
        return { kind: 'result', output: approval.output };
      }
    }
    try {
      const result = await Promise.resolve(
        matchedSkill.tool.execute(toolInput as Record<string, unknown>, currentState),
      );
      if (result.mutation) {
        ctx.usage.committedMutations += 1;
        yield { type: 'state-mutation', ...createMutationEnvelope(result.mutation) };
      }
      return { kind: 'result', output: result.output, nextState: result.nextState };
    } catch (skillErr) {
      const skillError = toError(skillErr);
      ctx.onToolError?.(name, skillError);
      return { kind: 'result', output: JSON.stringify({ error: skillError.message }) };
    }
  }

  // query_data_source — resolved via the app-provided data config, dispatched
  // through the SAME `createDataToolHandlers` factory the MCP transport uses,
  // so both transports run the identical structured-query pipeline.
  if (name === 'query_data_source') {
    // `query_data_source` is SIDE-EFFECTFUL (runs a live query) but never mutates
    // dashboard state, so the policy is consulted args-only BEFORE it runs
    // (`mayMutate` omitted), never as a post-hoc dry-run.
    const gate = await consultToolPolicyArgsOnly(name, toolInput, currentState, {
      policy: ctx.toolPolicy,
      transport: 'chat',
      usage: ctx.usage,
    });
    if (gate.kind === 'denied') {
      return { kind: 'result', output: JSON.stringify({ error: gate.reason }) };
    }
    if (gate.kind === 'needs-approval') {
      const displayInput = buildApprovalDisplayInput(name, toolInput, currentState);
      // `query_data_source` never mutates dashboard state, so there are no structural
      // effects to summarize.
      const approval = yield* runApprovalFlow(tc.id, name, displayInput, undefined, ctx);
      if (approval.kind === 'aborted') {
        return { kind: 'aborted' };
      }
      if (approval.kind === 'denied') {
        return { kind: 'result', output: approval.output };
      }
    }
    let output: string;
    try {
      if (!ctx.data) {
        output = JSON.stringify({
          error:
            'query_data_source is not available: no data access was configured on the server. ' +
            'Pass a `data` config in AgenticLoopOptions to enable this tool.',
        });
      } else {
        const handlers = createDataToolHandlers({
          stateBox: { current: currentState },
          data: ctx.data,
          maxQueryRows: ctx.data.maxQueryRows ?? DEFAULT_MAX_QUERY_ROWS,
          recentChanges: [],
        });
        const result = await handlers.query_data_source(toolInput as Record<string, unknown>);
        const textItem = result.content.find(
          (item): item is { type: 'text'; text: string } => item.type === 'text',
        );
        output = textItem?.text ?? JSON.stringify(result);
        if (result.isError) {
          const parsed = JSON.parse(output) as { error?: string };
          ctx.onToolError?.(name, new Error(parsed.error ?? output));
        }
      }
    } catch (queryErr) {
      const queryError = toError(queryErr);
      ctx.onToolError?.(name, queryError);
      output = JSON.stringify({ error: queryError.message });
    }
    return { kind: 'result', output };
  }

  // Skill was declared in the request but has no registered server handler.
  const isUnregisteredSkillTool = (ctx.skills ?? [])
    .filter((s) => s.mode === 'server-tool' && s.tool)
    .some((s) => s.tool!.name === name);

  if (isUnregisteredSkillTool) {
    return {
      kind: 'result',
      output: JSON.stringify({
        error: `server-tool skill '${name}' has no registered handler on the server.`,
      }),
    };
  }

  // Built-in tool — run through the policy chokepoint (execute-then-gate). This is
  // the single point where the pure dry-run, the effect diff, and the policy
  // decision happen for every built-in tool. A read-only tool produces no mutation,
  // so `executeToolWithPolicy` simply returns `allowed` with no `state-mutation`.
  let outcome: Awaited<ReturnType<typeof executeToolWithPolicy>>;
  try {
    outcome = await executeToolWithPolicy(name, toolInput, currentState, {
      policy: ctx.toolPolicy,
      customWidgets: ctx.customWidgets,
      pageSnapshot: ctx.pageSnapshot,
      snapshotPageId: ctx.snapshotPageId,
      transport: 'chat',
      usage: ctx.usage,
    });
  } catch (err) {
    const toolErr = toError(err);
    ctx.onToolError?.(name, toolErr);
    return { kind: 'result', output: JSON.stringify({ error: toolErr.message }) };
  }

  if (outcome.kind === 'denied') {
    return { kind: 'result', output: JSON.stringify({ error: outcome.reason }) };
  }

  if (outcome.kind === 'needs-approval') {
    // The human-facing approval display must reflect the real target from state,
    // not a title the (possibly prompt-injected) model chose. See
    // `buildApprovalDisplayInput`.
    const displayInput = buildApprovalDisplayInput(name, toolInput, currentState);
    // T2-2: attach a state-derived structural-effects summary (which widgets/pages/filters
    // get removed, which widgets get orphaned) so the human isn't approving a layout op
    // blind. `outcome.effects` is always present on the built-in needs-approval path.
    const effectsSummary = buildApprovalEffectsSummary(outcome.effects, currentState);
    const approval = yield* runApprovalFlow(tc.id, name, displayInput, effectsSummary, ctx);
    if (approval.kind === 'aborted') {
      return { kind: 'aborted' };
    }
    if (approval.kind === 'denied') {
      // Denied/timed-out: discard — do NOT adopt nextState, no state-mutation event,
      // no committed-mutation increment.
      return { kind: 'result', output: approval.output };
    }
    // Approved: commit exactly like the allow path below.
    if (outcome.result.mutation) {
      ctx.usage.committedMutations += 1;
      yield { type: 'state-mutation', ...createMutationEnvelope(outcome.result.mutation) };
    }
    return {
      kind: 'result',
      output: outcome.result.output,
      nextState: outcome.result.nextState,
    };
  }

  // Allowed (no approval needed) — commit immediately, indistinguishable from the
  // historical behavior for every tool not gated by the policy.
  if (outcome.result.mutation) {
    ctx.usage.committedMutations += 1;
    yield { type: 'state-mutation', ...createMutationEnvelope(outcome.result.mutation) };
  }
  return {
    kind: 'result',
    output: outcome.result.output,
    nextState: outcome.result.nextState,
  };
}
