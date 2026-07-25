/**
 * Bounds a tool's OUTPUT before it re-enters the conversation (finding H2).
 *
 * Every INPUT to a tool in this package is bounded (args buffer, filter values,
 * bulk-update op counts, query row limits), but the output was not — and a tool
 * result is not a one-shot cost: `agenticLoop.ts` appends it to `currentMessages`
 * and re-sends it on EVERY remaining turn, so an unbounded result costs
 * O(turns × size) tokens, and it is also forwarded to the browser inside the
 * `tool-activity` SSE event. A single `query_data_source({ limit: 1000 })` against
 * a table with a ~1 MB `notes TEXT` column produces a ~1 GB JSON string: a
 * `RangeError: Invalid string length`/OOM at best, hundreds of millions of billed
 * tokens at worst.
 *
 * This caps at the `ToolDispatchOutcome.output` boundary — the single point every
 * producer's result funnels through — rather than in each producer, so it covers
 * `query_data_source`, `describe_data_source`, `get_field_values`,
 * `summarise_page`, `get_dashboard_state` and any future tool uniformly.
 *
 * KNOWN LIMITATION: the producer has already built its own JSON string by the time
 * this runs, so this cannot prevent a `RangeError` thrown INSIDE a producer's own
 * `JSON.stringify`. Row-count/cell-size limits at the query layer are the other
 * half of that fix; this half bounds everything that actually reaches the model.
 *
 * Internal to the package — not exported from `index.ts`.
 */
import { capText } from './promptCaps';

/**
 * Total cap (chars, ~bytes of JSON text) on a single tool result. Sized so a
 * legitimate 1000-row query result with ordinary cell values passes untouched
 * (~200 KB is roughly 50K tokens — already a large single tool result), while a
 * runaway result is bounded well before it can dominate the conversation.
 */
export const MAX_TOOL_OUTPUT_CHARS = 200_000;

/**
 * Per-string ("cell") cap applied while structurally trimming an oversized
 * result. Bounds the single-huge-value shape (one `notes TEXT` document) that a
 * pure total-size slice would handle by amputating the JSON mid-token.
 */
export const MAX_TOOL_OUTPUT_CELL_CHARS = 4_000;

/**
 * Per-object key ("column") cap applied while structurally trimming an oversized
 * result — the too-many-columns shape (`SELECT *` on a very wide table).
 */
export const MAX_TOOL_OUTPUT_OBJECT_KEYS = 200;

/** Per-array entry ("row") cap applied while structurally trimming an oversized result. */
export const MAX_TOOL_OUTPUT_ARRAY_ITEMS = 1_000;

/** Max nesting depth walked while trimming; deeper values are replaced with an empty container. */
const MAX_TOOL_OUTPUT_DEPTH = 12;

/**
 * Explicit truncation marker, mirroring the `statsTruncatedNote` pattern
 * `mcp/dataTools.ts` already uses: the model must be told the result is partial,
 * otherwise it silently reasons over truncated data and reports a wrong answer
 * with full confidence.
 */
export const TOOL_OUTPUT_TRUNCATED_NOTE =
  'MUI X Studio: This tool result was truncated because it exceeded the per-call output budget ' +
  `of ${MAX_TOOL_OUTPUT_CHARS} characters. The data below is INCOMPLETE — do not present it as a ` +
  'full answer. Re-run the tool with a smaller limit, fewer columns, or a narrower filter.';

/** Suffix appended in place of the removed tail when a plain-text (non-JSON) result is sliced. */
export const TOOL_OUTPUT_TRUNCATED_SUFFIX = `\n…[${TOOL_OUTPUT_TRUNCATED_NOTE}]`;

interface TrimState {
  truncated: boolean;
}

function trimValue(value: unknown, depth: number, state: TrimState): unknown {
  if (typeof value === 'string') {
    if (value.length > MAX_TOOL_OUTPUT_CELL_CHARS) {
      state.truncated = true;
      return `${value.slice(0, MAX_TOOL_OUTPUT_CELL_CHARS)}…`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_TOOL_OUTPUT_DEPTH) {
      state.truncated = true;
      return [];
    }
    if (value.length > MAX_TOOL_OUTPUT_ARRAY_ITEMS) {
      state.truncated = true;
    }
    return value
      .slice(0, MAX_TOOL_OUTPUT_ARRAY_ITEMS)
      .map((entry) => trimValue(entry, depth + 1, state));
  }
  if (value !== null && typeof value === 'object') {
    if (depth >= MAX_TOOL_OUTPUT_DEPTH) {
      state.truncated = true;
      return {};
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > MAX_TOOL_OUTPUT_OBJECT_KEYS) {
      state.truncated = true;
    }
    // `Object.create(null)`, not `{}` — the keys come from a producer's JSON, and
    // `JSON.parse('{"__proto__": …}')` yields an OWN `__proto__` property that a
    // plain-object assignment would either silently drop or route into the
    // prototype. A null-prototype target has no such member to collide with, and
    // `JSON.stringify` serialises it identically.
    const out: Record<string, unknown> = Object.create(null);
    for (const [key, entry] of entries.slice(0, MAX_TOOL_OUTPUT_OBJECT_KEYS)) {
      out[capText(key, MAX_TOOL_OUTPUT_CELL_CHARS)] = trimValue(entry, depth + 1, state);
    }
    return out;
  }
  return value;
}

/**
 * Cap a tool result before it is appended to the conversation and streamed to the
 * client.
 *
 * Results at or under {@link MAX_TOOL_OUTPUT_CHARS} are returned byte-identical —
 * the structural trim only engages once the total budget is already blown, so
 * normal tool results (the overwhelming majority) are never reshaped.
 *
 * @param output - The tool's serialized result string.
 * @returns The original string when it is within budget, otherwise a truncated
 *   result carrying an explicit {@link TOOL_OUTPUT_TRUNCATED_NOTE}.
 */
export function capToolOutput(output: string): string {
  if (typeof output !== 'string' || output.length <= MAX_TOOL_OUTPUT_CHARS) {
    return output;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    // Not JSON (a `summarise_page` CSV block, a plain-text resource) — there is no
    // structure to trim, so slice and mark it.
    return `${output.slice(0, MAX_TOOL_OUTPUT_CHARS)}${TOOL_OUTPUT_TRUNCATED_SUFFIX}`;
  }

  const state: TrimState = { truncated: false };
  const trimmed = trimValue(parsed, 0, state);

  let serialized: string;
  try {
    serialized = JSON.stringify(
      state.truncated && trimmed !== null && typeof trimmed === 'object' && !Array.isArray(trimmed)
        ? {
            ...(trimmed as Record<string, unknown>),
            toolOutputTruncatedNote: TOOL_OUTPUT_TRUNCATED_NOTE,
          }
        : trimmed,
    );
  } catch {
    return `${output.slice(0, MAX_TOOL_OUTPUT_CHARS)}${TOOL_OUTPUT_TRUNCATED_SUFFIX}`;
  }

  if (serialized === undefined || serialized.length > MAX_TOOL_OUTPUT_CHARS) {
    // Still over budget after the structural trim (e.g. a million short rows) —
    // fall back to a hard slice with the same explicit marker. `JSON.stringify`
    // returns `undefined` for a bare `undefined` root, which is not a valid tool
    // result either, so it takes the same path.
    return `${(serialized ?? output).slice(0, MAX_TOOL_OUTPUT_CHARS)}${TOOL_OUTPUT_TRUNCATED_SUFFIX}`;
  }
  return serialized;
}
