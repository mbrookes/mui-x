/**
 * A minimal GeoJSON FeatureCollection for the choropleth demos.
 * In a real application, load this from `world-atlas` or `us-atlas`:
 *
 * ```ts
 * import { feature } from 'topojson-client';
 * import worldAtlas from 'world-atlas/countries-110m.json';
 * const world = feature(worldAtlas, worldAtlas.objects.countries);
 * ```
 */
import type { ExtendedFeatureCollection } from '@mui/x-charts-vendor/d3-geo';

// Five simplified country-like polygons for demonstration purposes
export const demoGeography: ExtendedFeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'US',
      properties: { name: 'United States' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-125, 24],
            [-66, 24],
            [-66, 49],
            [-125, 49],
            [-125, 24],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      id: 'CA',
      properties: { name: 'Canada' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-140, 49],
            [-52, 49],
            [-52, 72],
            [-140, 72],
            [-140, 49],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      id: 'MX',
      properties: { name: 'Mexico' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-117, 14],
            [-87, 14],
            [-87, 24],
            [-117, 24],
            [-117, 14],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      id: 'BR',
      properties: { name: 'Brazil' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-73, -33],
            [-34, -33],
            [-34, 5],
            [-73, 5],
            [-73, -33],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      id: 'AR',
      properties: { name: 'Argentina' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-73, -55],
            [-53, -55],
            [-53, -22],
            [-73, -22],
            [-73, -55],
          ],
        ],
      },
    },
  ],
};
