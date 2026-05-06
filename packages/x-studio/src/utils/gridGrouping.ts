import type { StudioGridSummaryAggregation } from '../models/studio';

function aggregateGridValue(
  rows: Record<string, unknown>[],
  fieldId: string,
  aggregation: StudioGridSummaryAggregation,
) {
  if (aggregation === 'count') {
    return rows.length;
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

export function buildGroupedGridRows(
  rows: Record<string, unknown>[],
  groupByField: string,
  visibleFields: string[],
  aggregations: Record<string, StudioGridSummaryAggregation>,
  widgetId: string,
) {
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
      if (aggregation) {
        groupedRow[fieldId] = aggregateGridValue(groupRows, fieldId, aggregation);
        return;
      }

      groupedRow[fieldId] = firstRow[fieldId] ?? null;
    });

    return groupedRow;
  });
}
