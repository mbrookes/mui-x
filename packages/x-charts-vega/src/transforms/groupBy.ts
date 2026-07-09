import type { DatasetRow } from '../types';

/*
 * OWNERSHIP: the "transforms" work unit owns this file — the group-by
 * partitioning loop shared by every group-aware transform (`aggregate`,
 * `window`, `joinaggregate`, `regression`, `loess`, `quantile`, `density`).
 * Extracted verbatim from the original `applyAggregateTransform` grouping
 * loop so every transform partitions rows identically.
 */

/**
 * Partitions `rows` by the values of the `groupby` fields, preserving
 * insertion (row) order within each group and returning groups in
 * first-seen order. An empty `groupby` array produces a single group
 * (empty key) containing every row, matching Vega-Lite's "no groupby means
 * one group" semantics.
 *
 * Grouping keys are derived the same way for every field: `Date` values key
 * by their epoch millis (`d:<ms>`), everything else keys by `<typeof
 * value>:<String(value)>` — so `undefined`, `null`, `0`, and `"0"` are all
 * distinguishable groups.
 */
export function groupRows(
  rows: readonly DatasetRow[],
  groupby: readonly string[],
): Map<string, { key: DatasetRow; rows: DatasetRow[] }> {
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
  return groups;
}
