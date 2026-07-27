/**
 * Server-side tool execution for x-studio-ai-middleware.
 *
 * Unlike the client-side `executeTool` (which calls `StudioController` directly),
 * this function operates on a `StudioState` value and returns:
 * - `output`   — JSON string to feed back to the LLM
 * - `mutation` — optional `StateMutation` for the client to apply
 * - `nextState`— the updated state after the tool ran (used to carry state forward
 *                across multiple tool calls in a single agentic loop turn)
 */
import {
  applyMutation,
  createDefaultWidget,
  createFilterId,
  createPageId,
  isStudioChartType,
  isStudioFilterOperator,
  isWidgetOfKind,
  STUDIO_CHART_TYPES,
  STUDIO_FILTER_OPERATORS,
  validateChartConfigKeysForType,
  validateConfigKeysForKind,
} from '@mui/x-studio-schema';
import type { BuiltinStudioWidgetKind, OptionalWidgetField } from '@mui/x-studio-schema';
import type {
  StudioState,
  StudioCustomWidgetDef,
  StudioWidget,
  StudioPage,
  StudioFilterOperator,
  StudioDataField,
  StudioFilterState,
  StudioDataSource,
} from './models/studioTypes';
import type { StateMutation, StudioAIToolName } from './models/aiTypes';
// Shared pure functions: the widget factory (so AI-created and UI-created widgets
// share defaults) and the single mutation reducer (so the server-threaded state
// and the client-applied state are computed by the exact same code).

export interface ToolExecutionResult {
  output: string;
  mutation?: StateMutation;
  nextState: StudioState;
}

/**
 * Max distinct values per field emitted in a `get_dashboard_state` payload. The
 * full `fieldDistinctValues` list can be arbitrarily large (every unique value of
 * a high-cardinality column), so it is capped here — both to avoid a token bomb
 * and to avoid dumping a full column's contents into the model context.
 */
const MAX_DISTINCT_VALUES_IN_STATE_OUTPUT = 20;

/**
 * Max length of a model-supplied stored title (dashboard / page / widget). These
 * strings are re-interpolated into `<dashboard_state>` on EVERY future request, so an
 * unbounded title is a persistent token bomb (finding T3-3) — `sanitizeForPrompt`
 * neutralizes markup but not size. Capped at the write source so the oversized string
 * never lands in state. Larger than `rename_thread`'s 40-char cap because dashboard and
 * widget titles are legitimately longer than a chat-thread label, but still bounded.
 */
const MAX_TITLE_LENGTH = 200;

/**
 * Max length of a model-supplied filter `field`/`sourceId` string (and of a
 * string-typed filter `value`), persisted verbatim by `add_page_filter` /
 * `add_widget_filter`. Same rationale — and same token-bomb class — as
 * {@link MAX_TITLE_LENGTH}: `buildAISystemPrompt.ts` re-interpolates every active
 * filter's `field`/`value` (via `JSON.stringify(f.value)`) into the "Active
 * Filters" block on EVERY subsequent request, so an unbounded value persists as
 * a token bomb across the whole conversation (finding T3-3).
 *
 * Exported (finding F4, Tier 2) so `mcp/queryTools.ts` can cap `query_data_source`'s
 * `filters[].field`/`get_field_values.fieldId` strings with the SAME bound already
 * applied to the conceptually identical `add_page_filter`/`add_widget_filter`
 * `field` string, rather than inventing a second constant for the same class of
 * short identifier string.
 */
export const MAX_FILTER_STRING_LENGTH = 200;

/**
 * Max number of entries kept in an array-typed filter `value` (e.g. an `in`
 * operator's value list). An unbounded array is JSON-stringified into the
 * system prompt on every future request exactly like an oversized string.
 */
const MAX_FILTER_VALUE_ARRAY_LENGTH = 50;

/**
 * Max number of keys retained in a plain-object-typed filter `value` (finding F3,
 * Tier 3). `capFilterValue`'s array branch already bounds array length and its
 * string branch bounds string length, but the object branch previously recursed
 * over EVERY key with no cap on key COUNT — so a model-supplied object-typed filter
 * `value` with a huge number of (individually short) keys was persisted verbatim and
 * re-interpolated via `JSON.stringify(f.value)` into `<dashboard_state>` on every
 * subsequent request, exactly the same persistent token-bomb class the array-length
 * cap already guards against. Reuses {@link MAX_FILTER_VALUE_ARRAY_LENGTH}'s 50-entry
 * convention rather than inventing a second bound for the same class of unbounded
 * container.
 */
const MAX_FILTER_VALUE_OBJECT_KEYS = MAX_FILTER_VALUE_ARRAY_LENGTH;

/**
 * Max length of an object KEY retained inside a model-supplied filter `value` or
 * widget `config` (finding M8).
 *
 * Every cap in this file bounded object VALUES and entry COUNTS; key NAMES at any
 * depth were never bounded at all. Both containers are re-serialized in full on
 * every subsequent request — `buildAISystemPrompt.ts` echoes a filter value via
 * `JSON.stringify(f.value)`, and `describeWidget` echoes config content — and a
 * key is just as much of that serialization as its value. The concrete reachable
 * case: `customConfig` is a SHARED config key, valid on every widget kind and
 * arbitrarily shaped by design, so
 * `add_widget({ kind:'chart', title:'t', config:{ customConfig:{ "<1,000,000 chars>": 1 } } })`
 * passes every existing gate and lands a 1 MB key in persisted `doc.widgets` and
 * in every future `get_dashboard_state` payload.
 *
 * Reuses {@link MAX_FILTER_STRING_LENGTH} — a key is the same class of short
 * identifier string as a filter `field` or a `sourceId`, both already bounded by
 * it. Truncation can in principle collide two keys sharing a 200-char prefix
 * (last write wins); that is the same trade-off the entry-COUNT caps already make
 * by dropping entries outright, and no legitimate config or filter key comes close
 * to the bound.
 */
const MAX_OBJECT_KEY_LENGTH = MAX_FILTER_STRING_LENGTH;

/**
 * Max number of TOP-LEVEL keys retained in a model-supplied widget `config`
 * (finding M8). `capConfigStringValues` bounded the shape of every VALUE but never
 * the number of keys at the top level, even though its own nested branches
 * (`capShallowConfigValue`) have bounded key count since they were written. An
 * unbounded key count is both a persisted token bomb and an unbounded RESPONSE
 * echo: `invalidConfigKeyError` joins every offending key into its error string.
 * Sized at 200 — matching `capIncomingCustomWidgets`'s
 * `MAX_CUSTOM_WIDGET_CONFIG_KEYS` for the same kind of config bag — because a
 * legitimate chart config can legally carry well over a hundred keys (the union of
 * the shared keys and a chart family's own), so the 50-entry nested bound would be
 * too tight here.
 */
const MAX_CONFIG_KEYS = 200;

/**
 * Max number of operations accepted per array/record arg of a single
 * `apply_bulk_update` call (finding F2, Tier 2). One bulk call counts as ONE
 * mutation against `maxMutationsPerRequest`, but without a per-arg cap a single call
 * could mint unbounded persisted widgets via `widgetAdditions` — a PERSISTENT token
 * bomb, since every widget is re-described in `<dashboard_state>` on every future
 * request — plus unbounded diff work in `computeToolEffects`. Entries beyond this cap
 * are rejected with actionable guidance (mirroring `validateQueryArrayArg`'s
 * reject-with-guidance pattern) rather than silently dropped or processed.
 */
const MAX_BULK_UPDATE_OPS = 200;

/**
 * Max number of layout rows accepted by `set_widget_layout` / `apply_bulk_update`'s
 * `layout` op (finding F3). Same unbounded-work/token-bomb class as
 * {@link MAX_BULK_UPDATE_OPS}: an unbounded row array is re-flattened and re-validated
 * on every call and, once committed, re-described on every future request.
 */
const MAX_LAYOUT_ROWS = 200;

/**
 * Max number of ids interpolated into a single tool-result error string before the
 * list is truncated with a "…N more" suffix (finding F3). Several error paths
 * (`set_widget_layout` and `apply_bulk_update`'s layout op) join an offending id list
 * into the error text; a model that sends hundreds of bad ids would otherwise echo the
 * whole list straight back into the conversation as an unbounded response bomb.
 */
const MAX_IDS_IN_ERROR = 10;

/**
 * Max number of `skipped` entries echoed in an `apply_bulk_update` tool result before
 * the list is truncated with a trailing "…N more" marker (finding F2). Each rejected
 * op appends to `skipped`, and the whole array is echoed back verbatim — an unbounded
 * response echo without this cap.
 */
const MAX_SKIPPED_IN_OUTPUT = 20;

/**
 * Max characters of an offending argument VALUE echoed back into a tool-result
 * validation error (finding H4). `JSON.stringify(value)` is this file's existing
 * idiom for "show the model what it sent", but the value is model-supplied and
 * unbounded, so a megabyte-sized object would be echoed straight back into the
 * conversation — the same response-echo bomb {@link MAX_IDS_IN_ERROR} and
 * {@link MAX_SKIPPED_IN_OUTPUT} already bound for id and skip lists.
 */
const MAX_ECHOED_ARG_VALUE_LENGTH = 100;

/** Cap a model-supplied string to `maxLength` characters. */
function capString(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

/**
 * Coerce an untrusted, model- or client-supplied value to a string WITHOUT ever
 * invoking `ToPrimitive` on an object (finding H4).
 *
 * `String(x)` looks total but is not. For a JSON object whose `toString` is a
 * NON-callable own property — `{"toString": 1}`, which `JSON.parse` accepts
 * verbatim, so it survives both a raw tool-call `arguments` buffer and the request
 * body — `ToPrimitive` skips the uncallable `toString`, falls back to
 * `Object.prototype.valueOf` (which returns the object itself), and throws
 * `TypeError: Cannot convert object to primitive value`.
 *
 * That throw escaped in two places, and in both the raw `TypeError` was strictly
 * worse than a validation error:
 *
 * - Out of `executeToolOnState`, whose contract (see `toolPolicy.ts`'s PURITY
 *   INVARIANT and `agenticLoop/toolDispatch.ts`'s catch block) is that it is pure
 *   and never throws — so the catch there classifies the throw as a HOST-policy
 *   failure or an internal defect and hands the model an opaque correlation id,
 *   burning a turn and a mutation-budget unit, while the host's `onToolError`
 *   logs a middleware bug misattributed to host code.
 * - Out of `capIncomingDashboardState`, at the very top of `handleAIChat` request
 *   handling, where it collapsed the entire request into one generic SSE error —
 *   a per-request DoS from a two-token payload, and exactly the "opaque native
 *   `TypeError`" class `validateStudioAIRequestBody` exists to eliminate.
 *
 * Semantics, chosen so that nothing which was already safe changes behavior:
 * - a string is returned as-is;
 * - `null`/`undefined` become `''` — exactly what the `String(x ?? '')` idiom this
 *   replaces produced;
 * - a number/boolean/bigint stringifies as before, so a model that sends
 *   `pageId: 3` still addresses page `"3"`;
 * - anything else (object, array, function, symbol) becomes `''` rather than
 *   `"[object Object]"` or a throw. `''` is the right sentinel because it is
 *   already the "argument absent" value at every call site, so an unusable object
 *   takes the SAME path an omitted argument takes (the existence check fails, the
 *   cap yields empty) instead of inventing a plausible-looking `"[object Object]"`
 *   id or title. Tool-argument call sites additionally reject the value up front
 *   via {@link invalidStringArgsError}, so the model receives an actionable error
 *   rather than silently landing an empty title; the incoming-state cap path has
 *   no caller to report to and relies on the `''` normalization alone.
 */
function asString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    // Safe: the value is already a primitive here, so `ToPrimitive` never runs.
    return String(value);
  }
  return '';
}

/**
 * `Number()`'s mirror of {@link asString} (finding H4). `Number(x)` throws the same
 * `TypeError: Cannot convert object to primitive value` for the mirror-image shape
 * `{"valueOf": 1, "toString": 2}` (both coercion methods present but neither
 * callable), and throws unconditionally for a symbol.
 *
 * Returns `NaN` for anything not numerically coercible, so the `Number.isFinite`
 * gate every caller already applies turns the bad value into that caller's own
 * actionable error instead of a raw throw. Nullish also yields `NaN` rather than
 * `Number(null) === 0`: both call sites already exclude nullish before calling,
 * and `0` would be a silently-wrong column width / forecast period rather than a
 * rejected one.
 */
function asNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'bigint') {
    // Safe: the value is already a primitive here, so `ToPrimitive` never runs.
    return Number(value);
  }
  return NaN;
}

/**
 * Render an offending model-supplied argument value for a tool-result error,
 * bounded to {@link MAX_ECHOED_ARG_VALUE_LENGTH} and never throwing (finding H4).
 * Falls back to naming the runtime shape when the value is not JSON-representable
 * (a cyclic structure, a `BigInt`, a function), so the error stays useful without
 * this file having to trust `JSON.stringify` on untrusted input.
 */
function describeArgValue(value: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    json = undefined;
  }
  if (json === undefined) {
    return Array.isArray(value) ? 'an array' : `a ${typeof value}`;
  }
  return json.length > MAX_ECHOED_ARG_VALUE_LENGTH
    ? `${json.slice(0, MAX_ECHOED_ARG_VALUE_LENGTH)}…`
    : json;
}

/**
 * Reject a model-supplied tool argument that the handler is about to read AS A
 * STRING but that is not string-coercible (finding H4).
 *
 * {@link asString} guarantees the handler cannot THROW on such a value, but on its
 * own it would silently normalize `{"toString": 1}` to `''` — committing an empty
 * dashboard/page/widget title, or looking up the widget named `''`. This gate runs
 * first so the model gets the same actionable, retryable validation error every
 * sibling argument already produces (`fieldType`, `operator`, `columns`,
 * `periods`, `enabled`), rather than a silent mis-apply reported as success.
 *
 * A number or boolean is ACCEPTED, not rejected: `String(42)` was always the
 * behavior for a model that sends an id or title as a bare number, and tightening
 * that would be an unrelated behavior change. Nullish is accepted too — every call
 * site treats an absent argument as legal and defaults it.
 *
 * Returns one error naming every offending argument (not just the first), so a
 * model that mis-shapes two arguments fixes both in one retry.
 */
function invalidStringArgsError(
  args: Record<string, unknown>,
  names: readonly string[],
): string | undefined {
  const offenders = names.filter((name) => {
    const value = args[name];
    return (
      value !== undefined &&
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    );
  });
  if (offenders.length === 0) {
    return undefined;
  }
  return `argument(s) of the wrong type: ${offenders
    .map((name) => `${name} (expected a string, received ${describeArgValue(args[name])})`)
    .join(', ')}. Send a plain string for each.`;
}

/**
 * Join an id list for a tool-result error string, truncating to the first
 * {@link MAX_IDS_IN_ERROR} with a "…N more" suffix (finding F3). Bounds the response
 * echo when the model sends a very large list of offending ids.
 */
function joinIdsForError(ids: string[]): string {
  if (ids.length <= MAX_IDS_IN_ERROR) {
    return ids.join(', ');
  }
  return `${ids.slice(0, MAX_IDS_IN_ERROR).join(', ')}, …${ids.length - MAX_IDS_IN_ERROR} more`;
}

/**
 * Truncate an `apply_bulk_update` `skipped` list to a bounded prefix for the tool
 * result (finding F2), appending a "…N more" marker when entries were dropped.
 */
function truncateSkipped(skipped: string[]): string[] {
  if (skipped.length <= MAX_SKIPPED_IN_OUTPUT) {
    return skipped;
  }
  return [
    ...skipped.slice(0, MAX_SKIPPED_IN_OUTPUT),
    `…and ${skipped.length - MAX_SKIPPED_IN_OUTPUT} more`,
  ];
}

/** Cap a model-supplied title to {@link MAX_TITLE_LENGTH} (see the constant's rationale). */
function capTitle(title: string): string {
  return capString(title, MAX_TITLE_LENGTH);
}

/**
 * Max recursion depth `capFilterValue`/`capShallowConfigValue` will descend into a
 * nested array/object value. Bounds the work done on a pathologically deep
 * model-supplied structure.
 */
const MAX_FILTER_VALUE_DEPTH = 5;

/**
 * What a container found AT the recursion depth limit is replaced with (finding
 * L2).
 *
 * The depth guards previously returned the remaining subtree VERBATIM, which made
 * the depth limit a complete cap BYPASS rather than a work bound: a 1 MB string or
 * a 100,000-entry array nested one level past the limit skipped the 200-char /
 * 50-entry caps entirely and was persisted and re-interpolated on every subsequent
 * request — the exact token-bomb class these caps exist to close, reachable by
 * simply adding nesting. (`mcp/queryTools.ts` relies on `capFilterValue` for the
 * same bound on the forwarded-query path.)
 *
 * Replacing the over-deep container with a marker rather than recursing further
 * keeps the work bound intact AND closes the bypass, and follows this package's
 * "say so, don't silently truncate" convention (`SYSTEM_PROMPT_TRUNCATION_NOTE`,
 * `truncateSkipped`'s "…N more", `projectDataSourceMetadata`'s `truncated` flag) —
 * the model reads why the value stops rather than reasoning over a subtree it
 * cannot know was dropped. Scalars at the limit (number/boolean/null, and strings,
 * which are length-capped before the depth check) pass through unchanged: they are
 * inherently bounded, so there is nothing to bypass.
 */
const DEPTH_LIMIT_MARKER = '[truncated: nested too deeply]';

/**
 * Cap a model-supplied filter `value` before persisting it — same token-bomb class
 * `capTitle` guards against (finding T3-3). String values are truncated to
 * {@link MAX_FILTER_STRING_LENGTH}; array values (e.g. an `in` list) are truncated
 * to {@link MAX_FILTER_VALUE_ARRAY_LENGTH} entries. Recurses into array elements and
 * plain-object properties so a huge string or object NESTED inside an array-typed
 * value is also capped, not just the array's own length (Tier 2, iteration 22) —
 * `buildAISystemPrompt.ts` echoes the whole value via `JSON.stringify(f.value)` on
 * every future request, so an uncapped element anywhere inside the structure is just
 * as much a persistent token bomb as an uncapped top-level string. Object KEY names
 * are length-capped as well as counted ({@link MAX_OBJECT_KEY_LENGTH}, finding M8),
 * and a container found AT the depth limit is replaced with
 * {@link DEPTH_LIMIT_MARKER} rather than returned verbatim (finding L2) — returning
 * it made the depth limit a complete cap bypass. Other JSON-serializable scalar
 * shapes (number/boolean/null) are left as-is.
 *
 * Exported (Tier 3, iteration 25, finding T2-3) so `mcp/queryTools.ts` can apply the
 * SAME cap to `query_data_source`'s `filters[].value` — that path forwards
 * model-supplied filters straight to the host's `queryDataSource` callback rather
 * than persisting them onto dashboard state, but a megabyte-sized string/array
 * `value` is exactly the same unbounded-work/token-bomb class this function
 * already guards `add_page_filter`/`add_widget_filter` against.
 */
