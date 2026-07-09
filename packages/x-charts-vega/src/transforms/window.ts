import type { DatasetRow, VegaAggregateOp, VegaWindowTransform } from '../types';
import type { GapCollector } from '../gaps';
import { evaluateAggregate } from './aggregateOps';
import { groupRows } from './groupBy';

/*
 * OWNERSHIP: the "transforms" work unit owns this file.
 *
 * `window` computes running/ranking/offset values over sorted, partitioned
 * frames of rows, writing each `{op, field, param, as}` output onto every
 * row without changing row count.
 *
 * DEVIATION FROM VEGA-LITE: Vega-Lite's `window` transform is defined to
 * reorder rows into partition/sort order as a side effect (the sorted order
 * IS the output order). This wrapper instead computes over the
 * sorted/partitioned view internally but writes results back onto rows in
 * their ORIGINAL INPUT ORDER. This is deliberate: downstream x-charts series
 * are built from positional row index, and a pipeline step that doesn't
 * change row cardinality silently reordering rows would corrupt every OTHER
 * channel's row-index alignment (e.g. a `color` field read from the same
 * row). Values computed (ranks, running sums, lag/lead) are numerically
 * identical to Vega-Lite; only the row ORDER of the output differs.
 */

type SortSpec = ReadonlyArray<{ field: string; order?: 'ascending' | 'descending' }>;

const RANKING_OPS = new Set([
  'row_number',
  'rank',
  'dense_rank',
  'percent_rank',
  'cume_dist',
  'ntile',
]);
const OFFSET_OPS = new Set(['lag', 'lead']);
const VALUE_OPS = new Set(['first_value', 'last_value', 'nth_value']);
const AGGREGATE_OPS = new Set<string>([
  'count',
  'valid',
  'missing',
  'distinct',
  'sum',
  'product',
  'mean',
  'average',
  'variance',
  'variancep',
  'stdev',
  'stdevp',
  'stderr',
  'median',
  'q1',
  'q3',
  'ci0',
  'ci1',
  'min',
  'max',
  'argmin',
  'argmax',
]);

/** Sort rank for a raw value: 0 = null/undefined (sorts first), 1 = everything else. */
function sortRank(value: unknown): 0 | 1 {
  return value == null ? 0 : 1;
}

/**
 * Stable comparator over the `sort` spec: null/undefined first, then
 * number/Date compared numerically, everything else lexicographically.
 * `order: 'descending'` negates the whole per-field comparison (including
 * the null-first placement).
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

interface PeerInfo {
  /** Index of the first row sharing this row's sort key (RANGE frame start). */
  peerStart: number[];
  /** Index of the last row sharing this row's sort key (RANGE frame end). */
  peerEnd: number[];
  /** 0-based ordinal of this row's peer group, in sort order. */
  peerGroupIndex: number[];
}

/**
 * Computes maximal equal-sort-key runs ("peer groups") over an already
 * sorted partition. With no `sort` spec, each row is its own singleton peer
 * group (there is no shared key to compare by), matching plain input order.
 */
function computePeers(sortedRows: readonly DatasetRow[], sort: SortSpec): PeerInfo {
  const n = sortedRows.length;
  const peerStart = new Array<number>(n);
  const peerEnd = new Array<number>(n);
  const peerGroupIndex = new Array<number>(n);
  if (sort.length === 0) {
    for (let i = 0; i < n; i += 1) {
      peerStart[i] = i;
      peerEnd[i] = i;
      peerGroupIndex[i] = i;
    }
    return { peerStart, peerEnd, peerGroupIndex };
  }
  let runStart = 0;
  let group = 0;
  for (let i = 1; i <= n; i += 1) {
    if (i === n || compareBySort(sortedRows[i], sortedRows[runStart], sort) !== 0) {
      for (let j = runStart; j < i; j += 1) {
        peerStart[j] = runStart;
        peerEnd[j] = i - 1;
        peerGroupIndex[j] = group;
      }
      group += 1;
      runStart = i;
    }
  }
  return { peerStart, peerEnd, peerGroupIndex };
}

function computeRankingValue(
  op: string,
  i: number,
  n: number,
  peers: PeerInfo,
  param: number | undefined,
  gaps: GapCollector,
  path: string,
  as: string,
): number | null {
  switch (op) {
    case 'row_number':
      return i + 1;
    case 'rank':
      return peers.peerStart[i] + 1;
    case 'dense_rank':
      return peers.peerGroupIndex[i] + 1;
    case 'percent_rank':
      return n === 1 ? 0 : peers.peerStart[i] / (n - 1);
    case 'cume_dist':
      return (peers.peerEnd[i] + 1) / n;
    case 'ntile': {
      if (param == null || !Number.isInteger(param) || param < 1) {
        gaps.add({
          code: 'window:ntile-param',
          message: `The \`ntile\` window op requires a positive integer \`param\`; "${as}" is null.`,
          severity: 'unsupported',
          path,
        });
        return null;
      }
      return Math.ceil(((i + 1) * param) / n);
    }
    default:
      // Unreachable: RANKING_OPS only contains the cases above.
      return null;
  }
}

