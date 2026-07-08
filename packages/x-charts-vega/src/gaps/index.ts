/**
 * Gap reporting: every Vega-Lite feature the wrapper cannot (fully) translate
 * to `@mui/x-charts` is recorded as a `TranslationGap` instead of throwing.
 * An incomplete render plus an explicit gap list is the contract of this
 * package.
 */

export type GapSeverity =
  /** The feature is not supported at all; the related visual is dropped. */
  | 'unsupported'
  /** The feature is rendered with a visible approximation. */
  | 'partial'
  /** The property was recognized but has no x-charts equivalent and was ignored. */
  | 'ignored';

export interface TranslationGap {
  /** Stable machine-readable identifier, e.g. `mark:geoshape` or `encoding:shape`. */
  code: string;
  /** Human-readable explanation, including the x-charts tier that covers it when one exists. */
  message: string;
  severity: GapSeverity;
  /** JSON-path-ish locator into the input spec, e.g. `layer[1].encoding.shape`. */
  path?: string;
}

export interface GapCollector {
  add: (gap: TranslationGap) => void;
  list: () => TranslationGap[];
}

export function createGapCollector(): GapCollector {
  const gaps: TranslationGap[] = [];
  const seen = new Set<string>();
  return {
    add(gap) {
      const key = `${gap.code}|${gap.path ?? ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        gaps.push(gap);
      }
    },
    list: () => gaps.slice(),
  };
}
