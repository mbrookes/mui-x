import type { DatasetRow, VegaQuantileTransform } from '../types';
import type { GapCollector } from '../gaps';
import { toNumber } from '../compile/fieldTypes';
import { quantile } from './aggregateOps';
import { groupRows } from './groupBy';

/*
 * OWNERSHIP: the "transforms" work unit owns this file — per-group quantile
 * curves, reusing the shared linear-interpolation `quantile()` helper from
 * aggregateOps.ts (the same one backing the `median`/`q1`/`q3` aggregate
 * ops). Groups with no numeric values emit nothing (no gap: an empty
 * quantile curve for an empty group is expected, not a translation failure).
 */
export function applyQuantileTransform(
  rows: readonly DatasetRow[],
  transform: VegaQuantileTransform,
  // Accepted for signature parity with the other group-aware transforms;
  // there is nothing to gap here (see the file header).
  _gaps: GapCollector,
  _path: string,
): readonly DatasetRow[] {
  const groupby = transform.groupby ?? [];
  const groups = groupRows(rows, groupby);
  const [probAs, valueAs] = transform.as ?? ['prob', 'value'];

  const probs =
    transform.probs ??
    (() => {
      // A non-positive step would never advance `p` (infinite loop) or run
      // backwards, so fall back to the default 0.01 for step <= 0.
      const rawStep = transform.step ?? 0.01;
      const step = rawStep > 0 ? rawStep : 0.01;
      const generated: number[] = [];
      for (let p = step / 2; p < 1; p += step) {
        generated.push(p);
      }
      return generated;
    })();

  const out: DatasetRow[] = [];
  for (const group of groups.values()) {
    const values = group.rows
      .map((row) => toNumber(row[transform.quantile]))
      .filter((value): value is number => value != null)
      .sort((a, b) => a - b);
    if (values.length === 0) {
      continue;
    }
    for (const p of probs) {
      out.push({ ...group.key, [probAs]: p, [valueAs]: quantile(values, p) });
    }
  }
  return out;
}
