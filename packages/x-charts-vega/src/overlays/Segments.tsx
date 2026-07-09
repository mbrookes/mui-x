'use client';
import type { CompiledOverlay } from '../compile/context';

/*
 * OWNERSHIP: the "segments, ticks & bubbles" work unit owns this file.
 *
 * Render a `{kind: 'segments'}` overlay: one SVG <line> per item, both
 * endpoints converted from data space with `scalePosition(useXScale(), v)` /
 * `scalePosition(useYScale(), v)` (see ../overlays/scaleUtils). Skip items
 * whose endpoints don't resolve. Apply per-item `style` (stroke/strokeWidth/
 * strokeDasharray); default stroke: currentColor or a theme-ish gray.
 * Wrap in <g className="MuiVegaOverlay-segments">.
 */
export function SegmentsOverlay(props: {
  overlay: Extract<CompiledOverlay, { kind: 'segments' }>;
}) {
  // Stub — implemented by the segments work unit.
  return props.overlay.items.length === 0 ? null : null;
}
