import { enrichRowsWithExpressions } from '../utils/expressionEvaluator';
import type { StudioDataSource, StudioExpressionField, StudioRelationship } from '../models';
import { collectExpressionRefs, collectJoinSourceIds } from './expressionRefs';

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
//   joinedSourceRows  for each JoinFieldExpression: the joined source's rows ref
//   relRefs         the specific StudioRelationship objects where sourceId === X
//
// This means changing customers data (or a customers expression field, or an
// unrelated relationship) has zero effect on the orders cache entry.

interface EnrichCacheEntry {
  rows: Row[];
  fieldRefs: StudioExpressionField[];
  joinedSourceRows: Map<string, Row[]>;
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

  // 3. Joined source rows unchanged (only the sources this entry actually joins to)
  for (const jId of joinedSourceIds) {
    if (entry.joinedSourceRows.get(jId) !== dataSources[jId]?.rows) {
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
 * - **Measure expressions** (`isMeasure: true`) are excluded from row-level
 *   enrichment entirely and never affect this cache.
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

  // Collect all non-measure expression fields for this source.
  const allSourceFields = expressionFields.filter(
    (ef) => ef.sourceId === sourceId && !ef.isMeasure,
  );

  // If usedFieldIds is provided, filter to only those fields (plus transitive deps).
  const relevantFields = usedFieldIds
    ? expandWithDependencies(usedFieldIds, allSourceFields)
    : allSourceFields;

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
  // `if(customers.country == 'US', 1, 0)` is tracked as a dependency (finding 2.18).
  const joinedSourceIds = new Set<string>();
  for (const ef of relevantFields) {
    for (const joinSourceId of collectJoinSourceIds(ef.expression)) {
      joinedSourceIds.add(joinSourceId);
      collectJoinedSourceIds?.add(joinSourceId);
    }
  }

  // Collect only the relationships that affect this source's enrichment
  // (those where this source is the "from" end of a join).
  const relevantRelationships = relationships.filter(
    (r) => r.sourceId === sourceId && joinedSourceIds.has(r.targetId),
  );

  // Look up the 2-level cache: rows array → fieldSetKey → entry.
  let byFieldSet = cache.get(rows);
  if (!byFieldSet) {
    byFieldSet = new Map();
    cache.set(rows, byFieldSet);
  }

  const existing = byFieldSet.get(fieldSetKey);
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

  const joinedSourceRows = new Map<string, Row[]>();
  for (const jId of joinedSourceIds) {
    const jRows = dataSources[jId]?.rows;
    if (jRows) {
      joinedSourceRows.set(jId, jRows);
    }
  }

  byFieldSet.set(fieldSetKey, {
    rows,
    fieldRefs: relevantFields,
    joinedSourceRows,
    relRefs: relevantRelationships,
    result,
  });

  return result;
}
