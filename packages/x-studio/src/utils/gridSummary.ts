import type { StudioDataField, StudioGridSummaryAggregation } from '../models/studio';
import { formatFieldValue } from '../internals/numberFormat';

export interface GridSummaryConfig {
  /** Map of fieldId → aggregation function. Only listed fields get a summary cell. */
  fields: Record<string, StudioGridSummaryAggregation>;
}

/**
 * Compute summary (totals) values for a set of rows.
 *
 * Returns a plain record mapping fieldId → formatted display string.
 * Fields not listed in `config.fields` are omitted from the result.
 * Numeric-only aggregations (sum, avg, min, max) applied to non-number fields
 * fall back to count.
 */
export function computeGridSummary(
  rows: Record<string, unknown>[],
  fields: StudioDataField[],
  config: GridSummaryConfig,
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [fieldId, aggregation] of Object.entries(config.fields)) {
    const fieldDef = fields.find((f) => f.id === fieldId);
    const isNumeric = fieldDef?.type === 'number';

    // For non-numeric fields, numeric aggregations aren't meaningful — fall back to count.
    const effectiveAgg: StudioGridSummaryAggregation =
      !isNumeric && aggregation !== 'count' ? 'count' : aggregation;

    const numericValues = rows
      .map((row) => row[fieldId])
      .filter((v): v is number => typeof v === 'number' && !Number.isNaN(v));

    let raw: number;

    switch (effectiveAgg) {
      case 'count':
        raw = rows.length;
        break;
      case 'sum':
        raw = numericValues.reduce((acc, v) => acc + v, 0);
        break;
      case 'avg':
        raw =
          numericValues.length > 0
            ? numericValues.reduce((a, v) => a + v, 0) / numericValues.length
            : 0;
        break;
      case 'min':
        raw = numericValues.length > 0 ? Math.min(...numericValues) : 0;
        break;
      case 'max':
        raw = numericValues.length > 0 ? Math.max(...numericValues) : 0;
        break;
      default:
        raw = 0;
    }

    const label = aggregationLabel(effectiveAgg);

    if (effectiveAgg === 'count') {
      result[fieldId] = `${label} ${raw.toLocaleString()}`;
    } else {
      const formatted = formatFieldValue(raw, fieldDef);
      result[fieldId] = `${label} ${formatted}`;
    }
  }

  return result;
}

/** Short prefix label shown before the computed value in a summary cell. */
export function aggregationLabel(agg: StudioGridSummaryAggregation): string {
  switch (agg) {
    case 'sum':
      return 'Total:';
    case 'avg':
      return 'Avg:';
    case 'count':
      return 'Count:';
    case 'min':
      return 'Min:';
    case 'max':
      return 'Max:';
    default:
      return '';
  }
}
