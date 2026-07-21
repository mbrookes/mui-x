import { ensureRowIdentity } from '../rowIdentity';

type Row = Record<string, unknown>;

/** One bar in a Gantt / timeline chart. */
export interface GanttItem {
  /**
   * Stable per-row identity token (see `rowIdentity.ts`), used as the React key when
   * rendering bars. Two rows with the same label and start time are a legitimate case (e.g.
   * two tasks named identically starting the same day) — keying on `label`/`startMs` alone
   * collided in that case, and on a cross-filter-driven list change the reconciler could pair
   * the wrong row's bar/tooltip state to the wrong DOM node (finding 15). `ensureRowIdentity`
   * survives the row-cloning the pipeline does (object spread), so the id stays stable across
   * re-renders of the same logical row even though the row object reference is fresh.
   */
  id: number;
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
    items.push({ id: ensureRowIdentity(row), label, startMs, endMs, colorCategory });
  }

  return { items, categories: [...categorySet] };
}
