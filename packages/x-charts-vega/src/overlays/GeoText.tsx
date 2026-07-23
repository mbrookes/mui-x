'use client';
import * as React from 'react';
import type { CompiledOverlay } from '../compile/context';
import { useResolvedGeoProjection } from './geoProjection';

/*
 * OWNERSHIP: the "text/image marks" work unit owns this file.
 *
 * Render a `{kind: 'geoText'}` overlay: one SVG <text> per item at its
 * `[lon, lat]` projected position (see geoProjection.ts) plus dx/dy pixel
 * offsets — mirrors `TextMarks.tsx`'s `{kind: 'text'}` renderer, but there is
 * no cartesian axis on a geo chart, so positions come from the geo chart's
 * own projection instead of `useXScale`/`useYScale`.
 * Wrap in <g className="MuiVegaOverlay-geoText">.
 */

export function GeoTextOverlay(props: { overlay: Extract<CompiledOverlay, { kind: 'geoText' }> }) {
  const { overlay } = props;
  const projection = useResolvedGeoProjection();

  if (overlay.items.length === 0 || !projection) {
    return null;
  }

  return (
    <g className="MuiVegaOverlay-geoText">
      {overlay.items.map((item, index) => {
        const projected = projection([item.lon, item.lat]);
        if (!projected) {
          return null;
        }
        const [x, y] = projected;
        return (
          <text key={index} x={x + (item.dx ?? 0)} y={y + (item.dy ?? 0)} style={item.style}>
            {item.text}
          </text>
        );
      })}
    </g>
  );
}
