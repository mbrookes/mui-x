import type { StudioDataSource, StudioGridColumn, StudioRelationship } from '../models';
import { buildManyToOneRelationshipIndex } from './dataSourceGraph';
import { indexRowsByKey, normalizeJoinKey } from './joinKeys';
import { ensureRowIdentity } from './rowIdentity';

type Row = Record<string, unknown>;

/** Minimal field reference used by enrichWithCrossSourceFields. */
interface CrossSourceFieldRef {
  fieldId: string;
  sourceId: string;
}

/**
 * Enriches `rows` with field values from many-to-one related sources.
 *
 * For each field ref whose `sourceId !== widgetSourceId` the function:
 *  1. Locates the many-to-one relationship from `widgetSourceId` → `ref.sourceId`
 *  2. Builds a Map of related rows keyed by their PK (`rel.targetField`)
 *  3. Copies `ref.fieldId` from the related row onto each primary row via FK lookup
 *
 * Field refs whose related source has no in-memory rows (async sources) are silently
 * skipped — the field value stays `undefined` in the primary row.
 *
 * @param rows             Filtered primary-source rows
 * @param widgetSourceId   The widget's primary source ID
 * @param fieldRefs        Cross-source field references to enrich
 * @param dataSources      All data sources (keyed by ID)
 * @param relationships    Declared relationships
 */
export function enrichWithCrossSourceFields(
  rows: Row[],
  widgetSourceId: string | undefined,
  fieldRefs: CrossSourceFieldRef[],
  dataSources: Record<string, StudioDataSource>,
  relationships: StudioRelationship[],
): Row[] {
  if (!widgetSourceId || !fieldRefs.length) {
    return rows;
  }

  const crossFields = fieldRefs.filter((r) => r.sourceId !== widgetSourceId);

  if (crossFields.length === 0) {
    return rows;
  }

  // Group by relatedSourceId to build each index only once
  type ColMeta = {
    fieldId: string;
    fkField: string; // field on primary rows
    relatedIndex: Map<string, Row>;
  };

  const colMeta: ColMeta[] = [];

  // targetId → relationship (many-to-one from widgetSourceId) — shared traversal step,
  // see dataSourceGraph.buildManyToOneRelationshipIndex.
  const relIndex = buildManyToOneRelationshipIndex(widgetSourceId, relationships);

  for (const ref of crossFields) {
    const rel = relIndex.get(ref.sourceId);
    if (!rel) {
      continue;
    }
    const relatedRows = dataSources[ref.sourceId]?.rows as Row[] | undefined;
    if (!relatedRows) {
      continue;
    }
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
): Row[] {
  if (!widgetSourceId || !columns?.length) {
    return rows;
  }

  const fieldRefs: CrossSourceFieldRef[] = columns.flatMap((c) =>
    c.sourceId && c.sourceId !== widgetSourceId
      ? [{ fieldId: c.fieldId, sourceId: c.sourceId }]
      : [],
  );

  return enrichWithCrossSourceFields(rows, widgetSourceId, fieldRefs, dataSources, relationships);
}
