import type { StudioDataField, StudioGridSummaryAggregation } from '../models';
import { formatFieldValue } from '../internals/numberFormat';
import {
  DEFAULT_STUDIO_LOCALE_TEXT,
  type StudioLocaleText,
} from '../internals/StudioUIConfigContext';

interface GridSummaryConfig {
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
  localeText: StudioLocaleText = DEFAULT_STUDIO_LOCALE_TEXT,
): Record<string, string> {
  const result: Record<string, string> = {};

  const fieldIndex = new Map(fields.map((f) => [f.id, f]));

  for (const [fieldId, aggregation] of Object.entries(config.fields)) {
    const fieldDef = fieldIndex.get(fieldId);
    const isNumeric = fieldDef?.type === 'number';

    // For non-numeric fields, numeric aggregations aren't meaningful — fall back to count.
    // count_distinct is meaningful for any field type so it is exempt from the fallback.
    const effectiveAgg: StudioGridSummaryAggregation =
      !isNumeric && aggregation !== 'count' && aggregation !== 'count_distinct'
        ? 'count'
        : aggregation;

    const numericValues = rows
      .map((row) => row[fieldId])
      .filter((v): v is number => typeof v === 'number' && !Number.isNaN(v));

    let raw: number | null;

    switch (effectiveAgg) {
      case 'count':
        raw = rows.length;
        break;
      case 'count_distinct': {
        const seen = new Set(rows.map((row) => row[fieldId]).filter((v) => v != null));
        raw = seen.size;
        break;
      }
      case 'sum':
        raw = numericValues.reduce((acc, v) => acc + v, 0);
        break;
      case 'avg':
        // Exclude nulls from denominator — matches gridGrouping and KPI behaviour.
        raw =
          numericValues.length > 0
            ? numericValues.reduce((a, v) => a + v, 0) / numericValues.length
            : null;
        break;
      case 'min':
        raw = numericValues.length > 0 ? numericValues.reduce((a, v) => (v < a ? v : a)) : null;
        break;
      case 'max':
        raw = numericValues.length > 0 ? numericValues.reduce((a, v) => (v > a ? v : a)) : null;
        break;
      default:
        raw = null;
    }

    // When there are no numeric values, omit the summary cell rather than show a misleading zero.
    if (raw === null) {
      continue;
    }

    const label = aggregationLabel(effectiveAgg, localeText);

    if (effectiveAgg === 'count' || effectiveAgg === 'count_distinct') {
      result[fieldId] = `${label} ${raw.toLocaleString()}`;
    } else {
      const formatted = formatFieldValue(raw, fieldDef);
      result[fieldId] = `${label} ${formatted}`;
    }
  }

  return result;
}

/** Short prefix label shown before the computed value in a summary cell. */
export function aggregationLabel(
  agg: StudioGridSummaryAggregation,
  localeText: StudioLocaleText = DEFAULT_STUDIO_LOCALE_TEXT,
): string {
  switch (agg) {
    case 'sum':
      return localeText.gridSummaryLabelSum;
    case 'avg':
      return localeText.gridSummaryLabelAvg;
    case 'count':
      return localeText.gridSummaryLabelCount;
    case 'count_distinct':
      return localeText.gridSummaryLabelCountDistinct;
    case 'min':
      return localeText.gridSummaryLabelMin;
    case 'max':
      return localeText.gridSummaryLabelMax;
    default:
      return '';
  }
}
