import type { DatasetRow, VegaJoinAggregateTransform } from '../types';
import type { GapCollector } from '../gaps';
import { evaluateAggregate } from './aggregateOps';
import { groupRows } from './groupBy';

/*
 * OWNERSHIP: the "transforms" work unit owns this file.
 *
 * `joinaggregate` computes the same group-by aggregates as `aggregate`, but
 * instead of collapsing each group down to one row, it joins the aggregate
 * value(s) back onto EVERY row of the group — original row count, order, and
 * fields are preserved; aggregate columns are merged on top.
 */
export function applyJoinAggregateTransform(
  rows: readonly DatasetRow[],
  transform: VegaJoinAggregateTransform,
  gaps: GapCollector,
  path: string,
): readonly DatasetRow[] {
  const groupby = transform.groupby ?? [];
  const groups = groupRows(rows, groupby);

  // Maps each original row (by reference) to the aggregate fields its group
  // computed, so the final pass can rebuild output rows in the caller's
  // original order/positions without re-deriving group keys.
  const aggregatesByRow = new Map<DatasetRow, DatasetRow>();
  for (const group of groups.values()) {
    const aggregates: DatasetRow = {};
    for (const { op, field, as } of transform.joinaggregate) {
      const values = field == null ? group.rows : group.rows.map((row) => row[field]);
      const result = evaluateAggregate(op, values, group.rows);
      if (result === undefined) {
        gaps.add({
          code: `aggregate:${op}`,
          message: `Aggregate op "${op}" is not implemented; "${as}" is null.`,
          severity: 'unsupported',
          path,
        });
        aggregates[as] = null;
      } else {
        aggregates[as] = result;
      }
    }
    for (const row of group.rows) {
      aggregatesByRow.set(row, aggregates);
    }
  }

  return rows.map((row) => ({ ...row, ...aggregatesByRow.get(row) }));
}
