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

export type GapOrigin =
  /**
   * The Vega-Lite feature itself is not translated by this wrapper — either
   * genuinely out of scope (reactive signals, `repeat`, URL fetching, …) or a
   * spec-level construct with no target here. These are the *actual remaining
   * gaps*: closing one means teaching the wrapper a new Vega-Lite feature.
   */
  | 'vega-lite'
  /**
   * The Vega-Lite feature is understood, but `@mui/x-charts` cannot render it
   * natively, so the wrapper approximates it (e.g. a gradient fill collapsed to
   * a solid color) or works around it with a custom overlay/hack. These are
   * *x-charts limitations*, not wrapper omissions — closing one means x-charts
   * gaining the capability (or the workaround improving), not new spec support.
   */
  | 'x-charts';

/**
 * Gap codes whose limitation lives in the **render target** (`@mui/x-charts`)
 * rather than in Vega-Lite coverage: x-charts cannot express the feature, so
 * the wrapper approximates or hacks around it. Everything not listed here is a
 * genuine Vega-Lite coverage gap (`origin: 'vega-lite'`). The collector stamps
 * each gap's `origin` from this set so consumers (and the demo) can separate
 * "spec feature we don't support" from "x-charts can't do this natively".
 */
const X_CHARTS_LIMITATION_CODES = new Set<string>([
  // Scatter/line marker + line styling that x-charts renders uniformly.
  'encoding:shape',
  'mark:point-square-shape',
  'mark:point-size-approximation',
  'mark:point-styling',
  'mark:point-transparent',
  'mark:trail-width',
  // x-charts' native legend swatch has no per-entry dash pattern.
  'mark:strokedash-legend-swatch',
  // Opacity: an x-charts series/marker has a single color, no separate alphas.
  'encoding:opacity',
  'encoding:opacity-field-unsupported',
  // x-charts ties a stack's draw order to the series/legend order, so a custom
  // color-domain order can't reproduce Vega's descending-by-value stack sort.
  'mark:stack-order-explicit-domain',
  // Bar geometry x-charts derives automatically or applies chart-wide.
  'mark:bar-corner-radius',
  'mark:bar-corner-radius-conflict',
  'mark:bar-corner-radius-per-corner',
  'mark:bar-size',
  // Fills / heatmap-cell styling x-charts cannot express.
  'mark:gradient-fill',
  'mark:rect-opacity',
  'mark:rect-stroke',
  'mark:rect-ranged',
  // x-charts' `CurveType` set is narrower than Vega-Lite's `interpolate` list.
  'mark:interpolate-approximate',
  'mark:interpolate-unsupported',
  // Scale/axis knobs with no x-charts equivalent.
  'scale:band-padding',
  'scale:nice-count',
  'scale:zero-approximation',
  'scale:temporal-point-approximation',
  // Legend config x-charts has no per-spec equivalent for.
  'encoding:color-legend-config-ignored',
  // x-charts draws one shared axis pair, not per-layer independent scales.
  'resolve:independent-scale',
  // Marks with no x-charts series/plot equivalent, rendered by the custom SVG
  // overlay pipeline (src/overlays) instead — see GAPS.md's "custom overlay"
  // column. The overlay reproduces the mark correctly; there's just no native
  // x-charts primitive backing it.
  'mark:boxplot-custom-overlay',
  'mark:errorbar-custom-overlay',
  'mark:errorband-custom-overlay',
  'mark:image-custom-overlay',
  'mark:text-custom-overlay',
  'mark:line-continuous-x-custom-overlay',
  'mark:area-continuous-x-custom-overlay',
  'mark:line-closed-polygon-custom-overlay',
  'mark:tick-custom-overlay',
  'mark:rule-segment-custom-overlay',
]);

/** Classify a gap `code`'s origin (see `X_CHARTS_LIMITATION_CODES`). */
export function gapOrigin(code: string): GapOrigin {
  return X_CHARTS_LIMITATION_CODES.has(code) ? 'x-charts' : 'vega-lite';
}

export interface TranslationGap {
  /** Stable machine-readable identifier, e.g. `mark:geoshape` or `encoding:shape`. */
  code: string;
  /** Human-readable explanation, including the x-charts tier that covers it when one exists. */
  message: string;
  severity: GapSeverity;
  /**
   * Whether the limitation is in Vega-Lite coverage (`'vega-lite'`, the actual
   * remaining gaps) or in the x-charts render target (`'x-charts'`, approximated
   * or worked around). Stamped by the collector from the gap's `code`; a call
   * site may set it explicitly to override the default classification.
   */
  origin?: GapOrigin;
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
        // Stamp the origin from the code unless the call site set one explicitly.
        gaps.push({ ...gap, origin: gap.origin ?? gapOrigin(gap.code) });
      }
    },
    list: () => gaps.slice(),
  };
}
