import type { OverlayPosition } from '../compile/context';

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
 * within the band for band scales. Returns `null` when the value is outside
 * the scale's domain (callers skip drawing that item).
 * @param {AnyScale} scale The d3 scale from `useXScale()`/`useYScale()`.
 * @param {OverlayPosition} value The data-space value.
 * @returns {number | null} The pixel position, or `null` when unresolvable.
 */
export function scalePosition(scale: AnyScale, value: OverlayPosition): number | null {
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
