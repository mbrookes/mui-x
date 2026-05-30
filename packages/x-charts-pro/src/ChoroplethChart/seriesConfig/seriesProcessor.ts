import type { SeriesProcessor } from '@mui/x-charts/internals';
import type { DefaultizedChoroplethSeriesType } from '../../models/seriesType/choropleth';
import { ChoroplethValueMap } from '../../models/seriesType/choropleth';

const seriesProcessor: SeriesProcessor<'choropleth'> = (params) => {
  const { series, seriesOrder } = params;

  const defaultizedSeries: Record<string, DefaultizedChoroplethSeriesType> = {};

  Object.keys(series).forEach((seriesId) => {
    const s = series[seriesId];
    const data = s.data ?? [];

    defaultizedSeries[seriesId] = {
      valueFormatter: (v) => v?.toString() ?? null,
      data,
      labelMarkType: 'square',
      ...s,
      valueMap: new ChoroplethValueMap(data),
    };
  });

  return { series: defaultizedSeries, seriesOrder };
};

export default seriesProcessor;
