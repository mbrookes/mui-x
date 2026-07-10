import type { StudioDataField, StudioGridSummaryAggregation } from '../models';
import { formatFieldValue } from '../internals/numberFormat';
import {
  DEFAULT_STUDIO_LOCALE_TEXT,
  type StudioLocaleText,
} from '../internals/StudioUIConfigContext';
import { normalizeJoinKey } from '../internals/joinKeys';
import { aggregateValues } from './gridGrouping';

interface GridSummaryConfig {
  /** Map of fieldId → aggregation function. Only listed fields get a summary cell. */
  fields: Record<string, StudioGridSummaryAggregation>;
}

/**
 * Extract the value list to aggregate for one summary field.
 *
 * For a plain (own-source or expression) column this is simply `row[fieldId]` for every
 * row. For a fanned-out cross-source column (a many-to-one joined column whose value is
 * duplicated onto every widget row sharing the same FK — see `useWidgetRows.ts`'s
 * `enrichWithCrossSourceFields`), the footer must dedupe by FK first, otherwise summing
 * counts each linked one-side record once per many-side row — exactly the double-count the
 * grid's *group* totals already avoid via `makeFanoutSafeAggregationFunction` /
 * `symmetricAggregate` (architecture review finding 1.2). A missing/unlinked FK
 * (null/undefined) never joins and contributes nothing, matching those paths.
 */
function extractSummaryValues(
  rows: Record<string, unknown>[],
  fieldId: string,
  fkField: string | undefined,
): unknown[] {
  if (!fkField) {
    return rows.map((row) => row[fieldId]);
  }
  const seenFks = new Set<string>();
  const values: unknown[] = [];
  for (const row of rows) {
    const key = normalizeJoinKey(row[fkField]);
    if (key === null || seenFks.has(key)) {
      continue;
    }
    seenFks.add(key);
    values.push(row[fieldId]);
  }
  return values;
}

/**
 * Compute summary (totals) values for a set of rows.
 *
 * Returns a plain record mapping fieldId → formatted display string.
 * Fields not listed in `config.fields` are omitted from the result.
 * Numeric-only aggregations (sum, avg, min, max) applied to non-number fields
 * fall back to count.
 *
 * `fields` must resolve every configured summary field — including cross-source and
 * expression-field columns (the caller folds `crossSourceFieldDefs` and the widget's own
 * expression fields into this list). A missing field def resolves as non-numeric and
 * silently degrades a `sum`/`avg`/`min`/`max` to `count` (finding 1.2), so the field-def
 * resolution must happen upstream.
 *
 * `crossSourceFkFields` maps a fanned-out cross-source column's field id to its FK field
 * on the widget's own rows; those columns are FK-deduped before reducing (finding 1.2),
 * reusing the same value reducer (`gridGrouping.ts`'s `aggregateValues`) the group-by and
 * native-aggregation paths use, so the footer agrees with the grouped view of the column.
 */
export function computeGridSummary(
  rows: Record<string, unknown>[],
  fields: StudioDataField[],
  config: GridSummaryConfig,
  localeText: StudioLocaleText = DEFAULT_STUDIO_LOCALE_TEXT,
  crossSourceFkFields?: Map<string, string>,
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

    // FK-dedup a fanned-out cross-source column before reducing (finding 1.2); a plain
    // column reads one value per row. The shared reducer applies the null-skip +
    // boolean/numeric-string coercion (finding 2.13) and distinct-count policy (2.23), so
    // the footer agrees with KPI/Chart/Pivot and with the grouped view of this column.
    const values = extractSummaryValues(rows, fieldId, crossSourceFkFields?.get(fieldId));

    const raw = aggregateValues(values, effectiveAgg);

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
