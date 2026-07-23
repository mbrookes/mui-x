'use client';
import { useGeoPath } from '@mui/x-charts-premium/hooks';
import type { GeoProjection } from '@mui/x-charts-vendor/d3-geo';

/*
 * OWNERSHIP: shared by every geo-projected overlay renderer (GeoPoints.tsx,
 * GeoSegments.tsx, GeoText.tsx).
 *
 * Resolves the geo chart's live projection function via `useGeoPath()` — the
 * same one `<GeoDataPlot />`/`<MapShapePlot />` use, staying in sync with
 * interactive pan/zoom. `GeoPath.projection()` is typed to also allow a bare
 * `GeoStreamWrapper` (a `{stream}`-only custom transform with no
 * `(point) => [x, y]` call signature) — never what this wrapper registers,
 * but the type needs narrowing before it can be called as a function.
 */
export function useResolvedGeoProjection(): GeoProjection | undefined {
  const path = useGeoPath();
  const rawProjection = path?.projection?.();
  return typeof rawProjection === 'function' ? (rawProjection as GeoProjection) : undefined;
}
