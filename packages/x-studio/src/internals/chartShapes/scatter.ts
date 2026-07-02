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
): ScatterSeriesData[] {
  // Build a map from category → points for the current (filtered) rows
  const grouped = new Map<string, ScatterDataPoint[]>(stableCategories.map((cat) => [cat, []]));
  rows.forEach((row, index) => {
    const raw = row[colorField];
    const cat = raw == null || raw === '' ? '(blank)' : String(raw);
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