/** [lo, hi] frame bounds for row `i`, snapped to the RANGE peer group unless `ignorePeers`. */
function resolveFrame(
  i: number,
  n: number,
  frame: readonly [number | null, number | null],
  ignorePeers: boolean,
  peers: PeerInfo,
): [number, number] | null {
  const rawLo = frame[0] == null ? 0 : i + frame[0];
  const rawHi = frame[1] == null ? n - 1 : i + frame[1];
  // An offset frame can point entirely off the partition (e.g. `[1, null]` at
  // the last row, or `[null, -1]` at the first, or an inverted `[2, 1]`). Any
  // of those is an EMPTY frame — signaled with null so value/aggregate ops
  // yield null rather than clamping to a spurious in-bounds row.
  if (rawLo > rawHi || rawLo > n - 1 || rawHi < 0) {
    return null;
  }
  let lo = Math.max(0, rawLo);
  let hi = Math.min(n - 1, rawHi);
  if (!ignorePeers) {
    lo = peers.peerStart[lo];
    hi = peers.peerEnd[hi];
  }
  return [lo, hi];
}

export function applyWindowTransform(
  rows: readonly DatasetRow[],
  transform: VegaWindowTransform,
  gaps: GapCollector,
  path: string,
): readonly DatasetRow[] {
  const groupby = transform.groupby ?? [];
  const sort: SortSpec = transform.sort ?? [];
  const frame: readonly [number | null, number | null] = transform.frame ?? [null, 0];
  const ignorePeers = transform.ignorePeers === true;
  const groups = groupRows(rows, groupby);

  // Maps each original row (by reference) to its shallow-cloned output row,
  // so results can be restored to the caller's original row order at the end
  // (see the DEVIATION note above the SortSpec type).
  const outputByRow = new Map<DatasetRow, DatasetRow>();

  for (const group of groups.values()) {
    const sorted =
      sort.length > 0 ? [...group.rows].sort((a, b) => compareBySort(a, b, sort)) : group.rows;
    const n = sorted.length;
    const peers = computePeers(sorted, sort);
    const clones = sorted.map((row) => ({ ...row }));
    sorted.forEach((row, i) => outputByRow.set(row, clones[i]));

    for (const spec of transform.window) {
      const { op, field, param, as } = spec;
      for (let i = 0; i < n; i += 1) {
        let value: unknown;
        if (RANKING_OPS.has(op)) {
          value = computeRankingValue(op, i, n, peers, param, gaps, path, as);
        } else if (OFFSET_OPS.has(op)) {
          const offset = param ?? 1;
          const j = op === 'lag' ? i - offset : i + offset;
          value = j >= 0 && j < n && field != null ? (sorted[j][field] ?? null) : null;
        } else if (VALUE_OPS.has(op)) {
          const bounds = resolveFrame(i, n, frame, ignorePeers, peers);
          if (bounds == null) {
            // Empty frame: a value over no rows is null.
            value = null;
          } else if (op === 'first_value') {
            value = field != null ? (sorted[bounds[0]][field] ?? null) : null;
          } else if (op === 'last_value') {
            value = field != null ? (sorted[bounds[1]][field] ?? null) : null;
          } else if (param == null || !Number.isInteger(param) || param < 1) {
            // nth_value with a missing/invalid param.
            gaps.add({
              code: 'window:nth-value-param',
              message: `The \`nth_value\` window op requires a positive integer \`param\`; "${as}" is null.`,
              severity: 'unsupported',
              path,
            });
            value = null;
          } else {
            // nth_value with a valid param.
            const [lo, hi] = bounds;
            const idx = lo + param - 1;
            value = idx >= lo && idx <= hi && field != null ? (sorted[idx][field] ?? null) : null;
          }
        } else if (AGGREGATE_OPS.has(op)) {
          const bounds = resolveFrame(i, n, frame, ignorePeers, peers);
          const frameRows = bounds == null ? [] : sorted.slice(bounds[0], bounds[1] + 1);
          const values = field == null ? frameRows : frameRows.map((row) => row[field]);
          const result = evaluateAggregate(op as VegaAggregateOp, values, frameRows);
          if (result === undefined) {
            gaps.add({
              code: `aggregate:${op}`,
              message: `Aggregate op "${op}" is not implemented; "${as}" is null.`,
              severity: 'unsupported',
              path,
            });
            value = null;
          } else {
            value = result;
          }
        } else {
          gaps.add({
            code: `window:op:${op}`,
            message: `Window op "${op}" is not recognized; "${as}" is null.`,
            severity: 'unsupported',
            path,
          });
          value = null;
        }
        clones[i][as] = value;
      }
    }
  }

  return rows.map((row) => outputByRow.get(row) ?? row);
}
