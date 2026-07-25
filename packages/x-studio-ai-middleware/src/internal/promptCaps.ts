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
 * Cap an arbitrary value's string form to `maxChars`.
 *
 * Coerces first (`String(value ?? '')`) because every caller is guarding a field
 * that is only NOMINALLY typed: request bodies are unvalidated JSON, so a field
 * declared `string` can arrive as a number, an object, or `undefined`.
 */
export function capText(value: unknown, maxChars: number): string {
  const str = typeof value === 'string' ? value : String(value ?? '');
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
 * Cap both the LENGTH of a string array and the length of each of its entries.
 * Returns a new array; non-string entries are coerced by {@link capText}.
 */
export function capTextList(values: unknown, maxCount: number, maxChars: number): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return values.slice(0, maxCount).map((v) => capText(v, maxChars));
}
