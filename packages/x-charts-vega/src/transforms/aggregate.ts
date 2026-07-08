import type { DatasetRow, VegaAggregateTransform } from '../types';
import type { GapCollector } from '../gaps';
import { evaluateAggregate } from './aggregateOps';

/*
 * OWNERSHIP: the "transforms" work unit owns this file. Baseline: full
 * group-by aggregation using the shared op evaluator.
 */
export function applyAggregateTransform(
  rows: readonly DatasetRow[],
  transform: VegaAggregateTransform,
  gaps: GapCollector,
  path: string,
): readonly DatasetRow[] {
  const groupby = transform.groupby ?? [];
  const groups = new Map<string, { key: DatasetRow; rows: DatasetRow[] }>();
  for (const row of rows) {
    const groupKey = groupby
      .map((field) => {
        const value = row[field];
        return value instanceof Date ? `d:${value.getTime()}` : `${typeof value}:${String(value)}`;
      })
      .join(' ');
    let group = groups.get(groupKey);
    if (!group) {
      group = { key: Object.fromEntries(groupby.map((field) => [field, row[field]])), rows: [] };
      groups.set(groupKey, group);
    }
    group.rows.push(row);
  }

  const out: DatasetRow[] = [];
  for (const group of groups.values()) {
    const outRow: DatasetRow = { ...group.key };
    for (const { op, field, as } of transform.aggregate) {
      const values = field == null ? group.rows : group.rows.map((row) => row[field]);
      const result = evaluateAggregate(op, values);
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
