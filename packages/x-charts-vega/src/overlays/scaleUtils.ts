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
