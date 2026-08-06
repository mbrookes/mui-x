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
import { getStudioLocale } from './studioLocale';
import type { StudioLocaleText } from './localeText';

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
      // The shipped `world-atlas` 110m topology gives exactly 3 features a `null`/`undefined`
      // `id` instead of an ISO 3166-1 numeric code — they're identifiable only by
      // `properties.name`: Kosovo, Northern Cyprus ("N. Cyprus"), and Somaliland. None have an
      // official ISO 3166-1 alpha-2 assignment (they're disputed territories / non-UN-members),
      // but Kosovo already has a de facto standard this codebase treats as canonical: "XK" is the
      // widely-used user-assigned code (ISO reserves the "X*" range for local/user assignment)
      // adopted by the EU, IMF, World Bank, and SWIFT — see `NAME_TO_ALPHA2.kosovo`,
      // `ALPHA3_TO_ALPHA2.XKX`, and `EUROPEAN_ALPHA2_CODES` in `countryUtils.ts`. Reuse that same
      // code here so the Kosovo feature survives instead of being silently dropped by the
      // `!alpha2` check below.
      // Northern Cyprus and Somaliland have no comparably established de facto alpha-2 code (and
      // no corresponding `NAME_TO_ALPHA2` entry), so inventing one here would let a shape render
      // on the map that no real data source could ever address — a data field couldn't normalize
      // to a code nobody outside this file knows about. They remain excluded until such a code is
      // adopted (which would also require extending `normalizeToAlpha2`).
      const name = typeof f.properties?.name === 'string' ? f.properties.name : undefined;
      const alpha2 = NUMERIC_TO_ALPHA2[numericId] ?? (name === 'Kosovo' ? 'XK' : undefined);
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

/**
 * Localizes a built-in geography's selector label via `Intl.DisplayNames` (region display
 * names) instead of hardcoding the English name — this is pure UI chrome (a dropdown
 * option in the Map Setup panel's "Map type" picker), not a data-derived proper noun, so
 * it should track the active locale the same way `internals/temporalUtils.ts` localizes
 * month names rather than reading them from a hardcoded English table.
 *
 * `regionCode` is a UN M49 / ISO 3166-1 region code understood by `Intl.DisplayNames`'s
 * `'region'` type: `'001'` ("World"), `'150'` ("Europe"), or an ISO 3166-1 alpha-2 country
 * code (e.g. `'US'`). Falls back to `fallback` if `Intl.DisplayNames` is unavailable in the
 * runtime or doesn't recognise the code (defensive only — all codes used below are valid).
 */
function getRegionDisplayName(regionCode: string, fallback: string): string {
  try {
    const name = new Intl.DisplayNames(getStudioLocale(), { type: 'region' }).of(regionCode);
    if (!name) {
      return fallback;
    }
    // CLDR's English name for UN M49 '001' is the lowercase running-text form "world"
    // (by design, matching prose like "countries around the world") — capitalize it for use
    // as a standalone selector option label. Other locales' region names are already
    // capitalized appropriately, so this is a no-op for them.
    return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    return fallback;
  }
}

/**
 * The built-in geography definitions keyed by map type name.
 *
 * A function of `localeText` rather than a module-level constant: the `label` is localized
 * (via `Intl.DisplayNames`) but `fieldLabel`/`fieldHint` used to be English literals, so a
 * French dashboard rendered "Country field" and "A field containing ISO alpha-2 codes…"
 * directly beneath "Monde". Both now come from `StudioLocaleText`, which means they can
 * only be resolved once the resolved locale text is in hand — hence a factory. A constant
 * also froze `label` at module-import time, before `<Studio locale={…} />` could be read.
 *
 * Call it through `useStudioGeographies()`, which memoizes per locale text and merges the
 * consumer's `geographies` over the result.
 *
 * @param localeText - Resolved Studio locale text supplying the region field label/hint.
 * @returns The built-in geography definitions, localized.
 */
export function getBuiltInGeographyDefinitions(
  localeText: Pick<
    StudioLocaleText,
    | 'mapSetupCountryFieldLabel'
    | 'mapSetupCountryFieldHelperText'
    | 'mapSetupStateFieldLabel'
    | 'mapSetupStateFieldHelperText'
  >,
): Record<string, StudioMapGeographyDefinition> {
  return {
    world: {
      loader: loadWorldGeography,
      label: getRegionDisplayName('001', 'World'),
      fieldLabel: localeText.mapSetupCountryFieldLabel,
      fieldHint: localeText.mapSetupCountryFieldHelperText,
      normalizer: normalizeToAlpha2,
    },
    usa: {
      loader: loadUsaGeography,
      label: getRegionDisplayName('US', 'United States'),
      fieldLabel: localeText.mapSetupStateFieldLabel,
      fieldHint: localeText.mapSetupStateFieldHelperText,
      normalizer: normalizeToStateAbbr,
    },
    europe: {
      loader: loadEuropeGeography,
      label: getRegionDisplayName('150', 'Europe'),
      fieldLabel: localeText.mapSetupCountryFieldLabel,
      fieldHint: localeText.mapSetupCountryFieldHelperText,
      normalizer: normalizeToAlpha2,
    },
  };
}
