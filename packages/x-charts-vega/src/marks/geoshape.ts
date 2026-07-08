import type { CompiledUnit, UnitContext } from '../compile/context';

/*
 * OWNERSHIP: the "geoshape/map mark" work unit owns this file.
 *
 * Translate the `geoshape` mark to an x-charts-premium map, rendered by the
 * shell's geo branch (<ChartsGeoDataProviderPremium> + <GeoDataPlot /> +
 * <MapShapePlot />). See docs/data/charts/map/*.tsx for reference usage.
 * - The GeoJSON FeatureCollection comes from the unit's data: either the
 *   rows ARE features (row.type === 'Feature' with a geometry), or the
 *   spec's data was a FeatureCollection passed via the `datasets`/`data`
 *   options (normalize keeps rows as-is). Build `CompiledUnit.geo =
 *   { geoData, projection }`.
 * - `projection` from the unit spec's `projection.type` (Vega-Lite names
 *   like 'naturalEarth1', 'mercator', 'equalEarth' map ~1:1 onto d3 named
 *   projections — pass through, gap for unknown names).
 * - A plain outline map (no color encoding) → plots: ['geoBase'] only.
 * - A choropleth (color encoding with a field over feature properties or
 *   joined rows) → also emit a `type: 'mapShape'` series (data entries
 *   `{name, value|color, label?}` — see packages/x-charts-premium/src/
 *   models/seriesType/mapShape.ts) and plots: ['geoBase', 'mapShape'].
 * - Vega-Lite `transform: [{lookup}]` joins for choropleth data are still
 *   unsupported (transforms unit) — document as a gap; support the common
 *   direct case where rows carry both the feature name/id and the value.
 * - gaps: unknown projections, graticule/sphere data generators, `shape`
 *   channel projections beyond geoshape.
 */
export function compileGeoshapeMark(ctx: UnitContext): CompiledUnit {
  ctx.gaps.add({
    code: 'mark:geoshape-not-implemented',
    message: 'The geoshape/map mark compiler is not implemented yet.',
    severity: 'unsupported',
    path: ctx.unit.path,
  });
  return { series: [], plots: [] };
}
