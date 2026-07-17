'use client';
import * as React from 'react';
import { scaleLinear, scalePow, scaleSqrt } from '@mui/x-charts-vendor/d3-scale';
import { useDrawingArea } from '@mui/x-charts/hooks';
import type { CompiledOverlay } from '../compile/context';

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

  const fullRadius = Math.min(drawingArea.width, drawingArea.height) / 2;
  const cx = drawingArea.left + drawingArea.width / 2;
  const cy = drawingArea.top + drawingArea.height / 2;

  const buildScale =
    overlay.radiusScaleType === 'linear'
      ? scaleLinear
      : overlay.radiusScaleType === 'pow'
        ? scalePow
        : scaleSqrt;
  const radiusScale = buildScale(overlay.radiusDomain, [overlay.radiusRangeMin, fullRadius]);

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
