/**
 * OpenAI wire-format helpers for the x-studio-ai-middleware agentic loop.
 *
 * Pure wire-format transformation with zero security surface: the OpenAI
 * chat-completions message shapes, the `ChatMessage` → `OpenAIMessage[]`
 * serialiser, and the streamed tool-call delta accumulator. Extracted from
 * `agenticLoop.ts` verbatim.
 */
import type { ChatMessage } from '@mui/x-chat-headless';
import { markPackageAuthored } from '../internal/packageError';

// ── OpenAI message types ──────────────────────────────────────────────────────

export interface OpenAIUserMessage {
  role: 'user';
  content: string;
}

export interface OpenAIAssistantMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
    extra_content?: unknown;
  }>;
}

export interface OpenAIToolResultMessage {
  role: 'tool';
  tool_call_id: string;
  content: string;
}

export interface OpenAISystemMessage {
  role: 'system';
  content: string;
}

export type OpenAIMessage =
  | OpenAISystemMessage
  | OpenAIUserMessage
  | OpenAIAssistantMessage
  | OpenAIToolResultMessage;

// ── Conversation serialisation ────────────────────────────────────────────────

export function toOpenAIMessages(systemPrompt: string, messages: ChatMessage[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = [{ role: 'system', content: systemPrompt }];

  for (const msg of messages) {
    const textParts = msg.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');

    const toolParts = msg.parts.filter((p) => p.type === 'dynamic-tool') as Array<{
      type: 'dynamic-tool';
      toolInvocation: {
        toolCallId: string;
        toolName: string;
        input: unknown;
        output: unknown;
        state: string;
      };
    }>;

    if (msg.role === 'user') {
      if (textParts) {
        result.push({ role: 'user', content: textParts });
      }
    } else if (msg.role === 'assistant') {
      if (toolParts.length > 0) {
        result.push({
          // Preserve any assistant text alongside the tool calls — OpenAI allows a
          // `tool_calls` message to also carry `content`, and dropping it loses the
          // model's own reasoning/commentary from the replayed history.
          role: 'assistant',
          content: textParts || null,
          tool_calls: toolParts.map((p) => ({
            id: p.toolInvocation.toolCallId,
            type: 'function' as const,
            function: {
              name: p.toolInvocation.toolName,
              arguments: JSON.stringify(p.toolInvocation.input ?? {}),
            },
          })),
        });
        for (const p of toolParts) {
          // OpenAI requires every `tool_calls` entry to be followed by a matching
          // tool message. A result that is still pending (`output === undefined`)
          // would otherwise be skipped, leaving an unmatched tool call and a 400 on
          // the next turn — emit a placeholder result instead of dropping it.
          result.push({
            role: 'tool',
            tool_call_id: p.toolInvocation.toolCallId,
            content:
              p.toolInvocation.output !== undefined
                ? JSON.stringify(p.toolInvocation.output)
                : JSON.stringify({ status: 'unknown' }),
          });
        }
      } else if (textParts) {
        result.push({ role: 'assistant', content: textParts });
      }
    }
  }

  return result;
}

// ── Tool-call delta accumulation ──────────────────────────────────────────────

export interface AccumulatedToolCall {
  id: string;
  name: string;
  argsBuffer: string;
  extra_content?: unknown;
}

export interface ToolCallAccumulator {
  reqToolCalls: Record<number, AccumulatedToolCall>;
  idToIdx: Record<string, number>;
  nextAutoIdx: number;
}

export interface ToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
  extra_content?: unknown;
}

/**
 * Seed for synthetic indices assigned to id-only tool-call deltas.
 *
 * Providers key streamed tool-call fragments either by a numeric `index` or by an
 * `id`. For id-only deltas we mint our own index; seeding from a high, disjoint
 * range (rather than `0`) guarantees a synthetic index can never collide with a
 * real provider-supplied `index: 0` in a mixed stream, which would otherwise merge
 * two distinct calls' fragments.
 */
export const SYNTHETIC_INDEX_BASE = 1_000_000;

