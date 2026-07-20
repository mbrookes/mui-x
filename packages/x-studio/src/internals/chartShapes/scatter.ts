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
 * Prepare data for scatter charts
 */
export function prepareScatterData(
  rows: Row[],
  xField: string,
  yField: string,
  sizeField?: string,
): ScatterDataPoint[] {
  return rows.map((row, index) => ({
    x: Number(row[xField] ?? 0),
    y: Number(row[yField] ?? 0),
    id: index,
    sizeValue: sizeField != null ? Number(row[sizeField] ?? 0) : undefined,
  }));
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
    const raw = row[colorField];
    const cat = raw == null || raw === '' ? emptyBucketLabel(localeText) : String(raw);
    if (!grouped.has(cat)) {
      grouped.set(cat, []);
    }
    grouped.get(cat)!.push({
      x: Number(row[xField] ?? 0),
      y: Number(row[yField] ?? 0),
      id: index,
      sizeValue: sizeField != null ? Number(row[sizeField] ?? 0) : undefined,
    });
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
