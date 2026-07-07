/**
 * Stable, content-based stringify used to build cache keys. Sorts nested object keys
 * so two values that differ only by key order stringify identically.
 *
 * A bare `undefined` (or any value `JSON.stringify` returns `undefined` for, e.g. an
 * `undefined` array element) maps to the literal `'null'` so the output is always a
 * deterministic string — never the runtime `undefined`. This makes it safe for the
 * ephemeral descriptor/filter cache keys the pipeline builds.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const sorted = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
  return `{${sorted.join(',')}}`;
}
