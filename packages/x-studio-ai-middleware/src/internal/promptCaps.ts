/**
 * Shared size-cap helpers for every client-supplied string that reaches an LLM
 * prompt built by this package.
 *
 * Rationale (finding H1): the request handlers each grew their own ad-hoc
 * `cap*` helper (`handleAIChat.ts`'s `capRequestString`,
 * `executeToolOnState.ts`'s `capString`, `handleGenerateInsight.ts`'s
 * `capCreateWidgetString`), and every gap found so far has been a site that
 * simply forgot to call one of them. These are the single shared primitives all
 * of those sites now build on, so a new interpolation site has one obvious
 * helper to reach for rather than three near-identical private ones.
 *
 * Internal to the package — not exported from `index.ts`.
 */

/**
 * Coerce an untrusted, model- or client-supplied value to a string WITHOUT ever
 * invoking `ToPrimitive` on an object (findings H4, then H1).
 *
 * `String(x)` looks total but is not. For a JSON object whose `toString` is a
 * NON-callable own property — `{"toString": 1}`, which `JSON.parse` accepts
 * verbatim, so it survives both a raw tool-call `arguments` buffer and the request
 * body — `ToPrimitive` skips the uncallable `toString`, falls back to
 * `Object.prototype.valueOf` (which returns the object itself), and throws
 * `TypeError: Cannot convert object to primitive value`. A null-prototype object
 * (`JSON.parse` output assigned onto `Object.create(null)`, which several caps in
 * this package produce) throws for the same reason with no own `toString` at all.
 *
 * That throw escaped in several places, and in every one the raw `TypeError` was
 * strictly worse than a validation error:
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
 * - Out of `buildApprovalDisplayInput` on the chat approval path, which ran
 *   OUTSIDE `dispatchToolCall`'s try — so a `remove_widget({"widgetId":{"toString":1}})`
 *   the executor would have rejected cleanly instead propagated past the SSE try
 *   block and CLOSED THE STREAM with one generic error frame (finding H1).
 *
 * This lives here, next to the other shared cap primitives, because every one of
 * them — and every prompt sanitizer built on them (`sanitizeForPrompt`,
 * `sanitizeForPromptLine`, `safeIdentifier`, `chartRenderer`'s `sanitizeText`/`esc`)
 * — needs the same guarantee. A `String` restriction in `eslint.config.mjs` keeps
 * the sanitizer surface routed through here.
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
 *   via `executeToolOnState`'s `invalidStringArgsError`, so the model receives an
 *   actionable error rather than silently landing an empty title; the
 *   incoming-state and display-only paths have no caller to report to and rely on
 *   the `''` normalization alone.
 */
export function asString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    // eslint-disable-next-line no-restricted-syntax -- this IS the total coercion the restriction points at; the value is already a primitive here, so `ToPrimitive` never runs and `String` cannot throw.
    return String(value);
  }
  return '';
}

/**
 * Cap an arbitrary value's string form to `maxChars`.
 *
 * Coerces through {@link asString} because every caller is guarding a field that is
 * only NOMINALLY typed: request bodies are unvalidated JSON, so a field declared
 * `string` can arrive as a number, an object, or `undefined` — and the raw
 * `String(value ?? '')` this used to do THROWS for `{"toString": 1}` (finding H1).
 */
export function capText(value: unknown, maxChars: number): string {
  const str = asString(value);
  return str.length > maxChars ? str.slice(0, maxChars) : str;
}

/**
 * Cap a value to `maxChars` when (and only when) it is a string; pass anything
 * else through untouched.
 *
 * Use this where the well-formed value is legitimately a non-string (a number, a
 * boolean, `undefined`) but a crafted body could smuggle an oversized string into
 * the same field — capping must not coerce the well-formed case into a string.
 */
export function capMaybeText(value: unknown, maxChars: number): unknown {
  return typeof value === 'string' && value.length > maxChars ? value.slice(0, maxChars) : value;
}

/**
 * Hard cap on a generated chat-session title, matching `rename_thread`'s server-side
 * cap. Exported so both `executeToolOnState.ts`'s `rename_thread` handler and
 * `handleGenerateInsight.ts`'s `handleGenerateTitle` can import and reuse this exact
 * value instead of a bare literal, so the "must match" invariant is enforced by the
 * type system/import rather than by convention alone.
 *
 * Lives here — in this neutral, leaf `internal/promptCaps.ts` module — specifically to
 * avoid a two-node import cycle: a prior consolidation defined this constant in
 * `handleGenerateInsight.ts` and had `executeToolOnState.ts` import it from there,
 * while `handleGenerateInsight.ts` separately imports `buildWidgetFromArgs`/
 * `MAX_FILTER_STRING_LENGTH` FROM `executeToolOnState.ts` — a genuine `A imports B
 * imports A` cycle. It worked only because both bindings were read inside deferred
 * function bodies rather than at module-evaluation time, but it inverted this
 * package's documented dependency direction (`ARCHITECTURE.md` describes
 * `executeToolOnState.ts` as the shared core both transports build on, and
 * `handleGenerateInsight.ts` as a one-shot handler that depends on it, not the
 * reverse). Both call sites now import this constant from a shared module with no
 * back-reference to either of them, restoring the one-directional dependency.
 */
export const MAX_GENERATED_TITLE_LENGTH = 40;
