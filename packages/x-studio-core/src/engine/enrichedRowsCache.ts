import { enrichRowsWithExpressions } from '../utils/expressionEvaluator';
import type {
  StudioDataField,
  StudioDataSource,
  StudioExpressionField,
  StudioRelationship,
} from '../models';
import { collectExpressionRefs, collectJoinSourceIds } from './expressionRefs';
import { getLruEntry, getOrCreateBucket, setLruEntry } from './rowCacheLru';

type Row = Record<string, unknown>;

// ─── Per-rows cache entries ───────────────────────────────────────────────────
//
// Outer key: the source's own `rows` array (WeakMap) — matches the pattern used by
//   `normalizedRowsCache`/`resolvedRowsCache`. Keying on the rows reference (rather
//   than a bare `sourceId` string) means:
//     - Entries are GC'd automatically when a source's rows array is replaced or
//       the dashboard unmounts — no more rows pinned forever in a module-level Map.
//     - Two `<Studio>` instances with the SAME rows reference legitimately share an
//       entry (desired); two instances with DISTINCT rows arrays (even same sourceId)
//       get independent entries and never thrash each other.
//
// Inner key: fieldSetKey — the sorted, joined IDs of the expression fields being
//   enriched. Using '*' when usedFieldIds is undefined (all fields for the source).
//
// Each entry tracks only ITS OWN dependencies:
//   rows            the rows array at cache time (== outer key; kept for clarity)
//   fieldRefs       the specific StudioExpressionField objects for this source
// joinedSourceDeps for each JoinFieldExpression: the joined source's rows AND fields refs
//   relRefs         the specific StudioRelationship objects where sourceId === X
//
// This means changing customers data (or a customers expression field, or an
// unrelated relationship) has zero effect on the orders cache entry.
//
// The inner map is capped/evicted through the shared insertion-order LRU in
// `rowCacheLru.ts` — `usedFieldIds` derives from widget config plus reachable filter
// fields, so adding grid columns one at a time mints a new `fieldSetKey` per column and
// an uncapped map would retain one full enriched clone per HISTORICAL field set for as
// long as the rows array lives.

interface JoinedSourceDep {
  /** The joined source's rows ref at cache time (`undefined` when it had no rows). */
  rows: Row[] | undefined;
  /**
   * The joined source's `fields` ref at cache time. The join reads the joined source
   * through `getCachedNormalizedDataSource`, which is keyed on rows AND fields — so a
   * `fields`-only patch (e.g. `updateDataSourceField` retyping `signupDate` from
   * `'string'` to `'date'`, which keeps the same rows ref) changes the joined VALUES
   * without changing the rows ref. Tracking rows alone returned the stale enriched array
   * by reference: the raw `Date` object instead of the canonical `'2024-01-15'`.
   */
  fields: StudioDataField[] | undefined;
}

interface EnrichCacheEntry {
  rows: Row[];
  fieldRefs: StudioExpressionField[];
  joinedSourceDeps: Map<string, JoinedSourceDep>;
  relRefs: StudioRelationship[];
  result: Row[];
}

// 2-level cache: rows array (WeakMap) → fieldSetKey → entry
const cache = new WeakMap<Row[], Map<string, EnrichCacheEntry>>();

function isEntryValid(
  entry: EnrichCacheEntry,
  rows: Row[],
  relevantFields: StudioExpressionField[],
  joinedSourceIds: Iterable<string>,
  dataSources: Record<string, StudioDataSource>,
  relevantRelationships: StudioRelationship[],
): boolean {
  // 1. Own rows unchanged
  if (entry.rows !== rows) {
    return false;
  }

  // 2. Relevant expression fields: same objects, same count, same order
  if (entry.fieldRefs.length !== relevantFields.length) {
    return false;
  }
  for (let i = 0; i < relevantFields.length; i += 1) {
    if (entry.fieldRefs[i] !== relevantFields[i]) {
      return false;
    }
  }

  // 3. Joined source rows AND fields unchanged (only the sources this entry actually
  //    joins to). `fields` matters because the join reads the joined source through
  //    `getCachedNormalizedDataSource`, whose output depends on both.
  for (const jId of joinedSourceIds) {
    const dep = entry.joinedSourceDeps.get(jId);
    const joined = dataSources[jId];
    if (dep?.rows !== joined?.rows || dep?.fields !== joined?.fields) {
      return false;
    }
  }

  // 4. Relevant relationships unchanged (same objects)
  if (entry.relRefs.length !== relevantRelationships.length) {
    return false;
  }
  for (let i = 0; i < relevantRelationships.length; i += 1) {
    if (entry.relRefs[i] !== relevantRelationships[i]) {
      return false;
    }
  }

  return true;
}

