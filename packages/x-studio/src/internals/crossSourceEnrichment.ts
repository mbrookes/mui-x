import type {
  StudioDataSource,
  StudioExpressionField,
  StudioGridColumn,
  StudioRelationship,
} from '../models';
import { buildRelatedSourceJoinIndex } from './dataSourceGraph';
import { getCachedEnrichedRows } from './enrichedRowsCache';
import { indexRowsByKey, normalizeJoinKey } from './joinKeys';
import { getCachedNormalizedDataSource } from './normalizedRowsCache';
import { ensureRowIdentity } from './rowIdentity';

type Row = Record<string, unknown>;

/** Minimal field reference used by enrichWithCrossSourceFields. */
export interface CrossSourceFieldRef {
  fieldId: string;
  sourceId: string;
}

/**
 * Enriches `rows` with field values from directly (one-hop) related sources.
 *
 * For each field ref whose `sourceId !== widgetSourceId` the function:
 *  1. Locates the direct relationship between `widgetSourceId` and `ref.sourceId` — in either
 *     declared direction, and for any non-many-to-many type (see
 *     `buildRelatedSourceJoinIndex`)
 *  2. Builds a Map of related rows keyed by their join field (`join.targetField`)
 *  3. Copies `ref.fieldId` from the related row onto each primary row via the widget-side
 *     join value (`join.sourceField`)
 *
 * Field refs whose related source has no in-memory rows (async sources) are silently
 * skipped — the field value stays `undefined` in the primary row.
 *
 * When a requested related field is a **calculated column** (an expression field owned
 * by the related source) rather than a physical field, the related source's rows carry
 * no value for it until they run through the L2 pass. Passing `expressionFields` lets
 * this function route the related source's rows through the shared, dependency-tracked
 * L2 cache (`getCachedEnrichedRows`, scoped to only the requested field ids) before
 * building the lookup index — the same pass `grainResolution.ts` applies to
 * anchor/junction/remote rows — so a related-source expression column resolves to a real
 * value instead of `undefined` (architecture review finding 2.3). Physical related-source
 * fields are unaffected (their value is already present on the raw rows).
 *
 * @param rows             Filtered primary-source rows
 * @param widgetSourceId   The widget's primary source ID
 * @param fieldRefs        Cross-source field references to enrich
 * @param dataSources      All data sources (keyed by ID)
 * @param relationships    Declared relationships
 * @param expressionFields Expression fields (used to L2-enrich related sources whose
 *                         requested field is a calculated column). Defaults to `[]`.
 */
