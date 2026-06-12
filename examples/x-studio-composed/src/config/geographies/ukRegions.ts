/**
 * Custom geography definition for England's 9 electoral regions.
 *
 * This demonstrates how developers can register additional map geographies
 * in Studio beyond the built-in 'world', 'usa', and 'europe' options.
 *
 * Data source: martinjc/UK-GeoJSON (MIT) — English Electoral Regions (EER).
 * https://github.com/martinjc/UK-GeoJSON
 */
import type { StudioMapGeographyDefinition } from '@mui/x-studio';

/** Converts a region name to a URL-safe slug used as the feature ID. */
function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Maps ONS English Electoral Region codes (e.g. `E15000001`) to the
 * URL-safe slugs used as feature IDs in this geography (e.g. `north-east`).
 */
const EER_CODE_TO_SLUG: Record<string, string> = {
  E15000001: 'north-east',
  E15000002: 'north-west',
  E15000003: 'yorkshire-and-the-humber',
  E15000004: 'east-midlands',
  E15000005: 'west-midlands',
  E15000006: 'eastern',
  E15000007: 'london',
  E15000008: 'south-east',
  E15000009: 'south-west',
};

/**
 * A `StudioMapGeographyDefinition` for the 9 English Electoral Regions.
 *
 * Register it on the Studio component to enable a map type for UK regional data:
 *
 * ```tsx
 * import { ukRegionsGeography } from './config/geographies/ukRegions';
 *
 * <Studio
 *   geographies={{ 'england-regions': ukRegionsGeography }}
 *   ...
 * />
 * ```
 *
 * The widget then expects a field containing region names such as:
 * `"North East"`, `"North West"`, `"Yorkshire and The Humber"`,
 * `"East Midlands"`, `"West Midlands"`, `"Eastern"`,
 * `"London"`, `"South East"`, `"South West"`.
 */
export const ukRegionsGeography: StudioMapGeographyDefinition = {
  label: 'England (Regions)',
  fieldLabel: 'Region field',
  fieldHint:
    'A field containing English region names such as "North West", "London", or "Yorkshire and The Humber".',
  normalizer: (value) => (value != null ? slugify(String(value)) : null),
  loader: async () => {
    // Fetch the EER TopoJSON from the martinjc/UK-GeoJSON open-data project.
    // In a production app you would bundle this file locally or serve it from
    // your own CDN to avoid a third-party network dependency.
    const res = await fetch(
      'https://raw.githubusercontent.com/martinjc/UK-GeoJSON/master/json/electoral/eng/topo_eer.json',
    );
    if (!res.ok) {
      throw new Error(`MUI X: Failed to load UK regions topology (${res.status})`);
    }
    const [topo, { feature }] = await Promise.all([res.json(), import('topojson-client')]);
    const fc = feature(topo, topo.objects.eer) as unknown as GeoJSON.FeatureCollection;

    // Remap feature IDs from ONS codes (E15000001) to URL-safe slugs (north-east)
    // so they match the output of the normalizer above.
    return {
      ...fc,
      features: fc.features.map((f) => ({
        ...f,
        id:
          EER_CODE_TO_SLUG[String(f.id ?? '')] ??
          slugify(((f.properties as Record<string, unknown>)?.EER13NM as string) ?? String(f.id)),
      })),
    } as GeoJSON.FeatureCollection;
  },
};
