'use client';
import * as React from 'react';
import { arc as d3Arc } from '@mui/x-charts-vendor/d3-shape';
import { useDrawingArea } from '@mui/x-charts/hooks';
import type { CompiledOverlay } from '../compile/context';
import { radiusScaleBuilder } from './scaleUtils';

/*
 * OWNERSHIP: the "arc/pie mark" work unit owns this file.
 *
 * Render `{kind: 'radialArcs'}`: a "coxcomb"/polar-bar chart where each slice
 * has its own outer radius (arc.ts's `compileRadialArcMark` — x-charts' pie
 * series only supports one inner/outer radius for the whole series). Centers
 * on the drawing area (matching `<PiePlot />`'s own centering) and sizes the
 * full radius to `min(width, height) / 2`, mirroring the same formula
 * VegaLiteChart.tsx uses to default a plain pie/donut's `outerRadius`. Draws
 * each slice with `@mui/x-charts-vendor/d3-shape`'s `arc()` generator
 * directly rather than going through any x-charts series.
 */

type Overlay = Extract<CompiledOverlay, { kind: 'radialArcs' }>;

export function RadialArcsOverlay(props: { overlay: Overlay }) {
  const { overlay } = props;
  const drawingArea = useDrawingArea();

  // Vega sizes a radial view's outer radius from the PLOT, not from the plot
  // minus the chart margins — and the pie path already does the same
  // (`Math.min(resolvedWidth, resolvedHeight) / 2` on the surface), which is why
  // pies match exactly while `arc_radial` came out at 0.82 of the reference in
  // both dimensions. The margins are symmetric, so the inset on one side
  // reconstructs the surface without hard-coding x-charts' default.
  const surfaceWidth = drawingArea.width + 2 * drawingArea.left;
  const surfaceHeight = drawingArea.height + 2 * drawingArea.top;
  const fullRadius = Math.min(surfaceWidth, surfaceHeight) / 2;
  const cx = drawingArea.left + drawingArea.width / 2;
  const cy = drawingArea.top + drawingArea.height / 2;

  const radiusScale = radiusScaleBuilder(overlay.radiusScaleType)(overlay.radiusDomain, [
    overlay.radiusRangeMin,
    fullRadius,
  ]);

  const generator = d3Arc();

  return (
    <g className="MuiVegaOverlay-radialArcs" transform={`translate(${cx}, ${cy})`}>
      {overlay.items.map((item, index) => {
        const outerRadius = radiusScale(item.radiusValue);
        const d = generator({
          innerRadius: overlay.innerRadius,
          outerRadius,
          startAngle: item.startAngle,
          endAngle: item.endAngle,
        } as never);
        if (!d) {
          return null;
        }
        return <path key={index} d={d} fill={item.color} stroke="#fff" strokeWidth={1} />;
      })}
    </g>
  );
}
