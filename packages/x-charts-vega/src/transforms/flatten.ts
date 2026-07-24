import type { DatasetRow, VegaFlattenTransform } from '../types';
import type { GapCollector } from '../gaps';

/*
 * OWNERSHIP: the "transforms" work unit owns this file.
 *
 * `flatten` expands array-valued fields into one row per array entry — the
 * array-of-values sibling of `fold` (which expands COLUMNS into rows; this
 * expands each row's own array ELEMENTS into rows). Non-flattened fields are
 * copied onto every output row unchanged (`boxplot_preaggregated`'s
 * `outliers: [2700, 4800]` becomes two rows, each keeping that row's
 * `Species`/`lower`/`q1`/… untouched, with `outliers` replaced by the single
 * numeric value).
 */
export function applyFlattenTransform(
  rows: readonly DatasetRow[],
  transform: VegaFlattenTransform,
  gaps: GapCollector,
  path: string,
): readonly DatasetRow[] {
  const fields = transform.flatten;
  if (!Array.isArray(fields) || fields.length === 0) {
    gaps.add({
      code: 'transform:flatten',
      message:
        'A `flatten` transform needs a non-empty `flatten` field list; this one has neither, so it was skipped and downstream values may be wrong.',
      severity: 'unsupported',
      path,
    });
    return rows;
  }
  // A field whose value isn't an array (or is missing) is treated as a
  // single-element array, matching Vega-Lite's own fallback — the row still
  // survives, just without actually expanding.
  const asNames =
    Array.isArray(transform.as) && transform.as.length === fields.length ? transform.as : fields;

  const output: DatasetRow[] = [];
  for (const row of rows) {
    const arrays = fields.map((field) => {
      const value = row[field];
      return Array.isArray(value) ? value : [value];
    });
    const maxLength = Math.max(...arrays.map((values) => values.length));
    // Every listed field resolved to an empty array (e.g. `outliers: []`):
    // Vega-Lite produces no output row for it at all, not one row of nulls.
    if (maxLength === 0) {
      continue;
    }
    for (let index = 0; index < maxLength; index += 1) {
      const newRow: DatasetRow = { ...row };
      fields.forEach((_field, fieldIndex) => {
        const values = arrays[fieldIndex];
        newRow[asNames[fieldIndex]] = index < values.length ? values[index] : undefined;
      });
      output.push(newRow);
    }
  }
  return output;
}
