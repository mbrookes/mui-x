import type { DatasetRow, VegaTimeUnitTransform } from '../types';
import type { GapCollector } from '../gaps';

/*
 * OWNERSHIP: the "transforms" work unit owns this file — implement calendar
 * truncation for the common time units (year, yearmonth, month, date, day,
 * hours, ...) writing the truncated Date into `as`. The stub reports a gap
 * and passes rows through unchanged.
 */
export function applyTimeUnitTransform(
  rows: readonly DatasetRow[],
  transform: VegaTimeUnitTransform,
  gaps: GapCollector,
  path: string,
): readonly DatasetRow[] {
  gaps.add({
    code: 'transform:timeUnit',
    message: `The \`timeUnit\` transform ("${transform.timeUnit}") is not implemented yet; raw date values are used.`,
    severity: 'unsupported',
    path,
  });
  return rows;
}
