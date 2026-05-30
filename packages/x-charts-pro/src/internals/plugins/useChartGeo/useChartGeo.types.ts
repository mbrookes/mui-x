import type { ChartPluginSignature, UseChartDimensionsSignature } from '@mui/x-charts/internals';
import type {
  GeoPath,
  GeoPermissibleObjects,
  GeoProjection,
  ExtendedFeature,
  ExtendedFeatureCollection,
} from '@mui/x-charts-vendor/d3-geo';

export type GeoProjectionType =
  | 'geoMercator'
  | 'geoNaturalEarth1'
  | 'geoAlbers'
  | 'geoAlbersUsa'
  | 'geoOrthographic'
  | 'geoEqualEarth'
  | 'geoEquirectangular';

export interface GeoProjectionConfig {
  /**
   * The D3-geo projection to use.
   * @default 'geoMercator'
   */
  type?: GeoProjectionType;
  /**
   * The D3-geo scale factor. Ignored when `fitProjection` is true.
   */
  scale?: number;
  /**
   * [longitude, latitude] center of the projection.
   */
  center?: [number, number];
  /**
   * Rotation [lambda, phi, gamma] for the projection.
   */
  rotate?: [number, number, number?];
}

export interface UseChartGeoParameters {
  /**
   * GeoJSON FeatureCollection describing the map regions to render.
   */
  geography: ExtendedFeatureCollection;
  /**
   * D3-geo projection configuration.
   * @default { type: 'geoMercator' }
   */
  projection?: GeoProjectionConfig;
  /**
   * Whether to automatically fit the projection to the drawing area.
   * @default true
   */
  fitProjection?: boolean;
}

export type UseChartGeoDefaultizedParameters = UseChartGeoParameters & {
  projection: GeoProjectionConfig;
  fitProjection: boolean;
};

export interface UseChartGeoState {
  geo: {
    /** The D3-geo projection instance (fitted to drawing area). */
    projection: GeoProjection;
    /** The D3-geo path generator bound to the projection. */
    path: GeoPath<any, GeoPermissibleObjects>;
    /** The GeoJSON feature collection being rendered. */
    geography: ExtendedFeatureCollection;
  };
}

export interface UseChartGeoInstance {
  /**
   * Get the SVG path `d` attribute for a given GeoJSON feature.
   */
  getFeaturePath(feature: ExtendedFeature): string | null;
  /**
   * Project a [longitude, latitude] coordinate to SVG [x, y].
   */
  projectPoint(lon: number, lat: number): [number, number] | null;
}

export type UseChartGeoSignature = ChartPluginSignature<{
  params: UseChartGeoParameters;
  defaultizedParams: UseChartGeoDefaultizedParameters;
  state: UseChartGeoState;
  instance: UseChartGeoInstance;
  dependencies: [UseChartDimensionsSignature];
}>;
