/**
 * `Array.prototype.map` that returns the ORIGINAL array when no element's reference changed.
 *
 * The reference-equality no-op contract depends on this. Both the doc reducer and the runtime
 * transforms decline a write by returning the same object they were given, and a caller that
 * rebuilt its array unconditionally would defeat that: a logical no-op (an unknown id, a
 * value-identical update, a rejected patch) would still produce a fresh array, a fresh partition
 * and therefore a real commit — an undo entry and a log line for a change nobody made.
 *
 * Shared rather than duplicated: `StudioController` and `runtimeTransforms` both need exactly
 * this, and it was module-local to the controller until the second caller appeared.
 */
export function mapPreservingIdentity<T>(array: T[], mapFn: (item: T) => T): T[] {
  let changed = false;
  const next = array.map((item) => {
    const mapped = mapFn(item);
    if (mapped !== item) {
      changed = true;
    }
    return mapped;
  });
  return changed ? next : array;
}
