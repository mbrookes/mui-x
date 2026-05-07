import { enrichRowsWithExpressions, isJoinFieldExpression } from '../utils/expressionEvaluator';
import type { StudioDataSource, StudioExpressionField, StudioRelationship } from '../models';

type Row = Record<string, unknown>;

// ─── Per-source cache entries ─────────────────────────────────────────────────
//
// Each source gets its own cache entry tracking only ITS OWN dependencies:
//
//   rows            dataSources[X].rows at cache time
//   fieldRefs       the specific StudioExpressionField objects for source X
//   joinedSourceRows  for each JoinFieldExpression: the joined source's rows ref
//   relRefs         the specific StudioRelationship objects where sourceId === X
//
// This means changing customers data (or a customers expression field, or an
// unrelated relationship) has zero effect on the orders cache entry.
//
// Contrast with the old sentinel approach which wiped ALL entries on any
// dataSources / expressionFields / relationships ref change.

interface EnrichCacheEntry {
  rows: Row[];
  fieldRefs: StudioExpressionField[];
  joinedSourceRows: Map<string, Row[]>;
  relRefs: StudioRelationship[];
  result: Row[];
}

const entriesBySource = new Map<string, EnrichCacheEntry>();

function isEntryValid(
  entry: EnrichCacheEntry,
  rows: Row[],
  relevantFields: StudioExpressionField[],
  joinedSourceIds: string[],
  dataSources: Record<string, StudioDataSource>,
  relevantRelationships: StudioRelationship[],
): boolean {
  // 1. Own rows unchanged
  if (entry.rows !== rows) return false;

  // 2. Relevant expression fields: same objects, same count, same order
  if (entry.fieldRefs.length !== relevantFields.length) return false;
  for (let i = 0; i < relevantFields.length; i++) {
    if (entry.fieldRefs[i] !== relevantFields[i]) return false;
  }

  // 3. Joined source rows unchanged (only the sources this entry actually joins to)
  for (const jId of joinedSourceIds) {
    if (entry.joinedSourceRows.get(jId) !== dataSources[jId]?.rows) return false;
  }

  // 4. Relevant relationships unchanged (same objects)
  if (entry.relRefs.length !== relevantRelationships.length) return false;
  for (let i = 0; i < relevantRelationships.length; i++) {
    if (entry.relRefs[i] !== relevantRelationships[i]) return false;
  }

  return true;
}

/**
 * Returns enriched rows for the given source, using a per-source cache.
 *
 * Each source independently tracks only the dependencies that actually affect
 * its enrichment result:
 * - Own rows ref
 * - Expression field objects targeting this source
 * - Joined source rows refs (for JoinFieldExpression fields)
 * - Relationship objects involving this source
 *
 * Changing an unrelated source's data, expression fields, or relationships
 * does NOT invalidate this source's cache entry.
 *
 * The cache is also filter-independent — filter changes do not affect any
 * of the tracked dependencies, so enriched rows stay cached across filter
 * changes (cutting L3 cold cost from ~316ms to ~74ms at 100k rows).
 *
 * If there are no non-measure expression fields for this source, returns
 * `rows` unchanged (same reference — no cache entry created).
 */
/**
 * Returns enriched rows for the given source, using a per-source cache keyed
 * on the actual dependency refs (rows, relevant expression fields, joined source
 * rows, relationships).
 *
 * **Evaluation model — important for understanding performance:**
 *
 * Enrichment is *source-scoped*, not *widget-scoped*.  All row-level expression
 * fields (`isMeasure === false`) for a given `sourceId` are computed together in
 * one O(N) pass, regardless of which widgets currently reference them.
 *
 * Consequences:
 * - Expressions for **unrelated sources** → zero cost (filtered out immediately).
 * - Expressions for the **same source** (even if no widget uses them yet) →
 *   invalidate the source's cache entry on first call, triggering a full re-enrich.
 *   After that one recompute the result is cached and subsequent calls are O(1).
 * - **Measure expressions** (`isMeasure: true`) are excluded from row-level
 *   enrichment entirely and never affect this cache.
 *
 * If you add many unused expressions for an active source, expect a one-time
 * O(N × expressions) recompute, not a per-render cost.
 */
export function getCachedEnrichedRows(
  rows: Row[],
  sourceId: string | undefined,
  expressionFields: StudioExpressionField[],
  dataSources: Record<string, StudioDataSource>,
  relationships: StudioRelationship[],
): Row[] {
  if (!sourceId) {
    return rows;
  }

  // Collect only the expression fields that affect this source's enrichment.
  const relevantFields = expressionFields.filter((ef) => ef.sourceId === sourceId && !ef.isMeasure);
  if (relevantFields.length === 0) {
    return rows;
  }

  // Collect the joined source IDs used by JoinFieldExpression fields.
  const joinedSourceIds: string[] = [];
  for (const ef of relevantFields) {
    if (isJoinFieldExpression(ef.expression)) {
      const { joinSourceId } = ef.expression;
      if (!joinedSourceIds.includes(joinSourceId)) {
        joinedSourceIds.push(joinSourceId);
      }
    }
  }

  // Collect only the relationships that affect this source's enrichment
  // (those where this source is the "from" end of a join).
  const relevantRelationships = relationships.filter(
    (r) => r.sourceId === sourceId && joinedSourceIds.includes(r.targetId),
  );

  // Check the per-source cache entry.
  const existing = entriesBySource.get(sourceId);
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
  const result = enrichRowsWithExpressions(
    rows,
    expressionFields,
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

  entriesBySource.set(sourceId, {
    rows,
    fieldRefs: relevantFields,
    joinedSourceRows,
    relRefs: relevantRelationships,
    result,
  });

  return result;
}
