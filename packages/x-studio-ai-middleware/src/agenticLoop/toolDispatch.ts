/**
 * Tool approval + dispatch machinery for the x-studio-ai-middleware agentic loop.
 *
 * Owns the human-in-the-loop approval race and the per-tool-call dispatch decision
 * (parse-failure → gating → server-tool skill → query_data_source → unregistered
 * skill → approval + built-in). Extracted from `agenticLoop.ts` verbatim.
 */
import { applyMutation, createMutationEnvelope, type StateMutation } from '@mui/x-studio-schema';
import type { StudioState, StudioCustomWidgetDef } from '../models/studioTypes';
import type { SerializableSkill, StudioAISkill, StudioAIDataConfig } from '../models/aiTypes';
import {
  consultToolPolicyArgsOnly,
  executeToolWithPolicy,
  type ToolPolicy,
  type ToolEffectSummary,
  type ConsultToolPolicyArgsOnlyResult,
} from '../toolPolicy';
import type { StudioAISSEEvent, ApprovalEffectsSummary } from '../models/protocol';
import { createDataToolHandlers } from '../mcp/dataTools';
import {
  opLabel,
  redactedHostErrorMessage,
  safeIdentifier,
  withTimeout,
  sanitizeMaxQueryRows,
} from '../mcp/helpers';
import { asString } from '../internal/promptCaps';
import { getWidget, getPage } from '../internal/entityLookup';
import type { AccumulatedToolCall } from './openaiWire';

/**
 * Timeout (ms) for the chat-transport `query_data_source` call into the
 * host-provided `data.queryDataSource`. Without this, a hung DB connection would
 * block the whole agentic-loop turn (and therefore the SSE stream) indefinitely.
 * Matches the timeout `mcp/summarisePage.ts` already applies to its own
 * `data.queryDataSource` calls via the same `withTimeout` helper.
 */
const QUERY_DATA_SOURCE_TIMEOUT_MS = 15_000;

/**
 * Timeout (ms) for a host-registered server-tool skill's `execute()` call. Without
 * this, a hanging skill (e.g. one that awaits a stuck external API call) would block
 * the whole agentic-loop turn — and therefore the SSE stream — indefinitely, exactly
 * like the unbounded `query_data_source` call this mirrors. Same value as
 * `QUERY_DATA_SOURCE_TIMEOUT_MS`: both are server-side calls into host-supplied code
 * with no more specific latency contract to size a bespoke timeout against.
 */
const SERVER_TOOL_TIMEOUT_MS = 15_000;

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
 *
 * IMPORTANT for hosts that DO wire this check: use `isApprovalThreadIdAuthorized`
 * (below) rather than hand-rolling it. When `entry.threadId` is set, the
 * resolving request MUST present a matching `threadId` — reject the resolution
 * (403) if it is missing OR mismatched, not only when both sides happen to have
 * one. A check of the shape `entry.threadId !== undefined && threadId !== undefined
 * && entry.threadId !== threadId` is bypassable simply by omitting `threadId` from
 * the request body, since it degrades to a no-op the moment `threadId` is absent.
 *
 * `resolve`'s optional third argument is the resolving request's asserted thread id
 * (finding F8). Forward it and `waitForApproval` re-checks the binding AT THE
 * RESOLVER — a mismatch fails closed as `approved: false` rather than being trusted
 * to the caller — so a host that forwards the wrong conversation's id cannot approve
 * a destructive tool even if its own route check is missing or wrong. Omitting the
 * argument keeps the historical behavior, deliberately: the package cannot tell a
 * host that never wired thread-id passthrough (for whom omitting it is CORRECT, per
 * the paragraph above) from an attacker who dropped the field to dodge the check,
 * and refusing would silently break every such host. That is the half only the host
 * route can close, which is why `isApprovalThreadIdAuthorized` denies on a MISSING
 * id and this resolver does not.
 */
export interface PendingApproval {
  resolve: (approved: boolean, reason?: string, resolvingThreadId?: string) => void;
  threadId?: string;
}

