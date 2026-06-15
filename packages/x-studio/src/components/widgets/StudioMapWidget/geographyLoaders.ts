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

import type { ExtendedFeature, ExtendedFeatureCollection } from '@mui/x-charts-vendor/d3-geo';
import {
  NUMERIC_TO_ALPHA2,
  FIPS_TO_STATE_ABBR,
  EUROPEAN_ALPHA2_CODES,
  normalizeToAlpha2,
  normalizeToStateAbbr,
} from './countryUtils';

export type GeographyLoader = () => Promise<ExtendedFeatureCollection>;

/**
 * Configuration for a map geography used by `StudioMapWidget`.
 *
 * Pass a record of these to `<Studio geographies={…} />` to register custom
 * map types (e.g., UK counties, Canadian provinces) alongside the built-ins.
 *
 * @example
 * ```tsx
 * const customGeographies: Record<string, StudioMapGeographyDefinition> = {
 *   'uk-counties': {
 *     label: 'United Kingdom',
 *     fieldLabel: 'County field',
 *     fieldHint: 'A field containing UK county names.',
 *     loader: async () => {
 *       const topo = await import('./uk-counties.json');
 *       const { feature } = await import('topojson-client');
 *       return feature(topo, topo.objects.counties);
 *     },
 *     normalizer: (value) => String(value ?? '').trim().toLowerCase(),
 *   },
 * };
 * <Studio geographies={customGeographies} />
 * ```
 */
export interface StudioMapGeographyDefinition {
  /** Async loader that resolves to a GeoJSON FeatureCollection. */
  loader: GeographyLoader;
  /** Display label shown in the Map type selector in the Setup panel. */
  label: string;
  /**
   * Label for the region ID field picker in the Setup panel.
   * @default 'Region field'
   */
  fieldLabel?: string;
  /**
   * Help text shown below the region field picker describing the expected values.
   * @default 'A field containing region identifiers matching the geography feature IDs.'
   */
  fieldHint?: string;
  /**
   * Converts a raw data value to the feature ID used in the geography.
   * Returning `null` skips the row.
   * @param {unknown} value - The raw field value from the dataset row.
   * @returns {string | null} The feature ID to look up in the geography, or `null` to skip the row.
   * @default normalizeToAlpha2 — handles ISO country codes and country names
   */
  normalizer?: (value: unknown) => string | null;
}

/** Converts a topojson Topology + object name to a GeoJSON FeatureCollection. */
async function loadTopoFeatures(topo: any, objectName: string): Promise<ExtendedFeatureCollection> {
  const { feature } = await import('topojson-client');
  // JSON modules resolve to { default: data } in ESM bundlers
  const topology = topo?.default ?? topo;
  return feature(topology, topology.objects[objectName]) as unknown as ExtendedFeatureCollection;
}

/**
 * Loads the Natural Earth 110m world countries map.
 * Feature IDs are ISO 3166-1 alpha-2 codes.
 */
async function loadWorldGeography(): Promise<ExtendedFeatureCollection> {
  const topo = await import('world-atlas/countries-110m.json');
  const fc = await loadTopoFeatures(topo, 'countries');
  return {
    ...fc,
    features: fc.features.flatMap((f: ExtendedFeature) => {
      const numericId = typeof f.id === 'string' ? parseInt(f.id, 10) : (f.id as number);
      // Exclude Antarctica (ISO 3166-1 numeric 010): no civilian population or country-level
      // statistics, and its size is heavily distorted by the Mercator projection.
      if (numericId === 10) {
        return [];
      }
      const alpha2 = NUMERIC_TO_ALPHA2[numericId];
      if (!alpha2) {
        return [];
      }
      // The official premium Map joins series data to features by `feature.properties.name`
      // (see selectorChartGeoFeatureIndexesByName), so expose the alpha-2 code there too.
      // `id` is kept intact for the europe loader's filter and any other id consumer.
      return [{ ...f, id: alpha2, properties: { ...f.properties, name: alpha2 } }];
    }) as ExtendedFeatureCollection['features'],
  };
}

/**
 * Loads the US Census 10m states map.
 * Feature IDs are 2-letter US postal state abbreviations (e.g. `'CA'`, `'TX'`).
 */
async function loadUsaGeography(): Promise<ExtendedFeatureCollection> {
  const topo = await import('us-atlas/states-10m.json');
  const fc = await loadTopoFeatures(topo, 'states');
  return {
    ...fc,
    features: fc.features.flatMap((f: ExtendedFeature) => {
      const fips = typeof f.id === 'number' ? String(f.id).padStart(2, '0') : String(f.id ?? '');
      const abbr = FIPS_TO_STATE_ABBR[fips];
      if (!abbr) {
        return [];
      }
      // The official premium Map joins series data to features by `feature.properties.name`
      // (see selectorChartGeoFeatureIndexesByName), so expose the state abbreviation there too.
      return [{ ...f, id: abbr, properties: { ...f.properties, name: abbr } }];
    }) as ExtendedFeatureCollection['features'],
  };
}

/**
 * Loads the European countries subset of the Natural Earth 110m world map.
 * Feature IDs are ISO 3166-1 alpha-2 codes.
 */
async function loadEuropeGeography(): Promise<ExtendedFeatureCollection> {
  const world = await loadWorldGeography();
  return {
    ...world,
    features: world.features.filter((f: ExtendedFeature) =>
      EUROPEAN_ALPHA2_CODES.has(String(f.id ?? '')),
    ),
  };
}

/** The built-in geography definitions keyed by map type name. */
export const BUILT_IN_GEOGRAPHY_DEFINITIONS: Record<string, StudioMapGeographyDefinition> = {
  world: {
    loader: loadWorldGeography,
    label: 'World',
    fieldLabel: 'Country field',
    fieldHint: 'A field containing ISO alpha-2 codes, alpha-3 codes, or full country names.',
    normalizer: normalizeToAlpha2,
  },
  usa: {
    loader: loadUsaGeography,
    label: 'United States',
    fieldLabel: 'State field',
    fieldHint: 'A field containing US state names or 2-letter postal abbreviations.',
    normalizer: normalizeToStateAbbr,
  },
  europe: {
    loader: loadEuropeGeography,
    label: 'Europe',
    fieldLabel: 'Country field',
    fieldHint: 'A field containing ISO alpha-2 codes, alpha-3 codes, or full country names.',
    normalizer: normalizeToAlpha2,
  },
};
