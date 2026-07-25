/**
 * Prototype-chain-safe record indexing.
 *
 * A bare `record[key]` on a plain object literal walks the prototype chain, so a key that
 * happens to name an `Object.prototype` member — `"constructor"`, `"toString"`, `"valueOf"`,
 * `"hasOwnProperty"` — resolves an inherited, truthy-but-wrong value instead of `undefined`.
 * Neither `?.` nor `?? fallback` fires for such a value, so the bogus function flows onward:
 * `ds?.fields` becomes `undefined` on the `Object` constructor, `descriptor.collectFields`
 * becomes "not a function", a locale key becomes a React child, a day count becomes `NaN`.
 *
 * Every key in x-studio that indexes a record comes from somewhere untrusted — a persisted
 * dashboard document, an AI tool call, or a host-injected config — so lookups on plain object
 * literals must be guarded. Use this helper (or a real `Map`) instead of open-coding
 * `Object.hasOwn(...) ? record[...] : undefined` at each call site.
 *
 * @example
 * const source = lookup(dataSources, widget.sourceId);
 * const field = source?.fields?.find((f) => f.id === fieldId);
 */
export function lookup<K extends PropertyKey, V>(
  record: Partial<Record<K, V>> | undefined | null,
  key: K | undefined | null,
): V | undefined {
  if (record == null || key == null) {
    return undefined;
  }
  return Object.hasOwn(record, key) ? record[key] : undefined;
}
