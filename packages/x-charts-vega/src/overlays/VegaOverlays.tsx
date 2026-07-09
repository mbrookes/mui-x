'use client';
import * as React from 'react';
import type { CompiledOverlay } from '../compile/context';
import { SegmentsOverlay } from './Segments';
import { BoxPlotOverlay } from './BoxPlot';
import { ErrorBarsOverlay } from './ErrorBars';
import { TextMarksOverlay } from './TextMarks';

/**
 * Dispatches compiled overlay instructions to their per-kind SVG renderers.
 * Rendered inside `ChartsSurface`, after the plot components — the same
 * custom-SVG-child composition pattern as `ChartsReferenceLine` (each
 * renderer reads the axis scales via the public `useXScale`/`useYScale`
 * hooks). Owned by the foundation; the per-kind renderer files are owned by
 * their respective work units.
 */
export function VegaOverlays(props: { overlays?: CompiledOverlay[] }) {
  const { overlays } = props;
  if (!overlays || overlays.length === 0) {
    return null;
  }
  return (
    <g className="MuiVegaOverlays-root">
      {overlays.map((overlay, index) => {
        switch (overlay.kind) {
          case 'segments':
            return <SegmentsOverlay key={index} overlay={overlay} />;
          case 'boxes':
            return <BoxPlotOverlay key={index} overlay={overlay} />;
          case 'errorBars':
          case 'band':
            return <ErrorBarsOverlay key={index} overlay={overlay} />;
          case 'text':
          case 'image':
            return <TextMarksOverlay key={index} overlay={overlay} />;
          default:
            return null;
        }
      })}
    </g>
  );
}
