import {
  enrichRowsWithExpressions,
  isFieldExpression,
  isFunctionExpression,
  isJoinFieldExpression,
} from '../utils/expressionEvaluator';
import type { StudioDataSource, StudioExpression, StudioExpressionField, StudioRelationship } from '../models';

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

// 2-level cache: sourceId → fieldSetKey → entry
// fieldSetKey is the sorted, joined IDs of the expression fields being enriched.
// Using '*' when usedFieldIds is undefined (all fields for the source).
const entriesBySource = new Map<string, Map<string, EnrichCacheEntry>>();

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

// ─── Expression dependency expansion ─────────────────────────────────────────

/**
 * Walks a StudioExpression tree and collects all field IDs referenced
 * (excluding join-field references which are native, not expression, fields).
 */
function collectExpressionFieldRefs(expr: StudioExpression): string[] {
  const refs: string[] = [];
  function walk(node: StudioExpression): void {
    if (isFieldExpression(node)) {
      refs.push(node.id);
    } else if (isFunctionExpression(node)) {
      for (const input of node.inputs) {
        walk(input);
      }
    }
    // JoinFieldExpression, ValueExpression → no expression-field refs
  }
  walk(expr);
  return refs;
}

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
    for (const refId of collectExpressionFieldRefs(field.expression)) {
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
 */
export function getCachedEnrichedRows(
  rows: Row[],
  sourceId: string | undefined,
  expressionFields: StudioExpressionField[],
  dataSources: Record<string, StudioDataSource>,
  relationships: StudioRelationship[],
  usedFieldIds?: ReadonlySet<string>,
): Row[] {
  if (!sourceId) {
    return rows;
  }

  // Collect all non-measure expression fields for this source.
  const allSourceFields = expressionFields.filter((ef) => ef.sourceId === sourceId && !ef.isMeasure);

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

  // Look up the 2-level cache: sourceId → fieldSetKey → entry.
  let byFieldSet = entriesBySource.get(sourceId);
  if (!byFieldSet) {
    byFieldSet = new Map();
    entriesBySource.set(sourceId, byFieldSet);
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
