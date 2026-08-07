type Row = Record<string, unknown>;

/**
 * The single join-key coercion policy shared by every cross-source path in the
 * package (chart grain re-anchoring, filter semi-joins, grid fan-out dedup, and
 * display-column enrichment).
 *
 * History: the two families of code that resolve cross-source joins used to
 * disagree. `gridGrouping.ts` and `crossSourceEnrichment.ts` coerced keys with
 * `String(x ?? '')`, while `dataSourceGraph.ts` and `chartAggregation.ts` used
 * the raw runtime value as a `Map`/`Set` key. That meant a numeric FK (`5`)
 * against a string PK (`"5"`) joined in the grid path but silently failed in the
 * chart/filter path — the same relationship produced different numbers depending
 * on the widget kind, and a numeric-vs-string mismatch in the many-to-many
 * junction-anchor path dropped ALL rows.
 *
 * Policy:
 * - `null` / `undefined` → `null`. A missing key never matches a real key
 *   (see `indexRowsByKey`, which refuses to index rows whose key is `null`), so
 *   an unlinked FK contributes nothing rather than colliding with an empty PK.
 * - `Date` → its ISO string, so two equal instants join regardless of identity.
 * - everything else → `String(value)`. This is what makes `5` and `"5"` the
 *   same key. Same-type keys (string↔string, number↔number) are unaffected,
 *   because `String` is idempotent on them for equality purposes.
 */
export function normalizeJoinKey(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'object') {
    // Objects/arrays are not valid scalar join keys; treat as "no key".
    return null;
  }
  return String(value);
}

/**
 * Builds a `normalizedKey → row` index over `rows`, keyed by `keyField` through
 * {@link normalizeJoinKey}. Rows whose key normalizes to `null` (missing/objects)
 * are skipped so they never become a spurious join target. By default the FIRST
 * row seen for a key wins (matching the display-column "first match" semantics);
 * pass `keepLast` to have later rows overwrite earlier ones.
 */
export function indexRowsByKey(
  rows: Row[],
  keyField: string,
  options?: { keepLast?: boolean },
): Map<string, Row> {
  const map = new Map<string, Row>();
  const keepLast = options?.keepLast ?? false;
  for (const row of rows) {
    const key = normalizeJoinKey(row[keyField]);
    if (key === null) {
      continue;
    }
    if (keepLast || !map.has(key)) {
      map.set(key, row);
    }
  }
  return map;
}

/**
 * Builds a `Set` of normalized key values read from `keyField` across `rows`.
 * Missing/object keys (normalizing to `null`) are excluded.
 */
export function collectKeySet(rows: Row[], keyField: string): Set<string> {
  const set = new Set<string>();
  for (const row of rows) {
    const key = normalizeJoinKey(row[keyField]);
    if (key !== null) {
      set.add(key);
    }
  }
  return set;
}