export function enrichWithCrossSourceFields(
  rows: Row[],
  widgetSourceId: string | undefined,
  fieldRefs: CrossSourceFieldRef[],
  dataSources: Record<string, StudioDataSource>,
  relationships: StudioRelationship[],
  expressionFields: StudioExpressionField[] = [],
): Row[] {
  if (!widgetSourceId || !fieldRefs.length) {
    return rows;
  }

  const crossFields = fieldRefs.filter((r) => r.sourceId !== widgetSourceId);

  if (crossFields.length === 0) {
    return rows;
  }

  // Requested calculated-column ids grouped by their related source. A related-source
  // field is a calculated column when a non-measure expression field owns it there; such
  // a field has no value on the related source's raw rows and needs an L2 pass first.
  const exprIdsBySource = new Map<string, Set<string>>();
  if (expressionFields.length > 0) {
    for (const ref of crossFields) {
      const isRelatedExpression = expressionFields.some(
        (ef) => ef.id === ref.fieldId && ef.sourceId === ref.sourceId && !ef.isMeasure,
      );
      if (isRelatedExpression) {
        let set = exprIdsBySource.get(ref.sourceId);
        if (!set) {
          set = new Set<string>();
          exprIdsBySource.set(ref.sourceId, set);
        }
        set.add(ref.fieldId);
      }
    }
  }

  // Group by relatedSourceId to build each index only once
  type ColMeta = {
    fieldId: string;
    fkField: string; // field on primary rows
    relatedIndex: Map<string, Row>;
  };

  const colMeta: ColMeta[] = [];

  // relatedSourceId → oriented one-hop join — shared traversal step, see
  // dataSourceGraph.buildRelatedSourceJoinIndex. Direction-independent and not limited to
  // `many-to-one`, so a one-to-one or reverse-declared relationship resolves here exactly as
  // it already did for charts (`findDirectFieldOwner`) and for the adapter (`resolveField`).
  const relIndex = buildRelatedSourceJoinIndex(widgetSourceId, relationships);

  for (const ref of crossFields) {
    const rel = relIndex.get(ref.sourceId);
    if (!rel) {
      continue;
    }
    const relatedDataSource = dataSources[ref.sourceId];
    if (!relatedDataSource?.rows) {
      continue;
    }
    // Route through the same L1 date normalization the widget's own source rows get
    // (`getCachedNormalizedDataSource`) rather than the raw store — otherwise a date/datetime
    // cross-source display column (a grid column or map field referencing a related source) stays
    // a raw `Date`/non-canonical string here, bucketing differently than an L1-normalized date on
    // the primary source for a non-UTC viewer (finding 4).
    const rawRelatedRows = getCachedNormalizedDataSource(relatedDataSource).rows as Row[];
    // If a calculated column owned by this related source is requested, L2-enrich the
    // related source's rows (scoped to only the requested calculated-column ids) so the
    // value exists before indexing. Cached and dependency-tracked, so repeated refs to the
    // same source recompute nothing; a purely-physical related source uses its raw rows.
    const exprIds = exprIdsBySource.get(ref.sourceId);
    const relatedRows =
      exprIds && exprIds.size > 0
        ? (getCachedEnrichedRows(
            rawRelatedRows,
            ref.sourceId,
            expressionFields,
            dataSources,
            relationships,
            exprIds,
          ) as Row[])
        : rawRelatedRows;
    // Index related rows by their PK using the shared join-key policy so a numeric
    // PK matches a string FK etc. (see internals/joinKeys.ts).
    const relatedIndex = indexRowsByKey(relatedRows, rel.targetField);
    colMeta.push({ fieldId: ref.fieldId, fkField: rel.sourceField, relatedIndex });
  }

  if (colMeta.length === 0) {
    return rows;
  }

  return rows.map((row) => {
    // Tag the (shared, pre-clone) source row with a stable identity token BEFORE the
    // `{ ...row }` clone below. Cross-source enrichment is the point where a row's object
    // identity is otherwise lost: each baseline (`filteredRows` vs `filteredRowsNoChartCross`)
    // is enriched by a separate `.map()` pass, and the spread clones a fresh object for every
    // row that receives a cross-source value — so the two baselines end up holding *different*
    // instances for the same logical row, silently breaking any reference-equality match (e.g.
    // the grid's cross-highlight Set). Because both baselines are filtered from the same
    // pipeline-cached array, their same-logical-row entries are the *same* object here; tagging
    // it once (idempotent) means both passes clone from an already-tagged original, and the
    // enumerable symbol tag is carried forward by the spread — giving a match key that survives
    // cloning. See rowIdentity.ts for why an enumerable symbol (not a WeakMap) is required.
    ensureRowIdentity(row);
    let enriched: Row | null = null;
    for (const { fieldId, fkField, relatedIndex } of colMeta) {
      // Never overwrite a value the primary row already owns under this bare id — a
      // cross-source column can share a bare `fieldId` with a primary column (e.g. a
      // primary `name` plus a related `customers.name`), and clobbering the own-source
      // cell would silently replace the primary column's data with the joined value on
      // every matched row (finding T1.2). Mirrors `dataSourceGraph.ts`'s
      // `enrichRowsWithRelatedFields` own-field guard.
      if (fieldId in row) {
        continue;
      }
      const fkValue = normalizeJoinKey(row[fkField]);
      const relatedRow = fkValue === null ? undefined : relatedIndex.get(fkValue);
      if (relatedRow && relatedRow[fieldId] !== undefined) {
        if (!enriched) {
          enriched = { ...row };
        }
        enriched[fieldId] = relatedRow[fieldId];
      }
    }
    return enriched ?? row;
  });
}

/**
 * Convenience wrapper: enriches rows using StudioGridColumn config.
 * Delegates to enrichWithCrossSourceFields after normalising column shape.
 */
export function enrichWithCrossSourceColumns(
  rows: Row[],
  widgetSourceId: string | undefined,
  columns: StudioGridColumn[] | undefined,
  dataSources: Record<string, StudioDataSource>,
  relationships: StudioRelationship[],
  expressionFields: StudioExpressionField[] = [],
): Row[] {
  if (!widgetSourceId || !columns?.length) {
    return rows;
  }

  const fieldRefs: CrossSourceFieldRef[] = columns.flatMap((c) =>
    c.sourceId && c.sourceId !== widgetSourceId
      ? [{ fieldId: c.fieldId, sourceId: c.sourceId }]
      : [],
  );

  return enrichWithCrossSourceFields(
    rows,
    widgetSourceId,
    fieldRefs,
    dataSources,
    relationships,
    expressionFields,
  );
}