export function capFilterValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return capString(value, MAX_FILTER_STRING_LENGTH);
  }
  if (depth >= MAX_FILTER_VALUE_DEPTH) {
    // Finding L2 — a container here is REPLACED, not returned verbatim; see
    // {@link DEPTH_LIMIT_MARKER} for why returning it was a cap bypass.
    return value !== null && typeof value === 'object' ? DEPTH_LIMIT_MARKER : value;
  }
  if (Array.isArray(value)) {
    const bounded =
      value.length > MAX_FILTER_VALUE_ARRAY_LENGTH
        ? value.slice(0, MAX_FILTER_VALUE_ARRAY_LENGTH)
        : value;
    return bounded.map((entry) => capFilterValue(entry, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    // `Object.create(null)`, not `{}` (finding M8): the keys are model-supplied, so a
    // `{"__proto__": {…}}` filter value silently LOST that entry on a normal object
    // literal (assigning an object to `__proto__` rewrites the prototype instead of
    // creating a property) while the tool still reported `{ success: true }`. Same
    // treatment the sibling `capFieldDistinctValues`/`capDataSources` maps already get.
    const capped: Record<string, unknown> = Object.create(null);
    // Finding F3 (Tier 3): bound the NUMBER of retained keys, not just each key's
    // recursively-capped value — an object with thousands of short keys is otherwise
    // persisted and re-interpolated verbatim, the same token-bomb class the array
    // branch above already caps by length.
    const entries = Object.entries(value as Record<string, unknown>);
    const boundedEntries =
      entries.length > MAX_FILTER_VALUE_OBJECT_KEYS
        ? entries.slice(0, MAX_FILTER_VALUE_OBJECT_KEYS)
        : entries;
    for (const [key, entry] of boundedEntries) {
      // Finding M8 — the KEY is length-capped too, not just the value; see
      // {@link MAX_OBJECT_KEY_LENGTH}.
      capped[capString(key, MAX_OBJECT_KEY_LENGTH)] = capFilterValue(entry, depth + 1);
    }
    return capped;
  }
  return value;
}

/**
 * Cap a model-supplied `sourceId` string before persisting it onto a widget — same
 * token-bomb class as {@link MAX_TITLE_LENGTH}/{@link MAX_FILTER_STRING_LENGTH}:
 * `buildAISystemPrompt.ts`'s `describeWidget` echoes a widget's resolved source into
 * `<dashboard_state>` on every future request. Reuses `MAX_FILTER_STRING_LENGTH` —
 * the same bound already applied to a filter's `field`/`sourceId` — rather than
 * inventing a new constant for what is the same class of short identifier string.
 */
function capSourceId(sourceId: string): string {
  return capString(sourceId, MAX_FILTER_STRING_LENGTH);
}

/**
 * Max number of entries retained in an array-typed widget config field (e.g.
 * `ySeries`, `annotations`, `funnelCategoryOrder`, `funnelStageSequence`, grid
 * `columns`) before it is persisted (sibling to {@link capConfigStringValues}'s
 * string cap — Tier 1 architecture-review finding). Reuses
 * `MAX_FILTER_VALUE_ARRAY_LENGTH`'s 50-entry convention rather than inventing a
 * new bound for the same class of unbounded array.
 */
const MAX_CONFIG_ARRAY_LENGTH = MAX_FILTER_VALUE_ARRAY_LENGTH;

/**
 * Max recursion depth {@link capShallowConfigValue} will descend into a nested
 * widget-config value (Tier 1 architecture-review finding). Mirrors
 * `capFilterValue`'s {@link MAX_FILTER_VALUE_DEPTH} pattern: config values were
 * previously capped only ONE level deep, which missed two real nested config
 * shapes — `StudioSharedWidgetConfig.customConfig` (arbitrary consumer JSON,
 * valid on every widget kind) and `StudioGridConfig.gridConditionalFormats[].style`
 * (whose `backgroundColor`/`color` strings sit one level past what the old
 * one-level cap inspected). Both are echoed into `<dashboard_state>` verbatim by
 * `buildAISystemPrompt.ts` on every future request, so an uncapped string
 * nested past the first level is exactly the same persistent token-bomb class
 * `capTitle`/`capFilterValue` already guard against. Values beyond this depth
 * are left as-is (bounded work, not infinite recursion on a pathologically deep
 * structure), same trade-off `capFilterValue` makes.
 */
const MAX_CONFIG_VALUE_DEPTH = 4;

/**
 * Caps a single config value, recursing up to {@link MAX_CONFIG_VALUE_DEPTH}
 * levels deep (Tier 1 architecture-review finding — see
 * {@link MAX_CONFIG_VALUE_DEPTH} for why one level was not enough): a string
 * (e.g. a `funnelCategoryOrder`/`funnelStageSequence` array entry) is
 * length-capped directly; an array (e.g. a nested array inside `customConfig`)
 * has its length bounded to {@link MAX_CONFIG_ARRAY_LENGTH} and each element
 * recursively capped; a plain object (e.g. a `ySeries`/`annotations`/grid
 * `columns` array entry, a nested single-object config value like `forecast`,
 * or an arbitrarily-shaped `customConfig`/`gridConditionalFormats[].style`) has
 * its key COUNT bounded to `MAX_FILTER_VALUE_OBJECT_KEYS` and every value
 * recursively capped. Any other shape (number, boolean, `null`) is left as-is.
 * Shared by {@link capConfigStringValues} for both array ELEMENTS and direct
 * nested-object config VALUES.
 */
function capShallowConfigValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return capString(value, MAX_FILTER_STRING_LENGTH);
  }
  if (depth >= MAX_CONFIG_VALUE_DEPTH) {
    // Finding L2, same bypass as `capFilterValue`'s guard — a container at the depth
    // limit is replaced, never returned verbatim (see {@link DEPTH_LIMIT_MARKER}).
    return value !== null && typeof value === 'object' ? DEPTH_LIMIT_MARKER : value;
  }
  if (Array.isArray(value)) {
    const bounded =
      value.length > MAX_CONFIG_ARRAY_LENGTH ? value.slice(0, MAX_CONFIG_ARRAY_LENGTH) : value;
    return bounded.map((entry) => capShallowConfigValue(entry, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    // Null-prototype for the same reason as `capFilterValue`'s object branch (finding
    // M8) — `customConfig` is arbitrarily shaped model JSON, so `__proto__` is a
    // reachable key here.
    const capped: Record<string, unknown> = Object.create(null);
    const entries = Object.entries(value as Record<string, unknown>);
    const boundedEntries =
      entries.length > MAX_FILTER_VALUE_OBJECT_KEYS
        ? entries.slice(0, MAX_FILTER_VALUE_OBJECT_KEYS)
        : entries;
    for (const [key, prop] of boundedEntries) {
      // Finding M8 — the KEY is length-capped too (`customConfig` is an arbitrarily
      // shaped consumer bag, so its keys are as model-supplied as its values).
      capped[capString(key, MAX_OBJECT_KEY_LENGTH)] = capShallowConfigValue(prop, depth + 1);
    }
    return capped;
  }
  return value;
}

/**
 * Cap every STRING-typed value in a model-supplied widget `config` object before
 * persisting it (Tier 2, iteration 22), AND every ARRAY-typed value's length plus
 * its elements' string content, AND every nested-OBJECT-typed value's string
 * properties RECURSIVELY up to {@link MAX_CONFIG_VALUE_DEPTH} levels deep (Tier 1
 * architecture-review finding — the recursion closes a real gap: a plain
 * one-level cap missed `customConfig`'s arbitrarily-nested consumer JSON and
 * `gridConditionalFormats[].style.backgroundColor`/`color`, both of which sit
 * past the first level). Chart-config string fields
 * such as `xField`/`yField`/`seriesField` (and their per-chart-type siblings —
 * `ganttLabelField`, `sankeyTargetField`, `scatterColorField`, `heatYField`, …)
 * are free-form model-supplied field-id strings with no existing length bound,
 * and `buildAISystemPrompt.ts`'s `describeWidget` echoes every one of them into
 * `<dashboard_state>` on EVERY future request — the same persistent token-bomb
 * class `capTitle`/`capFilterValue` already guard against. Array-typed config
 * fields (`ySeries`, `annotations`, `funnelCategoryOrder`, `funnelStageSequence`,
 * grid `columns`, …) and single nested-object fields (`forecast`, whose `method`
 * is echoed via `describeWidget`'s `enabled (${method}, ${periods} periods)`) are
 * exactly the same class of hazard: `describeWidget` echoes their FULL content
 * (not just a count) into the same prompt block on every turn, so an unbounded
 * array/object — or one containing unboundedly-long strings — is just as much a
 * persistent token bomb as an oversized scalar string. Reuses
 * `MAX_FILTER_STRING_LENGTH` (the bound already applied to filter
 * `field`/`sourceId`) and `MAX_CONFIG_ARRAY_LENGTH` rather than inventing new
 * constants. Other non-string/array/object values (numbers, booleans) are left
 * untouched — they are either already value-checked elsewhere
 * (`invalidConfigValueError`) or out of scope for this cap. Accepts `unknown`
 * (not just a record) so it can be applied directly to an untrusted
 * `args.config` (or a custom widget's `defaultConfig`) at the write source; any
 * non-plain-object input (including `null`/arrays) is returned unchanged for the
 * caller's own shape validation to reject.
 *
 * Finding M8 additionally bounds the config's KEY space, which no cap in this file
 * covered before: the TOP-LEVEL key count ({@link MAX_CONFIG_KEYS} — the nested
 * branches had a key-count bound from the start, the top level did not) and every
 * key's LENGTH at any depth ({@link MAX_OBJECT_KEY_LENGTH}). `customConfig` is a
 * `SHARED_CONFIG_KEYS` member valid on every widget kind and arbitrarily shaped by
 * design, so a 1 MB KEY inside it passed every gate and landed in persisted
 * `doc.widgets` and every future `get_dashboard_state`.
 */
function capConfigStringValues(config: unknown): unknown {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return config;
  }
  // Null-prototype for the same reason as the two helpers above (finding M8).
  const capped: Record<string, unknown> = Object.create(null);
  // Finding M8 — bound the TOP-LEVEL key COUNT and each key's LENGTH, not just the
  // values. The nested branches (`capShallowConfigValue`) already bounded key count;
  // the top level did not, and no branch bounded key names at all. See
  // {@link MAX_CONFIG_KEYS} / {@link MAX_OBJECT_KEY_LENGTH}.
  for (const [rawKey, value] of Object.entries(config as Record<string, unknown>).slice(
    0,
    MAX_CONFIG_KEYS,
  )) {
    const key = capString(rawKey, MAX_OBJECT_KEY_LENGTH);
    if (typeof value === 'string') {
      capped[key] = capString(value, MAX_FILTER_STRING_LENGTH);
    } else if (Array.isArray(value)) {
      // NOT `.map(capShallowConfigValue)`: `Array.prototype.map` invokes its callback
      // with `(element, index, array)`, and `capShallowConfigValue`'s SECOND parameter
      // is now the recursion `depth` (Tier 1 architecture-review finding) — passing the
      // callback directly would silently feed the array INDEX in as `depth`, corrupting
      // the depth budget for every element past index 0. Wrap it so each element always
      // starts its own recursion fresh at `depth = 0`.
      capped[key] = value
        .slice(0, MAX_CONFIG_ARRAY_LENGTH)
        .map((entry) => capShallowConfigValue(entry));
    } else if (value !== null && typeof value === 'object') {
      capped[key] = capShallowConfigValue(value);
    } else {
      capped[key] = value;
    }
  }
  return capped;
}

/**
 * Max number of pages / widgets / filters retained from an INCOMING, client-supplied
 * `dashboardState` before it is interpolated into `<dashboard_state>` (finding F2,
 * Tier 2).
 *
 * Every `cap*` helper above only runs when an AI tool MUTATES state — the very first
 * request's `dashboardState` comes straight from the client `body` and is fed into the
 * system prompt with only `sanitizeForPrompt` (which neutralizes `<`/`>` but neither
 * truncates length nor counts). So a client could post thousands of pages/widgets/
 * filters (each with an oversized title / megabyte filter value) and blow the system
 * prompt up unbounded on turn one — before any tool-call cap can apply, and before
 * `maxTokensPerRequest` (checked only AFTER a turn completes, and a documented no-op
 * when a gateway omits usage chunks) could ever catch it. {@link capIncomingDashboardState}
 * closes that gap by running the incoming state through the same caps at the top of
 * request handling. These count bounds are sized generously — far beyond any realistic
 * hand-authored dashboard — so they only ever trip for a runaway/hostile payload; kept
 * as three separate constants because pages, widgets, and filters legitimately scale
 * very differently.
 */
const MAX_STATE_PAGES = 200;
const MAX_STATE_WIDGETS = 1000;
const MAX_STATE_FILTERS = 500;

/**
 * Max number of `runtime.dataSources` entries retained from an incoming,
 * client-supplied `dashboardState` before it is interpolated into
 * `<dashboard_state>`'s "## Data Sources" section (Tier 1 resource-exhaustion
 * finding, sibling to {@link MAX_STATE_PAGES}/{@link MAX_STATE_WIDGETS}/
 * {@link MAX_STATE_FILTERS}). `buildAISystemPrompt.ts`'s `buildDashboardState`
 * does `Object.values(dataSources)` with NO existing count cap, and
 * `describeSource`/`serializeFieldForAI` interpolate every entry's free-text
 * strings with only `sanitizeForPrompt`'s angle-bracket escaping — escaping
 * neutralizes markup but does not bound size. A client posting thousands of
 * fabricated data sources would blow the very first system prompt up
 * unbounded, before any tool-call cap or token-budget check could apply.
 * Sized like {@link MAX_STATE_FILTERS} — a real integration wires at most a
 * few dozen data sources, so this only ever trips a runaway/hostile payload.
 */
const MAX_STATE_DATA_SOURCES = 500;

/**
 * Max number of `fields` entries retained per data source in the same cap pass
 * (see {@link MAX_STATE_DATA_SOURCES}). `describeSource` iterates every field
 * with no existing cap, and each field is individually rendered via
 * `serializeFieldForAI` in `<dashboard_state>`.
 */
const MAX_STATE_DATA_SOURCE_FIELDS = 500;

/**
 * Max length of a model-supplied entity `.id` (widget/page/data-source) retained
 * from an incoming, client-supplied `dashboardState` (Tier 1 architecture-review
 * finding). Unlike a `title`/`label`, an entity's `.id` is a SEPARATE field from
 * its map key — `buildAISystemPrompt.ts` echoes it verbatim regardless
 * (`pushField('id', widget.id)`, `sanitizeForPrompt(page.id)`,
 * `sanitizeForPrompt(source.id)`) on EVERY future request, and
 * `sanitizeForPrompt` only escapes `<`/`>` — it never bounds length. So an
 * oversized `.id` is the same persistent token-bomb class `capTitle` already
 * guards the title fields against. Reuses `MAX_FILTER_STRING_LENGTH` (the
 * identifier-string bound already applied to `sourceId`/filter `field`) rather
 * than inventing a new constant for the same class of short id string.
 */
const MAX_ENTITY_ID_LENGTH = MAX_FILTER_STRING_LENGTH;

/**
 * Max number of rows retained in an incoming, client-supplied `page.widgetRows`
 * layout matrix (Tier 1 architecture-review finding). Mirrors
 * {@link MAX_LAYOUT_ROWS} — the bound already applied to the model-authored
 * `set_widget_layout` write path — for the INCOMING request-body read path:
 * `buildAISystemPrompt.ts`'s "## Layout" block iterates the active page's
 * `widgetRows` with no cap of its own on the very first request.
 */
const MAX_STATE_LAYOUT_ROWS = MAX_LAYOUT_ROWS;

/**
 * Max number of widget-id cells retained per incoming `page.widgetRows` row (see
 * {@link MAX_STATE_LAYOUT_ROWS}). A single pathological row (e.g. one widget id
 * repeated a million times) is just as unbounded as too many rows.
 */
const MAX_STATE_LAYOUT_ROW_CELLS = 50;

/**
 * Max number of entries retained in an incoming `page.widgetColSpans` map (see
 * {@link MAX_STATE_LAYOUT_ROWS}). A well-formed `widgetColSpans` map never
 * legitimately carries more entries than there are widgets, so it is bounded to
 * the same count as {@link MAX_STATE_WIDGETS}.
 */
const MAX_STATE_WIDGET_COL_SPANS = MAX_STATE_WIDGETS;

/**
 * Max number of `capabilities` entries retained per incoming data-source field
 * (finding H1d). `serializeFieldForAI` renders `f.capabilities.join('+')` into
 * every field's tag list with no cap of its own, so an unbounded array is the same
 * first-request token bomb as an unbounded `label`. A real field declares one or
 * two capabilities.
 */
const MAX_STATE_FIELD_CAPABILITIES = 20;

/**
 * Max number of `fieldDistinctValues` map entries retained per incoming data
 * source (finding H1c). Bounded to the same count as the source's own field list,
 * since a well-formed map never carries more entries than there are fields.
 */
const MAX_STATE_FIELD_DISTINCT_VALUE_KEYS = MAX_STATE_DATA_SOURCE_FIELDS;

/**
 * Max length of a single `fieldDistinctValues` value retained (finding H1c).
 * `serializeFieldForAI` renders every value IN FULL when a field has ≤8 of them,
 * so one 50 MB value passed straight into the first system prompt —
 * `MAX_DISTINCT_VALUES_IN_STATE_OUTPUT` already existed for the
 * `get_dashboard_state` output path but was never applied to this read path.
 * Reuses {@link MAX_FILTER_STRING_LENGTH}: a distinct value is the same class of
 * short data string as a filter value, which is already bounded by it.
 */
const MAX_STATE_DISTINCT_VALUE_LENGTH = MAX_FILTER_STRING_LENGTH;

/**
 * Max number of distinct values retained per field on the incoming READ path
 * (finding H1c).
 *
 * Deliberately NOT `MAX_DISTINCT_VALUES_IN_STATE_OUTPUT` (20), which bounds the
 * `get_dashboard_state` OUTPUT path: `serializeFieldForAI` renders the values in
 * full at ≤8, renders a bare `"N values"` count at ≤30, and omits them entirely
 * above 30. Truncating to 20 here would rewrite a 10,000-value high-cardinality
 * field into a plausible-looking `"20 values"` cardinality hint and mislead the
 * model's chart/filter-type choices. 50 sits above every rendering threshold, so
 * each field renders EXACTLY as it did before while the retained array is bounded.
 */
