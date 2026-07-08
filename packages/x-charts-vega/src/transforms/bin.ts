import type { DatasetRow, VegaBinTransform } from '../types';
import type { GapCollector } from '../gaps';

/*
 * OWNERSHIP: the "transforms" work unit owns this file — implement d3-style
 * nice binning (maxbins/step/extent) writing `as` (bin start) and `as_end`
 * columns. The stub reports a gap and passes rows through unchanged.
 */
export function applyBinTransform(
  rows: readonly DatasetRow[],
  transform: VegaBinTransform,
  gaps: GapCollector,
  path: string,
): readonly DatasetRow[] {
  gaps.add({
    code: 'transform:bin',
    message: `The \`bin\` transform on field "${transform.field}" is not implemented yet; rows pass through unbinned.`,
    severity: 'unsupported',
    path,
  });
  return rows;
}
