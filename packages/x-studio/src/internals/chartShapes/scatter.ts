import { coerceAggregateValue } from '../aggregate';
import { emptyBucketLabel } from '../chartValues';
import type { StudioLocaleText } from '../localeText';

type Row = Record<string, unknown>;

export interface ScatterDataPoint {
  x: number;
  y: number;
  id: number;
  sizeValue?: number;
}

/**
 * Builds one scatter point from a row, or `null` when the row has no plottable
 * coordinate — i.e. either axis value is null/undefined/empty/non-numeric.
 *
 * Such a row must be DROPPED, not defaulted to the origin. `Number(row[field] ?? 0)`
 * fabricated a real data point at 0: a "Revenue vs Cost" scatter with 30% null costs
 * rendered a solid vertical stack on `y = 0`, distorting the very correlation the chart
 * exists to show, and a `'N/A'` cell passed a raw `NaN` straight into `@mui/x-charts`
 * (M13). Dropping matches every other chart family, which discards empty x values via
 * `isEmptyXValue` — a disagreement `chartShapes/heatmap.ts` already called out by name
 * (T3.2b) and fixed on its side.
 *
 * `sizeValue` deliberately still falls back to 0 rather than dropping the point: a
 * missing bubble size is a missing *decoration*, and the x/y coordinate it carries is
 * real data that must stay on the plot. It routes through `coerceAggregateValue` too, so
 * a non-numeric size yields 0 instead of a `NaN` radius.
 */
function toScatterPoint(
  row: Row,
  index: number,
  xField: string,
  yField: string,
  sizeField?: string,
): ScatterDataPoint | null {
  const x = coerceAggregateValue(row[xField]);
  const y = coerceAggregateValue(row[yField]);
  if (x === null || y === null) {
    return null;
  }
  return {
    x,
    y,
    id: index,
    sizeValue: sizeField != null ? (coerceAggregateValue(row[sizeField]) ?? 0) : undefined,
  };
}

/**
 * Prepare data for scatter charts.
 *
 * Rows without a plottable x/y coordinate are dropped (see {@link toScatterPoint}); the
 * surviving points keep their ORIGINAL row index as `id`, so ids stay traceable back to
 * `rows` and are simply non-contiguous where rows were skipped.
 */
export function prepareScatterData(
  rows: Row[],
  xField: string,
  yField: string,
  sizeField?: string,
): ScatterDataPoint[] {
  return rows.flatMap((row, index) => {
    const point = toScatterPoint(row, index, xField, yField, sizeField);
    return point ? [point] : [];
  });
}

export interface ScatterSeriesData {
  id: string;
  label: string;
  data: ScatterDataPoint[];
}

/**
 * Prepare data for scatter charts with a color-by categorical field.
 * Returns one series per unique category value for color-coded rendering.
 * Uses `stableCategories` (from all/unfiltered rows) to ensure consistent
 * color assignment even when some categories disappear after filtering.
 */
export function prepareScatterDataGrouped(
  rows: Row[],
  xField: string,
  yField: string,
  colorField: string,
  stableCategories: string[],
  sizeField?: string,
  /**
   * Locale text bundle used to resolve the translated empty-category bucket label
   * (`chartEmptyCategoryLabel`) for a null/blank `colorField` value — mirrors how the
   * x-axis empty bucket is resolved elsewhere (`toXValue`/`isEmptyXValue`) instead of
   * hardcoding the English `'(blank)'` literal (finding 4).
   */
  localeText?: Partial<StudioLocaleText>,
): ScatterSeriesData[] {
  // Build a map from category → points for the current (filtered) rows
  const grouped = new Map<string, ScatterDataPoint[]>(stableCategories.map((cat) => [cat, []]));
  rows.forEach((row, index) => {
    // Same drop-don't-fabricate rule as the ungrouped path (M13) — applied BEFORE the
    // category is registered, so a category whose every row lacks a coordinate produces
    // no empty series rather than a stack of points at the origin.
    const point = toScatterPoint(row, index, xField, yField, sizeField);
    if (!point) {
      return;
    }
    const raw = row[colorField];
    const cat = raw == null || raw === '' ? emptyBucketLabel(localeText) : String(raw);
    if (!grouped.has(cat)) {
      grouped.set(cat, []);
    }
    grouped.get(cat)!.push(point);
  });
  // Only include categories that have data (skip empty series)
  return stableCategories.flatMap((cat) => {
    const data = grouped.get(cat) ?? [];
    return data.length > 0 ? [{ id: cat, label: cat, data }] : [];
  });
}

/**
 * Assigns a stable color to each category, keyed by category identity rather than
 * array position.
 *
 * Used to pin matching colors on a color-by scatter's ghost (baseline) and
 * highlighted (filtered) series lists. Those two lists can have different
 * lengths/orders — a category present in the unfiltered baseline may have no
 * points (and therefore no series) in the current filtered set — so assigning
 * colors positionally (`colors[seriesIndex]`) would skew every subsequent
 * category's color and make a category's ghost render a different color than its
 * highlighted series.
 *
 * `categories` should be given in a stable, filter-independent order (e.g. the
 * baseline/unfiltered category list) so a category's color never shifts as the
 * filtered set changes.
 */
export function buildScatterCategoryColorMap(
  categories: string[],
  colors: string[],
): Map<string, string> {
  const map = new Map<string, string>();
  if (colors.length === 0) {
    return map;
  }
  categories.forEach((cat, index) => {
    map.set(cat, colors[index % colors.length]);
  });
  return map;
}
