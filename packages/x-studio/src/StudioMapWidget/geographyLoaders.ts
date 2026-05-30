/**
 * Lazy-loading helpers for the built-in map geographies.
 *
 * Each function returns a Promise resolving to a GeoJSON FeatureCollection
 * whose feature `id` values are the keys callers should use as `featureId`
 * in series data.
 *
 * Built-in keys and their feature ID formats:
 *  - `'world'`  → ISO 3166-1 alpha-2 country codes (e.g. `'US'`, `'FR'`)
 *  - `'usa'`    → 2-letter US postal state abbreviations (e.g. `'CA'`, `'TX'`)
 *  - `'europe'` → ISO 3166-1 alpha-2 country codes, European subset only
 */

import type { ExtendedFeature, ExtendedFeatureCollection } from '@mui/x-charts-pro/ChoroplethChart';
import { NUMERIC_TO_ALPHA2, FIPS_TO_STATE_ABBR, EUROPEAN_ALPHA2_CODES } from './countryUtils';

export type GeographyLoader = () => Promise<ExtendedFeatureCollection>;

/** Converts a topojson Topology + object name to a GeoJSON FeatureCollection. */
async function loadTopoFeatures(
  topo: any,
  objectName: string,
): Promise<ExtendedFeatureCollection> {
  const { feature } = await import('topojson-client');
  // JSON modules resolve to { default: data } in ESM bundlers
  const topology = topo?.default ?? topo;
  return feature(topology, topology.objects[objectName]) as unknown as ExtendedFeatureCollection;
}

/**
 * Loads the Natural Earth 110m world countries map.
 * Feature IDs are ISO 3166-1 alpha-2 codes.
 */
export async function loadWorldGeography(): Promise<ExtendedFeatureCollection> {
  const topo = await import('world-atlas/countries-110m.json');
  const fc = await loadTopoFeatures(topo, 'countries');
  return {
    ...fc,
    features: fc.features
      .map((f: ExtendedFeature) => {
        const numericId = typeof f.id === 'string' ? parseInt(f.id, 10) : (f.id as number);
        // Exclude Antarctica (ISO 3166-1 numeric 010): no civilian population or country-level
        // statistics, and its size is heavily distorted by the Mercator projection.
        if (numericId === 10) {
          return null;
        }
        const alpha2 = NUMERIC_TO_ALPHA2[numericId];
        if (!alpha2) {
          return null;
        }
        return { ...f, id: alpha2 };
      })
      .filter(Boolean) as ExtendedFeatureCollection['features'],
  };
}

/**
 * Loads the US Census 10m states map.
 * Feature IDs are 2-letter US postal state abbreviations (e.g. `'CA'`, `'TX'`).
 */
export async function loadUsaGeography(): Promise<ExtendedFeatureCollection> {
  const topo = await import('us-atlas/states-10m.json');
  const fc = await loadTopoFeatures(topo, 'states');
  return {
    ...fc,
    features: fc.features
      .map((f: ExtendedFeature) => {
        const fips = typeof f.id === 'number' ? String(f.id).padStart(2, '0') : String(f.id ?? '');
        const abbr = FIPS_TO_STATE_ABBR[fips];
        if (!abbr) {
          return null;
        }
        return { ...f, id: abbr };
      })
      .filter(Boolean) as ExtendedFeatureCollection['features'],
  };
}

/**
 * Loads the European countries subset of the Natural Earth 110m world map.
 * Feature IDs are ISO 3166-1 alpha-2 codes.
 */
export async function loadEuropeGeography(): Promise<ExtendedFeatureCollection> {
  const world = await loadWorldGeography();
  return {
    ...world,
    features: world.features.filter((f: ExtendedFeature) => EUROPEAN_ALPHA2_CODES.has(String(f.id ?? ''))),
  };
}

/** The built-in geography loaders keyed by map type name. */
export const BUILT_IN_GEOGRAPHIES: Record<string, GeographyLoader> = {
  world: loadWorldGeography,
  usa: loadUsaGeography,
  europe: loadEuropeGeography,
};
