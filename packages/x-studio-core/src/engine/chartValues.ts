import { truncateToGranularity, type XGroupBy } from './temporalUtils';
import { DEFAULT_STUDIO_LOCALE_TEXT, type StudioLocaleText } from './localeText';

/**
 * Small row-value helpers shared by the generic aggregators (`aggregators.ts`) and
 * the chart-type-specific prep (`chartShapes/`). Kept in a dedicated module so both
 * can depend on them without importing each other, and so they stay off the public
 * chart-aggregation surface (this module is not re-exported by `chartAggregation.ts`).
 */

/**
 * Apply xGroupBy truncation to an x-axis value.
 * Returns the original value when xGroupBy is not set or the value is not date-like.
 */
export function applyXGroupBy(
  value: string | number,
  xGroupBy: XGroupBy | undefined,
): string | number {
  if (!xGroupBy) {
    return value;
  }
  return truncateToGranularity(value, xGroupBy) ?? value;
}

/**
 * The bucket label used for a null/undefined x-axis value. Falls back to the
 * English default when `localeText` (or the key) isn't supplied, so existing
 * callers that don't thread a locale through keep their current behavior.
 *
 * Exported so other chart-type-specific prep (e.g. `chartShapes/scatter.ts`'s
 * color-by-field empty bucket) can reuse the same configurable label instead of
 * hardcoding an English literal.
 */
export function emptyBucketLabel(localeText?: Partial<StudioLocaleText>): string {
  return localeText?.chartEmptyCategoryLabel ?? DEFAULT_STUDIO_LOCALE_TEXT.chartEmptyCategoryLabel;
}

/**
 * Safely extracts a row field value as a string or number suitable for chart grouping.
 *
 * Its `null`/`undefined` → {@link emptyBucketLabel} branch is reachable only from a **split**
 * dimension — `aggregateByTwoFields`' `seriesField` and `chartShapes/scatter`'s color field.
 * Every **axis/category** call site (`aggregators.ts`' three x loops, `chartShapes/heatmap`,
 * `StudioPieChart`) drops the row via {@link isEmptyXValue} first, so an empty x value never
 * reaches this function. That asymmetry is the package's deliberate policy, not an oversight —
 * see {@link isEmptyXValue}.
 */
export function toXValue(raw: unknown, localeText?: Partial<StudioLocaleText>): string | number {
  if (raw instanceof Date) {
    return raw.toISOString();
  }
  if (typeof raw === 'boolean') {
    return String(raw);
  }
  if (raw === null || raw === undefined) {
    return emptyBucketLabel(localeText);
  }
  if (typeof raw === 'object') {
    return String(raw);
  }
  return raw as string | number;
}

/**
 * Whether a RAW row value should be dropped from a chart's x axis: `null`, `undefined`
 * or the empty string.
 *
 * **The package-wide null policy, stated once here because it differs per dimension:**
 *
 * - **Axis / category dimension → the row is DROPPED.** Applied uniformly by
 * `aggregateByField`, `aggregateByTwoFields`, `aggregateMultipleSeries`,
 * `chartShapes/heatmap.aggregateHeatmap`, `chartShapes/scatter` (either coordinate) and
 * `StudioPieChart`'s inner ring. A category axis answers "how does the measure break down ACROSS
 * this dimension"; a row with no value for it has no position on that breakdown, and fabricating
 * one (an `(empty)` bar, a scatter point at the origin) invents a data point the source never
 * contained. Two earlier fixes converged on this deliberately rather than by accident: heatmap was
 * changed to drop so it would stop disagreeing with bar/line over the same field, and scatter to
 * drop so null costs stopped stacking on `y = 0`.
 * - **Split / color dimension → the row is KEPT, under {@link emptyBucketLabel}.** A split
 *   partitions a category's rows; silently deleting the unlabelled partition would make the
 *   stacked bars at that category sum to less than the single-series bar for the same rows
 *  .
 *
 * The consequence to know when reading a dashboard: a chart's bars can sum to LESS than a KPI
 * counting the same rows, by exactly the number of rows whose x value is empty. That is the
 * accepted cost of the rule above — changing it is a cross-family behaviour change (six call
 * sites in four files), not a local edit to one aggregator.
 *
 * Because every axis call site runs this guard BEFORE `toXValue`, `toXValue`'s own empty-bucket
 * branch (and therefore the `localeText` those aggregators thread into it on the x path) can
 * never fire for an x value. The argument is kept so the guard-then-convert pair is spelled
 * identically at all six sites and the policy stays a one-line decision here.
 *
 * Deliberately does NOT treat the empty-bucket label (`emptyBucketLabel`) as empty, and therefore
 * takes no `localeText`. Every call site passes a raw row value, never an already-converted
 * `toXValue` output, so that clause could only ever fire as a FALSE POSITIVE: a `tickets.csv` whose
 * `assignee` column literally contains the string `(empty)` had those rows silently dropped from
 * "count by assignee" — the bars summed to less than the row count, with no indication anything was
 * missing — and a French dashboard did the same for `frLocaleText.chartEmptyCategoryLabel`. A real
 * category must never be deleted because it collides with a display label.
 */
export function isEmptyXValue(raw: unknown): boolean {
  return raw === null || raw === undefined || raw === '';
}
