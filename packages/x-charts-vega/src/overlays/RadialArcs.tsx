'use client';
import * as React from 'react';
import { arc as d3Arc } from '@mui/x-charts-vendor/d3-shape';
import { scaleLinear, scalePow, scaleSqrt } from '@mui/x-charts-vendor/d3-scale';
import { useDrawingArea } from '@mui/x-charts/hooks';
import type { CompiledOverlay } from '../compile/context';

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
