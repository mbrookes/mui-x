/**
 * Shared internal predicates/helpers used by the reducer (`applyMutation.ts`), the wire
 * boundary (`parseStateMutation.ts`), and the persistence load boundary
 * (`statePersistence.ts`).
 *
 * These three "trust boundary" files each independently defined byte-for-byte identical copies of
 * `isRecord`/`isPlainRecord`, `repairFilterDependsOn`, and the unsafe-own-key strip
 * (`stripUnsafeConfigKeys`/`stripUnsafeOwnKeys`). Consolidating them here means the three
 * boundaries can no longer silently drift apart (e.g. one gaining a tolerance, or a bugfix, the
 * others don't get).
 *
 * NOT exported from the package's public `index.ts` — these are implementation details of
 * the reducer/wire/load boundaries, not part of the package's public API. (`unsafeKeys.ts`
 * and `wireLimits.ts` ARE public: a denylist and a set of size caps whose whole purpose is
 * to be identical everywhere are not implementation details of any one boundary, and keeping
 * them unreachable is what made `@mui/x-studio` hand-roll a byte-equivalent copy — see the
 * note on their export in `index.ts`.)
 *
 * This module intentionally does NOT import from `parseStateMutation.ts` (which needs
 * {@link isPlainRecord} from here for its own `isRecord` alias) — that would form an
 * import cycle. `stripUnsafeOwnKeys` and `repairFilterDependsOn` therefore check the
 * unsafe-key condition directly against {@link UNSAFE_KEYS}, and the array-shape/size
 * condition against the shared {@link MAX_ARRAY_LENGTH}/{@link MAX_STRING_LENGTH}
 * constants, rather than calling `parseStateMutation.ts`'s `hasUnsafeOwnKeys`/
 * `isStringArray` directly — this file only depends on the zero-dependency
 * `unsafeKeys.ts`/`wireLimits.ts`, and the size caps are still the SAME caps
 * `isStringArray` enforces, imported from one shared source rather than re-declared.
 */
import { isSafeKey, UNSAFE_KEYS } from './unsafeKeys';
import { MAX_ARRAY_LENGTH, MAX_STRING_LENGTH } from './wireLimits';

/**
 * A plain object (not `null`, not an array, not a primitive, and not an exotic object
 * like a `Date`/`RegExp`/`Map`/`Set`/class instance). The single shared "is this a usable
 * record" predicate for every trust boundary in this package: a non-record value (`null`,
 * an array, a truthy primitive like a string, or an exotic object) is treated as ABSENT,
 * never as a record to merge, install, or read fields off of.
 *
 * The prototype check (Tier2 finding) is what excludes the exotic-object case: `typeof
 * value === 'object' && value !== null && !Array.isArray(value)` alone is true for a
 * `Date`, `RegExp`, `Map`, `Set`, or any class instance, since all of those ARE
 * `typeof … === 'object'` non-array non-null values. Every call site treats a passing
 * value as a plain data bag — spreading it (`{ ...value }`), reading arbitrary string
 * keys off it, or installing it verbatim as a widget/filter config — so an exotic object
 * silently "laundered" through as `{}`-like (e.g. `{ ...new Map([['a', 1]]) }` produces
 * `{}`, discarding the Map's entries with no error) rather than being rejected as the
 * malformed input it is. Requiring the prototype to be exactly `Object.prototype` (a
 * literal `{}`/object-literal shape) or `null` (an explicit `Object.create(null)` bag,
 * which callers may legitimately use to avoid prototype pollution entirely) is a strict
 * tightening: every object literal and every `JSON.parse` output (the wire/persistence
 * boundaries' actual input shape) already has `Object.prototype` as its prototype, so
 * this changes no behavior for the values this predicate was ever meant to accept.
 *
 * `!Array.isArray(value)` is REDUNDANT for every value that can reach a trust boundary:
 * an array's prototype is `Array.prototype`, so the prototype clause below already rejects
 * it, and removing the array clause fails no test in this package. It is kept as a cheap,
 * self-documenting early-out for the commonest non-record input, and because it still
 * covers the one case the prototype clause does not — an array whose prototype has been
 * re-pointed at `Object.prototype`.
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

/**
 * Strip the prototype-polluting own keys (`__proto__`/`constructor`/`prototype`) from a
 * record that is about to be installed WHOLESALE (a widget/filter config, a persisted
 * `dashboard`/`ai` bag, a thread). Object spread uses DEFINE semantics (so it never
 * pollutes a live prototype), but it RETAINS an unsafe key as an own DATA property; on
 * the next load/round-trip that own key can poison a later `Object.assign`/spread of the
 * record, or (for a widget config) cause the ENTIRE widget to be dropped by the load
 * boundary's own-key screen. Reference-stable: returns the SAME object when it carries no
 * unsafe own key.
 */
export function stripUnsafeOwnKeys<T extends object>(record: T): T {
  const keys = Object.keys(record);
  if (keys.every((key) => !UNSAFE_KEYS.has(key))) {
    return record;
  }
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (isSafeKey(key)) {
      safe[key] = value;
    }
  }
  return safe as T;
}

/**
 * Repair (not drop) a filter's `dependsOn` field before it is installed/appended
 * verbatim: `dependsOn` is optional cascade metadata, not identity data, so a malformed
 * value (`dependsOn: 'w1'`, `dependsOn: [1, 2]`) is stripped from the filter object
 * rather than sinking (or dropping) the whole filter. Non-record input is returned as-is
 * — the caller's own record screen handles that case. Reference-stable when `dependsOn`
 * is absent or already a valid `string[]` within {@link MAX_ARRAY_LENGTH}/
 * {@link MAX_STRING_LENGTH}.
 *
 * Enforces the SAME size caps `parseStateMutation.ts`'s `isStringArray` applies at the
 * wire boundary, not just the shape. This function is the reducer/load-boundary
 * defense-in-depth repair — reachable by a server-built mutation that bypasses the wire
 * parser (`applyMutation.ts`'s `addFilter`) and by a persisted/shared doc
 * (`docScreening.ts`'s `screenFilters`) — so an unbounded `dependsOn` array on either of
 * those paths must be repaired (treated as malformed and stripped) exactly as the wire
 * boundary would reject it, not accepted as unbounded cascade metadata.
 */
export function repairFilterDependsOn<T>(entry: T): T {
  if (!isPlainRecord(entry)) {
    return entry;
  }
  const dependsOn = (entry as { dependsOn?: unknown }).dependsOn;
  if (
    dependsOn === undefined ||
    (Array.isArray(dependsOn) &&
      dependsOn.length <= MAX_ARRAY_LENGTH &&
      dependsOn.every((item) => typeof item === 'string' && item.length <= MAX_STRING_LENGTH))
  ) {
    return entry;
  }
  const rest = { ...(entry as Record<string, unknown>) };
  delete rest.dependsOn;
  return rest as T;
}