/**
 * Seed for synthetic indices assigned to tool-call deltas that carry NEITHER an
 * `index` NOR an `id`, which otherwise fall back to their bare position (`i`)
 * within the current chunk's `tool_calls` array.
 *
 * Offset from `SYNTHETIC_INDEX_BASE` (rather than reusing it, or using raw `i`) so
 * this positional fallback can't collide with either a real provider-supplied
 * `index` in the same 0..n range OR an id-only delta's synthetic index — both of
 * which would otherwise wrongly merge two distinct tool calls' fragments into one
 * slot.
 */
export const POSITIONAL_INDEX_BASE = 2_000_000;

/**
 * True only for a value that is genuinely usable as a tool-call slot key.
 *
 * `ToolCallDelta.index` is TYPED `number`, but it is raw JSON straight off the
 * provider's wire — this package's threat model explicitly includes a
 * hostile/compromised OpenAI-compatible gateway (the same actor
 * {@link MAX_TOOL_CALL_ARGS_BUFFER_CHARS}, {@link MAX_TOOL_CALLS_PER_TURN} and
 * `parseSSE`'s buffer cap already defend against). A delta carrying
 * `index: "__proto__"` previously flowed straight into `acc.reqToolCalls[idx]`:
 * the lookup resolved to `Object.prototype` (truthy, so the slot-count cap never
 * tripped) and the subsequent `.id`/`.name`/`.argsBuffer` writes landed on
 * `Object.prototype` itself — permanent, process-wide prototype pollution
 * affecting every object in the host app, with the tool call silently dropped on
 * top. Rejecting a non-integer `index` here makes the delta fall through to the
 * id-based / positional path, which mints a safe synthetic index instead.
 *
 * The RANGE check (finding L7) is what makes {@link SYNTHETIC_INDEX_BASE} and
 * {@link POSITIONAL_INDEX_BASE} deliver the non-collision their own doc comments
 * promise. They were only disjoint from a WELL-BEHAVED provider's `0..n` indices: a
 * gateway sending `index: 2000000` landed in the positional fallback's range and merged
 * its fragments with a genuinely position-keyed call's, and `index: 1000000` did the
 * same to an id-keyed one — the exact "two distinct calls' fragments merged into one
 * slot" outcome those constants exist to rule out. Accepting only `0 <= index <
 * SYNTHETIC_INDEX_BASE` makes the three ranges disjoint BY CONSTRUCTION rather than by
 * assumption; an out-of-range `index` is treated like an absent one and falls through
 * to the id/positional path, which is exactly where a value we refuse to trust belongs.
 * A negative index is rejected for the same reason it is meaningless on the wire.
 */
function isUsableToolCallIndex(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < SYNTHETIC_INDEX_BASE
  );
}

/**
 * True only for a non-empty string, the type every textual field on this wire is
 * declared as and none of them is guaranteed to be (invariant 15).
 *
 * `id` keys `idToIdx`, becomes the OpenAI `tool_calls[].id`, addresses the shared
 * `approvalPending` map, and is echoed to the browser as `toolCallId`; `function.name`
 * is matched against `advertisedToolNames`; `function.arguments` is concatenated and
 * `JSON.parse`d. Each was previously used on a bare truthiness check, so a non-string
 * rode through implicit `+`/key coercion into all of those positions.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Hard ceiling (chars, ~bytes for the JSON text a provider streams) on a single tool
 * call's accumulated `argsBuffer` (finding 6, iteration 24). Nothing else in the
 * agentic loop bounds this: unlike the per-request token/turn/mutation budgets in
 * `agenticLoop.ts`, a tool call's arguments stream until the provider itself signals
 * the call is complete, so a misbehaving/malicious gateway that keeps emitting
 * `function.arguments` deltas for the SAME tool call without ever finishing it could
 * grow this buffer (and this process's memory) without bound within one request.
 * Sized generously — 1,000,000 chars is far beyond the largest legitimate built-in
 * tool call's arguments (e.g. `apply_bulk_update` with hundreds of widget removals) —
 * so this only ever trips for a genuinely runaway stream.
 */
export const MAX_TOOL_CALL_ARGS_BUFFER_CHARS = 1_000_000;