/**
 * Whether a resolution request may resolve `entry`, given the entry's own
 * `threadId` (absent when the approval was never bound to a thread) and the
 * resolving request's asserted `threadId` (finding 5, Tier 3).
 *
 * When `entry.threadId` is set, the resolving request MUST present a matching
 * `threadId` — this returns `false` when it is missing OR mismatched. A check
 * of the shape `entry.threadId !== undefined && threadId !== undefined &&
 * entry.threadId !== threadId` is bypassable simply by omitting `threadId`
 * from the request body (it degrades to a no-op the moment `threadId` is
 * absent on either side); this helper closes that gap. Only when
 * `entry.threadId` itself is absent does this return `true` unconditionally —
 * the approval was never bound to a thread, so there is nothing to check.
 *
 * Exported so a host's approval route (see the `@example` on
 * `StudioAIHandlerOptions.approvalPending` in `handleAIChat.ts`, and
 * `examples/x-studio-dev-server/src/routes/ai.ts`'s `/approval` route) can
 * reuse this exact check instead of hand-rolling a bypassable version.
 */
export function isApprovalThreadIdAuthorized(
  entry: Pick<PendingApproval, 'threadId'>,
  threadId: string | undefined,
): boolean {
  if (entry.threadId === undefined) {
    return true;
  }
  return entry.threadId === threadId;
}

/**
 * Waits for a destructive tool's approval, but never unconditionally: races the
 * approval callback against the abort signal and a timeout so an abandoned prompt
 * can't hang the stream and leak the map entry forever. The `approvalPending`
 * entry is always removed once the race settles.
 *
 * The registered resolver also RE-CHECKS the thread binding it was created with
 * (finding F8), rather than only recording it. `isApprovalThreadIdAuthorized` was
 * exported for host routes to call, and every real call site was a host route — so
 * the binding was enforced entirely outside the package and not at all within it. A
 * resolution that ASSERTS a thread id now has to present a matching one here too, or
 * it is refused as `approved: false` (fail closed, exactly like the duplicate-id
 * guard below). See `PendingApproval` for why an OMITTED id is still honoured and
 * why that half necessarily belongs to the host route.
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
      resolve: (a, r, resolvingThreadId) => {
        // Finding F8 — enforce the binding here, not merely record it. Only when the
        // resolver ASSERTS a thread id: `isApprovalThreadIdAuthorized` also denies a
        // MISSING one, which is right for a host route (an attacker can drop a field)
        // but wrong here, where an omitted argument is indistinguishable from a host
        // that never wired passthrough at all. `r` is deliberately NOT echoed — a
        // refused resolution must not read as if the caller's decision was honoured.
        if (
          resolvingThreadId !== undefined &&
          !isApprovalThreadIdAuthorized({ threadId }, resolvingThreadId)
        ) {
          resolve({
            kind: 'resolved',
            approved: false,
            reason:
              'the resolving request named a different chat thread than the one this approval ' +
              'was raised under — approval refused',
          });
          return;
        }
        resolve({ kind: 'resolved', approved: a, reason: r });
      },
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
   * Whether the request runs under `privateMode` (finding F4). `PRIVATE_MODE_EXCLUDED_TOOLS`
   * withdraws the read tools; this threads the flag down to the WRITE tools that stay
   * advertised, so their rejection strings state the constraint instead of the withheld
   * state — see `ToolPlanContext.privateMode` in `executeToolOnState.ts`.
   */
  privateMode?: boolean;
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
   * The budget half of `toolPolicy` (mutation + tool-call budgets) WITHOUT the host
   * policy, forwarded as `executeToolWithPolicy`'s `preCheckPolicy` so a call the
   * budgets will reject skips the expensive pure dry-run. Kept separate because that
   * pre-check consult presents `proposed: undefined` on a call that may well be
   * mutating — a false premise for a host policy, but not for a budget. Optional: omit
   * to skip the pre-check entirely (correct, just less efficient).
   */
  budgetPolicy?: ToolPolicy;
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