// ─── Expression dependency expansion ─────────────────────────────────────────

/**
 * Given a set of requested field IDs and the full list of expression fields for a source,
 * returns the subset of expression fields that are needed — including transitive
 * dependencies (expression A references expression B → B is included too).
 *
 * `allSourceFields` MUST be the source's FULL expression-field list, measures included:
 * a widget's `usedFieldIds` routinely names a MEASURE (a KPI's `kpiValueField` is the
 * measure id), and a measure's own refs are exactly how the calculated columns it reads
 * enter enrichment scope. Filtering measures out BEFORE expansion makes
 * `fieldById.get(measureId)` miss, so the walk returns immediately, `relevantFields` is
 * empty, and `getCachedEnrichedRows` hands back the RAW rows — the measure then aggregates
 * a column that was never computed and evaluates to 0 in every widget. Measures are dropped
 * from the returned set by the caller instead, AFTER the transitive closure (mirrors
 * `queryDescriptor.expandToNativeFields`, which has always expanded against the unfiltered
 * list).
 */
function expandWithDependencies(
  requestedIds: ReadonlySet<string>,
  allSourceFields: StudioExpressionField[],
): StudioExpressionField[] {
  const fieldById = new Map(allSourceFields.map((f) => [f.id, f]));
  const included = new Set<string>();

  function includeTransitively(id: string): void {
    if (included.has(id)) {
      return;
    }
    const field = fieldById.get(id);
    if (!field) {
      // Not an expression field for this source (native field or different source).
      return;
    }
    included.add(id);
    for (const refId of collectExpressionRefs(field.expression)) {
      includeTransitively(refId);
    }
  }

  for (const id of requestedIds) {
    includeTransitively(id);
  }

  return allSourceFields.filter((f) => included.has(f.id));
}

/**
 * on the actual dependency refs (rows, relevant expression fields, joined source
 * rows, relationships).
 *
 * **Evaluation model — important for understanding performance:**
 *
 * Enrichment is *widget-scoped* when `usedFieldIds` is provided, or *source-scoped*
 * when `usedFieldIds` is omitted (enriches all non-measure expression fields for the source).
 *
 * Widget-scoped enrichment only computes the expression fields the widget actually
 * references in its config (xField, yField, columns, kpiValueField, filter fields, etc.),
 * plus any transitive expression-field dependencies. This means:
 *
 * - Adding an unused expression for the same source → zero cost (different cache slot).
 * - Each widget gets an independent cache entry → no cross-widget cache invalidation.
 * - Expressions for **unrelated sources** → zero cost (filtered out immediately).
 * - **Measure expressions** (`isMeasure: true`) are never themselves enriched onto a row,
 *   but they ARE walked during dependency expansion: a widget whose `usedFieldIds` names a
 *   measure (a KPI's value field is the measure id) pulls in the calculated columns that
 *   measure reads. Editing a measure's formula therefore changes the enriched field set —
 *   which is exactly what makes the measure aggregate real values instead of `undefined`.
 *
 * If you add many unused expressions for an active source, there is no performance
 * penalty for any existing widget (only new widgets that actually use them will compute).
 *
 * @param usedFieldIds  The set of expression field IDs this widget references.
 *   Pass `undefined` to enrich all relevant fields (backward-compatible, source-scoped).
 * @param collectJoinedSourceIds  Optional out-param: every foreign source id whose rows this
 *   enrichment reads (via a `JoinFieldExpression`, including nested ones) is added to it, so a
 *   caller building its own dependency-tracking cache (e.g. the L4 `rcfaCache`) can invalidate
 *   when those foreign rows change.
 */
