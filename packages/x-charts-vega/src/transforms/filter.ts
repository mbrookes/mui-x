import type { DatasetRow, VegaFilterTransform } from '../types';
import type { GapCollector } from '../gaps';

/*
 * OWNERSHIP: the "transforms" work unit owns this file — implement field
 * predicates ({field, equal/lt/lte/gt/gte/range/oneOf/valid}) and the
 * logical composers (and/or/not). Vega expression strings ("datum.x > 5")
 * should stay a gap unless a safe mini-evaluator is written — never eval().
 * The stub supports nothing and reports a gap.
 */
export function applyFilterTransform(
  rows: readonly DatasetRow[],
  transform: VegaFilterTransform,
  gaps: GapCollector,
  path: string,
): readonly DatasetRow[] {
  gaps.add({
    code: 'transform:filter',
    message: 'The `filter` transform is not implemented yet; no rows were filtered.',
    severity: 'unsupported',
    path,
  });
  return rows;
}
