/**
 * Reading and reporting on model-supplied tool arguments.
 *
 * Not caps (see `valueCaps.ts`) and not validation of what an argument MEANS — this is the small
 * shared vocabulary for coercing an untrusted argument and for saying what was wrong with it in
 * a sentence the model can retry from.
 *
 * Every string here ends up in a tool result, and on the chat transport a tool result is not a
 * one-shot value: it is appended to the conversation and re-sent to the provider on every
 * remaining turn. So an error message is egress, and each of these bounds what it echoes.
 */

/**
 * Max number of ids interpolated into a single tool-result error string before the
 * list is truncated with a "…N more" suffix. Several error paths
 * (`set_widget_layout` and `apply_bulk_update`'s layout op) join an offending id list
 * into the error text; a model that sends hundreds of bad ids would otherwise echo the
 * whole list straight back into the conversation as an unbounded response bomb.
 */
export const MAX_IDS_IN_ERROR = 10;

/**
 * Max number of `skipped` entries echoed in an `apply_bulk_update` tool result before
 * the list is truncated with a trailing "…N more" marker. Each rejected
 * op appends to `skipped`, and the whole array is echoed back verbatim — an unbounded
 * response echo without this cap.
 */
export const MAX_SKIPPED_IN_OUTPUT = 20;

/**
 * Max characters of an offending argument VALUE echoed back into a tool-result
 * validation error. `JSON.stringify(value)` is this file's existing
 * idiom for "show the model what it sent", but the value is model-supplied and
 * unbounded, so a megabyte-sized object would be echoed straight back into the
 * conversation — the same response-echo bomb {@link MAX_IDS_IN_ERROR} and
 * {@link MAX_SKIPPED_IN_OUTPUT} already bound for id and skip lists.
 */
export const MAX_ECHOED_ARG_VALUE_LENGTH = 100;

/**
 * `Number()`'s mirror of `asString`. `Number(x)` throws the same
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
export function asNumber(value: unknown): number {
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
 * bounded to {@link MAX_ECHOED_ARG_VALUE_LENGTH} and never throwing.
 * Falls back to naming the runtime shape when the value is not JSON-representable
 * (a cyclic structure, a `BigInt`, a function), so the error stays useful without
 * this file having to trust `JSON.stringify` on untrusted input.
 */
export function describeArgValue(value: unknown): string {
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
 * STRING but that is not string-coercible.
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
export function invalidStringArgsError(
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
 * {@link MAX_IDS_IN_ERROR} with a "…N more" suffix. Bounds the response
 * echo when the model sends a very large list of offending ids.
 */
export function joinIdsForError(ids: string[]): string {
  if (ids.length <= MAX_IDS_IN_ERROR) {
    return ids.join(', ');
  }
  return `${ids.slice(0, MAX_IDS_IN_ERROR).join(', ')}, …${ids.length - MAX_IDS_IN_ERROR} more`;
}

/**
 * Truncate an `apply_bulk_update` `skipped` list to a bounded prefix for the tool
 * result, appending a "…N more" marker when entries were dropped.
 */
export function truncateSkipped(skipped: string[]): string[] {
  if (skipped.length <= MAX_SKIPPED_IN_OUTPUT) {
    return skipped;
  }
  return [
    ...skipped.slice(0, MAX_SKIPPED_IN_OUTPUT),
    `…and ${skipped.length - MAX_SKIPPED_IN_OUTPUT} more`,
  ];
}
