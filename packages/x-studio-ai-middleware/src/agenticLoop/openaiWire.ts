/**
 * OpenAI wire-format helpers for the x-studio-ai-middleware agentic loop.
 *
 * Pure wire-format transformation with zero security surface: the OpenAI
 * chat-completions message shapes, the `ChatMessage` → `OpenAIMessage[]`
 * serialiser, and the streamed tool-call delta accumulator. Extracted from
 * `agenticLoop.ts` verbatim.
 */
import type { ChatMessage } from '@mui/x-chat-headless';

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

export function createToolCallAccumulator(): ToolCallAccumulator {
  return { reqToolCalls: {}, idToIdx: {}, nextAutoIdx: SYNTHETIC_INDEX_BASE };
}

/**
 * Merges a chunk's `tool_calls` deltas into the accumulator, resolving each
 * fragment to a stable slot by `index`, then by `id` (synthetic index), then by
 * position. Mutates `acc` in place.
 */
export function accumulateToolCallDeltas(deltas: ToolCallDelta[], acc: ToolCallAccumulator): void {
  for (const [i, tc] of deltas.entries()) {
    let idx: number;
    const tcIndex = tc.index;
    if (tcIndex !== undefined) {
      idx = tcIndex;
    } else if (tc.id) {
      if (acc.idToIdx[tc.id] !== undefined) {
        idx = acc.idToIdx[tc.id];
      } else {
        idx = acc.nextAutoIdx;
        acc.idToIdx[tc.id] = idx;
        acc.nextAutoIdx += 1;
      }
    } else {
      // No `index` and no `id` — fall back to array position, offset by
      // `POSITIONAL_INDEX_BASE` so it can't collide with a real `index` or a
      // synthetic id-based index (see that constant's doc comment).
      idx = POSITIONAL_INDEX_BASE + i;
    }
    if (!acc.reqToolCalls[idx]) {
      acc.reqToolCalls[idx] = { id: tc.id ?? '', name: '', argsBuffer: '' };
    }
    if (tc.id) {
      acc.reqToolCalls[idx].id = tc.id;
    }
    if (tc.extra_content) {
      acc.reqToolCalls[idx].extra_content = tc.extra_content;
    }
    if (tc.function?.name) {
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
      if (existingName !== tc.function.name) {
        acc.reqToolCalls[idx].name += tc.function.name;
      }
    }
    if (tc.function?.arguments) {
      acc.reqToolCalls[idx].argsBuffer += tc.function.arguments;
    }
  }
}
