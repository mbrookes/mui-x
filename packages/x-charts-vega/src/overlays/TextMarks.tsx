'use client';
import type { CompiledOverlay } from '../compile/context';

/*
 * OWNERSHIP: the "text/image marks" work unit owns this file.
 *
 * Render `{kind: 'text'}`: one SVG <text> per item at the scaled position
 * plus dx/dy pixel offsets, applying per-item style (fontSize, fill,
 * textAnchor from Vega align, dominantBaseline from Vega baseline).
 * Render `{kind: 'image'}`: one SVG <image href> per item, centered on the
 * scaled position, with width/height (sensible defaults when omitted).
 * Use useXScale()/useYScale() + scalePosition from ../overlays/scaleUtils.
 * Wrap in <g className="MuiVegaOverlay-text"> / "MuiVegaOverlay-image".
 */
export function TextMarksOverlay(props: {
  overlay: Extract<CompiledOverlay, { kind: 'text' } | { kind: 'image' }>;
}) {
  // Stub — implemented by the text/image marks work unit.
  return props.overlay.kind === 'text' ? null : null;
}