/**
 * Hard ceiling on the number of DISTINCT tool-call slots (`reqToolCalls` entries)
 * a single turn's accumulator may hold (finding T2-1, iteration 25). Nothing else
 * bounds this: `accumulateToolCallDeltas` mints a new `reqToolCalls[idx]` entry for
 * every distinct `index` (or synthetic id-based / positional index) a delta
 * carries, so a misbehaving/malicious gateway that streams deltas for indices
 * `0..10^7` — never repeating one — grows this accumulator (and this process's
 * memory) without bound within a single turn, the same threat model that motivated
 * `MAX_TOOL_CALL_ARGS_BUFFER_CHARS` above and `MAX_TURN_TEXT_BUFFER_CHARS` in
 * `agenticLoop.ts`, just bounding the NUMBER of tool calls rather than the size of
 * one. It also caps the real per-entry work the dispatch loop performs afterward
 * (two SSE `tool-activity` events plus a tool-result message per entry). Sized
 * generously — 1,000 distinct tool calls in a single LLM turn is far beyond any
 * legitimate response — so this only ever trips for a genuinely runaway stream.
 */
export const MAX_TOOL_CALLS_PER_TURN = 1_000;

/**
 * Both maps are `Object.create(null)` (NOT `{}`) because every key written into
 * them is derived from provider-supplied wire data: `reqToolCalls` is keyed by
 * `tool_calls[].index` and `idToIdx` by `tool_calls[].id`. With an ordinary object
 * literal, a key of `"__proto__"`/`"constructor"` resolves through the prototype
 * chain — the lookup returns a truthy inherited value, the "mint a new slot" branch
 * (and therefore {@link MAX_TOOL_CALLS_PER_TURN}) is skipped, and the writes below
 * land on `Object.prototype`/`Object` instead of the accumulator. A null-prototype
 * map has no inherited members at all, so such a key can only ever address its own
 * ordinary slot. This is defense-in-depth alongside {@link isUsableToolCallIndex},
 * which already rejects a non-integer `index` up front.
 */
export function createToolCallAccumulator(): ToolCallAccumulator {
  return {
    reqToolCalls: Object.create(null) as Record<number, AccumulatedToolCall>,
    idToIdx: Object.create(null) as Record<string, number>,
    nextAutoIdx: SYNTHETIC_INDEX_BASE,
  };
}

/**
 * Merges a chunk's `tool_calls` deltas into the accumulator, resolving each
 * fragment to a stable slot by `index`, then by `id` (synthetic index), then by
 * position. Mutates `acc` in place.
 */
