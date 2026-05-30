'use client';
import * as React from 'react';
import {
  geoAlbers,
  geoAlbersUsa,
  geoEqualEarth,
  geoEquirectangular,
  geoMercator,
  geoNaturalEarth1,
  geoOrthographic,
  geoPath,
} from '@mui/x-charts-vendor/d3-geo';
import type {
  GeoProjection,
  ExtendedFeature,
  ExtendedFeatureCollection,
} from '@mui/x-charts-vendor/d3-geo';
import { type ChartPlugin, selectorChartDrawingArea } from '@mui/x-charts/internals';
import type {
  UseChartGeoDefaultizedParameters,
  UseChartGeoSignature,
  GeoProjectionConfig,
  GeoProjectionType,
} from './useChartGeo.types';

function createProjection(type: GeoProjectionType): GeoProjection {
  switch (type) {
    case 'geoNaturalEarth1':
      return geoNaturalEarth1();
    case 'geoAlbers':
      return geoAlbers();
    case 'geoAlbersUsa':
      return geoAlbersUsa();
    case 'geoOrthographic':
      return geoOrthographic();
    case 'geoEqualEarth':
      return geoEqualEarth();
    case 'geoEquirectangular':
      return geoEquirectangular();
    case 'geoMercator':
    default:
      return geoMercator();
  }
}

function buildGeoState(
  geography: ExtendedFeatureCollection,
  projectionConfig: GeoProjectionConfig,
  fitProjection: boolean,
  drawingArea: { width: number; height: number; left: number; top: number },
) {
  const projection = createProjection(projectionConfig.type ?? 'geoMercator');

  if (projectionConfig.center) {
    projection.center(projectionConfig.center);
  }
  if (projectionConfig.rotate) {
    projection.rotate(projectionConfig.rotate as [number, number, number]);
  }

  if (fitProjection && drawingArea.width > 0 && drawingArea.height > 0) {
    (projection as any).fitExtent?.(
      [
        [drawingArea.left, drawingArea.top],
        [drawingArea.left + drawingArea.width, drawingArea.top + drawingArea.height],
      ],
      geography,
    );
  } else if (projectionConfig.scale !== undefined) {
    projection.scale(projectionConfig.scale);
  }

  const pathGenerator = geoPath(projection);

  return { projection, path: pathGenerator, geography };
}

export const useChartGeo: ChartPlugin<UseChartGeoSignature> = ({ params, store }) => {
  const { geography, projection: projectionConfig, fitProjection } = params;

  // Reactive: subscribes to drawing area changes via useSyncExternalStore
  const drawingArea = store.use(selectorChartDrawingArea);

  const isFirstRender = React.useRef(true);

  // Rebuild the geo state whenever props or drawing area change.
  // The isFirstRender guard matches the pattern used in useChartCartesianAxis / useChartZAxis:
  // the first useEffect run is always equal to getInitialState, so we skip it.
  React.useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }

    store.set('geo', buildGeoState(geography, projectionConfig, fitProjection, drawingArea));
  }, [geography, projectionConfig, fitProjection, drawingArea, store]);

  const instance = {
    getFeaturePath(feature: ExtendedFeature): string | null {
      return store.state.geo.path(feature);
    },
    projectPoint(lon: number, lat: number): [number, number] | null {
      return store.state.geo.projection([lon, lat]) ?? null;
    },
  };

  return { instance };
};

useChartGeo.params = {
  geography: true,
  projection: true,
  fitProjection: true,
};

useChartGeo.getDefaultizedParams = ({ params }) =>
  ({
    ...params,
    projection: params.projection ?? {},
    fitProjection: params.fitProjection ?? true,
  }) as UseChartGeoDefaultizedParameters;

useChartGeo.getInitialState = (params) => {
  const projectionConfig = params.projection ?? {};

  // Initial state uses zero dimensions since ResizeObserver hasn't fired yet.
  // The useEffect above will refit once the actual drawing area is known.
  return {
    geo: buildGeoState(params.geography, projectionConfig, false, {
      width: 0,
      height: 0,
      left: 0,
      top: 0,
    }),
  };
};
