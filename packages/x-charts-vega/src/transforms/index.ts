import type { DatasetRow, VegaEncoding, VegaTransform } from '../types';
import type { GapCollector } from '../gaps';
import { applyAggregateTransform } from './aggregate';
import { applyBinTransform } from './bin';
import { applyCalculateTransform } from './calculate';
import { applyFilterTransform } from './filter';
import { applyLookupTransform } from './lookup';
import { applyTimeUnitTransform } from './timeUnit';
import { applyEncodingTransforms } from './encoding';

export { applyEncodingTransforms };
export type { EncodingTransformResult } from './encoding';

/**
 * Vega-Lite transform kinds this wrapper recognizes but deliberately does
 * not implement (all reported as 'unsupported' gaps with a kind-specific
 * message, rather than falling through to the generic "unknown transform"
 * message below).
 */
const KNOWN_UNSUPPORTED_TRANSFORMS: Record<string, string> = {
  window:
    'Window transforms (running/cumulative calculations over sorted, partitioned frames) are not supported.',
  joinaggregate:
    'Join-aggregate transforms (aggregate values joined back onto every row) are not supported.',
  density: 'Density transforms (kernel density estimation) are not supported.',
  regression: 'Regression transforms (fitted trend lines) are not supported.',
  loess: 'Loess transforms (local regression smoothing) are not supported.',
  pivot: 'Pivot transforms (long-to-wide reshaping) are not supported.',
  quantile: 'Quantile transforms (per-group quantile curves) are not supported.',
  sample: 'Sample transforms (random row sampling) are not supported.',
  stack: 'Explicit `stack` transforms are not supported; use a stacked mark/encoding instead.',
  impute: 'Impute transforms (synthesizing missing data points) are not supported.',
  flatten: 'Flatten transforms (expanding array-valued fields into rows) are not supported.',
};

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
    } else if ('lookup' in transform) {
      current = applyLookupTransform(current, transform as never, gaps, transformPath);
    } else if ('fold' in transform) {
      const fold = transform as { fold: string[]; as?: [string, string] };
      const [keyAs, valueAs] = fold.as ?? ['key', 'value'];
      current = current.flatMap((row) =>
        fold.fold.map((field) => ({ ...row, [keyAs]: field, [valueAs]: row[field] })),
      );
    } else {
      const knownKind = Object.keys(transform).find((key) => key in KNOWN_UNSUPPORTED_TRANSFORMS);
      const kind = knownKind ?? Object.keys(transform)[0] ?? 'unknown';
      const knownMessage = knownKind ? KNOWN_UNSUPPORTED_TRANSFORMS[knownKind] : undefined;
      gaps.add({
        code: `transform:${kind}`,
        message: knownMessage
          ? `${knownMessage} The transform was skipped and downstream values may be wrong.`
          : `The \`${kind}\` transform is not implemented; it was skipped and downstream values may be wrong.`,
        severity: 'unsupported',
        path: transformPath,
      });
    }
  });
  return current;
}

export type { VegaEncoding };
