type Row = Record<string, unknown>;

/** One bar in a Gantt / timeline chart. */
export interface GanttItem {
  label: string;
  startMs: number;
  endMs: number;
  /** Optional category value used for colour coding */
  colorCategory?: string;
}

/** Result of building Gantt bars from filtered rows. */
export interface GanttItemsResult {
  items: GanttItem[];
  /** Ordered list of unique category values seen — determines colour palette assignment. */
  categories: string[];
}

/**
 * Builds Gantt/timeline bars from filtered rows.
 *
 * Rows missing a label, start, or end value are skipped, as are rows whose
 * start/end don't parse to valid dates or where the end precedes the start
 * (a Gantt bar can never have negative duration).
 *
 * @param rows - Filtered rows to build bars from.
 * @param labelField - Field providing the row label (Y axis).
 * @param startField - Date/datetime field marking the start of each bar.
 * @param endField - Date/datetime field marking the end of each bar.
 * @param colorField - Optional categorical field used to colour-code bars.
 */
export function buildGanttItems(
  rows: Row[],
  labelField: string,
  startField: string,
  endField: string,
  colorField: string | undefined,
): GanttItemsResult {
  const items: GanttItem[] = [];
  const categorySet = new Set<string>();

  for (const row of rows) {
    const label = String(row[labelField] ?? '');
    const startRaw = row[startField];
    const endRaw = row[endField];
    if (!label || startRaw == null || endRaw == null) {
      continue;
    }
    const startMs = new Date(startRaw as string).getTime();
    const endMs = new Date(endRaw as string).getTime();
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) {
      continue;
    }
    const colorCategory = colorField ? String(row[colorField] ?? '') : undefined;
    if (colorCategory) {
      categorySet.add(colorCategory);
    }
    items.push({ label, startMs, endMs, colorCategory });
  }

  return { items, categories: [...categorySet] };
}
