import type { StudioDataField, StudioGridColumn, StudioGridSummaryAggregation } from '../models';
import { formatFieldValue } from '../internals/numberFormat';
import {
  DEFAULT_STUDIO_LOCALE_TEXT,
  type StudioLocaleText,
} from '../internals/StudioUIConfigContext';
import { normalizeJoinKey } from '../internals/joinKeys';
import { getStudioLocale } from '../internals/studioLocale';
import { aggregateValues } from './gridGrouping';

interface GridSummaryConfig {
  /** Map of fieldId → aggregation function. Only listed fields get a summary cell. */
  fields: Record<string, StudioGridSummaryAggregation>;
}

/**
 * Composite key identifying one configured grid column in the
 * `config.gridSummaryFields`/`config.gridAggregations` maps: bare `fieldId` for a
 * primary-source column, `sourceId/fieldId` for a cross-source one.
 *
 * Keying those maps by bare `fieldId` alone made a related-source column whose field id
 * happens to match a primary column's (e.g. both sources have a `total`) share the exact
 * same entry, so configuring one column's aggregation silently overwrote the other's
 * (architecture review: per-column aggregation collision).
 *
 * Lives here — not in `GridSetupPanel` (the producer) nor `StudioGridWidget` (the
 * consumer) — so both sides derive the key with the SAME function instead of one of them
 * re-deriving it by string surgery (`key.slice(key.indexOf('/') + 1)`), which silently
 * mangled a field id that legitimately contains a slash (a `P/L` column resolved to a
 * bare `L`) and re-introduced the very collision the composite key was added to fix.
 */
export function columnAggKey(col: Pick<StudioGridColumn, 'fieldId' | 'sourceId'>): string {
  return col.sourceId ? `${col.sourceId}/${col.fieldId}` : col.fieldId;
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
 * silently degrades a `sum`/`avg`/`min`/`max` to `count`, so the field-def
 * resolution must happen upstream.
 *
 * `crossSourceFkFields` maps a fanned-out cross-source column's field id to its FK field
 * on the widget's own rows; those columns are FK-deduped before reducing,
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
  // Collected in a Map, not a plain object literal: `config.fields`' keys are
  // doc-/AI-authored, and `result['__proto__'] = …` on an object literal mutates the
  // prototype instead of creating an own property. `Object.fromEntries` always creates
  // own data properties, so the returned record stays a plain value map.
  const result = new Map<string, string>();

  const fieldIndex = new Map(fields.map((f) => [f.id, f]));

  for (const [fieldId, aggregation] of Object.entries(config.fields)) {
    const fieldDef = fieldIndex.get(fieldId);
    const isNumeric = fieldDef?.type === 'number';

    // For non-numeric fields, numeric aggregations aren't meaningful — fall back to count.
    // All THREE counts are meaningful for any field type (each reads the raw cell, never the
    // numeric coercion sum/avg/min/max apply), so each is exempt from the fallback. Letting
    // `count_non_null` fall through would silently answer a DIFFERENT question than the user
    // asked — "how many rows" instead of "how many have a value" — on exactly the string
    // columns where the two most often differ.
    const effectiveAgg: StudioGridSummaryAggregation =
      !isNumeric && !isCountAggregation(aggregation) ? 'count' : aggregation;

    // FK-dedup a fanned-out cross-source column before reducing; a plain
    // column reads one value per row. The shared reducer applies the null-skip +
    // boolean/numeric-string coercion and distinct-count policy (2.23), so
    // the footer agrees with KPI/Chart/Pivot and with the grouped view of this column.
    const values = extractSummaryValues(rows, fieldId, crossSourceFkFields?.get(fieldId));

    const raw = aggregateValues(values, effectiveAgg);

    // When there are no numeric values, omit the summary cell rather than show a misleading zero.
    if (raw === null) {
      continue;
    }

    const label = aggregationLabel(effectiveAgg, localeText);

    // A count is a tally of rows/values, not a quantity of the column's unit, so it must not
    // be run through the field's currency/percent formatter.
    if (isCountAggregation(effectiveAgg)) {
      result.set(fieldId, `${label} ${raw.toLocaleString(getStudioLocale())}`);
    } else {
      const formatted = formatFieldValue(raw, fieldDef);
      result.set(fieldId, `${label} ${formatted}`);
    }
  }

  return Object.fromEntries(result);
}

/**
 * True for the three count aggregations — `count` (`COUNT(*)`), `count_non_null`
 * (`COUNT(column)`) and `count_distinct` (`COUNT(DISTINCT column)`).
 *
 * They share two behaviours this module needs in different places, and keeping the membership
 * test in ONE place is what stops the two lists drifting (they already did once: adding
 * `count_non_null` to only the formatting check would have left it falling back to `count` on a
 * string column, answering a different question than the one asked). Both callers below use it:
 * counts are exempt from the non-numeric fallback, and counts are rendered unformatted.
 */
function isCountAggregation(
  agg: StudioGridSummaryAggregation,
): agg is 'count' | 'count_non_null' | 'count_distinct' {
  return agg === 'count' || agg === 'count_non_null' || agg === 'count_distinct';
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
    case 'count_non_null':
      return localeText.gridSummaryLabelCountValues;
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