const MAX_STATE_DISTINCT_VALUES_PER_FIELD = 50;

/** Cap a model-supplied entity id to {@link MAX_ENTITY_ID_LENGTH}. */
function capEntityId(id: string): string {
  return capString(id, MAX_ENTITY_ID_LENGTH);
}

/**
 * Cap a model-supplied `StudioDataField`'s free-text strings before it is
 * persisted onto an incoming data source (see {@link MAX_STATE_DATA_SOURCES}).
 * `label`/`aiDescription` reuse {@link MAX_TITLE_LENGTH} — the same bound
 * already applied to dashboard/page/widget titles — rather than inventing a
 * new constant for the same class of free-text string. `format` is nominally
 * typed as a fixed `StudioNumberFormat` enum, but `dashboardState` is
 * client-supplied JSON with no runtime enum check, so it is capped the same
 * defensive way (`serializeFieldForAI` interpolates it verbatim).
 */
function capDataSourceField(field: StudioDataField): StudioDataField {
  // Finding M3: `dashboardState` is unvalidated client JSON, so a `fields: [null]`
  // entry reached `field.label` here and threw a raw, unprefixed `TypeError`.
  // `validateStudioAIRequestBody` now rejects that shape up front; this stays as
  // defense-in-depth for the other (non-`handleAIChat`) callers of this cap pass.
  const f = (field ?? {}) as StudioDataField;
  return {
    ...f,
    // Finding H1d — `id` is echoed into EVERY field rendering
    // (`serializeFieldForAI`'s `sanitizeForPrompt(f.id)`) on every request, exactly
    // like the source/page/widget ids `capEntityId` already bounds; only
    // `label`/`format`/`aiDescription` were capped before.
    id: capEntityId(asString(f.id ?? '')),
    label: capTitle(asString(f.label ?? '')),
    ...(f.format !== undefined
      ? { format: capString(asString(f.format), MAX_TITLE_LENGTH) as StudioDataField['format'] }
      : {}),
    // Finding H1d — rendered as `capabilities.join('+')`, unbounded in both entry
    // count and per-entry length.
    ...(Array.isArray(f.capabilities)
      ? {
          capabilities: f.capabilities
            .slice(0, MAX_STATE_FIELD_CAPABILITIES)
            .map((c) =>
              capString(asString(c ?? ''), MAX_FILTER_STRING_LENGTH),
            ) as StudioDataField['capabilities'],
        }
      : {}),
    // Finding H1d — rendered as `default:<value>` in the field's tag list.
    ...(f.defaultAggregationFn !== undefined
      ? {
          defaultAggregationFn: capString(
            asString(f.defaultAggregationFn),
            MAX_FILTER_STRING_LENGTH,
          ) as StudioDataField['defaultAggregationFn'],
        }
      : {}),
    ...(f.aiDescription !== undefined
      ? { aiDescription: capTitle(asString(f.aiDescription)) }
      : {}),
  };
}

/**
 * Cap an incoming `source.fieldDistinctValues` map (finding H1c).
 *
 * `serializeFieldForAI` renders every value IN FULL when a field has ≤8 of them,
 * so a single oversized value landed verbatim in the first system prompt.
 * `capDataSource` never touched this map before, even though
 * `MAX_DISTINCT_VALUES_IN_STATE_OUTPUT` already existed for the
 * `get_dashboard_state` OUTPUT path — this applies the same bound to the incoming
 * READ path, plus a per-value length cap and a map-key count/length cap.
 */
function capFieldDistinctValues(
  fieldDistinctValues: Record<string, string[]> | undefined,
): Record<string, string[]> | undefined {
  if (fieldDistinctValues === undefined || fieldDistinctValues === null) {
    return undefined;
  }
  // `Object.create(null)` (finding L1): the keys are client-supplied field ids, and
  // a `__proto__`/`constructor` key must address an ordinary own slot rather than
  // being silently dropped or routed into the prototype.
  const capped: Record<string, string[]> = Object.create(null);
  for (const [fieldId, values] of Object.entries(fieldDistinctValues).slice(
    0,
    MAX_STATE_FIELD_DISTINCT_VALUE_KEYS,
  )) {
    // A malformed (non-array) entry is DROPPED rather than coerced to `[]`: an empty
    // array would render as a `0: ` cardinality hint, inventing a fact about the
    // field. Dropping it renders exactly as "no distinct values known" (finding M1's
    // sibling — the read site also `Array.isArray`-guards this).
    if (Array.isArray(values)) {
      capped[capEntityId(asString(fieldId))] = values
        .slice(0, MAX_STATE_DISTINCT_VALUES_PER_FIELD)
        .map((v) => capString(asString(v ?? ''), MAX_STATE_DISTINCT_VALUE_LENGTH));
    }
  }
  return capped;
}

/**
 * Cap a model-supplied `StudioDataSource` before it is interpolated into
 * `<dashboard_state>`'s "## Data Sources" section (see
 * {@link MAX_STATE_DATA_SOURCES}). Caps the `fields` count
 * ({@link MAX_STATE_DATA_SOURCE_FIELDS}) and every field's free-text strings
 * (via {@link capDataSourceField}), plus the source's own `label`/
 * `aiDescription`/`id` ({@link MAX_ENTITY_ID_LENGTH} — see its doc comment for
 * why the `id`, a field separate from the map key, must be length-capped too).
 *
 * `tableName` is normalized rather than capped, because it is the one field here
 * that leaves the process: it is forwarded to the host's `queryDataSource` (and,
 * for a Knex host, straight into `db(tableName)`) instead of merely being rendered
 * into the prompt. The `...source` spread used to pass it through untouched, so a
 * request body asserting `tableName: { orders: 'secrets' }` reached the host as an
 * object — which Knex reads as an alias map, querying a table the caller chose.
 * A non-string or over-long value is therefore DROPPED, not coerced or truncated:
 * coercing `{…}` would invent a table name (`String({…})` yields
 * `"[object Object]"`; the {@link asString} that replaced it yields `""`) and a
 * truncated name would address a DIFFERENT table, whereas dropping it leaves the
 * source without a `tableName`, which every resolver already reports as an unknown
 * / unqueryable data source.
 */
function capDataSource(source: StudioDataSource): StudioDataSource {
  const cappedDistinct = capFieldDistinctValues(source.fieldDistinctValues);
  const usableTableName =
    typeof source.tableName === 'string' &&
    source.tableName.length > 0 &&
    source.tableName.length <= MAX_FILTER_STRING_LENGTH;
  return {
    ...source,
    id: capEntityId(asString(source.id ?? '')),
    label: capTitle(asString(source.label ?? '')),
    ...(source.tableName !== undefined && !usableTableName ? { tableName: undefined } : {}),
    ...(source.aiDescription !== undefined
      ? { aiDescription: capTitle(asString(source.aiDescription)) }
      : {}),
    fields: (Array.isArray(source.fields) ? source.fields : [])
      .slice(0, MAX_STATE_DATA_SOURCE_FIELDS)
      .map(capDataSourceField),
    // Finding H1c — this map was never capped, even though every value in it is
    // rendered verbatim into the first system prompt for a ≤8-value field.
    ...(cappedDistinct !== undefined ? { fieldDistinctValues: cappedDistinct } : {}),
  };
}

/**
 * Cap a client-supplied `page.widgetRows` layout matrix and `widgetColSpans` map
 * before it is interpolated into `<dashboard_state>`'s "## Layout" block (Tier 1
 * architecture-review finding, sibling to `capDataSources`). Bounds the ROW
 * count and the CELL count per row ({@link MAX_STATE_LAYOUT_ROWS}/
 * {@link MAX_STATE_LAYOUT_ROW_CELLS} — mirroring `set_widget_layout`'s own
 * {@link MAX_LAYOUT_ROWS} write-path cap, which this incoming-state read path had
 * no equivalent of), each retained cell id's length
 * ({@link MAX_ENTITY_ID_LENGTH}), and the `widgetColSpans` entry count
 * ({@link MAX_STATE_WIDGET_COL_SPANS}). Truncates rather than rejects — this
 * runs on the READ path (the very first request's `dashboardState`), which has
 * no caller to report a validation error back to.
 */
function capPageWidgetRows(
  widgetRows: string[][] | undefined,
): { widgetRows: string[][] } | Record<string, never> {
  // Finding M3: `widgetRows` is unvalidated client JSON — a `"abc"` (string) or
  // `["abc"]` (array of strings) value previously reached `.slice(…).map(…)` on a
  // non-array row and threw a raw `TypeError: row.slice is not a function`.
  // `validateStudioAIRequestBody` now rejects those shapes up front; this stays as
  // defense-in-depth for the other callers, normalising a malformed row to empty
  // rather than throwing.
  if (!Array.isArray(widgetRows)) {
    return {};
  }
  return {
    widgetRows: widgetRows
      .slice(0, MAX_STATE_LAYOUT_ROWS)
      .map((row) =>
        (Array.isArray(row) ? row : [])
          .slice(0, MAX_STATE_LAYOUT_ROW_CELLS)
          .map((id) => capEntityId(asString(id ?? ''))),
      ),
  };
}

/**
 * Cap a client-supplied `runtime.dataSources` map (Tier 1 resource-exhaustion
 * finding — see {@link MAX_STATE_DATA_SOURCES}) before `capIncomingDashboardState`
 * threads it forward. Bounds entry count, per-source field count, and every
 * free-text string, mirroring the `doc`-partition caps below.
 */
function capDataSources(
  dataSources: Record<string, StudioDataSource>,
): Record<string, StudioDataSource> {
  // `Object.create(null)`, not `{}` (finding L1): these keys come straight from the
  // client body, and a source keyed `__proto__` would otherwise be silently dropped
  // from the prompt (an assignment to `{}`'s `__proto__` with an object value
  // rewrites the prototype instead of creating an entry). A null-prototype map has
  // no such member, so every key round-trips as an ordinary own property. Every
  // downstream read of this map already goes through an `Object.hasOwn` guard.
  const capped: Record<string, StudioDataSource> = Object.create(null);
  for (const [id, source] of Object.entries(dataSources).slice(0, MAX_STATE_DATA_SOURCES)) {
    // Finding H1g — the map KEY is echoed into the prompt independently of the
    // entry's own `.id` field (`Object.entries` in `projectStateForAI`, and the
    // key is what every `sourceId` reference resolves against), so it needs the
    // same length bound `.id` already gets.
    capped[capEntityId(asString(id))] = capDataSource(source);
  }
  return capped;
}

/**
 * Cap a client-supplied `dashboardState` (finding F2, Tier 2) by running its
 * dashboard title, pages, widgets, and filters through the SAME caps the AI-tool
 * mutation paths already apply at their write sources — `capTitle` for dashboard/
 * page/widget titles, `capEntityId` for each widget/page/data-source `id`,
 * `capSourceId` for widget `sourceId`, `capConfigStringValues` for each widget
 * `config`, `capPageWidgetRows` for each page's `widgetRows`/`widgetColSpans`
 * layout, `capFilterValue` for each filter `value`/`value2`, and
 * `MAX_FILTER_STRING_LENGTH` for filter `field`/`filterSourceId` — plus a count cap
 * on each of pages/widgets/filters ({@link MAX_STATE_PAGES}/{@link MAX_STATE_WIDGETS}/
 * {@link MAX_STATE_FILTERS}).
 *
 * Also caps `runtime.dataSources` (Tier 1 resource-exhaustion finding —
 * see {@link MAX_STATE_DATA_SOURCES}/{@link capDataSources}): unlike the other
 * `doc` partitions this cap guards, `dataSources` is interpolated into the
 * system prompt directly from `runtime`, with no per-tool-call write path of
 * its own to cap at — so this is the ONLY chokepoint that bounds it.
 *
 * Applied once, at the top of `handleAIChat` request handling, BEFORE the state is
 * used to build the system prompt or threaded into the agentic loop as the starting
 * `currentState`. Returns a shallow-cloned state; the input is not mutated.
 *
 * WHAT THIS DOES **NOT** COVER (corrected — the previous wording called these
 * "non-interpolated … passed through unchanged", which was false for the first
 * half): the `doc` sub-partitions `relationships`, `expressionFields`,
 * `filterPresets` and `ai` are passed through UNCAPPED, and they are NOT
 * uninterpolated — `projectStateForAI` spreads the whole `doc` (minus `ai`), so all
 * three of `relationships`/`expressionFields`/`filterPresets` are emitted verbatim
 * by the `get_dashboard_state` tool and the `studio://dashboard/state` resource.
 * They are absent only from the `<dashboard_state>` SYSTEM PROMPT block, which is
 * what the original claim actually described. The bounds that do apply to them are
 * downstream, not here: `capToolOutput` bounds the chat tool-result size, and
 * `projectStateForAI` length-caps the `ai` thread `id`/`name` it emits (that path
 * has no write-source cap of its own). Adding count/shape caps for the three
 * structured sub-partitions is deliberately NOT done here — each is a typed graph
 * the reducer and the pipeline consume by shape, so truncating one would silently
 * break relationship resolution or expression evaluation rather than merely
 * shortening a string; bounding them belongs at the same `validateStudioAIRequestBody`
 * shape boundary that already types the rest of the body.
 */
export function capIncomingDashboardState(state: StudioState): StudioState {
  const { doc } = state;

  const cappedDashboard = {
    ...doc.dashboard,
    title: capTitle(asString(doc.dashboard.title ?? '')),
    // Finding M8 — `activePageId` was the one `doc.dashboard` field that is neither
    // type-validated by `validateStudioAIRequestBody` nor capped here, yet it is
    // echoed verbatim into `list_pages` and `get_dashboard_state` output and read as
    // a page-map key by nearly every tool. Same `capEntityId` bound the page ids it
    // is compared against already get, so the two can't disagree about length.
    activePageId: capEntityId(asString(doc.dashboard.activePageId ?? '')),
  };

  // `Object.create(null)` for both maps (finding L1) and a capped map KEY for every
  // entry (finding H1g) — see `capDataSources` above for both rationales. The key is
  // a SEPARATE string from the entry's own `.id`: `buildAISystemPrompt.ts` echoes the
  // key wherever a layout row or `focusedWidgetId` names it, so capping only `.id`
  // left the key unbounded.
  const cappedWidgets: Record<string, StudioWidget> = Object.create(null);
  for (const [id, widget] of Object.entries(doc.widgets).slice(0, MAX_STATE_WIDGETS)) {
    cappedWidgets[capEntityId(asString(id))] = {
      ...widget,
      // `widget?.` throughout (finding M3): a `doc.widgets: { w1: null }` body
      // previously threw a raw `TypeError: Cannot read properties of null (reading
      // 'id')` right here. The validator now rejects that shape; these guards keep
      // the other callers of this cap pass crash-free too.
      id: capEntityId(asString(widget?.id ?? '')),
      title: capTitle(asString(widget?.title ?? '')),
      ...(widget?.subtitle !== undefined
        ? { subtitle: capString(asString(widget.subtitle), MAX_TITLE_LENGTH) }
        : {}),
      ...(widget?.sourceId !== undefined
        ? { sourceId: capSourceId(asString(widget.sourceId)) }
        : {}),
      // Finding M3 — default a missing `config` to `{}`. Every widget-describing
      // branch in `buildAISystemPrompt.ts` dereferences it (`resolveChartType(cfg)`,
      // `kpiCfg.kpiValueField`, …), so a config-less widget on the active page threw
      // an opaque `TypeError: Cannot read properties of undefined (reading
      // 'chartType')` and killed every chat request for that dashboard.
      config: capConfigStringValues(widget?.config ?? {}) as StudioWidget['config'],
    } as StudioWidget;
  }

  const cappedPages: Record<string, StudioPage> = Object.create(null);
  for (const [id, page] of Object.entries(doc.pages).slice(0, MAX_STATE_PAGES)) {
    // `page?.` throughout (finding M3): a `doc.pages: { p1: null }` body previously
    // threw a raw `TypeError: Cannot read properties of null (reading
    // 'widgetColSpans')` right here.
    const cappedColSpans =
      page?.widgetColSpans && typeof page.widgetColSpans === 'object'
        ? Object.fromEntries(
            Object.entries(page.widgetColSpans)
              .slice(0, MAX_STATE_WIDGET_COL_SPANS)
              .map(([spanId, span]) => [capEntityId(asString(spanId)), span]),
          )
        : undefined;
    cappedPages[capEntityId(asString(id))] = {
      ...page,
      id: capEntityId(asString(page?.id ?? '')),
      title: capTitle(asString(page?.title ?? '')),
      ...capPageWidgetRows(page?.widgetRows),
      ...(cappedColSpans !== undefined ? { widgetColSpans: cappedColSpans } : {}),
    };
  }

  // `f?.` throughout (finding M3): a `doc.filters: [null]` body previously threw a
  // raw `TypeError: Cannot read properties of null (reading 'field')` here.
  const cappedFilters: StudioFilterState[] = doc.filters.slice(0, MAX_STATE_FILTERS).map((f) => ({
    ...f,
    field: capString(asString(f?.field ?? ''), MAX_FILTER_STRING_LENGTH),
    ...(f?.filterSourceId !== undefined
      ? { filterSourceId: capString(asString(f.filterSourceId), MAX_FILTER_STRING_LENGTH) }
      : {}),
    value: capFilterValue(f?.value),
    ...(f?.value2 !== undefined ? { value2: capFilterValue(f.value2) } : {}),
  }));

  return {
    ...state,
    doc: {
      ...doc,
      dashboard: cappedDashboard,
      pages: cappedPages,
      widgets: cappedWidgets,
      filters: cappedFilters,
    },
    runtime: {
      ...state.runtime,
      dataSources: capDataSources(state.runtime.dataSources),
    },
  };
}

/**
 * Project a `StudioDataSource` down to AI-safe metadata for `get_dashboard_state`.
 *
 * Strips `rows` (raw live table data — an exfiltration / token-bomb path that also
 * contradicts the system prompt's no-raw-data rule and defeats `privateMode`) and
 * `adapter` (a non-serializable host callback) entirely, and caps
 * `fieldDistinctValues` per field with a `truncated` marker. `describe_data_source`
 * is the intentional, opt-in channel for sample rows — this dump is not.
 */