export function getCachedEnrichedRows(
  rows: Row[],
  sourceId: string | undefined,
  expressionFields: StudioExpressionField[],
  dataSources: Record<string, StudioDataSource>,
  relationships: StudioRelationship[],
  usedFieldIds?: ReadonlySet<string>,
  collectJoinedSourceIds?: Set<string>,
): Row[] {
  if (!sourceId) {
    return rows;
  }

  // Collect ALL expression fields for this source — measures included. Measures are not
  // themselves row-level columns, but they are the DEPENDENCY EDGE that pulls a calculated
  // column into scope (`sum(profit)` → `profit`), and a widget's `usedFieldIds` frequently
  // names only the measure. Expanding against a measure-free map silently produced an empty
  // field set, so the widget rendered raw rows and the measure aggregated a missing column.
  const allSourceFields = expressionFields.filter((ef) => ef.sourceId === sourceId);

  // If usedFieldIds is provided, filter to only those fields (plus transitive deps). Measures
  // are dropped only AFTER the closure — they have no per-row value to enrich, but their refs
  // must have been walked first.
  const relevantFields = (
    usedFieldIds ? expandWithDependencies(usedFieldIds, allSourceFields) : allSourceFields
  ).filter((ef) => !ef.isMeasure);

  if (relevantFields.length === 0) {
    return rows;
  }

  // Compute the cache key for this specific field set.
  const fieldSetKey = relevantFields
    .map((f) => f.id)
    .sort()
    .join(',');

  // Collect the joined source IDs used by JoinFieldExpression fields — walking the FULL
  // expression tree, not just the top-level node, so a join nested inside e.g.
  // `if(customers.country == 'US', 1, 0)` is tracked as a dependency.
  const joinedSourceIds = new Set<string>();
  for (const ef of relevantFields) {
    for (const joinSourceId of collectJoinSourceIds(ef.expression)) {
      joinedSourceIds.add(joinSourceId);
      collectJoinedSourceIds?.add(joinSourceId);
    }
  }

  // Collect only the relationships that affect this source's enrichment: any DIRECT
  // (non-many-to-many) relationship whose other endpoint is a source we join to, in EITHER
  // declared direction.
  //
  // This predicate must stay byte-for-byte equivalent to `expressionEvaluator.findJoinFields`,
  // which is what the enrichment itself uses to resolve a `JoinFieldExpression`. It was
  // previously the same one-directional `r.sourceId === sourceId` test the evaluator used, so
  // the two agreed — but only because both were narrow. Widening the evaluator to resolve
  // reverse-declared relationships without widening this filter would open a cache-invalidation
  // hole: editing the join fields of a reverse-declared relationship would change the enriched
  // values while leaving `relRefs` unchanged, so the stale result array would be served forever.
  // `many-to-many` is excluded for the same reason the evaluator skips it — such a relationship
  // can never contribute a join here, so a change to one must not force recomputation either.
  const relevantRelationships = relationships.filter(
    (r) =>
      r.type !== 'many-to-many' &&
      ((r.sourceId === sourceId && joinedSourceIds.has(r.targetId)) ||
        (r.targetId === sourceId && joinedSourceIds.has(r.sourceId))),
  );

  // Look up the 2-level cache: rows array → fieldSetKey → entry.
  const byFieldSet = getOrCreateBucket(cache, rows);

  // `getLruEntry` refreshes recency on read so a repeatedly-used field set is never the
  // eviction candidate.
  const existing = getLruEntry(byFieldSet, fieldSetKey);
  if (
    existing &&
    isEntryValid(
      existing,
      rows,
      relevantFields,
      joinedSourceIds,
      dataSources,
      relevantRelationships,
    )
  ) {
    return existing.result;
  }

  // Cache miss — compute and store a new entry.
  // Pass only the relevantFields to enrichRowsWithExpressions for efficiency.
  const result = enrichRowsWithExpressions(
    rows,
    relevantFields,
    sourceId,
    dataSources,
    relationships,
  );

  // Record BOTH the rows and the fields ref of every joined source. Recording a source that
  // is currently absent (both `undefined`) is deliberate: it invalidates the entry the moment
  // that source loads.
  const joinedSourceDeps = new Map<string, JoinedSourceDep>();
  for (const jId of joinedSourceIds) {
    const joined = dataSources[jId];
    joinedSourceDeps.set(jId, { rows: joined?.rows, fields: joined?.fields });
  }

  setLruEntry(byFieldSet, fieldSetKey, {
    rows,
    fieldRefs: relevantFields,
    joinedSourceDeps,
    relRefs: relevantRelationships,
    result,
  });

  return result;
}