/**
 * Turns a failure that crossed the HOST boundary into a model- and browser-safe
 * message.
 *
 * Every failure this dispatcher can catch comes from code outside this package: a
 * host `toolPolicy` (which the docs invite hosts to back with a per-tenant rules
 * table — i.e. a live DB call), a host-registered server-tool skill's `execute`, or
 * the host's `queryDataSource`. Their messages routinely carry credentials
 * (`password authentication failed for user "studio_ro"`), the failing SQL with its
 * bindings, and internal hostnames — and on THIS transport a tool result is not a
 * one-shot value: `agenticLoop.ts` appends it to `currentMessages` and re-sends it
 * to the provider on every remaining turn, and forwards it to the browser inside the
 * `tool-activity` SSE event. Relaying it verbatim breaks the invariant
 * `ARCHITECTURE.md` states for the MCP transport ("error text that crossed the host
 * boundary is never relayed to the model or the browser"); this is that invariant's
 * chat-transport half.
 *
 * `redactedHostErrorMessage` is the single chokepoint that upholds it: the full
 * detail goes to the logger sink under a short correlation reference, and only a
 * generic, bounded sentence carrying that reference is returned. Errors this package
 * authored — currently a `withTimeout` deadline, branded via
 * `internal/packageError.ts` — are relayed verbatim by that helper, so "the call
 * hung" stays distinguishable from "the host rejected it".
 *
 * `ctx.onToolError` is the one server-side error channel the chat transport has, so
 * it doubles as the logger sink — the same wiring the `query_data_source` branch
 * below already uses for `createDataToolHandlers`. `toolName` is routed through
 * `safeIdentifier` before being interpolated into the returned prose because the
 * advertised tool set can include client-declared server-tool skill names.
 */
function redactedHostError(
  toolName: string,
  context: string,
  err: unknown,
  ctx: ToolDispatchContext,
): string {
  return redactedHostErrorMessage(context, err, {
    log: () => {},
    error: (...args: unknown[]) => {
      // `asString`, not the raw `String` global (finding H1): this sink runs while
      // handling a failure, so a non-coercible log argument must not throw a second
      // one out of the catch that is already recovering.
      ctx.onToolError?.(
        toolName,
        /* minify-error-disabled */ new Error(args.map((a) => asString(a)).join(' ')),
      );
    },
  });
}

/**
 * Runs the args-only policy consult for a side-effectful tool, converting a THROW
 * from the host policy into a `denied` outcome instead of letting it escape.
 *
 * `Policy.all` awaits the host policy with no try/catch, so a host policy that
 * throws (its per-tenant rules table is behind a dropped DB connection) used to
 * reject out of `dispatchToolCall`, out of the `while (true) { await dispatch.next()
 * }` driver in `agenticLoop.ts` — whose enclosing try covers only the SSE read loop,
 * which has already exited by then — out of `runAgenticLoop` entirely, and was
 * caught only by `handleAIChat`'s outer catch, which relayed the raw host message
 * AND terminated the whole stream. Both halves were wrong: the documented contract
 * is that a policy failure surfaces as a RECOVERABLE tool result, and host error
 * text is never relayed. Failing closed (denied, redacted) upholds both — the model
 * gets a correlation id it can report, the operator gets the detail, and the loop
 * continues.
 */
async function consultToolPolicyArgsOnlyGuarded(
  toolName: string,
  toolInput: unknown,
  currentState: StudioState,
  ctx: ToolDispatchContext,
  mayMutate: boolean,
): Promise<ConsultToolPolicyArgsOnlyResult> {
  try {
    return await consultToolPolicyArgsOnly(toolName, toolInput, currentState, {
      policy: ctx.toolPolicy,
      transport: 'chat',
      usage: ctx.usage,
      // The request's abort signal, threaded into the policy consult's bounds so an
      // abandoned chat request cancels the wait for a host policy immediately. The
      // `TOOL_POLICY_TIMEOUT_MS` deadline inside `consultPolicyBounded` is the safety
      // net (it bounds a policy that never settles at all); the signal is the correct
      // behaviour, because without it an aborted request still burns the full deadline
      // on EVERY remaining tool call. MCP threads the SDK's per-request `extra.signal`
      // into all four of its consults for the same reason.
      signal: ctx.signal,
      ...(mayMutate ? { mayMutate: true } : {}),
    });
  } catch (policyErr) {
    return {
      kind: 'denied',
      reason: redactedHostError(
        toolName,
        `the tool policy check for "${safeIdentifier(toolName)}"`,
        policyErr,
        ctx,
      ),
    };
  }
}

