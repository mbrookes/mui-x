/**
 * Unit tests for the OpenAI wire-format helpers extracted from `agenticLoop.ts`.
 *
 * These cover the message serialiser and the streamed tool-call delta accumulator
 * directly, independent of the agentic loop that consumes them.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { ChatMessage } from '@mui/x-chat-headless';
import {
  toOpenAIMessages,
  createToolCallAccumulator,
  accumulateToolCallDeltas,
  SYNTHETIC_INDEX_BASE,
  POSITIONAL_INDEX_BASE,
  MAX_TOOL_CALL_ARGS_BUFFER_CHARS,
  MAX_TOOL_CALLS_PER_TURN,
  type ToolCallDelta,
} from './openaiWire';

function userMsg(text: string): ChatMessage {
  return {
    id: `msg-${Math.random()}`,
    role: 'user',
    parts: [{ type: 'text', text }],
  } as unknown as ChatMessage;
}

function assistantTextMsg(text: string): ChatMessage {
  return {
    id: `msg-${Math.random()}`,
    role: 'assistant',
    parts: [{ type: 'text', text }],
  } as unknown as ChatMessage;
}

function assistantToolMsg(
  text: string,
  tools: Array<{ toolCallId: string; toolName: string; input: unknown; output: unknown }>,
): ChatMessage {
  return {
    id: `msg-${Math.random()}`,
    role: 'assistant',
    parts: [
      ...(text ? [{ type: 'text', text }] : []),
      ...tools.map((t) => ({
        type: 'dynamic-tool',
        toolInvocation: {
          toolCallId: t.toolCallId,
          toolName: t.toolName,
          input: t.input,
          output: t.output,
          state: 'output-available',
        },
      })),
    ],
  } as unknown as ChatMessage;
}

describe('toOpenAIMessages', () => {
  it('prepends the system prompt as the first message', () => {
    const result = toOpenAIMessages('SYS', []);
    expect(result).toEqual([{ role: 'system', content: 'SYS' }]);
  });

  it('serialises a user text message', () => {
    const result = toOpenAIMessages('SYS', [userMsg('hello')]);
    expect(result).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('drops user messages with no text parts', () => {
    const empty = { id: 'x', role: 'user', parts: [] } as unknown as ChatMessage;
    const result = toOpenAIMessages('SYS', [empty]);
    expect(result).toEqual([{ role: 'system', content: 'SYS' }]);
  });

  it('serialises an assistant text-only message', () => {
    const result = toOpenAIMessages('SYS', [assistantTextMsg('hi there')]);
    expect(result).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'assistant', content: 'hi there' },
    ]);
  });

  it('emits assistant tool_calls followed by a matching tool result message', () => {
    const result = toOpenAIMessages('SYS', [
      assistantToolMsg('', [
        { toolCallId: 'call_1', toolName: 'list_pages', input: { a: 1 }, output: { ok: true } },
      ]),
    ]);
    expect(result).toEqual([
      { role: 'system', content: 'SYS' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'list_pages', arguments: JSON.stringify({ a: 1 }) },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: JSON.stringify({ ok: true }) },
    ]);
  });

  it('preserves assistant commentary text alongside tool calls', () => {
    const result = toOpenAIMessages('SYS', [
      assistantToolMsg('thinking...', [{ toolCallId: 'c', toolName: 't', input: {}, output: 'r' }]),
    ]);
    const assistant = result[1] as { role: string; content: string | null };
    expect(assistant.content).toBe('thinking...');
  });

  it('emits a placeholder tool result when the output is still pending', () => {
    const result = toOpenAIMessages('SYS', [
      assistantToolMsg('', [
        { toolCallId: 'call_pending', toolName: 't', input: {}, output: undefined },
      ]),
    ]);
    const toolResult = result[2] as { role: string; content: string };
    expect(toolResult.role).toBe('tool');
    expect(toolResult.content).toBe(JSON.stringify({ status: 'unknown' }));
  });

  it('defaults missing tool input to an empty object in the arguments', () => {
    const result = toOpenAIMessages('SYS', [
      assistantToolMsg('', [{ toolCallId: 'c', toolName: 't', input: undefined, output: 'x' }]),
    ]);
    const assistant = result[1] as { tool_calls: Array<{ function: { arguments: string } }> };
    expect(assistant.tool_calls[0].function.arguments).toBe('{}');
  });
});

describe('createToolCallAccumulator', () => {
  it('starts empty with nextAutoIdx seeded from SYNTHETIC_INDEX_BASE', () => {
    const acc = createToolCallAccumulator();
    expect(acc.reqToolCalls).toEqual({});
    expect(acc.idToIdx).toEqual({});
    expect(acc.nextAutoIdx).toBe(SYNTHETIC_INDEX_BASE);
  });

  it('exposes SYNTHETIC_INDEX_BASE as a high disjoint seed', () => {
    expect(SYNTHETIC_INDEX_BASE).toBe(1_000_000);
  });
});

describe('accumulateToolCallDeltas', () => {
  it('accumulates a single index-keyed tool call across chunks', () => {
    const acc = createToolCallAccumulator();
    accumulateToolCallDeltas(
      [{ index: 0, id: 'tc_1', function: { name: 'list_', arguments: '{"a"' } }],
      acc,
    );
    accumulateToolCallDeltas([{ index: 0, function: { name: 'pages', arguments: ':1}' } }], acc);
    expect(acc.reqToolCalls[0]).toEqual({
      id: 'tc_1',
      name: 'list_pages',
      argsBuffer: '{"a":1}',
    });
  });

  it('mints a synthetic index for id-only deltas and reuses it for the same id', () => {
    const acc = createToolCallAccumulator();
    accumulateToolCallDeltas([{ id: 'tc_a', function: { name: 'foo' } }], acc);
    accumulateToolCallDeltas([{ id: 'tc_a', function: { arguments: '{}' } }], acc);
    expect(acc.idToIdx.tc_a).toBe(SYNTHETIC_INDEX_BASE);
    expect(acc.nextAutoIdx).toBe(SYNTHETIC_INDEX_BASE + 1);
    expect(acc.reqToolCalls[SYNTHETIC_INDEX_BASE]).toEqual({
      id: 'tc_a',
      name: 'foo',
      argsBuffer: '{}',
    });
  });

  it('keeps two distinct id-only calls in separate synthetic slots', () => {
    const acc = createToolCallAccumulator();
    accumulateToolCallDeltas(
      [
        { id: 'tc_a', function: { name: 'a', arguments: '{}' } },
        { id: 'tc_b', function: { name: 'b', arguments: '{}' } },
      ],
      acc,
    );
    expect(Object.keys(acc.reqToolCalls)).toHaveLength(2);
    expect(acc.idToIdx.tc_a).toBe(SYNTHETIC_INDEX_BASE);
    expect(acc.idToIdx.tc_b).toBe(SYNTHETIC_INDEX_BASE + 1);
  });

  it('never lets a synthetic index collide with a provider index: 0', () => {
    const acc = createToolCallAccumulator();
    accumulateToolCallDeltas(
      [
        { index: 0, id: 'real', function: { name: 'real', arguments: '{}' } },
        { id: 'idonly', function: { name: 'synthetic', arguments: '{}' } },
      ],
      acc,
    );
    expect(acc.reqToolCalls[0].name).toBe('real');
    expect(acc.reqToolCalls[SYNTHETIC_INDEX_BASE].name).toBe('synthetic');
  });

  it('falls back to a positional index (offset by POSITIONAL_INDEX_BASE) when a delta has neither index nor id', () => {
    const acc = createToolCallAccumulator();
    accumulateToolCallDeltas([{ function: { name: 'x', arguments: '{}' } }], acc);
    // Offset from POSITIONAL_INDEX_BASE (not raw array position `0`) so this
    // fallback can't collide with a real provider `index: 0` in the same stream.
    expect(acc.reqToolCalls[POSITIONAL_INDEX_BASE]).toEqual({
      id: '',
      name: 'x',
      argsBuffer: '{}',
    });
    expect(acc.reqToolCalls[0]).toBeUndefined();
  });

  it('exposes POSITIONAL_INDEX_BASE as a seed disjoint from SYNTHETIC_INDEX_BASE', () => {
    expect(POSITIONAL_INDEX_BASE).toBe(2_000_000);
    expect(POSITIONAL_INDEX_BASE).toBeGreaterThan(SYNTHETIC_INDEX_BASE);
  });

  it('never lets a positional fallback index collide with a real provider index', () => {
    const acc = createToolCallAccumulator();
    // A no-index/no-id delta at array position 0, plus a real `index: 0` tool call
    // in the SAME chunk — without the offset these would merge into one slot.
    accumulateToolCallDeltas(
      [
        { function: { name: 'x', arguments: '{}' } },
        { index: 0, id: 'real', function: { name: 'real_tool', arguments: '{}' } },
      ],
      acc,
    );
    expect(acc.reqToolCalls[0]).toEqual({ id: 'real', name: 'real_tool', argsBuffer: '{}' });
    expect(acc.reqToolCalls[POSITIONAL_INDEX_BASE]).toEqual({
      id: '',
      name: 'x',
      argsBuffer: '{}',
    });
  });

  // Finding L7 — the two bases were documented as guaranteeing no collision, but they
  // only guaranteed it against a WELL-BEHAVED provider's 0..n indices. A hostile gateway
  // that simply names an index inside a reserved range walked straight into the
  // fallback's slot and merged two distinct calls' fragments — the exact outcome the
  // constants exist to rule out. The ranges are now disjoint by construction.
  it('rejects a provider index inside the reserved positional-fallback range', () => {
    const acc = createToolCallAccumulator();
    accumulateToolCallDeltas(
      [
        // Hostile: names the slot the positional fallback below would take.
        { index: POSITIONAL_INDEX_BASE, function: { name: 'hostile', arguments: '{"a":1}' } },
        { function: { name: 'genuine', arguments: '{"b":2}' } },
      ],
      acc,
    );
    // The out-of-range index is treated as absent, so the hostile delta takes its OWN
    // positional slot (array position 0) rather than the genuine delta's (position 1).
    expect(acc.reqToolCalls[POSITIONAL_INDEX_BASE].name).toBe('hostile');
    expect(acc.reqToolCalls[POSITIONAL_INDEX_BASE + 1].name).toBe('genuine');
  });

  it('rejects a provider index inside the reserved synthetic (id-keyed) range', () => {
    const acc = createToolCallAccumulator();
    accumulateToolCallDeltas(
      [
        { id: 'tc_a', function: { name: 'id_keyed', arguments: '{"a":1}' } },
        // Hostile: names the slot the id-keyed call above was just given.
        { index: SYNTHETIC_INDEX_BASE, function: { name: 'hostile', arguments: '{"b":2}' } },
      ],
      acc,
    );
    // Un-merged: the id-keyed call keeps its synthetic slot untouched.
    expect(acc.reqToolCalls[SYNTHETIC_INDEX_BASE]).toEqual({
      id: 'tc_a',
      name: 'id_keyed',
      argsBuffer: '{"a":1}',
    });
    expect(acc.reqToolCalls[POSITIONAL_INDEX_BASE + 1].name).toBe('hostile');
  });

  it('rejects a negative provider index', () => {
    const acc = createToolCallAccumulator();
    accumulateToolCallDeltas([{ index: -1, function: { name: 'x', arguments: '{}' } }], acc);
    expect(acc.reqToolCalls[-1]).toBeUndefined();
    expect(acc.reqToolCalls[POSITIONAL_INDEX_BASE].name).toBe('x');
  });

  // Sibling sweep for finding M7: every textual field here is raw provider JSON, and
  // none of them was type-checked — a non-string rode through implicit coercion into the
  // `tool_call_id` on the wire, the `approvalPending` map key, and the browser-facing
  // `toolCallId`.
  it('ignores non-string id / name / arguments fields', () => {
    const acc = createToolCallAccumulator();
    accumulateToolCallDeltas(
      [
        {
          index: 0,
          id: { toString: () => 'forged' },
          function: { name: 42, arguments: { a: 1 } },
        } as unknown as Parameters<typeof accumulateToolCallDeltas>[0][number],
      ],
      acc,
    );
    expect(acc.reqToolCalls[0]).toEqual({ id: '', name: '', argsBuffer: '' });
  });

  it('skips a non-object delta entry instead of throwing', () => {
    const acc = createToolCallAccumulator();
    expect(() =>
      accumulateToolCallDeltas(
        [null, { index: 0, function: { name: 'x', arguments: '{}' } }] as Parameters<
          typeof accumulateToolCallDeltas
        >[0],
        acc,
      ),
    ).not.toThrow();
    expect(acc.reqToolCalls[0].name).toBe('x');
  });

  it('does not duplicate a function name a gateway resends in full on every chunk', () => {
    const acc = createToolCallAccumulator();
    accumulateToolCallDeltas([{ index: 0, function: { name: 'remove_page' } }], acc);
    accumulateToolCallDeltas([{ index: 0, function: { name: 'remove_page' } }], acc);
    expect(acc.reqToolCalls[0].name).toBe('remove_page');
  });

  it('still accumulates a genuinely incremental function name across chunks', () => {
    const acc = createToolCallAccumulator();
    accumulateToolCallDeltas([{ index: 0, function: { name: 'remove_' } }], acc);
    accumulateToolCallDeltas([{ index: 0, function: { name: 'page' } }], acc);
    expect(acc.reqToolCalls[0].name).toBe('remove_page');
  });

  it('records extra_content when present', () => {
    const acc = createToolCallAccumulator();
    const delta: ToolCallDelta = { index: 0, id: 't', extra_content: { reasoning: 'r' } };
    accumulateToolCallDeltas([delta], acc);
    expect(acc.reqToolCalls[0].extra_content).toEqual({ reasoning: 'r' });
  });

  // Regression for finding 6 (Tier 3, iteration 24): nothing else bounds how large a
  // single tool call's streamed `arguments` may grow — a misbehaving gateway that
  // keeps emitting argument deltas for the same call without ever finishing it would
  // otherwise grow `argsBuffer` (and process memory) without bound.
  describe('argsBuffer size cap (finding 6)', () => {
    it("throws once a single tool call's accumulated arguments exceed the cap", () => {
      const acc = createToolCallAccumulator();
      accumulateToolCallDeltas(
        [
          {
            index: 0,
            id: 'tc_1',
            function: { name: 't', arguments: 'a'.repeat(MAX_TOOL_CALL_ARGS_BUFFER_CHARS) },
          },
        ],
        acc,
      );
      expect(() =>
        accumulateToolCallDeltas([{ index: 0, function: { arguments: 'a' } }], acc),
      ).toThrow(
        new RegExp(
          `exceeded the maximum buffered size \\(${MAX_TOOL_CALL_ARGS_BUFFER_CHARS} chars\\)`,
        ),
      );
    });

    it('does not throw when arguments stay within the cap', () => {
      const acc = createToolCallAccumulator();
      expect(() =>
        accumulateToolCallDeltas(
          [{ index: 0, id: 'tc_1', function: { name: 't', arguments: 'a'.repeat(1000) } }],
          acc,
        ),
      ).not.toThrow();
      expect(acc.reqToolCalls[0].argsBuffer).toHaveLength(1000);
    });
  });

  // Regression for finding T2-1 (Tier 2, iteration 25): nothing else bounds the
  // NUMBER of distinct tool-call slots a single turn's accumulator may hold — a
  // misbehaving/malicious gateway that streams deltas for an unbounded number of
  // distinct indices would otherwise grow `reqToolCalls` (and process memory, plus
  // the dispatch loop's per-entry work) without bound.
  describe('tool-call count cap (finding T2-1)', () => {
    it('throws once distinct streamed tool-call indices exceed the cap, rather than growing unboundedly', () => {
      const acc = createToolCallAccumulator();
      const deltas: ToolCallDelta[] = Array.from({ length: MAX_TOOL_CALLS_PER_TURN }, (_, idx) => ({
        index: idx,
        id: `tc_${idx}`,
        function: { name: 't', arguments: '{}' },
      }));
      expect(() => accumulateToolCallDeltas(deltas, acc)).not.toThrow();
      expect(Object.keys(acc.reqToolCalls)).toHaveLength(MAX_TOOL_CALLS_PER_TURN);

      expect(() =>
        accumulateToolCallDeltas(
          [{ index: MAX_TOOL_CALLS_PER_TURN, id: 'one_too_many', function: { name: 't' } }],
          acc,
        ),
      ).toThrow(new RegExp(`exceeded the maximum count \\(${MAX_TOOL_CALLS_PER_TURN}\\)`));

      // The accumulator was not silently grown past the cap by the rejected delta.
      expect(Object.keys(acc.reqToolCalls)).toHaveLength(MAX_TOOL_CALLS_PER_TURN);
    });

    it('does not count a delta that updates an EXISTING slot toward the cap', () => {
      const acc = createToolCallAccumulator();
      const deltas: ToolCallDelta[] = Array.from({ length: MAX_TOOL_CALLS_PER_TURN }, (_, idx) => ({
        index: idx,
        id: `tc_${idx}`,
        function: { name: 't', arguments: '{}' },
      }));
      accumulateToolCallDeltas(deltas, acc);

      // A further fragment for an ALREADY-accumulated index (index 0) merely updates
      // that slot in place — it must not be treated as a new slot and must not throw.
      expect(() =>
        accumulateToolCallDeltas([{ index: 0, function: { arguments: 'x' } }], acc),
      ).not.toThrow();
      expect(Object.keys(acc.reqToolCalls)).toHaveLength(MAX_TOOL_CALLS_PER_TURN);
      expect(acc.reqToolCalls[0].argsBuffer).toBe('{}x');
    });

    it('does not throw when distinct tool calls stay within the cap', () => {
      const acc = createToolCallAccumulator();
      const deltas: ToolCallDelta[] = Array.from(
        { length: MAX_TOOL_CALLS_PER_TURN - 1 },
        (_, idx) => ({
          index: idx,
          id: `tc_${idx}`,
          function: { name: 't', arguments: '{}' },
        }),
      );
      expect(() => accumulateToolCallDeltas(deltas, acc)).not.toThrow();
      expect(Object.keys(acc.reqToolCalls)).toHaveLength(MAX_TOOL_CALLS_PER_TURN - 1);
    });
  });
});

// ── Prototype-pollution hardening (finding C1) ────────────────────────────────
//
// `ToolCallDelta.index`/`id` are TYPED but arrive as raw JSON from the provider —
// a hostile/compromised OpenAI-compatible gateway is explicitly in this package's
// threat model (the same actor `MAX_TOOL_CALL_ARGS_BUFFER_CHARS`,
// `MAX_TOOL_CALLS_PER_TURN` and `parseSSE`'s buffer cap already exist for).
//
// Before the fix, a delta with `index: "__proto__"` resolved
// `acc.reqToolCalls["__proto__"]` to `Object.prototype` (truthy, so the slot-count
// cap never tripped) and then wrote `.id`/`.name`/`.argsBuffer` onto
// `Object.prototype` itself — permanent, process-wide pollution affecting every
// object in the host app, with the tool call silently dropped on top.
describe('accumulateToolCallDeltas — prototype pollution', () => {
  afterEach(() => {
    // Clean up (and make a leak obvious) if any assertion above ever fails open.
    for (const key of ['name', 'id', 'argsBuffer', 'extra_content'] as const) {
      delete (Object.prototype as unknown as Record<string, unknown>)[key];
    }
  });

  it('never writes to Object.prototype for a `__proto__` index', () => {
    const acc = createToolCallAccumulator();
    accumulateToolCallDeltas(
      [
        {
          index: '__proto__' as unknown as number,
          function: { name: 'remove_page', arguments: '{"pageId":"p1"}' },
        },
      ],
      acc,
    );

    expect(Object.hasOwn(Object.prototype, 'name')).toBe(false);
    expect(Object.hasOwn(Object.prototype, 'argsBuffer')).toBe(false);
    expect(({ a: 1 } as Record<string, unknown>).name).toBeUndefined();
  });

  it('still accumulates a `__proto__`-indexed tool call into a real slot', () => {
    const acc = createToolCallAccumulator();
    accumulateToolCallDeltas(
      [
        {
          index: '__proto__' as unknown as number,
          id: 'tc_evil',
          function: { name: 'remove_page', arguments: '{"pageId":"p1"}' },
        },
      ],
      acc,
    );

    // The call is NOT silently dropped — it lands in an ordinary (id-derived) slot,
    // so the model still gets a result and the per-turn slot cap still counts it.
    const entries = Object.values(acc.reqToolCalls);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: 'tc_evil',
      name: 'remove_page',
      argsBuffer: '{"pageId":"p1"}',
    });
  });

  it('does not merge two distinct calls whose ids are prototype member names', () => {
    const acc = createToolCallAccumulator();
    accumulateToolCallDeltas(
      [
        { id: '__proto__', function: { name: 'list_pages', arguments: '{}' } },
        { id: 'constructor', function: { name: 'get_dashboard_state', arguments: '{}' } },
      ],
      acc,
    );

    const entries = Object.values(acc.reqToolCalls);
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.name).sort()).toEqual([
      'get_dashboard_state',
      'list_pages',
    ]);
    // `idToIdx` must not resolve through the prototype either — a truthy inherited
    // lookup would have merged both fragments into one `"[object Object]"` slot.
    expect(Object.values(acc.idToIdx)).toHaveLength(2);
  });

  it('still enforces the per-turn slot cap for `__proto__`-indexed deltas', () => {
    const acc = createToolCallAccumulator();
    const deltas: ToolCallDelta[] = Array.from({ length: MAX_TOOL_CALLS_PER_TURN }, (_, idx) => ({
      index: idx,
      id: `tc_${idx}`,
      function: { name: 't', arguments: '{}' },
    }));
    accumulateToolCallDeltas(deltas, acc);

    // Previously this slipped past the cap entirely, because the `Object.prototype`
    // lookup made the "mint a new slot" branch (which carries the check) unreachable.
    expect(() =>
      accumulateToolCallDeltas(
        [{ index: '__proto__' as unknown as number, function: { name: 't', arguments: '{}' } }],
        acc,
      ),
    ).toThrow(new RegExp(`exceeded the maximum count \\(${MAX_TOOL_CALLS_PER_TURN}\\)`));
  });

  it.each([
    ['a float', 1.5],
    ['NaN', Number.NaN],
    ['a numeric string', '0'],
    ['an object', {}],
  ])('routes %s index to the safe positional path', (_label, badIndex) => {
    const acc = createToolCallAccumulator();
    accumulateToolCallDeltas(
      [{ index: badIndex as unknown as number, function: { name: 't', arguments: '{}' } }],
      acc,
    );

    // No key was minted from the malformed index; the positional fallback (offset by
    // `POSITIONAL_INDEX_BASE`) owns the slot instead.
    expect(Object.keys(acc.reqToolCalls)).toEqual([String(POSITIONAL_INDEX_BASE)]);
  });

  it('creates both accumulator maps with a null prototype', () => {
    const acc = createToolCallAccumulator();
    expect(Object.getPrototypeOf(acc.reqToolCalls)).toBeNull();
    expect(Object.getPrototypeOf(acc.idToIdx)).toBeNull();
  });
});
