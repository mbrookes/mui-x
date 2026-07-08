import type { DatasetRow, VegaCalculateTransform } from '../types';
import type { GapCollector } from '../gaps';

/*
 * OWNERSHIP: the "transforms" work unit owns this file. `calculate` takes a
 * Vega expression string — implement a small safe expression evaluator for
 * the common subset (datum.field access, arithmetic, string concat,
 * comparisons, ternary). Never use eval()/new Function(). The stub reports a
 * gap and passes rows through with the target column set to null.
 */
export function applyCalculateTransform(
  rows: readonly DatasetRow[],
  transform: VegaCalculateTransform,
  gaps: GapCollector,
  path: string,
): readonly DatasetRow[] {
  gaps.add({
    code: 'transform:calculate',
    message: `The \`calculate\` transform ("${transform.calculate}") is not implemented yet; "${transform.as}" is null.`,
    severity: 'unsupported',
    path,
  });
  return rows.map((row) => ({ ...row, [transform.as]: null }));
}
