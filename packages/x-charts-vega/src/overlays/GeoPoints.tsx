'use client';
import * as React from 'react';
import { useGeoPath } from '@mui/x-charts-premium/hooks';
import type { CompiledOverlay } from '../compile/context';

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
  const path = useGeoPath();
  const rawProjection = path?.projection?.();
  // `GeoPath.projection()` is typed to also allow a bare `GeoStreamWrapper`
  // (a `{stream}`-only custom transform, no `(point) => [x, y]` call
  // signature) — never what this wrapper registers, but the type needs
  // narrowing before it can be called as a function.
  const projection = typeof rawProjection === 'function' ? rawProjection : undefined;

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
