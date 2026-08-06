/**
 * Bounds a tool's OUTPUT before it re-enters the conversation.
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
import { MAX_TOOL_OUTPUT_CHARS } from '@mui/x-studio-schema';
import { capText } from './promptCaps';

/**
 * Total cap (chars, ~bytes of JSON text) on a single tool result.
 *
 * Defined in `@mui/x-studio-schema` because `@mui/x-studio`'s SSE adapter mirrors it as
 * `MAX_TOOL_OUTPUT_SIZE` — a client budget below this one would clip a result this loop had
 * already decided to send. Re-exported here so callers and tests in this package keep naming it
 * where it is enforced.
 */
export { MAX_TOOL_OUTPUT_CHARS };

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
 * Floors for the progressive re-trim (see {@link capToolOutput}). The structural caps
 * above are the FIRST attempt, not a guarantee: 1000 rows × 200 columns × 4000 chars
 * is still far over {@link MAX_TOOL_OUTPUT_CHARS}, so an oversized result has to be
 * tightened until it fits. Cells shrink before rows are dropped — a narrower cell
 * still tells the model what the column holds, whereas a dropped row is data it never
 * learns exists.
 */
const MIN_TOOL_OUTPUT_CELL_CHARS = 64;
const MIN_TOOL_OUTPUT_ARRAY_ITEMS = 1;
/**
 * Floor for `objectKeys`, the third and last cap the progressive re-trim tightens.
 *
 * It was originally left out of the loop entirely, which made
 * {@link MAX_TOOL_OUTPUT_OBJECT_KEYS} a ONE-SHOT cap: a 300,000-key object dropped to
 * 200 keys on the first pass and never narrowed again, so a result whose size lives in
 * its key COUNT (200 keys × 12 levels of nesting, each already at the 64-char cell
 * floor) had nothing structural left to give and fell through to the hard slice — the
 * exact mid-token amputation the progressive loop exists to avoid. Columns are dropped
 * LAST, after cells are narrowed and rows are dropped, because losing a column removes
 * a dimension from every row at once whereas losing rows leaves the full schema
 * visible — and a model that can still see the schema can re-query for the rest.
 */
const MIN_TOOL_OUTPUT_OBJECT_KEYS = 8;

interface TrimCaps {
  cellChars: number;
  arrayItems: number;
  objectKeys: number;
}

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

/**
 * Property name carrying {@link TOOL_OUTPUT_TRUNCATED_NOTE} in a trimmed JSON result.
 *
 * For an OBJECT root it is folded in as a sibling key, preserving the shape the tool
 * advertises. For an ARRAY or SCALAR root there is nowhere to fold a sibling key, so
 * the trimmed value is wrapped in `{ [MARKER]: …, result: <value> }` — see
 * {@link TOOL_OUTPUT_TRUNCATED_RESULT_KEY}.
 */
export const TOOL_OUTPUT_TRUNCATED_NOTE_KEY = 'toolOutputTruncatedNote';

/**
 * Property holding the trimmed value when a non-object root had to be wrapped to carry
 * the truncation marker.
 *
 * Reshaping a result is not free — the model was told this tool returns an array — but
 * it only ever happens on a path that has ALREADY discarded data, and the alternative
 * shipped for a while: an array or scalar root was returned bare, with no marker
 * anywhere, so the model reasoned over silently-truncated data and reported a wrong
 * answer with full confidence. That is the one failure mode this whole module exists to
 * prevent, and it was reachable through any host `server-tool` skill returning a
 * top-level array (`capToolOutput` runs on EVERY `ToolDispatchOutcome.output`, skills
 * included) as well as any future tool built on `jsonResult(array)`, a shape
 * `mcp/utilityTools.ts` already produces. A parseable, explicitly-marked envelope is
 * strictly better than a parseable, silent lie.
 */
export const TOOL_OUTPUT_TRUNCATED_RESULT_KEY = 'result';

interface TrimState {
  truncated: boolean;
}

function trimValue(value: unknown, depth: number, state: TrimState, caps: TrimCaps): unknown {
  if (typeof value === 'string') {
    if (value.length > caps.cellChars) {
      state.truncated = true;
      return `${value.slice(0, caps.cellChars)}…`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_TOOL_OUTPUT_DEPTH) {
      state.truncated = true;
      return [];
    }
    if (value.length > caps.arrayItems) {
      state.truncated = true;
    }
    return value.slice(0, caps.arrayItems).map((entry) => trimValue(entry, depth + 1, state, caps));
  }
  if (value !== null && typeof value === 'object') {
    if (depth >= MAX_TOOL_OUTPUT_DEPTH) {
      state.truncated = true;
      return {};
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > caps.objectKeys) {
      state.truncated = true;
    }
    // `Object.create(null)`, not `{}` — the keys come from a producer's JSON, and
    // `JSON.parse('{"__proto__": …}')` yields an OWN `__proto__` property that a
    // plain-object assignment would either silently drop or route into the
    // prototype. A null-prototype target has no such member to collide with, and
    // `JSON.stringify` serialises it identically.
    const out: Record<string, unknown> = Object.create(null);
    for (const [key, entry] of entries.slice(0, caps.objectKeys)) {
      const cappedKey = capText(key, caps.cellChars);
      let outKey = cappedKey;
      if (cappedKey !== key) {
        // Capping a KEY is data loss exactly like capping a value, and it was the one
        // trim in this function that did not record itself — so a result whose only
        // truncation was a key name came back unmarked. Worse, two keys sharing a
        // prefix longer than `cellChars` capped to the SAME string and the second
        // silently overwrote the first, losing a whole column with no trace.
        // `Object.entries` never yields duplicates, so only capped keys can collide;
        // disambiguate those rather than dropping one.
        state.truncated = true;
        let suffix = 2;
        while (outKey in out) {
          outKey = `${cappedKey}~${suffix}`;
          suffix += 1;
        }
      }
      out[outKey] = trimValue(entry, depth + 1, state, caps);
    }
    return out;
  }
  return value;
}

