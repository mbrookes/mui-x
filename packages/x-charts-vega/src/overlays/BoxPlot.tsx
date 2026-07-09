'use client';
import type { CompiledOverlay } from '../compile/context';

/*
 * OWNERSHIP: the "boxplot" work unit owns this file.
 *
 * Render a `{kind: 'boxes'}` overlay: per item, a filled rect from q1→q3
 * (thickness = widthRatio × category bandwidth, centered on the category via
 * scalePosition), a median line, whisker lines to min/max with end caps, and
 * small circles for outliers. `orientation: 'horizontal'` transposes
 * (category on the y axis, values on x). Use useXScale()/useYScale() +
 * scaleBandwidth() from ../overlays/scaleUtils; skip unresolvable items.
 * Wrap in <g className="MuiVegaOverlay-boxes">.
 */
export function BoxPlotOverlay(props: { overlay: Extract<CompiledOverlay, { kind: 'boxes' }> }) {
  // Stub — implemented by the boxplot work unit.
  return props.overlay.items.length === 0 ? null : null;
}