export function accumulateToolCallDeltas(deltas: ToolCallDelta[], acc: ToolCallAccumulator): void {
  for (const [i, tcRaw] of deltas.entries()) {
    // A delta entry itself is provider JSON: `tool_calls: [null]` used to throw a bare
    // `TypeError` on `tc.index`, which the caller's catch then reported to the browser as
    // a transport failure ("the provider was unreachable") of a provider that was, in
    // fact, streaming. Skip a non-object entry instead.
    if (tcRaw === null || typeof tcRaw !== 'object') {
      continue;
    }
    const tc = tcRaw as ToolCallDelta;
    // Every textual field is re-derived through `isNonEmptyString` rather than used
    // straight off `tc`, so the checks below can't be skipped by a later edit.
    const tcId = isNonEmptyString(tc.id) ? tc.id : undefined;
    const fn = tc.function;
    const fnName =
      fn !== null && typeof fn === 'object' && isNonEmptyString(fn.name) ? fn.name : undefined;
    const fnArgs =
      fn !== null && typeof fn === 'object' && isNonEmptyString(fn.arguments)
        ? fn.arguments
        : undefined;
    let idx: number;
    const tcIndex = tc.index;
    // Only a genuine integer `index` may be used as a slot key (see
    // `isUsableToolCallIndex`). Anything else — `"__proto__"`, `"constructor"`, a
    // float, `NaN`, an object — falls through to the id-based / positional path
    // below, which mints a safe synthetic index.
    if (isUsableToolCallIndex(tcIndex)) {
      idx = tcIndex;
    } else if (tcId !== undefined) {
      if (acc.idToIdx[tcId] !== undefined) {
        idx = acc.idToIdx[tcId];
      } else {
        idx = acc.nextAutoIdx;
        acc.idToIdx[tcId] = idx;
        acc.nextAutoIdx += 1;
      }
    } else {
      // No `index` and no `id` — fall back to array position, offset by
      // `POSITIONAL_INDEX_BASE` so it can't collide with a real `index` or a
      // synthetic id-based index (see that constant's doc comment).
      idx = POSITIONAL_INDEX_BASE + i;
    }
    if (!acc.reqToolCalls[idx]) {
      // Finding T2-1 — bound the NUMBER of distinct tool-call slots this turn's
      // accumulator may hold. Checked before minting a NEW slot (an update to an
      // existing slot never grows the count), and thrown here — rather than
      // silently dropped or truncated — so the caller's enclosing try/catch turns
      // this into a clean `{ type: 'error' }` SSE event, exactly like the
      // `argsBuffer`/turn-text-buffer caps this mirrors, instead of a slow,
      // unbounded memory leak plus unbounded per-entry dispatch-loop work.
      if (Object.keys(acc.reqToolCalls).length >= MAX_TOOL_CALLS_PER_TURN) {
        // Branded for the same reason as the buffer cap in `parseSSE`: this is OUR limit
        // firing on a provider that is responding, so relaying it verbatim is what keeps
        // the browser from being told the provider was unreachable.
        throw markPackageAuthored(
          new Error(
            `MUI X Studio: A single turn's streamed tool calls exceeded the maximum count ` +
              `(${MAX_TOOL_CALLS_PER_TURN}). This can happen when a misbehaving gateway streams ` +
              'tool-call deltas for an unbounded number of distinct indices, which would otherwise ' +
              "let a single request grow this process's memory (and per-call dispatch work) without " +
              'bound. Aborting this request.',
          ),
        );
      }
      acc.reqToolCalls[idx] = { id: tcId ?? '', name: '', argsBuffer: '' };
    }
    if (tcId !== undefined) {
      acc.reqToolCalls[idx].id = tcId;
    }
    if (tc.extra_content) {
      acc.reqToolCalls[idx].extra_content = tc.extra_content;
    }
    if (fnName !== undefined) {
      const existingName = acc.reqToolCalls[idx].name;
      // Some gateways resend the tool's COMPLETE function name on every chunk
      // instead of streaming it incrementally. Naively concatenating would turn
      // e.g. "remove_page" into "remove_pageremove_page". If the incoming
      // fragment exactly matches what has already been accumulated, treat it as
      // a repeated full resend rather than a new incremental fragment and don't
      // append it again. A genuinely incremental fragment (the common case)
      // never equals the name accumulated so far, so this never drops a real
      // fragment.
      //
      // KNOWN LIMITATION (accepted best-effort heuristic): this rule is imprecise in
      // the pathological case where a genuinely incremental fragment happens to be
      // textually IDENTICAL to the prefix accumulated so far (e.g. name "aaaa" streamed
      // as "aa" + "aa" — the second "aa" fragment would be wrongly dropped as a
      // "resend"). No real registered tool name (`STUDIO_AI_TOOLS`) has this
      // self-repeating structure at any plausible chunk boundary, so this never
      // misfires in practice; there is no cheaper/more precise signal available here
      // (no resend flag or expected-total-length hint on the wire) to distinguish the
      // two cases in general, so this stays a deliberate best-effort tradeoff rather
      // than a bug fix.
      if (existingName !== fnName) {
        acc.reqToolCalls[idx].name += fnName;
      }
    }
    if (fnArgs !== undefined) {
      const nextArgsBuffer = acc.reqToolCalls[idx].argsBuffer + fnArgs;
      // Finding 6 — bound `argsBuffer` growth per tool call. Thrown here (rather than
      // silently truncated) so the caller's enclosing try/catch turns this into a
      // clean `{ type: 'error' }` SSE event, exactly like the idle-timeout and
      // turn-text-buffer caps this mirrors, instead of a slow, unbounded memory leak.
      if (nextArgsBuffer.length > MAX_TOOL_CALL_ARGS_BUFFER_CHARS) {
        // Branded — same reason as the tool-call count cap above.
        throw markPackageAuthored(
          new Error(
            `MUI X Studio: A streamed tool call's arguments exceeded the maximum buffered size ` +
              `(${MAX_TOOL_CALL_ARGS_BUFFER_CHARS} chars). This can happen when a misbehaving gateway ` +
              "streams a tool call's argument deltas without ever completing the call, which would " +
              "otherwise let a single request grow this process's memory without bound. Aborting this request.",
          ),
        );
      }
      acc.reqToolCalls[idx].argsBuffer = nextArgsBuffer;
    }
  }
}