export function projectDataSourceMetadata(source: StudioDataSource): Record<string, unknown> {
  // `Object.create(null)`, not `{}` (finding M8): these keys are DATABASE COLUMN
  // names, so a column literally named `__proto__` assigned an object value would
  // rewrite the prototype instead of creating an entry — that field's distinct
  // values would silently vanish from `get_dashboard_state` AND from the
  // `studio://dashboard/state` resource while everything reported success. The
  // sibling `capFieldDistinctValues` above already uses a null-prototype map over
  // the same key space, for the same reason.
  const cappedDistinct: Record<string, { values: string[]; truncated: boolean }> =
    Object.create(null);
  for (const [fieldId, values] of Object.entries(source.fieldDistinctValues ?? {})) {
    // `Array.isArray` before `.slice` (finding M8): `fieldDistinctValues` is
    // client-supplied JSON on every path that does not go through
    // `capFieldDistinctValues` (which drops malformed entries for this exact
    // reason), so a `{ revenue: "abc" }` entry reached `.slice`/`.length` on a
    // non-array. A string would have `slice`d into a fake value list and a number
    // would have thrown a raw `TypeError` out of a read-only tool. Drop it instead:
    // an empty list would render as a `0 values` cardinality hint, inventing a fact
    // about the field.
    if (!Array.isArray(values)) {
      continue;
    }
    cappedDistinct[fieldId] = {
      values: values.slice(0, MAX_DISTINCT_VALUES_IN_STATE_OUTPUT),
      truncated: values.length > MAX_DISTINCT_VALUES_IN_STATE_OUTPUT,
    };
  }
  return {
    id: source.id,
    label: source.label,
    tableName: source.tableName,
    aiDescription: source.aiDescription,
    hidden: source.hidden,
    fields: source.fields,
    fieldDistinctValues: cappedDistinct,
  };
}

/**
 * Per-thread AI metadata emitted in the AI-safe state snapshot — the shape
 * `doc.ai` is reduced to. Deliberately carries NO `messages`: only enough for the
 * model to know which threads exist and how large each is.
 */
export interface ProjectedAIThread {
  id: string;
  name: string;
  updatedAt?: string;
  messageCount: number;
}

/** The AI-safe `doc.ai` replacement: thread metadata with all transcripts removed. */
export interface ProjectedAIState {
  activeThreadId?: string;
  threads: ProjectedAIThread[];
}

/** The AI-safe `{ doc, dataSources }` snapshot shared by both read surfaces. */
export interface ProjectedStateForAI {
  doc: Omit<StudioState['doc'], 'ai'> & { ai?: ProjectedAIState };
  dataSources: Record<string, unknown>;
}

/**
 * Project a `StudioState` down to the AI-safe `{ doc, dataSources }` snapshot that
 * both the `get_dashboard_state` TOOL and the `studio://dashboard/state` MCP
 * RESOURCE emit. This is the single home for the read-surface redaction contract —
 * previously the doc half was hand-copied across both call sites, so a leak (or a
 * new sensitive `StudioDoc` sub-partition) had to be remembered in two files.
 *
 * Two redactions happen here, in ONE place so the two surfaces cannot drift:
 *
 * 1. `runtime.dataSources` is projected through `projectDataSourceMetadata`, which
 *    strips `rows` (raw live table data) and `adapter` (a non-serializable host
 *    callback) and caps `fieldDistinctValues`. Emitting the raw `StudioState` here
 *    would leak live rows into the model context — a token bomb and an exfiltration
 *    path that defeats `privateMode`.
 * 2. `doc.ai` is reduced to per-thread METADATA (`{ id, name, updatedAt,
 *    messageCount }`) with every message transcript removed. `StudioAIChatThread.messages`
 *    holds the FULL history of EVERY thread (not just the active one), and `doc.ai`
 *    is persisted with shareable dashboards — so echoing it verbatim would dump every
 *    conversation's transcript back to the provider (cross-conversation information
 *    disclosure + an unbounded token bomb). The model already has the active thread as
 *    its live message array, so it needs no chat history in this snapshot. The
 *    surviving `id`/`name`/`updatedAt` are length-capped here (finding M8) because
 *    this is their ONLY chokepoint: `rename_thread` bounds the name it writes, but
 *    `doc.ai` arrives from the request body and `capIncomingDashboardState` does not
 *    touch that sub-partition.
 *
 * What is deliberately NOT redacted: the rest of `doc` is spread through verbatim,
 * including `relationships`, `expressionFields` and `filterPresets`. They are
 * authored dashboard structure the model legitimately needs, not host or user
 * secrets — but note that they ARE emitted here (an earlier comment on
 * `capIncomingDashboardState` wrongly described them as non-interpolated), so they
 * are bounded only by `capToolOutput` on the chat path.
 */
export function projectStateForAI(state: StudioState): ProjectedStateForAI {
  // `Object.create(null)`, not `{}` (finding M8): the keys are client-supplied data
  // source ids, and a source keyed `__proto__` would be silently dropped from BOTH
  // read surfaces (assigning an object to `{}`'s `__proto__` rewrites the prototype
  // rather than creating an entry) — the model would then be told a `sourceId` the
  // dashboard really has does not exist. The sibling `capDataSources` uses a
  // null-prototype map over the same key space for the same reason.
  const dataSources: Record<string, unknown> = Object.create(null);
  for (const [id, source] of Object.entries(state.runtime.dataSources)) {
    dataSources[id] = projectDataSourceMetadata(source);
  }
  const { ai, ...docWithoutAi } = state.doc;
  const redactedAi: ProjectedAIState | undefined = ai
    ? {
        ...(ai.activeThreadId ? { activeThreadId: capEntityId(asString(ai.activeThreadId)) } : {}),
        // `id`/`name` are length-capped here (finding M8). Unlike every other string
        // this snapshot emits they have no write-source cap: `rename_thread` bounds
        // the name it SETS to 40 chars, but `doc.ai` arrives from the request body
        // and `capIncomingDashboardState` passes the whole `ai` sub-partition through
        // untouched, so a client-supplied 50 MB thread name landed verbatim in
        // `get_dashboard_state` output and in `studio://dashboard/state`.
        threads: (Array.isArray(ai.threads) ? ai.threads : []).map((thread) => ({
          id: capEntityId(asString(thread?.id)),
          name: capTitle(asString(thread?.name)),
          ...(thread?.updatedAt ? { updatedAt: capTitle(asString(thread.updatedAt)) } : {}),
          messageCount: Array.isArray(thread?.messages) ? thread.messages.length : 0,
        })),
      }
    : undefined;
  return {
    doc: { ...docWithoutAi, ...(redactedAi ? { ai: redactedAi } : {}) },
    dataSources,
  };
}

/** Context threaded into every pure tool's `plan` function. */
export interface ToolPlanContext {
  state: StudioState;
  customWidgets?: StudioCustomWidgetDef[];
  pageSnapshot?: string;
  /**
   * The id of the page the `pageSnapshot` was built for — captured ONCE at request
   * time (the active page when the request began). `summarise_page` compares the
   * requested page against THIS, not the threaded `state.doc.dashboard.activePageId`,
   * so a same-turn `set_active_page` cannot make it narrate the wrong page's snapshot
   * (finding 2-2).
   */
  snapshotPageId?: string;
}

/**
 * A tool whose execution is a pure function of `(args, ctx) => ToolExecutionResult`
 * — no I/O, no shared-state mutation, safe to call speculatively (dry-run) and
 * discard. This is the shape `toolPolicy.ts`'s execute-then-gate chokepoint
 * depends on: see the PURITY INVARIANT documented there.
 */
export interface PureToolImpl {
  effect: 'pure';
  plan: (args: Record<string, unknown>, ctx: ToolPlanContext) => ToolExecutionResult;
}

/**
 * A tool whose execution has a side effect (I/O) and therefore must NEVER be
 * routed through the execute-then-gate dry-run path — it must be authorized
 * BEFORE it runs, args-only. `query_data_source` is the only member: its real
 * dispatch lives in `agenticLoop/toolDispatch.ts` (chat) and `mcp/dataTools.ts`
 * (MCP), both consulting the policy first, and is intentionally NOT reachable through
 * `executeToolOnState` — see the `default` case below. This entry exists
 * purely so `TOOL_IMPLS` is exhaustive over every `StudioAIToolName`, letting
 * a future consumer type `executeToolWithPolicy`'s
 * accepted shape as `PureToolImpl`-only.
 */
export interface ExternalToolImpl {
  effect: 'external';
}

/**
 * `Object.hasOwn`-guarded read of a model-supplied id from a plain-object map.
 *
 * Every entity map in `state.doc` (`widgets`, `pages`, …) is a plain object, so a
 * bare `map[id]` walks the prototype chain: a model-supplied id like `"constructor"`,
 * `"toString"`, or `"__proto__"` resolves to a truthy inherited function and passes a
 * naive `if (map[id])` existence check — even though the shared reducer
 * (`applyMutation.ts`) is fully `Object.hasOwn`-hardened and silently no-ops on that
 * same key. That mismatch is finding T2-1: the executor reports `success: true` for a
 * call the reducer treated as a no-op (budget/SSE/persistence-hook pollution + a
 * model/actual-state desync), and for `add_widget_filter` actually COMMITS a dangling
 * filter (its `addFilter` reducer applies the filter verbatim regardless). Routing
 * every model-supplied id lookup through these helpers makes the executor's
 * existence checks agree with the reducer's own-property discipline.
 */
function hasOwnEntity(map: object, id: string): boolean {
  return Object.hasOwn(map, id);
}

/** `Object.hasOwn`-guarded widget lookup (see `hasOwnEntity`). */
function getWidget(state: StudioState, id: string): StudioWidget | undefined {
  return Object.hasOwn(state.doc.widgets, id) ? state.doc.widgets[id] : undefined;
}

/** `Object.hasOwn`-guarded page lookup (see `hasOwnEntity`). */
function getPage(state: StudioState, id: string): StudioState['doc']['pages'][string] | undefined {
  return Object.hasOwn(state.doc.pages, id) ? state.doc.pages[id] : undefined;
}

/**
 * `Object.hasOwn`-guarded read of one widget's column span from a page's
 * `widgetColSpans` map (finding M8), returning `null` for "no span set".
 *
 * `widgetColSpans` is keyed by a model-supplied widget id, and it is the second of
 * the two maps the MCP-side `ownArrayEntry` helper was introduced for. The bare
 * `page?.widgetColSpans?.[widgetId]` this replaces walked the prototype chain: for
 * `widgetId: 'constructor'` it resolved `Object` — a truthy non-number — and
 * `set_widget_width` reported `{ success: true, columns: <the Object function> }`,
 * telling the model a width had been applied that the reducer never wrote. The
 * `typeof … === 'number'` check makes the read total in the other direction too, so
 * a client-supplied non-numeric span reads back as "unset" rather than being echoed.
 */
function getWidgetColSpan(
  page: StudioState['doc']['pages'][string] | undefined,
  widgetId: string,
): number | null {
  const spans = page?.widgetColSpans;
  if (!spans || typeof spans !== 'object' || !Object.hasOwn(spans, widgetId)) {
    return null;
  }
  const span = spans[widgetId];
  return typeof span === 'number' ? span : null;
}

/**
 * Validates `config`'s keys against the given widget `kind` (via the shared
 * `validateConfigKeysForKind` runtime guard) and, if any key doesn't belong to
 * that kind, returns a human-readable error string naming the offending keys.
 * Returns `undefined` when the config is valid (or the kind is unrestricted).
 * Shared by every AI-tool call site that writes untrusted, model-supplied
 * `config` onto a widget of a known kind (`buildWidgetFromArgs`, `update_widget`,
 * `apply_bulk_update`'s updates loop) so the error wording stays consistent.
 */
function invalidConfigKeyError(kind: string, config: Record<string, unknown>): string | undefined {
  const invalidKeys = validateConfigKeysForKind(kind, config);
  // `joinIdsForError`, not a bare `.join` (finding M8 sibling): the offending keys are
  // model-supplied and there can be as many of them as the config has keys, so the
  // unbounded join echoed the whole set straight back into the conversation — the same
  // response-echo bomb the layout-id errors already bound.
  return invalidKeys.length > 0
    ? `config carries key(s) not valid for a '${kind}' widget: ${joinIdsForError(invalidKeys)}`
    : undefined;
}

/**
 * Curated primitive types for the scalar config fields the AI tools populate (finding
 * 3.2). Key validation (`invalidConfigKeyError`) is a key-PRESENCE check only — it never
 * inspects values — so a valid config key can still carry a wrong-typed value. The
 * concrete hazard: `update_widget({ config: { pivotShowTotals: "</dashboard_state>…" } })`
 * stores a STRING in a field declared `boolean`, which is (a) a structurally-broken
 * widget the client must then render, and (b) the exact stored-prompt-injection surface
 * behind finding 1.1 (the value was later echoed into `<dashboard_state>` verbatim).
 *
 * This is a lightweight, fail-closed value-shape backstop AT THE WRITE SOURCE — the
 * prompt boundary's `sanitizeForPrompt` choke point is the primary injection defense;
 * this additionally stops the malformed value from ever landing in state. The set is
 * intentionally small (the scalar toggles the tools populate); non-scalar/structured
 * config (arrays, nested objects like `ySeries`/`forecast`) is out of scope here, and
 * `set_widget_forecast` coerces its own nested `periods` separately.
 */
const SCALAR_CONFIG_VALUE_TYPES: Record<string, 'number' | 'boolean'> = {
  // boolean toggles
  dualYAxis: 'boolean',
  sankeyShowValues: 'boolean',
  pieLegendBelow: 'boolean',
  kpiSparkline: 'boolean',
  kpiTrend: 'boolean',
  kpiTrendInvert: 'boolean',
  pivotShowTotals: 'boolean',
  mapCrossFilterEmit: 'boolean',
  // numeric settings
  barBandLabelWrap: 'number',
  wrapBandLabelMaxLines: 'number',
  barCategoryGapRatio: 'number',
  barMinBandSize: 'number',
  barMaxCategories: 'number',
  axisTickFontSize: 'number',
  funnelGap: 'number',
  pieArcLabelMinAngle: 'number',
  pieMaxSlices: 'number',
  scatterMinRadius: 'number',
  scatterMaxRadius: 'number',
  gaugeMin: 'number',
  gaugeMax: 'number',
};

/**
 * Validates that every scalar-typed key present in a model-supplied `config` carries a
 * value of the expected primitive type (see `SCALAR_CONFIG_VALUE_TYPES`). Returns a
 * human-readable error naming the offending keys, or `undefined` when all present scalar
 * values are well-typed. A `null`/`undefined` value is treated as inert (clearing a key
 * is handled by the dedicated unset paths), not a type violation. Shared by every tool
 * that writes untrusted `config` (`buildWidgetFromArgs`, `update_widget`, the bulk
 * updates loop) so the wording and the allow-list stay identical.
 */
function invalidConfigValueError(config: Record<string, unknown>): string | undefined {
  const offenders: string[] = [];
  for (const [key, expected] of Object.entries(SCALAR_CONFIG_VALUE_TYPES)) {
    if (!Object.hasOwn(config, key)) {
      continue;
    }
    const value = config[key];
    if (value === null || value === undefined) {
      continue;
    }
    if (expected === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        offenders.push(`${key} (expected a finite number)`);
      }
    } else if (typeof value !== 'boolean') {
      offenders.push(`${key} (expected a boolean)`);
    }
  }
  return offenders.length > 0
    ? `config carries value(s) of the wrong type: ${offenders.join(', ')}.`
    : undefined;
}

/**
 * Finer-grained sibling of `invalidConfigKeyError`, scoped to `kind === 'chart'`:
 * validates `patch`'s keys against the specific `StudioChartType` the patch would
 * end up with (its own `chartType` if present, else the widget's `existingChartType`,
 * else the runtime default `'bar'` — the same effective-type rule as
 * `resolveChartType`), via `validateChartConfigKeysForType`. A key can pass the
 * kind-level check (it's a valid CHART key somewhere) yet fail this one (it
 * belongs to a different chart type than the effective one) — e.g. `gauge` with
 * `sankeyTargetField`. There are no custom chart types, so an unrecognized
 * `chartType` string is a hard error via `isStudioChartType`, not a pass-through.
 * Returns `undefined` when the patch is valid for the effective chart type.
 */
function invalidChartConfigKeyError(
  patch: Record<string, unknown>,
  existingChartType: string | undefined,
): string | undefined {
  const effective = asString(patch.chartType ?? existingChartType ?? 'bar');
  if (!isStudioChartType(effective)) {
    return `unknown chartType '${effective}'. Valid values: ${STUDIO_CHART_TYPES.join(', ')}`;
  }
  const invalid = validateChartConfigKeysForType(effective, patch);
  // Bounded join, same reason as `invalidConfigKeyError` above.
  return invalid.length > 0
    ? `config carries key(s) not valid for chartType '${effective}': ${joinIdsForError(invalid)}`
    : undefined;
}

/**
 * Validates a model-supplied filter operator string against the schema package's
 * `isStudioFilterOperator` guard (backed by the exhaustive, compile-time-locked
 * `STUDIO_FILTER_OPERATORS` list — see `@mui/x-studio-schema/widgetTypeGuards`).
 * Returns a human-readable error naming the valid operators when the value is not a
 * known operator, or `undefined` when it is valid. Shared by `add_page_filter` and
 * `add_widget_filter` so the wording (and the allow-list) stays identical.
 *
 * This consumes the SAME shared list the schema-side `addFilter` wire boundary
 * (`parseStateMutation.ts`) validates against (schema T2-1), so the AI-tool boundary
 * and the persistence/wire boundary can never disagree about which operators are
 * legal. The previous hand-copied `VALID_FILTER_OPERATORS` object literal (a second
 * source of truth that had to be kept in lockstep by hand) is gone.
 */
function invalidFilterOperatorError(operator: string): string | undefined {
  return isStudioFilterOperator(operator)
    ? undefined
    : `invalid filter operator '${operator}'. Valid operators: ${STUDIO_FILTER_OPERATORS.join(
        ', ',
      )}.`;
}

/**
 * Runtime allow-list of valid `StudioDataField['type']` values (finding T2-3), kept
 * EXHAUSTIVE against the schema union via the `satisfies Record<StudioDataField['type'],
 * true>` annotation: adding a field type to the schema without listing it here is a
 * compile error, so this gate can never silently drift stale. The `fieldType` filter
 * arg is an optional UI hint that the client keys its filter-input rendering off of, so
 * an unvalidated value (a classic LLM slip like `"text"`, or a crafted non-string) would
 * persist verbatim into `StudioFilterState.fieldType` and ship a broken filter editor —
 * the exact value-shape class the sibling `operator` arg is already gated for.
 */
const VALID_FIELD_TYPES = {
  string: true,
  number: true,
  date: true,
  datetime: true,
  boolean: true,
} satisfies Record<NonNullable<StudioDataField['type']>, true>;

/**
 * Validates and narrows a model-supplied `fieldType` filter arg. `fieldType` is
 * optional, so an absent (`undefined`/`null`) value is legal and narrows to
 * `undefined` (the hint is simply omitted). A present value must be a known
 * `StudioDataField['type']`; anything else yields an actionable error (mirroring the
 * fail-closed `operator` handling). Shared by `add_page_filter` and `add_widget_filter`.
 */
