/**
 * Hard ceiling on recursion depth for `sortedStringify` (finding Tier3 —
 * ordering bug). `generateCacheKey` → `computeQueryHash` calls this on the RAW
 * widget descriptor — including `filters[].value` — BEFORE the shape guards on
 * filter values (`isScalarComparisonValue` / `isPrimitivePredicateElement` in
 * `shared/predicates.ts`) ever run, so a pathologically nested client-supplied
 * value (e.g. a `value` deeply nested thousands of objects/arrays deep) would
 * otherwise recurse unbounded here — burning CPU, and risking a stack overflow
 * — before any validation gets a chance to reject it. This is defense in depth
 * independent of that ordering: a legitimate query descriptor never nests
 * anywhere near this deep.
 */
const MAX_SORTED_STRINGIFY_DEPTH = 50;

/**
 * Recursively serialize a value with object keys sorted alphabetically at every
 * depth, producing deterministic output regardless of property insertion order.
 *
 * Array element order is preserved and IS significant — two inputs whose arrays
 * differ only in element order serialize to different strings. `undefined`
 * values serialize via plain `JSON.stringify` semantics (e.g. `undefined` itself
 * stringifies to the string `"undefined"`, distinct from `null`'s `"null"`).
 * Both behaviors are load-bearing for existing hashes — do not "fix" either.
 *
 * SECURITY: this is the single canonical serializer feeding BOTH the cache-key
 * security hash (`cacheKey.ts`'s `computeSecurityHash` / `computeQueryHash`) and
 * the compiled-policy digest (`compileSecurityPolicy.ts`'s `computePolicyDigest`).
 * The two must always canonicalize identical inputs identically — never fork
 * this function into per-file copies.
 *
 * `depth` is an internal recursion counter (always omitted by callers) capped
 * at `MAX_SORTED_STRINGIFY_DEPTH` — see that constant's doc comment.
 */
export function sortedStringify(obj: unknown, depth: number = 0): string {
  if (depth > MAX_SORTED_STRINGIFY_DEPTH) {
    throw new Error(
      `MUI X Studio Server: A value passed to the cache-key/policy-digest serializer is nested more than ` +
        `${MAX_SORTED_STRINGIFY_DEPTH} levels deep. This exceeds any shape a legitimate dashboard query or ` +
        `security policy would produce and would otherwise risk unbounded recursion. ` +
        `Ensure filter values, aggregation specs, and policy configuration are not arbitrarily deeply nested.`,
    );
  }
  if (Array.isArray(obj)) {
    return `[${obj.map((entry) => sortedStringify(entry, depth + 1)).join(',')}]`;
  }
  // Honor a `toJSON` method (e.g. `Date`) BEFORE the plain-object branch. A `Date`
  // has ZERO own enumerable keys, so the object branch below would serialize every
  // distinct date to `{}` — collapsing two widgets that differ only in a `Date`
  // filter bound onto ONE cache entry, so one is served the other's cached rows
  // (`computeQueryHash` in `cacheKey.ts`). `Date` filter values are a supported
  // shape (`isScalarComparisonValue` in `shared/predicates.ts`). Routing through
  // `JSON.stringify`, which invokes `toJSON`, serializes each date to its distinct
  // ISO string — matching how these values already serialize everywhere else. This
  // only changes hashes for previously-colliding inputs, so it cannot un-share a
  // legitimately shared entry.
  if (
    obj !== null &&
    typeof obj === 'object' &&
    typeof (obj as { toJSON?: unknown }).toJSON === 'function'
  ) {
    return JSON.stringify(obj);
  }
  if (obj !== null && typeof obj === 'object') {
    const sorted = Object.keys(obj as Record<string, unknown>)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${sortedStringify((obj as Record<string, unknown>)[k], depth + 1)}`,
      );
    return `{${sorted.join(',')}}`;
  }
  return JSON.stringify(obj);
}