/**
 * Extracts a human-readable error message from an `isError` tool result's text
 * (finding 7, Tier 3, latent, iteration 24).
 *
 * `output` here is whatever text a tool handler returned alongside `isError: true` —
 * today, for the `query_data_source` handler this is always JSON (`errorResult` in
 * `mcp/helpers.ts` always calls `JSON.stringify({ error })`), but a future or
 * misbehaving handler could return plain non-JSON error text instead. Parsing that
 * text is deliberately isolated in its OWN try/catch, separate from the caller's
 * OUTER `catch (queryErr)` (which wraps the whole `query_data_source` dispatch): if
 * `JSON.parse` were left unguarded inline there, a non-JSON `output` would make it
 * throw, and the outer catch would then report a generic "Unexpected token ... in
 * JSON" parse error via `onToolError` INSTEAD of the tool's real failure — silently
 * corrupting the actual error. Falling back to the raw `output` text here preserves
 * the real error either way.
 *
 * Exported for direct unit testing — this repo runs vitest with `isolate: false`
 * (see `vitest.shared.mts`), which makes per-file module mocks (e.g. of
 * `createDataToolHandlers`, the only way to make a REAL dispatch call reach this
 * branch with non-JSON text) unsafe to use in this suite; testing the extraction
 * logic directly avoids that entirely.
 */