function resolveFieldType(
  value: unknown,
): { fieldType: StudioDataField['type'] | undefined } | { error: string } {
  if (value === undefined || value === null) {
    return { fieldType: undefined };
  }
  if (typeof value === 'string' && Object.hasOwn(VALID_FIELD_TYPES, value)) {
    return { fieldType: value as StudioDataField['type'] };
  }
  return {
    error: `invalid fieldType ${describeArgValue(value)}. Valid field types: ${Object.keys(
      VALID_FIELD_TYPES,
    ).join(', ')}.`,
  };
}

/**
 * Runtime allow-list of every built-in widget kind (finding T2-4), kept EXHAUSTIVE
 * against `BuiltinStudioWidgetKind` via the `satisfies readonly BuiltinStudioWidgetKind[]`
 * clause plus the `AssertAllBuiltinKindsListed` compile-time lock below (same pattern as
 * the schema package's `STUDIO_FILTER_OPERATORS`/`STUDIO_CHART_TYPES` locks): adding a
 * built-in kind without listing it here fails the build. The set of kinds a model may
 * legitimately name is this list UNION the host-registered `customWidgets[].kind`; any
 * other kind string both mints an unrenderable widget AND bypasses all config-key
 * validation (`validateConfigKeysForKind` returns `[]` — unrestricted — for an unknown
 * kind, and the chart-level check only runs for `kind === 'chart'` exactly).
 */
const BUILTIN_WIDGET_KINDS = [
  'grid',
  'chart',
  'kpi',
  'text',
  'filter',
  'pivot',
  'map',
] as const satisfies readonly BuiltinStudioWidgetKind[];

type AssertAllBuiltinKindsListed =
  Exclude<BuiltinStudioWidgetKind, (typeof BUILTIN_WIDGET_KINDS)[number]> extends never
    ? true
    : [
        'BUILTIN_WIDGET_KINDS is missing:',
        Exclude<BuiltinStudioWidgetKind, (typeof BUILTIN_WIDGET_KINDS)[number]>,
      ];
const ALL_BUILTIN_KINDS_LISTED: AssertAllBuiltinKindsListed = true;
void ALL_BUILTIN_KINDS_LISTED;

/**
 * Builds a `StudioWidget` from AI-tool arguments, layering config in one canonical
 * order — factory defaults → custom-widget `defaultConfig` → model-supplied config —
 * and minting the id through the shared `createDefaultWidget` (its
 * `createWidgetId` scheme is collision-resistant). Used by both `add_widget` and
 * `apply_bulk_update`'s additions so the two paths cannot drift (they were
 * previously character-for-character duplicates, including a hand-copied id scheme).
 *
 * Validates the MERGE of `customDef.defaultConfig` and the untrusted `args.config`
 * against the widget's `kind` (Tier 1 architecture-review finding). `customWidgets`
 * — and therefore every `customWidgets[].defaultConfig` — is request-body content
 * (`StudioCustomWidgetDef` is shaped directly by `body.customWidgets`, capped only
 * for length/count by `capIncomingCustomWidgets` in `handleAIChat.ts`, never
 * key/value validated), so it is exactly as untrusted as `args.config` and must go
 * through the SAME fail-closed key-allowlist, value-shape, and length/array caps
 * before it can land on a widget. `defaultConfig` is capped via
 * `capConfigStringValues` (string-length + array-length/element caps) before the
 * merge, same as `args.config`. Returns `{ error }` (no widget built) when the
 * merged config carries a key that belongs to a different widget kind, or a
 * wrong-typed scalar value — fail-closed, so neither an invalid cross-kind key nor
 * a malformed `defaultConfig` value can ever be committed to state.
 */
export function buildWidgetFromArgs(
  args: { kind?: unknown; title?: unknown; sourceId?: unknown; config?: unknown },
  customWidgets?: StudioCustomWidgetDef[],
): { widget: StudioWidget } | { error: string } {
  // Reject a non-string-coercible `kind`/`title`/`sourceId` BEFORE anything is built
  // (finding H4). `asString` alone would silently turn `{"toString":1}` into `''` and
  // commit a nameless widget; the model gets the same actionable error its `config`
  // and `chartType` siblings already produce. Reported through this function's own
  // `{ error }` channel, so `apply_bulk_update`'s additions loop turns it into a
  // `skipped` entry exactly like every other rejected addition.
  const argError = invalidStringArgsError(args as Record<string, unknown>, [
    'kind',
    'title',
    'sourceId',
  ]);
  if (argError) {
    return { error: argError };
  }
  const kind = asString(args.kind ?? 'chart') as StudioWidget['kind'];
  const title = capTitle(asString(args.title ?? ''));
  const sourceId = args.sourceId ? capSourceId(asString(args.sourceId)) : undefined;
  // Cap every model-supplied string-typed config value (e.g. `xField`/`yField`/
  // `seriesField`) BEFORE it is validated/merged, so an oversized value never
  // lands in state (Tier 2, iteration 22 — see `capConfigStringValues`).
  const aiConfig = capConfigStringValues(args.config ?? {}) as StudioWidget['config'];
  // Validate `kind` against the CLOSED, locally-knowable set (built-in kinds ∪
  // host-registered `customWidgets[].kind`) BEFORE building anything (finding T2-4).
  // An unknown kind — even a capitalization slip like `"Chart"` — both mints a widget
  // the client cannot render AND bypasses every config-key check (an unrestricted kind
  // passes `validateConfigKeysForKind`, and the chart-level check only runs for the
  // exact string `'chart'`). Fail closed with an error naming the valid kinds, matching
  // the fail-closed `chartType` treatment via `isStudioChartType`.
  const isBuiltinKind = (BUILTIN_WIDGET_KINDS as readonly string[]).includes(kind);
  const isRegisteredCustomKind = customWidgets?.some((d) => d.kind === kind) ?? false;
  if (!isBuiltinKind && !isRegisteredCustomKind) {
    const customKinds = (customWidgets ?? []).map((d) => d.kind);
    const validKinds = [...BUILTIN_WIDGET_KINDS, ...customKinds];
    return {
      error: `unknown widget kind '${kind}'. Valid kinds: ${validKinds.join(', ')}.`,
    };
  }
  // Cap `customDef.defaultConfig` with the SAME string/array cap applied to
  // `args.config` above — it is request-body content, not a trusted server
  // default (Tier 1 architecture-review finding: `customWidgets` is shaped by
  // `body.customWidgets`).
  const customDef = customWidgets?.find((d) => d.kind === kind);
  const cappedDefaultConfig = capConfigStringValues(customDef?.defaultConfig ?? {}) as Record<
    string,
    unknown
  >;
  // Validate the MERGED config (defaultConfig + aiConfig, aiConfig taking
  // precedence) rather than just `aiConfig` — a key/value carried ONLY by
  // `defaultConfig` must be caught too, not just one the model itself supplied.
  const mergedConfig = { ...cappedDefaultConfig, ...aiConfig } as Record<string, unknown>;
  const error = invalidConfigKeyError(kind, mergedConfig);
  if (error) {
    return { error };
  }
  const valueError = invalidConfigValueError(mergedConfig);
  if (valueError) {
    return { error: valueError };
  }
  if (kind === 'chart') {
    // No existing widget yet — the effective chart type comes purely from the
    // merged config (`mergedConfig.chartType ?? 'bar'`), so there is no fallback
    // to pass.
    const chartError = invalidChartConfigKeyError(mergedConfig, undefined);
    if (chartError) {
      return { error: chartError };
    }
  }
  const base = createDefaultWidget(kind);
  const config = {
    ...base.config,
    ...cappedDefaultConfig,
    ...aiConfig,
  } as StudioWidget['config'];
  return {
    widget: {
      ...base,
      title,
      sourceId: sourceId ?? base.sourceId,
      config,
    },
  };
}

/** Shared plan for `remove_page_filter`/`remove_widget_filter` (identical behavior). */
function planRemoveFilter(
  args: Record<string, unknown>,
  ctx: ToolPlanContext,
): ToolExecutionResult {
  // Finding H4 — reject a non-string-coercible `filterId` with an actionable error
  // rather than letting `asString` normalize it to `''` and reporting the confusing
  // `Filter  not found.` (and rather than the raw `TypeError` `String()` threw).
  const argError = invalidStringArgsError(args, ['filterId']);
  if (argError) {
    return { output: JSON.stringify({ error: argError }), nextState: ctx.state };
  }
  const filterId = asString(args.filterId ?? '');
  // Existence check BEFORE mutating: the `removeFilter` reducer is a silent
  // no-op for an unknown id, so without this guard the model would be told
  // `success: true` for a call that changed nothing and has no signal to
  // retry with a corrected id — matching every other entity-targeting tool
  // (`remove_widget`, `remove_page`, `set_widget_width`, etc.), which all
  // validate existence and return an actionable error instead.
  if (!ctx.state.doc.filters.find((f) => f.id === filterId)) {
    return {
      output: JSON.stringify({ error: `Filter ${filterId} not found.` }),
      nextState: ctx.state,
    };
  }
  const mutation: StateMutation = { type: 'removeFilter', args: { filterId } };
  return {
    output: JSON.stringify({ success: true, filterId }),
    mutation,
    nextState: applyMutation(ctx.state, mutation),
  };
}

/**
 * The typed handler table — one entry per `StudioAIToolName`, enforced
 * exhaustively by the mapped type below. Converting the previous switch
 * statement into this table makes tool purity a TYPE, not a convention: a
 * tool that performs I/O must be declared `{ effect: 'external' }` (and
 * therefore cannot supply a `plan` function), so it structurally cannot enter
 * the execute-then-gate dry-run path in `toolPolicy.ts`.
 */
