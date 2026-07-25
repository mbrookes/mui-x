'use client';
import * as React from 'react';
import { useGeoPath } from '@mui/x-charts-premium/hooks';
import type { CompiledOverlay } from '../compile/context';

/*
 * OWNERSHIP: the "geo overlays" work unit owns this file.
 *
 * Render a `{kind: 'geoShapes'}` overlay: one SVG <path> per feature, its `d`
 * built by the geo chart's OWN `useGeoPath()` — the same path generator
 * `<GeoDataPlot />`/`<MapShapePlot />` use, so an extra geo layer shares the
 * base map's projection and stays aligned through interactive pan/zoom.
 *
 * Used for every `geoshape` layer after the first: x-charts draws a single
 * `geoData` per chart, so a spec stacking several geo datasets (borough
 * outlines + the tube-line network in `geo_layer_line_london`) renders only
 * the base natively and the rest through here.
 * Wrap in <g className="MuiVegaOverlay-geoShapes">.
 */

const DEFAULT_FILL = 'none';
const DEFAULT_STROKE = 'currentColor';
const DEFAULT_STROKE_WIDTH = 1;

export function GeoShapesOverlay(props: {
  overlay: Extract<CompiledOverlay, { kind: 'geoShapes' }>;
}) {
  const { overlay } = props;
  const path = useGeoPath();

  if (overlay.items.length === 0 || !path) {
    return null;
  }

  return (
    <g className="MuiVegaOverlay-geoShapes">
      {overlay.items.map((item, index) => {
        // `geoPath` returns null for a geometry that projects to nothing (fully
        // clipped, or empty coordinates) — skip rather than emit `d="null"`.
        const d = path(item.feature as Parameters<typeof path>[0]);
        if (!d) {
          return null;
        }
        return (
          <path
            key={index}
            d={d}
            fill={item.fill ?? DEFAULT_FILL}
            stroke={item.stroke ?? DEFAULT_STROKE}
            strokeWidth={item.strokeWidth ?? DEFAULT_STROKE_WIDTH}
            // These are decorative map strata; the base map keeps the tooltips.
            pointerEvents="none"
          />
        );
      })}
    </g>
  );
}
