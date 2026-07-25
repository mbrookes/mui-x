import { scaleLinear, scalePow, scaleSqrt } from '@mui/x-charts-vendor/d3-scale';
import type { OverlayPixelPosition, OverlayPosition } from '../compile/context';

/**
 * A minimal structural view of the d3 scales returned by `useXScale`/
 * `useYScale`: continuous scales are plain value→pixel functions; band/point
 * scales additionally expose `bandwidth()`.
 */
export interface AnyScale {
  (value: never): number | undefined;
  bandwidth?: () => number;
}

/**
 * Converts a data-space overlay position to a pixel coordinate, centering
 * within the band for band scales. A literal `{pixel: N}` position bypasses
 * the scale entirely and returns `N` unchanged (Vega-Lite's positional
 * `value` encoding is already a plot-area pixel offset, not a data value).
 * Returns `null` when a data-space value is outside the scale's domain
 * (callers skip drawing that item).
 * @param {AnyScale} scale The d3 scale from `useXScale()`/`useYScale()`.
 * @param {OverlayPosition} value The data-space value, or a literal pixel position.
 * @returns {number | null} The pixel position, or `null` when unresolvable.
 */
export function scalePosition(scale: AnyScale, value: OverlayPosition): number | null {
  if (typeof value === 'object' && value !== null && 'pixel' in value) {
    return (value as OverlayPixelPosition).pixel;
  }
  const position = scale(value as never);
  if (position === undefined || Number.isNaN(position)) {
    return null;
  }
  const bandwidth = typeof scale.bandwidth === 'function' ? scale.bandwidth() : 0;
  return position + bandwidth / 2;
}

/**
 * The band width in pixels for band/point scales (0 for continuous scales) —
 * used to size category-anchored glyphs like boxplot boxes.
 * @param {AnyScale} scale The d3 scale.
 * @returns {number} The bandwidth, or 0.
 */
export function scaleBandwidth(scale: AnyScale): number {
  return typeof scale.bandwidth === 'function' ? scale.bandwidth() : 0;
}

/**
 * The d3 scale constructor for a radial overlay's `radiusScaleType`, defaulting
 * to `sqrt` — Vega-Lite's own default for a radius scale, which keeps a slice's
 * AREA proportional to its value rather than its radius. Shared by
 * `RadialArcs.tsx` and `RadialLabels.tsx` so labels land at the same radius the
 * arcs were drawn at (they already share the centering/full-radius formula).
 */
export function radiusScaleBuilder(radiusScaleType: string | undefined): typeof scaleLinear {
  // The three constructors share the `(domain, range)` overload used here, but
  // their full signatures don't unify into a callable union — so they are
  // normalized to one builder type rather than returned as a union.
  if (radiusScaleType === 'linear') {
    return scaleLinear;
  }
  return (radiusScaleType === 'pow' ? scalePow : scaleSqrt) as typeof scaleLinear;
}
