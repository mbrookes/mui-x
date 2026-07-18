import type { DatasetRow, VegaPivotTransform } from '../types';
import type { GapCollector } from '../gaps';
import { compareColorValues } from '../compile/color';
import { evaluateAggregate } from './aggregateOps';
import { groupRows } from './groupBy';

/*
 * OWNERSHIP: the "transforms" work unit owns this file.
 *
 * `pivot` reshapes long-format rows into wide format: one output row per
 * distinct `groupby` combination, with one new column per distinct `pivot`
 * field value (holding the aggregated `value` field for that combination).
 * This is the long-to-wide counterpart of `fold` (wide-to-long), which the
 * wrapper already implements inline in `transforms/index.ts`.
 *
 * - `groupby` defaults to every field present on the rows other than `pivot`
 *   and `value` (Vega-Lite's own default) when omitted.
 * - New column names come from the pivot field's distinct values, sorted
 *   ascending (numeric-aware, then locale) to match Vega-Lite's default
 *   ordering — the same comparator `compile/color.ts` uses for a default
 *   color domain. `limit` (when positive) keeps only the first `limit` of
 *   those sorted values; the rest are dropped (matching Vega-Lite).
 * - A (groupby, pivot-value) combination with multiple contributing rows is
 *   aggregated via `op` (default `'sum'`, reusing the shared op evaluator);
 *   a combination with no contributing row gets `null`, matching Vega-Lite's
 *   "missing cells are null" behavior.
 */
export function applyPivotTransform(
  rows: readonly DatasetRow[],
  transform: VegaPivotTransform,
  gaps: GapCollector,
  path: string,
): readonly DatasetRow[] {
  const { pivot, value, op = 'sum', limit } = transform;

  const groupby =
    transform.groupby ??
    (() => {
      const fields = new Set<string>();
      rows.forEach((row) => Object.keys(row).forEach((field) => fields.add(field)));
      fields.delete(pivot);
      fields.delete(value);
      return [...fields];
    })();

  const seenColumns = new Set<string>();
  const distinctColumns: unknown[] = [];
  rows.forEach((row) => {
    const columnValue = row[pivot];
    if (columnValue == null) {
      return;
    }
    const key = String(columnValue);
    if (!seenColumns.has(key)) {
      seenColumns.add(key);
      distinctColumns.push(columnValue);
    }
  });
  distinctColumns.sort(compareColorValues);
  const columns =
    typeof limit === 'number' && limit > 0 ? distinctColumns.slice(0, limit) : distinctColumns;

  const groups = groupRows(rows, groupby);
  const out: DatasetRow[] = [];
  for (const group of groups.values()) {
    const rowsByColumn = new Map<string, DatasetRow[]>();
    group.rows.forEach((row) => {
      const columnValue = row[pivot];
      if (columnValue == null) {
        return;
      }
      const key = String(columnValue);
      const bucket = rowsByColumn.get(key);
      if (bucket) {
        bucket.push(row);
      } else {
        rowsByColumn.set(key, [row]);
      }
    });

    const outRow: DatasetRow = { ...group.key };
    columns.forEach((columnValue) => {
      const key = String(columnValue);
      const bucket = rowsByColumn.get(key);
      if (!bucket) {
        outRow[key] = null;
        return;
      }
      const result = evaluateAggregate(
        op,
        bucket.map((row) => row[value]),
        bucket,
      );
      if (result === undefined) {
        gaps.add({
          code: `aggregate:${op}`,
          message: `The pivot transform's aggregation op "${op}" is not implemented; "${key}" is null.`,
          severity: 'unsupported',
          path,
        });
        outRow[key] = null;
      } else {
        outRow[key] = result;
      }
    });
    out.push(outRow);
  }
  return out;
}
