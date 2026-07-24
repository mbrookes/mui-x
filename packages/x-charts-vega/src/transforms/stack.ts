import type { DatasetRow, VegaStackTransform } from '../types';
import type { GapCollector } from '../gaps';
import { groupRows } from './groupBy';

/*
 * OWNERSHIP: the "transforms" work unit owns this file.
 *
 * The explicit `stack` transform (distinct from a stacked mark/encoding,
 * which x-charts series handle natively via `stack`/`stackOffset` — see
 * marks/bar.ts and marks/lineArea.ts): groups rows by `groupby`, orders each
 * group by `sort` (default: input row order), and writes a running
 * `[start, end]` interval per row into the `as` fields — the same shape a
 * `d.stack()` layout computes, but over one flat row set rather than a
 * per-series matrix.
 */

type SortSpec = ReadonlyArray<{ field: string; order?: 'ascending' | 'descending' }>;

/** Sort rank for a raw value: 0 = null/undefined (sorts first), 1 = everything else. */
function sortRank(value: unknown): 0 | 1 {
  return value == null ? 0 : 1;
}

/**
 * Stable comparator over the `sort` spec: null/undefined first, then
 * number/Date compared numerically, everything else lexicographically.
 * `order: 'descending'` negates the whole per-field comparison (including
 * the null-first placement). A duplicate of `window.ts`'s own copy — each
 * transform file keeps its own to respect file ownership boundaries.
 */
function compareBySort(a: DatasetRow, b: DatasetRow, sort: SortSpec): number {
  for (const { field, order } of sort) {
    const valueA = a[field];
    const valueB = b[field];
    const rankA = sortRank(valueA);
    const rankB = sortRank(valueB);
    let cmp: number;
    if (rankA !== rankB) {
      cmp = rankA - rankB;
    } else if (rankA === 0) {
      cmp = 0;
    } else if (
      (typeof valueA === 'number' || valueA instanceof Date) &&
      (typeof valueB === 'number' || valueB instanceof Date)
    ) {
      const numA = valueA instanceof Date ? valueA.getTime() : (valueA as number);
      const numB = valueB instanceof Date ? valueB.getTime() : (valueB as number);
      cmp = numA - numB;
    } else {
      cmp = String(valueA).localeCompare(String(valueB));
    }
    if (cmp !== 0) {
      return order === 'descending' ? -cmp : cmp;
    }
  }
  return 0;
}

export function applyStackTransform(
  rows: readonly DatasetRow[],
  transform: VegaStackTransform,
  gaps: GapCollector,
  path: string,
): readonly DatasetRow[] {
  const asStart = Array.isArray(transform.as) ? transform.as[0] : transform.as;
  if (typeof transform.stack !== 'string' || !asStart) {
    gaps.add({
      code: 'transform:stack',
      message:
        'A `stack` transform needs a `stack` field and an `as` output name (string or [start, end] pair); this one is missing one or the other, so it was skipped and downstream values may be wrong.',
      severity: 'unsupported',
      path,
    });
    return rows;
  }
  const asEnd = Array.isArray(transform.as) ? transform.as[1] : `${asStart}_end`;
  const groupby = transform.groupby ?? [];
  const sort: SortSpec = transform.sort ?? [];
  const groups = groupRows(rows, groupby);

  // Maps each original row (by reference) to its computed [start, end], so
  // the final pass can rebuild output rows in the caller's original
  // order/positions without re-deriving group keys or sort order.
  const stackedByRow = new Map<DatasetRow, [number, number]>();
  for (const group of groups.values()) {
    const ordered =
      sort.length > 0 ? [...group.rows].sort((a, b) => compareBySort(a, b, sort)) : group.rows;
    // Vega-Lite's default ("zero") offset stacks nonnegative and negative
    // values separately (a diverging stack: negatives grow downward from 0,
    // positives upward), matching d3's stackOffsetDiverging.
    let runningPos = 0;
    let runningNeg = 0;
    const rawIntervals: Array<[number, number]> = [];
    for (const row of ordered) {
      const raw = Number(row[transform.stack]);
      const value = Number.isFinite(raw) ? raw : 0;
      if (value < 0) {
        rawIntervals.push([runningNeg, runningNeg + value]);
        runningNeg += value;
      } else {
        rawIntervals.push([runningPos, runningPos + value]);
        runningPos += value;
      }
    }
    let intervals = rawIntervals;
    if (transform.offset === 'normalize') {
      const totalAbs = runningPos - runningNeg;
      if (totalAbs > 0) {
        intervals = rawIntervals.map(([start, end]) => [start / totalAbs, end / totalAbs]);
      }
    } else if (transform.offset === 'center') {
      const total = runningPos + runningNeg;
      const shift = total / 2;
      intervals = rawIntervals.map(([start, end]) => [start - shift, end - shift]);
    }
    ordered.forEach((row, index) => {
      stackedByRow.set(row, intervals[index]);
    });
  }

  return rows.map((row) => {
    const interval = stackedByRow.get(row);
    return interval ? { ...row, [asStart]: interval[0], [asEnd]: interval[1] } : row;
  });
}
