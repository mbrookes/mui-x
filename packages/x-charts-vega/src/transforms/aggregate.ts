import type { DatasetRow, VegaAggregateTransform } from '../types';
import type { GapCollector } from '../gaps';
import { evaluateAggregate } from './aggregateOps';
import { groupRows } from './groupBy';

/*
 * OWNERSHIP: the "transforms" work unit owns this file. Baseline: full
 * group-by aggregation using the shared op evaluator. Grouping itself is
 * delegated to `groupRows` (groupBy.ts), shared with every other group-aware
 * transform (window/joinaggregate/regression/loess/quantile/density).
 */
export function applyAggregateTransform(
  rows: readonly DatasetRow[],
  transform: VegaAggregateTransform,
  gaps: GapCollector,
  path: string,
): readonly DatasetRow[] {
  const groupby = transform.groupby ?? [];
  const groups = groupRows(rows, groupby);

  const out: DatasetRow[] = [];
  for (const group of groups.values()) {
    const outRow: DatasetRow = { ...group.key };
    for (const { op, field, as } of transform.aggregate) {
      const values = field == null ? group.rows : group.rows.map((row) => row[field]);
      const result = evaluateAggregate(op, values, group.rows);
      if (result === undefined) {
        gaps.add({
          code: `aggregate:${op}`,
          message: `Aggregate op "${op}" is not implemented; "${as}" is null.`,
          severity: 'unsupported',
          path,
        });
        outRow[as] = null;
      } else {
        outRow[as] = result;
      }
    }
    out.push(outRow);
  }
  return out;
}
