'use client';
import type { CompiledOverlay } from '../compile/context';

/*
 * OWNERSHIP: the "errorbar/errorband" work unit owns this file.
 *
 * Render `{kind: 'errorBars'}`: per item, a whisker line from lower→upper at
 * the category position with perpendicular end caps and an optional center
 * tick; `orientation: 'horizontal'` transposes. Render `{kind: 'band'}`: a
 * single closed <path> tracing points' upper values left→right then lower
 * values right→left, filled with `color` at `opacity` (default ~0.3).
 * Use useXScale()/useYScale() + scalePosition from ../overlays/scaleUtils.
 * Wrap in <g className="MuiVegaOverlay-errorBars"> / "MuiVegaOverlay-band".
 */
export function ErrorBarsOverlay(props: {
  overlay: Extract<CompiledOverlay, { kind: 'errorBars' } | { kind: 'band' }>;
}) {
  // Stub — implemented by the errorbar/errorband work unit.
  return props.overlay.kind === 'errorBars' ? null : null;
}
