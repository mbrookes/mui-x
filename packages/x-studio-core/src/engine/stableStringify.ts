/**
 * Maximum object/array nesting depth walked before the remainder collapses to a sentinel.
 *
 * Together with the cycle guard below this makes `stableStringify` total: it is called from
 * inside `useMemo` during render (`filterFingerprint`, `buildQueryDescriptor`'s `cacheKey`)
 * on `StudioFilterState['value']`, which is typed `unknown` and comes straight from the host.
 * An unbounded recursion there turns a self-referential or pathologically deep filter value
 * into a `RangeError` thrown during render, with no error boundary above it.
 */
const MAX_DEPTH = 64;

/**
 * Stable, content-based stringify used to build cache keys. Sorts nested object keys
 * so two values that differ only by key order stringify identically.
 *
 * Beyond plain JSON it gives every value the pipeline can legitimately carry a DISTINCT,
 * deterministic encoding — the whole point of a cache key:
 *
 * - `Date` → `D<epoch ms>`. `JSON.stringify` sees no own enumerable keys on a `Date` and
 *   emits `{}` through the object branch below, so every `Date` collapsed to one key.
 *   `filterUtils` explicitly supports `Date` filter values, so a host driving the filter
 *   API with `new Date(...)` was served the PREVIOUS date's rows out of the L3 cache and
 *   the wrong server response out of `StudioRequestCache` for its whole TTL.
 * - `Map` / `Set` → sorted entry/value encodings (both also stringified `{}` before).
 *   Sorting keeps them order-insensitive, matching the object-key sort.
 * - `NaN` / `±Infinity` → `#NaN` / `#Infinity` / `#-Infinity` sentinels. `JSON.stringify`
 *   maps all three to `null`, making them indistinguishable from an actual `null`.
 * - `BigInt` → `#BigInt(n)`. `JSON.stringify` THROWS on a bigint.
 * - `RegExp` → `#RegExp(/src/flags)` (another own-key-less built-in).
 *
 * A bare `undefined` (or any value `JSON.stringify` returns `undefined` for, e.g. an
 * `undefined` array element, a function, a symbol) maps to the literal `'null'` so the
 * output is always a deterministic string — never the runtime `undefined`.
 */
export function stableStringify(value: unknown): string {
  return stringifyValue(value, 0, new WeakSet<object>());
}

function stringifyValue(value: unknown, depth: number, seen: WeakSet<object>): string {
  if (value === null) {
    return 'null';
  }

  const valueType = typeof value;

  if (valueType === 'number') {
    const num = value as number;
    if (Number.isNaN(num)) {
      return '"#NaN"';
    }
    if (!Number.isFinite(num)) {
      return num > 0 ? '"#Infinity"' : '"#-Infinity"';
    }
    return JSON.stringify(num) ?? 'null';
  }

  if (valueType === 'bigint') {
    // JSON.stringify throws a TypeError on a bigint — encode it explicitly instead.
    return `"#BigInt(${String(value)})"`;
  }

  if (valueType !== 'object') {
    // string / boolean / undefined / symbol / function
    return JSON.stringify(value) ?? 'null';
  }

  const obj = value as object;

  // Cycle guard: a value already on the current path re-encodes as a sentinel rather than
  // recursing forever. Removed again on the way out so a DAG (the same object referenced
  // twice in SIBLING positions) still encodes fully, both times.
  if (seen.has(obj)) {
    return '"#Cycle"';
  }
  if (depth >= MAX_DEPTH) {
    return '"#MaxDepth"';
  }

  if (obj instanceof Date) {
    // getTime() is NaN for an Invalid Date — still deterministic, and distinct from any
    // valid instant.
    return `"D${obj.getTime()}"`;
  }

  if (obj instanceof RegExp) {
    return `"#RegExp(${obj.source}/${obj.flags})"`;
  }

  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      return `[${obj.map((item) => stringifyValue(item, depth + 1, seen)).join(',')}]`;
    }

    if (obj instanceof Map) {
      const entries = Array.from(
        obj.entries(),
        ([k, v]) => `[${stringifyValue(k, depth + 1, seen)},${stringifyValue(v, depth + 1, seen)}]`,
      ).sort();
      return `Map(${entries.join(',')})`;
    }

    if (obj instanceof Set) {
      const values = Array.from(obj.values(), (v) => stringifyValue(v, depth + 1, seen)).sort();
      return `Set(${values.join(',')})`;
    }

    const sorted = Object.keys(obj as Record<string, unknown>)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${stringifyValue((obj as Record<string, unknown>)[k], depth + 1, seen)}`,
      );
    return `{${sorted.join(',')}}`;
  } finally {
    seen.delete(obj);
  }
}