export function extractToolErrorMessage(output: string): string {
  try {
    return (JSON.parse(output) as { error?: string }).error ?? output;
  } catch {
    return output;
  }
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
 *
 * Every id read here goes through `asString`, never the raw `String` global (finding
 * H1). `toolInput` is un-narrowed `JSON.parse` output straight off the model's
 * tool-call buffer, and `String({"toString": 1})` throws `TypeError: Cannot convert
 * object to primitive value`. That mattered here more than anywhere else in the
 * package: `createDefaultToolPolicy` gates by tool NAME, so
 * `remove_widget({"widgetId":{"toString":1}})` — which the executor rejects cleanly —
 * still routed to approval and reached this function, whose caller in
 * `dispatchToolCall` sat OUTSIDE the try wrapping `executeToolWithPolicy`. The throw
 * propagated past the SSE try block in `agenticLoop.ts` and closed the whole stream
 * with one generic error frame. `apply_bulk_update({widgetRemovals:[{toString:1}]})`
 * did the same through the `widgetRemovals` branch. The call site is now inside that
 * try as well, so neither this function nor `buildApprovalEffectsSummary` can escape
 * as a stream-killing throw even if a future edit reintroduces one.
 */
export function buildApprovalDisplayInput(
  toolName: string,
  toolInput: unknown,
  state: StudioState,
): unknown {
  const input = (toolInput ?? {}) as Record<string, unknown>;
  // `Object.hasOwn`-guarded lookups (finding T2-1) via the shared `getWidget`/`getPage`
  // (`../internal/entityLookup`): a prototype-member id must not resolve to an
  // inherited value via the prototype chain — display-only here, but kept consistent
  // with the executor's own-property discipline.
  if (toolName === 'remove_widget') {
    const realTitle = getWidget(state, asString(input.widgetId))?.title;
    return realTitle !== undefined ? { ...input, widgetTitle: realTitle } : toolInput;
  }
  if (toolName === 'remove_page') {
    const realTitle = getPage(state, asString(input.pageId))?.title;
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
          const widgetId = asString(id);
          return { id: widgetId, title: getWidget(state, widgetId)?.title ?? '(unknown widget)' };
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
  // `Object.hasOwn`-guarded lookups (finding T2-1) via the shared `getWidget`/`getPage`
  // (`../internal/entityLookup`) — see `buildApprovalDisplayInput` above.
  const widgetTitle = (id: string): string => getWidget(state, id)?.title ?? '(unknown widget)';
  const pageTitle = (id: string): string => getPage(state, id)?.title ?? '(unknown page)';

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
 *
 * `policyReason` (Tier 3, iteration 22) is the POLICY's own stated reason for
 * requiring approval (`ToolPolicyDecision`'s `{ action: 'require-approval', reason
 * }`), when the configured policy supplied one — previously computed by
 * `toolPolicy.ts` but dropped before ever reaching this function, so it could not
 * be surfaced to a human approver NOR relayed back to the LLM on the no-channel
 * auto-deny fallback below. Threaded into the `tool-approval-request` event for the
 * former, and appended to the fallback denial message for the latter.
 */
async function* runApprovalFlow(
  toolCallId: string,
  toolName: string,
  displayInput: unknown,
  effectsSummary: ApprovalEffectsSummary | undefined,
  ctx: ToolDispatchContext,
  policyReason?: string,
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
        reason: `"${toolName}" requires approval${policyReason ? ` (${policyReason})` : ''} but no approvalPending map is configured. Wire an approval channel (pass approvalPending) or set approvalFallback: 'allow'.`,
      }),
    };
  }
  yield {
    type: 'tool-approval-request',
    toolCallId,
    toolName,
    input: displayInput,
    ...(effectsSummary ? { effects: effectsSummary } : {}),
    ...(policyReason ? { reason: policyReason } : {}),
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
 * Reconciles a `server-tool` skill's independently-supplied `mutation` and `nextState`
 * so the two can't disagree (finding L1).
 *
 * This is the ONE dispatch path where invariant 8 — "server-threaded and client-applied
 * state cannot disagree, because they run the same code" — did not hold. Every built-in
 * tool derives its `nextState` from `applyMutation`, the same reducer the browser runs
 * on the `state-mutation` event, so the two sides are the same computation by
 * construction. A skill supplies BOTH halves itself, from host code this package never
 * sees, and nothing checked that one was the other's result. Two divergences followed:
 *
 * - `nextState` with NO `mutation` — the server's threaded doc advances, no
 *   `state-mutation` event is emitted, and the client's doc never moves. Every later
 *   mutation this request produces is then computed against a doc the client does not
 *   have, so it applies to a different base.
 * - `mutation` with a STALE (or unrelated) `nextState` — the client applies the mutation
 *   and moves, the server does not, and the same divergence opens the other way.
 *
 * So the DOC is always taken from the reducer: `applyMutation(state, mutation)` when a
 * mutation was returned, and the unchanged `state.doc` when none was. What a skill
 * legitimately owns is the rest — `runtime` (a skill that fetches rows and injects them
 * into `runtime.dataSources` is the motivating case, and none of that is expressible as
 * a `StateMutation`) and `session` — which are carried over from its own `nextState`
 * untouched. Neither is persisted, undoable, or client-applied via `state-mutation`, so
 * neither can desynchronise the two sides.
 *
 * The practical rule for a skill author, and the reason it is now enforceable rather
 * than merely documented: **every `doc` change must be expressed as the returned
 * `mutation`.** A `doc` edit made only inside `nextState` is dropped here rather than
 * silently forking the two states.
 */
function reconcileSkillNextState(
  state: StudioState,
  result: { mutation?: StateMutation; nextState: StudioState },
): StudioState {
  const doc = result.mutation ? applyMutation(state, result.mutation).doc : state.doc;
  // A skill returning a malformed `nextState` (it is host code — `undefined` is
  // reachable however the type is declared) falls back to the threaded state rather
  // than producing a `StudioState` with missing partitions.
  const base = result.nextState ?? state;
  return { ...base, doc };
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
    // Every other dispatch path counts against `usage.toolCalls` via
    // `executeToolWithPolicy`/`consultToolPolicyArgsOnly` — this early return happens
    // before either runs, so it must bump the counter itself. A malformed tool call
    // still consumed a turn (and, from the model's perspective, an attempted call), so
    // it must count against the tool-call budget just like a dispatched one; otherwise a
    // model stuck emitting invalid JSON could retry unboundedly without ever tripping
    // `maxToolCallsPerRequest`.
    ctx.usage.toolCalls += 1;
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
    // Same accounting rationale as the parse-failure return above: this happens before
    // any policy consult increments `usage.toolCalls`, so a hallucinated/injected call to
    // an unadvertised tool would otherwise dispatch for free against the budget.
    ctx.usage.toolCalls += 1;
    // `safeIdentifier`, not the raw `name`: this message is spliced straight back into
    // the model conversation, and `name` is raw provider-supplied wire data, so it is an
    // untrusted-string-into-prompt position exactly like the three other interpolations
    // of this same value in this file (the policy-consult label, the server-tool-skill
    // label and the `executeToolOnState` label), all of which already route through the
    // shared sanitize-AND-cap chokepoint. This site was the outlier. `mcp.ts`'s two
    // `Unknown tool:` messages do the same.
    return {
      kind: 'result',
      output: JSON.stringify({ error: `Unknown tool: ${safeIdentifier(name)}` }),
    };
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
    // against the mutation budget exactly like a built-in mutating tool. A throw from
    // the host policy becomes a redacted `denied` rather than escaping the loop; see
    // `consultToolPolicyArgsOnlyGuarded`.
    const gate = await consultToolPolicyArgsOnlyGuarded(name, toolInput, currentState, ctx, true);
    if (gate.kind === 'denied') {
      return { kind: 'result', output: JSON.stringify({ error: gate.reason }) };
    }
    if (gate.kind === 'needs-approval') {
      const displayInput = buildApprovalDisplayInput(name, toolInput, currentState);
      // No structural effects to summarize here: a server-tool skill is gated args-only
      // (no pure dry-run), so no `ToolEffectSummary` is available before it runs.
      const approval = yield* runApprovalFlow(
        tc.id,
        name,
        displayInput,
        undefined,
        ctx,
        gate.reason,
      );
      if (approval.kind === 'aborted') {
        return { kind: 'aborted' };
      }
      if (approval.kind === 'denied') {
        return { kind: 'result', output: approval.output };
      }
    }
    try {
      const result = await withTimeout(
        Promise.resolve(
          matchedSkill.tool.execute(toolInput as Record<string, unknown>, currentState),
        ),
        SERVER_TOOL_TIMEOUT_MS,
        // `opLabel`, not a raw template: `name` is a CLIENT-declared server-tool skill
        // name off `body.skills`, and this label lands in a BRANDED `StudioTimeoutError`
        // that `redactedHostErrorMessage` relays verbatim. The tagged template routes
        // the hole through `safeIdentifier` while keeping the literal quotes.
        opLabel`server-tool skill "${name}"`,
      );
      if (result.mutation) {
        ctx.usage.committedMutations += 1;
        yield { type: 'state-mutation', ...createMutationEnvelope(result.mutation) };
      }
      return {
        kind: 'result',
        output: result.output,
        nextState: reconcileSkillNextState(currentState, result),
      };
    } catch (skillErr) {
      // A server-tool skill's `execute` is HOST code: its throw is exactly as likely
      // to carry credentials, SQL, and internal hostnames as a driver error, so it is
      // redacted rather than relayed. The `withTimeout` deadline above is
      // package-authored and still reaches the model verbatim.
      return {
        kind: 'result',
        output: JSON.stringify({
          error: redactedHostError(
            name,
            `the server-tool skill "${safeIdentifier(name)}"`,
            skillErr,
            ctx,
          ),
        }),
      };
    }
  }

  // query_data_source — resolved via the app-provided data config, dispatched
  // through the SAME `createDataToolHandlers` factory the MCP transport uses,
  // so both transports run the identical structured-query pipeline.
  //
  // SECURITY — trust boundary specific to THIS (chat) transport: `currentState`
  // (and therefore `currentState.runtime.dataSources[sourceId].tableName`, which
  // `resolveSource` in `mcp/queryTools.ts` resolves `sourceId` to) descends from
  // the CLIENT-SUPPLIED request body (`body.dashboardState` in `handleAIChat`),
  // not from server-held state. `resolveSource` only checks that `sourceId` is a
  // key present in that client-supplied catalog — it does NOT prove the resulting
  // `tableName` is a table the caller is actually allowed to query. A hostile
  // caller can submit a `dashboardState` whose `runtime.dataSources` fabricates an
  // entry pointing an innocuous-looking `sourceId` at an arbitrary table your DB
  // connection can reach. The MCP transport does not share this gap: its state box
  // is server-held, never request-supplied.
  //
  // This branch is therefore FAIL-CLOSED by default (finding F1): when the host has
  // not configured `StudioAIDataConfig.allowedTables`, it refuses to resolve any
  // source rather than trusting the client-supplied catalog. A host opts in with an
  // explicit `allowedTables` array (validated inside `resolveSource`).
  //
  // The literal `'*'` sentinel skips that check entirely, and means exactly ONE thing:
  // the host's `queryDataSource` implementation independently re-derives the physical
  // table from its own server-held mapping and IGNORES `params.tableName`. It is not a
  // "this deployment is trusted" switch — the untrusted input here is the request body,
  // not the operator — so a host that sets `'*'` while still passing `params.tableName`
  // to its query builder has removed the only check standing between a hostile body and
  // an arbitrary table its DB connection can reach.
  if (name === 'query_data_source') {
    // `query_data_source` is SIDE-EFFECTFUL (runs a live query) but never mutates
    // dashboard state, so the policy is consulted args-only BEFORE it runs
    // (`mayMutate` omitted), never as a post-hoc dry-run. A throw from the host policy
    // becomes a redacted `denied` rather than escaping the loop; see
    // `consultToolPolicyArgsOnlyGuarded`.
    const gate = await consultToolPolicyArgsOnlyGuarded(name, toolInput, currentState, ctx, false);
    if (gate.kind === 'denied') {
      return { kind: 'result', output: JSON.stringify({ error: gate.reason }) };
    }
    if (gate.kind === 'needs-approval') {
      const displayInput = buildApprovalDisplayInput(name, toolInput, currentState);
      // `query_data_source` never mutates dashboard state, so there are no structural
      // effects to summarize.
      const approval = yield* runApprovalFlow(
        tc.id,
        name,
        displayInput,
        undefined,
        ctx,
        gate.reason,
      );
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
      } else if (ctx.data.allowedTables === undefined) {
        // Finding F1 (Tier 1): FAIL-CLOSED table scoping on the chat transport. Here
        // `currentState.runtime.dataSources` descends from the CLIENT-SUPPLIED request
        // body, so trusting an omitted allowlist would let a hostile caller point an
        // innocuous `sourceId` at any table the DB connection can reach and have the
        // model query it. Refuse to resolve ANY source until the host declares its
        // intent — an explicit `allowedTables` array, or the literal `'*'` opt-out for a
        // `queryDataSource` that re-derives the physical table itself. The MCP transport
        // (server-held state) is unaffected: it never routes through this dispatch branch.
        output = JSON.stringify({
          error:
            'query_data_source is disabled: this server has not configured a table allowlist. ' +
            'On the chat transport the data-source catalog comes from the client-supplied request, ' +
            'so tables cannot be resolved safely without one. The host must set ' +
            '`StudioAIDataConfig.allowedTables` to the tables the assistant may query, or to the ' +
            "literal '*' — which is only safe when its `queryDataSource` implementation re-derives " +
            'the physical table from server-held configuration and ignores `params.tableName`.',
        });
      } else {
        // `createDataToolHandlers` redacts a host/DB failure (finding H4): it writes the
        // full detail to its `logger` and returns only a correlation id to the model. The
        // chat transport has no logger of its own, so without this sink the detail would be
        // dropped entirely and the reference id in the model-visible message would point at
        // nothing an operator could look up. Capture it and hand it to the host's
        // server-side `onToolError` callback — the one server-side error channel this
        // transport does have.
        let hostErrorDetail: string | undefined;
        const handlers = createDataToolHandlers({
          stateBox: { current: currentState },
          data: ctx.data,
          maxQueryRows: sanitizeMaxQueryRows(ctx.data.maxQueryRows),
          recentChanges: [],
          logger: {
            log: () => {},
            error: (...args: unknown[]) => {
              // `asString` (finding H1) — see `redactedHostError`'s sink above.
              hostErrorDetail = args.map((a) => asString(a)).join(' ');
            },
          },
        });
        const result = await withTimeout(
          Promise.resolve(handlers.query_data_source(toolInput as Record<string, unknown>)),
          QUERY_DATA_SOURCE_TIMEOUT_MS,
          'query_data_source',
        );
        const textItem = result.content.find(
          (item): item is { type: 'text'; text: string } => item.type === 'text',
        );
        output = textItem?.text ?? JSON.stringify(result);
        if (result.isError) {
          // Full detail to the host callback (server-side); only `output` — already
          // redacted by the handler — reaches the model and the browser.
          ctx.onToolError?.(name, new Error(hostErrorDetail ?? extractToolErrorMessage(output)));
        }
      }
    } catch (queryErr) {
      // Anything escaping the handler above crossed the host boundary (a rejected
      // `data.queryDataSource`, a driver error) or is the package-authored
      // `withTimeout` deadline. `redactedHostError` withholds the former behind a
      // correlation reference and relays the latter verbatim.
      output = JSON.stringify({
        error: redactedHostError(name, 'query_data_source', queryErr, ctx),
      });
    }
    return { kind: 'result', output };
  }

  // Skill was declared in the request but has no registered server handler.
  const isUnregisteredSkillTool = (ctx.skills ?? [])
    .filter((s) => s.mode === 'server-tool' && s.tool)
    .some((s) => s.tool!.name === name);

  if (isUnregisteredSkillTool) {
    // Finding F3 (Tier 2): same accounting rationale as the parse-failure and
    // unadvertised-tool early returns above — this happens before any policy
    // consult increments `usage.toolCalls`, so a skill declared in `body.skills`
    // with no `skillHandlers` entry would otherwise dispatch for free against the
    // budget; a model stuck retrying it could do so unboundedly without ever
    // tripping `maxToolCallsPerRequest`.
    ctx.usage.toolCalls += 1;
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
  // Built INSIDE the try below (finding H1). These were computed after it, so a throw
  // from either — `buildApprovalDisplayInput` used the non-total `String()` on raw
  // model arguments — escaped `dispatchToolCall`, escaped the `while (true) { await
  // dispatch.next() }` driver in `agenticLoop.ts` (whose enclosing try covers only the
  // SSE read loop, which has already exited by then), and killed the stream with one
  // generic error frame. Both are display-only enrichment of an approval prompt;
  // neither is worth a terminated request, so they now fail the same recoverable,
  // redacted way every other step on this path does.
  let displayInput: unknown;
  let effectsSummary: ApprovalEffectsSummary | undefined;
  try {
    outcome = await executeToolWithPolicy(name, toolInput, currentState, {
      policy: ctx.toolPolicy,
      preCheckPolicy: ctx.budgetPolicy,
      customWidgets: ctx.customWidgets,
      pageSnapshot: ctx.pageSnapshot,
      snapshotPageId: ctx.snapshotPageId,
      privateMode: ctx.privateMode,
      transport: 'chat',
      usage: ctx.usage,
      // Same rationale as the args-only consult above: the deadline bounds a host policy
      // that never settles, the signal makes an abandoned request stop waiting at once.
      signal: ctx.signal,
    });
    if (outcome.kind === 'needs-approval') {
      // The human-facing approval display must reflect the real target from state,
      // not a title the (possibly prompt-injected) model chose. See
      // `buildApprovalDisplayInput`.
      displayInput = buildApprovalDisplayInput(name, toolInput, currentState);
      // T2-2: attach a state-derived structural-effects summary (which widgets/pages/filters
      // get removed, which widgets get orphaned) so the human isn't approving a layout op
      // blind. `outcome.effects` is always present on the built-in needs-approval path.
      effectsSummary = buildApprovalEffectsSummary(outcome.effects, currentState);
    }
  } catch (err) {
    // `executeToolOnState` is pure and never throws by design, so anything caught here
    // is either a throw from the HOST `toolPolicy` (`Policy.all` awaits it with no
    // try/catch) or an internal defect. Neither is safe to relay: the first is host
    // code whose message leaks exactly like a driver error, and the second is a raw
    // stack-bearing `TypeError`. Both are redacted, and the call still surfaces to the
    // model as a recoverable tool result rather than killing the stream.
    return {
      kind: 'result',
      output: JSON.stringify({
        error: redactedHostError(name, `the tool "${safeIdentifier(name)}"`, err, ctx),
      }),
    };
  }

  if (outcome.kind === 'denied') {
    return { kind: 'result', output: JSON.stringify({ error: outcome.reason }) };
  }

  if (outcome.kind === 'needs-approval') {
    const approval = yield* runApprovalFlow(
      tc.id,
      name,
      displayInput,
      effectsSummary,
      ctx,
      outcome.reason,
    );
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
