/**
 * The prototype-pollution key denylist, shared by every place in this package that
 * writes an untrusted string into a record via a bare bracket assignment
 * (`record[key] = value`).
 *
 * `record['__proto__'] = v` invokes the inherited `__proto__` setter (prototype
 * pollution) rather than adding an own key; `'constructor'`/`'prototype'` are the
 * sibling escape hatches. Both the wire boundary (`parseStateMutation`, which rejects
 * a payload carrying these keys) and the reducer (`applyMutation`, whose
 * defense-in-depth copy guards mutations the server builds WITHOUT the parser) import
 * from here, so the denylist is defined exactly once and cannot drift between them.
 */
export const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * True when `key` is safe to use as a `Record` key via a bare bracket assignment —
 * i.e. it is not one of the prototype-polluting {@link UNSAFE_KEYS}.
 */
export function isSafeKey(key: string): boolean {
  return !UNSAFE_KEYS.has(key);
}
