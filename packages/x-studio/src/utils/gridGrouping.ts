import type {
  StudioDataSource,
  StudioGridColumn,
  StudioGridSummaryAggregation,
  StudioRelationship,
} from '../models/studio';

function aggregateGridValue(
  rows: Record<string, unknown>[],
  fieldId: string,
  aggregation: StudioGridSummaryAggregation,
) {
  if (aggregation === 'count') {
    return rows.length;
  }

  if (aggregation === 'count_distinct') {
    const seen = new Set(rows.map((row) => row[fieldId]).filter((v) => v != null));
    return seen.size;
  }

  const numericValues = rows
    .map((row) => row[fieldId])
    .filter((value): value is number => typeof value === 'number' && !Number.isNaN(value));

  switch (aggregation) {
    case 'sum':
      return numericValues.reduce((total, value) => total + value, 0);
    case 'avg':
      return numericValues.length > 0
        ? numericValues.reduce((total, value) => total + value, 0) / numericValues.length
        : 0;
    case 'min':
      return numericValues.length > 0 ? Math.min(...numericValues) : null;
    case 'max':
      return numericValues.length > 0 ? Math.max(...numericValues) : null;
    default:
      return null;
  }
}

/**
 * Symmetric aggregate — avoids fan-out double-counting when a cross-source field
 * is duplicated across related rows.
 *
 * For a many-to-one column (e.g. orders.total on an order-items grouping), each
 * unique FK value contributes exactly once. The FK field is read from the
 * widget-source rows and deduplicated; then the related-source row map is used
 * to look up the actual value for aggregation.
 *
 * Falls back to `aggregateGridValue` for same-source fields.
 */
function symmetricAggregate(
  groupRows: Record<string, unknown>[],
  fkField: string,
  relatedRowMap: Map<string, Record<string, unknown>>,
  valueField: string,
  fn: StudioGridSummaryAggregation,
): number | null {
  const seenFks = new Set<string>();
  const deduped: Record<string, unknown>[] = [];

  for (const row of groupRows) {
    const fkValue = String(row[fkField] ?? '');
    if (!seenFks.has(fkValue)) {
      seenFks.add(fkValue);
      const relatedRow = relatedRowMap.get(fkValue);
      if (relatedRow) {
        deduped.push(relatedRow);
      }
    }
  }

  return aggregateGridValue(deduped, valueField, fn);
}

export function buildGroupedGridRows(
  rows: Record<string, unknown>[],
  groupByField: string,
  visibleFields: string[],
  aggregations: Record<string, StudioGridSummaryAggregation>,
  widgetId: string,
  /** Optional: full column definitions for cross-source aggregation. */
  columns?: StudioGridColumn[],
  /** Optional: all data sources keyed by ID (needed for cross-source columns). */
  dataSources?: Record<string, StudioDataSource>,
  /** Optional: declared relationships for fan-out detection. */
  relationships?: StudioRelationship[],
  /** Optional: the widget's primary source ID. */
  widgetSourceId?: string,
) {
  // Build per-column cross-source context once (before grouping loop)
  const crossSourceMeta = new Map<
    string,
    { fkField: string; relatedRowMap: Map<string, Record<string, unknown>> }
  >();

  if (columns && dataSources && relationships && widgetSourceId) {
    for (const col of columns) {
      if (!col.sourceId || col.sourceId === widgetSourceId) {
        continue;
      }
      // Find a many-to-one relationship from widgetSourceId → col.sourceId
      const rel = relationships.find(
        (r) =>
          r.type === 'many-to-one' &&
          r.sourceId === widgetSourceId &&
          r.targetId === col.sourceId,
      );
      if (!rel) {
        continue;
      }
      const relatedSource = dataSources[col.sourceId];
      if (!relatedSource?.rows) {
        continue;
      }
      // Index related rows by their PK for fast look-up
      const pkField = rel.targetField;
      const relatedRowMap = new Map<string, Record<string, unknown>>(
        (relatedSource.rows as Record<string, unknown>[]).map((r) => [String(r[pkField] ?? ''), r]),
      );
      crossSourceMeta.set(col.fieldId, { fkField: rel.sourceField, relatedRowMap });
    }
  }

  const groups = new Map<string, Record<string, unknown>[]>();

  rows.forEach((row) => {
    const key = String(row[groupByField] ?? '');
    const existing = groups.get(key);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(key, [row]);
    }
  });

  return Array.from(groups.entries()).map(([groupKey, groupRows], index) => {
    const firstRow = groupRows[0] ?? {};
    const groupedRow: Record<string, unknown> = {
      __rowId: `group-${widgetId}-${index}`,
      [groupByField]: firstRow[groupByField] ?? groupKey,
    };

    visibleFields.forEach((fieldId) => {
      if (fieldId === groupByField) {
        groupedRow[fieldId] = firstRow[fieldId] ?? groupKey;
        return;
      }

      const aggregation = aggregations[fieldId];

      const crossSource = crossSourceMeta.get(fieldId);
      if (crossSource && aggregation) {
        groupedRow[fieldId] = symmetricAggregate(
          groupRows,
          crossSource.fkField,
          crossSource.relatedRowMap,
          fieldId,
          aggregation,
        );
        return;
      }

      if (aggregation) {
        groupedRow[fieldId] = aggregateGridValue(groupRows, fieldId, aggregation);
        return;
      }

      groupedRow[fieldId] = firstRow[fieldId] ?? null;
    });

    return groupedRow;
  });
}
