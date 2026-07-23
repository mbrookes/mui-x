'use client';
import * as React from 'react';
import type { CompiledOverlay } from '../compile/context';
import { useResolvedGeoProjection } from './geoProjection';

/*
 * OWNERSHIP: the "segments, ticks & bubbles" work unit owns this file.
 *
 * Render a `{kind: 'geoSegments'}` overlay: one SVG <line> per item, both
 * endpoints projected from `[lon, lat]` to pixels with the geo chart's own
 * projection (see geoProjection.ts) rather than `useXScale`/`useYScale` —
 * there is no cartesian axis on a geo chart at all. Used by a `rule` mark's
 * `longitude`/`latitude`/`longitude2`/`latitude2` span (one independent
 * segment per row) and by a `line` mark's ordered `longitude`/`latitude`
 * path (consecutive segments connecting every row).
 * Wrap in <g className="MuiVegaOverlay-geoSegments">.
 */

const DEFAULT_STROKE = 'currentColor';
const DEFAULT_STROKE_WIDTH = 1;

export function GeoSegmentsOverlay(props: {
  overlay: Extract<CompiledOverlay, { kind: 'geoSegments' }>;
}) {
  const { overlay } = props;
  const projection = useResolvedGeoProjection();

  if (overlay.items.length === 0 || !projection) {
    return null;
  }

  return (
    <g className="MuiVegaOverlay-geoSegments">
      {overlay.items.map((item, index) => {
        const p1 = projection([item.lon1, item.lat1]);
        const p2 = projection([item.lon2, item.lat2]);
        if (!p1 || !p2) {
          return null;
        }
        return (
          <line
            key={index}
            x1={p1[0]}
            y1={p1[1]}
            x2={p2[0]}
            y2={p2[1]}
            stroke={(item.style?.stroke as string | undefined) ?? DEFAULT_STROKE}
            strokeWidth={item.style?.strokeWidth ?? DEFAULT_STROKE_WIDTH}
            strokeDasharray={item.style?.strokeDasharray as string | undefined}
          />
        );
      })}
    </g>
  );
}
