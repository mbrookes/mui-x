import type { StudioDataSource, StudioGridColumn, StudioRelationship } from '../models';

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

  // Pre-build relationship index: targetId → relationship (many-to-one from widgetSourceId)
  const relIndex = new Map<string, (typeof relationships)[number]>();
  for (const r of relationships) {
    if (r.type === 'many-to-one' && r.sourceId === widgetSourceId) {
      relIndex.set(r.targetId, r);
    }
  }

  for (const ref of crossFields) {
    const rel = relIndex.get(ref.sourceId);
    if (!rel) {
      continue;
    }
    const relatedRows = dataSources[ref.sourceId]?.rows as Row[] | undefined;
    if (!relatedRows) {
      continue;
    }
    const relatedIndex = new Map<string, Row>(
      relatedRows.map((r) => [String(r[rel.targetField] ?? ''), r]),
    );
    colMeta.push({ fieldId: ref.fieldId, fkField: rel.sourceField, relatedIndex });
  }

  if (colMeta.length === 0) {
    return rows;
  }

  return rows.map((row) => {
    let enriched: Row | null = null;
    for (const { fieldId, fkField, relatedIndex } of colMeta) {
      const fkValue = String(row[fkField] ?? '');
      const relatedRow = relatedIndex.get(fkValue);
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
