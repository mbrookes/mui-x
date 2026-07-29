'use client';
import * as React from 'react';
import { useDrawingArea } from '@mui/x-charts/hooks';
import type { CompiledOverlay } from '../compile/context';
import { radiusScaleBuilder } from './scaleUtils';

/*
 * OWNERSHIP: the "text/image marks" work unit owns this file.
 *
 * Render `{kind: 'radialLabels'}`: value labels beside a `radialArcs` chart
 * (textMark.ts's `compilePolarTextLabels`). Shares the same centering/full-
 * radius formula as `RadialArcs.tsx` (drawing area center, `min(width,
 * height) / 2`) so labels land at the matching slice's actual resolved
 * radius, offset outward by `radiusOffset`.
 */

type Overlay = Extract<CompiledOverlay, { kind: 'radialLabels' }>;

export function RadialLabelsOverlay(props: { overlay: Overlay }) {
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

  return (
    <g className="MuiVegaOverlay-radialLabels" transform={`translate(${cx}, ${cy})`}>
      {overlay.items.map((item, index) => {
        const radius = radiusScale(item.radiusValue) + overlay.radiusOffset;
        const x = radius * Math.sin(item.angle);
        const y = -radius * Math.cos(item.angle);
        return (
          <text
            key={index}
            x={x}
            y={y}
            fill={item.color}
            fontSize={10}
            textAnchor="middle"
            dominantBaseline="middle"
          >
            {item.text}
          </text>
        );
      })}
    </g>
  );
}
