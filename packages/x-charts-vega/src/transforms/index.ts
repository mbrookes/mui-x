import type { DatasetRow, VegaEncoding, VegaTransform } from '../types';
import type { GapCollector } from '../gaps';
import { applyAggregateTransform } from './aggregate';
import { applyBinTransform } from './bin';
import { applyCalculateTransform } from './calculate';
import { applyFilterTransform } from './filter';
import { applyTimeUnitTransform } from './timeUnit';
import { applyEncodingTransforms } from './encoding';

export { applyEncodingTransforms };
export type { EncodingTransformResult } from './encoding';

/**
 * Runs a unit's top-level `transform` array over its rows, in order.
 * Unrecognized transform kinds are reported as gaps and skipped.
 */
export function applyTransforms(
  rows: readonly DatasetRow[],
  transforms: readonly VegaTransform[],
  gaps: GapCollector,
  path: string,
): readonly DatasetRow[] {
  let current = rows;
  transforms.forEach((transform, index) => {
    const transformPath = `${path}.transform[${index}]`;
    if ('filter' in transform) {
      current = applyFilterTransform(current, transform as never, gaps, transformPath);
    } else if ('calculate' in transform) {
      current = applyCalculateTransform(current, transform as never, gaps, transformPath);
    } else if ('aggregate' in transform) {
      current = applyAggregateTransform(current, transform as never, gaps, transformPath);
    } else if ('bin' in transform) {
      current = applyBinTransform(current, transform as never, gaps, transformPath);
    } else if ('timeUnit' in transform) {
      current = applyTimeUnitTransform(current, transform as never, gaps, transformPath);
    } else if ('fold' in transform) {
      const fold = transform as { fold: string[]; as?: [string, string] };
      const [keyAs, valueAs] = fold.as ?? ['key', 'value'];
      current = current.flatMap((row) =>
        fold.fold.map((field) => ({ ...row, [keyAs]: field, [valueAs]: row[field] })),
      );
    } else {
      const kind = Object.keys(transform)[0] ?? 'unknown';
      gaps.add({
        code: `transform:${kind}`,
        message: `The \`${kind}\` transform is not implemented; it was skipped and downstream values may be wrong.`,
        severity: 'unsupported',
        path: transformPath,
      });
    }
  });
  return current;
}

export type { VegaEncoding };
