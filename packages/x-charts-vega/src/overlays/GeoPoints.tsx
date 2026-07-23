'use client';
import * as React from 'react';
import type { CompiledOverlay } from '../compile/context';
import { useResolvedGeoProjection } from './geoProjection';

/*
 * OWNERSHIP: the "point/scatter marks" work unit owns this file.
 *
 * Render a `{kind: 'geoPoints'}` overlay: one SVG <circle> per item, its
 * `[lon, lat]` projected to pixels with the geo chart's own projection —
 * `useGeoPath().projection()` — rather than `useXScale`/`useYScale` (there is
 * no cartesian axis on a geo chart at all). This is the same projection
 * `<GeoDataPlot />`/`<MapShapePlot />` use (and stays in sync with
 * interactive pan/zoom, since `useGeoPath` reads the live projection from the
 * geo store), so markers track the base map exactly.
 * Wrap in <g className="MuiVegaOverlay-geoPoints">.
 */

const DEFAULT_FILL = 'currentColor';

export function GeoPointsOverlay(props: {
  overlay: Extract<CompiledOverlay, { kind: 'geoPoints' }>;
}) {
  const { overlay } = props;
  const projection = useResolvedGeoProjection();

  if (overlay.items.length === 0 || !projection) {
    return null;
  }

  return (
    <g className="MuiVegaOverlay-geoPoints">
      {overlay.items.map((item, index) => {
        const projected = projection([item.lon, item.lat]);
        if (!projected) {
          return null;
        }
        const [cx, cy] = projected;
        return (
          <circle
            key={index}
            cx={cx}
            cy={cy}
            r={item.radius}
            fill={item.color ?? DEFAULT_FILL}
            fillOpacity={item.fillOpacity}
          />
        );
      })}
    </g>
  );
}