const TOOL_IMPLS: { [K in StudioAIToolName]: PureToolImpl | ExternalToolImpl } = {
  get_dashboard_state: {
    effect: 'pure',
    plan: (_args, { state }) => {
      // Return the dashboard document plus DATA-SOURCE METADATA ONLY — never raw
      // row data, and never the AI chat transcripts. The `doc` partition
      // (pages/widgets/dashboard/filters/…) is the authored structure the model
      // needs; `runtime.dataSources` is projected down to
      // `{ id, label, tableName, aiDescription, fields, fieldDistinctValues }` with
      // `rows`/`adapter` stripped and distinct values capped, and `doc.ai` is reduced
      // to per-thread metadata with transcripts removed. This is the canonical output
      // contract, shared with the MCP transport (both call `projectStateForAI`, so the
      // redaction rules live in exactly one place and cannot drift).
      return {
        output: JSON.stringify(projectStateForAI(state)),
        nextState: state,
      };
    },
  },

  list_pages: {
    effect: 'pure',
    plan: (_args, { state }) => {
      const pageList = Object.values(state.doc.pages).map((page) => {
        const widgetIds = (page.widgetRows ?? []).flat();
        const widgetTitles = widgetIds
          .map((id) => getWidget(state, id)?.title)
          .filter((t): t is string => Boolean(t));
        return {
          id: page.id,
          title: page.title,
          widgetCount: widgetIds.length,
          widgetTitles,
          isActive: page.id === state.doc.dashboard.activePageId,
        };
      });
      return {
        output: JSON.stringify({ pages: pageList, activePageId: state.doc.dashboard.activePageId }),
        nextState: state,
      };
    },
  },

  add_page: {
    effect: 'pure',
    plan: (args, { state }) => {
      // Finding H4 — see `invalidStringArgsError`. Without this an unusable `title`
      // object silently became `''`, committing an untitled page (and the default
      // `'New Page'` would NOT apply, since the argument is present).
      const argError = invalidStringArgsError(args, ['title']);
      if (argError) {
        return { output: JSON.stringify({ error: argError }), nextState: state };
      }
      const title = capTitle(asString(args.title ?? 'New Page'));
      const id = createPageId();
      const mutation: StateMutation = { type: 'addPage', args: { id, title } };
      return {
        output: JSON.stringify({ success: true, pageId: id, title }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    },
  },

  set_dashboard_title: {
    effect: 'pure',
    plan: (args, { state }) => {
      // Finding H4 — `set_dashboard_title({ title: { "toString": 1 } })` used to throw
      // a raw `TypeError` out of this "never throws by design" function.
      const argError = invalidStringArgsError(args, ['title']);
      if (argError) {
        return { output: JSON.stringify({ error: argError }), nextState: state };
      }
      const title = capTitle(asString(args.title ?? ''));
      const mutation: StateMutation = { type: 'setDashboardTitle', args: { title } };
      return {
        output: JSON.stringify({ success: true, title }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    },
  },

  add_widget: {
    effect: 'pure',
    plan: (args, { state, customWidgets }) => {
      // Explicitly resolve (and validate) the target page server-side so the
      // widget lands on the same page the model is told about, regardless of
      // where the client's navigation happens to be. Error rather than spread
      // an `undefined` page into state.
      const pageId = state.doc.dashboard.activePageId;
      if (!getPage(state, pageId)) {
        return {
          output: JSON.stringify({
            error: 'Cannot add a widget: there is no active page. Call add_page first.',
          }),
          nextState: state,
        };
      }

      const built = buildWidgetFromArgs(args, customWidgets);
      if ('error' in built) {
        return { output: JSON.stringify({ error: built.error }), nextState: state };
      }
      const { widget } = built;
      const mutation: StateMutation = { type: 'addWidget', args: { widget, pageId } };
      return {
        output: JSON.stringify({ success: true, widgetId: widget.id, title: widget.title }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    },
  },

  update_widget: {
    effect: 'pure',
    plan: (args, { state }) => {
      // Finding H4 — every argument this handler reads as a string, checked in one
      // pass so a model that mis-shapes two of them fixes both in one retry.
      const argError = invalidStringArgsError(args, ['widgetId', 'title', 'sourceId']);
      if (argError) {
        return { output: JSON.stringify({ error: argError }), nextState: state };
      }
      const widgetId = asString(args.widgetId ?? '');
      const widget = getWidget(state, widgetId);
      if (!widget) {
        return {
          output: JSON.stringify({ error: `Widget ${widgetId} not found.` }),
          nextState: state,
        };
      }

      // Treat `config: null` as absent (T3-1): JSON `null` is not `undefined`, so it
      // would slip past an `!== undefined` gate straight into the config-key validators,
      // whose `Object.keys(null)` / `Object.hasOwn(null, …)` throw a raw
      // `TypeError: Cannot convert undefined or null to object` — surfaced to the model as
      // an opaque, unactionable error. Every sibling path already tolerates a nullish
      // config (`buildWidgetFromArgs` uses `?? {}`; the bulk loop gates on truthiness; the
      // reducer treats a non-record config as absent), so normalize to `undefined` here.
      // Cap every model-supplied string-typed config value BEFORE validation, so an
      // oversized `xField`/`yField`/… never lands in state (Tier 2, iteration 22).
      const configArg = args.config == null ? undefined : capConfigStringValues(args.config);
      if (configArg !== undefined) {
        const error = invalidConfigKeyError(widget.kind, configArg as Record<string, unknown>);
        if (error) {
          return { output: JSON.stringify({ error }), nextState: state };
        }
        const valueError = invalidConfigValueError(configArg as Record<string, unknown>);
        if (valueError) {
          return { output: JSON.stringify({ error: valueError }), nextState: state };
        }
        if (widget.kind === 'chart') {
          // Fall back to the widget's CURRENT chartType: a patch that omits
          // `chartType` validates against it, while a patch that changes
          // `chartType` validates against the NEW type (the patch's own value
          // takes precedence inside the helper).
          const existingChartType = isWidgetOfKind(widget, 'chart')
            ? widget.config.chartType
            : undefined;
          const chartError = invalidChartConfigKeyError(
            configArg as Record<string, unknown>,
            existingChartType,
          );
          if (chartError) {
            return { output: JSON.stringify({ error: chartError }), nextState: state };
          }
        }
      }

      const changes: Partial<Omit<StudioWidget, 'id'>> = {};
      if (args.title !== undefined) {
        changes.title = capTitle(asString(args.title));
      }
      if (args.sourceId !== undefined) {
        changes.sourceId = capSourceId(asString(args.sourceId));
      }

      // Local MERGE of the incoming patch onto the widget's CURRENT config. Used ONLY
      // for the `unsetConfigKeys` presence filter below (which must test keys against the
      // post-merge config) — the mutation itself carries the RAW patch (`configPatch`),
      // never this merged snapshot. Shipping the whole merged config would re-assert
      // every pre-existing key at its turn-start value, silently reverting a concurrent
      // client edit to a DIFFERENT config key — the same lost-update class already fixed
      // for `apply_bulk_update` and `set_widget_forecast` (finding 2-1). The reducer
      // key-by-key merges the raw patch onto the LIVE widget, so untouched keys survive.
      const mergedConfig =
        configArg !== undefined
          ? ({
              ...widget.config,
              ...(configArg as StudioWidget['config']),
            } as StudioWidget['config'])
          : undefined;
      const configPatch =
        configArg !== undefined ? (configArg as StudioWidget['config']) : undefined;

      // Validate the model-supplied clear arrays before handing them to the reducer
      // (mirrors `set_widget_layout`'s shape validation): malformed model output must
      // not poison state. For `unsetFields` only a fixed set of safe, clearable
      // top-level keys is honored — `id`/`kind`/`title`/`config` are never clearable
      // this way (a required field or the config bag). For `unsetConfigKeys` only keys
      // actually present on the widget's (post-merge) config are honored, so an
      // unknown key name is a silent ignore rather than a delete against nothing.
      const CLEARABLE_WIDGET_FIELDS = new Set<OptionalWidgetField>([
        'sourceId',
        'subtitle',
        'titleMode',
        'subtitleMode',
      ]);
      const unsetFields = (Array.isArray(args.unsetFields) ? args.unsetFields : []).filter(
        (key): key is OptionalWidgetField =>
          typeof key === 'string' && CLEARABLE_WIDGET_FIELDS.has(key as OptionalWidgetField),
      );
      const configForUnsetCheck = mergedConfig ?? widget.config;
      const unsetConfigKeys = (
        Array.isArray(args.unsetConfigKeys) ? args.unsetConfigKeys : []
      ).filter(
        (key): key is string => typeof key === 'string' && Object.hasOwn(configForUnsetCheck, key),
      );

      const mutation: StateMutation = {
        type: 'updateWidget',
        args: {
          widgetId,
          changes,
          ...(configPatch !== undefined ? { config: configPatch } : {}),
          ...(unsetFields.length > 0 ? { unsetFields } : {}),
          ...(unsetConfigKeys.length > 0 ? { unsetConfigKeys } : {}),
        },
      };
      return {
        output: JSON.stringify({ success: true, widgetId }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    },
  },

  remove_widget: {
    effect: 'pure',
    plan: (args, { state }) => {
      // Finding H4 — see `invalidStringArgsError`.
      const argError = invalidStringArgsError(args, ['widgetId']);
      if (argError) {
        return { output: JSON.stringify({ error: argError }), nextState: state };
      }
      const widgetId = asString(args.widgetId ?? '');
      if (!getWidget(state, widgetId)) {
        return {
          output: JSON.stringify({ error: `Widget ${widgetId} not found.` }),
          nextState: state,
        };
      }
      const mutation: StateMutation = { type: 'removeWidget', args: { widgetId } };
      return {
        output: JSON.stringify({ success: true, widgetId }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    },
  },

  set_widget_layout: {
    effect: 'pure',
    plan: (args, { state }) => {
      const rawRows = args.rows;
      // Validate the SHAPE, not just `Array.isArray`: a flat `["w1","w2"]` (the
      // exact mistake the system prompt warns about) is a valid array but corrupts
      // `widgetRows` — every downstream `row.map`/`row.filter` then throws on a
      // string, killing the next turn's `buildDashboardState`.
      if (
        !Array.isArray(rawRows) ||
        !rawRows.every((row) => Array.isArray(row) && row.every((id) => typeof id === 'string'))
      ) {
        return {
          output: JSON.stringify({
            error:
              'set_widget_layout requires "rows" to be an array of rows, where each row is an ' +
              'array of widget-ID strings (e.g. [["w1","w2"],["w3"]]).',
          }),
          nextState: state,
        };
      }
      const rows = rawRows as string[][];
      // Cap the row COUNT (finding F3): an unbounded row array is re-flattened and
      // re-validated on every call and, once committed, re-described on every future
      // request. Reject rather than truncate — a truncated layout would silently orphan
      // every widget beyond the cap.
      if (rows.length > MAX_LAYOUT_ROWS) {
        return {
          output: JSON.stringify({
            error:
              `set_widget_layout received ${rows.length} rows, more than the ${MAX_LAYOUT_ROWS} ` +
              'allowed. Send a layout with fewer rows.',
          }),
          nextState: state,
        };
      }
      const activePageId = state.doc.dashboard.activePageId;
      const activePage = getPage(state, activePageId);
      if (!activePage) {
        return { output: JSON.stringify({ error: 'No active page.' }), nextState: state };
      }
      // Reject DUPLICATE ids (RC5): a widget id appearing in more than one cell would
      // place the same widget twice, corrupting the layout (the reducer and canvas
      // assume each widget occupies exactly one slot). Catch it here — before the
      // membership check and the mutation — with an actionable error so the model can
      // resend a clean layout, rather than committing a self-overlapping arrangement.
      const flatLayoutIds = rows.flat();
      const seenLayoutIds = new Set<string>();
      const duplicateIds = [
        ...new Set(
          flatLayoutIds.filter((id) => {
            if (seenLayoutIds.has(id)) {
              return true;
            }
            seenLayoutIds.add(id);
            return false;
          }),
        ),
      ];
      if (duplicateIds.length > 0) {
        return {
          output: JSON.stringify({
            error:
              `set_widget_layout received duplicate widget IDs: ${joinIdsForError(duplicateIds)}. ` +
              'Each widget must appear exactly once across all rows.',
          }),
          nextState: state,
        };
      }
      // Validate MEMBERSHIP: every id must be a known widget (widgets added earlier
      // this turn are already threaded into `state.doc.widgets`). Unknown ids would
      // otherwise be stored as phantom layout entries (blank cards).
      const unknownIds = [...new Set(rows.flat())].filter(
        (id) => !hasOwnEntity(state.doc.widgets, id),
      );
      if (unknownIds.length > 0) {
        // The remediation states the CONSTRAINT and names no discovery tool. The
        // obvious hint here — "call get_dashboard_state" — is wrong in private mode:
        // `get_dashboard_state` is `privateModeExcluded` (see `STUDIO_AI_TOOL_REGISTRY`)
        // and so is never advertised there, while `set_widget_layout` still is, so the
        // model would spend a turn on an `Unknown tool` error before it could retry.
        // The same applies whenever a host narrows `allowedTools`. What is true in
        // EVERY mode is where a valid id comes from, so say that instead.
        return {
          output: JSON.stringify({
            error:
              `set_widget_layout received unknown widget IDs: ${joinIdsForError(unknownIds)}. ` +
              'A layout only arranges widgets that already exist — it cannot create one, so an ' +
              'ID that names no widget would be stored as a blank card. Use the IDs that ' +
              'add_widget returned earlier in this conversation, or the ones already present in ' +
              'the layout you were given.',
          }),
          nextState: state,
        };
      }
      // Active-page OWNERSHIP (T2-A): the emitted `setWidgetLayout` mutation targets the
      // ACTIVE page and the `setWidgetLayout` reducer does NO cross-page cleanup, so placing
      // an id that currently lives on ANOTHER page here would leave that widget referenced by
      // BOTH pages' `widgetRows` — one widget (sharing one config) duplicated across two pages.
      // Mirror `set_widget_width`'s ownership guard: membership is restricted to widgets on the
      // active page or not yet placed anywhere; reject ids owned by a non-active page.
      const activeLayoutIds = new Set((activePage.widgetRows ?? []).flat());
      const foreignPageIds = [...new Set(rows.flat())].filter(
        (id) =>
          !activeLayoutIds.has(id) &&
          Object.values(state.doc.pages).some(
            (page) =>
              page.id !== activePageId && (page.widgetRows ?? []).some((row) => row.includes(id)),
          ),
      );
      if (foreignPageIds.length > 0) {
        return {
          output: JSON.stringify({
            error:
              `set_widget_layout received widget IDs that live on another page: ${joinIdsForError(foreignPageIds)}. ` +
              'A layout call only arranges the active page; call set_active_page for the page that ' +
              'contains them before rearranging them.',
          }),
          nextState: state,
        };
      }
      const mutation: StateMutation = {
        type: 'setWidgetLayout',
        args: { rows, pageId: activePageId },
      };
      return {
        output: JSON.stringify({ success: true, rows }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    },
  },

  set_widget_width: {
    effect: 'pure',
    plan: (args, { state }) => {
      const { widgetId, columns } = args as { widgetId: string; columns: unknown };
      if (typeof widgetId !== 'string') {
        return {
          output: JSON.stringify({ error: 'set_widget_width requires a "widgetId" string.' }),
          nextState: state,
        };
      }
      // Coerce/validate `columns` at the write source (T2-3), mirroring
      // `set_widget_forecast.periods`. `null` is the documented reset (clears the span).
      // The tool schema declares a number, but the value is untrusted: a string like
      // "12" would survive the bare cast and reach the reducer's `clampSpan`, which
      // treats any non-finite input as `MIN_SPAN` (6) — silently committing the minimum
      // width and reporting `{ success: true, columns: 6 }`, contradicting the request.
      // Fail closed on a non-numeric value with an actionable error naming the 6–24 range.
      let normalizedColumns: number | null = null;
      if (columns != null) {
        const n = asNumber(columns);
        if (!Number.isFinite(n)) {
          return {
            output: JSON.stringify({
              error: `set_widget_width 'columns' must be a number between 6 and 24 (or null to reset); received ${describeArgValue(columns)}.`,
            }),
            nextState: state,
          };
        }
        normalizedColumns = Math.trunc(n);
      }
      // Existence check BEFORE touching layout: without it a nonexistent id falls
      // through to the `[widgetId]` fallback below and emits a `setWidgetColSpan`
      // for a phantom widget (a silent no-op on apply). Reject with a clear error
      // so the model can correct the id instead of assuming the width was set.
      if (!getWidget(state, widgetId)) {
        return {
          output: JSON.stringify({ error: `Widget ${widgetId} not found.` }),
          nextState: state,
        };
      }
      const activePageId = state.doc.dashboard.activePageId;
      const activePage = getPage(state, activePageId);
      if (!activePage) {
        return { output: JSON.stringify({ error: 'No active page.' }), nextState: state };
      }
      // Row-membership check. `setWidgetColSpan` silently no-ops unless the widget is in a row
      // on the target page: a span written for a widget that is elsewhere would land on the
      // wrong page, and one written for a widget on NO page is an orphan that both the
      // reducer's own enforcement pass and the load boundary delete — so it would appear to
      // work and silently revert on reload. Either way the tool would otherwise read back
      // `null` and report `{ success: true, columns: null }`, telling the model a width took
      // effect that never did. Both cases are reported as errors, with the remediation that
      // actually applies to each.
      const currentRow = activePage.widgetRows?.find((row) => row.includes(widgetId));
      if (currentRow === undefined) {
        const onAnotherPage = Object.values(state.doc.pages).some((page) =>
          (page.widgetRows ?? []).some((row) => row.includes(widgetId)),
        );
        return {
          output: JSON.stringify({
            error: onAnotherPage
              ? `Widget ${widgetId} is not on the active page, so its width cannot be set here. ` +
                'Call set_active_page for the page that contains it first.'
              : `Widget ${widgetId} is not placed on any page, so a width set for it would be ` +
                'discarded when the dashboard is saved. Place it with set_widget_layout first, ' +
                'then set its width.',
          }),
          nextState: state,
        };
      }
      const rowWidgetIds = currentRow ?? [widgetId];
      const mutation: StateMutation = {
        type: 'setWidgetColSpan',
        args: { widgetId, columns: normalizedColumns, rowWidgetIds, pageId: activePageId },
      };
      const nextState = applyMutation(state, mutation);
      // Report the value that ACTUALLY landed in state, not the raw model input:
      // the `setWidgetColSpan` reducer clamps `columns` to 6–24 (and coerces a
      // non-finite value to the minimum), so `columns: 100` really becomes 24 and
      // `columns: null` clears the span (read back as `null`). Echoing the unclamped
      // input would tell the model a width took effect that never did.
      const appliedColumns = getWidgetColSpan(getPage(nextState, activePageId), widgetId);
      return {
        output: JSON.stringify({ success: true, widgetId, columns: appliedColumns }),
        mutation,
        nextState,
      };
    },
  },

  rename_page: {
    effect: 'pure',
    plan: (args, { state }) => {
      // Finding H4 — see `invalidStringArgsError`.
      const argError = invalidStringArgsError(args, ['pageId', 'title']);
      if (argError) {
        return { output: JSON.stringify({ error: argError }), nextState: state };
      }
      const pageId = asString(args.pageId ?? '');
      const title = capTitle(asString(args.title ?? ''));
      const page = getPage(state, pageId);
      if (!page) {
        return { output: JSON.stringify({ error: `Page ${pageId} not found.` }), nextState: state };
      }
      const mutation: StateMutation = { type: 'renamePage', args: { pageId, title } };
      return {
        output: JSON.stringify({ success: true, pageId, title }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    },
  },

  remove_page: {
    effect: 'pure',
    plan: (args, { state }) => {
      // Finding H4 — see `invalidStringArgsError`.
      const argError = invalidStringArgsError(args, ['pageId']);
      if (argError) {
        return { output: JSON.stringify({ error: argError }), nextState: state };
      }
      const pageId = asString(args.pageId ?? '');
      const page = getPage(state, pageId);
      if (!page) {
        return { output: JSON.stringify({ error: `Page ${pageId} not found.` }), nextState: state };
      }

      // `applyMutation`'s removePage mirrors `StudioController.removePage`
      // exactly (drop the page, remove its widgets, remove its page-scoped
      // filters, and reassign `activePageId` when the removed page was active),
      // so the server-computed `nextState` matches what the client produces.
      const mutation: StateMutation = { type: 'removePage', args: { pageId } };
      return {
        output: JSON.stringify({ success: true, pageId }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    },
  },

  set_active_page: {
    effect: 'pure',
    plan: (args, { state }) => {
      // Finding H4 — see `invalidStringArgsError`.
      const argError = invalidStringArgsError(args, ['pageId']);
      if (argError) {
        return { output: JSON.stringify({ error: argError }), nextState: state };
      }
      const pageId = asString(args.pageId ?? '');
      if (!getPage(state, pageId)) {
        return { output: JSON.stringify({ error: `Page ${pageId} not found.` }), nextState: state };
      }
      const mutation: StateMutation = { type: 'setActivePage', args: { pageId } };
      return {
        output: JSON.stringify({ success: true, pageId }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    },
  },

  add_page_filter: {
    effect: 'pure',
    plan: (args, { state }) => {
      const activePageId = state.doc.dashboard.activePageId;
      // Match add_widget: confirm the active page exists before scoping a filter to
      // it, so a stale/empty activePageId returns an actionable error instead of
      // committing a page filter targeting a page that no longer exists.
      if (!getPage(state, activePageId)) {
        return { output: JSON.stringify({ error: 'No active page.' }), nextState: state };
      }
      // Finding H4 — `field`/`sourceId`/`operator` are read as strings. `value` is NOT
      // in this list: a filter value is legitimately an object or array (an `in` list, a
      // range), and `capFilterValue` handles every shape without coercing to a primitive.
      const argError = invalidStringArgsError(args, ['field', 'sourceId', 'operator']);
      if (argError) {
        return { output: JSON.stringify({ error: argError }), nextState: state };
      }
      const field = capString(asString(args.field ?? ''), MAX_FILTER_STRING_LENGTH);
      const sourceId = capString(asString(args.sourceId ?? ''), MAX_FILTER_STRING_LENGTH);
      const operatorRaw = asString(args.operator ?? 'equals');
      const operatorError = invalidFilterOperatorError(operatorRaw);
      if (operatorError) {
        return { output: JSON.stringify({ error: operatorError }), nextState: state };
      }
      const operator = operatorRaw as StudioFilterOperator;
      const value = capFilterValue(args.value);
      // Validate `fieldType` against the exhaustive schema-derived set (finding T2-3),
      // mirroring the sibling `operator` gate above — an unvalidated hint would persist
      // verbatim and break the client's filter-input rendering.
      const fieldTypeResult = resolveFieldType(args.fieldType);
      if ('error' in fieldTypeResult) {
        return { output: JSON.stringify({ error: fieldTypeResult.error }), nextState: state };
      }
      const { fieldType } = fieldTypeResult;
      const filterId = createFilterId();
      const filter: StudioFilterState = {
        id: filterId,
        field,
        filterSourceId: sourceId,
        operator,
        value,
        fieldType,
        // Page target chosen server-side and carried in the filter's scope, so
        // the client applies it to this page rather than its own active page.
        scope: { kind: 'page', pageId: activePageId },
      };
      const mutation: StateMutation = { type: 'addFilter', args: { filter } };
      return {
        output: JSON.stringify({ success: true, filterId }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    },
  },

  remove_page_filter: { effect: 'pure', plan: planRemoveFilter },

  add_widget_filter: {
    effect: 'pure',
    plan: (args, { state }) => {
      // Finding H4 — same set as `add_page_filter`, plus the target `widgetId`.
      const argError = invalidStringArgsError(args, ['widgetId', 'field', 'sourceId', 'operator']);
      if (argError) {
        return { output: JSON.stringify({ error: argError }), nextState: state };
      }
      const widgetId = asString(args.widgetId ?? '');
      // Match every other entity-targeting tool: validate the widget exists before
      // committing a widget-scoped filter, so a fabricated/stale widgetId returns an
      // actionable error instead of silently committing a dangling no-op filter.
      if (!getWidget(state, widgetId)) {
        return {
          output: JSON.stringify({ error: `Widget ${widgetId} not found.` }),
          nextState: state,
        };
      }
      const field = capString(asString(args.field ?? ''), MAX_FILTER_STRING_LENGTH);
      const sourceId = capString(asString(args.sourceId ?? ''), MAX_FILTER_STRING_LENGTH);
      const operatorRaw = asString(args.operator ?? 'equals');
      const operatorError = invalidFilterOperatorError(operatorRaw);
      if (operatorError) {
        return { output: JSON.stringify({ error: operatorError }), nextState: state };
      }
      const operator = operatorRaw as StudioFilterOperator;
      const value = capFilterValue(args.value);
      // Validate `fieldType` (finding T2-3), same as `add_page_filter`.
      const fieldTypeResult = resolveFieldType(args.fieldType);
      if ('error' in fieldTypeResult) {
        return { output: JSON.stringify({ error: fieldTypeResult.error }), nextState: state };
      }
      const { fieldType } = fieldTypeResult;
      const filterId = createFilterId();
      const filter: StudioFilterState = {
        id: filterId,
        field,
        filterSourceId: sourceId,
        operator,
        value,
        fieldType,
        scope: { kind: 'widget', widgetId },
      };
      const mutation: StateMutation = { type: 'addFilter', args: { filter } };
      return {
        output: JSON.stringify({ success: true, filterId }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    },
  },

  remove_widget_filter: { effect: 'pure', plan: planRemoveFilter },

  summarise_page: {
    effect: 'pure',
    plan: (args, { state, pageSnapshot, snapshotPageId }) => {
      // On the chat path the only row data available is the client-provided
      // `pageSnapshot`, which is fixed at REQUEST time for the page that was active
      // then (`snapshotPageId`). Unlike the MCP path (which can query any page's
      // sources live), we cannot honor a `pageId` that points at a different page here.
      //
      // Compare the requested page against the snapshot's OWN page identity, NOT the
      // threaded `state.doc.dashboard.activePageId`: a same-turn `set_active_page`
      // mutates the threaded active page mid-turn, so comparing against it would let a
      // `set_active_page(pageB)` + `summarise_page(pageB)` sequence pass this guard and
      // return page A's snapshot narrated as page B (finding 2-2). The snapshot cannot
      // be rebuilt for another page within the turn — that needs a fresh request — so we
      // do NOT tell the model to call `set_active_page`. Fall back to the threaded active
      // page only for legacy callers that don't thread `snapshotPageId`.
      //
      // The error states the contract — on this transport `summarise_page` covers the
      // SNAPSHOT'S page and nothing else — and names the one action that can succeed in
      // this turn. It deliberately does not read as "retry": there is no argument, and
      // no other tool call, that makes another page's rows available before the next
      // request, so any retry is a wasted turn. Every id it echoes is model- or
      // client-supplied and unbounded, so all of them are length-capped like every
      // other id this file echoes back.
      //
      // Finding H6 — the guard covers the OMITTED-`pageId` form too, not just the
      // explicit one. It previously fired only `if (requestedPageId)`, so a model
      // following the advertised advice — `set_active_page(pageB)` then
      // `summarise_page()` with no `pageId` — fell straight through to the
      // `pageSnapshot` return and got page A's snapshot, which it then narrated as
      // page B: exactly the wrong-page attribution the `snapshotPageId` comparison
      // exists to prevent, just reached by the argument-less path. With no `pageId`
      // the page the model MEANS is the threaded active page, so that is what is
      // compared. (When no `snapshotPageId` was threaded — legacy callers —
      // `coveredPageId` IS the threaded active page, so this can never fire.)
      // Finding H4 — see `invalidStringArgsError`.
      const argError = invalidStringArgsError(args, ['pageId']);
      if (argError) {
        return { output: JSON.stringify({ error: argError }), nextState: state };
      }
      const requestedPageId = args.pageId ? capEntityId(asString(args.pageId)) : undefined;
      const coveredPageId = capEntityId(
        asString(snapshotPageId ?? state.doc.dashboard.activePageId),
      );
      const targetPageId =
        requestedPageId ?? capEntityId(asString(state.doc.dashboard.activePageId));
      if (targetPageId !== coveredPageId) {
        // The two forms differ only in the ONE action that can still succeed: an
        // explicit `pageId` can be dropped, while an omitted one cannot be "dropped"
        // any further — there the mismatch came from making another page active
        // mid-turn, so the model must be told that doing so did not (and cannot)
        // bring that page's rows with it. Neither form names a tool to call: the
        // guidance must not read as "retry", because no argument and no tool call can
        // make another page's rows available before the next request.
        const remedy = requestedPageId
          ? `Omit "pageId" to summarise page "${coveredPageId}", and ask the user to open page ` +
            `"${targetPageId}" if they want that one summarised.`
          : `Making page "${targetPageId}" active during this turn did not bring its rows with ` +
            `it — the snapshot was already fixed when the request arrived. Summarise page ` +
            `"${coveredPageId}" instead, and ask the user to open page "${targetPageId}" if they ` +
            'want that one summarised.';
        return {
          output: JSON.stringify({
            error:
              `summarise_page can only summarise page "${coveredPageId}" in this conversation ` +
              'turn. The row data it reads is a snapshot captured once per request, for the page ' +
              `that was active when the request arrived; page "${targetPageId}" has no rows ` +
              `available here and no tool call can load them. ${remedy}`,
          }),
          nextState: state,
        };
      }
      if (pageSnapshot) {
        // Return the data snapshot as plain text so the model can read it directly
        // without unwrapping a JSON structure. The tool description instructs the model
        // to follow up with an executive summary of the key insights.
        return {
          output: pageSnapshot,
          nextState: state,
        };
      }
      // No snapshot available — explain the limitation so the model can degrade
      // gracefully. Like the guard above, this names no discovery tool: this branch is
      // reached only when a host advertised `summarise_page` through `allowedTools`
      // without a snapshot, and the same `allowedTools` may well have excluded
      // `get_dashboard_state`, in which case following that advice costs a turn on an
      // `Unknown tool` error. Answer from the dashboard structure already in context.
      return {
        output: JSON.stringify({
          error:
            'summarise_page requires live row data, which is only available client-side and was ' +
            'not sent with this request. No tool call can load it here. Answer from the ' +
            'dashboard structure you already have, and say that the underlying figures were not ' +
            'available.',
        }),
        nextState: state,
      };
    },
  },

  apply_bulk_update: {
    effect: 'pure',
    plan: (args, { state, customWidgets }) => {
      const activePageId = state.doc.dashboard.activePageId;
      const activePage = getPage(state, activePageId);
      if (!activePage) {
        return { output: JSON.stringify({ error: 'No active page found.' }), nextState: state };
      }

      const skipped: string[] = [];
      const applied = { updated: 0, added: 0, removed: 0, layout: false, colSpans: 0 };

      let widgetRows = (activePage.widgetRows ?? []).map((row) => [...row]);
      // `Object.assign(Object.create(null), …)`, not a `{ … }` spread (finding M8):
      // both span maps are keyed by a MODEL-supplied widget id (or an id that came in
      // on the request body — `state.doc.widgets` is client JSON), and `colSpans['__proto__']
      // = 12` on a normal object literal is silently discarded (assigning a primitive to
      // `__proto__` is a no-op) while `applied.colSpans += 1` still counts it. That is a
      // dropped mutation reported as `{ success: true }` — the exact executor/reducer
      // desync class the `Object.hasOwn` id hardening exists to prevent, on the write
      // side. A null-prototype map has no `__proto__` accessor, so every key lands as an
      // ordinary own property and ships in the mutation.
      const colSpans: Record<string, number> = Object.assign(
        Object.create(null),
        activePage.widgetColSpans ?? {},
      );
      // T2-1 (residual lost-update): `colSpans` is a plan-time snapshot of EVERY widget's
      // span. The `rowsChanged` branch legitimately ships that whole snapshot (rows were
      // re-placed, so the snapshot IS the intended full map), but the colSpans-ONLY branch
      // must ship ONLY the entries this batch actually accepted — otherwise the reducer's
      // merge re-asserts the stale snapshot spans of widgets this batch never touched,
      // reverting a concurrent client-side resize of a DIFFERENT widget. Track accepted
      // entries separately so the colSpans-only payload carries just the real changes.
      // Null-prototype for the same reason as `colSpans` above (finding M8).
      const changedSpans: Record<string, number> = Object.create(null);

      // The mutation carries only DELTAS (remove/add/update), applied by the reducer
      // against the receiver's CURRENT `state.doc.widgets` — never a snapshot of the
      // whole `widgets` record. This is the lost-update fix: a widget the user edits
      // on any page while this agentic turn is running is no longer reverted, because
      // only the ids named below are touched.
      const removedWidgetIds: string[] = [];
      const addedWidgets: StudioWidget[] = [];
      const updatedWidgets: Array<{
        widgetId: string;
        title?: string;
        sourceId?: string;
        config?: StudioWidget['config'];
      }> = [];

      // 1. Removals
      // This handler only rewrites the ACTIVE page's `widgetRows`. Removing a widget
      // that lives on another page would delete it from `widgets` while leaving a
      // dangling id in that other page's rows (blank card). Only remove widgets that
      // are on the active page; report the rest as `skipped`, mirroring the not-found
      // handling. `liveWidgetIds` tracks the ids that exist after each delta step so
      // later update/validation checks match the pre-delta-refactor behavior.
      const activePageWidgetIds = new Set((activePage.widgetRows ?? []).flat());
      const liveWidgetIds = new Set(Object.keys(state.doc.widgets));
      // SHAPE-validate before iterating (finding 2-4), mirroring the `layout` op below:
      // a bare `as string[]` cast trusts the model verbatim, so `widgetRemovals: "w1"`
      // would `for…of` over CHARACTERS (removing widgets "w", "1", …) and report
      // `success`, while `{}` / `42` / `[null]` would throw a raw TypeError instead of
      // the schema-shaped errors this handler crafts. Reject a mis-shaped array with a
      // descriptive `skipped` entry and treat it as empty.
      const rawRemovals = args.widgetRemovals;
      let removals: string[] = [];
      if (rawRemovals !== undefined) {
        if (!Array.isArray(rawRemovals) || !rawRemovals.every((id) => typeof id === 'string')) {
          skipped.push('widgetRemovals: must be an array of widget-ID strings (e.g. ["w1","w2"]).');
        } else if (rawRemovals.length > MAX_BULK_UPDATE_OPS) {
          skipped.push(
            `widgetRemovals: received ${rawRemovals.length} entries; only the first ` +
              `${MAX_BULK_UPDATE_OPS} were processed. Split the rest into a separate ` +
              'apply_bulk_update call.',
          );
          removals = (rawRemovals as string[]).slice(0, MAX_BULK_UPDATE_OPS);
        } else {
          removals = rawRemovals as string[];
        }
      }
      for (const wid of removals) {
        // Length-cap the id used in the ECHO only, never the one used for lookups:
        // `skipped` entries are count-bounded by `truncateSkipped` but each entry was
        // itself unbounded, so a batch of over-long ids echoed megabytes back into the
        // conversation. A live id can never exceed `MAX_ENTITY_ID_LENGTH` (every
        // incoming id is `capEntityId`-capped), so a capped label never hides a match.
        const widLabel = capEntityId(wid);
        if (!liveWidgetIds.has(wid)) {
          skipped.push(`remove ${widLabel}: not found`);
          continue;
        }
        if (!activePageWidgetIds.has(wid)) {
          skipped.push(`remove ${widLabel}: not on the active page`);
          continue;
        }
        removedWidgetIds.push(wid);
        liveWidgetIds.delete(wid);
        widgetRows = widgetRows
          .map((row) => row.filter((id) => id !== wid))
          .filter((row) => row.length > 0);
        applied.removed += 1;
      }

      // 2. Additions
      // A `Map` (not a plain object) so a model-chosen widget `title` that is an
      // `Object.prototype` member ("constructor", "toString", "__proto__", …)
      // can't resolve a title ref to an inherited value: `.get(ref)` returns
      // `undefined` for an unmatched ref, so the `?? ref` fallthrough always
      // reaches the raw model string and skip messages read back the exact ref.
      const addedTitleToId = new Map<string, string>();
      // Kind of each widget added THIS batch, keyed by id — so the updates loop below
      // can resolve the kind of a same-batch addition (not yet present in
      // `state.doc.widgets`) for its own config-key validation.
      //
      // A `Map`, matching its two immediate siblings (finding M8): the lookup key is a
      // MODEL-supplied `update.widgetId`, so a plain object literal resolved
      // `addedWidgetKinds['toString']` through the prototype chain to an inherited
      // FUNCTION. That function then flowed into `invalidConfigKeyError` as the widget
      // `kind`, and `validateConfigKeysForKind` returns `[]` (unrestricted) for any
      // unknown kind — so the whole config-key / chart-key / value-shape gate was
      // skipped for that update. `.get()` returns `undefined` for an unmatched key, so
      // the `?? ` fallthroughs behave exactly as they do for a genuinely absent id.
      const addedWidgetKinds = new Map<string, string>();
      // Running (NOT snapshot) map of every chart widget's CURRENT chartType, keyed by
      // id. Seeded lazily with existing chart widgets and eagerly with same-batch chart
      // additions, then UPDATED after each accepted update that changes a widget's
      // chartType — so a later update in the SAME batch validates its config keys
      // against the chartType an earlier update in this batch just set, not the
      // pre-batch value. Without this, changing a widget's chartType and then setting a
      // key valid only for the NEW type in one bulk call would be falsely rejected
      // (and the reverse — a key valid only for the OLD type — falsely accepted).
      const currentChartTypes = new Map<string, string | undefined>();
      const resolveChartTypeForUpdate = (
        wid: string,
        existingWidget: StudioWidget | undefined,
      ): string | undefined => {
        if (currentChartTypes.has(wid)) {
          return currentChartTypes.get(wid);
        }
        const seed =
          existingWidget && isWidgetOfKind(existingWidget, 'chart')
            ? existingWidget.config.chartType
            : undefined;
        currentChartTypes.set(wid, seed);
        return seed;
      };
      // SHAPE-validate before iterating (finding 2-4): each addition must be a plain
      // record carrying at least a string `kind` and string `title`. A non-array, or an
      // element that is a string / null / array / missing those keys, would throw or
      // silently mis-build. Reject with a descriptive `skipped` entry and treat as empty.
      const rawAdditions = args.widgetAdditions;
      let additions: Array<{
        kind: string;
        title: string;
        sourceId?: string;
        config?: Record<string, unknown>;
      }> = [];
      if (rawAdditions !== undefined) {
        if (
          !Array.isArray(rawAdditions) ||
          !rawAdditions.every(
            (a) =>
              a !== null &&
              typeof a === 'object' &&
              !Array.isArray(a) &&
              typeof (a as { kind?: unknown }).kind === 'string' &&
              typeof (a as { title?: unknown }).title === 'string',
          )
        ) {
          skipped.push(
            'widgetAdditions: must be an array of objects each with a string `kind` and ' +
              'string `title` (e.g. [{ "kind": "chart", "title": "Revenue" }]).',
          );
        } else if (rawAdditions.length > MAX_BULK_UPDATE_OPS) {
          skipped.push(
            `widgetAdditions: received ${rawAdditions.length} entries; only the first ` +
              `${MAX_BULK_UPDATE_OPS} were processed. Split the rest into a separate ` +
              'apply_bulk_update call.',
          );
          additions = (rawAdditions as typeof additions).slice(0, MAX_BULK_UPDATE_OPS);
        } else {
          additions = rawAdditions as typeof additions;
        }
      }
      // Whether this batch carries a layout or colSpans op that resolves added-widget
      // refs BY TITLE (finding 2-3). When it does, two additions with the SAME title are
      // ambiguous: `addedTitleToId` is last-write-wins, so the layout/colSpans ref would
      // resolve to only one of them and the other would land in `doc.widgets` referenced
      // by no page — an invisible orphan that still persists, serializes, and survives
      // undo, all reported as `applied.added` success. So when a title ref could be
      // consulted, the SECOND (and later) addition sharing a title is skipped with an
      // actionable message rather than silently orphaned.
      const batchHasTitleRefs =
        args.layout !== undefined ||
        (args.colSpans !== null &&
          typeof args.colSpans === 'object' &&
          !Array.isArray(args.colSpans) &&
          Object.keys(args.colSpans as Record<string, unknown>).length > 0);
      for (const addition of additions) {
        const built = buildWidgetFromArgs(addition, customWidgets);
        if ('error' in built) {
          // Echo-only cap on the raw model-supplied title, same rationale as the
          // removals loop above.
          skipped.push(`add "${capTitle(asString(addition.title))}": ${built.error}`);
          continue;
        }
        const { widget } = built;
        if (batchHasTitleRefs && addedTitleToId.has(widget.title)) {
          skipped.push(
            `add "${widget.title}": duplicate addition title is ambiguous for a layout or ` +
              'colSpans title reference; give each widget added in this batch a unique title.',
          );
          continue;
        }
        addedWidgets.push(widget);
        liveWidgetIds.add(widget.id);
        addedTitleToId.set(widget.title, widget.id);
        addedWidgetKinds.set(widget.id, widget.kind);
        if (isWidgetOfKind(widget, 'chart')) {
          currentChartTypes.set(widget.id, widget.config.chartType);
        }
        widgetRows.push([widget.id]);
        applied.added += 1;
      }

      // 3. Updates
      // Emit each update as a partial patch (never the merged widget snapshot). The
      // reducer merges it onto the LIVE widget, so a concurrent edit to a different
      // key on that widget survives too.
      // SHAPE-validate before iterating (finding 2-4): each update must be a plain
      // record carrying a string `widgetId`. A non-array, or an element that is a
      // string / null / array / missing `widgetId`, would throw or mis-resolve. Reject
      // with a descriptive `skipped` entry and treat as empty.
      const rawUpdates = args.widgetUpdates;
      let updates: Array<{
        widgetId: string;
        title?: string;
        sourceId?: string;
        config?: Record<string, unknown>;
      }> = [];
      if (rawUpdates !== undefined) {
        if (
          !Array.isArray(rawUpdates) ||
          !rawUpdates.every(
            (u) =>
              u !== null &&
              typeof u === 'object' &&
              !Array.isArray(u) &&
              typeof (u as { widgetId?: unknown }).widgetId === 'string',
          )
        ) {
          skipped.push(
            'widgetUpdates: must be an array of objects each with a string `widgetId` ' +
              '(e.g. [{ "widgetId": "w1", "title": "New" }]).',
          );
        } else if (rawUpdates.length > MAX_BULK_UPDATE_OPS) {
          skipped.push(
            `widgetUpdates: received ${rawUpdates.length} entries; only the first ` +
              `${MAX_BULK_UPDATE_OPS} were processed. Split the rest into a separate ` +
              'apply_bulk_update call.',
          );
          updates = (rawUpdates as typeof updates).slice(0, MAX_BULK_UPDATE_OPS);
        } else {
          updates = rawUpdates as typeof updates;
        }
      }
      for (const update of updates) {
        const wid = asString(update.widgetId ?? '');
        // Echo-only cap, same rationale as the removals loop above.
        const widLabel = capEntityId(wid);
        if (!liveWidgetIds.has(wid)) {
          skipped.push(`update ${widLabel}: not found`);
          continue;
        }
        // Finding H4 — `widgetId` was already shape-checked as a string above, but
        // `title`/`sourceId` were not: a `{"toString":1}` in either threw a raw
        // `TypeError` out of the whole bulk call, discarding every op the batch had
        // already accepted. Report it as a `skipped` entry, matching every other
        // rejected op in this handler, so the rest of the batch still applies.
        const updateArgError = invalidStringArgsError(update as Record<string, unknown>, [
          'title',
          'sourceId',
        ]);
        if (updateArgError) {
          skipped.push(`update ${widLabel}: ${updateArgError}`);
          continue;
        }
        // Cap every model-supplied string-typed config value BEFORE validation, so an
        // oversized `xField`/`yField`/… never lands in state (Tier 2, iteration 22).
        const configArg = update.config
          ? (capConfigStringValues(update.config) as Record<string, unknown>)
          : undefined;
        if (configArg) {
          // Resolve the target's kind from either the CURRENT state or a widget
          // added earlier in this same batch (not yet in `state.doc.widgets`).
          const existingWidget = getWidget(state, wid);
          // `?? ''` is unreachable in practice (`liveWidgetIds` membership was checked
          // above, and it only ever holds existing or same-batch-added ids) but keeps
          // the type honest now that the lookup is a `Map`; an empty kind is treated as
          // an unknown kind by `validateConfigKeysForKind`, exactly as before.
          const kind = existingWidget?.kind ?? addedWidgetKinds.get(wid) ?? '';
          const error = invalidConfigKeyError(kind, configArg);
          if (error) {
            skipped.push(`update ${widLabel}: ${error}`);
            continue;
          }
          const valueError = invalidConfigValueError(configArg);
          if (valueError) {
            skipped.push(`update ${widLabel}: ${valueError}`);
            continue;
          }
          if (kind === 'chart') {
            // Resolve against the RUNNING chartType map (seeded from existing state
            // and same-batch additions, updated after each accepted same-batch
            // chartType change) — never a pre-batch snapshot — so a chartType changed
            // earlier in this same batch is honored here.
            const existingChartType = resolveChartTypeForUpdate(wid, existingWidget);
            const chartError = invalidChartConfigKeyError(configArg, existingChartType);
            if (chartError) {
              skipped.push(`update ${widLabel}: ${chartError}`);
              continue;
            }
            // Accepted: if this update sets a new chartType, record it so later
            // same-batch updates targeting this widget validate against it.
            if (Object.hasOwn(configArg, 'chartType')) {
              currentChartTypes.set(wid, configArg.chartType as string | undefined);
            }
          }
        }
        updatedWidgets.push({
          widgetId: wid,
          ...(update.title !== undefined ? { title: capTitle(asString(update.title)) } : {}),
          ...(update.sourceId !== undefined
            ? { sourceId: capSourceId(asString(update.sourceId)) }
            : {}),
          ...(configArg ? { config: configArg as StudioWidget['config'] } : {}),
        });
        applied.updated += 1;
      }

      // 4. Layout
      // Validate the layout with the SAME rigor as the single-widget `set_widget_layout`
      // handler (shape + membership), rather than trusting the model's array verbatim:
      // (a) SHAPE — an array of rows, each an array of strings; a flat `["w1","w2"]`
      //     would corrupt `widgetRows` and make every downstream `row.map`/`row.filter`
      //     throw. (b) MEMBERSHIP — after mapping added-widget TITLE refs to their minted
      //     ids, every id must resolve to a widget that is live after this batch's
      //     removals/additions (`liveWidgetIds`); an unknown id would persist as a
      //     phantom layout entry (blank card) or reference a widget removed earlier in
      //     this same batch. On any failure the layout op is skipped with a clear
      //     message (the rest of the bulk update still applies) — never applied partially
      //     and never thrown.
      const rawLayout = args.layout;
      if (rawLayout !== undefined) {
        if (
          !Array.isArray(rawLayout) ||
          !rawLayout.every(
            (row) => Array.isArray(row) && row.every((ref) => typeof ref === 'string'),
          )
        ) {
          skipped.push(
            'layout: must be an array of rows, where each row is an array of widget-ID ' +
              '(or added-widget-title) strings (e.g. [["w1","w2"],["w3"]]).',
          );
        } else if (rawLayout.length > MAX_LAYOUT_ROWS) {
          // A layout op REPLACES the active page's rows wholesale, so a truncated layout
          // would orphan every widget beyond the cap. Reject the whole op with guidance
          // rather than applying a partial arrangement (finding F3).
          skipped.push(
            `layout: received ${rawLayout.length} rows, more than the ${MAX_LAYOUT_ROWS} allowed. ` +
              'Layout not applied — send a layout with fewer rows.',
          );
        } else {
          const mappedRows = (rawLayout as string[][])
            .map((row) => row.map((ref) => addedTitleToId.get(ref) ?? ref))
            .filter((row) => row.length > 0);
          // Reject DUPLICATE ids with the SAME rigor as `set_widget_layout`: an id
          // appearing in more than one cell would place one widget twice. The reducer's
          // `dedupeLayoutRows` silently keeps the first occurrence, so committing a layout
          // with duplicates would diverge from what `applied.layout: true` reports. Skip
          // with an actionable message instead so the model can resend a clean layout.
          const seenLayoutIds = new Set<string>();
          const duplicateLayoutIds = [
            ...new Set(
              mappedRows.flat().filter((id) => {
                if (seenLayoutIds.has(id)) {
                  return true;
                }
                seenLayoutIds.add(id);
                return false;
              }),
            ),
          ];
          const unknownLayoutIds = [...new Set(mappedRows.flat())].filter(
            (id) => !liveWidgetIds.has(id),
          );
          // Active-page OWNERSHIP (T2-A): like `set_widget_layout`, the `applyBulkUpdate`
          // mutation rewrites the ACTIVE page's rows and the reducer does NO cross-page
          // cleanup, so an id currently on another page would end up referenced by both
          // pages — one widget duplicated across two. Active-page ids and widgets added this
          // batch (fresh, unplaced ids) are never on `state.doc.pages`'s OTHER pages, so this
          // rejects exactly the ids owned by a non-active page, reported alongside
          // `unknownLayoutIds` for consistency.
          const foreignPageLayoutIds = [...new Set(mappedRows.flat())].filter((id) =>
            Object.values(state.doc.pages).some(
              (page) =>
                page.id !== activePageId && (page.widgetRows ?? []).some((row) => row.includes(id)),
            ),
          );
          // An explicit layout op REPLACES the active page's rows wholesale (including the
          // one-widget-per-row entries the additions loop pushed for this batch's new
          // widgets). So every widget added in this batch MUST appear in the layout — a
          // widget added-but-not-placed would land in `doc.widgets` referenced by no page
          // (invisible orphan that still persists/serializes/survives undo), reported as
          // `applied.added` + `layout:true` success (finding 2-3). Reject the layout op if
          // any addition is unplaced so the model resends a layout that includes them.
          const layoutIdSet = new Set(mappedRows.flat());
          const unplacedAddedIds = addedWidgets
            .map((w) => w.id)
            .filter((id) => !layoutIdSet.has(id));
          if (duplicateLayoutIds.length > 0) {
            skipped.push(
              `layout: duplicate widget IDs: ${joinIdsForError(duplicateLayoutIds)}. ` +
                'Each widget must appear exactly once across all rows.',
            );
          } else if (unknownLayoutIds.length > 0) {
            skipped.push(
              `layout: unknown or removed widget IDs: ${joinIdsForError(unknownLayoutIds)}. ` +
                'Reference only widgets that exist after this update (added-widget titles ' +
                'are resolved to their new IDs).',
            );
          } else if (foreignPageLayoutIds.length > 0) {
            skipped.push(
              `layout: widget IDs that live on another page: ${joinIdsForError(foreignPageLayoutIds)}. ` +
                'A layout op only arranges the active page; switch to the page that contains ' +
                'them first.',
            );
          } else if (unplacedAddedIds.length > 0) {
            skipped.push(
              `layout: widgets added in this batch are not placed in the layout: ${joinIdsForError(
                unplacedAddedIds,
              )}. A layout op replaces the active page, so every added widget must appear in ` +
                'it (reference an added widget by its title). Layout not applied.',
            );
          } else {
            widgetRows = mappedRows;
            applied.layout = true;
          }
        }
      }

      // 5. Column spans
      // Accept spans in the 24-column unit system the canvas renders (matches
      // `canvasGridConstants.GRID_COLS` = 24 / `MIN_SPAN` = 6 in `@mui/x-studio`
      // and the `setWidgetColSpan` reducer's clamp).
      //
      // An out-of-range (or non-numeric) span is REJECTED and reported via `skipped`,
      // rather than silently dropped: this handler's output reports `applied.colSpans`
      // as a per-op COUNT, not the per-widget applied value (unlike `set_widget_width`,
      // which echoes back the reducer-clamped value for its single widget), so clamping
      // here instead would give the model no way to learn which width it actually got.
      // A `skipped` entry matches every other rejected op in this handler (removals,
      // additions, updates, layout) and gives the model an actionable signal to retry
      // with a value in range.
      //
      // MEMBERSHIP is also enforced (not just range): the reducer writes col-spans to the
      // ACTIVE page only and `enforceLayoutColSpans` prunes any span whose widget isn't in
      // the active page's post-batch rows. So a span keyed to a phantom widget, a widget
      // living on ANOTHER page, or one removed earlier in THIS batch is silently discarded
      // on apply — counting it in `applied.colSpans` would overstate what actually landed.
      // `activePageWidgetIdsAfterBatch` is the authoritative membership set: `widgetRows`
      // here already reflects this batch's removals, additions, and (if provided) layout.
      const activePageWidgetIdsAfterBatch = new Set(widgetRows.flat());
      const colSpanPatch = (args.colSpans as Record<string, unknown> | undefined) ?? {};
      let colSpanEntries = Object.entries(colSpanPatch);
      if (colSpanEntries.length > MAX_BULK_UPDATE_OPS) {
        skipped.push(
          `colSpans: received ${colSpanEntries.length} entries; only the first ` +
            `${MAX_BULK_UPDATE_OPS} were processed. Split the rest into a separate ` +
            'apply_bulk_update call.',
        );
        colSpanEntries = colSpanEntries.slice(0, MAX_BULK_UPDATE_OPS);
      }
      for (const [ref, span] of colSpanEntries) {
        // Resolve added-widget TITLE refs to their minted ids, mirroring the `layout` op
        // above: a widget added earlier in this same batch is only known to the model by
        // title (its id is server-minted), so keying `colSpans` strictly by id would
        // silently drop a same-batch add-then-resize.
        const wid = addedTitleToId.get(ref) ?? ref;
        // Echo-only cap, same rationale as the removals loop above — `ref` is a raw
        // model-supplied object KEY, so it is unbounded in length.
        const refLabel = capEntityId(ref);
        if (!liveWidgetIds.has(wid)) {
          skipped.push(`colSpan ${refLabel}: widget not found.`);
          continue;
        }
        if (!activePageWidgetIdsAfterBatch.has(wid)) {
          skipped.push(`colSpan ${refLabel}: not on the active page.`);
          continue;
        }
        if (typeof span === 'number' && span >= 6 && span <= 24) {
          colSpans[wid] = span;
          changedSpans[wid] = span;
          applied.colSpans += 1;
        } else {
          skipped.push(
            `colSpan ${refLabel}: ${describeArgValue(span)} is out of range (must be a number 6-24).`,
          );
        }
      }

      // T2-4 / 2.3 (producer half): `widgetRows`/`widgetColSpans` are a plan-time snapshot
      // of the active page's layout — attaching them unconditionally means a batch that only
      // contains `widgetUpdates` (no removals/additions/layout/colSpans) still ships that
      // stale snapshot, silently reverting any concurrent client-side layout edit (e.g. a
      // drag-reorder) that happened while this turn was running. So the layout fields are
      // attached only when this batch actually changed layout — mirrored by `applied`, since
      // a requested op that was skipped (not found / invalid / out of range) never touched
      // `widgetRows` or `colSpans` and must not be sent either.
      //
      // Two distinct layout-change shapes attach DIFFERENT fields (finding 2.3):
      //  - A removal / addition / explicit `layout` op genuinely reorders or re-places rows,
      //    so the full turn-start `widgetRows` snapshot IS the intended new placement and
      //    must ship alongside `widgetColSpans`.
      //  - A colSpans-ONLY batch (`applied.colSpans > 0` but no removal/addition/layout op)
      //    changes only widths, never row placement. Shipping `widgetRows` here would revert
      //    a concurrent client-side drag-reorder/row-reassignment — the exact lost-update
      //    class T2-4 closed, one case narrower. So we omit `widgetRows` and send ONLY
      //    `widgetColSpans`, relying on the reducer (`applyMutation.ts`'s
      //    `applyBulkUpdate.apply`, fixed in the same round) to reconcile a spans-only
      //    payload against the page's EXISTING rows instead of wiping them.
      // The reducer treats true absence of BOTH fields as "layout unchanged" and skips the
      // layout-replacement block entirely, so an updates-only or all-skipped batch leaves the
      // client's current layout untouched.
      const rowsChanged = applied.removed > 0 || applied.added > 0 || applied.layout;
      const colSpansOnly = !rowsChanged && applied.colSpans > 0;

      let layoutFields: Record<string, unknown>;
      if (rowsChanged) {
        layoutFields = { widgetRows, widgetColSpans: colSpans };
      } else if (colSpansOnly) {
        // T2-1: ship ONLY the spans this batch changed, not the full turn-start snapshot.
        // The reducer merges these onto the receiver's current spans, so a concurrent
        // client-side resize of an untouched widget survives.
        layoutFields = { widgetColSpans: changedSpans };
      } else {
        layoutFields = {};
      }

      const mutation: StateMutation = {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds,
          addedWidgets,
          updatedWidgets,
          ...layoutFields,
          activePageId,
        },
      } as StateMutation;
      return {
        output: JSON.stringify({
          success: true,
          applied,
          ...(skipped.length > 0 ? { skipped: truncateSkipped(skipped) } : {}),
        }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    },
  },

  rename_thread: {
    effect: 'pure',
    plan: (args, { state }) => {
      const { name } = args as { name?: string };
      // Check the TRIMMED value, not just `!name`: a whitespace-only name (e.g. "   ")
      // is a truthy non-empty string that passes `!name` but `trim()`s to "", which
      // would commit an empty thread title (finding T3-3).
      if (!name || typeof name !== 'string' || name.trim() === '') {
        return {
          output: JSON.stringify({ error: 'rename_thread requires a non-empty name string.' }),
          nextState: state,
        };
      }
      const trimmed = name.trim().slice(0, 40);
      // Stamp the thread the request belongs to (the active thread in the request's
      // state snapshot) so the reducer renames THAT thread on the client, even if
      // the user has since switched threads while the model was running. Falls back
      // to the applying side's active thread for legacy/omitted payloads.
      const threadId = state.doc.ai?.activeThreadId;
      const mutation: StateMutation = {
        type: 'renameAIThread',
        args: {
          name: trimmed,
          updatedAt: new Date().toISOString(),
          ...(threadId ? { threadId } : {}),
        },
      };
      return {
        output: JSON.stringify({ success: true, name: trimmed }),
        mutation,
        // Server state carries no `ai` thread store, so this is a no-op here; the
        // client applies the thread rename via the same reducer.
        nextState: applyMutation(state, mutation),
      };
    },
  },

  // Side-effectful (runs a live query via the app-provided `data` config) and
  // therefore must be authorized BEFORE it executes, not dry-run-then-gated —
  // see the PURITY INVARIANT documented in `toolPolicy.ts`. Its real dispatch
  // lives in `agenticLoop/toolDispatch.ts` (chat) and `mcp/dataTools.ts` (MCP) — both call
  // `createDataToolHandlers`, never this function. This entry exists only so
  // `TOOL_IMPLS` is exhaustive over `StudioAIToolName` — calling
  // `executeToolOnState('query_data_source', ...)` directly still falls
  // through to the `default` "Unknown tool" case below.
  query_data_source: { effect: 'external' },

  set_widget_forecast: {
    effect: 'pure',
    plan: (args, { state }) => {
      const { widgetId, enabled, periods, showConfidenceBands } = args as {
        widgetId?: string;
        enabled?: unknown;
        periods?: number;
        showConfidenceBands?: unknown;
      };
      if (!widgetId || typeof widgetId !== 'string') {
        return {
          output: JSON.stringify({ error: 'set_widget_forecast requires a widgetId.' }),
          nextState: state,
        };
      }
      const widget = getWidget(state, widgetId);
      if (!widget) {
        return {
          output: JSON.stringify({ error: `Widget '${widgetId}' not found.` }),
          nextState: state,
        };
      }
      if (!isWidgetOfKind(widget, 'chart')) {
        return {
          output: JSON.stringify({
            error: `set_widget_forecast only supports chartType 'line' or 'area'. Widget '${widgetId}' has kind '${widget.kind}'.`,
          }),
          nextState: state,
        };
      }
      const { chartType } = widget.config;
      if (chartType !== 'line' && chartType !== 'area') {
        return {
          output: JSON.stringify({
            error: `set_widget_forecast only supports chartType 'line' or 'area'. Widget '${widgetId}' has chartType '${chartType ?? '(none)'}'.`,
          }),
          nextState: state,
        };
      }

      // Coerce/validate `periods` as a number at the write source (finding 3.2). The
      // tool schema declares it a number, but the value is untrusted and unvalidated —
      // a crafted string here both produces a structurally-broken forecast config and
      // (before the prompt-side sanitize fix) was echoed into `<dashboard_state>`
      // verbatim (finding 1.1). Fail closed with an actionable error on a non-numeric
      // value so the model can retry, rather than storing the raw string.
      let periodsNum: number | undefined;
      if (periods != null) {
        const n = asNumber(periods);
        if (!Number.isFinite(n) || n <= 0) {
          return {
            output: JSON.stringify({
              error: `set_widget_forecast 'periods' must be a positive number; received ${describeArgValue(periods)}.`,
            }),
            nextState: state,
          };
        }
        periodsNum = Math.floor(n);
      }

      // Strictly validate `enabled`/`showConfidenceBands` as ACTUAL booleans at the write
      // source (T2-3, finding-3.2 value-shape class). The tool schema declares both boolean
      // (and marks `enabled` required), but the args are untrusted and unvalidated: relying
      // on JS truthiness means a classic string-boolean slip like `enabled: "false"`
      // (truthy!) would ENABLE a forecast a call meant to DISABLE — while reporting
      // `success` — and a `showConfidenceBands: "no"` would persist a string in a
      // `boolean`-typed config field. Fail closed with an actionable error — mirroring the
      // `periods` coercion above and the shared `invalidConfigValueError` boolean check —
      // rather than silently coercing the dangerous `"false"` → `true` direction.
      if (typeof enabled !== 'boolean') {
        return {
          output: JSON.stringify({
            error: `set_widget_forecast 'enabled' must be a boolean (true or false); received ${describeArgValue(enabled)}.`,
          }),
          nextState: state,
        };
      }
      if (showConfidenceBands != null && typeof showConfidenceBands !== 'boolean') {
        return {
          output: JSON.stringify({
            error: `set_widget_forecast 'showConfidenceBands' must be a boolean (true or false); received ${describeArgValue(showConfidenceBands)}.`,
          }),
          nextState: state,
        };
      }

      const forecastConfig = enabled
        ? {
            enabled: true,
            ...(periodsNum != null ? { periods: periodsNum } : {}),
            method: 'linear' as const,
            ...(showConfidenceBands != null ? { showConfidenceBands } : {}),
          }
        : { enabled: false };

      // Emit a PARTIAL config patch carrying only `forecast` (via the top-level `config`
      // arg, which the reducer shallow-merges onto the LIVE widget config) rather than
      // a `changes.config` object — `changes.config` replaces the config WHOLESALE, so
      // it would discard every other config key (title styling, colors, series, other
      // chart settings) the widget already had, and would also clobber a concurrent
      // edit to a different config key made while this turn was running. Merging just
      // the forecast delta preserves them.
      const mutation: StateMutation = {
        type: 'updateWidget',
        args: {
          widgetId,
          changes: {},
          config: { forecast: forecastConfig } as StudioWidget['config'],
        },
      };
      return {
        output: JSON.stringify({ success: true, widgetId, forecast: forecastConfig }),
        mutation,
        nextState: applyMutation(state, mutation),
      };
    },
  },
};

/**
 * Execute a single built-in tool against the provided `StudioState`.
 *
 * Returns the tool output string plus an optional state mutation (for write tools).
 * The `nextState` can be fed into subsequent tool calls within the same turn.
 *
 * Dispatches through `TOOL_IMPLS`. `toolName` is an arbitrary string (unknown or
 * unregistered tool names — including `query_data_source`, which is intentionally
 * `{ effect: 'external' }` with no `plan` — fall through to the same
 * `Unknown tool` error the old switch statement's `default` case produced).
 */
export function executeToolOnState(
  toolName: string,
  input: unknown,
  state: StudioState,
  customWidgets?: StudioCustomWidgetDef[],
  pageSnapshot?: string,
  snapshotPageId?: string,
): ToolExecutionResult {
  const args = (input ?? {}) as Record<string, unknown>;
  // `Object.hasOwn`-guard the lookup so a model-supplied `toolName` that is an
  // `Object.prototype` member ("constructor", "toString", "__proto__", …)
  // resolves to `undefined` instead of an inherited value, and falls through to
  // the same `Unknown tool` error every other unregistered name receives.
  const impl = Object.hasOwn(TOOL_IMPLS, toolName)
    ? (TOOL_IMPLS as Record<string, PureToolImpl | ExternalToolImpl | undefined>)[toolName]
    : undefined;

  if (impl?.effect === 'pure') {
    return impl.plan(args, { state, customWidgets, pageSnapshot, snapshotPageId });
  }

  return { output: JSON.stringify({ error: `Unknown tool: ${toolName}` }), nextState: state };
}
