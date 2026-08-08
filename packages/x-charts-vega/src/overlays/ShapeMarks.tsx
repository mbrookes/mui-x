'use client';
import * as React from 'react';
import { useXScale, useYScale } from '@mui/x-charts/hooks';
import type { CompiledOverlay, OverlayShapeItem } from '../compile/context';
import { scalePosition } from './scaleUtils';

/*
 * OWNERSHIP: the "point/scatter marks" work unit owns this file.
 *
 * Render `{kind: 'shapes'}`: one SVG <path> per item, drawn in the shape's own
 * coordinate space and placed by `translate(x, y) scale(s)`. x-charts' scatter
 * markers are uniform circles, so a `shape` encoding carrying literal SVG path
 * data (Vega's isotype examples) has no series equivalent and renders here
 * instead.
 *
 * The transform order matters: translate THEN scale, so the shape scales about
 * its own origin and lands centred on the data point — which is how Vega
 * composes it, and why the path data is authored centred on (0, 0).
 */
function ShapeItems(props: { items: OverlayShapeItem[] }) {
  const xScale = useXScale();
  const yScale = useYScale();

  return (
    <g className="MuiVegaOverlay-shapes">
      {props.items.map((item, index) => {
        const x = scalePosition(xScale, item.x);
        const y = scalePosition(yScale, item.y);
        if (x === null || y === null) {
          return null;
        }
        return (
          <path
            key={index}
            d={item.path}
            transform={`translate(${x}, ${y}) scale(${item.scale})`}
            fill={item.color ?? 'currentColor'}
            opacity={item.opacity}
            // The path is scaled up from a unit-ish space, so a stroke would be
            // scaled with it; these marks are filled silhouettes anyway.
            stroke="none"
          />
        );
      })}
    </g>
  );
}

export function ShapeMarksOverlay(props: {
  overlay: Extract<CompiledOverlay, { kind: 'shapes' }>;
}) {
  return <ShapeItems items={props.overlay.items} />;
}
