'use client';
import * as React from 'react';
import { useXScale, useYScale } from '@mui/x-charts/hooks';
import type { CompiledOverlay } from '../compile/context';
import type { AnyScale } from './scaleUtils';
import { scalePosition } from './scaleUtils';

/*
 * OWNERSHIP: the "line & area marks" work unit owns this file.
 *
 * Render a `{kind: 'polygon'}` overlay: a single closed, filled SVG <polygon>
 * from data-space points (in the given row order — never sorted), scaled via
 * `scalePosition(useXScale(), …)` / `scalePosition(useYScale(), …)`. A point
 * outside either scale's domain is dropped rather than distorting the shape.
 */

export function PolygonOverlay(props: { overlay: Extract<CompiledOverlay, { kind: 'polygon' }> }) {
  const { overlay } = props;
  const xScale = useXScale() as unknown as AnyScale;
  const yScale = useYScale() as unknown as AnyScale;

  const pixelPoints = overlay.points
    .map((point) => {
      const px = scalePosition(xScale, point.x);
      const py = scalePosition(yScale, point.y);
      return px === null || py === null ? null : `${px},${py}`;
    })
    .filter((entry): entry is string => entry !== null);

  if (pixelPoints.length < 3) {
    return null;
  }

  return (
    <polygon
      className="MuiVegaOverlay-polygon"
      points={pixelPoints.join(' ')}
      fill={overlay.fill ?? 'none'}
      fillOpacity={overlay.fillOpacity}
      stroke={overlay.stroke}
      strokeWidth={overlay.strokeWidth}
    />
  );
}
