import type {
  StudioDataSource,
  StudioGridColumn,
  StudioRelationship,
} from '../models';

type Row = Record<string, unknown>;

/**
 * Enriches `rows` with field values from many-to-one related sources.
 *
 * For each column that has `sourceId !== widgetSourceId` the function:
 *  1. Locates the many-to-one relationship from `widgetSourceId` → `col.sourceId`
 *  2. Builds a Map of related rows keyed by their PK (`rel.targetField`)
 *  3. Copies `col.fieldId` from the related row onto each primary row via FK lookup
 *
 * Columns whose related source has no in-memory rows (async sources) are silently
 * skipped — the field value stays `undefined` in the primary row.
 *
 * @param rows             Filtered primary-source rows
 * @param widgetSourceId   The widget's primary source ID
 * @param columns          The widget's StudioGridColumn config
 * @param dataSources      All data sources (keyed by ID)
 * @param relationships    Declared relationships
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

  const crossCols = columns.filter(
    (c) => c.sourceId && c.sourceId !== widgetSourceId,
  );

  if (crossCols.length === 0) {
    return rows;
  }

  // Group by relatedSourceId to build each index only once
  type ColMeta = {
    fieldId: string;
    fkField: string; // field on primary rows
    relatedIndex: Map<string, Row>;
  };

  const colMeta: ColMeta[] = [];

  for (const col of crossCols) {
    const relatedSourceId = col.sourceId!;
    const rel = relationships.find(
      (r) =>
        r.type === 'many-to-one' &&
        r.sourceId === widgetSourceId &&
        r.targetId === relatedSourceId,
    );
    if (!rel) {
      continue;
    }
    const relatedRows = dataSources[relatedSourceId]?.rows as Row[] | undefined;
    if (!relatedRows) {
      // No in-memory rows — skip (async sources not yet supported for cross-source columns)
      continue;
    }
    const relatedIndex = new Map<string, Row>(
      relatedRows.map((r) => [String(r[rel.targetField] ?? ''), r]),
    );
    colMeta.push({ fieldId: col.fieldId, fkField: rel.sourceField, relatedIndex });
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
