import { geoContains } from '@mui/x-charts-vendor/d3-geo';
import type { ChartState } from '@mui/x-charts/internals';
import { selectorAllSeriesOfType } from '@mui/x-charts/internals';
import type { SeriesItemIdentifierWithData } from '@mui/x-charts/models';
import type { DefaultizedChoroplethSeriesType } from '../../models/seriesType/choropleth';
import type { UseChartGeoSignature } from '../../internals/plugins/useChartGeo';

export default function getItemAtPosition(
  state: ChartState<[]>,
  point: { x: number; y: number },
): SeriesItemIdentifierWithData<'choropleth'> | undefined {
  const geoState = (state as ChartState<[UseChartGeoSignature]>).geo;

  if (!geoState) {
    return undefined;
  }

  const series = selectorAllSeriesOfType(state, 'choropleth');

  if (!series || series.seriesOrder.length === 0) {
    return undefined;
  }

  const seriesId = series.seriesOrder[0];
  const seriesData = series.series[seriesId] as unknown as DefaultizedChoroplethSeriesType;

  for (const feature of geoState.geography.features) {
    const featureId =
      seriesData.featureIdKey !== undefined
        ? String((feature.properties as Record<string, unknown>)?.[seriesData.featureIdKey] ?? '')
        : String(feature.id ?? '');

    if (featureId === '') {
      continue;
    }

    if (geoContains(feature, geoState.projection.invert?.([point.x, point.y]) ?? [0, 0])) {
      const value = seriesData.valueMap.getValue(featureId);

      return {
        type: 'choropleth',
        seriesId,
        featureId,
        value,
      };
    }
  }

  return undefined;
}
