type Row = Record<string, unknown>;

/**
 * Well-known symbol key carrying a stable, per-logical-row identity token.
 *
 * Why a symbol-keyed property (and not `row.id` or a WeakMap):
 *
 * - **Survives cloning.** The pipeline clones rows with object spread in several
 *   places (`normalizeDataSourceRows`, `enrichRowsWithExpressions`, `resolveRows`
 *   semi-join, `enrichWithCrossSourceFields`). Object spread copies own **enumerable**
 *   properties — including symbol-keyed ones — so an enumerable symbol tag is carried
 *   forward automatically by every `{ ...row }` clone without touching those sites. A
 *   `WeakMap<Row, id>` would break here: a clone is a *different* object reference, so
 *   it would not inherit the original's entry.
 * - **Invisible everywhere it must be.** `Object.keys`, `Object.entries`,
 *   `JSON.stringify`, and the Data Grid's (string-keyed) column model all ignore symbol
 *   keys, so the tag never leaks into columns, serialization, or `processRowUpdate`.
 * - **Works for id-less sources.** Some data sources have no natural `id` field (an
 *   explicitly supported case); the tag gives every row a stable identity regardless.
 */
export const ROW_IDENTITY: unique symbol = Symbol('studioRowIdentity');

let counter = 0;

/**
 * Returns the row's stable identity token, assigning a fresh monotonic one the first
 * time. Idempotent — calling it again on the same object (or on a spread-clone that
 * already carried the tag forward) returns the existing token.
 *
 * The property is created **enumerable** on purpose so downstream `{ ...row }` clones
 * copy it forward automatically (see the note on `ROW_IDENTITY`).
 *
 * Adding this inert identity tag to a (possibly cache-shared) row object is safe: it is
 * assigned once and never changes, it is semantically invisible to every cache's
 * validity check (all of which key on array/field-object references, never on per-row
 * shape), and two logical-row instances that legitimately share an object correctly
 * share one token.
 */
export function ensureRowIdentity(row: Row): number {
  const existing = (row as Record<symbol, unknown>)[ROW_IDENTITY] as number | undefined;
  if (existing !== undefined) {
    return existing;
  }
  counter += 1;
  (row as Record<symbol, unknown>)[ROW_IDENTITY] = counter;
  return counter;
}

/** Returns the row's identity token if it has been tagged, otherwise `undefined`. */
export function getRowIdentity(row: Row): number | undefined {
  return (row as Record<symbol, unknown>)[ROW_IDENTITY] as number | undefined;
}
