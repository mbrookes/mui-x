/**
 * The one "is this a usable bag of keys" predicate for this package.
 *
 * There were three byte-identical copies — `handleAIChat`'s `isPlainRecord`,
 * `buildAISystemPrompt`'s `isPlainObject`, and the tool executor's `isOpRecord` — each written
 * where its first caller happened to be. They all answer the same question about the same class
 * of value, so they are one function.
 *
 * **Deliberately looser than `@mui/x-studio-schema`'s exported `isPlainRecord`**, which
 * additionally requires the prototype to be `Object.prototype` or `null`. That strictness is
 * right where the schema uses it — screening a persisted or wire-sourced `StudioDoc`, where a
 * non-plain prototype is a red flag and `JSON.parse` could never have produced one. It is wrong
 * here. Two of this package's inputs, `customWidgets` and `skills`, arrive from the HOST as live
 * JavaScript rather than through `JSON.parse`, so a host that builds them with a class or a
 * factory hands over objects with a non-plain prototype. Under the strict predicate those become
 * "malformed" and are silently dropped from the prompt — real host configuration discarded to
 * satisfy a check meant for wire data.
 *
 * So the two predicates coexist on purpose, and swapping this one for the schema's is a
 * behavior change rather than a cleanup. That is exactly why it is written down here.
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
