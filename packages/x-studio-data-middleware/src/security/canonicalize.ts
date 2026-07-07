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
 */
export function sortedStringify(obj: unknown): string {
  if (Array.isArray(obj)) {
    return `[${obj.map(sortedStringify).join(',')}]`;
  }
  if (obj !== null && typeof obj === 'object') {
    const sorted = Object.keys(obj as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${sortedStringify((obj as Record<string, unknown>)[k])}`);
    return `{${sorted.join(',')}}`;
  }
  return JSON.stringify(obj);
}