/**
 * Attach {@link TOOL_OUTPUT_TRUNCATED_NOTE} to a trimmed value, whatever its root shape.
 *
 * An object root keeps its shape and gains a sibling key; ANY other root (array,
 * string, number, boolean, `null`) is wrapped, because there is no sibling position to
 * put the note in. The wrap is what closes the original defect: the marker used to be
 * folded in only for object roots, and every other root was returned bare with the
 * truncation completely invisible to the model.
 *
 * Returns `value` untouched when nothing was trimmed, so a within-budget-after-trim
 * result is never reshaped for no reason.
 */
function withTruncationMarker(value: unknown, truncated: boolean): unknown {
  if (!truncated) {
    return value;
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return {
      ...(value as Record<string, unknown>),
      [TOOL_OUTPUT_TRUNCATED_NOTE_KEY]: TOOL_OUTPUT_TRUNCATED_NOTE,
    };
  }
  return {
    [TOOL_OUTPUT_TRUNCATED_NOTE_KEY]: TOOL_OUTPUT_TRUNCATED_NOTE,
    [TOOL_OUTPUT_TRUNCATED_RESULT_KEY]: value,
  };
}

/**
 * Cap a tool result before it is appended to the conversation and streamed to the
 * client.
 *
 * Results at or under {@link MAX_TOOL_OUTPUT_CHARS} are returned byte-identical —
 * the structural trim only engages once the total budget is already blown, so
 * normal tool results (the overwhelming majority) are never reshaped.
 *
 * When the first structural pass is still over budget, the caps are tightened and
 * the trim is re-run rather than the string being sliced: a raw slice of a JSON
 * document cuts mid-token, so the model receives something it cannot parse at all —
 * strictly worse than a smaller, well-formed result. Cells are narrowed first (down
 * to {@link MIN_TOOL_OUTPUT_CELL_CHARS}), then rows are dropped (down to
 * {@link MIN_TOOL_OUTPUT_ARRAY_ITEMS}), then columns (down to
 * {@link MIN_TOOL_OUTPUT_OBJECT_KEYS}); each pass re-trims the previous pass's
 * output, so the work shrinks geometrically. The hard slice survives only as the
 * last resort for a result that no structural trim can fit (a million scalar rows,
 * whose size is all commas) and for genuinely non-JSON output.
 *
 * EVERY truncating path here marks its result: an object root gains a
 * {@link TOOL_OUTPUT_TRUNCATED_NOTE_KEY} sibling, an array/scalar root is wrapped in
 * an envelope carrying the same key, and both slice paths append
 * {@link TOOL_OUTPUT_TRUNCATED_SUFFIX}. There is no path that discards data silently —
 * that is the invariant, and it did not hold before (see
 * {@link TOOL_OUTPUT_TRUNCATED_RESULT_KEY}).
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

  let caps: TrimCaps = {
    cellChars: MAX_TOOL_OUTPUT_CELL_CHARS,
    arrayItems: MAX_TOOL_OUTPUT_ARRAY_ITEMS,
    objectKeys: MAX_TOOL_OUTPUT_OBJECT_KEYS,
  };
  const state: TrimState = { truncated: false };
  // Each pass trims the PREVIOUS pass's result, not the original: trimming is
  // monotonic (every cap only ever shrinks), so the outcome is identical and each
  // pass walks a much smaller value than the last.
  let candidate: unknown = parsed;
  let lastSerialized: string | undefined;

  for (;;) {
    candidate = trimValue(candidate, 0, state, caps);

    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(withTruncationMarker(candidate, state.truncated));
    } catch {
      return `${output.slice(0, MAX_TOOL_OUTPUT_CHARS)}${TOOL_OUTPUT_TRUNCATED_SUFFIX}`;
    }

    // `JSON.stringify` returns `undefined` for a bare `undefined` root, which is not a
    // valid tool result either — treat it as unfittable.
    if (serialized !== undefined && serialized.length <= MAX_TOOL_OUTPUT_CHARS) {
      return serialized;
    }
    lastSerialized = serialized;

    if (caps.cellChars > MIN_TOOL_OUTPUT_CELL_CHARS) {
      caps = {
        ...caps,
        cellChars: Math.max(MIN_TOOL_OUTPUT_CELL_CHARS, Math.floor(caps.cellChars / 2)),
      };
    } else if (caps.arrayItems > MIN_TOOL_OUTPUT_ARRAY_ITEMS) {
      caps = {
        ...caps,
        arrayItems: Math.max(MIN_TOOL_OUTPUT_ARRAY_ITEMS, Math.floor(caps.arrayItems / 2)),
      };
    } else if (caps.objectKeys > MIN_TOOL_OUTPUT_OBJECT_KEYS) {
      caps = {
        ...caps,
        objectKeys: Math.max(MIN_TOOL_OUTPUT_OBJECT_KEYS, Math.floor(caps.objectKeys / 2)),
      };
    } else {
      // Nothing structural left to give (e.g. one row of a million scalar columns) —
      // fall back to a hard slice with the same explicit marker.
      return `${(lastSerialized ?? output).slice(0, MAX_TOOL_OUTPUT_CHARS)}${TOOL_OUTPUT_TRUNCATED_SUFFIX}`;
    }
  }
}
